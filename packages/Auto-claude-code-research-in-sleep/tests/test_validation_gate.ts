import assert from "node:assert/strict";
import {
  selectUniqueFinalist,
  validationBindingSha256,
  validationEvidenceSetSha256,
  type ValidationBinding,
  type ValidationCellResult,
  type ValidationReview,
} from "../src/tools/validation-gate.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const plan = [
  { cell_id: "00" as const, module_ids: [] },
  { cell_id: "10" as const, module_ids: ["module:a"] },
  { cell_id: "01" as const, module_ids: ["module:b"] },
  { cell_id: "11" as const, module_ids: ["module:a", "module:b"] },
];

const binding: ValidationBinding = {
  active_scorer_revision: "scorer:v1",
  model_assignment_sha256: HASH_A,
  sample_plan_sha256: HASH_B,
  repeat_ids: ["repeat:1", "repeat:2"],
};

function results(): ValidationCellResult[] {
  return [
    {
      cell_id: "00",
      candidate_id: "candidate:00",
      status: "succeeded",
      complete: true,
      primary_score: 1,
      hard_constraints_passed: true,
      cost: 1,
      changed_module_count: 0,
      binding,
      evidence: { evidence_bundle_id: "evidence:00", evidence_sha256: HASH_A },
    },
    {
      cell_id: "10",
      candidate_id: "candidate:10",
      status: "succeeded",
      complete: true,
      primary_score: 1.1,
      hard_constraints_passed: true,
      cost: 2,
      changed_module_count: 1,
      binding,
      evidence: { evidence_bundle_id: "evidence:10", evidence_sha256: HASH_A },
    },
    {
      cell_id: "01",
      candidate_id: "candidate:01",
      status: "succeeded",
      complete: true,
      primary_score: 1.2,
      hard_constraints_passed: true,
      cost: 2,
      changed_module_count: 1,
      binding,
      evidence: { evidence_bundle_id: "evidence:01", evidence_sha256: HASH_A },
    },
    {
      cell_id: "11",
      candidate_id: "candidate:11",
      status: "succeeded",
      complete: true,
      primary_score: 1.3,
      hard_constraints_passed: true,
      cost: 3,
      changed_module_count: 2,
      binding,
      evidence: { evidence_bundle_id: "evidence:11", evidence_sha256: HASH_A },
    },
  ];
}

function approvedReview(cellResults: readonly ValidationCellResult[]): ValidationReview {
  return {
    review_id: "review:validation-1",
    verdict: "approved",
    plan_id: "plan:v1",
    binding_sha256: validationBindingSha256(binding),
    evidence_set_sha256: validationEvidenceSetSha256(cellResults),
    reviewed_cell_ids: cellResults.map((result) => result.cell_id),
    reviewed_candidate_ids: cellResults.map((result) => result.candidate_id),
  };
}

const complete = results();
const selection = selectUniqueFinalist(plan, complete, {
  plan_id: "plan:v1",
  primary_direction: "higher_better",
  improvement: { policy: "relative", minimum_gain: 0.1 },
  binding,
  review: approvedReview(complete),
});
assert.equal(selection.selected_candidate_id, "candidate:11");
assert.equal(selection.selected_cell_id, "11");

const incomplete = complete.slice(0, -1);
const incompleteSelection = selectUniqueFinalist(plan, incomplete, {
  plan_id: "plan:v1",
  primary_direction: "higher_better",
  improvement: { policy: "relative", minimum_gain: 0.01 },
  binding,
  review: approvedReview(complete),
});
assert.equal(incompleteSelection.selected_candidate_id, null);
assert.equal(incompleteSelection.reason, "validation_incomplete");

const changedBinding = { ...binding, sample_plan_sha256: "c".repeat(64) };
const bindingMismatch = selectUniqueFinalist(
  plan,
  complete.map((result) =>
    result.cell_id === "10" ? { ...result, binding: changedBinding } : result,
  ),
  {
    plan_id: "plan:v1",
    primary_direction: "higher_better",
    improvement: { policy: "relative", minimum_gain: 0.01 },
    binding,
    review: approvedReview(complete),
  },
);
assert.equal(bindingMismatch.selected_candidate_id, null);
assert.equal(bindingMismatch.reason, "validation_binding_mismatch");

const rejectedReview = {
  ...approvedReview(complete),
  verdict: "rejected" as const,
};
const rejected = selectUniqueFinalist(plan, complete, {
  plan_id: "plan:v1",
  primary_direction: "higher_better",
  improvement: { policy: "relative", minimum_gain: 0.01 },
  binding,
  review: rejectedReview,
});
assert.equal(rejected.selected_candidate_id, null);
assert.equal(rejected.reason, "validation_review_rejected");

const zeroBaseline = complete.map((result) =>
  result.cell_id === "00" ? { ...result, primary_score: 0 } : result,
);
const zeroRelative = selectUniqueFinalist(plan, zeroBaseline, {
  plan_id: "plan:v1",
  primary_direction: "higher_better",
  improvement: { policy: "relative", minimum_gain: 0 },
  binding,
  review: approvedReview(zeroBaseline),
});
assert.equal(zeroRelative.reason, "zero_baseline_relative_policy");
const zeroAbsolute = selectUniqueFinalist(plan, zeroBaseline, {
  plan_id: "plan:v1",
  primary_direction: "higher_better",
  improvement: { policy: "absolute", minimum_gain: 1 },
  binding,
  review: approvedReview(zeroBaseline),
});
assert.equal(zeroAbsolute.selected_candidate_id, "candidate:11");

for (const status of ["not_executable", "infra_unavailable"] as const) {
  const blocked = complete.map((result) => result.cell_id === "10" ? { ...result, status } : result);
  const input = { plan_id: "plan:v1", primary_direction: "higher_better" as const,
    improvement: { policy: "absolute" as const, minimum_gain: 0 }, binding, review: approvedReview(blocked) };
  const first = selectUniqueFinalist(plan, blocked, input);
  assert.equal(first.selected_candidate_id, null);
  assert.equal(first.reason, "rejected_incompatible");
  assert.equal(JSON.stringify(first), JSON.stringify(selectUniqueFinalist(plan, blocked, input)));
}
const failedResult = complete.map((result) => ({ ...result, status: "failed" as const }));
assert.equal(selectUniqueFinalist(plan, failedResult, {
  plan_id: "plan:v1", primary_direction: "higher_better", improvement: { policy: "absolute", minimum_gain: 0 },
  binding, review: approvedReview(failedResult),
}).selected_candidate_id, "candidate:11");
for (const review of [null, { ...approvedReview(complete), verdict: "insufficient" as const }]) {
  assert.equal(selectUniqueFinalist(plan, complete, {
    plan_id: "plan:v1", primary_direction: "higher_better", improvement: { policy: "absolute", minimum_gain: 0 },
    binding, review,
  }).selected_candidate_id, null);
}
const narrowPlan = plan.filter((cell) => cell.cell_id === "00" || cell.cell_id === "10");
const narrowResults = complete.filter((cell) => cell.cell_id === "00" || cell.cell_id === "10");
assert.equal(selectUniqueFinalist(narrowPlan, narrowResults, {
  plan_id: "plan:v1", primary_direction: "higher_better", improvement: { policy: "absolute", minimum_gain: 0 },
  binding, review: approvedReview(narrowResults),
}).selected_candidate_id, "candidate:10");
console.log("validation gate: 12 passed, 0 failed");
