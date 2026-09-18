import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";

export type ScopeMode = "independent" | "bundled";

export interface OptimizablePosition {
  position_id: string;
  mode: ScopeMode;
  bundle_members: string[];
}

export interface BaselineCodeReference {
  ref: string;
  sha256: string;
}

export interface BaselineArtifactReference {
  artifact_ref: string;
  artifact_sha256: string;
}

export interface BaselineValidation {
  scorer_revision: string;
  input_snapshot_sha256: string;
  judge_binding: unknown;
  judge_binding_sha256: string;
  metrics: Record<string, number>;
}

export interface BaselineScope {
  schema_version: 1;
  baseline_id: string;
  workflow_definition: Record<string, unknown>;
  workflow_definition_sha256: string;
  code_baseline: BaselineCodeReference;
  position_artifacts: Record<string, BaselineArtifactReference>;
  initial_validation: BaselineValidation;
  optimizable_scope: OptimizablePosition[];
  max_bundled_positions_per_graph: number;
  baseline_sha256: string;
}

const BASELINE_SCHEMA = "baseline-scope-v1";

function firstProvidedField(value: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(value, name) && value[name] !== undefined) return value[name];
  }
  return undefined;
}

function nonEmptyContent(value: unknown, location: string): unknown {
  if (value === null || value === undefined)
    failA1("INVALID_BASELINE", "value is required", location);
  if (typeof value === "string") return requireString(value, location);
  if (Array.isArray(value) && value.length === 0)
    failA1("INVALID_BASELINE", "array must not be empty", location);
  if (isRecord(value) && Object.keys(value).length === 0)
    failA1("INVALID_BASELINE", "object must not be empty", location);
  return value;
}

function extractPositionIds(
  workflow: Record<string, unknown>,
  artifactIds: readonly string[],
): string[] {
  const rawPositions = workflow.positions;
  if (Array.isArray(rawPositions)) {
    const ids = rawPositions.map((position, index) => {
      if (typeof position === "string")
        return assertIdentifier(position, `workflow_definition.positions[${index}]`);
      if (!isRecord(position))
        failA1(
          "INVALID_BASELINE",
          "workflow position must be an object or id",
          `workflow_definition.positions[${index}]`,
        );
      return assertIdentifier(
        firstProvidedField(position, ["position_id", "id"]),
        `workflow_definition.positions[${index}].position_id`,
      );
    });
    if (new Set(ids).size !== ids.length)
      failA1(
        "DUPLICATE_ID",
        "workflow position ids must be unique",
        "workflow_definition.positions",
      );
    return ids;
  }
  const rawModules = workflow.modules;
  if (Array.isArray(rawModules)) {
    const ids = rawModules.map((module, index) => {
      if (!isRecord(module))
        failA1(
          "INVALID_BASELINE",
          "workflow module must be an object",
          `workflow_definition.modules[${index}]`,
        );
      return assertIdentifier(
        firstProvidedField(module, ["id", "position_id"]),
        `workflow_definition.modules[${index}].id`,
      );
    });
    if (new Set(ids).size !== ids.length)
      failA1("DUPLICATE_ID", "workflow module ids must be unique", "workflow_definition.modules");
    return ids;
  }
  if (Array.isArray(workflow.position_ids)) {
    const ids = workflow.position_ids.map((id, index) =>
      assertIdentifier(id, `workflow_definition.position_ids[${index}]`),
    );
    if (new Set(ids).size !== ids.length)
      failA1(
        "DUPLICATE_ID",
        "workflow position ids must be unique",
        "workflow_definition.position_ids",
      );
    return ids;
  }
  return [...artifactIds];
}

function normalizeCodeBaseline(value: unknown): BaselineCodeReference {
  if (typeof value === "string") {
    const ref = requireString(value, "baseline.code_baseline");
    return {
      ref,
      sha256: canonicalJsonSha256({ ref }, undefined, { schemaVersion: "code-baseline-ref-v1" }),
    };
  }
  if (!isRecord(value))
    failA1("INVALID_BASELINE", "code_baseline must be a ref or object", "baseline.code_baseline");
  assertNoUnknownFields(
    value,
    ["ref", "commit", "sha256", "code_baseline_sha256"],
    "baseline.code_baseline",
  );
  const ref = requireString(
    firstProvidedField(value, ["ref", "commit"]),
    "baseline.code_baseline.ref",
  );
  const suppliedHash = firstProvidedField(value, ["sha256", "code_baseline_sha256"]);
  const sha256 =
    suppliedHash === undefined
      ? canonicalJsonSha256({ ref }, undefined, { schemaVersion: "code-baseline-ref-v1" })
      : assertSha256(suppliedHash, "baseline.code_baseline.sha256");
  return { ref, sha256 };
}

function normalizeArtifacts(value: unknown): Record<string, BaselineArtifactReference> {
  const result: Record<string, BaselineArtifactReference> = {};
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const location = `baseline.position_artifacts[${index}]`;
      if (!isRecord(item))
        failA1("INVALID_BASELINE", "artifact reference must be an object", location);
      assertNoUnknownFields(
        item,
        ["position_id", "id", "artifact_ref", "artifact_id", "artifact_sha256", "sha256"],
        location,
      );
      const positionId = assertIdentifier(
        firstProvidedField(item, ["position_id", "id"]),
        `${location}.position_id`,
      );
      if (Object.hasOwn(result, positionId))
        failA1("DUPLICATE_ID", `artifact for '${positionId}' is repeated`, location);
      result[positionId] = {
        artifact_ref: requireString(
          firstProvidedField(item, ["artifact_ref", "artifact_id"]),
          `${location}.artifact_ref`,
        ),
        artifact_sha256: assertSha256(
          firstProvidedField(item, ["artifact_sha256", "sha256"]),
          `${location}.artifact_sha256`,
        ),
      };
    });
    return result;
  }
  if (!isRecord(value))
    failA1(
      "INVALID_BASELINE",
      "position_artifacts must be an object or array",
      "baseline.position_artifacts",
    );
  for (const [key, raw] of Object.entries(value)) {
    const positionId = assertIdentifier(key, `baseline.position_artifacts.${key}`);
    if (!isRecord(raw))
      failA1(
        "INVALID_BASELINE",
        "artifact reference must be an object",
        `baseline.position_artifacts.${key}`,
      );
    assertNoUnknownFields(
      raw,
      ["artifact_ref", "artifact_id", "artifact_sha256", "sha256"],
      `baseline.position_artifacts.${key}`,
    );
    result[positionId] = {
      artifact_ref: requireString(
        firstProvidedField(raw, ["artifact_ref", "artifact_id"]),
        `baseline.position_artifacts.${key}.artifact_ref`,
      ),
      artifact_sha256: assertSha256(
        firstProvidedField(raw, ["artifact_sha256", "sha256"]),
        `baseline.position_artifacts.${key}.artifact_sha256`,
      ),
    };
  }
  return result;
}

function normalizeMetrics(value: unknown, location: string): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) failA1("INVALID_BASELINE", "metrics must be an object", location);
  const result: Record<string, number> = {};
  for (const [key, metric] of Object.entries(value)) {
    result[requireString(key, `${location}.${key}`)] = requireFiniteNumber(
      metric,
      `${location}.${key}`,
    );
  }
  return result;
}

function normalizeValidation(value: unknown): BaselineValidation {
  if (!isRecord(value))
    failA1(
      "INVALID_BASELINE",
      "initial_validation must be an object",
      "baseline.initial_validation",
    );
  assertNoUnknownFields(
    value,
    [
      "scorer_revision",
      "scorer_id",
      "input_snapshot_sha256",
      "judge_binding",
      "judge_binding_sha256",
      "metrics",
    ],
    "baseline.initial_validation",
  );
  const scorerRevision = assertIdentifier(
    firstProvidedField(value, ["scorer_revision", "scorer_id"]),
    "baseline.initial_validation.scorer_revision",
  );
  const inputSnapshotSha256 = assertSha256(
    value.input_snapshot_sha256,
    "baseline.initial_validation.input_snapshot_sha256",
  );
  if (!Object.hasOwn(value, "judge_binding"))
    failA1(
      "INVALID_BASELINE",
      "judge_binding is required",
      "baseline.initial_validation.judge_binding",
    );
  const judgeBinding =
    value.judge_binding === null
      ? null
      : nonEmptyContent(value.judge_binding, "baseline.initial_validation.judge_binding");
  const judgeBindingSha256 = canonicalJsonSha256(judgeBinding, undefined, {
    schemaVersion: "judge-binding-v1",
  });
  if (
    value.judge_binding_sha256 !== undefined &&
    assertSha256(value.judge_binding_sha256, "baseline.initial_validation.judge_binding_sha256") !==
      judgeBindingSha256
  )
    failA1(
      "BASELINE_HASH_MISMATCH",
      "judge binding hash does not match judge_binding",
      "baseline.initial_validation.judge_binding_sha256",
    );
  return {
    scorer_revision: scorerRevision,
    input_snapshot_sha256: inputSnapshotSha256,
    judge_binding: judgeBinding,
    judge_binding_sha256: judgeBindingSha256,
    metrics: normalizeMetrics(value.metrics, "baseline.initial_validation.metrics"),
  };
}

function normalizeScopeEntry(value: unknown, index: number): OptimizablePosition {
  const location = `baseline.optimizable_scope[${index}]`;
  if (typeof value === "string") {
    return {
      position_id: assertIdentifier(value, location),
      mode: "independent",
      bundle_members: [],
    };
  }
  if (!isRecord(value)) failA1("INVALID_BASELINE", "scope entry must be an object or id", location);
  assertNoUnknownFields(
    value,
    ["position_id", "id", "mode", "acceptance", "bundle_members", "members"],
    location,
  );
  const modeValue = firstProvidedField(value, ["mode", "acceptance"]);
  if (modeValue !== "independent" && modeValue !== "bundled")
    failA1("INVALID_BASELINE", "scope mode must be independent or bundled", `${location}.mode`);
  const positionId = assertIdentifier(
    firstProvidedField(value, ["position_id", "id"]),
    `${location}.position_id`,
  );
  const rawMembers = firstProvidedField(value, ["bundle_members", "members"]);
  if (modeValue === "independent") {
    if (rawMembers !== undefined && (!Array.isArray(rawMembers) || rawMembers.length !== 0))
      failA1(
        "INVALID_BASELINE",
        "independent positions cannot have bundle members",
        `${location}.bundle_members`,
      );
    return { position_id: positionId, mode: "independent", bundle_members: [] };
  }
  if (!Array.isArray(rawMembers) || rawMembers.length < 2)
    failA1(
      "INVALID_BASELINE",
      "bundled positions need at least two bundle members",
      `${location}.bundle_members`,
    );
  const bundleMembers = rawMembers.map((member, memberIndex) =>
    assertIdentifier(member, `${location}.bundle_members[${memberIndex}]`),
  );
  if (new Set(bundleMembers).size !== bundleMembers.length)
    failA1("DUPLICATE_ID", "bundle members must be unique", `${location}.bundle_members`);
  if (!bundleMembers.includes(positionId))
    failA1(
      "INVALID_BASELINE",
      "bundle members must include the scoped position",
      `${location}.bundle_members`,
    );
  bundleMembers.sort(compareIdentityStrings);
  return { position_id: positionId, mode: "bundled", bundle_members: bundleMembers };
}

function normalizeScope(value: unknown, positionIds: readonly string[]): OptimizablePosition[] {
  if (!Array.isArray(value))
    failA1("INVALID_BASELINE", "optimizable_scope must be an array", "baseline.optimizable_scope");
  const scope = value.map((entry, index) => normalizeScopeEntry(entry, index));
  if (new Set(scope.map((entry) => entry.position_id)).size !== scope.length)
    failA1("DUPLICATE_ID", "optimizable position ids must be unique", "baseline.optimizable_scope");
  const known = new Set(positionIds);
  for (const entry of scope) {
    if (positionIds.length > 0 && !known.has(entry.position_id))
      failA1(
        "INVALID_BASELINE",
        `position '${entry.position_id}' is not in the workflow`,
        "baseline.optimizable_scope",
      );
    for (const member of entry.bundle_members) {
      if (positionIds.length > 0 && !known.has(member))
        failA1(
          "INVALID_BASELINE",
          `bundle member '${member}' is not in the workflow`,
          "baseline.optimizable_scope",
        );
    }
  }
  const claimedMembers = new Set<string>();
  const scopedPositionIds = new Set(scope.map((entry) => entry.position_id));
  for (const entry of scope) {
    for (const member of entry.bundle_members) {
      if (member !== entry.position_id && scopedPositionIds.has(member))
        failA1(
          "INVALID_BASELINE",
          `bundle member '${member}' is also a separate optimizable position`,
          "baseline.optimizable_scope",
        );
      if (claimedMembers.has(member))
        failA1(
          "INVALID_BASELINE",
          `bundle member '${member}' appears in more than one position`,
          "baseline.optimizable_scope",
        );
      claimedMembers.add(member);
    }
  }
  return scope.sort((left, right) => compareIdentityStrings(left.position_id, right.position_id));
}

export function normalizeOptimizableScope(
  value: unknown,
  positionIds: readonly string[] = [],
): OptimizablePosition[] {
  return normalizeScope(value, positionIds);
}

function maxBundledLimit(value: unknown): number {
  if (!isRecord(value))
    failA1("WORKFLOW_LIMITS_REQUIRED", "owner_limits must be an object", "owner_limits");
  if (!Object.hasOwn(value, "max_bundled_positions_per_graph"))
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "max_bundled_positions_per_graph is required",
      "owner_limits.max_bundled_positions_per_graph",
    );
  return requireInteger(
    value.max_bundled_positions_per_graph,
    "owner_limits.max_bundled_positions_per_graph",
    0,
  );
}

function baselineWithoutHash(value: Omit<BaselineScope, "baseline_sha256">): object {
  return {
    schema_version: value.schema_version,
    baseline_id: value.baseline_id,
    workflow_definition: value.workflow_definition,
    workflow_definition_sha256: value.workflow_definition_sha256,
    code_baseline: value.code_baseline,
    position_artifacts: value.position_artifacts,
    initial_validation: value.initial_validation,
    optimizable_scope: value.optimizable_scope,
    max_bundled_positions_per_graph: value.max_bundled_positions_per_graph,
  };
}

function baselineHash(value: Omit<BaselineScope, "baseline_sha256">): string {
  return canonicalJsonSha256(baselineWithoutHash(value), undefined, {
    schemaVersion: BASELINE_SCHEMA,
  });
}

export function createBaselineScope(input: unknown): BaselineScope {
  if (!isRecord(input)) failA1("INVALID_BASELINE", "baseline input must be an object", "baseline");
  assertNoUnknownFields(
    input,
    [
      "schema_version",
      "baseline_id",
      "workflow_definition",
      "workflow",
      "definition",
      "code_baseline",
      "code_baseline_ref",
      "code_baseline_sha256",
      "position_artifacts",
      "initial_artifacts",
      "artifacts",
      "initial_validation",
      "validation",
      "optimizable_scope",
      "scope",
      "owner_limits",
      "max_bundled_positions_per_graph",
    ],
    "baseline",
  );
  if (input.schema_version !== undefined && input.schema_version !== 1)
    failA1("INVALID_BASELINE", "baseline schema_version must be 1", "baseline.schema_version");
  const workflowValue = firstProvidedField(input, [
    "workflow_definition",
    "workflow",
    "definition",
  ]);
  if (!isRecord(workflowValue))
    failA1("INVALID_BASELINE", "workflow_definition is required", "baseline.workflow_definition");
  const artifacts = normalizeArtifacts(
    firstProvidedField(input, ["position_artifacts", "initial_artifacts", "artifacts"]),
  );
  const positionIds = extractPositionIds(workflowValue, Object.keys(artifacts));
  if (positionIds.length === 0)
    failA1(
      "INVALID_BASELINE",
      "baseline needs at least one workflow position",
      "baseline.workflow_definition",
    );
  for (const positionId of positionIds)
    if (!Object.hasOwn(artifacts, positionId))
      failA1(
        "INVALID_BASELINE",
        `baseline artifact for '${positionId}' is missing`,
        "baseline.position_artifacts",
      );
  const scope = normalizeScope(
    firstProvidedField(input, ["optimizable_scope", "scope"]),
    positionIds,
  );
  const limitValue =
    input.max_bundled_positions_per_graph !== undefined
      ? input.max_bundled_positions_per_graph
      : isRecord(input.owner_limits)
        ? input.owner_limits.max_bundled_positions_per_graph
        : undefined;
  const maxBundled = maxBundledLimit({ max_bundled_positions_per_graph: limitValue });
  const bundledCount = scope.filter((entry) => entry.mode === "bundled").length;
  if (bundledCount > maxBundled)
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "bundled positions exceed max_bundled_positions_per_graph",
      "baseline.optimizable_scope",
    );
  const codeValue =
    input.code_baseline !== undefined
      ? input.code_baseline
      : {
          ref: input.code_baseline_ref,
          sha256: input.code_baseline_sha256,
        };
  const codeBaseline = normalizeCodeBaseline(codeValue);
  const initialValidation = normalizeValidation(
    input.initial_validation !== undefined ? input.initial_validation : input.validation,
  );
  const baselineWithoutDigest: Omit<BaselineScope, "baseline_sha256"> = {
    schema_version: 1,
    baseline_id:
      input.baseline_id === undefined
        ? "W_0"
        : assertIdentifier(input.baseline_id, "baseline.baseline_id"),
    workflow_definition: workflowValue,
    workflow_definition_sha256: canonicalJsonSha256(workflowValue, undefined, {
      schemaVersion: "workflow-definition-v1",
    }),
    code_baseline: codeBaseline,
    position_artifacts: artifacts,
    initial_validation: initialValidation,
    optimizable_scope: scope,
    max_bundled_positions_per_graph: maxBundled,
  };
  return { ...baselineWithoutDigest, baseline_sha256: baselineHash(baselineWithoutDigest) };
}

export function validateBaselineScope(value: unknown, location = "baseline"): BaselineScope {
  if (!isRecord(value)) failA1("CORRUPT_BASELINE", "baseline must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "baseline_id",
      "workflow_definition",
      "workflow_definition_sha256",
      "code_baseline",
      "position_artifacts",
      "initial_validation",
      "optimizable_scope",
      "max_bundled_positions_per_graph",
      "baseline_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_BASELINE", "baseline schema_version must be 1", location);
  if (!Object.hasOwn(value, "baseline_id"))
    failA1("CORRUPT_BASELINE", "baseline_id is required", `${location}.baseline_id`);
  const created = createBaselineScope({
    schema_version: 1,
    baseline_id: value.baseline_id,
    workflow_definition: value.workflow_definition,
    code_baseline: value.code_baseline,
    position_artifacts: value.position_artifacts,
    initial_validation: value.initial_validation,
    optimizable_scope: value.optimizable_scope,
    max_bundled_positions_per_graph: value.max_bundled_positions_per_graph,
  });
  if (created.workflow_definition_sha256 !== value.workflow_definition_sha256)
    failA1("CORRUPT_BASELINE", "workflow definition hash does not match", location);
  const digest = assertSha256(value.baseline_sha256, `${location}.baseline_sha256`);
  if (digest !== created.baseline_sha256)
    failA1("BASELINE_HASH_MISMATCH", "baseline hash does not match its fields", location);
  return { ...created, baseline_sha256: digest };
}

export function baselineScopeSha256(value: unknown): string {
  return validateBaselineScope(value).baseline_sha256;
}

export function baselineScopePath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "baseline.json");
}

export function saveBaselineScope(
  projectRoot: string,
  runId: string,
  value: unknown,
): BaselineScope;
export function saveBaselineScope(input: {
  project_root: string;
  run_id: string;
  baseline: unknown;
}): BaselineScope;
export function saveBaselineScope(
  first: string | { project_root: string; run_id: string; baseline: unknown },
  second?: string,
  third?: unknown,
): BaselineScope {
  const projectRoot = typeof first === "string" ? first : first.project_root;
  const runId = typeof first === "string" ? second : first.run_id;
  const value = typeof first === "string" ? third : first.baseline;
  if (runId === undefined) failA1("INVALID_VALUE", "run_id is required", "run_id");
  const contract = requireRunContract(projectRoot, runId);
  const baseline = validateBaselineScope(value);
  const filePath = baselineScopePath(projectRoot, runId);
  if (contract.run_id !== runId) failA1("IDENTITY_MISMATCH", "baseline run id mismatch", filePath);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateBaselineScope(readStateFile(filePath), filePath);
      if (existing.baseline_sha256 === baseline.baseline_sha256) return existing;
      failA1("IMMUTABLE_CONFLICT", "baseline is immutable", filePath);
    }
    writeStateJsonAtomic(filePath, baseline);
    return baseline;
  });
}

export function readBaselineScope(projectRoot: string, runId: string): BaselineScope {
  const contract = requireRunContract(projectRoot, runId);
  const filePath = baselineScopePath(projectRoot, runId);
  if (!fs.existsSync(filePath))
    failA1("BASELINE_NOT_FOUND", `baseline is missing at ${filePath}`, filePath);
  const baseline = validateBaselineScope(readStateFile(filePath), filePath);
  if (contract.run_id !== runId) failA1("IDENTITY_MISMATCH", "baseline run id mismatch", filePath);
  return baseline;
}

function normalizedScope(value: unknown): OptimizablePosition[] {
  if (isRecord(value) && Array.isArray(value.optimizable_scope))
    return normalizeScope(value.optimizable_scope, []);
  if (Array.isArray(value)) return normalizeScope(value, []);
  failA1("INVALID_BASELINE", "optimizable scope must be a baseline or array", "optimizable_scope");
}

function scopeEntryKey(entry: OptimizablePosition): string {
  return canonicalJsonSha256(entry, undefined, { schemaVersion: "optimizable-position-v1" });
}

/** A child may keep only an atomic position already granted by its parent. */
export function assertOptimizableScopeSubset(parentValue: unknown, childValue: unknown): void {
  const parent = normalizedScope(parentValue);
  const child = normalizedScope(childValue);
  const parentById = new Map(parent.map((entry) => [entry.position_id, entry]));
  for (const childEntry of child) {
    const parentEntry = parentById.get(childEntry.position_id);
    if (parentEntry === undefined || scopeEntryKey(parentEntry) !== scopeEntryKey(childEntry))
      failA1(
        "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED",
        `child position '${childEntry.position_id}' is outside the parent optimizable scope`,
      );
  }
}

export const assertScopeSubset = assertOptimizableScopeSubset;

export function baselineMatchesValidation(
  baselineValue: unknown,
  validationValue: unknown,
): boolean {
  const baseline = validateBaselineScope(baselineValue);
  const validation = normalizeValidation(validationValue);
  return (
    baseline.initial_validation.scorer_revision === validation.scorer_revision &&
    baseline.initial_validation.input_snapshot_sha256 === validation.input_snapshot_sha256 &&
    baseline.initial_validation.judge_binding_sha256 === validation.judge_binding_sha256
  );
}

export function assertBaselineComparable(baselineValue: unknown, validationValue: unknown): void {
  if (!baselineMatchesValidation(baselineValue, validationValue))
    failA1(
      "BASELINE_COMPARISON_MISMATCH",
      "baseline and comparison validation use different scorer, input snapshot, or judge binding",
    );
}

export const createBaseline = createBaselineScope;
export const validateBaseline = validateBaselineScope;
export const saveBaseline = saveBaselineScope;
export const readBaseline = readBaselineScope;
