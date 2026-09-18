import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireInteger,
  requireString,
  validateWorkflowSpec,
  type WorkflowSpec,
} from "./workflow-spec.js";
import {
  candidateIdFromSnapshot,
  compileWorkflow,
  parseStructureActions,
  validateCandidateSnapshot,
  type CandidateIdentityInput,
  type CandidateSnapshot,
  type CompiledWorkflow,
  type StructureAction,
} from "./workflow-compiler.js";
import { beginOrdinaryWave, finishOrdinaryWave } from "./scorer-state.js";
import { readFrozenPolicy, workflowCycleDirectory } from "./workflow-state.js";
import { readOuterRunState, type OuterRunIdentity } from "./workflow-runtime.js";
import { readStoredReviewReceipt, type ReviewReceipt } from "./review-submit.js";

/**
 * A structure proposal is one indivisible change to the workflow graph. The
 * proposal owns both candidates: S0 is the current graph and S1 is the graph
 * after the normalized actions. Keeping both in one record prevents a caller
 * from silently replacing a failed structure with a second candidate.
 */
export interface StructureProposalInput {
  proposal_id: string;
  baseline_revision: string;
  baseline_spec_sha256: string;
  structure_actions: readonly StructureAction[];
  module_version_manifest: Record<string, string>;
  model_scope_confirmation: {
    status: "confirmed";
    task_setup_revision: string;
    role_ids: readonly string[];
  };
  s0_candidate: unknown;
  s1_candidate: unknown;
  comparison_binding: {
    input_snapshot_sha256: string;
    scorer_revision: string;
    model_assignment_sha256: string;
    seed_manifest_sha256: string;
    repeat_ids: readonly string[];
  };
}

export interface PrepareStructureWaveInput extends OuterRunIdentity {
  outer_iteration: number;
  generation: number;
  wave_id: string;
  workflow_spec: unknown;
  proposals: readonly StructureProposalInput[];
}

export type StructureWaveStatus = "prepared" | "reviewed" | "rejected";

export interface StructureWaveCandidate {
  label: "S0" | "S1";
  candidate_id: string;
  candidate: CandidateSnapshot;
  compilation: CompiledWorkflow;
  compilation_sha256: string;
}

export interface StructureWaveRecord {
  schema_version: 1;
  outer_run_id: string;
  outer_iteration: number;
  generation: number;
  wave_id: string;
  workflow_id: string;
  proposal_id: string;
  structure_delta_id: string;
  baseline_revision: string;
  baseline_spec_sha256: string;
  module_version_manifest_sha256: string;
  comparison_binding: {
    input_snapshot_sha256: string;
    scorer_revision: string;
    model_assignment_sha256: string;
    seed_manifest_sha256: string;
    repeat_ids: string[];
  };
  s0: StructureWaveCandidate;
  s1: StructureWaveCandidate;
  status: StructureWaveStatus;
  review_id: string | null;
  review_receipt_sha256: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordStructureReviewInput extends OuterRunIdentity {
  outer_iteration: number;
  review: unknown;
}

function waveDirectory(projectRoot: string, outerRunId: string, outerIteration: number): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "structure-wave",
  );
}

function waveStatePath(projectRoot: string, outerRunId: string, outerIteration: number): string {
  return path.join(
    path.dirname(waveDirectory(projectRoot, outerRunId, outerIteration)),
    "structure-wave.json",
  );
}

function hash(value: unknown, schemaVersion: string): string {
  return canonicalJsonSha256(value, undefined, { schemaVersion });
}

function immutableJson(filePath: string, value: unknown, schemaVersion: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (hash(existing, schemaVersion) !== hash(value, schemaVersion))
        failA1("IMMUTABLE_CONFLICT", "structure wave artifact cannot change", filePath);
      return;
    }
    writeStateJsonAtomic(filePath, value);
  });
}

function ensureStructureWaveMarker(projectRoot: string, outerRunId: string): void {
  const markerPath = path.join(path.resolve(projectRoot), ".aris", "active-wave.json");
  if (fs.existsSync(markerPath)) {
    const marker = readStateFile(markerPath);
    if (
      isRecord(marker) &&
      marker.status === "running" &&
      marker.wave_kind === "structure" &&
      marker.run_id === outerRunId
    )
      return;
  }
  beginOrdinaryWave(projectRoot, "structure", outerRunId);
}

function assertStructureCycle(input: PrepareStructureWaveInput): WorkflowSpec {
  const outer = readOuterRunState(input);
  if (
    outer.active_cycle === null ||
    outer.active_cycle.outer_iteration !==
      requireInteger(input.outer_iteration, "outer_iteration", 1) ||
    outer.active_cycle.generation !== requireInteger(input.generation, "generation", 1) ||
    outer.active_cycle.wave_id !== assertIdentifier(input.wave_id, "wave_id") ||
    outer.active_cycle.wave_kind !== "structure"
  )
    failA1("STRUCTURE_WAVE_REQUIRED", "the requested outer cycle is not the active structure wave");
  if (outer.children.some((child) => child.outer_iteration === outer.active_cycle!.outer_iteration))
    failA1(
      "STRUCTURE_CHILD_CONFLICT",
      "a structure proposal must be frozen before any child run is registered",
    );
  const frozen = readFrozenPolicy(input.project_root, input.outer_run_id);
  const spec = validateWorkflowSpec(input.workflow_spec);
  if (
    spec.workflow_id !== outer.workflow_id ||
    spec.task_id !== outer.task_id ||
    spec.task_setup_revision !== frozen.task_setup_revision
  )
    failA1("IDENTITY_MISMATCH", "structure workflow does not match the frozen outer setup");
  return spec;
}

function validateVersionManifest(
  spec: WorkflowSpec,
  manifestValue: unknown,
  candidateModuleIds: readonly string[],
): Record<string, string> {
  if (!isRecord(manifestValue))
    failA1("MODULE_VERSION_FREEZE_REQUIRED", "module_version_manifest must be an object");
  const manifest: Record<string, string> = {};
  for (const [moduleId, version] of Object.entries(manifestValue)) {
    manifest[assertIdentifier(moduleId, "module_version_manifest.module_id")] = requireString(
      version,
      `module_version_manifest.${moduleId}`,
    );
  }
  const catalog = new Map(spec.module_catalog.map((module) => [module.id, module]));
  const required = [...new Set(candidateModuleIds)].sort(compareIdentityStrings);
  for (const moduleId of required) {
    const module = catalog.get(moduleId);
    if (!module || module.version === undefined)
      failA1("MODULE_VERSION_FREEZE_REQUIRED", `module '${moduleId}' has no registered version`);
    if (manifest[moduleId] !== module.version)
      failA1(
        "MODULE_VERSION_FREEZE_REQUIRED",
        `module '${moduleId}' is not bound to its registered baseline version`,
      );
  }
  return manifest;
}

function validateConfirmation(spec: WorkflowSpec, value: unknown, taskSetupRevision: string): void {
  if (!isRecord(value) || value.status !== "confirmed")
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "structure roles need explicit user confirmation");
  if (value.task_setup_revision !== taskSetupRevision)
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "structure confirmation uses another task setup");
  if (!Array.isArray(value.role_ids))
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "structure confirmation must list model roles");
  const roleIds = value.role_ids.map((role, index) =>
    assertIdentifier(role, `model_scope_confirmation.role_ids[${index}]`),
  );
  const expected = spec.model_usage_policy.roles
    .map((role) => role.role_id)
    .sort(compareIdentityStrings);
  const actual = [...new Set(roleIds)].sort(compareIdentityStrings);
  if (expected.length !== actual.length || expected.some((role, index) => role !== actual[index]))
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "structure confirmation does not cover all roles");
}

function normalizeBinding(value: unknown): StructureWaveRecord["comparison_binding"] {
  if (!isRecord(value)) failA1("STRUCTURE_COMPARISON_INCOMPLETE", "comparison_binding is required");
  if (!Array.isArray(value.repeat_ids) || value.repeat_ids.length === 0)
    failA1("STRUCTURE_COMPARISON_INCOMPLETE", "comparison_binding.repeat_ids is required");
  const repeatIds = value.repeat_ids.map((repeat, index) =>
    assertIdentifier(repeat, `comparison_binding.repeat_ids[${index}]`),
  );
  if (new Set(repeatIds).size !== repeatIds.length)
    failA1("DUPLICATE_ID", "comparison repeat ids must be unique");
  return {
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      "comparison_binding.input_snapshot_sha256",
    ),
    scorer_revision: assertIdentifier(value.scorer_revision, "comparison_binding.scorer_revision"),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      "comparison_binding.model_assignment_sha256",
    ),
    seed_manifest_sha256: assertSha256(
      value.seed_manifest_sha256,
      "comparison_binding.seed_manifest_sha256",
    ),
    repeat_ids: repeatIds,
  };
}

function candidate(
  label: "S0" | "S1",
  value: unknown,
  spec: WorkflowSpec,
  projectRoot: string,
  options: Parameters<typeof compileWorkflow>[1],
): StructureWaveCandidate {
  const parsed = validateCandidateSnapshot(value);
  const compiled = compileWorkflow(spec, {
    ...options,
    workspace_root: projectRoot,
    candidate: parsed as unknown as CandidateIdentityInput,
  });
  const candidateId = candidateIdFromSnapshot(parsed, projectRoot);
  if (compiled.candidate_id !== candidateId)
    failA1("CANDIDATE_IDENTITY_MISMATCH", `${label} compiler identity differs from candidate`);
  return {
    label,
    candidate_id: candidateId,
    candidate: parsed,
    compilation: compiled,
    compilation_sha256: hash(compiled, "compiled-workflow-v1"),
  };
}

function validateRecord(value: unknown, filePath: string): StructureWaveRecord {
  if (!isRecord(value))
    failA1("CORRUPT_STRUCTURE_WAVE", "structure wave state must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "outer_run_id",
      "outer_iteration",
      "generation",
      "wave_id",
      "workflow_id",
      "proposal_id",
      "structure_delta_id",
      "baseline_revision",
      "baseline_spec_sha256",
      "module_version_manifest_sha256",
      "comparison_binding",
      "s0",
      "s1",
      "status",
      "review_id",
      "review_receipt_sha256",
      "created_at",
      "updated_at",
    ],
    filePath,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_STRUCTURE_WAVE", "structure wave schema_version must be 1", filePath);
  if (value.status !== "prepared" && value.status !== "reviewed" && value.status !== "rejected")
    failA1("CORRUPT_STRUCTURE_WAVE", "structure wave status is invalid", filePath);
  return value as unknown as StructureWaveRecord;
}

export function structureWaveStatePath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return waveStatePath(projectRoot, outerRunId, outerIteration);
}

export function readStructureWave(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): StructureWaveRecord {
  const filePath = waveStatePath(projectRoot, outerRunId, outerIteration);
  if (!fs.existsSync(filePath))
    failA1("STRUCTURE_WAVE_NOT_FOUND", `no structure wave at ${filePath}`);
  return validateRecord(readStateFile(filePath), filePath);
}

export function prepareStructureWave(input: PrepareStructureWaveInput): StructureWaveRecord {
  const spec = assertStructureCycle(input);
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  const generation = requireInteger(input.generation, "generation", 1);
  const waveId = assertIdentifier(input.wave_id, "wave_id");
  if (!Array.isArray(input.proposals) || input.proposals.length !== 1)
    failA1("STRUCTURE_PROPOSAL_REQUIRED", "a structure wave must contain exactly one proposal");
  const proposal = input.proposals[0]!;
  if (!isRecord(proposal))
    failA1("INVALID_STRUCTURE_DELTA", "structure proposal must be an object");
  const proposalId = assertIdentifier(proposal.proposal_id, "proposal_id");
  const baselineRevision = assertIdentifier(proposal.baseline_revision, "baseline_revision");
  if (baselineRevision !== spec.revision)
    failA1("STRUCTURE_BASELINE_CONFLICT", "structure proposal baseline is not the active revision");
  const specHash = hash(spec, "workflow-spec-v1");
  if (assertSha256(proposal.baseline_spec_sha256, "baseline_spec_sha256") !== specHash)
    failA1("STRUCTURE_BASELINE_CONFLICT", "structure proposal baseline hash differs");
  const frozen = readFrozenPolicy(input.project_root, input.outer_run_id);
  validateConfirmation(spec, proposal.model_scope_confirmation, frozen.task_setup_revision);
  const actions = parseStructureActions(proposal.structure_actions);
  const s0 = candidate("S0", proposal.s0_candidate, spec, input.project_root, {
    wave_kind: "module",
  });
  const s1 = candidate("S1", proposal.s1_candidate, spec, input.project_root, {
    wave_kind: "structure",
    structure_actions: actions,
  });
  if (s0.candidate_id === s1.candidate_id)
    failA1("STRUCTURE_DELTA_EMPTY", "S0 and S1 must be different candidates");
  const activeIds = [
    ...s0.compilation.execution_graph.nodes.map((node) => node.module_id),
    ...s1.compilation.execution_graph.nodes.map((node) => node.module_id),
  ];
  const moduleVersionManifest = validateVersionManifest(
    spec,
    proposal.module_version_manifest,
    activeIds,
  );
  const comparisonBinding = normalizeBinding(proposal.comparison_binding);
  const deltaId = s1.compilation.structure_delta_id;
  if (deltaId === null) failA1("INVALID_STRUCTURE_DELTA", "S1 did not produce a structure delta");
  const recordBase = {
    schema_version: 1 as const,
    outer_run_id: input.outer_run_id,
    outer_iteration: outerIteration,
    generation,
    wave_id: waveId,
    workflow_id: spec.workflow_id,
    proposal_id: proposalId,
    structure_delta_id: deltaId,
    baseline_revision: baselineRevision,
    baseline_spec_sha256: specHash,
    module_version_manifest_sha256: hash(moduleVersionManifest, "module-version-manifest-v1"),
    comparison_binding: comparisonBinding,
    s0,
    s1,
    status: "prepared" as const,
    review_id: null,
    review_receipt_sha256: null,
  };
  const filePath = waveStatePath(input.project_root, input.outer_run_id, outerIteration);
  const existing = fs.existsSync(filePath)
    ? validateRecord(readStateFile(filePath), filePath)
    : null;
  if (existing !== null) {
    const existingBase = { ...existing } as Record<string, unknown>;
    delete existingBase.created_at;
    delete existingBase.updated_at;
    delete existingBase.status;
    delete existingBase.review_id;
    delete existingBase.review_receipt_sha256;
    const proposedBase = { ...recordBase } as Record<string, unknown>;
    delete proposedBase.status;
    delete proposedBase.review_id;
    delete proposedBase.review_receipt_sha256;
    if (hash(existingBase, "structure-wave-v1") !== hash(proposedBase, "structure-wave-v1"))
      failA1("IMMUTABLE_CONFLICT", "structure wave already contains another proposal", filePath);
    ensureStructureWaveMarker(input.project_root, input.outer_run_id);
    return existing;
  }
  ensureStructureWaveMarker(input.project_root, input.outer_run_id);
  const now = new Date().toISOString();
  const record: StructureWaveRecord = { ...recordBase, created_at: now, updated_at: now };
  immutableJson(filePath, record, "structure-wave-v1");
  immutableJson(
    path.join(
      waveDirectory(input.project_root, input.outer_run_id, outerIteration),
      "baseline-spec.json",
    ),
    spec,
    "workflow-spec-v1",
  );
  immutableJson(
    path.join(waveDirectory(input.project_root, input.outer_run_id, outerIteration), "s0.json"),
    s0,
    "structure-candidate-v1",
  );
  immutableJson(
    path.join(waveDirectory(input.project_root, input.outer_run_id, outerIteration), "s1.json"),
    s1,
    "structure-candidate-v1",
  );
  return record;
}

function reviewHash(review: ReviewReceipt): string {
  return hash(review, "review-receipt-v1");
}

export function recordStructureReview(input: RecordStructureReviewInput): StructureWaveRecord {
  const current = readStructureWave(input.project_root, input.outer_run_id, input.outer_iteration);
  const review = readStoredReviewReceipt(input.project_root, input.review);
  if (
    review.reviewed_run_kind !== "workflow" ||
    review.wave_kind !== "structure" ||
    review.review_stage !== "validation" ||
    review.reviewed_run_id !== input.outer_run_id ||
    review.outer_iteration !== current.outer_iteration ||
    review.wave_id !== current.wave_id ||
    review.generation !== current.generation
  )
    failA1("REVIEW_TYPE_MISMATCH", "structure review does not match the frozen wave");
  if (
    !isRecord(review.subject) ||
    review.subject.validation_comparison_id !== `structure-validation:${current.proposal_id}` ||
    !Array.isArray(review.subject.candidate_ids) ||
    review.subject.candidate_ids.length !== 2 ||
    review.subject.candidate_ids[0] !== current.s0.candidate_id ||
    review.subject.candidate_ids[1] !== current.s1.candidate_id
  )
    failA1("IDENTITY_MISMATCH", "structure review does not name S0 and S1");
  const nextStatus: StructureWaveStatus = review.verdict === "approved" ? "reviewed" : "rejected";
  const next: StructureWaveRecord = {
    ...current,
    status: nextStatus,
    review_id: review.review_id,
    review_receipt_sha256: reviewHash(review),
    updated_at: new Date().toISOString(),
  };
  const filePath = waveStatePath(input.project_root, input.outer_run_id, input.outer_iteration);
  withStateFileLock(filePath, () => {
    const stored = validateRecord(readStateFile(filePath), filePath);
    const stableStored = { ...stored } as Record<string, unknown>;
    const stableNext = { ...next } as Record<string, unknown>;
    for (const stable of [stableStored, stableNext]) {
      delete stable.status;
      delete stable.review_id;
      delete stable.review_receipt_sha256;
      delete stable.created_at;
      delete stable.updated_at;
    }
    if (hash(stableStored, "structure-wave-v1") !== hash(stableNext, "structure-wave-v1"))
      failA1("IMMUTABLE_CONFLICT", "structure review cannot replace a previous decision", filePath);
    writeStateJsonAtomic(filePath, next);
  });
  immutableJson(
    path.join(
      waveDirectory(input.project_root, input.outer_run_id, input.outer_iteration),
      "review.json",
    ),
    review,
    "review-receipt-v1",
  );
  if (nextStatus === "rejected")
    finishOrdinaryWave(input.project_root, "structure", input.outer_run_id, "failed");
  return next;
}

export function finishStructureWave(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  status: "completed" | "failed",
): StructureWaveRecord {
  const record = readStructureWave(projectRoot, outerRunId, outerIteration);
  if (record.status === "prepared")
    failA1("STRUCTURE_REVIEW_REQUIRED", "structure wave cannot finish before review");
  finishOrdinaryWave(projectRoot, "structure", outerRunId, status);
  return record;
}
