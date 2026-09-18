import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  resultStatusPolicy,
  validateResultPackage,
  type ResultPackage,
  type ResultStatus,
} from "./result-package.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import { readCycleFile, type OuterCycleSummary, writeCycleFile } from "./workflow-state.js";

export type StopReason =
  | "continue"
  | "target_reached"
  | "outer_budget_exhausted"
  | "tester_exposure_exhausted"
  | "no_finalist"
  | "no_tester_improvement"
  | "no_valid_candidate";

export interface StopTargetPolicy {
  name: string;
  direction: "higher_better" | "lower_better";
  value: number;
}

export interface StopBudgetPolicy {
  amount: number;
  unit: string;
}

export interface StopPolicy {
  target?: StopTargetPolicy;
  max_outer_budget?: StopBudgetPolicy;
  max_no_finalist_cycles?: number;
  max_no_tester_improvement_cycles?: number;
  max_no_valid_candidate_cycles?: number;
}

export interface StopExposureSnapshot {
  max_exposures_per_task: number;
  reserved: number;
  settled: number;
  released: number;
}

export interface StopBudgetSnapshot {
  limit: number;
  reserved: number;
  consumed: number;
  released: number;
  unit: string;
}

/**
 * The stop gate receives this small, immutable view next to each cycle. The
 * status is copied from result-package.json; it is deliberately not inferred
 * from a worker status, validation label, or infrastructure error.
 */
export interface StopGateResultPackage {
  outer_iteration?: number;
  status: ResultStatus;
  matrix_compared?: boolean;
  matrix_improved?: boolean;
}

export interface StopGateInput {
  outer_run_id?: string;
  policy: StopPolicy;
  cycle_summaries: readonly OuterCycleSummary[];
  exposure: StopExposureSnapshot;
  budget?: StopBudgetSnapshot;
  outer_iteration?: number;
  result_packages?: readonly (StopGateResultPackage | ResultPackage)[];
  /** Alias used by callers that name the association explicitly. */
  cycle_result_packages?: readonly (StopGateResultPackage | ResultPackage)[];
}

export interface StopDecision {
  schema_version: 1;
  outer_run_id: string | null;
  evaluated_cycle_count: number;
  decision: "continue" | "stop";
  reason: StopReason;
  no_finalist_streak: number;
  no_tester_improvement_streak: number;
  no_valid_candidate_streak: number;
  budget_remaining: number | null;
  exposure_remaining: number;
  cycle_history_sha256: string;
  decision_sha256: string;
}

function nonNegativeFinite(value: unknown, location: string): number {
  const number = requireFiniteNumber(value, location);
  if (number < 0) failA1("INVALID_VALUE", "value must be non-negative", location);
  return number;
}

function positiveInteger(value: unknown, location: string): number {
  return requireInteger(value, location, 1);
}

function validatePolicy(policy: StopPolicy): void {
  if (policy.target !== undefined) {
    requireString(policy.target.name, "stop.policy.target.name");
    if (policy.target.direction !== "higher_better" && policy.target.direction !== "lower_better")
      failA1("INVALID_VALUE", "stop target direction is invalid", "stop.policy.target.direction");
    requireFiniteNumber(policy.target.value, "stop.policy.target.value");
  }
  if (policy.max_outer_budget !== undefined) {
    nonNegativeFinite(policy.max_outer_budget.amount, "stop.policy.max_outer_budget.amount");
    requireString(policy.max_outer_budget.unit, "stop.policy.max_outer_budget.unit");
  }
  if (policy.max_no_finalist_cycles !== undefined)
    positiveInteger(policy.max_no_finalist_cycles, "stop.policy.max_no_finalist_cycles");
  if (policy.max_no_tester_improvement_cycles !== undefined)
    positiveInteger(
      policy.max_no_tester_improvement_cycles,
      "stop.policy.max_no_tester_improvement_cycles",
    );
  if (policy.max_no_valid_candidate_cycles !== undefined)
    positiveInteger(
      policy.max_no_valid_candidate_cycles,
      "stop.policy.max_no_valid_candidate_cycles",
    );
}

function validateExposure(exposure: StopExposureSnapshot): number {
  const max = positiveInteger(
    exposure.max_exposures_per_task,
    "stop.exposure.max_exposures_per_task",
  );
  const reserved = requireInteger(exposure.reserved, "stop.exposure.reserved", 0);
  const settled = requireInteger(exposure.settled, "stop.exposure.settled", 0);
  requireInteger(exposure.released, "stop.exposure.released", 0);
  if (reserved + settled > max)
    failA1("INVALID_VALUE", "tester exposure counts are inconsistent", "stop.exposure");
  return max - reserved - settled;
}

function validateBudget(budget: StopBudgetSnapshot): number {
  const limit = nonNegativeFinite(budget.limit, "stop.budget.limit");
  const reserved = nonNegativeFinite(budget.reserved, "stop.budget.reserved");
  const consumed = nonNegativeFinite(budget.consumed, "stop.budget.consumed");
  const released = nonNegativeFinite(budget.released, "stop.budget.released");
  requireString(budget.unit, "stop.budget.unit");
  if (consumed + reserved > limit)
    failA1("INVALID_VALUE", "outer budget counts are inconsistent", "stop.budget");
  return limit - consumed - reserved;
}

function completeResearchCycle(cycle: OuterCycleSummary): boolean {
  // An infrastructure failure is not evidence of a negative research result.
  // It must not advance a no-progress stopping streak.
  return (
    cycle.status === "completed" &&
    cycle.validation_result !== "incomplete" &&
    cycle.validation_result !== "not_run"
  );
}

interface ResultCycleView {
  cycle: OuterCycleSummary;
  result: StopGateResultPackage;
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

function normalizeResultPackages(
  cycles: readonly OuterCycleSummary[],
  packages: readonly (StopGateResultPackage | ResultPackage)[],
): ResultCycleView[] {
  const sortedCycles = [...cycles].sort(
    (left, right) => left.outer_iteration - right.outer_iteration,
  );
  const normalized = packages.map((value, index) => {
    if (!isRecord(value))
      failA1(
        "INVALID_RESULT_PACKAGE",
        "stop gate result package must be an object",
        `result_packages[${index}]`,
      );
    if (Object.hasOwn(value, "package_sha256")) {
      const packageValue = validateResultPackage(value, `result_packages[${index}]`);
      return { status: packageValue.status } satisfies StopGateResultPackage;
    }
    // This envelope is not a second result-package schema. It only permits
    // the classification and the frozen matrix fact needed by this gate.
    assertNoUnknownFields(
      value,
      ["outer_iteration", "status", "matrix_compared", "matrix_improved"],
      `result_packages[${index}]`,
    );
    if (value.matrix_compared !== undefined && typeof value.matrix_compared !== "boolean")
      failA1(
        "INVALID_RESULT_PACKAGE",
        "matrix_compared must be boolean",
        `result_packages[${index}]`,
      );
    if (value.matrix_improved !== undefined && typeof value.matrix_improved !== "boolean")
      failA1(
        "INVALID_RESULT_PACKAGE",
        "matrix_improved must be boolean",
        `result_packages[${index}]`,
      );
    return {
      ...(value.outer_iteration === undefined
        ? {}
        : {
            outer_iteration: requireInteger(
              value.outer_iteration,
              `result_packages[${index}].outer_iteration`,
              1,
            ),
          }),
      status: validateResultStatus(value.status, `result_packages[${index}].status`),
      ...(value.matrix_compared === undefined ? {} : { matrix_compared: value.matrix_compared }),
      ...(value.matrix_improved === undefined ? {} : { matrix_improved: value.matrix_improved }),
    } satisfies StopGateResultPackage;
  });
  const hasExplicitIterations = normalized.some((item) => item.outer_iteration !== undefined);
  if (hasExplicitIterations && normalized.some((item) => item.outer_iteration === undefined))
    failA1(
      "INVALID_RESULT_PACKAGE",
      "result package cycle association must be explicit for every item or for none",
      "result_packages",
    );
  const byIteration = new Map<number, StopGateResultPackage>();
  if (hasExplicitIterations) {
    for (const item of normalized) {
      const iteration = item.outer_iteration!;
      if (byIteration.has(iteration))
        failA1("DUPLICATE_ID", "result package cycle iterations must be unique", "result_packages");
      byIteration.set(iteration, item);
    }
    if (byIteration.size !== sortedCycles.length)
      failA1("INVALID_RESULT_PACKAGE", "result packages must cover every cycle", "result_packages");
    return sortedCycles.map((cycle) => {
      const result = byIteration.get(cycle.outer_iteration);
      if (result === undefined)
        failA1(
          "INVALID_RESULT_PACKAGE",
          `missing result package for cycle ${cycle.outer_iteration}`,
          "result_packages",
        );
      return { cycle, result };
    });
  }
  if (normalized.length !== sortedCycles.length)
    failA1("INVALID_RESULT_PACKAGE", "result packages must cover every cycle", "result_packages");
  return sortedCycles.map((cycle, index) => ({ cycle, result: normalized[index]! }));
}

function resultCycleIsEligible(view: ResultCycleView): boolean {
  return resultStatusPolicy(view.result.status).enters_validation;
}

function resultCycleSucceeded(view: ResultCycleView): boolean {
  return view.result.status === "succeeded";
}

function resultCycleHasMatrix(view: ResultCycleView): boolean {
  return view.result.matrix_compared === true;
}

function resultCycleImproved(view: ResultCycleView): boolean {
  return view.result.matrix_improved === true;
}

function resultTrailingStreak(
  views: readonly ResultCycleView[],
  predicate: (view: ResultCycleView) => boolean,
): number {
  const ordered = [...views].sort(
    (left, right) => left.cycle.outer_iteration - right.cycle.outer_iteration,
  );
  let result = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const view = ordered[index]!;
    // A child that could not run is neutral. It neither increases nor resets
    // the research streak. A real matrix is the only unit that can do either.
    if (!resultCycleIsEligible(view) || !resultCycleHasMatrix(view)) continue;
    if (!predicate(view)) break;
    result += 1;
  }
  return result;
}

function trailingStreak(
  cycles: readonly OuterCycleSummary[],
  predicate: (cycle: OuterCycleSummary) => boolean,
): number {
  let result = 0;
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index]!;
    if (!completeResearchCycle(cycle) || !predicate(cycle)) break;
    result += 1;
  }
  return result;
}

function decisionPayload(
  decision: Omit<StopDecision, "decision_sha256">,
): Omit<StopDecision, "decision_sha256"> {
  return decision;
}

export function evaluateWorkflowStopGate(input: StopGateInput): StopDecision {
  validatePolicy(input.policy);
  const outerRunId =
    input.outer_run_id === undefined ? null : assertIdentifier(input.outer_run_id, "outer_run_id");
  const cycles = [...input.cycle_summaries].sort(
    (left, right) => left.outer_iteration - right.outer_iteration,
  );
  const seen = new Set<number>();
  for (const cycle of cycles) {
    if (seen.has(cycle.outer_iteration))
      failA1("DUPLICATE_ID", "stop gate cycle iterations must be unique", "stop.cycle_summaries");
    seen.add(cycle.outer_iteration);
    if (outerRunId !== null && cycle.outer_run_id !== outerRunId)
      failA1("IDENTITY_MISMATCH", "stop gate cycle belongs to another outer run");
  }
  const exposureRemaining = validateExposure(input.exposure);
  if (input.policy.max_outer_budget !== undefined && input.budget === undefined)
    failA1(
      "STOP_BUDGET_SNAPSHOT_REQUIRED",
      "a stop policy with a budget limit needs an explicit budget snapshot",
    );
  if (
    input.policy.max_outer_budget !== undefined &&
    input.budget !== undefined &&
    (input.policy.max_outer_budget.amount !== input.budget.limit ||
      input.policy.max_outer_budget.unit !== input.budget.unit)
  )
    failA1("INVALID_VALUE", "stop budget snapshot does not match the configured budget limit");
  const budgetRemaining = input.budget === undefined ? null : validateBudget(input.budget);
  const latest = cycles[cycles.length - 1] ?? null;
  const resultPackages = input.result_packages ?? input.cycle_result_packages;
  if (input.result_packages !== undefined && input.cycle_result_packages !== undefined)
    failA1(
      "INVALID_RESULT_PACKAGE",
      "provide result_packages or cycle_result_packages, not both",
      "stop",
    );
  const resultViews =
    resultPackages === undefined ? null : normalizeResultPackages(cycles, resultPackages);
  const latestResultView = resultViews?.[resultViews.length - 1] ?? null;
  const targetReached =
    input.policy.target !== undefined &&
    (resultViews === null
      ? latest?.target_reached === true
      : latestResultView !== null &&
        resultCycleSucceeded(latestResultView) &&
        latestResultView.cycle.target_reached === true);
  const budgetExhausted = budgetRemaining !== null && budgetRemaining <= 0;
  const exposureExhausted = exposureRemaining <= 0;
  const noFinalistStreak =
    resultViews === null
      ? trailingStreak(cycles, (cycle) => cycle.finalist_id === null)
      : resultTrailingStreak(
          resultViews,
          (view) => view.cycle.finalist_id === null && !resultCycleImproved(view),
        );
  const noTesterImprovementStreak =
    resultViews === null
      ? trailingStreak(cycles, (cycle) => cycle.tester_improved === false)
      : resultTrailingStreak(
          resultViews,
          (view) => view.cycle.tester_improved === false && !resultCycleImproved(view),
        );
  const noValidCandidateStreak =
    resultViews === null
      ? trailingStreak(cycles, (cycle) => !cycle.valid_candidate)
      : resultTrailingStreak(
          resultViews,
          (view) => !view.cycle.valid_candidate && !resultCycleImproved(view),
        );

  let reason: StopReason = "continue";
  if (targetReached) reason = "target_reached";
  else if (budgetExhausted) reason = "outer_budget_exhausted";
  else if (exposureExhausted) reason = "tester_exposure_exhausted";
  else if (
    input.policy.max_no_finalist_cycles !== undefined &&
    noFinalistStreak >= input.policy.max_no_finalist_cycles
  )
    reason = "no_finalist";
  else if (
    input.policy.max_no_tester_improvement_cycles !== undefined &&
    noTesterImprovementStreak >= input.policy.max_no_tester_improvement_cycles
  )
    reason = "no_tester_improvement";
  else if (
    input.policy.max_no_valid_candidate_cycles !== undefined &&
    noValidCandidateStreak >= input.policy.max_no_valid_candidate_cycles
  )
    reason = "no_valid_candidate";

  const cycleHistoryValue =
    resultViews === null
      ? cycles
      : resultViews.map((view) => ({
          outer_iteration: view.cycle.outer_iteration,
          cycle: view.cycle,
          result: view.result,
        }));

  const base: Omit<StopDecision, "decision_sha256"> = {
    schema_version: 1,
    outer_run_id: outerRunId,
    evaluated_cycle_count: cycles.length,
    decision: reason === "continue" ? "continue" : "stop",
    reason,
    no_finalist_streak: noFinalistStreak,
    no_tester_improvement_streak: noTesterImprovementStreak,
    no_valid_candidate_streak: noValidCandidateStreak,
    budget_remaining: budgetRemaining,
    exposure_remaining: exposureRemaining,
    cycle_history_sha256: canonicalJsonSha256(cycleHistoryValue, undefined, {
      schemaVersion: "workflow-cycle-history-v1",
    }),
  };
  return {
    ...base,
    decision_sha256: canonicalJsonSha256(decisionPayload(base), undefined, {
      schemaVersion: "workflow-stop-decision-v1",
    }),
  };
}

export const evaluateStopGate = evaluateWorkflowStopGate;

export function validateWorkflowStopDecision(
  value: unknown,
  filePath = "stop-decision",
): StopDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    failA1("CORRUPT_STOP_DECISION", "stop decision must be an object", filePath);
  const record = value as Record<string, unknown>;
  const allowed = [
    "schema_version",
    "outer_run_id",
    "evaluated_cycle_count",
    "decision",
    "reason",
    "no_finalist_streak",
    "no_tester_improvement_streak",
    "no_valid_candidate_streak",
    "budget_remaining",
    "exposure_remaining",
    "cycle_history_sha256",
    "decision_sha256",
  ];
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown stop decision field '${key}'`, filePath);
  if (record.schema_version !== 1)
    failA1("CORRUPT_STOP_DECISION", "stop decision schema_version must be 1", filePath);
  const outerRunId =
    record.outer_run_id === null
      ? null
      : assertIdentifier(record.outer_run_id, `${filePath}.outer_run_id`);
  if (record.decision !== "continue" && record.decision !== "stop")
    failA1("CORRUPT_STOP_DECISION", "stop decision is invalid", filePath);
  const reasons: StopReason[] = [
    "continue",
    "target_reached",
    "outer_budget_exhausted",
    "tester_exposure_exhausted",
    "no_finalist",
    "no_tester_improvement",
    "no_valid_candidate",
  ];
  if (!reasons.includes(record.reason as StopReason))
    failA1("CORRUPT_STOP_DECISION", "stop reason is invalid", filePath);
  const parsed: Omit<StopDecision, "decision_sha256"> = {
    schema_version: 1,
    outer_run_id: outerRunId,
    evaluated_cycle_count: requireInteger(
      record.evaluated_cycle_count,
      `${filePath}.evaluated_cycle_count`,
      0,
    ),
    decision: record.decision,
    reason: record.reason as StopReason,
    no_finalist_streak: requireInteger(
      record.no_finalist_streak,
      `${filePath}.no_finalist_streak`,
      0,
    ),
    no_tester_improvement_streak: requireInteger(
      record.no_tester_improvement_streak,
      `${filePath}.no_tester_improvement_streak`,
      0,
    ),
    no_valid_candidate_streak: requireInteger(
      record.no_valid_candidate_streak,
      `${filePath}.no_valid_candidate_streak`,
      0,
    ),
    budget_remaining:
      record.budget_remaining === null
        ? null
        : nonNegativeFinite(record.budget_remaining, `${filePath}.budget_remaining`),
    exposure_remaining: nonNegativeFinite(
      record.exposure_remaining,
      `${filePath}.exposure_remaining`,
    ),
    cycle_history_sha256: assertSha256(
      record.cycle_history_sha256,
      `${filePath}.cycle_history_sha256`,
    ),
  };
  const decisionSha256 = assertSha256(record.decision_sha256, `${filePath}.decision_sha256`);
  if (
    decisionSha256 !==
    canonicalJsonSha256(parsed, undefined, { schemaVersion: "workflow-stop-decision-v1" })
  )
    failA1("CORRUPT_STOP_DECISION", "stop decision hash does not match its content", filePath);
  if ((parsed.decision === "continue") !== (parsed.reason === "continue"))
    failA1("CORRUPT_STOP_DECISION", "stop decision and reason disagree", filePath);
  return { ...parsed, decision_sha256: decisionSha256 };
}

export function writeWorkflowStopDecision(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  decision: StopDecision,
): StopDecision {
  const safeRunId = assertIdentifier(outerRunId, "outer_run_id");
  const validated = validateWorkflowStopDecision(decision);
  if (validated.outer_run_id !== safeRunId)
    failA1("IDENTITY_MISMATCH", "stop decision does not belong to the outer run");
  requireInteger(outerIteration, "outer_iteration", 1);
  writeCycleFile(projectRoot, safeRunId, outerIteration, "stop-decision.json", validated);
  return validated;
}

export const writeStopDecision = writeWorkflowStopDecision;

export function readWorkflowStopDecision(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): StopDecision {
  const safeRunId = assertIdentifier(outerRunId, "outer_run_id");
  return validateWorkflowStopDecision(
    readCycleFile(projectRoot, safeRunId, outerIteration, "stop-decision.json"),
  );
}

export const readStopDecision = readWorkflowStopDecision;
