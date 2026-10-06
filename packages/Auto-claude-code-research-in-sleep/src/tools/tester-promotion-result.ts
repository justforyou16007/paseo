import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireInteger,
} from "./workflow-spec.js";
import { readStateFile } from "./state-file.js";
import { sanitizeTesterFeedback, type TesterFeedback } from "./tester-feedback.js";
import { readAuditedTesterResult, type TesterTestResult } from "./tester-facility.js";
export interface TesterPromotionConclusion {
  schema_version: 1;
  tester_run_id: string;
  outer_run_id: string;
  task_id: string;
  promotion_trial_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  input_snapshot_sha256: string;
  input_distribution_sha256: string;
  model_assignment_sha256: string;
  test_result_sha256: string;
  review_receipt_sha256: string;
  status: "passed" | "rejected";
}

/**
 * The promotion feedback carries the research feedback and its run bindings.  The
 * binding fields make it impossible to detach a harmless-looking feedback
 * message from the tester run and gate result it describes.
 */
export interface TesterPromotionFeedback {
  schema_version: 1;
  tester_run_id: string;
  outer_run_id: string;
  task_id: string;
  promotion_trial_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  input_snapshot_sha256: string;
  input_distribution_sha256: string;
  tester_version: string;
  tester_conclusion_status: "passed" | "rejected";
  feedback: TesterFeedback;
}

export function validateTesterPromotionConclusion(value: unknown): TesterPromotionConclusion {
  if (!isRecord(value)) failA1("INVALID_TESTER_CONCLUSION", "public conclusion must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "tester_run_id",
      "outer_run_id",
      "task_id",
      "promotion_trial_id",
      "outer_iteration",
      "generation",
      "wave_id",
      "tester_definition_sha256",
      "harness_sha256",
      "matching_baseline_artifact_sha256",
      "finalist_artifact_sha256",
      "input_snapshot_sha256",
      "input_distribution_sha256",
      "model_assignment_sha256",
      "test_result_sha256",
      "review_receipt_sha256",
      "status",
    ],
    "tester_conclusion",
  );
  if (value.schema_version !== 1 || (value.status !== "passed" && value.status !== "rejected"))
    failA1("INVALID_TESTER_CONCLUSION", "only terminal tester conclusions can be exported");
  return {
    schema_version: 1,
    tester_run_id: assertIdentifier(value.tester_run_id, "tester_run_id"),
    outer_run_id: assertIdentifier(value.outer_run_id, "outer_run_id"),
    task_id: assertIdentifier(value.task_id, "task_id"),
    promotion_trial_id: assertIdentifier(value.promotion_trial_id, "promotion_trial_id"),
    outer_iteration: requireInteger(value.outer_iteration, "outer_iteration", 1),
    generation: requireInteger(value.generation, "generation", 0),
    wave_id: assertIdentifier(value.wave_id, "wave_id"),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      "tester_definition_sha256",
    ),
    harness_sha256: assertSha256(value.harness_sha256, "harness_sha256"),
    matching_baseline_artifact_sha256: assertSha256(
      value.matching_baseline_artifact_sha256,
      "matching_baseline_artifact_sha256",
    ),
    finalist_artifact_sha256: assertSha256(
      value.finalist_artifact_sha256,
      "finalist_artifact_sha256",
    ),
    input_snapshot_sha256: assertSha256(value.input_snapshot_sha256, "input_snapshot_sha256"),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      "input_distribution_sha256",
    ),
    model_assignment_sha256: assertSha256(value.model_assignment_sha256, "model_assignment_sha256"),
    test_result_sha256: assertSha256(value.test_result_sha256, "test_result_sha256"),
    review_receipt_sha256: assertSha256(value.review_receipt_sha256, "review_receipt_sha256"),
    status: value.status,
  };
}
export function validateTesterPromotionFeedback(value: unknown): TesterPromotionFeedback {
  if (!isRecord(value))
    failA1("INVALID_TESTER_FEEDBACK_RECEIPT", "feedback receipt must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "tester_run_id",
      "outer_run_id",
      "task_id",
      "promotion_trial_id",
      "outer_iteration",
      "generation",
      "wave_id",
      "tester_definition_sha256",
      "harness_sha256",
      "matching_baseline_artifact_sha256",
      "finalist_artifact_sha256",
      "input_snapshot_sha256",
      "input_distribution_sha256",
      "tester_version",
      "tester_conclusion_status",
      "feedback",
    ],
    "tester_feedback_receipt",
  );
  if (value.schema_version !== 1)
    failA1("INVALID_TESTER_FEEDBACK_RECEIPT", "feedback receipt schema_version must be 1");
  if (value.tester_conclusion_status !== "passed" && value.tester_conclusion_status !== "rejected")
    failA1(
      "INVALID_TESTER_FEEDBACK_RECEIPT",
      "feedback receipt must name a terminal tester conclusion",
    );
  const feedback = sanitizeTesterFeedback(value.feedback);
  const testerRunId = assertIdentifier(
    value.tester_run_id,
    "tester_feedback_receipt.tester_run_id",
  );
  const outerRunId = assertIdentifier(value.outer_run_id, "tester_feedback_receipt.outer_run_id");
  const taskId = assertIdentifier(value.task_id, "tester_feedback_receipt.task_id");
  const promotionTrialId = assertIdentifier(
    value.promotion_trial_id,
    "tester_feedback_receipt.promotion_trial_id",
  );
  const inputSnapshotSha256 = assertSha256(
    value.input_snapshot_sha256,
    "tester_feedback_receipt.input_snapshot_sha256",
  );
  const testerVersion = assertIdentifier(
    value.tester_version,
    "tester_feedback_receipt.tester_version",
  );
  const status = value.tester_conclusion_status;
  if (
    feedback.task_id !== taskId ||
    feedback.promotion_trial_id !== promotionTrialId ||
    feedback.input_snapshot_sha256 !== inputSnapshotSha256 ||
    feedback.tester_version !== testerVersion ||
    (status === "passed" && feedback.conclusion !== "improved") ||
    (status === "rejected" && feedback.conclusion === "improved")
  )
    failA1(
      "TESTER_FEEDBACK_NOT_READY",
      "feedback receipt content does not match its tester binding",
    );
  return {
    schema_version: 1,
    tester_run_id: testerRunId,
    outer_run_id: outerRunId,
    task_id: taskId,
    promotion_trial_id: promotionTrialId,
    outer_iteration: requireInteger(
      value.outer_iteration,
      "tester_feedback_receipt.outer_iteration",
      1,
    ),
    generation: requireInteger(value.generation, "tester_feedback_receipt.generation", 0),
    wave_id: assertIdentifier(value.wave_id, "tester_feedback_receipt.wave_id"),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      "tester_feedback_receipt.tester_definition_sha256",
    ),
    harness_sha256: assertSha256(value.harness_sha256, "tester_feedback_receipt.harness_sha256"),
    matching_baseline_artifact_sha256: assertSha256(
      value.matching_baseline_artifact_sha256,
      "tester_feedback_receipt.matching_baseline_artifact_sha256",
    ),
    finalist_artifact_sha256: assertSha256(
      value.finalist_artifact_sha256,
      "tester_feedback_receipt.finalist_artifact_sha256",
    ),
    input_snapshot_sha256: inputSnapshotSha256,
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      "tester_feedback_receipt.input_distribution_sha256",
    ),
    tester_version: testerVersion,
    tester_conclusion_status: status,
    feedback,
  };
}

export interface AuditedTesterResultReference {
  result_path: string;
  audit_path: string;
}
function promotionData(ref: AuditedTesterResultReference): {
  result: TesterTestResult;
  data: Record<string, unknown>;
} {
  const { result } = readAuditedTesterResult(ref.result_path, ref.audit_path);
  const output = readStateFile<Record<string, unknown>>(result.evidence[0]!.path);
  if (!isRecord(output.promotion))
    failA1(
      "TESTER_PROMOTION_RESULT_REQUIRED",
      "benchmark adapter must produce promotion binding for workflow promotion",
    );
  return { result, data: output.promotion };
}
export function readAuditedTesterConclusion(
  ref: AuditedTesterResultReference,
): TesterPromotionConclusion {
  const { result, data } = promotionData(ref);
  const conclusion = validateTesterPromotionConclusion(data.conclusion);
  if (
    conclusion.outer_run_id !== result.request.run_id ||
    conclusion.outer_iteration !== result.request.iteration ||
    conclusion.finalist_artifact_sha256 !== result.request.artifact.sha256
  )
    failA1(
      "TESTER_RESULT_BINDING_MISMATCH",
      "promotion conclusion does not identify the audited test",
    );
  return conclusion;
}
export function readAuditedTesterFeedback(
  ref: AuditedTesterResultReference,
): TesterPromotionFeedback {
  const { result, data } = promotionData(ref);
  const feedback = validateTesterPromotionFeedback(data.feedback);
  if (
    feedback.outer_run_id !== result.request.run_id ||
    feedback.outer_iteration !== result.request.iteration ||
    feedback.finalist_artifact_sha256 !== result.request.artifact.sha256
  )
    failA1(
      "TESTER_RESULT_BINDING_MISMATCH",
      "promotion feedback does not identify the audited test",
    );
  return feedback;
}
