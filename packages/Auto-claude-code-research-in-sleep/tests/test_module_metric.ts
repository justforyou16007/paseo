import { createRootRun, runJsonPath } from "../src/tools/run-contract.js";
import { initializeRunBudget } from "../src/tools/run-budget.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PACKAGE_ROOT = path.resolve(".");
const METRIC_GATE = path.resolve("src/tools/metric-gate.ts");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-module-metric-test-"));
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runMetricGate(...args: string[]): CommandResult {
  try {
    return {
      stdout: execFileSync("npx", ["--no-install", "tsx", METRIC_GATE, ...args], {
        cwd: PACKAGE_ROOT,
        encoding: "utf-8",
        timeout: 15_000,
      }),
      stderr: "",
      exitCode: 0,
    };
  } catch (error: unknown) {
    const result = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function dashboard(root: string, runId: string, value: Record<string, unknown>): void {
  if (!fs.existsSync(runJsonPath(root, runId))) {
    createRootRun({ project_root: root, run_id: runId });
    // "budget exhausted" is read off the run's budget ledger rather than an
    // iteration counter on the dashboard, so a run the gate can evaluate at
    // all is a run whose budget was initialized. Leave room so these fixtures
    // exercise the metric decision instead of stopping on resources.
    initializeRunBudget(root, runId, { amount: 10, unit: "compute" });
  }
  writeJson(path.join(root, ".aris", "runs", runId, "dashboard.json"), value);
}

const moduleMetric = {
  schema_version: 1,
  module_id: "rl",
  primary: {
    name: "teacher_reward",
    target: 0.8,
    direction: "higher_better",
    tolerance: 0.01,
    baseline: 0.62,
  },
  patience: 2,
};

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

test("module metric is explicit, wins over dashboard defaults, and validates identity", () => {
  const root = tmpDir();
  try {
    const metricPath = path.join(root, "config", "module-metric.json");
    writeJson(metricPath, moduleMetric);
    dashboard(root, "run-rl", {
      workflow_mode: true,
      module_id: "rl",
      metric: {
        current: 0.79,
        direction: "lower_better",
        target: 0.1,
        tolerance: 0.9,
        baseline: 0.1,
        history: [],
      },
      iteration: 1,
      config: { patience: 9 },
    });

    const config = runMetricGate("config", root, "--module-metric", metricPath);
    assert.equal(config.exitCode, 0, `${config.stdout}\n${config.stderr}`);
    assert.deepEqual(JSON.parse(config.stdout), {
      configured: true,
      module_id: "rl",
      name: "teacher_reward",
      target: 0.8,
      direction: "higher_better",
      tolerance: 0.01,
      baseline: 0.62,
      patience: 2,
    });

    const evaluation = runMetricGate("evaluate", root, "run-rl", "--module-metric", metricPath);
    assert.equal(evaluation.exitCode, 0, `${evaluation.stdout}\n${evaluation.stderr}`);
    const decision = JSON.parse(evaluation.stdout) as Record<string, unknown>;
    assert.equal(decision.target, 0.8);
    assert.equal(decision.direction, "higher_better");
    assert.equal(decision.patience, 2);
    assert.equal(decision.stop_reason, null);

    const positional = runMetricGate("config", root, "config/module-metric.json");
    assert.equal(positional.exitCode, 0, `${positional.stdout}\n${positional.stderr}`);
    const alias = runMetricGate("config", root, "--metric-file", metricPath);
    assert.equal(alias.exitCode, 0, `${alias.stdout}\n${alias.stderr}`);

    const mismatchPath = path.join(root, "wrong-module-metric.json");
    writeJson(mismatchPath, { ...moduleMetric, module_id: "data" });
    const mismatch = runMetricGate("evaluate", root, "run-rl", "--module-metric", mismatchPath);
    assert.notEqual(mismatch.exitCode, 0);
    assert.match(`${mismatch.stdout}${mismatch.stderr}`, /does not match dashboard module_id/);
  } finally {
    cleanup(root);
  }
});

test("workflow/module mode refuses to fall back to CLAUDE.md", () => {
  const root = tmpDir();
  try {
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      ["## Metric Target", "", "primary: 0.7 score", "direction: higher_better"].join("\n"),
      "utf-8",
    );
    dashboard(root, "run-rl", {
      run_kind: "module",
      module_id: "rl",
      metric: { current: 0.7, history: [] },
      iteration: 1,
      config: { patience: 2 },
    });
    const result = runMetricGate("evaluate", root, "run-rl");
    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}${result.stderr}`, /requires an explicit module-metric\.json/);
  } finally {
    cleanup(root);
  }
});

test("malformed module metric fails before it can be used", () => {
  const root = tmpDir();
  try {
    const metricPath = path.join(root, "module-metric.json");
    writeJson(metricPath, { ...moduleMetric, unexpected: true });
    const result = runMetricGate("config", root, "--module-metric", metricPath);
    assert.notEqual(result.exitCode, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unknown field 'unexpected'/);
  } finally {
    cleanup(root);
  }
});

let passed = 0;
let failed = 0;
for (const current of tests) {
  try {
    current.fn();
    console.log(`  PASS ${current.name}`);
    passed += 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.log(`  FAIL ${current.name}: ${message}`);
    failed += 1;
    if (process.argv.includes("--bail")) break;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
