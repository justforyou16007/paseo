import { runBudgetExhausted, settleExecutionReceipt } from "./run-budget.js";
import { runOwnedPath } from "./run-contract.js";
import {
  sealWikiWorkerManifest,
  readWikiWorkerManifest,
  wikiWorkerManifestPath,
} from "./research-wiki.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertRelativePath,
  assertSha256,
  failA1,
  isRecord,
  requireBoolean,
  requireFiniteNumber,
  requireInteger,
  requireString,
  validateWorkflowSpec,
  type WorkflowSpec,
} from "./workflow-spec.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertCandidateWithinFrozenLimits,
  candidateIdFromSnapshot,
  compileWorkflow,
  pathForCompiledCandidate,
  validateCandidateSnapshot,
  type CandidateIdentityInput,
  type CandidateSnapshot,
  type CompiledWorkflow,
  type CompileOptions,
} from "./workflow-compiler.js";
import {
  selectUniqueFinalist,
  type ValidationBinding,
  type ValidationCellResult,
  type ValidationImprovement,
  type ValidationReview,
} from "./validation-gate.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  readTesterAgentConfig,
  testerAgentConfigSha256,
  type TesterAgentConfig,
} from "./tester-agent.js";
import {
  assertWorkflowConnectionsConnected,
  readWorkflowConnectionRecord,
} from "./workflow-interface.js";
import {
  materializeBridgeChildren,
  planExperimentBridge,
  type BridgeExpansionPlan,
  type ExperimentBridgeInput,
} from "./experiment-bridge.js";
import {
  createWorkflowDashboard,
  createWorkflowRuntimeState,
  frozenPolicyPath,
  frozenPolicyFingerprint,
  readFrozenPolicy,
  readWorkflowCycleSummary,
  readWorkflowRuntimeState,
  synchronizeWorkflowHistory,
  updateWorkflowDashboard,
  validateWorkflowRuntimeState,
  workflowCycleDirectory,
  workflowCycleRelativePath,
  workflowRuntimePath,
  writeWorkflowCycleSummary,
  writeWorkflowPhaseHistory,
  writeWorkflowRuntimeState,
  freezeOuterRun,
  type ActiveOuterCycle,
  type OuterBridgeFailure,
  type FreezeOuterRunInput,
  type OuterBudgetCategory,
  type OuterBudgetReservation,
  type OuterChildKind,
  type OuterChildRecord,
  type OuterChildStatus,
  type OuterCycleSummary,
  type OuterPhase,
  type OuterPhaseHistoryEntry,
  type OuterRuntimeStatus,
  type WorkflowRuntimeState,
  saveFrozenPolicy,
} from "./workflow-state.js";
import { readResultPackage, resultPackagePath, type ResultPackage } from "./result-package.js";
import {
  acquireRunScope,
  assertRunReferenceCompatible,
  deriveChildScopePath,
  normalizeScopePath,
  readRunScopeLeaseTokens,
  readRun,
  openExistingRun,
  requireRunContract,
  updateRun,
  runJsonPath,
  type RunIdentityInput,
  type RunRecord,
  type RunScopeLease,
} from "./run-contract.js";
import { readScorerRunState, scorerRunStatePath } from "./scorer-state.js";
import {
  readTesterRunState,
  readExposureLedger,
  testerRunStatePath,
  type TesterRunState,
} from "./tester-state.js";
import {
  evaluateWorkflowStopGate,
  readWorkflowStopDecision,
  writeWorkflowStopDecision,
  type StopBudgetSnapshot,
  type StopDecision,
  type StopExposureSnapshot,
  type StopPolicy,
} from "./workflow-stop-gate.js";

const OWNERSHIP_FILE = "outer-run-ownership.json";
const CONTROLLER_FILE = "outer-run-controller.lock";
const TERMINAL_RUNTIME_STATUSES = new Set<OuterRuntimeStatus>(["completed", "failed", "stopped"]);

export interface OuterRunOwnership {
  schema_version: 1;
  execution_root: string;
  status: "active" | "released";
  outer_run_id: string;
  project_root: string | null;
  task_id: string | null;
  workflow_id: string | null;
  runtime_status: OuterRuntimeStatus;
  owner_pid: number;
  acquired_at: string;
  updated_at: string;
  released_at: string | null;
}

export interface OuterRunIdentity {
  execution_root: string;
  project_root: string;
  outer_run_id: string;
  parent_run_id?: string | null;
  depth?: number;
  scope_path?: string;

  run_identity?: RunIdentityInput;
  output_hashes?: Record<string, string>;
  task_id?: string;
  workflow_id?: string;
}

export interface OuterRunLeaseInput extends OuterRunIdentity {
  mode?: "start" | "resume" | "control";
}

export interface OuterRunLease {
  readonly execution_root: string;
  readonly outer_run_id: string;
  readonly controller_token: string;
  readonly scope_path: string;
  close(): void;
  release(): void;
  /** Release a reservation that failed before runtime state existed. */
  abortSetup(): void;
}

export interface StartOuterRunInput extends OuterRunIdentity {
  freeze_input: FreezeOuterRunInput;
  tester_agent_config_path: string;
}

export interface ResumeOuterRunInput extends OuterRunIdentity {
  tester_agent_config_path: string;
  freeze_input?: FreezeOuterRunInput;
}

export interface EvidenceBundle {
  evidence_refs: string[];
  evidence_sha256: string;
  files: string[];
}

/**
 * The one production hand-off from the outer loop to the experiment bridge.
 * The bridge input contains the loop's idea positions and its validated
 * charter, baseline, and resource inventory. The outer layer owns the
 * project path and evidence list, so those cannot be smuggled in as a second
 * materialization request.
 */
export interface AutoResearchBridgeInput extends OuterRunIdentity {
  bridge: ExperimentBridgeInput;
  evidence_paths: readonly string[];
}

export interface AutoResearchBridgeResult {
  parent: RunRecord;
  evidence: EvidenceBundle;
  plan: BridgeExpansionPlan;
  children: RunRecord[];
  opened_children: RunRecord[];
}

export interface PhaseAdvanceInput extends OuterRunIdentity {
  from_phase: OuterPhase;
  to_phase: OuterPhase;
  evidence_paths: readonly string[];
  /** Frozen connection records required before a new node wave starts. */
  connection_ids?: readonly string[];
}

export interface BeginOuterCycleInput extends OuterRunIdentity {
  wave_id: string;
  wave_kind: "module" | "structure" | "scorer";
  evidence_paths: readonly string[];
  outer_iteration?: number;
  generation?: number;
}

/**
 * The outer experiment bridge writes its receipt and input manifest inside
 * the current cycle directory.  The scheduler records their bytes and keeps
 * the frozen input hash so a repair can only retry the same experiment.
 */
export interface RecordOuterBridgeFailureInput extends OuterRunIdentity {
  receipt_path: string;
  manifest_path?: string;
  evidence_paths: readonly string[];
}

export interface RecordOuterBridgeSuccessInput extends OuterRunIdentity {
  receipt_path: string;
  manifest_path?: string;
  evidence_paths: readonly string[];
}

export interface RecordOuterBridgeRepairInput extends OuterRunIdentity {
  repair_receipt_path: string;
  repair_manifest_path?: string;
  evidence_paths: readonly string[];
}

export interface RegisterOuterChildInput extends OuterRunIdentity {
  child_run_id: string;
  kind: OuterChildKind;
  /** Required for a module child: the module of the workflow spec it works on. */
  module_id?: string | null;
  outer_iteration?: number;
  generation?: number;
}

export interface OuterTesterArmMapping {
  schema_version: 1;
  tester_run_id: string;
  promotion_trial_id: string;
  arm_a: {
    name: "matching_baseline";
    artifact_id: string;
    artifact_sha256: string;
  };
  arm_b: {
    name: "finalist";
    artifact_id: string;
    artifact_sha256: string;
  };
  tester_definition_sha256: string;
  harness_sha256: string;
  input_distribution_sha256: string;
  model_assignment_sha256: string;
  judge_binding_id: string | null;
}

export interface ValidationGateRecord {
  schema_version: 1;
  outer_run_id: string;
  outer_iteration: number;
  candidate_ids: string[];
  finalist_id: string | null;
  selected_cell_id: string | null;
  validation_result: "passed" | "rejected" | "incomplete" | "not_run";
  evidence_refs: string[];
  evidence_sha256: string;
}

export interface RecordValidationGateInput extends OuterRunIdentity {
  candidate_ids?: readonly string[];
  finalist_id?: string | null;
  selected_cell_id?: string | null;
  selection?: {
    selected_candidate_id?: string | null;
    selected_cell_id?: string | null;
  };
  validation_result?: ValidationGateRecord["validation_result"];
  evidence_paths: readonly string[];
  /** The scheduler supplies the complete validation inputs; the gate chooses the finalist. */
  gate_input?: {
    plan: Parameters<typeof selectUniqueFinalist>[0];
    results: readonly ValidationCellResult[];
    plan_id: string;
    primary_direction: "higher_better" | "lower_better";
    improvement: ValidationImprovement;
    binding: ValidationBinding;
    review: ValidationReview;
  };
}

export interface PromotionGateRecord {
  schema_version: 1;
  outer_run_id: string;
  outer_iteration: number;
  tester_run_id: string;
  promotion_trial_id: string;
  result: "passed" | "rejected";
  tester_state_sha256: string;
  evidence_refs: string[];
  evidence_sha256: string;
}

export interface RecordPromotionGateInput extends OuterRunIdentity {
  tester_run_id: string;
  evidence_paths: readonly string[];
}

export interface CompleteOuterCycleInput extends OuterRunIdentity {
  status?: "completed" | "failed" | "stopped";
  target_reached?: boolean;
  evidence_paths: readonly string[];
  candidate_ids?: readonly string[];
  finalist_id?: string | null;
  promotion_trial_id?: string | null;
  validation_result?: ValidationGateRecord["validation_result"];
  promotion_result?: OuterCycleSummary["promotion_result"];
  tester_improved?: boolean | null;
}

export interface ReserveOuterBudgetInput extends OuterRunIdentity {
  reservation_id: string;
  category: OuterBudgetCategory;
  amount: number;
  unit: string;
  child_run_id?: string | null;
}

export interface CloseOuterBudgetInput extends OuterRunIdentity {
  reservation_id: string;
  evidence_paths: readonly string[];
}

export interface RecordStopDecisionInput extends OuterRunIdentity {
  policy: StopPolicy;
  budget?: Pick<StopBudgetSnapshot, "limit" | "unit">;
}

export interface FinishOuterRunInput extends OuterRunIdentity {
  outcome: "completed" | "failed" | "stopped";
  evidence_paths: readonly string[];
}

export interface CompileOuterCandidateInput extends OuterRunIdentity {
  candidate: unknown;
  spec: unknown;
  options?: Omit<CompileOptions, "candidate" | "workspace_root">;
}

export interface CompiledOuterCandidate {
  candidate_id: string;
  candidate: CandidateSnapshot;
  compilation: CompiledWorkflow;
  directory: string;
}

function normalizedDirectory(value: unknown, location: string): string {
  const directory = requireString(value, location);
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === "/")
    failA1("INVALID_PATH", "expected a normalized absolute directory", location);
  return directory;
}

interface NormalizedOuterRunIdentity extends Required<OuterRunIdentity> {}

function normalizedIdentity(input: OuterRunIdentity): NormalizedOuterRunIdentity {
  const executionRoot = normalizedDirectory(input.execution_root, "execution_root");
  const projectRoot = normalizedDirectory(input.project_root, "project_root");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const parentRunId =
    input.parent_run_id === undefined || input.parent_run_id === null
      ? null
      : assertIdentifier(input.parent_run_id, "parent_run_id");
  const parent = parentRunId === null ? null : readRun(projectRoot, parentRunId);
  const depth = requireInteger(input.depth ?? (parent === null ? 0 : parent.depth + 1), "depth", 0);

  const normalizedScope = normalizeScopePath(
    input.scope_path ??
      (parent === null ? "/" : deriveChildScopePath(projectRoot, parent.run_id, outerRunId)),
  );
  assertRunReferenceCompatible(projectRoot, {
    run_id: outerRunId,
    parent_run_id: parentRunId,
    depth,
    scope_path: normalizedScope,
  });
  return {
    execution_root: executionRoot,
    project_root: projectRoot,
    outer_run_id: outerRunId,
    parent_run_id: parentRunId,
    depth,
    scope_path: normalizedScope,

    run_identity: input.run_identity ?? {},
    output_hashes: input.output_hashes ?? {},
    task_id: input.task_id === undefined ? "" : assertIdentifier(input.task_id, "task_id"),
    workflow_id:
      input.workflow_id === undefined ? "" : assertIdentifier(input.workflow_id, "workflow_id"),
  };
}

function now(): string {
  return new Date().toISOString();
}

function hashBytes(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

interface ValidatedOuterBridgeFiles {
  receiptPath: string;
  manifestPath: string;
  receiptRef: string;
  manifestRef: string;
  receiptSha256: string;
  manifestSha256: string;
  receipt: Record<string, unknown>;
  manifest: Record<string, unknown>;
  frozenInputSha256: string;
  error: Record<string, unknown> | null;
}

function outerRunRoot(projectRoot: string, outerRunId: string): string {
  return path.dirname(workflowRuntimePath(projectRoot, outerRunId));
}

type StartPreflightFile =
  | "workflow-runtime.json"
  | "workflow-dashboard.json"
  | "frozen-policy.json";

/**
 * Start needs to check these files before it writes runtime state. Keep this
 * lookup private to the start workflow; ordinary callers must use the gated
 * workflow paths from workflow-state.ts.
 */
function startPreflightPath(
  projectRoot: string,
  outerRunId: string,
  fileName: StartPreflightFile,
): string {
  return path.join(
    path.dirname(runJsonPath(projectRoot, assertIdentifier(outerRunId, "outer_run_id"))),
    fileName,
  );
}

function assertRealPathInside(parent: string, child: string, code: string, message: string): void {
  let realParent: string;
  let realChild: string;
  try {
    realParent = fs.realpathSync.native(parent);
    realChild = fs.realpathSync.native(child);
  } catch {
    failA1(code, message);
  }
  const relative = path.relative(realParent, realChild);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    failA1(code, message);
}

function resolveOuterCycleFile(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  supplied: string,
  expectedBasename: string,
  location: string,
): { absolute: string; ref: string } {
  const cycleRoot = workflowCycleDirectory(projectRoot, outerRunId, outerIteration);
  const runRoot = outerRunRoot(projectRoot, outerRunId);
  if (!fs.existsSync(cycleRoot)) fs.mkdirSync(cycleRoot, { recursive: true });
  const candidates = path.isAbsolute(supplied)
    ? [path.resolve(supplied)]
    : (() => {
        const relative = assertRelativePath(supplied, location);
        return [
          path.resolve(cycleRoot, relative),
          path.resolve(runRoot, relative),
          path.resolve(projectRoot, relative),
        ];
      })();
  const candidate = candidates.find((item) => fs.existsSync(item));
  if (candidate === undefined)
    failA1("OUTER_BRIDGE_FILE_NOT_FOUND", `bridge file does not exist for ${location}`);
  const absolute = fs.realpathSync(candidate);
  if (path.basename(absolute) !== expectedBasename)
    failA1("INVALID_PATH", `${location} must name ${expectedBasename}`);
  assertRealPathInside(
    cycleRoot,
    absolute,
    "PATH_ESCAPE",
    `${location} escapes the cycle directory`,
  );
  assertRealPathInside(runRoot, absolute, "PATH_ESCAPE", `${location} escapes the outer run`);
  if (!fs.statSync(absolute).isFile()) failA1("INVALID_PATH", `${location} must name a file`);
  const ref = path.relative(cycleRoot, absolute).split(path.sep).join("/");
  return { absolute, ref: assertRelativePath(ref, location) };
}

function assertOptionalOuterIdentity(
  record: Record<string, unknown>,
  outerRunId: string,
  cycle: ActiveOuterCycle,
  location: string,
): void {
  const embeddedRunId = record.outer_run_id ?? record.run_id;
  if (embeddedRunId === undefined)
    failA1("IDENTITY_MISMATCH", `${location} must declare its outer run id`);
  if (embeddedRunId !== outerRunId)
    failA1("IDENTITY_MISMATCH", `${location} does not belong to this outer run`);
  if (
    record.outer_run_id !== undefined &&
    record.run_id !== undefined &&
    record.outer_run_id !== record.run_id
  )
    failA1("IDENTITY_MISMATCH", `${location} has conflicting run ids`);
  for (const field of ["outer_iteration", "generation"] as const) {
    if (record[field] !== undefined && record[field] !== cycle[field])
      failA1("IDENTITY_MISMATCH", `${location}.${field} does not match the active cycle`);
  }
  if (record.wave_id !== undefined && record.wave_id !== cycle.wave_id)
    failA1("IDENTITY_MISMATCH", `${location}.wave_id does not match the active cycle`);
}

function manifestOutputDirectory(
  projectRoot: string,
  manifestPath: string,
  manifest: Record<string, unknown>,
): string {
  const outputDirValue = requireString(manifest.output_dir, "bridge manifest.output_dir");
  const expected = path.resolve(path.dirname(manifestPath), "outputs");
  const candidates = [
    path.resolve(projectRoot, outputDirValue),
    path.resolve(path.dirname(manifestPath), outputDirValue),
  ];
  const outputDir = candidates.find((candidate) => candidate === expected);
  if (outputDir === undefined)
    failA1("IDENTITY_MISMATCH", "bridge manifest output_dir must be its worker outputs directory");
  return outputDir;
}

function validateOuterBridgeFiles(
  projectRoot: string,
  outerRunId: string,
  cycle: ActiveOuterCycle,
  receiptPathInput: string,
  manifestPathInput: string | undefined,
  kind: "failure" | "success" | "repair",
): ValidatedOuterBridgeFiles {
  const receipt = resolveOuterCycleFile(
    projectRoot,
    outerRunId,
    cycle.outer_iteration,
    receiptPathInput,
    "receipt.json",
    "receipt_path",
  );
  const manifest = manifestPathInput
    ? resolveOuterCycleFile(
        projectRoot,
        outerRunId,
        cycle.outer_iteration,
        manifestPathInput,
        "input-manifest.json",
        "manifest_path",
      )
    : resolveOuterCycleFile(
        projectRoot,
        outerRunId,
        cycle.outer_iteration,
        path.join(path.dirname(receipt.absolute), "input-manifest.json"),
        "input-manifest.json",
        "manifest_path",
      );
  if (path.dirname(receipt.absolute) !== path.dirname(manifest.absolute))
    failA1("IDENTITY_MISMATCH", "bridge receipt and manifest must share a worker directory");
  const receiptValue = readStateFile(receipt.absolute);
  const manifestValue = readStateFile(manifest.absolute);
  if (!isRecord(receiptValue) || !isRecord(manifestValue))
    failA1("INVALID_EXECUTION_RECEIPT", "bridge receipt and manifest must be JSON objects");
  assertOptionalOuterIdentity(receiptValue, outerRunId, cycle, "bridge receipt");
  assertOptionalOuterIdentity(manifestValue, outerRunId, cycle, "bridge manifest");
  const expectedWorker = kind === "repair" ? "auto-review-loop" : "experiment-bridge";
  if (receiptValue.worker !== expectedWorker || manifestValue.worker !== expectedWorker)
    failA1("WORKER_NOT_ALLOWED", "bridge receipt worker is not allowed for this transition");
  const receiptPhase = receiptValue.phase;
  const manifestPhase = manifestValue.phase;
  if (
    kind === "repair"
      ? !["bridge-repair", "auto-review-loop"].includes(String(receiptPhase))
      : receiptPhase !== "experiment-bridge"
  )
    failA1("IDENTITY_MISMATCH", "bridge receipt phase is invalid");
  if (manifestPhase !== receiptPhase)
    failA1("IDENTITY_MISMATCH", "bridge receipt and manifest phases differ");
  if (
    kind === "repair" &&
    (!isRecord(manifestValue.context) || manifestValue.context.purpose !== "bridge_repair")
  )
    failA1("INVALID_REPAIR_RECEIPT", "bridge repair manifest must declare bridge_repair purpose");
  if (!isRecord(manifestValue.inputs) || !isRecord(manifestValue.context))
    failA1("INVALID_EXECUTION_RECEIPT", "bridge manifest needs frozen inputs and context");
  manifestOutputDirectory(projectRoot, manifest.absolute, manifestValue);
  const status = receiptValue.status;
  const hasOutput =
    receiptValue.primary_output !== null && receiptValue.primary_output !== undefined;
  if (kind === "failure") {
    const unusable = status === "failed" || (status === "done" && !hasOutput);
    if (!unusable)
      failA1(
        "BRIDGE_FAILURE_UNSUPPORTED",
        "bridge failure transition needs a failed or unusable receipt",
      );
    if (receiptValue.primary_output !== null)
      failA1("INVALID_EXECUTION_RECEIPT", "failed bridge receipt must not contain an output");
    if (status === "failed" && !isRecord(receiptValue.error))
      failA1("INVALID_EXECUTION_RECEIPT", "failed bridge receipt needs a structured error");
    if (
      receiptValue.dashboard_patch !== undefined &&
      (!isRecord(receiptValue.dashboard_patch) ||
        Object.keys(receiptValue.dashboard_patch).length > 0)
    )
      failA1("INVALID_EXECUTION_RECEIPT", "failed bridge receipt must not patch outer state");
  } else if (kind === "repair") {
    if (status !== "done" || hasOutput)
      failA1("INVALID_REPAIR_RECEIPT", "bridge repair must finish without an output");
    if (
      receiptValue.dashboard_patch !== undefined &&
      receiptValue.dashboard_patch !== null &&
      (!isRecord(receiptValue.dashboard_patch) ||
        Object.keys(receiptValue.dashboard_patch).length > 0)
    )
      failA1("INVALID_REPAIR_RECEIPT", "bridge repair receipt must not patch outer state");
    if (!isRecord(receiptValue.summary))
      failA1("INVALID_REPAIR_RECEIPT", "bridge repair receipt needs a summary");
    const repairStatus = receiptValue.summary.repair_status;
    if (repairStatus !== "fixed" && repairStatus !== "exhausted")
      failA1("INVALID_REPAIR_RECEIPT", "bridge repair summary needs fixed or exhausted status");
  } else {
    if (status !== "done" || !hasOutput)
      failA1("BRIDGE_SUCCESS_REQUIRED", "bridge success needs a complete output receipt");
    const outputDir = manifestOutputDirectory(projectRoot, manifest.absolute, manifestValue);
    const primaryOutput = requireString(
      receiptValue.primary_output,
      "bridge receipt.primary_output",
    );
    if (path.isAbsolute(primaryOutput) || primaryOutput.split(/[\\/]/).includes(".."))
      failA1("PATH_ESCAPE", "bridge primary output must stay in its outputs directory");
    const primaryPath = path.resolve(outputDir, primaryOutput);
    const relative = path.relative(outputDir, primaryPath);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      failA1("PATH_ESCAPE", "bridge primary output escapes its outputs directory");
    assertRealPathInside(
      outerRunRoot(projectRoot, outerRunId),
      primaryPath,
      "PATH_ESCAPE",
      "bridge output escapes the outer run",
    );
    const declared = assertSha256(
      receiptValue.primary_output_sha256 ?? receiptValue.output_sha256,
      "bridge receipt.primary_output_sha256",
    );
    if (hashBytes(primaryPath) !== declared)
      failA1("PRIMARY_OUTPUT_HASH_MISMATCH", "bridge primary output hash is stale");
  }
  const error = isRecord(receiptValue.error)
    ? receiptValue.error
    : status === "done" && !hasOutput
      ? { category: "no_analyzable_artifact" }
      : null;
  return {
    receiptPath: receipt.absolute,
    manifestPath: manifest.absolute,
    receiptRef: receipt.ref,
    manifestRef: manifest.ref,
    receiptSha256: hashBytes(receipt.absolute),
    manifestSha256: hashBytes(manifest.absolute),
    receipt: receiptValue,
    manifest: manifestValue,
    frozenInputSha256: canonicalJsonSha256(
      { inputs: manifestValue.inputs, context: manifestValue.context },
      undefined,
      { schemaVersion: "outer-bridge-input-v1" },
    ),
    error,
  };
}

function assertStoredBridgeFile(
  projectRoot: string,
  outerRunId: string,
  cycle: ActiveOuterCycle,
  ref: string,
  expectedSha256: string,
  location: string,
): string {
  const file = resolveOuterCycleFile(
    projectRoot,
    outerRunId,
    cycle.outer_iteration,
    path.join(workflowCycleDirectory(projectRoot, outerRunId, cycle.outer_iteration), ref),
    path.basename(ref),
    location,
  );
  if (hashBytes(file.absolute) !== expectedSha256)
    failA1("IMMUTABLE_CONFLICT", `${location} changed after it was recorded`);
  return file.absolute;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertEvidencePath(
  projectRoot: string,
  target: string,
): { absolute: string; ref: string } {
  const project = fs.realpathSync(projectRoot);
  const candidate = path.isAbsolute(target) ? target : path.resolve(project, target);
  if (!fs.existsSync(candidate))
    failA1("OUTER_EVIDENCE_NOT_FOUND", `evidence file does not exist at ${candidate}`);
  const absolute = fs.realpathSync(candidate);
  if (!inside(project, absolute) || !fs.statSync(absolute).isFile())
    failA1("OUTER_EVIDENCE_INVALID", "outer evidence must be a file below project_root");
  const basename = path.basename(absolute);
  if (basename === "private-result.json" || basename === "private-result.ref.json")
    failA1("TESTER_PRIVATE_DATA_ACCESSIBLE", "private tester result cannot be outer evidence");
  const ref = path.relative(project, absolute).split(path.sep).join("/");
  return { absolute, ref };
}

export function hashOuterEvidence(
  projectRoot: string,
  evidencePaths: readonly string[],
): EvidenceBundle {
  if (evidencePaths.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "at least one evidence file is required");
  const files = evidencePaths.map((item) => assertEvidencePath(projectRoot, item));
  const unique = new Map(files.map((item) => [item.ref, item]));
  if (unique.size !== files.length) failA1("DUPLICATE_ID", "outer evidence paths must be unique");
  const entries = [...unique.values()]
    .sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)))
    .map((item) => ({ ref: item.ref, sha256: hashBytes(item.absolute) }));
  return {
    evidence_refs: entries.map((item) => item.ref),
    evidence_sha256: canonicalJsonSha256(entries, undefined, {
      schemaVersion: "outer-evidence-v1",
    }),
    files: entries.map((item) => item.ref),
  };
}

function validateAutomaticBridgeInput(value: ExperimentBridgeInput): ExperimentBridgeInput {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "automatic bridge input must be an object", "bridge");
  // The loop supplies the project root and owns the one materialization call.
  // Accepting either field here would allow a nested payload to select a
  // different storage root or ask the bridge to perform a second write.
  if (Object.hasOwn(value, "project_root"))
    failA1("IDENTITY_MISMATCH", "automatic bridge input must not provide project_root", "bridge");
  if (Object.hasOwn(value, "materialize_children"))
    failA1(
      "INVALID_EXPANSION",
      "automatic bridge input must not provide materialize_children",
      "bridge",
    );
  return value as unknown as ExperimentBridgeInput;
}

function openOuterContractForState(input: NormalizedOuterRunIdentity): RunRecord {
  return openExistingRun({
    project_root: input.project_root,
    run_id: input.outer_run_id,
    parent_run_id: input.parent_run_id,
    depth: input.depth,
    scope_path: input.scope_path,

    identity: input.run_identity,
    output_hashes: input.output_hashes,
  });
}

function openBridgeChildForState(
  projectRoot: string,
  child: BridgeExpansionPlan["children"][number],
): RunRecord {
  return openExistingRun({
    project_root: projectRoot,
    run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    depth: child.depth,
    scope_path: child.scope_path,

    identity: {
      charter_sha256: child.charter_sha256,
      input_snapshot_sha256: child.input_snapshot_sha256,
      execution_plan_sha256: child.execution_plan_sha256,
      code_baseline_sha256: child.code_baseline_sha256,
      policy_revision: child.policy_revision,
    },
  });
}

/**
 * Run the production hand-off from a completed loop input set to child state.
 * The loop decides its positions before entering here; this function hashes
 * evidence, asks the bridge for one complete plan, materializes that plan,
 * and only then lets state layers open the resulting contracts.
 */
export function runAutoResearchBridge(input: AutoResearchBridgeInput): AutoResearchBridgeResult {
  const normalized = normalizedIdentity(input);
  const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
  const bridgeInput = validateAutomaticBridgeInput(input.bridge);
  const plan = planExperimentBridge(bridgeInput);
  if (plan.parent_run_id !== normalized.outer_run_id)
    failA1(
      "IDENTITY_MISMATCH",
      "bridge plan parent does not match the outer loop run",
      "bridge.parent_run_id",
    );
  if (plan.parent_depth !== normalized.depth)
    failA1(
      "RUN_DEPTH_MISMATCH",
      "bridge plan parent depth does not match the outer loop run",
      "bridge.parent_depth",
    );

  // This is the only call in the outer production loop that can write child
  // run.json files. It receives the already validated, hashed plan unchanged.
  const children = materializeBridgeChildren(normalized.project_root, plan);
  const parent = openOuterContractForState(normalized);
  const openedChildren = plan.children.map((child) =>
    openBridgeChildForState(normalized.project_root, child),
  );
  return { parent, evidence, plan, children, opened_children: openedChildren };
}

function ownershipPath(executionRoot: string): string {
  return path.join(normalizedDirectory(executionRoot, "execution_root"), OWNERSHIP_FILE);
}

export function outerRunOwnershipPath(executionRoot: string): string {
  return ownershipPath(executionRoot);
}

export const outerOwnershipPath = outerRunOwnershipPath;

export function outerRunControllerLockPath(executionRoot: string): string {
  return path.join(normalizedDirectory(executionRoot, "execution_root"), CONTROLLER_FILE);
}

export const outerControllerLockPath = outerRunControllerLockPath;

function nullableString(value: unknown, location: string): string | null {
  return value === null ? null : requireString(value, location);
}

function validateOwnership(value: unknown, filePath: string): OuterRunOwnership {
  if (!isRecord(value))
    failA1("CORRUPT_OUTER_OWNERSHIP", "outer ownership must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "execution_root",
      "status",
      "outer_run_id",
      "project_root",
      "task_id",
      "workflow_id",
      "runtime_status",
      "owner_pid",
      "acquired_at",
      "updated_at",
      "released_at",
    ],
    filePath,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_OUTER_OWNERSHIP", "unsupported ownership schema", filePath);
  const status = value.status;
  if (status !== "active" && status !== "released")
    failA1("CORRUPT_OUTER_OWNERSHIP", "ownership status is invalid", filePath);
  const runtimeStatus = value.runtime_status;
  if (
    runtimeStatus !== "initializing" &&
    runtimeStatus !== "running" &&
    runtimeStatus !== "completed" &&
    runtimeStatus !== "failed" &&
    runtimeStatus !== "stopped"
  )
    failA1("CORRUPT_OUTER_OWNERSHIP", "ownership runtime status is invalid", filePath);
  const projectRoot = nullableString(value.project_root, `${filePath}.project_root`);
  if (projectRoot !== null) normalizedDirectory(projectRoot, `${filePath}.project_root`);
  const taskId = nullableString(value.task_id, `${filePath}.task_id`);
  if (taskId !== null) assertIdentifier(taskId, `${filePath}.task_id`);
  const workflowId = nullableString(value.workflow_id, `${filePath}.workflow_id`);
  if (workflowId !== null) assertIdentifier(workflowId, `${filePath}.workflow_id`);
  const ownerPid = requireInteger(value.owner_pid, `${filePath}.owner_pid`, 1);
  if (status === "released" && !TERMINAL_RUNTIME_STATUSES.has(runtimeStatus))
    failA1(
      "CORRUPT_OUTER_OWNERSHIP",
      "released ownership must have a terminal runtime status",
      filePath,
    );
  if (status === "active" && value.released_at !== null)
    failA1("CORRUPT_OUTER_OWNERSHIP", "active ownership cannot have released_at", filePath);
  return {
    schema_version: 1,
    execution_root: normalizedDirectory(value.execution_root, `${filePath}.execution_root`),
    status,
    outer_run_id: assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`),
    project_root: projectRoot,
    task_id: taskId,
    workflow_id: workflowId,
    runtime_status: runtimeStatus,
    owner_pid: ownerPid,
    acquired_at: requireString(value.acquired_at, `${filePath}.acquired_at`),
    updated_at: requireString(value.updated_at, `${filePath}.updated_at`),
    released_at: nullableString(value.released_at, `${filePath}.released_at`),
  };
}

export function readOuterRunOwnership(executionRoot: string): OuterRunOwnership | null {
  const root = normalizedDirectory(executionRoot, "execution_root");
  const filePath = ownershipPath(root);
  if (!fs.existsSync(filePath)) return null;
  const value = validateOwnership(readStateFile(filePath), filePath);
  if (value.execution_root !== root)
    failA1("IDENTITY_MISMATCH", "ownership file belongs to another execution_root", filePath);
  return value;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

function controllerPid(filePath: string): number | null {
  try {
    const first = fs.readFileSync(filePath, "utf8").trim().split(":", 1)[0];
    const parsed = Number(first);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function scopedControllerLockPath(executionRoot: string, scopePath: string): string {
  if (scopePath === "/") return outerRunControllerLockPath(executionRoot);
  const scopeHash = crypto
    .createHash("sha256")
    .update(scopePath, "utf8")
    .digest("hex")
    .slice(0, 24);
  return path.join(
    normalizedDirectory(executionRoot, "execution_root"),
    `outer-run-controller-${scopeHash}.lock`,
  );
}

function acquireControllerLock(executionRoot: string, scopePath = "/"): string {
  const root = normalizedDirectory(executionRoot, "execution_root");
  fs.mkdirSync(root, { recursive: true });
  const filePath = scopedControllerLockPath(root, scopePath);
  const token = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
  for (;;) {
    try {
      const fd = fs.openSync(
        filePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        fs.writeSync(fd, `${token}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST") throw error;
      const pid = controllerPid(filePath);
      if (pid === null || isPidAlive(pid))
        failA1("RUN_SCOPE_ACTIVE", "another run operation is active in this scope", filePath);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // The owner may have released the lock between the check and unlink.
      }
    }
  }
}

function releaseControllerLock(executionRoot: string, token: string, scopePath = "/"): void {
  const filePath = scopedControllerLockPath(executionRoot, scopePath);
  try {
    if (fs.readFileSync(filePath, "utf8").trim() === token) fs.unlinkSync(filePath);
  } catch {
    // A process death or an already completed recovery may have removed it.
  }
}

function ownerMatchesRequest(owner: OuterRunOwnership, input: Required<OuterRunIdentity>): void {
  if (owner.execution_root !== input.execution_root || owner.outer_run_id !== input.outer_run_id)
    failA1("OUTER_RUN_ACTIVE", "another outer run already owns this execution_root");
  if (owner.project_root !== null && owner.project_root !== input.project_root)
    failA1("IDENTITY_MISMATCH", "outer ownership project root differs from the command");
  if (input.task_id !== "" && owner.task_id !== null && owner.task_id !== input.task_id)
    failA1("IDENTITY_MISMATCH", "outer ownership task id differs from the command");
  if (
    input.workflow_id !== "" &&
    owner.workflow_id !== null &&
    owner.workflow_id !== input.workflow_id
  )
    failA1("IDENTITY_MISMATCH", "outer ownership workflow id differs from the command");
}

function createOwnership(input: Required<OuterRunIdentity>): OuterRunOwnership {
  const timestamp = now();
  return {
    schema_version: 1,
    execution_root: input.execution_root,
    status: "active",
    outer_run_id: input.outer_run_id,
    project_root: input.project_root,
    task_id: input.task_id === "" ? null : input.task_id,
    workflow_id: input.workflow_id === "" ? null : input.workflow_id,
    runtime_status: "initializing",
    owner_pid: process.pid,
    acquired_at: timestamp,
    updated_at: timestamp,
    released_at: null,
  };
}

function writeOwnership(value: OuterRunOwnership): void {
  const filePath = ownershipPath(value.execution_root);
  withStateFileLock(filePath, () => writeStateJsonAtomic(filePath, value));
}

function setOwnershipRuntimeStatus(
  input: Required<OuterRunIdentity>,
  status: OuterRuntimeStatus,
): void {
  // Non-root runs are owned by the shared scope registry. The legacy single
  // outer ownership file can only represent the depth-0 compatibility path.
  if (input.scope_path !== "/") return;
  const filePath = ownershipPath(input.execution_root);
  withStateFileLock(filePath, () => {
    if (!fs.existsSync(filePath))
      failA1("OUTER_OWNERSHIP_NOT_FOUND", "outer ownership is missing", filePath);
    const current = validateOwnership(readStateFile(filePath), filePath);
    if (current.status !== "active" || current.outer_run_id !== input.outer_run_id)
      failA1("OUTER_OWNERSHIP_CONFLICT", "outer ownership is no longer held by this run", filePath);
    ownerMatchesRequest(current, input);
    writeStateJsonAtomic(filePath, {
      ...current,
      runtime_status: status,
      owner_pid: process.pid,
      updated_at: now(),
    });
  });
}

function assertRuntimeCleanup(state: WorkflowRuntimeState): void {
  if (
    state.active_cycle !== null ||
    state.children.some((child) => child.status === "active") ||
    state.budgets.some((budget) => budget.status === "reserved")
  )
    failA1("OUTER_CLEANUP_REQUIRED", "outer run still owns active children, cycle, or budget");
}

function releaseAllRunScopeLeases(
  input: Required<OuterRunIdentity>,
  scopeLease: RunScopeLease,
): void {
  const leaseTokens = readRunScopeLeaseTokens({
    project_root: input.project_root,
    run_id: input.outer_run_id,
    parent_run_id: input.parent_run_id,
    scope_path: input.scope_path,
  });
  scopeLease.releaseAll(leaseTokens, true);
}

function releasePersistentOwnership(
  input: Required<OuterRunIdentity>,
  controllerToken?: string,
  scopeLease?: RunScopeLease,
): void {
  if (scopeLease === undefined)
    failA1("RUN_SCOPE_LEASE_REQUIRED", "persistent ownership release requires its scope lease");
  if (input.scope_path !== "/") {
    const runtimePath = workflowRuntimePath(input.project_root, input.outer_run_id);
    if (fs.existsSync(runtimePath)) {
      const runtime = readWorkflowRuntimeState(input.project_root, input.outer_run_id);
      if (!TERMINAL_RUNTIME_STATUSES.has(runtime.status))
        failA1("OUTER_CLEANUP_REQUIRED", "cannot release a non-terminal outer run");
      assertRuntimeCleanup(runtime);
      if (runtime.stop_decision_ref === null)
        failA1("OUTER_STOP_DECISION_REQUIRED", "terminal outer run has no stop decision");
    } else {
      failA1("OUTER_CLEANUP_REQUIRED", "cannot release a non-terminal outer run");
    }
    releaseAllRunScopeLeases(input, scopeLease);
    return;
  }
  const perform = (): void => {
    const filePath = ownershipPath(input.execution_root);
    if (!fs.existsSync(filePath))
      failA1("OUTER_OWNERSHIP_NOT_FOUND", "outer ownership is missing", filePath);
    const current = validateOwnership(readStateFile(filePath), filePath);
    if (current.status !== "active" || current.outer_run_id !== input.outer_run_id)
      failA1("OUTER_OWNERSHIP_CONFLICT", "outer ownership is not held by this run", filePath);
    ownerMatchesRequest(current, input);
    const runtime =
      current.project_root !== null &&
      fs.existsSync(workflowRuntimePath(current.project_root, current.outer_run_id))
        ? readWorkflowRuntimeState(current.project_root, current.outer_run_id)
        : null;
    if (runtime !== null) {
      if (!TERMINAL_RUNTIME_STATUSES.has(runtime.status))
        failA1("OUTER_CLEANUP_REQUIRED", "cannot release a non-terminal outer run");
      assertRuntimeCleanup(runtime);
      if (runtime.stop_decision_ref === null)
        failA1("OUTER_STOP_DECISION_REQUIRED", "terminal outer run has no stop decision");
    }
    const released: OuterRunOwnership = {
      ...current,
      status: "released",
      // If setup failed before workflow-runtime.json existed, the ownership
      // reservation itself is the only durable record. Mark that failed setup
      // terminal so the root remains readable and reusable.
      runtime_status: runtime?.status ?? "failed",
      owner_pid: process.pid,
      updated_at: now(),
      released_at: now(),
    };
    writeStateJsonAtomic(filePath, released);
  };
  if (controllerToken === undefined) {
    const token = acquireControllerLock(input.execution_root, input.scope_path);
    try {
      withStateFileLock(ownershipPath(input.execution_root), perform);
    } finally {
      releaseControllerLock(input.execution_root, token, input.scope_path);
    }
  } else {
    withStateFileLock(ownershipPath(input.execution_root), perform);
  }
  releaseAllRunScopeLeases(input, scopeLease);
}

function makeLease(
  input: Required<OuterRunIdentity>,
  token: string,
  _scopeLease: RunScopeLease,
): OuterRunLease {
  let closed = false;
  let released = false;
  return {
    execution_root: input.execution_root,
    outer_run_id: input.outer_run_id,
    controller_token: token,
    scope_path: input.scope_path,
    close(): void {
      if (!closed) {
        closed = true;
        releaseControllerLock(input.execution_root, token, input.scope_path);
      }
    },
    release(): void {
      if (released) return;
      releasePersistentOwnership(input, token, _scopeLease);
      released = true;
      this.close();
    },
    abortSetup(): void {
      if (released) return;
      _scopeLease.release();
      released = true;
      this.close();
    },
  };
}

export function acquireOuterRunLease(input: OuterRunLeaseInput): OuterRunLease {
  const normalized = normalizedIdentity(input);
  const mode = input.mode ?? "start";
  openRunContractForRuntime(normalized);
  let scopeLease: RunScopeLease;
  try {
    scopeLease = acquireRunScope({
      project_root: normalized.project_root,
      run_id: normalized.outer_run_id,
      parent_run_id: normalized.parent_run_id,
      scope_path: normalized.scope_path,
    });
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    if (normalized.scope_path === "/" && code === "RUN_SCOPE_ACTIVE") {
      const owner = readOuterRunOwnership(normalized.execution_root);
      const controllerPath = outerRunControllerLockPath(normalized.execution_root);
      const controllerActive =
        fs.existsSync(controllerPath) &&
        (() => {
          const pid = controllerPid(controllerPath);
          return pid === null || isPidAlive(pid);
        })();
      if (
        owner?.status === "active" &&
        owner.outer_run_id !== normalized.outer_run_id &&
        !controllerActive
      )
        failA1("OUTER_RUN_ACTIVE", "another outer run already owns this execution_root");
    }
    throw error;
  }
  let token = "";
  try {
    token = acquireControllerLock(normalized.execution_root, normalized.scope_path);
    if (normalized.scope_path !== "/") {
      // Scoped recursive runs do not use the legacy one-owner file. Their
      // durable ownership is the run-contract scope registry.
      return makeLease(normalized, token, scopeLease);
    }
    const filePath = ownershipPath(normalized.execution_root);
    const owner = fs.existsSync(filePath)
      ? validateOwnership(readStateFile(filePath), filePath)
      : null;
    let next: OuterRunOwnership;
    if (owner === null) {
      if (mode !== "start")
        failA1(
          "OUTER_OWNERSHIP_NOT_FOUND",
          "resume or control requires an existing outer ownership record",
        );
      next = createOwnership(normalized);
    } else if (owner.status === "active") {
      if (mode === "start" || owner.outer_run_id !== normalized.outer_run_id)
        failA1("OUTER_RUN_ACTIVE", "another outer run already owns this execution_root");
      ownerMatchesRequest(owner, normalized);
      next = { ...owner, owner_pid: process.pid, updated_at: now() };
    } else {
      if (mode === "resume" && owner.outer_run_id !== normalized.outer_run_id)
        failA1("OUTER_RUN_ACTIVE", "a different released run is recorded for this execution_root");
      if (mode === "resume") {
        ownerMatchesRequest(owner, normalized);
        failA1("OUTER_RUN_TERMINAL", "a released outer run cannot be resumed");
      }
      if (mode === "control") {
        ownerMatchesRequest(owner, normalized);
        failA1("OUTER_RUN_TERMINAL", "a released outer run cannot be changed");
      }
      next = createOwnership(normalized);
    }
    withStateFileLock(filePath, () => writeStateJsonAtomic(filePath, next));
    return makeLease(normalized, token, scopeLease);
  } catch (error: unknown) {
    if (typeof token === "string")
      releaseControllerLock(normalized.execution_root, token, normalized.scope_path);
    scopeLease.release();
    throw error;
  }
}

export function releaseOuterRunLease(input: OuterRunIdentity): void {
  const lease = acquireOuterRunLease({ ...input, mode: "control" });
  try {
    lease.release();
  } catch (error) {
    try {
      lease.abortSetup();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  } finally {
    lease.close();
  }
}

export const releaseOuterRun = releaseOuterRunLease;

export function withOuterRunLease<T>(
  input: OuterRunLeaseInput,
  action: (lease: OuterRunLease) => T,
): T {
  const lease = acquireOuterRunLease({ ...input, mode: input.mode ?? "control" });
  try {
    return action(lease);
  } finally {
    lease.close();
  }
}

function readRequiredTesterAgentConfig(
  input: StartOuterRunInput | ResumeOuterRunInput,
  required: boolean,
): TesterAgentConfig | null {
  const configPath = input.tester_agent_config_path;
  if (configPath === "") {
    if (required)
      failA1("TESTER_AGENT_REQUIRED", "formal outer run needs a tester agent config path");
    return null;
  }
  // The tester agent config carries the pinned public key used to verify the
  // response. It is deliberately independent of execution_root: swapping the
  // tester machine is prevented by the frozen config hash below.
  return readTesterAgentConfig(configPath);
}

function freezeWithTesterAgentConfig(
  input: StartOuterRunInput | ResumeOuterRunInput,
  freezeInput: FreezeOuterRunInput,
  required: boolean,
): FreezeOuterRunInput {
  const config = readRequiredTesterAgentConfig(input, required);
  if (config === null) return freezeInput;
  if (
    freezeInput.tester_agent_config !== undefined &&
    testerAgentConfigSha256(freezeInput.tester_agent_config as TesterAgentConfig) !==
      testerAgentConfigSha256(config)
  )
    failA1(
      "TESTER_AGENT_CONFIG_CONFLICT",
      "freeze input tester agent config differs from the supplied config",
    );
  return { ...freezeInput, tester_agent_config: config };
}

function assertFrozenTesterAgentConfig(
  input: StartOuterRunInput | ResumeOuterRunInput,
  projectRoot: string,
  outerRunId: string,
  required: boolean,
): void {
  const config = readRequiredTesterAgentConfig(input, required);
  if (config === null) return;
  const frozen = readFrozenPolicy(projectRoot, outerRunId);
  if (
    frozen.tester_agent_config === undefined ||
    frozen.tester_agent_sha256 === undefined ||
    frozen.tester_agent_sha256 !== testerAgentConfigSha256(config)
  )
    failA1("TESTER_AGENT_CONFIG_CONFLICT", "resume config does not match the frozen tester agent");
}

function validateFreezeIdentity(
  input: OuterRunIdentity,
  freezeInput: FreezeOuterRunInput,
): FreezeOuterRunInput {
  const normalized = normalizedIdentity(input);
  if (path.resolve(freezeInput.project_root) !== normalized.project_root)
    failA1("IDENTITY_MISMATCH", "freeze input project root differs from outer run");
  if (freezeInput.outer_run_id !== normalized.outer_run_id)
    failA1("IDENTITY_MISMATCH", "freeze input outer run id differs from outer run");
  return freezeInput;
}

function writeInitialRuntime(input: Required<OuterRunIdentity>): WorkflowRuntimeState {
  openRunContractForRuntime(input);
  const policy = readFrozenPolicy(input.project_root, input.outer_run_id);
  const dashboard = createWorkflowDashboard(
    input.project_root,
    input.outer_run_id,
    frozenPolicyFingerprint(policy),
  );
  const state = createWorkflowRuntimeState({
    execution_root: input.execution_root,
    project_root: input.project_root,
    outer_run_id: input.outer_run_id,
    parent_run_id: input.parent_run_id,
    depth: input.depth,
    scope_path: input.scope_path,

    task_id: policy.task_id,
    workflow_id: policy.workflow_id,
  });
  const statePath = workflowRuntimePath(input.project_root, input.outer_run_id);
  withStateFileLock(statePath, () => {
    if (fs.existsSync(statePath)) {
      const existing = readWorkflowRuntimeState(input.project_root, input.outer_run_id);
      if (existing.execution_root !== input.execution_root)
        failA1("IDENTITY_MISMATCH", "runtime state execution root differs from command");
      return;
    }
    writeWorkflowRuntimeState(input.project_root, state);
  });
  writeWorkflowPhaseHistory(input.project_root, input.outer_run_id, state.phase_history);
  updateWorkflowDashboard(input.project_root, input.outer_run_id, {
    status: dashboard.status,
    current_phase: dashboard.current_phase,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
  });
  return readWorkflowRuntimeState(input.project_root, input.outer_run_id);
}

function openRunContractForRuntime(input: Required<OuterRunIdentity>): void {
  openExistingRun({
    project_root: input.project_root,
    run_id: input.outer_run_id,
    parent_run_id: input.parent_run_id,
    depth: input.depth,
    scope_path: input.scope_path,

    identity: input.run_identity,
    output_hashes: input.output_hashes,
  });
}

function startOuterRunInternal(
  input: StartOuterRunInput,
  formalTesterAgent: boolean,
): WorkflowRuntimeState {
  const normalized = normalizedIdentity(input);
  const freezeInput = validateFreezeIdentity(
    input,
    freezeWithTesterAgentConfig(input, input.freeze_input, formalTesterAgent),
  );
  // Check the startup artifacts before validating or saving the frozen input.
  // A duplicate start must not recreate a missing sibling artifact before the
  // preflight reports that this run is already started.
  const existingPaths = [
    startPreflightPath(normalized.project_root, normalized.outer_run_id, "workflow-runtime.json"),
    startPreflightPath(normalized.project_root, normalized.outer_run_id, "workflow-dashboard.json"),
    startPreflightPath(normalized.project_root, normalized.outer_run_id, "frozen-policy.json"),
  ];
  if (existingPaths.some((filePath) => fs.existsSync(filePath)))
    failA1("OUTER_RUN_EXISTS", "outer run files already exist; use resume for recovery");
  // Validate before taking the global owner so an invalid request cannot block
  // the environment. The durable owner is acquired before any persistent run
  // files are written, so a process death cannot be mistaken for a free slot.
  freezeOuterRun(freezeInput);
  const lease = acquireOuterRunLease({ ...normalized, mode: "start" });
  try {
    // saveFrozenPolicy is the only writer for the frozen task/model/tester
    // snapshot. The outer layer never edits that JSON itself.
    saveFrozenPolicy(freezeInput);
    const state = writeInitialRuntime(normalized);
    setOwnershipRuntimeStatus(normalized, state.status);
    return state;
  } catch (error: unknown) {
    // A failure before workflow-runtime.json exists is a rejected setup, not a
    // recoverable running research process. Release that empty reservation;
    // once runtime state exists, leave ownership for resume.
    if (
      !fs.existsSync(
        startPreflightPath(
          normalized.project_root,
          normalized.outer_run_id,
          "workflow-runtime.json",
        ),
      )
    ) {
      try {
        lease.abortSetup();
      } catch {
        // Preserve the original setup error. A surviving owner is safer than
        // silently claiming that a partially written run is free.
      }
    }
    throw error;
  } finally {
    lease.close();
  }
}

export function startOuterRun(input: StartOuterRunInput): WorkflowRuntimeState {
  return startOuterRunInternal(input, true);
}

/** Used only by storage/transition tests; production start always requires a tester agent. */
export function startOuterRunForTest(
  input: Omit<StartOuterRunInput, "tester_agent_config_path"> & {
    tester_agent_config_path?: string;
  },
): WorkflowRuntimeState {
  return startOuterRunInternal(
    { ...input, tester_agent_config_path: input.tester_agent_config_path ?? "" },
    false,
  );
}

export const createOuterRun = startOuterRun;

function runtimePath(input: OuterRunIdentity): string {
  const normalized = normalizedIdentity(input);
  return workflowRuntimePath(normalized.project_root, normalized.outer_run_id);
}

function assertRuntimeIdentity(
  input: Required<OuterRunIdentity>,
  state: WorkflowRuntimeState,
): void {
  if (
    state.execution_root !== input.execution_root ||
    state.project_root !== input.project_root ||
    state.outer_run_id !== input.outer_run_id
  )
    failA1("IDENTITY_MISMATCH", "runtime state identity differs from the command");
  if (
    state.parent_run_id !== input.parent_run_id ||
    state.depth !== input.depth ||
    state.scope_path !== input.scope_path
  )
    failA1("IDENTITY_MISMATCH", "runtime run.json identity differs from the command");
  if (input.task_id !== "" && state.task_id !== input.task_id)
    failA1("IDENTITY_MISMATCH", "runtime task id differs from the command");
  if (input.workflow_id !== "" && state.workflow_id !== input.workflow_id)
    failA1("IDENTITY_MISMATCH", "runtime workflow id differs from the command");
}

function currentCycle(state: WorkflowRuntimeState): ActiveOuterCycle {
  if (state.active_cycle === null)
    failA1("OUTER_CYCLE_REQUIRED", "the requested operation needs an active outer cycle");
  return state.active_cycle;
}

function closePhase(
  state: WorkflowRuntimeState,
  evidence: EvidenceBundle,
  status: "completed" | "failed" | "stopped" = "completed",
): OuterPhaseHistoryEntry[] {
  const history = [...state.phase_history];
  const current = history[history.length - 1];
  if (!current || current.phase !== state.current_phase || current.status !== "active")
    failA1("OUTER_PHASE_ORDER", "current phase has no active history entry");
  history[history.length - 1] = {
    ...current,
    status,
    evidence_refs: [...evidence.evidence_refs],
    evidence_sha256: evidence.evidence_sha256,
    completed_at: now(),
  };
  return history;
}

function openPhase(
  history: readonly OuterPhaseHistoryEntry[],
  phase: OuterPhase,
  cycle: ActiveOuterCycle,
): OuterPhaseHistoryEntry[] {
  return [
    ...history,
    {
      phase,
      outer_iteration: cycle.outer_iteration,
      generation: cycle.generation,
      status: "active",
      evidence_refs: [],
      evidence_sha256: null,
      started_at: now(),
      completed_at: null,
    },
  ];
}

function phaseDashboardValue(phase: OuterPhase): "init" | "loop" | "summary" {
  if (phase === "init") return "init";
  if (phase === "summary") return "summary";
  return "loop";
}

function syncDashboard(input: Required<OuterRunIdentity>, state: WorkflowRuntimeState): void {
  const latest = state.cycle_history[state.cycle_history.length - 1] ?? null;
  const childStates: Record<string, string> = {};
  for (const child of state.children) childStates[child.child_run_id] = child.status;
  updateWorkflowDashboard(input.project_root, input.outer_run_id, {
    status: state.status === "initializing" ? "running" : state.status,
    current_phase: phaseDashboardValue(state.current_phase),
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    wave_kind: state.active_cycle?.wave_kind ?? null,
    child_run_ids: state.children.map((child) => child.child_run_id),
    candidate_ids: latest?.candidate_ids ?? [],
    finalist_id: latest?.finalist_id ?? null,
    promotion_trial_id: latest?.promotion_trial_id ?? null,
    stop_decision: state.stop_decision_ref,
    child_states: childStates,
  });
}

function persistRuntimeState(
  input: Required<OuterRunIdentity>,
  state: WorkflowRuntimeState,
): WorkflowRuntimeState {
  const validated = validateWorkflowRuntimeState(state, input.outer_run_id, runtimePath(input));
  writeWorkflowRuntimeState(input.project_root, validated);
  const policy = readFrozenPolicy(input.project_root, input.outer_run_id);
  createWorkflowDashboard(input.project_root, input.outer_run_id, frozenPolicyFingerprint(policy));
  writeWorkflowPhaseHistory(input.project_root, input.outer_run_id, validated.phase_history);
  synchronizeWorkflowHistory(input.project_root, validated);
  syncDashboard(input, validated);
  setOwnershipRuntimeStatus(input, validated.status);
  return validated;
}

function withRuntimeMutation<T>(
  input: OuterRunIdentity,
  action: (
    state: WorkflowRuntimeState,
    normalized: Required<OuterRunIdentity>,
  ) => {
    state: WorkflowRuntimeState;
    result: T;
  },
): T {
  const normalized = normalizedIdentity(input);
  // Pass the caller's identity to the lease entry point. Passing the already
  // normalized object would turn its internal empty optional fields into
  // invalid user input on the second normalization.
  return withOuterRunLease({ ...input, mode: "control" }, () => {
    const filePath = runtimePath(normalized);
    return withStateFileLock(filePath, () => {
      if (!fs.existsSync(filePath))
        failA1("OUTER_RUN_STATE_NOT_FOUND", `no workflow runtime at ${filePath}`);
      const current = readWorkflowRuntimeState(normalized.project_root, normalized.outer_run_id);
      assertRuntimeIdentity(normalized, current);
      if (TERMINAL_RUNTIME_STATUSES.has(current.status))
        failA1("OUTER_RUN_TERMINAL", "terminal outer run cannot be changed");
      const changed = action(current, normalized);
      persistRuntimeState(normalized, changed.state);
      return changed.result;
    });
  });
}

export interface OuterRuntimeMutationResult<T> {
  state: WorkflowRuntimeState;
  result: T;
}

export type OuterRuntimeMutationAction<T> = (
  state: WorkflowRuntimeState,
  normalized: Required<OuterRunIdentity>,
) => OuterRuntimeMutationResult<T>;

/**
 * A narrow transaction hook for outer-owned helpers. The helper keeps the
 * controller lease and runtime state lock in one place; callers only return
 * the next validated runtime state and their result.
 */
export function withOuterRuntimeMutation<T>(
  input: OuterRunIdentity,
  action: OuterRuntimeMutationAction<T>,
): T {
  return withRuntimeMutation(input, action);
}

function childPath(projectRoot: string, childRunId: string, kind: OuterChildKind): string {
  const id = assertIdentifier(childRunId, "child_run_id");
  if (kind === "module") {
    // A module child is an ordinary research run with no parent-facing state
    // machine. Until it publishes a result package there is nothing about it
    // the parent may read, so what the parent watches is first the run contract
    // it wrote when it created the child, then the package the child publishes.
    const packagePath = resultPackagePath(projectRoot, id);
    return fs.existsSync(packagePath) ? packagePath : runJsonPath(projectRoot, id);
  }
  if (kind === "scorer") return scorerRunStatePath(projectRoot, id);
  return testerRunStatePath(projectRoot, id);
}

interface ObservedChild {
  record: OuterChildRecord;
  terminal: boolean;
}

/**
 * A module child is terminal exactly when its result package exists. The two
 * infrastructure outcomes are not research verdicts - the run never produced a
 * measurement - so they end the child as `stopped` rather than `failed`, which
 * keeps them out of the stop gate's count of rounds without improvement.
 */
function moduleChildStatus(result: ResultPackage | null): OuterChildStatus {
  if (result === null) return "active";
  if (result.status === "succeeded") return "completed";
  if (result.status === "failed") return "failed";
  return "stopped";
}

function childStatusFromState(kind: OuterChildKind, state: unknown): OuterChildStatus {
  if (kind === "scorer") {
    const scorer = state as { status?: string };
    if (scorer.status === "failed") return "failed";
    if (scorer.status === "activated" || scorer.status === "rejected") return "completed";
    return "active";
  }
  const tester = state as TesterRunState;
  if (tester.status === "passed" || tester.status === "rejected") return "completed";
  return "active";
}

function observeChild(
  projectRoot: string,
  child: Pick<
    OuterChildRecord,
    "child_run_id" | "kind" | "module_id" | "outer_iteration" | "generation"
  >,
  cycle: ActiveOuterCycle | null,
  expectedOuterRunId: string,
): ObservedChild {
  const statePath = childPath(projectRoot, child.child_run_id, child.kind);
  if (!fs.existsSync(statePath))
    failA1("CHILD_STATE_NOT_FOUND", `registered child state is missing at ${statePath}`);
  let status: OuterChildStatus;
  if (child.kind === "module") {
    // The only thing the child records about its parent is the link the parent
    // itself wrote into run.json at creation. Which iteration and generation
    // the child belongs to is the parent's own bookkeeping and is read from the
    // child record below, never from the child.
    const contract = requireRunContract(projectRoot, child.child_run_id);
    if (contract.parent_run_id !== expectedOuterRunId)
      failA1("IDENTITY_MISMATCH", "child state belongs to another outer run");
    const published = statePath === resultPackagePath(projectRoot, child.child_run_id);
    status = moduleChildStatus(
      published ? readResultPackage(projectRoot, child.child_run_id) : null,
    );
  } else {
    const state: unknown =
      child.kind === "scorer"
        ? readScorerRunState(projectRoot, child.child_run_id)
        : readTesterRunState(projectRoot, child.child_run_id);
    const record = state as Record<string, unknown>;
    const childParentRunId = record.parent_run_id ?? record.outer_run_id;
    if (childParentRunId !== expectedOuterRunId)
      failA1("IDENTITY_MISMATCH", "child state belongs to another outer run");
    if (record.outer_iteration !== child.outer_iteration || record.generation !== child.generation)
      failA1("IDENTITY_MISMATCH", "child state does not match its outer cycle");
    status = childStatusFromState(child.kind, state);
  }
  if (cycle !== null) {
    if (child.outer_iteration !== cycle.outer_iteration || child.generation !== cycle.generation)
      failA1("IDENTITY_MISMATCH", "child is registered against another cycle");
    if (
      (child.kind === "scorer" && cycle.wave_kind !== "scorer") ||
      (child.kind !== "scorer" && cycle.wave_kind === "scorer")
    )
      failA1("IDENTITY_MISMATCH", "child kind does not match the active wave");
  }
  const terminal = status !== "active";
  return {
    terminal,
    record: {
      child_run_id: child.child_run_id,
      kind: child.kind,
      module_id: child.module_id,
      outer_iteration: child.outer_iteration,
      generation: child.generation,
      status,
      state_sha256: hashBytes(statePath),
      registered_at: "",
      terminal_at: terminal ? now() : null,
    },
  };
}

function reconcileChildren(
  input: Required<OuterRunIdentity>,
  state: WorkflowRuntimeState,
): WorkflowRuntimeState {
  const cycle = state.active_cycle;
  let changed = false;
  const children = state.children.map((child) => {
    const observed = observeChild(
      input.project_root,
      child,
      child.status === "active" ? cycle : null,
      input.outer_run_id,
    );
    if (
      child.status !== observed.record.status ||
      child.state_sha256 !== observed.record.state_sha256
    ) {
      changed = true;
      return {
        ...child,
        status: observed.record.status,
        state_sha256: observed.record.state_sha256,
        terminal_at: observed.terminal ? (child.terminal_at ?? observed.record.terminal_at) : null,
      };
    }
    return child;
  });
  return changed ? { ...state, children, updated_at: now() } : state;
}

function testerMappingPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "tester-arm-map.json",
  );
}

function testerArmMappingFromState(state: TesterRunState): OuterTesterArmMapping {
  // This is deliberately explicit. The outer layer never examines private
  // scores or lets an ordering comparison decide which model is baseline.
  return {
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    promotion_trial_id: state.promotion_trial_id,
    arm_a: {
      name: "matching_baseline",
      artifact_id: `artifact:sha256:${state.matching_baseline_artifact_sha256}`,
      artifact_sha256: state.matching_baseline_artifact_sha256,
    },
    arm_b: {
      name: "finalist",
      artifact_id: `artifact:sha256:${state.finalist_artifact_sha256}`,
      artifact_sha256: state.finalist_artifact_sha256,
    },
    tester_definition_sha256: state.tester_definition_sha256,
    harness_sha256: state.harness_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
    judge_binding_id: state.judge_binding_id,
  };
}

function validateTesterArmMapping(value: unknown, filePath: string): OuterTesterArmMapping {
  if (!isRecord(value))
    failA1("CORRUPT_TESTER_MAPPING", "tester arm mapping must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "tester_run_id",
      "promotion_trial_id",
      "arm_a",
      "arm_b",
      "tester_definition_sha256",
      "harness_sha256",
      "input_distribution_sha256",
      "model_assignment_sha256",
      "judge_binding_id",
    ],
    filePath,
  );
  const arm = <Name extends "matching_baseline" | "finalist">(
    raw: unknown,
    name: Name,
    location: string,
  ) => {
    if (!isRecord(raw))
      failA1("CORRUPT_TESTER_MAPPING", "tester arm mapping arm is invalid", location);
    assertNoUnknownFields(raw, ["name", "artifact_id", "artifact_sha256"], location);
    if (raw.name !== name)
      failA1("TESTER_ARM_MAPPING_REQUIRED", `expected ${name} mapping`, location);
    return {
      name,
      artifact_id: assertIdentifier(raw.artifact_id, `${location}.artifact_id`),
      artifact_sha256: assertSha256(raw.artifact_sha256, `${location}.artifact_sha256`),
    };
  };
  const judgeBindingId =
    value.judge_binding_id === null
      ? null
      : assertIdentifier(value.judge_binding_id, `${filePath}.judge_binding_id`);
  return {
    schema_version: 1,
    tester_run_id: assertIdentifier(value.tester_run_id, `${filePath}.tester_run_id`),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      `${filePath}.promotion_trial_id`,
    ),
    arm_a: arm(value.arm_a, "matching_baseline", `${filePath}.arm_a`),
    arm_b: arm(value.arm_b, "finalist", `${filePath}.arm_b`),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      `${filePath}.tester_definition_sha256`,
    ),
    harness_sha256: assertSha256(value.harness_sha256, `${filePath}.harness_sha256`),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      `${filePath}.input_distribution_sha256`,
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      `${filePath}.model_assignment_sha256`,
    ),
    judge_binding_id: judgeBindingId,
  };
}

function assertTesterMappingMatchesState(
  mapping: OuterTesterArmMapping,
  state: TesterRunState,
): void {
  const expected = testerArmMappingFromState(state);
  if (
    canonicalJsonSha256(mapping, undefined, { schemaVersion: "outer-tester-arm-map-v1" }) !==
    canonicalJsonSha256(expected, undefined, { schemaVersion: "outer-tester-arm-map-v1" })
  )
    failA1("TESTER_ARMS_MISMATCH", "tester arm mapping differs from the frozen tester state");
}

function writeTesterArmMapping(input: Required<OuterRunIdentity>, state: TesterRunState): void {
  const mapping = testerArmMappingFromState(state);
  const filePath = testerMappingPath(input.project_root, input.outer_run_id, state.outer_iteration);
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateTesterArmMapping(readStateFile(filePath), filePath);
      assertTesterMappingMatchesState(existing, state);
      return;
    }
    writeStateJsonAtomic(filePath, mapping);
  });
}

function validationRecordPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "validation-gate.json",
  );
}

function validateValidationRecord(value: unknown, filePath: string): ValidationGateRecord {
  if (!isRecord(value))
    failA1("CORRUPT_VALIDATION_GATE", "validation gate record must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "outer_run_id",
      "outer_iteration",
      "candidate_ids",
      "finalist_id",
      "selected_cell_id",
      "validation_result",
      "evidence_refs",
      "evidence_sha256",
    ],
    filePath,
  );
  if (value.schema_version !== 1)
    failA1("CORRUPT_VALIDATION_GATE", "validation gate schema_version must be 1", filePath);
  const validationResult = value.validation_result;
  if (
    validationResult !== "passed" &&
    validationResult !== "rejected" &&
    validationResult !== "incomplete" &&
    validationResult !== "not_run"
  )
    failA1("CORRUPT_VALIDATION_GATE", "validation result is invalid", filePath);
  if (!Array.isArray(value.candidate_ids) || !Array.isArray(value.evidence_refs))
    failA1("CORRUPT_VALIDATION_GATE", "validation ids and evidence are required", filePath);
  const candidateIds = value.candidate_ids.map((candidate, index) =>
    assertIdentifier(candidate, `${filePath}.candidate_ids[${index}]`),
  );
  if (new Set(candidateIds).size !== candidateIds.length)
    failA1("DUPLICATE_ID", "validation candidate ids must be unique", filePath);
  const finalistId =
    value.finalist_id === null
      ? null
      : assertIdentifier(value.finalist_id, `${filePath}.finalist_id`);
  if (finalistId !== null && !candidateIds.includes(finalistId))
    failA1("IDENTITY_MISMATCH", "validation finalist must be one of candidate ids", filePath);
  if (validationResult === "passed" && finalistId === null)
    failA1("VALIDATION_FINALIST_REQUIRED", "a passed validation gate needs one finalist", filePath);
  if (validationResult !== "passed" && finalistId !== null)
    failA1(
      "VALIDATION_FINALIST_INVALID",
      "a rejected validation gate cannot carry a finalist",
      filePath,
    );
  const evidenceRefs = value.evidence_refs.map((ref, index) =>
    requireString(ref, `${filePath}.evidence_refs[${index}]`),
  );
  if (evidenceRefs.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "validation gate needs evidence references", filePath);
  return {
    schema_version: 1,
    outer_run_id: assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`),
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    candidate_ids: candidateIds,
    finalist_id: finalistId,
    selected_cell_id:
      value.selected_cell_id === null
        ? null
        : assertIdentifier(value.selected_cell_id, `${filePath}.selected_cell_id`),
    validation_result: validationResult,
    evidence_refs: evidenceRefs,
    evidence_sha256: assertSha256(value.evidence_sha256, `${filePath}.evidence_sha256`),
  };
}

function readValidationRecord(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): ValidationGateRecord {
  const filePath = validationRecordPath(projectRoot, outerRunId, outerIteration);
  if (!fs.existsSync(filePath))
    failA1("VALIDATION_GATE_NOT_FOUND", `no validation gate record at ${filePath}`);
  const record = validateValidationRecord(readStateFile(filePath), filePath);
  if (record.outer_run_id !== outerRunId || record.outer_iteration !== outerIteration)
    failA1("IDENTITY_MISMATCH", "validation gate record does not match its cycle", filePath);
  return record;
}

export function readOuterValidationGateRecord(
  input: OuterRunIdentity & { outer_iteration: number },
): ValidationGateRecord {
  const normalized = normalizedIdentity(input);
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  return readValidationRecord(normalized.project_root, normalized.outer_run_id, outerIteration);
}

export function recordValidationGateResult(input: RecordValidationGateInput): ValidationGateRecord {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    if (state.current_phase !== "validation")
      failA1("OUTER_PHASE_ORDER", "validation gate result belongs in the validation phase");
    const outerIteration = cycle.outer_iteration;
    const gateSelection = input.gate_input
      ? selectUniqueFinalist(input.gate_input.plan, input.gate_input.results, {
          plan_id: input.gate_input.plan_id,
          primary_direction: input.gate_input.primary_direction,
          improvement: input.gate_input.improvement,
          binding: input.gate_input.binding,
          review: input.gate_input.review,
        })
      : null;
    if (gateSelection === null && input.validation_result === "passed")
      failA1(
        "VALIDATION_GATE_REQUIRED",
        "a passed validation record must be produced by selectUniqueFinalist",
      );
    const derivedCandidateIds = gateSelection
      ? input.gate_input!.results.map((result, index) =>
          assertIdentifier(result.candidate_id, `gate_input.results[${index}].candidate_id`),
        )
      : input.candidate_ids?.map((candidate, index) =>
          assertIdentifier(candidate, `candidate_ids[${index}]`),
        );
    if (!derivedCandidateIds || derivedCandidateIds.length === 0)
      failA1("VALIDATION_INCOMPLETE", "validation candidate ids are required");
    const finalistFromGate = gateSelection?.selected_candidate_id ?? null;
    const cellFromGate = gateSelection?.selected_cell_id ?? null;
    const finalistFromSelection = input.selection?.selected_candidate_id;
    const finalistId =
      finalistFromGate !== null || gateSelection !== null
        ? finalistFromGate
        : finalistFromSelection === undefined
          ? (input.finalist_id ?? null)
          : finalistFromSelection;
    const selectedCellId =
      gateSelection !== null
        ? cellFromGate
        : input.selection?.selected_cell_id === undefined
          ? (input.selected_cell_id ?? null)
          : input.selection.selected_cell_id;
    if (gateSelection !== null) {
      const derivedResult = validationResultFromSelection(
        gateSelection.reason,
        gateSelection.selected_candidate_id,
      );
      if (input.validation_result !== undefined && input.validation_result !== derivedResult)
        failA1(
          "VALIDATION_GATE_CONFLICT",
          "reported validation result differs from the gate result",
        );
      if (input.finalist_id !== undefined && input.finalist_id !== finalistId)
        failA1("VALIDATION_GATE_CONFLICT", "reported finalist differs from the gate result");
      if (input.selected_cell_id !== undefined && input.selected_cell_id !== selectedCellId)
        failA1("VALIDATION_GATE_CONFLICT", "reported validation cell differs from the gate result");
      if (
        input.selection?.selected_candidate_id !== undefined &&
        input.selection.selected_candidate_id !== finalistId
      )
        failA1("VALIDATION_GATE_CONFLICT", "reported selection differs from the gate result");
      if (
        input.selection?.selected_cell_id !== undefined &&
        input.selection.selected_cell_id !== selectedCellId
      )
        failA1("VALIDATION_GATE_CONFLICT", "reported selection cell differs from the gate result");
    }
    const validationResult =
      gateSelection === null
        ? input.validation_result
        : validationResultFromSelection(gateSelection.reason, gateSelection.selected_candidate_id);
    if (validationResult === undefined)
      failA1("VALIDATION_GATE_REQUIRED", "validation result must come from the validation gate");
    const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
    const record: ValidationGateRecord = {
      schema_version: 1,
      outer_run_id: normalized.outer_run_id,
      outer_iteration: outerIteration,
      candidate_ids: derivedCandidateIds,
      finalist_id: finalistId === null ? null : assertIdentifier(finalistId, "finalist_id"),
      selected_cell_id:
        selectedCellId === null ? null : assertIdentifier(selectedCellId, "selected_cell_id"),
      validation_result: validationResult,
      evidence_refs: evidence.evidence_refs,
      evidence_sha256: evidence.evidence_sha256,
    };
    const validated = validateValidationRecord(
      record,
      validationRecordPath(normalized.project_root, normalized.outer_run_id, outerIteration),
    );
    const filePath = validationRecordPath(
      normalized.project_root,
      normalized.outer_run_id,
      outerIteration,
    );
    withStateFileLock(filePath, () => {
      if (fs.existsSync(filePath)) {
        const existing = validateValidationRecord(readStateFile(filePath), filePath);
        if (
          canonicalJsonSha256(existing, undefined, {
            schemaVersion: "outer-validation-gate-v1",
          }) !==
          canonicalJsonSha256(validated, undefined, { schemaVersion: "outer-validation-gate-v1" })
        )
          failA1("IMMUTABLE_CONFLICT", "validation gate result cannot change", filePath);
      } else writeStateJsonAtomic(filePath, validated);
    });
    return { state, result: validated };
  });
}

export const recordValidationEvidence = recordValidationGateResult;

function promotionRecordPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "promotion-gate.json",
  );
}

function validatePromotionRecord(value: unknown, filePath: string): PromotionGateRecord {
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_GATE", "promotion gate record must be an object", filePath);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "outer_run_id",
      "outer_iteration",
      "tester_run_id",
      "promotion_trial_id",
      "result",
      "tester_state_sha256",
      "evidence_refs",
      "evidence_sha256",
    ],
    filePath,
  );
  if (value.schema_version !== 1 || (value.result !== "passed" && value.result !== "rejected"))
    failA1("CORRUPT_PROMOTION_GATE", "promotion gate record is invalid", filePath);
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "promotion gate needs evidence references", filePath);
  return {
    schema_version: 1,
    outer_run_id: assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`),
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    tester_run_id: assertIdentifier(value.tester_run_id, `${filePath}.tester_run_id`),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      `${filePath}.promotion_trial_id`,
    ),
    result: value.result,
    tester_state_sha256: assertSha256(value.tester_state_sha256, `${filePath}.tester_state_sha256`),
    evidence_refs: value.evidence_refs.map((ref, index) =>
      requireString(ref, `${filePath}.evidence_refs[${index}]`),
    ),
    evidence_sha256: assertSha256(value.evidence_sha256, `${filePath}.evidence_sha256`),
  };
}

function readPromotionRecord(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): PromotionGateRecord {
  const filePath = promotionRecordPath(projectRoot, outerRunId, outerIteration);
  if (!fs.existsSync(filePath))
    failA1("PROMOTION_GATE_NOT_FOUND", `no promotion gate record at ${filePath}`);
  const record = validatePromotionRecord(readStateFile(filePath), filePath);
  if (record.outer_run_id !== outerRunId || record.outer_iteration !== outerIteration)
    failA1("IDENTITY_MISMATCH", "promotion gate record does not match its cycle", filePath);
  return record;
}

export function readOuterPromotionGateRecord(
  input: OuterRunIdentity & { outer_iteration: number },
): PromotionGateRecord {
  const normalized = normalizedIdentity(input);
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  return readPromotionRecord(normalized.project_root, normalized.outer_run_id, outerIteration);
}

export function readOuterTesterArmMapping(
  input: OuterRunIdentity & { outer_iteration: number },
): OuterTesterArmMapping {
  const normalized = normalizedIdentity(input);
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  const filePath = testerMappingPath(
    normalized.project_root,
    normalized.outer_run_id,
    outerIteration,
  );
  if (!fs.existsSync(filePath))
    failA1("TESTER_ARM_MAPPING_REQUIRED", `no tester arm mapping at ${filePath}`);
  return validateTesterArmMapping(readStateFile(filePath), filePath);
}

export function recordPromotionGateResult(input: RecordPromotionGateInput): PromotionGateRecord {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    if (state.current_phase !== "promotion")
      failA1("OUTER_PHASE_ORDER", "promotion gate result belongs in the promotion phase");
    const testerChild = state.children.find(
      (child) =>
        child.kind === "tester" &&
        child.child_run_id === assertIdentifier(input.tester_run_id, "tester_run_id") &&
        child.outer_iteration === cycle.outer_iteration,
    );
    if (!testerChild)
      failA1("CHILD_NOT_REGISTERED", "promotion gate tester is not registered in this cycle");
    const tester = readTesterRunState(normalized.project_root, testerChild.child_run_id);
    if (
      tester.outer_run_id !== normalized.outer_run_id ||
      tester.outer_iteration !== cycle.outer_iteration ||
      tester.promotion_trial_id === ""
    )
      failA1("IDENTITY_MISMATCH", "tester state does not match the promotion cycle");
    if (
      (tester.status !== "passed" && tester.status !== "rejected") ||
      !tester.gate_consumed ||
      tester.gate_status === null
    )
      failA1("PROMOTION_GATE_REQUIRED", "promotion result must come from a consumed tester gate");
    const mappingPath = testerMappingPath(
      normalized.project_root,
      normalized.outer_run_id,
      cycle.outer_iteration,
    );
    if (!fs.existsSync(mappingPath))
      failA1("TESTER_ARM_MAPPING_REQUIRED", "promotion result has no explicit tester arm mapping");
    const mapping = validateTesterArmMapping(readStateFile(mappingPath), mappingPath);
    assertTesterMappingMatchesState(mapping, tester);
    const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
    const record: PromotionGateRecord = {
      schema_version: 1,
      outer_run_id: normalized.outer_run_id,
      outer_iteration: cycle.outer_iteration,
      tester_run_id: tester.tester_run_id,
      promotion_trial_id: tester.promotion_trial_id,
      result: tester.gate_status,
      tester_state_sha256: hashBytes(
        testerRunStatePath(normalized.project_root, tester.tester_run_id),
      ),
      evidence_refs: evidence.evidence_refs,
      evidence_sha256: evidence.evidence_sha256,
    };
    const filePath = promotionRecordPath(
      normalized.project_root,
      normalized.outer_run_id,
      cycle.outer_iteration,
    );
    const validated = validatePromotionRecord(record, filePath);
    withStateFileLock(filePath, () => {
      if (fs.existsSync(filePath)) {
        const existing = validatePromotionRecord(readStateFile(filePath), filePath);
        if (
          canonicalJsonSha256(existing, undefined, { schemaVersion: "outer-promotion-gate-v1" }) !==
          canonicalJsonSha256(validated, undefined, { schemaVersion: "outer-promotion-gate-v1" })
        )
          failA1("IMMUTABLE_CONFLICT", "promotion gate result cannot change", filePath);
      } else writeStateJsonAtomic(filePath, validated);
    });
    return { state, result: validated };
  });
}

export const recordPromotionEvidence = recordPromotionGateResult;

function nextPhaseFor(current: OuterPhase, requested: OuterPhase): boolean {
  if (current === "diagnosis") return requested === "workset";
  if (current === "workset") return requested === "wave" || requested === "bridge-repair";
  if (current === "bridge-repair") return requested === "workset";
  if (current === "wave") return requested === "validation";
  if (current === "validation") return requested === "promotion" || requested === "summary";
  if (current === "promotion") return requested === "summary";
  return false;
}

function bridgeFailureOf(cycle: ActiveOuterCycle): OuterBridgeFailure | null {
  return cycle.bridge_failure ?? null;
}

function sameBridgeReceipt(
  failure: OuterBridgeFailure | null,
  receiptRef: string,
  receiptSha256: string,
  manifestRef?: string,
  manifestSha256?: string,
): boolean {
  return (
    failure !== null &&
    failure.bridge_receipt_ref === receiptRef &&
    failure.bridge_receipt_sha256 === receiptSha256 &&
    (manifestRef === undefined || failure.bridge_manifest_ref === manifestRef) &&
    (manifestSha256 === undefined || failure.bridge_manifest_sha256 === manifestSha256)
  );
}

function assertWorkflowBridgeCycle(cycle: ActiveOuterCycle): void {
  if (cycle.wave_kind === "scorer")
    failA1("OUTER_WAVE_KIND_CONFLICT", "scorer waves do not run a workflow experiment bridge");
}

function verifyFrozenConnections(
  projectRoot: string,
  outerRunId: string,
  cycle: ActiveOuterCycle,
  connectionIds: readonly string[] | undefined,
): void {
  // Older storage-only lifecycle tests can still move a workset to a wave
  // without a bridge receipt. A formal bridge path must provide its frozen
  // connection decisions before downstream nodes are scheduled.
  if (
    cycle.wave_kind !== "module" ||
    cycle.bridge_success_receipt_ref === undefined ||
    cycle.bridge_success_receipt_ref === null
  )
    return;
  if (connectionIds === undefined || connectionIds.length === 0)
    failA1(
      "CONTENT_CONNECTION_REQUIRED",
      "a bridged workflow must provide frozen connection records before its node wave",
    );
  const ids = connectionIds.map((value, index) =>
    assertIdentifier(value, `connection_ids[${index}]`),
  );
  if (new Set(ids).size !== ids.length) failA1("DUPLICATE_ID", "connection_ids must be unique");
  const records = ids.map((connectionId) =>
    readWorkflowConnectionRecord(projectRoot, outerRunId, connectionId),
  );
  assertWorkflowConnectionsConnected(records);
  if (records.some((record) => record.from.node_id === record.to.node_id))
    failA1("CONTENT_CONNECTION_REQUIRED", "a node cannot connect to itself");
  if (records.some((record) => record.input_snapshot_sha256 === null))
    failA1(
      "CONTENT_CONNECTION_REQUIRED",
      "frozen workflow connections must carry an input snapshot hash",
    );
  if (new Set(records.map((record) => record.input_snapshot_sha256)).size !== 1)
    failA1(
      "CONTENT_CONNECTION_REQUIRED",
      "all frozen workflow connections must use one input snapshot",
    );
  // The records are read from the immutable outer-run directory. The cycle
  // argument is intentionally used to make the call site explicit: a future
  // scheduler can compare these records with the cycle's frozen graph.
  void cycle;
}

function bridgeEvidence(projectRoot: string, evidencePaths: readonly string[]): EvidenceBundle {
  return hashOuterEvidence(projectRoot, evidencePaths);
}

/**
 * Record an outer experiment-bridge failure and hand the same candidate to the
 * bounded auto-review repair path.  A pending failure blocks every downstream
 * phase; an exhausted failure can only be closed as a failed cycle.
 */
export function recordOuterBridgeFailure(
  input: RecordOuterBridgeFailureInput,
): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    assertWorkflowBridgeCycle(cycle);
    if (state.current_phase !== "workset")
      failA1(
        "OUTER_PHASE_ORDER",
        "an outer bridge failure can only be recorded in the workset bridge phase",
      );
    const bridge = validateOuterBridgeFiles(
      normalized.project_root,
      normalized.outer_run_id,
      cycle,
      requireString(input.receipt_path, "receipt_path"),
      input.manifest_path,
      "failure",
    );
    const previous = bridgeFailureOf(cycle);
    if (
      sameBridgeReceipt(
        previous,
        bridge.receiptRef,
        bridge.receiptSha256,
        bridge.manifestRef,
        bridge.manifestSha256,
      )
    )
      return { state, result: state };
    if (previous?.status === "pending")
      failA1("OUTER_PHASE_ORDER", "a bridge repair is already pending for this cycle");
    if (previous?.status === "exhausted")
      failA1("BRIDGE_REPAIR_LIMIT", "an exhausted bridge candidate cannot be retried");
    if (previous?.status === "fixed" && previous.frozen_input_sha256 !== bridge.frozenInputSha256)
      failA1(
        "RETRY_SEMANTICS_CHANGED",
        "a repaired outer bridge must be retried with the same frozen inputs",
      );

    const repairAttempts = previous?.repair_attempts ?? 0;
    settleExecutionReceipt(
      normalized.project_root,
      normalized.outer_run_id,
      bridge.manifest,
      bridge.receipt.summary,
    );
    const exhausted = runBudgetExhausted(normalized.project_root, normalized.outer_run_id);
    const failure: OuterBridgeFailure = {
      schema_version: 1,
      bridge_receipt_ref: bridge.receiptRef,
      bridge_receipt_sha256: bridge.receiptSha256,
      bridge_manifest_ref: bridge.manifestRef,
      bridge_manifest_sha256: bridge.manifestSha256,
      frozen_input_sha256: bridge.frozenInputSha256,
      error: bridge.error ?? { category: "bridge_failed" },
      repair_attempts: repairAttempts,

      status: exhausted ? "exhausted" : "pending",
      repair_receipt_ref: exhausted ? (previous?.repair_receipt_ref ?? null) : null,
      repair_receipt_sha256: exhausted ? (previous?.repair_receipt_sha256 ?? null) : null,
    };
    const nextCycle: ActiveOuterCycle = {
      ...cycle,
      bridge_success_receipt_ref: null,
      bridge_success_receipt_sha256: null,
      bridge_success_manifest_ref: null,
      bridge_success_manifest_sha256: null,
      bridge_failure: failure,
    };
    const evidence = bridgeEvidence(normalized.project_root, input.evidence_paths);
    const history = closePhase(state, evidence, "failed");
    const next: WorkflowRuntimeState = {
      ...state,
      current_phase: "bridge-repair",
      active_cycle: nextCycle,
      phase_history: openPhase(history, "bridge-repair", nextCycle),
      updated_at: now(),
    };
    return { state: next, result: next };
  });
}

/**
 * Record the auto-review-loop repair receipt.  A fixed repair returns to the
 * same bridge; an exhausted repair remains blocked until cycle completion.
 */
export function recordOuterBridgeRepair(input: RecordOuterBridgeRepairInput): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    assertWorkflowBridgeCycle(cycle);
    const failure = bridgeFailureOf(cycle);
    if (failure === null)
      failA1("OUTER_PHASE_ORDER", "bridge repair requires a recorded bridge failure");
    const repair = validateOuterBridgeFiles(
      normalized.project_root,
      normalized.outer_run_id,
      cycle,
      requireString(input.repair_receipt_path, "repair_receipt_path"),
      input.repair_manifest_path,
      "repair",
    );
    const repairReceiptRef = repair.receiptRef;
    const repairReceiptSha256 = repair.receiptSha256;
    if (
      failure.repair_receipt_ref === repairReceiptRef &&
      failure.repair_receipt_sha256 === repairReceiptSha256
    )
      return { state, result: state };
    if (state.current_phase !== "bridge-repair" || failure.status !== "pending")
      failA1("OUTER_PHASE_ORDER", "bridge repair is not pending for this cycle");
    const summary = repair.receipt.summary;
    if (!isRecord(summary))
      failA1("INVALID_REPAIR_RECEIPT", "bridge repair receipt needs a summary");
    if (
      summary.semantic_change === true ||
      summary.research_semantics_changed === true ||
      summary.workflow_graph_changed === true ||
      summary.node_interface_changed === true ||
      summary.connection_changed === true ||
      summary.tester_definition_changed === true ||
      summary.scoring_policy_changed === true
    )
      failA1(
        "RETRY_SEMANTICS_CHANGED",
        "bridge repair changed the workflow meaning or a frozen boundary",
      );
    const repairContext = isRecord(repair.manifest.context) ? repair.manifest.context : null;
    if (
      repairContext !== null &&
      repairContext.frozen_input_sha256 !== undefined &&
      repairContext.frozen_input_sha256 !== failure.frozen_input_sha256
    )
      failA1("RETRY_SEMANTICS_CHANGED", "bridge repair does not reference the frozen bridge input");
    const repairAttempts = failure.repair_attempts + 1;

    const repairRound = summary.repair_round;
    if (repairRound !== undefined && repairRound !== repairAttempts)
      failA1("IDENTITY_MISMATCH", "bridge repair round does not match the cycle state");
    const repairStatus = summary.repair_status;
    if (repairStatus !== "fixed" && repairStatus !== "exhausted")
      failA1("INVALID_REPAIR_RECEIPT", "bridge repair summary needs fixed or exhausted status");

    settleExecutionReceipt(
      normalized.project_root,
      normalized.outer_run_id,
      repair.manifest,
      repair.receipt.summary,
    );
    if (
      repairStatus === "exhausted" &&
      !runBudgetExhausted(normalized.project_root, normalized.outer_run_id)
    )
      failA1("BUDGET_STATE_ORDER", "repair still has execution budget");
    const nextFailure: OuterBridgeFailure = {
      ...failure,
      repair_attempts: repairAttempts,
      status: repairStatus,
      repair_receipt_ref: repairReceiptRef,
      repair_receipt_sha256: repairReceiptSha256,
    };
    const nextCycle: ActiveOuterCycle = {
      ...cycle,
      bridge_failure: nextFailure,
      bridge_success_receipt_ref: null,
      bridge_success_receipt_sha256: null,
      bridge_success_manifest_ref: null,
      bridge_success_manifest_sha256: null,
    };
    const evidence = bridgeEvidence(normalized.project_root, input.evidence_paths);
    if (repairStatus === "fixed") {
      const history = closePhase(state, evidence);
      const next: WorkflowRuntimeState = {
        ...state,
        current_phase: "workset",
        active_cycle: nextCycle,
        phase_history: openPhase(history, "workset", nextCycle),
        updated_at: now(),
      };
      return { state: next, result: next };
    }
    // Keep bridge-repair active. completeOuterCycle will turn this immutable
    // failure evidence into a failed cycle without creating validation/tester.
    const next: WorkflowRuntimeState = { ...state, active_cycle: nextCycle, updated_at: now() };
    return {
      state: next,
      result: next,
    };
  });
}

/**
 * Record a usable bridge result after the initial bridge or a repaired retry.
 * The actual output is checked before its hash is stored; downstream waves
 * cannot start from a caller-provided aggregate value.
 */
export function recordOuterBridgeSuccess(
  input: RecordOuterBridgeSuccessInput,
): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    assertWorkflowBridgeCycle(cycle);
    if (state.current_phase !== "workset")
      failA1("OUTER_PHASE_ORDER", "a bridge success can only be recorded in the workset phase");
    const bridge = validateOuterBridgeFiles(
      normalized.project_root,
      normalized.outer_run_id,
      cycle,
      requireString(input.receipt_path, "receipt_path"),
      input.manifest_path,
      "success",
    );
    const failure = bridgeFailureOf(cycle);
    if (failure?.status === "pending")
      failA1("BRIDGE_REPAIR_PENDING", "bridge success cannot bypass pending repair");
    if (failure?.status === "exhausted")
      failA1("BRIDGE_REPAIR_LIMIT", "an exhausted bridge candidate cannot produce success");
    if (failure !== null && failure.frozen_input_sha256 !== bridge.frozenInputSha256)
      failA1("RETRY_SEMANTICS_CHANGED", "bridge retry inputs changed after repair");
    if (
      cycle.bridge_success_receipt_ref !== undefined &&
      cycle.bridge_success_receipt_ref !== null
    ) {
      if (
        cycle.bridge_success_receipt_ref !== bridge.receiptRef ||
        cycle.bridge_success_receipt_sha256 !== bridge.receiptSha256 ||
        cycle.bridge_success_manifest_ref !== bridge.manifestRef ||
        cycle.bridge_success_manifest_sha256 !== bridge.manifestSha256
      )
        failA1("IMMUTABLE_CONFLICT", "outer bridge success cannot be replaced");
      return { state, result: state };
    }
    bridgeEvidence(normalized.project_root, input.evidence_paths);
    settleExecutionReceipt(
      normalized.project_root,
      normalized.outer_run_id,
      bridge.manifest,
      bridge.receipt.summary,
    );
    const nextCycle: ActiveOuterCycle = {
      ...cycle,
      bridge_success_receipt_ref: bridge.receiptRef,
      bridge_success_receipt_sha256: bridge.receiptSha256,
      bridge_success_manifest_ref: bridge.manifestRef,
      bridge_success_manifest_sha256: bridge.manifestSha256,
    };
    const next: WorkflowRuntimeState = { ...state, active_cycle: nextCycle, updated_at: now() };
    return { state: next, result: next };
  });
}

export const registerOuterBridgeFailure = recordOuterBridgeFailure;
export const registerOuterBridgeRepair = recordOuterBridgeRepair;
export const registerOuterBridgeSuccess = recordOuterBridgeSuccess;

function assertPromotionCommitComplete(
  projectRoot: string,
  outerRunId: string,
  cycle: ActiveOuterCycle,
  expectedResult: "passed" | "rejected",
): void {
  const expectedRef = workflowCycleRelativePath(
    cycle.outer_iteration,
    "promotion-commit-intent.json",
  );
  if (cycle.promotion_commit_ref !== expectedRef)
    failA1(
      "PROMOTION_COMMIT_REQUIRED",
      "promotion phase cannot finish before its commit intent is complete",
    );
  const filePath = path.join(
    workflowCycleDirectory(projectRoot, outerRunId, cycle.outer_iteration),
    "promotion-commit-intent.json",
  );
  if (!fs.existsSync(filePath))
    failA1("PROMOTION_COMMIT_REQUIRED", `promotion commit intent is missing at ${filePath}`);
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_PROMOTION_COMMIT", "promotion commit intent must be an object", filePath);
  if (value.outer_run_id !== outerRunId || value.outer_iteration !== cycle.outer_iteration)
    failA1("IDENTITY_MISMATCH", "promotion commit intent does not match its cycle", filePath);
  const status = value.status;
  const expectedStatus = expectedResult === "passed" ? "committed" : "rejected";
  if (status !== expectedStatus)
    failA1(
      "PROMOTION_COMMIT_REQUIRED",
      `promotion commit intent must be '${expectedStatus}' before phase completion`,
      filePath,
    );
}

export function beginOuterCycle(input: BeginOuterCycleInput): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    if (state.current_phase !== "init" && state.current_phase !== "summary")
      failA1("OUTER_PHASE_ORDER", "a new cycle can begin only from init or summary");
    if (state.active_cycle !== null)
      failA1("OUTER_CYCLE_ACTIVE", "the outer run already has an active cycle");
    const requestedWaveId = assertIdentifier(input.wave_id, "wave_id");
    const requestedWaveKind = input.wave_kind;
    if (
      requestedWaveKind !== "module" &&
      requestedWaveKind !== "structure" &&
      requestedWaveKind !== "scorer"
    )
      failA1("INVALID_WAVE_POLICY", "outer cycle wave kind is invalid");
    if (state.current_phase === "summary") {
      if (state.stop_decision_ref === null)
        failA1("OUTER_STOP_DECISION_REQUIRED", "the previous cycle has no stop decision");
      const previousIteration =
        state.cycle_history[state.cycle_history.length - 1]?.outer_iteration;
      if (previousIteration === undefined)
        failA1("CORRUPT_WORKFLOW_RUNTIME", "summary phase has no cycle summary");
      const expectedStopDecisionRef = workflowCycleRelativePath(
        previousIteration,
        "stop-decision.json",
      );
      if (state.stop_decision_ref !== expectedStopDecisionRef)
        failA1("IDENTITY_MISMATCH", "stop decision reference is not derived from the latest cycle");
      const decision = readWorkflowStopDecision(
        normalized.project_root,
        normalized.outer_run_id,
        previousIteration,
      );
      if (decision.decision === "stop")
        failA1("OUTER_STOPPED", `stop gate prevents another cycle: ${decision.reason}`);
    }
    const currentIteration =
      state.current_phase === "init" ? state.outer_iteration : state.outer_iteration + 1;
    if (input.outer_iteration !== undefined && input.outer_iteration !== currentIteration)
      failA1("IDENTITY_MISMATCH", "requested cycle iteration is not the next iteration");
    const generation =
      input.generation === undefined
        ? state.generation
        : requireInteger(input.generation, "generation", 1);
    const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
    const cycle: ActiveOuterCycle = {
      outer_iteration: currentIteration,
      generation,
      wave_id: requestedWaveId,
      wave_kind: requestedWaveKind,
      promotion_commit_ref: null,
      bridge_success_receipt_ref: null,
      bridge_success_receipt_sha256: null,
      bridge_success_manifest_ref: null,
      bridge_success_manifest_sha256: null,
      bridge_failure: null,
    };
    fs.mkdirSync(
      workflowCycleDirectory(normalized.project_root, normalized.outer_run_id, currentIteration),
      {
        recursive: true,
      },
    );
    const history = closePhase(state, evidence);
    const next: WorkflowRuntimeState = {
      ...state,
      status: "running",
      current_phase: "diagnosis",
      outer_iteration: currentIteration,
      generation,
      active_cycle: cycle,
      stop_decision_ref: null,
      phase_history: openPhase(history, "diagnosis", cycle),
      updated_at: now(),
    };
    return { state: next, result: next };
  });
}

export const startOuterCycle = beginOuterCycle;

export function advanceOuterPhase(input: PhaseAdvanceInput): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    currentCycle(state);
    if (state.current_phase !== input.from_phase)
      failA1("OUTER_PHASE_ORDER", "requested phase does not match durable current phase");
    if (!nextPhaseFor(state.current_phase, input.to_phase))
      failA1(
        "OUTER_PHASE_ORDER",
        `cannot advance from ${state.current_phase} to ${input.to_phase}`,
      );
    let working = state;
    const cycle = currentCycle(state);
    if (state.current_phase === "workset" && input.to_phase === "bridge-repair") {
      const failure = bridgeFailureOf(cycle);
      if (failure === null || (failure.status !== "pending" && failure.status !== "exhausted"))
        failA1("OUTER_PHASE_ORDER", "bridge-repair requires a pending or exhausted bridge failure");
    } else if (state.current_phase === "bridge-repair" && input.to_phase === "workset") {
      if (bridgeFailureOf(cycle)?.status !== "fixed")
        failA1("OUTER_PHASE_ORDER", "only a fixed bridge repair may return to the workset");
    } else if (state.current_phase === "workset" && input.to_phase === "wave") {
      const failure = bridgeFailureOf(cycle);
      if (failure?.status === "pending")
        failA1("BRIDGE_REPAIR_PENDING", "complete bridge repair before starting node waves");
      if (failure?.status === "exhausted")
        failA1("BRIDGE_REPAIR_LIMIT", "an exhausted bridge candidate cannot start node waves");
      if (failure?.status === "fixed") {
        const receiptRef = cycle.bridge_success_receipt_ref;
        const receiptSha256 = cycle.bridge_success_receipt_sha256;
        const manifestRef = cycle.bridge_success_manifest_ref;
        const manifestSha256 = cycle.bridge_success_manifest_sha256;
        if (
          receiptRef === undefined ||
          receiptRef === null ||
          receiptSha256 === undefined ||
          receiptSha256 === null ||
          manifestRef === undefined ||
          manifestRef === null ||
          manifestSha256 === undefined ||
          manifestSha256 === null
        )
          failA1("BRIDGE_SUCCESS_REQUIRED", "a repaired bridge must record its successful retry");
        const success = validateOuterBridgeFiles(
          normalized.project_root,
          normalized.outer_run_id,
          cycle,
          path.join(
            workflowCycleDirectory(
              normalized.project_root,
              normalized.outer_run_id,
              cycle.outer_iteration,
            ),
            receiptRef,
          ),
          path.join(
            workflowCycleDirectory(
              normalized.project_root,
              normalized.outer_run_id,
              cycle.outer_iteration,
            ),
            manifestRef,
          ),
          "success",
        );
        if (
          success.receiptSha256 !== receiptSha256 ||
          success.manifestSha256 !== manifestSha256 ||
          success.frozenInputSha256 !== failure.frozen_input_sha256
        )
          failA1(
            "IMMUTABLE_CONFLICT",
            "recorded bridge retry no longer matches its frozen evidence",
          );
      }
      verifyFrozenConnections(
        normalized.project_root,
        normalized.outer_run_id,
        cycle,
        input.connection_ids,
      );
    } else if (state.current_phase === "wave" && input.to_phase === "validation") {
      working = reconcileChildren(normalized, state);
      const children = assertCycleChildrenComplete(working, cycle);
      if (children.some((child) => child.status === "failed")) {
        failA1(
          "VALIDATION_NOT_ALLOWED",
          "a failed module candidate must be analyzed and closed before validation",
        );
      }
    } else if (state.current_phase === "validation") {
      const validation = readValidationRecord(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (input.to_phase === "promotion") {
        if (validation.validation_result !== "passed" || validation.finalist_id === null)
          failA1("PROMOTION_NOT_ALLOWED", "promotion requires a validation gate with one finalist");
        if (
          state.children.some(
            (child) => child.kind === "tester" && child.outer_iteration === cycle.outer_iteration,
          )
        )
          failA1("TESTER_NOT_ALLOWED", "a tester cannot exist before promotion phase");
      } else if (input.to_phase === "summary") {
        if (validation.finalist_id !== null)
          failA1(
            "OUTER_PHASE_ORDER",
            "a validation finalist must pass through the promotion phase",
          );
        if (
          state.children.some(
            (child) => child.kind === "tester" && child.outer_iteration === cycle.outer_iteration,
          )
        )
          failA1("TESTER_NOT_ALLOWED", "a rejected validation gate cannot have a tester child");
      }
    } else if (state.current_phase === "promotion" && input.to_phase === "summary") {
      working = reconcileChildren(normalized, state);
      assertCycleChildrenComplete(working, cycle);
      const validation = readValidationRecord(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (validation.finalist_id === null)
        failA1("PROMOTION_NOT_ALLOWED", "a cycle without a finalist cannot enter promotion");
      const testerChildren = working.children.filter(
        (child) => child.kind === "tester" && child.outer_iteration === cycle.outer_iteration,
      );
      if (testerChildren.length !== 1)
        failA1("TESTER_REQUIRED", "promotion requires exactly one tester child");
      const tester = readTesterRunState(normalized.project_root, testerChildren[0]!.child_run_id);
      if (
        (tester.status !== "passed" && tester.status !== "rejected") ||
        !tester.gate_consumed ||
        tester.gate_status === null
      )
        failA1("PROMOTION_GATE_REQUIRED", "promotion phase needs a consumed terminal tester gate");
      const promotion = readPromotionRecord(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (
        promotion.tester_run_id !== tester.tester_run_id ||
        promotion.promotion_trial_id !== tester.promotion_trial_id ||
        promotion.result !== tester.gate_status
      )
        failA1("PROMOTION_GATE_CONFLICT", "promotion evidence does not match tester state");
      assertPromotionCommitComplete(
        normalized.project_root,
        normalized.outer_run_id,
        cycle,
        promotion.result,
      );
    }
    const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
    if (input.to_phase === "wave") {
      // The parent freezes inputs before any child can be dispatched. Recovery
      // uses the existing bytes, even if more Wiki events have since arrived.
      const run = requireRunContract(normalized.project_root, normalized.outer_run_id);
      const file = wikiWorkerManifestPath(normalized.project_root, run.run_id);
      if (fs.existsSync(file)) {
        readWikiWorkerManifest(normalized.project_root, run.run_id);
      } else {
        const parentFile =
          run.parent_run_id === null
            ? null
            : wikiWorkerManifestPath(normalized.project_root, run.parent_run_id);
        sealWikiWorkerManifest({
          project_root: normalized.project_root,
          run_id: run.run_id,
          worker: "experiment-bridge",
          input_snapshot:
            parentFile === null
              ? null
              : {
                  ref: path.relative(normalized.project_root, parentFile),
                  sha256: hashBytes(parentFile),
                },
        });
      }
      const hash = hashBytes(file);
      const registered = run.output_hashes["input-manifest.json"];
      if (registered !== undefined && registered !== hash)
        failA1("PARENT_INPUT_SNAPSHOT_NOT_SEALED", "registered parent snapshot changed");
      if (registered === undefined)
        updateRun(normalized.project_root, run.run_id, {
          output_hashes: { ...run.output_hashes, "input-manifest.json": hash },
        });
    }
    const history = closePhase(working, evidence);
    const next: WorkflowRuntimeState = {
      ...working,
      current_phase: input.to_phase,
      phase_history: openPhase(history, input.to_phase, cycle),
      updated_at: now(),
    };
    return { state: next, result: next };
  });
}

export const advanceWorkflowPhase = advanceOuterPhase;

export function registerOuterChild(input: RegisterOuterChildInput): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    const childId = assertIdentifier(input.child_run_id, "child_run_id");
    const moduleId =
      input.module_id === undefined || input.module_id === null
        ? null
        : requireString(input.module_id, "module_id");
    if (input.kind === "module" && moduleId === null)
      failA1("INVALID_VALUE", "a module child must name the module it was dispatched for");
    if (input.kind !== "module" && moduleId !== null)
      failA1("INVALID_VALUE", "only a module child can name a module", "module_id");
    const outerIteration = input.outer_iteration ?? cycle.outer_iteration;
    const generation = input.generation ?? cycle.generation;
    if (outerIteration !== cycle.outer_iteration || generation !== cycle.generation)
      failA1("IDENTITY_MISMATCH", "child registration does not match the active cycle");
    if (input.kind === "tester") {
      if (state.current_phase !== "promotion")
        failA1("OUTER_PHASE_ORDER", "tester children can only be registered in promotion phase");
      if (cycle.wave_kind !== "module" && cycle.wave_kind !== "structure")
        failA1("TESTER_NOT_ALLOWED", "a scorer wave cannot create a tester child");
      const validation = readValidationRecord(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (validation.finalist_id === null)
        failA1("TESTER_NOT_ALLOWED", "a tester requires a unique validation finalist");
    } else if (state.current_phase !== "wave") {
      failA1(
        "OUTER_PHASE_ORDER",
        "module and scorer children can only be registered in wave phase",
      );
    } else if (input.kind !== cycle.wave_kind) {
      failA1(
        "OUTER_WAVE_KIND_CONFLICT",
        `${input.kind} child cannot be registered in a ${cycle.wave_kind} wave`,
      );
    }
    const parent = requireRunContract(normalized.project_root, normalized.outer_run_id);
    const childContract = requireRunContract(normalized.project_root, childId);
    if (childContract.parent_run_id !== parent.run_id || !parent.child_run_ids.includes(childId))
      failA1("IDENTITY_MISMATCH", "registered child must belong to this parent contract");
    // A child is only traceable if the inputs it was dispatched from are frozen.
    // The parent seals its own dispatch manifest on entering the wave phase and
    // records that hash in its contract; re-checking it here keeps a parent from
    // adopting children after its dispatch inputs moved.
    readWikiWorkerManifest(normalized.project_root, parent.run_id);
    const parentSnapshot = hashBytes(
      wikiWorkerManifestPath(normalized.project_root, parent.run_id),
    );
    if (parent.output_hashes["input-manifest.json"] !== parentSnapshot)
      failA1(
        "PARENT_INPUT_SNAPSHOT_NOT_SEALED",
        "parent must register the sealed dispatch manifest it is registering children from",
      );
    const binding = readWikiWorkerManifest(normalized.project_root, childId);
    if (
      binding.role !==
      (input.kind === "tester" ? "tester" : input.kind === "scorer" ? "scorer" : "module")
    )
      failA1("INVALID_WORKER_IDENTITY", "child manifest role differs from dispatch kind");
    if (
      binding.role !== "tester" &&
      (!binding.input_snapshot ||
        !path
          .resolve(normalized.project_root, binding.input_snapshot.ref)
          .startsWith(`${runOwnedPath(normalized.project_root, childId)}/`))
    )
      failA1("INPUT_SNAPSHOT_MISMATCH", "child inputs must be frozen in the child's own directory");
    const existing = state.children.find((child) => child.child_run_id === childId);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.module_id !== moduleId ||
        existing.outer_iteration !== outerIteration ||
        existing.generation !== generation
      )
        failA1("IDENTITY_MISMATCH", "child registration conflicts with the existing child");
      if (input.kind === "tester") {
        const tester = readTesterRunState(normalized.project_root, childId);
        assertTesterMappingMatchesState(
          validateTesterArmMapping(
            readStateFile(
              testerMappingPath(
                normalized.project_root,
                normalized.outer_run_id,
                cycle.outer_iteration,
              ),
            ),
            testerMappingPath(
              normalized.project_root,
              normalized.outer_run_id,
              cycle.outer_iteration,
            ),
          ),
          tester,
        );
      }
      return { state, result: state };
    }
    const observed = observeChild(
      normalized.project_root,
      {
        child_run_id: childId,
        kind: input.kind,
        module_id: moduleId,
        outer_iteration: outerIteration,
        generation,
      },
      cycle,
      normalized.outer_run_id,
    );
    const child = {
      ...observed.record,
      registered_at: now(),
      terminal_at: observed.terminal ? observed.record.terminal_at : null,
    };
    if (input.kind === "tester") {
      const tester = readTesterRunState(normalized.project_root, childId);
      writeTesterArmMapping(normalized, tester);
    }
    const next: WorkflowRuntimeState = {
      ...state,
      children: [...state.children, child],
      updated_at: now(),
    };
    return { state: next, result: next };
  });
}

export const registerOuterChildRun = registerOuterChild;

function updateOneChild(
  state: WorkflowRuntimeState,
  input: Required<OuterRunIdentity>,
  childRunId: string,
  requireTerminal: boolean,
): WorkflowRuntimeState {
  const index = state.children.findIndex((child) => child.child_run_id === childRunId);
  if (index < 0) failA1("CHILD_NOT_REGISTERED", `child '${childRunId}' is not registered`);
  const existing = state.children[index]!;
  const observed = observeChild(
    input.project_root,
    existing,
    existing.status === "active" ? state.active_cycle : null,
    input.outer_run_id,
  );
  if (requireTerminal && !observed.terminal)
    failA1("CHILD_NOT_TERMINAL", "child terminal status must come from its actual state file");
  const child: OuterChildRecord = {
    ...existing,
    status: observed.record.status,
    state_sha256: observed.record.state_sha256,
    terminal_at: observed.terminal ? (existing.terminal_at ?? observed.record.terminal_at) : null,
  };
  if (
    canonicalJsonSha256(child, undefined, { schemaVersion: "outer-child-v1" }) ===
    canonicalJsonSha256(existing, undefined, { schemaVersion: "outer-child-v1" })
  )
    return state;
  const children = [...state.children];
  children[index] = child;
  return { ...state, children, updated_at: now() };
}

export function markOuterChildTerminal(
  input: OuterRunIdentity & { child_run_id: string },
): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const next = updateOneChild(
      state,
      normalized,
      assertIdentifier(input.child_run_id, "child_run_id"),
      true,
    );
    return { state: next, result: next };
  });
}

export const completeOuterChild = markOuterChildTerminal;

export function reconcileOuterChildren(input: OuterRunIdentity): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    let next = state;
    for (const child of state.children)
      next = updateOneChild(next, normalized, child.child_run_id, false);
    return { state: next, result: next };
  });
}

export function reserveOuterBudget(input: ReserveOuterBudgetInput): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    const reservationId = assertIdentifier(input.reservation_id, "reservation_id");
    if (state.budgets.some((budget) => budget.reservation_id === reservationId))
      failA1("DUPLICATE_ID", "budget reservation id is already used");
    const amount = requireFiniteNumber(input.amount, "amount");
    if (amount <= 0) failA1("INVALID_VALUE", "budget amount must be positive", "amount");
    const unit = requireString(input.unit, "unit");
    const childRunId =
      input.child_run_id === undefined || input.child_run_id === null
        ? null
        : assertIdentifier(input.child_run_id, "child_run_id");
    if (childRunId !== null) {
      const child = state.children.find((candidate) => candidate.child_run_id === childRunId);
      if (!child || child.outer_iteration !== cycle.outer_iteration || child.status !== "active")
        failA1("CHILD_NOT_REGISTERED", "budget child must be an active child in this cycle");
    }
    const reservation: OuterBudgetReservation = {
      reservation_id: reservationId,
      outer_iteration: cycle.outer_iteration,
      category: input.category,
      amount,
      unit,
      child_run_id: childRunId,
      status: "reserved",
      evidence_sha256: null,
      reserved_at: now(),
      closed_at: null,
    };
    const next: WorkflowRuntimeState = {
      ...state,
      budgets: [...state.budgets, reservation],
      updated_at: now(),
    };
    return { state: next, result: next };
  });
}

function closeBudget(
  input: CloseOuterBudgetInput,
  status: "settled" | "released",
): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const reservationId = assertIdentifier(input.reservation_id, "reservation_id");
    const index = state.budgets.findIndex((budget) => budget.reservation_id === reservationId);
    if (index < 0)
      failA1("BUDGET_NOT_FOUND", `budget reservation '${reservationId}' is not registered`);
    const current = state.budgets[index]!;
    const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
    if (current.status !== "reserved") {
      if (current.status !== status || current.evidence_sha256 !== evidence.evidence_sha256)
        failA1("BUDGET_STATE_ORDER", "budget reservation is already closed differently");
      return { state, result: state };
    }
    if (current.child_run_id !== null) {
      const child = state.children.find(
        (candidate) => candidate.child_run_id === current.child_run_id,
      );
      if (!child || child.status === "active")
        failA1(
          "OUTER_CLEANUP_REQUIRED",
          "a child budget cannot close before the child is terminal",
        );
    }
    const nextReservation: OuterBudgetReservation = {
      ...current,
      status,
      evidence_sha256: evidence.evidence_sha256,
      closed_at: now(),
    };
    const budgets = [...state.budgets];
    budgets[index] = nextReservation;
    const next: WorkflowRuntimeState = { ...state, budgets, updated_at: now() };
    return { state: next, result: next };
  });
}

export function settleOuterBudget(input: CloseOuterBudgetInput): WorkflowRuntimeState {
  return closeBudget(input, "settled");
}

export function releaseOuterBudget(input: CloseOuterBudgetInput): WorkflowRuntimeState {
  return closeBudget(input, "released");
}

function sameCanonical(left: unknown, right: unknown, schemaVersion: string): boolean {
  return (
    canonicalJsonSha256(left, undefined, { schemaVersion }) ===
    canonicalJsonSha256(right, undefined, { schemaVersion })
  );
}

function sameIdList(left: readonly string[], right: readonly string[]): boolean {
  return sameCanonical(left, right, "outer-id-list-v1");
}

function currentCycleChildren(
  state: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
): OuterChildRecord[] {
  return state.children.filter(
    (child) =>
      child.outer_iteration === cycle.outer_iteration && child.generation === cycle.generation,
  );
}

function assertCycleChildrenComplete(
  state: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
): OuterChildRecord[] {
  const children = currentCycleChildren(state, cycle);
  if (cycle.wave_kind === "scorer") {
    if (!children.some((child) => child.kind === "scorer"))
      failA1("CHILD_REQUIRED", "a scorer wave must register a scorer child");
  } else if (!children.some((child) => child.kind === "module")) {
    failA1("CHILD_REQUIRED", "a module or structure wave must register a module child");
  }
  if (children.some((child) => child.status === "active"))
    failA1("OUTER_CLEANUP_REQUIRED", "all cycle children must be terminal before cycle completion");
  return children;
}

function cycleBudgetSummary(
  projectRoot: string,
  outerRunId: string,
  state: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
): OuterCycleSummary["budget"] {
  const budgets = state.budgets.filter(
    (budget) => budget.outer_iteration === cycle.outer_iteration,
  );
  const units = new Set(budgets.map((budget) => budget.unit));
  if (units.size > 1) failA1("COMPUTE_UNIT_MISMATCH", "one cycle cannot mix budget units");
  const frozen = readFrozenPolicy(projectRoot, outerRunId);
  return {
    reserved: budgets.reduce((total, budget) => total + budget.amount, 0),
    consumed: budgets
      .filter((budget) => budget.status === "settled")
      .reduce((total, budget) => total + budget.amount, 0),
    released: budgets
      .filter((budget) => budget.status === "released")
      .reduce((total, budget) => total + budget.amount, 0),
    unit: [...units][0] ?? frozen.owner_limits.max_compute_per_candidate.unit,
  };
}

function stableCycleSummary(projectRoot: string, summary: OuterCycleSummary): OuterCycleSummary {
  const summaryPath = path.join(
    workflowCycleDirectory(projectRoot, summary.outer_run_id, summary.outer_iteration),
    "summary.json",
  );
  if (!fs.existsSync(summaryPath)) {
    writeWorkflowCycleSummary(projectRoot, summary);
    return summary;
  }
  const existing = readWorkflowCycleSummary(
    projectRoot,
    summary.outer_run_id,
    summary.outer_iteration,
  );
  const withoutTime = (value: OuterCycleSummary): Omit<OuterCycleSummary, "recorded_at"> => {
    const { recorded_at: _recordedAt, ...rest } = value;
    return rest;
  };
  if (!sameCanonical(withoutTime(existing), withoutTime(summary), "outer-cycle-summary-v1"))
    failA1("IMMUTABLE_CONFLICT", "cycle summary already contains different evidence", summaryPath);
  return existing;
}

function finishFailedWaveCycle(
  normalized: Required<OuterRunIdentity>,
  working: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
  input: CompleteOuterCycleInput,
): WorkflowRuntimeState {
  if (input.status === "completed") {
    failA1("CHILD_FAILED", "a cycle with a failed child cannot be marked completed");
  }
  const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
  const summary: OuterCycleSummary = {
    schema_version: 1,
    outer_run_id: normalized.outer_run_id,
    outer_iteration: cycle.outer_iteration,
    generation: cycle.generation,
    wave_id: cycle.wave_id,
    wave_kind: cycle.wave_kind,
    status: input.status ?? "failed",
    candidate_ids: input.candidate_ids === undefined ? [] : [...input.candidate_ids],
    finalist_id: null,
    promotion_trial_id: null,
    validation_result: "not_run",
    promotion_result: "not_run",
    target_reached: false,
    valid_candidate: false,
    tester_improved: null,
    budget: cycleBudgetSummary(normalized.project_root, normalized.outer_run_id, working, cycle),
    evidence_refs: evidence.evidence_refs,
    evidence_sha256: evidence.evidence_sha256,
    recorded_at: now(),
  };
  const persistedSummary = stableCycleSummary(normalized.project_root, summary);
  const phaseHistory = openPhase(closePhase(working, evidence), "summary", cycle);
  return {
    ...working,
    current_phase: "summary",
    active_cycle: null,
    phase_history: phaseHistory,
    cycle_history: [...working.cycle_history, persistedSummary],
    updated_at: now(),
  };
}

function finishFailedBridgeCycle(
  normalized: Required<OuterRunIdentity>,
  working: WorkflowRuntimeState,
  cycle: ActiveOuterCycle,
  input: CompleteOuterCycleInput,
): WorkflowRuntimeState {
  const failure = bridgeFailureOf(cycle);
  if (failure?.status !== "exhausted")
    failA1(
      "BRIDGE_REPAIR_PENDING",
      "an outer cycle can close after bridge repair only when the repair limit is exhausted",
    );
  if (input.status === "completed")
    failA1("BRIDGE_REPAIR_LIMIT", "a cycle with an exhausted bridge cannot be completed");
  const currentChildren = currentCycleChildren(working, cycle);
  if (currentChildren.length > 0)
    failA1(
      "OUTER_PHASE_ORDER",
      "an exhausted bridge candidate cannot have created downstream children",
    );
  const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
  const summary: OuterCycleSummary = {
    schema_version: 1,
    outer_run_id: normalized.outer_run_id,
    outer_iteration: cycle.outer_iteration,
    generation: cycle.generation,
    wave_id: cycle.wave_id,
    wave_kind: cycle.wave_kind,
    status: input.status ?? "failed",
    candidate_ids: input.candidate_ids === undefined ? [] : [...input.candidate_ids],
    finalist_id: null,
    promotion_trial_id: null,
    validation_result: "not_run",
    promotion_result: "not_run",
    target_reached: false,
    valid_candidate: false,
    tester_improved: null,
    budget: cycleBudgetSummary(normalized.project_root, normalized.outer_run_id, working, cycle),
    evidence_refs: evidence.evidence_refs,
    evidence_sha256: evidence.evidence_sha256,
    recorded_at: now(),
  };
  const persistedSummary = stableCycleSummary(normalized.project_root, summary);
  const phaseHistory = openPhase(closePhase(working, evidence, "failed"), "summary", cycle);
  return {
    ...working,
    current_phase: "summary",
    active_cycle: null,
    phase_history: phaseHistory,
    cycle_history: [...working.cycle_history, persistedSummary],
    updated_at: now(),
  };
}

function validationResultFromSelection(
  reason: string,
  selectedCandidateId: string | null,
): ValidationGateRecord["validation_result"] {
  if (selectedCandidateId !== null) return "passed";
  return reason === "validation_incomplete" ? "incomplete" : "rejected";
}

export function completeOuterCycle(input: CompleteOuterCycleInput): WorkflowRuntimeState {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    const bridgeFailure = bridgeFailureOf(cycle);
    if (
      state.current_phase === "workset" &&
      bridgeFailure !== null &&
      bridgeFailure.status === "fixed" &&
      (cycle.bridge_success_receipt_ref === undefined || cycle.bridge_success_receipt_ref === null)
    )
      failA1("BRIDGE_SUCCESS_REQUIRED", "retry the repaired bridge before closing the cycle");
    if (state.current_phase === "bridge-repair" || bridgeFailure?.status === "exhausted") {
      if (bridgeFailure?.status === "pending")
        failA1(
          "BRIDGE_REPAIR_PENDING",
          "complete the pending bridge repair before closing the cycle",
        );
      if (bridgeFailure?.status === "fixed")
        failA1("BRIDGE_SUCCESS_REQUIRED", "retry the repaired bridge before closing the cycle");
      const failedState = finishFailedBridgeCycle(normalized, state, cycle, input);
      return { state: failedState, result: failedState };
    }
    let working = reconcileChildren(normalized, state);
    const children = assertCycleChildrenComplete(working, cycle);
    const childFailed = children.some((child) => child.status === "failed");
    if (state.current_phase === "wave" && childFailed) {
      const failedState = finishFailedWaveCycle(normalized, working, cycle, input);
      return {
        state: failedState,
        result: failedState,
      };
    }
    const validation = readValidationRecord(
      normalized.project_root,
      normalized.outer_run_id,
      cycle.outer_iteration,
    );
    if (
      input.candidate_ids !== undefined &&
      !sameIdList(input.candidate_ids, validation.candidate_ids)
    )
      failA1(
        "VALIDATION_GATE_CONFLICT",
        "cycle candidate ids differ from the recorded validation gate",
      );
    if (input.finalist_id !== undefined && input.finalist_id !== validation.finalist_id)
      failA1(
        "VALIDATION_GATE_CONFLICT",
        "cycle finalist differs from the recorded validation gate",
      );
    if (
      input.validation_result !== undefined &&
      input.validation_result !== validation.validation_result
    )
      failA1("VALIDATION_GATE_CONFLICT", "cycle validation result differs from the recorded gate");

    if (state.current_phase === "validation") {
      if (validation.finalist_id !== null)
        failA1(
          "OUTER_PHASE_ORDER",
          "a validation finalist must pass through the promotion phase before cycle completion",
        );
      const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
      working = {
        ...working,
        current_phase: "summary",
        phase_history: openPhase(closePhase(working, evidence), "summary", cycle),
        updated_at: now(),
      };
    } else if (state.current_phase === "promotion") {
      if (validation.finalist_id === null)
        failA1(
          "PROMOTION_NOT_ALLOWED",
          "a cycle without a validation finalist cannot enter promotion",
        );
      const promotion = readPromotionRecord(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (
        promotion.promotion_trial_id !== input.promotion_trial_id &&
        input.promotion_trial_id !== null &&
        input.promotion_trial_id !== undefined
      )
        failA1(
          "PROMOTION_GATE_CONFLICT",
          "cycle promotion trial does not match the recorded promotion gate",
        );
      const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
      working = {
        ...working,
        current_phase: "summary",
        phase_history: openPhase(closePhase(working, evidence), "summary", cycle),
        updated_at: now(),
      };
    } else if (state.current_phase !== "summary") {
      failA1(
        "OUTER_PHASE_ORDER",
        "cycle completion requires validation, promotion, or summary phase",
      );
    }

    const testerChildren = children.filter((child) => child.kind === "tester");
    let promotionResult: OuterCycleSummary["promotion_result"] = "not_run";
    let promotionTrialId: string | null = null;
    let testerImproved: boolean | null = null;
    if (validation.finalist_id !== null) {
      if (testerChildren.length !== 1)
        failA1("TESTER_REQUIRED", "a validation finalist needs exactly one tester child");
      const testerChild = testerChildren[0]!;
      const tester = readTesterRunState(normalized.project_root, testerChild.child_run_id);
      if (tester.status !== "passed" && tester.status !== "rejected")
        failA1("PROMOTION_GATE_REQUIRED", "tester child is not in a terminal public state");
      if (!tester.gate_consumed || tester.gate_status === null)
        failA1("PROMOTION_GATE_REQUIRED", "tester terminal state is not backed by a consumed gate");
      const mappingPath = testerMappingPath(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (!fs.existsSync(mappingPath))
        failA1("TESTER_ARM_MAPPING_REQUIRED", "promotion cycle has no explicit tester arm mapping");
      const mapping = validateTesterArmMapping(readStateFile(mappingPath), mappingPath);
      assertTesterMappingMatchesState(mapping, tester);
      const promotion = readPromotionRecord(
        normalized.project_root,
        normalized.outer_run_id,
        cycle.outer_iteration,
      );
      if (
        promotion.tester_run_id !== tester.tester_run_id ||
        promotion.promotion_trial_id !== tester.promotion_trial_id ||
        promotion.result !== tester.gate_status
      )
        failA1(
          "PROMOTION_GATE_CONFLICT",
          "promotion evidence does not match the public tester state",
        );
      assertPromotionCommitComplete(
        normalized.project_root,
        normalized.outer_run_id,
        cycle,
        promotion.result,
      );
      promotionResult = promotion.result;
      promotionTrialId = tester.promotion_trial_id;
      testerImproved = promotion.result === "passed";
    } else if (testerChildren.length > 0) {
      failA1("TESTER_NOT_ALLOWED", "a rejected validation gate cannot have a tester child");
    }

    if (input.promotion_result !== undefined && input.promotion_result !== promotionResult)
      failA1(
        "PROMOTION_GATE_CONFLICT",
        "cycle promotion result differs from public tester evidence",
      );
    if (input.tester_improved !== undefined && input.tester_improved !== testerImproved)
      failA1(
        "PROMOTION_GATE_CONFLICT",
        "cycle tester improvement differs from public tester evidence",
      );
    const targetReached = input.target_reached ?? false;
    requireBoolean(targetReached, "target_reached");
    if (targetReached && validation.finalist_id === null)
      failA1("TARGET_EVIDENCE_REQUIRED", "a reached target requires a validated finalist");
    const requestedStatus = input.status;
    if (requestedStatus === "completed" && childFailed)
      failA1("CHILD_FAILED", "a cycle with a failed child cannot be marked completed");
    const status: OuterCycleSummary["status"] =
      requestedStatus ??
      (childFailed ||
      validation.validation_result === "incomplete" ||
      validation.validation_result === "not_run"
        ? "failed"
        : "completed");
    const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
    const summary: OuterCycleSummary = {
      schema_version: 1,
      outer_run_id: normalized.outer_run_id,
      outer_iteration: cycle.outer_iteration,
      generation: cycle.generation,
      wave_id: cycle.wave_id,
      wave_kind: cycle.wave_kind,
      status,
      candidate_ids: [...validation.candidate_ids],
      finalist_id: validation.finalist_id,
      promotion_trial_id: promotionTrialId,
      validation_result: validation.validation_result,
      promotion_result: promotionResult,
      target_reached: targetReached,
      valid_candidate: validation.validation_result === "passed",
      tester_improved: testerImproved,
      budget: cycleBudgetSummary(normalized.project_root, normalized.outer_run_id, working, cycle),
      evidence_refs: evidence.evidence_refs,
      evidence_sha256: evidence.evidence_sha256,
      recorded_at: now(),
    };
    const persistedSummary = stableCycleSummary(normalized.project_root, summary);
    const next: WorkflowRuntimeState = {
      ...working,
      active_cycle: null,
      cycle_history: [...working.cycle_history, persistedSummary],
      updated_at: now(),
    };
    return { state: next, result: next };
  });
}

export const finishOuterCycle = completeOuterCycle;
export const completeWorkflowCycle = completeOuterCycle;

export function recordWorkflowStopDecision(input: RecordStopDecisionInput): StopDecision {
  return withRuntimeMutation(input, (state, normalized) => {
    if (state.current_phase !== "summary" || state.active_cycle !== null)
      failA1("OUTER_PHASE_ORDER", "stop gate requires a completed cycle in summary phase");
    const latest = state.cycle_history[state.cycle_history.length - 1];
    if (!latest) failA1("OUTER_CYCLE_REQUIRED", "stop gate requires at least one completed cycle");
    const policy = readFrozenPolicy(normalized.project_root, normalized.outer_run_id);
    const ledger = readExposureLedger(
      normalized.project_root,
      policy.task_id,
      policy.tester_definition.max_exposures_per_task,
    );
    const exposure: StopExposureSnapshot = {
      max_exposures_per_task: ledger.max_exposures_per_task,
      reserved: ledger.exposures.filter((item) => item.status === "reserved").length,
      settled: ledger.exposures.filter((item) => item.status === "settled").length,
      released: ledger.exposures.filter((item) => item.status === "released").length,
    };
    const budgetPolicy = input.budget
      ? { limit: input.budget.limit, unit: input.budget.unit }
      : input.policy.max_outer_budget;
    const budget: StopBudgetSnapshot | undefined = budgetPolicy
      ? {
          limit: "limit" in budgetPolicy ? budgetPolicy.limit : budgetPolicy.amount,
          reserved: state.budgets
            .filter((item) => item.status === "reserved")
            .reduce((total, item) => total + item.amount, 0),
          consumed: state.budgets
            .filter((item) => item.status === "settled")
            .reduce((total, item) => total + item.amount, 0),
          released: state.budgets
            .filter((item) => item.status === "released")
            .reduce((total, item) => total + item.amount, 0),
          unit: budgetPolicy.unit,
        }
      : undefined;
    const decision = evaluateWorkflowStopGate({
      outer_run_id: normalized.outer_run_id,
      policy: input.policy,
      cycle_summaries: state.cycle_history,
      exposure,
      budget,
      outer_iteration: state.outer_iteration,
    });
    const persisted = writeWorkflowStopDecision(
      normalized.project_root,
      normalized.outer_run_id,
      latest.outer_iteration,
      decision,
    );
    const stopDecisionRef = workflowCycleRelativePath(latest.outer_iteration, "stop-decision.json");
    const next: WorkflowRuntimeState = {
      ...state,
      stop_decision_ref: stopDecisionRef,
      updated_at: now(),
    };
    return { state: next, result: persisted };
  });
}

export const evaluateAndRecordStopGate = recordWorkflowStopDecision;
export const recordStopDecision = recordWorkflowStopDecision;

function readLatestStopDecision(
  projectRoot: string,
  outerRunId: string,
  state: WorkflowRuntimeState,
): StopDecision {
  const latest = state.cycle_history[state.cycle_history.length - 1];
  if (!latest || state.stop_decision_ref === null)
    failA1("OUTER_STOP_DECISION_REQUIRED", "outer run has no stop decision");
  if (
    state.stop_decision_ref !==
    workflowCycleRelativePath(latest.outer_iteration, "stop-decision.json")
  )
    failA1("IDENTITY_MISMATCH", "stop decision reference is not derived from the latest cycle");
  return readWorkflowStopDecision(projectRoot, outerRunId, latest.outer_iteration);
}

export function finishOuterRun(input: FinishOuterRunInput): WorkflowRuntimeState {
  const normalized = normalizedIdentity(input);
  const lease = acquireOuterRunLease({ ...normalized, mode: "control" });
  try {
    const filePath = runtimePath(normalized);
    return withStateFileLock(filePath, () => {
      if (!fs.existsSync(filePath))
        failA1("OUTER_RUN_STATE_NOT_FOUND", `no workflow runtime at ${filePath}`);
      const current = readWorkflowRuntimeState(normalized.project_root, normalized.outer_run_id);
      assertRuntimeIdentity(normalized, current);
      if (TERMINAL_RUNTIME_STATUSES.has(current.status)) {
        if (current.status !== input.outcome)
          failA1("OUTER_RUN_TERMINAL", "terminal outer run has a different outcome");
        return current;
      }
      if (current.current_phase !== "summary" || current.active_cycle !== null)
        failA1("OUTER_CLEANUP_REQUIRED", "outer run must finish from a clean summary phase");
      const reconciled = reconcileChildren(normalized, current);
      assertRuntimeCleanup(reconciled);
      const decision = readLatestStopDecision(
        normalized.project_root,
        normalized.outer_run_id,
        reconciled,
      );
      if (decision.decision !== "stop")
        failA1("OUTER_STOP_REQUIRED", "a run cannot finish while the stop gate says continue");
      if (
        input.outcome !== "completed" &&
        input.outcome !== "failed" &&
        input.outcome !== "stopped"
      )
        failA1("INVALID_VALUE", "outer run outcome is invalid");
      const evidence = hashOuterEvidence(normalized.project_root, input.evidence_paths);
      const next: WorkflowRuntimeState = {
        ...reconciled,
        status: input.outcome,
        phase_history: closePhase(reconciled, evidence, input.outcome),
        updated_at: now(),
      };
      const persisted = persistRuntimeState(normalized, next);
      lease.release();
      return persisted;
    });
  } finally {
    lease.close();
  }
}

export const finishWorkflowRun = finishOuterRun;

export function resumeOuterRun(input: ResumeOuterRunInput): WorkflowRuntimeState {
  return resumeOuterRunInternal(input, true);
}

function resumeOuterRunInternal(
  input: ResumeOuterRunInput,
  formalTesterAgent: boolean,
): WorkflowRuntimeState {
  const normalized = normalizedIdentity(input);
  if (formalTesterAgent) {
    readRequiredTesterAgentConfig(input, true);
    const statePath = workflowRuntimePath(normalized.project_root, normalized.outer_run_id);
    if (fs.existsSync(statePath))
      assertFrozenTesterAgentConfig(input, normalized.project_root, normalized.outer_run_id, true);
  }
  const scopedRun = normalized.scope_path !== "/";
  const owner = scopedRun ? null : readOuterRunOwnership(normalized.execution_root);
  if (!scopedRun && owner === null)
    failA1("OUTER_OWNERSHIP_NOT_FOUND", "resume requires an existing outer ownership record");
  if (owner !== null) ownerMatchesRequest(owner, normalized);
  if (owner?.status === "released") {
    const statePath = workflowRuntimePath(normalized.project_root, normalized.outer_run_id);
    if (!fs.existsSync(statePath))
      failA1("OUTER_RUN_TERMINAL", "released outer run has no recoverable runtime state");
    const state = readWorkflowRuntimeState(normalized.project_root, normalized.outer_run_id);
    assertRuntimeIdentity(normalized, state);
    return state;
  }
  if (scopedRun) requireRunContract(normalized.project_root, normalized.outer_run_id);
  const lease = acquireOuterRunLease({ ...normalized, mode: "resume" });
  try {
    const statePath = workflowRuntimePath(normalized.project_root, normalized.outer_run_id);
    if (!fs.existsSync(statePath)) {
      if (input.freeze_input !== undefined) {
        const freezeInput = validateFreezeIdentity(
          input,
          freezeWithTesterAgentConfig(input, input.freeze_input, formalTesterAgent),
        );
        freezeOuterRun(freezeInput);
        saveFrozenPolicy(freezeInput);
      } else {
        const frozenPath = frozenPolicyPath(normalized.project_root, normalized.outer_run_id);
        if (!fs.existsSync(frozenPath))
          failA1("OUTER_RECOVERY_INPUT_REQUIRED", "runtime recovery needs frozen setup input");
        readFrozenPolicy(normalized.project_root, normalized.outer_run_id);
      }
      const state = writeInitialRuntime(normalized);
      setOwnershipRuntimeStatus(normalized, state.status);
      return state;
    }
    return withStateFileLock(statePath, () => {
      const current = readWorkflowRuntimeState(normalized.project_root, normalized.outer_run_id);
      assertRuntimeIdentity(normalized, current);
      if (TERMINAL_RUNTIME_STATUSES.has(current.status)) {
        assertRuntimeCleanup(current);
        if (current.stop_decision_ref === null)
          failA1("OUTER_STOP_DECISION_REQUIRED", "terminal outer run has no stop decision");
        const repaired = persistRuntimeState(normalized, current);
        lease.release();
        return repaired;
      }
      const reconciled = reconcileChildren(normalized, current);
      return persistRuntimeState(normalized, reconciled);
    });
  } finally {
    lease.close();
  }
}

export function resumeOuterRunForTest(
  input: Omit<ResumeOuterRunInput, "tester_agent_config_path"> & {
    tester_agent_config_path?: string;
  },
): WorkflowRuntimeState {
  return resumeOuterRunInternal(
    { ...input, tester_agent_config_path: input.tester_agent_config_path ?? "" },
    false,
  );
}

export const resumeWorkflowRun = resumeOuterRun;
export const recoverOuterRun = resumeOuterRun;

export interface OuterRunStatusSnapshot {
  ownership: OuterRunOwnership | null;
  runtime: WorkflowRuntimeState | null;
}

export function readOuterRunStatus(input: OuterRunIdentity): OuterRunStatusSnapshot {
  const normalized = normalizedIdentity(input);
  const runtimeFile = workflowRuntimePath(normalized.project_root, normalized.outer_run_id);
  const runtime = fs.existsSync(runtimeFile)
    ? readWorkflowRuntimeState(normalized.project_root, normalized.outer_run_id)
    : null;
  if (runtime !== null) assertRuntimeIdentity(normalized, runtime);
  const ownership = readOuterRunOwnership(normalized.execution_root);
  if (ownership !== null && ownership.outer_run_id === normalized.outer_run_id)
    ownerMatchesRequest(ownership, normalized);
  return { ownership, runtime };
}

export const statusOuterRun = readOuterRunStatus;

function writeImmutableJson(filePath: string, value: unknown, schemaVersion: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (sameCanonical(existing, value, schemaVersion)) return;
      failA1("IMMUTABLE_CONFLICT", "compiled workflow output cannot change", filePath);
    }
    writeStateJsonAtomic(filePath, value);
  });
}

export function compileOuterCandidate(input: CompileOuterCandidateInput): CompiledOuterCandidate {
  return withRuntimeMutation(input, (state, normalized) => {
    const cycle = currentCycle(state);
    if (state.current_phase !== "workset" && state.current_phase !== "wave")
      failA1("OUTER_PHASE_ORDER", "candidate compilation belongs to workset or wave phase");
    const frozen = readFrozenPolicy(normalized.project_root, normalized.outer_run_id);
    const spec = validateWorkflowSpec(input.spec);
    if (
      spec.task_id !== frozen.task_id ||
      spec.workflow_id !== frozen.workflow_id ||
      spec.task_setup_revision !== frozen.task_setup_revision
    )
      failA1("IDENTITY_MISMATCH", "candidate spec does not match the frozen task setup");
    assertCandidateWithinFrozenLimits(frozen.owner_limits, spec.owner_limits);
    const candidate = validateCandidateSnapshot(input.candidate);
    const candidateId = candidateIdFromSnapshot(candidate, normalized.project_root);
    const requestedWaveKind = input.options?.wave_kind ?? cycle.wave_kind;
    if (requestedWaveKind !== cycle.wave_kind)
      failA1("IDENTITY_MISMATCH", "candidate compilation wave kind differs from the active cycle");
    const compilation = compileWorkflow(spec, {
      ...input.options,
      wave_kind: requestedWaveKind,
      candidate: candidate as unknown as CandidateIdentityInput,
      workspace_root: normalized.project_root,
    });
    if (compilation.candidate_id !== candidateId)
      failA1("CANDIDATE_IDENTITY_MISMATCH", "compiler returned a different candidate identity");
    const directory = pathForCompiledCandidate(
      normalized.project_root,
      normalized.outer_run_id,
      cycle.outer_iteration,
      candidateId,
      candidate,
    );
    writeImmutableJson(path.join(directory, "candidate.json"), candidate, "compiled-candidate-v1");
    writeImmutableJson(
      path.join(directory, "compiled-workflow.json"),
      compilation,
      "compiled-workflow-v1",
    );
    return {
      state,
      result: { candidate_id: candidateId, candidate, compilation, directory },
    };
  });
}

export const compileWorkflowCandidate = compileOuterCandidate;

export function readOuterRunState(input: OuterRunIdentity): WorkflowRuntimeState {
  const normalized = normalizedIdentity(input);
  const state = readWorkflowRuntimeState(normalized.project_root, normalized.outer_run_id);
  assertRuntimeIdentity(normalized, state);
  return state;
}

export const readWorkflowRuntime = readOuterRunState;
