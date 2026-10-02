import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateDashboard } from "../src/tools/metric-gate.js";
import { evaluateWorkflowStopGate } from "../src/tools/workflow-stop-gate.js";
import { ensureRun } from "../src/tools/run-contract.js";
import type { OuterCycleSummary } from "../src/tools/workflow-state.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-arl-cap-"));
const runId = "arl-cap";
const runRoot = path.join(root, ".aris", "runs", runId);
fs.mkdirSync(runRoot, { recursive: true });
try {
  ensureRun({ project_root: root, run_id: runId, parent_run_id: null, scope_path: "/" });
  const dashboard = {
    run_id: runId,
    iteration: 2,
    config: { max_iterations: 3, patience: 1 },
    metric: {
      direction: "higher_better",
      target: 0.9,
      tolerance: 0,
      current: 0.6,
      baseline: 0.7,
      history: [{ iter: 1, value: 0.7 }, { iter: 2, value: 0.6 }],
    },
  };
  const dashboardPath = path.join(runRoot, "dashboard.json");
  fs.writeFileSync(dashboardPath, JSON.stringify(dashboard));
  assert.equal(evaluateDashboard(root, runId).stop_reason, null);
  dashboard.iteration = 3;
  fs.writeFileSync(dashboardPath, JSON.stringify(dashboard));
  assert.equal(evaluateDashboard(root, runId).stop_reason, "iteration_cap");
  dashboard.metric.current = 0.91;
  fs.writeFileSync(dashboardPath, JSON.stringify(dashboard));
  assert.equal(evaluateDashboard(root, runId).stop_reason, "metric_met");
  fs.writeFileSync(dashboardPath, JSON.stringify({ ...dashboard, config: {} }));
  assert.equal(evaluateDashboard(root, runId).stop_reason, "invalid_metric");

  const moduleMetricPath = path.join(root, "module-metric.json");
  fs.writeFileSync(moduleMetricPath, JSON.stringify({
    schema_version: 1,
    module_id: "module-a",
    primary: { name: "score", target: 0.9, direction: "higher_better", tolerance: 0, baseline: 0.7 },
    patience: 2,
  }));
  fs.writeFileSync(dashboardPath, JSON.stringify({ ...dashboard, mode: "module", module_id: "module-a", config: {} }));
  const moduleDecision = evaluateDashboard(root, runId, moduleMetricPath);
  assert.equal(moduleDecision.stop_reason, "metric_met");
  assert.equal(moduleDecision.max_iterations, null);

  const cycle = (outer_iteration: number, target_reached = false): OuterCycleSummary => ({
    schema_version: 1,
    outer_run_id: runId,
    outer_iteration,
    generation: 1,
    wave_id: `wave-${outer_iteration}`,
    wave_kind: "module",
    candidate_ids: [],
    target_reached,
    finalist_id: null,
    promotion_trial_id: null,
    validation_result: "rejected",
    promotion_result: "not_run",
    tester_improved: false,
    valid_candidate: false,
    status: "completed",
    evidence_refs: [],
    evidence_sha256: "a".repeat(64),
    recorded_at: "2026-10-01T00:00:00.000Z",
  });
  const base = {
    outer_run_id: runId,
    policy: { mode: "auto_research_loop" as const, max_iterations: 2, target: { name: "score", direction: "higher_better" as const, value: 0.9 } },
    exposure: { max_exposures_per_task: 1, reserved: 0, settled: 1, released: 0 },
  };
  assert.equal(evaluateWorkflowStopGate({ ...base, cycle_summaries: [cycle(1)] }).reason, "continue");
  assert.equal(evaluateWorkflowStopGate({ ...base, cycle_summaries: [cycle(1), cycle(2)] }).reason, "iteration_cap");
  assert.equal(evaluateWorkflowStopGate({ ...base, cycle_summaries: [cycle(1), cycle(2, true)] }).reason, "target_reached");
  assert.throws(() => evaluateWorkflowStopGate({
    ...base,
    cycle_summaries: [cycle(1)],
    budget: { limit: 1, reserved: 0, consumed: 0, released: 0, unit: "gpu_hours" },
  }), /budget snapshot/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
