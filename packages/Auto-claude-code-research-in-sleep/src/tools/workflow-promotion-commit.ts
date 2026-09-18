import { requireRunContract } from "./run-contract.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { type ArtifactRegistry, type ArtifactRegistryEntry } from "./artifact-registry.js";
import {
  commitPromotionAtomically,
  type IncumbentArtifact,
  type IncumbentSnapshot,
  validateIncumbentSnapshot,
} from "./model-assignment.js";
import {
  type PremiseWriteReceipt,
  readStateFile,
  withStateFileLock,
  writeStateJsonAtomic,
  writeVerifiedStateJsonAtomic,
} from "./state-file.js";
import {
  sanitizeTesterFeedback,
  testerFeedbackPath,
  type TesterFeedback,
} from "./tester-feedback.js";
import {
  readExposureLedger,
  recordTesterFeedbackEvent,
  readTesterRunState,
  settleExposure,
  testerRunStatePath,
  type ExposureRecord,
  type TesterRunState,
} from "./tester-state.js";
import {
  readVerifiedTesterConclusion,
  readVerifiedTesterFeedback,
  validateTesterPublicConclusion,
  verifyTesterFeedback,
  verifyTesterConclusion,
  type TesterPublicFeedbackEnvelope,
  type TesterPublicConclusion,
} from "./tester-public-receipt.js";
import {
  hashOuterEvidence,
  readOuterPromotionGateRecord,
  readOuterRunState,
  readOuterTesterArmMapping,
  readOuterValidationGateRecord,
  reconcileOuterChildren,
  withOuterRuntimeMutation,
  type OuterRunIdentity,
  type OuterTesterArmMapping,
} from "./workflow-runtime.js";
import {
  readFrozenPolicy,
  workflowCycleDirectory,
  workflowCycleRelativePath,
  type ActiveOuterCycle,
  type FrozenPolicy,
  type OuterBudgetReservation,
  type WorkflowRuntimeState,
} from "./workflow-state.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

export interface TesterPublicReceiptReference {
  receipt_path: string;
  public_key_path: string;
}

export interface TesterPublicFeedbackReceiptReference {
  receipt_path: string;
  public_key_path: string;
}

export interface PromotionCommitInput extends OuterRunIdentity {
  registry: ArtifactRegistry;
  tester_public_receipt: TesterPublicReceiptReference;
  tester_feedback_receipt: TesterPublicFeedbackReceiptReference;
  evidence_paths: readonly string[];
}

export interface RecoverPromotionCommitInput extends OuterRunIdentity {
  registry: ArtifactRegistry;
  tester_public_receipt: TesterPublicReceiptReference;
  tester_feedback_receipt: TesterPublicFeedbackReceiptReference;
  evidence_paths?: readonly string[];
}

export interface PromotionCommitTestInput extends OuterRunIdentity {
  registry: ArtifactRegistry;
  signed_tester_public_receipt: unknown;
  tester_public_key: crypto.KeyObject;
  signed_tester_feedback: unknown;
  tester_feedback_public_key: crypto.KeyObject;
  evidence_paths: readonly string[];
}

export interface RecoverPromotionCommitTestInput extends OuterRunIdentity {
  registry: ArtifactRegistry;
  signed_tester_public_receipt: unknown;
  tester_public_key: crypto.KeyObject;
  signed_tester_feedback: unknown;
  tester_feedback_public_key: crypto.KeyObject;
  evidence_paths?: readonly string[];
}

export type PromotionCommitStatus = "prepared" | "committed" | "rejected";

interface PromotionCandidateFacts {
  candidate_id: string;
  generation: number;
  producer_run_id: string;
  role_artifacts: IncumbentArtifact[];
  promotion_outputs: Record<string, string>;
  candidate_output_artifact_ids: string[];
  output_entries: ArtifactRegistryEntry[];
}

interface PromotionIntentFacts {
  schema_version: 1;
  outer_run_id: string;
  outer_iteration: number;
  generation: number;
  task_id: string;
  workflow_id: string;
  wave_id: string;
  wave_kind: "module" | "structure";
  validation: {
    evidence_sha256: string;
    finalist_id: string;
    selected_cell_id: string | null;
  };
  promotion: {
    tester_run_id: string;
    promotion_trial_id: string;
    result: "passed" | "rejected";
    tester_state_sha256: string;
    evidence_sha256: string;
  };
  tester_conclusion: TesterPublicConclusion;
  tester_receipt_sha256: string;
  tester_feedback_receipt_sha256: string;
  tester_arm_mapping: OuterTesterArmMapping;
  parent: IncumbentSnapshot;
  finalist: {
    candidate_id: string;
    generation: number;
    producer_run_id: string;
    role_artifacts: IncumbentArtifact[];
    promotion_outputs: Record<string, string>;
    candidate_output_artifact_ids: string[];
  };
  feedback: TesterFeedback;
  feedback_sha256: string;
  budget: {
    reservation_id: string;
    amount: number;
    unit: string;
  };
  evidence_refs: string[];
  evidence_sha256: string;
  expected_parent_sha256: string;
  expected_active_incumbent_sha256: string;
}

export interface PromotionCommitIntent extends PromotionIntentFacts {
  intent_sha256: string;
  status: PromotionCommitStatus;
  created_at: string;
  updated_at: string;
}

export interface PromotionCommitResult {
  status: "committed" | "rejected";
  replaced: boolean;
  intent: PromotionCommitIntent;
  active_incumbent: IncumbentSnapshot;
  feedback_event_id: string;
}

export function promotionCommitIntentPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "promotion-commit-intent.json",
  );
}

function activeIncumbentPath(projectRoot: string, workflowId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "workflows",
    assertIdentifier(workflowId, "workflow_id"),
    "active-incumbent.json",
  );
}

function now(): string {
  return new Date().toISOString();
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function publicReceiptPath(projectRoot: string, requestedPath: string): string {
  const project = fs.realpathSync(projectRoot);
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(project, requestedPath);
  if (!fs.existsSync(candidate))
    failA1(
      "TESTER_PUBLIC_RECEIPT_REQUIRED",
      `tester public receipt does not exist at ${candidate}`,
    );
  const resolved = fs.realpathSync(candidate);
  if (!inside(project, resolved) || !fs.statSync(resolved).isFile())
    failA1(
      "TESTER_PUBLIC_RECEIPT_REQUIRED",
      "tester public receipt must be a file below project_root",
    );
  const basename = path.basename(resolved);
  if (basename === "private-result.json" || basename === "private-result.ref.json")
    failA1(
      "TESTER_PRIVATE_DATA_ACCESSIBLE",
      "private tester result cannot be used as a public receipt",
    );
  return resolved;
}

interface ReadTesterConclusionResult {
  conclusion: TesterPublicConclusion;
  receipt_sha256: string;
}

interface ReadTesterFeedbackResult {
  feedback: TesterFeedback;
  envelope: TesterPublicFeedbackEnvelope;
  receipt_sha256: string;
}

function readTesterConclusion(
  projectRoot: string,
  reference: TesterPublicReceiptReference,
): ReadTesterConclusionResult {
  const receiptPath = publicReceiptPath(
    projectRoot,
    requireString(reference.receipt_path, "receipt_path"),
  );
  const publicKeyPath = requireString(reference.public_key_path, "public_key_path");
  return {
    conclusion: readVerifiedTesterConclusion(receiptPath, publicKeyPath),
    receipt_sha256: hashFile(receiptPath),
  };
}

function readTesterFeedback(
  projectRoot: string,
  reference: TesterPublicFeedbackReceiptReference,
): ReadTesterFeedbackResult {
  const receiptPath = publicReceiptPath(
    projectRoot,
    requireString(reference.receipt_path, "feedback_receipt_path"),
  );
  const publicKeyPath = requireString(reference.public_key_path, "feedback_public_key_path");
  const envelope = readVerifiedTesterFeedback(receiptPath, publicKeyPath);
  return {
    feedback: envelope.feedback,
    envelope,
    receipt_sha256: hashFile(receiptPath),
  };
}

function readTestTesterConclusion(
  signedReceipt: unknown,
  publicKey: crypto.KeyObject,
): ReadTesterConclusionResult {
  return {
    conclusion: verifyTesterConclusion(signedReceipt, publicKey),
    receipt_sha256: canonicalJsonSha256(signedReceipt, undefined, {
      schemaVersion: "tester-public-receipt-v1",
    }),
  };
}

function readTestTesterFeedback(
  signedReceipt: unknown,
  publicKey: crypto.KeyObject,
): ReadTesterFeedbackResult {
  const envelope = verifyTesterFeedback(signedReceipt, publicKey);
  return {
    feedback: envelope.feedback,
    envelope,
    receipt_sha256: canonicalJsonSha256(signedReceipt, undefined, {
      schemaVersion: "tester-public-feedback-v1",
    }),
  };
}

function snapshotHash(snapshot: IncumbentSnapshot): string {
  return canonicalJsonSha256(snapshot, undefined, { schemaVersion: "incumbent-v1" });
}

function sameJson(left: unknown, right: unknown, schemaVersion: string): boolean {
  return (
    canonicalJsonSha256(left, undefined, { schemaVersion }) ===
    canonicalJsonSha256(right, undefined, { schemaVersion })
  );
}

function readActiveIncumbent(projectRoot: string, workflowId: string): IncumbentSnapshot {
  const filePath = activeIncumbentPath(projectRoot, workflowId);
  if (!fs.existsSync(filePath))
    failA1("ACTIVE_INCUMBENT_NOT_FOUND", `active incumbent does not exist at ${filePath}`);
  const value = readStateFile(filePath);
  return validateIncumbent(value, filePath);
}

function validateIncumbent(value: unknown, filePath: string): IncumbentSnapshot {
  if (!isRecord(value))
    failA1("CORRUPT_ACTIVE_INCUMBENT", "active incumbent must be an object", filePath);
  return validateIncumbentSnapshotForCommit(value);
}

function validateIncumbentSnapshotForCommit(value: unknown): IncumbentSnapshot {
  // Keep the model-assignment validator as the single incumbent shape owner.
  return validateIncumbentSnapshot(value);
}

function parseRoleArtifact(value: unknown, location: string): IncumbentArtifact {
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "role artifact must be an object", location);
  assertNoUnknownFields(value, ["artifact_id", "generation", "role_id"], location);
  return {
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    generation: requireInteger(value.generation, `${location}.generation`, 0),
    role_id: assertIdentifier(value.role_id, `${location}.role_id`),
  };
}

function parseRoleArtifacts(value: unknown, location: string): IncumbentArtifact[] {
  if (!Array.isArray(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "role artifacts must be an array", location);
  const artifacts = value.map((item, index) => parseRoleArtifact(item, `${location}[${index}]`));
  if (new Set(artifacts.map((artifact) => artifact.role_id)).size !== artifacts.length)
    failA1("DUPLICATE_ID", "role artifacts must have unique roles", location);
  return artifacts;
}

function parsePromotionOutputs(value: unknown, location: string): Record<string, string> {
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion outputs must be an object", location);
  const outputs: Record<string, string> = {};
  for (const [output, artifactId] of Object.entries(value)) {
    const outputId = assertIdentifier(output, `${location}.key`);
    outputs[outputId] = assertIdentifier(artifactId, `${location}.${outputId}`);
  }
  return outputs;
}

function parseTesterArm<Name extends "matching_baseline" | "finalist">(
  value: unknown,
  name: Name,
  location: string,
): { name: Name; artifact_id: string; artifact_sha256: string } {
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "tester arm must be an object", location);
  assertNoUnknownFields(value, ["name", "artifact_id", "artifact_sha256"], location);
  if (value.name !== name)
    failA1("TESTER_ARM_MAPPING_REQUIRED", `tester arm must be named '${name}'`, location);
  return {
    name,
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    artifact_sha256: assertSha256(value.artifact_sha256, `${location}.artifact_sha256`),
  };
}

function parseTesterArmMapping(value: unknown, location: string): OuterTesterArmMapping {
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "tester arm mapping must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "tester_run_id",
      "promotion_trial_id",
      "arm_a",
      "arm_b",
      "tester_definition_sha256",
      "harness_sha256",
      "input_distribution_sha256",
      "model_assignment_sha256",
      "judge_binding_id",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_PROMOTION_COMMIT", "tester arm mapping schema_version must be 1", location);
  return {
    schema_version: 1,
    tester_run_id: assertIdentifier(value.tester_run_id, `${location}.tester_run_id`),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      `${location}.promotion_trial_id`,
    ),
    arm_a: parseTesterArm(value.arm_a, "matching_baseline", `${location}.arm_a`),
    arm_b: parseTesterArm(value.arm_b, "finalist", `${location}.arm_b`),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      `${location}.tester_definition_sha256`,
    ),
    harness_sha256: assertSha256(value.harness_sha256, `${location}.harness_sha256`),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      `${location}.input_distribution_sha256`,
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      `${location}.model_assignment_sha256`,
    ),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, `${location}.judge_binding_id`),
  };
}

function validateIntent(value: unknown, filePath: string): PromotionCommitIntent {
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion commit intent must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "intent_sha256",
      "status",
      "outer_run_id",
      "outer_iteration",
      "generation",
      "task_id",
      "workflow_id",
      "wave_id",
      "wave_kind",
      "validation",
      "promotion",
      "tester_conclusion",
      "tester_receipt_sha256",
      "tester_feedback_receipt_sha256",
      "tester_arm_mapping",
      "parent",
      "finalist",
      "feedback",
      "feedback_sha256",
      "budget",
      "evidence_refs",
      "evidence_sha256",
      "expected_parent_sha256",
      "expected_active_incumbent_sha256",
      "created_at",
      "updated_at",
    ],
    filePath,
  );
  if (value.schema_version !== 1)
    failA1(
      "CORRUPT_PROMOTION_COMMIT",
      "promotion commit intent schema_version must be 1",
      filePath,
    );
  if (value.status !== "prepared" && value.status !== "committed" && value.status !== "rejected")
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion commit intent status is invalid", filePath);
  if (value.wave_kind !== "module" && value.wave_kind !== "structure")
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion commit wave kind is invalid", filePath);
  if (!isRecord(value.validation) || !isRecord(value.promotion) || !isRecord(value.budget))
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion commit nested facts are invalid", filePath);
  assertNoUnknownFields(
    value.validation,
    ["evidence_sha256", "finalist_id", "selected_cell_id"],
    `${filePath}.validation`,
  );
  assertNoUnknownFields(
    value.promotion,
    ["tester_run_id", "promotion_trial_id", "result", "tester_state_sha256", "evidence_sha256"],
    `${filePath}.promotion`,
  );
  assertNoUnknownFields(value.budget, ["reservation_id", "amount", "unit"], `${filePath}.budget`);
  const validation = {
    evidence_sha256: assertSha256(
      value.validation.evidence_sha256,
      `${filePath}.validation.evidence_sha256`,
    ),
    finalist_id: assertIdentifier(
      value.validation.finalist_id,
      `${filePath}.validation.finalist_id`,
    ),
    selected_cell_id:
      value.validation.selected_cell_id === null
        ? null
        : assertIdentifier(
            value.validation.selected_cell_id,
            `${filePath}.validation.selected_cell_id`,
          ),
  };
  if (value.promotion.result !== "passed" && value.promotion.result !== "rejected")
    failA1(
      "CORRUPT_PROMOTION_COMMIT",
      "promotion result is invalid",
      `${filePath}.promotion.result`,
    );
  const promotionResult: "passed" | "rejected" = value.promotion.result;
  const promotion: PromotionIntentFacts["promotion"] = {
    tester_run_id: assertIdentifier(
      value.promotion.tester_run_id,
      `${filePath}.promotion.tester_run_id`,
    ),
    promotion_trial_id: assertIdentifier(
      value.promotion.promotion_trial_id,
      `${filePath}.promotion.promotion_trial_id`,
    ),
    result: promotionResult,
    tester_state_sha256: assertSha256(
      value.promotion.tester_state_sha256,
      `${filePath}.promotion.tester_state_sha256`,
    ),
    evidence_sha256: assertSha256(
      value.promotion.evidence_sha256,
      `${filePath}.promotion.evidence_sha256`,
    ),
  };
  const budget = {
    reservation_id: assertIdentifier(
      value.budget.reservation_id,
      `${filePath}.budget.reservation_id`,
    ),
    amount: requireFiniteNumber(value.budget.amount, `${filePath}.budget.amount`),
    unit: requireString(value.budget.unit, `${filePath}.budget.unit`),
  };
  if (budget.amount <= 0)
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion budget amount must be positive", filePath);
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "promotion commit needs evidence references", filePath);
  const evidenceRefs = value.evidence_refs.map((ref, index) =>
    requireString(ref, `${filePath}.evidence_refs[${index}]`),
  );
  const parent = validateIncumbent(value.parent, `${filePath}.parent`);
  if (!isRecord(value.finalist))
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion finalist facts must be an object", filePath);
  assertNoUnknownFields(
    value.finalist,
    [
      "candidate_id",
      "generation",
      "producer_run_id",
      "role_artifacts",
      "promotion_outputs",
      "candidate_output_artifact_ids",
    ],
    `${filePath}.finalist`,
  );
  if (!Array.isArray(value.finalist.candidate_output_artifact_ids))
    failA1("CORRUPT_PROMOTION_COMMIT", "finalist output ids must be an array", filePath);
  const candidateOutputArtifactIds = value.finalist.candidate_output_artifact_ids.map((id, index) =>
    assertIdentifier(id, `${filePath}.finalist.candidate_output_artifact_ids[${index}]`),
  );
  if (new Set(candidateOutputArtifactIds).size !== candidateOutputArtifactIds.length)
    failA1("DUPLICATE_ID", "finalist output ids must be unique", filePath);
  const finalist = {
    candidate_id: assertIdentifier(
      value.finalist.candidate_id,
      `${filePath}.finalist.candidate_id`,
    ),
    generation: requireInteger(value.finalist.generation, `${filePath}.finalist.generation`, 0),
    producer_run_id: assertIdentifier(
      value.finalist.producer_run_id,
      `${filePath}.finalist.producer_run_id`,
    ),
    role_artifacts: parseRoleArtifacts(
      value.finalist.role_artifacts,
      `${filePath}.finalist.role_artifacts`,
    ),
    promotion_outputs: parsePromotionOutputs(
      value.finalist.promotion_outputs,
      `${filePath}.finalist.promotion_outputs`,
    ),
    candidate_output_artifact_ids: candidateOutputArtifactIds,
  };
  const feedback = sanitizeTesterFeedback(value.feedback);
  const intent: PromotionCommitIntent = {
    schema_version: 1,
    intent_sha256: assertSha256(value.intent_sha256, `${filePath}.intent_sha256`),
    status: value.status,
    outer_run_id: assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`),
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    generation: requireInteger(value.generation, `${filePath}.generation`, 1),
    task_id: assertIdentifier(value.task_id, `${filePath}.task_id`),
    workflow_id: assertIdentifier(value.workflow_id, `${filePath}.workflow_id`),
    wave_id: assertIdentifier(value.wave_id, `${filePath}.wave_id`),
    wave_kind: value.wave_kind,
    validation,
    promotion,
    tester_conclusion: validateTesterPublicConclusion(value.tester_conclusion),
    tester_receipt_sha256: assertSha256(
      value.tester_receipt_sha256,
      `${filePath}.tester_receipt_sha256`,
    ),
    tester_feedback_receipt_sha256: assertSha256(
      value.tester_feedback_receipt_sha256,
      `${filePath}.tester_feedback_receipt_sha256`,
    ),
    tester_arm_mapping: parseTesterArmMapping(
      value.tester_arm_mapping,
      `${filePath}.tester_arm_mapping`,
    ),
    parent,
    finalist,
    feedback,
    feedback_sha256: assertSha256(value.feedback_sha256, `${filePath}.feedback_sha256`),
    budget,
    evidence_refs: evidenceRefs,
    evidence_sha256: assertSha256(value.evidence_sha256, `${filePath}.evidence_sha256`),
    expected_parent_sha256: assertSha256(
      value.expected_parent_sha256,
      `${filePath}.expected_parent_sha256`,
    ),
    expected_active_incumbent_sha256: assertSha256(
      value.expected_active_incumbent_sha256,
      `${filePath}.expected_active_incumbent_sha256`,
    ),
    created_at: requireString(value.created_at, `${filePath}.created_at`),
    updated_at: requireString(value.updated_at, `${filePath}.updated_at`),
  };
  const facts = intentFacts(intent);
  if (
    canonicalJsonSha256(facts, undefined, {
      schemaVersion: "workflow-promotion-commit-intent-v1",
    }) !== intent.intent_sha256
  )
    failA1(
      "CORRUPT_PROMOTION_COMMIT",
      "promotion commit intent hash does not match its facts",
      filePath,
    );
  if (
    intent.feedback_sha256 !==
    canonicalJsonSha256(intent.feedback, undefined, { schemaVersion: "tester-feedback-v1" })
  )
    failA1(
      "CORRUPT_PROMOTION_COMMIT",
      "promotion commit feedback hash does not match its content",
      filePath,
    );
  if (intent.expected_parent_sha256 !== snapshotHash(intent.parent))
    failA1(
      "CORRUPT_PROMOTION_COMMIT",
      "promotion commit parent hash does not match its snapshot",
      filePath,
    );
  return intent;
}

function intentFacts(intent: PromotionCommitIntent): PromotionIntentFacts {
  const {
    intent_sha256: _intentSha256,
    status: _status,
    created_at: _createdAt,
    updated_at: _updatedAt,
    ...facts
  } = intent;
  return facts;
}

function buildIntent(facts: PromotionIntentFacts): PromotionCommitIntent {
  const intentSha256 = canonicalJsonSha256(facts, undefined, {
    schemaVersion: "workflow-promotion-commit-intent-v1",
  });
  const timestamp = now();
  return {
    ...facts,
    intent_sha256: intentSha256,
    status: "prepared",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/**
 * The intent exists only because a tester's signed conclusion was read and its
 * signature checked, so the acceptance it records is already on the facts: the
 * run asking for the promotion produced it, the tester run ruled on it, and the
 * receipt hash names the document that ruling came in.
 */
function intentReceipt(intent: PromotionIntentFacts): PremiseWriteReceipt {
  return {
    producer_id: intent.outer_run_id,
    verifier_id: intent.promotion.tester_run_id,
    receipt_ref: intent.tester_receipt_sha256,
  };
}

function readIntentAt(filePath: string): PromotionCommitIntent | null {
  if (!fs.existsSync(filePath)) return null;
  return validateIntent(readStateFile(filePath), filePath);
}

function persistPreparedIntent(
  filePath: string,
  expected: PromotionCommitIntent,
): PromotionCommitIntent {
  return withStateFileLock(filePath, () => {
    const existing = readIntentAt(filePath);
    if (existing !== null) {
      if (existing.intent_sha256 !== expected.intent_sha256)
        failA1(
          "PROMOTION_COMMIT_CONFLICT",
          "promotion commit intent facts cannot change",
          filePath,
        );
      return existing;
    }
    writeVerifiedStateJsonAtomic(filePath, expected, intentReceipt(expected));
    return expected;
  });
}

function setIntentStatus(
  filePath: string,
  expectedHash: string,
  status: "committed" | "rejected",
): PromotionCommitIntent {
  return withStateFileLock(filePath, () => {
    const current = readIntentAt(filePath);
    if (current === null)
      failA1("PROMOTION_COMMIT_REQUIRED", "promotion commit intent is missing", filePath);
    if (current.intent_sha256 !== expectedHash)
      failA1("PROMOTION_COMMIT_CONFLICT", "promotion commit intent facts changed", filePath);
    if (current.status !== "prepared" && current.status !== status)
      failA1(
        "PROMOTION_COMMIT_CONFLICT",
        "promotion commit intent has a different terminal status",
        filePath,
      );
    if (current.status === status) return current;
    const next: PromotionCommitIntent = { ...current, status, updated_at: now() };
    writeVerifiedStateJsonAtomic(filePath, next, intentReceipt(next));
    return next;
  });
}

export function readPromotionCommitIntent(
  input: OuterRunIdentity & { outer_iteration: number },
): PromotionCommitIntent {
  const filePath = promotionCommitIntentPath(
    input.project_root,
    input.outer_run_id,
    input.outer_iteration,
  );
  const intent = readIntentAt(filePath);
  if (intent === null)
    failA1("PROMOTION_COMMIT_REQUIRED", `promotion commit intent does not exist at ${filePath}`);
  if (
    intent.outer_run_id !== input.outer_run_id ||
    intent.outer_iteration !== input.outer_iteration
  )
    failA1(
      "IDENTITY_MISMATCH",
      "promotion commit intent does not match its requested cycle",
      filePath,
    );
  return intent;
}

function candidateFacts(
  registry: ArtifactRegistry,
  candidateId: string,
  expectedGeneration: number,
  policy: FrozenPolicy["model_usage_policy"],
  finalistArtifactSha256: string,
): PromotionCandidateFacts {
  const entries = registry.findByCandidate(candidateId);
  if (entries.length === 0)
    failA1("ARTIFACT_NOT_FOUND", `finalist '${candidateId}' has no registered output artifacts`);
  const producerIds = new Set<string>();
  const generations = new Set<number>();
  for (const entry of entries) {
    if (entry.producer_run_id === null || entry.generation === null)
      failA1("ARTIFACT_PROVENANCE_MISMATCH", "finalist output is missing producer facts");
    producerIds.add(entry.producer_run_id);
    generations.add(entry.generation);
    registry.assertSealed(entry.artifact_id);
    if (
      entry.source_type !== "workflow_output" ||
      entry.candidate_id !== candidateId ||
      entry.role_id === null ||
      entry.output_slot === null
    )
      failA1("ARTIFACT_PROVENANCE_MISMATCH", "finalist output is not a workflow role artifact");
  }
  if (producerIds.size !== 1 || generations.size !== 1)
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      "finalist outputs must share one producer and generation",
    );
  const producerRunId = [...producerIds][0]!;
  const generation = [...generations][0]!;
  if (generation !== expectedGeneration)
    failA1(
      "GENERATION_MISMATCH",
      "finalist artifacts are not the next generation after the parent",
    );
  const outputRoles = policy.roles.filter((role) => role.promotion_output !== null);
  if (outputRoles.length === 0)
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "promotion policy has no output roles");
  const outputEntries: ArtifactRegistryEntry[] = [];
  const roleArtifacts: IncumbentArtifact[] = [];
  const promotionOutputs: Record<string, string> = {};
  for (const role of outputRoles) {
    const slot = role.promotion_output!;
    const matches = entries.filter(
      (entry) => entry.role_id === role.role_id && entry.output_slot === slot,
    );
    if (matches.length !== 1)
      failA1("ARTIFACT_PROVENANCE_MISMATCH", `finalist must have one artifact for '${slot}'`);
    const entry = matches[0]!;
    outputEntries.push(entry);
    roleArtifacts.push({ artifact_id: entry.artifact_id, generation, role_id: role.role_id });
    promotionOutputs[slot] = entry.artifact_id;
  }
  const candidateOutputArtifactIds = outputEntries
    .map((entry) => entry.artifact_id)
    .sort(compareIdentityStrings);
  const finalistMatches = outputEntries.filter((entry) => entry.sha256 === finalistArtifactSha256);
  if (finalistMatches.length !== 1)
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      "tester finalist artifact must identify exactly one policy promotion output",
    );
  return {
    candidate_id: candidateId,
    generation,
    producer_run_id: producerRunId,
    role_artifacts: roleArtifacts.sort((left, right) =>
      compareIdentityStrings(left.role_id, right.role_id),
    ),
    promotion_outputs: promotionOutputs,
    candidate_output_artifact_ids: candidateOutputArtifactIds,
    output_entries: outputEntries,
  };
}

function expectedActiveIncumbent(
  parent: IncumbentSnapshot,
  candidate: PromotionCandidateFacts,
): IncumbentSnapshot {
  const byRole = new Map(parent.role_artifacts.map((artifact) => [artifact.role_id, artifact]));
  for (const artifact of candidate.role_artifacts) byRole.set(artifact.role_id, artifact);
  return {
    candidate_id: candidate.candidate_id,
    generation: candidate.generation,
    role_artifacts: [...byRole.values()].sort((left, right) =>
      compareIdentityStrings(left.role_id, right.role_id),
    ),
  };
}

function assertTesterConclusionMatches(
  conclusion: TesterPublicConclusion,
  tester: TesterRunState,
  cycle: ActiveOuterCycle,
  mapping: OuterTesterArmMapping,
  promotionResult: "passed" | "rejected",
): void {
  if (
    conclusion.tester_run_id !== tester.tester_run_id ||
    conclusion.outer_run_id !== tester.outer_run_id ||
    conclusion.task_id !== tester.task_id ||
    conclusion.promotion_trial_id !== tester.promotion_trial_id ||
    conclusion.outer_iteration !== tester.outer_iteration ||
    conclusion.generation !== tester.generation ||
    conclusion.wave_id !== tester.wave_id ||
    conclusion.tester_definition_sha256 !== tester.tester_definition_sha256 ||
    conclusion.harness_sha256 !== tester.harness_sha256 ||
    conclusion.matching_baseline_artifact_sha256 !== tester.matching_baseline_artifact_sha256 ||
    conclusion.finalist_artifact_sha256 !== tester.finalist_artifact_sha256 ||
    conclusion.input_snapshot_sha256 !== tester.input_snapshot_sha256 ||
    conclusion.input_distribution_sha256 !== tester.input_distribution_sha256 ||
    conclusion.model_assignment_sha256 !== tester.model_assignment_sha256 ||
    conclusion.private_result_sha256 !== tester.private_result_sha256 ||
    conclusion.review_receipt_sha256 !== tester.review_receipt_sha256 ||
    conclusion.status !== promotionResult ||
    tester.outer_iteration !== cycle.outer_iteration ||
    tester.generation !== cycle.generation ||
    tester.wave_id !== cycle.wave_id ||
    tester.wave_kind !== cycle.wave_kind ||
    tester.status !== conclusion.status ||
    !tester.gate_consumed ||
    tester.gate_status !== conclusion.status
  )
    failA1(
      "TESTER_PUBLIC_RECEIPT_MISMATCH",
      "signed tester conclusion does not match the public run state",
    );
  if (
    mapping.tester_run_id !== tester.tester_run_id ||
    mapping.promotion_trial_id !== tester.promotion_trial_id ||
    mapping.arm_a.name !== "matching_baseline" ||
    mapping.arm_b.name !== "finalist" ||
    mapping.arm_a.artifact_sha256 !== tester.matching_baseline_artifact_sha256 ||
    mapping.arm_b.artifact_sha256 !== tester.finalist_artifact_sha256 ||
    mapping.tester_definition_sha256 !== tester.tester_definition_sha256 ||
    mapping.harness_sha256 !== tester.harness_sha256 ||
    mapping.input_distribution_sha256 !== tester.input_distribution_sha256 ||
    mapping.model_assignment_sha256 !== tester.model_assignment_sha256 ||
    mapping.judge_binding_id !== tester.judge_binding_id
  )
    failA1(
      "TESTER_ARM_MAPPING_REQUIRED",
      "tester arm mapping does not match the signed tester state",
    );
}

function assertExposureMatches(
  exposure: ExposureRecord,
  tester: TesterRunState,
  conclusion: TesterPublicConclusion,
): void {
  if (
    exposure.status === "released" ||
    exposure.promotion_trial_id !== tester.promotion_trial_id ||
    exposure.outer_run_id !== tester.outer_run_id ||
    exposure.wave_id !== tester.wave_id ||
    exposure.tester_version !== tester.tester_version ||
    exposure.tester_definition_sha256 !== tester.tester_definition_sha256 ||
    exposure.harness_sha256 !== tester.harness_sha256 ||
    exposure.task_setup_revision !== tester.task_setup_revision ||
    exposure.case_manifest_sha256 !== tester.case_manifest_sha256 ||
    exposure.seed_manifest_sha256 !== tester.seed_manifest_sha256 ||
    exposure.matching_baseline_artifact_sha256 !== tester.matching_baseline_artifact_sha256 ||
    exposure.finalist_artifact_sha256 !== tester.finalist_artifact_sha256 ||
    exposure.model_assignment_sha256 !== tester.model_assignment_sha256 ||
    exposure.input_distribution_sha256 !== tester.input_distribution_sha256 ||
    exposure.judge_binding_id !== tester.judge_binding_id ||
    exposure.tester_run_id !== tester.tester_run_id ||
    !exposure.tester_started ||
    exposure.private_result_sha256 !== conclusion.private_result_sha256
  )
    failA1("EXPOSURE_CONFLICT", "tester exposure does not match its signed public conclusion");
}

function assertParentRegistryFacts(
  registry: ArtifactRegistry,
  parent: IncumbentSnapshot,
  baselineArtifactSha256: string,
): string {
  const registeredArtifacts = parent.role_artifacts.map((artifact) => {
    const registered = registry.assertSealed(artifact.artifact_id);
    if (registered.generation !== artifact.generation)
      failA1("GENERATION_MISMATCH", "frozen parent artifact generation is not registered");
    if (
      registered.source_type === "workflow_output" &&
      (registered.candidate_id !== parent.candidate_id || registered.role_id !== artifact.role_id)
    )
      failA1(
        "ARTIFACT_PROVENANCE_MISMATCH",
        "frozen parent artifact is registered for another candidate or role",
      );
    return { artifact, registered };
  });
  const matches = registeredArtifacts.filter(
    ({ registered }) => registered.sha256 === baselineArtifactSha256,
  );
  if (matches.length !== 1)
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      "tester matching baseline must identify exactly one frozen parent artifact",
    );
  return matches[0]!.artifact.artifact_id;
}

function assertTesterArtifactBinding(
  providedArtifactId: string,
  expectedArtifactId: string,
  artifactSha256: string,
  location: string,
): void {
  // The current outer mapping uses a deterministic hash reference because
  // tester workers do not write outer state. Accept that reference or the
  // concrete registry id, but never an unrelated caller-supplied id.
  if (
    providedArtifactId !== expectedArtifactId &&
    providedArtifactId !== `artifact:sha256:${artifactSha256}`
  )
    failA1("TESTER_ARM_MAPPING_REQUIRED", `${location} is not bound to the expected artifact`);
}

function assertEvidenceHash(
  projectRoot: string,
  refs: readonly string[],
  expectedSha256: string,
  location: string,
): void {
  const actual = hashOuterEvidence(projectRoot, refs);
  if (
    actual.evidence_sha256 !== expectedSha256 ||
    !sameJson(actual.evidence_refs, refs, "outer-evidence-refs-v1")
  )
    failA1("OUTER_EVIDENCE_CHANGED", `${location} no longer matches its recorded files`);
}

function feedbackForCommit(
  envelope: TesterPublicFeedbackEnvelope,
  conclusion: TesterPublicConclusion,
  tester: TesterRunState,
  status: "passed" | "rejected",
  frozen: FrozenPolicy,
): TesterFeedback {
  const feedback = sanitizeTesterFeedback(envelope.feedback);
  if (
    envelope.tester_run_id !== conclusion.tester_run_id ||
    envelope.outer_run_id !== conclusion.outer_run_id ||
    envelope.task_id !== conclusion.task_id ||
    envelope.promotion_trial_id !== conclusion.promotion_trial_id ||
    envelope.outer_iteration !== conclusion.outer_iteration ||
    envelope.generation !== conclusion.generation ||
    envelope.wave_id !== conclusion.wave_id ||
    envelope.tester_definition_sha256 !== conclusion.tester_definition_sha256 ||
    envelope.harness_sha256 !== conclusion.harness_sha256 ||
    envelope.matching_baseline_artifact_sha256 !== conclusion.matching_baseline_artifact_sha256 ||
    envelope.finalist_artifact_sha256 !== conclusion.finalist_artifact_sha256 ||
    envelope.input_snapshot_sha256 !== conclusion.input_snapshot_sha256 ||
    envelope.input_distribution_sha256 !== conclusion.input_distribution_sha256 ||
    envelope.tester_conclusion_status !== conclusion.status ||
    feedback.task_id !== frozen.task_id ||
    feedback.task_setup_revision !== tester.task_setup_revision ||
    feedback.input_snapshot_sha256 !== tester.input_snapshot_sha256 ||
    feedback.promotion_trial_id !== tester.promotion_trial_id ||
    feedback.tester_version !== tester.tester_version ||
    (status === "passed" && feedback.conclusion !== "improved") ||
    (status === "rejected" && feedback.conclusion === "improved")
  )
    failA1("TESTER_FEEDBACK_NOT_READY", "sanitized tester feedback does not match the signed gate");
  return feedback;
}

function persistFeedback(
  projectRoot: string,
  testerRunId: string,
  feedback: TesterFeedback,
): TesterFeedback {
  const filePath = testerFeedbackPath(projectRoot, testerRunId);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = sanitizeTesterFeedback(readStateFile(filePath));
      if (!sameJson(existing, feedback, "tester-feedback-v1"))
        failA1("IMMUTABLE_CONFLICT", "tester feedback cannot change", filePath);
      return existing;
    }
    writeStateJsonAtomic(filePath, feedback);
    return feedback;
  });
}

function currentPromotionBudget(
  state: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
  testerRunId: string,
): OuterBudgetReservation {
  const matches = state.budgets.filter(
    (budget) => budget.outer_iteration === cycle.outer_iteration && budget.category === "promotion",
  );
  if (matches.length !== 1)
    failA1(
      "PROMOTION_BUDGET_REQUIRED",
      "promotion commit requires one current-cycle promotion budget",
    );
  const budget = matches[0]!;
  if (budget.child_run_id !== testerRunId)
    failA1("IDENTITY_MISMATCH", "promotion budget belongs to another tester child");
  if (budget.status === "released")
    failA1("PROMOTION_BUDGET_REQUIRED", "a released promotion budget cannot commit");
  return budget;
}

function settlePromotionBudget(
  state: WorkflowRuntimeState,
  intent: PromotionCommitIntent,
): WorkflowRuntimeState {
  const index = state.budgets.findIndex(
    (budget) => budget.reservation_id === intent.budget.reservation_id,
  );
  if (index < 0) failA1("PROMOTION_BUDGET_REQUIRED", "promotion budget reservation is missing");
  const current = state.budgets[index]!;
  if (
    current.outer_iteration !== intent.outer_iteration ||
    current.category !== "promotion" ||
    current.child_run_id !== intent.promotion.tester_run_id ||
    current.amount !== intent.budget.amount ||
    current.unit !== intent.budget.unit
  )
    failA1("PROMOTION_BUDGET_CONFLICT", "promotion budget differs from the commit intent");
  if (current.status === "settled") return state;
  if (current.status !== "reserved")
    failA1("PROMOTION_BUDGET_CONFLICT", "promotion budget is not reservable");
  const budgets = [...state.budgets];
  budgets[index] = {
    ...current,
    status: "settled",
    evidence_sha256: intent.evidence_sha256,
    closed_at: now(),
  };
  return { ...state, budgets, updated_at: now() };
}

function setCycleCommitReference(
  state: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
  intentPath: string,
  projectRoot: string,
  outerRunId: string,
): WorkflowRuntimeState {
  const relative = workflowCycleRelativePath(cycle.outer_iteration, "promotion-commit-intent.json");
  if (cycle.promotion_commit_ref !== null && cycle.promotion_commit_ref !== relative)
    failA1("PROMOTION_COMMIT_CONFLICT", "active cycle points to another promotion commit intent");
  const expectedPath = promotionCommitIntentPath(projectRoot, outerRunId, cycle.outer_iteration);
  if (path.resolve(intentPath) !== path.resolve(expectedPath))
    failA1(
      "IDENTITY_MISMATCH",
      "promotion commit intent path is not derived from the active cycle",
    );
  if (cycle.promotion_commit_ref === relative) return state;
  return {
    ...state,
    active_cycle: { ...cycle, promotion_commit_ref: relative },
    updated_at: now(),
  };
}

interface PreparedCommit {
  intent: PromotionCommitIntent;
  activeIncumbent: IncumbentSnapshot;
  expectedActiveIncumbent: IncumbentSnapshot;
  tester: TesterRunState;
  exposure: ExposureRecord;
  frozen: FrozenPolicy;
  cycle: ActiveOuterCycle;
  testerFeedback: TesterFeedback;
  testerFeedbackReceiptSha256: string;
  parentWasCurrent: boolean;
}

interface CommitOptions {
  testerConclusion: ReadTesterConclusionResult;
  testerFeedback: ReadTesterFeedbackResult;
  evidencePaths: readonly string[] | undefined;
  execute: boolean;
}

function prepareCommit(
  registry: ArtifactRegistry,
  options: CommitOptions,
  state: WorkflowRuntimeState,
  normalized: Required<OuterRunIdentity>,
): PreparedCommit {
  const root = requireRunContract(normalized.project_root, normalized.outer_run_id);
  if (root.depth !== 0 || root.parent_run_id !== null)
    failA1("TESTER_ROOT_ONLY", "only the root run may commit a tester promotion");
  if (state.current_phase !== "promotion" || state.active_cycle === null)
    failA1("OUTER_PHASE_ORDER", "promotion commit requires an active promotion phase");
  const cycle = state.active_cycle;
  if (cycle.wave_kind !== "module" && cycle.wave_kind !== "structure")
    failA1("PROMOTION_NOT_ALLOWED", "scorer cycles cannot commit a workflow promotion");
  const frozen = readFrozenPolicy(normalized.project_root, normalized.outer_run_id);
  if (frozen.workflow_id !== normalized.workflow_id && normalized.workflow_id !== "")
    failA1("IDENTITY_MISMATCH", "promotion commit workflow id differs from frozen policy");
  const validation = readOuterValidationGateRecord({
    ...normalized,
    outer_iteration: cycle.outer_iteration,
  });
  assertEvidenceHash(
    normalized.project_root,
    validation.evidence_refs,
    validation.evidence_sha256,
    "validation evidence",
  );
  if (validation.validation_result !== "passed" || validation.finalist_id === null)
    failA1("PROMOTION_NOT_ALLOWED", "promotion commit requires one passed validation finalist");
  const promotion = readOuterPromotionGateRecord({
    ...normalized,
    outer_iteration: cycle.outer_iteration,
  });
  assertEvidenceHash(
    normalized.project_root,
    promotion.evidence_refs,
    promotion.evidence_sha256,
    "promotion evidence",
  );
  const testerChildren = state.children.filter(
    (child) =>
      child.kind === "tester" &&
      child.outer_iteration === cycle.outer_iteration &&
      child.generation === cycle.generation,
  );
  if (testerChildren.length !== 1)
    failA1("TESTER_REQUIRED", "promotion commit requires exactly one tester child");
  if (testerChildren[0]!.status === "active")
    failA1("OUTER_CLEANUP_REQUIRED", "tester child must be terminal before promotion commit");
  const tester = readTesterRunState(normalized.project_root, testerChildren[0]!.child_run_id);
  const mapping = readOuterTesterArmMapping({
    ...normalized,
    outer_iteration: cycle.outer_iteration,
  });
  if (
    promotion.tester_run_id !== tester.tester_run_id ||
    promotion.promotion_trial_id !== tester.promotion_trial_id ||
    promotion.result !== tester.gate_status
  )
    failA1("PROMOTION_GATE_CONFLICT", "promotion gate does not match the tester public state");
  assertTesterConclusionMatches(
    options.testerConclusion.conclusion,
    tester,
    cycle,
    mapping,
    promotion.result,
  );
  if (
    tester.task_id !== frozen.task_id ||
    tester.tester_id !== frozen.tester_id ||
    tester.tester_version !== frozen.tester_version ||
    tester.tester_definition_sha256 !== frozen.tester_definition.definition_sha256 ||
    tester.harness_sha256 !== frozen.tester_definition.harness_sha256
  )
    failA1("IDENTITY_MISMATCH", "tester public state differs from the frozen policy");
  const ledger = readExposureLedger(
    normalized.project_root,
    frozen.task_id,
    frozen.tester_definition.max_exposures_per_task,
  );
  const exposureMatches = ledger.exposures.filter(
    (exposure) => exposure.promotion_trial_id === tester.promotion_trial_id,
  );
  if (exposureMatches.length !== 1)
    failA1("EXPOSURE_NOT_FOUND", "promotion commit requires one matching tester exposure");
  const exposure = exposureMatches[0]!;
  assertExposureMatches(exposure, tester, options.testerConclusion.conclusion);
  if (tester.finalist_artifact_sha256 === tester.matching_baseline_artifact_sha256)
    failA1("MATCHING_BASELINE_REQUIRED", "tester baseline and finalist artifacts must differ");
  const baselineArtifactId = assertParentRegistryFacts(
    registry,
    frozen.incumbent,
    tester.matching_baseline_artifact_sha256,
  );
  const candidate = candidateFacts(
    registry,
    validation.finalist_id,
    frozen.incumbent.generation + 1,
    frozen.model_usage_policy,
    tester.finalist_artifact_sha256,
  );
  const finalistEntry = candidate.output_entries.find(
    (entry) => entry.sha256 === tester.finalist_artifact_sha256,
  );
  if (!finalistEntry)
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      "tester finalist does not identify a registered promotion output",
    );
  assertTesterArtifactBinding(
    mapping.arm_a.artifact_id,
    baselineArtifactId,
    tester.matching_baseline_artifact_sha256,
    "tester_arm_mapping.arm_a.artifact_id",
  );
  assertTesterArtifactBinding(
    mapping.arm_b.artifact_id,
    finalistEntry.artifact_id,
    tester.finalist_artifact_sha256,
    "tester_arm_mapping.arm_b.artifact_id",
  );
  const testerStatePath = testerRunStatePath(normalized.project_root, tester.tester_run_id);
  if (hashFile(testerStatePath) !== promotion.tester_state_sha256)
    failA1("PROMOTION_GATE_CONFLICT", "promotion gate does not match the current tester state");
  const expectedActive = expectedActiveIncumbent(frozen.incumbent, candidate);
  const activeIncumbent = readActiveIncumbent(normalized.project_root, frozen.workflow_id);
  const parentWasCurrent = sameJson(activeIncumbent, frozen.incumbent, "incumbent-v1");
  if (!parentWasCurrent && !sameJson(activeIncumbent, expectedActive, "incumbent-v1"))
    failA1("PROMOTION_PARENT_CONFLICT", "active incumbent is not the frozen promotion parent");
  if (options.testerConclusion.conclusion.status === "rejected" && !parentWasCurrent)
    failA1("PROMOTION_PARENT_CONFLICT", "a rejected promotion cannot accept a changed incumbent");
  const budget = currentPromotionBudget(state, cycle, tester.tester_run_id);
  const testerFeedback = feedbackForCommit(
    options.testerFeedback.envelope,
    options.testerConclusion.conclusion,
    tester,
    promotion.result,
    frozen,
  );
  const evidence =
    options.evidencePaths === undefined
      ? null
      : hashOuterEvidence(normalized.project_root, options.evidencePaths);
  const intentPath = promotionCommitIntentPath(
    normalized.project_root,
    normalized.outer_run_id,
    cycle.outer_iteration,
  );
  const existingIntent = readIntentAt(intentPath);
  if (options.evidencePaths === undefined && existingIntent !== null)
    assertEvidenceHash(
      normalized.project_root,
      existingIntent.evidence_refs,
      existingIntent.evidence_sha256,
      "promotion commit evidence",
    );
  const expectedFacts: PromotionIntentFacts = {
    schema_version: 1,
    outer_run_id: normalized.outer_run_id,
    outer_iteration: cycle.outer_iteration,
    generation: candidate.generation,
    task_id: frozen.task_id,
    workflow_id: frozen.workflow_id,
    wave_id: cycle.wave_id,
    wave_kind: cycle.wave_kind,
    validation: {
      evidence_sha256: validation.evidence_sha256,
      finalist_id: validation.finalist_id,
      selected_cell_id: validation.selected_cell_id,
    },
    promotion: {
      tester_run_id: tester.tester_run_id,
      promotion_trial_id: tester.promotion_trial_id,
      result: promotion.result,
      tester_state_sha256: promotion.tester_state_sha256,
      evidence_sha256: promotion.evidence_sha256,
    },
    tester_conclusion: options.testerConclusion.conclusion,
    tester_receipt_sha256: options.testerConclusion.receipt_sha256,
    tester_arm_mapping: mapping,
    parent: frozen.incumbent,
    finalist: {
      candidate_id: candidate.candidate_id,
      generation: candidate.generation,
      producer_run_id: candidate.producer_run_id,
      role_artifacts: candidate.role_artifacts,
      promotion_outputs: candidate.promotion_outputs,
      candidate_output_artifact_ids: candidate.candidate_output_artifact_ids,
    },
    feedback: testerFeedback,
    feedback_sha256: canonicalJsonSha256(testerFeedback, undefined, {
      schemaVersion: "tester-feedback-v1",
    }),
    tester_feedback_receipt_sha256: options.testerFeedback.receipt_sha256,
    budget: { reservation_id: budget.reservation_id, amount: budget.amount, unit: budget.unit },
    evidence_refs: evidence?.evidence_refs ?? existingIntent?.evidence_refs ?? [],
    evidence_sha256: evidence?.evidence_sha256 ?? existingIntent?.evidence_sha256 ?? "",
    expected_parent_sha256: snapshotHash(frozen.incumbent),
    expected_active_incumbent_sha256: snapshotHash(expectedActive),
  };
  if (expectedFacts.evidence_refs.length === 0 || expectedFacts.evidence_sha256 === "")
    failA1("OUTER_EVIDENCE_REQUIRED", "promotion commit needs evidence on its first invocation");
  const expectedIntent = buildIntent(expectedFacts);
  const intent = persistPreparedIntent(intentPath, expectedIntent);
  if (intent.status !== "prepared" && intent.intent_sha256 !== expectedIntent.intent_sha256)
    failA1("PROMOTION_COMMIT_CONFLICT", "terminal promotion intent differs from this request");
  return {
    intent,
    activeIncumbent,
    expectedActiveIncumbent: expectedActive,
    tester,
    exposure,
    frozen,
    cycle,
    testerFeedback,
    testerFeedbackReceiptSha256: options.testerFeedback.receipt_sha256,
    parentWasCurrent,
  };
}

function applyPreparedCommit(
  prepared: PreparedCommit,
  registry: ArtifactRegistry,
  state: WorkflowRuntimeState,
  normalized: Required<OuterRunIdentity>,
): { state: WorkflowRuntimeState; result: PromotionCommitResult } {
  const intent = prepared.intent;
  const feedback = persistFeedback(
    normalized.project_root,
    prepared.tester.tester_run_id,
    prepared.testerFeedback,
  );
  recordTesterFeedbackEvent(
    normalized.project_root,
    prepared.tester.task_id,
    prepared.tester.promotion_trial_id,
    feedback.feedback_event_id,
    prepared.frozen.tester_definition.max_exposures_per_task,
  );
  settleExposure(
    normalized.project_root,
    prepared.tester.task_id,
    prepared.tester.promotion_trial_id,
    prepared.frozen.tester_definition.max_exposures_per_task,
  );
  const afterFeedbackLedger = readExposureLedger(
    normalized.project_root,
    prepared.tester.task_id,
    prepared.frozen.tester_definition.max_exposures_per_task,
  );
  const afterFeedback = afterFeedbackLedger.exposures.find(
    (exposure) => exposure.promotion_trial_id === prepared.tester.promotion_trial_id,
  );
  if (!afterFeedback)
    failA1("EXPOSURE_NOT_FOUND", "promotion exposure disappeared while committing");
  assertExposureMatches(afterFeedback, prepared.tester, intent.tester_conclusion);
  if (
    afterFeedback.status !== "settled" ||
    afterFeedback.feedback_event_id !== feedback.feedback_event_id
  )
    failA1("EXPOSURE_CONFLICT", "promotion exposure was not settled by its feedback event");

  let active = readActiveIncumbent(normalized.project_root, prepared.frozen.workflow_id);
  let replaced = false;
  if (intent.promotion.result === "passed") {
    if (sameJson(active, prepared.expectedActiveIncumbent, "incumbent-v1")) {
      // The pointer update completed before a crash; do not run it again.
    } else if (sameJson(active, prepared.frozen.incumbent, "incumbent-v1")) {
      commitPromotionAtomically(normalized.project_root, prepared.frozen.workflow_id, {
        expected_parent_sha256: intent.expected_parent_sha256,
        candidate_id: intent.finalist.candidate_id,
        generation: intent.finalist.generation,
        role_artifacts: intent.finalist.role_artifacts,
        producer_run_id: intent.finalist.producer_run_id,
        policy: prepared.frozen.model_usage_policy,
        registry,
        promotion_outputs: intent.finalist.promotion_outputs,
        candidate_output_artifact_ids: intent.finalist.candidate_output_artifact_ids,
      });
      replaced = true;
      active = readActiveIncumbent(normalized.project_root, prepared.frozen.workflow_id);
    } else {
      failA1("PROMOTION_PARENT_CONFLICT", "active incumbent changed before its atomic replacement");
    }
    if (!sameJson(active, prepared.expectedActiveIncumbent, "incumbent-v1"))
      failA1(
        "PROMOTION_COMMIT_CONFLICT",
        "active incumbent does not equal the exact finalist commit",
      );
  } else if (!sameJson(active, prepared.frozen.incumbent, "incumbent-v1")) {
    failA1("PROMOTION_PARENT_CONFLICT", "rejected promotion cannot replace the incumbent");
  }

  const settledState = settlePromotionBudget(state, intent);
  const terminalStatus = intent.promotion.result === "passed" ? "committed" : "rejected";
  const terminalIntent = setIntentStatus(
    promotionCommitIntentPath(
      normalized.project_root,
      normalized.outer_run_id,
      intent.outer_iteration,
    ),
    intent.intent_sha256,
    terminalStatus,
  );
  const cycle = prepared.cycle;
  const nextState = setCycleCommitReference(
    settledState,
    cycle,
    promotionCommitIntentPath(
      normalized.project_root,
      normalized.outer_run_id,
      intent.outer_iteration,
    ),
    normalized.project_root,
    normalized.outer_run_id,
  );
  return {
    state: nextState,
    result: {
      status: terminalStatus,
      replaced,
      intent: terminalIntent,
      active_incumbent: active,
      feedback_event_id: feedback.feedback_event_id,
    },
  };
}

function commitWithConclusion(
  input: OuterRunIdentity,
  registry: ArtifactRegistry,
  options: CommitOptions,
): PromotionCommitResult {
  reconcileOuterChildren(input);
  return withOuterRuntimeMutation(input, (state, normalized) => {
    const prepared = prepareCommit(registry, options, state, normalized);
    if (!options.execute) {
      const active = readActiveIncumbent(normalized.project_root, prepared.frozen.workflow_id);
      return {
        state,
        result: {
          status: prepared.intent.promotion.result === "passed" ? "committed" : "rejected",
          replaced: false,
          intent: prepared.intent,
          active_incumbent: active,
          feedback_event_id: prepared.testerFeedback.feedback_event_id,
        },
      };
    }
    return applyPreparedCommit(prepared, registry, state, normalized);
  });
}

export function preparePromotionCommit(input: PromotionCommitInput): PromotionCommitIntent {
  const conclusion = readTesterConclusion(input.project_root, input.tester_public_receipt);
  const testerFeedback = readTesterFeedback(input.project_root, input.tester_feedback_receipt);
  const result = commitWithConclusion(input, input.registry, {
    testerConclusion: conclusion,
    testerFeedback,
    evidencePaths: input.evidence_paths,
    execute: false,
  });
  return result.intent;
}

export function preparePromotionCommitForTest(
  input: PromotionCommitTestInput,
): PromotionCommitIntent {
  const conclusion = readTestTesterConclusion(
    input.signed_tester_public_receipt,
    input.tester_public_key,
  );
  const testerFeedback = readTestTesterFeedback(
    input.signed_tester_feedback,
    input.tester_feedback_public_key,
  );
  const result = commitWithConclusion(input, input.registry, {
    testerConclusion: conclusion,
    testerFeedback,
    evidencePaths: input.evidence_paths,
    execute: false,
  });
  return result.intent;
}

export function commitPromotion(input: PromotionCommitInput): PromotionCommitResult {
  const conclusion = readTesterConclusion(input.project_root, input.tester_public_receipt);
  const testerFeedback = readTesterFeedback(input.project_root, input.tester_feedback_receipt);
  return commitWithConclusion(input, input.registry, {
    testerConclusion: conclusion,
    testerFeedback,
    evidencePaths: input.evidence_paths,
    execute: true,
  });
}

export function recoverPromotionCommit(input: RecoverPromotionCommitInput): PromotionCommitResult {
  readPromotionCommitIntent({
    ...input,
    outer_iteration: readOuterRunStateIteration(input),
  });
  // The intent records what was accepted, but it is not an authority by itself:
  // a recovery must re-verify both signed public receipts with their root-owned keys.
  const conclusion = readTesterConclusion(input.project_root, input.tester_public_receipt);
  const testerFeedback = readTesterFeedback(input.project_root, input.tester_feedback_receipt);
  return commitWithConclusion(input, input.registry, {
    testerConclusion: conclusion,
    testerFeedback,
    evidencePaths: input.evidence_paths,
    execute: true,
  });
}

function readOuterRunStateIteration(input: OuterRunIdentity): number {
  const state = readOuterRunState(input);
  if (state.active_cycle === null)
    failA1("OUTER_CYCLE_REQUIRED", "promotion recovery needs an active cycle");
  return state.active_cycle.outer_iteration;
}

export function commitPromotionForTest(input: PromotionCommitTestInput): PromotionCommitResult {
  const conclusion = readTestTesterConclusion(
    input.signed_tester_public_receipt,
    input.tester_public_key,
  );
  const testerFeedback = readTestTesterFeedback(
    input.signed_tester_feedback,
    input.tester_feedback_public_key,
  );
  return commitWithConclusion(input, input.registry, {
    testerConclusion: conclusion,
    testerFeedback,
    evidencePaths: input.evidence_paths,
    execute: true,
  });
}

export function recoverPromotionCommitForTest(
  input: RecoverPromotionCommitTestInput,
): PromotionCommitResult {
  readPromotionCommitIntent({
    ...input,
    outer_iteration: readOuterRunStateIteration(input),
  });
  const conclusion = readTestTesterConclusion(
    input.signed_tester_public_receipt,
    input.tester_public_key,
  );
  const testerFeedback = readTestTesterFeedback(
    input.signed_tester_feedback,
    input.tester_feedback_public_key,
  );
  return commitWithConclusion(input, input.registry, {
    testerConclusion: conclusion,
    testerFeedback,
    evidencePaths: input.evidence_paths,
    execute: true,
  });
}

export const executePromotionCommit = commitPromotion;
export const applyPromotionCommit = commitPromotion;
