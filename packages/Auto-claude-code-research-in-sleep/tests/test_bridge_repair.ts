import { reserveRunExecution } from "../src/tools/run-budget.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRootRun } from "../src/tools/run-contract.js";
import { createChildContract } from "./helpers/child-contract.js";
import { resolveRunWikiScope } from "../src/tools/wiki-scope.js";

const TSX_CLI = "/home/liu/paseo/node_modules/tsx/dist/cli.mjs";
const MERGE_TS = path.resolve("src/tools/dashboard-merge.ts");

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runRoot(root: string, runId: string): string {
  return path.join(root, ".aris", "runs", runId);
}

function dashboardPath(root: string, runId: string): string {
  return path.join(runRoot(root, runId), "dashboard.json");
}

interface Dashboard {
  status: string;
  current_phase: string;
  iteration: number;
  outcome?: string;
  applied_receipts: string[];
  bridge_failure?: {
    status: string;
    reason: string;
    repair_attempts: number;
    bridge_receipt_ref: string;
  };
  last_bridge_receipt?: { receipt_ref: string; frozen_input_sha256: string };
  metric: { history: Array<{ iter: number; value: number; source?: string }> };
}

function readDashboard(root: string, runId: string): Dashboard {
  return JSON.parse(fs.readFileSync(dashboardPath(root, runId), "utf8")) as Dashboard;
}

/**
 * Advance the phase the way the orchestrator does. `dashboard-merge` only
 * rules on receipts; which phase runs next is the loop's decision, and the
 * merge tool never moves the run forward on its own. The one exception is the
 * repair path, which is exactly what these tests are about.
 */
function setPhase(root: string, runId: string, phase: string): void {
  const dashboard = JSON.parse(fs.readFileSync(dashboardPath(root, runId), "utf8")) as Record<
    string,
    unknown
  >;
  dashboard.current_phase = phase;
  writeJson(dashboardPath(root, runId), dashboard);
}

function makeRun(root: string, runId: string, dispatchBudget = 10): void {
  createRootRun({
    project_root: root,
    run_id: "outer-1",
    input_snapshot_sha256: "c".repeat(64),
    code_baseline_sha256: "a".repeat(64),
    policy_revision: "policy:bridge-fixture",
  });
  createChildContract(root, "outer-1", runId, "train", false, dispatchBudget);
  writeJson(dashboardPath(root, runId), {
    run_id: runId,
    project: "bridge-repair-fixture",
    status: "running",
    iteration: 1,
    max_iterations: 5,
    current_phase: "experiment-bridge",
    config: { patience: 2 },
    metric: {
      name: "F1",
      target: 0.85,
      direction: "higher_better",
      tolerance: 0.01,
      current: 0.6,
      baseline: 0.6,
      history: [{ iter: 1, value: 0.6 }],
    },
    problems: { open: [], closed: [], total: 0 },
    last_review: { verdict: null, score: null, reviewer_id: null },
    system_errors: { total: 0, last: null },
    applied_receipts: [],
  });
}

function makeReceipt(
  root: string,
  runId: string,
  slot: string,
  input: Record<string, unknown>,
  output: string | null,
  status: "done" | "failed",
  extra: Record<string, unknown> = {},
): string {
  const workerRoot = path.join(runRoot(root, runId), "workers", slot);
  const outputDir = path.join(workerRoot, "outputs");
  const outputName = output === null ? null : "result.json";
  fs.mkdirSync(outputDir, { recursive: true });
  let outputHash: string | undefined;
  if (outputName !== null) {
    const bytes = `${output}\n`;
    fs.writeFileSync(path.join(outputDir, outputName), bytes, "utf8");
    outputHash = sha256(bytes);
  }
  const worker = String(extra.worker ?? "experiment-bridge");
  // Every worker but analyze-results writes the phase it is named after, and
  // the same worker drives both the review loop and a bridge repair, so the
  // repair is told apart by its phase and its manifest purpose, not by its
  // worker.
  const phase = String(extra.phase ?? worker);
  const isRepair = phase === "bridge-repair";
  const iteration = Number(extra.iteration ?? 1);
  // A dispatch reserves before it runs. The one case that skips this is a
  // receipt written only to be refused: the merge rejects it before it reaches
  // the budget, and reserving for it would distort the exhaustion arithmetic
  // the surrounding test depends on.
  if (extra.reserve !== false && (phase === "experiment-bridge" || phase === "bridge-repair"))
    reserveRunExecution({ project_root: root, run_id: runId, execution_id: slot, budget: 1 });
  writeJson(path.join(workerRoot, "input-manifest.json"), {
    schema_version: 1,
    execution_id: slot,
    run_id: runId,
    scope: resolveRunWikiScope(root, runId),
    worker,
    phase,
    iteration,
    inputs: input,
    context: extra.context ?? { candidate_id: "candidate:1" },
    output_dir: path.relative(root, outputDir),
  });
  const receiptPath = path.join(workerRoot, "receipt.json");
  writeJson(receiptPath, {
    worker,
    iteration,
    run_id: runId,
    scope: resolveRunWikiScope(root, runId),
    phase,
    status,
    error:
      status === "failed"
        ? { category: "code_error", message: "experiment did not start", recoverable: true }
        : null,
    primary_output: outputName,
    ...(outputHash === undefined ? {} : { primary_output_sha256: outputHash }),
    summary: extra.summary ?? { phase },
    dashboard_patch: isRepair ? null : status === "failed" ? {} : (extra.dashboard_patch ?? {}),
    completed_at: "2026-09-09T00:00:00Z",
    has_errors: status === "failed",
    error_count: status === "failed" ? 1 : 0,
  });
  return receiptPath;
}

function merge(root: string, runId: string, receiptPath: string): string {
  return execFileSync(
    process.execPath,
    [TSX_CLI, MERGE_TS, "apply", "--root", root, "--run-id", runId, "--receipt", receiptPath],
    { encoding: "utf8", stdio: "pipe" },
  );
}

function expectMergeFails(
  root: string,
  runId: string,
  receiptPath: string,
  pattern: RegExp,
): void {
  assert.throws(
    () => merge(root, runId, receiptPath),
    (error: unknown) => {
      assert.match(String((error as { stderr: string }).stderr), pattern);
      return true;
    },
  );
}

const BRIDGE_PATCH = { "metric.current": 0.7, experiment_ids: ["exp-1"] };

function reviewPatch(verdict: string): Record<string, unknown> {
  return {
    "last_review.verdict": verdict,
    "last_review.score": 0.3,
    "last_review.reviewer_id": "reviewer:1",
    // A metric-target run needs the review to publish the number it ruled on,
    // even when the ruling is that the evidence could not be ruled on.
    "metric.current": 0.7,
  };
}

function testRepairAndRetry(): void {
  const root = tempDir("aris-bridge-repair-");
  try {
    const runId = "train-1";
    makeRun(root, runId);
    const frozenInput = { experiment_plan_sha256: "plan:1", seed: 7 };
    const failed = makeReceipt(root, runId, "bridge-fail-1", frozenInput, null, "failed");
    assert.match(merge(root, runId, failed), /bridge-repair-pending/);
    let dashboard = readDashboard(root, runId);
    assert.equal(dashboard.status, "bridge_repair_pending");
    assert.equal(dashboard.current_phase, "bridge-repair");
    assert.equal(dashboard.bridge_failure?.status, "pending");
    assert.equal(dashboard.bridge_failure?.reason, "execution");
    assert.equal(
      dashboard.bridge_failure?.bridge_receipt_ref,
      "workers/bridge-fail-1/receipt.json",
    );
    // A failure is recorded, not merged: nothing entered metric history.
    assert.deepEqual(dashboard.metric.history, [{ iter: 1, value: 0.6 }]);

    const repair = makeReceipt(root, runId, "repair-1", {}, null, "done", {
      worker: "auto-review-loop",
      phase: "bridge-repair",
      context: { purpose: "bridge_repair", candidate_id: "candidate:1" },
      summary: { repair_status: "fixed", repair_round: 1 },
    });
    merge(root, runId, repair);
    dashboard = readDashboard(root, runId);
    assert.equal(dashboard.current_phase, "experiment-bridge");
    assert.equal(dashboard.status, "running");
    assert.equal(dashboard.bridge_failure?.status, "fixed");
    assert.equal(dashboard.bridge_failure?.repair_attempts, 1);
    // Re-applying the same repair is a replay, not a second round.
    assert.match(merge(root, runId, repair), /already-applied/);
    assert.equal(readDashboard(root, runId).bridge_failure?.repair_attempts, 1);

    const retried = makeReceipt(root, runId, "bridge-retry-1", frozenInput, "usable", "done", {
      dashboard_patch: BRIDGE_PATCH,
    });
    assert.match(merge(root, runId, retried), /"applied":true/);
    dashboard = readDashboard(root, runId);
    assert.equal(dashboard.last_bridge_receipt?.receipt_ref, "workers/bridge-retry-1/receipt.json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRepairBoundaries(): void {
  const root = tempDir("aris-bridge-boundary-");
  try {
    const runId = "train-2";
    // Each bridge or repair dispatch below reserves one unit and nothing here
    // reports an actual cost, so nothing is refunded. This scenario makes six
    // such dispatches, so a budget of six leaves the run with nothing left at
    // the moment the last repair reports exhaustion - which is the only way
    // that report is accepted.
    makeRun(root, runId, 6);
    const failed = makeReceipt(root, runId, "bridge-fail-1", { plan: "p" }, null, "failed");
    merge(root, runId, failed);
    const semantic = makeReceipt(root, runId, "repair-semantic", {}, null, "done", {
      worker: "auto-review-loop",
      phase: "bridge-repair",
      context: { purpose: "bridge_repair" },
      summary: { repair_status: "fixed", repair_round: 1, node_interface_changed: true },
    });
    expectMergeFails(root, runId, semantic, /frozen research boundary/);
    const fixed = makeReceipt(root, runId, "repair-1", {}, null, "done", {
      worker: "auto-review-loop",
      phase: "bridge-repair",
      context: { purpose: "bridge_repair" },
      summary: { repair_status: "fixed", repair_round: 1 },
    });
    merge(root, runId, fixed);
    const changed = makeReceipt(root, runId, "bridge-changed", { plan: "changed" }, "bad", "done", {
      dashboard_patch: BRIDGE_PATCH,
    });
    expectMergeFails(root, runId, changed, /bridge retry inputs changed after repair/);

    const secondFailure = makeReceipt(root, runId, "bridge-fail-2", { plan: "p" }, null, "failed");
    merge(root, runId, secondFailure);
    const exhausted = makeReceipt(root, runId, "repair-2", {}, null, "done", {
      worker: "auto-review-loop",
      phase: "bridge-repair",
      context: { purpose: "bridge_repair" },
      summary: { repair_status: "exhausted", repair_round: 2 },
    });
    merge(root, runId, exhausted);
    const dashboard = readDashboard(root, runId);
    // The bridge itself never ran, so the run ends failed rather than
    // completing without a proposal.
    assert.equal(dashboard.status, "failed");
    assert.equal(dashboard.current_phase, "bridge-repair");
    assert.equal(dashboard.bridge_failure?.status, "exhausted");

    // Nothing more lands on a run that already ended: it is parked in
    // bridge-repair, and the bridge cannot write from there.
    const late = makeReceipt(root, runId, "bridge-fail-3", { plan: "p" }, null, "failed", {
      reserve: false,
    });
    expectMergeFails(root, runId, late, /cannot write while dashboard.current_phase is/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Run the bridge and stop with the run waiting on its review loop. */
function advanceToReview(
  root: string,
  runId: string,
  bridgeSlot: string,
  frozenInput: Record<string, unknown>,
): void {
  const bridge = makeReceipt(root, runId, bridgeSlot, frozenInput, "measured", "done", {
    dashboard_patch: BRIDGE_PATCH,
  });
  merge(root, runId, bridge);
  setPhase(root, runId, "auto-review-loop");
}

// Evidence too weak to judge means the experiment fell short, not the idea. The
// candidate goes back to the bridge to run the same idea with better settings,
// and the iteration stays put because no new idea was proposed.
function testInsufficientEvidenceReturnsToTheBridge(): void {
  const root = tempDir("aris-bridge-insufficient-");
  try {
    const runId = "train-3";
    makeRun(root, runId);
    const frozenInput = { experiment_plan_sha256: "plan:1", seed: 7 };
    advanceToReview(root, runId, "bridge-1", frozenInput);

    const review = makeReceipt(root, runId, "review-1", {}, "review-report", "done", {
      worker: "auto-review-loop",
      phase: "auto-review-loop",
      summary: { verdict: "insufficient" },
      dashboard_patch: reviewPatch("insufficient"),
    });
    assert.match(merge(root, runId, review), /bridge-repair-pending/);
    let dashboard = readDashboard(root, runId);
    assert.equal(dashboard.status, "bridge_repair_pending");
    assert.equal(dashboard.current_phase, "bridge-repair");
    assert.equal(dashboard.iteration, 1);
    assert.equal(dashboard.bridge_failure?.reason, "insufficient_evidence");
    assert.equal(dashboard.bridge_failure?.status, "pending");
    // The repair worker reads the experiment it has to re-tune, so the receipt
    // that produced the thin evidence is still on the dashboard.
    assert.equal(dashboard.bridge_failure?.bridge_receipt_ref, "workers/bridge-1/receipt.json");
    // An unjudgeable result never enters metric history: the only entry for
    // this iteration is still the one the bridge wrote.
    assert.equal(dashboard.metric.history.length, 1);
    assert.equal(dashboard.metric.history[0]!.source, "experiment-bridge");

    const repair = makeReceipt(root, runId, "repair-1", {}, null, "done", {
      worker: "auto-review-loop",
      phase: "bridge-repair",
      context: { purpose: "bridge_repair", candidate_id: "candidate:1" },
      summary: { repair_status: "fixed", repair_round: 1 },
    });
    merge(root, runId, repair);
    dashboard = readDashboard(root, runId);
    assert.equal(dashboard.current_phase, "experiment-bridge");
    assert.equal(dashboard.bridge_failure?.status, "fixed");

    // Tuning changes the experiment plan's contents, not the manifest inputs,
    // so the retry still carries the frozen inputs the repair was bound to.
    const retry = makeReceipt(root, runId, "bridge-2", frozenInput, "better", "done", {
      dashboard_patch: BRIDGE_PATCH,
    });
    assert.match(merge(root, runId, retry), /"applied":true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A candidate that ran out of tuning budget never earned a proposal, but it did
// not break either - so it completes without a proposal instead of failing.
function testExhaustedTuningCompletesWithoutAProposal(): void {
  const root = tempDir("aris-bridge-insufficient-exhausted-");
  try {
    const runId = "train-4";
    // The bridge takes the first unit and the repair takes the second, which is
    // the only way the repair is allowed to report exhaustion.
    makeRun(root, runId, 2);
    advanceToReview(root, runId, "bridge-1", { plan: "p" });
    const review = makeReceipt(root, runId, "review-1", {}, "review-report", "done", {
      worker: "auto-review-loop",
      phase: "auto-review-loop",
      summary: { verdict: "insufficient" },
      dashboard_patch: reviewPatch("insufficient"),
    });
    merge(root, runId, review);
    assert.equal(readDashboard(root, runId).current_phase, "bridge-repair");
    const repair = makeReceipt(root, runId, "repair-1", {}, null, "done", {
      worker: "auto-review-loop",
      phase: "bridge-repair",
      context: { purpose: "bridge_repair", candidate_id: "candidate:1" },
      summary: { repair_status: "exhausted", repair_round: 1 },
    });
    merge(root, runId, repair);
    const dashboard = readDashboard(root, runId);
    assert.equal(dashboard.current_phase, "completed");
    assert.equal(dashboard.status, "completed");
    assert.equal(dashboard.outcome, "no_proposal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testRepairAndRetry();
testInsufficientEvidenceReturnsToTheBridge();
testExhaustedTuningCompletesWithoutAProposal();
testRepairBoundaries();
console.log("bridge repair tests passed");
