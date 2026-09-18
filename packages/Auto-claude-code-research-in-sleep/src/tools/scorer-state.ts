import { requireRunContract, runOwnedPath } from "./run-contract.js";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStoredReviewReceipt, type ScorerReviewReceipt } from "./review-submit.js";
import { validateCoverageMap } from "./scorer-coverage.js";
import {
  materializeScorerRevision,
  validateScorerDelta,
  validateScorerRevision,
  type ScorerRevision,
} from "./scorer-definition.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertRunId,
  assertSha256,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import { workflowCycleDirectory } from "./workflow-state.js";

export type ScorerRunStatus =
  | "proposed"
  | "materialized"
  | "experimenting_parent"
  | "experimenting_candidate"
  | "reviewed"
  | "activated"
  | "rejected"
  | "failed";

export interface ScorerRunState {
  schema_version: 1;
  run_id: string;
  scorer_run_id: string;
  workflow_id: string;
  scorer_id: string;
  outer_run_id: string;
  outer_iteration: number;
  wave_id: string;
  generation: number;
  parent_revision: string;
  candidate_revision: string;
  delta_id: string;
  active_parent_revision: string;
  status: ScorerRunStatus;
  parent_sealed: boolean;
  candidate_sealed: boolean;
  parent_result_sha256: string | null;
  candidate_result_sha256: string | null;
  shared_probe_manifest_sha256: string | null;
  review_id: string | null;
  active_revision: string | null;
  updated_at: string;
}

export interface StartScorerRunInput {
  project_root: string;
  workflow_id: string;
  scorer_run_id: string;
  scorer_id: string;
  outer_run_id: string;
  outer_iteration: number;
  wave_id: string;
  generation: number;
  parent_revision: string;
  candidate_revision: string;
  delta_id: string;
}

const TERMINAL_STATUSES = new Set<ScorerRunStatus>(["activated", "rejected", "failed"]);

function scorerRunDirectory(projectRoot: string, scorerRunId: string): string {
  return runOwnedPath(projectRoot, scorerRunId);
}

export function scorerRunDashboardPath(projectRoot: string, scorerRunId: string): string {
  return path.join(scorerRunDirectory(projectRoot, scorerRunId), "dashboard.json");
}

export function scorerRunStatePath(projectRoot: string, scorerRunId: string): string {
  return runOwnedPath(projectRoot, scorerRunId, "scorer-state.json");
}

export function activeScorerPointerPath(projectRoot: string, workflowId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "workflows",
    assertIdentifier(workflowId, "workflow_id"),
    "active-scorer.json",
  );
}

function activeRunPath(projectRoot: string, scorerId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "scorers",
    assertIdentifier(scorerId, "scorer_id"),
    "active-run.json",
  );
}

function scorerExclusivePath(projectRoot: string, scorerId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "scorers",
    assertIdentifier(scorerId, "scorer_id"),
    "exclusive.state.json",
  );
}

function activeWavePath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".aris", "active-wave.json");
}

function workflowDefinitionPath(projectRoot: string, workflowId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "workflows",
    assertIdentifier(workflowId, "workflow_id"),
    "definition.json",
  );
}

export function scorerWaveRegistrationPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "scorer-wave.json",
  );
}

export interface ScorerWaveRegistrationInput {
  project_root: string;
  workflow_id: string;
  scorer_id: string;
  scorer_run_id: string;
  outer_run_id: string;
  outer_iteration: number;
  wave_id: string;
  parent_revision: string;
  candidate_revision: string;
  delta_id: string;
}

/**
 * Store the outer scheduler's one-time proof that this scorer wave owns its
 * cycle.  The lower-level scorer state machine only accepts a run after this
 * immutable record exists, so a direct scorer command cannot invent a wave.
 */
export function saveScorerWaveRegistration(
  input: ScorerWaveRegistrationInput,
): ScorerWaveRegistrationInput {
  const normalized: ScorerWaveRegistrationInput = {
    project_root: requireString(input.project_root, "project_root"),
    workflow_id: assertIdentifier(input.workflow_id, "workflow_id"),
    scorer_id: assertIdentifier(input.scorer_id, "scorer_id"),
    scorer_run_id: assertIdentifier(input.scorer_run_id, "scorer_run_id"),
    outer_run_id: assertIdentifier(input.outer_run_id, "outer_run_id"),
    outer_iteration: requireInteger(input.outer_iteration, "outer_iteration", 1),
    wave_id: assertIdentifier(input.wave_id, "wave_id"),
    parent_revision: assertIdentifier(input.parent_revision, "parent_revision"),
    candidate_revision: assertIdentifier(input.candidate_revision, "candidate_revision"),
    delta_id: assertIdentifier(input.delta_id, "delta_id"),
  };
  const filePath = scorerWaveRegistrationPath(
    normalized.project_root,
    normalized.outer_run_id,
    normalized.outer_iteration,
  );
  const record = {
    schema_version: 1 as const,
    wave_kind: "scorer" as const,
    workflow_id: normalized.workflow_id,
    scorer_id: normalized.scorer_id,
    scorer_run_id: normalized.scorer_run_id,
    outer_run_id: normalized.outer_run_id,
    outer_iteration: normalized.outer_iteration,
    wave_id: normalized.wave_id,
    parent_revision: normalized.parent_revision,
    candidate_revision: normalized.candidate_revision,
    delta_id: normalized.delta_id,
  };
  let created = false;
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (
        canonicalJsonSha256(existing, undefined, {
          schemaVersion: "scorer-wave-registration-v1",
        }) ===
        canonicalJsonSha256(record, undefined, { schemaVersion: "scorer-wave-registration-v1" })
      )
        return;
      failA1("IMMUTABLE_CONFLICT", "scorer wave registration cannot change", filePath);
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStateJsonAtomic(filePath, record);
    created = true;
  });
  try {
    assertScorerWaveRegistration(normalized);
  } catch (error: unknown) {
    if (created) fs.rmSync(filePath, { force: true });
    throw error;
  }
  return normalized;
}

/**
 * A runtime marker only says who currently holds the slot. The immutable
 * workflow definition and cycle registration say whether that slot was
 * actually granted to this scorer wave.
 */
export function assertScorerWaveRegistration(input: ScorerWaveRegistrationInput): void {
  const workflowId = assertIdentifier(input.workflow_id, "workflow_id");
  const scorerId = assertIdentifier(input.scorer_id, "scorer_id");
  const scorerRunId = assertIdentifier(input.scorer_run_id, "scorer_run_id");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  const waveId = assertIdentifier(input.wave_id, "wave_id");
  const definitionPath = workflowDefinitionPath(input.project_root, workflowId);
  if (!fs.existsSync(definitionPath))
    failA1("SCORER_WAVE_NOT_FOUND", "workflow definition is missing at " + definitionPath);
  const definition = readStateFile(definitionPath);
  if (!isRecord(definition))
    failA1("CORRUPT_WORKFLOW_DEFINITION", "workflow definition must be an object", definitionPath);
  if (definition.schema_version !== 1)
    failA1(
      "CORRUPT_WORKFLOW_DEFINITION",
      "workflow definition schema_version must be 1",
      definitionPath,
    );
  if (definition.workflow_id !== workflowId)
    failA1(
      "IDENTITY_MISMATCH",
      "workflow definition does not match workflow identity",
      definitionPath,
    );
  const scorers = Array.isArray(definition.scorers) ? definition.scorers : [];
  const registered = scorers.some((scorer) => isRecord(scorer) && scorer.id === scorerId);
  const validationPolicy = definition.validation_policy;
  const validationScorer = isRecord(validationPolicy) && validationPolicy.scorer_id === scorerId;
  if (!registered && !validationScorer)
    failA1("SCORER_WAVE_NOT_FOUND", "scorer is not registered by the workflow", definitionPath);
  const wavePolicy = definition.scorer_wave_policy;
  if (
    !isRecord(wavePolicy) ||
    wavePolicy.exclusive !== true ||
    wavePolicy.max_candidates !== 1 ||
    wavePolicy.experiment_parallelism !== 1 ||
    wavePolicy.execution_order !== "baseline_then_candidate" ||
    wavePolicy.blocks_other_wave_kinds !== true
  )
    failA1(
      "SCORER_WAVE_NOT_FOUND",
      "workflow does not grant the required exclusive scorer wave policy",
    );

  const registrationPath = scorerWaveRegistrationPath(
    input.project_root,
    outerRunId,
    outerIteration,
  );
  if (!fs.existsSync(registrationPath))
    failA1(
      "SCORER_WAVE_NOT_FOUND",
      "immutable scorer wave registration is missing at " + registrationPath,
    );
  const registration = readStateFile(registrationPath);
  if (!isRecord(registration))
    failA1("CORRUPT_SCORER_WAVE", "scorer wave registration must be an object", registrationPath);
  const identity: Array<[string, unknown]> = [
    ["workflow_id", workflowId],
    ["scorer_id", scorerId],
    ["scorer_run_id", scorerRunId],
    ["outer_run_id", outerRunId],
    ["outer_iteration", outerIteration],
    ["wave_id", waveId],
    ["parent_revision", input.parent_revision],
    ["candidate_revision", input.candidate_revision],
    ["delta_id", input.delta_id],
  ];
  if (registration.schema_version !== 1 || registration.wave_kind !== "scorer")
    failA1("CORRUPT_SCORER_WAVE", "scorer wave registration envelope is invalid", registrationPath);
  for (const [field, expected] of identity) {
    if (!Object.hasOwn(registration, field) || registration[field] !== expected)
      failA1(
        "IDENTITY_MISMATCH",
        "scorer wave registration field '" + field + "' differs",
        registrationPath,
      );
  }
}

function terminal(
  status: ScorerRunStatus,
): status is Extract<ScorerRunStatus, "activated" | "rejected" | "failed"> {
  return TERMINAL_STATUSES.has(status as ScorerRunStatus);
}

function optionalHash(value: unknown, location: string): string | null {
  return value === null ? null : assertSha256(value, location);
}

function validateScorerState(
  value: unknown,
  scorerRunId: string,
  filePath: string,
): ScorerRunState {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_STATE", "scorer state must be an object", filePath);
  const allowed = [
    "schema_version",
    "run_id",
    "scorer_run_id",
    "workflow_id",
    "scorer_id",
    "outer_run_id",
    "outer_iteration",
    "wave_id",
    "generation",
    "parent_revision",
    "candidate_revision",
    "delta_id",
    "active_parent_revision",
    "status",
    "parent_sealed",
    "candidate_sealed",
    "parent_result_sha256",
    "candidate_result_sha256",
    "shared_probe_manifest_sha256",
    "review_id",
    "active_revision",
    "updated_at",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", "unknown scorer state field '" + key + "'", filePath);
  if (
    value.schema_version !== 1 ||
    value.run_id !== scorerRunId ||
    value.scorer_run_id !== scorerRunId
  )
    failA1("IDENTITY_MISMATCH", "scorer state and path ids differ", filePath);
  const statuses: ScorerRunStatus[] = [
    "proposed",
    "materialized",
    "experimenting_parent",
    "experimenting_candidate",
    "reviewed",
    "activated",
    "rejected",
    "failed",
  ];
  const status = value.status;
  if (typeof status !== "string" || !statuses.includes(status as ScorerRunStatus))
    failA1("CORRUPT_SCORER_STATE", "invalid scorer state status", filePath);
  if (typeof value.parent_sealed !== "boolean" || typeof value.candidate_sealed !== "boolean")
    failA1("CORRUPT_SCORER_STATE", "scorer seal flags must be booleans", filePath);
  const parentResultSha256 = optionalHash(
    value.parent_result_sha256,
    filePath + ".parent_result_sha256",
  );
  const candidateResultSha256 = optionalHash(
    value.candidate_result_sha256,
    filePath + ".candidate_result_sha256",
  );
  const sharedProbeManifestSha256 = optionalHash(
    value.shared_probe_manifest_sha256,
    filePath + ".shared_probe_manifest_sha256",
  );
  const parentRevision = assertIdentifier(value.parent_revision, filePath + ".parent_revision");
  const candidateRevision = assertIdentifier(
    value.candidate_revision,
    filePath + ".candidate_revision",
  );
  const activeParentRevision = assertIdentifier(
    value.active_parent_revision,
    filePath + ".active_parent_revision",
  );
  if (activeParentRevision !== parentRevision)
    failA1(
      "IDENTITY_MISMATCH",
      "scorer state active parent must equal its frozen parent revision",
      filePath,
    );
  const reviewId =
    value.review_id === null ? null : assertIdentifier(value.review_id, filePath + ".review_id");
  const activeRevision =
    value.active_revision === null
      ? null
      : assertIdentifier(value.active_revision, filePath + ".active_revision");
  if (value.parent_sealed && (parentResultSha256 === null || sharedProbeManifestSha256 === null))
    failA1(
      "CORRUPT_SCORER_STATE",
      "sealed parent state must record its result and shared probe",
      filePath,
    );
  if (
    value.candidate_sealed &&
    (candidateResultSha256 === null || sharedProbeManifestSha256 === null)
  )
    failA1(
      "CORRUPT_SCORER_STATE",
      "sealed candidate state must record its result and shared probe",
      filePath,
    );
  if (
    (status === "experimenting_candidate" || status === "reviewed" || status === "activated") &&
    !value.parent_sealed
  )
    failA1("CORRUPT_SCORER_STATE", "candidate phase requires sealed parent results", filePath);
  if ((status === "reviewed" || status === "activated") && !value.candidate_sealed)
    failA1("CORRUPT_SCORER_STATE", "reviewed phase requires sealed candidate results", filePath);
  if (status === "reviewed" && reviewId === null)
    failA1("CORRUPT_SCORER_STATE", "reviewed phase requires a review id", filePath);
  if (status === "activated" && (reviewId === null || activeRevision === null))
    failA1(
      "CORRUPT_SCORER_STATE",
      "activated phase requires review and active revision ids",
      filePath,
    );
  if (status !== "activated" && activeRevision !== null)
    failA1("CORRUPT_SCORER_STATE", "only activated phase may record an active revision", filePath);
  return {
    schema_version: 1,
    run_id: scorerRunId,
    scorer_run_id: scorerRunId,
    workflow_id: assertIdentifier(value.workflow_id, filePath + ".workflow_id"),
    scorer_id: assertIdentifier(value.scorer_id, filePath + ".scorer_id"),
    outer_run_id: assertIdentifier(value.outer_run_id, filePath + ".outer_run_id"),
    outer_iteration: requireInteger(value.outer_iteration, filePath + ".outer_iteration", 1),
    wave_id: assertIdentifier(value.wave_id, filePath + ".wave_id"),
    generation: requireInteger(value.generation, filePath + ".generation", 1),
    parent_revision: parentRevision,
    candidate_revision: candidateRevision,
    delta_id: assertIdentifier(value.delta_id, filePath + ".delta_id"),
    active_parent_revision: activeParentRevision,
    status: status as ScorerRunStatus,
    parent_sealed: value.parent_sealed,
    candidate_sealed: value.candidate_sealed,
    parent_result_sha256: parentResultSha256,
    candidate_result_sha256: candidateResultSha256,
    shared_probe_manifest_sha256: sharedProbeManifestSha256,
    review_id: reviewId,
    active_revision: activeRevision,
    updated_at: requireString(value.updated_at, filePath + ".updated_at"),
  };
}

function readScorerState(projectRoot: string, scorerRunId: string): ScorerRunState {
  const id = assertRunId(scorerRunId, "scorer_run_id");
  const statePath = scorerRunStatePath(projectRoot, id);
  if (!fs.existsSync(statePath)) failA1("SCORER_RUN_NOT_FOUND", "no scorer run at " + statePath);
  return validateScorerState(readStateFile(statePath), id, statePath);
}

export function readScorerRunState(projectRoot: string, scorerRunId: string): ScorerRunState {
  requireRunContract(projectRoot, scorerRunId);
  return readScorerState(projectRoot, scorerRunId);
}

function readActiveParentRevision(
  projectRoot: string,
  workflowId: string,
  scorerId: string,
): string {
  const activePath = activeScorerPointerPath(projectRoot, workflowId);
  if (!fs.existsSync(activePath))
    failA1("ACTIVE_SCORER_NOT_FOUND", "active scorer pointer is missing at " + activePath);
  const active = readStateFile(activePath);
  if (!isRecord(active))
    failA1("CORRUPT_ACTIVE_SCORER", "active scorer pointer must be an object", activePath);
  if (
    active.schema_version !== 1 ||
    active.workflow_id !== workflowId ||
    active.scorer_id !== scorerId
  )
    failA1("IDENTITY_MISMATCH", "active scorer pointer does not match the scorer wave", activePath);
  return assertIdentifier(active.revision, activePath + ".revision");
}

function assertImmutableScorerArtifacts(
  projectRoot: string,
  scorerRunId: string,
  scorerId: string,
  parentRevision: string,
  candidateRevision: string,
  deltaId: string,
): void {
  const scorerBase = path.join(
    path.resolve(projectRoot),
    ".aris",
    "scorers",
    assertIdentifier(scorerId, "scorer_id"),
  );
  const paths = [
    path.join(scorerBase, "deltas", assertIdentifier(deltaId, "delta_id") + ".json"),
    path.join(
      scorerBase,
      "revisions",
      assertIdentifier(parentRevision, "parent_revision"),
      "definition.json",
    ),
    path.join(
      scorerBase,
      "revisions",
      assertIdentifier(candidateRevision, "candidate_revision"),
      "definition.json",
    ),
  ];
  const coveragePaths = [
    path.join(
      scorerBase,
      "revisions",
      assertIdentifier(parentRevision, "parent_revision"),
      "coverage-map.json",
    ),
    path.join(
      scorerBase,
      "revisions",
      assertIdentifier(candidateRevision, "candidate_revision"),
      "coverage-map.json",
    ),
  ];
  for (const artifactPath of [...paths, ...coveragePaths]) {
    if (!fs.existsSync(artifactPath))
      failA1(
        "SCORER_REVISION_NOT_FOUND",
        "immutable scorer artifact is missing at " + artifactPath,
      );
  }
  const delta = validateScorerDelta(readStateFile(paths[0]!));
  const parent = validateScorerRevision(readStateFile(paths[1]!));
  const candidate = validateScorerRevision(readStateFile(paths[2]!));
  for (const [coveragePath, revision] of [
    [coveragePaths[0]!, parent],
    [coveragePaths[1]!, candidate],
  ] as const) {
    const storedCoverage = validateCoverageMap(readStateFile(coveragePath));
    if (canonicalJsonSha256(storedCoverage) !== canonicalJsonSha256(revision.coverage_map))
      failA1(
        "SCORER_HASH_MISMATCH",
        "scorer coverage map differs from its immutable definition",
        coveragePath,
      );
  }
  if (
    delta.producer_scorer_run_id !== scorerRunId ||
    delta.scorer_id !== scorerId ||
    delta.parent_revision !== parentRevision ||
    parent.scorer_id !== scorerId ||
    parent.revision !== parentRevision ||
    candidate.scorer_id !== scorerId ||
    candidate.revision !== candidateRevision ||
    candidate.parent_revision !== parentRevision
  )
    failA1("IDENTITY_MISMATCH", "immutable scorer artifacts do not match the scorer wave");

  // A self-consistent candidate file may still have been produced outside
  // this delta. Rebuild it from the stored parent before execution starts.
  const expectedCandidate = materializeScorerRevision(parent, delta, candidate.coverage_map);
  if (
    expectedCandidate.revision !== candidate.revision ||
    expectedCandidate.definition_sha256 !== candidate.definition_sha256 ||
    expectedCandidate.coverage_map_sha256 !== candidate.coverage_map_sha256
  )
    failA1(
      "SCORER_HASH_MISMATCH",
      "candidate revision is not the immutable materialization of its delta",
    );
}

export function assertScorerRunArtifacts(projectRoot: string, scorerRunId: string): void {
  const state = readScorerState(projectRoot, scorerRunId);
  assertImmutableScorerArtifacts(
    projectRoot,
    state.scorer_run_id,
    state.scorer_id,
    state.parent_revision,
    state.candidate_revision,
    state.delta_id,
  );
}

function writeDashboard(projectRoot: string, state: ScorerRunState): void {
  writeStateJsonAtomic(scorerRunDashboardPath(projectRoot, state.scorer_run_id), {
    schema_version: 1,
    run_id: state.scorer_run_id,
    scorer_run_id: state.scorer_run_id,
    workflow_id: state.workflow_id,
    scorer_id: state.scorer_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    generation: state.generation,
    parent_revision: state.parent_revision,
    candidate_revision: state.candidate_revision,
    delta_id: state.delta_id,
    active_parent_revision: state.active_parent_revision,
    status: state.status,
    parent_sealed: state.parent_sealed,
    candidate_sealed: state.candidate_sealed,
    parent_result_sha256: state.parent_result_sha256,
    candidate_result_sha256: state.candidate_result_sha256,
    shared_probe_manifest_sha256: state.shared_probe_manifest_sha256,
    review_id: state.review_id,
    active_revision: state.active_revision,
    updated_at: state.updated_at,
  });
}

function writeWaveMarker(
  projectRoot: string,
  scorerId: string,
  scorerRunId: string,
  workflowId: string,
  status: "running" | "activated" | "rejected" | "failed",
): void {
  writeStateJsonAtomic(activeRunPath(projectRoot, scorerId), {
    schema_version: 1,
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    status,
  });
  writeStateJsonAtomic(activeWavePath(projectRoot), {
    schema_version: 1,
    wave_kind: "scorer",
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    run_id: scorerRunId,
    status,
  });
}

function markerState(projectRoot: string): Record<string, unknown> | null {
  const markerPath = activeWavePath(projectRoot);
  if (!fs.existsSync(markerPath)) return null;
  const marker = readStateFile(markerPath);
  if (!isRecord(marker)) failA1("CORRUPT_WAVE_STATE", "active wave marker is corrupt", markerPath);
  return marker;
}

function assertNoOtherDurableScorer(projectRoot: string, allowedScorerRunId?: string): void {
  const runsRoot = path.join(path.resolve(projectRoot), ".aris", "runs");
  if (!fs.existsSync(runsRoot)) return;
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Discover state first so unrelated directories do not require a scorer contract.
    if (!fs.existsSync(path.join(runsRoot, entry.name, "scorer-state.json"))) continue;
    const state = readScorerRunState(projectRoot, entry.name);
    if (!terminal(state.status) && state.scorer_run_id !== allowedScorerRunId)
      failA1("SCORER_WAVE_EXCLUSIVE", "another durable scorer run owns the wave slot");
  }
}

function assertStateWaveProof(
  projectRoot: string,
  state: ScorerRunState,
  requireRunning: boolean,
): void {
  assertScorerWaveRegistration({
    project_root: projectRoot,
    workflow_id: state.workflow_id,
    scorer_id: state.scorer_id,
    scorer_run_id: state.scorer_run_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    parent_revision: state.parent_revision,
    candidate_revision: state.candidate_revision,
    delta_id: state.delta_id,
  });

  const globalMarker = markerState(projectRoot);
  if (globalMarker === null) {
    if (requireRunning) failA1("SCORER_WAVE_NOT_FOUND", "scorer wave marker does not exist");
  } else if (
    globalMarker.schema_version !== 1 ||
    globalMarker.wave_kind !== "scorer" ||
    globalMarker.workflow_id !== state.workflow_id ||
    globalMarker.scorer_id !== state.scorer_id ||
    globalMarker.scorer_run_id !== state.scorer_run_id ||
    globalMarker.run_id !== state.scorer_run_id ||
    (requireRunning && globalMarker.status !== "running")
  ) {
    failA1("SCORER_WAVE_EXCLUSIVE", "scorer state is not owned by its registered wave");
  }

  const scorerMarkerPath = activeRunPath(projectRoot, state.scorer_id);
  if (!fs.existsSync(scorerMarkerPath)) {
    if (requireRunning) failA1("SCORER_WAVE_NOT_FOUND", "scorer run marker does not exist");
    return;
  }
  const scorerMarker = readStateFile(scorerMarkerPath);
  if (!isRecord(scorerMarker))
    failA1("CORRUPT_SCORER_STATE", "active scorer marker is corrupt", scorerMarkerPath);
  if (
    scorerMarker.schema_version !== 1 ||
    scorerMarker.workflow_id !== state.workflow_id ||
    scorerMarker.scorer_id !== state.scorer_id ||
    scorerMarker.scorer_run_id !== state.scorer_run_id ||
    (requireRunning && scorerMarker.status !== "running")
  )
    failA1("SCORER_WAVE_EXCLUSIVE", "scorer state is not owned by its scorer marker");
}

function recoverTerminalMarker(projectRoot: string, marker: Record<string, unknown>): void {
  if (marker.status !== "running" || marker.wave_kind !== "scorer") return;
  const runId = marker.scorer_run_id;
  if (typeof runId !== "string") {
    writeStateJsonAtomic(activeWavePath(projectRoot), { ...marker, status: "failed" });
    return;
  }
  const statePath = scorerRunStatePath(projectRoot, runId);
  if (!fs.existsSync(statePath)) {
    failA1(
      "SCORER_WAVE_NOT_FOUND",
      "scorer wave marker has no immutable run state at " + statePath,
    );
  }
  const state = validateScorerState(readStateFile(statePath), runId, statePath);
  if (
    marker.scorer_id !== state.scorer_id ||
    marker.workflow_id !== state.workflow_id ||
    marker.run_id !== state.scorer_run_id
  )
    failA1("IDENTITY_MISMATCH", "scorer wave marker does not match its immutable run state");
  assertScorerWaveRegistration({
    project_root: projectRoot,
    workflow_id: state.workflow_id,
    scorer_id: state.scorer_id,
    scorer_run_id: state.scorer_run_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    parent_revision: state.parent_revision,
    candidate_revision: state.candidate_revision,
    delta_id: state.delta_id,
  });
  if (!terminal(state.status)) return;
  writeWaveMarker(
    projectRoot,
    state.scorer_id,
    state.scorer_run_id,
    state.workflow_id,
    state.status,
  );
}

function ensureNoOtherActiveScorer(
  projectRoot: string,
  scorerId: string,
  scorerRunId: string,
  workflowId: string,
): void {
  const globalMarker = markerState(projectRoot);
  if (globalMarker) {
    if (
      !(
        globalMarker.status === "running" &&
        globalMarker.scorer_run_id === scorerRunId &&
        globalMarker.scorer_id === scorerId
      )
    )
      recoverTerminalMarker(projectRoot, globalMarker);
    const current = markerState(projectRoot);
    if (
      current?.status === "running" &&
      (current.scorer_run_id !== scorerRunId || current.scorer_id !== scorerId)
    )
      failA1("SCORER_WAVE_EXCLUSIVE", "another wave already owns the global wave slot");
  }
  const marker = activeRunPath(projectRoot, scorerId);
  if (!fs.existsSync(marker)) return;
  const existing = readStateFile(marker);
  if (!isRecord(existing))
    failA1("CORRUPT_SCORER_STATE", "active scorer marker is corrupt", marker);
  if (existing.status !== "running") return;
  if (existing.scorer_run_id === scorerRunId && existing.workflow_id === workflowId) return;
  const otherRunId = existing.scorer_run_id;
  if (
    typeof otherRunId === "string" &&
    fs.existsSync(scorerRunStatePath(projectRoot, otherRunId))
  ) {
    const otherState = validateScorerState(
      readStateFile(scorerRunStatePath(projectRoot, otherRunId)),
      otherRunId,
      scorerRunStatePath(projectRoot, otherRunId),
    );
    if (terminal(otherState.status)) {
      writeWaveMarker(
        projectRoot,
        otherState.scorer_id,
        otherState.scorer_run_id,
        otherState.workflow_id,
        otherState.status,
      );
      return;
    }
  }
  failA1("SCORER_WAVE_EXCLUSIVE", "another scorer experiment is active");
}

export function beginScorerWave(
  projectRoot: string,
  scorerIdValue: string,
  scorerRunIdValue: string,
  workflowIdValue: string,
): void {
  const scorerId = assertIdentifier(scorerIdValue, "scorer_id");
  const scorerRunId = assertRunId(scorerRunIdValue, "scorer_run_id");
  requireRunContract(projectRoot, scorerRunId);
  const workflowId = assertIdentifier(workflowIdValue, "workflow_id");
  const statePath = scorerRunStatePath(projectRoot, scorerRunId);
  if (!fs.existsSync(statePath))
    failA1("SCORER_WAVE_NOT_FOUND", "scorer wave requires its immutable run state");
  const state = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
  const proof = {
    project_root: projectRoot,
    workflow_id: state.workflow_id,
    scorer_id: state.scorer_id,
    scorer_run_id: state.scorer_run_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    parent_revision: state.parent_revision,
    candidate_revision: state.candidate_revision,
    delta_id: state.delta_id,
  } satisfies ScorerWaveRegistrationInput;
  if (proof.workflow_id !== workflowId || proof.scorer_id !== scorerId)
    failA1("IDENTITY_MISMATCH", "scorer wave proof does not match the requested marker");
  assertScorerWaveRegistration(proof);
  assertImmutableScorerArtifacts(
    projectRoot,
    proof.scorer_run_id,
    proof.scorer_id,
    proof.parent_revision,
    proof.candidate_revision,
    proof.delta_id,
  );
  if (readActiveParentRevision(projectRoot, workflowId, scorerId) !== proof.parent_revision)
    failA1(
      "SCORER_ACTIVE_CONFLICT",
      "scorer wave parent is not the workflow's active scorer revision",
    );
  const globalMarker = activeWavePath(projectRoot);
  withStateFileLock(globalMarker, () => {
    assertNoOtherDurableScorer(projectRoot, scorerRunId);
    const current = markerState(projectRoot);
    if (current) {
      if (
        !(
          current.status === "running" &&
          current.scorer_run_id === scorerRunId &&
          current.scorer_id === scorerId
        )
      )
        recoverTerminalMarker(projectRoot, current);
      const recovered = markerState(projectRoot);
      if (
        recovered?.status === "running" &&
        (recovered.scorer_run_id !== scorerRunId || recovered.scorer_id !== scorerId)
      )
        failA1("SCORER_WAVE_EXCLUSIVE", "another wave already owns the global wave slot");
    }
    writeStateJsonAtomic(globalMarker, {
      schema_version: 1,
      wave_kind: "scorer",
      workflow_id: workflowId,
      scorer_id: scorerId,
      scorer_run_id: scorerRunId,
      run_id: scorerRunId,
      status: "running",
    });
  });
  const marker = activeRunPath(projectRoot, scorerId);
  withStateFileLock(marker, () => {
    ensureNoOtherActiveScorer(projectRoot, scorerId, scorerRunId, workflowId);
    writeStateJsonAtomic(marker, {
      schema_version: 1,
      workflow_id: workflowId,
      scorer_id: scorerId,
      scorer_run_id: scorerRunId,
      status: "running",
    });
  });
}

function terminateScorerMarkers(projectRoot: string, state: ScorerRunState): void {
  const marker = activeRunPath(projectRoot, state.scorer_id);
  withStateFileLock(marker, () => {
    if (!fs.existsSync(marker)) {
      writeStateJsonAtomic(marker, {
        schema_version: 1,
        workflow_id: state.workflow_id,
        scorer_id: state.scorer_id,
        scorer_run_id: state.scorer_run_id,
        status: state.status,
      });
      return;
    }
    const current = readStateFile(marker);
    if (
      isRecord(current) &&
      current.scorer_run_id !== undefined &&
      current.scorer_run_id !== state.scorer_run_id
    )
      failA1("IDENTITY_MISMATCH", "scorer marker belongs to another run");
    writeStateJsonAtomic(marker, {
      schema_version: 1,
      workflow_id: state.workflow_id,
      scorer_id: state.scorer_id,
      scorer_run_id: state.scorer_run_id,
      status: state.status,
    });
  });
  const globalMarker = activeWavePath(projectRoot);
  withStateFileLock(globalMarker, () => {
    if (!fs.existsSync(globalMarker)) {
      writeStateJsonAtomic(globalMarker, {
        schema_version: 1,
        wave_kind: "scorer",
        workflow_id: state.workflow_id,
        scorer_id: state.scorer_id,
        scorer_run_id: state.scorer_run_id,
        run_id: state.scorer_run_id,
        status: state.status,
      });
      return;
    }
    const current = readStateFile(globalMarker);
    if (!isRecord(current) || current.scorer_run_id !== state.scorer_run_id)
      failA1("IDENTITY_MISMATCH", "global wave marker belongs to another scorer run");
    writeStateJsonAtomic(globalMarker, {
      schema_version: 1,
      wave_kind: "scorer",
      workflow_id: state.workflow_id,
      scorer_id: state.scorer_id,
      scorer_run_id: state.scorer_run_id,
      run_id: state.scorer_run_id,
      status: state.status,
    });
  });
}

export function finishScorerWave(
  projectRoot: string,
  scorerIdValue: string,
  scorerRunIdValue: string,
  status: "activated" | "rejected" | "failed",
): void {
  if (status === "activated")
    failA1(
      "SCORER_ACTIVATION_REQUIRED",
      "only activateScorerRevision may enter the activated state",
    );
  const scorerId = assertIdentifier(scorerIdValue, "scorer_id");
  const scorerRunId = assertRunId(scorerRunIdValue, "scorer_run_id");
  requireRunContract(projectRoot, scorerRunId);
  const statePath = scorerRunStatePath(projectRoot, scorerRunId);
  if (fs.existsSync(statePath)) {
    withStateFileLock(statePath, () => {
      const current = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
      if (current.scorer_id !== scorerId)
        failA1("IDENTITY_MISMATCH", "scorer marker and state scorer ids differ");
      assertStateWaveProof(projectRoot, current, !terminal(current.status));
      if (!TERMINAL_STATUSES.has(current.status)) {
        const next: ScorerRunState = {
          ...current,
          status,
          updated_at: new Date().toISOString(),
        };
        writeStateJsonAtomic(statePath, next);
        writeDashboard(projectRoot, next);
      }
      const currentState = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
      terminateScorerMarkers(projectRoot, currentState);
    });
    return;
  }
  failA1("SCORER_WAVE_NOT_FOUND", "a scorer wave cannot finish without its immutable run state");
}

export function assertWaveKindExclusive(
  projectRoot: string,
  requested: "module" | "structure" | "scorer",
  requestedRunId?: string,
): void {
  if (requested === "scorer" && requestedRunId === undefined)
    failA1("IDENTITY_MISMATCH", "scorer wave exclusivity checks require the scorer run identity");
  const markerPath = activeWavePath(projectRoot);
  if (!fs.existsSync(markerPath)) {
    assertNoOtherDurableScorer(projectRoot, requested === "scorer" ? requestedRunId : undefined);
    return;
  }
  const raw = markerState(projectRoot);
  if (!raw) return;
  recoverTerminalMarker(projectRoot, raw);
  const current = markerState(projectRoot);
  if (!current || current.status !== "running") return;
  if (current.wave_kind !== requested)
    failA1("SCORER_WAVE_EXCLUSIVE", "scorer wave blocks module and structure waves");
  if (
    requested === "scorer" &&
    requestedRunId !== undefined &&
    current.scorer_run_id !== requestedRunId
  )
    failA1("SCORER_WAVE_EXCLUSIVE", "another scorer run already owns the scorer wave");
  if (requested !== "scorer" && requestedRunId !== undefined && current.run_id !== requestedRunId)
    failA1("SCORER_WAVE_EXCLUSIVE", "another ordinary wave already owns the wave slot");
}

export function beginOrdinaryWave(
  projectRoot: string,
  waveKind: "module" | "structure",
  runIdValue: string,
): void {
  const runId = assertIdentifier(runIdValue, "run_id");
  const marker = activeWavePath(projectRoot);
  withStateFileLock(marker, () => {
    assertNoOtherDurableScorer(projectRoot);
    const current = markerState(projectRoot);
    if (current) {
      recoverTerminalMarker(projectRoot, current);
      const recovered = markerState(projectRoot);
      if (recovered?.status === "running")
        failA1("SCORER_WAVE_EXCLUSIVE", "an active wave already owns the global wave slot");
    }
    writeStateJsonAtomic(marker, {
      schema_version: 1,
      wave_kind: waveKind,
      run_id: runId,
      status: "running",
    });
  });
}

export function finishOrdinaryWave(
  projectRoot: string,
  waveKind: "module" | "structure",
  runIdValue: string,
  status: "completed" | "failed",
): void {
  const runId = assertIdentifier(runIdValue, "run_id");
  const marker = activeWavePath(projectRoot);
  withStateFileLock(marker, () => {
    if (!fs.existsSync(marker)) failA1("WAVE_NOT_FOUND", "no ordinary wave is active");
    const current = readStateFile(marker);
    if (!isRecord(current) || current.wave_kind !== waveKind || current.run_id !== runId)
      failA1("IDENTITY_MISMATCH", "ordinary wave marker does not match the requested run");
    writeStateJsonAtomic(marker, { schema_version: 1, wave_kind: waveKind, run_id: runId, status });
  });
}

export function withScorerExclusive<T>(projectRoot: string, scorerId: string, action: () => T): T {
  const lockPath = scorerExclusivePath(projectRoot, scorerId);
  return withStateFileLock(lockPath, () => {
    const existing = fs.existsSync(lockPath) ? readStateFile(lockPath) : null;
    if (existing !== null && isRecord(existing) && existing.status === "running")
      failA1("SCORER_WAVE_EXCLUSIVE", "scorer lock is already active");
    writeStateJsonAtomic(lockPath, {
      schema_version: 1,
      scorer_id: assertIdentifier(scorerId, "scorer_id"),
      status: "running",
    });
    try {
      return action();
    } finally {
      writeStateJsonAtomic(lockPath, {
        schema_version: 1,
        scorer_id: assertIdentifier(scorerId, "scorer_id"),
        status: "idle",
      });
    }
  });
}

function sameStartInput(
  state: ScorerRunState,
  input: StartScorerRunInput,
  workflowId: string,
): boolean {
  return (
    state.workflow_id === workflowId &&
    state.scorer_id === input.scorer_id &&
    state.outer_run_id === input.outer_run_id &&
    state.outer_iteration === input.outer_iteration &&
    state.wave_id === input.wave_id &&
    state.generation === input.generation &&
    state.parent_revision === input.parent_revision &&
    state.candidate_revision === input.candidate_revision &&
    state.delta_id === input.delta_id
  );
}

export function startScorerRun(input: StartScorerRunInput): ScorerRunState {
  const scorerRunId = assertRunId(input.scorer_run_id, "scorer_run_id");
  const contract = requireRunContract(input.project_root, scorerRunId);
  const parent = requireRunContract(input.project_root, input.outer_run_id);
  if (contract.parent_run_id !== parent.run_id || !parent.child_run_ids.includes(scorerRunId))
    failA1("IDENTITY_MISMATCH", "scorer must be registered under its parent contract");
  const scorerId = assertIdentifier(input.scorer_id, "scorer_id");
  const workflowId = assertIdentifier(input.workflow_id, "workflow_id");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  const waveId = assertIdentifier(input.wave_id, "wave_id");
  const generation = requireInteger(input.generation, "generation", 1);
  const parentRevision = assertIdentifier(input.parent_revision, "parent_revision");
  const candidateRevision = assertIdentifier(input.candidate_revision, "candidate_revision");
  const deltaId = assertIdentifier(input.delta_id, "delta_id");
  const statePath = scorerRunStatePath(input.project_root, scorerRunId);
  if (fs.existsSync(statePath)) {
    const existing = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
    if (!sameStartInput(existing, input, workflowId))
      failA1("IDENTITY_MISMATCH", "scorer retry does not match its frozen run assignment");
    assertScorerWaveRegistration({
      project_root: input.project_root,
      workflow_id: workflowId,
      scorer_id: scorerId,
      scorer_run_id: scorerRunId,
      outer_run_id: existing.outer_run_id,
      outer_iteration: existing.outer_iteration,
      wave_id: existing.wave_id,
      parent_revision: existing.parent_revision,
      candidate_revision: existing.candidate_revision,
      delta_id: existing.delta_id,
    });
    assertImmutableScorerArtifacts(
      input.project_root,
      existing.scorer_run_id,
      existing.scorer_id,
      existing.parent_revision,
      existing.candidate_revision,
      existing.delta_id,
    );
    return withStateFileLock(activeScorerPointerPath(input.project_root, workflowId), () => {
      if (!TERMINAL_STATUSES.has(existing.status)) {
        if (
          readActiveParentRevision(input.project_root, workflowId, scorerId) !==
          existing.active_parent_revision
        )
          failA1("SCORER_ACTIVE_CONFLICT", "scorer retry parent is no longer active");
        beginScorerWave(input.project_root, scorerId, scorerRunId, workflowId);
      }
      writeDashboard(input.project_root, existing);
      if (TERMINAL_STATUSES.has(existing.status))
        terminateScorerMarkers(input.project_root, existing);
      return existing;
    });
  }

  // Check the runtime slot first so an ordinary wave still reports the slot
  // conflict before any new scorer registration can be touched.
  assertWaveKindExclusive(input.project_root, "scorer", scorerRunId);
  assertScorerWaveRegistration({
    project_root: input.project_root,
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    outer_run_id: outerRunId,
    outer_iteration: outerIteration,
    wave_id: waveId,
    parent_revision: parentRevision,
    candidate_revision: candidateRevision,
    delta_id: deltaId,
  });
  assertImmutableScorerArtifacts(
    input.project_root,
    scorerRunId,
    scorerId,
    parentRevision,
    candidateRevision,
    deltaId,
  );
  const activeParentRevision = readActiveParentRevision(input.project_root, workflowId, scorerId);
  if (activeParentRevision !== parentRevision)
    failA1(
      "SCORER_ACTIVE_CONFLICT",
      "scorer wave parent is not the workflow's active scorer revision",
    );
  return withStateFileLock(statePath, () =>
    withStateFileLock(activeScorerPointerPath(input.project_root, workflowId), () => {
      const latestActiveParentRevision = readActiveParentRevision(
        input.project_root,
        workflowId,
        scorerId,
      );
      if (latestActiveParentRevision !== activeParentRevision)
        failA1("SCORER_ACTIVE_CONFLICT", "active scorer changed while starting the scorer wave");
      ensureNoOtherActiveScorer(input.project_root, scorerId, scorerRunId, workflowId);
      if (fs.existsSync(statePath)) {
        const existing = readScorerState(input.project_root, scorerRunId);
        if (!sameStartInput(existing, input, workflowId))
          failA1("IDENTITY_MISMATCH", "scorer retry does not match its frozen run assignment");
        assertScorerWaveRegistration({
          project_root: input.project_root,
          workflow_id: workflowId,
          scorer_id: scorerId,
          scorer_run_id: scorerRunId,
          outer_run_id: existing.outer_run_id,
          outer_iteration: existing.outer_iteration,
          wave_id: existing.wave_id,
          parent_revision: existing.parent_revision,
          candidate_revision: existing.candidate_revision,
          delta_id: existing.delta_id,
        });
        assertImmutableScorerArtifacts(
          input.project_root,
          existing.scorer_run_id,
          existing.scorer_id,
          existing.parent_revision,
          existing.candidate_revision,
          existing.delta_id,
        );
        if (!TERMINAL_STATUSES.has(existing.status))
          beginScorerWave(input.project_root, scorerId, scorerRunId, workflowId);
        writeDashboard(input.project_root, existing);
        if (TERMINAL_STATUSES.has(existing.status))
          terminateScorerMarkers(input.project_root, existing);
        return existing;
      }
      const now = new Date().toISOString();
      const state: ScorerRunState = {
        schema_version: 1,
        run_id: scorerRunId,
        scorer_run_id: scorerRunId,
        workflow_id: workflowId,
        scorer_id: scorerId,
        outer_run_id: assertIdentifier(input.outer_run_id, "outer_run_id"),
        outer_iteration: requireInteger(input.outer_iteration, "outer_iteration", 1),
        wave_id: assertIdentifier(input.wave_id, "wave_id"),
        generation: requireInteger(input.generation, "generation", 1),
        parent_revision: assertIdentifier(input.parent_revision, "parent_revision"),
        candidate_revision: assertIdentifier(input.candidate_revision, "candidate_revision"),
        delta_id: assertIdentifier(input.delta_id, "delta_id"),
        active_parent_revision: activeParentRevision,
        status: "proposed",
        parent_sealed: false,
        candidate_sealed: false,
        parent_result_sha256: null,
        candidate_result_sha256: null,
        shared_probe_manifest_sha256: null,
        review_id: null,
        active_revision: null,
        updated_at: now,
      };
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      writeStateJsonAtomic(statePath, state);
      writeDashboard(input.project_root, state);
      beginScorerWave(input.project_root, scorerId, scorerRunId, workflowId);
      return state;
    }),
  );
}

const TRANSITIONS: Readonly<Record<ScorerRunStatus, readonly ScorerRunStatus[]>> = {
  proposed: ["materialized", "failed"],
  materialized: ["experimenting_parent", "failed"],
  experimenting_parent: ["experimenting_candidate", "failed"],
  experimenting_candidate: ["reviewed", "failed"],
  reviewed: ["activated", "rejected", "failed"],
  activated: [],
  rejected: [],
  failed: [],
};

function updateState(
  projectRoot: string,
  statePath: string,
  current: ScorerRunState,
  nextStatus: ScorerRunStatus,
  changes: Partial<ScorerRunState> = {},
  allowActivation = false,
): ScorerRunState {
  if (nextStatus === "activated" && !allowActivation)
    failA1(
      "SCORER_ACTIVATION_REQUIRED",
      "only activateScorerRevision may enter the activated state",
    );
  if (current.status !== nextStatus && !TRANSITIONS[current.status].includes(nextStatus))
    failA1(
      "SCORER_STATE_ORDER",
      "cannot transition scorer run from '" + current.status + "' to '" + nextStatus + "'",
    );
  const next: ScorerRunState = {
    ...current,
    ...changes,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
  if (nextStatus === "experimenting_candidate" && !next.parent_sealed)
    failA1("SCORER_STATE_ORDER", "candidate experiment requires sealed parent results");
  if (nextStatus === "reviewed" && !next.candidate_sealed)
    failA1("SCORER_STATE_ORDER", "review requires sealed candidate results");
  writeStateJsonAtomic(statePath, next);
  writeDashboard(projectRoot, next);
  if (TERMINAL_STATUSES.has(next.status)) terminateScorerMarkers(projectRoot, next);
  return next;
}

export function transitionScorerState(
  projectRoot: string,
  scorerRunIdValue: string,
  nextStatus: ScorerRunStatus,
): ScorerRunState {
  const scorerRunId = assertRunId(scorerRunIdValue, "scorer_run_id");
  requireRunContract(projectRoot, scorerRunId);
  if (nextStatus === "activated")
    failA1(
      "SCORER_ACTIVATION_REQUIRED",
      "only activateScorerRevision may enter the activated state",
    );
  const statePath = scorerRunStatePath(projectRoot, scorerRunId);
  return withStateFileLock(statePath, () => {
    if (!fs.existsSync(statePath)) failA1("SCORER_RUN_NOT_FOUND", "no scorer run at " + statePath);
    const current = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
    assertStateWaveProof(projectRoot, current, !terminal(current.status));
    if (current.status === nextStatus && terminal(nextStatus)) {
      writeDashboard(projectRoot, current);
      terminateScorerMarkers(projectRoot, current);
      return current;
    }
    return updateState(projectRoot, statePath, current, nextStatus);
  });
}

function resultHash(results: readonly unknown[]): string {
  return canonicalJsonSha256(results, undefined, { schemaVersion: "scorer-results-v1" });
}

interface ComparisonLike {
  parent_revision: string;
  candidate_revision: string;
  shared_probe_manifest: {
    manifest_sha256: string;
    case_ids: string[];
  };
  parent_results: Array<{ item_id: string }>;
  candidate_results: Array<{ item_id: string }>;
}

function activeCaseIds(revision: ScorerRevision): string[] {
  return revision.benchmark_items
    .filter((item) => item.status === "active")
    .map((item) => item.benchmark_id)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

interface FrozenSharedProbeIdentity {
  manifest_sha256: string;
  case_ids: string[];
  source_revisions: Record<string, string[]>;
  case_source_revisions: Record<string, string>;
  item_hashes: Record<string, string>;
  output_hashes: Record<string, string>;
  seed_manifest_sha256: string;
}

function validateFrozenSharedProbe(value: unknown, filePath: string): FrozenSharedProbeIdentity {
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_INPUT", "shared probe manifest must be an object", filePath);
  const allowed = [
    "schema_version",
    "shared_probe_manifest_id",
    "case_ids",
    "source_revisions",
    "case_source_revisions",
    "seed_manifest_sha256",
    "item_hashes",
    "output_hashes",
    "manifest_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_INPUT", "unknown shared probe field '" + key + "'", filePath);
  if (value.schema_version !== 1 || !Array.isArray(value.case_ids))
    failA1("CORRUPT_SCORER_INPUT", "shared probe manifest envelope is invalid", filePath);
  const caseIds = value.case_ids.map((caseId, index) =>
    assertIdentifier(caseId, filePath + ".case_ids[" + index + "]"),
  );
  const sortedCaseIds = [...caseIds].sort();
  if (
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id, index) => id !== sortedCaseIds[index])
  )
    failA1("CORRUPT_SCORER_INPUT", "shared probe case ids must be sorted and unique", filePath);
  const sourceRevisionsValue = value.source_revisions;
  const caseSourceRevisionsValue = value.case_source_revisions;
  const itemHashesValue = value.item_hashes;
  const outputHashesValue = value.output_hashes;
  if (
    !isRecord(sourceRevisionsValue) ||
    !isRecord(caseSourceRevisionsValue) ||
    !isRecord(itemHashesValue) ||
    !isRecord(outputHashesValue)
  )
    failA1("CORRUPT_SCORER_INPUT", "shared probe records are invalid", filePath);
  const sourceRevisions: Record<string, string[]> = {};
  const caseSourceRevisions: Record<string, string> = {};
  const itemHashes: Record<string, string> = {};
  const outputHashes: Record<string, string> = {};
  for (const caseId of caseIds) {
    const revisions = sourceRevisionsValue[caseId];
    if (
      !Array.isArray(revisions) ||
      revisions.length === 0 ||
      !revisions.every((revision) => typeof revision === "string")
    )
      failA1("CORRUPT_SCORER_INPUT", "shared probe source record is invalid", filePath);
    const sourceRevision = assertIdentifier(
      caseSourceRevisionsValue[caseId],
      filePath + ".case_source_revisions." + caseId,
    );
    if (!revisions.includes(sourceRevision))
      failA1("CORRUPT_SCORER_INPUT", "shared probe source is not listed for its case", filePath);
    revisions.forEach((revision, index) =>
      assertIdentifier(revision, filePath + ".source_revisions." + caseId + "[" + index + "]"),
    );
    sourceRevisions[caseId] = revisions.map((revision, index) =>
      assertIdentifier(revision, filePath + ".source_revisions." + caseId + "[" + index + "]"),
    );
    caseSourceRevisions[caseId] = sourceRevision;
    itemHashes[caseId] = assertSha256(itemHashesValue[caseId], filePath + ".item_hashes." + caseId);
    outputHashes[caseId] = assertSha256(
      outputHashesValue[caseId],
      filePath + ".output_hashes." + caseId,
    );
  }
  for (const record of [
    sourceRevisionsValue,
    caseSourceRevisionsValue,
    itemHashesValue,
    outputHashesValue,
  ])
    for (const key of Object.keys(record))
      if (!caseIds.includes(key))
        failA1("CORRUPT_SCORER_INPUT", "shared probe has an unknown case id", filePath);
  const seedManifestSha256 = assertSha256(
    value.seed_manifest_sha256,
    filePath + ".seed_manifest_sha256",
  );
  const base = {
    schema_version: 1 as const,
    case_ids: caseIds,
    source_revisions: sourceRevisions,
    case_source_revisions: caseSourceRevisions,
    seed_manifest_sha256: seedManifestSha256,
    item_hashes: itemHashes,
    output_hashes: outputHashes,
  };
  const manifestSha256 = assertSha256(value.manifest_sha256, filePath + ".manifest_sha256");
  if (
    manifestSha256 !==
    canonicalJsonSha256(base, undefined, { schemaVersion: "shared-probe-manifest-v1" })
  )
    failA1("CORRUPT_SCORER_INPUT", "shared probe manifest hash is invalid", filePath);
  if (value.shared_probe_manifest_id !== "shared-probe:sha256:" + manifestSha256)
    failA1("CORRUPT_SCORER_INPUT", "shared probe manifest id is invalid", filePath);
  return {
    manifest_sha256: manifestSha256,
    case_ids: caseIds,
    source_revisions: sourceRevisions,
    case_source_revisions: caseSourceRevisions,
    item_hashes: itemHashes,
    output_hashes: outputHashes,
    seed_manifest_sha256: seedManifestSha256,
  };
}

interface FrozenCaseManifestIdentity {
  manifest_sha256: string;
  scorer_revision: string;
  seed_manifest_sha256: string;
  case_ids: string[];
}

function validateFrozenCaseManifest(value: unknown, filePath: string): FrozenCaseManifestIdentity {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_INPUT", "case manifest must be an object", filePath);
  const allowed = [
    "schema_version",
    "manifest_id",
    "scorer_revision",
    "case_ids",
    "seed_manifest_sha256",
    "manifest_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_INPUT", "unknown case manifest field '" + key + "'", filePath);
  if (value.schema_version !== 1 || !Array.isArray(value.case_ids))
    failA1("CORRUPT_SCORER_INPUT", "case manifest envelope is invalid", filePath);
  const caseIds = value.case_ids.map((caseId, index) =>
    assertIdentifier(caseId, filePath + ".case_ids[" + index + "]"),
  );
  const sortedCaseIds = [...caseIds].sort();
  if (
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id, index) => id !== sortedCaseIds[index])
  )
    failA1("CORRUPT_SCORER_INPUT", "case manifest ids must be sorted and unique", filePath);
  const scorerRevision = assertIdentifier(value.scorer_revision, filePath + ".scorer_revision");
  const seedManifestSha256 = assertSha256(
    value.seed_manifest_sha256,
    filePath + ".seed_manifest_sha256",
  );
  const manifestSha256 = assertSha256(value.manifest_sha256, filePath + ".manifest_sha256");
  const base = {
    schema_version: 1 as const,
    scorer_revision: scorerRevision,
    case_ids: caseIds,
    seed_manifest_sha256: seedManifestSha256,
  };
  if (
    manifestSha256 !==
    canonicalJsonSha256(base, undefined, { schemaVersion: "scorer-case-manifest-v1" })
  )
    failA1("CORRUPT_SCORER_INPUT", "case manifest hash is invalid", filePath);
  if (value.manifest_id !== "case-manifest:sha256:" + manifestSha256)
    failA1("CORRUPT_SCORER_INPUT", "case manifest id is invalid", filePath);
  return {
    manifest_sha256: manifestSha256,
    scorer_revision: scorerRevision,
    seed_manifest_sha256: seedManifestSha256,
    case_ids: caseIds,
  };
}

const FORBIDDEN_EVALUATION_KEYS = new Set([
  "candidate",
  "candidate_rank",
  "candidate_ranking",
  "candidate_revision",
  "cell_scores",
  "dashboard",
  "incumbent",
  "model",
  "model_id",
  "model_override",
  "other_cell_scores",
  "prompt",
  "prompt_override",
  "selected_candidate_id",
  "scorer_revision",
  "scores",
  "wiki",
  "workflow",
  "workflow_id",
  "workflow_state",
  "adoption_state",
  "active_revision",
  "judge_binding_id",
]);

function rejectForbiddenEvaluationValue(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      rejectForbiddenEvaluationValue(child, location + "[" + index + "]"),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVALUATION_KEYS.has(key))
      failA1(
        "EVALUATION_SCOPE_VIOLATION",
        "evaluation input contains forbidden '" + key + "'",
        location,
      );
    rejectForbiddenEvaluationValue(child, location + "." + key);
  }
}

interface FrozenEvaluationItem {
  item_id: string;
  input: unknown;
  contract: string;
  source: string;
}

function validateFrozenEvaluationItem(value: unknown, location: string): FrozenEvaluationItem {
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_INPUT", "frozen evaluation item must be an object", location);
  for (const key of Object.keys(value))
    if (!["item_id", "input", "contract", "source"].includes(key))
      failA1(
        "CORRUPT_SCORER_INPUT",
        "unknown frozen evaluation item field '" + key + "'",
        location,
      );
  if (!Object.hasOwn(value, "input"))
    failA1("CORRUPT_SCORER_INPUT", "frozen evaluation item input is missing", location);
  const item: FrozenEvaluationItem = {
    item_id: assertIdentifier(value.item_id, location + ".item_id"),
    input: value.input,
    contract: requireString(value.contract, location + ".contract"),
    source: assertIdentifier(value.source, location + ".source"),
  };
  rejectForbiddenEvaluationValue(item.input, location + ".input");
  canonicalJsonSha256(item, undefined, { schemaVersion: "evaluation-item-v1" });
  return item;
}

function validateFrozenSharedProbeInputs(
  projectRoot: string,
  state: ScorerRunState,
  seedManifest: unknown,
  parentManifest: FrozenCaseManifestIdentity,
  candidateManifest: FrozenCaseManifestIdentity,
  sharedProbe: FrozenSharedProbeIdentity,
): void {
  const filePath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    "shared-probe-inputs.json",
  );
  if (!fs.existsSync(filePath))
    failA1("SCORER_INPUTS_NOT_FROZEN", "shared probe item snapshot is missing at " + filePath);
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_INPUT", "shared probe inputs must be an object", filePath);
  const allowed = ["schema_version", "shared_probe_manifest_sha256", "items"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_INPUT", "unknown shared probe input field '" + key + "'", filePath);
  if (value.schema_version !== 1 || !Array.isArray(value.items))
    failA1("CORRUPT_SCORER_INPUT", "shared probe inputs envelope is invalid", filePath);
  if (
    assertSha256(value.shared_probe_manifest_sha256, filePath + ".shared_probe_manifest_sha256") !==
    sharedProbe.manifest_sha256
  )
    failA1("SCORER_INPUT_HASH_MISMATCH", "shared probe inputs name another manifest", filePath);
  const items = value.items.map((item, index) =>
    validateFrozenEvaluationItem(item, filePath + ".items[" + index + "]"),
  );
  if (
    items.length !== sharedProbe.case_ids.length ||
    items.some((item, index) => item.item_id !== sharedProbe.case_ids[index])
  )
    failA1(
      "CORRUPT_SCORER_INPUT",
      "shared probe inputs do not cover the frozen case set",
      filePath,
    );

  for (const item of items) {
    const caseId = item.item_id;
    const parentHasCase = parentManifest.case_ids.includes(caseId);
    const candidateHasCase = candidateManifest.case_ids.includes(caseId);
    const expectedSources: string[] = [];
    if (parentHasCase) expectedSources.push(state.parent_revision);
    if (candidateHasCase) expectedSources.push(state.candidate_revision);
    const actualSources = sharedProbe.source_revisions[caseId];
    if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources))
      failA1("SCORER_INPUT_CONFLICT", "shared probe source revisions are not frozen", filePath);
    const expectedSource = parentHasCase ? state.parent_revision : state.candidate_revision;
    if (
      sharedProbe.case_source_revisions[caseId] !== expectedSource ||
      item.source !== expectedSource
    )
      failA1("SCORER_INPUT_CONFLICT", "shared probe item source is not frozen", filePath);
    const itemHash = canonicalJsonSha256(
      { evaluation_item: item, seed_manifest: seedManifest },
      undefined,
      { schemaVersion: "shared-probe-item-v1" },
    );
    if (
      itemHash !== sharedProbe.item_hashes[caseId] ||
      sharedProbe.output_hashes[caseId] !== sharedProbe.item_hashes[caseId]
    )
      failA1(
        "SCORER_INPUT_CONFLICT",
        "shared probe item hash differs from its frozen manifest",
        filePath,
      );
  }
}

function readFrozenSharedProbe(
  projectRoot: string,
  scorerRunId: string,
): FrozenSharedProbeIdentity {
  const filePath = path.join(
    scorerRunDirectory(projectRoot, scorerRunId),
    "case-manifests",
    "shared-probe.json",
  );
  if (!fs.existsSync(filePath))
    failA1("SCORER_INPUTS_NOT_FROZEN", "shared probe manifest is missing at " + filePath);
  return validateFrozenSharedProbe(readStateFile(filePath), filePath);
}

interface StoredResultCheckpoint {
  results_sha256: string;
  shared_probe_manifest_sha256: string;
}

function readStoredResultCheckpoint(
  projectRoot: string,
  state: ScorerRunState,
  side: "parent" | "candidate",
  sharedProbe: FrozenSharedProbeIdentity,
): StoredResultCheckpoint {
  const filePath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    side + "-results.json",
  );
  if (!fs.existsSync(filePath))
    failA1("SCORER_RESULTS_INCOMPLETE", "sealed " + side + " results are missing at " + filePath);
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_RESULTS", "result checkpoint must be an object", filePath);
  const allowed = [
    "schema_version",
    "scorer_run_id",
    "side",
    "scorer_revision",
    "shared_probe_manifest_sha256",
    "complete",
    "results",
    "results_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_RESULTS", "unknown result checkpoint field '" + key + "'", filePath);
  const expectedRevision = side === "parent" ? state.parent_revision : state.candidate_revision;
  if (
    value.schema_version !== 1 ||
    value.scorer_run_id !== state.scorer_run_id ||
    value.side !== side ||
    value.scorer_revision !== expectedRevision ||
    value.shared_probe_manifest_sha256 !== sharedProbe.manifest_sha256 ||
    value.complete !== true ||
    !Array.isArray(value.results)
  )
    failA1(
      "SCORER_RESULTS_IDENTITY_MISMATCH",
      "result checkpoint identity is not frozen",
      filePath,
    );
  if (value.results.length !== sharedProbe.case_ids.length)
    failA1(
      "SCORER_RESULTS_INCOMPLETE",
      "result checkpoint does not cover the shared probe",
      filePath,
    );
  value.results.forEach((result, index) => {
    if (!isRecord(result))
      failA1("CORRUPT_SCORER_RESULTS", "result entry must be an object", filePath);
    if (result.item_id !== sharedProbe.case_ids[index])
      failA1("CORRUPT_SCORER_RESULTS", "result checkpoint item order is not frozen", filePath);
    if (typeof result.score !== "number" || !Number.isFinite(result.score))
      failA1("CORRUPT_SCORER_RESULTS", "result score must be finite", filePath);
    if (!Array.isArray(result.labels) || !result.labels.every((label) => typeof label === "string"))
      failA1("CORRUPT_SCORER_RESULTS", "result labels are invalid", filePath);
    assertSha256(result.output_sha256, filePath + ".results[" + index + "].output_sha256");
  });
  const resultsSha256 = assertSha256(value.results_sha256, filePath + ".results_sha256");
  if (resultsSha256 !== resultHash(value.results))
    failA1(
      "SCORER_RESULTS_HASH_MISMATCH",
      "result checkpoint hash does not match contents",
      filePath,
    );
  return {
    results_sha256: resultsSha256,
    shared_probe_manifest_sha256: sharedProbe.manifest_sha256,
  };
}

function assertScorerPlanFields(value: Record<string, unknown>, filePath: string): void {
  const allowed = [
    "schema_version",
    "workflow_id",
    "scorer_id",
    "scorer_run_id",
    "parent_revision",
    "candidate_revision",
    "parent_coverage_map_sha256",
    "candidate_coverage_map_sha256",
    "shared_probe_manifest_sha256",
    "seed_manifest",
    "seed_manifest_sha256",
    "representative_artifact_id",
    "representative_artifact_sha256",
    "input_snapshot_sha256",
    "model_assignment_sha256",
    "judge_binding_id",
    "plan_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_INPUT", "unknown experiment plan field '" + key + "'", filePath);
}

function readCompleteComparison(
  projectRoot: string,
  state: ScorerRunState,
): { comparison: ComparisonLike; parentHash: string; candidateHash: string } {
  assertImmutableScorerArtifacts(
    projectRoot,
    state.scorer_run_id,
    state.scorer_id,
    state.parent_revision,
    state.candidate_revision,
    state.delta_id,
  );
  const comparisonPath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    "comparison.json",
  );
  if (!fs.existsSync(comparisonPath))
    failA1("SCORER_RESULTS_INCOMPLETE", "scorer comparison is not sealed at " + comparisonPath);
  const value = readStateFile(comparisonPath);
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_COMPARISON", "scorer comparison must be an object", comparisonPath);
  const allowed = [
    "schema_version",
    "experiment_plan_sha256",
    "parent_revision",
    "candidate_revision",
    "judge_binding_id",
    "model_assignment_sha256",
    "representative_artifact_id",
    "representative_artifact_sha256",
    "input_snapshot_sha256",
    "parent_case_manifest",
    "candidate_case_manifest",
    "shared_probe_manifest",
    "parent_results",
    "candidate_results",
    "execution_order",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_COMPARISON", "unknown comparison field '" + key + "'", comparisonPath);
  if (value.schema_version !== 1)
    failA1("CORRUPT_SCORER_COMPARISON", "comparison schema_version must be 1", comparisonPath);
  if (
    !Array.isArray(value.execution_order) ||
    value.execution_order.length !== 2 ||
    value.execution_order[0] !== "parent" ||
    value.execution_order[1] !== "candidate"
  )
    failA1("SCORER_STATE_ORDER", "comparison execution order must be parent then candidate");
  const planPath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    "experiment-plan.json",
  );
  if (!fs.existsSync(planPath))
    failA1("SCORER_INPUTS_NOT_FROZEN", "experiment plan is missing at " + planPath);
  const planValue = readStateFile(planPath);
  if (!isRecord(planValue))
    failA1("CORRUPT_SCORER_INPUT", "experiment plan must be an object", planPath);
  assertScorerPlanFields(planValue, planPath);
  if (planValue.schema_version !== 1)
    failA1("CORRUPT_SCORER_INPUT", "experiment plan schema_version must be 1", planPath);
  const planSha256 = assertSha256(planValue.plan_sha256, planPath + ".plan_sha256");
  const planBase: Record<string, unknown> = { ...planValue };
  delete planBase.plan_sha256;
  if (
    planSha256 !==
    canonicalJsonSha256(planBase, undefined, { schemaVersion: "scorer-experiment-plan-v1" })
  )
    failA1(
      "SCORER_INPUT_HASH_MISMATCH",
      "experiment plan hash does not match its contents",
      planPath,
    );
  const planWorkflowId = assertIdentifier(planValue.workflow_id, planPath + ".workflow_id");
  const planScorerId = assertIdentifier(planValue.scorer_id, planPath + ".scorer_id");
  const planRunId = assertIdentifier(planValue.scorer_run_id, planPath + ".scorer_run_id");
  const planParentRevision = assertIdentifier(
    planValue.parent_revision,
    planPath + ".parent_revision",
  );
  const planCandidateRevision = assertIdentifier(
    planValue.candidate_revision,
    planPath + ".candidate_revision",
  );
  assertSha256(planValue.parent_coverage_map_sha256, planPath + ".parent_coverage_map_sha256");
  assertSha256(
    planValue.candidate_coverage_map_sha256,
    planPath + ".candidate_coverage_map_sha256",
  );
  const planSharedProbeManifestSha256 = assertSha256(
    planValue.shared_probe_manifest_sha256,
    planPath + ".shared_probe_manifest_sha256",
  );
  const planSeedManifestSha256 = assertSha256(
    planValue.seed_manifest_sha256,
    planPath + ".seed_manifest_sha256",
  );
  if (
    planSeedManifestSha256 !==
    canonicalJsonSha256(planValue.seed_manifest, undefined, {
      schemaVersion: "scorer-seed-manifest-v1",
    })
  )
    failA1(
      "SCORER_INPUT_HASH_MISMATCH",
      "seed manifest hash does not match its contents",
      planPath,
    );
  assertIdentifier(planValue.representative_artifact_id, planPath + ".representative_artifact_id");
  assertSha256(
    planValue.representative_artifact_sha256,
    planPath + ".representative_artifact_sha256",
  );
  assertSha256(planValue.input_snapshot_sha256, planPath + ".input_snapshot_sha256");
  assertSha256(planValue.model_assignment_sha256, planPath + ".model_assignment_sha256");
  if (planValue.judge_binding_id !== null)
    assertIdentifier(planValue.judge_binding_id, planPath + ".judge_binding_id");
  const comparisonPlanSha256 = assertSha256(
    value.experiment_plan_sha256,
    comparisonPath + ".experiment_plan_sha256",
  );
  const comparisonParentRevision = assertIdentifier(
    value.parent_revision,
    comparisonPath + ".parent_revision",
  );
  const comparisonCandidateRevision = assertIdentifier(
    value.candidate_revision,
    comparisonPath + ".candidate_revision",
  );
  if (
    comparisonPlanSha256 !== planSha256 ||
    comparisonParentRevision !== state.parent_revision ||
    comparisonCandidateRevision !== state.candidate_revision ||
    planWorkflowId !== state.workflow_id ||
    planScorerId !== state.scorer_id ||
    planRunId !== state.scorer_run_id ||
    planParentRevision !== state.parent_revision ||
    planCandidateRevision !== state.candidate_revision
  )
    failA1("SCORER_INPUT_CONFLICT", "comparison plan does not match the scorer run");
  const comparisonFields: Array<[string, unknown]> = [
    ["judge_binding_id", planValue.judge_binding_id],
    [
      "model_assignment_sha256",
      assertSha256(planValue.model_assignment_sha256, planPath + ".model_assignment_sha256"),
    ],
    [
      "representative_artifact_id",
      assertIdentifier(
        planValue.representative_artifact_id,
        planPath + ".representative_artifact_id",
      ),
    ],
    [
      "representative_artifact_sha256",
      assertSha256(
        planValue.representative_artifact_sha256,
        planPath + ".representative_artifact_sha256",
      ),
    ],
    [
      "input_snapshot_sha256",
      assertSha256(planValue.input_snapshot_sha256, planPath + ".input_snapshot_sha256"),
    ],
  ];
  for (const [field, expected] of comparisonFields)
    if (value[field] !== expected)
      failA1("SCORER_INPUT_CONFLICT", "comparison field '" + field + "' differs from its plan");

  const scorerBase = path.join(path.resolve(projectRoot), ".aris", "scorers", state.scorer_id);
  const parentDefinitionPath = path.join(
    scorerBase,
    "revisions",
    state.parent_revision,
    "definition.json",
  );
  const candidateDefinitionPath = path.join(
    scorerBase,
    "revisions",
    state.candidate_revision,
    "definition.json",
  );
  const parentRevision = validateScorerRevision(readStateFile(parentDefinitionPath));
  const candidateRevision = validateScorerRevision(readStateFile(candidateDefinitionPath));
  if (
    parentRevision.coverage_map_sha256 !== planValue.parent_coverage_map_sha256 ||
    candidateRevision.coverage_map_sha256 !== planValue.candidate_coverage_map_sha256
  )
    failA1("SCORER_INPUT_CONFLICT", "stored scorer coverage differs from the frozen plan");

  const parentManifestPath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    "case-manifests",
    "parent.json",
  );
  const candidateManifestPath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    "case-manifests",
    "candidate.json",
  );
  const sharedManifestPath = path.join(
    scorerRunDirectory(projectRoot, state.scorer_run_id),
    "case-manifests",
    "shared-probe.json",
  );
  for (const manifestPath of [parentManifestPath, candidateManifestPath, sharedManifestPath])
    if (!fs.existsSync(manifestPath))
      failA1("SCORER_INPUTS_NOT_FROZEN", "fixed case manifest is missing at " + manifestPath);
  const fixedParent = readStateFile(parentManifestPath);
  const fixedCandidate = readStateFile(candidateManifestPath);
  const fixedShared = readStateFile(sharedManifestPath);
  if (
    canonicalJsonSha256(value.parent_case_manifest) !== canonicalJsonSha256(fixedParent) ||
    canonicalJsonSha256(value.candidate_case_manifest) !== canonicalJsonSha256(fixedCandidate) ||
    canonicalJsonSha256(value.shared_probe_manifest) !== canonicalJsonSha256(fixedShared)
  )
    failA1("SCORER_INPUT_CONFLICT", "comparison does not use the fixed case manifests");
  const parentManifest = validateFrozenCaseManifest(fixedParent, parentManifestPath);
  const candidateManifest = validateFrozenCaseManifest(fixedCandidate, candidateManifestPath);
  const shared = validateFrozenSharedProbe(fixedShared, sharedManifestPath);
  if (!isRecord(value.shared_probe_manifest))
    failA1("CORRUPT_SCORER_COMPARISON", "comparison shared probe is not an object", comparisonPath);
  if (
    value.shared_probe_manifest.manifest_sha256 !== shared.manifest_sha256 ||
    shared.manifest_sha256 !== planSharedProbeManifestSha256
  )
    failA1("SCORER_INPUT_CONFLICT", "comparison shared probe identity is not fixed");
  if (
    parentManifest.scorer_revision !== state.parent_revision ||
    candidateManifest.scorer_revision !== state.candidate_revision ||
    JSON.stringify(parentManifest.case_ids) !== JSON.stringify(activeCaseIds(parentRevision)) ||
    JSON.stringify(candidateManifest.case_ids) !==
      JSON.stringify(activeCaseIds(candidateRevision)) ||
    parentManifest.seed_manifest_sha256 !== candidateManifest.seed_manifest_sha256 ||
    parentManifest.seed_manifest_sha256 !== planSeedManifestSha256 ||
    shared.seed_manifest_sha256 !== planSeedManifestSha256 ||
    JSON.stringify(shared.case_ids) !==
      JSON.stringify(
        [...new Set([...parentManifest.case_ids, ...candidateManifest.case_ids])].sort(),
      )
  )
    failA1("SCORER_INPUT_CONFLICT", "fixed case manifests do not match the frozen plan");
  validateFrozenSharedProbeInputs(
    projectRoot,
    state,
    planValue.seed_manifest,
    parentManifest,
    candidateManifest,
    shared,
  );
  const caseIds = shared.case_ids;
  const parentResults = value.parent_results;
  const candidateResults = value.candidate_results;
  if (!Array.isArray(parentResults) || !Array.isArray(candidateResults))
    failA1("SCORER_RESULTS_INCOMPLETE", "parent and candidate results are not arrays");
  if (parentResults.length !== caseIds.length || candidateResults.length !== caseIds.length)
    failA1("SCORER_RESULTS_INCOMPLETE", "parent and candidate results are not complete");
  const validateComparisonResults = (results: unknown[], label: string): void => {
    results.forEach((result, index) => {
      if (!isRecord(result))
        failA1("CORRUPT_SCORER_COMPARISON", label + " result must be an object");
      const resultKeys = ["item_id", "score", "labels", "output_sha256"];
      for (const key of Object.keys(result))
        if (!resultKeys.includes(key))
          failA1("CORRUPT_SCORER_COMPARISON", "unknown " + label + " result field '" + key + "'");
      if (result.item_id !== caseIds[index])
        failA1("SCORER_RESULTS_INCOMPLETE", label + " results do not cover the shared probe");
      if (typeof result.score !== "number" || !Number.isFinite(result.score))
        failA1("CORRUPT_SCORER_COMPARISON", label + " score must be finite");
      if (
        !Array.isArray(result.labels) ||
        !result.labels.every((labelValue) => typeof labelValue === "string")
      )
        failA1("CORRUPT_SCORER_COMPARISON", label + " labels are invalid");
      assertSha256(
        result.output_sha256,
        comparisonPath + "." + label + "[" + index + "].output_sha256",
      );
    });
  };
  validateComparisonResults(parentResults, "parent");
  validateComparisonResults(candidateResults, "candidate");
  const parentCheckpoint = readStoredResultCheckpoint(projectRoot, state, "parent", shared);
  const candidateCheckpoint = readStoredResultCheckpoint(projectRoot, state, "candidate", shared);
  if (
    parentCheckpoint.results_sha256 !== resultHash(parentResults) ||
    candidateCheckpoint.results_sha256 !== resultHash(candidateResults)
  )
    failA1("SCORER_RESULTS_HASH_MISMATCH", "comparison results differ from sealed checkpoints");
  const comparison = value as unknown as ComparisonLike;
  return {
    comparison,
    parentHash: resultHash(parentResults),
    candidateHash: resultHash(candidateResults),
  };
}

function sealResults(
  projectRoot: string,
  scorerRunIdValue: string,
  side: "parent" | "candidate",
  suppliedResultValue?: unknown,
): ScorerRunState {
  const scorerRunId = assertRunId(scorerRunIdValue, "scorer_run_id");
  requireRunContract(projectRoot, scorerRunId);
  const statePath = scorerRunStatePath(projectRoot, scorerRunId);
  return withStateFileLock(statePath, () => {
    const current = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
    assertStateWaveProof(projectRoot, current, true);
    const sharedProbe = readFrozenSharedProbe(projectRoot, scorerRunId);
    const comparisonPath = path.join(
      scorerRunDirectory(projectRoot, scorerRunId),
      "comparison.json",
    );
    if (side === "candidate" && !fs.existsSync(comparisonPath))
      failA1(
        "SCORER_RESULTS_INCOMPLETE",
        "candidate results cannot be sealed before the complete comparison is stored",
      );
    const checkpoint = readStoredResultCheckpoint(projectRoot, current, side, sharedProbe);
    let resultSha256: string = checkpoint.results_sha256;
    const sharedHash: string = checkpoint.shared_probe_manifest_sha256;
    if (fs.existsSync(comparisonPath)) {
      const complete = readCompleteComparison(projectRoot, current);
      const comparisonResultHash = side === "parent" ? complete.parentHash : complete.candidateHash;
      if (comparisonResultHash !== resultSha256)
        failA1("SCORER_RESULTS_HASH_MISMATCH", "sealed result checkpoint differs from comparison");
      const comparisonSharedHash = assertSha256(
        complete.comparison.shared_probe_manifest.manifest_sha256,
        "shared_probe_manifest.manifest_sha256",
      );
      if (comparisonSharedHash !== sharedHash)
        failA1("SCORER_RESULTS_HASH_MISMATCH", "comparison uses a different shared probe");
    }
    if (suppliedResultValue !== undefined) {
      const suppliedHash =
        typeof suppliedResultValue === "string"
          ? assertSha256(suppliedResultValue, "scorer_result_sha256")
          : resultHash(suppliedResultValue as readonly unknown[]);
      if (suppliedHash !== resultSha256)
        failA1("SCORER_RESULTS_HASH_MISMATCH", "supplied result is not the sealed result");
    }
    if (side === "parent") {
      if (current.status !== "experimenting_parent")
        failA1("SCORER_STATE_ORDER", "parent can only seal during parent experiment");
      return updateState(projectRoot, statePath, current, "experimenting_candidate", {
        parent_sealed: true,
        parent_result_sha256: resultSha256,
        shared_probe_manifest_sha256: sharedHash,
      });
    }
    if (current.status !== "experimenting_candidate")
      failA1("SCORER_STATE_ORDER", "candidate can only seal during candidate experiment");
    return updateState(projectRoot, statePath, current, "experimenting_candidate", {
      candidate_sealed: true,
      candidate_result_sha256: resultSha256,
      shared_probe_manifest_sha256: sharedHash,
    });
  });
}

export function beginScorerParentExperiment(
  projectRoot: string,
  scorerRunId: string,
): ScorerRunState {
  return transitionScorerState(projectRoot, scorerRunId, "experimenting_parent");
}

export function sealScorerParent(
  projectRoot: string,
  scorerRunId: string,
  suppliedResultValue?: unknown,
): ScorerRunState {
  return sealResults(projectRoot, scorerRunId, "parent", suppliedResultValue);
}

export function sealScorerCandidate(
  projectRoot: string,
  scorerRunId: string,
  suppliedResultValue?: unknown,
): ScorerRunState {
  return sealResults(projectRoot, scorerRunId, "candidate", suppliedResultValue);
}

export function recoverScorerRun(projectRoot: string, scorerRunId: string): ScorerRunState {
  const state = readScorerState(projectRoot, scorerRunId);
  assertScorerWaveRegistration({
    project_root: projectRoot,
    workflow_id: state.workflow_id,
    scorer_id: state.scorer_id,
    scorer_run_id: state.scorer_run_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    parent_revision: state.parent_revision,
    candidate_revision: state.candidate_revision,
    delta_id: state.delta_id,
  });
  assertImmutableScorerArtifacts(
    projectRoot,
    state.scorer_run_id,
    state.scorer_id,
    state.parent_revision,
    state.candidate_revision,
    state.delta_id,
  );
  if (TERMINAL_STATUSES.has(state.status)) {
    writeDashboard(projectRoot, state);
    terminateScorerMarkers(projectRoot, state);
    return state;
  }
  if (
    readActiveParentRevision(projectRoot, state.workflow_id, state.scorer_id) !==
    state.active_parent_revision
  )
    failA1("SCORER_ACTIVE_CONFLICT", "scorer recovery parent is no longer active");
  beginScorerWave(projectRoot, state.scorer_id, state.scorer_run_id, state.workflow_id);
  writeDashboard(projectRoot, state);
  return state;
}

function assertStoredReview(
  projectRoot: string,
  scorerRunId: string,
  reviewValue: unknown,
): ScorerReviewReceipt {
  const review = readStoredReviewReceipt(projectRoot, reviewValue);
  if (review.reviewed_run_kind !== "scorer")
    failA1("REVIEW_TYPE_MISMATCH", "scorer state accepts only scorer review receipts");
  if (review.reviewed_run_id !== scorerRunId)
    failA1("IDENTITY_MISMATCH", "scorer review does not belong to this run");
  return review;
}

export function recordScorerReview(
  projectRoot: string,
  scorerRunId: string,
  reviewValue: unknown,
): ScorerRunState {
  assertStoredReview(projectRoot, scorerRunId, reviewValue);
  const statePath = scorerRunStatePath(projectRoot, scorerRunId);
  return withStateFileLock(statePath, () => {
    const current = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
    assertStateWaveProof(projectRoot, current, true);
    const review = assertStoredReview(projectRoot, scorerRunId, reviewValue);
    const alreadyRecorded = current.status === "reviewed" && current.review_id === review.review_id;
    if (
      !alreadyRecorded &&
      (current.status !== "experimenting_candidate" || !current.candidate_sealed)
    )
      failA1("SCORER_STATE_ORDER", "scorer review requires sealed candidate results");
    if (
      review.outer_iteration !== current.outer_iteration ||
      review.wave_id !== current.wave_id ||
      review.wave_kind !== "scorer" ||
      review.generation !== current.generation ||
      review.subject.parent_revision !== current.parent_revision ||
      review.subject.candidate_revision !== current.candidate_revision ||
      review.subject.delta_id !== current.delta_id
    )
      failA1("IDENTITY_MISMATCH", "scorer review subject does not match run");
    if (
      current.shared_probe_manifest_sha256 !== null &&
      review.subject.shared_probe_manifest_sha256 !== current.shared_probe_manifest_sha256
    )
      failA1("IDENTITY_MISMATCH", "scorer review does not name the sealed shared probe");
    assertActivationArtifacts(projectRoot, current, review);
    const complete = readCompleteComparison(projectRoot, current);
    if (
      current.parent_result_sha256 !== complete.parentHash ||
      current.candidate_result_sha256 !== complete.candidateHash ||
      current.shared_probe_manifest_sha256 !==
        complete.comparison.shared_probe_manifest.manifest_sha256
    )
      failA1(
        "SCORER_RESULTS_INCOMPLETE",
        "scorer review requires the complete sealed parent and candidate comparison",
      );
    if (alreadyRecorded) return current;
    return updateState(projectRoot, statePath, current, "reviewed", {
      review_id: review.review_id,
    });
  });
}

function assertActivationArtifacts(
  projectRoot: string,
  state: ScorerRunState,
  review: ScorerReviewReceipt,
): ScorerRevision {
  const scorerBase = path.join(path.resolve(projectRoot), ".aris", "scorers", state.scorer_id);
  const deltaPath = path.join(scorerBase, "deltas", state.delta_id + ".json");
  const parentPath = path.join(scorerBase, "revisions", state.parent_revision, "definition.json");
  const candidatePath = path.join(
    scorerBase,
    "revisions",
    state.candidate_revision,
    "definition.json",
  );
  const parentCoveragePath = path.join(path.dirname(parentPath), "coverage-map.json");
  const candidateCoveragePath = path.join(path.dirname(candidatePath), "coverage-map.json");
  for (const requiredPath of [
    deltaPath,
    parentPath,
    candidatePath,
    parentCoveragePath,
    candidateCoveragePath,
  ])
    if (!fs.existsSync(requiredPath))
      failA1(
        "SCORER_REVISION_NOT_FOUND",
        "immutable scorer artifact is missing at " + requiredPath,
      );
  const delta = validateScorerDelta(readStateFile(deltaPath));
  const parent = validateScorerRevision(readStateFile(parentPath));
  const candidate = validateScorerRevision(readStateFile(candidatePath));
  const storedParentCoverage = validateCoverageMap(readStateFile(parentCoveragePath));
  const storedCoverage = validateCoverageMap(readStateFile(candidateCoveragePath));
  if (canonicalJsonSha256(storedParentCoverage) !== canonicalJsonSha256(parent.coverage_map))
    failA1("SCORER_HASH_MISMATCH", "parent coverage map is not the stored immutable map");
  if (canonicalJsonSha256(storedCoverage) !== canonicalJsonSha256(candidate.coverage_map))
    failA1("SCORER_HASH_MISMATCH", "candidate coverage map is not the stored immutable map");
  if (
    delta.producer_scorer_run_id !== state.scorer_run_id ||
    delta.scorer_id !== state.scorer_id ||
    delta.parent_revision !== state.parent_revision ||
    parent.scorer_id !== state.scorer_id ||
    parent.revision !== state.parent_revision ||
    candidate.scorer_id !== state.scorer_id ||
    candidate.revision !== state.candidate_revision ||
    candidate.parent_revision !== parent.revision
  )
    failA1("IDENTITY_MISMATCH", "activation artifacts do not match the frozen scorer run");
  const expected = materializeScorerRevision(parent, delta, candidate.coverage_map);
  if (
    expected.revision !== candidate.revision ||
    expected.definition_sha256 !== candidate.definition_sha256 ||
    expected.coverage_map_sha256 !== candidate.coverage_map_sha256
  )
    failA1("SCORER_HASH_MISMATCH", "candidate is not the immutable materialization of its delta");
  if (
    review.subject.parent_revision !== parent.revision ||
    review.subject.delta_id !== delta.delta_id ||
    review.subject.coverage_map_sha256 !== candidate.coverage_map_sha256 ||
    review.subject.candidate_revision !== candidate.revision
  )
    failA1("IDENTITY_MISMATCH", "review does not name the immutable candidate coverage");
  return candidate;
}

export function activateScorerRevision(
  projectRoot: string,
  scorerRunIdValue: string,
  reviewValue: unknown,
): ScorerRunState {
  const scorerRunId = assertRunId(scorerRunIdValue, "scorer_run_id");
  requireRunContract(projectRoot, scorerRunId);
  const review = assertStoredReview(projectRoot, scorerRunId, reviewValue);
  if (
    review.reviewed_run_kind !== "scorer" ||
    review.verdict !== "approved" ||
    review.breadth_verdict !== "approved" ||
    review.depth_verdict !== "approved"
  )
    failA1("SCORER_REVIEW_REQUIRED", "active scorer requires approved breadth and depth review");
  const statePath = scorerRunStatePath(projectRoot, scorerRunId);
  return withStateFileLock(statePath, () => {
    const current = validateScorerState(readStateFile(statePath), scorerRunId, statePath);
    const storedReview = assertStoredReview(projectRoot, scorerRunId, review);
    assertStateWaveProof(projectRoot, current, current.status !== "activated");
    if (current.review_id !== storedReview.review_id)
      failA1("IDENTITY_MISMATCH", "stored scorer review differs from state");
    const candidate = assertActivationArtifacts(projectRoot, current, storedReview);
    const complete = readCompleteComparison(projectRoot, current);
    assertScorerWaveRegistration({
      project_root: projectRoot,
      workflow_id: current.workflow_id,
      scorer_id: current.scorer_id,
      scorer_run_id: current.scorer_run_id,
      outer_run_id: current.outer_run_id,
      outer_iteration: current.outer_iteration,
      wave_id: current.wave_id,
      parent_revision: current.parent_revision,
      candidate_revision: current.candidate_revision,
      delta_id: current.delta_id,
    });
    if (
      current.parent_result_sha256 === null ||
      current.candidate_result_sha256 === null ||
      current.shared_probe_manifest_sha256 === null ||
      current.parent_result_sha256 !== complete.parentHash ||
      current.candidate_result_sha256 !== complete.candidateHash ||
      current.shared_probe_manifest_sha256 !==
        complete.comparison.shared_probe_manifest.manifest_sha256 ||
      storedReview.subject.shared_probe_manifest_sha256 !== current.shared_probe_manifest_sha256
    )
      failA1(
        "SCORER_RESULTS_INCOMPLETE",
        "activation needs complete sealed parent/candidate results",
      );

    if (current.status === "activated") {
      if (current.active_revision !== candidate.revision)
        failA1("IDENTITY_MISMATCH", "activated scorer state names another revision");
    } else if (current.status !== "reviewed" || current.review_id !== storedReview.review_id) {
      failA1("SCORER_STATE_ORDER", "scorer revision must be reviewed before activation");
    }

    const activePath = activeScorerPointerPath(projectRoot, current.workflow_id);
    withStateFileLock(activePath, () => {
      const expectedPointer = {
        schema_version: 1,
        workflow_id: current.workflow_id,
        scorer_id: current.scorer_id,
        revision: candidate.revision,
        scorer_run_id: current.scorer_run_id,
      };
      if (!fs.existsSync(activePath)) {
        if (current.status !== "activated")
          failA1("ACTIVE_SCORER_NOT_FOUND", "active scorer disappeared before CAS activation");
        writeStateJsonAtomic(activePath, expectedPointer);
        return;
      }
      const existing = readStateFile(activePath);
      if (!isRecord(existing))
        failA1("CORRUPT_ACTIVE_SCORER", "workflow active scorer pointer must be an object");
      if (existing.schema_version !== 1)
        failA1("CORRUPT_ACTIVE_SCORER", "workflow active scorer pointer schema_version must be 1");
      if (existing.workflow_id !== current.workflow_id || existing.scorer_id !== current.scorer_id)
        failA1("IDENTITY_MISMATCH", "workflow active scorer belongs to another scorer");
      const existingRevision = assertIdentifier(existing.revision, activePath + ".revision");
      if (current.status === "activated") {
        if (
          existingRevision !== candidate.revision ||
          existing.scorer_run_id !== current.scorer_run_id
        )
          failA1(
            "SCORER_ACTIVE_CONFLICT",
            "activated scorer pointer was replaced by another revision",
          );
        if (canonicalJsonSha256(existing) !== canonicalJsonSha256(expectedPointer))
          writeStateJsonAtomic(activePath, expectedPointer);
        return;
      }
      if (existingRevision === candidate.revision) {
        if (existing.scorer_run_id !== current.scorer_run_id)
          failA1(
            "SCORER_ACTIVE_CONFLICT",
            "candidate pointer belongs to another scorer experiment",
          );
        if (canonicalJsonSha256(existing) !== canonicalJsonSha256(expectedPointer))
          writeStateJsonAtomic(activePath, expectedPointer);
        return;
      }
      if (existingRevision !== current.active_parent_revision)
        failA1(
          "SCORER_ACTIVE_CONFLICT",
          "active scorer changed after this experiment froze its parent revision",
        );
      writeStateJsonAtomic(activePath, expectedPointer);
    });
    if (current.status === "activated") {
      writeDashboard(projectRoot, current);
      terminateScorerMarkers(projectRoot, current);
      return current;
    }
    return updateState(
      projectRoot,
      statePath,
      current,
      "activated",
      {
        active_revision: candidate.revision,
      },
      true,
    );
  });
}

export function rejectScorerRevision(projectRoot: string, scorerRunId: string): ScorerRunState {
  return transitionScorerState(projectRoot, scorerRunId, "rejected");
}
