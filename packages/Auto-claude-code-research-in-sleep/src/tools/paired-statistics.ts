import {
  assertIdentifier,
  compareIdentityStrings,
  failA1,
  requireFiniteNumber,
  requireInteger,
} from "./workflow-spec.js";

/** The only confidence method currently accepted by a tester definition. */
export type PairedStatisticsMethod = "paired_student_t";

export interface PairedStatisticsConfig {
  method: PairedStatisticsMethod;
  /** One-sided confidence for the lower confidence bound, for example 0.95. */
  confidence_level: number;
  /** The owner-selected minimum number of independent repetitions. */
  min_repeats: number;
}

export interface PairedScoreObservation {
  case_id: string;
  repeat_id: string;
  baseline: number;
  finalist: number;
}

export interface PairedCaseMean {
  case_id: string;
  baseline_mean: number;
  finalist_mean: number;
  directional_delta: number;
}

export interface PairedRepeatMean {
  repeat_id: string;
  baseline_case_mean: number;
  finalist_case_mean: number;
  directional_delta: number;
}

export interface PairedStatistics {
  method: PairedStatisticsMethod;
  confidence_level: number;
  min_repeats: number;
  direction: "higher_better" | "lower_better";
  case_count: number;
  repeat_count: number;
  baseline_mean: number;
  finalist_mean: number;
  mean_delta: number;
  sample_standard_deviation: number;
  standard_error: number;
  degrees_of_freedom: number;
  critical_value: number;
  lower_confidence_bound: number;
  upper_confidence_bound: number;
  case_means: PairedCaseMean[];
  repeat_means: PairedRepeatMean[];
  repeat_deltas: number[];
}

export interface CompleteGridMetricObservation {
  case_id: string;
  repeat_id: string;
  metrics: Record<string, number>;
  constraint_metrics: Record<string, number>;
}

export interface CompleteGridMeans {
  metrics: Record<string, number>;
  constraint_metrics: Record<string, number>;
}

function validateConfig(config: PairedStatisticsConfig): void {
  if (config.method !== "paired_student_t")
    failA1(
      "STATISTICS_UNSUPPORTED_METHOD",
      "tester statistics must explicitly select paired_student_t",
    );
  if (
    !Number.isFinite(config.confidence_level) ||
    config.confidence_level <= 0.5 ||
    config.confidence_level >= 1
  )
    failA1(
      "INVALID_STATISTICS_CONFIGURATION",
      "confidence_level must be finite, greater than 0.5, and less than 1",
    );
  requireInteger(config.min_repeats, "tester.gate.statistics.min_repeats", 2);
}

function sortedUniqueIds(values: readonly string[], location: string): string[] {
  if (values.length === 0) failA1("STATISTICS_GRID_INCOMPLETE", `${location} must not be empty`);
  const normalized = values.map((value, index) => assertIdentifier(value, `${location}[${index}]`));
  if (new Set(normalized).size !== normalized.length)
    failA1("STATISTICS_GRID_INCOMPLETE", `${location} must not contain duplicate ids`);
  return [...normalized].sort(compareIdentityStrings);
}

function validateObservationGrid(
  observations: readonly PairedScoreObservation[],
  caseIds: readonly string[],
  repeatIds: readonly string[],
): { cases: string[]; repeats: string[]; values: PairedScoreObservation[] } {
  const cases = sortedUniqueIds(caseIds, "statistics.case_ids");
  const repeats = sortedUniqueIds(repeatIds, "statistics.repeat_ids");
  const caseSet = new Set(cases);
  const repeatSet = new Set(repeats);
  const expectedKeys = new Set<string>();
  for (const caseId of cases) {
    for (const repeatId of repeats) expectedKeys.add(`${caseId}\u0000${repeatId}`);
  }
  if (observations.length !== expectedKeys.size)
    failA1(
      "STATISTICS_GRID_INCOMPLETE",
      "tester observations must contain exactly one result for every case/repeat pair",
    );
  const seen = new Set<string>();
  const values = observations.map((observation, index) => {
    const caseId = assertIdentifier(
      observation.case_id,
      `statistics.observations[${index}].case_id`,
    );
    const repeatId = assertIdentifier(
      observation.repeat_id,
      `statistics.observations[${index}].repeat_id`,
    );
    if (!caseSet.has(caseId) || !repeatSet.has(repeatId))
      failA1(
        "STATISTICS_GRID_INCOMPLETE",
        "tester observations contain a case/repeat id outside the declared grid",
      );
    const key = `${caseId}\u0000${repeatId}`;
    if (seen.has(key))
      failA1("STATISTICS_PAIR_MISMATCH", "tester observations contain a duplicate pair");
    seen.add(key);
    const baseline = requireFiniteNumber(
      observation.baseline,
      `statistics.observations[${index}].baseline`,
    );
    const finalist = requireFiniteNumber(
      observation.finalist,
      `statistics.observations[${index}].finalist`,
    );
    return { case_id: caseId, repeat_id: repeatId, baseline, finalist };
  });
  if (seen.size !== expectedKeys.size)
    failA1(
      "STATISTICS_GRID_INCOMPLETE",
      "tester observations are missing at least one case/repeat pair",
    );
  values.sort(
    (left, right) =>
      compareIdentityStrings(left.case_id, right.case_id) ||
      compareIdentityStrings(left.repeat_id, right.repeat_id),
  );
  return { cases, repeats, values };
}

function average(values: readonly number[]): number {
  if (values.length === 0) failA1("STATISTICS_GRID_INCOMPLETE", "cannot average an empty set");
  const result = values.reduce((sum, value) => sum + value, 0) / values.length;
  return requireFiniteNumber(result, "statistics.mean");
}

function sampleStandardDeviation(values: readonly number[], mean: number): number {
  if (values.length < 2)
    failA1("STATISTICS_NOT_ENOUGH_REPEATS", "paired statistics need at least two repeats");
  const sumSquares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const variance = sumSquares / (values.length - 1);
  return requireFiniteNumber(Math.sqrt(Math.max(variance, 0)), "statistics.standard_deviation");
}

/*
 * Student-t values are evaluated from the t CDF, not from a normal or small-n
 * approximation. The CDF uses log-gamma plus the regularized incomplete beta
 * continued fraction. Its inverse is found by a bracketed bisection, which is
 * slow but deterministic and adequate for one gate decision per tester run.
 */
const LANCZOS_COEFFICIENTS = [
  676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
] as const;

function logGamma(value: number): number {
  if (value < 0.5)
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const shifted = value - 1;
  let sum = 0.9999999999998099;
  for (const [index, coefficient] of LANCZOS_COEFFICIENTS.entries())
    sum += coefficient / (shifted + index + 1);
  const t = shifted + LANCZOS_COEFFICIENTS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront =
    a * Math.log(x) + b * Math.log1p(-x) + logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(logFront) / a;
  const useDirectContinuedFraction = x < (a + 1) / (a + b + 2);
  const continuedFraction = (fractionX: number, fractionA: number, fractionB: number): number => {
    const maxIterations = 10_000;
    const epsilon = 3e-14;
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((fractionA + fractionB) * fractionX) / (fractionA + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let result = d;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const m = iteration;
      const m2 = 2 * m;
      let numerator = (m * (fractionB - m) * fractionX) / ((fractionA + m2 - 1) * (fractionA + m2));
      d = 1 + numerator * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + numerator / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      result *= d * c;
      numerator =
        (-(fractionA + m) * (fractionA + fractionB + m) * fractionX) /
        ((fractionA + m2) * (fractionA + m2 + 1));
      d = 1 + numerator * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + numerator / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const change = d * c;
      result *= change;
      if (Math.abs(change - 1) < epsilon) return result;
    }
    failA1("STATISTICS_NUMERICAL_FAILURE", "incomplete beta evaluation did not converge");
  };
  if (useDirectContinuedFraction)
    return Math.min(1, Math.max(0, front * continuedFraction(x, a, b)));
  const complementFront =
    Math.exp(b * Math.log1p(-x) + a * Math.log(x) + logGamma(a + b) - logGamma(a) - logGamma(b)) /
    b;
  const complement = complementFront * continuedFraction(1 - x, b, a);
  return Math.min(1, Math.max(0, 1 - complement));
}

function studentTCdf(value: number, degreesOfFreedom: number): number {
  if (value === 0) return 0.5;
  const x = degreesOfFreedom / (degreesOfFreedom + value * value);
  const beta = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5);
  return value > 0 ? 1 - beta / 2 : beta / 2;
}

function studentTQuantile(probability: number, degreesOfFreedom: number): number {
  if (probability <= 0 || probability >= 1)
    failA1("INVALID_STATISTICS_CONFIGURATION", "student-t quantile probability must be in (0, 1)");
  if (probability === 0.5) return 0;
  const sign = probability < 0.5 ? -1 : 1;
  const target = probability < 0.5 ? 1 - probability : probability;
  let low = 0;
  let high = 1;
  while (studentTCdf(high, degreesOfFreedom) < target) {
    high *= 2;
    if (!Number.isFinite(high) || high > 1e12)
      failA1("STATISTICS_NUMERICAL_FAILURE", "student-t quantile could not be bracketed");
  }
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, degreesOfFreedom) < target) low = middle;
    else high = middle;
  }
  return sign * ((low + high) / 2);
}

export function computeCompleteGridMeans(input: {
  observations: readonly CompleteGridMetricObservation[];
  case_ids: readonly string[];
  repeat_ids: readonly string[];
}): CompleteGridMeans {
  const cases = sortedUniqueIds(input.case_ids, "tester.case_ids");
  const repeats = sortedUniqueIds(input.repeat_ids, "tester.repeat_ids");
  const expected = new Set<string>();
  for (const caseId of cases)
    for (const repeatId of repeats) expected.add(`${caseId}\u0000${repeatId}`);
  if (input.observations.length !== expected.size)
    failA1("STATISTICS_GRID_INCOMPLETE", "tester observations do not cover the full grid");
  const seen = new Set<string>();
  const metricValues = new Map<string, number[]>();
  const constraintValues = new Map<string, number[]>();
  for (const [index, observation] of input.observations.entries()) {
    const caseId = assertIdentifier(observation.case_id, `tester.observations[${index}].case_id`);
    const repeatId = assertIdentifier(
      observation.repeat_id,
      `tester.observations[${index}].repeat_id`,
    );
    const key = `${caseId}\u0000${repeatId}`;
    if (!expected.has(key) || seen.has(key))
      failA1("STATISTICS_PAIR_MISMATCH", "tester observations must be a unique Cartesian product");
    seen.add(key);
    for (const [name, value] of Object.entries(observation.metrics)) {
      const values = metricValues.get(name) ?? [];
      values.push(requireFiniteNumber(value, `tester.observations[${index}].metrics.${name}`));
      metricValues.set(name, values);
    }
    for (const [name, value] of Object.entries(observation.constraint_metrics)) {
      const values = constraintValues.get(name) ?? [];
      values.push(
        requireFiniteNumber(value, `tester.observations[${index}].constraint_metrics.${name}`),
      );
      constraintValues.set(name, values);
    }
  }
  if (seen.size !== expected.size)
    failA1("STATISTICS_GRID_INCOMPLETE", "tester observations are missing grid cells");
  const toRecord = (values: Map<string, number[]>): Record<string, number> =>
    Object.fromEntries(
      [...values.entries()]
        .sort(([left], [right]) => compareIdentityStrings(left, right))
        .map(([name, entries]) => [name, average(entries)]),
    );
  return { metrics: toRecord(metricValues), constraint_metrics: toRecord(constraintValues) };
}

export function computePairedStatistics(input: {
  metric_name: string;
  direction: "higher_better" | "lower_better";
  config: PairedStatisticsConfig;
  case_ids: readonly string[];
  repeat_ids: readonly string[];
  observations: readonly PairedScoreObservation[];
}): PairedStatistics {
  assertIdentifier(input.metric_name, "statistics.metric_name");
  if (input.direction !== "higher_better" && input.direction !== "lower_better")
    failA1("INVALID_STATISTICS_CONFIGURATION", "statistics direction is invalid");
  validateConfig(input.config);
  const grid = validateObservationGrid(input.observations, input.case_ids, input.repeat_ids);
  if (grid.repeats.length < input.config.min_repeats)
    failA1(
      "STATISTICS_NOT_ENOUGH_REPEATS",
      `tester has ${grid.repeats.length} repeats but requires at least ${input.config.min_repeats}`,
    );
  const direction = input.direction;
  const directionalDelta = (baseline: number, finalist: number): number =>
    direction === "higher_better" ? finalist - baseline : baseline - finalist;
  const caseMeans: PairedCaseMean[] = grid.cases.map((caseId) => {
    const values = grid.values.filter((value) => value.case_id === caseId);
    const baselineMean = average(values.map((value) => value.baseline));
    const finalistMean = average(values.map((value) => value.finalist));
    return {
      case_id: caseId,
      baseline_mean: baselineMean,
      finalist_mean: finalistMean,
      directional_delta: directionalDelta(baselineMean, finalistMean),
    };
  });
  const repeatMeans: PairedRepeatMean[] = grid.repeats.map((repeatId) => {
    const values = grid.values.filter((value) => value.repeat_id === repeatId);
    const baselineCaseMean = average(values.map((value) => value.baseline));
    const finalistCaseMean = average(values.map((value) => value.finalist));
    return {
      repeat_id: repeatId,
      baseline_case_mean: baselineCaseMean,
      finalist_case_mean: finalistCaseMean,
      directional_delta: directionalDelta(baselineCaseMean, finalistCaseMean),
    };
  });
  const repeatDeltas = repeatMeans.map((repeat) => repeat.directional_delta);
  const meanDelta = average(repeatDeltas);
  const standardDeviation = sampleStandardDeviation(repeatDeltas, meanDelta);
  const standardError = standardDeviation / Math.sqrt(repeatDeltas.length);
  const degreesOfFreedom = repeatDeltas.length - 1;
  const criticalValue = studentTQuantile(input.config.confidence_level, degreesOfFreedom);
  const lowerConfidenceBound = meanDelta - criticalValue * standardError;
  return {
    method: input.config.method,
    confidence_level: input.config.confidence_level,
    min_repeats: input.config.min_repeats,
    direction,
    case_count: grid.cases.length,
    repeat_count: grid.repeats.length,
    baseline_mean: average(repeatMeans.map((repeat) => repeat.baseline_case_mean)),
    finalist_mean: average(repeatMeans.map((repeat) => repeat.finalist_case_mean)),
    mean_delta: meanDelta,
    sample_standard_deviation: standardDeviation,
    standard_error: standardError,
    degrees_of_freedom: degreesOfFreedom,
    critical_value: criticalValue,
    lower_confidence_bound: requireFiniteNumber(
      lowerConfidenceBound,
      "statistics.lower_confidence_bound",
    ),
    upper_confidence_bound: requireFiniteNumber(
      meanDelta + criticalValue * standardError,
      "statistics.upper_confidence_bound",
    ),
    case_means: caseMeans,
    repeat_means: repeatMeans,
    repeat_deltas: repeatDeltas,
  };
}
