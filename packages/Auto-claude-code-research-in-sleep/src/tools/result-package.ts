import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertRelativePath,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireString,
} from "./workflow-spec.js";
import {
  normalizeScopePath,
  requireRunContract,
  runOwnedPath,
  type RunRecord,
} from "./run-contract.js";
import { requireApprovedResultReview } from "./result-review.js";
import {
  type PremiseWriteReceipt,
  readStateFile,
  withStateFileLock,
  writeStateFileAtomic,
  writeVerifiedStateJsonAtomic,
} from "./state-file.js";

export type ResultStatus = "succeeded" | "failed" | "not_executable" | "infra_unavailable";

export interface ResultFailure {
  reason: string;
  failure_code: string;
  evidence_refs: string[];
}

export interface ResultChildSummary {
  run_id: string;
  status: ResultStatus;
  summary_sha256: string;
}

export interface ResultPackage {
  schema_version: 1;
  run_id: string;
  run_version: string;
  parent_run_id: string | null;
  scope_path: string;
  status: ResultStatus;
  input_snapshot_sha256: string;
  output_paths: string[];
  output_hashes: Record<string, string>;
  summary_sha256: string;
  best_idea_ref: string | null;
  execution_plan_ref: string | null;
  evidence_refs: string[];
  child_summaries: ResultChildSummary[];
  cost_actual: number | { amount: number; unit: string };
  failure?: ResultFailure;
  local_metrics?: Record<string, number>;
  interface_record_ref?: string | null;
  wiki_head_ref?: string | null;
  signal_id?: string | null;
  package_sha256: string;
}

export interface ResultPackageInput {
  run_id: string;
  run_version?: string;
  parent_run_id?: string | null;
  scope_path?: string;
  status: ResultStatus;
  input_snapshot_sha256: string;
  output_paths?: readonly string[];
  output_hashes?: Record<string, string>;
  summary?: string;
  summary_sha256?: string;
  best_idea_ref?: string | null;
  execution_plan_ref?: string | null;
  evidence_refs?: readonly string[];
  child_summaries?: readonly ResultChildSummary[];
  cost_actual?: number | { amount: number; unit: string };
  failure?: ResultFailure;
  local_metrics?: Record<string, number>;
  interface_record_ref?: string | null;
  wiki_head_ref?: string | null;
  signal_id?: string | null;
}

const RESULT_SCHEMA = "result-package-v1";

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_RESULT_PACKAGE", "expected an array", location);
  const result = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", "array contains duplicates", location);
  return result;
}

function hashMap(value: unknown, location: string): Record<string, string> {
  if (!isRecord(value))
    failA1("INVALID_RESULT_PACKAGE", "output_hashes must be an object", location);
  const result: Record<string, string> = {};
  for (const [outputPath, hash] of Object.entries(value)) {
    const normalizedPath = assertRelativePath(outputPath, `${location}.${outputPath}`);
    if (Object.hasOwn(result, normalizedPath))
      failA1("DUPLICATE_ID", "output paths collide after normalization", location);
    result[normalizedPath] = assertSha256(hash, `${location}.${outputPath}`);
  }
  return result;
}

function normalizeCost(value: unknown): ResultPackage["cost_actual"] {
  if (value === undefined) return 0;
  if (typeof value === "number") {
    const amount = requireFiniteNumber(value, "result_package.cost_actual");
    if (amount < 0)
      failA1(
        "INVALID_RESULT_PACKAGE",
        "cost_actual cannot be negative",
        "result_package.cost_actual",
      );
    return amount;
  }
  if (!isRecord(value))
    failA1(
      "INVALID_RESULT_PACKAGE",
      "cost_actual must be a number or object",
      "result_package.cost_actual",
    );
  assertNoUnknownFields(value, ["amount", "unit"], "result_package.cost_actual");
  const amount = requireFiniteNumber(value.amount, "result_package.cost_actual.amount");
  if (amount < 0)
    failA1(
      "INVALID_RESULT_PACKAGE",
      "cost_actual cannot be negative",
      "result_package.cost_actual.amount",
    );
  return { amount, unit: requireString(value.unit, "result_package.cost_actual.unit") };
}

function normalizeFailure(value: unknown, location = "result_package.failure"): ResultFailure {
  if (!isRecord(value)) failA1("INVALID_RESULT_PACKAGE", "failure must be an object", location);
  assertNoUnknownFields(value, ["reason", "failure_code", "evidence_refs"], location);
  return {
    reason: requireString(value.reason, `${location}.reason`),
    failure_code: assertIdentifier(value.failure_code, `${location}.failure_code`),
    evidence_refs: stringList(value.evidence_refs, `${location}.evidence_refs`),
  };
}

function normalizeChildSummaries(value: unknown): ResultChildSummary[] {
  if (!Array.isArray(value))
    failA1(
      "INVALID_RESULT_PACKAGE",
      "child_summaries must be an array",
      "result_package.child_summaries",
    );
  const result = value.map((item, index) => {
    const location = `result_package.child_summaries[${index}]`;
    if (!isRecord(item))
      failA1("INVALID_RESULT_PACKAGE", "child summary must be an object", location);
    assertNoUnknownFields(item, ["run_id", "status", "summary_sha256"], location);
    const status = item.status;
    if (
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "not_executable" &&
      status !== "infra_unavailable"
    )
      failA1("INVALID_RESULT_PACKAGE", "child status is invalid", `${location}.status`);
    return {
      run_id: assertIdentifier(item.run_id, `${location}.run_id`),
      status: status as ResultStatus,
      summary_sha256: assertSha256(item.summary_sha256, `${location}.summary_sha256`),
    };
  });
  if (new Set(result.map((item) => item.run_id)).size !== result.length)
    failA1("DUPLICATE_ID", "child run ids must be unique", "result_package.child_summaries");
  return result.sort((left, right) => compareIdentityStrings(left.run_id, right.run_id));
}

function normalizeMetrics(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    failA1(
      "INVALID_RESULT_PACKAGE",
      "local_metrics must be an object",
      "result_package.local_metrics",
    );
  const result: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    result[requireString(name, `result_package.local_metrics.${name}`)] = requireFiniteNumber(
      metric,
      `result_package.local_metrics.${name}`,
    );
  }
  return result;
}

function packageWithoutHash(value: Omit<ResultPackage, "package_sha256">): object {
  return {
    schema_version: value.schema_version,
    run_id: value.run_id,
    run_version: value.run_version,
    parent_run_id: value.parent_run_id,
    scope_path: value.scope_path,
    status: value.status,
    input_snapshot_sha256: value.input_snapshot_sha256,
    output_paths: value.output_paths,
    output_hashes: value.output_hashes,
    summary_sha256: value.summary_sha256,
    best_idea_ref: value.best_idea_ref,
    execution_plan_ref: value.execution_plan_ref,
    evidence_refs: value.evidence_refs,
    child_summaries: value.child_summaries,
    cost_actual: value.cost_actual,
    ...(value.failure === undefined ? {} : { failure: value.failure }),
    ...(value.local_metrics === undefined ? {} : { local_metrics: value.local_metrics }),
    ...(value.interface_record_ref === undefined
      ? {}
      : { interface_record_ref: value.interface_record_ref }),
    ...(value.wiki_head_ref === undefined ? {} : { wiki_head_ref: value.wiki_head_ref }),
    ...(value.signal_id === undefined ? {} : { signal_id: value.signal_id }),
  };
}

function packageHash(value: Omit<ResultPackage, "package_sha256">): string {
  return canonicalJsonSha256(packageWithoutHash(value), undefined, {
    schemaVersion: RESULT_SCHEMA,
  });
}

function buildPackage(input: ResultPackageInput, summarySha256: string): ResultPackage {
  const runId = assertIdentifier(input.run_id, "result_package.run_id");
  const parentRunId =
    input.parent_run_id === undefined || input.parent_run_id === null
      ? null
      : assertIdentifier(input.parent_run_id, "result_package.parent_run_id");
  const scopePath = normalizeScopePath(
    input.scope_path === undefined ? "/" : input.scope_path,
    "result_package.scope_path",
  );
  const status = input.status;
  if (
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "not_executable" &&
    status !== "infra_unavailable"
  )
    failA1("INVALID_RESULT_PACKAGE", "status is invalid", "result_package.status");
  const outputHashes = hashMap(
    input.output_hashes === undefined ? {} : input.output_hashes,
    "result_package.output_hashes",
  );
  const outputPaths =
    input.output_paths === undefined
      ? Object.keys(outputHashes).sort(compareIdentityStrings)
      : stringList(input.output_paths, "result_package.output_paths").map((outputPath, index) =>
          assertRelativePath(outputPath, `result_package.output_paths[${index}]`),
        );
  const sortedOutputPaths = [...outputPaths].sort(compareIdentityStrings);
  const sortedHashPaths = Object.keys(outputHashes).sort(compareIdentityStrings);
  if (JSON.stringify(sortedOutputPaths) !== JSON.stringify(sortedHashPaths))
    failA1(
      "INVALID_RESULT_PACKAGE",
      "output_paths and output_hashes must name the same files",
      "result_package",
    );
  const failure = input.failure === undefined ? undefined : normalizeFailure(input.failure);
  if (
    (status === "succeeded" && failure !== undefined) ||
    (status !== "succeeded" && failure === undefined)
  )
    failA1(
      "INVALID_RESULT_PACKAGE",
      "failure must match the result status",
      "result_package.failure",
    );
  const packageWithoutDigest: Omit<ResultPackage, "package_sha256"> = {
    schema_version: 1,
    run_id: runId,
    run_version: assertIdentifier(
      input.run_version === undefined ? "1" : input.run_version,
      "result_package.run_version",
    ),
    parent_run_id: parentRunId,
    scope_path: scopePath,
    status,
    input_snapshot_sha256: assertSha256(
      input.input_snapshot_sha256,
      "result_package.input_snapshot_sha256",
    ),
    output_paths: sortedOutputPaths,
    output_hashes: outputHashes,
    summary_sha256: assertSha256(summarySha256, "result_package.summary_sha256"),
    best_idea_ref:
      input.best_idea_ref === undefined || input.best_idea_ref === null
        ? null
        : requireString(input.best_idea_ref, "result_package.best_idea_ref"),
    execution_plan_ref:
      input.execution_plan_ref === undefined || input.execution_plan_ref === null
        ? null
        : requireString(input.execution_plan_ref, "result_package.execution_plan_ref"),
    evidence_refs:
      input.evidence_refs === undefined
        ? []
        : stringList(input.evidence_refs, "result_package.evidence_refs"),
    child_summaries:
      input.child_summaries === undefined ? [] : normalizeChildSummaries(input.child_summaries),
    cost_actual: normalizeCost(input.cost_actual),
    ...(failure === undefined ? {} : { failure }),
    ...(input.local_metrics === undefined
      ? {}
      : { local_metrics: normalizeMetrics(input.local_metrics)! }),
    ...(input.interface_record_ref === undefined
      ? {}
      : {
          interface_record_ref:
            input.interface_record_ref === null
              ? null
              : requireString(input.interface_record_ref, "result_package.interface_record_ref"),
        }),
    ...(input.wiki_head_ref === undefined
      ? {}
      : {
          wiki_head_ref:
            input.wiki_head_ref === null
              ? null
              : requireString(input.wiki_head_ref, "result_package.wiki_head_ref"),
        }),
    ...(input.signal_id === undefined
      ? {}
      : {
          signal_id:
            input.signal_id === null
              ? null
              : requireString(input.signal_id, "result_package.signal_id"),
        }),
  };
  return { ...packageWithoutDigest, package_sha256: packageHash(packageWithoutDigest) };
}

export function createResultPackage(input: ResultPackageInput): ResultPackage {
  if (!isRecord(input))
    failA1("INVALID_RESULT_PACKAGE", "result package input must be an object", "result_package");
  assertNoUnknownFields(
    input,
    [
      "run_id",
      "run_version",
      "parent_run_id",
      "scope_path",
      "status",
      "input_snapshot_sha256",
      "output_paths",
      "output_hashes",
      "summary",
      "summary_sha256",
      "best_idea_ref",
      "execution_plan_ref",
      "evidence_refs",
      "child_summaries",
      "cost_actual",
      "failure",
      "local_metrics",
      "interface_record_ref",
      "wiki_head_ref",
      "signal_id",
    ],
    "result_package",
  );
  const summary =
    input.summary === undefined ? "" : requireString(input.summary, "result_package.summary");
  const summaryHash = sha256Text(summary);
  if (
    input.summary_sha256 !== undefined &&
    assertSha256(input.summary_sha256, "result_package.summary_sha256") !== summaryHash
  )
    failA1(
      "RESULT_SUMMARY_HASH_MISMATCH",
      "summary_sha256 does not match summary",
      "result_package.summary_sha256",
    );
  return buildPackage(input, summaryHash);
}

export function validateResultPackage(value: unknown, location = "result_package"): ResultPackage {
  if (!isRecord(value))
    failA1("CORRUPT_RESULT_PACKAGE", "result package must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "run_id",
      "run_version",
      "parent_run_id",
      "scope_path",
      "status",
      "input_snapshot_sha256",
      "output_paths",
      "output_hashes",
      "summary_sha256",
      "best_idea_ref",
      "execution_plan_ref",
      "evidence_refs",
      "child_summaries",
      "cost_actual",
      "failure",
      "local_metrics",
      "interface_record_ref",
      "wiki_head_ref",
      "signal_id",
      "package_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_RESULT_PACKAGE", "schema_version must be 1", location);
  for (const field of [
    "run_id",
    "run_version",
    "parent_run_id",
    "scope_path",
    "status",
    "input_snapshot_sha256",
    "output_paths",
    "output_hashes",
    "summary_sha256",
    "best_idea_ref",
    "execution_plan_ref",
    "evidence_refs",
    "child_summaries",
    "cost_actual",
    "package_sha256",
  ])
    if (!Object.hasOwn(value, field))
      failA1("CORRUPT_RESULT_PACKAGE", `${field} is required`, `${location}.${field}`);
  const result = buildPackage(
    {
      run_id: assertIdentifier(value.run_id, `${location}.run_id`),
      run_version: assertIdentifier(value.run_version, `${location}.run_version`),
      parent_run_id:
        value.parent_run_id === null
          ? null
          : assertIdentifier(value.parent_run_id, `${location}.parent_run_id`),
      scope_path: requireString(value.scope_path, `${location}.scope_path`),
      status: value.status as ResultStatus,
      input_snapshot_sha256: value.input_snapshot_sha256 as string,
      output_paths: value.output_paths as string[],
      output_hashes: value.output_hashes as Record<string, string>,
      summary_sha256: value.summary_sha256 as string,
      best_idea_ref:
        value.best_idea_ref === null
          ? null
          : requireString(value.best_idea_ref, `${location}.best_idea_ref`),
      execution_plan_ref:
        value.execution_plan_ref === null
          ? null
          : requireString(value.execution_plan_ref, `${location}.execution_plan_ref`),
      evidence_refs: value.evidence_refs as string[],
      child_summaries: value.child_summaries as ResultChildSummary[],
      cost_actual: value.cost_actual as ResultPackage["cost_actual"],
      failure:
        value.failure === undefined
          ? undefined
          : normalizeFailure(value.failure, `${location}.failure`),
      local_metrics:
        value.local_metrics === undefined ? undefined : normalizeMetrics(value.local_metrics),
      interface_record_ref:
        value.interface_record_ref === undefined || value.interface_record_ref === null
          ? (value.interface_record_ref as string | null | undefined)
          : requireString(value.interface_record_ref, `${location}.interface_record_ref`),
      wiki_head_ref:
        value.wiki_head_ref === undefined || value.wiki_head_ref === null
          ? (value.wiki_head_ref as string | null | undefined)
          : requireString(value.wiki_head_ref, `${location}.wiki_head_ref`),
      signal_id:
        value.signal_id === undefined || value.signal_id === null
          ? (value.signal_id as string | null | undefined)
          : requireString(value.signal_id, `${location}.signal_id`),
    },
    assertSha256(value.summary_sha256, `${location}.summary_sha256`),
  );
  const packageSha256 = assertSha256(value.package_sha256, `${location}.package_sha256`);
  if (packageSha256 !== result.package_sha256)
    failA1(
      "RESULT_PACKAGE_HASH_MISMATCH",
      "result package hash does not match its fields",
      location,
    );
  return { ...result, package_sha256: packageSha256 };
}

export function resultPackagePath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "result-package.json");
}

export function resultSummaryPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "result-summary.md");
}

function assertPackageMatchesRun(
  packageValue: ResultPackage,
  contract: RunRecord,
  location: string,
): void {
  if (
    packageValue.run_id !== contract.run_id ||
    packageValue.parent_run_id !== contract.parent_run_id ||
    packageValue.scope_path !== contract.scope_path
  )
    failA1("IDENTITY_MISMATCH", "result package identity does not match run.json", location);
}

function defaultSummary(value: ResultPackage): string {
  const outputs = value.output_paths.length === 0 ? "(none)" : value.output_paths.join(", ");
  return [
    `status: ${value.status}`,
    `outputs: ${outputs}`,
    `run: ${value.run_id}`,
    "This summary contains no private tester cases, prompts, or raw outputs.",
  ].join("\n");
}

/**
 * Which acceptance lets this package land. A run's result package is what every
 * later run gets to take as given, so it lands only after a reviewer outside
 * the producing run has ruled on it.
 *
 * Only the review id is passed. Everything else -- who the reviewer was, what
 * it ruled, and which package it ruled on -- is read back off disk from the
 * stored acceptance, because a caller that could state those itself could state
 * whatever made the write succeed.
 */
export interface ResultPackageReview {
  /** Names the stored acceptance. Its contents, not this string, are the proof. */
  review_id: string;
}

/**
 * Build the exact package a save would write, without writing it.
 *
 * A reviewer has to rule on a digest, and the digest only means something if
 * the reviewer and the writer computed it the same way -- including the default
 * summary, which changes the hash and which the caller usually does not supply.
 * So the construction lives here and both paths call it: the export that shows
 * a candidate to a reviewer, and the save that lands the reviewed one.
 */
export function buildResultPackageForRun(
  projectRoot: string,
  runId: string,
  input: ResultPackageInput,
): { package: ResultPackage; summary: string } {
  const contract = requireRunContract(projectRoot, runId);
  const suppliedInput = { ...input, run_id: runId };
  const summaryText =
    suppliedInput.summary === undefined
      ? undefined
      : requireString(suppliedInput.summary, "result_package.summary");
  const packageValue = createResultPackage({
    ...suppliedInput,
    ...(summaryText === undefined ? {} : { summary: summaryText }),
  });
  const packagePath = resultPackagePath(projectRoot, runId);
  assertPackageMatchesRun(packageValue, contract, packagePath);
  const summary = summaryText ?? defaultSummary(packageValue);
  const packageWithSummary =
    summaryText === undefined ? createResultPackage({ ...suppliedInput, summary }) : packageValue;
  assertPackageMatchesRun(packageWithSummary, contract, packagePath);
  return { package: packageWithSummary, summary };
}

export function saveResultPackage(
  projectRoot: string,
  runId: string,
  input: ResultPackageInput,
  review: ResultPackageReview,
): ResultPackage;
export function saveResultPackage(input: {
  project_root: string;
  run_id: string;
  result: ResultPackageInput;
  review: ResultPackageReview;
}): ResultPackage;
export function saveResultPackage(
  first:
    | string
    | {
        project_root: string;
        run_id: string;
        result: ResultPackageInput;
        review: ResultPackageReview;
      },
  second?: string,
  third?: ResultPackageInput,
  fourth?: ResultPackageReview,
): ResultPackage {
  const projectRoot = typeof first === "string" ? first : first.project_root;
  const runId = typeof first === "string" ? second : first.run_id;
  const input = typeof first === "string" ? third : first.result;
  const review = typeof first === "string" ? fourth : first.review;
  if (runId === undefined || input === undefined)
    failA1("INVALID_RESULT_PACKAGE", "run_id and result are required");
  if (review === undefined)
    failA1("INVALID_RESULT_PACKAGE", "a result package needs the review that accepted it");
  const { package: packageWithSummary, summary } = buildResultPackageForRun(
    projectRoot,
    runId,
    input,
  );
  const contract = requireRunContract(projectRoot, runId);
  const packagePath = resultPackagePath(projectRoot, runId);
  const summaryPath = resultSummaryPath(projectRoot, runId);
  // Resolve the acceptance against the package that is actually about to be
  // written. Doing it here, after the summary is settled, is what makes the
  // digest comparison meaningful: an earlier draft of the same package hashes
  // differently and would not match a verdict passed on the final one.
  const acceptance = requireApprovedResultReview({
    project_root: projectRoot,
    run_id: runId,
    review_id: requireString(review.review_id, "review.review_id"),
    package_sha256: packageWithSummary.package_sha256,
  });
  const receipt: PremiseWriteReceipt = {
    producer_id: runId,
    verifier_id: acceptance.reviewer_worker_id,
    receipt_ref: acceptance.review_id,
  };
  return withStateFileLock(packagePath, () => {
    const packageExisted = fs.existsSync(packagePath);
    if (packageExisted) {
      const existing = validateResultPackage(readStateFile(packagePath), packagePath);
      assertPackageMatchesRun(existing, contract, packagePath);
      if (existing.package_sha256 !== packageWithSummary.package_sha256)
        failA1("IMMUTABLE_CONFLICT", "result package is immutable", packagePath);
      if (fs.existsSync(summaryPath)) {
        if (sha256Text(fs.readFileSync(summaryPath, "utf8")) !== existing.summary_sha256)
          failA1(
            "RESULT_SUMMARY_HASH_MISMATCH",
            "existing result summary does not match package",
            summaryPath,
          );
      } else {
        writeStateFileAtomic(summaryPath, summary);
      }
      return existing;
    }
    let packageWritten = false;
    let summaryWritten = false;
    try {
      writeVerifiedStateJsonAtomic(packagePath, packageWithSummary, receipt);
      packageWritten = true;
      withStateFileLock(summaryPath, () => {
        if (fs.existsSync(summaryPath)) {
          const existingSummary = fs.readFileSync(summaryPath, "utf8");
          if (sha256Text(existingSummary) !== packageWithSummary.summary_sha256)
            failA1(
              "RESULT_SUMMARY_HASH_MISMATCH",
              "existing result summary does not match package",
              summaryPath,
            );
        } else {
          writeStateFileAtomic(summaryPath, summary);
          summaryWritten = true;
        }
      });
      return packageWithSummary;
    } catch (error) {
      const cleanupFailures: string[] = [];
      if (summaryWritten) {
        try {
          fs.unlinkSync(summaryPath);
        } catch (cleanupError) {
          cleanupFailures.push(`cannot remove ${summaryPath}: ${String(cleanupError)}`);
        }
      }
      if (packageWritten) {
        try {
          fs.unlinkSync(packagePath);
        } catch (cleanupError) {
          cleanupFailures.push(`cannot remove ${packagePath}: ${String(cleanupError)}`);
        }
      }
      if (cleanupFailures.length > 0)
        failA1(
          "RESULT_PACKAGE_CLEANUP_FAILED",
          `result package write failed: ${cleanupFailures.join("; ")}`,
          packagePath,
        );
      throw error;
    }
  });
}

export function readResultPackage(projectRoot: string, runId: string): ResultPackage {
  const contract = requireRunContract(projectRoot, runId);
  const packagePath = resultPackagePath(projectRoot, runId);
  if (!fs.existsSync(packagePath))
    failA1("RESULT_PACKAGE_NOT_FOUND", `result package is missing at ${packagePath}`, packagePath);
  const result = validateResultPackage(readStateFile(packagePath), packagePath);
  assertPackageMatchesRun(result, contract, packagePath);
  const summaryPath = resultSummaryPath(projectRoot, runId);
  if (!fs.existsSync(summaryPath))
    failA1("RESULT_SUMMARY_NOT_FOUND", `result summary is missing at ${summaryPath}`, summaryPath);
  if (sha256Text(fs.readFileSync(summaryPath, "utf8")) !== result.summary_sha256)
    failA1(
      "RESULT_SUMMARY_HASH_MISMATCH",
      "result summary does not match result package",
      summaryPath,
    );
  return result;
}

export function resultStatusPolicy(status: ResultStatus): {
  enters_validation: boolean;
  counts_for_stop_gate: boolean;
  consumes_tester_exposure: boolean;
} {
  if (status === "succeeded")
    return { enters_validation: true, counts_for_stop_gate: false, consumes_tester_exposure: true };
  if (status === "failed")
    return { enters_validation: true, counts_for_stop_gate: true, consumes_tester_exposure: true };
  return { enters_validation: false, counts_for_stop_gate: false, consumes_tester_exposure: false };
}

export const classifyResultStatus = resultStatusPolicy;
export const validateResult = validateResultPackage;
export const createResult = createResultPackage;
export const saveResult = saveResultPackage;
export const readResult = readResultPackage;
