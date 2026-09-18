import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readStateFile,
  withStateFileLock,
  writeStateJsonAtomic,
  writeStateFileAtomic,
} from "./state-file.js";
import { assertIdentifier, assertRelativePath, assertSha256, failA1 } from "./workflow-spec.js";
import { readResultPackage, resultPackagePath } from "./result-package.js";
import { requireRunContract } from "./run-contract.js";
import { readWorkflowRuntimeState } from "./workflow-state.js";

export interface ModuleWorkspaceInput {
  project_root: string;
  module_run_id: string;
  baseline_commit: string;
  write_scope: string[];
}

export interface ModuleWorkspace {
  schema_version: 1;
  module_run_id: string;
  project_root: string;
  repository_root: string;
  project_prefix: string;
  worktree_root: string;
  workspace_root: string;
  baseline_commit: string;
  write_scope: string[];
  patch_sha256: string | null;
  status: "creating" | "active" | "sealed" | "removing" | "removed" | "restoring";
}

export interface WorkspaceEvidence {
  relative_path: string;
  sha256: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function recordPath(projectRoot: string, runId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "runs",
    assertIdentifier(runId, "module_run_id"),
    "workspace.json",
  );
}

function patchPath(state: ModuleWorkspace): string {
  return path.join(
    path.dirname(recordPath(state.project_root, state.module_run_id)),
    "workspace.patch",
  );
}

function digest(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectedRoots(projectRoot: string, runId: string): { project: string; worktree: string } {
  const project = fs.realpathSync(projectRoot);
  return {
    project,
    worktree: path.join(project, ".aris", "worktrees", assertIdentifier(runId, "module_run_id")),
  };
}

export function readModuleWorkspace(projectRoot: string, runId: string): ModuleWorkspace {
  const roots = expectedRoots(projectRoot, runId);
  const state = readStateFile<ModuleWorkspace>(recordPath(roots.project, runId));
  if (
    state.schema_version !== 1 ||
    state.module_run_id !== runId ||
    state.project_root !== roots.project ||
    state.worktree_root !== roots.worktree
  )
    failA1("IDENTITY_MISMATCH", "workspace record does not match its owning run");
  if (
    state.workspace_root !== path.resolve(roots.worktree, state.project_prefix) ||
    state.project_prefix.startsWith("..") ||
    path.isAbsolute(state.project_prefix)
  )
    failA1("IDENTITY_MISMATCH", "workspace escaped its worktree");
  if (!["creating", "active", "sealed", "removing", "removed", "restoring"].includes(state.status))
    failA1("INVALID_VALUE", "invalid workspace state");
  if (state.repository_root !== git(roots.project, ["rev-parse", "--show-toplevel"]).trim())
    failA1("IDENTITY_MISMATCH", "workspace repository changed");
  for (const scope of state.write_scope) assertRelativePath(scope, "write_scope");
  return state;
}

export function createModuleWorkspace(input: ModuleWorkspaceInput): ModuleWorkspace {
  const roots = expectedRoots(input.project_root, input.module_run_id);
  if (!/^[0-9a-f]{40,64}$/.test(input.baseline_commit))
    failA1("INVALID_BASELINE", "workspace baseline must be a full commit hash");
  if (!Array.isArray(input.write_scope) || input.write_scope.length === 0)
    failA1("WRITE_SCOPE_REQUIRED", "workspace needs explicit writable paths");
  const scopes = [
    ...new Set(input.write_scope.map((scope) => assertRelativePath(scope, "write_scope"))),
  ].sort();
  if (
    scopes.some(
      (scope) =>
        scope === "." ||
        scope === "env.json" ||
        scope === ".aris" ||
        scope.startsWith(".aris/") ||
        scope === ".git" ||
        scope.startsWith(".git/"),
    )
  )
    failA1(
      "WRITE_SCOPE_FORBIDDEN",
      "workspace scope must exclude control state and environment config",
    );
  const filePath = recordPath(roots.project, input.module_run_id);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readModuleWorkspace(roots.project, input.module_run_id);
      if (
        existing.baseline_commit !== input.baseline_commit ||
        JSON.stringify(existing.write_scope) !== JSON.stringify(scopes)
      )
        failA1("IMMUTABLE_CONFLICT", "workspace semantics changed during retry");
      if (existing.status === "removed")
        failA1("WORKSPACE_REMOVED", "removed workspaces cannot be recreated as a new proposal");
      if (existing.status === "creating") return finishWorkspaceCreation(existing);
      return existing;
    }
    const repository = git(roots.project, ["rev-parse", "--show-toplevel"]).trim();
    const prefix = path.relative(repository, roots.project);
    const commit = git(repository, [
      "rev-parse",
      "--verify",
      `${input.baseline_commit}^{commit}`,
    ]).trim();
    const trackedState = git(repository, [
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      "--",
      path.join(prefix, ".aris"),
      path.join(prefix, "env.json"),
    ]).trim();
    if (trackedState)
      failA1("WORKSPACE_STATE_TRACKED", "baseline contains persistent state or env.json");
    if (fs.existsSync(roots.worktree))
      failA1("WORKSPACE_EXISTS", "unregistered workspace path already exists");
    fs.mkdirSync(path.dirname(roots.worktree), { recursive: true });
    const state: ModuleWorkspace = {
      schema_version: 1,
      module_run_id: input.module_run_id,
      project_root: roots.project,
      repository_root: repository,
      project_prefix: prefix,
      worktree_root: roots.worktree,
      workspace_root: path.join(roots.worktree, prefix),
      baseline_commit: commit,
      write_scope: scopes,
      patch_sha256: null,
      status: "creating",
    };
    writeStateJsonAtomic(filePath, state);
    return finishWorkspaceCreation(state);
  });
}

function finishWorkspaceCreation(state: ModuleWorkspace): ModuleWorkspace {
  if (!fs.existsSync(state.worktree_root))
    git(state.repository_root, [
      "worktree",
      "add",
      "--detach",
      state.worktree_root,
      state.baseline_commit,
    ]);
  const worktrees = git(state.repository_root, ["worktree", "list", "--porcelain"]);
  if (
    !worktrees.split("\n").includes(`worktree ${state.worktree_root}`) ||
    git(state.worktree_root, ["rev-parse", "HEAD"]).trim() !== state.baseline_commit
  )
    failA1(
      "WORKSPACE_BASELINE_MISMATCH",
      "workspace creation did not preserve the frozen baseline",
    );
  const active: ModuleWorkspace = { ...state, status: "active" };
  writeStateJsonAtomic(recordPath(state.project_root, state.module_run_id), active);
  return active;
}

export function inspectModuleWorkspace(projectRoot: string, runId: string): string[] {
  const state = readModuleWorkspace(projectRoot, runId);
  if (state.status === "removed") failA1("WORKSPACE_REMOVED", "workspace has already been removed");
  if (fs.realpathSync(state.worktree_root) !== state.worktree_root)
    failA1("WRITE_SCOPE_FORBIDDEN", "workspace path was replaced with a symlink");
  for (const name of [".aris", "env.json"]) {
    if (fs.existsSync(path.join(state.workspace_root, name)))
      failA1(
        "WORKSPACE_STATE_FORBIDDEN",
        "persistent state must remain in the project run directory",
      );
  }
  const changes = [
    git(state.worktree_root, ["diff", "--name-only", "-z", state.baseline_commit, "--"]),
    git(state.worktree_root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(state.worktree_root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]),
  ].flatMap((text) => text.split("\0").filter(Boolean));
  const relativeChanges = [...new Set(changes)].map((file) =>
    path.relative(state.project_prefix || ".", file).replaceAll(path.sep, "/"),
  );
  for (const file of relativeChanges) {
    assertRelativePath(file.replace(/\/$/, ""), "changed_path");
    const allowed = state.write_scope.some(
      (scope) => file === scope || file.startsWith(`${scope}/`),
    );
    if (!allowed) failA1("WRITE_SCOPE_FORBIDDEN", `changed path is outside module scope: ${file}`);
  }
  return relativeChanges.sort();
}

export function sealModuleWorkspace(projectRoot: string, runId: string): ModuleWorkspace {
  const filePath = recordPath(projectRoot, runId);
  return withStateFileLock(filePath, () => {
    const state = readModuleWorkspace(projectRoot, runId);
    inspectModuleWorkspace(projectRoot, runId);
    git(state.workspace_root, ["add", "--all", "--", ...state.write_scope]);
    const patch = git(state.worktree_root, [
      "diff",
      "--cached",
      "--binary",
      state.baseline_commit,
      "--",
    ]);
    const hash = digest(patch);
    if (state.patch_sha256 !== null && state.patch_sha256 !== hash)
      failA1("IMMUTABLE_CONFLICT", "sealed workspace changed");
    writeStateFileAtomic(patchPath(state), patch);
    const sealed: ModuleWorkspace = { ...state, patch_sha256: hash, status: "sealed" };
    writeStateJsonAtomic(filePath, sealed);
    return sealed;
  });
}

export function removeModuleWorkspace(
  projectRoot: string,
  runId: string,
  evidence: WorkspaceEvidence[],
): ModuleWorkspace {
  const filePath = recordPath(projectRoot, runId);
  return withStateFileLock(filePath, () => {
    const state = readModuleWorkspace(projectRoot, runId);
    if (state.status === "removed") return state;
    if (state.status === "removing" && !fs.existsSync(state.worktree_root)) {
      const removed: ModuleWorkspace = { ...state, status: "removed" };
      writeStateJsonAtomic(filePath, removed);
      return removed;
    }
    if (
      (state.status !== "sealed" && state.status !== "removing") ||
      state.patch_sha256 === null ||
      digest(fs.readFileSync(patchPath(state))) !== state.patch_sha256
    )
      failA1("WORKSPACE_NOT_SEALED", "seal and preserve the workspace patch before cleanup");
    // The run published a result package, so its own review already accepted
    // the result - saveResultPackage refuses to write one without a reviewer.
    // What cleanup has to establish is that the package and everything it names
    // are on disk unchanged before the worktree that produced them is deleted.
    const result = readResultPackage(projectRoot, runId);
    if (result.status !== "succeeded")
      failA1("WORKSPACE_EVIDENCE_REQUIRED", "only a succeeded run's workspace can be cleaned up");
    const packagePath = resultPackagePath(projectRoot, runId);
    const packageSha256 = digest(fs.readFileSync(packagePath));
    const packageRef = path.relative(path.dirname(filePath), packagePath);
    if (
      !evidence.some((item) => item.relative_path === packageRef && item.sha256 === packageSha256)
    )
      failA1("WORKSPACE_EVIDENCE_REQUIRED", "cleanup must verify the published result package");
    if (result.output_paths.length === 0)
      failA1("WORKSPACE_EVIDENCE_REQUIRED", "cleanup needs the sealed outputs the package names");
    const outerRunId = requireRunContract(projectRoot, runId).parent_run_id;
    if (outerRunId === null)
      failA1("WORKSPACE_EVIDENCE_REQUIRED", "a module workspace belongs to a parent run");
    const outer = readWorkflowRuntimeState(projectRoot, outerRunId);
    const registered = outer.children.find(
      (child) => child.child_run_id === runId && child.kind === "module",
    );
    // Which cycle the child belongs to is the parent's record, not the child's,
    // so there is nothing here to cross-check it against; what cleanup checks is
    // that the parent has seen this exact package.
    if (
      !registered ||
      registered.status !== "completed" ||
      registered.state_sha256 !== packageSha256
    )
      failA1(
        "WORKSPACE_EVIDENCE_REQUIRED",
        "outer run must register the completed module before cleanup",
      );
    const runRoot = path.dirname(filePath);
    // Cleanup deletes the worktree, so whatever justified the result has to
    // survive outside it. Every file the result package names is that
    // justification: each one must be listed in the evidence, and each must
    // still hash to what the package recorded.
    const unpreserved = new Set(result.output_paths);
    for (const item of evidence) {
      const relative = assertRelativePath(item.relative_path, "evidence.relative_path");
      const absolute = fs.realpathSync(path.join(runRoot, relative));
      if (!absolute.startsWith(`${fs.realpathSync(runRoot)}/`))
        failA1("WRITE_SCOPE_FORBIDDEN", "cleanup evidence must belong to the module run");
      const itemHash = digest(fs.readFileSync(absolute));
      if (itemHash !== assertSha256(item.sha256, "evidence.sha256"))
        failA1("EVIDENCE_HASH_MISMATCH", "cleanup evidence changed");
      const recordedHash = result.output_hashes[relative];
      if (recordedHash === undefined) continue;
      if (itemHash !== recordedHash)
        failA1("EVIDENCE_HASH_MISMATCH", "a sealed run output changed after it was published");
      unpreserved.delete(relative);
    }
    if (unpreserved.size > 0)
      failA1(
        "WORKSPACE_EVIDENCE_REQUIRED",
        `cleanup must preserve every sealed run output; missing ${[...unpreserved].sort().join(", ")}`,
      );
    inspectModuleWorkspace(projectRoot, runId);
    git(state.workspace_root, ["add", "--all", "--", ...state.write_scope]);
    const currentPatch = git(state.worktree_root, [
      "diff",
      "--cached",
      "--binary",
      state.baseline_commit,
      "--",
    ]);
    if (digest(currentPatch) !== state.patch_sha256)
      failA1("IMMUTABLE_CONFLICT", "workspace changed after sealing; cleanup refused");
    writeStateJsonAtomic(filePath, { ...state, status: "removing" });
    git(state.repository_root, ["worktree", "remove", "--force", state.worktree_root]);
    const removed: ModuleWorkspace = { ...state, status: "removed" };
    writeStateJsonAtomic(filePath, removed);
    return removed;
  });
}

// Reconstruct the exact sealed candidate, retaining its original proposal identity.
export function restoreModuleWorkspace(projectRoot: string, runId: string): ModuleWorkspace {
  const filePath = recordPath(projectRoot, runId);
  return withStateFileLock(filePath, () => {
    const state = readModuleWorkspace(projectRoot, runId);
    if (state.status !== "removed" && state.status !== "restoring" && state.status !== "sealed")
      failA1("WORKSPACE_NOT_SEALED", "only a sealed candidate can be restored");
    const patch = fs.readFileSync(patchPath(state));
    if (state.patch_sha256 === null || digest(patch) !== state.patch_sha256)
      failA1("EVIDENCE_HASH_MISMATCH", "sealed patch changed before restoration");
    if (state.status === "removed" && fs.existsSync(state.worktree_root))
      failA1("WORKSPACE_EXISTS", "removed workspace path is occupied");
    const restoring: ModuleWorkspace = { ...state, status: "restoring" };
    writeStateJsonAtomic(filePath, restoring);
    if (!fs.existsSync(state.worktree_root))
      git(state.repository_root, [
        "worktree",
        "add",
        "--detach",
        state.worktree_root,
        state.baseline_commit,
      ]);
    if (
      !git(state.repository_root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .includes(`worktree ${state.worktree_root}`) ||
      git(state.worktree_root, ["rev-parse", "HEAD"]).trim() !== state.baseline_commit
    )
      failA1("WORKSPACE_BASELINE_MISMATCH", "restored workspace has a different baseline");
    inspectModuleWorkspace(projectRoot, runId);
    git(state.workspace_root, ["add", "--all", "--", ...state.write_scope]);
    const current = git(state.worktree_root, [
      "diff",
      "--cached",
      "--binary",
      state.baseline_commit,
      "--",
    ]);
    if (digest(current) !== state.patch_sha256) {
      if (current !== "")
        failA1("IMMUTABLE_CONFLICT", "restoring workspace contains a different candidate");
      if (patch.length > 0) git(state.worktree_root, ["apply", "--index", "--", patchPath(state)]);
      const restored = git(state.worktree_root, [
        "diff",
        "--cached",
        "--binary",
        state.baseline_commit,
        "--",
      ]);
      if (digest(restored) !== state.patch_sha256)
        failA1("EVIDENCE_HASH_MISMATCH", "restored patch differs from the sealed candidate");
    }
    const sealed: ModuleWorkspace = { ...state, status: "sealed" };
    writeStateJsonAtomic(filePath, sealed);
    return sealed;
  });
}
