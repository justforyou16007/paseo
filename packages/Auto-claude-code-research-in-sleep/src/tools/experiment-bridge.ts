import fs from "node:fs";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  createRunCharter,
  validateRunCharter,
  type RunCharter,
  type RunCharterInput,
} from "./run-charter.js";
import { runOwnedPath } from "./run-contract.js";
import { initializeRunBudget } from "./run-budget.js";
import {
  createBudgetLedger,
  optionalBudget,
  normalizeBudget,
  normalizeBudgetForUnit,
  allocationId,
  splitChildBudget,
  refundChildBudget,
  validateBudgetLedger,
  withRunBudget,
  type BridgeBudget,
  type BudgetLedger,
} from "./run-budget.js";
export {
  createBudgetLedger,
  splitChildBudget,
  refundChildBudget,
  settleChildBudget,
  refundBudget,
  splitBudget,
  type BridgeBudget,
  type BudgetLedger,
  type BudgetAllocation,
} from "./run-budget.js";
import crypto from "node:crypto";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertAblationPlanConstructible,
  assertAblationPlanFrozen,
  buildAblationPlan,
  type AblationCell,
} from "./workflow-compiler.js";
import {
  assertOptimizableScopeSubset,
  validateBaselineScope,
  type BaselineScope,
  type OptimizablePosition,
  type ScopeMode,
} from "./baseline-scope.js";
import {
  classifyResourceRequest,
  validateResourceInventory,
  type ResourceClassification,
  type ResourceInventory,
  type ResourceRequest,
  type ResourceRuntimeAvailability,
} from "./resource-inventory.js";
import { validateRootCharter, type RootCharter } from "./root-charter.js";
import {
  assertRunReferenceCompatible,
  createBridgeChildRun,
  normalizeScopePath as normalizeRunScopePath,
  readRun,
  requireRunContract,
  type RunRecord,
} from "./run-contract.js";
import { resultStatusPolicy, type ResultPackage, type ResultStatus } from "./result-package.js";
import {
  assertIdentifier,
  assertRunId,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireBoolean,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

import type { WorkflowSpec } from "./workflow-spec.js";

function requireExperimentPlan(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0)
    failA1("INVALID_EXPANSION", "a dispatched task requires its experiment plan content");
  return value;
}

export type ExpansionStrategy = "bfs" | "dfs";

export interface ExpansionEvidence {
  completed_round: boolean;
  bottleneck: boolean;
  relative_improvement?: number;
  validation_threshold?: number;
  internal_structure_failure?: boolean;
  failure_evidence?: boolean;
  acceptance: "independent" | "bundled";
}

export interface BridgePositionInput {
  position_id: string;
  execution_plan?: Record<string, unknown>;
  charter?: Omit<RunCharterInput, "run_id" | "charter_id" | "budget">;
  mode?: ScopeMode;

  child_positions?: readonly string[];
  evidence?: ExpansionEvidence;
  resource_request?: ResourceRequest | unknown;
  candidate_id?: string | null;
  result_status?: ResultStatus;
  cost_actual?: BridgeBudget | number;
  input_snapshot_sha256?: string;
  baseline_artifact_ref?: string;
  baseline_artifact_sha256?: string;
  has_usable_frozen_artifact?: boolean;
  output_artifact_ref?: string | null;
  output_artifact_sha256?: string | null;
  /** A graph child is judged against its own charter output, never the parent's full workflow. */

  /** An already materialized child can be associated without changing its id. */
  child_run_id?: string;
  budget?: BridgeBudget | number;
}

export interface BridgeStatusRoute {
  status: ResultStatus;
  failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED" | "INFRA_UNAVAILABLE" | null;
  enters_validation: boolean;
  counts_for_stop_gate: boolean;
  consumes_tester_exposure: boolean;
}

export interface BridgePositionResult {
  position_id: string;
  status: ResultStatus;
  candidate_id: string | null;
  resource_classifications: ResourceClassification[];
  route: BridgeStatusRoute;
  cost_actual: BridgeBudget;
  input_snapshot_sha256: string | null;
  input_snapshot_source: "candidate" | "original_artifact" | null;
  failure_code: string | null;
}

export interface ChildRunPlan {
  charter: RunCharter;
  position_id: string;
  run_id: string;
  parent_run_id: string;
  depth: number;
  scope_path: string;

  budget: BridgeBudget;
  charter_sha256: string;
  baseline_sha256: string;
  resource_inventory_sha256: string;
  input_snapshot_sha256: string;
  execution_plan: Record<string, unknown>;
  execution_plan_sha256: string;
  child_identity_sha256: string;
  code_baseline_sha256: string;
  policy_revision: string;
  expected_output: unknown;

  result: BridgePositionResult;
}

export interface BridgeExpansionPlan {
  schema_version: 1;
  parent_run_id: string;
  parent_depth: number;
  strategy: ExpansionStrategy;
  children: ChildRunPlan[];
  budget: BudgetLedger;
  matrix: DynamicAblationPlan | null;
  downstream: DownstreamRoute[];
  plan_sha256: string;
}

export interface DynamicAblationPlan {
  schema_version: 1;
  width: 0 | 1 | 2;
  candidate_position_ids: string[];
  cells: AblationCell[];
  frozen: true;
  plan_sha256: string;
}

export interface DownstreamRoute {
  position_id: string;
  status: "continue" | "not_executable";
  input_snapshot_sha256: string | null;
  input_snapshot_source: "original_artifact" | null;
  failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED" | null;
  reason: string;
}

export interface WaveDecision {
  schema_version: 1;
  siblings_to_continue: string[];
  results: BridgePositionResult[];
  validation_candidate_ids: string[];
  tester_candidate_ids: string[];
  matrix: DynamicAblationPlan | null;
  downstream: DownstreamRoute[];
  no_progress_matrix: boolean;
  decision_sha256: string;
}

export interface ExperimentBridgeInput {
  run: Pick<RunRecord, "run_id" | "depth" | "scope_path">;
  charter: unknown;
  baseline: unknown;
  resource_inventory: unknown;
  positions: readonly BridgePositionInput[];
  strategy?: ExpansionStrategy;
  strategy_reason: string;
  resource_availability?: ResourceRuntimeAvailability;
  workflow_spec?: WorkflowSpec;
  frozen_matrix?: DynamicAblationPlan;
  constructible_cell_ids?: readonly string[];
  project_root?: string;
  materialize_children?: boolean;
  stop_decision?: { decision: "continue" | "stop"; reason: string };
}

export interface ClassifiedBridgeResultInput {
  resource_classifications?: readonly ResourceClassification[];
  resource_status?: ResourceClassification["status"];
  execution_outcome?: "not_started" | "succeeded" | "failed";
  result_package?: Pick<ResultPackage, "status"> | null;
}

export function assertWaveCreationAllowed(
  value: { decision: "continue" | "stop"; reason: string } | undefined,
): void {
  if (value === undefined) return;
  if (!isRecord(value))
    failA1("INVALID_STOP_DECISION", "stop decision must be an object", "stop_decision");
  assertNoUnknownFields(value, ["decision", "reason"], "stop_decision");
  if (value.decision !== "continue" && value.decision !== "stop")
    failA1("INVALID_STOP_DECISION", "stop decision is invalid", "stop_decision.decision");
  const reason = requireString(value.reason, "stop_decision.reason");
  if (value.decision === "stop")
    failA1("STOP_GATE_CLOSED", `stop gate closed the next wave (${reason})`, "stop_decision");
}

export const assertNextWaveAllowed = assertWaveCreationAllowed;

function normalizeEvidence(value: unknown, location: string): ExpansionEvidence | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "expansion evidence must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "completed_round",
      "bottleneck",
      "relative_improvement",
      "validation_threshold",
      "internal_structure_failure",
      "failure_evidence",
      "acceptance",
    ],
    location,
  );
  if (value.acceptance !== "independent" && value.acceptance !== "bundled")
    failA1(
      "INVALID_EXPANSION",
      "expansion evidence acceptance is invalid",
      `${location}.acceptance`,
    );
  return {
    completed_round:
      value.completed_round === undefined
        ? false
        : requireBoolean(value.completed_round, `${location}.completed_round`),
    bottleneck:
      value.bottleneck === undefined
        ? false
        : requireBoolean(value.bottleneck, `${location}.bottleneck`),
    relative_improvement:
      value.relative_improvement === undefined
        ? undefined
        : requireFiniteNumber(value.relative_improvement, `${location}.relative_improvement`),
    validation_threshold:
      value.validation_threshold === undefined
        ? undefined
        : requireFiniteNumber(value.validation_threshold, `${location}.validation_threshold`),
    internal_structure_failure:
      value.internal_structure_failure === undefined
        ? false
        : requireBoolean(
            value.internal_structure_failure,
            `${location}.internal_structure_failure`,
          ),
    failure_evidence:
      value.failure_evidence === undefined
        ? false
        : requireBoolean(value.failure_evidence, `${location}.failure_evidence`),
    acceptance: value.acceptance,
  };
}

function normalizePosition(value: BridgePositionInput, index: number): BridgePositionInput {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "bridge position must be an object", `positions[${index}]`);
  assertNoUnknownFields(
    value,
    [
      "position_id",
      "execution_plan",
      "charter",
      "mode",

      "child_positions",
      "evidence",
      "resource_request",
      "candidate_id",
      "result_status",
      "cost_actual",
      "input_snapshot_sha256",
      "baseline_artifact_ref",
      "baseline_artifact_sha256",
      "has_usable_frozen_artifact",
      "output_artifact_ref",
      "output_artifact_sha256",

      "child_run_id",
      "budget",
    ],
    `positions[${index}]`,
  );
  const positionId = assertIdentifier(value.position_id, `positions[${index}].position_id`);
  if (value.mode !== undefined && value.mode !== "independent" && value.mode !== "bundled")
    failA1("INVALID_EXPANSION", "position mode is invalid", `positions[${index}].mode`);
  if (value.child_positions !== undefined && !Array.isArray(value.child_positions))
    failA1(
      "INVALID_EXPANSION",
      "child_positions must be an array",
      `positions[${index}].child_positions`,
    );
  const childPositions = value.child_positions?.map((child, childIndex) =>
    assertIdentifier(child, `positions[${index}].child_positions[${childIndex}]`),
  );
  if (childPositions !== undefined && new Set(childPositions).size !== childPositions.length)
    failA1("DUPLICATE_ID", "child positions must be unique", `positions[${index}].child_positions`);
  const resultStatus =
    value.result_status === undefined
      ? undefined
      : validateResultStatus(value.result_status, `positions[${index}].result_status`);
  const candidateId =
    value.candidate_id === undefined || value.candidate_id === null
      ? value.candidate_id
      : assertIdentifier(value.candidate_id, `positions[${index}].candidate_id`);
  const inputSnapshot =
    value.input_snapshot_sha256 === undefined
      ? undefined
      : assertSha256(value.input_snapshot_sha256, `positions[${index}].input_snapshot_sha256`);
  const baselineArtifactSha256 =
    value.baseline_artifact_sha256 === undefined
      ? undefined
      : assertSha256(
          value.baseline_artifact_sha256,
          `positions[${index}].baseline_artifact_sha256`,
        );
  const outputArtifactSha256 =
    value.output_artifact_sha256 === undefined || value.output_artifact_sha256 === null
      ? value.output_artifact_sha256
      : assertSha256(value.output_artifact_sha256, `positions[${index}].output_artifact_sha256`);
  const hasUsableFrozenArtifact =
    value.has_usable_frozen_artifact === undefined
      ? undefined
      : requireBoolean(
          value.has_usable_frozen_artifact,
          `positions[${index}].has_usable_frozen_artifact`,
        );
  const baselineArtifactRef =
    value.baseline_artifact_ref === undefined
      ? undefined
      : requireString(value.baseline_artifact_ref, `positions[${index}].baseline_artifact_ref`);
  const outputArtifactRef =
    value.output_artifact_ref === undefined || value.output_artifact_ref === null
      ? value.output_artifact_ref
      : requireString(value.output_artifact_ref, `positions[${index}].output_artifact_ref`);
  return {
    ...value,
    position_id: positionId,
    ...(childPositions === undefined ? {} : { child_positions: childPositions }),
    ...(value.evidence === undefined
      ? {}
      : { evidence: normalizeEvidence(value.evidence, `positions[${index}].evidence`)! }),
    ...(resultStatus === undefined ? {} : { result_status: resultStatus }),
    ...(candidateId === undefined ? {} : { candidate_id: candidateId }),
    ...(inputSnapshot === undefined ? {} : { input_snapshot_sha256: inputSnapshot }),
    ...(baselineArtifactSha256 === undefined
      ? {}
      : { baseline_artifact_sha256: baselineArtifactSha256 }),
    ...(outputArtifactSha256 === undefined ? {} : { output_artifact_sha256: outputArtifactSha256 }),
    ...(hasUsableFrozenArtifact === undefined
      ? {}
      : { has_usable_frozen_artifact: hasUsableFrozenArtifact }),
    ...(baselineArtifactRef === undefined ? {} : { baseline_artifact_ref: baselineArtifactRef }),
    ...(outputArtifactRef === undefined ? {} : { output_artifact_ref: outputArtifactRef }),
  };
}

function validateResultStatus(value: unknown, location: string): ResultStatus {
  if (
    value !== "succeeded" &&
    value !== "failed" &&
    value !== "not_executable" &&
    value !== "infra_unavailable"
  )
    failA1("INVALID_RESULT_PACKAGE", "result package status is invalid", location);
  return value;
}

export function checkExpansionScope(
  charterValue: unknown,
  positionValue: BridgePositionInput,
): ScopeMode {
  const charter = validateRunCharter(charterValue);
  const position = normalizePosition(positionValue, 0);
  const scope = charter.optimizable_scope.find(
    (entry) => entry.position_id === position.position_id,
  );
  if (scope === undefined || (position.mode !== undefined && position.mode !== scope.mode))
    failA1(
      "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED",
      "position must remain within the charter scope and retain its mode",
    );
  return scope.mode;
}

function validateBridgeInputs(input: ExperimentBridgeInput): {
  charter: RunCharter;
  baseline: BaselineScope;
  resource: ResourceInventory;
  positions: BridgePositionInput[];
} {
  if (!isRecord(input)) failA1("INVALID_EXPANSION", "bridge input must be an object", "bridge");
  assertNoUnknownFields(
    input,
    [
      "run",
      "charter",
      "baseline",
      "resource_inventory",
      "positions",
      "strategy",
      "strategy_reason",
      "resource_availability",
      "workflow_spec",
      "frozen_matrix",
      "project_root",
      "materialize_children",
      "stop_decision",
    ],
    "bridge",
  );
  const baseline = validateBaselineScope(input.baseline);
  const resource = validateResourceInventory(input.resource_inventory);
  const rawCharter = validateRunCharter(input.charter);
  if (input.run === undefined || input.run.run_id !== rawCharter.run_id)
    failA1("IDENTITY_MISMATCH", "bridge needs the scheduler run reference matching its charter");
  requireInteger(input.run.depth, "run.depth", 0);
  normalizeRunScopePath(input.run.scope_path);
  const charter = {
    ...rawCharter,
    code_baseline_sha256: baseline.code_baseline.sha256,
  };
  if (charter.baseline_sha256 !== baseline.baseline_sha256)
    failA1(
      "IDENTITY_MISMATCH",
      "bridge charter does not reference this baseline",
      "charter.baseline_sha256",
    );
  if (charter.resource_inventory_sha256 !== resource.inventory_sha256)
    failA1(
      "IDENTITY_MISMATCH",
      "bridge charter does not reference this resource inventory",
      "charter.resource_inventory_sha256",
    );
  assertOptimizableScopeSubset(baseline, charter.optimizable_scope);
  if (!Array.isArray(input.positions))
    failA1("INVALID_EXPANSION", "bridge positions must be an array", "positions");
  const positions = input.positions.map((position, index) => normalizePosition(position, index));
  const seen = new Set<string>();
  for (const position of positions) {
    if (seen.has(position.position_id))
      failA1("DUPLICATE_ID", `position '${position.position_id}' is repeated`, "positions");
    seen.add(position.position_id);
    if (!charter.optimizable_scope.some((entry) => entry.position_id === position.position_id))
      failA1(
        "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED",
        `position '${position.position_id}' is outside the charter optimizable scope`,
      );
  }
  return { charter, baseline, resource, positions };
}

function positionResourceClassifications(
  position: BridgePositionInput,
  resource: ResourceInventory,
  availability?: ResourceRuntimeAvailability,
): ResourceClassification[] {
  if (position.resource_request === undefined)
    return [
      {
        status: "not_executable",
        platform_id: "unset",
        reason: "bridge position has no explicit resource request",
        failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED",
      },
    ];
  return [classifyResourceRequest(resource, position.resource_request, availability)];
}

function assertResourceClassificationStatus(value: unknown, location: string): void {
  if (value !== "succeeded" && value !== "not_executable" && value !== "infra_unavailable")
    failA1("INVALID_RESOURCE_REQUEST", "resource classification status is invalid", location);
}

function zeroCost(unit: string): BridgeBudget {
  return { amount: 0, unit };
}

function actualCost(value: BridgePositionInput["cost_actual"], unit: string): BridgeBudget {
  if (value === undefined) return zeroCost(unit);
  const cost = normalizeBudgetForUnit(value, unit, "position.cost_actual");
  if (cost.unit !== unit)
    failA1(
      "COMPUTE_UNIT_MISMATCH",
      "child cost uses a different budget unit",
      "position.cost_actual",
    );
  return cost;
}

/** Apply the four-state priority without reinterpreting a result package. */
export function classifyBridgeResult(input: ClassifiedBridgeResultInput): BridgeStatusRoute {
  if (
    input.resource_status !== undefined &&
    input.resource_status !== "succeeded" &&
    input.resource_status !== "not_executable" &&
    input.resource_status !== "infra_unavailable"
  )
    failA1(
      "INVALID_RESOURCE_REQUEST",
      "resource classification status is invalid",
      "resource_status",
    );
  if (
    input.resource_classifications !== undefined &&
    !Array.isArray(input.resource_classifications)
  )
    failA1(
      "INVALID_RESOURCE_REQUEST",
      "resource classifications must be an array",
      "resource_classifications",
    );
  for (const [index, classification] of (input.resource_classifications ?? []).entries()) {
    if (!isRecord(classification))
      failA1(
        "INVALID_RESOURCE_REQUEST",
        "resource classification must be an object",
        `resource_classifications[${index}]`,
      );
    assertResourceClassificationStatus(
      classification.status,
      `resource_classifications[${index}].status`,
    );
  }
  if (
    input.execution_outcome !== undefined &&
    input.execution_outcome !== "not_started" &&
    input.execution_outcome !== "succeeded" &&
    input.execution_outcome !== "failed"
  )
    failA1("INVALID_RESULT_PACKAGE", "execution outcome is invalid", "execution_outcome");
  const classifications = [...(input.resource_classifications ?? [])];
  // classifyResourceRequest emits one status: scope checks return
  // not_executable before runtime probing can return infra_unavailable. Keep
  // this precedence for defensive or legacy envelopes that combine fields;
  // current production callers cannot produce that combined input.
  if (
    input.resource_status === "not_executable" ||
    classifications.some((item) => item.status === "not_executable")
  ) {
    return {
      status: "not_executable",
      failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED",
      ...resultStatusPolicy("not_executable"),
    };
  }
  if (
    input.resource_status === "infra_unavailable" ||
    classifications.some((item) => item.status === "infra_unavailable")
  ) {
    return {
      status: "infra_unavailable",
      failure_code: "INFRA_UNAVAILABLE",
      ...resultStatusPolicy("infra_unavailable"),
    };
  }
  if (input.result_package !== undefined && input.result_package !== null) {
    const status = validateResultStatus(input.result_package.status, "result_package.status");
    return {
      status,
      failure_code:
        status === "not_executable"
          ? "RESOURCE_SCOPE_ALIGNMENT_REQUIRED"
          : status === "infra_unavailable"
            ? "INFRA_UNAVAILABLE"
            : null,
      ...resultStatusPolicy(status),
    };
  }
  if (input.execution_outcome === undefined || input.execution_outcome === "not_started")
    failA1("EXECUTION_RESULT_REQUIRED", "resource checks passed but execution has no result");
  const status: ResultStatus = input.execution_outcome === "failed" ? "failed" : "succeeded";
  return { status, failure_code: null, ...resultStatusPolicy(status) };
}

export const routeResultStatus = classifyBridgeResult;
export const classifyExecutionResult = classifyBridgeResult;

function resultForPosition(
  position: BridgePositionInput,
  resource: ResourceInventory,
  availability?: ResourceRuntimeAvailability,
  budgetUnit = "budget_units",
): BridgePositionResult {
  const resourceClassifications = positionResourceClassifications(position, resource, availability);
  const route = classifyBridgeResult({
    resource_classifications: resourceClassifications,
    ...(position.result_status === undefined
      ? { execution_outcome: "succeeded" as const }
      : { result_package: { status: position.result_status } }),
  });
  const status = route.status;
  const candidateId =
    resultStatusPolicy(status).enters_validation && position.candidate_id !== undefined
      ? (position.candidate_id ?? null)
      : null;
  const inputSnapshot = position.input_snapshot_sha256 ?? null;
  return {
    position_id: position.position_id,
    status,
    candidate_id: candidateId,
    resource_classifications: resourceClassifications,
    route,
    cost_actual: actualCost(position.cost_actual, budgetUnit),
    input_snapshot_sha256: inputSnapshot,
    input_snapshot_source: inputSnapshot === null ? null : "candidate",
    failure_code: route.failure_code,
  };
}

function positionBudget(
  position: BridgePositionInput,
  availableBudget: BridgeBudget,
  remainingPositions: number,
): BridgeBudget {
  if (position.budget !== undefined) {
    const requested = normalizeBudgetForUnit(
      position.budget,
      availableBudget.unit,
      `position '${position.position_id}'.budget`,
    );
    if (requested.unit !== availableBudget.unit)
      failA1("COMPUTE_UNIT_MISMATCH", "child budget uses a different unit", "position.budget");
    return requested;
  }
  return {
    amount: availableBudget.amount / remainingPositions,
    unit: availableBudget.unit,
  };
}

type ChildIdentityFields = Pick<
  ChildRunPlan,
  | "position_id"
  | "run_id"
  | "parent_run_id"
  | "depth"
  | "scope_path"
  | "budget"
  | "charter_sha256"
  | "baseline_sha256"
  | "resource_inventory_sha256"
  | "input_snapshot_sha256"
  | "code_baseline_sha256"
  | "policy_revision"
>;

/**
 * Hash the child identity that the bridge plan carries into run.json.
 *
 * The outer plan hash covers this material through the child object, but it is
 * intentionally not part of this material: putting plan_sha256 here would
 * make the plan hash depend on itself. This hash detects changes to a plan's
 * child identity; SHA-256 does not authenticate that planExperimentBridge was
 * the code that constructed it.
 */
export function computeBridgeChildIdentityHash(
  child: ChildIdentityFields,
  strategy: ExpansionStrategy,
): string {
  return canonicalJsonSha256(
    {
      parent_run_id: child.parent_run_id,
      child_run_id: child.run_id,
      position_id: child.position_id,
      depth: child.depth,
      scope_path: child.scope_path,

      budget: child.budget,
      charter_sha256: child.charter_sha256,
      baseline_sha256: child.baseline_sha256,
      resource_inventory_sha256: child.resource_inventory_sha256,
      input_snapshot_sha256: child.input_snapshot_sha256,
      code_baseline_sha256: child.code_baseline_sha256,
      policy_revision: child.policy_revision,
      strategy,
    },
    undefined,
    { schemaVersion: "bridge-child-identity-v2" },
  );
}

function childRunId(position: BridgePositionInput): string {
  if (position.child_run_id !== undefined) {
    const runId = assertRunId(position.child_run_id, "child_run_id");
    if (runId.length > 121)
      failA1(
        "INVALID_RUN_ID",
        "explicit child run id must be at most 121 characters to leave room for budget:",
        "child_run_id",
      );
    return runId;
  }
  return `run-${crypto.randomUUID()}`;
}

function normalizeScopePath(parent: string, child: string): string {
  const normalizedParent = parent.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return normalizedParent === "/" ? `/${child}` : `${normalizedParent}/${child}`;
}

function dynamicPlan(
  workflowSpec: WorkflowSpec,
  candidatePositionIds: readonly string[],
): DynamicAblationPlan {
  const normalized = candidatePositionIds.map((id) =>
    assertIdentifier(id, "candidate_position_id"),
  );
  if (new Set(normalized).size !== normalized.length)
    failA1("DUPLICATE_ID", "ablation candidate positions must be unique");
  const ordered = [...normalized].sort(compareIdentityStrings);
  if (ordered.length > 2)
    failA1("INVALID_WAVE_POLICY", "the first ablation matrix supports at most two candidates");
  const cells = buildAblationPlan(workflowSpec, ordered);
  const base = {
    schema_version: 1 as const,
    width: ordered.length as 0 | 1 | 2,
    candidate_position_ids: ordered,
    cells,
    frozen: true as const,
  };
  return {
    ...base,
    plan_sha256: canonicalJsonSha256(base, undefined, {
      schemaVersion: "dynamic-ablation-plan-v1",
    }),
  };
}

export function buildDynamicAblationPlan(
  workflowSpec: WorkflowSpec,
  candidates:
    | readonly string[]
    | readonly Pick<BridgePositionResult, "position_id" | "status" | "candidate_id">[],
): DynamicAblationPlan | null {
  const candidatePositionIds = candidates
    .map((candidate, index) => {
      if (typeof candidate === "string") return assertIdentifier(candidate, `candidates[${index}]`);
      if (!isRecord(candidate))
        failA1(
          "INVALID_WAVE_POLICY",
          "ablation candidate must be an object",
          `candidates[${index}]`,
        );
      const status = validateResultStatus(candidate.status, `candidates[${index}].status`);
      return resultStatusPolicy(status).enters_validation && candidate.candidate_id !== null
        ? assertIdentifier(candidate.position_id, `candidates[${index}].position_id`)
        : null;
    })
    .filter((value): value is string => value !== null);
  if (candidatePositionIds.length === 0) return null;
  return dynamicPlan(workflowSpec, candidatePositionIds);
}

export const freezeAblationPlan = buildDynamicAblationPlan;

function validateDynamicAblationPlan(value: unknown, location: string): DynamicAblationPlan {
  if (!isRecord(value))
    failA1("CORRUPT_ABLATION_PLAN", "ablation plan must be an object", location);
  assertNoUnknownFields(
    value,
    ["schema_version", "width", "candidate_position_ids", "cells", "frozen", "plan_sha256"],
    location,
  );
  if (value.schema_version !== 1 || value.frozen !== true)
    failA1("CORRUPT_ABLATION_PLAN", "ablation plan schema or frozen marker is invalid", location);
  if (value.width !== 0 && value.width !== 1 && value.width !== 2)
    failA1("CORRUPT_ABLATION_PLAN", "ablation plan width is invalid", `${location}.width`);
  if (value.width === 0)
    failA1(
      "CORRUPT_ABLATION_PLAN",
      "an empty wave must not freeze an ablation plan",
      `${location}.width`,
    );
  if (!Array.isArray(value.candidate_position_ids))
    failA1("CORRUPT_ABLATION_PLAN", "candidate_position_ids must be an array", location);
  const candidatePositionIds = value.candidate_position_ids.map((item, index) =>
    assertIdentifier(item, `${location}.candidate_position_ids[${index}]`),
  );
  if (candidatePositionIds.length !== value.width)
    failA1("CORRUPT_ABLATION_PLAN", "ablation width does not match candidate positions", location);
  if (new Set(candidatePositionIds).size !== candidatePositionIds.length)
    failA1(
      "DUPLICATE_ID",
      "candidate positions must be unique",
      `${location}.candidate_position_ids`,
    );
  if (!Array.isArray(value.cells))
    failA1("CORRUPT_ABLATION_PLAN", "ablation cells must be an array", `${location}.cells`);
  const cells = value.cells.map((cell, index) => {
    const cellLocation = `${location}.cells[${index}]`;
    if (!isRecord(cell))
      failA1("CORRUPT_ABLATION_PLAN", "ablation cell must be an object", cellLocation);
    assertNoUnknownFields(cell, ["cell_id", "module_ids"], cellLocation);
    if (
      cell.cell_id !== "00" &&
      cell.cell_id !== "10" &&
      cell.cell_id !== "01" &&
      cell.cell_id !== "11"
    )
      failA1(
        "CORRUPT_ABLATION_PLAN",
        "dynamic ablation cell id is invalid",
        `${cellLocation}.cell_id`,
      );
    if (!Array.isArray(cell.module_ids))
      failA1("CORRUPT_ABLATION_PLAN", "ablation module_ids must be an array", cellLocation);
    const moduleIds = cell.module_ids.map((moduleId, moduleIndex) =>
      assertIdentifier(moduleId, `${cellLocation}.module_ids[${moduleIndex}]`),
    );
    if (new Set(moduleIds).size !== moduleIds.length)
      failA1("DUPLICATE_ID", "ablation module ids must be unique", cellLocation);
    return { cell_id: cell.cell_id, module_ids: moduleIds } as AblationCell;
  });
  const expectedCellCount = value.width === 1 ? 2 : 4;
  if (cells.length !== expectedCellCount)
    failA1(
      "CORRUPT_ABLATION_PLAN",
      "ablation cells do not match the frozen width",
      `${location}.cells`,
    );
  if (new Set(cells.map((cell) => cell.cell_id)).size !== cells.length)
    failA1("DUPLICATE_ID", "ablation cell ids must be unique", `${location}.cells`);
  const base = {
    schema_version: 1 as const,
    width: value.width as 0 | 1 | 2,
    candidate_position_ids: [...candidatePositionIds].sort(compareIdentityStrings),
    cells,
    frozen: true as const,
  };
  const planSha256 = assertSha256(value.plan_sha256, `${location}.plan_sha256`);
  if (
    planSha256 !==
    canonicalJsonSha256(base, undefined, { schemaVersion: "dynamic-ablation-plan-v1" })
  )
    failA1("CORRUPT_ABLATION_PLAN", "ablation plan hash does not match its fields", location);
  return { ...base, plan_sha256: planSha256 };
}

export function validateFrozenDynamicAblationPlan(
  frozen: DynamicAblationPlan,
  requested: DynamicAblationPlan,
  constructibleCellIds?: readonly string[],
): void {
  const frozenPlan = validateDynamicAblationPlan(frozen, "frozen_matrix");
  const requestedPlan = validateDynamicAblationPlan(requested, "requested_matrix");
  if (frozenPlan.plan_sha256 !== requestedPlan.plan_sha256)
    failA1("ABLATION_WIDTH_FROZEN", "frozen ablation width or candidate positions changed");
  assertAblationPlanFrozen(frozenPlan.cells, requestedPlan.cells);
  if (constructibleCellIds !== undefined)
    assertAblationPlanConstructible(frozenPlan.cells, constructibleCellIds);
}

export function routeDownstreamInput(input: {
  position_id: string;
  status: ResultStatus;
  frozen_input_snapshot_sha256?: string;
  has_usable_frozen_artifact: boolean;
}): DownstreamRoute {
  const positionId = assertIdentifier(input.position_id, "position_id");
  if (input.status === "succeeded" || input.has_usable_frozen_artifact) {
    if (input.has_usable_frozen_artifact && input.frozen_input_snapshot_sha256 === undefined)
      failA1(
        "INPUT_SNAPSHOT_REQUIRED",
        "a reusable original artifact needs its input snapshot",
        positionId,
      );
    if (input.status !== "succeeded")
      return {
        position_id: positionId,
        status: "continue",
        input_snapshot_sha256: input.frozen_input_snapshot_sha256 ?? null,
        input_snapshot_source: "original_artifact",
        failure_code: null,
        reason: "the candidate failed, so downstream keeps the frozen original artifact",
      };
    return {
      position_id: positionId,
      status: "continue",
      input_snapshot_sha256: input.frozen_input_snapshot_sha256 ?? null,
      input_snapshot_source: input.has_usable_frozen_artifact ? "original_artifact" : null,
      failure_code: null,
      reason: "the position produced a usable result",
    };
  }
  return {
    position_id: positionId,
    status: "not_executable",
    input_snapshot_sha256: null,
    input_snapshot_source: null,
    failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED",
    reason: "downstream has no usable frozen artifact to consume",
  };
}

function planSha256(value: Omit<BridgeExpansionPlan, "plan_sha256">): string {
  return canonicalJsonSha256(value, undefined, { schemaVersion: "bridge-expansion-plan-v1" });
}

const BRIDGE_PLAN_FIELDS = [
  "schema_version",
  "parent_run_id",
  "parent_depth",
  "strategy",
  "children",
  "budget",
  "matrix",
  "downstream",
  "plan_sha256",
] as const;

const CHILD_PLAN_FIELDS = [
  "charter",
  "position_id",
  "run_id",
  "parent_run_id",
  "depth",
  "scope_path",

  "budget",
  "charter_sha256",
  "baseline_sha256",
  "resource_inventory_sha256",
  "input_snapshot_sha256",
  "execution_plan",
  "execution_plan_sha256",
  "child_identity_sha256",
  "code_baseline_sha256",
  "policy_revision",
  "expected_output",

  "result",
] as const;

function requirePlanFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  location: string,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(value, field))
      failA1("INVALID_EXPANSION", `missing required field '${field}'`, `${location}.${field}`);
  }
}

function validatePlanBudget(value: unknown, location: string): BridgeBudget {
  if (!isRecord(value)) failA1("INVALID_EXPANSION", "plan budget must be an object", location);
  assertNoUnknownFields(value, ["amount", "unit"], location);
  requirePlanFields(value, ["amount", "unit"], location);
  const amount = requireFiniteNumber(value.amount, `${location}.amount`);
  if (amount < 0) failA1("INVALID_EXPANSION", "budget amount must be non-negative", location);
  return { amount, unit: requireString(value.unit, `${location}.unit`) };
}

function validatePlanResourceClassification(
  value: unknown,
  location: string,
): ResourceClassification {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "resource classification must be an object", location);
  assertNoUnknownFields(value, ["status", "platform_id", "reason", "failure_code"], location);
  requirePlanFields(value, ["status", "platform_id", "reason"], location);
  assertResourceClassificationStatus(value.status, `${location}.status`);
  const status = value.status as ResourceClassification["status"];
  const failureCode = value.failure_code;
  if (
    failureCode !== undefined &&
    failureCode !== "RESOURCE_SCOPE_ALIGNMENT_REQUIRED" &&
    failureCode !== "INFRA_UNAVAILABLE"
  )
    failA1("INVALID_EXPANSION", "resource classification failure_code is invalid", location);
  const expectedFailureCode =
    status === "not_executable"
      ? "RESOURCE_SCOPE_ALIGNMENT_REQUIRED"
      : status === "infra_unavailable"
        ? "INFRA_UNAVAILABLE"
        : undefined;
  if (failureCode !== expectedFailureCode)
    failA1("INVALID_EXPANSION", "resource classification does not match its status", location);
  return {
    status,
    platform_id: assertIdentifier(value.platform_id, `${location}.platform_id`),
    reason: requireString(value.reason, `${location}.reason`),
    ...(failureCode === undefined ? {} : { failure_code: failureCode }),
  };
}

function validatePlanStatusRoute(value: unknown, location: string): BridgeStatusRoute {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "bridge status route must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "status",
      "failure_code",
      "enters_validation",
      "counts_for_stop_gate",
      "consumes_tester_exposure",
    ],
    location,
  );
  requirePlanFields(
    value,
    [
      "status",
      "failure_code",
      "enters_validation",
      "counts_for_stop_gate",
      "consumes_tester_exposure",
    ],
    location,
  );
  const status = validateResultStatus(value.status, `${location}.status`);
  const failureCode = value.failure_code;
  const expectedFailureCode =
    status === "not_executable"
      ? "RESOURCE_SCOPE_ALIGNMENT_REQUIRED"
      : status === "infra_unavailable"
        ? "INFRA_UNAVAILABLE"
        : null;
  if (failureCode !== expectedFailureCode)
    failA1("INVALID_EXPANSION", "bridge status route does not match its status", location);
  const policy = resultStatusPolicy(status);
  if (
    value.enters_validation !== policy.enters_validation ||
    value.counts_for_stop_gate !== policy.counts_for_stop_gate ||
    value.consumes_tester_exposure !== policy.consumes_tester_exposure
  )
    failA1(
      "INVALID_EXPANSION",
      "bridge status route does not match the shared status policy",
      location,
    );
  return {
    status,
    failure_code: failureCode as BridgeStatusRoute["failure_code"],
    enters_validation: requireBoolean(value.enters_validation, `${location}.enters_validation`),
    counts_for_stop_gate: requireBoolean(
      value.counts_for_stop_gate,
      `${location}.counts_for_stop_gate`,
    ),
    consumes_tester_exposure: requireBoolean(
      value.consumes_tester_exposure,
      `${location}.consumes_tester_exposure`,
    ),
  };
}

function validatePlanPositionResult(value: unknown, location: string): BridgePositionResult {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "bridge position result must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "position_id",
      "status",
      "candidate_id",
      "resource_classifications",
      "route",
      "cost_actual",
      "input_snapshot_sha256",
      "input_snapshot_source",
      "failure_code",
    ],
    location,
  );
  requirePlanFields(
    value,
    [
      "position_id",
      "status",
      "candidate_id",
      "resource_classifications",
      "route",
      "cost_actual",
      "input_snapshot_sha256",
      "input_snapshot_source",
      "failure_code",
    ],
    location,
  );
  const positionId = assertIdentifier(value.position_id, `${location}.position_id`);
  const status = validateResultStatus(value.status, `${location}.status`);
  const candidateId =
    value.candidate_id === null
      ? null
      : assertIdentifier(value.candidate_id, `${location}.candidate_id`);
  if (!Array.isArray(value.resource_classifications))
    failA1("INVALID_EXPANSION", "resource classifications must be an array", location);
  const resourceClassifications = value.resource_classifications.map((item, index) =>
    validatePlanResourceClassification(item, `${location}.resource_classifications[${index}]`),
  );
  const route = validatePlanStatusRoute(value.route, `${location}.route`);
  if (route.status !== status)
    failA1("INVALID_EXPANSION", "position result and route statuses disagree", location);
  const costActual = validatePlanBudget(value.cost_actual, `${location}.cost_actual`);
  const inputSnapshotSha256 =
    value.input_snapshot_sha256 === null
      ? null
      : assertSha256(value.input_snapshot_sha256, `${location}.input_snapshot_sha256`);
  const inputSnapshotSource = value.input_snapshot_source;
  if (
    inputSnapshotSource !== null &&
    inputSnapshotSource !== "candidate" &&
    inputSnapshotSource !== "original_artifact"
  )
    failA1("INVALID_EXPANSION", "position result input_snapshot_source is invalid", location);
  if (inputSnapshotSha256 === null && inputSnapshotSource !== null)
    failA1("INVALID_EXPANSION", "an absent input snapshot cannot have a source", location);
  if (inputSnapshotSha256 !== null && inputSnapshotSource === null)
    failA1("INVALID_EXPANSION", "an input snapshot needs a source", location);
  const failureCode = value.failure_code;
  if (failureCode !== null && typeof failureCode !== "string")
    failA1("INVALID_EXPANSION", "position result failure_code must be a string or null", location);
  if (failureCode !== route.failure_code)
    failA1("INVALID_EXPANSION", "position result failure_code disagrees with its route", location);
  return {
    position_id: positionId,
    status,
    candidate_id: candidateId,
    resource_classifications: resourceClassifications,
    route,
    cost_actual: costActual,
    input_snapshot_sha256: inputSnapshotSha256,
    input_snapshot_source: inputSnapshotSource,
    failure_code: failureCode,
  };
}

function validateChildRunPlan(
  value: unknown,
  strategy: ExpansionStrategy,
  location: string,
): ChildRunPlan {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "bridge child plan must be an object", location);
  assertNoUnknownFields(value, CHILD_PLAN_FIELDS, location);
  requirePlanFields(value, CHILD_PLAN_FIELDS, location);
  const child = {
    charter: validateRunCharter(value.charter),
    position_id: assertIdentifier(value.position_id, `${location}.position_id`),
    run_id: assertIdentifier(value.run_id, `${location}.run_id`),
    parent_run_id: assertIdentifier(value.parent_run_id, `${location}.parent_run_id`),
    depth: requireInteger(value.depth, `${location}.depth`, 0),
    scope_path: normalizeRunScopePath(value.scope_path, `${location}.scope_path`),

    budget: validatePlanBudget(value.budget, `${location}.budget`),
    charter_sha256: assertSha256(value.charter_sha256, `${location}.charter_sha256`),
    baseline_sha256: assertSha256(value.baseline_sha256, `${location}.baseline_sha256`),
    resource_inventory_sha256: assertSha256(
      value.resource_inventory_sha256,
      `${location}.resource_inventory_sha256`,
    ),
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      `${location}.input_snapshot_sha256`,
    ),
    execution_plan: requireExperimentPlan(value.execution_plan),
    child_identity_sha256: assertSha256(
      value.child_identity_sha256,
      `${location}.child_identity_sha256`,
    ),
    execution_plan_sha256: assertSha256(
      value.execution_plan_sha256,
      `${location}.execution_plan_sha256`,
    ),
    code_baseline_sha256: assertSha256(
      value.code_baseline_sha256,
      `${location}.code_baseline_sha256`,
    ),
    policy_revision: requireString(value.policy_revision, `${location}.policy_revision`),
    expected_output: value.expected_output,

    result: validatePlanPositionResult(value.result, `${location}.result`),
  } as ChildRunPlan;
  if (value.scope_path !== child.scope_path)
    failA1("INVALID_EXPANSION", "child scope_path must be normalized", `${location}.scope_path`);
  if (child.expected_output === undefined || child.expected_output === null)
    failA1("INVALID_EXPANSION", "child expected_output is required", `${location}.expected_output`);
  if (child.result.position_id !== child.position_id)
    failA1("INVALID_EXPANSION", "child result position_id does not match the child", location);
  if (validateRunCharter(child.charter).charter_sha256 !== child.charter_sha256)
    failA1("IDENTITY_MISMATCH", "child charter hash does not match its fields", location);
  if (
    child.charter.run_id !== child.run_id ||
    canonicalJsonSha256(child.charter.budget) !== canonicalJsonSha256(child.budget) ||
    canonicalJsonSha256(child.charter.expected_output) !==
      canonicalJsonSha256(child.expected_output)
  )
    failA1("IDENTITY_MISMATCH", "child charter differs from its dispatch task", location);
  if (canonicalJsonSha256(child.execution_plan) !== child.execution_plan_sha256)
    failA1("IDENTITY_MISMATCH", "execution plan hash does not match its content", location);
  if (computeBridgeChildIdentityHash(child, strategy) !== child.child_identity_sha256)
    failA1("IDENTITY_MISMATCH", "child identity hash does not match its fields", location);
  return child;
}

function validatePlanDownstreamRoute(value: unknown, location: string): DownstreamRoute {
  if (!isRecord(value)) failA1("INVALID_EXPANSION", "downstream route must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "position_id",
      "status",
      "input_snapshot_sha256",
      "input_snapshot_source",
      "failure_code",
      "reason",
    ],
    location,
  );
  requirePlanFields(
    value,
    [
      "position_id",
      "status",
      "input_snapshot_sha256",
      "input_snapshot_source",
      "failure_code",
      "reason",
    ],
    location,
  );
  const status = value.status;
  if (status !== "continue" && status !== "not_executable")
    failA1("INVALID_EXPANSION", "downstream route status is invalid", `${location}.status`);
  const inputSnapshotSha256 =
    value.input_snapshot_sha256 === null
      ? null
      : assertSha256(value.input_snapshot_sha256, `${location}.input_snapshot_sha256`);
  const inputSnapshotSource = value.input_snapshot_source;
  if (inputSnapshotSource !== null && inputSnapshotSource !== "original_artifact")
    failA1("INVALID_EXPANSION", "downstream input_snapshot_source is invalid", location);
  const failureCode = value.failure_code;
  const expectedFailureCode =
    status === "not_executable" ? "RESOURCE_SCOPE_ALIGNMENT_REQUIRED" : null;
  if (failureCode !== expectedFailureCode)
    failA1("INVALID_EXPANSION", "downstream route does not match its status", location);
  if (
    (inputSnapshotSource === "original_artifact" && inputSnapshotSha256 === null) ||
    (inputSnapshotSource === null && inputSnapshotSha256 !== null)
  )
    failA1("INVALID_EXPANSION", "downstream snapshot and source disagree", location);
  return {
    position_id: assertIdentifier(value.position_id, `${location}.position_id`),
    status,
    input_snapshot_sha256: inputSnapshotSha256,
    input_snapshot_source: inputSnapshotSource,
    failure_code: failureCode as DownstreamRoute["failure_code"],
    reason: requireString(value.reason, `${location}.reason`),
  };
}

/**
 * Validate the complete value emitted by planExperimentBridge before any
 * contract or scope write is attempted. This checks shape and child hashes;
 * the ordinary plan hash still proves integrity after planning, not the
 * identity of the code that supplied the value.
 */
export function validateBridgeExpansionPlan(value: unknown): BridgeExpansionPlan {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "bridge expansion plan must be an object", "bridge.plan");
  assertNoUnknownFields(value, BRIDGE_PLAN_FIELDS, "bridge.plan");
  requirePlanFields(value, BRIDGE_PLAN_FIELDS, "bridge.plan");
  if (value.schema_version !== 1)
    failA1("INVALID_EXPANSION", "bridge expansion plan schema_version must be 1", "bridge.plan");
  const parentRunId = assertIdentifier(value.parent_run_id, "bridge.plan.parent_run_id");
  const parentDepth = requireInteger(value.parent_depth, "bridge.plan.parent_depth", 0);
  const strategy = value.strategy;
  if (strategy !== "bfs" && strategy !== "dfs")
    failA1(
      "INVALID_EXPANSION",
      "bridge expansion plan strategy is invalid",
      "bridge.plan.strategy",
    );
  if (!Array.isArray(value.children))
    failA1(
      "INVALID_EXPANSION",
      "bridge expansion plan children must be an array",
      "bridge.plan.children",
    );
  const children = value.children.map((child, index) =>
    validateChildRunPlan(child, strategy, `bridge.plan.children[${index}]`),
  );
  if (new Set(children.map((child) => child.run_id)).size !== children.length)
    failA1("DUPLICATE_ID", "bridge child run ids must be unique", "bridge.plan.children");
  if (new Set(children.map((child) => child.position_id)).size !== children.length)
    failA1("DUPLICATE_ID", "bridge child position ids must be unique", "bridge.plan.children");
  for (const child of children) {
    if (child.parent_run_id !== parentRunId)
      failA1(
        "IDENTITY_MISMATCH",
        "bridge child parent does not match the plan parent",
        "bridge.plan.children",
      );
    if (child.depth !== parentDepth + 1)
      failA1(
        "RUN_DEPTH_MISMATCH",
        "bridge child depth does not follow the plan parent",
        "bridge.plan.children",
      );
  }
  const budget = validateBudgetLedger(value.budget, "bridge.plan.budget");
  for (const child of children) {
    const allocation = budget.allocations.find((entry) => entry.execution_id === child.run_id);
    const consumes =
      child.result.status !== "not_executable" && child.result.status !== "infra_unavailable";
    if (consumes && (allocation === undefined || allocation.amount !== child.budget.amount))
      failA1("INVALID_EXPANSION", "dispatched execution must have a matching budget reservation");
    if (!consumes && allocation !== undefined)
      failA1("INVALID_EXPANSION", "resource-unavailable positions must not reserve budget");
  }
  const matrix =
    value.matrix === null ? null : validateDynamicAblationPlan(value.matrix, "bridge.plan.matrix");
  if (!Array.isArray(value.downstream))
    failA1("INVALID_EXPANSION", "downstream routes must be an array", "bridge.plan.downstream");
  const downstream = value.downstream.map((route, index) =>
    validatePlanDownstreamRoute(route, `bridge.plan.downstream[${index}]`),
  );
  if (new Set(downstream.map((route) => route.position_id)).size !== downstream.length)
    failA1("DUPLICATE_ID", "downstream position ids must be unique", "bridge.plan.downstream");
  const childrenByPosition = new Map(children.map((child) => [child.position_id, child]));
  for (const route of downstream) {
    const child = childrenByPosition.get(route.position_id);
    if (child === undefined || child.result.status === "succeeded")
      failA1(
        "INVALID_EXPANSION",
        "downstream route has no failed or incomplete child",
        "bridge.plan.downstream",
      );
  }
  const storedPlanSha256 = assertSha256(value.plan_sha256, "bridge.plan.plan_sha256");
  const base: Omit<BridgeExpansionPlan, "plan_sha256"> = {
    schema_version: 1,
    parent_run_id: parentRunId,
    parent_depth: parentDepth,
    strategy,
    children,
    budget,
    matrix,
    downstream,
  };
  if (storedPlanSha256 !== planSha256(base))
    failA1(
      "IDENTITY_MISMATCH",
      "bridge expansion plan hash does not match its fields",
      "bridge.plan",
    );
  return {
    ...base,
    plan_sha256: storedPlanSha256,
  };
}

function resolveWaveMatrix(
  workflowSpec: WorkflowSpec,
  candidatePositionIds: readonly string[],
  frozenValue?: DynamicAblationPlan,
  constructibleCellIds?: readonly string[],
): DynamicAblationPlan | null {
  const requestedMatrix = buildDynamicAblationPlan(workflowSpec, candidatePositionIds);
  if (frozenValue === undefined) return requestedMatrix;
  const frozen = validateDynamicAblationPlan(frozenValue, "frozen_matrix");
  const expectedFrozen = buildDynamicAblationPlan(workflowSpec, frozen.candidate_position_ids);
  if (expectedFrozen === null)
    failA1("CORRUPT_ABLATION_PLAN", "a frozen matrix must contain at least one candidate");
  assertAblationPlanFrozen(frozen.cells, expectedFrozen.cells);
  const actualPositionIds = new Set(candidatePositionIds);
  const frozenPositionIds = new Set(frozen.candidate_position_ids);
  if ([...actualPositionIds].some((id) => !frozenPositionIds.has(id)))
    failA1("ABLATION_WIDTH_FROZEN", "a frozen matrix cannot add a candidate position");
  const allFrozenPositionsReturned = [...frozenPositionIds].every((id) =>
    actualPositionIds.has(id),
  );
  if (allFrozenPositionsReturned && requestedMatrix !== null) {
    validateFrozenDynamicAblationPlan(frozen, requestedMatrix);
    if (constructibleCellIds !== undefined)
      assertAblationPlanConstructible(frozen.cells, constructibleCellIds);
  } else {
    const inferredConstructible = [
      "00",
      ...frozen.cells
        .filter(
          (cell) =>
            cell.cell_id !== "00" &&
            actualPositionIds.has(frozen.candidate_position_ids[cell.cell_id === "10" ? 0 : 1]!),
        )
        .map((cell) => cell.cell_id),
    ];
    assertAblationPlanConstructible(frozen.cells, constructibleCellIds ?? inferredConstructible);
  }
  return frozen;
}

/**
 * Store dispatch ownership on the parent. Children receive only their frozen tasks.
 */
interface ChildPositionIndex {
  schema_version: 1;
  positions: Array<{ position_id: string; task_sha256: string; child_run_id: string }>;
}
function indexBridgePositions(input: ExperimentBridgeInput): ExperimentBridgeInput {
  const file = runOwnedPath(input.project_root!, input.run.run_id, "children.json");
  return withStateFileLock(file, () => {
    const index: ChildPositionIndex = fs.existsSync(file)
      ? readStateFile(file)
      : { schema_version: 1, positions: [] };
    const positions = input.positions.map((position) => {
      const taskSha = canonicalJsonSha256({
        position_id: position.position_id,
        execution_plan: position.execution_plan,
        charter: position.charter,
      });
      const prior = index.positions.find(
        (entry) => entry.position_id === position.position_id && entry.task_sha256 === taskSha,
      );
      if (prior !== undefined) {
        if (position.child_run_id !== undefined && position.child_run_id !== prior.child_run_id)
          failA1("IDENTITY_MISMATCH", "position already assigned to another child");
        return { ...position, child_run_id: prior.child_run_id };
      }
      const id = childRunId(position);
      index.positions.push({
        position_id: position.position_id,
        task_sha256: taskSha,
        child_run_id: id,
      });
      return { ...position, child_run_id: id };
    });
    writeStateJsonAtomic(file, index);
    return { ...input, positions };
  });
}
export function planExperimentBridge(input: ExperimentBridgeInput): BridgeExpansionPlan {
  const charter = validateRunCharter(input.charter);
  if (input.project_root !== undefined)
    return withRunBudget(
      input.project_root,
      charter.run_id,
      charter.budget ?? undefined,
      (ledger) => {
        const indexed = indexBridgePositions(input);
        const plan = planWithBudget(indexed, ledger);
        return { ledger: plan.budget, result: plan };
      },
    );
  return planWithBudget(
    input,
    createBudgetLedger(charter.budget ?? { amount: 0, unit: "budget_units" }),
  );
}
function planWithBudget(
  input: ExperimentBridgeInput,
  initialLedger: BudgetLedger,
): BridgeExpansionPlan {
  const validated = validateBridgeInputs(input);
  assertWaveCreationAllowed(input.stop_decision);
  requireString(input.strategy_reason, "strategy_reason");
  const strategy = input.strategy ?? "bfs";
  if (strategy !== "bfs" && strategy !== "dfs")
    failA1("INVALID_EXPANSION", "bridge strategy must be bfs or dfs", "strategy");
  const parentBudget = validated.charter.budget;
  if (validated.positions.length > 0 && parentBudget === null)
    failA1(
      "BUDGET_REQUIRED",
      "a graph bridge needs a parent budget before creating children",
      "charter.budget",
    );
  const orderedPositions = [...validated.positions].sort((left, right) =>
    compareIdentityStrings(left.position_id, right.position_id),
  );
  const parentBudgetValue = parentBudget ?? zeroCost("budget_units");
  let ledger = initialLedger;
  const classified = new Map(
    orderedPositions.map((position) => [
      position.position_id,
      resultForPosition(
        position,
        validated.resource,
        input.resource_availability,
        parentBudgetValue.unit,
      ),
    ]),
  );
  let remaining = [...classified.values()].filter(
    (result) => result.status !== "not_executable" && result.status !== "infra_unavailable",
  ).length;
  const children: ChildRunPlan[] = [];
  for (const [index, position] of orderedPositions.entries()) {
    // Scope, resource classification, identity construction, and
    // budget checks all happen before the first child creation call
    // (materialize is a separate operation below).
    checkExpansionScope(input.charter, position);
    const result = classified.get(position.position_id)!;
    const runId = childRunId(position);
    const consumes = result.status !== "not_executable" && result.status !== "infra_unavailable";
    const existing = ledger.allocations.find((entry) => entry.execution_id === runId);
    const budget = consumes
      ? existing === undefined
        ? positionBudget(position, { amount: ledger.available, unit: ledger.unit }, remaining)
        : { amount: existing.amount, unit: ledger.unit }
      : { amount: 0, unit: ledger.unit };
    if (consumes) {
      ledger = splitChildBudget(ledger, runId, budget);
      remaining--;
      if (position.cost_actual !== undefined)
        ledger = refundChildBudget(ledger, runId, position.cost_actual);
    }
    const inputSnapshotSha256 =
      position.input_snapshot_sha256 ?? validated.baseline.initial_validation.input_snapshot_sha256;
    const resultWithSnapshot: BridgePositionResult = {
      ...result,
      input_snapshot_sha256: position.input_snapshot_sha256 ?? inputSnapshotSha256,
      input_snapshot_source:
        position.input_snapshot_sha256 === undefined ? "candidate" : "candidate",
    };
    if (position.charter === undefined)
      failA1("CORRUPT_CHARTER", "a dispatched task needs its own frozen charter");
    const childCharter = createRunCharter({
      ...position.charter,
      schema_version: 1,
      charter_id: `charter:${canonicalJsonSha256(runId)}`,
      run_id: runId,
      budget,
    });
    const childBase = {
      charter: childCharter,
      position_id: position.position_id,
      run_id: runId,
      parent_run_id: validated.charter.run_id,
      depth: input.run.depth + 1,
      scope_path: normalizeScopePath(input.run.scope_path, position.position_id),

      budget,
      charter_sha256: "",
      baseline_sha256: validated.baseline.baseline_sha256,
      resource_inventory_sha256: validated.resource.inventory_sha256,
      input_snapshot_sha256: inputSnapshotSha256,
      execution_plan: requireExperimentPlan(position.execution_plan),
      execution_plan_sha256: canonicalJsonSha256(requireExperimentPlan(position.execution_plan)),
      child_identity_sha256: "",
      code_baseline_sha256: validated.baseline.code_baseline.sha256,
      policy_revision: validated.charter.policy_revision,
      expected_output: childCharter.expected_output,

      result: resultWithSnapshot,
    } satisfies Omit<ChildRunPlan, "charter_sha256" | "execution_plan_sha256"> & {
      charter_sha256: string;
      execution_plan_sha256: string;
    };
    const child = {
      ...childBase,
      charter_sha256: childCharter.charter_sha256,
    };
    children.push({
      ...child,
      child_identity_sha256: computeBridgeChildIdentityHash(child, strategy),
    });
  }
  if (
    (input.frozen_matrix !== undefined || input.constructible_cell_ids !== undefined) &&
    input.workflow_spec === undefined
  )
    failA1(
      "WORKFLOW_SPEC_REQUIRED",
      "a frozen or constructibility-checked matrix needs workflow_spec",
    );
  const candidatePositionIds = children
    .filter((child) => child.result.route.enters_validation && child.result.candidate_id !== null)
    .map((child) => child.position_id);
  const matrix =
    input.workflow_spec === undefined
      ? null
      : resolveWaveMatrix(
          input.workflow_spec,
          candidatePositionIds,
          input.frozen_matrix,
          input.constructible_cell_ids,
        );
  const downstream = children
    .filter((child) => child.result.status !== "succeeded")
    .map((child) => {
      const position = orderedPositions.find((item) => item.position_id === child.position_id)!;
      return routeDownstreamInput({
        position_id: child.position_id,
        status: child.result.status,
        frozen_input_snapshot_sha256:
          position.input_snapshot_sha256 ??
          validated.baseline.initial_validation.input_snapshot_sha256,
        has_usable_frozen_artifact: position.has_usable_frozen_artifact === true,
      });
    });
  const base: Omit<BridgeExpansionPlan, "plan_sha256"> = {
    schema_version: 1,
    parent_run_id: validated.charter.run_id,
    parent_depth: input.run.depth,
    strategy,
    children,
    budget: ledger,
    matrix,
    downstream,
  };
  return { ...base, plan_sha256: planSha256(base) };
}

export const buildExperimentBridgePlan = planExperimentBridge;
export const expandExperimentBridge = planExperimentBridge;

/** Materialize a previously validated plan. It never makes a new decision. */
export function materializeBridgeChildren(
  projectRoot: string,
  plan: BridgeExpansionPlan,
): RunRecord[] {
  // This is the B boundary: a child can only be written from the complete
  // plan shape. The plan hash is an integrity check, not proof of caller
  // provenance, so this validation must remain explicit.
  const validatedPlan = validateBridgeExpansionPlan(plan);
  const parent = requireRunContract(projectRoot, validatedPlan.parent_run_id);
  if (parent.depth !== validatedPlan.parent_depth)
    failA1("RUN_DEPTH_MISMATCH", "bridge plan parent depth changed before materialization");
  const orderedChildren = [...validatedPlan.children].sort((left, right) =>
    compareIdentityStrings(left.run_id, right.run_id),
  );
  const childIds = new Set<string>();
  for (const child of orderedChildren) {
    if (childIds.has(child.run_id))
      failA1("DUPLICATE_ID", `child run '${child.run_id}' is repeated`, "bridge.children");
    childIds.add(child.run_id);
    if (child.parent_run_id !== validatedPlan.parent_run_id)
      failA1(
        "IDENTITY_MISMATCH",
        `child '${child.run_id}' points to a different parent run`,
        "bridge.children.parent_run_id",
      );
    // This is a read-only parent/depth/scope check. Do it for every child
    // before the first child creation call so a bad later child cannot leave an
    // earlier sibling half-materialized.
    assertRunReferenceCompatible(projectRoot, {
      run_id: child.run_id,
      parent_run_id: child.parent_run_id,
      depth: child.depth,
      scope_path: child.scope_path,
    });
    try {
      const existing = readRun(projectRoot, child.run_id);
      if (
        existing.parent_run_id !== child.parent_run_id ||
        existing.depth !== child.depth ||
        existing.scope_path !== child.scope_path ||
        existing.identity_material.charter_sha256 !== child.charter_sha256 ||
        existing.identity_material.input_snapshot_sha256 !== child.input_snapshot_sha256 ||
        existing.identity_material.execution_plan_sha256 !== child.execution_plan_sha256 ||
        existing.identity_material.code_baseline_sha256 !== child.code_baseline_sha256 ||
        existing.identity_material.policy_revision !== child.policy_revision
      )
        failA1(
          "RUN_IDENTITY_CONFLICT",
          `existing child '${child.run_id}' has a different identity`,
        );
    } catch (error) {
      if ((error as { code?: unknown }).code !== "RUN_NOT_FOUND") throw error;
    }
  }
  withRunBudget(projectRoot, parent.run_id, undefined, (ledger) => {
    let next = ledger;
    for (const child of orderedChildren) {
      if (child.result.status === "not_executable" || child.result.status === "infra_unavailable")
        continue;
      next = splitChildBudget(next, child.run_id, child.budget);
    }
    return { ledger: next, result: undefined };
  });
  const created: RunRecord[] = [];
  for (const child of orderedChildren) {
    if (child.result.status === "not_executable" || child.result.status === "infra_unavailable")
      continue;
    created.push(
      createBridgeChildRun({
        project_root: projectRoot,
        plan: validatedPlan,
        child_run_id: child.run_id,
      }),
    );
  }
  for (const child of orderedChildren) {
    if (!created.some((run) => run.run_id === child.run_id)) continue;
    const file = runOwnedPath(projectRoot, child.run_id, "charter.json");
    withStateFileLock(file, () => {
      if (
        fs.existsSync(file) &&
        validateRunCharter(readStateFile(file)).charter_sha256 !== child.charter_sha256
      )
        failA1("IMMUTABLE_CONFLICT", "child charter changed");
      writeStateJsonAtomic(file, child.charter);
    });
    initializeRunBudget(projectRoot, child.run_id, child.budget);
  }
  return created;
}

export const createBridgeChildren = materializeBridgeChildren;

function normalizePositionResult(
  position: BridgePositionInput,
  resource: ResourceInventory,
  availability?: ResourceRuntimeAvailability,
): BridgePositionResult {
  return resultForPosition(position, resource, availability);
}

export function decideWave(input: {
  workflow_spec: WorkflowSpec;
  positions: readonly BridgePositionInput[];
  resource_inventory: unknown;
  resource_availability?: ResourceRuntimeAvailability;
  frozen_matrix?: DynamicAblationPlan;
  /** Explicit construction result used when a frozen cell cannot be built. */
  constructible_cell_ids?: readonly string[];
  matrix_compared?: boolean;
  matrix_improved?: boolean;
  stop_decision?: { decision: "continue" | "stop"; reason: string };
}): WaveDecision {
  assertWaveCreationAllowed(input.stop_decision);
  const resource = validateResourceInventory(input.resource_inventory);
  const positions = input.positions
    .map((position, index) => normalizePosition(position, index))
    .sort((left, right) => compareIdentityStrings(left.position_id, right.position_id));
  const results = positions.map((position) =>
    normalizePositionResult(position, resource, input.resource_availability),
  );
  const validationCandidateIds = results
    .filter((result) => result.route.enters_validation && result.candidate_id !== null)
    .map((result) => result.candidate_id!)
    .sort(compareIdentityStrings);
  const testerCandidateIds = results
    .filter((result) => result.route.consumes_tester_exposure && result.candidate_id !== null)
    .map((result) => result.candidate_id!)
    .sort(compareIdentityStrings);
  const candidatePositionIds = results
    .filter((result) => result.route.enters_validation && result.candidate_id !== null)
    .map((result) => result.position_id);
  const matrix = resolveWaveMatrix(
    input.workflow_spec,
    candidatePositionIds,
    input.frozen_matrix,
    input.constructible_cell_ids,
  );
  const downstream = results
    .filter((result) => result.status !== "succeeded")
    .map((result) => {
      const position = positions.find((item) => item.position_id === result.position_id)!;
      return routeDownstreamInput({
        position_id: result.position_id,
        status: result.status,
        frozen_input_snapshot_sha256: position.input_snapshot_sha256,
        has_usable_frozen_artifact: position.has_usable_frozen_artifact === true,
      });
    });
  const noProgressMatrix =
    matrix !== null && input.matrix_compared === true && input.matrix_improved !== true;
  const base = {
    schema_version: 1 as const,
    siblings_to_continue: positions.map((position) => position.position_id),
    results,
    validation_candidate_ids: validationCandidateIds,
    tester_candidate_ids: testerCandidateIds,
    matrix,
    downstream,
    no_progress_matrix: noProgressMatrix,
  };
  return {
    ...base,
    decision_sha256: canonicalJsonSha256(base, undefined, {
      schemaVersion: "bridge-wave-decision-v1",
    }),
  };
}

export const routeWaveResults = decideWave;
