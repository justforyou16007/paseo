import { initializeRunBudget, reserveRunExecution } from "./run-budget.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertIdentifier,
  assertRunId,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireInteger,
  requireString,
  type JsonObject,
} from "./workflow-spec.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  readStateFile,
  withStateFileLock,
  writeStateFileAtomic,
  writeStateJsonAtomic,
} from "./state-file.js";
import { validateBridgeExpansionPlan } from "./experiment-bridge.js";

export interface RunIdentityMaterial {
  charter_sha256: string;
  input_snapshot_sha256: string;
  execution_plan_sha256: string;
  code_baseline_sha256: string;
  policy_revision: string;
  child_run_identities: string[];
}

/** The durable identity shared by every ARIS run implementation. */
export interface RunRecord {
  schema_version: 1;
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  scope_path: string;

  run_identity: string;
  /** Integrity check for every persisted field, including parent constraints. */
  run_contract_sha256: string;
  output_hashes: Record<string, string>;

  identity_material: RunIdentityMaterial;
  child_run_ids: string[];
}

export interface RunIdentityInput {
  charter_sha256?: string;
  input_snapshot_sha256?: string;
  execution_plan_sha256?: string;
  code_baseline_sha256?: string;
  policy_revision?: string;
  child_run_identities?: readonly string[];
}

export interface CreateRunInput extends RunIdentityInput {
  project_root: string;
  run_id: string;
  parent_run_id?: string | null;
  depth?: number;
  scope_path?: string;

  output_hashes?: Record<string, string>;

  identity?: RunIdentityInput;
}

/**
 * Inputs accepted by the bridge's child-contract creation boundary.
 *
 * The full plan is intentionally kept as an unknown value here. This is a
 * runtime boundary: a TypeScript caller must not be able to replace the plan
 * with the old narrow child fields by using `as any`.
 */
export interface CreateBridgeChildRunInput {
  project_root: string;
  plan: unknown;
  child_run_id: string;
}

export type RootRunIdentityInput = Omit<RunIdentityInput, "child_run_identities">;

/** Inputs accepted by the human/root creation boundary. */
export interface CreateRootRunInput extends RootRunIdentityInput {
  project_root: string;
  run_id: string;

  output_hashes?: Record<string, string>;

  identity?: RootRunIdentityInput;
}

/** The existing-contract boundary deliberately shares the request shape only. */
export type OpenExistingRunInput = CreateRunInput;

export interface RunReferenceInput {
  run_id: string;
  parent_run_id?: string | null;
  depth?: number;
  scope_path?: string;
}

export interface NormalizedRunReference {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  scope_path: string;
}

export interface RunScopeLockInput {
  project_root: string;
  run_id: string;
  scope_path: string;
  parent_run_id?: string | null;
}

interface ScopeLockRecord {
  schema_version: 1;
  run_id: string;
  parent_run_id: string | null;
  scope_path: string;
  owner_pid: number;
  acquired_at: string;
  lease_tokens: string[];
  lease_owners: Record<string, number>;
}

export interface RunScopeLease {
  readonly run_id: string;
  readonly scope_path: string;
  readonly lease_token: string;
  release(): void;
  /** Release every lease only when every token is held and terminal cleanup is verified. */
  releaseAll(leaseTokens: readonly string[], terminal: true): void;
  close(): void;
}

export interface RunScopeReleaseInput extends RunScopeLockInput {
  lease_token: string;
}

/**
 * This is deliberately private. A bootstrap transaction is the capability
 * that permits a path lookup before run.json exists; no public API returns it.
 */
interface RunBootstrapTransaction {
  readonly scopeLease: RunScopeLease;
  path(...relativePaths: string[]): string;
  commit(): void;
  rollback(): void;
}

const RUN_IDENTITY_SCHEMA = "aris-run-identity-v1";
const RUN_SCOPE_LOCKS_FILE = "run-scope-locks.json";
const SHA256_RE = /^[a-f0-9]{64}$/;

function projectRootPath(projectRoot: string): string {
  const root = path.resolve(requireString(projectRoot, "project_root"));
  if (root === path.parse(root).root)
    failA1("INVALID_PATH", "project_root cannot be the filesystem root");
  return root;
}

function safeRunId(runId: unknown, location = "run_id"): string {
  return assertRunId(runId, location);
}

function runRoot(projectRoot: string, runId: string): string {
  return path.join(projectRootPath(projectRoot), ".aris", "runs", safeRunId(runId));
}

function runOwnedPathUnchecked(
  projectRoot: string,
  runId: string,
  relativePaths: readonly string[],
): string {
  const base = runRoot(projectRoot, runId);
  if (relativePaths.length === 0) return base;
  const parts = relativePaths.map((value, index) => {
    const part = requireString(value, `run_owned_path[${index}]`).replaceAll("\\", "/");
    if (
      !part ||
      part.includes("\0") ||
      path.isAbsolute(part) ||
      part.split("/").some((segment) => segment === "." || segment === "..")
    )
      failA1("PATH_ESCAPE", "run-owned path must stay below the run directory");
    return part;
  });
  const target = path.resolve(base, ...parts);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    failA1("PATH_ESCAPE", "run-owned path must stay below the run directory");
  return target;
}

/**
 * Every path below `.aris/runs/<run_id>/` goes through this gate.  The gate is
 * deliberately attached to path construction, so a new reader or writer
 * cannot forget the contract check at its call site.
 */
export function runOwnedPath(
  projectRoot: string,
  runId: string,
  ...relativePaths: string[]
): string {
  const safeId = safeRunId(runId);
  requireRunContract(projectRoot, safeId);
  return runOwnedPathUnchecked(projectRoot, safeId, relativePaths);
}

/**
 * Compatibility stub for the old bootstrap export.
 *
 * The old function used to turn arbitrary `(root, run_id, relative path)`
 * input into a writable path. It is kept only until the A2-2 owner removes
 * the stale task-setup import before A2-2 validation; it must never return a
 * path. New code uses a private transaction in the creation entry point or a
 * private preflight helper in its own module.
 */
/** @deprecated migrate callers to an explicit creation/setup transaction. */
export function runOwnedPathForBootstrap(
  _projectRoot: string,
  _runId: string,
  ..._relativePaths: string[]
): string {
  failA1(
    "RUN_BOOTSTRAP_TRANSACTION_REQUIRED",
    "a bootstrap path requires an internal creation or migration transaction",
  );
}

export function runDirectory(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, runId);
}

export function runJsonPath(projectRoot: string, runId: string): string {
  return path.join(runRoot(projectRoot, runId), "run.json");
}

/** The old phase-only file is deliberately retained as a compatibility path. */
export function legacyRunStatePath(projectRoot: string, runId: string): string {
  return path.join(projectRootPath(projectRoot), ".aris", "runs", `${safeRunId(runId)}.json`);
}

function scopeLockPath(projectRoot: string): string {
  return path.join(projectRootPath(projectRoot), ".aris", RUN_SCOPE_LOCKS_FILE);
}

export function normalizeScopePath(value: unknown, location = "scope_path"): string {
  const raw = requireString(value, location).replaceAll("\\", "/");
  if (!raw.startsWith("/") || raw.includes("\0"))
    failA1("INVALID_SCOPE_PATH", "scope_path must be an absolute POSIX path", location);
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".."))
    failA1("INVALID_SCOPE_PATH", "scope_path cannot contain '.' or '..'", location);
  const normalized = `/${parts.join("/")}`;
  return normalized === "/" ? "/" : normalized;
}

export function scopePathsIntersect(left: string, right: string): boolean {
  const a = normalizeScopePath(left, "left_scope_path");
  const b = normalizeScopePath(right, "right_scope_path");
  return a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isStrictScopeDescendant(parentScope: string, childScope: string): boolean {
  const parent = normalizeScopePath(parentScope, "parent_scope_path");
  const child = normalizeScopePath(childScope, "child_scope_path");
  return child !== parent && (parent === "/" || child.startsWith(`${parent}/`));
}

function assertChildScope(parent: RunRecord, childScope: string): void {
  if (!isStrictScopeDescendant(parent.scope_path, childScope))
    failA1(
      "RUN_SCOPE_ACTIVE",
      `child scope '${childScope}' must be a strict descendant of parent scope '${parent.scope_path}'`,
    );
}

/**
 * A child scope names the workflow position the child owns, so two runs
 * competing for the same position collide in the scope mutex. Run ids carry no
 * position, so the recorded contract is the only source: the parent writes the
 * scope when it materializes the child.
 */
export function deriveChildScopePath(
  projectRoot: string,
  parentRunId: string,
  childRunId: string,
): string {
  const parent = readRun(projectRoot, parentRunId);
  const child = readStoredRun(projectRootPath(projectRoot), safeRunId(childRunId));
  if (child.parent_run_id !== parent.run_id)
    failA1("IDENTITY_MISMATCH", `run '${child.run_id}' is not a child of '${parent.run_id}'`);
  assertChildScope(parent, child.scope_path);
  return child.scope_path;
}

export function normalizeRunReference(input: RunReferenceInput): NormalizedRunReference {
  const runId = safeRunId(input.run_id);
  const parentRunId =
    input.parent_run_id === undefined || input.parent_run_id === null
      ? null
      : safeRunId(input.parent_run_id, "parent_run_id");
  const depth =
    input.depth === undefined
      ? parentRunId === null
        ? 0
        : 1
      : requireInteger(input.depth, "depth", 0);
  return {
    run_id: runId,
    parent_run_id: parentRunId,
    depth,
    scope_path: normalizeScopePath(input.scope_path ?? (parentRunId === null ? "/" : "/" + runId)),
  };
}

function nonEmptyIdentityPart(value: unknown, location: string): string {
  if (value === null)
    failA1("INVALID_RUN_IDENTITY", `${location} must be a string or omitted`, location);
  const text = requireString(value, location);
  if (text.length === 0) failA1("INVALID_RUN_IDENTITY", `${location} must not be empty`, location);
  return text;
}

const MISSING_IDENTITY_PART = "\u0000aris-identity-field-missing\u0000";

function identityPart(value: unknown, key: string): string {
  return value === undefined ? MISSING_IDENTITY_PART : nonEmptyIdentityPart(value, key);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function identityInputObject(input: unknown, location: string): RunIdentityInput | null {
  if (input === undefined) return null;
  if (!isRecord(input)) failA1("INVALID_RUN_IDENTITY", `${location} must be an object`, location);
  return input as RunIdentityInput;
}

function requestedIdentityValue(
  input: RunIdentityInput & { identity?: RunIdentityInput | null },
  key: keyof RunIdentityInput,
): { present: boolean; value: unknown } {
  const nested = identityInputObject(input.identity, "identity");
  const hasTop = hasOwn(input, key);
  const hasNested = nested !== null && hasOwn(nested, key);
  const topValue = hasTop ? input[key] : undefined;
  const nestedValue = hasNested ? nested![key] : undefined;
  if (hasTop && hasNested && topValue !== nestedValue)
    failA1("RUN_IDENTITY_CONFLICT", `identity.${key} conflicts with top-level ${key}`);
  return {
    present: hasTop || hasNested,
    value: hasNested ? nestedValue : topValue,
  };
}

function identityChildValues(
  input: RunIdentityInput & { identity?: RunIdentityInput | null },
): string[] {
  const requested = requestedIdentityValue(input, "child_run_identities");
  if (!requested.present || requested.value === undefined) return [];
  if (!Array.isArray(requested.value))
    failA1("INVALID_RUN_IDENTITY", "child_run_identities must be an array");
  return requested.value.map((child, index) =>
    nonEmptyIdentityPart(child, `child_run_identities[${index}]`),
  );
}

export function computeRunIdentity(input: RunIdentityInput): string {
  const source = input as RunIdentityInput & { identity?: RunIdentityInput | null };
  const requestedChildren = identityChildValues(source);
  const children = requestedChildren.sort();
  return canonicalJsonSha256(
    {
      charter_sha256: identityPart(
        requestedIdentityValue(source, "charter_sha256").value,
        "charter_sha256",
      ),
      input_snapshot_sha256: identityPart(
        requestedIdentityValue(source, "input_snapshot_sha256").value,
        "input_snapshot_sha256",
      ),
      execution_plan_sha256: identityPart(
        requestedIdentityValue(source, "execution_plan_sha256").value,
        "execution_plan_sha256",
      ),
      code_baseline_sha256: identityPart(
        requestedIdentityValue(source, "code_baseline_sha256").value,
        "code_baseline_sha256",
      ),
      policy_revision: identityPart(
        requestedIdentityValue(source, "policy_revision").value,
        "policy_revision",
      ),
      child_run_identities: children,
    },
    undefined,
    { schemaVersion: RUN_IDENTITY_SCHEMA },
  );
}

export const deriveRunIdentity = computeRunIdentity;

function normalizeOutputHashes(value: unknown, location = "output_hashes"): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value))
    failA1("INVALID_OUTPUT_HASHES", "output_hashes must be an object", location);
  const result: Record<string, string> = {};
  for (const [outputPath, hash] of Object.entries(value)) {
    if (
      !outputPath ||
      path.isAbsolute(outputPath) ||
      outputPath.split(/[\\/]/).some((part) => part === ".." || part === "")
    ) {
      failA1(
        "INVALID_OUTPUT_HASHES",
        "output paths must be relative files",
        `${location}.${outputPath}`,
      );
    }
    const safeHash = assertSha256(hash, `${location}.${outputPath}`);
    result[outputPath.replaceAll("\\", "/")] = safeHash;
  }
  return result;
}

function normalizeIdentityMaterial(
  input: RunIdentityInput & { identity?: RunIdentityInput | null },
): RunIdentityMaterial {
  const source = input;
  const requestedChildren = identityChildValues(source);
  return {
    charter_sha256: identityPart(
      requestedIdentityValue(source, "charter_sha256").value,
      "charter_sha256",
    ),
    input_snapshot_sha256: identityPart(
      requestedIdentityValue(source, "input_snapshot_sha256").value,
      "input_snapshot_sha256",
    ),
    execution_plan_sha256: identityPart(
      requestedIdentityValue(source, "execution_plan_sha256").value,
      "execution_plan_sha256",
    ),
    code_baseline_sha256: identityPart(
      requestedIdentityValue(source, "code_baseline_sha256").value,
      "code_baseline_sha256",
    ),
    policy_revision: identityPart(
      requestedIdentityValue(source, "policy_revision").value,
      "policy_revision",
    ),
    child_run_identities: requestedChildren.sort(),
  };
}

const IDENTITY_SCALAR_KEYS = [
  "charter_sha256",
  "input_snapshot_sha256",
  "execution_plan_sha256",
  "code_baseline_sha256",
  "policy_revision",
] as const;

const ROOT_RUN_INPUT_FIELDS = [
  "project_root",
  "run_id",

  "output_hashes",

  "identity",
  ...IDENTITY_SCALAR_KEYS,
] as const;

function assertRootRunInput(input: CreateRootRunInput): void {
  if (!isRecord(input)) failA1("INVALID_VALUE", "root run input must be an object", "root_run");
  assertNoUnknownFields(input, ROOT_RUN_INPUT_FIELDS, "root_run");
  if (input.identity !== undefined) {
    if (!isRecord(input.identity))
      failA1("INVALID_RUN_IDENTITY", "root_run.identity must be an object", "root_run.identity");
    assertNoUnknownFields(input.identity, IDENTITY_SCALAR_KEYS, "root_run.identity");
  }
}

function assertRequestedIdentityMatches(
  existing: RunRecord,
  input: CreateRunInput,
  filePath: string,
): void {
  for (const key of IDENTITY_SCALAR_KEYS) {
    const requested = requestedIdentityValue(input, key);
    if (requested.present && identityPart(requested.value, key) !== existing.identity_material[key])
      failA1("RUN_IDENTITY_CONFLICT", `existing run.json conflicts at ${key}`, filePath);
  }
  const requestedChildren = requestedIdentityValue(input, "child_run_identities");
  if (requestedChildren.present) {
    const expectedChildren = identityChildValues(input).sort();
    if (
      JSON.stringify(expectedChildren) !==
      JSON.stringify(existing.identity_material.child_run_identities)
    )
      failA1(
        "RUN_IDENTITY_CONFLICT",
        "existing run.json conflicts at child_run_identities",
        filePath,
      );
  }
}

function runContractPayload(
  record: Omit<RunRecord, "run_contract_sha256">,
): Record<string, unknown> {
  return {
    schema_version: record.schema_version,
    run_id: record.run_id,
    parent_run_id: record.parent_run_id,
    depth: record.depth,
    scope_path: record.scope_path,

    run_identity: record.run_identity,
    output_hashes: record.output_hashes,

    identity_material: record.identity_material,
    child_run_ids: record.child_run_ids,
  };
}

function computeRunContractSha256(record: Omit<RunRecord, "run_contract_sha256">): string {
  return canonicalJsonSha256(runContractPayload(record), undefined, {
    schemaVersion: "aris-run-contract-v1",
  });
}

function canonicalRunRecord(record: RunRecord): RunRecord {
  const normalized = normalizeRunReference(record);
  const identityMaterial = normalizeIdentityMaterial({ ...record.identity_material });
  const result: RunRecord = {
    schema_version: 1,
    ...normalized,
    run_identity: computeRunIdentity(identityMaterial),
    run_contract_sha256: "",
    output_hashes: normalizeOutputHashes(record.output_hashes),
    identity_material: identityMaterial,
    child_run_ids: [...record.child_run_ids].map((child) => safeRunId(child, "child_run_id")),
  };
  if (result.run_identity !== record.run_identity)
    failA1("RUN_IDENTITY_MISMATCH", "run_identity does not match its identity inputs");
  if (new Set(result.child_run_ids).size !== result.child_run_ids.length)
    failA1("DUPLICATE_ID", "child_run_ids must be unique");
  const contractSha256 = computeRunContractSha256(result);
  if (
    record.run_contract_sha256 !== undefined &&
    record.run_contract_sha256 !== "" &&
    record.run_contract_sha256 !== contractSha256
  )
    failA1("RUN_IDENTITY_MISMATCH", "run contract integrity does not match its fields");
  return { ...result, run_contract_sha256: contractSha256 };
}

function parseStoredRun(value: unknown, filePath: string, expectedRunId?: string): RunRecord {
  if (!isRecord(value)) failA1("CORRUPT_RUN", "run state must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "run_id",
      "parent_run_id",
      "outer_run_id",
      "depth",
      "scope_path",

      "run_identity",
      "run_contract_sha256",
      "output_hashes",

      "identity_material",
      "child_run_ids",
      "charter_sha256",
      "input_snapshot_sha256",
      "execution_plan_sha256",
      "code_baseline_sha256",
      "policy_revision",
    ],
    filePath,
  );
  if (value.schema_version !== undefined && value.schema_version !== 1)
    failA1("CORRUPT_RUN", "unsupported run schema", filePath);
  const runId = safeRunId(value.run_id, `${filePath}.run_id`);
  if (expectedRunId !== undefined && runId !== safeRunId(expectedRunId))
    failA1("IDENTITY_MISMATCH", "run.json and its directory have different run ids", filePath);
  if (
    value.parent_run_id !== undefined &&
    value.outer_run_id !== undefined &&
    value.parent_run_id !== value.outer_run_id
  )
    failA1("IDENTITY_MISMATCH", "parent_run_id and outer_run_id disagree", filePath);
  const rawParent =
    value.parent_run_id !== undefined ? value.parent_run_id : (value.outer_run_id ?? null);
  const parentRunId = rawParent === null ? null : safeRunId(rawParent, `${filePath}.parent_run_id`);
  const depth =
    value.depth === undefined
      ? parentRunId === null
        ? 0
        : 1
      : requireInteger(value.depth, `${filePath}.depth`, 0);
  const materialValue = isRecord(value.identity_material) ? value.identity_material : value;
  const rawChildIdentities = materialValue.child_run_identities;
  if (rawChildIdentities !== undefined && !Array.isArray(rawChildIdentities))
    failA1(
      "CORRUPT_RUN",
      "child_run_identities must be an array",
      `${filePath}.identity_material.child_run_identities`,
    );
  const normalizedChildIdentities = (rawChildIdentities ?? []).map((child, index) =>
    nonEmptyIdentityPart(child, `${filePath}.identity_material.child_run_identities[${index}]`),
  );
  const material: RunIdentityMaterial = {
    charter_sha256: identityPart(materialValue.charter_sha256, "charter_sha256"),
    input_snapshot_sha256: identityPart(
      materialValue.input_snapshot_sha256,
      "input_snapshot_sha256",
    ),
    execution_plan_sha256: identityPart(
      materialValue.execution_plan_sha256,
      "execution_plan_sha256",
    ),
    code_baseline_sha256: identityPart(materialValue.code_baseline_sha256, "code_baseline_sha256"),
    policy_revision: identityPart(materialValue.policy_revision, "policy_revision"),
    child_run_identities: normalizedChildIdentities,
  };
  const childRunIds =
    value.child_run_ids === undefined
      ? []
      : Array.isArray(value.child_run_ids)
        ? value.child_run_ids.map((child, index) =>
            safeRunId(child, `${filePath}.child_run_ids[${index}]`),
          )
        : (() => {
            failA1("CORRUPT_RUN", "child_run_ids must be an array", filePath);
          })();
  const identity = computeRunIdentity(material);
  if (value.run_identity !== undefined && value.run_identity !== identity)
    failA1(
      "RUN_IDENTITY_MISMATCH",
      "run_identity does not match the stored identity inputs",
      filePath,
    );
  const parsed: RunRecord = {
    schema_version: 1,
    run_id: runId,
    parent_run_id: parentRunId,
    depth,
    scope_path: normalizeScopePath(
      value.scope_path ?? (parentRunId === null ? "/" : `/${runId}`),
      `${filePath}.scope_path`,
    ),

    run_identity: identity,
    run_contract_sha256: "",
    output_hashes: normalizeOutputHashes(value.output_hashes, `${filePath}.output_hashes`),

    identity_material: material,
    child_run_ids: childRunIds,
  };
  const contractSha256 = computeRunContractSha256(parsed);
  const legacyContractWithoutIntegrity =
    value.run_contract_sha256 === undefined &&
    value.parent_run_id === undefined &&
    value.outer_run_id !== undefined;
  if (value.run_contract_sha256 === undefined && !legacyContractWithoutIntegrity)
    failA1(
      "CORRUPT_RUN",
      "run.json is missing run_contract_sha256; only outer_run_id legacy files may omit it",
      filePath,
    );
  if (value.run_contract_sha256 !== undefined && value.run_contract_sha256 !== contractSha256)
    failA1(
      "RUN_IDENTITY_MISMATCH",
      "run contract integrity does not match the stored fields",
      filePath,
    );
  return { ...parsed, run_contract_sha256: contractSha256 };
}

function looksLikeRunContract(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  const hasRunId = hasOwn(value, "run_id") || hasOwn(value, "outer_run_id");
  const hasIdentity =
    hasOwn(value, "run_identity") ||
    hasOwn(value, "identity_material") ||
    IDENTITY_SCALAR_KEYS.some((key) => hasOwn(value, key));
  const hasReference =
    hasOwn(value, "depth") ||
    hasOwn(value, "scope_path") ||
    hasOwn(value, "parent_run_id") ||
    hasOwn(value, "outer_run_id");
  return hasRunId && hasIdentity && hasReference;
}

function assertRunParentCompatibility(
  projectRoot: string,
  record: Pick<RunRecord, "run_id" | "parent_run_id" | "depth" | "scope_path">,
  trail: Set<string> = new Set(),
  allowLegacyMissingParent = false,
): RunRecord | null {
  const root = projectRootPath(projectRoot);
  if (record.parent_run_id === null) {
    if (record.depth !== 0) failA1("RUN_DEPTH_MISMATCH", "a root run must have depth 0");
    return null;
  }
  let parent: RunRecord;
  try {
    parent = readStoredRun(root, record.parent_run_id, trail);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (allowLegacyMissingParent && (code === "RUN_NOT_FOUND" || code === "RUN_CONTRACT_NOT_FOUND"))
      return null;
    throw error;
  }
  if (record.depth !== parent.depth + 1)
    failA1("RUN_DEPTH_MISMATCH", `child depth must be ${parent.depth + 1}`);
  assertChildScope(parent, record.scope_path);
  return parent;
}

function readStoredRun(
  projectRoot: string,
  runId: string,
  trail: Set<string> = new Set(),
): RunRecord {
  const safeId = safeRunId(runId);
  if (trail.has(safeId)) failA1("RUN_GRAPH_CYCLE", "run parent links contain a cycle");
  const nextTrail = new Set(trail);
  nextTrail.add(safeId);
  const canonicalPath = runJsonPath(projectRoot, safeId);
  if (fs.existsSync(canonicalPath)) {
    const value = readStateFile<unknown>(canonicalPath);
    const parsed = parseStoredRun(value, canonicalPath, safeId);
    const legacyParentOnly =
      isRecord(value) && value.parent_run_id === undefined && value.outer_run_id !== undefined;
    assertRunParentCompatibility(projectRoot, parsed, nextTrail, legacyParentOnly);
    return parsed;
  }
  const legacyPath = legacyRunStatePath(projectRoot, safeId);
  if (fs.existsSync(legacyPath)) {
    const legacyValue = readStateFile<unknown>(legacyPath);
    if (!looksLikeRunContract(legacyValue))
      failA1(
        "RUN_CONTRACT_NOT_FOUND",
        `legacy state at ${legacyPath} is not a run contract; migrate the run before reading its identity`,
        legacyPath,
      );
    const parsed = parseStoredRun(legacyValue, legacyPath, safeId);
    const legacyParentOnly =
      isRecord(legacyValue) &&
      legacyValue.parent_run_id === undefined &&
      legacyValue.outer_run_id !== undefined;
    assertRunParentCompatibility(projectRoot, parsed, nextTrail, legacyParentOnly);
    return parsed;
  }
  if (fs.existsSync(runRoot(projectRoot, safeId)))
    failA1(
      "RUN_CONTRACT_NOT_FOUND",
      `run '${safeId}' has state but no canonical run.json at ${canonicalPath}`,
      canonicalPath,
    );
  failA1("RUN_NOT_FOUND", `no run.json at ${canonicalPath}`);
}

/** Validate a prospective run before a caller constructs or persists its state. */
export function assertRunReferenceCompatible(
  projectRoot: string,
  input: RunReferenceInput,
): NormalizedRunReference {
  const normalized = normalizeRunReference(input);
  assertRunParentCompatibility(projectRoot, normalized);
  return normalized;
}

function readChildIds(projectRoot: string, record: RunRecord): string[] {
  const result = new Set(record.child_run_ids);
  const runsRoot = path.join(projectRootPath(projectRoot), ".aris", "runs");
  if (fs.existsSync(runsRoot)) {
    for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(runsRoot, entry.name, "run.json");
      if (!fs.existsSync(candidate)) continue;
      const child = parseStoredRun(readStateFile(candidate), candidate, entry.name);
      if (child.parent_run_id === record.run_id) result.add(child.run_id);
    }
  }
  return [...result].sort();
}

function resolveRun(projectRoot: string, runId: string, trail = new Set<string>()): RunRecord {
  const stored = readStoredRun(projectRoot, runId);
  if (trail.has(stored.run_id)) failA1("RUN_GRAPH_CYCLE", "run parent/child links contain a cycle");
  trail.add(stored.run_id);
  const childIds = readChildIds(projectRoot, stored);
  const childIdentities = childIds.map(
    (childId) => resolveRun(projectRoot, childId, new Set(trail)).run_identity,
  );
  const material = {
    ...stored.identity_material,
    child_run_identities: childIdentities.sort(),
  };
  const runIdentity = computeRunIdentity(material);
  const resolved: RunRecord = {
    ...stored,
    child_run_ids: childIds,
    identity_material: material,
    run_identity: runIdentity,
    run_contract_sha256: "",
  };
  return { ...resolved, run_contract_sha256: computeRunContractSha256(resolved) };
}

export function readRun(projectRoot: string, runId: string): RunRecord {
  return resolveRun(projectRoot, runId);
}

export const readRunContract = readRun;

/** Readers that recover a run-owned state file must require the canonical contract. */
export function requireRunContract(projectRoot: string, runId: string): RunRecord {
  const safeId = safeRunId(runId);
  const filePath = runJsonPath(projectRoot, safeId);
  if (!fs.existsSync(filePath))
    failA1(
      "RUN_CONTRACT_NOT_FOUND",
      `canonical run.json is required at ${filePath}; use root-setup (setupRootRun) for root runs or run-open for standalone runs first`,
      filePath,
    );
  return readRun(projectRoot, safeId);
}

function assertRequestedReferenceMatches(
  existing: RunRecord,
  input: OpenExistingRunInput,
  filePath: string,
): void {
  if (input.parent_run_id !== undefined) {
    const expected =
      input.parent_run_id === null ? null : safeRunId(input.parent_run_id, "parent_run_id");
    if (existing.parent_run_id !== expected)
      failA1("RUN_IDENTITY_CONFLICT", "existing run.json conflicts at parent_run_id", filePath);
  }
  if (input.depth !== undefined) {
    const expected = requireInteger(input.depth, "depth", 0);
    if (existing.depth !== expected)
      failA1("RUN_IDENTITY_CONFLICT", "existing run.json conflicts at depth", filePath);
  }
  if (input.scope_path !== undefined) {
    const expected = normalizeScopePath(input.scope_path, "scope_path");
    if (existing.scope_path !== expected)
      failA1("RUN_IDENTITY_CONFLICT", "existing run.json conflicts at scope_path", filePath);
  }
}

/** Open an already persisted contract; this function never creates or updates it. */
export function openExistingRun(input: OpenExistingRunInput): RunRecord {
  const existing = requireRunContract(input.project_root, input.run_id);
  const filePath = runJsonPath(input.project_root, input.run_id);
  assertRequestedReferenceMatches(existing, input, filePath);
  assertRequestedIdentityMatches(existing, input, filePath);
  return existing;
}

function persistRun(projectRoot: string, record: RunRecord): RunRecord {
  const canonical = canonicalRunRecord(record);
  const filePath = runJsonPath(projectRoot, canonical.run_id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withStateFileLock(filePath, () => writeStateJsonAtomic(filePath, canonical));
  return canonical;
}

function cleanupAfterRunFailure(
  filePath: string,
  scope: RunScopeLease | RunBootstrapTransaction | null,
  removeFile: boolean,
  originalError: unknown,
): void {
  const failures: string[] = [];
  if (removeFile && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      failures.push(`cannot remove ${filePath}: ${String(error)}`);
    }
  }
  if (scope !== null) {
    try {
      if ("rollback" in scope) scope.rollback();
      else scope.release();
    } catch (error) {
      failures.push(`cannot release the run scope: ${String(error)}`);
    }
  }
  if (failures.length > 0)
    failA1(
      "RUN_CREATE_CLEANUP_FAILED",
      `run creation failed (${String(originalError)}); cleanup also failed: ${failures.join("; ")}`,
      filePath,
    );
}

function parentRecord(projectRoot: string, parentRunId: string): RunRecord {
  return readStoredRun(projectRoot, parentRunId);
}

/**
 * Begin the only transaction that may inspect a run-owned path before its
 * canonical contract exists. The transaction is kept inside this module: a
 * caller can create a run, but cannot ask for the transaction's raw path
 * capability independently of that creation operation.
 */
function beginRunBootstrapTransaction(input: RunScopeLockInput): RunBootstrapTransaction {
  const scopeLease = acquirePersistentRunScope(input, true);
  let state: "open" | "committed" | "rolled-back" = "open";
  return {
    scopeLease,
    path(...relativePaths: string[]): string {
      if (state !== "open")
        failA1("RUN_BOOTSTRAP_TRANSACTION_CLOSED", "bootstrap transaction is no longer open");
      return runOwnedPathUnchecked(input.project_root, input.run_id, relativePaths);
    },
    commit(): void {
      if (state !== "open")
        failA1("RUN_BOOTSTRAP_TRANSACTION_CLOSED", "bootstrap transaction is no longer open");
      state = "committed";
    },
    rollback(): void {
      if (state === "committed")
        failA1(
          "RUN_BOOTSTRAP_TRANSACTION_CLOSED",
          "committed bootstrap transaction cannot roll back",
        );
      if (state === "rolled-back") return;
      try {
        scopeLease.release();
      } finally {
        state = "rolled-back";
      }
    },
  };
}

export function createRun(input: CreateRunInput): RunRecord {
  const root = projectRootPath(input.project_root);
  const knownParent =
    input.parent_run_id === undefined || input.parent_run_id === null
      ? null
      : parentRecord(root, input.parent_run_id);
  const normalized = normalizeRunReference({
    run_id: input.run_id,
    parent_run_id: input.parent_run_id,
    depth: input.depth ?? (knownParent === null ? undefined : knownParent.depth + 1),
    scope_path:
      input.scope_path ??
      (knownParent === null ? undefined : `${knownParent.scope_path}/${input.run_id}`),
  });
  const parent = assertRunParentCompatibility(root, normalized) ?? knownParent;
  const material = normalizeIdentityMaterial(input);
  const record: RunRecord = {
    schema_version: 1,
    ...normalized,

    run_contract_sha256: "",

    run_identity: computeRunIdentity(material),
    output_hashes: normalizeOutputHashes(input.output_hashes),
    identity_material: material,
    child_run_ids: [],
  };

  const transaction = beginRunBootstrapTransaction({
    project_root: root,
    run_id: record.run_id,
    parent_run_id: record.parent_run_id,
    scope_path: record.scope_path,
  });
  const filePath = transaction.path("run.json");
  let created = false;
  try {
    const result = withStateFileLock(`${filePath}.create`, () => {
      if (fs.existsSync(filePath)) {
        const existing = readStoredRun(root, record.run_id);
        if (
          existing.parent_run_id !== record.parent_run_id ||
          existing.depth !== record.depth ||
          existing.scope_path !== record.scope_path
        )
          failA1(
            "RUN_IDENTITY_CONFLICT",
            "existing run.json has a different run identity",
            filePath,
          );
        assertRequestedIdentityMatches(existing, input, filePath);
        return resolveRun(root, record.run_id);
      }
      persistRun(root, record);
      created = true;
      if (parent !== null) registerChildRun(root, parent.run_id, record.run_id);
      return resolveRun(root, record.run_id);
    });
    transaction.commit();
    return result;
  } catch (error) {
    cleanupAfterRunFailure(filePath, transaction, created, error);
    throw error;
  }
}

/** Create the only kind of contract a human-facing entry may create: a root. */
export function createRootRun(input: CreateRootRunInput): RunRecord {
  assertRootRunInput(input);
  return createRun({
    ...input,
    parent_run_id: null,
    depth: 0,
    scope_path: "/",
  });
}

const BRIDGE_CHILD_RUN_INPUT_FIELDS = ["project_root", "plan", "child_run_id"] as const;

/**
 * Create one child contract from a complete bridge expansion plan.
 *
 * The plan is validated here, at the final creation boundary, rather than
 * relying on materializeBridgeChildren's earlier check. A direct caller has
 * to provide the same complete plan shape and all of its matching hashes; the
 * old narrow child input cannot reach createRun anymore.
 */
export function createBridgeChildRun(input: unknown): RunRecord {
  if (!isRecord(input))
    failA1("INVALID_VALUE", "bridge child run input must be an object", "bridge_child_run");
  if (!Object.hasOwn(input, "plan"))
    failA1(
      "BRIDGE_EXPANSION_PLAN_REQUIRED",
      "bridge child creation requires a complete expansion plan",
      "bridge_child_run.plan",
    );
  assertNoUnknownFields(input, BRIDGE_CHILD_RUN_INPUT_FIELDS, "bridge_child_run");
  const projectRoot = requireString(input.project_root, "bridge_child_run.project_root");
  const childRunId = assertIdentifier(input.child_run_id, "bridge_child_run.child_run_id");
  const plan = validateBridgeExpansionPlan(input.plan);
  const child = plan.children.find((candidate) => candidate.run_id === childRunId);
  if (child === undefined)
    failA1(
      "IDENTITY_MISMATCH",
      `child '${childRunId}' is not present in the expansion plan`,
      "bridge_child_run.child_run_id",
    );
  if (child.result.status === "not_executable" || child.result.status === "infra_unavailable")
    failA1("INVALID_EXPANSION", "a resource-free result does not dispatch a child");
  assertRunReferenceCompatible(projectRoot, {
    run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    depth: child.depth,
    scope_path: child.scope_path,
  });
  reserveRunExecution({
    project_root: projectRoot,
    run_id: child.parent_run_id,
    execution_id: child.run_id,
    budget: child.budget,
  });
  const run = createRun({
    project_root: projectRoot,
    run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    depth: child.depth,
    scope_path: child.scope_path,

    charter_sha256: child.charter_sha256,
    input_snapshot_sha256: child.input_snapshot_sha256,
    execution_plan_sha256: child.execution_plan_sha256,
    code_baseline_sha256: child.code_baseline_sha256,
    policy_revision: child.policy_revision,
  });
  const charterPath = runOwnedPath(projectRoot, run.run_id, "charter.json");
  withStateFileLock(charterPath, () => {
    if (
      fs.existsSync(charterPath) &&
      canonicalJsonSha256(readStateFile(charterPath)) !== canonicalJsonSha256(child.charter)
    )
      failA1("IMMUTABLE_CONFLICT", "child charter changed");
    writeStateJsonAtomic(charterPath, child.charter);
  });
  const snapshotPath = runOwnedPath(projectRoot, run.run_id, "input-snapshot.json");
  const snapshot = {
    input_snapshot_sha256: child.input_snapshot_sha256,
    input_snapshot_refs: child.charter.input_snapshot_refs,
  };
  withStateFileLock(snapshotPath, () => {
    if (
      fs.existsSync(snapshotPath) &&
      canonicalJsonSha256(readStateFile(snapshotPath)) !== canonicalJsonSha256(snapshot)
    )
      failA1("IMMUTABLE_CONFLICT", "child inputs changed");
    writeStateJsonAtomic(snapshotPath, snapshot);
  });
  initializeRunBudget(projectRoot, run.run_id, child.budget);
  return updateRun(projectRoot, run.run_id, {
    output_hashes: {
      ...run.output_hashes,
      "input-snapshot.json": crypto
        .createHash("sha256")
        .update(fs.readFileSync(snapshotPath))
        .digest("hex"),
    },
  });
}

/**
 * @deprecated COMPAT(a2-5): retained only while the four state layers migrate
 * to openExistingRun. Remove after no production caller needs bootstrap-on-read.
 */
export function ensureRun(input: CreateRunInput): RunRecord {
  const filePath = runJsonPath(input.project_root, input.run_id);
  if (fs.existsSync(filePath)) {
    const existing = readStoredRun(input.project_root, input.run_id);
    const normalized = normalizeRunReference({
      run_id: input.run_id,
      parent_run_id: input.parent_run_id,
      depth: input.depth,
      scope_path: input.scope_path,
    });
    if (
      (input.parent_run_id !== undefined && existing.parent_run_id !== normalized.parent_run_id) ||
      (input.depth !== undefined && existing.depth !== normalized.depth) ||
      (input.scope_path !== undefined && existing.scope_path !== normalized.scope_path)
    )
      failA1(
        "RUN_IDENTITY_CONFLICT",
        "existing run.json conflicts with the requested identity",
        filePath,
      );
    assertRequestedIdentityMatches(existing, input, filePath);
    const scopeLease = acquirePersistentRunScope({
      project_root: input.project_root,
      run_id: existing.run_id,
      parent_run_id: existing.parent_run_id,
      scope_path: existing.scope_path,
    });
    try {
      return resolveRun(input.project_root, input.run_id);
    } catch (error) {
      scopeLease.release();
      throw error;
    }
  }
  return createRun(input);
}

function registerChildRun(projectRoot: string, parentRunId: string, childRunId: string): RunRecord {
  const root = projectRootPath(projectRoot);
  const parent = readStoredRun(root, parentRunId);
  const child = readStoredRun(root, childRunId);
  if (child.parent_run_id !== parent.run_id)
    failA1("IDENTITY_MISMATCH", "child run does not point at the requested parent");
  const childIds = [...new Set([...parent.child_run_ids, child.run_id])].sort();
  const material = {
    ...parent.identity_material,
    child_run_identities: childIds.map((id) => resolveRun(root, id).run_identity).sort(),
  };
  persistRun(root, {
    ...parent,
    child_run_ids: childIds,
    identity_material: material,
    run_identity: computeRunIdentity(material),
    run_contract_sha256: "",
  });
  if (parent.parent_run_id !== null) refreshRunIdentity(root, parent.parent_run_id);
  return resolveRun(root, parent.run_id);
}

function assertImmutableRunFields(existing: RunRecord, next: RunRecord, filePath: string): void {
  const fields: Array<keyof Pick<RunRecord, "run_id" | "parent_run_id" | "depth" | "scope_path">> =
    ["run_id", "parent_run_id", "depth", "scope_path"];
  for (const field of fields) {
    if (existing[field] !== next[field])
      failA1("RUN_IDENTITY_CONFLICT", `existing run.json cannot change ${field}`, filePath);
  }
}

export function writeRun(projectRoot: string, record: RunRecord): RunRecord {
  const root = projectRootPath(projectRoot);
  const filePath = runJsonPath(root, record.run_id);
  if (!fs.existsSync(filePath))
    failA1("RUN_CONTRACT_NOT_FOUND", `no canonical run.json at ${filePath}`, filePath);
  return withStateFileLock(filePath, () => {
    if (!fs.existsSync(filePath))
      failA1("RUN_CONTRACT_NOT_FOUND", `no canonical run.json at ${filePath}`, filePath);
    const canonical = canonicalRunRecord(record);
    const existing = readStoredRun(root, canonical.run_id);
    assertImmutableRunFields(existing, canonical, filePath);
    assertRunParentCompatibility(root, canonical, new Set(), false);
    const before = fs.readFileSync(filePath, "utf8");
    try {
      writeStateJsonAtomic(filePath, canonical);
      return resolveRun(root, canonical.run_id);
    } catch (error) {
      // An update failure must restore the existing contract, never delete it.
      try {
        writeStateFileAtomic(filePath, before);
      } catch (rollbackError) {
        failA1(
          "RUN_UPDATE_ROLLBACK_FAILED",
          `run update failed (${String(error)}); rollback also failed: ${String(rollbackError)}`,
          filePath,
        );
      }
      throw error;
    }
  });
}

export function updateRun(
  projectRoot: string,
  runId: string,
  patch: Partial<Omit<RunRecord, "schema_version" | "run_id" | "run_identity">> &
    RunIdentityInput & { identity?: RunIdentityInput },
): RunRecord {
  const current = readStoredRun(projectRoot, runId);
  const patchIdentity = patch as RunIdentityInput & { identity?: RunIdentityInput | null };
  const mergedIdentity: RunIdentityInput = { ...current.identity_material };
  for (const key of IDENTITY_SCALAR_KEYS) {
    const requested = requestedIdentityValue(patchIdentity, key);
    if (requested.present) (mergedIdentity as Record<string, unknown>)[key] = requested.value;
  }
  const requestedChildren = requestedIdentityValue(patchIdentity, "child_run_identities");
  if (requestedChildren.present)
    mergedIdentity.child_run_identities = requestedChildren.value as string[];
  const material = normalizeIdentityMaterial(mergedIdentity);
  return writeRun(projectRoot, {
    ...current,
    ...patch,
    run_id: current.run_id,
    identity_material: material,
    run_identity: computeRunIdentity(material),
    run_contract_sha256: "",
    output_hashes: patch.output_hashes ?? current.output_hashes,
    child_run_ids: patch.child_run_ids ?? current.child_run_ids,
  } as RunRecord);
}

function refreshRunIdentity(
  projectRoot: string,
  runId: string,
  trail = new Set<string>(),
): RunRecord {
  const root = projectRootPath(projectRoot);
  const stored = readStoredRun(root, runId);
  if (trail.has(stored.run_id)) failA1("RUN_GRAPH_CYCLE", "run parent/child links contain a cycle");
  trail.add(stored.run_id);
  const childIds = readChildIds(root, stored);
  const childIdentities = childIds.map(
    (id) => refreshRunIdentity(root, id, new Set(trail)).run_identity,
  );
  const material = {
    ...stored.identity_material,
    child_run_identities: childIdentities.sort(),
  };
  const identity = computeRunIdentity(material);
  const next = {
    ...stored,
    child_run_ids: childIds,
    identity_material: material,
    run_identity: identity,
    run_contract_sha256: "",
  };
  if (
    stored.run_identity !== identity ||
    JSON.stringify(stored.child_run_ids) !== JSON.stringify(childIds) ||
    JSON.stringify(stored.identity_material.child_run_identities) !==
      JSON.stringify(material.child_run_identities)
  )
    persistRun(root, next);
  return next;
}

export { refreshRunIdentity };

function resolveOutputPath(baseDirectory: string, outputPath: string): string {
  if (path.isAbsolute(outputPath)) failA1("INVALID_OUTPUT_HASHES", "output paths must be relative");
  const base = path.resolve(baseDirectory);
  const candidate = path.resolve(base, outputPath);
  const relative = path.relative(base, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    failA1("PATH_ESCAPE", "output hash path escapes the run directory", outputPath);
  return candidate;
}

export function verifyOutputHashes(
  projectRoot: string,
  runId: string,
  outputHashes?: Record<string, string>,
): boolean {
  const record = readStoredRun(projectRoot, runId);
  const expected = normalizeOutputHashes(outputHashes ?? record.output_hashes);
  const base = runDirectory(projectRoot, runId);
  for (const [outputPath, expectedHash] of Object.entries(expected)) {
    const absolute = resolveOutputPath(base, outputPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
    const bytesHash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    if (bytesHash !== expectedHash) return false;
  }
  return true;
}

export const validateOutputHashes = verifyOutputHashes;

export function assertOutputHashes(
  projectRoot: string,
  runId: string,
  outputHashes?: Record<string, string>,
): void {
  if (!verifyOutputHashes(projectRoot, runId, outputHashes))
    failA1("OUTPUT_HASH_MISMATCH", "a sealed run output does not match output_hashes");
}

export function isRunReusable(
  projectRoot: string,
  runId: string,
  expectedRunIdentity?: string,
): boolean {
  try {
    const stored = readStoredRun(projectRoot, runId);
    const current = resolveRun(projectRoot, runId);
    return (
      current.run_identity === stored.run_identity &&
      (expectedRunIdentity === undefined || current.run_identity === expectedRunIdentity) &&
      verifyOutputHashes(projectRoot, runId, stored.output_hashes)
    );
  } catch {
    return false;
  }
}

export const canReuseRun = isRunReusable;

export function assertRunReusable(
  projectRoot: string,
  runId: string,
  expectedRunIdentity?: string,
): RunRecord {
  const stored = readStoredRun(projectRoot, runId);
  const current = resolveRun(projectRoot, runId);
  if (current.run_identity !== stored.run_identity)
    failA1("RUN_IDENTITY_STALE", "run_identity changed through a descendant run");
  if (expectedRunIdentity !== undefined && current.run_identity !== expectedRunIdentity)
    failA1("RUN_IDENTITY_MISMATCH", "run identity does not match the requested reuse key");
  assertOutputHashes(projectRoot, runId, stored.output_hashes);
  return current;
}

function scopeRecords(projectRoot: string): ScopeLockRecord[] {
  const filePath = scopeLockPath(projectRoot);
  if (!fs.existsSync(filePath)) return [];
  const value = readStateFile<unknown>(filePath);
  if (!Array.isArray(value))
    failA1("CORRUPT_SCOPE_LOCKS", "scope locks must be an array", filePath);
  return value.map((item, index) => {
    if (!isRecord(item))
      failA1("CORRUPT_SCOPE_LOCKS", "scope lock must be an object", `${filePath}[${index}]`);
    const runId = safeRunId(item.run_id, `${filePath}[${index}].run_id`);
    const scopePath = normalizeScopePath(item.scope_path, `${filePath}[${index}].scope_path`);
    const ownerPid = requireInteger(item.owner_pid, `${filePath}[${index}].owner_pid`, 1);
    const rawTokens = item.lease_tokens;
    const leaseTokens =
      rawTokens === undefined
        ? [`legacy:${ownerPid}:${runId}:${scopePath}`]
        : Array.isArray(rawTokens)
          ? rawTokens.map((token, tokenIndex) =>
              requireString(token, `${filePath}[${index}].lease_tokens[${tokenIndex}]`),
            )
          : (() => {
              failA1(
                "CORRUPT_SCOPE_LOCKS",
                "scope lock lease_tokens must be an array",
                `${filePath}[${index}].lease_tokens`,
              );
            })();
    if (leaseTokens.length === 0)
      failA1("CORRUPT_SCOPE_LOCKS", "scope lock must have a lease token", filePath);
    const rawOwners = item.lease_owners;
    const leaseOwners: Record<string, number> = {};
    if (rawOwners !== undefined) {
      if (!isRecord(rawOwners))
        failA1("CORRUPT_SCOPE_LOCKS", "scope lock lease_owners must be an object", filePath);
      for (const token of leaseTokens) {
        leaseOwners[token] = requireInteger(
          rawOwners[token],
          `${filePath}[${index}].lease_owners.${token}`,
          1,
        );
      }
    } else {
      for (const token of leaseTokens) leaseOwners[token] = ownerPid;
    }
    return {
      schema_version: 1,
      run_id: runId,
      parent_run_id:
        item.parent_run_id === null || item.parent_run_id === undefined
          ? null
          : safeRunId(item.parent_run_id, `${filePath}[${index}].parent_run_id`),
      scope_path: scopePath,
      owner_pid: ownerPid,
      acquired_at: requireString(item.acquired_at, `${filePath}[${index}].acquired_at`),
      lease_tokens: [...new Set(leaseTokens)],
      lease_owners: leaseOwners,
    };
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function relatedRuns(left: RunScopeLockInput, right: ScopeLockRecord): boolean {
  return left.parent_run_id === right.run_id || right.parent_run_id === left.run_id;
}

function isAncestorRun(
  projectRoot: string,
  ancestorRunId: string,
  parentRunId: string | null,
): boolean {
  const seen = new Set<string>();
  let current = parentRunId;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorRunId) return true;
    seen.add(current);
    current = readStoredRun(projectRoot, current).parent_run_id;
  }
  return false;
}

function writeScopeRecords(filePath: string, records: ScopeLockRecord[]): void {
  if (records.length === 0) {
    if (!fs.existsSync(filePath)) return;
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      failA1(
        "RUN_SCOPE_CLEANUP_FAILED",
        `cannot remove empty scope registry: ${String(error)}`,
        filePath,
      );
    }
  } else writeStateJsonAtomic(filePath, records);
}

function releaseScopeLease(
  root: string,
  runId: string,
  scopePath: string,
  leaseToken: string,
): void {
  if (!leaseToken) failA1("RUN_SCOPE_LEASE_REQUIRED", "scope release requires a lease token");
  const filePath = scopeLockPath(root);
  withStateFileLock(filePath, () => {
    const records = scopeRecords(root);
    const record = records.find((item) => item.run_id === runId && item.scope_path === scopePath);
    if (record === undefined)
      failA1("RUN_SCOPE_NOT_FOUND", `no active scope lease for run '${runId}' at '${scopePath}'`);
    if (!record.lease_tokens.includes(leaseToken))
      failA1("RUN_SCOPE_LEASE_REQUIRED", "scope lease token is not held by this run");
    if (record.lease_owners[leaseToken] !== process.pid)
      failA1("RUN_SCOPE_OWNER_MISMATCH", "scope lease belongs to another process");
    record.lease_tokens = record.lease_tokens.filter((token) => token !== leaseToken);
    delete record.lease_owners[leaseToken];
    writeScopeRecords(
      filePath,
      records.filter((item) => item.lease_tokens.length > 0),
    );
  });
}

function releaseAllScopeLeases(
  root: string,
  runId: string,
  scopePath: string,
  currentLeaseToken: string,
  leaseTokens: readonly string[],
  terminal: boolean,
): void {
  if (terminal !== true)
    failA1(
      "RUN_SCOPE_TERMINAL_REQUIRED",
      "all scope leases may be released only after terminal cleanup",
    );
  if (!currentLeaseToken || !leaseTokens.includes(currentLeaseToken))
    failA1("RUN_SCOPE_LEASE_REQUIRED", "all scope leases must include the caller's token");
  const uniqueTokens = [...new Set(leaseTokens)];
  if (uniqueTokens.length !== leaseTokens.length || uniqueTokens.length === 0)
    failA1("RUN_SCOPE_LEASE_REQUIRED", "all active scope lease tokens must be supplied");
  const filePath = scopeLockPath(root);
  withStateFileLock(filePath, () => {
    const records = scopeRecords(root);
    const record = records.find((item) => item.run_id === runId && item.scope_path === scopePath);
    if (record === undefined)
      failA1("RUN_SCOPE_NOT_FOUND", `no active scope lease for run '${runId}' at '${scopePath}'`);
    if (
      record.lease_tokens.length !== uniqueTokens.length ||
      record.lease_tokens.some((token) => !uniqueTokens.includes(token))
    )
      failA1(
        "RUN_SCOPE_LEASE_REQUIRED",
        "terminal cleanup must hold every active scope lease token",
      );
    for (const token of uniqueTokens) {
      if (record.lease_owners[token] !== process.pid)
        failA1("RUN_SCOPE_OWNER_MISMATCH", "scope lease belongs to another process");
    }
    writeScopeRecords(
      filePath,
      records.filter((item) => item !== record),
    );
  });
}

/** Read the durable token set so terminal cleanup can prove it owns every lease. */
export function readRunScopeLeaseTokens(input: RunScopeLockInput): string[] {
  const root = projectRootPath(input.project_root);
  const runId = safeRunId(input.run_id);
  const scopePath = normalizeScopePath(input.scope_path);
  requireRunContract(root, runId);
  const filePath = scopeLockPath(root);
  return withStateFileLock(filePath, () => {
    const record = scopeRecords(root).find(
      (item) => item.run_id === runId && item.scope_path === scopePath,
    );
    if (record === undefined)
      failA1("RUN_SCOPE_NOT_FOUND", `no active scope lease for run '${runId}' at '${scopePath}'`);
    return [...record.lease_tokens];
  });
}

/**
 * Reattach to a scope token already owned by this process. This does not add
 * a token, and the canonical contract is required before the lock file is
 * inspected. It is used when a creation transaction made the durable token
 * before writing run.json and its caller needs a lease object afterward.
 */
export function adoptCurrentRunScopeLease(input: RunScopeLockInput): RunScopeLease {
  const root = projectRootPath(input.project_root);
  const runId = safeRunId(input.run_id);
  const scopePath = normalizeScopePath(input.scope_path);
  const parentRunId =
    input.parent_run_id === undefined || input.parent_run_id === null
      ? null
      : safeRunId(input.parent_run_id, "parent_run_id");
  const existing = requireRunContract(root, runId);
  if (existing.scope_path !== scopePath || existing.parent_run_id !== parentRunId)
    failA1("RUN_SCOPE_ACTIVE", `run '${runId}' has a different scope or parent`);

  const filePath = scopeLockPath(root);
  return withStateFileLock(filePath, () => {
    const record = scopeRecords(root).find(
      (item) => item.run_id === runId && item.scope_path === scopePath,
    );
    if (record === undefined)
      failA1("RUN_SCOPE_NOT_FOUND", `no active scope lease for run '${runId}' at '${scopePath}'`);
    const token = record.lease_tokens.find(
      (candidate) => record.lease_owners[candidate] === process.pid,
    );
    if (token === undefined)
      failA1("RUN_SCOPE_LEASE_REQUIRED", "this process does not own a scope token to adopt");
    return createRunScopeLease(root, runId, scopePath, token, true);
  });
}

function createRunScopeLease(
  root: string,
  runId: string,
  scopePath: string,
  leaseToken: string,
  ownsToken: boolean,
): RunScopeLease {
  let released = false;
  const release = (): void => {
    if (released) failA1("RUN_SCOPE_LEASE_RELEASED", "scope lease was already released");
    if (ownsToken) releaseScopeLease(root, runId, scopePath, leaseToken);
    released = true;
  };
  const releaseAll = (leaseTokens: readonly string[], terminal: true): void => {
    if (released) failA1("RUN_SCOPE_LEASE_RELEASED", "scope lease was already released");
    if (!ownsToken) failA1("RUN_SCOPE_LEASE_REQUIRED", "this lease does not hold a scope token");
    releaseAllScopeLeases(root, runId, scopePath, leaseToken, leaseTokens, terminal);
    released = true;
  };
  return {
    run_id: runId,
    scope_path: scopePath,
    lease_token: ownsToken ? leaseToken : "",
    release,
    releaseAll,
    close: release,
  };
}

function acquireRunScopeInternal(
  input: RunScopeLockInput,
  reuseExisting: boolean,
  allowMissingContract: boolean,
  requireCurrentProcessReservation = false,
): RunScopeLease {
  const root = projectRootPath(input.project_root);
  const runId = safeRunId(input.run_id);
  const scopePath = normalizeScopePath(input.scope_path);
  const parentRunId =
    input.parent_run_id === undefined || input.parent_run_id === null
      ? null
      : safeRunId(input.parent_run_id, "parent_run_id");

  const runPath = runJsonPath(root, runId);
  if (allowMissingContract) {
    if (fs.existsSync(runPath)) {
      const existing = readRun(root, runId);
      if (existing.scope_path !== scopePath || existing.parent_run_id !== parentRunId)
        failA1("RUN_SCOPE_ACTIVE", `run '${runId}' has a different scope or parent`);
    }
  } else {
    const existing = requireRunContract(root, runId);
    if (existing.scope_path !== scopePath || existing.parent_run_id !== parentRunId)
      failA1("RUN_SCOPE_ACTIVE", `run '${runId}' has a different scope or parent`);
  }
  if (parentRunId !== null) {
    const parent = allowMissingContract
      ? readStoredRun(root, parentRunId)
      : requireRunContract(root, parentRunId);
    assertChildScope(parent, scopePath);
  }

  const filePath = scopeLockPath(root);
  const leaseToken = crypto.randomUUID();
  let acquiredToken = true;
  withStateFileLock(filePath, () => {
    const live = scopeRecords(root)
      .map((record) => {
        const liveTokens = record.lease_tokens.filter((token) =>
          processAlive(record.lease_owners[token]!),
        );
        record.lease_tokens = liveTokens;
        for (const token of Object.keys(record.lease_owners)) {
          if (!liveTokens.includes(token)) delete record.lease_owners[token];
        }
        return record;
      })
      .filter((record) => record.lease_tokens.length > 0);
    for (const record of live) {
      if (record.run_id === runId && record.scope_path !== scopePath)
        failA1("RUN_SCOPE_ACTIVE", `run '${runId}' already owns ${record.scope_path}`);
      if (!scopePathsIntersect(record.scope_path, scopePath)) continue;
      if (record.run_id === runId) {
        if (
          requireCurrentProcessReservation &&
          !record.lease_tokens.some((token) => record.lease_owners[token] === process.pid)
        )
          failA1(
            "RUN_SCOPE_ACTIVE",
            `run '${runId}' has a scope reservation owned by another process`,
          );
        if (reuseExisting) {
          acquiredToken = false;
          continue;
        }
        record.lease_tokens.push(leaseToken);
        record.lease_owners[leaseToken] = process.pid;
        acquiredToken = true;
        continue;
      }
      const request = {
        project_root: root,
        run_id: runId,
        parent_run_id: parentRunId,
        scope_path: scopePath,
      };
      if (
        relatedRuns(request, record) ||
        isAncestorRun(root, record.run_id, parentRunId) ||
        isAncestorRun(root, runId, record.parent_run_id)
      )
        continue;
      failA1("RUN_SCOPE_ACTIVE", `scope '${scopePath}' is already owned by run '${record.run_id}'`);
    }
    if (
      acquiredToken &&
      !live.some((record) => record.run_id === runId && record.scope_path === scopePath)
    ) {
      live.push({
        schema_version: 1,
        run_id: runId,
        parent_run_id: parentRunId,
        scope_path: scopePath,
        owner_pid: process.pid,
        acquired_at: new Date().toISOString(),
        lease_tokens: [leaseToken],
        lease_owners: { [leaseToken]: process.pid },
      });
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStateJsonAtomic(filePath, live);
  });

  return createRunScopeLease(root, runId, scopePath, leaseToken, acquiredToken);
}

export function acquireRunScope(input: RunScopeLockInput): RunScopeLease {
  return acquireRunScopeInternal(input, false, false);
}

function acquirePersistentRunScope(
  input: RunScopeLockInput,
  requireCurrentProcessReservation = false,
): RunScopeLease {
  return acquireRunScopeInternal(input, true, true, requireCurrentProcessReservation);
}

export function releaseRunScope(input: RunScopeReleaseInput): void {
  if ((input as RunScopeReleaseInput & { release_all?: boolean }).release_all === true)
    failA1(
      "RUN_SCOPE_RELEASE_ALL_FORBIDDEN",
      "public scope release accepts one lease token; terminal cleanup must hold every token",
    );
  const root = projectRootPath(input.project_root);
  const runId = safeRunId(input.run_id);
  const scopePath = normalizeScopePath(input.scope_path);
  requireRunContract(root, runId);
  releaseScopeLease(root, runId, scopePath, input.lease_token);
}

export function withRunScope<T>(input: RunScopeLockInput, action: (lease: RunScopeLease) => T): T {
  const lease = acquireRunScope(input);
  try {
    return action(lease);
  } finally {
    lease.release();
  }
}

/** Convert a legacy parent field for in-memory use. Writers call stripLegacyParentField. */
export function normalizeLegacyParentRunId(value: JsonObject, location = "run"): string | null {
  if (
    value.parent_run_id !== undefined &&
    value.outer_run_id !== undefined &&
    value.parent_run_id !== value.outer_run_id
  )
    failA1("IDENTITY_MISMATCH", "parent_run_id and outer_run_id disagree", location);
  const parent =
    value.parent_run_id !== undefined ? value.parent_run_id : (value.outer_run_id ?? null);
  return parent === null ? null : safeRunId(parent, `${location}.parent_run_id`);
}

export function stripLegacyParentField<T extends object>(value: T, parentRunId: string | null): T {
  const persisted = { ...(value as Record<string, unknown>) } as T & Record<string, unknown>;
  delete persisted.outer_run_id;
  (persisted as Record<string, unknown>).parent_run_id = parentRunId;
  return persisted as T;
}
