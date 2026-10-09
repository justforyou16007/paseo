/**
 * Submission records on the validation machine. Each submission directory holds
 * one status.json; the service, the CLI and finalize all change it under one lock.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "../state-file.js";
import { failA1 } from "../validate.js";
import { meetsTarget, validationDir, type ValidationConfig } from "./config.js";

export type SubmissionStatus =
  | "awaiting_upload"
  | "queued"
  | "reviewing"
  | "scored"
  | "rejected_cheating"
  | "unusable"
  /** Not counted: the upload never arrived. */
  | "expired"
  /** Not counted: the deliverable was malformed (zip, size, USAGE.md). */
  | "invalid"
  /** Not counted: our side failed (agent could not start, review timed out). */
  | "failed"
  /** Not counted: validation completed or closed before this one was reviewed. */
  | "cancelled";

export interface SubmissionRecord {
  schema_version: 1;
  submission_id: string;
  status: SubmissionStatus;
  created_at: string;
  updated_at: string;
  note?: string;
  upload?: { token_sha256: string; expires_at: string };
  deliverable?: { sha256: string; bytes: number; files: number };
  agent_id?: string;
  review_started_at?: string;
  /** The full benchmark run finalize scores. */
  evaluation?: { test_dir: string };
  feedback_rejections?: number;
  /** Public reason for expired, invalid, failed and cancelled. */
  reason?: string;
}

export type Verdict = "valid" | "cheating" | "unusable";
export interface PublishedResult {
  schema_version: 1;
  submission_id: string;
  verdict: Verdict;
  /** Null unless the verdict is valid; a cheating verdict voids any measured score. */
  score: number | null;
  metric: string;
  meets_target: boolean;
  /** Empty when every rewrite still leaked hidden data. */
  feedback: string;
  published_at: string;
}

export const COUNTED: readonly SubmissionStatus[] = [
  "queued",
  "reviewing",
  "scored",
  "rejected_cheating",
  "unusable",
];
const FINAL: readonly SubmissionStatus[] = [
  "scored",
  "rejected_cheating",
  "unusable",
  "expired",
  "invalid",
  "failed",
  "cancelled",
];
const SUBMISSION_ID = /^s\d{3,}$/;

export const submissionsDir = (root: string): string =>
  path.join(validationDir(root), "submissions");
export function submissionDir(root: string, id: string): string {
  if (!SUBMISSION_ID.test(id)) failA1("UNKNOWN_SUBMISSION", `no submission ${id}`);
  return path.join(submissionsDir(root), id);
}
const statusFile = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "status.json");
export const publishedFile = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "published.json");
export const deliverableZip = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "deliverable.zip");
export const unpackedDir = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "unpacked");

/** Every read-modify-write of submission records goes through this one lock. */
export function withSubmissionsLock<T>(root: string, action: () => T): T {
  return withStateFileLock(submissionsDir(root), action);
}

export function readSubmission(root: string, id: string): SubmissionRecord {
  const file = statusFile(root, id);
  if (!fs.existsSync(file)) failA1("UNKNOWN_SUBMISSION", `no submission ${id}`);
  return readStateFile<SubmissionRecord>(file);
}
export function listSubmissions(root: string): SubmissionRecord[] {
  const dir = submissionsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => SUBMISSION_ID.test(name) && fs.existsSync(statusFile(root, name)))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map((name) => readSubmission(root, name));
}
export function readPublished(root: string, id: string): PublishedResult | null {
  const file = publishedFile(root, id);
  return fs.existsSync(file) ? readStateFile<PublishedResult>(file) : null;
}
export function countedSubmissions(root: string): number {
  return listSubmissions(root).filter((record) => COUNTED.includes(record.status)).length;
}

/** Caller holds the lock. Final records never change again. */
export function updateSubmission(
  root: string,
  id: string,
  change: Partial<SubmissionRecord>,
): SubmissionRecord {
  const current = readSubmission(root, id);
  if (FINAL.includes(current.status))
    failA1("SUBMISSION_FINAL", `submission ${id} is already ${current.status}`);
  const next = { ...current, ...change, updated_at: new Date().toISOString() };
  writeStateJsonAtomic(statusFile(root, id), next);
  return next;
}

export type ServiceState = "open" | "completed" | "closed";
export interface ServiceSummary {
  state: ServiceState;
  metric: ValidationConfig["metric"];
  max_submissions: number;
  counted: number;
  /** Slots left after counted submissions and live upload reservations. */
  remaining: number;
  best: { submission_id: string; score: number } | null;
}

export function serviceSummary(root: string, config: ValidationConfig): ServiceSummary {
  const records = listSubmissions(root),
    now = Date.now();
  let best: ServiceSummary["best"] = null,
    completed = false;
  for (const record of records) {
    const published = readPublished(root, record.submission_id);
    if (published?.verdict !== "valid" || published.score === null) continue;
    if (published.meets_target) completed = true;
    const better =
      best === null ||
      (config.metric.direction === "higher_better"
        ? published.score > best.score
        : published.score < best.score);
    if (better) best = { submission_id: record.submission_id, score: published.score };
  }
  const counted = records.filter((record) => COUNTED.includes(record.status)).length;
  const reserved = records.filter(
    (record) => record.status === "awaiting_upload" && Date.parse(record.upload!.expires_at) > now,
  ).length;
  const inFlight = records.some((record) => ["queued", "reviewing"].includes(record.status));
  return {
    state: completed
      ? "completed"
      : counted >= config.limits.max_submissions && !inFlight
        ? "closed"
        : "open",
    metric: config.metric,
    max_submissions: config.limits.max_submissions,
    counted,
    remaining: Math.max(0, config.limits.max_submissions - counted - reserved),
    best,
  };
}

/** Reserve a slot and an upload URL token. Refused once validation has completed or closed. */
export function createSubmission(
  root: string,
  config: ValidationConfig,
  note: string | undefined,
): { record: SubmissionRecord; upload_token: string } {
  return withSubmissionsLock(root, () => {
    const summary = serviceSummary(root, config);
    if (summary.state === "completed")
      failA1("VALIDATION_COMPLETED", "the target was already met; no more submissions");
    if (summary.remaining < 1) failA1("SUBMISSION_LIMIT", "no submissions remain");
    const records = listSubmissions(root);
    const last = records.at(-1);
    const id = `s${String((last ? Number(last.submission_id.slice(1)) : 0) + 1).padStart(3, "0")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const now = new Date();
    const record: SubmissionRecord = {
      schema_version: 1,
      submission_id: id,
      status: "awaiting_upload",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      ...(note ? { note: note.slice(0, 2000) } : {}),
      upload: {
        token_sha256: crypto.createHash("sha256").update(token).digest("hex"),
        expires_at: new Date(
          now.getTime() + config.limits.upload_ttl_minutes * 60_000,
        ).toISOString(),
      },
    };
    fs.mkdirSync(submissionDir(root, id), { recursive: true });
    writeStateJsonAtomic(statusFile(root, id), record);
    return { record, upload_token: token };
  });
}

export function publish(root: string, result: PublishedResult, config: ValidationConfig): void {
  if (result.verdict !== "valid" && (result.score !== null || result.meets_target))
    failA1("INVALID_RESULT", "only a valid verdict carries a score");
  if (result.score !== null && result.meets_target !== meetsTarget(config, result.score))
    failA1("INVALID_RESULT", "meets_target disagrees with the frozen target");
  writeStateJsonAtomic(publishedFile(root, result.submission_id), result);
}
