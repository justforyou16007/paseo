import { resultStatusPolicy, type ResultStatus } from "./result-package.js";
import { canonicalJsonSha256, canonicalJsonString } from "./canonical-json.js";
import {
  assertIdentifier,
  assertSha256,
  compareIdentityStrings,
  failA1,
  requireFiniteNumber,
  requireInteger,
} from "./workflow-spec.js";
import type { AblationCell } from "./workflow-compiler.js";

export interface ValidationBinding {
  active_scorer_revision: string;
  model_assignment_sha256: string;
  sample_plan_sha256: string;
  repeat_ids: string[];
}

export interface ValidationEvidence {
  evidence_bundle_id: string;
  evidence_sha256: string;
}

export interface ValidationCellResult {
  status: ResultStatus;
  cell_id: string;
  candidate_id: string;
  complete: boolean;
  primary_score: number;
  hard_constraints_passed: boolean;
  cost: number;
  changed_module_count: number;
  binding: ValidationBinding;
  evidence: ValidationEvidence;
}

export interface ValidationReview {
  review_id: string;
  verdict: "approved" | "rejected" | "insufficient";
  plan_id: string;
  binding_sha256: string;
  evidence_set_sha256: string;
  reviewed_cell_ids: string[];
  reviewed_candidate_ids: string[];
}

export interface ValidationFinalistSelection {
  selected_candidate_id: string | null;
  selected_cell_id: string | null;
  compared_cells: string[];
  reason:
    | "unique_validation_finalist"
    | "rejected_incompatible"
    | "validation_incomplete"
    | "validation_binding_mismatch"
    | "validation_evidence_mismatch"
    | "validation_review_rejected"
    | "validation_review_mismatch"
    | "no_validation_improvement"
    | "zero_baseline_relative_policy";
}

export interface ValidationImprovement {
  policy: "relative" | "absolute";
  minimum_gain: number;
}

function sortedUniqueIds(values: readonly string[], location: string): string[] {
  const normalized = values.map((value, index) => assertIdentifier(value, `${location}[${index}]`));
  if (new Set(normalized).size !== normalized.length)
    failA1("VALIDATION_INCOMPLETE", `${location} must not contain duplicate ids`);
  return [...normalized].sort(compareIdentityStrings);
}

function normalizeBinding(value: ValidationBinding, location: string): ValidationBinding {
  const repeatIds = sortedUniqueIds(value.repeat_ids, `${location}.repeat_ids`);
  if (repeatIds.length === 0)
    failA1("VALIDATION_INCOMPLETE", `${location}.repeat_ids must not be empty`);
  return {
    active_scorer_revision: assertIdentifier(
      value.active_scorer_revision,
      `${location}.active_scorer_revision`,
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      `${location}.model_assignment_sha256`,
    ),
    sample_plan_sha256: assertSha256(value.sample_plan_sha256, `${location}.sample_plan_sha256`),
    repeat_ids: repeatIds,
  };
}

export function validationBindingSha256(binding: ValidationBinding): string {
  const normalized = normalizeBinding(binding, "validation.binding");
  return canonicalJsonSha256(normalized, undefined, {
    schemaVersion: "validation-binding-v1",
  });
}

function normalizeEvidence(value: ValidationEvidence, location: string): ValidationEvidence {
  return {
    evidence_bundle_id: assertIdentifier(
      value.evidence_bundle_id,
      `${location}.evidence_bundle_id`,
    ),
    evidence_sha256: assertSha256(value.evidence_sha256, `${location}.evidence_sha256`),
  };
}

export function validationEvidenceSetSha256(results: readonly ValidationCellResult[]): string {
  const evidence = [...results]
    .map((result) => ({
      cell_id: assertIdentifier(result.cell_id, "validation.result.cell_id"),
      evidence: normalizeEvidence(result.evidence, "validation.result.evidence"),
    }))
    .sort((left, right) => compareIdentityStrings(left.cell_id, right.cell_id));
  return canonicalJsonSha256(evidence, undefined, { schemaVersion: "validation-evidence-v1" });
}

function emptySelection(
  results: readonly ValidationCellResult[],
  reason: ValidationFinalistSelection["reason"],
): ValidationFinalistSelection {
  return {
    selected_candidate_id: null,
    selected_cell_id: null,
    compared_cells: results.map((result) => result.cell_id),
    reason,
  };
}

function directionalGain(
  direction: "higher_better" | "lower_better",
  baseline: number,
  finalist: number,
): number {
  return direction === "higher_better" ? finalist - baseline : baseline - finalist;
}

function validateReview(
  review: ValidationReview,
  planId: string,
  planCellIds: readonly string[],
  results: readonly ValidationCellResult[],
  binding: ValidationBinding,
): ValidationFinalistSelection["reason"] | null {
  assertIdentifier(review.review_id, "validation.review.review_id");
  assertIdentifier(review.plan_id, "validation.review.plan_id");
  if (review.plan_id !== planId) return "validation_review_mismatch";
  if (
    review.verdict !== "approved" &&
    review.verdict !== "rejected" &&
    review.verdict !== "insufficient"
  )
    failA1("INVALID_TESTER_RESULT", "validation review verdict is invalid");
  const expectedBindingSha256 = validationBindingSha256(binding);
  if (
    assertSha256(review.binding_sha256, "validation.review.binding_sha256") !==
    expectedBindingSha256
  )
    return "validation_review_mismatch";
  const expectedEvidenceSha256 = validationEvidenceSetSha256(results);
  if (
    assertSha256(review.evidence_set_sha256, "validation.review.evidence_set_sha256") !==
    expectedEvidenceSha256
  )
    return "validation_review_mismatch";
  const expectedCellIds = sortedUniqueIds(planCellIds, "validation.review.reviewed_cell_ids");
  const reviewedCellIds = sortedUniqueIds(
    review.reviewed_cell_ids,
    "validation.review.reviewed_cell_ids",
  );
  if (canonicalJsonString(reviewedCellIds) !== canonicalJsonString(expectedCellIds))
    return "validation_review_mismatch";
  const expectedCandidateIds = sortedUniqueIds(
    results.map((result) => result.candidate_id),
    "validation.review.reviewed_candidate_ids",
  );
  const reviewedCandidateIds = sortedUniqueIds(
    review.reviewed_candidate_ids,
    "validation.review.reviewed_candidate_ids",
  );
  if (canonicalJsonString(reviewedCandidateIds) !== canonicalJsonString(expectedCandidateIds))
    return "validation_review_mismatch";
  return review.verdict === "approved" ? null : "validation_review_rejected";
}

export function selectUniqueFinalist(
  plan: readonly AblationCell[],
  results: readonly ValidationCellResult[],
  input: {
    plan_id: string;
    primary_direction: "higher_better" | "lower_better";
    improvement: ValidationImprovement;
    binding: ValidationBinding;
    review: ValidationReview | null;
  },
): ValidationFinalistSelection {
  const planId = assertIdentifier(input.plan_id, "validation.plan_id");
  if (!Number.isFinite(input.improvement.minimum_gain) || input.improvement.minimum_gain < 0)
    failA1("INVALID_TESTER_RESULT", "validation minimum_gain must be a non-negative finite number");
  if (input.improvement.policy !== "relative" && input.improvement.policy !== "absolute")
    failA1("INVALID_TESTER_RESULT", "validation improvement policy is invalid");
  const normalizedBinding = normalizeBinding(input.binding, "validation.binding");
  if (plan.length === 0 || new Set(plan.map((cell) => cell.cell_id)).size !== plan.length)
    failA1("VALIDATION_INCOMPLETE", "validation plan cell ids must be unique");
  for (const cell of plan) {
    assertIdentifier(cell.cell_id, "validation.plan.cell_id");
    if (new Set(cell.module_ids).size !== cell.module_ids.length)
      failA1(
        "VALIDATION_INCOMPLETE",
        `validation cell '${cell.cell_id}' contains duplicate modules`,
      );
    cell.module_ids.forEach((moduleId) =>
      assertIdentifier(moduleId, `validation.plan.${cell.cell_id}.module_ids`),
    );
  }
  const planCellIds = plan.map((cell) => cell.cell_id);
  const expectedIds = new Set(planCellIds);
  const actualIds = new Set(results.map((result) => result.cell_id));
  if (
    actualIds.size !== results.length ||
    actualIds.size !== expectedIds.size ||
    [...expectedIds].some((id) => !actualIds.has(id))
  )
    return emptySelection(results, "validation_incomplete");
  const planByCell = new Map<string, AblationCell>(plan.map((cell) => [cell.cell_id, cell]));
  const knownStatuses: readonly ResultStatus[] = [
    "succeeded",
    "failed",
    "not_executable",
    "infra_unavailable",
  ];
  for (const result of results) {
    assertIdentifier(result.cell_id, "validation.result.cell_id");
    // resultStatusPolicy treats every unrecognised value as "does not enter
    // validation", so a missing status would silently empty the selection.
    if (!knownStatuses.includes(result.status))
      failA1(
        "INVALID_TESTER_RESULT",
        `validation result '${result.cell_id}' has no recognised result status`,
      );
    assertIdentifier(result.candidate_id, "validation.result.candidate_id");
    if (typeof result.complete !== "boolean" || typeof result.hard_constraints_passed !== "boolean")
      failA1(
        "INVALID_TESTER_RESULT",
        "validation completeness and hard constraints must be boolean",
      );
    requireFiniteNumber(result.primary_score, "validation.result.primary_score");
    requireFiniteNumber(result.cost, "validation.result.cost");
    requireInteger(result.changed_module_count, "validation.result.changed_module_count", 0);
    if (result.cost < 0)
      failA1("INVALID_TESTER_RESULT", "validation result cost cannot be negative");
    const planCell = planByCell.get(result.cell_id);
    if (!planCell || result.changed_module_count !== planCell.module_ids.length)
      failA1(
        "VALIDATION_INCOMPLETE",
        `validation cell '${result.cell_id}' does not match its planned module count`,
      );
    const resultBinding = normalizeBinding(
      result.binding,
      `validation.result.${result.cell_id}.binding`,
    );
    if (canonicalJsonString(resultBinding) !== canonicalJsonString(normalizedBinding))
      return emptySelection(results, "validation_binding_mismatch");
    normalizeEvidence(result.evidence, `validation.result.${result.cell_id}.evidence`);
  }
  if (new Set(results.map((result) => result.candidate_id)).size !== results.length)
    failA1("VALIDATION_INCOMPLETE", "validation candidate ids must be unique");
  if (results.some((result) => !resultStatusPolicy(result.status).enters_validation))
    return emptySelection(results, "rejected_incompatible");
  if (input.review === null) return emptySelection(results, "validation_review_rejected");
  const reviewReason = validateReview(
    input.review,
    planId,
    planCellIds,
    results,
    normalizedBinding,
  );
  if (reviewReason !== null) return emptySelection(results, reviewReason);
  if (results.some((result) => !result.complete))
    return emptySelection(results, "validation_incomplete");
  const baselineCells = results.filter(
    (result) => result.cell_id === "00" || result.cell_id === "S0",
  );
  if (baselineCells.length !== 1)
    failA1(
      "VALIDATION_BASELINE_INVALID",
      "validation must contain exactly one matching baseline cell",
    );
  const baseline = baselineCells[0];
  if (!baseline) return emptySelection(results, "validation_incomplete");
  if (!baseline.hard_constraints_passed)
    failA1(
      "VALIDATION_BASELINE_INVALID",
      "matching validation baseline must satisfy hard constraints",
    );
  if (input.improvement.policy === "relative" && baseline.primary_score === 0)
    return emptySelection(results, "zero_baseline_relative_policy");
  const eligible = results
    .filter((result) => result !== baseline && result.complete && result.hard_constraints_passed)
    .filter((result) => {
      const delta = directionalGain(
        input.primary_direction,
        baseline.primary_score,
        result.primary_score,
      );
      const gain =
        input.improvement.policy === "relative" ? delta / Math.abs(baseline.primary_score) : delta;
      return gain >= input.improvement.minimum_gain && delta > 0;
    });
  if (eligible.length === 0) return emptySelection(results, "no_validation_improvement");
  const gainFor = (result: ValidationCellResult): number => {
    const delta = directionalGain(
      input.primary_direction,
      baseline.primary_score,
      result.primary_score,
    );
    return input.improvement.policy === "relative"
      ? delta / Math.abs(baseline.primary_score)
      : delta;
  };
  const sorted = [...eligible].sort((left, right) => {
    const leftGain = gainFor(left);
    const rightGain = gainFor(right);
    if (leftGain !== rightGain) return rightGain - leftGain;
    if (left.cost !== right.cost) return left.cost - right.cost;
    if (left.changed_module_count !== right.changed_module_count)
      return left.changed_module_count - right.changed_module_count;
    return compareIdentityStrings(left.candidate_id, right.candidate_id);
  });
  const selected = sorted[0];
  if (!selected) return emptySelection(results, "no_validation_improvement");
  return {
    selected_candidate_id: selected.candidate_id,
    selected_cell_id: selected.cell_id,
    compared_cells: results.map((result) => result.cell_id),
    reason: "unique_validation_finalist",
  };
}

export type { ValidationCellResult as ValidationResult };
