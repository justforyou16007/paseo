import { resultStatusPolicy } from "./result-package.js";
import { canonicalJsonString } from "./canonical-json.js";
import {
  computePairedStatistics,
  type PairedScoreObservation,
  type PairedStatistics,
} from "./paired-statistics.js";
import {
  assertTesterArmsComparable as assertStoredTesterArmsComparable,
  consumeTesterGate,
  normalizeTesterArmResult,
  readStoredTesterPrivateResult,
  readStoredTesterReview,
  readTesterRunState,
  readTesterFinalistStatus,
  type TesterArmResult,
  type TesterDefinition,
  type TesterGateBinding,
  validateTesterDefinition,
} from "./tester-state.js";
import {
  selectUniqueFinalist,
  type ValidationBinding,
  type ValidationCellResult,
  type ValidationFinalistSelection,
  type ValidationImprovement,
  type ValidationReview,
} from "./validation-gate.js";
import { failA1, requireFiniteNumber } from "./workflow-spec.js";

export type {
  ValidationBinding,
  ValidationCellResult,
  ValidationFinalistSelection,
  ValidationImprovement,
  ValidationReview,
};
export { selectUniqueFinalist };
export type { TesterArmResult } from "./tester-state.js";

/** What the paired comparison found for one declared metric. */
export interface PromotionMetricOutcome {
  baseline_score: number;
  finalist_score: number;
  paired_delta: number;
  relative_gain: number | null;
  lower_confidence_bound: number;
  relative_lower_confidence_bound: number | null;
  statistics: PairedStatistics;
}

export interface PromotionGateResult {
  status: "passed" | "rejected";
  reason_codes: string[];
  /** One entry per metric the tester declared, keyed by metric name. */
  metrics: Record<string, PromotionMetricOutcome>;
  constraint_statistics: Record<string, PairedStatistics>;
}

function compareValue(value: number, op: ">=" | "<=" | ">" | "<" | "=", target: number): boolean {
  if (op === ">=") return value >= target;
  if (op === "<=") return value <= target;
  if (op === ">") return value > target;
  if (op === "<") return value < target;
  return value === target;
}

function pairedObservationForMetric(
  baseline: TesterArmResult,
  finalist: TesterArmResult,
  metricName: string,
  location: string,
): PairedScoreObservation[] {
  const finalistByPair = new Map(
    finalist.observations.map((observation) => [
      `${observation.case_id}\u0000${observation.repeat_id}`,
      observation,
    ]),
  );
  return baseline.observations.map((baselineObservation) => {
    const key = `${baselineObservation.case_id}\u0000${baselineObservation.repeat_id}`;
    const finalistObservation = finalistByPair.get(key);
    if (!finalistObservation)
      failA1("TESTER_ARMS_MISMATCH", `${location} is missing a paired observation`);
    const baselineScore = baselineObservation.metrics[metricName];
    const finalistScore = finalistObservation.metrics[metricName];
    if (baselineScore === undefined || finalistScore === undefined)
      failA1("MISSING_PRIMARY_METRIC", `${location} is missing metric '${metricName}'`);
    return {
      case_id: baselineObservation.case_id,
      repeat_id: baselineObservation.repeat_id,
      baseline: requireFiniteNumber(baselineScore, `${location}.baseline`),
      finalist: requireFiniteNumber(finalistScore, `${location}.finalist`),
    };
  });
}

function pairedConstraintObservationForMetric(
  baseline: TesterArmResult,
  finalist: TesterArmResult,
  metricName: string,
  location: string,
): PairedScoreObservation[] {
  const finalistByPair = new Map(
    finalist.observations.map((observation) => [
      `${observation.case_id}\u0000${observation.repeat_id}`,
      observation,
    ]),
  );
  return baseline.observations.map((baselineObservation) => {
    const key = `${baselineObservation.case_id}\u0000${baselineObservation.repeat_id}`;
    const finalistObservation = finalistByPair.get(key);
    if (!finalistObservation)
      failA1("TESTER_ARMS_MISMATCH", `${location} is missing a paired observation`);
    const baselineScore = baselineObservation.constraint_metrics[metricName];
    const finalistScore = finalistObservation.constraint_metrics[metricName];
    if (baselineScore === undefined || finalistScore === undefined)
      failA1("MISSING_CONSTRAINT_METRIC", `${location} is missing metric '${metricName}'`);
    return {
      case_id: baselineObservation.case_id,
      repeat_id: baselineObservation.repeat_id,
      baseline: requireFiniteNumber(baselineScore, `${location}.baseline`),
      finalist: requireFiniteNumber(finalistScore, `${location}.finalist`),
    };
  });
}

function upperConfidenceBound(statistics: PairedStatistics): number {
  return statistics.mean_delta + statistics.critical_value * statistics.standard_error;
}

function comparePairedConstraint(
  statistics: PairedStatistics,
  op: ">=" | "<=" | ">" | "<" | "=",
  target: number,
): boolean {
  const lower = statistics.lower_confidence_bound;
  const upper = upperConfidenceBound(statistics);
  if (op === ">=" || op === ">") return compareValue(lower, op, target);
  if (op === "<=" || op === "<") return compareValue(upper, op, target);
  return lower <= target && upper >= target;
}

function normalizeComparableTesterArms(
  definition: TesterDefinition,
  baseline: TesterArmResult,
  finalist: TesterArmResult,
): { baseline: TesterArmResult; finalist: TesterArmResult } {
  const normalizedBaseline = normalizeTesterArmResult(baseline, "tester.baseline", definition);
  const normalizedFinalist = normalizeTesterArmResult(finalist, "tester.finalist", definition);
  assertStoredTesterArmsComparable(normalizedBaseline, normalizedFinalist);
  return { baseline: normalizedBaseline, finalist: normalizedFinalist };
}

export function evaluatePromotionGate(input: {
  definition: TesterDefinition;
  baseline: TesterArmResult;
  finalist: TesterArmResult;
  workflow_constraints_passed: boolean;
}): PromotionGateResult {
  const definition = validateTesterDefinition(input.definition);
  const arms = normalizeComparableTesterArms(definition, input.baseline, input.finalist);
  if (typeof input.workflow_constraints_passed !== "boolean")
    failA1("INVALID_TESTER_RESULT", "workflow_constraints_passed must be boolean");
  const reasonCodes: string[] = [];
  const metrics: Record<string, PromotionMetricOutcome> = {};
  // Each declared metric is compared on its own and has to clear its own bar.
  // A failure names the metric, so a rejection says which one fell short
  // instead of reporting one unattributed number.
  for (const primary of definition.gate.primaries) {
    const statistics = computePairedStatistics({
      metric_name: primary.name,
      direction: primary.direction,
      config: definition.gate.statistics,
      case_ids: arms.baseline.case_ids,
      repeat_ids: arms.baseline.repeat_ids,
      observations: pairedObservationForMetric(
        arms.baseline,
        arms.finalist,
        primary.name,
        `tester.primary.${primary.name}`,
      ),
    });
    const baselineScore = statistics.baseline_mean;
    const relativeGain =
      baselineScore === 0 ? null : statistics.mean_delta / Math.abs(baselineScore);
    const relativeLowerBound =
      baselineScore === 0 ? null : statistics.lower_confidence_bound / Math.abs(baselineScore);
    metrics[primary.name] = {
      baseline_score: baselineScore,
      finalist_score: statistics.finalist_mean,
      paired_delta: statistics.mean_delta,
      relative_gain: relativeGain,
      lower_confidence_bound: statistics.lower_confidence_bound,
      relative_lower_confidence_bound: relativeLowerBound,
      statistics,
    };
    if (statistics.lower_confidence_bound <= 0)
      reasonCodes.push(`tie_or_regression:${primary.name}`);
    if (primary.improvement.policy === "relative") {
      if (baselineScore === 0) reasonCodes.push(`relative_baseline_zero:${primary.name}`);
      else if (relativeLowerBound === null || relativeLowerBound < primary.improvement.minimum_gain)
        reasonCodes.push(`minimum_relative_gain_not_met:${primary.name}`);
    } else if (statistics.lower_confidence_bound < primary.improvement.minimum_gain) {
      reasonCodes.push(`minimum_absolute_gain_not_met:${primary.name}`);
    }
  }
  if (
    arms.baseline.tester_version !== definition.version ||
    arms.finalist.tester_version !== definition.version
  )
    reasonCodes.push("tester_version_mismatch");
  if (
    arms.baseline.tester_definition_sha256 !== definition.definition_sha256 ||
    arms.finalist.tester_definition_sha256 !== definition.definition_sha256
  )
    reasonCodes.push("tester_definition_mismatch");
  if (
    arms.baseline.harness_sha256 !== definition.harness_sha256 ||
    arms.finalist.harness_sha256 !== definition.harness_sha256
  )
    reasonCodes.push("harness_mismatch");
  if (
    arms.baseline.case_manifest_sha256 !== definition.case_manifest_sha256 ||
    arms.finalist.case_manifest_sha256 !== definition.case_manifest_sha256
  )
    reasonCodes.push("case_manifest_mismatch");
  if (
    arms.baseline.seed_manifest_sha256 !== definition.seed_manifest_sha256 ||
    arms.finalist.seed_manifest_sha256 !== definition.seed_manifest_sha256
  )
    reasonCodes.push("seed_manifest_mismatch");
  if (!arms.baseline.complete || !arms.finalist.complete) reasonCodes.push("tester_incomplete");
  const constraintStatistics: Record<string, PairedStatistics> = {};
  for (const constraint of definition.gate.constraints) {
    const constraintStatisticsValue = computePairedStatistics({
      metric_name: constraint.name,
      direction: "higher_better",
      config: definition.gate.statistics,
      case_ids: arms.baseline.case_ids,
      repeat_ids: arms.baseline.repeat_ids,
      observations: pairedConstraintObservationForMetric(
        arms.baseline,
        arms.finalist,
        constraint.name,
        `tester.constraint.${constraint.name}`,
      ),
    });
    constraintStatistics[constraint.name] = constraintStatisticsValue;
    const baselineConstraint = constraintStatisticsValue.baseline_mean;
    const finalistConstraint = constraintStatisticsValue.finalist_mean;
    if (!compareValue(baselineConstraint, constraint.absolute.op, constraint.absolute.value))
      reasonCodes.push(`baseline_absolute_constraint_failed:${constraint.name}`);
    if (!compareValue(finalistConstraint, constraint.absolute.op, constraint.absolute.value))
      reasonCodes.push(`absolute_constraint_failed:${constraint.name}`);
    if (
      !comparePairedConstraint(
        constraintStatisticsValue,
        constraint.paired_regression.op,
        constraint.paired_regression.value,
      )
    )
      reasonCodes.push(`paired_constraint_failed:${constraint.name}`);
  }
  if (!input.workflow_constraints_passed) reasonCodes.push("workflow_constraint_failed");
  return {
    status: reasonCodes.length === 0 ? "passed" : "rejected",
    reason_codes: reasonCodes,
    metrics,
    constraint_statistics: constraintStatistics,
  };
}

export function consumePromotionGate(input: {
  project_root: string;
  tester_run_id: string;
  definition: TesterDefinition;
  baseline: TesterArmResult;
  finalist: TesterArmResult;
  workflow_constraints_passed: boolean;
}): PromotionGateResult {
  const state = readTesterRunState(input.project_root, input.tester_run_id);
  const finalistStatus = readTesterFinalistStatus(
    input.project_root,
    state.outer_run_id,
    state.wave_id,
    state.finalist_artifact_sha256,
  );
  if (!resultStatusPolicy(finalistStatus).consumes_tester_exposure)
    failA1("TESTER_NOT_ALLOWED", "non-executable results cannot enter promotion testing");
  const privateResult = readStoredTesterPrivateResult(input.project_root, input.tester_run_id);
  const review = readStoredTesterReview(input.project_root, input.tester_run_id);
  if (review.verdict !== "approved")
    failA1("TESTER_REVIEW_REJECTED", "promotion gate requires an approved tester review");
  const definition = validateTesterDefinition(input.definition);
  if (definition.definition_sha256 !== privateResult.tester_definition_sha256)
    failA1(
      "TESTER_DEFINITION_MISMATCH",
      "promotion gate definition differs from the sealed private result",
    );
  if (privateResult.harness_sha256 !== definition.harness_sha256)
    failA1("HARNESS_MISMATCH", "promotion gate harness differs from the sealed definition");
  if (review.subject.private_result_sha256 !== state.private_result_sha256)
    failA1("PRIVATE_RESULT_HASH_MISMATCH", "review does not approve the stored private result");
  const normalizeSuppliedArm = (value: TesterArmResult, location: string): TesterArmResult => {
    try {
      return normalizeTesterArmResult(value, location, definition);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === "AGGREGATE_MISMATCH" || code === "PRIMARY_SCORE_MISMATCH")
        failA1(
          state.status === "passed" || state.status === "rejected"
            ? "TESTER_GATE_CONFLICT"
            : "TESTER_ARMS_MISMATCH",
          "promotion gate inputs differ from the sealed private result bundle",
        );
      throw error;
    }
  };
  const suppliedBaseline = normalizeSuppliedArm(input.baseline, "promotion.baseline");
  const suppliedFinalist = normalizeSuppliedArm(input.finalist, "promotion.finalist");
  assertStoredTesterArmsComparable(privateResult.baseline, privateResult.finalist);
  if (
    canonicalJsonString(suppliedBaseline) !== canonicalJsonString(privateResult.baseline) ||
    canonicalJsonString(suppliedFinalist) !== canonicalJsonString(privateResult.finalist) ||
    input.workflow_constraints_passed !== privateResult.workflow_constraints_passed
  )
    failA1(
      state.status === "passed" || state.status === "rejected"
        ? "TESTER_GATE_CONFLICT"
        : "TESTER_ARMS_MISMATCH",
      "promotion gate inputs differ from the sealed private result bundle",
    );
  const result = evaluatePromotionGate({
    definition: privateResult.tester_definition,
    baseline: privateResult.baseline,
    finalist: privateResult.finalist,
    workflow_constraints_passed: privateResult.workflow_constraints_passed,
  });
  const binding: TesterGateBinding = {
    tester_version: privateResult.tester_version,
    tester_definition_sha256: privateResult.tester_definition_sha256,
    harness_sha256: privateResult.harness_sha256,
    case_manifest_sha256: privateResult.case_manifest_sha256,
    seed_manifest_sha256: privateResult.seed_manifest_sha256,
    input_distribution_sha256: privateResult.input_distribution_sha256,
    matching_baseline_artifact_sha256: privateResult.baseline.artifact_sha256,
    finalist_artifact_sha256: privateResult.finalist.artifact_sha256,
    judge_binding_id: privateResult.judge_binding?.binding_id ?? null,
    judge_binding: privateResult.judge_binding,
    model_assignment_sha256: privateResult.model_assignment_sha256,
  };
  consumeTesterGate(input.project_root, input.tester_run_id, result.status, binding);
  return result;
}
