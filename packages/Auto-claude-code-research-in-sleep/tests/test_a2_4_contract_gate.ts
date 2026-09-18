import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluateDashboard } from "../src/tools/metric-gate.js";
import { createRootRun, runJsonPath } from "../src/tools/run-contract.js";

function withRoot(action: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-4-gate-"));
  try { action(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function cli(tool: string, args: string[]) {
  return spawnSync(process.execPath, [
    "/home/liu/paseo/node_modules/tsx/dist/cli.mjs",
    path.resolve("src/tools", tool + ".ts"), ...args,
  ], { encoding: "utf8", timeout: 15000 });
}

test("metric reads reject orphan dashboards and unsafe run ids", () => withRoot(root => {
  const directory = path.join(root, ".aris", "runs", "orphan");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "dashboard.json"), "{}");
  assert.throws(() => evaluateDashboard(root, "orphan"), { code: "RUN_CONTRACT_NOT_FOUND" });
  for (const id of ["bad:id", "bad@id", "bad id", "_leading", "x".repeat(129)])
    assert.throws(() => evaluateDashboard(root, id), { code: "INVALID_RUN_ID" });
  assert.equal(fs.existsSync(runJsonPath(root, "orphan")), false);
}));

test("metric and dashboard merge CLIs reject removed contracts before writing", () => withRoot(root => {
  createRootRun({ project_root: root, run_id: "removed" });
  const dashboard = path.join(root, ".aris", "runs", "removed", "dashboard.json");
  fs.writeFileSync(dashboard, "{}");
  fs.unlinkSync(runJsonPath(root, "removed"));
  for (const id of ["removed", "bad:id", "bad@id"]) {
    for (const [tool, args] of [
      ["metric-gate", ["evaluate", root, id]],
      ["dashboard-merge", ["apply", "--root", root, "--run-id", id, "--receipt", path.join(root, "receipt.json")]],
    ] as const) {
      const result = cli(tool, [...args]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, id === "removed" ? /RUN_CONTRACT_NOT_FOUND/ : /INVALID_RUN_ID/);
    }
  }
  assert.equal(fs.readFileSync(dashboard, "utf8"), "{}");
  assert.equal(fs.existsSync(runJsonPath(root, "removed")), false);
}));
