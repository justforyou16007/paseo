import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonString } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertRunId,
  assertRelativePath,
  assertSha256,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import { requireRunContract, runJsonPath, runOwnedPath } from "./run-contract.js";
import { workflowCycleDirectory, workflowCycleWorkerDirectory } from "./workflow-state.js";

export type ReviewVerdict = "approved" | "rejected" | "insufficient";
/**
 * A child research run is reviewed by its own auto-review-loop and publishes
 * that acceptance in its result package, so there is no parent-side review of a
 * child run here. What remains are the reviews a parent owns: its own
 * validation comparison, a scorer revision, and a promotion test.
 */
export type ReviewedRunKind = "workflow" | "scorer" | "tester";
export type ReviewWaveKind = "module" | "structure" | "scorer";

interface ReviewSubjectBase {
  [key: string]: unknown;
}

export interface ReviewReceiptBase {
  schema_version: 1;
  review_id: string;
  reviewed_run_id: string;
  reviewed_run_kind: ReviewedRunKind;
  outer_iteration: number;
  wave_id: string;
  wave_kind: ReviewWaveKind;
  review_stage: string;
  generation: number;
  subject: ReviewSubjectBase;
  reviewer_worker_id: string;
  evidence_bundle_id: string;
  evidence_sha256: string;
  verdict: ReviewVerdict;
  reason_codes: string[];
  evidence_refs: string[];
  command_id: string;
}

export interface WorkflowReviewReceipt extends ReviewReceiptBase {
  reviewed_run_kind: "workflow";
  review_stage: "validation";
  subject: { validation_comparison_id: string; candidate_ids: string[] };
}

export interface ScorerReviewReceipt extends ReviewReceiptBase {
  reviewed_run_kind: "scorer";
  review_stage: "scorer_revision";
  subject: {
    parent_revision: string;
    candidate_revision: string;
    delta_id: string;
    coverage_map_sha256: string;
    shared_probe_manifest_sha256: string;
  };
  breadth_verdict: ReviewVerdict;
  breadth_reason_codes: string[];
  breadth_evidence_refs: string[];
  depth_verdict: ReviewVerdict;
  depth_reason_codes: string[];
  depth_evidence_refs: string[];
}

export interface TesterReviewReceipt extends ReviewReceiptBase {
  reviewed_run_kind: "tester";
  review_stage: "promotion_test";
  wave_kind: "module" | "structure";
  subject: {
    promotion_trial_id: string;
    tester_version: string;
    case_manifest_sha256: string;
    matching_baseline_artifact_sha256: string;
    finalist_artifact_sha256: string;
    private_result_sha256: string;
  };
}

export type ReviewReceipt = WorkflowReviewReceipt | ScorerReviewReceipt | TesterReviewReceipt;

/** Created by a scheduler before the reviewer process starts. */
export interface ReviewAssignment {
  schema_version: 1;
  assignment_id: string;
  review_id: string;
  outer_run_id: string;
  reviewed_run_id: string;
  reviewed_run_kind: ReviewedRunKind;
  outer_iteration: number;
  wave_id: string;
  wave_kind: ReviewWaveKind;
  review_stage: string;
  generation: number;
  subject: ReviewSubjectBase;
  reviewer_worker_id: string;
  evidence_producer_worker_id: string;
  evidence_bundle_id: string;
  evidence_path: string;
  evidence_sha256: string;
  evidence_execution_receipt_path: string;
  evidence_execution_receipt_sha256: string;
}

export interface CreateReviewAssignmentInput {
  actor: "review_scheduler";
  project_root: string;
  review_id: string;
  outer_run_id: string;
  reviewed_run_id: string;
  reviewed_run_kind: ReviewedRunKind;
  outer_iteration: number;
  wave_id: string;
  wave_kind: ReviewWaveKind;
  review_stage: string;
  generation: number;
  subject: unknown;
  reviewer_worker_id: string;
  evidence_producer_worker_id: string;
  evidence_bundle_id: string;
  /** Scheduler-side assertion; the producer receipt remains authoritative. */
  evidence_path?: string;
}

export interface ReviewSubmission {
  status: "appended" | "skipped" | "conflict";
  receipt_path: string;
  receipt: ReviewReceipt;
}

const COMMON_FIELDS = [
  "schema_version",
  "review_id",
  "reviewed_run_id",
  "reviewed_run_kind",
  "outer_iteration",
  "wave_id",
  "wave_kind",
  "review_stage",
  "generation",
  "subject",
  "reviewer_worker_id",
  "evidence_bundle_id",
  "evidence_sha256",
  "verdict",
  "reason_codes",
  "evidence_refs",
  "command_id",
] as const;

const SCORER_ONLY_FIELDS = [
  "breadth_verdict",
  "breadth_reason_codes",
  "breadth_evidence_refs",
  "depth_verdict",
  "depth_reason_codes",
  "depth_evidence_refs",
] as const;

const REVIEW_ASSIGNMENT_FIELDS = [
  "schema_version",
  "assignment_id",
  "review_id",
  "outer_run_id",
  "reviewed_run_id",
  "reviewed_run_kind",
  "outer_iteration",
  "wave_id",
  "wave_kind",
  "review_stage",
  "generation",
  "subject",
  "reviewer_worker_id",
  "evidence_producer_worker_id",
  "evidence_bundle_id",
  "evidence_path",
  "evidence_sha256",
  "evidence_execution_receipt_path",
  "evidence_execution_receipt_sha256",
] as const;

function stringArray(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    failA1("INVALID_REVIEW", `${location} must be a non-empty string array`);
  }
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

function subjectObject(
  value: unknown,
  allowed: readonly string[],
  location: string,
): Record<string, unknown> {
  if (!isRecord(value)) failA1("INVALID_REVIEW", `${location} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      failA1("UNKNOWN_FIELD", `unknown review subject field '${key}'`, `${location}.${key}`);
    }
  }
  return value;
}

function commonReceipt(value: unknown): ReviewReceiptBase {
  if (!isRecord(value)) failA1("INVALID_REVIEW", "review receipt must be an object");
  const allowed: readonly string[] = [...COMMON_FIELDS, ...SCORER_ONLY_FIELDS];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", `unknown review receipt field '${key}'`);
  }
  if (value.schema_version !== 1) failA1("INVALID_REVIEW", "schema_version must be 1");

  const reviewedRunKind = value.reviewed_run_kind;
  if (
    reviewedRunKind !== "workflow" &&
    reviewedRunKind !== "scorer" &&
    reviewedRunKind !== "tester"
  ) {
    failA1("INVALID_REVIEW", "invalid reviewed_run_kind");
  }
  const waveKind = value.wave_kind;
  if (waveKind !== "module" && waveKind !== "structure" && waveKind !== "scorer") {
    failA1("INVALID_REVIEW", "invalid wave_kind");
  }
  const verdict = value.verdict;
  if (verdict !== "approved" && verdict !== "rejected" && verdict !== "insufficient") {
    failA1("INVALID_REVIEW", "invalid verdict");
  }
  const reviewId = assertIdentifier(value.review_id, "review.review_id");
  const reviewedRunId = assertIdentifier(value.reviewed_run_id, "review.reviewed_run_id");
  const commandId = requireString(value.command_id, "review.command_id");
  if (commandId !== `review-submit:${reviewId}`) {
    failA1("INVALID_REVIEW", "command_id must be review-submit:<review_id>");
  }
  return {
    schema_version: 1,
    review_id: reviewId,
    reviewed_run_id: reviewedRunId,
    reviewed_run_kind: reviewedRunKind,
    outer_iteration: requireInteger(value.outer_iteration, "review.outer_iteration", 1),
    wave_id: assertIdentifier(value.wave_id, "review.wave_id"),
    wave_kind: waveKind,
    review_stage: requireString(value.review_stage, "review.review_stage"),
    generation: requireInteger(value.generation, "review.generation", 1),
    subject: (() => {
      if (!isRecord(value.subject)) failA1("INVALID_REVIEW", "review.subject must be an object");
      return value.subject;
    })(),
    reviewer_worker_id: assertIdentifier(value.reviewer_worker_id, "review.reviewer_worker_id"),
    evidence_bundle_id: assertIdentifier(value.evidence_bundle_id, "review.evidence_bundle_id"),
    evidence_sha256: assertSha256(value.evidence_sha256, "review.evidence_sha256"),
    verdict,
    reason_codes: stringArray(value.reason_codes, "review.reason_codes"),
    evidence_refs: stringArray(value.evidence_refs, "review.evidence_refs"),
    command_id: commandId,
  };
}

function validateOpaqueEvidenceRefs(refs: readonly string[]): void {
  for (const reference of refs) {
    if (
      /(case[_ -]?id|prompt|question|answer|score|uri|file|private|result\s*[:=])/i.test(reference)
    ) {
      failA1("PRIVATE_EVIDENCE_LEAK", "tester review evidence refs must remain opaque");
    }
  }
}

function commonSubject(
  value: unknown,
  allowed: readonly string[],
  location: string,
): Record<string, unknown> {
  return subjectObject(value, allowed, location);
}

function normalizeReviewSubject(
  reviewedRunKind: ReviewedRunKind,
  waveKind: ReviewWaveKind,
  reviewStage: string,
  value: unknown,
): ReviewSubjectBase {
  if (reviewedRunKind === "workflow") {
    if (waveKind === "scorer" || reviewStage !== "validation") {
      failA1(
        "REVIEW_TYPE_MISMATCH",
        "workflow review must be validation on a module or structure wave",
      );
    }
    const subject = commonSubject(
      value,
      ["validation_comparison_id", "candidate_ids"],
      "review.subject",
    );
    return {
      validation_comparison_id: assertIdentifier(
        subject.validation_comparison_id,
        "review.subject.validation_comparison_id",
      ),
      candidate_ids: stringArray(subject.candidate_ids, "review.subject.candidate_ids").map(
        (item, index) => assertIdentifier(item, `review.subject.candidate_ids[${index}]`),
      ),
    };
  }

  if (reviewedRunKind === "scorer") {
    if (waveKind !== "scorer" || reviewStage !== "scorer_revision") {
      failA1("REVIEW_TYPE_MISMATCH", "scorer review must use scorer_revision on a scorer wave");
    }
    const subject = commonSubject(
      value,
      [
        "parent_revision",
        "candidate_revision",
        "delta_id",
        "coverage_map_sha256",
        "shared_probe_manifest_sha256",
      ],
      "review.subject",
    );
    return {
      parent_revision: assertIdentifier(subject.parent_revision, "review.subject.parent_revision"),
      candidate_revision: assertIdentifier(
        subject.candidate_revision,
        "review.subject.candidate_revision",
      ),
      delta_id: assertIdentifier(subject.delta_id, "review.subject.delta_id"),
      coverage_map_sha256: assertSha256(
        subject.coverage_map_sha256,
        "review.subject.coverage_map_sha256",
      ),
      shared_probe_manifest_sha256: assertSha256(
        subject.shared_probe_manifest_sha256,
        "review.subject.shared_probe_manifest_sha256",
      ),
    };
  }

  if (waveKind === "scorer" || reviewStage !== "promotion_test") {
    failA1(
      "REVIEW_TYPE_MISMATCH",
      "tester review must be promotion_test on a module or structure wave",
    );
  }
  const subject = commonSubject(
    value,
    [
      "promotion_trial_id",
      "tester_version",
      "case_manifest_sha256",
      "matching_baseline_artifact_sha256",
      "finalist_artifact_sha256",
      "private_result_sha256",
    ],
    "review.subject",
  );
  return {
    promotion_trial_id: assertIdentifier(
      subject.promotion_trial_id,
      "review.subject.promotion_trial_id",
    ),
    tester_version: assertIdentifier(subject.tester_version, "review.subject.tester_version"),
    case_manifest_sha256: assertSha256(
      subject.case_manifest_sha256,
      "review.subject.case_manifest_sha256",
    ),
    matching_baseline_artifact_sha256: assertSha256(
      subject.matching_baseline_artifact_sha256,
      "review.subject.matching_baseline_artifact_sha256",
    ),
    finalist_artifact_sha256: assertSha256(
      subject.finalist_artifact_sha256,
      "review.subject.finalist_artifact_sha256",
    ),
    private_result_sha256: assertSha256(
      subject.private_result_sha256,
      "review.subject.private_result_sha256",
    ),
  };
}

function rejectSpecializedFields(
  value: Record<string, unknown>,
  kind: "workflow" | "tester",
): void {
  for (const field of SCORER_ONLY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      failA1("UNKNOWN_FIELD", `${kind} review cannot contain scorer field '${field}'`);
    }
  }
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === "approved" || value === "rejected" || value === "insufficient";
}

export function validateReviewReceipt(value: unknown): ReviewReceipt {
  const base = commonReceipt(value);
  if (!isRecord(value)) failA1("INVALID_REVIEW", "review receipt must be an object");

  if (base.reviewed_run_kind === "workflow") {
    rejectSpecializedFields(value, "workflow");
    const subject = normalizeReviewSubject(
      base.reviewed_run_kind,
      base.wave_kind,
      base.review_stage,
      base.subject,
    ) as WorkflowReviewReceipt["subject"];
    return { ...base, reviewed_run_kind: "workflow", review_stage: "validation", subject };
  }

  if (base.reviewed_run_kind === "scorer") {
    if (base.wave_kind !== "scorer" || base.review_stage !== "scorer_revision") {
      failA1("REVIEW_TYPE_MISMATCH", "scorer review must use scorer_revision on a scorer wave");
    }
    const subject = normalizeReviewSubject(
      base.reviewed_run_kind,
      base.wave_kind,
      base.review_stage,
      base.subject,
    ) as ScorerReviewReceipt["subject"];
    const breadthVerdict = value.breadth_verdict;
    const depthVerdict = value.depth_verdict;
    if (!isReviewVerdict(breadthVerdict) || !isReviewVerdict(depthVerdict)) {
      failA1("INVALID_REVIEW", "scorer review needs breadth and depth verdicts");
    }
    return {
      ...base,
      reviewed_run_kind: "scorer",
      review_stage: "scorer_revision",
      subject,
      breadth_verdict: breadthVerdict,
      breadth_reason_codes: stringArray(value.breadth_reason_codes, "review.breadth_reason_codes"),
      breadth_evidence_refs: stringArray(
        value.breadth_evidence_refs,
        "review.breadth_evidence_refs",
      ),
      depth_verdict: depthVerdict,
      depth_reason_codes: stringArray(value.depth_reason_codes, "review.depth_reason_codes"),
      depth_evidence_refs: stringArray(value.depth_evidence_refs, "review.depth_evidence_refs"),
    };
  }

  rejectSpecializedFields(value, "tester");
  const subject = normalizeReviewSubject(
    base.reviewed_run_kind,
    base.wave_kind,
    base.review_stage,
    base.subject,
  ) as TesterReviewReceipt["subject"];
  validateOpaqueEvidenceRefs(base.evidence_refs);
  return {
    ...base,
    reviewed_run_kind: "tester",
    review_stage: "promotion_test",
    wave_kind: base.wave_kind as "module" | "structure",
    subject,
  };
}

function hashFile(filePath: string, code = "EVIDENCE_NOT_FOUND"): string {
  if (!fs.existsSync(filePath)) failA1(code, `file does not exist at ${filePath}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    failA1(code, `cannot stat file at ${filePath}`);
  }
  if (!stat.isFile()) failA1(code, `expected a regular file at ${filePath}`);
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function canonicalHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

interface ReviewIdentity {
  outer_run_id: string;
  reviewed_run_id: string;
  reviewed_run_kind: ReviewedRunKind;
  outer_iteration: number;
  wave_id: string;
  wave_kind: ReviewWaveKind;
  review_stage: string;
  generation: number;
  subject: ReviewSubjectBase;
  evidence_bundle_id: string;
}

function runRoot(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, runId);
}

function validateReviewedRun(projectRoot: string, identity: ReviewIdentity): void {
  if (identity.reviewed_run_kind === "workflow") return;
  const parentPath = runJsonPath(projectRoot, identity.outer_run_id);
  if (!fs.existsSync(parentPath))
    failA1("RUN_CONTRACT_NOT_FOUND", "review parent run.json is missing", parentPath);
  assertRealPathInside(
    path.resolve(projectRoot),
    parentPath,
    "PATH_ESCAPE",
    "review parent escapes project storage",
  );
  const parent = readStateFile(parentPath);
  if (
    !isRecord(parent) ||
    parent.run_id !== identity.outer_run_id ||
    !Array.isArray(parent.child_run_ids) ||
    !parent.child_run_ids.includes(identity.reviewed_run_id)
  ) {
    failA1("IDENTITY_MISMATCH", "parent run does not list the reviewed run as a child");
  }
  const reviewedRunRoot = runRoot(projectRoot, identity.reviewed_run_id);
  const statePath =
    identity.reviewed_run_kind === "tester"
      ? path.join(reviewedRunRoot, "tester-state.json")
      : path.join(reviewedRunRoot, "scorer-state.json");
  if (!fs.existsSync(statePath)) {
    failA1("STATE_NOT_FOUND", `reviewed run state does not exist at ${statePath}`);
  }
  assertRealPathInside(
    reviewedRunRoot,
    statePath,
    "PATH_ESCAPE",
    "reviewed run state escapes its storage directory",
  );
  const state = readStateFile(statePath);
  if (!isRecord(state)) failA1("CORRUPT_STATE", "reviewed run state must be an object", statePath);
  const runField = `${identity.reviewed_run_kind}_run_id`;
  if (state.schema_version !== 1 || state[runField] !== identity.reviewed_run_id) {
    failA1("IDENTITY_MISMATCH", "reviewed run state and review run id differ", statePath);
  }
  const expected: Array<[string, string | number]> = [
    ["outer_iteration", identity.outer_iteration],
    ["wave_id", identity.wave_id],
  ];
  for (const [field, expectedValue] of expected) {
    if (state[field] !== expectedValue) {
      failA1("IDENTITY_MISMATCH", `reviewed run state field '${field}' does not match`, statePath);
    }
  }
  if (identity.generation < requireInteger(state.generation, `${statePath}.generation`, 1)) {
    failA1("IDENTITY_MISMATCH", "review generation cannot move backwards", statePath);
  }
  // ScorerRunState has no wave_kind field: scorer runs only participate in scorer waves.
  const waveKind = identity.reviewed_run_kind === "scorer" ? "scorer" : state.wave_kind;
  if (waveKind !== identity.wave_kind) {
    failA1("IDENTITY_MISMATCH", "reviewed run state wave_kind does not match", statePath);
  }
}

function identityFromReceipt(projectRoot: string, receipt: ReviewReceipt): ReviewIdentity {
  let outerRunId = receipt.reviewed_run_id;
  if (receipt.reviewed_run_kind !== "workflow") {
    const run = requireRunContract(projectRoot, receipt.reviewed_run_id);
    if (run.parent_run_id === null) {
      failA1("PARENT_NOT_FOUND", "reviewed run has no parent");
    }
    outerRunId = run.parent_run_id;
  }
  const identity: ReviewIdentity = {
    outer_run_id: assertIdentifier(outerRunId, "outer_run_id"),
    reviewed_run_id: receipt.reviewed_run_id,
    reviewed_run_kind: receipt.reviewed_run_kind,
    outer_iteration: receipt.outer_iteration,
    wave_id: receipt.wave_id,
    wave_kind: receipt.wave_kind,
    review_stage: receipt.review_stage,
    generation: receipt.generation,
    subject: normalizeReviewSubject(
      receipt.reviewed_run_kind,
      receipt.wave_kind,
      receipt.review_stage,
      receipt.subject,
    ),
    evidence_bundle_id: receipt.evidence_bundle_id,
  };
  validateReviewedRun(projectRoot, identity);
  return identity;
}

function identityFromAssignmentInput(input: CreateReviewAssignmentInput): ReviewIdentity {
  const reviewedRunId = assertRunId(input.reviewed_run_id, "reviewed_run_id");
  const reviewedRunKind = input.reviewed_run_kind;
  if (
    reviewedRunKind !== "workflow" &&
    reviewedRunKind !== "scorer" &&
    reviewedRunKind !== "tester"
  ) {
    failA1("INVALID_REVIEW", "invalid reviewed_run_kind");
  }
  const waveKind = input.wave_kind;
  if (waveKind !== "module" && waveKind !== "structure" && waveKind !== "scorer") {
    failA1("INVALID_REVIEW", "invalid wave_kind");
  }
  return {
    outer_run_id: assertRunId(input.outer_run_id, "outer_run_id"),
    reviewed_run_id: reviewedRunId,
    reviewed_run_kind: reviewedRunKind,
    outer_iteration: requireInteger(input.outer_iteration, "outer_iteration", 1),
    wave_id: assertIdentifier(input.wave_id, "wave_id"),
    wave_kind: waveKind,
    review_stage: requireString(input.review_stage, "review_stage"),
    generation: requireInteger(input.generation, "generation", 1),
    subject: normalizeReviewSubject(reviewedRunKind, waveKind, input.review_stage, input.subject),
    evidence_bundle_id: assertIdentifier(input.evidence_bundle_id, "evidence_bundle_id"),
  };
}

function assignmentDirectory(projectRoot: string, identity: ReviewIdentity): string {
  return path.join(
    workflowCycleDirectory(projectRoot, identity.outer_run_id, identity.outer_iteration),
    "reviewer-assignments",
  );
}

function reviewerRecordPath(projectRoot: string, identity: ReviewIdentity): string {
  return path.join(
    assignmentDirectory(projectRoot, identity),
    `${assertIdentifier(identity.wave_id, "wave_id")}-generation-${identity.generation}.json`,
  );
}

function assignmentPathKey(
  identity: Pick<
    ReviewAssignment,
    | "outer_run_id"
    | "reviewed_run_id"
    | "reviewed_run_kind"
    | "outer_iteration"
    | "wave_id"
    | "wave_kind"
    | "review_stage"
    | "generation"
    | "subject"
    | "evidence_bundle_id"
  >,
): string {
  return canonicalHash({
    outer_run_id: identity.outer_run_id,
    reviewed_run_id: identity.reviewed_run_id,
    reviewed_run_kind: identity.reviewed_run_kind,
    outer_iteration: identity.outer_iteration,
    wave_id: identity.wave_id,
    wave_kind: identity.wave_kind,
    review_stage: identity.review_stage,
    generation: identity.generation,
    subject: identity.subject,
    evidence_bundle_id: identity.evidence_bundle_id,
  }).slice(0, 40);
}

function assignmentId(assignment: ReviewAssignment): string {
  return `assignment:${canonicalHash({
    schema_version: assignment.schema_version,
    review_id: assignment.review_id,
    outer_run_id: assignment.outer_run_id,
    reviewed_run_id: assignment.reviewed_run_id,
    reviewed_run_kind: assignment.reviewed_run_kind,
    outer_iteration: assignment.outer_iteration,
    wave_id: assignment.wave_id,
    wave_kind: assignment.wave_kind,
    review_stage: assignment.review_stage,
    generation: assignment.generation,
    subject: assignment.subject,
    reviewer_worker_id: assignment.reviewer_worker_id,
    evidence_producer_worker_id: assignment.evidence_producer_worker_id,
    evidence_bundle_id: assignment.evidence_bundle_id,
    evidence_path: assignment.evidence_path,
    evidence_sha256: assignment.evidence_sha256,
    evidence_execution_receipt_path: assignment.evidence_execution_receipt_path,
    evidence_execution_receipt_sha256: assignment.evidence_execution_receipt_sha256,
  }).slice(0, 40)}`;
}

function assignmentFilePath(projectRoot: string, identity: ReviewIdentity): string {
  return path.join(
    assignmentDirectory(projectRoot, identity),
    `assignment-${assignmentPathKey(identity)}.json`,
  );
}

export function reviewAssignmentPath(
  projectRoot: string,
  identity: Pick<
    ReviewAssignment,
    | "outer_run_id"
    | "reviewed_run_id"
    | "reviewed_run_kind"
    | "outer_iteration"
    | "wave_id"
    | "wave_kind"
    | "review_stage"
    | "generation"
    | "subject"
    | "evidence_bundle_id"
  >,
): string {
  return assignmentFilePath(path.resolve(projectRoot), {
    ...identity,
    subject: normalizeReviewSubject(
      identity.reviewed_run_kind,
      identity.wave_kind,
      identity.review_stage,
      identity.subject,
    ),
    evidence_bundle_id: assertIdentifier(identity.evidence_bundle_id, "evidence_bundle_id"),
  });
}

function workerDirectoryRoot(projectRoot: string, identity: ReviewIdentity): string {
  const root = runRoot(projectRoot, identity.reviewed_run_id);
  if (identity.reviewed_run_kind === "workflow") {
    return workflowCycleWorkerDirectory(
      projectRoot,
      identity.reviewed_run_id,
      identity.outer_iteration,
    );
  }
  return path.join(root, "workers");
}

function pathIsInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertRealPathInside(parent: string, child: string, code: string, message: string): void {
  let realParent: string;
  let realChild: string;
  try {
    realParent = fs.realpathSync.native(parent);
    realChild = fs.realpathSync.native(child);
  } catch {
    failA1(code, message);
  }
  const relative = path.relative(realParent, realChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    failA1(code, message);
  }
}

function assertCreationPathInside(
  parent: string,
  target: string,
  code: string,
  message: string,
): void {
  let existingParent = path.resolve(parent);
  while (!fs.existsSync(existingParent)) {
    const next = path.dirname(existingParent);
    if (next === existingParent) failA1(code, message);
    existingParent = next;
  }
  let existing = path.dirname(target);
  while (!fs.existsSync(existing)) {
    const next = path.dirname(existing);
    if (next === existing) failA1(code, message);
    existing = next;
  }
  assertRealPathInside(existingParent, existing, code, message);
  if (fs.existsSync(target)) assertRealPathInside(existingParent, target, code, message);
}

function producerWorkerDirectory(
  projectRoot: string,
  identity: ReviewIdentity,
  workerId: string,
  suppliedEvidencePath?: string,
): string {
  const workersRoot = workerDirectoryRoot(projectRoot, identity);
  const direct = path.join(workersRoot, workerId);
  const candidates: string[] = [];
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) candidates.push(direct);
  if (fs.existsSync(workersRoot)) {
    for (const entry of fs.readdirSync(workersRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = path.join(workersRoot, entry.name);
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    }
  }

  const matches: string[] = [];
  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, "input-manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: unknown;
    try {
      manifest = readStateFile(manifestPath);
    } catch {
      if (candidate === direct) return candidate;
      continue;
    }
    if (!isRecord(manifest)) {
      if (candidate === direct) return candidate;
      continue;
    }
    if (manifest.run_id !== identity.reviewed_run_id || manifest.worker !== workerId) continue;
    if (
      identity.reviewed_run_kind === "workflow" &&
      manifest.iteration !== identity.outer_iteration
    ) {
      continue;
    }
    matches.push(candidate);
  }

  if (suppliedEvidencePath !== undefined) {
    const supplied = path.isAbsolute(suppliedEvidencePath)
      ? path.resolve(suppliedEvidencePath)
      : path.resolve(projectRoot, assertRelativePath(suppliedEvidencePath, "evidence_path"));
    const selected = matches.filter((candidate) =>
      pathIsInside(path.join(candidate, "outputs"), supplied),
    );
    if (selected.length === 1) return selected[0];
    if (selected.length > 1) {
      failA1(
        "AMBIGUOUS_EXECUTION_RECEIPT",
        "more than one producer directory matches evidence_path",
      );
    }
    if (matches.length > 0) {
      failA1("IDENTITY_MISMATCH", "evidence_path does not belong to the producer output directory");
    }
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    failA1(
      "AMBIGUOUS_EXECUTION_RECEIPT",
      "more than one producer execution receipt matches the review",
    );
  }
  if (fs.existsSync(direct)) return direct;
  failA1("INPUT_MANIFEST_NOT_FOUND", `producer input manifest does not exist below ${workersRoot}`);
}

function relativeProjectPath(projectRoot: string, target: string, location: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    failA1("PATH_ESCAPE", `${location} must stay inside project root`);
  }
  return assertRelativePath(relative, location);
}

function resolveOutputDirectory(
  projectRoot: string,
  workerDir: string,
  value: unknown,
  location: string,
): string {
  const declared = requireString(value, location);
  const resolved = path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(projectRoot, declared);
  const expected = path.resolve(workerDir, "outputs");
  if (resolved !== expected) {
    failA1("IDENTITY_MISMATCH", `${location} must be the producer's outputs directory`);
  }
  return resolved;
}

interface ProducerEvidence {
  evidencePath: string;
  evidenceSha256: string;
  executionReceiptPath: string;
  executionReceiptSha256: string;
}

function producerEvidence(
  projectRoot: string,
  identity: ReviewIdentity,
  producerWorkerId: string,
  suppliedEvidencePath?: string,
): ProducerEvidence {
  const workerDir = producerWorkerDirectory(
    projectRoot,
    identity,
    producerWorkerId,
    suppliedEvidencePath,
  );
  assertRealPathInside(
    workerDirectoryRoot(projectRoot, identity),
    workerDir,
    "PATH_ESCAPE",
    "producer worker directory escapes the reviewed run",
  );
  const manifestPath = path.join(workerDir, "input-manifest.json");
  const receiptPath = path.join(workerDir, "receipt.json");
  if (!fs.existsSync(manifestPath)) {
    failA1("INPUT_MANIFEST_NOT_FOUND", `producer input manifest does not exist at ${manifestPath}`);
  }
  if (!fs.existsSync(receiptPath)) {
    failA1(
      "EXECUTION_RECEIPT_NOT_FOUND",
      `producer execution receipt does not exist at ${receiptPath}`,
    );
  }
  assertRealPathInside(
    workerDir,
    manifestPath,
    "PATH_ESCAPE",
    "producer input manifest escapes its worker directory",
  );
  assertRealPathInside(
    workerDir,
    receiptPath,
    "PATH_ESCAPE",
    "producer execution receipt escapes its worker directory",
  );
  const manifest = readStateFile(manifestPath);
  if (!isRecord(manifest))
    failA1("INVALID_INPUT_MANIFEST", "producer input manifest must be an object");
  if (manifest.run_id !== identity.reviewed_run_id || manifest.worker !== producerWorkerId) {
    failA1("IDENTITY_MISMATCH", "producer input manifest does not match the review assignment");
  }
  if (
    identity.reviewed_run_kind === "workflow" &&
    manifest.iteration !== identity.outer_iteration
  ) {
    failA1("IDENTITY_MISMATCH", "workflow producer iteration does not match the review assignment");
  }
  const outputDirectory = resolveOutputDirectory(
    projectRoot,
    workerDir,
    manifest.output_dir,
    "producer.input-manifest.output_dir",
  );

  const executionReceipt = readStateFile(receiptPath);
  if (!isRecord(executionReceipt)) {
    failA1("INVALID_EXECUTION_RECEIPT", "producer execution receipt must be an object");
  }
  if (
    executionReceipt.run_id !== identity.reviewed_run_id ||
    executionReceipt.worker !== producerWorkerId ||
    executionReceipt.status !== "done"
  ) {
    failA1("IDENTITY_MISMATCH", "producer execution receipt does not match the review assignment");
  }
  if (manifest.phase !== undefined && executionReceipt.phase !== undefined) {
    if (manifest.phase !== executionReceipt.phase) {
      failA1("IDENTITY_MISMATCH", "producer manifest and receipt phases differ");
    }
  }
  if (
    identity.reviewed_run_kind === "workflow" &&
    executionReceipt.iteration !== identity.outer_iteration
  ) {
    failA1("IDENTITY_MISMATCH", "workflow producer iteration does not match the review assignment");
  }
  const primaryOutput = requireString(
    executionReceipt.primary_output,
    "producer.receipt.primary_output",
  );
  if (path.isAbsolute(primaryOutput) || primaryOutput.split(/[\\/]/).includes("..")) {
    failA1("PATH_ESCAPE", "producer primary output must stay inside outputs");
  }
  const evidenceAbsolutePath = path.resolve(outputDirectory, primaryOutput);
  const outputRelative = path.relative(outputDirectory, evidenceAbsolutePath);
  if (outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) {
    failA1("PATH_ESCAPE", "producer primary output escapes outputs");
  }
  assertRealPathInside(
    outputDirectory,
    evidenceAbsolutePath,
    "PATH_ESCAPE",
    "producer primary output escapes the producer outputs directory",
  );
  if (suppliedEvidencePath !== undefined) {
    const supplied = path.isAbsolute(suppliedEvidencePath)
      ? path.resolve(suppliedEvidencePath)
      : path.resolve(projectRoot, assertRelativePath(suppliedEvidencePath, "evidence_path"));
    if (supplied !== evidenceAbsolutePath) {
      failA1(
        "IDENTITY_MISMATCH",
        "scheduler evidence_path differs from the receipt primary output",
      );
    }
  }
  const evidenceSha256 = hashFile(evidenceAbsolutePath);
  const receiptOutputHash =
    executionReceipt.primary_output_sha256 ??
    executionReceipt.output_sha256 ??
    executionReceipt.artifact_sha256;
  if (receiptOutputHash === undefined) {
    failA1("INVALID_EXECUTION_RECEIPT", "producer receipt must contain primary output sha256");
  }
  if (
    assertSha256(receiptOutputHash, "producer.receipt.primary_output_sha256") !== evidenceSha256
  ) {
    failA1("EVIDENCE_HASH_MISMATCH", "producer receipt hash does not match its primary output");
  }
  return {
    evidencePath: relativeProjectPath(projectRoot, evidenceAbsolutePath, "evidence_path"),
    evidenceSha256,
    executionReceiptPath: relativeProjectPath(projectRoot, receiptPath, "execution_receipt_path"),
    executionReceiptSha256: hashFile(receiptPath, "EXECUTION_RECEIPT_NOT_FOUND"),
  };
}

function validateAssignment(value: unknown, filePath: string): ReviewAssignment {
  if (!isRecord(value))
    failA1("CORRUPT_REVIEW_ASSIGNMENT", "review assignment must be an object", filePath);
  for (const key of Object.keys(value)) {
    if (!(REVIEW_ASSIGNMENT_FIELDS as readonly string[]).includes(key)) {
      failA1("CORRUPT_REVIEW_ASSIGNMENT", `unknown assignment field '${key}'`, filePath);
    }
  }
  if (value.schema_version !== 1)
    failA1("CORRUPT_REVIEW_ASSIGNMENT", "schema_version must be 1", filePath);
  const reviewedRunKind = value.reviewed_run_kind;
  if (
    reviewedRunKind !== "workflow" &&
    reviewedRunKind !== "scorer" &&
    reviewedRunKind !== "tester"
  ) {
    failA1("CORRUPT_REVIEW_ASSIGNMENT", "invalid reviewed_run_kind", filePath);
  }
  const waveKind = value.wave_kind;
  if (waveKind !== "module" && waveKind !== "structure" && waveKind !== "scorer") {
    failA1("CORRUPT_REVIEW_ASSIGNMENT", "invalid wave_kind", filePath);
  }
  const reviewStage = requireString(value.review_stage, `${filePath}.review_stage`);
  const subject = normalizeReviewSubject(reviewedRunKind, waveKind, reviewStage, value.subject);
  const assignment: ReviewAssignment = {
    schema_version: 1,
    assignment_id: assertIdentifier(value.assignment_id, `${filePath}.assignment_id`),
    review_id: assertIdentifier(value.review_id, `${filePath}.review_id`),
    outer_run_id: assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`),
    reviewed_run_id: assertIdentifier(value.reviewed_run_id, `${filePath}.reviewed_run_id`),
    reviewed_run_kind: reviewedRunKind,
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    wave_id: assertIdentifier(value.wave_id, `${filePath}.wave_id`),
    wave_kind: waveKind,
    review_stage: reviewStage,
    generation: requireInteger(value.generation, `${filePath}.generation`, 1),
    subject,
    reviewer_worker_id: assertIdentifier(
      value.reviewer_worker_id,
      `${filePath}.reviewer_worker_id`,
    ),
    evidence_producer_worker_id: assertIdentifier(
      value.evidence_producer_worker_id,
      `${filePath}.evidence_producer_worker_id`,
    ),
    evidence_bundle_id: assertIdentifier(
      value.evidence_bundle_id,
      `${filePath}.evidence_bundle_id`,
    ),
    evidence_path: assertRelativePath(value.evidence_path, `${filePath}.evidence_path`),
    evidence_sha256: assertSha256(value.evidence_sha256, `${filePath}.evidence_sha256`),
    evidence_execution_receipt_path: assertRelativePath(
      value.evidence_execution_receipt_path,
      `${filePath}.evidence_execution_receipt_path`,
    ),
    evidence_execution_receipt_sha256: assertSha256(
      value.evidence_execution_receipt_sha256,
      `${filePath}.evidence_execution_receipt_sha256`,
    ),
  };
  if (assignment.reviewer_worker_id === assignment.evidence_producer_worker_id) {
    failA1("REVIEWER_NOT_INDEPENDENT", "reviewer cannot be the evidence producer", filePath);
  }
  if (assignment.assignment_id !== assignmentId(assignment)) {
    failA1(
      "CORRUPT_REVIEW_ASSIGNMENT",
      "assignment_id does not match its immutable identity",
      filePath,
    );
  }
  return assignment;
}

function assertAssignmentMatchesReceipt(
  receipt: ReviewReceipt,
  assignment: ReviewAssignment,
): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["reviewed_run_id", receipt.reviewed_run_id, assignment.reviewed_run_id],
    ["reviewed_run_kind", receipt.reviewed_run_kind, assignment.reviewed_run_kind],
    ["outer_iteration", receipt.outer_iteration, assignment.outer_iteration],
    ["wave_id", receipt.wave_id, assignment.wave_id],
    ["wave_kind", receipt.wave_kind, assignment.wave_kind],
    ["review_stage", receipt.review_stage, assignment.review_stage],
    ["generation", receipt.generation, assignment.generation],
    ["review_id", receipt.review_id, assignment.review_id],
    ["reviewer_worker_id", receipt.reviewer_worker_id, assignment.reviewer_worker_id],
    ["evidence_bundle_id", receipt.evidence_bundle_id, assignment.evidence_bundle_id],
    ["evidence_sha256", receipt.evidence_sha256, assignment.evidence_sha256],
  ];
  for (const [field, actual, expected] of fields) {
    if (actual !== expected)
      failA1("IDENTITY_MISMATCH", `review ${field} differs from its assignment`);
  }
  if (canonicalJsonString(receipt.subject) !== canonicalJsonString(assignment.subject)) {
    failA1("IDENTITY_MISMATCH", "review subject differs from its assignment");
  }
}

function readReviewerRecord(
  filePath: string,
  identity: ReviewIdentity,
): { schema_version: 1; reviewer_worker_id: string } {
  const raw = readStateFile(filePath);
  if (!isRecord(raw) || raw.schema_version !== 1) {
    failA1("CORRUPT_REVIEW_ASSIGNMENT", "wave reviewer record is corrupt", filePath);
  }
  const allowed = [
    "schema_version",
    "outer_run_id",
    "outer_iteration",
    "wave_id",
    "wave_kind",
    "generation",
    "reviewer_worker_id",
  ];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key))
      failA1("CORRUPT_REVIEW_ASSIGNMENT", `unknown reviewer field '${key}'`, filePath);
  }
  const expected: Array<[string, string | number]> = [
    ["outer_run_id", identity.outer_run_id],
    ["outer_iteration", identity.outer_iteration],
    ["wave_id", identity.wave_id],
    ["wave_kind", identity.wave_kind],
    ["generation", identity.generation],
  ];
  for (const [field, expectedValue] of expected) {
    if (raw[field] !== expectedValue) {
      failA1("IDENTITY_MISMATCH", `wave reviewer field '${field}' does not match`, filePath);
    }
  }
  return {
    schema_version: 1,
    reviewer_worker_id: assertIdentifier(raw.reviewer_worker_id, `${filePath}.reviewer_worker_id`),
  };
}

export function createReviewAssignment(input: CreateReviewAssignmentInput): ReviewAssignment {
  if (input.actor !== "review_scheduler") {
    failA1("WRITE_SCOPE_FORBIDDEN", "only the review scheduler may create assignments");
  }
  const projectRoot = path.resolve(input.project_root);
  const identity = identityFromAssignmentInput(input);
  validateReviewedRun(projectRoot, identity);
  const reviewer = assertIdentifier(input.reviewer_worker_id, "reviewer_worker_id");
  const producer = assertIdentifier(
    input.evidence_producer_worker_id,
    "evidence_producer_worker_id",
  );
  if (reviewer === producer) {
    failA1("REVIEWER_NOT_INDEPENDENT", "reviewer cannot be the evidence producer");
  }
  const evidenceBundleId = assertIdentifier(input.evidence_bundle_id, "evidence_bundle_id");
  const reviewId = assertIdentifier(input.review_id, "review_id");
  const producerOutput = producerEvidence(projectRoot, identity, producer, input.evidence_path);
  const assignmentWithoutId: Omit<ReviewAssignment, "assignment_id"> = {
    schema_version: 1,
    review_id: reviewId,
    outer_run_id: identity.outer_run_id,
    reviewed_run_id: identity.reviewed_run_id,
    reviewed_run_kind: identity.reviewed_run_kind,
    outer_iteration: identity.outer_iteration,
    wave_id: identity.wave_id,
    wave_kind: identity.wave_kind,
    review_stage: identity.review_stage,
    generation: identity.generation,
    subject: identity.subject,
    reviewer_worker_id: reviewer,
    evidence_producer_worker_id: producer,
    evidence_bundle_id: evidenceBundleId,
    evidence_path: producerOutput.evidencePath,
    evidence_sha256: producerOutput.evidenceSha256,
    evidence_execution_receipt_path: producerOutput.executionReceiptPath,
    evidence_execution_receipt_sha256: producerOutput.executionReceiptSha256,
  };
  const assignment: ReviewAssignment = {
    ...assignmentWithoutId,
    assignment_id: assignmentId({ ...assignmentWithoutId, assignment_id: "" }),
  };
  const reviewerPath = reviewerRecordPath(projectRoot, identity);
  const assignmentPath = assignmentFilePath(projectRoot, identity);
  assertCreationPathInside(
    runRoot(projectRoot, identity.outer_run_id),
    reviewerPath,
    "PATH_ESCAPE",
    "reviewer assignment path escapes the outer run",
  );
  assertCreationPathInside(
    runRoot(projectRoot, identity.outer_run_id),
    assignmentPath,
    "PATH_ESCAPE",
    "review assignment path escapes the outer run",
  );
  return withStateFileLock(reviewerPath, () =>
    withStateFileLock(assignmentPath, () => {
      fs.mkdirSync(path.dirname(reviewerPath), { recursive: true });
      if (fs.existsSync(reviewerPath)) {
        const existing = readReviewerRecord(reviewerPath, identity);
        if (existing.reviewer_worker_id !== reviewer) {
          failA1(
            "SINGLE_REVIEWER_REQUIRED",
            "a wave and generation already has a different reviewer",
          );
        }
      } else {
        writeStateJsonAtomic(reviewerPath, {
          schema_version: 1,
          outer_run_id: identity.outer_run_id,
          outer_iteration: identity.outer_iteration,
          wave_id: identity.wave_id,
          wave_kind: identity.wave_kind,
          generation: identity.generation,
          reviewer_worker_id: reviewer,
        });
      }

      if (fs.existsSync(assignmentPath)) {
        const existing = validateAssignment(readStateFile(assignmentPath), assignmentPath);
        if (canonicalJsonString(existing) === canonicalJsonString(assignment)) return existing;
        failA1("REVIEW_ASSIGNMENT_CONFLICT", "review assignment is immutable and already differs");
      }
      writeStateJsonAtomic(assignmentPath, assignment);
      return assignment;
    }),
  );
}

function reviewOutputPath(projectRoot: string, receipt: ReviewReceipt): string {
  if (receipt.reviewed_run_kind === "workflow") {
    return path.join(
      workflowCycleWorkerDirectory(projectRoot, receipt.reviewed_run_id, receipt.outer_iteration),
      receipt.reviewer_worker_id,
      "outputs",
      "reviews",
      `${receipt.review_id}.json`,
    );
  }
  return path.join(
    runRoot(projectRoot, receipt.reviewed_run_id),
    "workers",
    receipt.reviewer_worker_id,
    "outputs",
    "reviews",
    `${receipt.review_id}.json`,
  );
}

export function reviewReceiptPath(projectRoot: string, receipt: ReviewReceipt): string {
  return reviewOutputPath(projectRoot, receipt);
}

export function reviewCommandIndexPath(projectRoot: string, commandId: string): string {
  const digest = crypto.createHash("sha256").update(commandId, "utf8").digest("hex");
  return path.join(path.resolve(projectRoot), ".aris", "review-commands", `${digest}.json`);
}

function assertNoForbiddenReviewFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenReviewFields);
    return;
  }
  if (!isRecord(value)) return;
  const forbidden = new Set([
    "dashboard_patch",
    "status_patch",
    "state_patch",
    "selected_candidate_id",
    "metric_override",
    "threshold_override",
    "wiki_event",
    "implementation_patch",
    "candidate_update",
    "candidate_patch",
    "code_patch",
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) {
      failA1("REVIEW_WRITE_FORBIDDEN", `review receipt cannot contain '${key}'`);
    }
    assertNoForbiddenReviewFields(child);
  }
}

function loadAssignmentForReceipt(
  projectRoot: string,
  receipt: ReviewReceipt,
): { identity: ReviewIdentity; assignmentPath: string; assignment: ReviewAssignment } {
  const identity = identityFromReceipt(projectRoot, receipt);
  const assignmentPath = assignmentFilePath(projectRoot, identity);
  assertCreationPathInside(
    runRoot(projectRoot, identity.outer_run_id),
    assignmentPath,
    "PATH_ESCAPE",
    "review assignment path escapes the outer run",
  );
  if (!fs.existsSync(assignmentPath)) {
    failA1(
      "REVIEW_ASSIGNMENT_NOT_FOUND",
      `review assignment must be created before submission: ${assignmentPath}`,
    );
  }
  const assignment = validateAssignment(readStateFile(assignmentPath), assignmentPath);
  if (
    assignment.outer_run_id !== identity.outer_run_id ||
    assignment.reviewed_run_id !== identity.reviewed_run_id ||
    assignment.reviewed_run_kind !== identity.reviewed_run_kind ||
    assignment.outer_iteration !== identity.outer_iteration ||
    assignment.wave_id !== identity.wave_id ||
    assignment.wave_kind !== identity.wave_kind ||
    assignment.review_stage !== identity.review_stage ||
    assignment.generation !== identity.generation ||
    canonicalJsonString(assignment.subject) !== canonicalJsonString(identity.subject)
  ) {
    failA1("IDENTITY_MISMATCH", "review assignment identity does not match the receipt");
  }
  return { identity, assignmentPath, assignment };
}

export function readReviewAssignment(
  projectRoot: string,
  receipt: ReviewReceipt,
): ReviewAssignment {
  return loadAssignmentForReceipt(path.resolve(projectRoot), receipt).assignment;
}

function recheckAssignmentEvidence(projectRoot: string, assignment: ReviewAssignment): void {
  const identity: ReviewIdentity = {
    outer_run_id: assignment.outer_run_id,
    reviewed_run_id: assignment.reviewed_run_id,
    reviewed_run_kind: assignment.reviewed_run_kind,
    outer_iteration: assignment.outer_iteration,
    wave_id: assignment.wave_id,
    wave_kind: assignment.wave_kind,
    review_stage: assignment.review_stage,
    generation: assignment.generation,
    subject: assignment.subject,
    evidence_bundle_id: assignment.evidence_bundle_id,
  };
  const derived = producerEvidence(
    projectRoot,
    identity,
    assignment.evidence_producer_worker_id,
    assignment.evidence_path,
  );
  if (
    derived.evidencePath !== assignment.evidence_path ||
    derived.evidenceSha256 !== assignment.evidence_sha256 ||
    derived.executionReceiptPath !== assignment.evidence_execution_receipt_path ||
    derived.executionReceiptSha256 !== assignment.evidence_execution_receipt_sha256
  ) {
    failA1("CORRUPT_REVIEW_ASSIGNMENT", "assignment evidence path or hash is not system-derived");
  }
  const evidencePath = path.resolve(projectRoot, assignment.evidence_path);
  const evidenceReceiptPath = path.resolve(projectRoot, assignment.evidence_execution_receipt_path);
  const evidenceRelative = path.relative(
    runRoot(projectRoot, assignment.reviewed_run_id),
    evidencePath,
  );
  if (evidenceRelative.startsWith("..") || path.isAbsolute(evidenceRelative)) {
    failA1("IDENTITY_MISMATCH", "assigned evidence must stay inside the reviewed run");
  }
  if (
    hashFile(evidenceReceiptPath, "EXECUTION_RECEIPT_NOT_FOUND") !==
    assignment.evidence_execution_receipt_sha256
  ) {
    failA1("EXECUTION_RECEIPT_CHANGED", "the evidence producer receipt changed after assignment");
  }
  if (hashFile(evidencePath) !== assignment.evidence_sha256) {
    failA1("EVIDENCE_HASH_MISMATCH", "evidence changed after the review assignment");
  }
}

function sameStoredReceipt(storedPath: string, receipt: ReviewReceipt): boolean {
  try {
    const stored = validateReviewReceipt(readStateFile(storedPath));
    return canonicalJsonString(stored) === canonicalJsonString(receipt);
  } catch {
    return false;
  }
}

interface ReviewCommandIndex {
  schema_version: 1;
  command_id: string;
  receipt_path: string;
  receipt_sha256: string;
}

function readCommandIndex(filePath: string): ReviewCommandIndex {
  const raw = readStateFile(filePath);
  if (!isRecord(raw)) {
    failA1("CORRUPT_REVIEW_INDEX", "review command index is corrupt", filePath);
  }
  const allowed = ["schema_version", "command_id", "receipt_path", "receipt_sha256"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      failA1("CORRUPT_REVIEW_INDEX", `unknown review command index field '${key}'`, filePath);
    }
  }
  if (raw.schema_version !== 1) {
    failA1("CORRUPT_REVIEW_INDEX", "review command index schema_version must be 1", filePath);
  }
  return {
    schema_version: 1,
    command_id: requireString(raw.command_id, `${filePath}.command_id`),
    receipt_path: requireString(raw.receipt_path, `${filePath}.receipt_path`),
    receipt_sha256: assertSha256(raw.receipt_sha256, `${filePath}.receipt_sha256`),
  };
}

function assertCommandIndexMatches(
  index: ReviewCommandIndex,
  receipt: ReviewReceipt,
  outputPath: string,
  receiptHash: string,
): void {
  if (
    index.command_id !== receipt.command_id ||
    path.resolve(index.receipt_path) !== path.resolve(outputPath) ||
    index.receipt_sha256 !== receiptHash
  ) {
    failA1("REVIEW_RECEIPT_CONFLICT", "review command index contains different content");
  }
}

export function readStoredReviewReceipt(projectRoot: string, value: unknown): ReviewReceipt {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const receipt = validateReviewReceipt(value);
  assertNoForbiddenReviewFields(value);
  const loaded = loadAssignmentForReceipt(resolvedProjectRoot, receipt);
  assertAssignmentMatchesReceipt(receipt, loaded.assignment);
  recheckAssignmentEvidence(resolvedProjectRoot, loaded.assignment);
  const outputPath = reviewOutputPath(resolvedProjectRoot, receipt);
  assertCreationPathInside(
    runRoot(resolvedProjectRoot, receipt.reviewed_run_id),
    outputPath,
    "PATH_ESCAPE",
    "review receipt path escapes the reviewed run",
  );
  if (!fs.existsSync(outputPath)) {
    failA1("REVIEW_NOT_FOUND", `review receipt must be stored at ${outputPath}`);
  }
  const stored = validateReviewReceipt(readStateFile(outputPath));
  assertAssignmentMatchesReceipt(stored, loaded.assignment);
  if (canonicalJsonString(stored) !== canonicalJsonString(receipt)) {
    failA1("IDENTITY_MISMATCH", "review input differs from the immutable receipt on disk");
  }
  const commandPath = reviewCommandIndexPath(resolvedProjectRoot, receipt.command_id);
  if (!fs.existsSync(commandPath)) {
    failA1("REVIEW_NOT_FOUND", `review command index is missing at ${commandPath}`);
  }
  assertCommandIndexMatches(
    readCommandIndex(commandPath),
    receipt,
    outputPath,
    canonicalHash(receipt),
  );
  return stored;
}

export function submitReviewReceipt(input: {
  project_root: string;
  receipt: unknown;
  /** @deprecated Ignored. Assignment is always loaded from disk. */
  assignment?: unknown;
  /** @deprecated Only accepted as a consistency assertion. */
  evidence_path?: string;
  manifest_run_id: string;
  command_run_id: string;
}): ReviewSubmission {
  const projectRoot = path.resolve(input.project_root);
  const receipt = validateReviewReceipt(input.receipt);
  assertNoForbiddenReviewFields(input.receipt);
  if (assertIdentifier(input.manifest_run_id, "manifest_run_id") !== receipt.reviewed_run_id) {
    failA1("IDENTITY_MISMATCH", "manifest run id does not match review");
  }
  if (assertIdentifier(input.command_run_id, "command_run_id") !== receipt.reviewed_run_id) {
    failA1("IDENTITY_MISMATCH", "command run id does not match review");
  }

  const loaded = loadAssignmentForReceipt(projectRoot, receipt);
  assertAssignmentMatchesReceipt(receipt, loaded.assignment);
  if (input.evidence_path !== undefined) {
    const supplied = path.isAbsolute(input.evidence_path)
      ? path.resolve(input.evidence_path)
      : path.resolve(projectRoot, assertRelativePath(input.evidence_path, "evidence_path"));
    if (supplied !== path.resolve(projectRoot, loaded.assignment.evidence_path)) {
      failA1("IDENTITY_MISMATCH", "caller evidence_path differs from the frozen assignment");
    }
  }

  const outputPath = reviewOutputPath(projectRoot, receipt);
  const assignmentPath = loaded.assignmentPath;
  const commandPath = reviewCommandIndexPath(projectRoot, receipt.command_id);
  assertCreationPathInside(
    runRoot(projectRoot, receipt.reviewed_run_id),
    outputPath,
    "PATH_ESCAPE",
    "review receipt path escapes the reviewed run",
  );
  assertCreationPathInside(
    path.join(projectRoot, ".aris"),
    commandPath,
    "PATH_ESCAPE",
    "review command index path escapes the project state directory",
  );
  return withStateFileLock(assignmentPath, () =>
    withStateFileLock(commandPath, () => {
      assertCreationPathInside(
        runRoot(projectRoot, receipt.reviewed_run_id),
        outputPath,
        "PATH_ESCAPE",
        "review receipt path escapes the reviewed run",
      );
      assertCreationPathInside(
        path.join(projectRoot, ".aris"),
        commandPath,
        "PATH_ESCAPE",
        "review command index path escapes the project state directory",
      );
      const assignment = validateAssignment(readStateFile(assignmentPath), assignmentPath);
      assertAssignmentMatchesReceipt(receipt, assignment);
      // Re-read the frozen execution receipt and evidence immediately before a write.
      recheckAssignmentEvidence(projectRoot, assignment);

      const currentReceiptHash = canonicalHash(receipt);
      if (fs.existsSync(outputPath)) {
        if (!sameStoredReceipt(outputPath, receipt)) {
          failA1("REVIEW_RECEIPT_CONFLICT", "review output already contains different content");
        }
        if (fs.existsSync(commandPath)) {
          assertCommandIndexMatches(
            readCommandIndex(commandPath),
            receipt,
            outputPath,
            currentReceiptHash,
          );
        } else {
          writeStateJsonAtomic(commandPath, {
            schema_version: 1,
            command_id: receipt.command_id,
            receipt_path: outputPath,
            receipt_sha256: currentReceiptHash,
          });
        }
        return { status: "skipped", receipt_path: outputPath, receipt };
      }

      if (fs.existsSync(commandPath)) {
        const index = readCommandIndex(commandPath);
        assertCommandIndexMatches(index, receipt, outputPath, currentReceiptHash);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        writeStateJsonAtomic(outputPath, receipt);
        return { status: "skipped", receipt_path: outputPath, receipt };
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      writeStateJsonAtomic(outputPath, receipt);
      // The receipt is the fact. The index is recoverable idempotency metadata.
      writeStateJsonAtomic(commandPath, {
        schema_version: 1,
        command_id: receipt.command_id,
        receipt_path: outputPath,
        receipt_sha256: currentReceiptHash,
      });
      return { status: "appended", receipt_path: outputPath, receipt };
    }),
  );
}

export const submitReview = submitReviewReceipt;
