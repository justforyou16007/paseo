import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { type ArtifactRegistry } from "./artifact-registry.js";
import { validateIncumbentSnapshot } from "./model-assignment.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertTaskSetupJudgeSafety,
  saveModelUsagePolicyRevision,
  saveTaskSetup,
  validateTaskSetupDocument,
  type TaskSetupDocument,
} from "./task-setup.js";
import { validateTesterDefinition, type TesterDefinition } from "./tester-state.js";
import {
  testerAgentConfigSha256,
  validateTesterAgentConfig,
  type TesterAgentConfig,
} from "./tester-agent.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  assertRelativePath,
  failA1,
  isRecord,
  requireInteger,
  requireFiniteNumber,
  requireString,
  validateModelUsagePolicy,
  validateOwnerLimits,
  type OwnerLimits,
  type ModelUsagePolicy,
} from "./workflow-spec.js";
import {
  assertRunReferenceCompatible,
  normalizeScopePath,
  openExistingRun,
  requireRunContract,
  legacyRunStatePath,
  runOwnedPath,
  stripLegacyParentField,
} from "./run-contract.js";

export interface FrozenPolicy {
  schema_version: 1;
  task_id: string;
  workflow_id: string;
  outer_run_id: string;
  owner_limits_revision: string;
  owner_limits_sha256: string;
  task_setup_revision: string;
  task_setup_sha256: string;
  model_usage_policy_revision: string;
  model_usage_policy_sha256: string;
  tester_id: string;
  tester_version: string;
  tester_sha256: string;
  incumbent_candidate_id: string;
  incumbent_generation: number;
  incumbent_sha256: string;
  owner_limits: OwnerLimits;
  task_setup: TaskSetupDocument;
  model_usage_policy: ModelUsagePolicy;
  tester_definition: TesterDefinition;
  /** Present for production outer runs. Test-only storage fixtures may omit it. */
  tester_agent_config?: TesterAgentConfig;
  tester_agent_sha256?: string;
  incumbent: ReturnType<typeof validateIncumbentSnapshot>;
  frozen_at: string;
}

export interface FreezeOuterRunInput {
  project_root: string;
  outer_run_id: string;
  task_id: string;
  owner_limits: OwnerLimits;
  task_setup_revision: string;
  task_setup: unknown;
  model_usage_policy_revision: string;
  model_usage_policy: unknown;
  tester_id: string;
  tester_version: string;
  tester_definition: unknown;
  /** The production outer entry supplies the frozen remote job configuration. */
  tester_agent_config?: unknown;
  incumbent_candidate_id: string;
  incumbent_generation: number;
  incumbent: unknown;
  registry?: ArtifactRegistry;
}

export interface WorkflowDashboard {
  schema_version: 1;
  run_id: string;
  status: "running" | "completed" | "failed" | "stopped";
  current_phase: "init" | "loop" | "summary";
  outer_iteration: number;
  generation: number;
  wave_kind: "module" | "structure" | "scorer" | null;
  child_run_ids: string[];
  candidate_ids: string[];
  finalist_id: string | null;
  promotion_trial_id: string | null;
  stop_decision: string | null;
  child_states: Record<string, string>;
  frozen_policy_sha256: string;
  updated_at: string;
}

export interface RunIdentityCheck {
  project_root: string;
  run_id: string;
  directory_path: string;
  manifest_run_id: string;
  command_run_id: string;
  dashboard_run_id?: string;
}

export function runDirectory(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"));
}

export function outerRunStatePath(projectRoot: string, runId: string): string {
  const safeRunId = assertIdentifier(runId, "run_id");
  requireRunContract(projectRoot, safeRunId);
  return legacyRunStatePath(projectRoot, safeRunId);
}

export function workflowDashboardPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "workflow-dashboard.json");
}

export function frozenPolicyPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "frozen-policy.json");
}

const WORKFLOW_CYCLES_DIRECTORY = "cycles";

/**
 * The one producer of the workflow outer-cycle worker root.
 * Module runs deliberately use their own run-root workers directory.
 */
export function workflowCycleWorkerDirectory(
  projectRoot: string,
  runId: string,
  outerIteration: number,
): string {
  requireInteger(outerIteration, "outer_iteration", 1);
  return runOwnedPath(
    projectRoot,
    assertIdentifier(runId, "run_id"),
    WORKFLOW_CYCLES_DIRECTORY,
    String(outerIteration),
    "workers",
  );
}

export function workflowCycleDirectory(
  projectRoot: string,
  runId: string,
  outerIteration: number,
): string {
  return path.dirname(workflowCycleWorkerDirectory(projectRoot, runId, outerIteration));
}

/** Compatibility name for callers that need the workflow cycle root itself. */
export function cycleDirectory(projectRoot: string, runId: string, outerIteration: number): string {
  return workflowCycleDirectory(projectRoot, runId, outerIteration);
}

export function workflowCycleRelativePath(
  outerIteration: number,
  ...relativePaths: string[]
): string {
  requireInteger(outerIteration, "outer_iteration", 1);
  return path.posix.join(
    WORKFLOW_CYCLES_DIRECTORY,
    String(outerIteration),
    ...relativePaths.map((value, index) =>
      assertRelativePath(value, `workflow_cycle.relative_path[${index}]`),
    ),
  );
}

export function cycleFilePath(
  projectRoot: string,
  runId: string,
  outerIteration: number,
  fileName: string,
): string {
  const safeName = requireString(fileName, "cycle.file_name");
  if (safeName.includes("/") || safeName.includes("\\") || safeName === "." || safeName === "..")
    failA1("PATH_ESCAPE", "cycle file name must be one file name", "cycle.file_name");
  requireInteger(outerIteration, "outer_iteration", 1);
  return path.join(cycleDirectory(projectRoot, runId, outerIteration), safeName);
}

export function assertRunIdentity(input: RunIdentityCheck): void {
  const runId = assertIdentifier(input.run_id, "run_id");
  if (
    input.manifest_run_id !== runId ||
    input.command_run_id !== runId ||
    (input.dashboard_run_id !== undefined && input.dashboard_run_id !== runId)
  ) {
    failA1("IDENTITY_MISMATCH", "directory, manifest, command and dashboard run ids must agree");
  }
  const expected = runDirectory(input.project_root, runId);
  if (path.resolve(input.directory_path) !== expected)
    failA1("IDENTITY_MISMATCH", "run directory is not derived from run_id");
}

function hashValue(value: unknown, schemaVersion: string): string {
  return canonicalJsonSha256(value, undefined, { schemaVersion });
}

function assertEmbeddedIdentity(
  value: unknown,
  fields: Record<string, string | number>,
  location: string,
): void {
  if (!isRecord(value)) failA1("IDENTITY_MISMATCH", `${location} must be an object`);
  for (const [field, expected] of Object.entries(fields)) {
    if (value[field] !== expected)
      failA1("IDENTITY_MISMATCH", `${location}.${field} does not match its frozen identity`);
  }
}

function assertFreezeInputShape(value: unknown): asserts value is FreezeOuterRunInput {
  if (!isRecord(value)) failA1("INVALID_VALUE", "freeze input must be an object");
  assertNoUnknownFields(
    value,
    [
      "project_root",
      "outer_run_id",
      "task_id",
      "owner_limits",
      "task_setup_revision",
      "task_setup",
      "model_usage_policy_revision",
      "model_usage_policy",
      "tester_id",
      "tester_version",
      "tester_definition",
      "tester_agent_config",
      "incumbent_candidate_id",
      "incumbent_generation",
      "incumbent",
      "registry",
    ],
    "freeze",
  );
}

export function freezeOuterRun(input: FreezeOuterRunInput): FrozenPolicy {
  assertFreezeInputShape(input);
  const runId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const taskId = assertIdentifier(input.task_id, "task_id");
  const ownerLimits = validateOwnerLimits(input.owner_limits, "owner_limits");
  const taskSetup = validateTaskSetupDocument(input.task_setup, "task_setup");
  const modelUsagePolicy = validateModelUsagePolicy(input.model_usage_policy, "model_usage_policy");
  const testerDefinition = validateTesterDefinition(input.tester_definition);
  const testerAgent =
    input.tester_agent_config === undefined
      ? undefined
      : validateTesterAgentConfig(input.tester_agent_config);
  const incumbent = validateIncumbentSnapshot(input.incumbent);
  assertEmbeddedIdentity(
    taskSetup,
    { task_id: taskId, setup_revision: input.task_setup_revision },
    "task_setup",
  );
  if (taskSetup.tester_id !== input.tester_id || taskSetup.tester_version !== input.tester_version)
    failA1("IDENTITY_MISMATCH", "task setup and frozen tester identity differ", "task_setup");
  assertEmbeddedIdentity(
    modelUsagePolicy,
    { revision: input.model_usage_policy_revision },
    "model_usage_policy",
  );
  if (
    taskSetup.policy_sha256 !==
    canonicalJsonSha256(modelUsagePolicy, undefined, { schemaVersion: "model-usage-policy-v1" })
  ) {
    failA1("IDENTITY_MISMATCH", "task setup and frozen model usage policy differ");
  }
  assertTaskSetupJudgeSafety(modelUsagePolicy, { registry: input.registry });
  assertEmbeddedIdentity(
    testerDefinition,
    { tester_id: input.tester_id, version: input.tester_version },
    "tester_definition",
  );
  assertEmbeddedIdentity(
    incumbent,
    { candidate_id: input.incumbent_candidate_id, generation: input.incumbent_generation },
    "incumbent",
  );
  const policy: FrozenPolicy = {
    schema_version: 1,
    task_id: taskId,
    workflow_id: taskSetup.workflow_id,
    outer_run_id: runId,
    owner_limits_revision: ownerLimits.revision,
    owner_limits_sha256: hashValue(ownerLimits, "owner-limits-v1"),
    task_setup_revision: assertIdentifier(input.task_setup_revision, "task_setup_revision"),
    task_setup_sha256: hashValue(taskSetup, "task-setup-v1"),
    model_usage_policy_revision: assertIdentifier(
      input.model_usage_policy_revision,
      "model_usage_policy_revision",
    ),
    model_usage_policy_sha256: hashValue(modelUsagePolicy, "model-usage-policy-v1"),
    tester_id: assertIdentifier(input.tester_id, "tester_id"),
    tester_version: assertIdentifier(input.tester_version, "tester_version"),
    tester_sha256: hashValue(testerDefinition, "tester-definition-v1"),
    incumbent_candidate_id: assertIdentifier(
      input.incumbent_candidate_id,
      "incumbent_candidate_id",
    ),
    incumbent_generation: requireInteger(input.incumbent_generation, "incumbent_generation", 0),
    incumbent_sha256: hashValue(incumbent, "incumbent-v1"),
    owner_limits: ownerLimits,
    task_setup: taskSetup,
    model_usage_policy: modelUsagePolicy,
    tester_definition: testerDefinition,
    ...(testerAgent === undefined
      ? {}
      : {
          tester_agent_config: testerAgent,
          tester_agent_sha256: testerAgentConfigSha256(testerAgent),
        }),
    incumbent,
    frozen_at: new Date().toISOString(),
  };
  return policy;
}

export function saveFrozenPolicy(input: FreezeOuterRunInput): FrozenPolicy {
  assertFreezeInputShape(input);
  const filePath = frozenPolicyPath(input.project_root, input.outer_run_id);
  // Validate the complete snapshot before creating any revision files. A bad
  // binding must leave no partial setup behind.
  freezeOuterRun(input);
  const taskSetup = validateTaskSetupDocument(input.task_setup, "task_setup");
  saveTaskSetup(input.project_root, {
    task_id: taskSetup.task_id,
    workflow_id: taskSetup.workflow_id,
    setup_revision: taskSetup.setup_revision,
    model_usage_policy: taskSetup.model_usage_policy,
    tester_id: input.tester_id,
    tester_version: input.tester_version,
    validation: input.registry ? { registry: input.registry } : undefined,
  });
  const policyRevision = saveModelUsagePolicyRevision(
    input.project_root,
    taskSetup.workflow_id,
    taskSetup.model_usage_policy,
    input.registry,
  );
  if (policyRevision.policy_revision !== input.model_usage_policy_revision)
    failA1("IDENTITY_MISMATCH", "frozen policy names a different model usage policy revision");
  const policy = freezeOuterRun({
    ...input,
    task_setup: { ...taskSetup, model_usage_policy: policyRevision.model_usage_policy },
    model_usage_policy: policyRevision.model_usage_policy,
    registry: input.registry,
  });
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readFrozenPolicy(input.project_root, policy.outer_run_id);
      const requestedWithoutTimestamp = { ...policy, frozen_at: existing.frozen_at };
      if (
        hashValue(existing, "frozen-policy-v1") ===
        hashValue(requestedWithoutTimestamp, "frozen-policy-v1")
      )
        return existing;
      failA1("IMMUTABLE_CONFLICT", `frozen policy for '${policy.outer_run_id}' cannot be replaced`);
    }
    writeStateJsonAtomic(filePath, policy);
    return policy;
  });
}

export function readFrozenPolicy(projectRoot: string, outerRunId: string): FrozenPolicy {
  const filePath = frozenPolicyPath(projectRoot, outerRunId);
  if (!fs.existsSync(filePath))
    failA1("FROZEN_POLICY_NOT_FOUND", `no frozen policy at ${filePath}`);
  const parsed = readStateFile(filePath);
  if (!isRecord(parsed))
    failA1("CORRUPT_FROZEN_POLICY", "frozen policy is not an object", filePath);
  const safeOuterRunId = assertIdentifier(outerRunId, "outer_run_id");
  if (parsed.schema_version !== 1 || parsed.outer_run_id !== safeOuterRunId)
    failA1("IDENTITY_MISMATCH", "frozen policy path and content disagree", filePath);
  const allowed = [
    "schema_version",
    "task_id",
    "workflow_id",
    "outer_run_id",
    "owner_limits_revision",
    "owner_limits_sha256",
    "task_setup_revision",
    "task_setup_sha256",
    "model_usage_policy_revision",
    "model_usage_policy_sha256",
    "tester_id",
    "tester_version",
    "tester_sha256",
    "incumbent_candidate_id",
    "incumbent_generation",
    "incumbent_sha256",
    "owner_limits",
    "task_setup",
    "model_usage_policy",
    "tester_definition",
    "tester_agent_config",
    "tester_agent_sha256",
    "incumbent",
    "frozen_at",
  ];
  for (const key of Object.keys(parsed))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown frozen policy field '${key}'`, filePath);
  assertIdentifier(parsed.task_id, `${filePath}.task_id`);
  assertIdentifier(parsed.workflow_id, `${filePath}.workflow_id`);
  assertIdentifier(parsed.owner_limits_revision, `${filePath}.owner_limits_revision`);
  assertIdentifier(parsed.task_setup_revision, `${filePath}.task_setup_revision`);
  assertIdentifier(parsed.model_usage_policy_revision, `${filePath}.model_usage_policy_revision`);
  assertIdentifier(parsed.tester_id, `${filePath}.tester_id`);
  assertIdentifier(parsed.tester_version, `${filePath}.tester_version`);
  assertIdentifier(parsed.incumbent_candidate_id, `${filePath}.incumbent_candidate_id`);
  requireInteger(parsed.incumbent_generation, `${filePath}.incumbent_generation`, 0);
  requireString(parsed.frozen_at, `${filePath}.frozen_at`);
  assertSha256(parsed.owner_limits_sha256, `${filePath}.owner_limits_sha256`);
  assertSha256(parsed.task_setup_sha256, `${filePath}.task_setup_sha256`);
  assertSha256(parsed.model_usage_policy_sha256, `${filePath}.model_usage_policy_sha256`);
  assertSha256(parsed.tester_sha256, `${filePath}.tester_sha256`);
  assertSha256(parsed.incumbent_sha256, `${filePath}.incumbent_sha256`);
  const taskId = assertIdentifier(parsed.task_id, `${filePath}.task_id`);
  const workflowId = assertIdentifier(parsed.workflow_id, `${filePath}.workflow_id`);
  const ownerLimits = validateOwnerLimits(parsed.owner_limits, `${filePath}.owner_limits`);
  const taskSetup = validateTaskSetupDocument(parsed.task_setup, `${filePath}.task_setup`);
  const modelUsagePolicy = validateModelUsagePolicy(
    parsed.model_usage_policy,
    `${filePath}.model_usage_policy`,
  );
  const testerDefinition = validateTesterDefinition(parsed.tester_definition);
  const testerAgent =
    parsed.tester_agent_config === undefined
      ? undefined
      : validateTesterAgentConfig(parsed.tester_agent_config);
  if ((testerAgent === undefined) !== (parsed.tester_agent_sha256 === undefined))
    failA1(
      "CORRUPT_FROZEN_POLICY",
      "remote tester config and its hash must be stored together",
      filePath,
    );
  if (
    testerAgent !== undefined &&
    testerAgentConfigSha256(testerAgent) !== parsed.tester_agent_sha256
  )
    failA1(
      "CORRUPT_FROZEN_POLICY",
      "frozen remote tester config hash cannot be verified",
      filePath,
    );
  const incumbent = validateIncumbentSnapshot(parsed.incumbent);
  const ownerLimitsRevision = assertIdentifier(
    parsed.owner_limits_revision,
    `${filePath}.owner_limits_revision`,
  );
  const taskSetupRevision = assertIdentifier(
    parsed.task_setup_revision,
    `${filePath}.task_setup_revision`,
  );
  const modelUsagePolicyRevision = assertIdentifier(
    parsed.model_usage_policy_revision,
    `${filePath}.model_usage_policy_revision`,
  );
  const testerId = assertIdentifier(parsed.tester_id, `${filePath}.tester_id`);
  const testerVersion = assertIdentifier(parsed.tester_version, `${filePath}.tester_version`);
  const incumbentCandidateId = assertIdentifier(
    parsed.incumbent_candidate_id,
    `${filePath}.incumbent_candidate_id`,
  );
  const incumbentGeneration = requireInteger(
    parsed.incumbent_generation,
    `${filePath}.incumbent_generation`,
    0,
  );
  if (taskSetup.task_id !== taskId || taskSetup.workflow_id !== workflowId)
    failA1("IDENTITY_MISMATCH", "frozen policy task setup identity does not match", filePath);
  if (taskSetup.setup_revision !== taskSetupRevision)
    failA1("IDENTITY_MISMATCH", "frozen policy task setup revision does not match", filePath);
  if (modelUsagePolicy.revision !== modelUsagePolicyRevision)
    failA1("IDENTITY_MISMATCH", "frozen policy model policy revision does not match", filePath);
  if (taskSetup.policy_sha256 !== hashValue(modelUsagePolicy, "model-usage-policy-v1"))
    failA1("CORRUPT_FROZEN_POLICY", "frozen task setup policy hash cannot be verified", filePath);
  if (ownerLimits.revision !== ownerLimitsRevision)
    failA1("IDENTITY_MISMATCH", "frozen owner limits revision does not match", filePath);
  if (testerDefinition.tester_id !== testerId || testerDefinition.version !== testerVersion)
    failA1("IDENTITY_MISMATCH", "frozen tester identity does not match", filePath);
  if (
    incumbent.candidate_id !== incumbentCandidateId ||
    incumbent.generation !== incumbentGeneration
  )
    failA1("IDENTITY_MISMATCH", "frozen incumbent identity does not match", filePath);
  if (hashValue(ownerLimits, "owner-limits-v1") !== parsed.owner_limits_sha256)
    failA1("CORRUPT_FROZEN_POLICY", "frozen owner limits hash cannot be verified", filePath);
  if (hashValue(taskSetup, "task-setup-v1") !== parsed.task_setup_sha256)
    failA1("CORRUPT_FROZEN_POLICY", "frozen task setup hash cannot be verified", filePath);
  if (hashValue(modelUsagePolicy, "model-usage-policy-v1") !== parsed.model_usage_policy_sha256)
    failA1("CORRUPT_FROZEN_POLICY", "frozen model policy hash cannot be verified", filePath);
  if (hashValue(testerDefinition, "tester-definition-v1") !== parsed.tester_sha256)
    failA1("CORRUPT_FROZEN_POLICY", "frozen tester hash cannot be verified", filePath);
  if (hashValue(incumbent, "incumbent-v1") !== parsed.incumbent_sha256)
    failA1("CORRUPT_FROZEN_POLICY", "frozen incumbent hash cannot be verified", filePath);
  return {
    schema_version: 1,
    task_id: taskId,
    workflow_id: workflowId,
    outer_run_id: safeOuterRunId,
    owner_limits_revision: ownerLimitsRevision,
    owner_limits_sha256: assertSha256(
      parsed.owner_limits_sha256,
      `${filePath}.owner_limits_sha256`,
    ),
    task_setup_revision: taskSetupRevision,
    task_setup_sha256: assertSha256(parsed.task_setup_sha256, `${filePath}.task_setup_sha256`),
    model_usage_policy_revision: modelUsagePolicyRevision,
    model_usage_policy_sha256: assertSha256(
      parsed.model_usage_policy_sha256,
      `${filePath}.model_usage_policy_sha256`,
    ),
    tester_id: testerId,
    tester_version: testerVersion,
    tester_sha256: assertSha256(parsed.tester_sha256, `${filePath}.tester_sha256`),
    incumbent_candidate_id: incumbentCandidateId,
    incumbent_generation: incumbentGeneration,
    incumbent_sha256: assertSha256(parsed.incumbent_sha256, `${filePath}.incumbent_sha256`),
    owner_limits: ownerLimits,
    task_setup: taskSetup,
    model_usage_policy: modelUsagePolicy,
    tester_definition: testerDefinition,
    ...(testerAgent === undefined
      ? {}
      : {
          tester_agent_config: testerAgent,
          tester_agent_sha256: assertSha256(
            parsed.tester_agent_sha256,
            `${filePath}.tester_agent_sha256`,
          ),
        }),
    incumbent,
    frozen_at: requireString(parsed.frozen_at, `${filePath}.frozen_at`),
  };
}

function emptyDashboard(runId: string, frozenHash: string): WorkflowDashboard {
  return {
    schema_version: 1,
    run_id: runId,
    status: "running",
    current_phase: "init",
    outer_iteration: 1,
    generation: 1,
    wave_kind: null,
    child_run_ids: [],
    candidate_ids: [],
    finalist_id: null,
    promotion_trial_id: null,
    stop_decision: null,
    child_states: {},
    frozen_policy_sha256: frozenHash,
    updated_at: new Date().toISOString(),
  };
}

function validateDashboard(value: unknown, runId: string, filePath: string): WorkflowDashboard {
  if (!isRecord(value))
    failA1("CORRUPT_DASHBOARD", "workflow dashboard is not an object", filePath);
  const allowed = [
    "schema_version",
    "run_id",
    "status",
    "current_phase",
    "outer_iteration",
    "generation",
    "wave_kind",
    "child_run_ids",
    "candidate_ids",
    "finalist_id",
    "promotion_trial_id",
    "stop_decision",
    "child_states",
    "frozen_policy_sha256",
    "updated_at",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown workflow dashboard field '${key}'`, `${filePath}.${key}`);
  if (value.schema_version !== 1 || value.run_id !== runId)
    failA1("IDENTITY_MISMATCH", "workflow dashboard run id does not match its directory", filePath);
  if (
    value.status !== "running" &&
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "stopped"
  )
    failA1("CORRUPT_DASHBOARD", "invalid workflow dashboard status", filePath);
  if (
    value.current_phase !== "init" &&
    value.current_phase !== "loop" &&
    value.current_phase !== "summary"
  )
    failA1("CORRUPT_DASHBOARD", "invalid workflow dashboard phase", filePath);
  if (
    value.wave_kind !== null &&
    value.wave_kind !== "module" &&
    value.wave_kind !== "structure" &&
    value.wave_kind !== "scorer"
  )
    failA1("CORRUPT_DASHBOARD", "invalid workflow wave kind", filePath);
  if (!Array.isArray(value.child_run_ids) || !Array.isArray(value.candidate_ids))
    failA1("CORRUPT_DASHBOARD", "workflow dashboard id arrays are required", filePath);
  const childRunIds = value.child_run_ids.map((child, index) =>
    assertIdentifier(child, `${filePath}.child_run_ids[${index}]`),
  );
  const candidateIds = value.candidate_ids.map((candidate, index) =>
    assertIdentifier(candidate, `${filePath}.candidate_ids[${index}]`),
  );
  if (!isRecord(value.child_states))
    failA1("CORRUPT_DASHBOARD", "child_states must be an object", filePath);
  const childStates: Record<string, string> = {};
  for (const [key, state] of Object.entries(value.child_states)) {
    assertIdentifier(key, `${filePath}.child_states.key`);
    childStates[key] = requireString(state, `${filePath}.child_states.${key}`);
  }
  const nullableIdentifier = (candidate: unknown, location: string): string | null =>
    candidate === null ? null : assertIdentifier(candidate, location);
  return {
    schema_version: 1,
    run_id: runId,
    status: value.status,
    current_phase: value.current_phase,
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${filePath}.generation`, 1),
    wave_kind: value.wave_kind,
    child_run_ids: childRunIds,
    candidate_ids: candidateIds,
    finalist_id: nullableIdentifier(value.finalist_id, `${filePath}.finalist_id`),
    promotion_trial_id: nullableIdentifier(
      value.promotion_trial_id,
      `${filePath}.promotion_trial_id`,
    ),
    stop_decision:
      value.stop_decision === null
        ? null
        : requireString(value.stop_decision, `${filePath}.stop_decision`),
    child_states: childStates,
    frozen_policy_sha256: assertSha256(
      value.frozen_policy_sha256,
      `${filePath}.frozen_policy_sha256`,
    ),
    updated_at: requireString(value.updated_at, `${filePath}.updated_at`),
  };
}

export function createWorkflowDashboard(
  projectRoot: string,
  outerRunId: string,
  frozenPolicySha256: string,
): WorkflowDashboard {
  const runId = assertIdentifier(outerRunId, "outer_run_id");
  const hash = assertSha256(frozenPolicySha256, "frozen_policy_sha256");
  const filePath = workflowDashboardPath(projectRoot, runId);
  return withStateFileLock(filePath, () => {
    const frozenPath = frozenPolicyPath(projectRoot, runId);
    if (!fs.existsSync(frozenPath))
      failA1("FROZEN_POLICY_NOT_FOUND", `no frozen policy at ${frozenPath}`);
    if (frozenPolicyFingerprint(readFrozenPolicy(projectRoot, runId)) !== hash) {
      failA1("IDENTITY_MISMATCH", "dashboard hash does not match the frozen policy", filePath);
    }
    if (fs.existsSync(filePath)) {
      const existing = validateDashboard(readStateFile(filePath), runId, filePath);
      if (existing.frozen_policy_sha256 !== hash)
        failA1(
          "IDENTITY_MISMATCH",
          "workflow dashboard is bound to a different frozen policy",
          filePath,
        );
      return existing;
    }
    const dashboard = emptyDashboard(runId, hash);
    writeStateJsonAtomic(filePath, dashboard);
    return dashboard;
  });
}

export type WorkflowDashboardUpdate = Partial<
  Pick<
    WorkflowDashboard,
    | "status"
    | "current_phase"
    | "outer_iteration"
    | "generation"
    | "wave_kind"
    | "child_run_ids"
    | "candidate_ids"
    | "finalist_id"
    | "promotion_trial_id"
    | "stop_decision"
    | "child_states"
  >
>;

export function updateWorkflowDashboard(
  projectRoot: string,
  outerRunId: string,
  update: WorkflowDashboardUpdate,
): WorkflowDashboard {
  const runId = assertIdentifier(outerRunId, "outer_run_id");
  const filePath = workflowDashboardPath(projectRoot, runId);
  return withStateFileLock(filePath, () => {
    if (!fs.existsSync(filePath))
      failA1("DASHBOARD_NOT_FOUND", `no workflow dashboard at ${filePath}`);
    const dashboard = validateDashboard(readStateFile(filePath), runId, filePath);
    const frozenPath = frozenPolicyPath(projectRoot, runId);
    if (
      !fs.existsSync(frozenPath) ||
      frozenPolicyFingerprint(readFrozenPolicy(projectRoot, runId)) !==
        dashboard.frozen_policy_sha256
    )
      failA1(
        "IDENTITY_MISMATCH",
        "workflow dashboard is not bound to its immutable frozen policy",
        filePath,
      );
    const next = {
      ...dashboard,
      ...update,
      run_id: runId,
      schema_version: 1,
      frozen_policy_sha256: dashboard.frozen_policy_sha256,
      updated_at: new Date().toISOString(),
    };
    const validated = validateDashboard(next, runId, filePath);
    writeStateJsonAtomic(filePath, validated);
    return validated;
  });
}

export function writeCycleFile(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  fileName: string,
  value: unknown,
): void {
  const filePath = cycleFilePath(projectRoot, outerRunId, outerIteration, fileName);
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (
        canonicalJsonSha256(existing, undefined, { schemaVersion: "cycle-file-v1" }) ===
        canonicalJsonSha256(value, undefined, { schemaVersion: "cycle-file-v1" })
      )
        return;
      failA1(
        "IMMUTABLE_CONFLICT",
        `cycle file '${fileName}' already exists with different content`,
        filePath,
      );
    }
    writeStateJsonAtomic(filePath, value);
  });
}

export function readCycleFile(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  fileName: string,
): unknown {
  const filePath = cycleFilePath(projectRoot, outerRunId, outerIteration, fileName);
  if (!fs.existsSync(filePath)) failA1("CYCLE_FILE_NOT_FOUND", `no cycle file at ${filePath}`);
  return readStateFile(filePath);
}

export interface WikiHeadSnapshot {
  schema_version: 1;
  outer_run_id: string;
  outer_iteration: number;
  head: string | null;
  sha256: string;
}

export function saveCycleWikiHead(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  head: string | null,
  eventLogSha256: string,
): WikiHeadSnapshot {
  const snapshot: WikiHeadSnapshot = {
    schema_version: 1,
    outer_run_id: assertIdentifier(outerRunId, "outer_run_id"),
    outer_iteration: requireInteger(outerIteration, "outer_iteration", 1),
    head: head === null ? null : requireString(head, "wiki_head.head"),
    sha256: assertSha256(eventLogSha256, "wiki_head.sha256"),
  };
  const filePath = cycleFilePath(
    projectRoot,
    snapshot.outer_run_id,
    snapshot.outer_iteration,
    "wiki-head.json",
  );
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (
        canonicalJsonSha256(existing, undefined, { schemaVersion: "wiki-head-v1" }) !==
        canonicalJsonSha256(snapshot, undefined, { schemaVersion: "wiki-head-v1" })
      )
        failA1(
          "IMMUTABLE_CONFLICT",
          `wiki head for cycle ${snapshot.outer_iteration} cannot be replaced`,
        );
      return;
    }
    writeStateJsonAtomic(filePath, snapshot);
  });
  return snapshot;
}

export function frozenPolicyFingerprint(policy: FrozenPolicy): string {
  return canonicalJsonSha256(policy, undefined, { schemaVersion: "frozen-policy-v1" });
}

export const OUTER_PHASES = [
  "init",
  "diagnosis",
  "workset",
  "bridge-repair",
  "wave",
  "validation",
  "promotion",
  "summary",
] as const;

export type OuterPhase = (typeof OUTER_PHASES)[number];
function isOuterPhase(value: unknown): value is OuterPhase {
  return OUTER_PHASES.some((phase) => phase === value);
}
export type OuterRuntimeStatus = "initializing" | "running" | "completed" | "failed" | "stopped";
export type OuterPhaseStatus = "active" | "completed" | "failed" | "stopped";
export type OuterChildKind = "module" | "scorer" | "tester";
export type OuterChildStatus = "active" | "completed" | "failed" | "stopped";
export type OuterBudgetCategory =
  | "outer"
  | "module"
  | "validation"
  | "scorer"
  | "promotion"
  | "review";
export type OuterBudgetStatus = "reserved" | "settled" | "released";

export interface OuterPhaseHistoryEntry {
  phase: OuterPhase;
  outer_iteration: number;
  generation: number;
  status: OuterPhaseStatus;
  evidence_refs: string[];
  evidence_sha256: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface OuterCycleBudgetSummary {
  reserved: number;
  consumed: number;
  released: number;
  unit: string;
}

export interface OuterCycleSummary {
  schema_version: 1;
  outer_run_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  wave_kind: "module" | "structure" | "scorer";
  status: "completed" | "failed" | "stopped";
  candidate_ids: string[];
  finalist_id: string | null;
  promotion_trial_id: string | null;
  validation_result: "passed" | "rejected" | "incomplete" | "not_run";
  promotion_result: "passed" | "rejected" | "not_run" | "infra_failed";
  target_reached: boolean;
  valid_candidate: boolean;
  tester_improved: boolean | null;
  budget: OuterCycleBudgetSummary;
  evidence_refs: string[];
  evidence_sha256: string;
  recorded_at: string;
}

export interface OuterChildRecord {
  child_run_id: string;
  kind: OuterChildKind;
  /**
   * Which module of the workflow spec this child was dispatched to work on.
   * Only a module child has one. The parent records it here because the parent
   * is the one that made the assignment: a child run is an ordinary research
   * run and has no reason to carry its parent's wave bookkeeping.
   */
  module_id: string | null;
  outer_iteration: number;
  generation: number;
  status: OuterChildStatus;
  state_sha256: string | null;
  registered_at: string;
  terminal_at: string | null;
}

/**
 * A workflow bridge failure is kept with the cycle that produced it.  The
 * failure is evidence about whether the candidate can be executed; it is not
 * a measured score and therefore cannot be sent to validation or tester.
 */
export interface OuterBridgeFailure {
  schema_version: 1;
  bridge_receipt_ref: string;
  bridge_receipt_sha256: string;
  bridge_manifest_ref: string;
  bridge_manifest_sha256: string;
  frozen_input_sha256: string;
  error: Record<string, unknown>;
  repair_attempts: number;

  status: "pending" | "fixed" | "exhausted";
  repair_receipt_ref: string | null;
  repair_receipt_sha256: string | null;
}

export interface OuterBudgetReservation {
  reservation_id: string;
  outer_iteration: number;
  category: OuterBudgetCategory;
  amount: number;
  unit: string;
  child_run_id: string | null;
  status: OuterBudgetStatus;
  evidence_sha256: string | null;
  reserved_at: string;
  closed_at: string | null;
}

export interface ActiveOuterCycle {
  outer_iteration: number;
  generation: number;
  wave_id: string;
  wave_kind: "module" | "structure" | "scorer";
  promotion_commit_ref: string | null;
  /** The latest successful bridge output, when the outer bridge was recorded. */
  bridge_success_receipt_ref?: string | null;
  bridge_success_receipt_sha256?: string | null;
  bridge_success_manifest_ref?: string | null;
  bridge_success_manifest_sha256?: string | null;
  /** Optional while reading a state written before the bridge repair fields existed. */
  bridge_failure?: OuterBridgeFailure | null;
}

export interface WorkflowRuntimeState {
  schema_version: 1;
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  scope_path: string;

  /** @deprecated Reader-only alias for parent_run_id. Never persisted. */
  outer_run_id: string;
  execution_root: string;
  project_root: string;
  task_id: string;
  workflow_id: string;
  status: OuterRuntimeStatus;
  current_phase: OuterPhase;
  outer_iteration: number;
  generation: number;
  active_cycle: ActiveOuterCycle | null;
  phase_history: OuterPhaseHistoryEntry[];
  cycle_history: OuterCycleSummary[];
  children: OuterChildRecord[];
  budgets: OuterBudgetReservation[];
  stop_decision_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkflowRuntimeStateInput {
  execution_root: string;
  project_root: string;
  outer_run_id: string;
  parent_run_id?: string | null;
  depth?: number;
  scope_path?: string;

  task_id: string;
  workflow_id: string;
}

export function workflowRuntimePath(projectRoot: string, outerRunId: string): string {
  return runOwnedPath(
    projectRoot,
    assertIdentifier(outerRunId, "outer_run_id"),
    "workflow-runtime.json",
  );
}

export function workflowPhaseHistoryPath(projectRoot: string, outerRunId: string): string {
  return runOwnedPath(
    projectRoot,
    assertIdentifier(outerRunId, "outer_run_id"),
    "phase-history.json",
  );
}

export function workflowCycleSummaryPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return cycleFilePath(projectRoot, outerRunId, outerIteration, "summary.json");
}

function assertAbsoluteNormalizedDirectory(value: unknown, location: string): string {
  const directory = requireString(value, location);
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === "/") {
    failA1("INVALID_PATH", "expected a normalized absolute directory", location);
  }
  return directory;
}

function nullableHash(value: unknown, location: string): string | null {
  return value === null ? null : assertSha256(value, location);
}

function nullableTimestamp(value: unknown, location: string): string | null {
  return value === null ? null : requireString(value, location);
}

function validatePhaseHistoryEntry(value: unknown, location: string): OuterPhaseHistoryEntry {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "phase history entry must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "phase",
      "outer_iteration",
      "generation",
      "status",
      "evidence_refs",
      "evidence_sha256",
      "started_at",
      "completed_at",
    ],
    location,
  );
  if (!isOuterPhase(value.phase))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "unknown outer phase", `${location}.phase`);
  if (
    value.status !== "active" &&
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "stopped"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "unknown outer phase status", `${location}.status`);
  if (!Array.isArray(value.evidence_refs))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "phase evidence_refs must be an array", location);
  const evidenceRefs = value.evidence_refs.map((ref, index) =>
    requireString(ref, `${location}.evidence_refs[${index}]`),
  );
  if (value.status !== "active" && evidenceRefs.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "a completed phase needs evidence references", location);
  const evidenceSha256 = nullableHash(value.evidence_sha256, `${location}.evidence_sha256`);
  if (value.status !== "active" && evidenceSha256 === null)
    failA1("OUTER_EVIDENCE_REQUIRED", "a completed phase needs an evidence hash", location);
  return {
    phase: value.phase,
    outer_iteration: requireInteger(value.outer_iteration, `${location}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${location}.generation`, 1),
    status: value.status,
    evidence_refs: evidenceRefs,
    evidence_sha256: evidenceSha256,
    started_at: requireString(value.started_at, `${location}.started_at`),
    completed_at: nullableTimestamp(value.completed_at, `${location}.completed_at`),
  };
}

function validateCycleBudget(value: unknown, location: string): OuterCycleBudgetSummary {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle budget must be an object", location);
  assertNoUnknownFields(value, ["reserved", "consumed", "released", "unit"], location);
  const reserved = requireFiniteNumber(value.reserved, `${location}.reserved`);
  const consumed = requireFiniteNumber(value.consumed, `${location}.consumed`);
  const released = requireFiniteNumber(value.released, `${location}.released`);
  if (reserved < 0 || consumed < 0 || released < 0 || consumed > reserved || released > reserved) {
    failA1("INVALID_VALUE", "cycle budget values are inconsistent", location);
  }
  return {
    reserved,
    consumed,
    released,
    unit: requireString(value.unit, `${location}.unit`),
  };
}

function validateCycleSummary(value: unknown, location: string): OuterCycleSummary {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle summary must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "outer_run_id",
      "outer_iteration",
      "generation",
      "wave_id",
      "wave_kind",
      "status",
      "candidate_ids",
      "finalist_id",
      "promotion_trial_id",
      "validation_result",
      "promotion_result",
      "target_reached",
      "valid_candidate",
      "tester_improved",
      "budget",
      "evidence_refs",
      "evidence_sha256",
      "recorded_at",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle summary schema_version must be 1", location);
  if (
    value.wave_kind !== "module" &&
    value.wave_kind !== "structure" &&
    value.wave_kind !== "scorer"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle summary wave_kind is invalid", location);
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "stopped")
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle summary status is invalid", location);
  if (
    value.validation_result !== "passed" &&
    value.validation_result !== "rejected" &&
    value.validation_result !== "incomplete" &&
    value.validation_result !== "not_run"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle validation result is invalid", location);
  if (
    value.promotion_result !== "passed" &&
    value.promotion_result !== "rejected" &&
    value.promotion_result !== "not_run" &&
    value.promotion_result !== "infra_failed"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle promotion result is invalid", location);
  if (typeof value.target_reached !== "boolean" || typeof value.valid_candidate !== "boolean")
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle boolean results are invalid", location);
  if (value.tester_improved !== null && typeof value.tester_improved !== "boolean")
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle tester_improved is invalid", location);
  if (!Array.isArray(value.candidate_ids) || !Array.isArray(value.evidence_refs))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "cycle id and evidence arrays are required", location);
  const candidateIds = value.candidate_ids.map((candidate, index) =>
    assertIdentifier(candidate, `${location}.candidate_ids[${index}]`),
  );
  if (new Set(candidateIds).size !== candidateIds.length)
    failA1("DUPLICATE_ID", "cycle candidate ids must be unique", `${location}.candidate_ids`);
  const finalistId =
    value.finalist_id === null
      ? null
      : assertIdentifier(value.finalist_id, `${location}.finalist_id`);
  if (finalistId !== null && !candidateIds.includes(finalistId))
    failA1("IDENTITY_MISMATCH", "cycle finalist must be one of its candidates", location);
  const promotionTrialId =
    value.promotion_trial_id === null
      ? null
      : assertIdentifier(value.promotion_trial_id, `${location}.promotion_trial_id`);
  const evidenceRefs = value.evidence_refs.map((ref, index) =>
    requireString(ref, `${location}.evidence_refs[${index}]`),
  );
  if (evidenceRefs.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "cycle completion needs evidence references", location);
  return {
    schema_version: 1,
    outer_run_id: assertIdentifier(value.outer_run_id, `${location}.outer_run_id`),
    outer_iteration: requireInteger(value.outer_iteration, `${location}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${location}.generation`, 1),
    wave_id: assertIdentifier(value.wave_id, `${location}.wave_id`),
    wave_kind: value.wave_kind,
    status: value.status,
    candidate_ids: candidateIds,
    finalist_id: finalistId,
    promotion_trial_id: promotionTrialId,
    validation_result: value.validation_result,
    promotion_result: value.promotion_result,
    target_reached: value.target_reached,
    valid_candidate: value.valid_candidate,
    tester_improved: value.tester_improved,
    budget: validateCycleBudget(value.budget, `${location}.budget`),
    evidence_refs: evidenceRefs,
    evidence_sha256: assertSha256(value.evidence_sha256, `${location}.evidence_sha256`),
    recorded_at: requireString(value.recorded_at, `${location}.recorded_at`),
  };
}

function validateChildRecord(value: unknown, location: string): OuterChildRecord {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "child record must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "child_run_id",
      "kind",
      "module_id",
      "outer_iteration",
      "generation",
      "status",
      "state_sha256",
      "registered_at",
      "terminal_at",
    ],
    location,
  );
  if (value.kind !== "module" && value.kind !== "scorer" && value.kind !== "tester")
    failA1("CORRUPT_WORKFLOW_RUNTIME", "child kind is invalid", `${location}.kind`);
  if (
    value.status !== "active" &&
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "stopped"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "child status is invalid", `${location}.status`);
  const statusSha256 = nullableHash(value.state_sha256, `${location}.state_sha256`);
  const terminalAt = nullableTimestamp(value.terminal_at, `${location}.terminal_at`);
  if (value.status === "active" && terminalAt !== null)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "active child cannot have terminal_at", location);
  if (value.status !== "active" && (statusSha256 === null || terminalAt === null))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "terminal child lacks state evidence", location);
  const moduleId =
    value.module_id === undefined || value.module_id === null
      ? null
      : requireString(value.module_id, `${location}.module_id`);
  if (value.kind === "module" && moduleId === null)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "a module child must name the module it works on", location);
  if (value.kind !== "module" && moduleId !== null)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "only a module child can name a module", location);
  return {
    child_run_id: assertIdentifier(value.child_run_id, `${location}.child_run_id`),
    kind: value.kind,
    module_id: moduleId,
    outer_iteration: requireInteger(value.outer_iteration, `${location}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${location}.generation`, 1),
    status: value.status,
    state_sha256: statusSha256,
    registered_at: requireString(value.registered_at, `${location}.registered_at`),
    terminal_at: terminalAt,
  };
}

function validateBudgetReservation(value: unknown, location: string): OuterBudgetReservation {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "budget reservation must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "reservation_id",
      "outer_iteration",
      "category",
      "amount",
      "unit",
      "child_run_id",
      "status",
      "evidence_sha256",
      "reserved_at",
      "closed_at",
    ],
    location,
  );
  const categories: readonly OuterBudgetCategory[] = [
    "outer",
    "module",
    "validation",
    "scorer",
    "promotion",
    "review",
  ];
  const category = categories.find((item) => item === value.category);
  if (category === undefined)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "budget category is invalid", `${location}.category`);
  if (value.status !== "reserved" && value.status !== "settled" && value.status !== "released")
    failA1("CORRUPT_WORKFLOW_RUNTIME", "budget status is invalid", `${location}.status`);
  const amount = requireFiniteNumber(value.amount, `${location}.amount`);
  if (amount < 0)
    failA1("INVALID_VALUE", "budget amount must be non-negative", `${location}.amount`);
  const evidenceSha256 = nullableHash(value.evidence_sha256, `${location}.evidence_sha256`);
  const closedAt = nullableTimestamp(value.closed_at, `${location}.closed_at`);
  if (value.status !== "reserved" && (evidenceSha256 === null || closedAt === null))
    failA1("OUTER_EVIDENCE_REQUIRED", "closed budget needs evidence", location);
  return {
    reservation_id: assertIdentifier(value.reservation_id, `${location}.reservation_id`),
    outer_iteration: requireInteger(value.outer_iteration, `${location}.outer_iteration`, 1),
    category,
    amount,
    unit: requireString(value.unit, `${location}.unit`),
    child_run_id:
      value.child_run_id === null
        ? null
        : assertIdentifier(value.child_run_id, `${location}.child_run_id`),
    status: value.status,
    evidence_sha256: evidenceSha256,
    reserved_at: requireString(value.reserved_at, `${location}.reserved_at`),
    closed_at: closedAt,
  };
}

function validateOuterBridgeFailure(value: unknown, location: string): OuterBridgeFailure | null {
  if (value === null) return null;
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "bridge_failure must be an object or null", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "bridge_receipt_ref",
      "bridge_receipt_sha256",
      "bridge_manifest_ref",
      "bridge_manifest_sha256",
      "frozen_input_sha256",
      "error",
      "repair_attempts",

      "status",
      "repair_receipt_ref",
      "repair_receipt_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "bridge_failure schema_version must be 1", location);
  if (!isRecord(value.error))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "bridge_failure.error must be an object", location);
  if (value.status !== "pending" && value.status !== "fixed" && value.status !== "exhausted")
    failA1("CORRUPT_WORKFLOW_RUNTIME", "bridge_failure.status is invalid", location);
  const repairAttempts = requireInteger(value.repair_attempts, `${location}.repair_attempts`, 0);

  const repairReceiptRef =
    value.repair_receipt_ref === null
      ? null
      : assertRelativePath(value.repair_receipt_ref, `${location}.repair_receipt_ref`);
  const repairReceiptSha256 =
    value.repair_receipt_sha256 === null
      ? null
      : assertSha256(value.repair_receipt_sha256, `${location}.repair_receipt_sha256`);
  if ((repairReceiptRef === null) !== (repairReceiptSha256 === null))
    failA1(
      "CORRUPT_WORKFLOW_RUNTIME",
      "bridge repair receipt reference and hash must be present together",
      location,
    );
  return {
    schema_version: 1,
    bridge_receipt_ref: assertRelativePath(
      value.bridge_receipt_ref,
      `${location}.bridge_receipt_ref`,
    ),
    bridge_receipt_sha256: assertSha256(
      value.bridge_receipt_sha256,
      `${location}.bridge_receipt_sha256`,
    ),
    bridge_manifest_ref: assertRelativePath(
      value.bridge_manifest_ref,
      `${location}.bridge_manifest_ref`,
    ),
    bridge_manifest_sha256: assertSha256(
      value.bridge_manifest_sha256,
      `${location}.bridge_manifest_sha256`,
    ),
    frozen_input_sha256: assertSha256(value.frozen_input_sha256, `${location}.frozen_input_sha256`),
    error: value.error,
    repair_attempts: repairAttempts,

    status: value.status,
    repair_receipt_ref: repairReceiptRef,
    repair_receipt_sha256: repairReceiptSha256,
  };
}

function validateActiveCycle(value: unknown, location: string): ActiveOuterCycle {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "active cycle must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "outer_iteration",
      "generation",
      "wave_id",
      "wave_kind",
      "promotion_commit_ref",
      "bridge_success_receipt_ref",
      "bridge_success_receipt_sha256",
      "bridge_success_manifest_ref",
      "bridge_success_manifest_sha256",
      "bridge_failure",
    ],
    location,
  );
  if (
    value.wave_kind !== "module" &&
    value.wave_kind !== "structure" &&
    value.wave_kind !== "scorer"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "active cycle wave kind is invalid", location);
  const bridgeSuccessReceiptRef =
    value.bridge_success_receipt_ref === undefined || value.bridge_success_receipt_ref === null
      ? null
      : assertRelativePath(
          value.bridge_success_receipt_ref,
          `${location}.bridge_success_receipt_ref`,
        );
  const bridgeSuccessReceiptSha256 =
    value.bridge_success_receipt_sha256 === undefined ||
    value.bridge_success_receipt_sha256 === null
      ? null
      : assertSha256(
          value.bridge_success_receipt_sha256,
          `${location}.bridge_success_receipt_sha256`,
        );
  const bridgeSuccessManifestRef =
    value.bridge_success_manifest_ref === undefined || value.bridge_success_manifest_ref === null
      ? null
      : assertRelativePath(
          value.bridge_success_manifest_ref,
          `${location}.bridge_success_manifest_ref`,
        );
  const bridgeSuccessManifestSha256 =
    value.bridge_success_manifest_sha256 === undefined ||
    value.bridge_success_manifest_sha256 === null
      ? null
      : assertSha256(
          value.bridge_success_manifest_sha256,
          `${location}.bridge_success_manifest_sha256`,
        );
  if ((bridgeSuccessReceiptRef === null) !== (bridgeSuccessReceiptSha256 === null))
    failA1(
      "CORRUPT_WORKFLOW_RUNTIME",
      "successful bridge receipt reference and hash must be present together",
      location,
    );
  if ((bridgeSuccessManifestRef === null) !== (bridgeSuccessManifestSha256 === null))
    failA1(
      "CORRUPT_WORKFLOW_RUNTIME",
      "successful bridge manifest reference and hash must be present together",
      location,
    );
  return {
    outer_iteration: requireInteger(value.outer_iteration, `${location}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${location}.generation`, 1),
    wave_id: assertIdentifier(value.wave_id, `${location}.wave_id`),
    wave_kind: value.wave_kind,
    promotion_commit_ref:
      value.promotion_commit_ref === null
        ? null
        : requireString(value.promotion_commit_ref, `${location}.promotion_commit_ref`),
    bridge_success_receipt_ref: bridgeSuccessReceiptRef,
    bridge_success_receipt_sha256: bridgeSuccessReceiptSha256,
    bridge_success_manifest_ref: bridgeSuccessManifestRef,
    bridge_success_manifest_sha256: bridgeSuccessManifestSha256,
    bridge_failure: validateOuterBridgeFailure(
      value.bridge_failure === undefined ? null : value.bridge_failure,
      `${location}.bridge_failure`,
    ),
  };
}

export function validateWorkflowRuntimeState(
  value: unknown,
  expectedOuterRunId?: string,
  filePath = "workflow-runtime",
): WorkflowRuntimeState {
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "workflow runtime must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "run_id",
      "parent_run_id",
      "outer_run_id",
      "depth",
      "scope_path",

      "execution_root",
      "project_root",
      "task_id",
      "workflow_id",
      "status",
      "current_phase",
      "outer_iteration",
      "generation",
      "active_cycle",
      "phase_history",
      "cycle_history",
      "children",
      "budgets",
      "stop_decision_ref",
      "created_at",
      "updated_at",
    ],
    filePath,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "workflow runtime schema_version must be 1", filePath);
  const runId = assertIdentifier(value.run_id ?? value.outer_run_id, `${filePath}.run_id`);
  if (
    expectedOuterRunId !== undefined &&
    runId !== assertIdentifier(expectedOuterRunId, "outer_run_id")
  )
    failA1("IDENTITY_MISMATCH", "workflow runtime path and content disagree", filePath);
  if (value.run_id !== undefined && value.run_id !== runId)
    failA1("IDENTITY_MISMATCH", "workflow runtime run_id does not match its path", filePath);
  const parentRunId =
    value.parent_run_id === undefined || value.parent_run_id === null
      ? null
      : assertIdentifier(value.parent_run_id, `${filePath}.parent_run_id`);
  const depth = requireInteger(
    value.depth ?? (parentRunId === null ? 0 : 1),
    `${filePath}.depth`,
    0,
  );

  const scopePath = normalizeScopePath(
    value.scope_path ?? (parentRunId === null ? "/" : `/${runId}`),
    `${filePath}.scope_path`,
  );

  if (
    value.status !== "initializing" &&
    value.status !== "running" &&
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "stopped"
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "workflow runtime status is invalid", `${filePath}.status`);
  if (!isOuterPhase(value.current_phase))
    failA1(
      "CORRUPT_WORKFLOW_RUNTIME",
      "workflow runtime phase is invalid",
      `${filePath}.current_phase`,
    );
  if (!Array.isArray(value.phase_history) || !Array.isArray(value.cycle_history))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "workflow runtime histories are required", filePath);
  if (!Array.isArray(value.children) || !Array.isArray(value.budgets))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "workflow runtime cleanup lists are required", filePath);
  const phaseHistory = value.phase_history.map((entry, index) =>
    validatePhaseHistoryEntry(entry, `${filePath}.phase_history[${index}]`),
  );
  if (phaseHistory.length === 0)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "workflow runtime phase history is empty", filePath);
  if (phaseHistory[phaseHistory.length - 1]!.phase !== value.current_phase)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "current phase is not the end of phase history", filePath);
  const cycleHistory = value.cycle_history.map((entry, index) =>
    validateCycleSummary(entry, `${filePath}.cycle_history[${index}]`),
  );
  const seenIterations = new Set<number>();
  for (const cycle of cycleHistory) {
    if (cycle.outer_run_id !== runId)
      failA1("IDENTITY_MISMATCH", "cycle summary belongs to another outer run", filePath);
    if (seenIterations.has(cycle.outer_iteration))
      failA1("DUPLICATE_ID", "workflow cycle iterations must be unique", filePath);
    seenIterations.add(cycle.outer_iteration);
  }
  const children = value.children.map((entry, index) =>
    validateChildRecord(entry, `${filePath}.children[${index}]`),
  );
  if (new Set(children.map((child) => child.child_run_id)).size !== children.length)
    failA1("DUPLICATE_ID", "workflow child ids must be unique", `${filePath}.children`);
  const budgets = value.budgets.map((entry, index) =>
    validateBudgetReservation(entry, `${filePath}.budgets[${index}]`),
  );
  if (new Set(budgets.map((budget) => budget.reservation_id)).size !== budgets.length)
    failA1("DUPLICATE_ID", "workflow budget reservation ids must be unique", `${filePath}.budgets`);
  const activeCycle =
    value.active_cycle === null
      ? null
      : validateActiveCycle(value.active_cycle, `${filePath}.active_cycle`);
  if (activeCycle !== null && activeCycle.outer_iteration !== value.outer_iteration)
    failA1("IDENTITY_MISMATCH", "active cycle does not match outer_iteration", filePath);
  if (
    value.status !== "initializing" &&
    activeCycle === null &&
    value.current_phase !== "summary" &&
    cycleHistory.length > 0
  )
    failA1("CORRUPT_WORKFLOW_RUNTIME", "a non-summary runtime needs an active cycle", filePath);
  if (value.status === "completed" || value.status === "failed" || value.status === "stopped") {
    if (
      activeCycle !== null ||
      children.some((child) => child.status === "active") ||
      budgets.some((budget) => budget.status === "reserved")
    )
      failA1(
        "OUTER_CLEANUP_REQUIRED",
        "terminal workflow still owns active children or budget",
        filePath,
      );
    if (value.current_phase !== "summary")
      failA1("CORRUPT_WORKFLOW_RUNTIME", "terminal workflow must be in summary phase", filePath);
  }
  return {
    schema_version: 1,
    run_id: runId,
    parent_run_id: parentRunId,
    depth,
    scope_path: scopePath,

    outer_run_id: runId,
    execution_root: assertAbsoluteNormalizedDirectory(
      value.execution_root,
      `${filePath}.execution_root`,
    ),
    project_root: assertAbsoluteNormalizedDirectory(value.project_root, `${filePath}.project_root`),
    task_id: assertIdentifier(value.task_id, `${filePath}.task_id`),
    workflow_id: assertIdentifier(value.workflow_id, `${filePath}.workflow_id`),
    status: value.status,
    current_phase: value.current_phase,
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${filePath}.generation`, 1),
    active_cycle: activeCycle,
    phase_history: phaseHistory,
    cycle_history: cycleHistory,
    children,
    budgets,
    stop_decision_ref:
      value.stop_decision_ref === null
        ? null
        : requireString(value.stop_decision_ref, `${filePath}.stop_decision_ref`),
    created_at: requireString(value.created_at, `${filePath}.created_at`),
    updated_at: requireString(value.updated_at, `${filePath}.updated_at`),
  };
}

export function createWorkflowRuntimeState(
  input: CreateWorkflowRuntimeStateInput,
): WorkflowRuntimeState {
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const executionRoot = assertAbsoluteNormalizedDirectory(input.execution_root, "execution_root");
  const projectRoot = assertAbsoluteNormalizedDirectory(input.project_root, "project_root");
  const run = openExistingRun({
    project_root: projectRoot,
    run_id: outerRunId,
    parent_run_id: input.parent_run_id,
    depth: input.depth,
    scope_path: input.scope_path,
  });

  assertRunReferenceCompatible(projectRoot, {
    run_id: run.run_id,
    parent_run_id: run.parent_run_id,
    depth: run.depth,
    scope_path: run.scope_path,
  });
  const taskId = assertIdentifier(input.task_id, "task_id");
  const workflowId = assertIdentifier(input.workflow_id, "workflow_id");
  const timestamp = new Date().toISOString();
  const initialPhase: OuterPhaseHistoryEntry = {
    phase: "init",
    outer_iteration: 1,
    generation: 1,
    status: "active",
    evidence_refs: [],
    evidence_sha256: null,
    started_at: timestamp,
    completed_at: null,
  };
  return {
    schema_version: 1,
    run_id: run.run_id,
    parent_run_id: run.parent_run_id,
    depth: run.depth,
    scope_path: run.scope_path,

    outer_run_id: run.run_id,
    execution_root: executionRoot,
    project_root: projectRoot,
    task_id: taskId,
    workflow_id: workflowId,
    status: "running",
    current_phase: "init",
    outer_iteration: 1,
    generation: 1,
    active_cycle: null,
    phase_history: [initialPhase],
    cycle_history: [],
    children: [],
    budgets: [],
    stop_decision_ref: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function readWorkflowRuntimeState(
  projectRoot: string,
  outerRunId: string,
): WorkflowRuntimeState {
  const safeRunId = assertIdentifier(outerRunId, "outer_run_id");
  const filePath = workflowRuntimePath(projectRoot, safeRunId);
  if (!fs.existsSync(filePath))
    failA1("OUTER_RUN_STATE_NOT_FOUND", `no workflow runtime at ${filePath}`);
  const state = validateWorkflowRuntimeState(readStateFile(filePath), safeRunId, filePath);
  const run = requireRunContract(projectRoot, safeRunId);
  if (
    run.parent_run_id !== state.parent_run_id ||
    run.depth !== state.depth ||
    run.scope_path !== state.scope_path
  )
    failA1("IDENTITY_MISMATCH", "workflow runtime and run.json identities differ", filePath);
  return {
    ...state,
  };
}

export function writeWorkflowRuntimeState(
  projectRoot: string,
  state: WorkflowRuntimeState,
): WorkflowRuntimeState {
  const validated = validateWorkflowRuntimeState(state, state.run_id, "workflow-runtime");
  if (path.resolve(validated.project_root) !== path.resolve(projectRoot))
    failA1("IDENTITY_MISMATCH", "workflow runtime project root differs from command root");
  const contract = requireRunContract(projectRoot, validated.run_id);
  if (
    contract.parent_run_id !== validated.parent_run_id ||
    contract.depth !== validated.depth ||
    contract.scope_path !== validated.scope_path
  )
    failA1("IDENTITY_MISMATCH", "workflow runtime and run.json identities differ");
  const persisted = stripLegacyParentField(validated, validated.parent_run_id);
  const filePath = workflowRuntimePath(projectRoot, validated.run_id);
  writeStateJsonAtomic(filePath, persisted);
  return validated;
}

export function writeWorkflowPhaseHistory(
  projectRoot: string,
  outerRunId: string,
  entries: readonly OuterPhaseHistoryEntry[],
): void {
  const safeRunId = assertIdentifier(outerRunId, "outer_run_id");
  const filePath = workflowPhaseHistoryPath(projectRoot, safeRunId);
  const parsedEntries = entries.map((entry, index) =>
    validatePhaseHistoryEntry(entry, `phase-history.entries[${index}]`),
  );
  if (parsedEntries.length === 0)
    failA1("CORRUPT_WORKFLOW_RUNTIME", "phase history cannot be empty");
  const value = { schema_version: 1 as const, outer_run_id: safeRunId, entries: parsedEntries };
  withStateFileLock(filePath, () => writeStateJsonAtomic(filePath, value));
}

export function readWorkflowPhaseHistory(
  projectRoot: string,
  outerRunId: string,
): OuterPhaseHistoryEntry[] {
  const safeRunId = assertIdentifier(outerRunId, "outer_run_id");
  const filePath = workflowPhaseHistoryPath(projectRoot, safeRunId);
  if (!fs.existsSync(filePath))
    failA1("PHASE_HISTORY_NOT_FOUND", `no phase history at ${filePath}`);
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_RUNTIME", "phase history must be an object", filePath);
  assertNoUnknownFields(value, ["schema_version", "outer_run_id", "entries"], filePath);
  if (
    value.schema_version !== 1 ||
    value.outer_run_id !== safeRunId ||
    !Array.isArray(value.entries)
  )
    failA1("IDENTITY_MISMATCH", "phase history identity is invalid", filePath);
  return value.entries.map((entry, index) =>
    validatePhaseHistoryEntry(entry, `${filePath}.entries[${index}]`),
  );
}

export function writeWorkflowCycleSummary(projectRoot: string, summary: OuterCycleSummary): void {
  const validated = validateCycleSummary(summary, "cycle-summary");
  writeCycleFile(
    projectRoot,
    validated.outer_run_id,
    validated.outer_iteration,
    "summary.json",
    validated,
  );
}

export function readWorkflowCycleSummary(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): OuterCycleSummary {
  const safeRunId = assertIdentifier(outerRunId, "outer_run_id");
  const filePath = workflowCycleSummaryPath(projectRoot, safeRunId, outerIteration);
  if (!fs.existsSync(filePath))
    failA1("CYCLE_SUMMARY_NOT_FOUND", `no cycle summary at ${filePath}`);
  return validateCycleSummary(readStateFile(filePath), filePath);
}

export function synchronizeWorkflowHistory(projectRoot: string, state: WorkflowRuntimeState): void {
  const validated = validateWorkflowRuntimeState(
    state,
    state.outer_run_id,
    workflowRuntimePath(projectRoot, state.outer_run_id),
  );
  writeWorkflowPhaseHistory(projectRoot, validated.outer_run_id, validated.phase_history);
  for (const summary of validated.cycle_history) writeWorkflowCycleSummary(projectRoot, summary);
}
