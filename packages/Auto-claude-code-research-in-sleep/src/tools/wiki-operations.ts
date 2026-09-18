export type WikiPageKind = "paper" | "idea" | "experiment" | "claim" | "problem";

export const WIKI_SIGNAL_KINDS = [
  "observation",
  "failure",
  "constraint",
  "proposal",
  "interaction",
] as const;

export type WikiSignalKind = (typeof WIKI_SIGNAL_KINDS)[number];

export const WIKI_SIGNAL_SOURCES = [
  "module_experiment",
  "workflow_validation",
  "scorer_experiment",
  "tester_feedback",
  "human_input",
] as const;

export type WikiSignalSource = (typeof WIKI_SIGNAL_SOURCES)[number];

export interface WikiSignalProducer {
  module_id: string;
  module_version: string;
  run_id: string;
}

export interface WikiSignalAppliesTo {
  workflow_id?: string;
  workflow_revision?: string;
  input_snapshot_id?: string;
  contract_versions: string[];
  scorer_revision?: string;
  scorer_target?: unknown;
  constraints?: unknown[];
}

export interface WikiSignal {
  signal_id: string;
  kind: WikiSignalKind;
  source: WikiSignalSource;
  producer: WikiSignalProducer;
  applies_to: WikiSignalAppliesTo;
  evidence_refs: string[];
  supersedes: string[];
  status: "active";
  summary?: string;
  observation?: string;
  inference?: string;
  recommendation?: string;
}

export interface WikiPayloadContext {
  module_version?: string;
  workflow_id?: string;
  workflow_revision?: string;
  input_snapshot_id?: string;
  contract_versions?: string[];
  scorer_revision?: string;
  scorer_target?: unknown;
  constraints?: unknown[];
  module_id?: string;
}

export const WIKI_EDGE_TYPES = [
  "extends",
  "contradicts",
  "addresses",
  "child_of",
  "inspired_by",
  "tested_by",
  "supports",
  "invalidates",
  "supersedes",
  "depends_on",
  "refutes",
  "uses",
] as const;

export type WikiEdgeType = (typeof WIKI_EDGE_TYPES)[number];

export type WikiOperation =
  | { op: "upsert_page"; kind: WikiPageKind; id: string; data: Record<string, unknown> }
  | { op: "remove_page"; kind: WikiPageKind; id: string }
  | {
      op: "upsert_edge";
      edge: { from: string; to: string; type: WikiEdgeType; evidence?: string };
    }
  | { op: "remove_edges"; from?: string; to?: string; type?: WikiEdgeType }
  | { op: "append_log"; message: string }
  | { op: "quarantine"; target: string; findings: string[]; raw_text: string }
  | { op: "set_project_direction"; text: string }
  | { op: "set_projection_config"; max_query_chars: number }
  | { op: "publish_signal"; signal: WikiSignal }
  | { op: "upsert_signal"; signal: WikiSignal }
  | { op: "retract_signal"; signal_id: string; reason?: string; evidence_refs?: string[] }
  | { op: "supersede_signal"; signal_id: string; replacement_signal_id: string };

const PAGE_KINDS = new Set<WikiPageKind>(["paper", "idea", "experiment", "claim", "problem"]);
const EDGE_TYPE_SET = new Set<string>(WIKI_EDGE_TYPES);
const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NODE_ID_PATTERN = /^(paper|idea|exp|claim|problem):[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SIGNAL_ID_PATTERN = /^signal:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const PAGE_DATA_KEYS: Record<WikiPageKind, readonly string[]> = {
  paper: [
    "title",
    "authors",
    "year",
    "venue",
    "external_ids",
    "tags",
    "thesis",
    "abstract",
    "primary_category",
  ],
  idea: [
    "title",
    "description",
    "stage",
    "outcome",
    "thesis",
    "risks",
    "based_on",
    "target_problems",
    "tags",
  ],
  experiment: [
    "title",
    "idea_id",
    "verdict",
    "confidence",
    "date",
    "hardware",
    "duration",
    "provenance",
    "metrics",
    "reasoning",
    "iteration",
    "gate_metric",
    "tester_metrics",
    "tester_definition_sha256",
    "tester_conclusion",
    "tester_confidence",
    "tester_directions",
    "tester_advice",
    "tags",
  ],
  claim: [
    "name",
    "description",
    "status",
    "provenance",
    "statement",
    "scope",
    "evidence",
    "tags",
    "date",
  ],
  problem: [
    "title",
    "status",
    "severity",
    "parent",
    "statement",
    "origin",
    "evidence",
    "whatWouldSolve",
    "caveats",
    "tags",
  ],
};

export function isWikiEdgeType(value: unknown): value is WikiEdgeType {
  return typeof value === "string" && EDGE_TYPE_SET.has(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`invalid Wiki operation ${location}: unknown field '${key}'`);
    }
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid Wiki operation: ${label} must be a string`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringField(value, label);
  if (result.trim() === "") throw new Error(`invalid Wiki operation: ${label} must be non-empty`);
  return result;
}

function assertSignalId(value: string, location: string): void {
  if (!SIGNAL_ID_PATTERN.test(value)) {
    throw new Error(`invalid Wiki signal id '${value}' at ${location}`);
  }
}

function assertStringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${location} must be a string array`);
  }
  return [...value] as string[];
}

function parseSignal(value: unknown, location: string): WikiSignal {
  if (!isObject(value)) throw new Error(`${location} must be an object`);
  assertKeys(
    value,
    [
      "signal_id",
      "kind",
      "source",
      "producer",
      "applies_to",
      "evidence_refs",
      "supersedes",
      "status",
      "summary",
      "observation",
      "inference",
      "recommendation",
    ],
    location,
  );
  const signalId = nonEmptyString(value.signal_id, `${location}.signal_id`);
  assertSignalId(signalId, `${location}.signal_id`);
  const kind = nonEmptyString(value.kind, `${location}.kind`) as WikiSignalKind;
  if (!WIKI_SIGNAL_KINDS.includes(kind)) throw new Error(`invalid Wiki signal kind '${kind}'`);
  const source = nonEmptyString(value.source, `${location}.source`) as WikiSignalSource;
  if (!WIKI_SIGNAL_SOURCES.includes(source)) {
    throw new Error(`invalid Wiki signal source '${source}'`);
  }

  if (!isObject(value.producer)) throw new Error(`${location}.producer must be an object`);
  assertKeys(value.producer, ["module_id", "module_version", "run_id"], `${location}.producer`);
  const producer: WikiSignalProducer = {
    module_id: nonEmptyString(value.producer.module_id, `${location}.producer.module_id`),
    module_version: nonEmptyString(
      value.producer.module_version,
      `${location}.producer.module_version`,
    ),
    run_id: nonEmptyString(value.producer.run_id, `${location}.producer.run_id`),
  };

  if (!isObject(value.applies_to)) throw new Error(`${location}.applies_to must be an object`);
  assertKeys(
    value.applies_to,
    [
      "workflow_id",
      "workflow_revision",
      "input_snapshot_id",
      "contract_versions",
      "scorer_revision",
      "scorer_target",
      "constraints",
    ],
    `${location}.applies_to`,
  );
  const appliesTo: WikiSignalAppliesTo = {
    contract_versions: assertStringList(
      value.applies_to.contract_versions,
      `${location}.applies_to.contract_versions`,
    ),
  };
  for (const field of [
    "workflow_id",
    "workflow_revision",
    "input_snapshot_id",
    "scorer_revision",
  ] as const) {
    if (value.applies_to[field] !== undefined) {
      appliesTo[field] = nonEmptyString(value.applies_to[field], `${location}.applies_to.${field}`);
    }
  }
  if (value.applies_to.scorer_target !== undefined) {
    appliesTo.scorer_target = value.applies_to.scorer_target;
  }
  if (value.applies_to.constraints !== undefined) {
    if (!Array.isArray(value.applies_to.constraints)) {
      throw new Error(`${location}.applies_to.constraints must be an array`);
    }
    appliesTo.constraints = [...value.applies_to.constraints];
  }

  const evidenceRefs = assertStringList(value.evidence_refs, `${location}.evidence_refs`);
  const supersedes = assertStringList(value.supersedes, `${location}.supersedes`);
  for (const [index, ref] of [...evidenceRefs, ...supersedes].entries()) {
    if (!ref.trim()) throw new Error(`${location} contains an empty reference at index ${index}`);
  }
  for (const [index, supersededId] of supersedes.entries()) {
    assertSignalId(supersededId, `${location}.supersedes[${index}]`);
    if (supersededId === signalId) {
      throw new Error(`${location}.supersedes cannot contain its own signal_id`);
    }
  }
  if (new Set(supersedes).size !== supersedes.length) {
    throw new Error(`${location}.supersedes must not contain duplicate signal ids`);
  }
  if (value.status !== "active") {
    throw new Error(`${location}.status must be active when publishing a signal`);
  }

  const signal: WikiSignal = {
    signal_id: signalId,
    kind,
    source,
    producer,
    applies_to: appliesTo,
    evidence_refs: evidenceRefs,
    supersedes,
    status: "active",
  };
  for (const field of ["summary", "observation", "inference", "recommendation"] as const) {
    if (value[field] !== undefined)
      signal[field] = stringField(value[field], `${location}.${field}`);
  }
  return signal;
}

function parseSignalId(value: unknown, location: string): string {
  const signalId = nonEmptyString(value, location);
  assertSignalId(signalId, location);
  return signalId;
}

function assertPageId(value: string, location: string): void {
  if (!PAGE_ID_PATTERN.test(value)) {
    throw new Error(
      `invalid Wiki page id '${value}' at ${location}; ids must be single relative path components`,
    );
  }
}

function assertNodeId(value: string, location: string): void {
  if (!NODE_ID_PATTERN.test(value)) {
    throw new Error(`invalid Wiki node id '${value}' at ${location}`);
  }
}

function assertStringArray(value: unknown, location: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${location} must be a string array`);
  }
}

/**
 * A machine-readable metric block: plain names, finite numbers, nothing nested.
 * The export ranks candidates by these, so they have to be comparable without
 * anyone re-reading the free-text `metrics` prose next to them.
 */
function assertNumberRecord(value: unknown, location: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new Error(`${location} must be a non-empty object of metric values`);
  }
  for (const [name, score] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw new Error(`${location} has an invalid metric name '${name}'`);
    if (typeof score !== "number" || !Number.isFinite(score))
      throw new Error(`${location}.${name} must be a finite number`);
  }
}

function assertOptionalStrings(
  data: Record<string, unknown>,
  fields: readonly string[],
  location: string,
): void {
  for (const field of fields) {
    if (data[field] !== undefined && typeof data[field] !== "string") {
      throw new Error(`${location}.${field} must be a string`);
    }
  }
}

function validatePageData(
  kind: WikiPageKind,
  data: Record<string, unknown>,
  location: string,
): void {
  assertKeys(data, PAGE_DATA_KEYS[kind], location);
  switch (kind) {
    case "paper": {
      assertOptionalStrings(
        data,
        ["title", "venue", "thesis", "abstract", "primary_category"],
        location,
      );
      if (data.authors !== undefined) assertStringArray(data.authors, `${location}.authors`);
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      if (
        data.year !== undefined &&
        (!Number.isInteger(data.year) || !Number.isFinite(data.year))
      ) {
        throw new Error(`${location}.year must be a finite integer`);
      }
      if (data.external_ids !== undefined) {
        if (!isObject(data.external_ids))
          throw new Error(`${location}.external_ids must be an object`);
        assertKeys(data.external_ids, ["arxiv", "doi", "s2"], `${location}.external_ids`);
        assertOptionalStrings(
          data.external_ids,
          ["arxiv", "doi", "s2"],
          `${location}.external_ids`,
        );
      }
      return;
    }
    case "idea":
      assertOptionalStrings(
        data,
        ["title", "description", "stage", "outcome", "thesis", "risks"],
        location,
      );
      for (const field of ["based_on", "target_problems", "tags"]) {
        if (data[field] !== undefined) assertStringArray(data[field], `${location}.${field}`);
      }
      return;
    case "experiment":
      assertOptionalStrings(
        data,
        [
          "title",
          "idea_id",
          "verdict",
          "confidence",
          "date",
          "hardware",
          "duration",
          "provenance",
          "metrics",
          "reasoning",
        ],
        location,
      );
      assertOptionalStrings(data, ["tester_definition_sha256"], location);
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      if (data.idea_id !== undefined && data.idea_id !== "")
        assertNodeId(data.idea_id as string, `${location}.idea_id`);
      // The loop numbers its own iterations from 1; an experiment without one
      // cannot be lined up against the dashboard metric history.
      if (
        data.iteration !== undefined &&
        (!Number.isInteger(data.iteration) || (data.iteration as number) < 1)
      )
        throw new Error(`${location}.iteration must be an integer >= 1`);
      if (
        data.gate_metric !== undefined &&
        (typeof data.gate_metric !== "number" || !Number.isFinite(data.gate_metric))
      )
        throw new Error(`${location}.gate_metric must be a finite number`);
      if (data.tester_metrics !== undefined)
        assertNumberRecord(data.tester_metrics, `${location}.tester_metrics`);
      if (
        data.tester_definition_sha256 !== undefined &&
        data.tester_definition_sha256 !== "" &&
        !/^[0-9a-f]{64}$/.test(data.tester_definition_sha256 as string)
      )
        throw new Error(`${location}.tester_definition_sha256 must be a sha256 hex digest`);
      // The tester's coarse verdict travels with its numbers. Only the shape is
      // checked here, the same way `tester_metrics` is: the fixed vocabularies
      // live in `tester-feedback.ts` and are enforced when the tester signs the
      // feedback, and only a signature-verified envelope reaches this page.
      assertOptionalStrings(data, ["tester_conclusion", "tester_confidence"], location);
      for (const field of ["tester_directions", "tester_advice"] as const) {
        if (data[field] === undefined) continue;
        assertStringArray(data[field], `${location}.${field}`);
        const items = data[field] as string[];
        if (new Set(items).size !== items.length)
          throw new Error(`${location}.${field} must not repeat a value`);
      }
      return;
    case "claim":
      assertOptionalStrings(
        data,
        ["name", "description", "status", "provenance", "statement", "scope", "evidence", "date"],
        location,
      );
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      return;
    case "problem":
      assertOptionalStrings(
        data,
        [
          "title",
          "status",
          "severity",
          "parent",
          "statement",
          "origin",
          "evidence",
          "whatWouldSolve",
          "caveats",
        ],
        location,
      );
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      if (data.parent !== undefined && data.parent !== "")
        assertNodeId(data.parent as string, `${location}.parent`);
      return;
  }
}

export function parseWikiOperation(value: unknown, location: string): WikiOperation {
  if (!isObject(value)) throw new Error(`invalid Wiki operation at ${location}`);
  const op = stringField(value.op, `${location}.op`);
  switch (op) {
    case "upsert_page": {
      assertKeys(value, ["op", "kind", "id", "data"], location);
      const kind = stringField(value.kind, `${location}.kind`) as WikiPageKind;
      if (!PAGE_KINDS.has(kind)) throw new Error(`invalid Wiki page kind '${kind}'`);
      const id = stringField(value.id, `${location}.id`);
      if (!isObject(value.data)) throw new Error(`${location}.data must be an object`);
      assertPageId(id, `${location}.id`);
      validatePageData(kind, value.data, `${location}.data`);
      return { op, kind, id, data: value.data };
    }
    case "remove_page": {
      assertKeys(value, ["op", "kind", "id"], location);
      const kind = stringField(value.kind, `${location}.kind`) as WikiPageKind;
      if (!PAGE_KINDS.has(kind)) throw new Error(`invalid Wiki page kind '${kind}'`);
      const id = stringField(value.id, `${location}.id`);
      assertPageId(id, `${location}.id`);
      return { op, kind, id };
    }
    case "upsert_edge": {
      assertKeys(value, ["op", "edge"], location);
      if (!isObject(value.edge)) throw new Error(`${location}.edge must be an object`);
      assertKeys(value.edge, ["from", "to", "type", "evidence"], `${location}.edge`);
      const from = stringField(value.edge.from, `${location}.edge.from`);
      const to = stringField(value.edge.to, `${location}.edge.to`);
      const type = stringField(value.edge.type, `${location}.edge.type`);
      if (!EDGE_TYPE_SET.has(type)) throw new Error(`invalid Wiki edge type '${type}'`);
      assertNodeId(from, `${location}.edge.from`);
      assertNodeId(to, `${location}.edge.to`);
      return {
        op,
        edge: {
          from,
          to,
          type: type as WikiEdgeType,
          evidence:
            value.edge.evidence === undefined
              ? ""
              : stringField(value.edge.evidence, `${location}.edge.evidence`),
        },
      };
    }
    case "remove_edges": {
      assertKeys(value, ["op", "from", "to", "type"], location);
      for (const key of ["from", "to", "type"] as const) {
        if (value[key] !== undefined) stringField(value[key], `${location}.${key}`);
      }
      if (value.from !== undefined) assertNodeId(value.from as string, `${location}.from`);
      if (value.to !== undefined) assertNodeId(value.to as string, `${location}.to`);
      if (value.type !== undefined && !EDGE_TYPE_SET.has(value.type as string)) {
        throw new Error(`invalid Wiki edge type '${value.type}'`);
      }
      return {
        op,
        from: value.from as string | undefined,
        to: value.to as string | undefined,
        type: value.type as WikiEdgeType | undefined,
      };
    }
    case "append_log":
      assertKeys(value, ["op", "message"], location);
      return { op, message: stringField(value.message, `${location}.message`) };
    case "quarantine":
      assertKeys(value, ["op", "target", "findings", "raw_text"], location);
      if (
        !Array.isArray(value.findings) ||
        !value.findings.every((item) => typeof item === "string")
      ) {
        throw new Error(`${location}.findings must be a string array`);
      }
      return {
        op,
        target: stringField(value.target, `${location}.target`),
        findings: [...value.findings],
        raw_text: stringField(value.raw_text, `${location}.raw_text`),
      };
    case "set_project_direction":
      assertKeys(value, ["op", "text"], location);
      return { op, text: stringField(value.text, `${location}.text`) };
    case "set_projection_config": {
      assertKeys(value, ["op", "max_query_chars"], location);
      if (
        typeof value.max_query_chars !== "number" ||
        !Number.isInteger(value.max_query_chars) ||
        value.max_query_chars < 200
      ) {
        throw new Error(`${location}.max_query_chars must be an integer >= 200`);
      }
      return { op, max_query_chars: value.max_query_chars };
    }
    case "publish_signal":
    case "upsert_signal":
      assertKeys(value, ["op", "signal"], location);
      return { op, signal: parseSignal(value.signal, `${location}.signal`) };
    case "retract_signal": {
      assertKeys(value, ["op", "signal_id", "reason", "evidence_refs"], location);
      const result: WikiOperation = {
        op,
        signal_id: parseSignalId(value.signal_id, `${location}.signal_id`),
      };
      if (value.reason !== undefined) {
        (result as { reason?: string }).reason = stringField(value.reason, `${location}.reason`);
      }
      if (value.evidence_refs !== undefined) {
        (result as { evidence_refs?: string[] }).evidence_refs = assertStringList(
          value.evidence_refs,
          `${location}.evidence_refs`,
        );
      }
      return result;
    }
    case "supersede_signal":
      assertKeys(value, ["op", "signal_id", "replacement_signal_id"], location);
      return {
        op,
        signal_id: parseSignalId(value.signal_id, `${location}.signal_id`),
        replacement_signal_id: parseSignalId(
          value.replacement_signal_id,
          `${location}.replacement_signal_id`,
        ),
      };
    default:
      throw new Error(`invalid Wiki operation '${op}' at ${location}`);
  }
}

function parsePayloadContext(value: unknown): WikiPayloadContext {
  if (!isObject(value)) throw new Error("Wiki payload.context must be an object");
  assertKeys(
    value,
    [
      "module_version",
      "workflow_id",
      "workflow_revision",
      "input_snapshot_id",
      "contract_versions",
      "scorer_revision",
      "scorer_target",
      "constraints",
      "module_id",
    ],
    "payload.context",
  );
  const context: WikiPayloadContext = {};
  for (const field of [
    "module_version",
    "workflow_id",
    "workflow_revision",
    "input_snapshot_id",
    "scorer_revision",
    "module_id",
  ] as const) {
    if (value[field] !== undefined)
      context[field] = nonEmptyString(value[field], `payload.context.${field}`);
  }
  if (value.contract_versions !== undefined) {
    context.contract_versions = assertStringList(
      value.contract_versions,
      "payload.context.contract_versions",
    );
  }
  if (value.scorer_target !== undefined) context.scorer_target = value.scorer_target;
  if (value.constraints !== undefined) {
    if (!Array.isArray(value.constraints)) {
      throw new Error("payload.context.constraints must be an array");
    }
    context.constraints = [...value.constraints];
  }
  return context;
}

export interface WikiPayload {
  operations: WikiOperation[];
  context?: WikiPayloadContext;
}

export function parseWikiPayload(payload: unknown): WikiPayload {
  if (!isObject(payload)) throw new Error("Wiki payload must be an object");
  assertKeys(payload, ["operations", "context"], "payload");
  if (!Array.isArray(payload.operations)) {
    throw new Error("Wiki payload.operations must be an array");
  }
  const parsed: WikiPayload = {
    operations: payload.operations.map((item, index) =>
      parseWikiOperation(item, `payload.operations[${index}]`),
    ),
  };
  if (payload.context !== undefined) parsed.context = parsePayloadContext(payload.context);
  return parsed;
}

export function validateWikiPayload(payload: unknown): void {
  parseWikiPayload(payload);
}
