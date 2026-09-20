import { settleExecutionReceipt, runBudgetExhausted } from "./run-budget.js";
import { assertRunId } from "./workflow-spec.js";
import { assertResearchVisible } from "./wiki-scope.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCli, runCli } from "../lib/cli.js";
import { canonicalJsonString } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { requireRunContract, runJsonPath, runOwnedPath } from "./run-contract.js";
import { readDispatchStructure, type DispatchStructure } from "./child-index.js";
import { hasDecomposition } from "./decomposition-graph.js";
import { requireCompleteRound } from "./orchestration-round.js";

type JsonObject = Record<string, unknown>;

interface Receipt {
  worker: string;
  iteration: number;
  run_id: string;
  phase?: string;
  status: "done" | "failed";
  error: JsonObject | null;
  primary_output: string | null;
  primary_output_sha256?: string;
  output_sha256?: string;
  summary: JsonObject;
  // Bridge-repair receipts are allowed to carry JSON null at runtime; normal
  // workers always use an object. Branches that handle repair check this before
  // reading the patch.
  dashboard_patch: JsonObject;
  completed_at: string;
  has_errors: boolean;
  error_count: number;
}

interface WorkerRule {
  phases: readonly string[];
  patchKeys: Readonly<Record<string, (value: unknown) => boolean>>;
  requiredPatchKeys: readonly string[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
// Problem entity node ids (research-wiki `problems/<slug>.md`). Replaces the old
// free-text gap ids (G1, G2, ...).
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

function isProblemIdArray(value: unknown): value is string[] {
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
  // "not ready" and "insufficient" are different findings. "not ready" means the
  // review judged the result and it did not hold up, so the next attempt needs a
  // different idea. "insufficient" means the review could not judge at all: the
  // experiment fell short of settling the question, so the same idea goes back to
  // the bridge to be run properly.
  return (
    value === "ready" || value === "almost" || value === "not ready" || value === "insufficient"
  );
}

function isScore(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 10;
}

function isPlanPath(value: unknown): value is string {
  return isNonEmptyString(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
  // An orchestration bridge does not run an experiment, it dispatches the
  // children that will. So it publishes no metric: at the moment its receipt is
  // written nothing has been measured, and claiming a number here would put a
  // value in metric history that no child produced. What it must publish is what
  // it decided — which children it dispatched, and the hash of the structure it
  // dispatched them in — because the next round compares against exactly that.
  "orchestration-bridge": {
    phases: ["experiment-bridge"],
    patchKeys: {
      child_run_ids: isStringArray,
      structure_sha256: isSha256,
    },
    requiredPatchKeys: ["child_run_ids", "structure_sha256"],
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
    phases: ["auto-review-loop", "auto-review", "bridge-repair"],
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
      plan_path: (value) => value === null || isPlanPath(value),
      overall_verdict: (value) => value === "PASS" || value === "WARN" || value === "FAIL",
    },
    requiredPatchKeys: ["overall_verdict"],
  },
  summary: {
    phases: ["summary"],
    patchKeys: {
      summary_path: isPlanPath,
      "problems.open": isProblemIdArray,
      "problems.closed": isProblemIdArray,
      "problems.total": (value) => Number.isInteger(value) && (value as number) >= 0,
    },
    requiredPatchKeys: ["summary_path", "problems.open", "problems.closed", "problems.total"],
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
  throw new Error(`error: ${message}`);
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

function readJson(filePath: string, label: string): unknown {
  try {
    return readStateFile(filePath);
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
  if (
    !["running", "bridge_repair_pending", "finishing", "completed", "invalid", "failed"].includes(
      String(raw.status),
    )
  ) {
    fail(`dashboard.status '${String(raw.status)}' is invalid`);
  }
  if (raw.failure !== undefined && raw.failure !== null && !isObject(raw.failure)) {
    fail("dashboard.failure must be an object or null");
  }
  if (!Number.isInteger(raw.iteration) || (raw.iteration as number) < 1) {
    fail("dashboard.iteration must be an integer >= 1");
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

  if (!isObject(raw.problems)) fail("dashboard.problems must be an object");
  if (!isProblemIdArray(raw.problems.open) || !isProblemIdArray(raw.problems.closed)) {
    fail("dashboard.problems.open/closed must be arrays of problem node ids");
  }
  if (!Number.isInteger(raw.problems.total) || (raw.problems.total as number) < 0) {
    fail("dashboard.problems.total must be an integer >= 0");
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

  const allowedFields = [
    "worker",
    "iteration",
    "run_id",
    "phase",
    "status",
    "error",
    "primary_output",
    "primary_output_sha256",
    "output_sha256",
    "summary",
    "dashboard_patch",
    "completed_at",
    "has_errors",
    "error_count",
    "module_run_id",
    "module_id",
    "scope",
  ];
  for (const key of Object.keys(raw)) {
    if (!allowedFields.includes(key)) fail(`receipt at ${receiptPath} has unknown field '${key}'`);
  }

  if (!isNonEmptyString(raw.worker) || !(raw.worker in WORKER_RULES)) {
    fail(`receipt at ${receiptPath} has unsupported worker '${String(raw.worker)}'`);
  }
  if (!Number.isInteger(raw.iteration) || (raw.iteration as number) < 1) {
    fail(`receipt at ${receiptPath} has invalid iteration '${String(raw.iteration)}'`);
  }
  if (raw.run_id !== runId) {
    fail(`receipt run_id '${String(raw.run_id)}' does not match '${runId}'`);
  }
  if (raw.phase !== undefined && !isNonEmptyString(raw.phase)) {
    fail(`receipt at ${receiptPath} has an invalid phase`);
  }
  for (const field of ["primary_output_sha256", "output_sha256"] as const) {
    if (raw[field] !== undefined && !isSha256(raw[field])) {
      fail(`receipt at ${receiptPath} has an invalid ${field}`);
    }
  }
  for (const field of ["module_run_id", "module_id", "scope"] as const) {
    if (raw[field] !== undefined && !isNonEmptyString(raw[field])) {
      fail(`receipt at ${receiptPath} has an invalid ${field}`);
    }
  }
  if (raw.status !== "done" && raw.status !== "failed") {
    fail(`receipt at ${receiptPath} has invalid status '${String(raw.status)}'`);
  }
  if (
    !isObject(raw.summary) ||
    (!isObject(raw.dashboard_patch) &&
      !(raw.dashboard_patch === null && raw.worker === "auto-review-loop"))
  ) {
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
    const bridgeRepairReceipt =
      raw.worker === "auto-review-loop" &&
      raw.primary_output === null &&
      raw.dashboard_patch === null;
    if (!bridgeRepairReceipt && !isNonEmptyString(raw.primary_output)) {
      fail(`done receipt at ${receiptPath} needs primary_output`);
    }
  } else {
    validateError(raw.error, receiptPath);
    if (raw.primary_output !== null) {
      fail(`failed receipt at ${receiptPath} must set primary_output to null`);
    }
    if (raw.dashboard_patch !== null && Object.keys(raw.dashboard_patch).length !== 0) {
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
  checkPhase = true,
): void {
  const workersRoot = path.join(moduleRunRoot(root, runId), "workers");
  const normalizedReceipt = path.resolve(receiptPath);
  const relative = path.relative(workersRoot, normalizedReceipt);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.basename(relative) !== "receipt.json"
  ) {
    fail(`receipt must be named receipt.json under ${workersRoot}`);
  }
  assertRealPathInside(
    moduleRunRoot(root, runId),
    normalizedReceipt,
    "receipt escapes its run directory",
  );

  const manifestPath = path.join(path.dirname(normalizedReceipt), "input-manifest.json");
  if (!fs.existsSync(manifestPath)) fail(`receipt has no sibling input-manifest.json`);
  assertRealPathInside(
    moduleRunRoot(root, runId),
    manifestPath,
    "receipt input manifest escapes its run directory",
  );
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
  assertRealPathInside(
    moduleRunRoot(root, runId),
    outputDir,
    "receipt output directory escapes its run directory",
  );
  if (receipt.status === "done") {
    const bridgeRepair =
      receipt.worker === "auto-review-loop" &&
      (receipt.phase === undefined ||
        receipt.phase === "bridge-repair" ||
        receipt.phase === "auto-review-loop") &&
      isObject(manifestRaw.context) &&
      manifestRaw.context.purpose === "bridge_repair";
    if (bridgeRepair) {
      if (receipt.primary_output !== null) {
        fail("bridge repair receipt must not publish a primary output");
      }
    } else {
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
      if (!fs.statSync(artifact).isFile()) fail(`primary output is not a file: ${artifact}`);
      assertRealPathInside(outputDir, artifact, "receipt.primary_output escapes output_dir");
      const declaredHash = receipt.primary_output_sha256 ?? receipt.output_sha256;
      if (declaredHash !== undefined) {
        const actualHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(artifact))
          .digest("hex");
        if (actualHash !== declaredHash)
          fail("receipt primary output hash does not match its contents");
      }

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
  }

  if (receipt.iteration !== dashboard.iteration) {
    fail(
      `receipt iteration ${receipt.iteration} does not match dashboard iteration ${String(dashboard.iteration)}`,
    );
  }
  const rule = WORKER_RULES[receipt.worker];
  if (checkPhase && !rule.phases.includes(dashboard.current_phase as string)) {
    fail(
      `worker '${receipt.worker}' cannot write while dashboard.current_phase is '${String(dashboard.current_phase)}'`,
    );
  }
}

/**
 * Check an orchestration receipt against the dispatch it claims to describe.
 *
 * `validatePatch` can only see that the receipt is well shaped; whether it is
 * true is a question about the parent's own children.json, which this process
 * can read. Both facts are re-derived rather than trusted: the structure hash,
 * so a receipt cannot record a structure that was never dispatched, and the
 * child list, so it cannot omit a child whose result will later have to be
 * collected or name a run belonging to someone else.
 */
function verifyOrchestrationReceipt(root: string, runId: string, receipt: Receipt): void {
  let structure: DispatchStructure;
  try {
    structure = readDispatchStructure(root, runId);
  } catch (error) {
    fail(`cannot read the dispatched structure: ${String(error)}`);
  }
  if (receipt.dashboard_patch.structure_sha256 !== structure.structure_sha256) {
    fail("orchestration receipt does not match the structure this run dispatched");
  }
  const claimed = receipt.dashboard_patch.child_run_ids as string[];
  const dispatched = structure.child_run_ids;
  if (
    claimed.length !== dispatched.length ||
    [...claimed].sort().join("\u0000") !== [...dispatched].sort().join("\u0000")
  ) {
    fail("orchestration receipt does not name the children this run dispatched");
  }
  for (const childRunId of dispatched) {
    if (requireRunContract(root, childRunId).parent_run_id !== runId) {
      fail(`child '${childRunId}' is not a child of run '${runId}'`);
    }
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
  // Every cross-check below reads required keys, so it runs only once they are
  // all present — otherwise a missing key surfaces as a TypeError instead of the
  // message that names it.

  if (receipt.worker === "auto-review-loop") {
    const metric = dashboard.metric as JsonObject;
    if (metric.target !== null && !Object.hasOwn(receipt.dashboard_patch, "metric.current")) {
      fail("auto-review-loop must publish the final metric for metric-target runs");
    }
  }

  if (receipt.worker === "summary") {
    const open = receipt.dashboard_patch["problems.open"] as string[];
    const closed = receipt.dashboard_patch["problems.closed"] as string[];
    const total = receipt.dashboard_patch["problems.total"] as number;
    if (new Set(open).size !== open.length || new Set(closed).size !== closed.length) {
      fail("problem lists must not contain duplicates");
    }
    if (open.some((problem) => closed.includes(problem))) {
      fail("a problem cannot be both open and closed");
    }
    if (total < new Set([...open, ...closed]).size) {
      fail("problems.total cannot be smaller than the adjudicated problem set");
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
  const replacement = {
    iter: receipt.iteration,
    value,
    source: receipt.worker,
    timestamp: new Date().toISOString(),
  };
  if (existingIndex >= 0) {
    history[existingIndex] = replacement;
    for (let index = history.length - 1; index > existingIndex; index -= 1) {
      if (history[index]!.iter === receipt.iteration) history.splice(index, 1);
    }
  } else {
    history.push(replacement);
  }
}

function assertRealPathInside(parent: string, child: string, message: string): void {
  let realParent: string;
  let realChild: string;
  try {
    realParent = fs.realpathSync.native(parent);
    realChild = fs.realpathSync.native(child);
  } catch {
    fail(message);
  }
  const relative = path.relative(realParent, realChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(message);
}

function moduleRunRoot(root: string, runId: string): string {
  return runOwnedPath(root, runId);
}

function moduleRelativePath(root: string, runId: string, target: string, label: string): string {
  const runRoot = moduleRunRoot(root, runId);
  const relative = path.relative(runRoot, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must stay inside the module run directory`);
  }
  return relative;
}

function moduleReceiptHash(receiptPath: string): string {
  if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
    fail("module receipt is not a regular file");
  }
  return crypto.createHash("sha256").update(fs.readFileSync(receiptPath)).digest("hex");
}

function frozenBridgeInputHash(manifest: JsonObject): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJsonString({
        inputs: manifest.inputs ?? null,
        context: manifest.context ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

function readReceiptManifest(root: string, runId: string, receiptPath: string): JsonObject {
  const runRoot = moduleRunRoot(root, runId);
  const manifestPath = path.join(path.dirname(path.resolve(receiptPath)), "input-manifest.json");
  assertRealPathInside(runRoot, manifestPath, "receipt input manifest escapes its run directory");
  const manifest = readJson(manifestPath, "input manifest");
  if (!isObject(manifest)) fail("input manifest is not an object");
  return manifest;
}

function isBridgeRepairManifest(manifest: JsonObject, receipt: Receipt): boolean {
  return (
    receipt.worker === "auto-review-loop" &&
    (receipt.phase === undefined ||
      receipt.phase === "bridge-repair" ||
      receipt.phase === "auto-review-loop") &&
    isObject(manifest.context) &&
    manifest.context.purpose === "bridge_repair"
  );
}

interface RecordedBridgeFacts {
  bridge_receipt_ref: string;
  bridge_receipt_sha256: string;
  bridge_manifest_ref: string;
  bridge_manifest_sha256: string;
  frozen_input_sha256: string;
}

/**
 * Re-prove that the bridge attempt being sent back for repair is the attempt
 * the dashboard recorded. The refs alone would let a later write point the
 * repair at different evidence, so both files are re-read and re-hashed here
 * and the frozen input hash is recomputed from the manifest on disk.
 */
function verifyRecordedBridgeFacts(
  root: string,
  runId: string,
  dashboard: JsonObject,
): RecordedBridgeFacts {
  const recorded = dashboard.last_bridge_receipt;
  if (!isObject(recorded)) {
    fail("no recorded experiment-bridge receipt to send back for repair");
  }
  const runRoot = moduleRunRoot(root, runId);
  const receiptRef = recorded.receipt_ref;
  const manifestRef = recorded.manifest_ref;
  if (!isNonEmptyString(receiptRef) || !isNonEmptyString(manifestRef)) {
    fail("recorded bridge receipt refs are invalid");
  }
  const receiptPath = path.resolve(runRoot, receiptRef);
  const manifestPath = path.resolve(runRoot, manifestRef);
  assertRealPathInside(runRoot, receiptPath, "recorded bridge receipt escapes its run");
  assertRealPathInside(runRoot, manifestPath, "recorded bridge manifest escapes its run");
  if (moduleReceiptHash(receiptPath) !== recorded.receipt_sha256) {
    fail("recorded bridge receipt changed on disk");
  }
  if (moduleReceiptHash(manifestPath) !== recorded.manifest_sha256) {
    fail("recorded bridge input manifest changed on disk");
  }
  const manifest = readJson(manifestPath, "bridge input manifest");
  if (!isObject(manifest)) fail("bridge input manifest is not a JSON object");
  return {
    bridge_receipt_ref: receiptRef,
    bridge_receipt_sha256: recorded.receipt_sha256 as string,
    bridge_manifest_ref: manifestRef,
    bridge_manifest_sha256: recorded.manifest_sha256 as string,
    frozen_input_sha256: frozenBridgeInputHash(manifest),
  };
}

function applyStandaloneBridgeRepair(
  root: string,
  runId: string,
  receiptPath: string,
  receipt: Receipt,
  dashboard: JsonObject,
  manifest: JsonObject,
  receiptHash: string,
): void {
  if (dashboard.status !== "bridge_repair_pending" || dashboard.current_phase !== "bridge-repair") {
    fail("bridge repair receipt requires a pending bridge repair dashboard");
  }
  if (!isObject(dashboard.bridge_failure) || dashboard.bridge_failure.status !== "pending") {
    fail("dashboard.bridge_failure is not pending");
  }
  if (!isObject(receipt.summary)) fail("bridge repair receipt needs a summary");
  const repairStatus = receipt.summary.repair_status;
  if (repairStatus !== "fixed" && repairStatus !== "exhausted") {
    fail("bridge repair summary needs fixed or exhausted status");
  }
  if (
    receipt.summary.semantic_change === true ||
    receipt.summary.research_semantics_changed === true ||
    receipt.summary.workflow_graph_changed === true ||
    receipt.summary.node_interface_changed === true ||
    receipt.summary.connection_changed === true ||
    receipt.summary.tester_definition_changed === true ||
    receipt.summary.scoring_policy_changed === true
  ) {
    fail("bridge repair changed a frozen research boundary");
  }
  const bridgeFailure = dashboard.bridge_failure as JsonObject;
  const currentAttempts = Number(bridgeFailure.repair_attempts);

  if (!Number.isInteger(currentAttempts) || currentAttempts < 0) fail("repair counter is invalid");
  settleExecutionReceipt(root, runId, manifest, receipt.summary);
  if (repairStatus === "exhausted" && !runBudgetExhausted(root, runId))
    fail("repair still has execution budget");
  const nextAttempts = currentAttempts + 1;

  if (receipt.summary.repair_round !== undefined && receipt.summary.repair_round !== nextAttempts) {
    fail("bridge repair round does not match the dashboard");
  }
  if (!isObject(manifest.context) || manifest.context.purpose !== "bridge_repair") {
    fail("bridge repair manifest purpose is invalid");
  }
  const runRoot = moduleRunRoot(root, runId);
  const receiptRef = moduleRelativePath(root, runId, receiptPath, "bridge repair receipt");
  const manifestPath = path.join(path.dirname(path.resolve(receiptPath)), "input-manifest.json");
  const manifestRef = moduleRelativePath(root, runId, manifestPath, "bridge repair manifest");
  const appliedReceipts = dashboard.applied_receipts as string[];
  const appliedHashes = isObject(dashboard.applied_receipt_hashes)
    ? dashboard.applied_receipt_hashes
    : {};
  if (!appliedReceipts.includes(path.resolve(receiptPath))) {
    appliedReceipts.push(path.resolve(receiptPath));
  }
  appliedHashes[path.resolve(receiptPath)] = receiptHash;
  dashboard.applied_receipt_hashes = appliedHashes;
  dashboard.bridge_failure = {
    ...bridgeFailure,
    repair_attempts: nextAttempts,
    status: repairStatus,
    repair_receipt_ref: receiptRef,
    repair_receipt_sha256: receiptHash,
    repair_manifest_ref: manifestRef,
    repair_manifest_sha256: moduleReceiptHash(manifestPath),
  };
  if (repairStatus === "fixed") {
    dashboard.current_phase = "experiment-bridge";
    dashboard.status = "running";
  } else if (bridgeFailure.reason === "insufficient_evidence") {
    // The bridge ran; the repair spent its rounds tuning the experiment and
    // still produced nothing anyone could rule on. Nothing broke, so the run
    // ends without a result. Marking it failed would read as "this direction
    // was tested and lost", which is a claim the evidence never supported.
    dashboard.current_phase = "completed";
    dashboard.status = "completed";
    dashboard.outcome = "no_proposal";
  } else {
    dashboard.current_phase = "bridge-repair";
    dashboard.status = "failed";
  }
  if (dashboard.status === "failed") {
    dashboard.failure = {
      ...(isObject(dashboard.failure) ? dashboard.failure : {}),
      repair_status: repairStatus,
      repair_attempts: nextAttempts,
      bridge_receipt_ref: bridgeFailure.bridge_receipt_ref,
    };
  }
  dashboard.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeStateJsonAtomic(path.join(runRoot, "dashboard.json"), dashboard);
}

function apply(root: string, runId: string, receiptPath: string): void {
  assertRunId(runId, "run_id");
  const dashboardPath = path.join(moduleRunRoot(root, runId), "dashboard.json");
  if (!fs.existsSync(dashboardPath)) fail(`no dashboard at ${dashboardPath}`);
  assertRealPathInside(
    moduleRunRoot(root, runId),
    dashboardPath,
    "dashboard escapes its run directory",
  );
  if (!fs.existsSync(receiptPath)) fail(`no receipt at ${receiptPath}`);

  const receiptRaw = readJson(receiptPath, "receipt");
  assertResearchVisible(receiptRaw);
  if (isObject(receiptRaw) && receiptRaw.reviewed_run_kind !== undefined) {
    fail("review receipts cannot be sent to dashboard-merge");
  }
  const dashboardRaw = readJson(dashboardPath, "dashboard");
  assertResearchVisible(dashboardRaw);

  withStateFileLock(dashboardPath, () => {
    // The receipt is immutable input, but the dashboard must be read and
    // changed under the same path-derived lock. Otherwise two valid receipts
    // can both read the same applied_receipts array and one update disappears.
    const currentReceiptRaw = readJson(receiptPath, "receipt");
    assertResearchVisible(currentReceiptRaw);
    if (isObject(currentReceiptRaw) && currentReceiptRaw.reviewed_run_kind !== undefined) {
      fail("review receipts cannot be sent to dashboard-merge");
    }
    const receipt = validateReceipt(currentReceiptRaw, runId, receiptPath);
    const dashboard = validateDashboard(readJson(dashboardPath, "dashboard"), runId, dashboardPath);
    const normalizedReceipt = path.resolve(receiptPath);
    const receiptHash = moduleReceiptHash(normalizedReceipt);
    const appliedReceipts = dashboard.applied_receipts as string[];
    if (appliedReceipts.includes(normalizedReceipt)) {
      const appliedHashes = isObject(dashboard.applied_receipt_hashes)
        ? dashboard.applied_receipt_hashes
        : {};
      if (
        appliedHashes[normalizedReceipt] !== undefined &&
        appliedHashes[normalizedReceipt] !== receiptHash
      ) {
        fail("receipt path already applied with different content");
      }
      validateOwnership(root, runId, receiptPath, receipt, dashboard, false);
      console.log(JSON.stringify({ applied: false, reason: "already-applied" }));
      return;
    }

    validateOwnership(root, runId, receiptPath, receipt, dashboard);

    const receiptManifest = readReceiptManifest(root, runId, receiptPath);
    if (isBridgeRepairManifest(receiptManifest, receipt)) {
      applyStandaloneBridgeRepair(
        root,
        runId,
        receiptPath,
        receipt,
        dashboard,
        receiptManifest,
        receiptHash,
      );
      console.log(JSON.stringify({ applied: true, reason: "bridge-repair-recorded" }));
      return;
    }

    if (
      receipt.worker === "experiment-bridge" &&
      (receipt.phase === undefined || receipt.phase === "experiment-bridge") &&
      receipt.status === "done" &&
      isObject(dashboard.bridge_failure) &&
      dashboard.bridge_failure.status === "fixed" &&
      dashboard.bridge_failure.frozen_input_sha256 !== frozenBridgeInputHash(receiptManifest)
    ) {
      fail("bridge retry inputs changed after repair; start a new candidate");
    }

    if (receipt.worker === "experiment-bridge")
      settleExecutionReceipt(root, runId, receiptManifest, receipt.summary);

    if (receipt.status === "failed") {
      if (
        receipt.worker === "experiment-bridge" &&
        (receipt.phase === undefined || receipt.phase === "experiment-bridge")
      ) {
        if (dashboard.status !== "running" || dashboard.current_phase !== "experiment-bridge") {
          fail("a bridge failure can only be recorded from the running experiment-bridge phase");
        }
        const previousFailure = isObject(dashboard.bridge_failure)
          ? dashboard.bridge_failure
          : null;
        if (previousFailure?.status === "pending") {
          fail("a bridge repair is already pending");
        }
        if (
          previousFailure?.status === "fixed" &&
          previousFailure.frozen_input_sha256 !== frozenBridgeInputHash(receiptManifest)
        ) {
          fail("a repaired bridge must be retried with the same frozen inputs");
        }
        const repairAttempts = Number(previousFailure?.repair_attempts ?? 0);

        const bridgeFailure = {
          schema_version: 1,
          // This merge path only ever fires on a failed bridge receipt; the
          // evidence-too-weak repair is opened further down, when the review
          // loop reports a verdict it could not rule on.
          reason: "execution",
          bridge_receipt_ref: moduleRelativePath(root, runId, receiptPath, "bridge receipt"),
          bridge_receipt_sha256: receiptHash,
          bridge_manifest_ref: moduleRelativePath(
            root,
            runId,
            path.join(path.dirname(path.resolve(receiptPath)), "input-manifest.json"),
            "bridge manifest",
          ),
          bridge_manifest_sha256: moduleReceiptHash(
            path.join(path.dirname(path.resolve(receiptPath)), "input-manifest.json"),
          ),
          frozen_input_sha256: frozenBridgeInputHash(receiptManifest),
          error: receipt.error,
          repair_attempts: repairAttempts,

          status: "pending",
          repair_receipt_ref: null,
          repair_receipt_sha256: null,
        };
        const appliedHashes = isObject(dashboard.applied_receipt_hashes)
          ? dashboard.applied_receipt_hashes
          : {};
        appliedHashes[normalizedReceipt] = receiptHash;
        dashboard.applied_receipt_hashes = appliedHashes;
        appliedReceipts.push(normalizedReceipt);
        dashboard.status = "bridge_repair_pending";
        dashboard.current_phase = "bridge-repair";
        dashboard.bridge_failure = bridgeFailure;
        dashboard.failure = {
          worker: receipt.worker,
          iteration: receipt.iteration,
          phase: receipt.phase,
          error: receipt.error,
          failed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        dashboard.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        writeStateJsonAtomic(dashboardPath, dashboard);
        console.log(JSON.stringify({ applied: false, reason: "bridge-repair-pending" }));
        return;
      }
      // A failed receipt is a terminal event, not a no-op. The resume path
      // decides "stage completed" from dashboard state, so the failure must be
      // recorded here - the only durable writer the orchestrator consults.
      dashboard.status = "failed";
      dashboard.failure = {
        worker: receipt.worker,
        iteration: receipt.iteration,
        phase: dashboard.current_phase,
        error: receipt.error,
        failed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      appliedReceipts.push(normalizedReceipt);
      const appliedHashes = isObject(dashboard.applied_receipt_hashes)
        ? dashboard.applied_receipt_hashes
        : {};
      appliedHashes[normalizedReceipt] = receiptHash;
      dashboard.applied_receipt_hashes = appliedHashes;
      dashboard.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      writeStateJsonAtomic(dashboardPath, dashboard);
      console.log(JSON.stringify({ applied: false, reason: "failed-receipt" }));
      return;
    }

    validatePatch(receipt, dashboard);
    // A run that has recorded a decomposition is being judged on that
    // decomposition, so its expansion phase can only be reported as an
    // orchestration. An ordinary experiment-bridge receipt would write a
    // metric.current here, before a single child has been collected, and that
    // number would then be the one the next round compares against.
    if (
      receipt.worker !== "orchestration-bridge" &&
      WORKER_RULES[receipt.worker].phases.includes("experiment-bridge") &&
      hasDecomposition(root, runId)
    ) {
      fail(
        `run '${runId}' dispatched a decomposition; its expansion must be reported by orchestration-bridge`,
      );
    }
    if (receipt.worker === "orchestration-bridge") verifyOrchestrationReceipt(root, runId, receipt);
    // `metric.current` on an orchestration run is the parent's measurement of
    // the assembled whole. There is no whole while a child is still running,
    // so the reading is refused until the generation has been collected back.
    if (receipt.dashboard_patch["metric.current"] !== undefined && hasDecomposition(root, runId)) {
      try {
        requireCompleteRound(root, runId);
      } catch (error) {
        fail(`this run cannot be measured yet: ${String(error)}`);
      }
    }
    for (const [key, value] of Object.entries(receipt.dashboard_patch)) {
      setDotPath(dashboard, key, value);
    }

    const review = isObject(dashboard.last_review) ? dashboard.last_review : null;
    if (receipt.worker === "auto-review-loop" && review?.verdict === "insufficient") {
      // The review could not rule on the result, and it diagnosed the cause as
      // the experiment rather than the idea: parameters off, sample too small, a
      // control not held. Nobody asked for a new idea, so the candidate goes
      // back to the bridge to be run properly and the iteration does not
      // advance. An unjudgeable result also never enters metric history, which
      // is why this returns before updateMetricHistory.
      const previousFailure = isObject(dashboard.bridge_failure) ? dashboard.bridge_failure : null;
      if (previousFailure?.status === "pending") fail("a bridge repair is already pending");
      if (runBudgetExhausted(root, runId)) {
        fail("no execution budget left to retune the experiment");
      }
      const appliedHashes = isObject(dashboard.applied_receipt_hashes)
        ? dashboard.applied_receipt_hashes
        : {};
      appliedHashes[normalizedReceipt] = receiptHash;
      dashboard.applied_receipt_hashes = appliedHashes;
      appliedReceipts.push(normalizedReceipt);
      dashboard.status = "bridge_repair_pending";
      dashboard.current_phase = "bridge-repair";
      dashboard.bridge_failure = {
        schema_version: 1,
        reason: "insufficient_evidence",
        ...verifyRecordedBridgeFacts(root, runId, dashboard),
        error: {
          verdict: review.verdict,
          score: review.score,
          reviewer_id: review.reviewer_id,
        },
        // Repair rounds are counted per candidate, not per cause. A candidate
        // that already burned rounds on a broken bridge does not get a fresh
        // allowance for tuning.
        repair_attempts: Number(previousFailure?.repair_attempts ?? 0),
        status: "pending",
        repair_receipt_ref: null,
        repair_receipt_sha256: null,
      };
      dashboard.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      writeStateJsonAtomic(dashboardPath, dashboard);
      console.log(JSON.stringify({ applied: false, reason: "bridge-repair-pending" }));
      return;
    }

    updateMetricHistory(dashboard, receipt);

    if (receipt.has_errors) {
      const systemErrors = dashboard.system_errors as JsonObject;
      systemErrors.total = (systemErrors.total as number) + receipt.error_count;
      systemErrors.last = `${receipt.iteration}-${receipt.worker}`;
    }

    if (receipt.worker === "experiment-bridge") {
      // The review that follows may find this evidence too thin to rule on. If
      // it does, the repair has to go back to this exact attempt, so record
      // which receipt produced the evidence while it is still in hand.
      const bridgeManifestPath = path.join(
        path.dirname(path.resolve(receiptPath)),
        "input-manifest.json",
      );
      dashboard.last_bridge_receipt = {
        receipt_ref: moduleRelativePath(root, runId, receiptPath, "bridge receipt"),
        receipt_sha256: receiptHash,
        manifest_ref: moduleRelativePath(root, runId, bridgeManifestPath, "bridge manifest"),
        manifest_sha256: moduleReceiptHash(bridgeManifestPath),
        frozen_input_sha256: frozenBridgeInputHash(receiptManifest),
      };
    }

    appliedReceipts.push(normalizedReceipt);
    dashboard.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeStateJsonAtomic(dashboardPath, dashboard);

    console.log(
      JSON.stringify({ applied: true, worker: receipt.worker, iteration: receipt.iteration }),
    );
  });
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
