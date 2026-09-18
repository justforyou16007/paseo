import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalJsonBytes } from "../src/tools/canonical-json.js";
import { buildTesterFeedback } from "../src/tools/tester-feedback.js";
import {
  validateTesterPublicConclusion,
  validateTesterPublicFeedback,
  verifyTesterConclusion,
  verifyTesterFeedback,
} from "../src/tools/tester-public-receipt.js";
const h = "a".repeat(64);
const conclusion = validateTesterPublicConclusion({
  schema_version: 1,
  tester_run_id: "tester-1",
  outer_run_id: "outer-1",
  task_id: "task:1",
  promotion_trial_id: "trial:1",
  outer_iteration: 1,
  generation: 0,
  wave_id: "wave:1",
  tester_definition_sha256: h,
  harness_sha256: h,
  matching_baseline_artifact_sha256: h,
  finalist_artifact_sha256: "b".repeat(64),
  input_snapshot_sha256: h,
  input_distribution_sha256: h,
  model_assignment_sha256: h,
  private_result_sha256: h,
  review_receipt_sha256: h,
  status: "passed",
});
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const signature = crypto
  .sign(
    null,
    Buffer.concat([
      Buffer.from("aris-tester-public-conclusion-v1\n"),
      canonicalJsonBytes(conclusion),
    ]),
    privateKey,
  )
  .toString("base64");
const receipt = { conclusion, signature };
assert.deepEqual(verifyTesterConclusion(receipt, publicKey), conclusion);
for (const field of [
  "outer_run_id",
  "promotion_trial_id",
  "finalist_artifact_sha256",
  "harness_sha256",
  "status",
]) {
  const value = field.endsWith("sha256")
    ? "c".repeat(64)
    : field === "status"
      ? "rejected"
      : "other:1";
  assert.throws(
    () =>
      verifyTesterConclusion(
        { ...receipt, conclusion: { ...conclusion, [field]: value } },
        publicKey,
      ),
    /signature/,
  );
}
assert.throws(
  () => verifyTesterConclusion(receipt, crypto.generateKeyPairSync("ed25519").publicKey),
  /signature/,
);
assert.throws(
  () =>
    verifyTesterConclusion(
      { ...receipt, conclusion: { ...conclusion, observations: [] } },
      publicKey,
    ),
  /unknown/i,
);
assert.throws(
  () => verifyTesterConclusion({ ...receipt, signature: "invalid" }, publicKey),
  /signature/,
);

const feedback = buildTesterFeedback({
  schema_version: 1,
  task_id: "task:1",
  task_setup_revision: "setup:1",
  input_snapshot_sha256: h,
  promotion_trial_id: "trial:1",
  tester_version: "tester:v1",
  conclusion: "improved",
  directions: ["long_horizon_stability"],
  advice: ["increase_long_horizon_consistency"],
  confidence: "high",
  metrics: { tester_score: 0.9 },
});
const feedbackEnvelope = validateTesterPublicFeedback({
  schema_version: 1,
  tester_run_id: conclusion.tester_run_id,
  outer_run_id: conclusion.outer_run_id,
  task_id: conclusion.task_id,
  promotion_trial_id: conclusion.promotion_trial_id,
  outer_iteration: conclusion.outer_iteration,
  generation: conclusion.generation,
  wave_id: conclusion.wave_id,
  tester_definition_sha256: conclusion.tester_definition_sha256,
  harness_sha256: conclusion.harness_sha256,
  matching_baseline_artifact_sha256: conclusion.matching_baseline_artifact_sha256,
  finalist_artifact_sha256: conclusion.finalist_artifact_sha256,
  input_snapshot_sha256: conclusion.input_snapshot_sha256,
  input_distribution_sha256: conclusion.input_distribution_sha256,
  tester_version: "tester:v1",
  tester_conclusion_status: "passed",
  feedback,
});
const feedbackKeyPair = crypto.generateKeyPairSync("ed25519");
const feedbackSignature = crypto
  .sign(
    null,
    Buffer.concat([
      Buffer.from("aris-tester-public-feedback-v1\n"),
      canonicalJsonBytes(feedbackEnvelope),
    ]),
    feedbackKeyPair.privateKey,
  )
  .toString("base64");
const signedFeedback = { feedback: feedbackEnvelope, signature: feedbackSignature };
assert.deepEqual(verifyTesterFeedback(signedFeedback, feedbackKeyPair.publicKey), feedbackEnvelope);
assert.throws(
  () =>
    verifyTesterFeedback(
      { ...signedFeedback, feedback: { ...feedbackEnvelope, promotion_trial_id: "trial:2" } },
      feedbackKeyPair.publicKey,
    ),
  /signature|feedback/i,
);
assert.throws(
  () => verifyTesterFeedback(signedFeedback, crypto.generateKeyPairSync("ed25519").publicKey),
  /signature/,
);
assert.throws(
  () => validateTesterPublicFeedback({ ...feedbackEnvelope, feedback: { ...feedback, score: 1 } }),
  /private|unknown/i,
);
assert.throws(
  () => validateTesterPublicFeedback({ ...feedbackEnvelope, tester_conclusion_status: "rejected" }),
  /feedback|conclusion/i,
);
console.log(
  "tester public receipt: authentic signatures, feedback binding and private-field rejection passed",
);
