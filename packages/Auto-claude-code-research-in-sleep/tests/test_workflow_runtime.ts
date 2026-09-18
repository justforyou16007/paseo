import { reserveRunExecution, initializeRunBudget } from "../src/tools/run-budget.js";
import { bridgeFixture } from "./helpers/recursive-fixture.js";
import { updateRun, readRun } from "../src/tools/run-contract.js";
import { sealWikiWorkerManifest, wikiWorkerManifestPath } from "../src/tools/research-wiki.js";
import { resolveRunWikiScope } from "../src/tools/wiki-scope.js";
import { createChildContract } from "./helpers/child-contract.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes } from "../src/tools/canonical-json.js";
import { createArtifactRegistry, type ArtifactRegistry } from "../src/tools/artifact-registry.js";
import { buildTesterFeedback, type TesterFeedback } from "../src/tools/tester-feedback.js";
import {
  commitPromotionForTest,
  type PromotionCommitResult,
} from "../src/tools/workflow-promotion-commit.js";
import {
  buildTesterDefinition,
  readTesterRunState,
  recordTesterPrivateResult,
  recordTesterReview,
  recordTesterStarted,
  reservePromotionTrial,
  saveTesterDefinition,
  startTesterRun,
  type TesterArmResult,
  type TesterDefinition,
} from "../src/tools/tester-state.js";
import { consumePromotionGate } from "../src/tools/promotion-gate.js";
import {
  validationBindingSha256,
  validationEvidenceSetSha256,
  selectUniqueFinalist,
  type ValidationBinding,
  type ValidationCellResult,
} from "../src/tools/validation-gate.js";
import { createReviewAssignment, submitReviewReceipt } from "../src/tools/review-submit.js";
import { createTaskSetup } from "../src/tools/task-setup.js";
import {
  createRootRun,
  deriveChildScopePath,
  requireRunContract,
  runJsonPath,
} from "../src/tools/run-contract.js";
import {
  buildResultPackageForRun,
  saveResultPackage,
  type ResultPackageInput,
} from "../src/tools/result-package.js";
import { saveResultReview } from "../src/tools/result-review.js";

/**
 * Publish a result package the way a run has to: build it, have a reviewer
 * outside the run approve that exact digest, then save. These fixtures are not
 * about the review, so the acceptance is produced mechanically -- but it is a
 * real stored acceptance, because `saveResultPackage` now resolves it.
 */
function publishReviewedPackage(root: string, runId: string, input: ResultPackageInput): void {
  const built = buildResultPackageForRun(root, runId, input);
  const reviewId = `review-${runId}`;
  saveResultReview(root, {
    schema_version: 1,
    review_id: reviewId,
    run_id: runId,
    reviewer_worker_id: `reviewer-${runId}`,
    package_sha256: built.package.package_sha256,
    verdict: "approved",
    evidence_refs: [],
    reason_codes: [],
  });
  saveResultPackage(root, runId, input, { review_id: reviewId });
}
import { createBaselineScope } from "../src/tools/baseline-scope.js";
import { createResourceInventory } from "../src/tools/resource-inventory.js";
import { materializeBridgeChildren, planExperimentBridge } from "../src/tools/experiment-bridge.js";
import { harnessDefinitionSha256, type HarnessDefinition } from "../src/tools/tester-harness.js";
import type {
  TesterPublicConclusion,
  TesterPublicFeedbackEnvelope,
} from "../src/tools/tester-public-receipt.js";
import {
  acquireOuterRunLease,
  advanceOuterPhase,
  beginOuterCycle,
  completeOuterCycle,
  finishOuterRun,
  markOuterChildTerminal,
  readOuterRunOwnership,
  readOuterRunStatus,
  reconcileOuterChildren,
  recordPromotionGateResult,
  recordValidationGateResult,
  recordWorkflowStopDecision,
  registerOuterChild,
  releaseOuterRunLease,
  reserveOuterBudget,
  settleOuterBudget,
  startOuterRun,
  startOuterRunForTest,
  resumeOuterRunForTest,
  withOuterRuntimeMutation,
  type OuterRunIdentity,
} from "../src/tools/workflow-runtime.js";
import {
  createWorkflowRuntimeState,
  writeWorkflowRuntimeState,
  type FreezeOuterRunInput,
  type OuterPhase,
} from "../src/tools/workflow-state.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeText(filePath: string, value: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  return sha256(value);
}

export function writeJson(filePath: string, value: unknown): string {
  return writeText(filePath, `${JSON.stringify(value)}\n`);
}

function scopeTokenCount(projectRoot: string, runId: string, scopePath: string): number {
  const filePath = path.join(projectRoot, ".aris", "run-scope-locks.json");
  if (!fs.existsSync(filePath)) return 0;
  const records = JSON.parse(fs.readFileSync(filePath, "utf8")) as Array<{
    run_id: string;
    scope_path: string;
    lease_tokens: string[];
  }>;
  return (
    records.find((record) => record.run_id === runId && record.scope_path === scopePath)
      ?.lease_tokens.length ?? 0
  );
}

export function evidence(root: string, name: string, value: unknown = { name }): string {
  const filePath = path.join(root, "evidence", `${name}.json`);
  writeJson(filePath, value);
  return filePath;
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

export interface Fixture {
  root: string;
  executionRoot: string;
  identity: OuterRunIdentity;
  freezeInput: FreezeOuterRunInput;
  tester: TesterDefinition;
  taskSetupRevision: string;
  modelAssignmentSha256: string;
  inputDistributionSha256: string;
  baselineArtifactSha256: string;
  finalistArtifactSha256: string;
  registry: ArtifactRegistry;
  reviewerWorkerId: string;
}

export interface FixtureOptions {
  reviewer_worker_id?: string;
  workflow_id?: string;
  tester?: TesterDefinition;
  task_id?: string;
  setup_revision?: string;
  producer_run_id?: string;
  baseline_artifact_sha256?: string;
  finalist_artifact_sha256?: string;
  outer_budget?: { amount: number; unit: string };
}

export function makeFixture(
  root: string,
  executionRoot: string,
  outerRunId: string,
  testerMaxExposures = 4,
  options: FixtureOptions = {},
): Fixture {
  createRootRun({
    project_root: root,
    run_id: outerRunId,
    input_snapshot_sha256: "c".repeat(64),
    code_baseline_sha256: "a".repeat(64),
    policy_revision: "policy:module-fixture",
  });
  // setupRootRun opens the ledger from the charter budget in production. This
  // fixture creates the contract directly, so it has to open the same account.
  // Every child this fixture creates draws 10 from here, so the default is wide
  // enough that no test hits the ledger by accident. A test that wants the run
  // to actually run out of resources passes its own balance.
  initializeRunBudget(root, outerRunId, options.outer_budget ?? { amount: 1000, unit: "gpu_hours" });
  const taskId = options.task_id ?? "task:fixed";
  const workflowId = options.workflow_id ?? "workflow:fixed";
  const policy = {
    revision: "policy:fixed",
    approval_id: "approval:policy",
    roles: [
      {
        role_id: "main-model",
        allowed_modules: ["module:a", "module:b", "module:c"],
        allowed_uses: ["generate"],
        judge_targets: [],
        judge_generation_lag: null,
        artifact_binding: "previous_promoted",
        promotion_output: "main.model",
        user_confirmed: true,
        approval_id: "approval:main",
      },
    ],
  } as const;
  const taskSetup = createTaskSetup({
    task_id: taskId,
    workflow_id: workflowId,
    setup_revision: options.setup_revision ?? "setup:fixed",
    model_usage_policy: policy,
    tester_id: options.tester?.tester_id ?? "tester:fixed",
    tester_version: options.tester?.version ?? "tester:v1",
  });
  const harness: HarnessDefinition = {
    schema_version: 1,
    harness_id: "harness:fixed",
    interpreter: process.execPath,
    interpreter_sha256: HASH_A,
    entrypoint: path.join(root, "harness-entry.js"),
    entrypoint_sha256: HASH_B,
    dependencies: [],
    model_roots: [root],
    timeout_ms: 1000,
    max_model_bytes: 1024 * 1024,
    max_result_bytes: 1024 * 1024,
  };
  const harnessSha256 = harnessDefinitionSha256(harness);
  const tester =
    options.tester ??
    buildTesterDefinition({
      schema_version: 1,
      tester_id: "tester:fixed",
      version: "tester:v1",
      immutable: true,
      case_manifest_id: "cases:fixed",
      case_manifest_sha256: HASH_C,
      seed_manifest_sha256: HASH_D,
      harness_sha256: harnessSha256,
      research_feedback: "fuzzy_advice_only",
      max_exposures_per_task: testerMaxExposures,
      comparison: "paired_matching_baseline_vs_finalist",
      gate: {
        primaries: [{ name: "tester_score", direction: "higher_better", improvement: { policy: "absolute", minimum_gain: 0.1 } }],
        paired_delta: "finalist_minus_matching_baseline",
        statistics: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 2 },
        case_aggregation: "mean_of_complete_case_set",
        repeat_aggregation: "lower_confidence_bound",
        tie_policy: "reject_finalist",
        missing_result_policy: "fail_closed",
        constraints: [],
        workflow_constraints: "must_also_pass",
      },
      scoring: [
        { kind: "deterministic_rules", definition_version: "rules:v1", judge_binding: null },
      ],
    });
  const ownerLimits = {
    revision: "limits:fixed",
    max_nodes: 10,
    max_edges: 20,
    max_fan_out_per_node: 4,
    max_unrolled_cycles: 2,
    max_jobs_per_candidate: 20,
    max_compute_per_candidate: { amount: 20, unit: "gpu_hours" },
  } as const;
  const incumbent = {
    candidate_id: "candidate:incumbent",
    generation: 1,
    role_artifacts: [{ role_id: "main-model", artifact_id: "artifact:incumbent", generation: 1 }],
  } as const;
  const freezeInput: FreezeOuterRunInput = {
    project_root: root,
    outer_run_id: outerRunId,
    task_id: taskId,
    owner_limits: ownerLimits,
    task_setup_revision: taskSetup.setup_revision,
    task_setup: taskSetup,
    model_usage_policy_revision: policy.revision,
    model_usage_policy: policy,
    tester_id: tester.tester_id,
    tester_version: tester.version,
    tester_definition: tester,
    incumbent_candidate_id: incumbent.candidate_id,
    incumbent_generation: incumbent.generation,
    incumbent,
  };
  const producerRunId = options.producer_run_id ?? "artifact-run";
  createChildContract(root, outerRunId, producerRunId, "finalist-output");
  const registry = createArtifactRegistry(root, producerRunId);
  const baselinePath = path.join(root, "artifacts", "incumbent.bin");
  const baselineArtifactSha256 =
    options.baseline_artifact_sha256 ?? writeText(baselinePath, "fixed incumbent model\n");
  registry.register({
    schema_version: 1,
    artifact_id: "artifact:incumbent",
    contract: "model@1",
    uri: options.baseline_artifact_sha256
      ? "https://models.example.invalid/incumbent"
      : "artifacts/incumbent.bin",
    file_path: options.baseline_artifact_sha256 ? null : "artifacts/incumbent.bin",
    sha256: baselineArtifactSha256,
    producer_module: "module:fixed",
    producer_version: "module:v1",
    producer_run_id: producerRunId,
    candidate_id: incumbent.candidate_id,
    input_artifact_ids: [],
    status: "sealed",
    generation: incumbent.generation,
    role_id: "main-model",
    output_slot: "main.model",
    source_type: "workflow_output",
  });
  const finalistPath = path.join(root, "artifacts", "finalist.bin");
  const finalistArtifactSha256 =
    options.finalist_artifact_sha256 ?? writeText(finalistPath, "fixed finalist model\n");
  registry.register({
    schema_version: 1,
    artifact_id: "artifact:finalist",
    contract: "model@1",
    uri: options.finalist_artifact_sha256
      ? "https://models.example.invalid/finalist"
      : "artifacts/finalist.bin",
    file_path: options.finalist_artifact_sha256 ? null : "artifacts/finalist.bin",
    sha256: finalistArtifactSha256,
    producer_module: "module:fixed",
    producer_version: "module:v1",
    producer_run_id: producerRunId,
    candidate_id: "candidate:111",
    input_artifact_ids: ["artifact:incumbent"],
    status: "sealed",
    generation: incumbent.generation + 1,
    role_id: "main-model",
    output_slot: "main.model",
    source_type: "workflow_output",
  });
  writeJson(path.join(root, ".aris", "workflows", workflowId, "active-incumbent.json"), incumbent);
  freezeInput.registry = registry;
  return {
    root,
    executionRoot,
    identity: {
      execution_root: executionRoot,
      project_root: root,
      outer_run_id: outerRunId,
      
      
      task_id: taskId,
      workflow_id: workflowId,
    },
    freezeInput,
    tester,
    taskSetupRevision: taskSetup.setup_revision,
    modelAssignmentSha256: HASH_E,
    inputDistributionSha256: HASH_F,
    baselineArtifactSha256,
    finalistArtifactSha256,
    registry,
    reviewerWorkerId: options.reviewer_worker_id ?? "reviewer:fixed",
  };
}

export function recover(fixture: Fixture, expectedPhase: OuterPhase): void {
  const state = resumeOuterRunForTest(fixture.identity);
  assert.equal(state.current_phase, expectedPhase);
  assert.equal(state.outer_run_id, fixture.identity.outer_run_id);
}

function moduleRoot(root: string, moduleRunId: string): string {
  return path.join(root, ".aris", "runs", moduleRunId);
}

export function makeModule(
  root: string,
  moduleRunId: string,
  moduleId: string,
  outerRunId = "outer-fixed",
): void {
  // A module child is an ordinary research run. All the parent creates for it
  // is the run contract and the Wiki binding it is dispatched against;
  // everything the parent later reads about it comes from the result package
  // the child publishes.
  createChildContract(root, outerRunId, moduleRunId, moduleId);
  const snapshotRef = path.relative(root, path.join(moduleRoot(root, moduleRunId), "input-snapshot.json"));
  sealWikiWorkerManifest({
    project_root: root,
    run_id: moduleRunId,
    worker: "idea-discovery",
    input_snapshot: {
      ref: snapshotRef,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, snapshotRef))).digest("hex"),
    },
  });
}

/**
 * Finish a module child the way a real one finishes: seal the files it
 * produced and publish a result package that a reviewer accepted. There is no
 * phase machine here any more - the child's own auto-review-loop is what lets
 * the package be written at all, which is why `saveResultPackage` refuses one
 * without a reviewer receipt.
 */
export function completeModule(root: string, moduleRunId: string, moduleId: string): void {
  const contract = requireRunContract(root, moduleRunId);
  const runRoot = moduleRoot(root, moduleRunId);
  const identity = { module_run_id: moduleRunId, module_id: moduleId };
  const outputs: Record<string, unknown> = {
    "outputs/review.json": { ...identity, phase: "auto-review-loop", verdict: "ready" },
    "outputs/gate.json": { ...identity, phase: "metric-gate", stop_reason: "metric_met" },
    "outputs/proposal.json": {
      ...identity,
      phase: "proposal",
      proposal: `proposal:${moduleId}`,
    },
  };
  const outputHashes: Record<string, string> = {};
  for (const [relative, value] of Object.entries(outputs)) {
    outputHashes[relative] = writeJson(path.join(runRoot, relative), value);
  }
  publishReviewedPackage(root, moduleRunId, {
    run_id: moduleRunId,
    parent_run_id: contract.parent_run_id,
    scope_path: contract.scope_path,
    status: "succeeded",
    output_paths: Object.keys(outputs),
    output_hashes: outputHashes,
    input_snapshot_sha256: contract.identity_material.input_snapshot_sha256,
    summary: `Module ${moduleId} finished its own review loop.`,
  });
}

export function validationInputs(): {
  plan: Array<{ cell_id: string; module_ids: string[] }>;
  results: ValidationCellResult[];
  binding: ValidationBinding;
  review: ReturnType<typeof makeValidationReview>;
} {
  const plan = [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: ["module:a"] },
    { cell_id: "01", module_ids: ["module:b"] },
    { cell_id: "001", module_ids: ["module:c"] },
    { cell_id: "110", module_ids: ["module:a", "module:b"] },
    { cell_id: "101", module_ids: ["module:a", "module:c"] },
    { cell_id: "011", module_ids: ["module:b", "module:c"] },
    { cell_id: "111", module_ids: ["module:a", "module:b", "module:c"] },
  ];
  const binding: ValidationBinding = {
    active_scorer_revision: "scorer:fixed",
    model_assignment_sha256: HASH_E,
    sample_plan_sha256: HASH_F,
    repeat_ids: ["repeat:1", "repeat:2"],
  };
  const scoreByCell: Record<string, number> = {
    "00": 1,
    "10": 1.01,
    "01": 1.02,
    "001": 1.03,
    "110": 1.04,
    "101": 1.05,
    "011": 1.06,
    "111": 1.4,
  };
  const results = plan.map((cell) => ({
    status: "succeeded" as const,
    cell_id: cell.cell_id,
    candidate_id: `candidate:${cell.cell_id}`,
    complete: true,
    primary_score: scoreByCell[cell.cell_id]!,
    hard_constraints_passed: true,
    cost: cell.module_ids.length + 1,
    changed_module_count: cell.module_ids.length,
    binding,
    evidence: { evidence_bundle_id: `validation:${cell.cell_id}`, evidence_sha256: HASH_A },
  }));
  return {
    plan,
    results,
    binding,
    review: makeValidationReview(results, binding),
  };
}

function makeValidationReview(
  results: readonly ValidationCellResult[],
  binding: ValidationBinding,
) {
  return {
    review_id: "review:validation-fixed",
    verdict: "approved" as const,
    plan_id: "plan:fixed-3",
    binding_sha256: validationBindingSha256(binding),
    evidence_set_sha256: validationEvidenceSetSha256(results),
    reviewed_cell_ids: results.map((result) => result.cell_id),
    reviewed_candidate_ids: results.map((result) => result.candidate_id),
  };
}

function testerArm(
  fixture: Fixture,
  side: "matching_baseline" | "finalist",
  scores: readonly [number, number, number, number],
): TesterArmResult {
  const artifactSha256 =
    side === "matching_baseline" ? fixture.baselineArtifactSha256 : fixture.finalistArtifactSha256;
  const artifactId = `artifact:sha256:${artifactSha256}`;
  const observations = [
    ["case:1", "repeat:1", scores[0]],
    ["case:2", "repeat:1", scores[1]],
    ["case:1", "repeat:2", scores[2]],
    ["case:2", "repeat:2", scores[3]],
  ].map(([caseId, repeatId, score]) => ({
    case_id: caseId as string,
    repeat_id: repeatId as string,
    metrics: { tester_score: score as number },
    constraint_metrics: {},
  }));
  const mean = scores.reduce((total, score) => total + score, 0) / scores.length;
  return {
    arm: side,
    artifact_id: artifactId,
    artifact_sha256: artifactSha256,
    tester_version: fixture.tester.version,
    tester_definition_sha256: fixture.tester.definition_sha256,
    harness_sha256: fixture.tester.harness_sha256,
    case_manifest_sha256: fixture.tester.case_manifest_sha256,
    seed_manifest_sha256: fixture.tester.seed_manifest_sha256,
    input_distribution_sha256: fixture.inputDistributionSha256,
    judge_binding_id: null,
    model_assignment_sha256: fixture.modelAssignmentSha256,
    case_ids: ["case:1", "case:2"],
    repeat_ids: ["repeat:1", "repeat:2"],
    complete: true,
    metrics: { tester_score: mean },
    constraint_metrics: {},
    observations,
  };
}

function testerReview(fixture: Fixture, testerRunId: string): void {
  const state = readTesterRunState(fixture.root, testerRunId);
  assert.ok(state.private_result_sha256);
  const workerRoot = path.join(
    fixture.root,
    ".aris",
    "runs",
    testerRunId,
    "workers",
    "tester-worker",
  );
  const evidencePath = path.join(workerRoot, "outputs", "evidence.json");
  const evidenceSha256 = writeJson(evidencePath, { result_ref: `opaque:${testerRunId}` });
  writeJson(path.join(workerRoot, "input-manifest.json"), {
    schema_version: 1,
    run_id: testerRunId,
    worker: "tester-worker",
    output_dir: path.relative(fixture.root, path.dirname(evidencePath)),
  });
  writeJson(path.join(workerRoot, "receipt.json"), {
    run_id: testerRunId,
    worker: "tester-worker",
    status: "done",
    primary_output: "evidence.json",
    primary_output_sha256: evidenceSha256,
  });
  const reviewId = `review:${testerRunId}`;
  const subject = {
    promotion_trial_id: state.promotion_trial_id,
    tester_version: state.tester_version,
    case_manifest_sha256: state.case_manifest_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    private_result_sha256: state.private_result_sha256,
  };
  const assignment = createReviewAssignment({
    actor: "review_scheduler",
    project_root: fixture.root,
    review_id: reviewId,
    outer_run_id: fixture.identity.outer_run_id,
    reviewed_run_id: testerRunId,
    reviewed_run_kind: "tester",
    outer_iteration: 1,
    wave_id: "wave:fixed",
    wave_kind: "module",
    review_stage: "promotion_test",
    generation: 1,
    subject,
    reviewer_worker_id: "reviewer:fixed",
    evidence_producer_worker_id: "tester-worker",
    evidence_bundle_id: `evidence:${testerRunId}`,
  });
  const review = {
    schema_version: 1,
    review_id: reviewId,
    reviewed_run_id: testerRunId,
    reviewed_run_kind: "tester" as const,
    outer_iteration: 1,
    wave_id: "wave:fixed",
    wave_kind: "module" as const,
    review_stage: "promotion_test",
    generation: 1,
    subject,
    reviewer_worker_id: "reviewer:fixed",
    evidence_bundle_id: `evidence:${testerRunId}`,
    evidence_sha256: assignment.evidence_sha256,
    verdict: "approved" as const,
    reason_codes: ["complete"],
    evidence_refs: [`opaque:${testerRunId}`],
    command_id: `review-submit:${reviewId}`,
  };
  const submitted = submitReviewReceipt({
    project_root: fixture.root,
    receipt: review,
    manifest_run_id: testerRunId,
    command_run_id: testerRunId,
  });
  recordTesterReview(fixture.root, testerRunId, submitted.receipt);
}

export function sealFinalistProducer(fixture: Fixture): void {
  const producer = requireRunContract(fixture.root, fixture.registry.runId);
  // A result package needs an acceptance from outside the run; this stands in
  // for the review the run's own auto-review-loop runs before publishing.
  publishReviewedPackage(fixture.root, producer.run_id, {
    run_id: producer.run_id,
    parent_run_id: producer.parent_run_id,
    scope_path: producer.scope_path,
    status: "succeeded",
    input_snapshot_sha256: producer.identity_material.input_snapshot_sha256,
    output_hashes: { "artifacts/finalist.bin": fixture.finalistArtifactSha256 },
    summary: "The workflow finalist completed validation.",
  });
}

export function prepareTester(
  fixture: Fixture,
  finalistScores: readonly [number, number, number, number],
): { testerRunId: string; baseline: TesterArmResult; finalist: TesterArmResult } {
  const testerRunId = "tester-run-fixed";
  const trialId = "promotion:fixed";
  sealFinalistProducer(fixture);
  // The reviewer checks the parent's child list, so the tester needs a real child contract.
  createChildContract(fixture.root, fixture.identity.outer_run_id, testerRunId, "tester");
  saveTesterDefinition(fixture.root, fixture.tester);
  reservePromotionTrial({
    project_root: fixture.root,
    task_id: fixture.freezeInput.task_id,
    promotion_trial_id: trialId,
    outer_run_id: fixture.identity.outer_run_id,
    wave_id: "wave:fixed",
    tester_id: fixture.tester.tester_id,
    tester_version: fixture.tester.version,
    tester_definition_sha256: fixture.tester.definition_sha256,
    harness_sha256: fixture.tester.harness_sha256,
    task_setup_revision: fixture.taskSetupRevision,
    case_manifest_sha256: fixture.tester.case_manifest_sha256,
    seed_manifest_sha256: fixture.tester.seed_manifest_sha256,
    matching_baseline_artifact_sha256: fixture.baselineArtifactSha256,
    finalist_artifact_sha256: fixture.finalistArtifactSha256,
    model_assignment_sha256: fixture.modelAssignmentSha256,
    input_distribution_sha256: fixture.inputDistributionSha256,
    judge_binding: null,
    max_exposures_per_task: fixture.tester.max_exposures_per_task,
  });
  startTesterRun({
    project_root: fixture.root,
    tester_run_id: testerRunId,
    task_id: fixture.freezeInput.task_id,
    outer_run_id: fixture.identity.outer_run_id,
    outer_iteration: 1,
    wave_id: "wave:fixed",
    wave_kind: "module",
    generation: 1,
    promotion_trial_id: trialId,
    tester: fixture.tester,
    task_setup_revision: fixture.taskSetupRevision,
    input_snapshot_sha256: HASH_D,
    harness_sha256: fixture.tester.harness_sha256,
    matching_baseline_artifact_sha256: fixture.baselineArtifactSha256,
    finalist_artifact_sha256: fixture.finalistArtifactSha256,
    model_assignment_sha256: fixture.modelAssignmentSha256,
    input_distribution_sha256: fixture.inputDistributionSha256,
    judge_binding: null,
  });
  const baseline = testerArm(fixture, "matching_baseline", [1, 1, 1.1, 1.1]);
  const finalist = testerArm(fixture, "finalist", finalistScores);
  recordTesterStarted(fixture.root, testerRunId);
  recordTesterPrivateResult(fixture.root, testerRunId, {
    baseline,
    finalist,
    harness_sha256: fixture.tester.harness_sha256,
    workflow_constraints_passed: true,
  });
  testerReview(fixture, testerRunId);
  sealWikiWorkerManifest({ project_root: fixture.root, run_id: testerRunId, worker: "tester" });
  return { testerRunId, baseline, finalist };
}

export function publicTesterConclusion(
  fixture: Fixture,
  testerRunId: string,
): TesterPublicConclusion {
  const state = readTesterRunState(fixture.root, testerRunId);
  assert.equal(state.gate_consumed, true);
  assert.ok(state.gate_status);
  return {
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    outer_run_id: state.outer_run_id,
    task_id: state.task_id,
    promotion_trial_id: state.promotion_trial_id,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    wave_id: state.wave_id,
    tester_definition_sha256: state.tester_definition_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    input_snapshot_sha256: state.input_snapshot_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
    private_result_sha256: state.private_result_sha256!,
    review_receipt_sha256: state.review_receipt_sha256!,
    status: state.gate_status,
  };
}

export function signTesterConclusion(conclusion: TesterPublicConclusion): {
  conclusion: TesterPublicConclusion;
  signature: string;
  publicKey: crypto.KeyObject;
} {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const signedBytes = Buffer.concat([
    Buffer.from("aris-tester-public-conclusion-v1\n"),
    canonicalJsonBytes(conclusion),
  ]);
  return {
    conclusion,
    signature: crypto.sign(null, signedBytes, keyPair.privateKey).toString("base64"),
    publicKey: keyPair.publicKey,
  };
}

export function signTesterFeedback(
  fixture: Fixture,
  testerRunId: string,
  status: "passed" | "rejected",
  feedback: TesterFeedback,
): {
  feedback: TesterPublicFeedbackEnvelope;
  signature: string;
  publicKey: crypto.KeyObject;
} {
  const state = readTesterRunState(fixture.root, testerRunId);
  const envelope: TesterPublicFeedbackEnvelope = {
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    outer_run_id: state.outer_run_id,
    task_id: state.task_id,
    promotion_trial_id: state.promotion_trial_id,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    wave_id: state.wave_id,
    tester_definition_sha256: state.tester_definition_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    input_snapshot_sha256: state.input_snapshot_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    tester_version: state.tester_version,
    tester_conclusion_status: status,
    feedback,
  };
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const signedBytes = Buffer.concat([
    Buffer.from("aris-tester-public-feedback-v1\n"),
    canonicalJsonBytes(envelope),
  ]);
  return {
    feedback: envelope,
    signature: crypto.sign(null, signedBytes, keyPair.privateKey).toString("base64"),
    publicKey: keyPair.publicKey,
  };
}

export function feedbackForTester(
  fixture: Fixture,
  testerRunId: string,
  status: "passed" | "rejected",
): TesterFeedback {
  const state = readTesterRunState(fixture.root, testerRunId);
  return buildTesterFeedback({
    schema_version: 1,
    task_id: state.task_id,
    task_setup_revision: state.task_setup_revision,
    input_snapshot_sha256: state.input_snapshot_sha256,
    promotion_trial_id: state.promotion_trial_id,
    tester_version: state.tester_version,
    conclusion: status === "passed" ? "improved" : "not_improved",
    directions: ["long_horizon_stability"],
    advice: ["increase_long_horizon_consistency"],
    confidence: "high",
    metrics: { tester_score: 0.9 },
  });
}

export function startFixture(fixture: Fixture): void {
  startOuterRunForTest({ ...fixture.identity, freeze_input: fixture.freezeInput });
}

function testStartRequiresExistingContract(): void {
  const projectRoot = tempDir("aris-workflow-start-missing-contract-");
  const executionRoot = tempDir("aris-workflow-start-missing-execution-");
  const runId = "missing-start-contract";
  const contractPath = runJsonPath(projectRoot, runId);
  try {
    expectCode(
      () =>
        acquireOuterRunLease({
          execution_root: executionRoot,
          project_root: projectRoot,
          outer_run_id: runId,
          mode: "start",
        }),
      "RUN_CONTRACT_NOT_FOUND",
    );
    assert.equal(fs.existsSync(contractPath), false, "start must not create run.json");
  } finally {
    cleanup(projectRoot);
    cleanup(executionRoot);
  }
}

function testStateCreationRequiresExistingContract(): void {
  const projectRoot = tempDir("aris-workflow-state-missing-contract-");
  const executionRoot = tempDir("aris-workflow-state-missing-execution-");
  const runId = "missing-state-contract";
  const contractPath = runJsonPath(projectRoot, runId);
  try {
    expectCode(
      () =>
        createWorkflowRuntimeState({
          execution_root: executionRoot,
          project_root: projectRoot,
          outer_run_id: runId,
          task_id: "task:missing-state",
          workflow_id: "workflow:missing-state",
        }),
      "RUN_CONTRACT_NOT_FOUND",
    );
    assert.equal(fs.existsSync(contractPath), false, "state construction must not create run.json");
  } finally {
    cleanup(projectRoot);
    cleanup(executionRoot);
  }
}

async function testOwnershipAndRecoveryMutex(): Promise<void> {
  const executionRoot = tempDir("aris-workflow-execution-");
  const projectRoot = tempDir("aris-workflow-project-");
  try {
    const seedSecond = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { createRootRun } from "./src/tools/run-contract.ts";
         createRootRun({ project_root: process.env.ARIS_PROJECT_ROOT, run_id: "outer-second" });`,
      ],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, ARIS_PROJECT_ROOT: projectRoot },
      },
    );
    assert.equal(seedSecond.status, 0, seedSecond.stderr.toString());
    assert.equal(fs.existsSync(runJsonPath(projectRoot, "outer-second")), true);
    createRootRun({ project_root: projectRoot, run_id: "outer-first" });
    const first = acquireOuterRunLease({
      execution_root: executionRoot,
      project_root: projectRoot,
      outer_run_id: "outer-first",
      mode: "start",
    });
    expectCode(
      () => createRootRun({ project_root: projectRoot, run_id: "outer-third" }),
      "RUN_SCOPE_ACTIVE",
    );
    assert.equal(fs.existsSync(runJsonPath(projectRoot, "outer-third")), false);
    first.close();
    expectCode(
      () =>
        acquireOuterRunLease({
          execution_root: executionRoot,
          project_root: projectRoot,
          outer_run_id: "outer-second",
          mode: "start",
        }),
      "OUTER_RUN_ACTIVE",
    );

    const marker = path.join(executionRoot, "controller-ready");
    const childCode = `
      import fs from "node:fs";
      import { acquireOuterRunLease } from "./src/tools/workflow-runtime.ts";
      const lease = acquireOuterRunLease({ execution_root: process.env.ARIS_EXECUTION_ROOT, project_root: process.env.ARIS_PROJECT_ROOT, outer_run_id: "outer-first", mode: "control" });
      fs.writeFileSync(process.env.ARIS_MARKER, "ready");
      setInterval(() => {}, 100);
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childCode],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          ARIS_EXECUTION_ROOT: executionRoot,
          ARIS_PROJECT_ROOT: projectRoot,
          ARIS_MARKER: marker,
        },
        stdio: "ignore",
      },
    );
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      // The child writes a durable marker after acquiring the transient lock.
    }
    assert.equal(fs.existsSync(marker), true);
    expectCode(
      () =>
        acquireOuterRunLease({
          execution_root: executionRoot,
          project_root: projectRoot,
          outer_run_id: "outer-first",
          mode: "resume",
        }),
      "RUN_SCOPE_ACTIVE",
    );
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });

    const deathCode = `
      import { acquireOuterRunLease } from "./src/tools/workflow-runtime.ts";
      acquireOuterRunLease({ execution_root: process.env.ARIS_EXECUTION_ROOT, project_root: process.env.ARIS_PROJECT_ROOT, outer_run_id: "outer-first", mode: "control" });
      process.exit(0);
    `;
    const death = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", deathCode],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          ARIS_EXECUTION_ROOT: executionRoot,
          ARIS_PROJECT_ROOT: projectRoot,
        },
        stdio: "ignore",
      },
    );
    assert.equal(death.status, 0);
    expectCode(
      () =>
        acquireOuterRunLease({
          execution_root: executionRoot,
          project_root: projectRoot,
          outer_run_id: "outer-second",
          mode: "start",
        }),
      "OUTER_RUN_ACTIVE",
    );
    const recovered = acquireOuterRunLease({
      execution_root: executionRoot,
      project_root: projectRoot,
      outer_run_id: "outer-first",
      mode: "resume",
    });
    recovered.close();
    releaseOuterRunLease({
      execution_root: executionRoot,
      project_root: projectRoot,
      outer_run_id: "outer-first",
    });
    assert.equal(readOuterRunOwnership(executionRoot)?.status, "released");
  } finally {
    cleanup(projectRoot);
    cleanup(executionRoot);
  }
}

function testRuntimeMutationRejectsMissingContractBeforeLeasing(): void {
  const projectRoot = tempDir("aris-workflow-mutation-missing-contract-");
  const executionRoot = tempDir("aris-workflow-mutation-missing-execution-");
  const runId = "missing-runtime-mutation";
  const lockPath = path.join(projectRoot, ".aris", "run-scope-locks.json");
  try {
    const beforeBytes = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
    assert.equal(scopeTokenCount(projectRoot, runId, "/"), 0);
    expectCode(
      () =>
        withOuterRuntimeMutation(
          {
            execution_root: executionRoot,
            project_root: projectRoot,
            outer_run_id: runId,
          },
          () => {
            throw new Error("runtime mutation action must not run");
          },
        ),
      "RUN_CONTRACT_NOT_FOUND",
    );
    assert.equal(scopeTokenCount(projectRoot, runId, "/"), 0);
    const afterBytes = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
    assert.deepEqual(afterBytes, beforeBytes);
  } finally {
    cleanup(projectRoot);
    cleanup(executionRoot);
  }
}

async function testNonRootOwnershipNeedsTerminalCleanup(): Promise<void> {
  const executionRoot = tempDir("aris-workflow-scoped-execution-");
  const projectRoot = tempDir("aris-workflow-scoped-project-");
  try {
    const rootId = "scoped-root";
    createRootRun({
      project_root: projectRoot,
      run_id: rootId,
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:scoped",
    });
    initializeRunBudget(projectRoot, rootId, { amount: 10, unit: "gpu_hours" });
    const baseline = createBaselineScope({
      schema_version: 1,
      baseline_id: "W_0",
      workflow_definition: { modules: [{ id: "main" }], edges: [] },
      code_baseline: { ref: "commit:scoped", sha256: HASH_A },
      position_artifacts: { main: { artifact_ref: "artifact:main", artifact_sha256: HASH_B } },
      initial_validation: {
        scorer_revision: "scorer:scoped",
        input_snapshot_sha256: HASH_C,
        judge_binding: { role: "fixed-judge", revision: "judge:scoped" },
        metrics: { score: 0.4 },
      },
      optimizable_scope: [{ position_id: "main", mode: "independent" }],
      max_bundled_positions_per_graph: 0,
    });
    const resource = createResourceInventory({
      schema_version: 1,
      inventory_id: "resources:scoped",
      platforms: [
        {
          platform_id: "gpu-a",
          access_ref: "credential:scoped",
          accelerators: [{ model: "A100", count: 2, memory_gb: 80 }],
          cpu: { cores: 16, memory_gb: 64 },
          capacity: { max_parallel_nodes: 2 },
          quota: { amount: 20, unit: "gpu_hours" },
          writable_paths: [{ path: "/workspace/**", capacity_bytes: 1_000_000 }],
          network: { internet: true, allowed_endpoints: ["https://models.example.invalid"] },
          max_wall_clock_ms: 60_000,
          time_window: { start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
        },
      ],
    });
    const plan = planExperimentBridge(bridgeFixture({
      charter: {
        schema_version: 1,
        charter_id: "charter:scoped",
        run_id: rootId,

        
        expected_output: "scoped child",
        budget: { amount: 10, unit: "gpu_hours" },
        
        
        baseline_sha256: baseline.baseline_sha256,
        resource_inventory_sha256: resource.inventory_sha256,
        optimizable_scope: baseline.optimizable_scope,
        policy_revision: "policy:scoped",
        code_baseline_sha256: HASH_A,
      },
      baseline,
      resource_inventory: resource,
      positions: [
        {
          position_id: "main",
          mode: "independent",
          resource_request: {
            platform_id: "gpu-a",
            accelerator_model: "A100",
            accelerator_count: 1,
            accelerator_memory_gb: 40,
            cpu_cores: 2,
            memory_gb: 8,
            parallel_nodes: 1,
            wall_clock_ms: 1_000,
            writable_path: "/workspace/run",
            endpoint: "https://models.example.invalid",
            quota: { amount: 1, unit: "gpu_hours" },
          },
          candidate_id: "candidate:main",
          result_status: "succeeded",
        },
      ],
    }));
    const [child] = materializeBridgeChildren(projectRoot, plan);
    assert.ok(child);
    assert.equal(child.scope_path, deriveChildScopePath(projectRoot, rootId, child.run_id));
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 1);
    const scopedIdentity = {
      execution_root: executionRoot,
      project_root: projectRoot,
      outer_run_id: child.run_id,
      parent_run_id: child.parent_run_id,
      depth: child.depth,
      scope_path: child.scope_path,
      
      
      
    };
    const lease = acquireOuterRunLease({
      ...scopedIdentity,
      mode: "start",
    });
    lease.close();
    // B keeps one persistent token; the runtime lease holds the second.
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 2);
    expectCode(() => releaseOuterRunLease(scopedIdentity), "OUTER_CLEANUP_REQUIRED");
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 2);
    lease.abortSetup();
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 1);
    const recovered = acquireOuterRunLease({
      ...scopedIdentity,
      mode: "start",
    });
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 2);
    recovered.abortSetup();
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 1);

    const terminal = createWorkflowRuntimeState({
      ...scopedIdentity,
      task_id: "task:scoped",
      workflow_id: "workflow:scoped",
    });
    const completedAt = terminal.phase_history[0]!.started_at;
    terminal.status = "completed";
    terminal.current_phase = "summary";
    terminal.stop_decision_ref = "stop-decision.json";
    terminal.phase_history = [
      {
        ...terminal.phase_history[0]!,
        status: "completed",
        evidence_refs: ["evidence/scoped-init.json"],
        evidence_sha256: HASH_A,
        completed_at: completedAt,
      },
      {
        phase: "summary",
        outer_iteration: 1,
        generation: 1,
        status: "completed",
        evidence_refs: ["evidence/scoped-summary.json"],
        evidence_sha256: HASH_B,
        started_at: completedAt,
        completed_at: completedAt,
      },
    ];
    writeWorkflowRuntimeState(projectRoot, terminal);
    releaseOuterRunLease(scopedIdentity);
    assert.equal(scopeTokenCount(projectRoot, child.run_id, child.scope_path), 0);
  } finally {
    cleanup(projectRoot);
    cleanup(executionRoot);
  }
}

function testFormalStartRequiresIsolationCheck(): void {
  const root = tempDir("aris-workflow-formal-project-");
  const executionRoot = tempDir("aris-workflow-formal-execution-");
  try {
    const fixture = makeFixture(root, executionRoot, "outer-formal");
    expectCode(
      () =>
        startOuterRun({
          ...fixture.identity,
          freeze_input: fixture.freezeInput,
          tester_agent_config_path: "",
        }),
      "TESTER_AGENT_REQUIRED",
    );
    assert.equal(readOuterRunOwnership(executionRoot), null);
  } finally {
    cleanup(root);
    cleanup(executionRoot);
  }
}

function runClosedCycle(finalistScores: readonly [number, number, number, number]): {
  result: "passed" | "rejected";
  reason: string;
  stateStatus: "completed" | "failed" | "stopped";
} {
  const root = tempDir("aris-workflow-closure-project-");
  const executionRoot = tempDir("aris-workflow-closure-execution-");
  try {
    const fixture = makeFixture(root, executionRoot, "outer-fixed");
    startFixture(fixture);
    recover(fixture, "init");

    beginOuterCycle({
      ...fixture.identity,
      wave_id: "wave:fixed",
      wave_kind: "module",
      evidence_paths: [evidence(root, "cycle-begin")],
    });
    recover(fixture, "diagnosis");
    advanceOuterPhase({
      ...fixture.identity,
      from_phase: "diagnosis",
      to_phase: "workset",
      evidence_paths: [evidence(root, "diagnosis")],
    });
    recover(fixture, "workset");
    advanceOuterPhase({
      ...fixture.identity,
      from_phase: "workset",
      to_phase: "wave",
      evidence_paths: [evidence(root, "workset")],
    });
    recover(fixture, "wave");

    const sealedParent = wikiWorkerManifestPath(root, "outer-fixed");
    assert.equal(
      readRun(root, "outer-fixed").output_hashes["input-manifest.json"],
      crypto.createHash("sha256").update(fs.readFileSync(sealedParent)).digest("hex"),
    );
    const moduleIds = ["module:a", "module:b", "module:c"];
    const moduleRunIds = ["module-run-a", "module-run-b", "module-run-c"];
    for (let index = 0; index < moduleIds.length; index += 1) {
      const moduleId = moduleIds[index]!;
      const moduleRunId = moduleRunIds[index]!;
      makeModule(root, moduleRunId, moduleId);
      const registration = {
        ...fixture.identity,
        child_run_id: moduleRunId,
        kind: "module" as const,
        module_id: moduleId,
      };
      const parentPath = wikiWorkerManifestPath(root, "outer-fixed");
      const childPath = wikiWorkerManifestPath(root, moduleRunId);
      const parentBytes = fs.readFileSync(parentPath);
      const childBytes = fs.readFileSync(childPath);
      fs.unlinkSync(parentPath);
      assert.throws(() => registerOuterChild(registration), /WORKER_MANIFEST_REQUIRED/);
      fs.writeFileSync(parentPath, parentBytes);
      const outputs = readRun(root, "outer-fixed").output_hashes;
      updateRun(root, "outer-fixed", { output_hashes: {} });
      assert.throws(() => registerOuterChild(registration), /parent must register/);
      updateRun(root, "outer-fixed", { output_hashes: outputs });
      fs.unlinkSync(childPath);
      assert.throws(() => registerOuterChild(registration), /WORKER_MANIFEST_REQUIRED/);
      fs.writeFileSync(childPath, childBytes);
      const registered = registerOuterChild(registration);
      assert.deepEqual(registerOuterChild(registration), registered);
      fs.appendFileSync(parentPath, " ");
      assert.throws(() => registerOuterChild(registration), /parent must register/);
      fs.writeFileSync(parentPath, parentBytes);
      assert.deepEqual(fs.readFileSync(childPath), childBytes);
    }
    reserveOuterBudget({
      ...fixture.identity,
      reservation_id: "budget:module",
      category: "module",
      amount: 1,
      unit: "gpu_hours",
      child_run_id: "module-run-a",
    });
    recover(fixture, "wave");
    for (let index = 0; index < moduleIds.length; index += 1)
      completeModule(root, moduleRunIds[index]!, moduleIds[index]!);
    reconcileOuterChildren(fixture.identity);
    recover(fixture, "wave");
    settleOuterBudget({
      ...fixture.identity,
      reservation_id: "budget:module",
      evidence_paths: [evidence(root, "module-budget")],
    });
    const waveState = readOuterRunStatus(fixture.identity).runtime;
    assert.equal(waveState?.children.filter((child) => child.kind === "module").length, 3);
    assert.equal(
      waveState?.children.every((child) => child.status === "completed"),
      true,
    );

    advanceOuterPhase({
      ...fixture.identity,
      from_phase: "wave",
      to_phase: "validation",
      evidence_paths: [evidence(root, "wave")],
    });
    recover(fixture, "validation");
    const validation = validationInputs();
    const selection = selectUniqueFinalist(validation.plan, validation.results, {
      plan_id: "plan:fixed-3",
      primary_direction: "higher_better",
      improvement: { policy: "absolute", minimum_gain: 0.2 },
      binding: validation.binding,
      review: validation.review,
    });
    assert.equal(selection.selected_candidate_id, "candidate:111");
    const validationRecord = recordValidationGateResult({
      ...fixture.identity,
      evidence_paths: [evidence(root, "validation")],
      gate_input: {
        plan: validation.plan,
        results: validation.results,
        plan_id: "plan:fixed-3",
        primary_direction: "higher_better",
        improvement: { policy: "absolute", minimum_gain: 0.2 },
        binding: validation.binding,
        review: validation.review,
      },
    });
    assert.equal(validationRecord.finalist_id, "candidate:111");
    recover(fixture, "validation");
    advanceOuterPhase({
      ...fixture.identity,
      from_phase: "validation",
      to_phase: "promotion",
      evidence_paths: [evidence(root, "validation-complete")],
    });
    recover(fixture, "promotion");

    const tester = prepareTester(fixture, finalistScores);
    registerOuterChild({
      ...fixture.identity,
      child_run_id: tester.testerRunId,
      kind: "tester",
    });
    reserveOuterBudget({
      ...fixture.identity,
      reservation_id: "budget:promotion",
      category: "promotion",
      amount: 1,
      unit: "gpu_hours",
      child_run_id: tester.testerRunId,
    });
    const mappingPath = path.join(
      root,
      ".aris",
      "runs",
      "outer-fixed",
      "cycles",
      "1",
      "tester-arm-map.json",
    );
    const mappingText = fs.readFileSync(mappingPath, "utf8");
    const mapping = JSON.parse(mappingText) as {
      arm_a: { name: string };
      arm_b: { name: string };
    };
    assert.equal(mapping.arm_a.name, "matching_baseline");
    assert.equal(mapping.arm_b.name, "finalist");
    assert.equal(mappingText.includes("primary_score"), false);
    recover(fixture, "promotion");
    const gateResult = consumePromotionGate({
      project_root: root,
      tester_run_id: tester.testerRunId,
      definition: fixture.tester,
      baseline: tester.baseline,
      finalist: tester.finalist,
      workflow_constraints_passed: true,
    });
    reconcileOuterChildren(fixture.identity);
    markOuterChildTerminal({ ...fixture.identity, child_run_id: tester.testerRunId });
    assert.equal(gateResult.status, finalistScores[0] > 1.2 ? "passed" : "rejected");
    assert.equal(readTesterRunState(root, tester.testerRunId).gate_consumed, true);
    const promotionRecord = recordPromotionGateResult({
      ...fixture.identity,
      tester_run_id: tester.testerRunId,
      evidence_paths: [evidence(root, "promotion")],
    });
    assert.equal(promotionRecord.result, gateResult.status);
    recover(fixture, "promotion");
    const signedConclusion = signTesterConclusion(
      publicTesterConclusion(fixture, tester.testerRunId),
    );
    const feedback = feedbackForTester(fixture, tester.testerRunId, gateResult.status);
    const signedFeedback = signTesterFeedback(
      fixture,
      tester.testerRunId,
      gateResult.status,
      feedback,
    );
    const promotionCommit: PromotionCommitResult = commitPromotionForTest({
      ...fixture.identity,
      registry: fixture.registry,
      signed_tester_public_receipt: {
        conclusion: signedConclusion.conclusion,
        signature: signedConclusion.signature,
      },
      tester_public_key: signedConclusion.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
      evidence_paths: [evidence(root, "promotion-commit")],
    });
    assert.equal(promotionCommit.status, gateResult.status === "passed" ? "committed" : "rejected");
    assert.equal(promotionCommit.replaced, gateResult.status === "passed");
    assert.equal(promotionCommit.intent.status, promotionCommit.status);
    assert.equal(
      promotionCommit.active_incumbent.candidate_id,
      gateResult.status === "passed" ? "candidate:111" : "candidate:incumbent",
    );
    const replayedCommit = commitPromotionForTest({
      ...fixture.identity,
      registry: fixture.registry,
      signed_tester_public_receipt: {
        conclusion: signedConclusion.conclusion,
        signature: signedConclusion.signature,
      },
      tester_public_key: signedConclusion.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
      evidence_paths: [evidence(root, "promotion-commit")],
    });
    assert.equal(replayedCommit.replaced, false);
    assert.equal(replayedCommit.intent.intent_sha256, promotionCommit.intent.intent_sha256);
    advanceOuterPhase({
      ...fixture.identity,
      from_phase: "promotion",
      to_phase: "summary",
      evidence_paths: [evidence(root, "promotion-complete")],
    });
    recover(fixture, "summary");
    const cycle = completeOuterCycle({
      ...fixture.identity,
      status: "completed",
      evidence_paths: [evidence(root, "cycle-complete")],
      finalist_id: "candidate:111",
      promotion_trial_id: "promotion:fixed",
      promotion_result: gateResult.status,
      tester_improved: gateResult.status === "passed",
    });
    assert.equal(cycle.active_cycle, null);
    assert.equal(cycle.cycle_history[0]?.promotion_result, gateResult.status);
    const stop = recordWorkflowStopDecision({
      ...fixture.identity,
      policy:
        gateResult.status === "passed"
          ? { max_outer_budget: { amount: 2, unit: "gpu_hours" } }
          : { max_no_tester_improvement_cycles: 1 },
    });
    assert.equal(stop.decision, "stop");
    assert.equal(
      stop.reason,
      gateResult.status === "passed" ? "outer_budget_exhausted" : "no_tester_improvement",
    );
    const finished = finishOuterRun({
      ...fixture.identity,
      outcome: gateResult.status === "passed" ? "completed" : "stopped",
      evidence_paths: [evidence(root, "run-finished")],
    });
    assert.equal(finished.status, gateResult.status === "passed" ? "completed" : "stopped");
    assert.equal(finished.active_cycle, null);
    assert.equal(
      finished.children.some((child) => child.status === "active"),
      false,
    );
    assert.equal(
      finished.budgets.some((budget) => budget.status === "reserved"),
      false,
    );
    assert.equal(readOuterRunOwnership(executionRoot)?.status, "released");
    const recoveredTerminal = resumeOuterRunForTest(fixture.identity);
    assert.equal(recoveredTerminal.status, finished.status);
    assert.equal(recoveredTerminal.phase_history.at(-1)?.phase, "summary");
    return {
      result: gateResult.status,
      reason: stop.reason,
      stateStatus: finished.status,
    };
  } finally {
    cleanup(root);
    cleanup(executionRoot);
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  testStartRequiresExistingContract();
  testStateCreationRequiresExistingContract();
  await testOwnershipAndRecoveryMutex();
  testRuntimeMutationRejectsMissingContractBeforeLeasing();
  await testNonRootOwnershipNeedsTerminalCleanup();
  testFormalStartRequiresIsolationCheck();
  const adopted = runClosedCycle([1.4, 1.4, 1.6, 1.6]);
  assert.deepEqual(adopted, {
    result: "passed",
    reason: "outer_budget_exhausted",
    stateStatus: "completed",
  });
  const rejected = runClosedCycle([1.05, 1.05, 1.15, 1.15]);
  assert.deepEqual(rejected, {
    result: "rejected",
    reason: "no_tester_improvement",
    stateStatus: "stopped",
  });

  console.log("test_workflow_runtime: ok");
}
