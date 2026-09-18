import fs from "node:fs";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { runOwnedPath } from "./run-contract.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertRunId,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";

/**
 * The acceptance a run's own reviewer signs before the run may publish a result
 * package.
 *
 * A result package is what every later run takes as given, so it cannot be a
 * document the producing run simply asserts. Until this file existed, the only
 * thing standing between a run and its own published conclusion was a pair of
 * command-line strings: `--reviewer` and `--review-id` were copied into the
 * write receipt verbatim and never resolved, so a run naming any reviewer other
 * than itself passed the check. That is a spelling rule, not a review.
 *
 * What makes this an acceptance is `package_sha256`. A result package is built
 * deterministically from its inputs, so a reviewer holding the candidate can
 * compute the same digest the producer will. Binding the verdict to that digest
 * is what stops the producer from getting one package approved and publishing
 * another: change any field and the stored acceptance no longer describes what
 * is being written, and the write is refused.
 *
 * This is deliberately not a `review-submit.ts` receipt. That system covers the
 * reviews a parent owns over work it dispatched -- a validation comparison, a
 * scorer revision, a promotion test -- and every one of its paths asserts that
 * the outer run lists the reviewed run as its child. A research run's own
 * reviewer is inside the run, reviewing the run's own output, with no parent
 * involved and no parent entitled to know the run exists.
 */
export interface ResultReview {
  schema_version: 1;
  /** Names the acceptance so a package can point back at it. */
  review_id: string;
  /** The run whose package this accepts. Also the producer. */
  run_id: string;
  /** Who accepted it. Never the producing run. */
  reviewer_worker_id: string;
  /** The exact package this verdict is about. */
  package_sha256: string;
  verdict: "approved" | "rejected";
  /** What the reviewer read, for an audit that comes later. */
  evidence_refs: string[];
  /** Why, in the reviewer's own coarse terms. Empty is allowed. */
  reason_codes: string[];
}

export function resultReviewPath(projectRoot: string, runId: string, reviewId: string): string {
  return runOwnedPath(
    projectRoot,
    assertIdentifier(runId, "run_id"),
    "reviews",
    `${assertIdentifier(reviewId, "review_id")}.json`,
  );
}

function assertStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_RESULT_REVIEW", `${location} must be an array`);
  return (value as unknown[]).map((item, index) => requireString(item, `${location}[${index}]`));
}

export function validateResultReview(value: unknown, location = "result_review"): ResultReview {
  if (!isRecord(value)) failA1("INVALID_RESULT_REVIEW", `${location} must be an object`, location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "review_id",
      "run_id",
      "reviewer_worker_id",
      "package_sha256",
      "verdict",
      "evidence_refs",
      "reason_codes",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("INVALID_RESULT_REVIEW", `${location}.schema_version must be 1`, location);
  const verdict = value.verdict;
  if (verdict !== "approved" && verdict !== "rejected")
    failA1("INVALID_RESULT_REVIEW", `${location}.verdict must be approved or rejected`, location);
  const runId = assertRunId(value.run_id, `${location}.run_id`);
  const reviewer = assertIdentifier(value.reviewer_worker_id, `${location}.reviewer_worker_id`);
  if (reviewer === runId)
    failA1("REVIEWER_NOT_INDEPENDENT", "a run cannot accept its own result package", location);
  return {
    schema_version: 1,
    review_id: assertIdentifier(value.review_id, `${location}.review_id`),
    run_id: runId,
    reviewer_worker_id: reviewer,
    package_sha256: assertSha256(value.package_sha256, `${location}.package_sha256`),
    verdict,
    evidence_refs: assertStringArray(value.evidence_refs ?? [], `${location}.evidence_refs`),
    reason_codes: assertStringArray(value.reason_codes ?? [], `${location}.reason_codes`),
  };
}

/**
 * Land a reviewer's verdict. Immutable: a reviewer that wants to change its
 * mind about the same package under the same review id is refused, because the
 * package may already have been published on the strength of the first answer.
 */
export function saveResultReview(projectRoot: string, input: unknown): ResultReview {
  const review = validateResultReview(input);
  const filePath = resultReviewPath(projectRoot, review.run_id, review.review_id);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateResultReview(readStateFile(filePath), filePath);
      if (
        existing.package_sha256 !== review.package_sha256 ||
        existing.verdict !== review.verdict ||
        existing.reviewer_worker_id !== review.reviewer_worker_id
      )
        failA1("IMMUTABLE_CONFLICT", "result review is immutable", filePath);
      return existing;
    }
    writeStateJsonAtomic(filePath, review);
    return review;
  });
}

/**
 * Resolve the acceptance a package write claims, and refuse the write unless it
 * holds up. This is the check `state-file.ts` cannot perform: it knows what a
 * receipt looks like, not whether the document it names exists or says yes.
 */
export function requireApprovedResultReview(input: {
  project_root: string;
  run_id: string;
  review_id: string;
  package_sha256: string;
}): ResultReview {
  const filePath = resultReviewPath(input.project_root, input.run_id, input.review_id);
  if (!fs.existsSync(filePath))
    failA1(
      "RESULT_REVIEW_NOT_FOUND",
      `result package needs the review that accepted it at ${filePath}`,
      filePath,
    );
  const review = validateResultReview(readStateFile(filePath), filePath);
  if (review.run_id !== input.run_id)
    failA1("IDENTITY_MISMATCH", "result review belongs to a different run", filePath);
  if (review.verdict !== "approved")
    failA1("RESULT_REVIEW_REJECTED", "result review did not accept this package", filePath);
  if (review.package_sha256 !== input.package_sha256)
    failA1(
      "RESULT_REVIEW_SUBJECT_MISMATCH",
      "result review accepted a different package than the one being written",
      filePath,
    );
  return review;
}
