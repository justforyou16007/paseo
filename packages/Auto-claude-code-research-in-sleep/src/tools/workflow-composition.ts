import { runOwnedPath } from "./run-contract.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { anyJsonSchema, canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertParallelModuleSet,
  candidateIdFromSnapshot,
  validateCandidateSnapshot,
  type CandidateSnapshot,
} from "./workflow-compiler.js";
import { readResultPackage, resultPackagePath, type ResultPackage } from "./result-package.js";
import { readModuleWorkspace, type ModuleWorkspace } from "./workflow-workspace.js";
import {
  readFrozenPolicy,
  readWorkflowRuntimeState,
  type WorkflowRuntimeState,
} from "./workflow-state.js";
import { hashOuterEvidence } from "./workflow-runtime.js";
import {
  readStateFile,
  withStateFileLock,
  writeStateFileAtomic,
  writeStateJsonAtomic,
} from "./state-file.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertRelativePath,
  assertSha256,
  assertLimitsUnchanged,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireInteger,
  requireString,
  validateWorkflowSpec,
  type WorkflowSpec,
} from "./workflow-spec.js";

const COMPOSITION_SCHEMA_VERSION = 1 as const;
const COMPOSITION_INTENT_SCHEMA = "workflow-composition-intent-v1";
const COMPOSITION_RESULT_SCHEMA = "workflow-composition-result-v1";
const COMPOSITION_STATE_FILE = "state.json";
const COMPOSITION_INTENT_FILE = "intent.json";
const COMPOSITION_RESULT_FILE = "result.json";
const COMBINED_PATCH_FILE = "combined.patch";

export interface CompositionModuleInput {
  module_id: string;
  module_run_id: string;
  proposal_ref: string;
  proposal_sha256: string;
  patch_sha256: string;
  write_scope: string[];
}

export interface WorkflowCompositionInput {
  schema_version: 1;
  project_root: string;
  outer_run_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  composition_id: string;
  baseline_commit: string;
  module_ids: string[];
  workflow_spec: unknown;
  candidate: unknown;
  modules: CompositionModuleInput[];
  evidence_paths: string[];
  evidence_sha256: string;
}

export interface WorkflowCompositionIntent {
  schema_version: 1;
  project_root: string;
  outer_run_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  composition_id: string;
  baseline_commit: string;
  module_ids: string[];
  workflow_spec: WorkflowSpec;
  candidate: CandidateSnapshot;
  candidate_id: string;
  modules: CompositionModuleInput[];
  evidence_refs: string[];
  evidence_sha256: string;
}

export interface CompositionPatchResult {
  module_id: string;
  module_run_id: string;
  patch_ref: string;
  patch_sha256: string;
  changed_paths: string[];
}

export interface WorkflowCompositionResult {
  schema_version: 1;
  status: "ready" | "failed";
  composition_id: string;
  outer_run_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  intent_sha256: string;
  candidate_id: string;
  baseline_commit: string;
  repository_root: string;
  project_prefix: string;
  worktree_root: string | null;
  workspace_root: string | null;
  module_ids: string[];
  source_patches: CompositionPatchResult[];
  changed_paths: string[];
  combined_patch_ref: string | null;
  combined_patch_sha256: string | null;
  tree_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  result_sha256: string;
}

export type WorkflowCompositionStatus = "applying" | "ready" | "failed";

export interface WorkflowCompositionState {
  schema_version: 1;
  composition_id: string;
  outer_run_id: string;
  status: WorkflowCompositionStatus;
  control_root: string;
  worktree_root: string;
  intent_ref: string;
  intent_sha256: string;
  result_ref: string | null;
  result_sha256: string | null;
  updated_at: string;
}

interface StoredIntent extends WorkflowCompositionIntent {
  intent_sha256: string;
}

interface PreparedModule {
  input: CompositionModuleInput;
  result: ResultPackage;
  workspace: ModuleWorkspace;
  proposal_path: string;
  /** Every file the child's result package published, resolved inside its run. */
  output_paths: string[];
  patch_path: string;
  patch_bytes: Buffer;
  changed_paths: string[];
}

interface PreparedComposition {
  input: WorkflowCompositionInput;
  root: string;
  repository_root: string;
  project_prefix: string;
  baseline_commit: string;
  runtime: WorkflowRuntimeState;
  spec: WorkflowSpec;
  candidate: CandidateSnapshot;
  candidate_id: string;
  modules: PreparedModule[];
  intent: WorkflowCompositionIntent;
  intent_sha256: string;
  control_root: string;
  worktree_root: string;
  workspace_root: string;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function gitBytes(cwd: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", cwd, ...args], {
    maxBuffer: 128 * 1024 * 1024,
  }) as Buffer;
}

function normalizedProjectRoot(value: unknown): string {
  const text = requireString(value, "project_root");
  if (
    !path.isAbsolute(text) ||
    path.normalize(text) !== text ||
    text === path.parse(text).root ||
    !fs.existsSync(text)
  )
    failA1("INVALID_PATH", "project_root must be an existing normalized absolute directory");
  const real = fs.realpathSync(text);
  if (!fs.statSync(real).isDirectory()) failA1("INVALID_PATH", "project_root must be a directory");
  return real;
}

function normalizedCommit(value: unknown): string {
  const commit = requireString(value, "baseline_commit");
  if (!/^[0-9a-f]{40,64}$/.test(commit))
    failA1("INVALID_BASELINE", "baseline_commit must be a full commit hash");
  return commit;
}

function normalizedPathList(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("WRITE_SCOPE_REQUIRED", `${location} must be a non-empty array`, location);
  const paths = value.map((item, index) => assertRelativePath(item, `${location}[${index}]`));
  if (new Set(paths).size !== paths.length)
    failA1("DUPLICATE_ID", `${location} must not contain duplicate paths`, location);
  return paths.sort(compareIdentityStrings);
}

function normalizedModuleInput(value: unknown, index: number): CompositionModuleInput {
  const location = `modules[${index}]`;
  if (!isRecord(value)) failA1("INVALID_VALUE", "composition module must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "module_id",
      "module_run_id",
      "proposal_ref",
      "proposal_sha256",
      "patch_sha256",
      "write_scope",
    ],
    location,
  );
  return {
    module_id: assertIdentifier(value.module_id, `${location}.module_id`),
    module_run_id: assertIdentifier(value.module_run_id, `${location}.module_run_id`),
    proposal_ref: assertRelativePath(value.proposal_ref, `${location}.proposal_ref`),
    proposal_sha256: assertSha256(value.proposal_sha256, `${location}.proposal_sha256`),
    patch_sha256: assertSha256(value.patch_sha256, `${location}.patch_sha256`),
    write_scope: normalizedPathList(value.write_scope, `${location}.write_scope`),
  };
}

function assertInside(root: string, target: string, code: string, message: string): string {
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    failA1(code, message, target);
  if (fs.existsSync(absolute)) {
    const real = fs.realpathSync(absolute);
    const realRelative = path.relative(fs.realpathSync(root), real);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative))
      failA1(code, message, target);
  }
  return absolute;
}

function projectRef(projectRoot: string, filePath: string): string {
  const realRoot = fs.realpathSync(projectRoot);
  const realFile = fs.realpathSync(filePath);
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    failA1("PATH_ESCAPE", "composition evidence must stay below project_root", filePath);
  return assertRelativePath(relative.split(path.sep).join("/"), "evidence_ref");
}

function scopeRoot(scope: string): string {
  const root = scope.replace(/(?:\/\*\*)|(?:\/\*)|\*+$/g, "");
  return root.replace(/\/$/g, "");
}

function pathMatchesScope(filePath: string, scope: string): boolean {
  const root = scopeRoot(scope);
  return root.length > 0 && (filePath === root || filePath.startsWith(`${root}/`));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(compareIdentityStrings);
  const b = [...right].sort(compareIdentityStrings);
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function repositoryAndPrefix(projectRoot: string): { repository: string; prefix: string } {
  const repository = fs.realpathSync(gitText(projectRoot, ["rev-parse", "--show-toplevel"]).trim());
  const relative = path.relative(repository, projectRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    failA1("PATH_ESCAPE", "project_root is not inside its git repository");
  return { repository, prefix: relative.split(path.sep).join("/") };
}

function resolveProjectPath(
  projectRoot: string,
  projectPrefix: string,
  repositoryPath: string,
): string {
  const normalized = repositoryPath.replaceAll("\\", "/");
  if (projectPrefix === "") return assertRelativePath(normalized, "changed_path");
  if (normalized !== projectPrefix && !normalized.startsWith(`${projectPrefix}/`))
    failA1("WRITE_SCOPE_FORBIDDEN", "patch changes a file outside project_root", normalized);
  const relative = normalized.slice(projectPrefix.length).replace(/^\//, "");
  return assertRelativePath(relative, "changed_path");
}

function patchPathsFromFile(repositoryRoot: string, patchPath: string): string[] {
  const output = gitBytes(repositoryRoot, [
    "apply",
    "--numstat",
    "-z",
    "--binary",
    "--",
    patchPath,
  ]);
  const records = output
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0);
  return records.map((record) => {
    const separator = record.lastIndexOf("\t");
    if (separator < 0 || separator === record.length - 1)
      failA1("COMPOSITION_PATCH_INVALID", "git could not identify a path in the sealed patch");
    const value = record
      .slice(separator + 1)
      .replace(/^a\//, "")
      .replace(/^b\//, "");
    return assertRelativePath(value, "patch_path");
  });
}

function changedRepositoryPaths(worktreeRoot: string, baselineCommit: string): string[] {
  return gitText(worktreeRoot, ["diff", "--cached", "--name-only", "-z", baselineCommit, "--"])
    .split("\0")
    .filter(Boolean)
    .map((value) => assertRelativePath(value.replaceAll("\\", "/"), "changed_path"))
    .sort(compareIdentityStrings);
}

function worktreeIsRegistered(repositoryRoot: string, worktreeRoot: string): boolean {
  const lines = gitText(repositoryRoot, ["worktree", "list", "--porcelain"]).split("\n");
  return lines.some((line) => line === `worktree ${worktreeRoot}`);
}

function removeOwnedWorktree(prepared: PreparedComposition): void {
  if (!fs.existsSync(prepared.worktree_root)) return;
  const stat = fs.lstatSync(prepared.worktree_root);
  if (stat.isSymbolicLink())
    failA1("COMPOSITION_WORKTREE_CONFLICT", "composition worktree path is a symlink");
  if (worktreeIsRegistered(prepared.repository_root, prepared.worktree_root)) {
    gitText(prepared.repository_root, ["worktree", "remove", "--force", prepared.worktree_root]);
    return;
  }
  if (fs.readdirSync(prepared.worktree_root).length !== 0)
    failA1(
      "COMPOSITION_RECOVERY_REQUIRED",
      "an unregistered non-empty directory occupies the composition worktree path",
    );
  fs.rmdirSync(prepared.worktree_root);
}

function assertCompositionInputShape(value: unknown): asserts value is WorkflowCompositionInput {
  if (!isRecord(value)) failA1("INVALID_VALUE", "composition input must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "project_root",
      "outer_run_id",
      "outer_iteration",
      "generation",
      "wave_id",
      "composition_id",
      "baseline_commit",
      "module_ids",
      "workflow_spec",
      "candidate",
      "modules",
      "evidence_paths",
      "evidence_sha256",
    ],
    "composition",
  );
}

/**
 * The files a child published with its result, resolved inside the child's run
 * and re-hashed. A parent never re-reviews a child: a result package cannot be
 * written without a reviewer receipt, so what the parent checks is that the
 * files that review accepted are still byte-for-byte what the package recorded.
 * They are then required to be part of the outer evidence bundle, so composing
 * a child's proposal always carries the work it rests on.
 */
function publishedOutputsForModule(projectRoot: string, result: ResultPackage): string[] {
  if (result.output_paths.length === 0)
    failA1("COMPOSITION_REVIEW_REQUIRED", "a module proposal needs published run outputs");
  const runRoot = runOwnedPath(projectRoot, result.run_id);
  return result.output_paths.map((outputPath) => {
    const absolute = assertInside(
      runRoot,
      path.join(runRoot, outputPath),
      "PATH_ESCAPE",
      "module run output escaped its run",
    );
    if (!fs.existsSync(absolute))
      failA1("COMPOSITION_REVIEW_REQUIRED", `published run output is missing at ${outputPath}`);
    if (digest(fs.readFileSync(absolute)) !== result.output_hashes[outputPath])
      failA1("EVIDENCE_HASH_MISMATCH", "a published run output changed after it was sealed");
    return fs.realpathSync(absolute);
  });
}

/**
 * The proposal only has to agree about what the child itself knows: which run
 * wrote it, which module it is for, and that it is the proposal rather than
 * some other output. Which outer iteration, generation or wave the work belongs
 * to is the parent's bookkeeping, checked against the parent's own child
 * record; a child that had to restate it could only ever be copying the parent.
 */
function validateProposalIdentity(
  proposalPath: string,
  moduleRunId: string,
  moduleId: string,
  baselineCommit: string,
  patchSha256: string,
  writeScope: readonly string[],
): void {
  const value = readStateFile(proposalPath);
  if (!isRecord(value))
    failA1("COMPOSITION_PROPOSAL_INVALID", "module proposal must be a JSON object");
  const expected: Readonly<Record<string, string | number>> = {
    module_run_id: moduleRunId,
    module_id: moduleId,
    phase: "proposal",
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue)
      failA1("COMPOSITION_PROPOSAL_INVALID", `proposal ${field} does not match its run`);
  }
  if (value.baseline_commit !== undefined && value.baseline_commit !== baselineCommit)
    failA1(
      "COMPOSITION_BASELINE_MISMATCH",
      "proposal baseline differs from the composition baseline",
    );
  if (value.patch_sha256 !== undefined && value.patch_sha256 !== patchSha256)
    failA1(
      "COMPOSITION_PATCH_MISMATCH",
      "proposal patch hash differs from the sealed workspace patch",
    );
  if (
    value.write_scope !== undefined &&
    !samePaths(normalizedPathList(value.write_scope, "proposal.write_scope"), writeScope)
  )
    failA1("WRITE_SCOPE_CONFLICT", "proposal write_scope differs from the sealed workspace scope");
}

function resultBase(
  result: WorkflowCompositionResult,
): Omit<WorkflowCompositionResult, "result_sha256"> {
  const { result_sha256: _ignored, ...base } = result;
  return base;
}

function resultHash(result: WorkflowCompositionResult): string {
  return canonicalJsonSha256(resultBase(result), anyJsonSchema, {
    schemaVersion: COMPOSITION_RESULT_SCHEMA,
  });
}

function intentHash(intent: WorkflowCompositionIntent): string {
  return canonicalJsonSha256(intent, anyJsonSchema, {
    schemaVersion: COMPOSITION_INTENT_SCHEMA,
  });
}

function writeImmutableJson(filePath: string, value: unknown, schemaVersion: string): void {
  if (fs.existsSync(filePath)) {
    const existing = readStateFile(filePath);
    if (
      canonicalJsonSha256(existing, anyJsonSchema, { schemaVersion }) !==
      canonicalJsonSha256(value, anyJsonSchema, { schemaVersion })
    )
      failA1("IMMUTABLE_CONFLICT", `immutable composition file cannot change: ${filePath}`);
    return;
  }
  writeStateJsonAtomic(filePath, value);
}

function writeImmutableBytes(filePath: string, bytes: Buffer): void {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (digest(existing) !== digest(bytes))
      failA1("IMMUTABLE_CONFLICT", `immutable composition file cannot change: ${filePath}`);
    return;
  }
  writeStateFileAtomic(filePath, bytes.toString("utf8"));
}

function validateState(value: unknown, filePath: string, root: string): WorkflowCompositionState {
  if (!isRecord(value))
    failA1("CORRUPT_COMPOSITION", "composition state must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "composition_id",
      "outer_run_id",
      "status",
      "control_root",
      "worktree_root",
      "intent_ref",
      "intent_sha256",
      "result_ref",
      "result_sha256",
      "updated_at",
    ],
    filePath,
  );
  const compositionId = assertIdentifier(value.composition_id, `${filePath}.composition_id`);
  const outerRunId = assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`);
  if (value.schema_version !== 1 || value.intent_ref !== COMPOSITION_INTENT_FILE)
    failA1(
      "CORRUPT_COMPOSITION",
      "composition state schema or intent reference is invalid",
      filePath,
    );
  if (value.status !== "applying" && value.status !== "ready" && value.status !== "failed")
    failA1("CORRUPT_COMPOSITION", "composition state status is invalid", filePath);
  const controlRoot = requireString(value.control_root, `${filePath}.control_root`);
  const expectedControlRoot = compositionControlRoot(root, outerRunId, compositionId);
  if (path.resolve(controlRoot) !== expectedControlRoot)
    failA1(
      "IDENTITY_MISMATCH",
      "composition state control root is not derived from its identity",
      filePath,
    );
  const worktreeRoot = requireString(value.worktree_root, `${filePath}.worktree_root`);
  if (path.resolve(worktreeRoot) !== path.join(expectedControlRoot, "worktree"))
    failA1(
      "IDENTITY_MISMATCH",
      "composition state worktree is not derived from its identity",
      filePath,
    );
  const resultRef =
    value.result_ref === null
      ? null
      : assertRelativePath(value.result_ref, `${filePath}.result_ref`);
  const resultSha =
    value.result_sha256 === null
      ? null
      : assertSha256(value.result_sha256, `${filePath}.result_sha256`);
  if (value.status !== "applying" && (resultRef !== COMPOSITION_RESULT_FILE || resultSha === null))
    failA1("CORRUPT_COMPOSITION", "terminal composition state has no immutable result", filePath);
  return {
    schema_version: 1,
    composition_id: compositionId,
    outer_run_id: outerRunId,
    status: value.status,
    control_root: controlRoot,
    worktree_root: worktreeRoot,
    intent_ref: COMPOSITION_INTENT_FILE,
    intent_sha256: assertSha256(value.intent_sha256, `${filePath}.intent_sha256`),
    result_ref: resultRef,
    result_sha256: resultSha,
    updated_at: requireString(value.updated_at, `${filePath}.updated_at`),
  };
}

function compositionControlRoot(
  projectRoot: string,
  outerRunId: string,
  compositionId: string,
): string {
  return runOwnedPath(
    projectRoot,
    outerRunId,
    "compositions",
    assertIdentifier(compositionId, "composition_id"),
  );
}

export function workflowCompositionPath(
  projectRoot: string,
  outerRunId: string,
  compositionId: string,
): string {
  return path.join(
    compositionControlRoot(projectRoot, outerRunId, compositionId),
    COMPOSITION_STATE_FILE,
  );
}

function readWorkflowCompositionAt(
  projectRoot: string,
  outerRunId: string,
  compositionId: string,
): WorkflowCompositionState {
  const root = normalizedProjectRoot(projectRoot);
  const filePath = workflowCompositionPath(root, outerRunId, compositionId);
  if (!fs.existsSync(filePath))
    failA1("COMPOSITION_NOT_FOUND", `no composition state at ${filePath}`);
  return validateState(readStateFile(filePath), filePath, root);
}

export function readWorkflowComposition(
  projectRoot: string,
  outerRunId: string,
  compositionId: string,
): WorkflowCompositionState;
/** Convenience form for the CLI. It is safe only when the id is unique below this project. */
export function readWorkflowComposition(
  projectRoot: string,
  compositionId: string,
): WorkflowCompositionState;
export function readWorkflowComposition(
  projectRoot: string,
  outerRunIdOrCompositionId: string,
  compositionId?: string,
): WorkflowCompositionState {
  if (compositionId !== undefined)
    return readWorkflowCompositionAt(projectRoot, outerRunIdOrCompositionId, compositionId);
  const root = normalizedProjectRoot(projectRoot);
  const safeCompositionId = assertIdentifier(outerRunIdOrCompositionId, "composition_id");
  const runsRoot = path.join(root, ".aris", "runs");
  const matches: string[] = [];
  if (fs.existsSync(runsRoot)) {
    for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(
        runsRoot,
        entry.name,
        "compositions",
        safeCompositionId,
        COMPOSITION_STATE_FILE,
      );
      // Only matching state belongs to this lookup; unrelated run directories need no gate.
      if (fs.existsSync(candidate))
        matches.push(workflowCompositionPath(root, entry.name, safeCompositionId));
    }
  }
  if (matches.length !== 1)
    failA1(
      matches.length === 0 ? "COMPOSITION_NOT_FOUND" : "AMBIGUOUS_COMPOSITION",
      matches.length === 0
        ? `no composition named '${safeCompositionId}'`
        : `composition id '${safeCompositionId}' is used by more than one outer run`,
    );
  return validateState(readStateFile(matches[0]!), matches[0]!, root);
}

function storedIntent(filePath: string): StoredIntent {
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_COMPOSITION", "composition intent must be an object", filePath);
  const supplied = assertSha256(value.intent_sha256, `${filePath}.intent_sha256`);
  const { intent_sha256: _ignored, ...base } = value;
  if (
    canonicalJsonSha256(base, anyJsonSchema, { schemaVersion: COMPOSITION_INTENT_SCHEMA }) !==
    supplied
  )
    failA1("CORRUPT_COMPOSITION", "composition intent hash does not match its content", filePath);
  return value as unknown as StoredIntent;
}

function storedResult(filePath: string): WorkflowCompositionResult {
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_COMPOSITION", "composition result must be an object", filePath);
  const supplied = assertSha256(value.result_sha256, `${filePath}.result_sha256`);
  const { result_sha256: _ignored, ...base } = value;
  if (
    canonicalJsonSha256(base, anyJsonSchema, { schemaVersion: COMPOSITION_RESULT_SCHEMA }) !==
    supplied
  )
    failA1("CORRUPT_COMPOSITION", "composition result hash does not match its content", filePath);
  return value as unknown as WorkflowCompositionResult;
}

function assertOuterAndFrozenIdentity(
  root: string,
  input: WorkflowCompositionInput,
  runtime: WorkflowRuntimeState,
  spec: WorkflowSpec,
): void {
  if (
    runtime.project_root !== root ||
    runtime.outer_run_id !== input.outer_run_id ||
    runtime.task_id !== spec.task_id ||
    runtime.workflow_id !== spec.workflow_id
  )
    failA1("IDENTITY_MISMATCH", "outer runtime and composition do not describe the same workflow");
  if (
    runtime.current_phase !== "wave" ||
    runtime.active_cycle === null ||
    runtime.active_cycle.wave_kind !== "module" ||
    runtime.active_cycle.wave_id !== input.wave_id ||
    runtime.active_cycle.outer_iteration !== input.outer_iteration ||
    runtime.active_cycle.generation !== input.generation
  )
    failA1("IDENTITY_MISMATCH", "composition must belong to the active module wave");
  const frozen = readFrozenPolicy(root, input.outer_run_id);
  if (
    frozen.task_id !== spec.task_id ||
    frozen.workflow_id !== spec.workflow_id ||
    frozen.task_setup_revision !== spec.task_setup_revision ||
    canonicalJsonSha256(frozen.model_usage_policy, anyJsonSchema, {
      schemaVersion: "model-usage-policy-v1",
    }) !==
      canonicalJsonSha256(spec.model_usage_policy, anyJsonSchema, {
        schemaVersion: "model-usage-policy-v1",
      })
  )
    failA1("IDENTITY_MISMATCH", "workflow spec does not match the outer frozen policy");
  if (
    spec.promotion_tester.tester_id !== frozen.tester_id ||
    spec.promotion_tester.definition_version !== frozen.tester_version ||
    spec.promotion_tester.max_exposures_per_task !== frozen.tester_definition.max_exposures_per_task
  )
    failA1("IDENTITY_MISMATCH", "workflow spec tester does not match the outer frozen policy");
  assertLimitsUnchanged(frozen.owner_limits, spec.owner_limits);
}

function prepareComposition(rawInput: unknown): PreparedComposition {
  assertCompositionInputShape(rawInput);
  if (rawInput.schema_version !== 1)
    failA1("INVALID_VALUE", "composition schema_version must be 1", "composition.schema_version");
  const root = normalizedProjectRoot(rawInput.project_root);
  const outerRunId = assertIdentifier(rawInput.outer_run_id, "outer_run_id");
  const compositionId = assertIdentifier(rawInput.composition_id, "composition_id");
  const waveId = assertIdentifier(rawInput.wave_id, "wave_id");
  const outerIteration = requireInteger(rawInput.outer_iteration, "outer_iteration", 1);
  const generation = requireInteger(rawInput.generation, "generation", 1);
  const baselineCommit = normalizedCommit(rawInput.baseline_commit);
  if (!Array.isArray(rawInput.module_ids) || rawInput.module_ids.length === 0)
    failA1("INVALID_WAVE_POLICY", "composition needs at least one module", "module_ids");
  const moduleIds = rawInput.module_ids.map((item, index) =>
    assertIdentifier(item, `module_ids[${index}]`),
  );
  if (new Set(moduleIds).size !== moduleIds.length)
    failA1("DUPLICATE_ID", "composition module ids must be unique", "module_ids");
  moduleIds.sort(compareIdentityStrings);
  if (!Array.isArray(rawInput.modules) || rawInput.modules.length !== moduleIds.length)
    failA1("INVALID_VALUE", "modules must contain exactly one binding per module_id", "modules");
  const modulesInput = rawInput.modules.map(normalizedModuleInput);
  modulesInput.sort((left, right) => compareIdentityStrings(left.module_id, right.module_id));
  if (
    !samePaths(
      moduleIds,
      modulesInput.map((module) => module.module_id),
    )
  )
    failA1("IDENTITY_MISMATCH", "module_ids and module bindings differ", "modules");

  const runtime = readWorkflowRuntimeState(root, outerRunId);
  const spec = validateWorkflowSpec(rawInput.workflow_spec);
  if (spec.mode === "standalone")
    failA1("INVALID_WAVE_POLICY", "standalone workflows cannot use module composition");
  assertOuterAndFrozenIdentity(
    root,
    {
      ...rawInput,
      project_root: root,
      outer_run_id: outerRunId,
      outer_iteration: outerIteration,
      generation,
      wave_id: waveId,
      composition_id: compositionId,
      baseline_commit: baselineCommit,
      module_ids: moduleIds,
      modules: modulesInput,
    },
    runtime,
    spec,
  );
  assertParallelModuleSet(spec, moduleIds);
  const candidate = validateCandidateSnapshot(rawInput.candidate);
  const candidateId = candidateIdFromSnapshot(candidate, root);
  if (candidate.workflow_revision !== spec.revision)
    failA1("IDENTITY_MISMATCH", "candidate workflow revision differs from workflow spec");
  if (candidate.wave_id !== null && candidate.wave_id !== waveId)
    failA1("IDENTITY_MISMATCH", "candidate belongs to a different outer wave");
  assertLimitsUnchanged(spec.owner_limits, candidate.owner_limits);
  const candidateVersions = new Map(
    candidate.module_versions.map((moduleVersion) => [moduleVersion.module_id, moduleVersion]),
  );
  const specModules = new Map(spec.module_catalog.map((module) => [module.id, module]));
  for (const moduleId of moduleIds) {
    if (!candidateVersions.has(moduleId))
      failA1("CANDIDATE_GRAPH_MISMATCH", `candidate has no module version for '${moduleId}'`);
    const specModule = specModules.get(moduleId);
    if (!specModule) failA1("INVALID_ID", `workflow spec has no module '${moduleId}'`);
  }

  const { repository, prefix } = repositoryAndPrefix(root);
  const resolvedBaseline = gitText(repository, [
    "rev-parse",
    "--verify",
    `${baselineCommit}^{commit}`,
  ]).trim();
  if (resolvedBaseline !== baselineCommit)
    failA1("INVALID_BASELINE", "baseline_commit is not the repository's full commit hash");

  const preparedModules: PreparedModule[] = [];
  const allPatchPaths: string[] = [];
  for (const moduleInput of modulesInput) {
    // Two sources, each for what it owns. Which module the child worked on and
    // which cycle it belongs to come from the parent's own child record; how
    // the run ended and what it produced come from the child's result package.
    const outerChild = runtime.children.find(
      (child) => child.child_run_id === moduleInput.module_run_id && child.kind === "module",
    );
    if (
      !outerChild ||
      outerChild.status !== "completed" ||
      outerChild.module_id !== moduleInput.module_id ||
      outerChild.outer_iteration !== outerIteration ||
      outerChild.generation !== generation ||
      outerChild.state_sha256 !==
        digest(fs.readFileSync(resultPackagePath(root, moduleInput.module_run_id)))
    )
      failA1(
        "COMPOSITION_CHILD_NOT_REGISTERED",
        "module must be completed and registered by the outer run",
      );
    const result = readResultPackage(root, moduleInput.module_run_id);
    if (result.status !== "succeeded" || result.parent_run_id !== outerRunId)
      failA1("IDENTITY_MISMATCH", "module result package is not a succeeded result of this run");
    if (result.output_hashes[moduleInput.proposal_ref] !== moduleInput.proposal_sha256)
      failA1("IDENTITY_MISMATCH", "module proposal is not a file the result package published");

    const workspace = readModuleWorkspace(root, moduleInput.module_run_id);
    if (workspace.status !== "sealed" && workspace.status !== "removed")
      failA1("WORKSPACE_NOT_SEALED", "composition accepts only a sealed module workspace");
    if (
      workspace.baseline_commit !== baselineCommit ||
      workspace.write_scope.length !== moduleInput.write_scope.length ||
      !samePaths(workspace.write_scope, moduleInput.write_scope)
    )
      failA1("COMPOSITION_BASELINE_MISMATCH", "module workspace baseline or write_scope differs");
    if (workspace.repository_root !== repository || workspace.project_prefix !== prefix)
      failA1(
        "IDENTITY_MISMATCH",
        "module workspace belongs to a different repository or project prefix",
      );
    if (workspace.patch_sha256 === null || workspace.patch_sha256 !== moduleInput.patch_sha256)
      failA1("COMPOSITION_PATCH_MISMATCH", "module patch hash is not the sealed workspace hash");
    const runRoot = runOwnedPath(root, moduleInput.module_run_id);
    const proposalPath = assertInside(
      runRoot,
      path.join(runRoot, moduleInput.proposal_ref),
      "PATH_ESCAPE",
      "module proposal escaped its run",
    );
    if (digest(fs.readFileSync(proposalPath)) !== moduleInput.proposal_sha256)
      failA1("EVIDENCE_HASH_MISMATCH", "module proposal changed after registration");
    const patchPath = assertInside(
      runRoot,
      path.join(runRoot, "workspace.patch"),
      "PATH_ESCAPE",
      "sealed workspace patch escaped its run",
    );
    const patchBytes = fs.readFileSync(patchPath);
    if (digest(patchBytes) !== moduleInput.patch_sha256)
      failA1("EVIDENCE_HASH_MISMATCH", "sealed workspace patch changed");
    validateProposalIdentity(
      proposalPath,
      moduleInput.module_run_id,
      moduleInput.module_id,
      baselineCommit,
      moduleInput.patch_sha256,
      moduleInput.write_scope,
    );
    const outputPaths = publishedOutputsForModule(root, result);
    const repositoryPatchPaths = patchPathsFromFile(repository, patchPath);
    const changedPaths = repositoryPatchPaths.map((repositoryPath) =>
      resolveProjectPath(root, prefix, repositoryPath),
    );
    if (new Set(changedPaths).size !== changedPaths.length)
      failA1("DUPLICATE_ID", "a sealed patch lists a path more than once");
    for (const changedPath of changedPaths) {
      if (!moduleInput.write_scope.some((scope) => pathMatchesScope(changedPath, scope)))
        failA1(
          "WRITE_SCOPE_FORBIDDEN",
          `sealed patch changes '${changedPath}' outside write_scope`,
        );
    }
    allPatchPaths.push(...changedPaths);
    preparedModules.push({
      input: moduleInput,
      result,
      workspace,
      proposal_path: proposalPath,
      output_paths: outputPaths,
      patch_path: patchPath,
      patch_bytes: patchBytes,
      changed_paths: changedPaths.sort(compareIdentityStrings),
    });
    const candidateVersion = candidateVersions.get(moduleInput.module_id)!;
    if (candidateVersion.patch_sha256 !== moduleInput.patch_sha256)
      failA1(
        "COMPOSITION_PATCH_MISMATCH",
        "sealed module patch is not the patch frozen in candidate",
      );
    if (changedPaths.some((changedPath) => !candidateVersion.code_paths.includes(changedPath)))
      failA1(
        "COMPOSITION_PATCH_MISMATCH",
        "sealed module patch changes a path absent from the frozen candidate module version",
      );
    const specModule = specModules.get(moduleInput.module_id)!;
    if (!samePaths(specModule.write_scope, moduleInput.write_scope))
      failA1("WRITE_SCOPE_CONFLICT", "module proposal write_scope differs from workflow spec");
  }
  if (new Set(allPatchPaths).size !== allPatchPaths.length)
    failA1("WRITE_SCOPE_CONFLICT", "sealed module patches change the same path");
  if (!samePaths(candidate.patch_paths, allPatchPaths))
    failA1(
      "COMPOSITION_PATCH_MISMATCH",
      "candidate.patch_paths differs from the sealed module patches",
    );

  if (!Array.isArray(rawInput.evidence_paths) || rawInput.evidence_paths.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "composition needs an outer evidence bundle");
  const evidence = hashOuterEvidence(root, rawInput.evidence_paths);
  const evidenceSha256 = assertSha256(rawInput.evidence_sha256, "evidence_sha256");
  if (evidence.evidence_sha256 !== evidenceSha256)
    failA1("EVIDENCE_HASH_MISMATCH", "outer evidence hash does not match its files");
  const evidenceRefs = new Set(evidence.evidence_refs);
  for (const module of preparedModules) {
    for (const filePath of [
      resultPackagePath(root, module.input.module_run_id),
      module.proposal_path,
      ...module.output_paths,
      module.patch_path,
    ]) {
      if (!evidenceRefs.has(projectRef(root, filePath)))
        failA1("OUTER_EVIDENCE_REQUIRED", `outer evidence does not include ${filePath}`);
    }
  }

  const normalizedInput: WorkflowCompositionInput = {
    schema_version: 1,
    project_root: root,
    outer_run_id: outerRunId,
    outer_iteration: outerIteration,
    generation,
    wave_id: waveId,
    composition_id: compositionId,
    baseline_commit: baselineCommit,
    module_ids: moduleIds,
    workflow_spec: spec,
    candidate,
    modules: modulesInput,
    evidence_paths: evidence.evidence_refs,
    evidence_sha256: evidenceSha256,
  };
  const intent: WorkflowCompositionIntent = {
    schema_version: 1,
    project_root: root,
    outer_run_id: outerRunId,
    outer_iteration: outerIteration,
    generation,
    wave_id: waveId,
    composition_id: compositionId,
    baseline_commit: baselineCommit,
    module_ids: moduleIds,
    workflow_spec: spec,
    candidate,
    candidate_id: candidateId,
    modules: modulesInput,
    evidence_refs: evidence.evidence_refs,
    evidence_sha256: evidenceSha256,
  };
  const intentSha256 = intentHash(intent);
  return {
    input: normalizedInput,
    root,
    repository_root: repository,
    project_prefix: prefix,
    baseline_commit: baselineCommit,
    runtime,
    spec,
    candidate,
    candidate_id: candidateId,
    modules: preparedModules,
    intent,
    intent_sha256: intentSha256,
    control_root: compositionControlRoot(root, outerRunId, compositionId),
    worktree_root: path.join(compositionControlRoot(root, outerRunId, compositionId), "worktree"),
    workspace_root: path.join(
      compositionControlRoot(root, outerRunId, compositionId),
      "worktree",
      prefix,
    ),
  };
}

function makeState(
  prepared: PreparedComposition,
  status: WorkflowCompositionStatus,
  result: WorkflowCompositionResult | null,
): WorkflowCompositionState {
  return {
    schema_version: 1,
    composition_id: prepared.input.composition_id,
    outer_run_id: prepared.input.outer_run_id,
    status,
    control_root: prepared.control_root,
    worktree_root: prepared.worktree_root,
    intent_ref: COMPOSITION_INTENT_FILE,
    intent_sha256: prepared.intent_sha256,
    result_ref: result === null ? null : COMPOSITION_RESULT_FILE,
    result_sha256: result?.result_sha256 ?? null,
    updated_at: new Date().toISOString(),
  };
}

function makeSourcePatchResults(prepared: PreparedComposition): CompositionPatchResult[] {
  return prepared.modules.map((module) => ({
    module_id: module.input.module_id,
    module_run_id: module.input.module_run_id,
    patch_ref: projectRef(prepared.root, module.patch_path),
    patch_sha256: module.input.patch_sha256,
    changed_paths: [...module.changed_paths].sort(compareIdentityStrings),
  }));
}

function makeFailureResult(
  prepared: PreparedComposition,
  error: unknown,
): WorkflowCompositionResult {
  const errorRecord =
    error instanceof Error && typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string })
      : null;
  const code =
    typeof errorRecord?.code === "string" ? errorRecord.code : "COMPOSITION_PATCH_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const base: Omit<WorkflowCompositionResult, "result_sha256"> = {
    schema_version: 1,
    status: "failed",
    composition_id: prepared.input.composition_id,
    outer_run_id: prepared.input.outer_run_id,
    outer_iteration: prepared.input.outer_iteration,
    generation: prepared.input.generation,
    wave_id: prepared.input.wave_id,
    intent_sha256: prepared.intent_sha256,
    candidate_id: prepared.candidate_id,
    baseline_commit: prepared.baseline_commit,
    repository_root: prepared.repository_root,
    project_prefix: prepared.project_prefix,
    worktree_root: null,
    workspace_root: null,
    module_ids: [...prepared.input.module_ids],
    source_patches: makeSourcePatchResults(prepared),
    changed_paths: [],
    combined_patch_ref: null,
    combined_patch_sha256: null,
    tree_id: null,
    failure_code: code,
    failure_message: message,
  };
  return {
    ...base,
    result_sha256: canonicalJsonSha256(base, anyJsonSchema, {
      schemaVersion: COMPOSITION_RESULT_SCHEMA,
    }),
  };
}

function applyPatches(prepared: PreparedComposition): WorkflowCompositionResult {
  if (fs.existsSync(prepared.worktree_root))
    failA1("COMPOSITION_WORKTREE_OCCUPIED", "composition worktree path is already occupied");
  fs.mkdirSync(prepared.control_root, { recursive: true });
  gitText(prepared.repository_root, [
    "worktree",
    "add",
    "--detach",
    prepared.worktree_root,
    prepared.baseline_commit,
  ]);
  if (
    !worktreeIsRegistered(prepared.repository_root, prepared.worktree_root) ||
    gitText(prepared.worktree_root, ["rev-parse", "HEAD"]).trim() !== prepared.baseline_commit
  )
    failA1(
      "COMPOSITION_BASELINE_MISMATCH",
      "integration worktree was not created at the frozen baseline",
    );

  const appliedPaths = new Set<string>();
  for (const module of prepared.modules) {
    for (const changedPath of module.changed_paths) {
      if (appliedPaths.has(changedPath))
        failA1("WRITE_SCOPE_CONFLICT", `module patches overlap at '${changedPath}'`);
    }
    if (module.patch_bytes.length > 0) {
      gitText(prepared.worktree_root, [
        "apply",
        "--index",
        "--check",
        "--binary",
        "--",
        module.patch_path,
      ]);
      gitText(prepared.worktree_root, ["apply", "--index", "--binary", "--", module.patch_path]);
    }
    const actualRepositoryPaths = changedRepositoryPaths(
      prepared.worktree_root,
      prepared.baseline_commit,
    );
    const actualProjectPaths = actualRepositoryPaths.map((repositoryPath) =>
      resolveProjectPath(prepared.root, prepared.project_prefix, repositoryPath),
    );
    const newPaths = actualProjectPaths.filter((changedPath) => !appliedPaths.has(changedPath));
    if (!samePaths(newPaths, module.changed_paths))
      failA1("COMPOSITION_PATCH_MISMATCH", "git applied paths differ from the sealed patch paths");
    for (const changedPath of module.changed_paths) appliedPaths.add(changedPath);
  }
  const changedPaths = [...appliedPaths].sort(compareIdentityStrings);
  if (!samePaths(changedPaths, prepared.candidate.patch_paths))
    failA1(
      "COMPOSITION_PATCH_MISMATCH",
      "integration worktree paths differ from the frozen candidate",
    );
  const combinedPatch = gitBytes(prepared.worktree_root, [
    "diff",
    "--cached",
    "--binary",
    prepared.baseline_commit,
    "--",
  ]);
  const combinedPatchPath = path.join(prepared.control_root, COMBINED_PATCH_FILE);
  writeImmutableBytes(combinedPatchPath, combinedPatch);
  if (digest(fs.readFileSync(combinedPatchPath)) !== digest(combinedPatch))
    failA1("EVIDENCE_HASH_MISMATCH", "combined composition patch was not durably written");
  const base: Omit<WorkflowCompositionResult, "result_sha256"> = {
    schema_version: 1,
    status: "ready",
    composition_id: prepared.input.composition_id,
    outer_run_id: prepared.input.outer_run_id,
    outer_iteration: prepared.input.outer_iteration,
    generation: prepared.input.generation,
    wave_id: prepared.input.wave_id,
    intent_sha256: prepared.intent_sha256,
    candidate_id: prepared.candidate_id,
    baseline_commit: prepared.baseline_commit,
    repository_root: prepared.repository_root,
    project_prefix: prepared.project_prefix,
    worktree_root: prepared.worktree_root,
    workspace_root: prepared.workspace_root,
    module_ids: [...prepared.input.module_ids],
    source_patches: makeSourcePatchResults(prepared),
    changed_paths: changedPaths,
    combined_patch_ref: COMBINED_PATCH_FILE,
    combined_patch_sha256: digest(combinedPatch),
    tree_id: gitText(prepared.worktree_root, ["write-tree"]).trim(),
    failure_code: null,
    failure_message: null,
  };
  return {
    ...base,
    result_sha256: canonicalJsonSha256(base, anyJsonSchema, {
      schemaVersion: COMPOSITION_RESULT_SCHEMA,
    }),
  };
}

function assertReadyWorktree(
  prepared: PreparedComposition,
  result: WorkflowCompositionResult,
): boolean {
  try {
    if (
      result.status !== "ready" ||
      result.intent_sha256 !== prepared.intent_sha256 ||
      result.worktree_root !== prepared.worktree_root ||
      result.workspace_root !== prepared.workspace_root ||
      result.combined_patch_ref !== COMBINED_PATCH_FILE ||
      result.combined_patch_sha256 === null ||
      result.tree_id === null ||
      !fs.existsSync(prepared.worktree_root) ||
      !worktreeIsRegistered(prepared.repository_root, prepared.worktree_root)
    )
      return false;
    if (gitText(prepared.worktree_root, ["rev-parse", "HEAD"]).trim() !== prepared.baseline_commit)
      return false;
    const combinedPatchPath = path.join(prepared.control_root, COMBINED_PATCH_FILE);
    if (
      !fs.existsSync(combinedPatchPath) ||
      digest(fs.readFileSync(combinedPatchPath)) !== result.combined_patch_sha256
    )
      return false;
    const currentPatch = gitBytes(prepared.worktree_root, [
      "diff",
      "--cached",
      "--binary",
      prepared.baseline_commit,
      "--",
    ]);
    if (digest(currentPatch) !== result.combined_patch_sha256) return false;
    const currentPaths = changedRepositoryPaths(
      prepared.worktree_root,
      prepared.baseline_commit,
    ).map((repositoryPath) =>
      resolveProjectPath(prepared.root, prepared.project_prefix, repositoryPath),
    );
    return (
      samePaths(currentPaths, result.changed_paths) &&
      gitText(prepared.worktree_root, ["write-tree"]).trim() === result.tree_id
    );
  } catch {
    return false;
  }
}

function throwStoredFailure(result: WorkflowCompositionResult): never {
  failA1("COMPOSITION_FAILED", result.failure_message ?? "composition is durably rejected");
}

export function composeWorkflowModules(input: unknown): WorkflowCompositionResult {
  const prepared = prepareComposition(input);
  const statePath = workflowCompositionPath(
    prepared.root,
    prepared.input.outer_run_id,
    prepared.input.composition_id,
  );
  return withStateFileLock(statePath, () => {
    fs.mkdirSync(prepared.control_root, { recursive: true });
    const intentPath = path.join(prepared.control_root, COMPOSITION_INTENT_FILE);
    const existingIntent = fs.existsSync(intentPath) ? storedIntent(intentPath) : null;
    if (existingIntent !== null && existingIntent.intent_sha256 !== prepared.intent_sha256)
      failA1("IMMUTABLE_CONFLICT", "composition_id is already bound to a different intent");
    const stored: StoredIntent = { ...prepared.intent, intent_sha256: prepared.intent_sha256 };
    writeImmutableJson(intentPath, stored, COMPOSITION_INTENT_SCHEMA);

    const existingState = fs.existsSync(statePath)
      ? validateState(readStateFile(statePath), statePath, prepared.root)
      : null;
    if (existingState !== null && existingState.intent_sha256 !== prepared.intent_sha256)
      failA1("IMMUTABLE_CONFLICT", "composition state is bound to a different intent");
    if (existingState?.status === "failed") {
      if (existingState.result_ref === null)
        failA1("CORRUPT_COMPOSITION", "failed composition has no result");
      const failed = storedResult(path.join(prepared.control_root, existingState.result_ref));
      throwStoredFailure(failed);
    }
    if (existingState?.status === "ready") {
      if (existingState.result_ref === null)
        failA1("CORRUPT_COMPOSITION", "ready composition has no result");
      const result = storedResult(path.join(prepared.control_root, existingState.result_ref));
      if (result.result_sha256 !== existingState.result_sha256)
        failA1("CORRUPT_COMPOSITION", "composition state and result hashes differ");
      if (assertReadyWorktree(prepared, result)) return result;
      // A successful composition may have been cleaned after a process crash.
      // Rebuild the same immutable result from the same intent; never create a
      // new module run or change the source worktrees.
      writeStateJsonAtomic(statePath, makeState(prepared, "applying", null));
      try {
        removeOwnedWorktree(prepared);
        const rebuilt = applyPatches(prepared);
        if (resultHash(rebuilt) !== result.result_sha256)
          failA1("IMMUTABLE_CONFLICT", "reconstructed composition differs from its sealed result");
        writeStateJsonAtomic(statePath, makeState(prepared, "ready", result));
        return result;
      } catch (error: unknown) {
        throw error;
      }
    }

    if (existingState === null) {
      writeStateJsonAtomic(statePath, makeState(prepared, "applying", null));
    } else if (existingState.status === "applying") {
      if (existingState.result_ref !== null)
        failA1("CORRUPT_COMPOSITION", "applying composition unexpectedly has a result");
      removeOwnedWorktree(prepared);
    }

    try {
      const result = applyPatches(prepared);
      const resultPath = path.join(prepared.control_root, COMPOSITION_RESULT_FILE);
      writeImmutableJson(resultPath, result, COMPOSITION_RESULT_SCHEMA);
      const durable = storedResult(resultPath);
      writeStateJsonAtomic(statePath, makeState(prepared, "ready", durable));
      return durable;
    } catch (error: unknown) {
      try {
        removeOwnedWorktree(prepared);
      } catch {
        // Leave state as applying. A later retry can only remove the explicit
        // composition path after it is proven to be this composition's path.
        throw error;
      }
      const failure = makeFailureResult(prepared, error);
      const resultPath = path.join(prepared.control_root, COMPOSITION_RESULT_FILE);
      writeImmutableJson(resultPath, failure, COMPOSITION_RESULT_SCHEMA);
      writeStateJsonAtomic(statePath, makeState(prepared, "failed", failure));
      if (error instanceof Error) throw error;
      throw new Error(failure.failure_message ?? "composition failed");
    }
  });
}

export const composeModules = composeWorkflowModules;

function removeWorkflowCompositionAt(
  projectRoot: string,
  outerRunId: string,
  compositionId: string,
): WorkflowCompositionState {
  const root = normalizedProjectRoot(projectRoot);
  const statePath = workflowCompositionPath(root, outerRunId, compositionId);
  if (!fs.existsSync(statePath))
    failA1("COMPOSITION_NOT_FOUND", `no composition state at ${statePath}`);
  const state = validateState(readStateFile(statePath), statePath, root);
  if (state.result_ref === null)
    failA1("COMPOSITION_NOT_READY", "an incomplete composition cannot be removed");
  const intent = storedIntent(path.join(state.control_root, state.intent_ref));
  const result = storedResult(path.join(state.control_root, state.result_ref));
  if (result.status === "ready" && fs.existsSync(state.worktree_root)) {
    const repository = result.repository_root;
    if (worktreeIsRegistered(repository, state.worktree_root))
      gitText(repository, ["worktree", "remove", "--force", state.worktree_root]);
    else if (fs.lstatSync(state.worktree_root).isSymbolicLink())
      failA1("COMPOSITION_WORKTREE_CONFLICT", "composition worktree path is a symlink");
    else
      failA1(
        "COMPOSITION_WORKTREE_CONFLICT",
        "composition worktree path is not registered with its repository",
      );
  }
  if (intent.intent_sha256 !== state.intent_sha256)
    failA1("CORRUPT_COMPOSITION", "composition intent and state hashes differ");
  return state;
}

export function removeWorkflowComposition(
  projectRoot: string,
  outerRunId: string,
  compositionId: string,
): WorkflowCompositionState;
export function removeWorkflowComposition(
  projectRoot: string,
  compositionId: string,
): WorkflowCompositionState;
export function removeWorkflowComposition(
  projectRoot: string,
  outerRunIdOrCompositionId: string,
  compositionId?: string,
): WorkflowCompositionState {
  if (compositionId !== undefined)
    return withStateFileLock(
      workflowCompositionPath(projectRoot, outerRunIdOrCompositionId, compositionId),
      () => removeWorkflowCompositionAt(projectRoot, outerRunIdOrCompositionId, compositionId),
    );
  const state = readWorkflowComposition(projectRoot, outerRunIdOrCompositionId);
  return withStateFileLock(
    workflowCompositionPath(projectRoot, state.outer_run_id, state.composition_id),
    () => removeWorkflowCompositionAt(projectRoot, state.outer_run_id, state.composition_id),
  );
}
