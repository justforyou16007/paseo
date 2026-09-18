import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRootRun, runJsonPath } from "../src/tools/run-contract.js";
import { createArtifactRegistry } from "../src/tools/artifact-registry.js";
import { nodeInterfaceRecordPath, readNodeInterfaceRecord, readWorkflowConnectionRecord } from "../src/tools/workflow-interface.js";
import { readWorkflowComposition, workflowCompositionPath } from "../src/tools/workflow-composition.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReviewAssignment } from "../src/tools/review-submit.js";

function withRoot(action: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-contract-gate-"));
  try { action(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const readers = [
  (root: string, id: string) => nodeInterfaceRecordPath(root, id),
  (root: string, id: string) => readNodeInterfaceRecord(root, id),
  (root: string, id: string) => readWorkflowConnectionRecord(root, id, "connection"),
  (root: string, id: string) => createArtifactRegistry(root, id),
  (root: string, id: string) => workflowCompositionPath(root, id, "composition"),
  (root: string, id: string) => readWorkflowComposition(root, id, "composition"),
];

test("run-owned entry points reject orphan state and invalid run ids", () => withRoot(root => {
  const directory = path.join(root, ".aris", "runs", "orphan");
  fs.mkdirSync(path.join(directory, "connections"), { recursive: true });
  fs.writeFileSync(path.join(directory, "interface-record.json"), "{}");
  fs.writeFileSync(path.join(directory, "connections", "connection.json"), "{}");
  for (const read of readers) {
    assert.throws(() => read(root, "orphan"), { code: "RUN_CONTRACT_NOT_FOUND" });
    for (const id of ["bad:id", "bad@id", "bad id"]) {
      assert.throws(() => read(root, id), { code: "INVALID_RUN_ID" });
    }
  }
  assert.equal(fs.existsSync(runJsonPath(root, "orphan")), false);
}));

test("a retained registry checks the contract again on reads and writes", () => withRoot(root => {
  createRootRun({ project_root: root, run_id: "registry" });
  const registry = createArtifactRegistry(root, "registry");
  assert.deepEqual(registry.list(), []);
  fs.unlinkSync(runJsonPath(root, "registry"));
  assert.throws(() => registry.list(), { code: "RUN_CONTRACT_NOT_FOUND" });
  assert.throws(() => registry.register({}), { code: "RUN_CONTRACT_NOT_FOUND" });
}));

function iteration(command: string, root: string, id: string) {
  return spawnSync(process.execPath, [
    "/home/liu/paseo/node_modules/tsx/dist/cli.mjs",
    fileURLToPath(new URL("../src/tools/iteration-log.ts", import.meta.url)),
    command, root, id, ...(command === "note" ? ["idea", "0"] : []),
  ], { encoding: "utf8" });
}

test("iteration CLI uses the run directory and leaves old flat files untouched", () => withRoot(root => {
  createRootRun({ project_root: root, run_id: "iterations" });
  const oldPath = path.join(root, ".aris", "runs", "iterations.iterations.jsonl");
  const oldContent = '{"stale_count":99}\n';
  fs.writeFileSync(oldPath, oldContent);
  const empty = iteration("show", root, "iterations");
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "");
  for (const stale of [1, 2]) {
    const result = iteration("note", root, "iterations");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { stale_count: stale, pivot: stale === 1 ? "none" : "structural" });
  }
  const shown = iteration("show", root, "iterations");
  assert.equal(shown.status, 0);
  assert.equal(shown.stdout.trim().split("\n").length, 2);
  assert.equal(fs.readFileSync(oldPath, "utf8"), oldContent);
  fs.unlinkSync(runJsonPath(root, "iterations"));
  for (const command of ["show", "note"]) {
    const missing = iteration(command, root, "iterations");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /RUN_CONTRACT_NOT_FOUND/);
    for (const id of ["bad:id", "bad@id", "bad id", "_leading", "a".repeat(129)]) {
      const invalid = iteration(command, root, id);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /INVALID_RUN_ID/);
    }
  }
}));

test("composition lookup gates matching owners, including invalid directory names", () => withRoot(root => {
  const runs = path.join(root, ".aris", "runs");
  fs.mkdirSync(path.join(runs, "unrelated"), { recursive: true });
  assert.throws(() => readWorkflowComposition(root, "target"), { code: "COMPOSITION_NOT_FOUND" });
  for (const id of ["orphan", "bad:id", "bad@id"]) {
    const directory = path.join(runs, id, "compositions", "target");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "state.json"), "{}");
    assert.throws(() => readWorkflowComposition(root, "target"), {
      code: id === "orphan" ? "RUN_CONTRACT_NOT_FOUND" : "INVALID_RUN_ID",
    });
    fs.rmSync(path.join(runs, id), { recursive: true });
  }
}));

test("review assignment run ids share INVALID_RUN_ID for spaces and colons", () => withRoot(root => {
  for (const field of ["outer_run_id", "reviewed_run_id"] as const) {
    for (const id of ["bad id", "bad:id", "bad@id"]) {
      assert.throws(() => createReviewAssignment({
        actor: "review_scheduler", project_root: root, review_id: "review",
        outer_run_id: "outer", reviewed_run_id: "outer", reviewed_run_kind: "workflow",
        outer_iteration: 1, wave_id: "wave", wave_kind: "module", review_stage: "validation",
        generation: 1, subject: { validation_comparison_id: "bundle", candidate_ids: ["candidate"] },
        reviewer_worker_id: "reviewer", evidence_producer_worker_id: "producer", evidence_bundle_id: "bundle",
        [field]: id,
      }), { code: "INVALID_RUN_ID", location: field });
    }
  }
}));
