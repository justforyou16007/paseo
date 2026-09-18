import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRootRun } from "../src/tools/run-contract.js";
import {
  createBudgetLedger,
  initializeRunBudget,
  readRunBudget,
  reserveRunExecution,
  settleRunExecution,
  splitChildBudget,
  refundChildBudget,
  isExecutionBudgetExhausted,
} from "../src/tools/run-budget.js";

function account(t: TestContext, amount = 10) {
  const project_root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-run-budget-"));
  t.after(() => fs.rmSync(project_root, { recursive: true, force: true }));
  const run_id = "budget-test";
  createRootRun({ project_root, run_id });
  initializeRunBudget(project_root, run_id, { amount, unit: "compute" });
  return { project_root, run_id };
}

test("zero reservation is exhausted, but zero actual cost refunds a positive reservation", (t) => {
  assert.throws(() => splitChildBudget(createBudgetLedger(0), "trial", 0), /budget/);
  const reserved = splitChildBudget(createBudgetLedger(10), "trial", 4);
  const settled = refundChildBudget(reserved, "trial", 0);
  assert.equal(settled.available, 10);
  assert.deepEqual(refundChildBudget(settled, "trial", 0), settled);
  assert.throws(() => refundChildBudget(settled, "trial", 1), /different cost/);
});

test("children, trials, and repairs share a persistent balance across rounds", (t) => {
  const run = account(t);
  reserveRunExecution({ ...run, execution_id: "child-run", budget: 4 });
  reserveRunExecution({ ...run, execution_id: "trial:1", budget: 3 });
  reserveRunExecution({ ...run, execution_id: "repair:1", budget: 2 });
  assert.equal(readRunBudget(run.project_root, run.run_id).available, 1);
  initializeRunBudget(run.project_root, run.run_id, { amount: 10, unit: "compute" });
  assert.equal(readRunBudget(run.project_root, run.run_id).available, 1);
  assert.throws(() => reserveRunExecution({ ...run, execution_id: "trial:2", budget: 2 }), /budget/);
  settleRunExecution(run.project_root, run.run_id, "child-run", 1);
  assert.equal(readRunBudget(run.project_root, run.run_id).available, 4);
  reserveRunExecution({ ...run, execution_id: "trial:2", budget: 4 });
  assert.equal(isExecutionBudgetExhausted(readRunBudget(run.project_root, run.run_id)), true);
});

test("missing cost stays reserved and replaying a reservation does not charge twice", (t) => {
  const run = account(t);
  reserveRunExecution({ ...run, execution_id: "trial:1", budget: 7 });
  reserveRunExecution({ ...run, execution_id: "trial:1", budget: 7 });
  const ledger = settleRunExecution(run.project_root, run.run_id, "trial:1");
  assert.equal(ledger.available, 3);
  assert.equal(ledger.allocations.length, 1);
  assert.equal(ledger.allocations[0]?.status, "reserved");
  assert.throws(() => reserveRunExecution({ ...run, execution_id: "trial:1", budget: 8 }), /reservation/);
});

for (const resource_status of ["not_executable", "infra_unavailable"] as const) test(`${resource_status} does not allocate at zero balance`, (t) => {
  const run = account(t, 0);
  const ledger = reserveRunExecution({ ...run, execution_id: "trial:1", resource_status });
  assert.equal(ledger.available, 0);
  assert.deepEqual(ledger.allocations, []);
});

test("budget history detects modified persisted balances", (t) => {
  const run = account(t);
  const file = path.join(run.project_root, ".aris/runs", run.run_id, "budget.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.events[0].ledger.available = 100;
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.throws(() => readRunBudget(run.project_root, run.run_id), { code: "BUDGET_STATE_ORDER" });
});
