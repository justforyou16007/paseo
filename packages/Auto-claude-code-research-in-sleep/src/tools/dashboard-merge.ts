import fs from "node:fs";
import path from "node:path";
import { createCli, runCli } from "../lib/cli.js";

type JsonObject = Record<string, unknown>;

interface Receipt {
  worker: string;
  iteration: number;
  run_id: string;
  status: "done" | "failed";
  error: JsonObject | null;
  primary_output: string | null;
  summary: JsonObject;
  dashboard_patch: JsonObject;
  completed_at: string;
  has_errors: boolean;
  error_count: number;
  experiments?: unknown;
}

interface WorkerRule {
  phases: readonly string[];
  patchKeys: Readonly<Record<string, (value: unknown) => boolean>>;
  requiredPatchKeys: readonly string[];
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
// Problem entity node ids (research-wiki `problems/<slug>.md`). Replaces the old
// free-text gap ids (G1, G2, ...); the dashboard field names stayed `gaps.*`.
const PROBLEM_ID_PATTERN = /^problem:[a-z0-9][a-z0-9._-]*$/;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isGapIdArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every((item) => PROBLEM_ID_PATTERN.test(item));
}

function isIdea(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isNullableFiniteNumber(value.metric) &&
    Number.isInteger(value.iteration) &&
    (value.iteration as number) >= 1
  );
}

function isReviewVerdict(value: unknown): boolean {
  return value === "ready" || value === "almost" || value === "not ready";
}

function isScore(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 10;
}

function isPlanPath(value: unknown): value is string {
  return isNonEmptyString(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

const WORKER_RULES: Readonly<Record<string, WorkerRule>> = {
  "idea-discovery": {
    phases: ["idea-discovery"],
    patchKeys: {
      best_idea: isIdea,
      idea_ids: isStringArray,
      plan_path: isPlanPath,
    },
    requiredPatchKeys: ["best_idea", "idea_ids", "plan_path"],
  },
  "idea-creator": {
    phases: ["idea-discovery"],
    patchKeys: {
      best_idea: isIdea,
      idea_ids: isStringArray,
    },
    requiredPatchKeys: ["best_idea", "idea_ids"],
  },
  "experiment-bridge": {
    phases: ["experiment-bridge"],
    patchKeys: {
      "metric.current": isFiniteNumber,
      "metric.delta": isNullableFiniteNumber,
      statistical_significance: (value) => typeof value === "boolean" || value === null,
      experiment_ids: (value) =>
        isStringArray(value) && value.every((item) => SLUG_PATTERN.test(item)),
    },
    requiredPatchKeys: ["metric.current", "experiment_ids"],
  },
  "analyze-results": {
    phases: ["analyze-results"],
    patchKeys: {
      "metric.current": isFiniteNumber,
      "metric.delta": isNullableFiniteNumber,
      statistical_significance: (value) => typeof value === "boolean" || value === null,
    },
    requiredPatchKeys: ["metric.current"],
  },
  "auto-review-loop": {
    phases: ["auto-review-loop", "auto-review"],
    patchKeys: {
      "last_review.verdict": isReviewVerdict,
      "last_review.score": isScore,
      "last_review.reviewer_id": isNonEmptyString,
      "metric.current": isFiniteNumber,
      "metric.delta": isNullableFiniteNumber,
      statistical_significance: (value) => typeof value === "boolean" || value === null,
    },
    requiredPatchKeys: ["last_review.verdict", "last_review.score", "last_review.reviewer_id"],
  },
  "kill-argument": {
    phases: ["kill-argument", "paper-writing"],
    patchKeys: {
      "gaps.open": isGapIdArray,
      "gaps.closed": isGapIdArray,
      "gaps.total": (value) => Number.isInteger(value) && (value as number) >= 0,
      plan_path: (value) => value === null || isPlanPath(value),
      overall_verdict: (value) => value === "PASS" || value === "WARN" || value === "FAIL",
    },
    requiredPatchKeys: ["gaps.open", "gaps.closed", "gaps.total", "overall_verdict"],
  },
  summary: {
    phases: ["summary"],
    patchKeys: {
      summary_path: isPlanPath,
    },
    requiredPatchKeys: ["summary_path"],
  },
  "paper-writing": {
    phases: ["paper-writing"],
    patchKeys: {
      paper_status: (value) => value === "compiled",
      audit_passed: (value) => typeof value === "boolean",
    },
    requiredPatchKeys: ["paper_status", "audit_passed"],
  },
  "render-html": {
    phases: ["render-html", "summary", "paper-writing", "idea-discovery", "auto-review-loop"],
    patchKeys: {
      html_rendered: (value) => typeof value === "boolean",
    },
    requiredPatchKeys: ["html_rendered"],
  },
};

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function assertNoDangerousKeys(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDangerousKeys(item, `${location}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) fail(`${location} contains forbidden key '${key}'`);
    assertNoDangerousKeys(child, `${location}.${key}`);
  }
}

function assertIsoTimestamp(value: unknown, location: string): asserts value is string {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    fail(`${location} must be an ISO-8601 timestamp`);
  }
}

function validateRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) {
    fail(`invalid run id '${runId}'`);
  }
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    fail(`cannot read ${label} at ${filePath}: ${String(error)}`);
  }
}

function validateDashboard(raw: unknown, runId: string, dashboardPath: string): JsonObject {
  if (!isObject(raw)) fail(`dashboard at ${dashboardPath} is not a JSON object`);
  assertNoDangerousKeys(raw, "dashboard");

  if (raw.run_id !== runId) {
    fail(`dashboard run_id '${String(raw.run_id)}' does not match '${runId}'`);
  }
  if (!isNonEmptyString(raw.project)) fail("dashboard.project must be a non-empty string");
  if (!["running", "finishing", "completed", "invalid"].includes(String(raw.status))) {
    fail(`dashboard.status '${String(raw.status)}' is invalid`);
  }
  if (!Number.isInteger(raw.iteration) || (raw.iteration as number) < 1) {
    fail("dashboard.iteration must be an integer >= 1");
  }
  if (!Number.isInteger(raw.max_iterations) || (raw.max_iterations as number) < 1) {
    fail("dashboard.max_iterations must be an integer >= 1");
  }
  if (!isNonEmptyString(raw.current_phase)) {
    fail("dashboard.current_phase must be a non-empty string");
  }
  if (!isObject(raw.config)) fail("dashboard.config must be an object");
  if (!isObject(raw.metric)) fail("dashboard.metric must be an object");

  const metric = raw.metric;
  if (!(metric.name === null || isNonEmptyString(metric.name))) {
    fail("dashboard.metric.name must be null or a non-empty string");
  }
  for (const field of ["target", "current", "baseline"] as const) {
    if (!isNullableFiniteNumber(metric[field])) {
      fail(`dashboard.metric.${field} must be null or finite`);
    }
  }
  if (metric.direction !== "higher_better" && metric.direction !== "lower_better") {
    fail("dashboard.metric.direction must be higher_better or lower_better");
  }
  if (!isFiniteNumber(metric.tolerance) || metric.tolerance < 0 || metric.tolerance >= 1) {
    fail("dashboard.metric.tolerance must be finite in [0, 1)");
  }
  if (!Array.isArray(metric.history)) fail("dashboard.metric.history must be an array");
  for (const [index, entry] of metric.history.entries()) {
    if (
      !isObject(entry) ||
      !Number.isInteger(entry.iter) ||
      (entry.iter as number) < 1 ||
      !isFiniteNumber(entry.value)
    ) {
      fail(`dashboard.metric.history[${index}] is invalid`);
    }
  }

  if (!isObject(raw.gaps)) fail("dashboard.gaps must be an object");
  if (!isGapIdArray(raw.gaps.open) || !isGapIdArray(raw.gaps.closed)) {
    fail("dashboard.gaps.open/closed must be arrays of gap ids");
  }
  if (!Number.isInteger(raw.gaps.total) || (raw.gaps.total as number) < 0) {
    fail("dashboard.gaps.total must be an integer >= 0");
  }
  if (!isObject(raw.last_review)) fail("dashboard.last_review must be an object");
  if (!isObject(raw.system_errors)) fail("dashboard.system_errors must be an object");
  if (
    !Number.isInteger(raw.system_errors.total) ||
    (raw.system_errors.total as number) < 0 ||
    !(raw.system_errors.last === null || typeof raw.system_errors.last === "string")
  ) {
    fail("dashboard.system_errors is invalid");
  }
  if (!Array.isArray(raw.applied_receipts) || !raw.applied_receipts.every(isNonEmptyString)) {
    fail("dashboard.applied_receipts must be a string array");
  }
  return raw;
}

function validateError(value: unknown, receiptPath: string): void {
  if (!isObject(value)) fail(`failed receipt at ${receiptPath} needs a structured error`);
  if (!["env_error", "code_error", "infra_error", "unknown"].includes(String(value.category))) {
    fail(`failed receipt at ${receiptPath} has an invalid error.category`);
  }
  if (!isNonEmptyString(value.message) || typeof value.recoverable !== "boolean") {
    fail(`failed receipt at ${receiptPath} needs error.message and error.recoverable`);
  }
}

function validateReceipt(raw: unknown, runId: string, receiptPath: string): Receipt {
  if (!isObject(raw)) fail(`receipt at ${receiptPath} is not a JSON object`);
  assertNoDangerousKeys(raw, "receipt");

  if (!isNonEmptyString(raw.worker) || !(raw.worker in WORKER_RULES)) {
    fail(`receipt at ${receiptPath} has unsupported worker '${String(raw.worker)}'`);
  }
  if (!Number.isInteger(raw.iteration) || (raw.iteration as number) < 1) {
    fail(`receipt at ${receiptPath} has invalid iteration '${String(raw.iteration)}'`);
  }
  if (raw.run_id !== runId) {
    fail(`receipt run_id '${String(raw.run_id)}' does not match '${runId}'`);
  }
  if (raw.status !== "done" && raw.status !== "failed") {
    fail(`receipt at ${receiptPath} has invalid status '${String(raw.status)}'`);
  }
  if (!isObject(raw.summary) || !isObject(raw.dashboard_patch)) {
    fail(`receipt at ${receiptPath} needs summary and dashboard_patch objects`);
  }
  assertIsoTimestamp(raw.completed_at, "receipt.completed_at");
  if (typeof raw.has_errors !== "boolean") fail("receipt.has_errors must be boolean");
  if (!Number.isInteger(raw.error_count) || (raw.error_count as number) < 0) {
    fail("receipt.error_count must be an integer >= 0");
  }
  if (
    (raw.has_errors === false && raw.error_count !== 0) ||
    (raw.has_errors && raw.error_count === 0)
  ) {
    fail("receipt.has_errors and error_count disagree");
  }

  if (raw.status === "done") {
    if (raw.error !== null) fail(`done receipt at ${receiptPath} must set error to null`);
    if (!isNonEmptyString(raw.primary_output)) {
      fail(`done receipt at ${receiptPath} needs primary_output`);
    }
  } else {
    validateError(raw.error, receiptPath);
    if (raw.primary_output !== null) {
      fail(`failed receipt at ${receiptPath} must set primary_output to null`);
    }
    if (Object.keys(raw.dashboard_patch).length !== 0) {
      fail(`failed receipt at ${receiptPath} must not contain a dashboard patch`);
    }
  }
  return raw as unknown as Receipt;
}

function resolveOutputDir(root: string, workerDir: string, outputDir: string): string {
  const resolved = path.isAbsolute(outputDir)
    ? path.resolve(outputDir)
    : path.resolve(root, outputDir);
  const expected = path.resolve(workerDir, "outputs");
  if (resolved !== expected) {
    fail(`manifest.output_dir must be the receipt worker's outputs directory (${expected})`);
  }
  return resolved;
}

function validateOwnership(
  root: string,
  runId: string,
  receiptPath: string,
  receipt: Receipt,
  dashboard: JsonObject,
): void {
  const workersRoot = path.resolve(root, ".aris", "runs", runId, "workers");
  const normalizedReceipt = path.resolve(receiptPath);
  const relative = path.relative(workersRoot, normalizedReceipt);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.basename(relative) !== "receipt.json"
  ) {
    fail(`receipt must be named receipt.json under ${workersRoot}`);
  }

  const manifestPath = path.join(path.dirname(normalizedReceipt), "input-manifest.json");
  if (!fs.existsSync(manifestPath)) fail(`receipt has no sibling input-manifest.json`);
  const manifestRaw = readJson(manifestPath, "input manifest");
  if (!isObject(manifestRaw)) fail(`input manifest at ${manifestPath} is not an object`);
  assertNoDangerousKeys(manifestRaw, "manifest");
  if (
    manifestRaw.worker !== receipt.worker ||
    manifestRaw.iteration !== receipt.iteration ||
    manifestRaw.run_id !== runId
  ) {
    fail("receipt worker/iteration/run_id does not match its input manifest");
  }
  if (!isObject(manifestRaw.inputs) || !isObject(manifestRaw.context)) {
    fail("input manifest needs inputs and context objects");
  }
  if (!isNonEmptyString(manifestRaw.output_dir)) fail("input manifest needs output_dir");

  const outputDir = resolveOutputDir(root, path.dirname(normalizedReceipt), manifestRaw.output_dir);
  if (receipt.status === "done") {
    const primaryOutput = receipt.primary_output as string;
    if (path.isAbsolute(primaryOutput) || primaryOutput.split(/[\\/]/).includes("..")) {
      fail("receipt.primary_output must stay within output_dir");
    }
    const artifact = path.resolve(outputDir, primaryOutput);
    const artifactRelative = path.relative(outputDir, artifact);
    if (artifactRelative.startsWith("..") || path.isAbsolute(artifactRelative)) {
      fail("receipt.primary_output escapes output_dir");
    }
    if (!fs.existsSync(artifact)) fail(`primary output does not exist: ${artifact}`);

    if (receipt.worker === "idea-discovery") {
      // The loop's next stage (experiment-bridge) consumes this plan directly, so the
      // path in the patch must name a file this worker actually produced.
      const expectedPlan = path.resolve(outputDir, "EXPERIMENT_PLAN.md");
      if (!fs.existsSync(expectedPlan)) {
        fail("idea-discovery output is missing EXPERIMENT_PLAN.md");
      }
      const planPath = receipt.dashboard_patch.plan_path;
      if (!isPlanPath(planPath) || path.resolve(root, planPath) !== expectedPlan) {
        fail("idea-discovery plan_path must name this worker's EXPERIMENT_PLAN.md");
      }
    }
  }

  if (receipt.iteration !== dashboard.iteration) {
    fail(
      `receipt iteration ${receipt.iteration} does not match dashboard iteration ${String(dashboard.iteration)}`,
    );
  }
  const rule = WORKER_RULES[receipt.worker];
  if (!rule.phases.includes(dashboard.current_phase as string)) {
    fail(
      `worker '${receipt.worker}' cannot write while dashboard.current_phase is '${String(dashboard.current_phase)}'`,
    );
  }
}

function validateExperiments(receipt: Receipt): void {
  if (!Array.isArray(receipt.experiments) || receipt.experiments.length === 0) {
    fail("experiment-bridge receipt needs a non-empty experiments array");
  }
  const slugs: string[] = [];
  for (const [index, value] of receipt.experiments.entries()) {
    if (!isObject(value)) fail(`receipt.experiments[${index}] must be an object`);
    if (!isNonEmptyString(value.slug) || !SLUG_PATTERN.test(value.slug)) {
      fail(`receipt.experiments[${index}].slug is invalid`);
    }
    if (!isNonEmptyString(value.title)) fail(`receipt.experiments[${index}].title is required`);
    if (value.verdict !== "yes" && value.verdict !== "partial" && value.verdict !== "no") {
      fail(`receipt.experiments[${index}].verdict is invalid`);
    }
    if (
      value.confidence !== "high" &&
      value.confidence !== "medium" &&
      value.confidence !== "low"
    ) {
      fail(`receipt.experiments[${index}].confidence is invalid`);
    }
    if (!(value.idea === "" || isNonEmptyString(value.idea))) {
      fail(`receipt.experiments[${index}].idea must be a string`);
    }
    if (!isNonEmptyString(value.metrics) || typeof value.reasoning !== "string") {
      fail(`receipt.experiments[${index}] needs metrics and reasoning`);
    }
    if (!isPlanPath(value.provenance) || !isStringArray(value.tags)) {
      fail(`receipt.experiments[${index}] has invalid provenance or tags`);
    }
    slugs.push(value.slug);
  }
  if (new Set(slugs).size !== slugs.length) fail("receipt.experiments contains duplicate slugs");
  const patchIds = receipt.dashboard_patch.experiment_ids;
  if (!Array.isArray(patchIds) || JSON.stringify(patchIds) !== JSON.stringify(slugs)) {
    fail("dashboard_patch.experiment_ids must exactly match receipt.experiments[].slug");
  }
}

function validatePatch(receipt: Receipt, dashboard: JsonObject): void {
  const rule = WORKER_RULES[receipt.worker];
  for (const key of Object.keys(receipt.dashboard_patch)) {
    const parts = key.split(".");
    if (parts.some((part) => DANGEROUS_KEYS.has(part))) {
      fail(`dashboard patch path '${key}' is forbidden`);
    }
    const validator = rule.patchKeys[key];
    if (!validator) fail(`worker '${receipt.worker}' is not allowed to patch '${key}'`);
    if (!validator(receipt.dashboard_patch[key])) {
      fail(`worker '${receipt.worker}' supplied an invalid value for '${key}'`);
    }
  }
  for (const required of rule.requiredPatchKeys) {
    if (!Object.hasOwn(receipt.dashboard_patch, required)) {
      fail(`worker '${receipt.worker}' receipt is missing required patch '${required}'`);
    }
  }

  if (receipt.worker === "experiment-bridge") {
    validateExperiments(receipt);
  }

  if (receipt.worker === "auto-review-loop") {
    const metric = dashboard.metric as JsonObject;
    if (metric.target !== null && !Object.hasOwn(receipt.dashboard_patch, "metric.current")) {
      fail("auto-review-loop must publish the final metric for metric-target runs");
    }
  }

  if (receipt.worker === "kill-argument") {
    const open = receipt.dashboard_patch["gaps.open"] as string[];
    const closed = receipt.dashboard_patch["gaps.closed"] as string[];
    const total = receipt.dashboard_patch["gaps.total"] as number;
    if (new Set(open).size !== open.length || new Set(closed).size !== closed.length) {
      fail("gap lists must not contain duplicates");
    }
    if (open.some((gap) => closed.includes(gap))) fail("a gap cannot be both open and closed");
    if (total < new Set([...open, ...closed]).size) {
      fail("gaps.total cannot be smaller than the adjudicated gap set");
    }
  }
}

function setDotPath(target: JsonObject, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".");
  let node = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!isObject(node[key])) node[key] = {};
    node = node[key] as JsonObject;
  }
  node[parts[parts.length - 1]] = value;
}

function updateMetricHistory(dashboard: JsonObject, receipt: Receipt): void {
  const patch = receipt.dashboard_patch;
  const current = patch["metric.current"];
  if (!isFiniteNumber(current)) return;
  const value = current;

  const metric = dashboard.metric as JsonObject;
  const history = metric.history as JsonObject[];
  const existingIndex = history.findIndex((entry) => entry.iter === receipt.iteration);
  if (existingIndex >= 0) {
    history[existingIndex] = {
      iter: receipt.iteration,
      value,
      source: receipt.worker,
      timestamp: new Date().toISOString(),
    };
  } else {
    history.push({
      iter: receipt.iteration,
      value,
      source: receipt.worker,
      timestamp: new Date().toISOString(),
    });
  }
}

function atomicWrite(filePath: string, value: JsonObject): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(temporary, filePath);
}

function apply(root: string, runId: string, receiptPath: string): void {
  validateRunId(runId);
  const dashboardPath = path.join(root, ".aris", "runs", runId, "dashboard.json");
  if (!fs.existsSync(dashboardPath)) fail(`no dashboard at ${dashboardPath}`);
  if (!fs.existsSync(receiptPath)) fail(`no receipt at ${receiptPath}`);

  const receipt = validateReceipt(readJson(receiptPath, "receipt"), runId, receiptPath);
  const dashboard = validateDashboard(readJson(dashboardPath, "dashboard"), runId, dashboardPath);

  const normalizedReceipt = path.resolve(receiptPath);
  const appliedReceipts = dashboard.applied_receipts as string[];
  if (appliedReceipts.includes(normalizedReceipt)) {
    console.log(JSON.stringify({ applied: false, reason: "already-applied" }));
    return;
  }

  validateOwnership(root, runId, receiptPath, receipt, dashboard);

  if (receipt.status === "failed") {
    console.log(JSON.stringify({ applied: false, reason: "failed-receipt" }));
    return;
  }

  validatePatch(receipt, dashboard);
  for (const [key, value] of Object.entries(receipt.dashboard_patch)) {
    setDotPath(dashboard, key, value);
  }
  updateMetricHistory(dashboard, receipt);

  if (receipt.has_errors) {
    const systemErrors = dashboard.system_errors as JsonObject;
    systemErrors.total = (systemErrors.total as number) + receipt.error_count;
    systemErrors.last = `${receipt.iteration}-${receipt.worker}`;
  }

  appliedReceipts.push(normalizedReceipt);
  dashboard.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  atomicWrite(dashboardPath, dashboard);

  console.log(
    JSON.stringify({ applied: true, worker: receipt.worker, iteration: receipt.iteration }),
  );
}

const program = createCli(
  "dashboard-merge",
  "Validate and atomically merge an authorized worker receipt into its run dashboard.",
);

program
  .command("apply")
  .requiredOption("--root <root>", "project root")
  .requiredOption("--run-id <runId>", "run id")
  .requiredOption("--receipt <receipt>", "path to the worker receipt.json")
  .action((options: { root: string; runId: string; receipt: string }) => {
    apply(path.resolve(options.root), options.runId, path.resolve(options.receipt));
  });

runCli(program);
