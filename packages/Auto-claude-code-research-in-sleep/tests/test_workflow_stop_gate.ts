import { createRootRun } from "../src/tools/run-contract.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluateWorkflowStopGate,
  readWorkflowStopDecision,
  writeWorkflowStopDecision,
  type StopPolicy,
} from "../src/tools/workflow-stop-gate.js";
import type { OuterCycleSummary } from "../src/tools/workflow-state.js";

const HASH = "a".repeat(64);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-workflow-stop-gate-"));
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function cycle(
  outerIteration: number,
  changes: Partial<OuterCycleSummary> = {},
): OuterCycleSummary {
  return {
    schema_version: 1,
    outer_run_id: "outer-stop-test",
    outer_iteration: outerIteration,
    generation: 1,
    wave_id: `wave:${outerIteration}`,
    wave_kind: "module",
    status: "completed",
    candidate_ids: ["candidate:baseline"],
    finalist_id: null,
    promotion_trial_id: null,
    validation_result: "rejected",
    promotion_result: "not_run",
    target_reached: false,
    valid_candidate: false,
    tester_improved: false,
    budget: { reserved: 0, consumed: 0, released: 0, unit: "gpu_hours" },
    evidence_refs: [`cycles/${outerIteration}/evidence.json`],
    evidence_sha256: HASH,
    recorded_at: `2026-09-08T00:0${outerIteration}:00.000Z`,
    ...changes,
  };
}

function basePolicy(): StopPolicy {
  return {};
}

{
  const first = cycle(1, {
    finalist_id: "candidate:finalist",
    candidate_ids: ["candidate:baseline", "candidate:finalist"],
    validation_result: "passed",
    valid_candidate: true,
    tester_improved: true,
  });
  const second = cycle(2, {
    finalist_id: "candidate:finalist-2",
    candidate_ids: ["candidate:baseline", "candidate:finalist-2"],
    validation_result: "passed",
    valid_candidate: true,
    tester_improved: true,
  });
  const policy = basePolicy();
  const forward = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy,
    cycle_summaries: [first, second],
    exposure: { max_exposures_per_task: 4, reserved: 1, settled: 1, released: 0 },
  });
  const reversed = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy,
    cycle_summaries: [second, first],
    exposure: { max_exposures_per_task: 4, reserved: 1, settled: 1, released: 0 },
  });
  assert.equal(forward.decision, "continue");
  assert.equal(forward.reason, "continue");
  assert.deepEqual(reversed, forward);
}

{
  const reached = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy: { target: { name: "score", direction: "higher_better", value: 1 } },
    cycle_summaries: [cycle(1, { target_reached: true })],
    exposure: { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 },
  });
  assert.equal(reached.decision, "stop");
  assert.equal(reached.reason, "target_reached");

  const unconfiguredTarget = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy: basePolicy(),
    cycle_summaries: [cycle(1, { target_reached: true })],
    exposure: { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 },
  });
  assert.equal(unconfiguredTarget.reason, "continue");

  const budget = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy: { max_outer_budget: { amount: 2, unit: "gpu_hours" } },
    cycle_summaries: [cycle(1)],
    budget: { limit: 2, reserved: 0, consumed: 2, released: 0, unit: "gpu_hours" },
    exposure: { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 },
  });
  assert.equal(budget.reason, "outer_budget_exhausted");

  const exposure = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy: basePolicy(),
    cycle_summaries: [cycle(1)],
    exposure: { max_exposures_per_task: 2, reserved: 0, settled: 2, released: 0 },
  });
  assert.equal(exposure.reason, "tester_exposure_exhausted");

  const noFinalist = evaluateWorkflowStopGate({
    outer_run_id: "outer-stop-test",
    policy: { max_no_finalist_cycles: 2 },
    cycle_summaries: [cycle(1), cycle(2)],
    exposure: { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 },
  });
  assert.equal(noFinalist.reason, "no_finalist");
  assert.equal(noFinalist.no_finalist_streak, 2);

  expectCode(
    () =>
      evaluateWorkflowStopGate({
        outer_run_id: "outer-stop-test",
        policy: { max_outer_budget: { amount: 2, unit: "gpu_hours" } },
        cycle_summaries: [cycle(1)],
        exposure: { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 },
      }),
    "STOP_BUDGET_SNAPSHOT_REQUIRED",
  );
}

{
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-stop-test" });
    const decision = evaluateWorkflowStopGate({
      outer_run_id: "outer-stop-test",
      policy: {  },
      cycle_summaries: [cycle(1)],
      outer_iteration: 1,
      exposure: { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 },
    });
    writeWorkflowStopDecision(root, "outer-stop-test", 1, decision);
    assert.deepEqual(readWorkflowStopDecision(root, "outer-stop-test", 1), decision);
    expectCode(
      () => writeWorkflowStopDecision(root, "outer-other", 1, decision),
      "IDENTITY_MISMATCH",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("test_workflow_stop_gate: ok");
