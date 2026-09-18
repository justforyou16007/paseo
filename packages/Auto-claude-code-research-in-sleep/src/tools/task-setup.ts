import { initializeRunBudget, normalizeBudget } from "./run-budget.js";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { createArtifactRegistry, type ArtifactRegistry } from "./artifact-registry.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  A1Error,
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireBoolean,
  requireFiniteNumber,
  requireInteger,
  requireString,
  validateModelUsagePolicy,
  type JsonObject,
  type ModelRolePolicy,
  type ModelUsagePolicy,
} from "./workflow-spec.js";
import {
  validateTesterAgentConfig,
  testerAgentConfigSha256,
  type TesterAgentConfig,
} from "./tester-agent.js";
import { validateTesterDefinition } from "./tester-state.js";
import {
  createBaselineScope,
  saveBaselineScope,
  validateBaselineScope,
  type BaselineScope,
} from "./baseline-scope.js";
import {
  createResourceInventory,
  saveResourceInventory,
  validateResourceInventory,
  type ResourceInventory,
} from "./resource-inventory.js";
import { createRootCharter, saveRootCharter, type RootCharter } from "./root-charter.js";
import {
  createRootRun,
  openExistingRun,
  readRun,
  readRunScopeLeaseTokens,
  releaseRunScope,
  runJsonPath,
  type RunRecord,
} from "./run-contract.js";

export interface TaskSetupDocument {
  schema_version: 1;
  task_id: string;
  workflow_id: string;
  setup_revision: string;
  model_usage_policy: ModelUsagePolicy;
  policy_sha256: string;
  tester_id: string;
  tester_version: string;
}

export interface ModelUsagePolicyRevisionDocument {
  schema_version: 1;
  workflow_id: string;
  policy_revision: string;
  policy_sha256: string;
  model_usage_policy: ModelUsagePolicy;
}

export interface TaskSetupValidationOptions {
  known_module_ids?: readonly string[];
  known_target_ids?: readonly string[];
  registry?: ArtifactRegistry;
  candidate_id?: string;
  producer_run_id?: string;
  candidate_artifact_ids?: readonly string[];
  candidate_output_artifact_ids?: readonly string[];
}

function validateRoleScope(role: ModelRolePolicy, options: TaskSetupValidationOptions): void {
  if (!role.user_confirmed || role.approval_id.trim() === "") {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      `model role '${role.role_id}' has no user confirmation`,
    );
  }
  if (options.known_module_ids) {
    const known = new Set(options.known_module_ids);
    for (const moduleId of role.allowed_modules) {
      if (
        !known.has(moduleId) &&
        moduleId !== "validation-scorer" &&
        moduleId !== "promotion-tester"
      ) {
        failA1(
          "MODEL_SCOPE_ALIGNMENT_REQUIRED",
          `role '${role.role_id}' names an unregistered module '${moduleId}'`,
        );
      }
    }
  }
  if (options.known_target_ids) {
    const known = new Set(options.known_target_ids);
    for (const target of role.judge_targets) {
      if (!known.has(target))
        failA1(
          "MODEL_SCOPE_ALIGNMENT_REQUIRED",
          `role '${role.role_id}' names an unapproved judge target '${target}'`,
        );
    }
  }
  if (role.allowed_uses.includes("judge")) {
    if (role.judge_generation_lag === null || role.judge_generation_lag < 1) {
      failA1(
        "JUDGE_LAG_VIOLATION",
        `judge role '${role.role_id}' must lag at least one promoted generation`,
      );
    }
    if (
      role.artifact_binding.source !== "previous_promoted" &&
      role.artifact_binding.source !== "fixed_external"
    ) {
      failA1("JUDGE_LAG_VIOLATION", `judge role '${role.role_id}' has an unsupported source`);
    }
    if (
      role.artifact_binding.source === "previous_promoted" &&
      role.artifact_binding.artifact_id !== null
    ) {
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        "previous_promoted bindings cannot pin a current artifact id",
      );
    }
  }
}

function isArtifactRegistry(value: unknown): value is ArtifactRegistry {
  if (!isRecord(value)) return false;
  return (
    typeof value.assertFixedExternal === "function" &&
    typeof value.assertNoSelfEvaluation === "function" &&
    typeof value.findByCandidate === "function"
  );
}

function requireArtifactRegistry(value: unknown): ArtifactRegistry {
  if (!isArtifactRegistry(value))
    failA1("ARTIFACT_REGISTRY_REQUIRED", "validation must use the system Artifact registry");
  return value;
}

function assertExactIds(
  supplied: readonly string[],
  expected: readonly string[],
  location: string,
): void {
  if (new Set(supplied).size !== supplied.length)
    failA1("DUPLICATE_ID", "caller artifact ids must be unique", location);
  const suppliedIds = [...supplied].sort(compareIdentityStrings);
  const expectedIds = [...expected].sort(compareIdentityStrings);
  if (
    suppliedIds.length !== expectedIds.length ||
    suppliedIds.some((artifactId, index) => artifactId !== expectedIds[index])
  )
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      "caller artifact ids do not match the registered candidate outputs",
      location,
    );
}

function candidateArtifactsFromRegistry(options: TaskSetupValidationOptions): {
  allIds: string[];
  outputIds: string[];
} {
  const hasCandidateContext =
    options.candidate_id !== undefined ||
    options.producer_run_id !== undefined ||
    options.candidate_artifact_ids !== undefined ||
    options.candidate_output_artifact_ids !== undefined;
  if (!hasCandidateContext) return { allIds: [], outputIds: [] };
  if (!options.registry || options.candidate_id === undefined)
    failA1(
      "ARTIFACT_REGISTRY_REQUIRED",
      "candidate lineage must be derived from a registered candidate and Artifact registry",
    );
  const registry = requireArtifactRegistry(options.registry);
  const entries = registry.findByCandidate(options.candidate_id, options.producer_run_id);
  if (entries.length === 0)
    failA1(
      "ARTIFACT_NOT_FOUND",
      `no registered workflow outputs exist for candidate '${options.candidate_id}'`,
    );
  const allIds = entries.map((entry) => entry.artifact_id).sort(compareIdentityStrings);
  const outputIds = entries
    .filter((entry) => entry.role_id !== null && entry.output_slot !== null)
    .map((entry) => entry.artifact_id)
    .sort(compareIdentityStrings);
  if (options.candidate_artifact_ids !== undefined)
    assertExactIds(options.candidate_artifact_ids, allIds, "candidate_artifact_ids");
  if (options.candidate_output_artifact_ids !== undefined) {
    if (
      new Set(options.candidate_output_artifact_ids).size !==
      options.candidate_output_artifact_ids.length
    )
      failA1(
        "DUPLICATE_ID",
        "candidate output artifact ids must be unique",
        "candidate_output_artifact_ids",
      );
    for (const artifactId of options.candidate_output_artifact_ids)
      if (!outputIds.includes(artifactId))
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `candidate output '${artifactId}' is not registered for this candidate`,
          "candidate_output_artifact_ids",
        );
  }
  return { allIds, outputIds };
}

export function assertTaskSetupJudgeSafety(
  policy: ModelUsagePolicy,
  options: TaskSetupValidationOptions = {},
): void {
  const normalizedOptions = normalizeValidationOptions(options) ?? {};
  const candidateArtifacts = candidateArtifactsFromRegistry(normalizedOptions);
  for (const role of policy.roles) {
    validateRoleScope(role, normalizedOptions);
    const binding = role.artifact_binding;
    if (binding.source !== "fixed_external" || binding.artifact_id === null) continue;
    if (!normalizedOptions.registry)
      failA1(
        "ARTIFACT_REGISTRY_REQUIRED",
        `fixed external role '${role.role_id}' must resolve through the Artifact registry`,
      );
    const registry = requireArtifactRegistry(normalizedOptions.registry);
    registry.assertFixedExternal(binding.artifact_id);
    const candidateIds = candidateArtifacts.allIds;
    const outputIds = candidateArtifacts.outputIds;
    if (candidateIds.includes(binding.artifact_id) || outputIds.includes(binding.artifact_id)) {
      failA1(
        "JUDGE_LAG_VIOLATION",
        `judge role '${role.role_id}' is bound to the current candidate lineage`,
      );
    }
    registry.assertNoSelfEvaluation(candidateIds, [binding.artifact_id]);
  }
}

function validateTaskSetupPolicyShape(value: unknown): ModelUsagePolicy {
  const policy = validateModelUsagePolicy(value, "task_setup.model_usage_policy");
  if (isRecord(value) && Object.hasOwn(value, "benchmark_coverage")) {
    failA1(
      "UNKNOWN_FIELD",
      "task setup does not accept benchmark coverage questions",
      "task_setup.benchmark_coverage",
    );
  }
  return policy;
}

export function validateTaskSetupPolicy(
  value: unknown,
  options: TaskSetupValidationOptions = {},
): ModelUsagePolicy {
  const policy = validateTaskSetupPolicyShape(value);
  assertTaskSetupJudgeSafety(policy, options);
  return policy;
}

export interface CreateTaskSetupInput {
  task_id: string;
  workflow_id: string;
  setup_revision: string;
  model_usage_policy: unknown;
  tester_id: string;
  tester_version: string;
  validation?: TaskSetupValidationOptions;
}

function normalizeValidationOptions(value: unknown): TaskSetupValidationOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    failA1(
      "INVALID_VALUE",
      "task setup validation options must be an object",
      "task_setup.validation",
    );
  assertNoUnknownFields(
    value,
    [
      "known_module_ids",
      "known_target_ids",
      "candidate_id",
      "producer_run_id",
      "registry",
      "candidate_artifact_ids",
      "candidate_output_artifact_ids",
    ],
    "task_setup.validation",
  );
  for (const field of [
    "known_module_ids",
    "known_target_ids",
    "candidate_artifact_ids",
    "candidate_output_artifact_ids",
  ] as const) {
    if (
      value[field] !== undefined &&
      (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string"))
    ) {
      failA1(
        "INVALID_VALUE",
        `${field} must be an array of strings`,
        `task_setup.validation.${field}`,
      );
    }
  }
  const normalizeIds = (
    field:
      | "known_module_ids"
      | "known_target_ids"
      | "candidate_artifact_ids"
      | "candidate_output_artifact_ids",
  ): string[] | undefined => {
    if (value[field] === undefined) return undefined;
    const ids = Array.isArray(value[field])
      ? value[field].map((item, index) =>
          assertIdentifier(item, `task_setup.validation.${field}[${index}]`),
        )
      : undefined;
    if (
      field === "candidate_output_artifact_ids" &&
      ids !== undefined &&
      new Set(ids).size !== ids.length
    )
      failA1(
        "DUPLICATE_ID",
        "candidate output artifact ids must be unique",
        `task_setup.validation.${field}`,
      );
    return ids;
  };
  const candidateId =
    value.candidate_id === undefined
      ? undefined
      : assertIdentifier(value.candidate_id, "task_setup.validation.candidate_id");
  const producerRunId =
    value.producer_run_id === undefined
      ? undefined
      : assertIdentifier(value.producer_run_id, "task_setup.validation.producer_run_id");
  return {
    known_module_ids: normalizeIds("known_module_ids"),
    known_target_ids: normalizeIds("known_target_ids"),
    registry: value.registry === undefined ? undefined : requireArtifactRegistry(value.registry),
    candidate_id: candidateId,
    producer_run_id: producerRunId,
    candidate_artifact_ids: normalizeIds("candidate_artifact_ids"),
    candidate_output_artifact_ids: normalizeIds("candidate_output_artifact_ids"),
  };
}

export function createTaskSetup(input: CreateTaskSetupInput): TaskSetupDocument {
  if (!isRecord(input)) failA1("INVALID_VALUE", "task setup input must be an object", "task_setup");
  assertNoUnknownFields(
    input,
    [
      "task_id",
      "workflow_id",
      "setup_revision",
      "model_usage_policy",
      "tester_id",
      "tester_version",
      "validation",
    ],
    "task_setup",
  );
  const taskId = assertIdentifier(input.task_id, "task_setup.task_id");
  const workflowId = assertIdentifier(input.workflow_id, "task_setup.workflow_id");
  const setupRevision = assertIdentifier(input.setup_revision, "task_setup.setup_revision");
  const testerId = assertIdentifier(input.tester_id, "task_setup.tester_id");
  const testerVersion = assertIdentifier(input.tester_version, "task_setup.tester_version");
  const policy = validateTaskSetupPolicy(
    input.model_usage_policy,
    normalizeValidationOptions(input.validation),
  );
  const policySha256 = canonicalJsonSha256(policy, undefined, {
    schemaVersion: "model-usage-policy-v1",
  });
  return {
    schema_version: 1,
    task_id: taskId,
    workflow_id: workflowId,
    setup_revision: setupRevision,
    model_usage_policy: policy,
    policy_sha256: policySha256,
    tester_id: testerId,
    tester_version: testerVersion,
  };
}

export function validateTaskSetupDocument(
  value: unknown,
  location = "task_setup",
): TaskSetupDocument {
  if (!isRecord(value)) failA1("CORRUPT_SETUP", "task setup must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "task_id",
      "workflow_id",
      "setup_revision",
      "model_usage_policy",
      "policy_sha256",
      "tester_id",
      "tester_version",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_SETUP", "task setup schema_version must be 1", `${location}.schema_version`);
  const taskId = assertIdentifier(value.task_id, `${location}.task_id`);
  const workflowId = assertIdentifier(value.workflow_id, `${location}.workflow_id`);
  const setupRevision = assertIdentifier(value.setup_revision, `${location}.setup_revision`);
  const testerId = assertIdentifier(value.tester_id, `${location}.tester_id`);
  const testerVersion = assertIdentifier(value.tester_version, `${location}.tester_version`);
  const policy = validateTaskSetupPolicyShape(value.model_usage_policy);
  const policySha256 = canonicalJsonSha256(policy, undefined, {
    schemaVersion: "model-usage-policy-v1",
  });
  if (assertSha256(value.policy_sha256, `${location}.policy_sha256`) !== policySha256)
    failA1("CORRUPT_SETUP", "task setup policy hash does not match its policy", location);
  return {
    schema_version: 1,
    task_id: taskId,
    workflow_id: workflowId,
    setup_revision: setupRevision,
    model_usage_policy: policy,
    policy_sha256: policySha256,
    tester_id: testerId,
    tester_version: testerVersion,
  };
}

export function taskSetupPath(
  projectRoot: string,
  workflowId: string,
  setupRevision: string,
): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "workflows",
    assertIdentifier(workflowId, "workflow_id"),
    "task-setups",
    `${assertIdentifier(setupRevision, "setup_revision")}.json`,
  );
}

export function modelUsagePolicyPath(
  projectRoot: string,
  workflowId: string,
  policyRevision: string,
): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "workflows",
    assertIdentifier(workflowId, "workflow_id"),
    "model-usage-policies",
    `${assertIdentifier(policyRevision, "model_usage_policy_revision")}.json`,
  );
}

function policyHash(policy: ModelUsagePolicy): string {
  return canonicalJsonSha256(policy, undefined, { schemaVersion: "model-usage-policy-v1" });
}

function validateModelUsagePolicyRevisionDocument(
  value: unknown,
  location: string,
): ModelUsagePolicyRevisionDocument {
  if (!isRecord(value))
    failA1("CORRUPT_POLICY_REVISION", "model usage policy revision must be an object", location);
  assertNoUnknownFields(
    value,
    ["schema_version", "workflow_id", "policy_revision", "policy_sha256", "model_usage_policy"],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_POLICY_REVISION", "policy revision schema_version must be 1", location);
  const workflowId = assertIdentifier(value.workflow_id, `${location}.workflow_id`);
  const policyRevision = assertIdentifier(value.policy_revision, `${location}.policy_revision`);
  const policy = validateModelUsagePolicy(
    value.model_usage_policy,
    `${location}.model_usage_policy`,
  );
  if (policy.revision !== policyRevision)
    failA1("IDENTITY_MISMATCH", "policy revision and embedded policy disagree", location);
  const digest = policyHash(policy);
  if (assertSha256(value.policy_sha256, `${location}.policy_sha256`) !== digest)
    failA1("CORRUPT_POLICY_REVISION", "policy revision hash does not match its policy", location);
  return {
    schema_version: 1,
    workflow_id: workflowId,
    policy_revision: policyRevision,
    policy_sha256: digest,
    model_usage_policy: policy,
  };
}

/** Store the policy under its own immutable revision before a setup can use it. */
export function saveModelUsagePolicyRevision(
  projectRoot: string,
  workflowId: string,
  value: unknown,
  registry?: ArtifactRegistry,
): ModelUsagePolicyRevisionDocument {
  const safeWorkflowId = assertIdentifier(workflowId, "workflow_id");
  const policy = validateModelUsagePolicy(value, "model_usage_policy");
  assertTaskSetupJudgeSafety(policy, { registry });
  const document: ModelUsagePolicyRevisionDocument = {
    schema_version: 1,
    workflow_id: safeWorkflowId,
    policy_revision: policy.revision,
    policy_sha256: policyHash(policy),
    model_usage_policy: policy,
  };
  const filePath = modelUsagePolicyPath(projectRoot, safeWorkflowId, policy.revision);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateModelUsagePolicyRevisionDocument(readStateFile(filePath), filePath);
      if (
        existing.workflow_id === document.workflow_id &&
        existing.policy_revision === document.policy_revision &&
        existing.policy_sha256 === document.policy_sha256
      )
        return existing;
      failA1(
        "IMMUTABLE_CONFLICT",
        `model usage policy revision '${document.policy_revision}' already exists with different content`,
      );
    }
    writeStateJsonAtomic(filePath, document);
    return document;
  });
}

export function loadModelUsagePolicyRevision(
  projectRoot: string,
  workflowId: string,
  policyRevision: string,
): ModelUsagePolicyRevisionDocument {
  const filePath = modelUsagePolicyPath(projectRoot, workflowId, policyRevision);
  if (!fs.existsSync(filePath))
    failA1(
      "POLICY_REVISION_NOT_FOUND",
      `model usage policy revision does not exist at ${filePath}`,
    );
  const document = validateModelUsagePolicyRevisionDocument(readStateFile(filePath), filePath);
  if (document.workflow_id !== workflowId || document.policy_revision !== policyRevision)
    failA1("IDENTITY_MISMATCH", "policy revision path and content disagree", filePath);
  return document;
}

export function saveTaskSetup(projectRoot: string, input: CreateTaskSetupInput): TaskSetupDocument {
  const document = createTaskSetup(input);
  const validation = normalizeValidationOptions(input.validation);
  saveModelUsagePolicyRevision(
    projectRoot,
    document.workflow_id,
    document.model_usage_policy,
    validation?.registry,
  );
  const filePath = taskSetupPath(projectRoot, document.workflow_id, document.setup_revision);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateTaskSetupDocument(readStateFile(filePath), filePath);
      if (
        canonicalJsonSha256(existing, undefined, { schemaVersion: "task-setup-v1" }) ===
        canonicalJsonSha256(document, undefined, { schemaVersion: "task-setup-v1" })
      )
        return existing;
      failA1(
        "IMMUTABLE_CONFLICT",
        `task setup '${document.setup_revision}' already exists with different content`,
      );
    }
    writeStateJsonAtomic(filePath, document);
    return document;
  });
}

export function loadTaskSetup(
  projectRoot: string,
  workflowId: string,
  setupRevision: string,
): TaskSetupDocument {
  const filePath = taskSetupPath(projectRoot, workflowId, setupRevision);
  if (!fs.existsSync(filePath))
    failA1("SETUP_NOT_FOUND", `task setup does not exist at ${filePath}`);
  const parsed = readStateFile(filePath);
  const document = validateTaskSetupDocument(parsed, filePath);
  if (document.workflow_id !== workflowId || document.setup_revision !== setupRevision)
    failA1("IDENTITY_MISMATCH", "task setup path and content disagree", filePath);
  const policyRevision = loadModelUsagePolicyRevision(
    projectRoot,
    workflowId,
    document.model_usage_policy.revision,
  );
  if (policyRevision.policy_sha256 !== document.policy_sha256)
    failA1(
      "IDENTITY_MISMATCH",
      "task setup does not match its immutable policy revision",
      filePath,
    );
  return { ...document, model_usage_policy: policyRevision.model_usage_policy };
}

export function createRegistryForTaskSetup(projectRoot: string, runId: string): ArtifactRegistry {
  return createArtifactRegistry(projectRoot, runId);
}

/** The setup fields whose owner confirmation can be reused on re-entry. */
export const ROOT_SETUP_ITEMS = [
  "tester",
  "tester_agent",
  "thresholds",
  "exposure",
  "limits",
  "resource",
  "baseline",
] as const;

export type RootSetupItem = (typeof ROOT_SETUP_ITEMS)[number];
export type SetupConfirmationHashes = Partial<Record<RootSetupItem, string>>;

export class SetupIncompleteError extends A1Error {
  readonly missing: RootSetupItem[];
  readonly missing_items: RootSetupItem[];

  constructor(missing: readonly RootSetupItem[]) {
    const items = [...missing];
    super("SETUP_INCOMPLETE", `setup is missing: ${items.join(", ")}`, "setup");
    this.missing = items;
    this.missing_items = [...items];
  }
}

export interface SetupReentryDiff {
  added: RootSetupItem[];
  changed: RootSetupItem[];
  removed: RootSetupItem[];
  reused: RootSetupItem[];
  confirmation_required: RootSetupItem[];
  new_items: RootSetupItem[];
  changed_items: RootSetupItem[];
}

export interface RootSetupRevisionDocument {
  schema_version: 1;
  task_id: string;
  workflow_id: string;
  setup_revision: string;
  run_id: string;
  confirmation_hashes: Record<RootSetupItem, string>;
  charter_sha256: string;
  baseline_sha256: string;
  resource_inventory_sha256: string;
  reentry_diff: SetupReentryDiff;
  revision_sha256: string;
}

export interface RootSetupInput {
  project_root: string;
  run_id: string;
  task_id: string;
  workflow_id: string;
  setup_revision: string;
  problem: string;
  expected_output: unknown;
  workflow_definition?: unknown;
  baseline?: unknown;
  baseline_scope?: unknown;
  tester_definition?: unknown;
  tester?: unknown;
  tester_agent_config?: unknown;
  tester_agent?: unknown;
  validation_thresholds?: unknown;
  thresholds?: unknown;
  exposure_limit?: unknown;
  exposure?: unknown;
  owner_limits?: unknown;
  limits?: unknown;
  resource_inventory?: unknown;
  resource?: unknown;
  model_usage_policy?: unknown;
  tester_id?: string;
  tester_version?: string;
  validator_ref?: string;
  input_snapshot_refs?: readonly string[];
  evidence_refs?: readonly string[];
  constraints?: Record<string, unknown>;
  budget?: unknown;

  tester_ref?: string;
  previous_setup?: unknown;
  previous_setup_revision?: string;
  [key: string]: unknown;
}

export interface RootSetupResult {
  root_charter: RootCharter;
  baseline: BaselineScope;
  resource_inventory: ResourceInventory;
  confirmation_hashes: Record<RootSetupItem, string>;
  reentry_diff: SetupReentryDiff;
  setup_revision: RootSetupRevisionDocument;
  task_setup?: TaskSetupDocument;
}

const pendingRootSetupDrafts = new Map<string, RootSetupInput>();

function setupDraftKey(input: RootSetupInput): string {
  return ["project_root", "run_id", "task_id", "workflow_id", "setup_revision"]
    .map((field) => `${field}:${typeof input[field]}:${String(input[field])}`)
    .join("\u0000");
}

function cloneSetupDraftValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneSetupDraftValue(item, seen));
    return result;
  }
  if (!isRecord(value)) return value;
  const result: JsonObject = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) result[key] = cloneSetupDraftValue(item, seen);
  return result;
}

function cloneSetupDraft(input: RootSetupInput): RootSetupInput {
  return cloneSetupDraftValue(input) as RootSetupInput;
}

function confirmationHashesFromPendingDraft(
  draft: RootSetupInput,
  fallbackLimits: JsonObject,
): SetupConfirmationHashes {
  const hashes: SetupConfirmationHashes = {};
  const testerValue = setupInputValue(draft, ["tester_definition", "tester"]);
  if (testerValue !== undefined) {
    hashes.tester = canonicalJsonSha256(normalizeTester(testerValue), undefined, {
      schemaVersion: "setup-tester-confirmation-v1",
    });
  }
  const testerAgentValue = setupInputValue(draft, ["tester_agent_config", "tester_agent"]);
  if (testerAgentValue !== undefined) {
    hashes.tester_agent = canonicalJsonSha256(normalizeTesterAgent(testerAgentValue), undefined, {
      schemaVersion: "setup-tester-agent-confirmation-v1",
    });
  }
  const thresholdValue = setupInputValue(draft, ["validation_thresholds", "thresholds"]);
  if (thresholdValue !== undefined) {
    hashes.thresholds = canonicalJsonSha256(normalizeThresholds(thresholdValue), undefined, {
      schemaVersion: "setup-threshold-confirmation-v1",
    });
  }
  const exposureValue = setupInputValue(draft, ["exposure_limit", "exposure"]);
  if (exposureValue !== undefined) {
    hashes.exposure = canonicalJsonSha256(
      { exposure: normalizeExposure(exposureValue) },
      undefined,
      { schemaVersion: "setup-exposure-confirmation-v1" },
    );
  }
  const limitsValue = setupInputValue(draft, ["owner_limits", "limits"]);
  const pendingLimits =
    limitsValue === undefined ? undefined : normalizeOwnerLimitsForRoot(limitsValue);
  if (pendingLimits !== undefined) {
    hashes.limits = canonicalJsonSha256(pendingLimits, undefined, {
      schemaVersion: "setup-limits-confirmation-v1",
    });
  }
  const resourceValue = setupInputValue(draft, ["resource_inventory", "resource"]);
  if (resourceValue !== undefined) {
    const resource =
      isRecord(resourceValue) && Object.hasOwn(resourceValue, "inventory_sha256")
        ? validateResourceInventory(resourceValue)
        : createResourceInventory(resourceValue);
    hashes.resource = resource.inventory_sha256;
  }
  const baselineValue = setupInputValue(draft, ["baseline_scope", "baseline"]);
  if (baselineValue !== undefined) {
    if (!isRecord(baselineValue))
      failA1("INVALID_BASELINE", "baseline must be an object", "baseline");
    const baselineInputValue =
      Object.hasOwn(baselineValue, "workflow_definition") || draft.workflow_definition === undefined
        ? baselineValue
        : { ...baselineValue, workflow_definition: draft.workflow_definition };
    const baseline = Object.hasOwn(baselineValue, "baseline_sha256")
      ? validateBaselineScope(baselineValue)
      : createBaselineScope({
          ...(baselineInputValue as JsonObject),
          owner_limits: pendingLimits ?? fallbackLimits,
        });
    hashes.baseline = baseline.baseline_sha256;
  }
  return hashes;
}

function presentField(value: JsonObject, names: readonly string[]): unknown {
  for (const name of names) {
    // Only an absent key or an explicit undefined is missing.  A null value
    // was supplied and must reach the content validator instead of selecting
    // another alias or being reported as a missing setup item.
    if (Object.hasOwn(value, name) && value[name] !== undefined) return value[name];
  }
  return undefined;
}

function setupInputValue(input: RootSetupInput, names: readonly string[]): unknown {
  return presentField(input as unknown as JsonObject, names);
}

export function collectMissingSetupItems(input: unknown): RootSetupItem[] {
  if (!isRecord(input)) failA1("INVALID_VALUE", "root setup input must be an object", "setup");
  const checks: Array<[RootSetupItem, readonly string[]]> = [
    ["tester", ["tester_definition", "tester"]],
    ["tester_agent", ["tester_agent_config", "tester_agent"]],
    ["thresholds", ["validation_thresholds", "thresholds"]],
    ["exposure", ["exposure_limit", "exposure"]],
    ["limits", ["owner_limits", "limits"]],
    ["resource", ["resource_inventory", "resource"]],
    ["baseline", ["baseline_scope", "baseline"]],
  ];
  return checks
    .filter(([, names]) => setupInputValue(input as RootSetupInput, names) === undefined)
    .map(([item]) => item);
}

function requireObject(value: unknown, location: string): JsonObject {
  if (!isRecord(value)) failA1("INVALID_VALUE", "expected an object", location);
  return value;
}

function normalizeThresholds(value: unknown): JsonObject {
  const thresholds = requireObject(value, "validation_thresholds");
  const primary = presentField(thresholds, ["primary", "metric"]);
  if (primary === undefined)
    failA1(
      "INVALID_VALUE",
      "a primary validation threshold is required",
      "validation_thresholds.primary",
    );
  if (typeof primary === "string") {
    requireString(primary, "validation_thresholds.metric");
    if (!Object.hasOwn(thresholds, "target") && !Object.hasOwn(thresholds, "minimum_gain"))
      failA1(
        "INVALID_VALUE",
        "a metric threshold target is required",
        "validation_thresholds.target",
      );
  } else {
    const primaryObject = requireObject(primary, "validation_thresholds.primary");
    requireString(
      presentField(primaryObject, ["name", "metric"]),
      "validation_thresholds.primary.name",
    );
    if (
      primaryObject.direction !== undefined &&
      primaryObject.direction !== "higher_better" &&
      primaryObject.direction !== "lower_better"
    )
      failA1(
        "INVALID_VALUE",
        "threshold direction is invalid",
        "validation_thresholds.primary.direction",
      );
    const target = presentField(primaryObject, ["target", "minimum", "value"]);
    if (target !== undefined) requireFiniteNumber(target, "validation_thresholds.primary.target");
  }
  if (thresholds.constraints !== undefined) {
    if (!Array.isArray(thresholds.constraints))
      failA1("INVALID_VALUE", "constraints must be an array", "validation_thresholds.constraints");
    thresholds.constraints.forEach((constraint: unknown, index: number) => {
      const item = requireObject(constraint, `validation_thresholds.constraints[${index}]`);
      requireString(item.name, `validation_thresholds.constraints[${index}].name`);
      if (item.value !== undefined)
        requireFiniteNumber(item.value, `validation_thresholds.constraints[${index}].value`);
    });
  }
  return thresholds;
}

function normalizeOwnerLimitsForRoot(value: unknown): JsonObject {
  const limits = requireObject(value, "owner_limits");

  if (
    !Object.hasOwn(limits, "max_bundled_positions_per_graph") ||
    limits.max_bundled_positions_per_graph === undefined
  )
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "root setup requires owner_limits.max_bundled_positions_per_graph",
      "owner_limits.max_bundled_positions_per_graph",
    );

  requireInteger(
    limits.max_bundled_positions_per_graph,
    "owner_limits.max_bundled_positions_per_graph",
    0,
  );
  for (const key of [
    "max_nodes",
    "max_edges",
    "max_fan_out_per_node",
    "max_unrolled_cycles",
    "max_jobs_per_candidate",
  ])
    if (limits[key] !== undefined)
      requireInteger(
        limits[key],
        `owner_limits.${key}`,
        key === "max_nodes" || key === "max_jobs_per_candidate" ? 1 : 0,
      );
  return { ...limits };
}

function normalizeTester(value: unknown): JsonObject {
  const tester = requireObject(value, "tester_definition");
  if (
    Object.hasOwn(tester, "definition_sha256") ||
    Object.hasOwn(tester, "case_manifest_sha256") ||
    Object.hasOwn(tester, "gate")
  )
    return validateTesterDefinition(tester) as unknown as JsonObject;
  const testerId = presentField(tester, ["tester_id", "id"]);
  const version = presentField(tester, ["version", "tester_version"]);
  return {
    ...tester,
    tester_id: assertIdentifier(testerId, "tester_definition.tester_id"),
    version: assertIdentifier(version, "tester_definition.version"),
  };
}

function normalizeTesterAgent(value: unknown): JsonObject {
  const config = requireObject(value, "tester_agent_config");
  return validateTesterAgentConfig(config) as unknown as JsonObject;
}

function normalizeExposure(value: unknown): number {
  return requireInteger(value, "exposure_limit", 1);
}

function setupConfirmationHashes(
  tester: JsonObject,
  testerAgent: JsonObject,
  thresholds: JsonObject,
  exposure: number,
  limits: JsonObject,
  resource: ResourceInventory,
  baseline: BaselineScope,
): Record<RootSetupItem, string> {
  return {
    tester: canonicalJsonSha256(tester, undefined, {
      schemaVersion: "setup-tester-confirmation-v1",
    }),
    tester_agent: canonicalJsonSha256(testerAgent, undefined, {
      schemaVersion: "setup-tester-agent-confirmation-v1",
    }),
    thresholds: canonicalJsonSha256(thresholds, undefined, {
      schemaVersion: "setup-threshold-confirmation-v1",
    }),
    exposure: canonicalJsonSha256({ exposure }, undefined, {
      schemaVersion: "setup-exposure-confirmation-v1",
    }),
    limits: canonicalJsonSha256(limits, undefined, {
      schemaVersion: "setup-limits-confirmation-v1",
    }),
    resource: resource.inventory_sha256,
    baseline: baseline.baseline_sha256,
  };
}

function priorHashes(value: unknown): Partial<Record<RootSetupItem, string>> {
  if (value === undefined) return {};
  if (!isRecord(value))
    failA1("INVALID_VALUE", "previous setup must be an object", "setup.previous_setup");
  const nested =
    value.confirmation_hashes !== undefined
      ? value.confirmation_hashes
      : value.setup_confirmation_hashes;
  if (nested !== undefined) {
    if (!isRecord(nested))
      failA1("INVALID_VALUE", "confirmation_hashes must be an object", "setup.confirmation_hashes");
    const result: Partial<Record<RootSetupItem, string>> = {};
    for (const item of ROOT_SETUP_ITEMS)
      if (nested[item] !== undefined)
        result[item] = assertSha256(nested[item], `setup.confirmation_hashes.${item}`);
    return result;
  }
  if (value.setup_revision !== undefined) return priorHashes(value.setup_revision);
  return {};
}

export function computeSetupReentryDiff(
  previousValue: unknown,
  current: Partial<Record<RootSetupItem, string>>,
): SetupReentryDiff {
  const previous = priorHashes(previousValue);
  const added: RootSetupItem[] = [];
  const changed: RootSetupItem[] = [];
  const removed: RootSetupItem[] = [];
  const reused: RootSetupItem[] = [];
  for (const item of ROOT_SETUP_ITEMS) {
    const oldHash = previous[item];
    const newHash = current[item];
    if (oldHash === undefined && newHash !== undefined) added.push(item);
    else if (oldHash !== undefined && newHash === undefined) removed.push(item);
    else if (oldHash !== undefined && newHash !== undefined && oldHash !== newHash)
      changed.push(item);
    else if (oldHash !== undefined && newHash !== undefined) reused.push(item);
  }
  const confirmationRequired = [...added, ...changed];
  return {
    added,
    changed,
    removed,
    reused,
    confirmation_required: confirmationRequired,
    new_items: [...added],
    changed_items: [...changed],
  };
}

export const reentryDiff = computeSetupReentryDiff;

export function setupRevisionPath(
  projectRoot: string,
  taskId: string,
  setupRevision: string,
): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "tasks",
    assertIdentifier(taskId, "task_id"),
    "setup-revisions",
    `${assertIdentifier(setupRevision, "setup_revision")}.json`,
  );
}

function revisionWithoutHash(value: Omit<RootSetupRevisionDocument, "revision_sha256">): object {
  return {
    schema_version: value.schema_version,
    task_id: value.task_id,
    workflow_id: value.workflow_id,
    setup_revision: value.setup_revision,
    run_id: value.run_id,
    confirmation_hashes: value.confirmation_hashes,
    charter_sha256: value.charter_sha256,
    baseline_sha256: value.baseline_sha256,
    resource_inventory_sha256: value.resource_inventory_sha256,
    // The diff is derived from the old and new confirmation hashes. It is not
    // part of the immutable setup revision identity, so rerunning the same
    // revision can report "reused" instead of conflicting with its first run.
  };
}

function revisionHash(value: Omit<RootSetupRevisionDocument, "revision_sha256">): string {
  return canonicalJsonSha256(revisionWithoutHash(value), undefined, {
    schemaVersion: "root-setup-revision-v1",
  });
}

function validateReentryDiff(value: unknown, location: string): SetupReentryDiff {
  if (!isRecord(value)) failA1("CORRUPT_SETUP", "reentry_diff must be an object", location);
  const list = (field: string): RootSetupItem[] => {
    if (!Array.isArray(value[field]))
      failA1("CORRUPT_SETUP", `${field} must be an array`, `${location}.${field}`);
    return value[field].map((item, index) => {
      if (!ROOT_SETUP_ITEMS.includes(item as RootSetupItem))
        failA1("CORRUPT_SETUP", "unknown setup item", `${location}.${field}[${index}]`);
      return item as RootSetupItem;
    });
  };
  return {
    added: list("added"),
    changed: list("changed"),
    removed: list("removed"),
    reused: list("reused"),
    confirmation_required: list("confirmation_required"),
    new_items: list("new_items"),
    changed_items: list("changed_items"),
  };
}

export function validateRootSetupRevision(
  value: unknown,
  location = "setup_revision",
): RootSetupRevisionDocument {
  if (!isRecord(value)) failA1("CORRUPT_SETUP", "setup revision must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "task_id",
      "workflow_id",
      "setup_revision",
      "run_id",
      "confirmation_hashes",
      "charter_sha256",
      "baseline_sha256",
      "resource_inventory_sha256",
      "reentry_diff",
      "revision_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_SETUP", "setup revision schema_version must be 1", location);
  if (!isRecord(value.confirmation_hashes))
    failA1(
      "CORRUPT_SETUP",
      "confirmation_hashes must be an object",
      `${location}.confirmation_hashes`,
    );
  const hashes = {} as Record<RootSetupItem, string>;
  for (const item of ROOT_SETUP_ITEMS)
    hashes[item] = assertSha256(
      value.confirmation_hashes[item],
      `${location}.confirmation_hashes.${item}`,
    );
  const base: Omit<RootSetupRevisionDocument, "revision_sha256"> = {
    schema_version: 1,
    task_id: assertIdentifier(value.task_id, `${location}.task_id`),
    workflow_id: assertIdentifier(value.workflow_id, `${location}.workflow_id`),
    setup_revision: assertIdentifier(value.setup_revision, `${location}.setup_revision`),
    run_id: assertIdentifier(value.run_id, `${location}.run_id`),
    confirmation_hashes: hashes,
    charter_sha256: assertSha256(value.charter_sha256, `${location}.charter_sha256`),
    baseline_sha256: assertSha256(value.baseline_sha256, `${location}.baseline_sha256`),
    resource_inventory_sha256: assertSha256(
      value.resource_inventory_sha256,
      `${location}.resource_inventory_sha256`,
    ),
    reentry_diff: validateReentryDiff(value.reentry_diff, `${location}.reentry_diff`),
  };
  const digest = assertSha256(value.revision_sha256, `${location}.revision_sha256`);
  if (digest !== revisionHash(base))
    failA1("CORRUPT_SETUP", "setup revision hash does not match", location);
  return { ...base, revision_sha256: digest };
}

export function saveRootSetupRevision(
  projectRoot: string,
  value: Omit<RootSetupRevisionDocument, "revision_sha256">,
): RootSetupRevisionDocument {
  const document = { ...value, revision_sha256: revisionHash(value) };
  const filePath = setupRevisionPath(projectRoot, document.task_id, document.setup_revision);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateRootSetupRevision(readStateFile(filePath), filePath);
      if (existing.revision_sha256 === document.revision_sha256) return existing;
      failA1("IMMUTABLE_CONFLICT", "setup revision is immutable", filePath);
    }
    writeStateJsonAtomic(filePath, document);
    return document;
  });
}

export function loadRootSetupRevision(
  projectRoot: string,
  taskId: string,
  setupRevision: string,
): RootSetupRevisionDocument {
  const filePath = setupRevisionPath(projectRoot, taskId, setupRevision);
  if (!fs.existsSync(filePath))
    failA1("SETUP_NOT_FOUND", `setup revision is missing at ${filePath}`, filePath);
  const document = validateRootSetupRevision(readStateFile(filePath), filePath);
  if (document.task_id !== taskId || document.setup_revision !== setupRevision)
    failA1("IDENTITY_MISMATCH", "setup revision path and content disagree", filePath);
  return document;
}

function identityForRoot(
  input: RootSetupInput,
  charter: RootCharter,
  baseline: BaselineScope,
): {
  charter_sha256: string;
  input_snapshot_sha256: string;
  execution_plan_sha256: string;
  code_baseline_sha256: string;
  policy_revision: string;
} {
  return {
    charter_sha256: charter.charter_sha256,
    input_snapshot_sha256: canonicalJsonSha256(input.input_snapshot_refs ?? [], undefined, {
      schemaVersion: "root-input-snapshot-v1",
    }),
    execution_plan_sha256: baseline.workflow_definition_sha256,
    code_baseline_sha256: baseline.code_baseline.sha256,
    policy_revision: assertIdentifier(input.setup_revision, "setup_revision"),
  };
}

function assertExistingRootContract(contract: RunRecord, charter: RootCharter): void {
  if (contract.parent_run_id !== null || contract.depth !== 0 || contract.scope_path !== "/")
    failA1("RUN_IDENTITY_CONFLICT", "existing root run contract does not match the charter");
  if (contract.identity_material.charter_sha256 !== charter.charter_sha256)
    failA1("ROOT_SETUP_SEALED", "root setup is sealed; create a new run to change its setup");
}

function cleanupSetupFailure(
  projectRoot: string,
  runId: string,
  createdContract: boolean,
  newlyWritten: readonly string[],
  preexisting: ReadonlySet<string>,
  originalError: unknown,
): void {
  const failures: string[] = [];
  for (const filePath of newlyWritten) {
    if (preexisting.has(filePath) || !fs.existsSync(filePath)) continue;
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      failures.push(`cannot remove ${filePath}: ${String(error)}`);
    }
  }
  const contractPath = runJsonPath(projectRoot, runId);
  if (createdContract && fs.existsSync(contractPath)) {
    const scopeInput = {
      project_root: projectRoot,
      run_id: runId,
      parent_run_id: null,
      scope_path: "/",
    } as const;
    try {
      const tokens = readRunScopeLeaseTokens(scopeInput);
      for (const token of tokens) releaseRunScope({ ...scopeInput, lease_token: token });
    } catch (error) {
      failures.push(`cannot release root scope: ${String(error)}`);
    }
    try {
      fs.unlinkSync(contractPath);
    } catch (error) {
      failures.push(`cannot remove ${contractPath}: ${String(error)}`);
    }
  }
  if (failures.length > 0)
    failA1(
      "SETUP_CLEANUP_FAILED",
      `setup failed (${String(originalError)}); cleanup also failed: ${failures.join("; ")}`,
    );
}

function setupInputAllowedFields(): string[] {
  return [
    "project_root",
    "run_id",
    "task_id",
    "workflow_id",
    "setup_revision",
    "problem",
    "expected_output",
    "workflow_definition",
    "baseline",
    "baseline_scope",
    "tester_definition",
    "tester",
    "tester_agent_config",
    "tester_agent",
    "validation_thresholds",
    "thresholds",
    "exposure_limit",
    "exposure",
    "owner_limits",
    "limits",
    "resource_inventory",
    "resource",
    "model_usage_policy",
    "tester_id",
    "tester_version",
    "validator_ref",
    "input_snapshot_refs",
    "evidence_refs",
    "constraints",
    "budget",

    "tester_ref",
    "previous_setup",
    "previous_setup_revision",
  ];
}

/**
 * Setup must record pre-existing files before createRun establishes the
 * contract.  The normal run-owned path intentionally rejects that phase, so
 * this one private helper is the only setup-only exception for path lookup.
 */
function setupPreContractArtifactPath(
  projectRoot: string,
  runId: string,
  fileName: string,
): string {
  // A2-1 keeps the raw bootstrap capability private to createRun.  runJsonPath
  // is the canonical pre-contract anchor; only this helper derives sibling
  // setup files from that anchor, before normal gated paths become available.
  return path.join(path.dirname(runJsonPath(projectRoot, runId)), fileName);
}

export function setupRootRun(input: RootSetupInput): RootSetupResult {
  if (!isRecord(input)) failA1("INVALID_VALUE", "root setup input must be an object", "setup");
  const draftKey = setupDraftKey(input);
  const missing = collectMissingSetupItems(input);
  if (missing.length > 0) {
    // Keep the supplied answers in memory so the next call can compare them
    // after the caller fills the missing fields.  No contract, state file, or
    // lock is created while the setup is incomplete.
    pendingRootSetupDrafts.set(draftKey, cloneSetupDraft(input));
    throw new SetupIncompleteError(missing);
  }
  assertNoUnknownFields(input, setupInputAllowedFields(), "setup");

  const projectRoot = requireString(input.project_root, "setup.project_root");
  const runId = assertIdentifier(input.run_id, "setup.run_id");
  const taskId = assertIdentifier(input.task_id, "setup.task_id");
  const workflowId = assertIdentifier(input.workflow_id, "setup.workflow_id");
  const setupRevision = assertIdentifier(input.setup_revision, "setup.setup_revision");
  const tester = normalizeTester(setupInputValue(input, ["tester_definition", "tester"]));
  const testerAgent = normalizeTesterAgent(
    setupInputValue(input, ["tester_agent_config", "tester_agent"]),
  );
  const thresholds = normalizeThresholds(
    setupInputValue(input, ["validation_thresholds", "thresholds"]),
  );
  const exposure = normalizeExposure(setupInputValue(input, ["exposure_limit", "exposure"]));
  const ownerLimits = normalizeOwnerLimitsForRoot(
    setupInputValue(input, ["owner_limits", "limits"]),
  );
  const rawResource = setupInputValue(input, ["resource_inventory", "resource"]);
  const resource =
    isRecord(rawResource) && Object.hasOwn(rawResource, "inventory_sha256")
      ? validateResourceInventory(rawResource)
      : createResourceInventory(rawResource);
  const rawBaseline = setupInputValue(input, ["baseline_scope", "baseline"]);
  if (!isRecord(rawBaseline)) failA1("INVALID_BASELINE", "baseline must be an object", "baseline");
  const baselineInputValue =
    Object.hasOwn(rawBaseline, "workflow_definition") || input.workflow_definition === undefined
      ? rawBaseline
      : { ...rawBaseline, workflow_definition: input.workflow_definition };
  const baseline =
    isRecord(rawBaseline) && Object.hasOwn(rawBaseline, "baseline_sha256")
      ? validateBaselineScope(rawBaseline)
      : createBaselineScope({ ...(baselineInputValue as JsonObject), owner_limits: ownerLimits });
  const validatedResource = resource;
  const validatedBaseline = baseline;
  if (
    validatedBaseline.max_bundled_positions_per_graph !==
    ownerLimits.max_bundled_positions_per_graph
  )
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "baseline and owner_limits disagree on max_bundled_positions_per_graph",
      "owner_limits.max_bundled_positions_per_graph",
    );
  const confirmationHashes = setupConfirmationHashes(
    tester,
    testerAgent,
    thresholds,
    exposure,
    ownerLimits,
    validatedResource,
    validatedBaseline,
  );
  const revisionFile = setupRevisionPath(projectRoot, taskId, setupRevision);
  const pendingDraft = pendingRootSetupDrafts.get(draftKey);
  const previous =
    input.previous_setup_revision !== undefined
      ? loadRootSetupRevision(
          projectRoot,
          taskId,
          assertIdentifier(input.previous_setup_revision, "previous_setup_revision"),
        )
      : input.previous_setup !== undefined
        ? input.previous_setup
        : fs.existsSync(revisionFile)
          ? loadRootSetupRevision(projectRoot, taskId, setupRevision)
          : pendingDraft;
  const previousForDiff =
    previous === pendingDraft && pendingDraft !== undefined
      ? { confirmation_hashes: confirmationHashesFromPendingDraft(pendingDraft, ownerLimits) }
      : previous;
  const diff = computeSetupReentryDiff(previousForDiff, confirmationHashes);
  const testerId =
    input.tester_id === undefined
      ? assertIdentifier(tester.tester_id, "tester_definition.tester_id")
      : assertIdentifier(input.tester_id, "setup.tester_id");
  const testerVersion =
    input.tester_version === undefined
      ? assertIdentifier(tester.version, "tester_definition.version")
      : assertIdentifier(input.tester_version, "setup.tester_version");
  const taskSetup =
    input.model_usage_policy === undefined
      ? undefined
      : createTaskSetup({
          task_id: taskId,
          workflow_id: workflowId,
          setup_revision: setupRevision,
          model_usage_policy: input.model_usage_policy,
          tester_id: testerId,
          tester_version: testerVersion,
        });
  const taskSetupMaterial = {
    task_id: taskId,
    workflow_id: workflowId,
    setup_revision: setupRevision,
    model_usage_policy: input.model_usage_policy ?? null,
    confirmation_hashes: confirmationHashes,
  };
  const taskSetupSha256 = canonicalJsonSha256(taskSetupMaterial, undefined, {
    schemaVersion: "task-setup-root-v1",
  });
  const charter = createRootCharter({
    ...input,
    run_id: runId,
    task_id: taskId,
    workflow_id: workflowId,
    setup_revision: setupRevision,
    baseline_scope: validatedBaseline,
    resource_inventory: validatedResource,
    owner_limits: ownerLimits,
    tester_definition: tester,
    tester_agent_config: testerAgent,
    validation_thresholds: thresholds,
    exposure_limit: exposure,
    task_setup_sha256: taskSetupSha256,
    tester_definition_sha256: canonicalJsonSha256(tester, undefined, {
      schemaVersion: "tester-definition-v1",
    }),
    tester_agent_sha256: testerAgentConfigSha256(testerAgent as unknown as TesterAgentConfig),
    validation_thresholds_sha256: canonicalJsonSha256(thresholds, undefined, {
      schemaVersion: "validation-thresholds-v1",
    }),
    owner_limits_sha256: canonicalJsonSha256(ownerLimits, undefined, {
      schemaVersion: "owner-limits-v1",
    }),
  });
  const contractPath = runJsonPath(projectRoot, runId);
  const createdContract = !fs.existsSync(contractPath);
  const paths = [
    contractPath,
    setupPreContractArtifactPath(projectRoot, runId, "charter.json"),
    setupPreContractArtifactPath(projectRoot, runId, "baseline.json"),
    setupPreContractArtifactPath(projectRoot, runId, "resource-inventory.json"),
    setupRevisionPath(projectRoot, taskId, setupRevision),
    ...(taskSetup === undefined
      ? []
      : [
          taskSetupPath(projectRoot, workflowId, setupRevision),
          modelUsagePolicyPath(projectRoot, workflowId, taskSetup.model_usage_policy.revision),
        ]),
  ];
  const preexisting = new Set(paths.filter((filePath) => fs.existsSync(filePath)));
  const newlyWritten: string[] = [];
  let contract: RunRecord;
  try {
    const identity = identityForRoot(input, charter, validatedBaseline);

    contract = createdContract
      ? createRootRun({ project_root: projectRoot, run_id: runId, ...identity })
      : readRun(projectRoot, runId);
    assertExistingRootContract(contract, charter);

    const savedResource = saveResourceInventory(projectRoot, runId, validatedResource);
    if (
      !preexisting.has(setupPreContractArtifactPath(projectRoot, runId, "resource-inventory.json"))
    )
      newlyWritten.push(
        setupPreContractArtifactPath(projectRoot, runId, "resource-inventory.json"),
      );
    const savedBaseline = saveBaselineScope(projectRoot, runId, validatedBaseline);
    if (!preexisting.has(setupPreContractArtifactPath(projectRoot, runId, "baseline.json")))
      newlyWritten.push(setupPreContractArtifactPath(projectRoot, runId, "baseline.json"));
    const savedCharter = saveRootCharter(projectRoot, runId, charter);
    initializeRunBudget(projectRoot, runId, normalizeBudget(charter.budget, "charter.budget"));
    if (!preexisting.has(setupPreContractArtifactPath(projectRoot, runId, "charter.json")))
      newlyWritten.push(setupPreContractArtifactPath(projectRoot, runId, "charter.json"));
    const revision = saveRootSetupRevision(projectRoot, {
      schema_version: 1,
      task_id: taskId,
      workflow_id: workflowId,
      setup_revision: setupRevision,
      run_id: runId,
      confirmation_hashes: confirmationHashes,
      charter_sha256: savedCharter.charter_sha256,
      baseline_sha256: savedBaseline.baseline_sha256,
      resource_inventory_sha256: savedResource.inventory_sha256,
      reentry_diff: diff,
    });
    if (!preexisting.has(setupRevisionPath(projectRoot, taskId, setupRevision)))
      newlyWritten.push(setupRevisionPath(projectRoot, taskId, setupRevision));
    if (taskSetup !== undefined) {
      const taskPath = taskSetupPath(projectRoot, workflowId, setupRevision);
      const policyPath = modelUsagePolicyPath(
        projectRoot,
        workflowId,
        taskSetup.model_usage_policy.revision,
      );
      if (!preexisting.has(taskPath)) newlyWritten.push(taskPath);
      if (!preexisting.has(policyPath)) newlyWritten.push(policyPath);
      saveTaskSetup(projectRoot, {
        task_id: taskId,
        workflow_id: workflowId,
        setup_revision: setupRevision,
        model_usage_policy: input.model_usage_policy,
        tester_id: testerId,
        tester_version: testerVersion,
      });
    }
    pendingRootSetupDrafts.delete(draftKey);
    return {
      root_charter: savedCharter,
      baseline: savedBaseline,
      resource_inventory: savedResource,
      confirmation_hashes: confirmationHashes,
      reentry_diff: diff,
      setup_revision: revision,
      ...(taskSetup === undefined ? {} : { task_setup: taskSetup }),
    };
  } catch (error) {
    cleanupSetupFailure(projectRoot, runId, createdContract, newlyWritten, preexisting, error);
    throw error;
  }
}

export const createRootSetup = setupRootRun;
export const runTaskSetup = setupRootRun;
export const setupTask = setupRootRun;
