import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  advanceOuterPhase,
  beginOuterCycle,
  completeOuterCycle,
  recordOuterBridgeFailure,
  recordOuterBridgeRepair,
  recordOuterBridgeSuccess,
} from "../src/tools/workflow-runtime.js";
import { prepareRunExecution } from "../src/tools/run-budget.js";
import {
  cleanup,
  evidence,
  makeFixture,
  startFixture,
  tempDir,
  writeJson,
} from "./test_workflow_runtime.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

interface BridgeFiles {
  receiptPath: string;
  manifestPath: string;
}

// COMPAT(outer-repair-receipt): added in v0.1.0, remove after 2026-12-14
// Keep repair receipt coverage while the outer bridge owns dispatch through its public API.
function bridgeFiles(
  root: string,
  runId: string,
  workerId: string,
  status: "failed" | "done",
  inputs: Record<string, unknown>,
  context: Record<string, unknown>,
  output?: unknown,
): BridgeFiles {
  const repair = workerId.startsWith("repair");
  // Dispatch through the same gate production uses: the manifest and the
  // reservation are written together, so a later receipt has an execution to
  // settle against. A repair attempt spends resources like any other run.
  const prepared = prepareRunExecution({
    project_root: root,
    run_id: runId,
    execution_id: workerId,
    scope: "cycles/1",
    budget: 1,
    manifest: {
      schema_version: 1,
      worker: repair ? "auto-review-loop" : "experiment-bridge",
      phase: repair ? "bridge-repair" : "experiment-bridge",
      inputs,
      context,
    },
  });
  const manifestPath = prepared.manifest_path;
  const workerRoot = path.dirname(manifestPath);
  const outputDir = prepared.output_dir;
  const outputName = output === undefined ? null : "bridge-result.json";
  const outputHash =
    outputName === null ? undefined : writeJson(path.join(outputDir, outputName), output);
  const receiptPath = path.join(workerRoot, "receipt.json");
  writeJson(receiptPath, {
    run_id: runId,
    worker: repair ? "auto-review-loop" : "experiment-bridge",
    phase: repair ? "bridge-repair" : "experiment-bridge",
    status: repair ? "done" : status,
    error:
      status === "failed" ? { category: "environment", message: "bridge did not start" } : null,
    primary_output: repair ? null : outputName,
    ...(outputHash === undefined ? {} : { primary_output_sha256: outputHash }),
    summary: repair
      ? {
          repair_status: context.repair_status ?? "fixed",
          repair_round: context.repair_round ?? 1,
        }
      : { phase: "experiment-bridge" },
    dashboard_patch: repair ? null : {},
  });
  return { receiptPath, manifestPath };
}

function enterWorkset(
  root: string,
  executionRoot: string,
  runId: string,
  outerBudget?: { amount: number; unit: string },
): ReturnType<typeof makeFixture> {
  const fixture = makeFixture(root, executionRoot, runId, 4, { outer_budget: outerBudget });
  startFixture(fixture);
  beginOuterCycle({
    ...fixture.identity,
    wave_id: "wave:workflow",
    wave_kind: "module",
    evidence_paths: [evidence(root, "cycle-begin")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "diagnosis",
    to_phase: "workset",
    evidence_paths: [evidence(root, "diagnosis")],
  });
  return fixture;
}

function testRepairAndFrozenRetry(): void {
  const root = tempDir("aris-outer-bridge-repair-");
  const executionRoot = tempDir("aris-outer-bridge-repair-exec-");
  try {
    const fixture = enterWorkset(root, executionRoot, "outer-bridge-fixed");
    const inputs = { workflow_idea_sha256: "idea:fixed", seed: 7 };
    const context = { candidate_id: "candidate:workflow" };
    const failed = bridgeFiles(
      root,
      fixture.identity.outer_run_id,
      "bridge-failed",
      "failed",
      inputs,
      context,
    );
    const pending = recordOuterBridgeFailure({
      ...fixture.identity,
      receipt_path: failed.receiptPath,
      manifest_path: failed.manifestPath,
      evidence_paths: [failed.receiptPath, failed.manifestPath],
    });
    assert.equal(pending.current_phase, "bridge-repair");
    assert.equal(pending.active_cycle?.bridge_failure?.status, "pending");
    expectCode(
      () =>
        advanceOuterPhase({
          ...fixture.identity,
          from_phase: "bridge-repair",
          to_phase: "workset",
          evidence_paths: [evidence(root, "repair-not-finished")],
        }),
      "OUTER_PHASE_ORDER",
    );

    const repair = bridgeFiles(
      root,
      fixture.identity.outer_run_id,
      "repair-1",
      "done",
      { failed_bridge: "bridge-failed" },
      { purpose: "bridge_repair", repair_status: "fixed", repair_round: 1 },
    );
    const fixed = recordOuterBridgeRepair({
      ...fixture.identity,
      repair_receipt_path: repair.receiptPath,
      repair_manifest_path: repair.manifestPath,
      evidence_paths: [repair.receiptPath, repair.manifestPath],
    });
    assert.equal(fixed.current_phase, "workset");
    assert.equal(fixed.active_cycle?.bridge_failure?.status, "fixed");

    const changed = bridgeFiles(
      root,
      fixture.identity.outer_run_id,
      "bridge-changed",
      "done",
      { ...inputs, seed: 8 },
      context,
      { usable: false },
    );
    expectCode(
      () =>
        recordOuterBridgeSuccess({
          ...fixture.identity,
          receipt_path: changed.receiptPath,
          manifest_path: changed.manifestPath,
          evidence_paths: [changed.receiptPath, changed.manifestPath],
        }),
      "RETRY_SEMANTICS_CHANGED",
    );

    const success = bridgeFiles(
      root,
      fixture.identity.outer_run_id,
      "bridge-retry",
      "done",
      inputs,
      context,
      { usable: true },
    );
    recordOuterBridgeSuccess({
      ...fixture.identity,
      receipt_path: success.receiptPath,
      manifest_path: success.manifestPath,
      evidence_paths: [success.receiptPath, success.manifestPath],
    });
    // A repaired receipt alone must not create downstream runs.
    assert.deepEqual(fixed.children, []);
  } finally {
    cleanup(root);
    cleanup(executionRoot);
  }
}

function testExhaustedRepairClosesWithoutDownstreamRuns(): void {
  const root = tempDir("aris-outer-bridge-exhausted-");
  const executionRoot = tempDir("aris-outer-bridge-exhausted-exec-");
  try {
    // The fixture's producer child takes 10, leaving exactly two dispatches:
    // the failed bridge and its one repair. The repair worker may then report
    // exhaustion because the run really has nothing left to spend.
    const fixture = enterWorkset(root, executionRoot, "outer-bridge-exhausted", {
      amount: 12,
      unit: "gpu_hours",
    });
    const failed = bridgeFiles(
      root,
      fixture.identity.outer_run_id,
      "bridge-failed",
      "failed",
      { workflow_idea_sha256: "idea:failed" },
      { candidate_id: "candidate:workflow" },
    );
    recordOuterBridgeFailure({
      ...fixture.identity,
      receipt_path: failed.receiptPath,
      manifest_path: failed.manifestPath,
      evidence_paths: [failed.receiptPath, failed.manifestPath],
    });
    const repair = bridgeFiles(
      root,
      fixture.identity.outer_run_id,
      "repair-1",
      "done",
      { failed_bridge: "bridge-failed" },
      { purpose: "bridge_repair", repair_status: "exhausted", repair_round: 1 },
    );
    const exhausted = recordOuterBridgeRepair({
      ...fixture.identity,
      repair_receipt_path: repair.receiptPath,
      repair_manifest_path: repair.manifestPath,
      evidence_paths: [repair.receiptPath, repair.manifestPath],
    });
    assert.equal(exhausted.current_phase, "bridge-repair");
    assert.equal(exhausted.active_cycle?.bridge_failure?.status, "exhausted");
    const closed = completeOuterCycle({
      ...fixture.identity,
      status: "failed",
      evidence_paths: [
        failed.receiptPath,
        failed.manifestPath,
        repair.receiptPath,
        repair.manifestPath,
      ],
    });
    const summary = closed.cycle_history[0]!;
    assert.equal(closed.current_phase, "summary");
    assert.equal(closed.active_cycle, null);
    assert.equal(summary.validation_result, "not_run");
    assert.equal(summary.promotion_result, "not_run");
    assert.equal(summary.finalist_id, null);
    assert.deepEqual(closed.children, []);
  } finally {
    cleanup(root);
    cleanup(executionRoot);
  }
}

testRepairAndFrozenRetry();
testExhaustedRepairClosesWithoutDownstreamRuns();
console.log("outer bridge repair: 2 passed, 0 failed");
