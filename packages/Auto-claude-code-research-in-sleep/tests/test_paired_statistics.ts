import assert from "node:assert/strict";
import { computePairedStatistics } from "../src/tools/paired-statistics.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

const observations = [
  { case_id: "case:1", repeat_id: "repeat:1", baseline: 10, finalist: 11 },
  { case_id: "case:2", repeat_id: "repeat:1", baseline: 20, finalist: 21 },
  { case_id: "case:1", repeat_id: "repeat:2", baseline: 11, finalist: 13 },
  { case_id: "case:2", repeat_id: "repeat:2", baseline: 21, finalist: 23 },
  { case_id: "case:1", repeat_id: "repeat:3", baseline: 12, finalist: 15 },
  { case_id: "case:2", repeat_id: "repeat:3", baseline: 22, finalist: 25 },
];

const statistics = computePairedStatistics({
  metric_name: "score",
  direction: "higher_better",
  config: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 3 },
  case_ids: ["case:1", "case:2"],
  repeat_ids: ["repeat:1", "repeat:2", "repeat:3"],
  observations,
});

assert.equal(statistics.case_count, 2);
assert.equal(statistics.repeat_count, 3);
assert.equal(statistics.baseline_mean, 16);
assert.equal(statistics.finalist_mean, 18);
assert.equal(statistics.mean_delta, 2);
assert.equal(statistics.degrees_of_freedom, 2);
assert.ok(Math.abs(statistics.critical_value - 2.919985580355516) < 1e-10);
assert.ok(Math.abs(statistics.lower_confidence_bound - 0.31414553915295174) < 1e-10);
assert.equal(statistics.case_means[0]?.directional_delta, 2);
assert.deepEqual(statistics.repeat_deltas, [1, 2, 3]);

const lowerIsBetter = computePairedStatistics({
  metric_name: "latency",
  direction: "lower_better",
  config: { method: "paired_student_t", confidence_level: 0.9, min_repeats: 3 },
  case_ids: ["case:1", "case:2"],
  repeat_ids: ["repeat:1", "repeat:2", "repeat:3"],
  observations: observations.map((observation) => ({
    ...observation,
    baseline: observation.finalist,
    finalist: observation.baseline,
  })),
});
assert.equal(lowerIsBetter.mean_delta, 2);
assert.ok(lowerIsBetter.lower_confidence_bound > 0);

expectCode(
  () =>
    computePairedStatistics({
      metric_name: "score",
      direction: "higher_better",
      config: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 3 },
      case_ids: ["case:1", "case:2"],
      repeat_ids: ["repeat:1", "repeat:2", "repeat:3"],
      observations: observations.slice(0, -1),
    }),
  "STATISTICS_GRID_INCOMPLETE",
);
expectCode(
  () =>
    computePairedStatistics({
      metric_name: "score",
      direction: "higher_better",
      config: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 4 },
      case_ids: ["case:1", "case:2"],
      repeat_ids: ["repeat:1", "repeat:2", "repeat:3"],
      observations,
    }),
  "STATISTICS_NOT_ENOUGH_REPEATS",
);
expectCode(
  () =>
    computePairedStatistics({
      metric_name: "score",
      direction: "higher_better",
      config: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 3 },
      case_ids: ["case:1", "case:2"],
      repeat_ids: ["repeat:1", "repeat:2", "repeat:3"],
      observations: observations.map((observation, index) =>
        index === 0 ? { ...observation, baseline: Number.NaN } : observation,
      ),
    }),
  "INVALID_VALUE",
);

console.log("test_paired_statistics: ok");
