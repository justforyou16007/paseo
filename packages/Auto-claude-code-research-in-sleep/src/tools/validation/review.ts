/**
 * What a validation agent runs against its submission: the frozen benchmark
 * (smoke while writing the adapter, then the full run) and finalize, which
 * turns review.json and feedback.md into the published result. The score is
 * read from the checked benchmark result, never from the agent's text.
 */
import fs from "node:fs";
import path from "node:path";
import { readStateFile } from "../state-file.js";
import {
  checkTesterResult,
  executeTesterJob,
  prepareTesterJob,
  testerConfigPath,
  testerResultPath,
} from "../tester-facility.js";
import { failA1, isRecord } from "../validate.js";
import { assertFrozenBenchmark, meetsTarget, readValidationConfig } from "./config.js";
import { checkLeak } from "./leak.js";
import {
  publish,
  readSubmission,
  serviceSummary,
  submissionDir,
  unpackedDir,
  updateSubmission,
  withSubmissionsLock,
  type SubmissionRecord,
  type SubmissionStatus,
  type Verdict,
} from "./store.js";

const MAX_FEEDBACK_CHARS = 20_000;
const RUN_DIRS = { smoke: "smoke", full: "evaluation" } as const;

function reviewing(root: string, id: string): SubmissionRecord {
  const record = readSubmission(root, id);
  if (record.status !== "reviewing")
    failA1("SUBMISSION_NOT_IN_REVIEW", `submission ${id} is ${record.status}`);
  return record;
}

/** Each attempt gets a new directory: a tester job directory binds one request for good. */
export async function runBenchmark(projectRoot: string, id: string, mode: "smoke" | "full") {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const record = reviewing(root, id);
  assertFrozenBenchmark(root, config);
  const base = path.join(submissionDir(root, id), RUN_DIRS[mode]);
  fs.mkdirSync(base, { recursive: true });
  const attempt = Math.max(0, ...fs.readdirSync(base).map(Number).filter(Number.isInteger)) + 1;
  const dir = path.join(base, String(attempt));
  fs.mkdirSync(dir);
  const adapter = path.join(submissionDir(root, id), "adapter");
  prepareTesterJob(dir, testerConfigPath(root), {
    schema_version: 1,
    test_id: `${id}-${mode === "full" ? "e" : "s"}${attempt}`,
    artifact: { ref: unpackedDir(root, id), sha256: record.deliverable!.sha256 },
    ...(fs.existsSync(adapter) ? { adapter_dir: adapter } : {}),
    mode,
  });
  if (mode === "full")
    withSubmissionsLock(root, () => updateSubmission(root, id, { evaluation: { test_dir: dir } }));
  const result = await executeTesterJob(dir);
  return {
    submission_id: id,
    test_dir: dir,
    metrics: result.metrics,
    sample_count: result.sample_count,
    failed_samples: result.failed_samples,
  };
}

/** Benchmark sample ids seen by any run of this submission; feedback must not name them. */
function sampleIds(dir: string): string[] {
  const ids: string[] = [];
  for (const kind of Object.values(RUN_DIRS)) {
    const base = path.join(dir, kind);
    if (!fs.existsSync(base)) continue;
    for (const attempt of fs.readdirSync(base)) {
      const output = path.join(base, attempt, "benchmark-output.json");
      if (!fs.existsSync(output)) continue;
      const raw = readStateFile<unknown>(output);
      if (isRecord(raw) && Array.isArray(raw.samples))
        for (const sample of raw.samples)
          if (isRecord(sample) && typeof sample.id === "string") ids.push(sample.id);
    }
  }
  return ids;
}

function readReview(dir: string): Verdict {
  const file = path.join(dir, "review.json");
  if (!fs.existsSync(file)) failA1("REVIEW_MISSING", `write ${file} first`);
  const review = readStateFile<unknown>(file);
  if (
    !isRecord(review) ||
    !["valid", "cheating", "unusable"].includes(String(review.verdict)) ||
    !Array.isArray(review.reasons) ||
    !review.reasons.length ||
    review.reasons.some((reason) => typeof reason !== "string" || !reason.trim())
  )
    failA1(
      "INVALID_REVIEW",
      'review.json must be {"verdict": "valid"|"cheating"|"unusable", "reasons": ["..."]}',
    );
  return review.verdict as Verdict;
}

/** A valid verdict is scored from the latest full run, which must pass the tester's own checks. */
function measuredScore(root: string, record: SubmissionRecord): number {
  const config = readValidationConfig(root);
  if (!record.evaluation) failA1("EVALUATION_REQUIRED", "run evaluate before a valid verdict");
  const result = checkTesterResult(testerResultPath(record.evaluation.test_dir));
  assertFrozenBenchmark(root, config);
  if (result.config_sha256 !== config.tester_config_sha256)
    failA1("BENCHMARK_CHANGED", "the evaluation ran on a different benchmark");
  if (result.request.artifact.sha256 !== record.deliverable!.sha256)
    failA1("EVALUATION_MISMATCH", "the evaluation tested a different deliverable");
  const score = result.metrics[config.metric.name];
  if (score === undefined || !Number.isFinite(score))
    failA1("METRIC_MISSING", `the evaluation has no ${config.metric.name} value`);
  return score;
}

export function finalizeSubmission(projectRoot: string, id: string) {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const record = reviewing(root, id);
  const dir = submissionDir(root, id);
  const verdict = readReview(dir);
  const feedbackFile = path.join(dir, "feedback.md");
  let feedback = fs.existsSync(feedbackFile) ? fs.readFileSync(feedbackFile, "utf8").trim() : "";
  if (feedback.length > MAX_FEEDBACK_CHARS)
    failA1("FEEDBACK_TOO_LONG", `keep feedback.md under ${MAX_FEEDBACK_CHARS} characters`);
  // Cheating voids the score, and an unusable deliverable has none.
  const score = verdict === "valid" ? measuredScore(root, record) : null;

  const leak = checkLeak(
    feedback,
    config.leak_check.hidden_paths,
    config.leak_check.min_match_chars,
    sampleIds(dir),
  );
  if (leak.leaked) {
    const rejections = (record.feedback_rejections ?? 0) + 1;
    if (rejections <= config.limits.feedback_attempts) {
      withSubmissionsLock(root, () =>
        updateSubmission(root, id, { feedback_rejections: rejections }),
      );
      failA1(
        "FEEDBACK_LEAKS_HIDDEN_DATA",
        `feedback.md quotes hidden benchmark data; rewrite it with invented examples (${config.limits.feedback_attempts - rejections + 1} attempts left). Matches: ${JSON.stringify(leak.matches)}`,
      );
    }
    feedback = "";
  }

  return withSubmissionsLock(root, () => {
    reviewing(root, id);
    publish(
      root,
      {
        schema_version: 1,
        submission_id: id,
        verdict,
        score,
        metric: config.metric.name,
        meets_target: score !== null && meetsTarget(config, score),
        feedback,
        published_at: new Date().toISOString(),
      },
      config,
    );
    const status: SubmissionStatus =
      verdict === "valid" ? "scored" : verdict === "cheating" ? "rejected_cheating" : "unusable";
    updateSubmission(root, id, { status });
    return {
      submission_id: id,
      status,
      score,
      feedback_withheld: leak.leaked,
      service: serviceSummary(root, config),
    };
  });
}
