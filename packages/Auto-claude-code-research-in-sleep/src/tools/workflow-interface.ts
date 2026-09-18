import { runOwnedPath } from "./run-contract.js";
import fs from "node:fs";
import path from "node:path";
import { anyJsonSchema, canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";

const INTERFACE_SCHEMA = "workflow-interface-record-v1";
const CONNECTION_SCHEMA = "workflow-connection-record-v1";

export interface WorkflowInterfaceOutput {
  location: string;
  contains: string[];
  example: unknown;
  document: string;
}

export interface WorkflowInterfaceInputRequirement {
  location: string;
  requires: string[];
  example: unknown;
  document: string;
}

/**
 * A node interface is deliberately descriptive. It does not turn every
 * output into a universal data type; it gives the Workflow enough information
 * to decide whether the next node can use that output.
 */
export interface WorkflowInterfaceRecord {
  schema_version: 1;
  node_id: string;
  outputs: WorkflowInterfaceOutput[];
  input_requirements: WorkflowInterfaceInputRequirement[];
}

export interface StoredWorkflowInterfaceRecord extends WorkflowInterfaceRecord {
  interface_record_sha256: string;
}

export type WorkflowConnectionStatus = "connected" | "content_insufficient" | "content_unclear";

export interface WorkflowConnectionRequirementMatch {
  input_location: string;
  required_concepts: string[];
  provided_concepts: string[];
  missing_concepts: string[];
  status: WorkflowConnectionStatus;
  reason: string;
}

export interface WorkflowConnectionRecord {
  schema_version: 1;
  connection_id: string;
  from: {
    node_id: string;
    location: string;
  };
  to: {
    node_id: string;
    location: string;
  };
  status: WorkflowConnectionStatus;
  reason: string;
  upstream_record_sha256: string;
  downstream_record_sha256: string;
  input_snapshot_sha256: string | null;
  requirement_matches: WorkflowConnectionRequirementMatch[];
}

export interface StoredWorkflowConnectionRecord extends WorkflowConnectionRecord {
  connection_record_sha256: string;
}

export interface EvaluateWorkflowConnectionInput {
  upstream: WorkflowInterfaceRecord | StoredWorkflowInterfaceRecord;
  downstream: WorkflowInterfaceRecord | StoredWorkflowInterfaceRecord;
  /** The selected output and input positions. Their text is not used as evidence. */
  upstream_output_location?: string;
  downstream_input_location?: string;
  /** Short aliases make JSON manifests easier to write. */
  output_location?: string;
  input_location?: string;
  connection_id?: string;
  input_snapshot?: unknown;
  input_snapshot_sha256?: string;
}

export interface ValidateWorkflowOutputInput {
  interface_record: WorkflowInterfaceRecord | StoredWorkflowInterfaceRecord;
  output_location?: string;
  actual_output: unknown;
  artifact_ref?: string;
  actual_output_sha256?: string;
}

export interface WorkflowOutputContentCheck {
  schema_version: 1;
  status: "content_present" | "content_missing" | "content_unclear";
  node_id: string;
  output_location: string;
  interface_record_sha256: string;
  artifact_ref: string | null;
  actual_output_sha256: string;
  declared_concepts: string[];
  observed_concepts: string[];
  missing_concepts: string[];
  reason: string;
}

function projectRootPath(projectRoot: string): string {
  const root = path.resolve(requireString(projectRoot, "project_root"));
  if (path.parse(root).root === root)
    failA1("INVALID_PROJECT_ROOT", "project_root cannot be a filesystem root");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    failA1("PATH_ESCAPE", "project_root must be an existing directory");
  return root;
}

function assertRealPathInside(root: string, target: string, message: string): void {
  const rootReal = fs.realpathSync.native(root);
  let existing = path.resolve(target);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) failA1("PATH_ESCAPE", message);
    existing = parent;
  }
  const targetReal = fs.realpathSync.native(existing);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`))
    failA1("PATH_ESCAPE", message);
}

function nodeRunDirectory(projectRoot: string, nodeRunId: string): string {
  const root = projectRootPath(projectRoot);
  const directory = runOwnedPath(root, nodeRunId);
  assertRealPathInside(root, directory, "node interface storage escapes project_root");
  return directory;
}

export function nodeInterfaceRecordPath(projectRoot: string, nodeRunId: string): string {
  return path.join(nodeRunDirectory(projectRoot, nodeRunId), "interface-record.json");
}

function connectionDirectory(projectRoot: string, outerRunId: string): string {
  const root = projectRootPath(projectRoot);
  const directory = runOwnedPath(root, outerRunId, "connections");
  assertRealPathInside(root, directory, "workflow connection storage escapes project_root");
  return directory;
}

function connectionRecordPath(
  projectRoot: string,
  outerRunId: string,
  connectionId: string,
): string {
  const directory = connectionDirectory(projectRoot, outerRunId);
  const id = assertIdentifier(connectionId, "connection_id");
  const filePath = path.join(directory, `${id}.json`);
  assertRealPathInside(
    projectRootPath(projectRoot),
    filePath,
    "workflow connection path escapes project_root",
  );
  return filePath;
}

function jsonExample(value: unknown, location: string): unknown {
  try {
    // Besides producing a hash, this rejects NaN, Infinity, unsupported
    // values, unpaired surrogates and non-NFC strings.
    canonicalJsonSha256(value, anyJsonSchema, { schemaVersion: `${INTERFACE_SCHEMA}-example` });
  } catch {
    failA1("INVALID_VALUE", "example must be finite, NFC-normalized JSON", location);
  }
  return value;
}

function shortDocument(value: unknown, location: string): string {
  const document = requireString(value, location);
  if (Array.from(document).length > 500)
    failA1("INVALID_VALUE", "document must contain at most 500 characters", location);
  return document;
}

function textList(value: unknown, location: string, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_VALUE", `${label} must contain at least one item`, location);
  const result = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", `${label} must not contain duplicate items`, location);
  return result;
}

function conceptList(value: unknown, location: string, label: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_VALUE", `${label} must be an array`, location);
  const result = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", `${label} must not contain duplicate items`, location);
  return result;
}

function interfaceLocation(value: unknown, location: string): string {
  // Locations are labels, so slash and port conventions are intentionally not
  // imposed here. The selected label is checked for membership only.
  return requireString(value, location);
}

function validateInterfaceOutput(value: unknown, location: string): WorkflowInterfaceOutput {
  if (!isRecord(value)) failA1("INVALID_VALUE", "output record must be an object", location);
  const keys = ["location", "contains", "example", "document"];
  for (const key of Object.keys(value))
    if (!keys.includes(key)) failA1("UNKNOWN_FIELD", `unknown output field '${key}'`, location);
  return {
    location: interfaceLocation(value.location, `${location}.location`),
    contains: textList(value.contains, `${location}.contains`, "contains"),
    example: jsonExample(value.example, `${location}.example`),
    document: shortDocument(value.document, `${location}.document`),
  };
}

function validateInputRequirement(
  value: unknown,
  location: string,
): WorkflowInterfaceInputRequirement {
  if (!isRecord(value)) failA1("INVALID_VALUE", "input requirement must be an object", location);
  const keys = ["location", "requires", "example", "document"];
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      failA1("UNKNOWN_FIELD", `unknown input requirement field '${key}'`, location);
  return {
    location: interfaceLocation(value.location, `${location}.location`),
    requires: textList(value.requires, `${location}.requires`, "requires"),
    example: jsonExample(value.example, `${location}.example`),
    document: shortDocument(value.document, `${location}.document`),
  };
}

export function validateWorkflowInterfaceRecord(value: unknown): WorkflowInterfaceRecord {
  if (!isRecord(value)) failA1("INVALID_VALUE", "workflow interface record must be an object");
  const keys = [
    "schema_version",
    "node_id",
    "outputs",
    "input_requirements",
    "interface_record_sha256",
  ];
  for (const key of Object.keys(value))
    if (!keys.includes(key)) failA1("UNKNOWN_FIELD", `unknown interface field '${key}'`);
  if (value.schema_version !== 1)
    failA1("INVALID_VALUE", "workflow interface schema_version must be 1");
  if (!Array.isArray(value.outputs) || value.outputs.length === 0)
    failA1("INVALID_VALUE", "workflow interface needs at least one output");
  if (!Array.isArray(value.input_requirements))
    failA1("INVALID_VALUE", "workflow interface input_requirements must be an array");
  const outputs = value.outputs.map((item, index) =>
    validateInterfaceOutput(item, `interface.outputs[${index}]`),
  );
  const inputs = value.input_requirements.map((item, index) =>
    validateInputRequirement(item, `interface.input_requirements[${index}]`),
  );
  if (new Set(outputs.map((item) => item.location)).size !== outputs.length)
    failA1("DUPLICATE_ID", "workflow output locations must be unique");
  if (new Set(inputs.map((item) => item.location)).size !== inputs.length)
    failA1("DUPLICATE_ID", "workflow input locations must be unique");
  if (Object.hasOwn(value, "interface_record_sha256"))
    assertSha256(value.interface_record_sha256, "interface_record_sha256");
  return {
    schema_version: 1,
    node_id: assertIdentifier(value.node_id, "interface.node_id"),
    outputs,
    input_requirements: inputs,
  };
}

function interfaceWithoutHash(value: unknown): WorkflowInterfaceRecord {
  if (isRecord(value) && Object.hasOwn(value, "interface_record_sha256")) {
    const copy = { ...value };
    delete copy.interface_record_sha256;
    return validateWorkflowInterfaceRecord(copy);
  }
  return validateWorkflowInterfaceRecord(value);
}

export function nodeInterfaceRecordSha256(value: unknown): string {
  return canonicalJsonSha256(interfaceWithoutHash(value), anyJsonSchema, {
    schemaVersion: INTERFACE_SCHEMA,
  });
}

function validateStoredInterface(value: unknown, filePath: string): StoredWorkflowInterfaceRecord {
  if (!isRecord(value))
    failA1("CORRUPT_STATE", "stored interface record must be an object", filePath);
  const record = interfaceWithoutHash(value);
  const digest = assertSha256(value.interface_record_sha256, `${filePath}.interface_record_sha256`);
  if (digest !== nodeInterfaceRecordSha256(record))
    failA1("CORRUPT_STATE", "stored interface record hash does not match its contents", filePath);
  return { ...record, interface_record_sha256: digest };
}

export function saveNodeInterfaceRecord(
  projectRoot: string,
  nodeRunId: string,
  value: unknown,
): StoredWorkflowInterfaceRecord {
  const record = validateWorkflowInterfaceRecord(value);
  const digest = nodeInterfaceRecordSha256(record);
  const stored: StoredWorkflowInterfaceRecord = {
    ...record,
    interface_record_sha256: digest,
  };
  const filePath = nodeInterfaceRecordPath(projectRoot, nodeRunId);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateStoredInterface(readStateFile(filePath), filePath);
      if (existing.interface_record_sha256 !== digest)
        failA1("IMMUTABLE_CONFLICT", "node interface record cannot be replaced", filePath);
      return existing;
    }
    writeStateJsonAtomic(filePath, stored);
    return stored;
  });
}

export function readNodeInterfaceRecord(
  projectRoot: string,
  nodeRunId: string,
): StoredWorkflowInterfaceRecord {
  const filePath = nodeInterfaceRecordPath(projectRoot, nodeRunId);
  if (!fs.existsSync(filePath)) failA1("INTERFACE_NOT_FOUND", "node interface record is missing");
  return validateStoredInterface(readStateFile(filePath), filePath);
}

export const saveWorkflowInterfaceRecord = saveNodeInterfaceRecord;
export const readWorkflowInterfaceRecord = readNodeInterfaceRecord;

type Concept =
  | "model"
  | "tokenizer"
  | "load"
  | "provenance"
  | "train"
  | "trajectory"
  | "observation"
  | "metric"
  | "path"
  | "config"
  | "data"
  | "environment"
  | "harness"
  | "judge"
  | "seed"
  | "error";

const CONCEPT_TERMS: Readonly<Record<Concept, readonly string[]>> = {
  model: ["模型", "model", "weight", "权重", "checkpoint"],
  tokenizer: ["tokenizer", "分词器", "词表", "vocab"],
  load: ["可加载", "加载", "load", "loader", "load_entry", "推理", "inference", "服务地址"],
  provenance: ["来源", "source", "version", "版本", "lineage", "commit", "训练来源"],
  train: ["训练", "train", "fine-tune", "finetune", "继续训练"],
  trajectory: ["轨迹", "trajectory", "trace", "rollout", "逐步", "step sequence"],
  observation: ["逐项", "observation", "per-case", "单条结果", "每个 case", "case result"],
  metric: ["指标", "metric", "score", "分数", "aggregate", "聚合", "均值", "mean"],
  path: ["路径", "文件", "file", "path", "uri"],
  config: ["配置", "config", "settings"],
  data: ["数据", "data", "dataset", "数据集", "样本"],
  environment: ["环境", "environment", "env", "runtime"],
  harness: ["harness", "测试流程", "测试脚本"],
  judge: ["judge", "评分器", "评审", "评分"],
  seed: ["seed", "随机种子"],
  error: ["错误", "失败", "error", "failure", "诊断", "分析"],
};

const NEGATION = /(?:不包含|不含|没有|缺少|无|without|not)\s*$/i;

function containsPositiveTerm(text: string, term: string): boolean {
  let start = 0;
  for (;;) {
    const index = text.indexOf(term, start);
    if (index < 0) return false;
    const before = text.slice(Math.max(0, index - 10), index);
    if (!NEGATION.test(before)) return true;
    start = index + term.length;
  }
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(jsonText).filter(Boolean).join(" ");
  if (isRecord(value))
    return Object.entries(value)
      .map(([key, child]) => {
        const childText = jsonText(child);
        return childText === "" ? "" : `${key} ${childText}`;
      })
      .filter(Boolean)
      .join(" ");
  try {
    return String(value);
  } catch {
    return "";
  }
}

function conceptsFor(parts: readonly string[], example: unknown): Concept[] {
  const text = `${parts.join(" ")} ${jsonText(example)}`.toLocaleLowerCase();
  const concepts: Concept[] = [];
  for (const [concept, terms] of Object.entries(CONCEPT_TERMS) as Array<
    [Concept, readonly string[]]
  >) {
    if (terms.some((term) => containsPositiveTerm(text, term.toLocaleLowerCase())))
      concepts.push(concept);
  }
  return concepts.sort();
}

function recordHash(value: WorkflowInterfaceRecord | StoredWorkflowInterfaceRecord): string {
  if (isRecord(value) && Object.hasOwn(value, "interface_record_sha256")) {
    const supplied = assertSha256(value.interface_record_sha256, "interface_record_sha256");
    if (supplied !== nodeInterfaceRecordSha256(value))
      failA1("INVALID_HASH", "interface record hash does not match the record");
    return supplied;
  }
  return nodeInterfaceRecordSha256(value);
}

function selectedLocation(
  explicit: string | undefined,
  alias: string | undefined,
  values: readonly string[],
  location: string,
): string {
  const selected = explicit ?? alias ?? (values.length === 1 ? values[0] : undefined);
  const value = requireString(selected, location);
  if (!values.includes(value)) failA1("CONTENT_CONNECTION_REQUIRED", `${location} is not declared`);
  return value;
}

function snapshotHash(input: EvaluateWorkflowConnectionInput): string | null {
  const calculated =
    input.input_snapshot === undefined
      ? null
      : canonicalJsonSha256(input.input_snapshot, anyJsonSchema, {
          schemaVersion: "workflow-connection-input-v1",
        });
  if (input.input_snapshot_sha256 !== undefined) {
    const supplied = assertSha256(input.input_snapshot_sha256, "input_snapshot_sha256");
    if (calculated !== null && calculated !== supplied)
      failA1("IMMUTABLE_CONFLICT", "input snapshot hash does not match the snapshot");
    return supplied;
  }
  return calculated;
}

function connectionId(input: {
  requested?: string;
  from: { node_id: string; location: string };
  to: { node_id: string; location: string };
  upstream_record_sha256: string;
  downstream_record_sha256: string;
  input_snapshot_sha256: string | null;
}): string {
  if (input.requested !== undefined) return assertIdentifier(input.requested, "connection_id");
  const digest = canonicalJsonSha256(
    {
      from: input.from,
      to: input.to,
      upstream_record_sha256: input.upstream_record_sha256,
      downstream_record_sha256: input.downstream_record_sha256,
      input_snapshot_sha256: input.input_snapshot_sha256,
    },
    anyJsonSchema,
    { schemaVersion: CONNECTION_SCHEMA },
  );
  return `connection:${digest}`;
}

export function evaluateWorkflowConnection(
  input: EvaluateWorkflowConnectionInput,
): WorkflowConnectionRecord {
  const upstream = interfaceWithoutHash(input.upstream);
  const downstream = interfaceWithoutHash(input.downstream);
  const upstreamHash = recordHash(input.upstream);
  const downstreamHash = recordHash(input.downstream);
  const outputLocation = selectedLocation(
    input.upstream_output_location,
    input.output_location,
    upstream.outputs.map((item) => item.location),
    "upstream_output_location",
  );
  const inputLocation = selectedLocation(
    input.downstream_input_location,
    input.input_location,
    downstream.input_requirements.map((item) => item.location),
    "downstream_input_location",
  );
  const output = upstream.outputs.find((item) => item.location === outputLocation)!;
  const requirement = downstream.input_requirements.find(
    (item) => item.location === inputLocation,
  )!;
  const requiredConcepts = conceptsFor(requirement.requires, requirement.example);
  const providedConcepts = conceptsFor([...output.contains, output.document], output.example);
  const missingConcepts = requiredConcepts.filter((concept) => !providedConcepts.includes(concept));
  let status: WorkflowConnectionStatus;
  let reason: string;
  if (requiredConcepts.length === 0 || providedConcepts.length === 0) {
    status = "content_unclear";
    reason = "无法从输入要求或上游输出说明中识别足够的内容含义";
  } else if (missingConcepts.length > 0) {
    status = "content_insufficient";
    reason = `上游输出缺少下游要求的内容：${missingConcepts.join(", ")}`;
  } else {
    status = "connected";
    reason = "上游输出说明和示例覆盖了下游输入要求的内容";
  }
  const inputSnapshotSha256 = snapshotHash(input);
  const from = { node_id: upstream.node_id, location: outputLocation };
  const to = { node_id: downstream.node_id, location: inputLocation };
  return {
    schema_version: 1,
    connection_id: connectionId({
      requested: input.connection_id,
      from,
      to,
      upstream_record_sha256: upstreamHash,
      downstream_record_sha256: downstreamHash,
      input_snapshot_sha256: inputSnapshotSha256,
    }),
    from,
    to,
    status,
    reason,
    upstream_record_sha256: upstreamHash,
    downstream_record_sha256: downstreamHash,
    input_snapshot_sha256: inputSnapshotSha256,
    requirement_matches: [
      {
        input_location: inputLocation,
        required_concepts: requiredConcepts,
        provided_concepts: providedConcepts,
        missing_concepts: missingConcepts,
        status,
        reason,
      },
    ],
  };
}

export const checkWorkflowConnection = evaluateWorkflowConnection;

/**
 * Check the real output after execution. A static connection can be valid
 * while a worker still publishes an incomplete artifact; that case becomes
 * evidence for analyze-results and is never silently replaced with an older
 * output.
 */
export function validateWorkflowOutputContent(
  input: ValidateWorkflowOutputInput,
): WorkflowOutputContentCheck {
  const record = interfaceWithoutHash(input.interface_record);
  const interfaceHash = recordHash(input.interface_record);
  const outputLocation = selectedLocation(
    input.output_location,
    undefined,
    record.outputs.map((item) => item.location),
    "output_location",
  );
  const output = record.outputs.find((item) => item.location === outputLocation)!;
  let actualHash: string;
  try {
    actualHash = canonicalJsonSha256(input.actual_output, anyJsonSchema, {
      schemaVersion: "workflow-output-content-v1",
    });
  } catch {
    failA1("CONTENT_MISSING", "actual output must be finite, NFC-normalized JSON");
  }
  if (input.actual_output_sha256 !== undefined) {
    const supplied = assertSha256(input.actual_output_sha256, "actual_output_sha256");
    if (supplied !== actualHash)
      failA1("IMMUTABLE_CONFLICT", "actual output hash does not match the output");
  }
  const declaredConcepts = conceptsFor([...output.contains, output.document], output.example);
  const observedConcepts = conceptsFor([jsonText(input.actual_output)], input.actual_output);
  const missingConcepts = declaredConcepts.filter((concept) => !observedConcepts.includes(concept));
  let status: WorkflowOutputContentCheck["status"];
  let reason: string;
  if (declaredConcepts.length === 0) {
    status = "content_unclear";
    reason = "输出说明没有可核对的内容含义";
  } else if (missingConcepts.length > 0) {
    status = "content_missing";
    reason = `实际产物缺少接口记录声明的内容：${missingConcepts.join(", ")}`;
  } else {
    status = "content_present";
    reason = "实际产物包含接口记录声明的内容";
  }
  return {
    schema_version: 1,
    status,
    node_id: record.node_id,
    output_location: outputLocation,
    interface_record_sha256: interfaceHash,
    artifact_ref:
      input.artifact_ref === undefined ? null : requireString(input.artifact_ref, "artifact_ref"),
    actual_output_sha256: actualHash,
    declared_concepts: declaredConcepts,
    observed_concepts: observedConcepts,
    missing_concepts: missingConcepts,
    reason,
  };
}

export const checkWorkflowOutputContent = validateWorkflowOutputContent;

function connectionWithoutHash(value: unknown): WorkflowConnectionRecord {
  if (!isRecord(value)) failA1("INVALID_VALUE", "workflow connection record must be an object");
  const allowed = [
    "schema_version",
    "connection_id",
    "from",
    "to",
    "status",
    "reason",
    "upstream_record_sha256",
    "downstream_record_sha256",
    "input_snapshot_sha256",
    "requirement_matches",
    "connection_record_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", `unknown connection field '${key}'`);
  const copy = { ...value };
  delete copy.connection_record_sha256;
  if (copy.schema_version !== 1) failA1("INVALID_VALUE", "connection schema_version must be 1");
  if (
    copy.status !== "connected" &&
    copy.status !== "content_insufficient" &&
    copy.status !== "content_unclear"
  )
    failA1("INVALID_VALUE", "connection status is invalid");
  assertIdentifier(copy.connection_id, "connection_id");
  assertSha256(copy.upstream_record_sha256, "upstream_record_sha256");
  assertSha256(copy.downstream_record_sha256, "downstream_record_sha256");
  if (copy.input_snapshot_sha256 !== null)
    assertSha256(copy.input_snapshot_sha256, "input_snapshot_sha256");
  if (!isRecord(copy.from) || !isRecord(copy.to))
    failA1("INVALID_VALUE", "connection endpoints must be objects");
  assertIdentifier(copy.from.node_id, "from.node_id");
  assertIdentifier(copy.to.node_id, "to.node_id");
  if (copy.from.node_id === copy.to.node_id)
    failA1("CONTENT_CONNECTION_REQUIRED", "a node cannot connect to itself");
  const endpointKeys = ["node_id", "location"];
  for (const [name, endpoint] of [
    ["from", copy.from],
    ["to", copy.to],
  ] as const)
    for (const key of Object.keys(endpoint))
      if (!endpointKeys.includes(key))
        failA1("UNKNOWN_FIELD", `unknown ${name} endpoint field '${key}'`);
  requireString(copy.from.location, "from.location");
  requireString(copy.to.location, "to.location");
  requireString(copy.reason, "reason");
  if (!Array.isArray(copy.requirement_matches))
    failA1("INVALID_VALUE", "requirement_matches must be an array");
  if (copy.requirement_matches.length === 0)
    failA1("INVALID_VALUE", "requirement_matches must contain at least one requirement");
  const matches = copy.requirement_matches.map((match, index) => {
    if (!isRecord(match)) failA1("INVALID_VALUE", "requirement match must be an object");
    const matchAllowed = [
      "input_location",
      "required_concepts",
      "provided_concepts",
      "missing_concepts",
      "status",
      "reason",
    ];
    for (const key of Object.keys(match))
      if (!matchAllowed.includes(key))
        failA1("UNKNOWN_FIELD", `unknown requirement match field '${key}'`);
    if (
      match.status !== "connected" &&
      match.status !== "content_insufficient" &&
      match.status !== "content_unclear"
    )
      failA1(
        "INVALID_VALUE",
        "requirement match status is invalid",
        `requirement_matches[${index}]`,
      );
    return {
      input_location: requireString(
        match.input_location,
        `requirement_matches[${index}].input_location`,
      ),
      required_concepts: conceptList(
        match.required_concepts,
        `requirement_matches[${index}].required_concepts`,
        "required_concepts",
      ),
      provided_concepts: conceptList(
        match.provided_concepts,
        `requirement_matches[${index}].provided_concepts`,
        "provided_concepts",
      ),
      missing_concepts: conceptList(
        match.missing_concepts,
        `requirement_matches[${index}].missing_concepts`,
        "missing_concepts",
      ),
      status: match.status,
      reason: requireString(match.reason, `requirement_matches[${index}].reason`),
    } as WorkflowConnectionRequirementMatch;
  });
  if (matches.some((match) => match.status !== copy.status))
    failA1("CORRUPT_STATE", "connection and requirement statuses must agree");
  return {
    schema_version: 1,
    connection_id: assertIdentifier(copy.connection_id, "connection_id"),
    from: {
      node_id: assertIdentifier(copy.from.node_id, "from.node_id"),
      location: requireString(copy.from.location, "from.location"),
    },
    to: {
      node_id: assertIdentifier(copy.to.node_id, "to.node_id"),
      location: requireString(copy.to.location, "to.location"),
    },
    status: copy.status,
    reason: requireString(copy.reason, "reason"),
    upstream_record_sha256: assertSha256(copy.upstream_record_sha256, "upstream_record_sha256"),
    downstream_record_sha256: assertSha256(
      copy.downstream_record_sha256,
      "downstream_record_sha256",
    ),
    input_snapshot_sha256:
      copy.input_snapshot_sha256 === null
        ? null
        : assertSha256(copy.input_snapshot_sha256, "input_snapshot_sha256"),
    requirement_matches: matches,
  };
}

export function workflowConnectionRecordSha256(value: unknown): string {
  return canonicalJsonSha256(connectionWithoutHash(value), anyJsonSchema, {
    schemaVersion: CONNECTION_SCHEMA,
  });
}

export function saveWorkflowConnectionRecord(
  projectRoot: string,
  outerRunId: string,
  value: unknown,
): StoredWorkflowConnectionRecord {
  const record = connectionWithoutHash(value);
  const digest = workflowConnectionRecordSha256(record);
  const stored: StoredWorkflowConnectionRecord = {
    ...record,
    connection_record_sha256: digest,
  };
  const filePath = connectionRecordPath(projectRoot, outerRunId, record.connection_id);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateStoredConnection(readStateFile(filePath), filePath);
      if (existing.connection_record_sha256 !== digest)
        failA1("IMMUTABLE_CONFLICT", "workflow connection record cannot be replaced", filePath);
      return existing;
    }
    writeStateJsonAtomic(filePath, stored);
    return stored;
  });
}

function validateStoredConnection(
  value: unknown,
  filePath: string,
): StoredWorkflowConnectionRecord {
  if (!isRecord(value))
    failA1("CORRUPT_STATE", "stored connection record must be an object", filePath);
  const record = connectionWithoutHash(value);
  const digest = assertSha256(
    value.connection_record_sha256,
    `${filePath}.connection_record_sha256`,
  );
  if (digest !== workflowConnectionRecordSha256(record))
    failA1("CORRUPT_STATE", "stored connection record hash does not match its contents", filePath);
  return { ...record, connection_record_sha256: digest };
}

export function readWorkflowConnectionRecord(
  projectRoot: string,
  outerRunId: string,
  connectionId: string,
): StoredWorkflowConnectionRecord {
  const filePath = connectionRecordPath(projectRoot, outerRunId, connectionId);
  if (!fs.existsSync(filePath))
    failA1("CONNECTION_NOT_FOUND", "workflow connection record is missing");
  return validateStoredConnection(readStateFile(filePath), filePath);
}

/** Stop graph creation before scheduling a downstream node when any edge is not usable. */
export function assertWorkflowConnectionsConnected(
  records: readonly (WorkflowConnectionRecord | StoredWorkflowConnectionRecord)[],
): WorkflowConnectionRecord[] {
  return records.map((value, index) => {
    const record = connectionWithoutHash(value);
    if (record.status !== "connected")
      failA1(
        "CONTENT_CONNECTION_REQUIRED",
        `workflow connection ${record.connection_id} is ${record.status}; downstream scheduling is blocked`,
        `connections[${index}]`,
      );
    return record;
  });
}
