import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createModuleWorkspace, inspectModuleWorkspace, sealModuleWorkspace, removeModuleWorkspace, restoreModuleWorkspace } from "../src/tools/workflow-workspace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-worktree-"));
function git(...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
try {
  git("init", "-q");
  git("config", "user.name", "ARIS test");
  git("config", "user.email", "aris-test@example.invalid");
  fs.mkdirSync(path.join(root, "module"));
  fs.writeFileSync(path.join(root, "module", "train.txt"), "baseline\n");
  fs.writeFileSync(path.join(root, "other.txt"), "untouched\n");
  git("add", "."); git("commit", "-qm", "fixture");
  const baseline = git("rev-parse", "HEAD");
  const request = { project_root: root, module_run_id: "module-1", baseline_commit: baseline, write_scope: ["module"] };
  const workspace = createModuleWorkspace(request);
  assert.equal(workspace.status, "active");
  assert.deepEqual(createModuleWorkspace(request), workspace);
  fs.writeFileSync(path.join(workspace.workspace_root, "module", "train.txt"), "candidate\n");
  assert.equal(fs.readFileSync(path.join(root, "module", "train.txt"), "utf8"), "baseline\n");
  assert.deepEqual(inspectModuleWorkspace(root, "module-1"), ["module/train.txt"]);
  fs.writeFileSync(path.join(workspace.workspace_root, "other.txt"), "forbidden\n");
  assert.throws(() => inspectModuleWorkspace(root, "module-1"), /outside module scope/);
  fs.writeFileSync(path.join(workspace.workspace_root, "other.txt"), "untouched\n");
  fs.mkdirSync(path.join(workspace.workspace_root, ".aris"));
  assert.throws(() => inspectModuleWorkspace(root, "module-1"), /persistent state/);
  fs.rmdirSync(path.join(workspace.workspace_root, ".aris"));
  fs.writeFileSync(path.join(workspace.workspace_root, "module", "new.txt"), "new candidate output\n");
  const sealed = sealModuleWorkspace(root, "module-1");
  assert.equal(sealed.status, "sealed");
  assert.match(fs.readFileSync(path.join(root, ".aris/runs/module-1/workspace.patch"), "utf8"), /new candidate output/);
  assert.deepEqual(sealModuleWorkspace(root, "module-1"), sealed);
  assert.throws(() => removeModuleWorkspace(root, "module-1", []));
  assert.equal(fs.existsSync(workspace.workspace_root), true);
  fs.writeFileSync(path.join(workspace.workspace_root, "module", "train.txt"), "changed after sealing\n");
  assert.throws(() => sealModuleWorkspace(root, "module-1"), /sealed workspace changed/);
  assert.throws(() => createModuleWorkspace({ ...request, write_scope: ["other.txt"] }), /semantics changed/);
  // Model a completed removal, then recover the candidate from durable baseline/patch evidence.
  git("worktree", "remove", "--force", workspace.worktree_root);
  const statePath = path.join(root, ".aris/runs/module-1/workspace.json");
  fs.writeFileSync(statePath, JSON.stringify({ ...sealed, status: "removed" }));
  const restored = restoreModuleWorkspace(root, "module-1");
  assert.equal(restored.status, "sealed");
  assert.equal(fs.readFileSync(path.join(restored.workspace_root, "module/train.txt"), "utf8"), "candidate\n");
  assert.equal(fs.readFileSync(path.join(restored.workspace_root, "module/new.txt"), "utf8"), "new candidate output\n");
  fs.writeFileSync(statePath, JSON.stringify({ ...restored, status: "restoring" }));
  assert.deepEqual(restoreModuleWorkspace(root, "module-1"), restored);
  fs.appendFileSync(path.join(root, ".aris/runs/module-1/workspace.patch"), "tampered");
  assert.throws(() => restoreModuleWorkspace(root, "module-1"), /sealed patch changed/);

} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("workflow workspace: real git isolation, scope and immutable patch checks passed");
