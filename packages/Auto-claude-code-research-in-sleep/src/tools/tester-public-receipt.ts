import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonBytes } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import {
  assertProtectedPath,
  checkTesterIsolation,
  readTesterIsolationConfig,
} from "./tester-isolation.js";
import {
  readTesterRunState,
  readStoredTesterReview,
  readExposureLedger,
  savePrivateResultReference,
  sealPrivateTesterResult,
  testerDashboardPath,
  testerDefinitionPath,
  testerRunStatePath,
  validateTesterDefinition,
  type TesterRunState,
} from "./tester-state.js";
import { sanitizeTesterFeedback, type TesterFeedback } from "./tester-feedback.js";

export interface TesterPublicConclusion {
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
  private_result_sha256: string;
  review_receipt_sha256: string;
  status: "passed" | "rejected";
}
export interface SignedTesterConclusion {
  conclusion: TesterPublicConclusion;
  signature: string;
}

/**
 * The feedback receipt contains only the coarse, public vocabulary.  The
 * binding fields make it impossible to detach a harmless-looking feedback
 * message from the tester run and gate result it describes.
 */
export interface TesterPublicFeedbackEnvelope {
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

export interface SignedTesterFeedback {
  feedback: TesterPublicFeedbackEnvelope;
  signature: string;
}

export function validateTesterPublicConclusion(value: unknown): TesterPublicConclusion {
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
      "private_result_sha256",
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
    private_result_sha256: assertSha256(value.private_result_sha256, "private_result_sha256"),
    review_receipt_sha256: assertSha256(value.review_receipt_sha256, "review_receipt_sha256"),
    status: value.status,
  };
}
function signedBytes(value: TesterPublicConclusion): Buffer {
  return Buffer.concat([
    Buffer.from("aris-tester-public-conclusion-v1\n"),
    canonicalJsonBytes(value),
  ]);
}

function feedbackSignedBytes(value: TesterPublicFeedbackEnvelope): Buffer {
  return Buffer.concat([
    Buffer.from("aris-tester-public-feedback-v1\n"),
    canonicalJsonBytes(value),
  ]);
}

function publicReceiptFilePath(receiptPath: string): string {
  if (!fs.existsSync(receiptPath))
    failA1("TESTER_PUBLIC_RECEIPT_REQUIRED", "public tester receipt does not exist");
  const resolved = fs.realpathSync(receiptPath);
  if (!fs.statSync(resolved).isFile())
    failA1("TESTER_PUBLIC_RECEIPT_REQUIRED", "public tester receipt must be a file");
  const basename = path.basename(resolved);
  if (basename === "private-result.json" || basename === "private-result.ref.json")
    failA1("TESTER_PRIVATE_DATA_ACCESSIBLE", "private tester data cannot be imported as a receipt");
  return resolved;
}

// Pure verification is useful for transport tests; production callers must use the protected key loader below.
export function verifyTesterConclusion(
  value: unknown,
  publicKey: crypto.KeyObject,
): TesterPublicConclusion {
  if (!isRecord(value)) failA1("INVALID_TESTER_CONCLUSION", "signed conclusion must be an object");
  assertNoUnknownFields(value, ["conclusion", "signature"], "signed_conclusion");
  const conclusion = validateTesterPublicConclusion(value.conclusion);
  const signature = requireString(value.signature, "signature");
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
    !crypto.verify(null, signedBytes(conclusion), publicKey, Buffer.from(signature, "base64"))
  )
    failA1("TESTER_SIGNATURE_INVALID", "tester conclusion signature is invalid");
  return conclusion;
}

export function readVerifiedTesterConclusion(
  receiptPath: string,
  publicKeyPath: string,
): TesterPublicConclusion {
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath));
  return verifyTesterConclusion(readStateFile(publicReceiptFilePath(receiptPath)), publicKey);
}

export function validateTesterPublicFeedback(value: unknown): TesterPublicFeedbackEnvelope {
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

// Pure verification is used by the research-side bridge after it has loaded a
// root-owned public key.  It never opens a tester private result or review.
export function verifyTesterFeedback(
  value: unknown,
  publicKey: crypto.KeyObject,
): TesterPublicFeedbackEnvelope {
  if (!isRecord(value))
    failA1("INVALID_TESTER_FEEDBACK_RECEIPT", "signed feedback must be an object");
  assertNoUnknownFields(value, ["feedback", "signature"], "signed_tester_feedback");
  const feedback = validateTesterPublicFeedback(value.feedback);
  const signature = requireString(value.signature, "signature");
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
    !crypto.verify(null, feedbackSignedBytes(feedback), publicKey, Buffer.from(signature, "base64"))
  )
    failA1("TESTER_SIGNATURE_INVALID", "tester feedback signature is invalid");
  return feedback;
}

export function readVerifiedTesterFeedback(
  receiptPath: string,
  publicKeyPath: string,
): TesterPublicFeedbackEnvelope {
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath));
  return verifyTesterFeedback(readStateFile(publicReceiptFilePath(receiptPath)), publicKey);
}

function privateFilePath(
  project: string,
  requestedPath: string,
  isolation: ReturnType<typeof readTesterIsolationConfig>,
): string {
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(project, requestedPath);
  if (!fs.existsSync(candidate))
    failA1("TESTER_FEEDBACK_REQUIRED", `tester feedback draft does not exist at ${candidate}`);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(project, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    failA1(
      "TESTER_PRIVATE_PATH_REQUIRED",
      "tester feedback draft must be below the private project",
    );
  if (!fs.statSync(resolved).isFile())
    failA1("TESTER_FEEDBACK_REQUIRED", "tester feedback draft must be a file");
  assertProtectedPath(resolved, [0, isolation.tester_uid]);
  return resolved;
}

function feedbackBindingFromTesterState(
  state: TesterRunState,
  feedback: unknown,
): TesterPublicFeedbackEnvelope {
  if (
    !state.gate_consumed ||
    (state.status !== "passed" && state.status !== "rejected") ||
    state.gate_status !== state.status ||
    state.private_result_sha256 === null ||
    state.review_receipt_sha256 === null
  )
    failA1(
      "TESTER_REVIEW_REQUIRED",
      "feedback export requires a terminal tester state with a consumed gate",
    );
  return validateTesterPublicFeedback({
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    outer_run_id: state.outer_run_id,
    task_id: state.task_id,
    promotion_trial_id: state.promotion_trial_id,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    wave_id: state.wave_id,
    tester_definition_sha256: state.tester_definition_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    input_snapshot_sha256: state.input_snapshot_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    tester_version: state.tester_version,
    tester_conclusion_status: state.status,
    feedback,
  });
}

/**
 * Legacy local export retained for receipt replay tests. The public workflow
 * uses signed receipts returned by the remote tester; checkTesterIsolation
 * rejects this local path before it can read a private run.
 */
export function exportTesterFeedback(input: {
  isolation_config: string;
  private_project_root: string;
  tester_run_id: string;
  feedback_path: string;
  signing_key_path: string;
}): SignedTesterFeedback {
  const isolation = readTesterIsolationConfig(input.isolation_config);
  checkTesterIsolation(isolation, "tester");
  const project = fs.realpathSync(input.private_project_root);
  const keyPath = fs.realpathSync(input.signing_key_path);
  for (const privatePath of [project, keyPath]) {
    if (!privatePath.startsWith(`${isolation.private_root}/`))
      failA1(
        "TESTER_PRIVATE_PATH_REQUIRED",
        "tester state and signing key must remain in private storage",
      );
    assertProtectedPath(privatePath, [0, isolation.tester_uid]);
  }
  const draftPath = privateFilePath(project, input.feedback_path, isolation);
  const state = readTesterRunState(project, input.tester_run_id);
  const review = readStoredTesterReview(project, input.tester_run_id);
  if (
    review.verdict !== "approved" ||
    state.review_receipt_sha256 === null ||
    review.subject.private_result_sha256 !== state.private_result_sha256
  )
    failA1(
      "TESTER_REVIEW_REQUIRED",
      "feedback export requires the approved review for the sealed private result",
    );
  const feedback = feedbackBindingFromTesterState(state, readStateFile(draftPath));
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (key.asymmetricKeyType !== "ed25519")
    failA1("TESTER_SIGNING_KEY_INVALID", "tester key must be Ed25519");
  return {
    feedback,
    signature: crypto.sign(null, feedbackSignedBytes(feedback), key).toString("base64"),
  };
}

function assertConclusionIdentity(
  state: TesterRunState,
  conclusion: TesterPublicConclusion,
  testerRunId: string,
): void {
  if (
    state.tester_run_id !== testerRunId ||
    conclusion.tester_run_id !== state.tester_run_id ||
    conclusion.outer_run_id !== state.outer_run_id ||
    conclusion.task_id !== state.task_id ||
    conclusion.promotion_trial_id !== state.promotion_trial_id ||
    conclusion.outer_iteration !== state.outer_iteration ||
    conclusion.generation !== state.generation ||
    conclusion.wave_id !== state.wave_id ||
    conclusion.tester_definition_sha256 !== state.tester_definition_sha256 ||
    conclusion.harness_sha256 !== state.harness_sha256 ||
    conclusion.matching_baseline_artifact_sha256 !== state.matching_baseline_artifact_sha256 ||
    conclusion.finalist_artifact_sha256 !== state.finalist_artifact_sha256 ||
    conclusion.input_snapshot_sha256 !== state.input_snapshot_sha256 ||
    conclusion.input_distribution_sha256 !== state.input_distribution_sha256 ||
    conclusion.model_assignment_sha256 !== state.model_assignment_sha256
  )
    failA1(
      "TESTER_PUBLIC_RECEIPT_MISMATCH",
      "signed tester conclusion does not match the prebuilt public tester run",
    );
}

function publicTesterDashboardValue(state: TesterRunState): Record<string, unknown> {
  const hashes: Record<string, string> = {
    input_snapshot_sha256: state.input_snapshot_sha256,
    case_manifest_sha256: state.case_manifest_sha256,
    seed_manifest_sha256: state.seed_manifest_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
  };
  if (state.input_distribution_sha256 !== null)
    hashes.input_distribution_sha256 = state.input_distribution_sha256;
  if (state.private_result_sha256 !== null)
    hashes.private_result_sha256 = state.private_result_sha256;
  if (state.review_receipt_sha256 !== null)
    hashes.review_receipt_sha256 = state.review_receipt_sha256;
  if (state.judge_binding_id !== null) hashes.judge_binding_id = state.judge_binding_id;
  return {
    schema_version: 1,
    run_id: state.run_id,
    tester_run_id: state.tester_run_id,
    phase: state.status,
    status: state.status,
    attempt: state.attempt,
    arms: {
      matching_baseline: { status: state.status },
      finalist: { status: state.status },
    },
    hashes,
    review: { review_id: state.review_id },
    gate: { consumed: state.gate_consumed, status: state.gate_status },
    updated_at: state.updated_at,
  };
}

/**
 * Research-side bridge for a conclusion produced in the private tester
 * project.  Only a verified signature can move the prebuilt public run to a
 * terminal state; no private result, review body, or caller-supplied boolean
 * crosses the boundary.
 */
export function importVerifiedTesterConclusion(input: {
  project_root: string;
  tester_run_id: string;
  signed_conclusion: unknown;
  public_key: crypto.KeyObject;
}): TesterRunState {
  const testerRunId = assertIdentifier(input.tester_run_id, "tester_run_id");
  const conclusion = verifyTesterConclusion(input.signed_conclusion, input.public_key);
  const initialState = readTesterRunState(input.project_root, testerRunId);
  assertConclusionIdentity(initialState, conclusion, testerRunId);
  if (initialState.status === "running") {
    // This updates only the public exposure ledger with an opaque hash. It
    // does not call recordTesterPrivateResult and therefore cannot create a
    // private-result.json in the research project.
    const definitionPath = testerDefinitionPath(
      input.project_root,
      initialState.tester_id,
      initialState.tester_version,
    );
    if (!fs.existsSync(definitionPath))
      failA1("TESTER_DEFINITION_NOT_FOUND", "public tester definition is required for import");
    const definition = validateTesterDefinition(readStateFile(definitionPath));
    if (
      definition.definition_sha256 !== initialState.tester_definition_sha256 ||
      definition.harness_sha256 !== initialState.harness_sha256 ||
      definition.case_manifest_sha256 !== initialState.case_manifest_sha256 ||
      definition.seed_manifest_sha256 !== initialState.seed_manifest_sha256
    )
      failA1("IDENTITY_MISMATCH", "public tester definition does not match the prebuilt run");
    const ledger = readExposureLedger(
      input.project_root,
      initialState.task_id,
      definition.max_exposures_per_task,
    );
    sealPrivateTesterResult(
      input.project_root,
      initialState.task_id,
      initialState.promotion_trial_id,
      conclusion.private_result_sha256,
      ledger.max_exposures_per_task,
    );
    savePrivateResultReference(input.project_root, testerRunId, conclusion.private_result_sha256);
  }
  const statePath = testerRunStatePath(input.project_root, testerRunId);
  return withStateFileLock(statePath, () => {
    const state = readTesterRunState(input.project_root, testerRunId);
    assertConclusionIdentity(state, conclusion, testerRunId);
    if (state.status === "passed" || state.status === "rejected") {
      if (
        state.status !== conclusion.status ||
        state.gate_status !== conclusion.status ||
        state.private_result_sha256 !== conclusion.private_result_sha256 ||
        state.review_receipt_sha256 !== conclusion.review_receipt_sha256
      )
        failA1(
          "TESTER_GATE_CONFLICT",
          "public tester conclusion conflicts with the imported state",
        );
      writeStateJsonAtomic(
        testerDashboardPath(input.project_root, testerRunId),
        publicTesterDashboardValue(state),
      );
      return state;
    }
    if (state.status !== "running" || state.gate_consumed || state.gate_status !== null)
      failA1(
        "TESTER_STATE_ORDER",
        "public tester conclusion can only import into an unconsumed running state",
      );
    if (
      state.private_result_sha256 !== null &&
      state.private_result_sha256 !== conclusion.private_result_sha256
    )
      failA1("PRIVATE_RESULT_CONFLICT", "public tester result hash conflicts with prebuilt state");
    if (
      state.review_receipt_sha256 !== null &&
      state.review_receipt_sha256 !== conclusion.review_receipt_sha256
    )
      failA1("REVIEW_RECEIPT_CONFLICT", "public review hash conflicts with prebuilt state");
    if (state.review_id === null || state.reviewer_worker_id === null)
      failA1(
        "PUBLIC_TESTER_REVIEW_REF_REQUIRED",
        "prebuilt public tester state must retain opaque review identity references",
      );
    const next: TesterRunState = {
      ...state,
      status: conclusion.status,
      private_result_sha256: conclusion.private_result_sha256,
      review_receipt_sha256: conclusion.review_receipt_sha256,
      gate_consumed: true,
      gate_status: conclusion.status,
      updated_at: new Date().toISOString(),
    };
    writeStateJsonAtomic(statePath, next);
    writeStateJsonAtomic(
      testerDashboardPath(input.project_root, testerRunId),
      publicTesterDashboardValue(next),
    );
    return next;
  });
}

export function importVerifiedTesterConclusionFromFiles(input: {
  project_root: string;
  tester_run_id: string;
  receipt_path: string;
  public_key_path: string;
}): TesterRunState {
  const publicKey = crypto.createPublicKey(fs.readFileSync(input.public_key_path));
  return importVerifiedTesterConclusion({
    project_root: input.project_root,
    tester_run_id: input.tester_run_id,
    signed_conclusion: readStateFile(publicReceiptFilePath(input.receipt_path)),
    public_key: publicKey,
  });
}

export const acceptVerifiedTesterConclusion = importVerifiedTesterConclusion;

export function exportTesterConclusion(input: {
  isolation_config: string;
  private_project_root: string;
  tester_run_id: string;
  signing_key_path: string;
}): SignedTesterConclusion {
  const isolation = readTesterIsolationConfig(input.isolation_config);
  checkTesterIsolation(isolation, "tester");
  const project = fs.realpathSync(input.private_project_root);
  const keyPath = fs.realpathSync(input.signing_key_path);
  for (const privatePath of [project, keyPath]) {
    if (!privatePath.startsWith(`${isolation.private_root}/`))
      failA1(
        "TESTER_PRIVATE_PATH_REQUIRED",
        "tester state and signing key must remain in private storage",
      );
    assertProtectedPath(privatePath, [0, isolation.tester_uid]);
  }
  const state = readTesterRunState(project, input.tester_run_id);
  const review = readStoredTesterReview(project, input.tester_run_id);
  if (
    !state.gate_consumed ||
    state.status !== state.gate_status ||
    review.verdict !== "approved" ||
    review.subject.private_result_sha256 !== state.private_result_sha256
  )
    failA1(
      "TESTER_REVIEW_REQUIRED",
      "export requires the consumed gate and its approved private review",
    );
  const conclusion = validateTesterPublicConclusion({
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    outer_run_id: state.outer_run_id,
    task_id: state.task_id,
    promotion_trial_id: state.promotion_trial_id,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    wave_id: state.wave_id,
    tester_definition_sha256: state.tester_definition_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    input_snapshot_sha256: state.input_snapshot_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
    private_result_sha256: state.private_result_sha256,
    review_receipt_sha256: state.review_receipt_sha256,
    status: state.gate_status,
  });
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (key.asymmetricKeyType !== "ed25519")
    failA1("TESTER_SIGNING_KEY_INVALID", "tester key must be Ed25519");
  return {
    conclusion,
    signature: crypto.sign(null, signedBytes(conclusion), key).toString("base64"),
  };
}
