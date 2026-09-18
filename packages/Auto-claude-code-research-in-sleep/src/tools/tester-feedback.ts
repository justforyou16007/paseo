import fs from "node:fs";
import { runOwnedPath } from "./run-contract.js";
import { canonicalJsonSha256, canonicalJsonString } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  readTesterRunState,
  readStoredTesterPrivateResult,
  readStoredTesterReview,
  recordTesterFeedbackEvent,
  markTesterStarted,
  sealPrivateTesterResult,
  settleExposure,
  readExposureLedger,
  testerDefinitionPath,
  testerPrivateResultSha256,
  validateTesterDefinition,
} from "./tester-state.js";
import {
  assertIdentifier,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";

export type TesterConclusion = "improved" | "not_improved" | "inconclusive";
export type TesterDirection =
  | "long_horizon_stability"
  | "tool_use_consistency"
  | "safety_regression"
  | "cost_efficiency"
  | "interface_compatibility";
export type TesterAdvice =
  | "increase_long_horizon_consistency"
  | "strengthen_tool_use_consistency"
  | "review_safety_margin"
  | "reduce_cost_variance"
  | "tighten_interface_contracts";

export interface TesterFeedback {
  schema_version: 1;
  task_id: string;
  task_setup_revision: string;
  input_snapshot_sha256: string;
  promotion_trial_id: string;
  tester_version: string;
  conclusion: TesterConclusion;
  directions: TesterDirection[];
  advice: TesterAdvice[];
  confidence: "low" | "medium" | "high";
  /**
   * Aggregate values for the metrics the tester definition declared, keyed by
   * metric name. This is the only numeric channel out of the tester, and it is
   * bounded by the frozen declaration rather than by the key heuristics below:
   * a declared metric may be called `pass_rate_score` without that making it a
   * per-case score. `publishTesterFeedback` is where the names are checked
   * against `gate.primaries`.
   */
  metrics: Record<string, number>;
  feedback_event_id: string;
}

/** Enough metrics for a real objective, few enough that per-case values cannot hide here. */
const MAX_PUBLIC_METRICS = 16;

const FORBIDDEN_KEYS = new Set([
  "case_id",
  "case_ids",
  "prompt",
  "question",
  "answer",
  "score",
  "scores",
  "per_case",
  "private_uri",
  "artifact_uri",
  "result_uri",
  "raw_result",
  "exact_example",
  "category",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPrivateKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
  return (
    normalized.includes("caseid") ||
    normalized.includes("caseids") ||
    normalized.includes("prompt") ||
    normalized.includes("question") ||
    normalized.includes("answer") ||
    normalized.includes("score") ||
    normalized.includes("percase") ||
    normalized.includes("uri") ||
    normalized.includes("exactexample") ||
    normalized.includes("exactsample") ||
    normalized.includes("category") ||
    normalized.includes("subcategory") ||
    normalized.includes("fine") ||
    normalized.includes("subtype") ||
    normalized.includes("rawresult") ||
    normalized.includes("private")
  );
}

function isPrivateString(value: string): boolean {
  return /(?:https?|file):\/\/|\/\.aris(?:\/|$)|\bcase(?:[_: -]?id)?\s*[:=]/i.test(value);
}

function rejectPrivate(value: unknown, location: string): void {
  if (typeof value === "string" && isPrivateString(value))
    failA1("PRIVATE_EVIDENCE_LEAK", "tester feedback contains a private reference", location);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivate(item, `${location}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isPrivateKey(key))
      failA1("PRIVATE_EVIDENCE_LEAK", `tester feedback cannot contain '${key}'`, location);
    if (typeof child === "string" && isPrivateString(child))
      failA1("PRIVATE_EVIDENCE_LEAK", "tester feedback contains a private reference", location);
    rejectPrivate(child, `${location}.${key}`);
  }
}

function stringArray(value: unknown, location: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  )
    failA1("INVALID_TESTER_FEEDBACK", `${location} must be a non-empty string array`);
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

/**
 * The declared metric values. Names are checked against the frozen tester
 * definition at publish time; here the rule is only that they are aggregate
 * numbers under plain names, so nothing case-shaped can ride along.
 */
function publicMetrics(value: unknown): Record<string, number> {
  if (!isRecord(value))
    failA1("INVALID_TESTER_FEEDBACK", "tester_feedback.metrics must be an object");
  const entries = Object.entries(value);
  if (entries.length === 0)
    failA1("INVALID_TESTER_FEEDBACK", "tester_feedback.metrics must name at least one metric");
  if (entries.length > MAX_PUBLIC_METRICS)
    failA1(
      "PRIVATE_EVIDENCE_LEAK",
      `tester feedback may publish at most ${MAX_PUBLIC_METRICS} metrics`,
    );
  const metrics: Record<string, number> = {};
  for (const [name, score] of entries) {
    const metricName = assertIdentifier(name, `tester_feedback.metrics.${name}`);
    if (typeof score !== "number" || !Number.isFinite(score))
      failA1(
        "INVALID_TESTER_FEEDBACK",
        `tester_feedback.metrics.${metricName} must be a finite number`,
      );
    metrics[metricName] = score;
  }
  return metrics;
}

export function sanitizeTesterFeedback(value: unknown): TesterFeedback {
  if (!isRecord(value)) failA1("INVALID_TESTER_FEEDBACK", "tester feedback must be an object");
  // The declared metrics are checked on their own terms, so they are held out
  // of the key heuristics that guard every other field.
  const { metrics: declaredMetrics, ...rest } = value;
  rejectPrivate(rest, "tester_feedback");
  const allowed = [
    "schema_version",
    "task_id",
    "task_setup_revision",
    "input_snapshot_sha256",
    "promotion_trial_id",
    "tester_version",
    "conclusion",
    "directions",
    "advice",
    "confidence",
    "metrics",
    "feedback_event_id",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", `unknown tester feedback field '${key}'`);
  if (value.schema_version !== 1) failA1("INVALID_TESTER_FEEDBACK", "schema_version must be 1");
  if (
    value.conclusion !== "improved" &&
    value.conclusion !== "not_improved" &&
    value.conclusion !== "inconclusive"
  )
    failA1("INVALID_TESTER_FEEDBACK", "invalid coarse tester conclusion");
  if (value.confidence !== "low" && value.confidence !== "medium" && value.confidence !== "high")
    failA1("INVALID_TESTER_FEEDBACK", "invalid coarse confidence");
  const directions = stringArray(value.directions, "tester_feedback.directions");
  const allowedDirections = new Set<TesterDirection>([
    "long_horizon_stability",
    "tool_use_consistency",
    "safety_regression",
    "cost_efficiency",
    "interface_compatibility",
  ]);
  if (directions.some((direction) => !allowedDirections.has(direction as TesterDirection)))
    failA1("INVALID_TESTER_FEEDBACK", "feedback direction is not in the fixed coarse vocabulary");
  if (new Set(directions).size !== directions.length)
    failA1("INVALID_TESTER_FEEDBACK", "feedback directions must be unique");
  const advice = stringArray(value.advice, "tester_feedback.advice");
  const allowedAdvice = new Set<TesterAdvice>([
    "increase_long_horizon_consistency",
    "strengthen_tool_use_consistency",
    "review_safety_margin",
    "reduce_cost_variance",
    "tighten_interface_contracts",
  ]);
  if (advice.some((item) => !allowedAdvice.has(item as TesterAdvice)))
    failA1("INVALID_TESTER_FEEDBACK", "feedback advice is not in the fixed coarse vocabulary");
  if (new Set(advice).size !== advice.length)
    failA1("INVALID_TESTER_FEEDBACK", "feedback advice must be unique");
  for (const item of advice) {
    if (item.length > 240 || /case[_ -]?id|score|prompt|answer|https?:\/\/|\/\.aris\//i.test(item))
      failA1(
        "PRIVATE_EVIDENCE_LEAK",
        "tester advice contains a case, score, URI, or other private detail",
      );
  }
  const feedbackWithoutId = { ...value };
  delete feedbackWithoutId.feedback_event_id;
  const expectedFeedbackId = `tester-feedback:sha256:${canonicalJsonSha256(feedbackWithoutId, undefined, { schemaVersion: "tester-feedback-v1" })}`;
  if (value.feedback_event_id !== expectedFeedbackId)
    failA1("INVALID_TESTER_FEEDBACK", "feedback_event_id does not match the sanitized content");
  return {
    schema_version: 1,
    task_id: assertIdentifier(value.task_id, "tester_feedback.task_id"),
    task_setup_revision: assertIdentifier(
      value.task_setup_revision,
      "tester_feedback.task_setup_revision",
    ),
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      "tester_feedback.input_snapshot_sha256",
    ),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      "tester_feedback.promotion_trial_id",
    ),
    tester_version: assertIdentifier(value.tester_version, "tester_feedback.tester_version"),
    conclusion: value.conclusion,
    directions: directions as TesterDirection[],
    advice: advice as TesterAdvice[],
    confidence: value.confidence,
    metrics: publicMetrics(declaredMetrics),
    feedback_event_id: assertIdentifier(
      value.feedback_event_id,
      "tester_feedback.feedback_event_id",
    ),
  };
}

export function buildTesterFeedback(
  input: Omit<TesterFeedback, "feedback_event_id">,
): TesterFeedback {
  const digest = canonicalJsonSha256(input, undefined, { schemaVersion: "tester-feedback-v1" });
  return sanitizeTesterFeedback({
    ...input,
    feedback_event_id: `tester-feedback:sha256:${digest}`,
  });
}

export function testerFeedbackPath(projectRoot: string, testerRunId: string): string {
  return runOwnedPath(projectRoot, testerRunId, "tester-feedback.json");
}

export function publishTesterFeedback(input: {
  project_root: string;
  tester_run_id: string;
  actor: "outer_committer" | "tester_worker" | "sanitizer" | "reviewer";
  feedback: unknown;
}): TesterFeedback {
  if (input.actor !== "outer_committer")
    failA1("WRITE_SCOPE_FORBIDDEN", "only the outer committer may publish tester feedback");
  const feedback = sanitizeTesterFeedback(input.feedback);
  const testerRun = readTesterRunState(input.project_root, input.tester_run_id);
  const privateResult = readStoredTesterPrivateResult(input.project_root, input.tester_run_id);
  const review = readStoredTesterReview(input.project_root, input.tester_run_id);
  if (review.subject.private_result_sha256 !== testerPrivateResultSha256(privateResult))
    failA1(
      "PRIVATE_RESULT_HASH_MISMATCH",
      "tester feedback does not identify the stored private result",
    );
  if (review.verdict !== "approved")
    failA1("TESTER_FEEDBACK_NOT_READY", "tester feedback requires an approved tester review");
  if (
    !testerRun.gate_consumed ||
    (testerRun.status !== "passed" && testerRun.status !== "rejected") ||
    testerRun.task_id !== feedback.task_id ||
    testerRun.task_setup_revision !== feedback.task_setup_revision ||
    testerRun.input_snapshot_sha256 !== feedback.input_snapshot_sha256 ||
    testerRun.promotion_trial_id !== feedback.promotion_trial_id ||
    testerRun.tester_version !== feedback.tester_version
  ) {
    failA1(
      "TESTER_FEEDBACK_NOT_READY",
      "tester feedback requires a terminal, gate-consumed tester run with matching identity",
    );
  }
  if (
    (testerRun.gate_status === "passed" && feedback.conclusion !== "improved") ||
    (testerRun.gate_status === "rejected" && feedback.conclusion === "improved")
  )
    failA1(
      "TESTER_FEEDBACK_NOT_READY",
      "tester feedback conclusion does not match the consumed gate result",
    );
  const definitionPath = testerDefinitionPath(
    input.project_root,
    testerRun.tester_id,
    testerRun.tester_version,
  );
  if (!fs.existsSync(definitionPath))
    failA1("TESTER_DEFINITION_NOT_FOUND", `tester definition does not exist at ${definitionPath}`);
  const definition = validateTesterDefinition(readStateFile(definitionPath));
  if (
    definition.tester_id !== testerRun.tester_id ||
    definition.version !== testerRun.tester_version ||
    definition.definition_sha256 !== testerRun.tester_definition_sha256 ||
    definition.case_manifest_sha256 !== testerRun.case_manifest_sha256 ||
    definition.seed_manifest_sha256 !== testerRun.seed_manifest_sha256
  ) {
    failA1("IDENTITY_MISMATCH", "tester feedback does not match the frozen tester definition");
  }
  if (privateResult.tester_definition_sha256 !== testerRun.tester_definition_sha256)
    failA1("PRIVATE_RESULT_HASH_MISMATCH", "tester feedback does not match private tester results");
  // The frozen declaration is the whole contract for the numeric channel: every
  // declared metric must be reported, and nothing else may be. Checking both
  // directions is what stops the tester widening its own disclosure later.
  const declared = definition.gate.primaries.map((primary) => primary.name);
  const reported = Object.keys(feedback.metrics).sort(compareIdentityStrings);
  if (
    declared.length !== reported.length ||
    declared.some((name, index) => name !== reported[index])
  )
    failA1(
      "INVALID_TESTER_FEEDBACK",
      "tester feedback metrics must be exactly the metrics the tester definition declares",
    );
  const filePath = testerFeedbackPath(input.project_root, input.tester_run_id);
  const published = withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (canonicalJsonString(existing) === canonicalJsonString(feedback)) return feedback;
      failA1("IMMUTABLE_CONFLICT", `tester feedback already exists at ${filePath}`);
    }
    writeStateJsonAtomic(filePath, feedback);
    return feedback;
  });
  const ledger = readExposureLedger(
    input.project_root,
    testerRun.task_id,
    definition.max_exposures_per_task,
  );
  const exposure = ledger.exposures.find(
    (candidate) => candidate.promotion_trial_id === testerRun.promotion_trial_id,
  );
  if (!exposure) failA1("EXPOSURE_NOT_FOUND", "tester feedback has no exposure reservation");
  if (exposure.status === "reserved") {
    markTesterStarted(
      input.project_root,
      testerRun.task_id,
      testerRun.promotion_trial_id,
      definition.max_exposures_per_task,
    );
    if (testerRun.private_result_sha256 !== null)
      sealPrivateTesterResult(
        input.project_root,
        testerRun.task_id,
        testerRun.promotion_trial_id,
        testerRun.private_result_sha256,
        definition.max_exposures_per_task,
      );
  }
  recordTesterFeedbackEvent(
    input.project_root,
    testerRun.task_id,
    testerRun.promotion_trial_id,
    published.feedback_event_id,
    definition.max_exposures_per_task,
  );
  settleExposure(
    input.project_root,
    testerRun.task_id,
    testerRun.promotion_trial_id,
    definition.max_exposures_per_task,
  );
  return published;
}
