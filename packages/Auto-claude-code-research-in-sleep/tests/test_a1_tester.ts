import { sealWikiWorkerManifest } from "../src/tools/research-wiki.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTesterDefinition,
  buildTesterJudgeBinding,
  testerTrialLedgerPath,
  readTesterTrialLedger,
  readTesterRunState,
  recordTesterResult,
  recordTesterReview,
  recordTesterStarted,
  releaseTesterTrial,
  reservePromotionTrial,
  retryTesterInfrastructure,
  saveTesterDefinition,
  startTesterRun,
  testerDashboardPath,
  testerDefinitionPath,
  testerResultPath,
  type TesterJudgeBinding,
  type TesterDefinition,
} from "../src/tools/tester-state.js";
import { runJsonPath, requireRunContract } from "../src/tools/run-contract.js";
import { createChildContract } from "./helpers/child-contract.js";
import { makePromotionFixture } from "./helpers/promotion-fixture.js";
import {
  consumePromotionGate,
  evaluatePromotionGate,
  selectUniqueFinalist,
  type TesterArmResult,
} from "../src/tools/promotion-gate.js";
import {
  validationBindingSha256,
  validationEvidenceSetSha256,
  type ValidationBinding,
  type ValidationCellResult,
} from "../src/tools/validation-gate.js";
import {
  buildTesterFeedback,
  publishTesterFeedback,
  sanitizeTesterFeedback,
  testerFeedbackPath,
} from "../src/tools/tester-feedback.js";
import {
  createReviewAssignment,
  reviewCommandIndexPath,
  submitReviewReceipt,
} from "../src/tools/review-submit.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

const tests: Array<{ name: string; fn: () => void }> = [];

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a1-tester-test-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, (error as Error).message);
    return true;
  });
}

function tester(version = "tester:v1"): TesterDefinition {
  return buildTesterDefinition({
    schema_version: 1,
    tester_id: "tester:fixed",
    version,
    immutable: true,
    case_manifest_id: "cases:v1",
    case_manifest_sha256: HASH_A,
    seed_manifest_sha256: HASH_B,
    harness_sha256: HASH_E,
    research_feedback: "detailed",

    comparison: "paired_matching_baseline_vs_finalist",
    gate: {
      primaries: [{ name: "tester_score", direction: "higher_better", improvement: { policy: "relative", minimum_gain: 0.1 } }],
      paired_delta: "finalist_minus_matching_baseline",
      statistics: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 2 },
      case_aggregation: "mean_of_complete_case_set",
      repeat_aggregation: "lower_confidence_bound",
      tie_policy: "reject_finalist",
      missing_result_policy: "fail_closed",
      constraints: [
        {
          name: "safety_score",
          absolute: { op: ">=", value: 0.9 },
          paired_regression: { op: ">=", value: 0 },
        },
      ],
      workflow_constraints: "must_also_pass",
    },
    scoring: [
      { kind: "deterministic_rules", definition_version: "rules:v1", judge_binding: null },
      {
        kind: "llm_rubric",
        definition_version: "rubric:v1",
        judge_binding: "from_model_usage_policy",
      },
    ],
  });
}

interface TrialSetup {
  tester: TesterDefinition;
  taskId: string;
  outerRunId: string;
  waveId: string;
  trialId: string;
  inputDistributionSha256: string;
  taskSetupRevision: string;
  judgeBinding: TesterJudgeBinding | null;
  judgeBindingId: string | null;
  modelAssignmentSha256: string;
}

function reserve(root: string, setup: TrialSetup): void {
  makePromotionFixture({
    project_root: root,
    outer_run_id: setup.outerRunId,
    wave_id: setup.waveId,
    task_id: setup.taskId,
    setup_revision: setup.taskSetupRevision,
    tester: setup.tester,
    reviewer_worker_id: "reviewer:1",
    baseline_artifact_sha256: HASH_C,
    finalist_artifact_sha256: HASH_D,
  });
  reservePromotionTrial({
    project_root: root,
    task_id: setup.taskId,
    promotion_trial_id: setup.trialId,
    outer_run_id: setup.outerRunId,
    wave_id: setup.waveId,
    tester_id: setup.tester.tester_id,
    tester_version: setup.tester.version,
    tester_definition_sha256: setup.tester.definition_sha256,
    harness_sha256: setup.tester.harness_sha256,
    task_setup_revision: setup.taskSetupRevision,
    case_manifest_sha256: setup.tester.case_manifest_sha256,
    seed_manifest_sha256: setup.tester.seed_manifest_sha256,
    matching_baseline_artifact_sha256: HASH_C,
    finalist_artifact_sha256: HASH_D,
    model_assignment_sha256: setup.modelAssignmentSha256,
    input_distribution_sha256: setup.inputDistributionSha256,
    judge_binding: setup.judgeBinding,

  });
}

function start(root: string, setup: TrialSetup, runId = "tester-run-1") {
  if (!fs.existsSync(runJsonPath(root, runId)))
    createChildContract(root, setup.outerRunId, runId, runId);
  return startTesterRun({
    project_root: root,
    tester_run_id: runId,
    task_id: setup.taskId,
    outer_run_id: setup.outerRunId,
    outer_iteration: 1,
    wave_id: setup.waveId,
    wave_kind: "module",
    generation: 1,
    promotion_trial_id: setup.trialId,
    tester: setup.tester,
    task_setup_revision: setup.taskSetupRevision,
    input_snapshot_sha256: HASH_E,
    harness_sha256: setup.tester.harness_sha256,
    matching_baseline_artifact_sha256: HASH_C,
    finalist_artifact_sha256: HASH_D,
    model_assignment_sha256: setup.modelAssignmentSha256,
    input_distribution_sha256: setup.inputDistributionSha256,
    judge_binding: setup.judgeBinding,
  });
}

function arm(
  setup: TrialSetup,
  side: "matching_baseline" | "finalist",
  score: number,
  overrides: Partial<TesterArmResult> = {},
): TesterArmResult {
  const baseline = side === "matching_baseline";
  return {
    arm: side,
    artifact_id: baseline ? "artifact:baseline" : "artifact:finalist",
    artifact_sha256: baseline ? HASH_C : HASH_D,
    tester_version: setup.tester.version,
    tester_definition_sha256: setup.tester.definition_sha256,
    harness_sha256: setup.tester.harness_sha256,
    case_manifest_sha256: setup.tester.case_manifest_sha256,
    seed_manifest_sha256: setup.tester.seed_manifest_sha256,
    input_distribution_sha256: setup.inputDistributionSha256,
    judge_binding_id: setup.judgeBindingId,
    model_assignment_sha256: setup.modelAssignmentSha256,
    case_ids: ["case:1", "case:2"],
    repeat_ids: ["repeat:1", "repeat:2"],
    complete: true,
    metrics: { tester_score: score },
    constraint_metrics: { safety_score: 0.95 },
    observations: [
      {
        case_id: "case:1",
        repeat_id: "repeat:1",
        metrics: { tester_score: score },
        constraint_metrics: { safety_score: 0.95 },
      },
      {
        case_id: "case:2",
        repeat_id: "repeat:1",
        metrics: { tester_score: score },
        constraint_metrics: { safety_score: 0.95 },
      },
      {
        case_id: "case:1",
        repeat_id: "repeat:2",
        metrics: { tester_score: score },
        constraint_metrics: { safety_score: 0.95 },
      },
      {
        case_id: "case:2",
        repeat_id: "repeat:2",
        metrics: { tester_score: score },
        constraint_metrics: { safety_score: 0.95 },
      },
    ],
    ...overrides,
  };
}

function writeTesterReview(root: string, setup: TrialSetup, runId: string) {
  const workerRoot = path.join(root, ".aris", "runs", runId, "workers", "tester-worker");
  const evidencePath = path.join(workerRoot, "outputs", "evidence.json");
  const evidence = `${JSON.stringify({ result_ref: "opaque:tester-result" })}\n`;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, evidence);
  const evidenceSha256 = crypto.createHash("sha256").update(evidence).digest("hex");
  const testResultSha256 = readTesterRunState(root, runId).test_result_sha256;
  assert.notEqual(testResultSha256, null);
  fs.writeFileSync(
    path.join(workerRoot, "input-manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        worker: "tester-worker",
        output_dir: path.relative(root, path.dirname(evidencePath)),
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(workerRoot, "receipt.json"),
    `${JSON.stringify(
      {
        run_id: runId,
        worker: "tester-worker",
        status: "done",
        primary_output: "evidence.json",
        primary_output_sha256: evidenceSha256,
      },
      null,
      2,
    )}\n`,
  );
  const review = {
    schema_version: 1,
    review_id: "review:tester-1",
    reviewed_run_id: runId,
    reviewed_run_kind: "tester",
    outer_iteration: 1,
    wave_id: setup.waveId,
    wave_kind: "module",
    review_stage: "promotion_test",
    generation: 1,
    subject: {
      promotion_trial_id: setup.trialId,
      tester_version: setup.tester.version,
      case_manifest_sha256: setup.tester.case_manifest_sha256,
      matching_baseline_artifact_sha256: HASH_C,
      finalist_artifact_sha256: HASH_D,
      test_result_sha256: testResultSha256,
    },
    reviewer_worker_id: "reviewer:1",
    evidence_bundle_id: "evidence:tester-1",
    evidence_sha256: evidenceSha256,
    verdict: "approved",
    reason_codes: ["complete"],
    evidence_refs: ["opaque:tester-evidence"],
    command_id: "review-submit:review:tester-1",
  } as const;
  const assignment = createReviewAssignment({
    actor: "review_scheduler",
    project_root: root,
    review_id: review.review_id,
    outer_run_id: setup.outerRunId,
    reviewed_run_id: runId,
    reviewed_run_kind: "tester",
    outer_iteration: 1,
    wave_id: setup.waveId,
    wave_kind: "module",
    review_stage: "promotion_test",
    generation: 1,
    subject: review.subject,
    reviewer_worker_id: review.reviewer_worker_id,
    evidence_producer_worker_id: "tester-worker",
    evidence_bundle_id: review.evidence_bundle_id,
  });
  assert.equal(assignment.evidence_sha256, evidenceSha256);
  const submitted = submitReviewReceipt({
    project_root: root,
    receipt: review,
    manifest_run_id: runId,
    command_run_id: runId,
  });
  recordTesterReview(root, runId, submitted.receipt);
  return review;
}

function readyRun(root: string, setup: TrialSetup, runId = "tester-run-1") {
  saveTesterDefinition(root, setup.tester);
  reserve(root, setup);
  start(root, setup, runId);
  recordTesterStarted(root, runId);
  const baseline = arm(setup, "matching_baseline", 0.5);
  const finalist = arm(setup, "finalist", 0.6);
  recordTesterResult(root, runId, {
    baseline,
    finalist,
    harness_sha256: setup.tester.harness_sha256,
    workflow_constraints_passed: true,
  });
  writeTesterReview(root, setup, runId);
  return { baseline, finalist };
}

function sealedRun(root: string, setup: TrialSetup, runId = "tester-run-1") {
  saveTesterDefinition(root, setup.tester);
  reserve(root, setup);
  start(root, setup, runId);
  recordTesterStarted(root, runId);
  const baseline = arm(setup, "matching_baseline", 0.5);
  const finalist = arm(setup, "finalist", 0.6);
  const testResult = {
    baseline,
    finalist,
    harness_sha256: setup.tester.harness_sha256,
    workflow_constraints_passed: true,
  };
  recordTesterResult(root, runId, testResult);
  return { baseline, finalist, testResult };
}

function setup(
  testerValue = tester(),
  trialId = "promotion:1",
  outerRunId = "outer-1",
  waveId = "wave-1",
): TrialSetup {
  const taskSetupRevision =
    testerValue.version === "tester:v1" ? "setup:v1" : `setup:${testerValue.version}`;
  const judgeBinding = testerValue.scoring.some((entry) => entry.kind === "llm_rubric")
    ? buildTesterJudgeBinding({
        artifact_id: "artifact:judge",
        artifact_sha256: HASH_A,
        source: "previous_promoted",
        generation: 1,
        target_generation: 2,
        task_setup_revision: taskSetupRevision,
        source_incumbent_id: "candidate:incumbent",
      })
    : null;
  return {
    tester: testerValue,
    taskId: "task:fixed",
    outerRunId,
    waveId,
    trialId,
    inputDistributionSha256: HASH_E,
    taskSetupRevision,
    judgeBinding,
    judgeBindingId: judgeBinding?.binding_id ?? null,
    modelAssignmentSha256: HASH_F,
  };
}

function deterministicTester(version = "tester:deterministic"): TesterDefinition {
  const { definition_sha256: ignoredHash, scoring: ignoredScoring, ...base } = tester(version);
  void ignoredHash;
  void ignoredScoring;
  return buildTesterDefinition({
    ...base,
    scoring: [{ kind: "deterministic_rules", definition_version: "rules:v1", judge_binding: null }],
  });
}

test("固定 tester definition 和 case ref 只能同 hash 重放并可修复缺失 ref", () => {
  const root = tempDir();
  try {
    const fixed = tester();
    saveTesterDefinition(root, fixed);
    const refPath = path.join(
      path.dirname(testerDefinitionPath(root, fixed.tester_id, fixed.version)),
      "case-manifest.ref.json",
    );
    fs.rmSync(refPath);
    saveTesterDefinition(root, fixed);
    assert.equal(fs.existsSync(refPath), true);
    fs.writeFileSync(
      refPath,
      JSON.stringify({
        schema_version: 1,
        case_manifest_id: "cases:other",
        case_manifest_sha256: HASH_B,
        seed_manifest_sha256: HASH_A,
      }),
    );
    expectCode(() => saveTesterDefinition(root, fixed), "IMMUTABLE_CONFLICT");
    const changed = tester("tester:v1");
    const changedValue = { ...changed, case_manifest_sha256: HASH_B };
    expectCode(() => saveTesterDefinition(root, changedValue), "TESTER_HASH_MISMATCH");
    expectCode(() => saveTesterDefinition(root, { ...fixed, idea_id: "idea:1" }), "UNKNOWN_FIELD");
  } finally {
    cleanup(root);
  }
});

test("完整消融表中任一计划 cell incomplete 就没有 finalist，且 identity 排序不依赖 localeCompare", () => {
  const plan = [
    { cell_id: "00" as const, module_ids: [] },
    { cell_id: "10" as const, module_ids: ["a"] },
    { cell_id: "01" as const, module_ids: ["b"] },
    { cell_id: "11" as const, module_ids: ["a", "b"] },
  ];
  const rawResults = plan.map((cell, index) => ({
    cell_id: cell.cell_id,
    candidate_id: `candidate:${cell.cell_id}`,
    complete: cell.cell_id !== "01",
    primary_score: 1 + index / 10,
    hard_constraints_passed: true,
    cost: index + 1,
    changed_module_count: cell.module_ids.length,
  }));
  const binding: ValidationBinding = {
    active_scorer_revision: "scorer:v1",
    model_assignment_sha256: HASH_A,
    sample_plan_sha256: HASH_B,
    repeat_ids: ["repeat:1"],
  };
  const attachValidation = (input: typeof rawResults): ValidationCellResult[] =>
    input.map((result) => ({
      ...result,
      status: "succeeded" as const,
      binding,
      evidence: {
        evidence_bundle_id: `evidence:${result.cell_id}`,
        evidence_sha256: HASH_C,
      },
    }));
  const reviewFor = (input: readonly ValidationCellResult[]) => ({
    review_id: "review:validation-1",
    verdict: "approved" as const,
    plan_id: "plan:v1",
    binding_sha256: validationBindingSha256(binding),
    evidence_set_sha256: validationEvidenceSetSha256(input),
    reviewed_cell_ids: input.map((result) => result.cell_id),
    reviewed_candidate_ids: input.map((result) => result.candidate_id),
  });
  const results = attachValidation(rawResults);
  const incomplete = selectUniqueFinalist(plan, results, {
    plan_id: "plan:v1",
    primary_direction: "higher_better",
    improvement: { policy: "relative", minimum_gain: 0.01 },
    binding,
    review: reviewFor(results),
  });
  assert.equal(incomplete.selected_candidate_id, null);
  assert.equal(incomplete.selected_cell_id, null);

  const tiedResults = attachValidation([
    {
      cell_id: "00",
      candidate_id: "candidate:00",
      complete: true,
      primary_score: 1,
      hard_constraints_passed: true,
      cost: 1,
      changed_module_count: 0,
    },
    {
      cell_id: "10",
      candidate_id: "candidate:Z",
      complete: true,
      primary_score: 2,
      hard_constraints_passed: true,
      cost: 2,
      changed_module_count: 1,
    },
    {
      cell_id: "01",
      candidate_id: "candidate:a",
      complete: true,
      primary_score: 2,
      hard_constraints_passed: true,
      cost: 2,
      changed_module_count: 1,
    },
    {
      cell_id: "11",
      candidate_id: "candidate:11",
      complete: true,
      primary_score: 1,
      hard_constraints_passed: true,
      cost: 3,
      changed_module_count: 2,
    },
  ]);
  const tied = selectUniqueFinalist(
    [
      { cell_id: "00", module_ids: [] },
      { cell_id: "10", module_ids: ["a"] },
      { cell_id: "01", module_ids: ["b"] },
      { cell_id: "11", module_ids: ["a", "b"] },
    ],
    tiedResults,
    {
      plan_id: "plan:v1",
      primary_direction: "higher_better",
      improvement: { policy: "relative", minimum_gain: 0.01 },
      binding,
      review: reviewFor(tiedResults),
    },
  );
  assert.equal(tied.selected_candidate_id, "candidate:Z");
  expectCode(
    () =>
      selectUniqueFinalist(
        plan,
        results.map((result) =>
          result.cell_id === "10" ? { ...result, changed_module_count: 2 } : result,
        ),
        {
          plan_id: "plan:v1",
          primary_direction: "higher_better",
          improvement: { policy: "relative", minimum_gain: 0.01 },
          binding,
          review: reviewFor(results),
        },
      ),
    "VALIDATION_INCOMPLETE",
  );
});

test("两臂一起伪造 tester version 或 manifest 不能通过 promotion gate", () => {
  const fixed = tester();
  const current = setup(fixed);
  const baseline = arm(current, "matching_baseline", 0.5, {
    tester_version: "tester:fake",
    case_manifest_sha256: HASH_C,
    seed_manifest_sha256: HASH_D,
  });
  const finalist = arm(current, "finalist", 0.6, {
    tester_version: "tester:fake",
    case_manifest_sha256: HASH_C,
    seed_manifest_sha256: HASH_D,
  });
  const result = evaluatePromotionGate({
    definition: fixed,
    baseline,
    finalist,
    workflow_constraints_passed: true,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason_codes.includes("tester_version_mismatch"), true);
  assert.equal(result.reason_codes.includes("case_manifest_mismatch"), true);
});

test("一个 trial 只绑定一个 tester run，同 run 重试幂等并同步 dashboard", () => {
  const root = tempDir();
  try {
    const current = setup();
    saveTesterDefinition(root, current.tester);
    reserve(root, current);
    const first = start(root, current, "tester-run-1");
    const replay = start(root, current, "tester-run-1");
    assert.deepEqual(replay, first);
    expectCode(() => start(root, current, "tester-run-2"), "TESTER_ONCE_PER_WAVE");
    recordTesterStarted(root, "tester-run-1");
    const dashboard = JSON.parse(
      fs.readFileSync(testerDashboardPath(root, "tester-run-1"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(dashboard.status, "running");
    assert.equal(dashboard.phase, "running");
    assert.equal(JSON.stringify(dashboard).includes("case:1"), false);
    assert.equal(JSON.stringify(dashboard).includes("tester_score"), false);
    assert.equal(JSON.stringify(dashboard).includes("test-result.ref"), false);
    const ledger = readTesterTrialLedger(root, current.taskId,);
    assert.equal(
      ledger.test_trials.filter((trial) => trial.tester_run_id === "tester-run-1").length,
      1,
    );
  } finally {
    cleanup(root);
  }
});

test("基础设施重试保持请求语义和同一trial，结果ref缺失时可恢复", () => {
  const root = tempDir();
  try {
    const current = setup();
    saveTesterDefinition(root, current.tester);
    reserve(root, current);
    start(root, current);
    recordTesterStarted(root, "tester-run-1");
    retryTesterInfrastructure(root, "tester-run-1", "same", "same");
    const resumed = recordTesterStarted(root, "tester-run-1");
    assert.equal(resumed.status, "running");
    assert.equal(resumed.attempt, 1);
    const before = readTesterTrialLedger(root, current.taskId,);
    const baseline = arm(current, "matching_baseline", 0.5);
    const finalist = arm(current, "finalist", 0.6);
    const testResult = {
      baseline,
      finalist,
      harness_sha256: current.tester.harness_sha256,
      workflow_constraints_passed: true,
    };
    recordTesterResult(root, "tester-run-1", testResult);
    fs.rmSync(path.join(root, ".aris", "runs", "tester-run-1", "test-result.ref.json"));
    const sealed = recordTesterResult(root, "tester-run-1", testResult);
    assert.equal(sealed.status, "sealed");
    const after = readTesterTrialLedger(root, current.taskId,);
    assert.equal(after.test_trials.length, before.test_trials.length);
    assert.equal(
      fs.existsSync(path.join(root, ".aris", "runs", "tester-run-1", "test-result.ref.json")),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("trial记录跨setup保留，新的评测不受旧exposure限额约束", () => {
  const root = tempDir();
  try {
    const first = setup(tester("tester:v1"), "promotion:1", "outer-1", "wave-1");
    saveTesterDefinition(root, first.tester);
    reserve(root, first);
    releaseTesterTrial(root, first.taskId, first.trialId, "failed_irrecoverable");

    const second = setup(tester("tester:v2"), "promotion:2", "outer-2", "wave-2");
    saveTesterDefinition(root, second.tester);
    reserve(root, second);
    start(root, second, "tester-run-2");
    recordTesterStarted(root, "tester-run-2");
    recordTesterResult(root, "tester-run-2", {
      baseline: arm(second, "matching_baseline", 0.5),
      finalist: arm(second, "finalist", 0.6),
      harness_sha256: second.tester.harness_sha256,
      workflow_constraints_passed: true,
    });
    const ledger = readTesterTrialLedger(root, first.taskId);
    assert.equal(ledger.test_trials.filter((trial) => trial.status === "released").length, 1);
    assert.equal(ledger.test_trials.filter((trial) => trial.status === "settled").length, 1);
    reserve(root, {...second,trialId:"promotion:3",outerRunId:"outer-3",waveId:"wave:3"});
    assert.equal(readTesterTrialLedger(root,first.taskId).test_trials.length,3);

  } finally {
    cleanup(root);
  }
});

test("冻结 gate 绑定两臂、run 和 reservation，不能把另一套 input 或 model assignment 偷换进来", () => {
  const root = tempDir();
  try {
    const current = setup();
    const { baseline, finalist } = readyRun(root, current);
    const wrongInput = { ...finalist, input_distribution_sha256: HASH_A };
    expectCode(
      () =>
        consumePromotionGate({
          project_root: root,
          tester_run_id: "tester-run-1",
          definition: current.tester,
          baseline,
          finalist: wrongInput,
          workflow_constraints_passed: true,
        }),
      "TESTER_ARMS_MISMATCH",
    );
    const wrongModel = { ...finalist, model_assignment_sha256: HASH_A };
    expectCode(
      () =>
        consumePromotionGate({
          project_root: root,
          tester_run_id: "tester-run-1",
          definition: current.tester,
          baseline,
          finalist: wrongModel,
          workflow_constraints_passed: true,
        }),
      "TESTER_ARMS_MISMATCH",
    );
    assert.equal(readTesterRunState(root, "tester-run-1").status, "reviewed");
  } finally {
    cleanup(root);
  }
});

test("state 已进入终态但账本尚未 settle 时，同结果重试补结算；不同结果拒绝", () => {
  const root = tempDir();
  try {
    const current = setup();
    const { baseline, finalist } = readyRun(root, current);
    const passed = consumePromotionGate({
      project_root: root,
      tester_run_id: "tester-run-1",
      definition: current.tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    });
    assert.equal(passed.status, "passed");
    const ledgerPath = testerTrialLedgerPath(root, current.taskId);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      test_trials: Array<Record<string, unknown>>;
    };
    ledger.test_trials[0]!.status = "reserved";
    ledger.test_trials[0]!.tester_started = false;
    ledger.test_trials[0]!.test_result_sha256 = null;
    ledger.test_trials[0]!.feedback_event_id = null;
    ledger.test_trials[0]!.settled_at = null;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const replay = consumePromotionGate({
      project_root: root,
      tester_run_id: "tester-run-1",
      definition: current.tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    });
    assert.equal(replay.status, "passed");
    assert.equal(
      readTesterTrialLedger(root, current.taskId,).test_trials[0]!
        .status,
      "settled",
    );
    expectCode(
      () =>
        consumePromotionGate({
          project_root: root,
          tester_run_id: "tester-run-1",
          definition: current.tester,
          baseline,
          finalist: { ...finalist, metrics: { tester_score: 0.4 } },
          workflow_constraints_passed: true,
        }),
      "TESTER_GATE_CONFLICT",
    );
  } finally {
    cleanup(root);
  }
});

test("反馈schema验证与明确建议，发布和账本事件可幂等恢复", () => {
  const root = tempDir();
  try {
    const current = setup();
    const { baseline, finalist } = readyRun(root, current);
    const gate = consumePromotionGate({
      project_root: root,
      tester_run_id: "tester-run-1",
      definition: current.tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    });
    assert.equal(gate.status, "passed");
    const feedback = buildTesterFeedback({
      schema_version: 1,
      task_id: current.taskId,
      task_setup_revision: "setup:v1",
      input_snapshot_sha256: HASH_E,
      promotion_trial_id: current.trialId,
      tester_version: current.tester.version,
      conclusion: "improved",
      directions: ["long_horizon_stability"],
      advice: ["increase_long_horizon_consistency"],
      confidence: "high",
      metrics: { tester_score: 0.9 },
    });
    expectCode(
      () => sanitizeTesterFeedback({ ...feedback, caseId: "case:secret" }),
      "UNKNOWN_FIELD",
    );
    expectCode(
      () => sanitizeTesterFeedback({ ...feedback, exact_sample: "secret" }),
      "UNKNOWN_FIELD",
    );
    expectCode(
      () =>
        publishTesterFeedback({
          project_root: root,
          tester_run_id: "tester-run-1",
          actor: "tester_worker",
          feedback,
        }),
      "WRITE_SCOPE_FORBIDDEN",
    );
    const published = publishTesterFeedback({
      project_root: root,
      tester_run_id: "tester-run-1",
      actor: "outer_committer",
      feedback,
    });
    const replay = publishTesterFeedback({
      project_root: root,
      tester_run_id: "tester-run-1",
      actor: "outer_committer",
      feedback,
    });
    assert.equal(replay.feedback_event_id, published.feedback_event_id);
    assert.equal(
      readTesterTrialLedger(root, current.taskId,).test_trials[0]!
        .status,
      "settled",
    );
  } finally {
    cleanup(root);
  }
});

test("审核后调用方替换 arm 分数，gate 只信任封存 bundle", () => {
  const root = tempDir();
  try {
    const current = setup();
    const { baseline, finalist } = readyRun(root, current);
    expectCode(
      () =>
        consumePromotionGate({
          project_root: root,
          tester_run_id: "tester-run-1",
          definition: current.tester,
          baseline,
          finalist: { ...finalist, metrics: { tester_score: 0.9 } },
          workflow_constraints_passed: true,
        }),
      "TESTER_ARMS_MISMATCH",
    );
    const resultPath = testerResultPath(root, "tester-run-1");
    const testResult = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<
      string,
      unknown
    >;
    const storedFinalist = testResult.finalist as Record<string, unknown>;
    (storedFinalist.metrics as Record<string, number>).tester_score = 0.9;
    fs.writeFileSync(resultPath, `${JSON.stringify(testResult, null, 2)}\n`);
    expectCode(
      () =>
        consumePromotionGate({
          project_root: root,
          tester_run_id: "tester-run-1",
          definition: current.tester,
          baseline,
          finalist,
          workflow_constraints_passed: true,
        }),
      "TEST_RESULT_HASH_MISMATCH",
    );
  } finally {
    cleanup(root);
  }
});

test("arm 指标与 observation 均值分叉或 model assignment hash 缺失不能封存", () => {
  const root = tempDir();
  try {
    const current = setup();
    const sealed = sealedRun(root, current);
    // An arm's reported metrics are the means of its own observations, so a
    // value that does not come back out of the observations is a fork.
    expectCode(
      () =>
        recordTesterResult(root, "tester-run-1", {
          ...sealed.testResult,
          baseline: { ...sealed.baseline, metrics: { tester_score: 0.9 } },
        }),
      "AGGREGATE_MISMATCH",
    );
    // Every declared metric has to be reported: the gate is conjunctive, so a
    // missing one is not a partial result it could still rule on.
    expectCode(
      () =>
        recordTesterResult(root, "tester-run-1", {
          ...sealed.testResult,
          baseline: {
            ...sealed.baseline,
            metrics: {},
            observations: sealed.baseline.observations.map((observation) => ({
              ...observation,
              metrics: {},
            })),
          },
        }),
      "MISSING_PRIMARY_METRIC",
    );
    const { model_assignment_sha256: ignoredHash, ...missingModel } = sealed.finalist;
    void ignoredHash;
    expectCode(
      () =>
        recordTesterResult(root, "tester-run-1", {
          ...sealed.testResult,
          finalist: missingModel,
        }),
      "MODEL_ASSIGNMENT_REQUIRED",
    );
  } finally {
    cleanup(root);
  }
});

test("deterministic tester 禁止 judge，LLM tester 在 reservation 时拒绝缺失或过新的 judge", () => {
  const deterministic = deterministicTester();
  const deterministicSetup = setup(deterministic, "promotion:det", "outer-det", "wave-det");
  const deterministicRoot = tempDir();
  try {
    saveTesterDefinition(deterministicRoot, deterministic);
    expectCode(
      () =>
        reserve(deterministicRoot, {
          ...deterministicSetup,
          judgeBinding: buildTesterJudgeBinding({
            artifact_id: "artifact:judge",
            artifact_sha256: HASH_A,
            source: "previous_promoted",
            generation: 1,
            target_generation: 2,
            task_setup_revision: deterministicSetup.taskSetupRevision,
            source_incumbent_id: "candidate:incumbent",
          }),
          judgeBindingId: "wrong",
        }),
      "JUDGE_BINDING_FORBIDDEN",
    );
  } finally {
    cleanup(deterministicRoot);
  }

  const missingRoot = tempDir();
  try {
    const current = setup();
    saveTesterDefinition(missingRoot, current.tester);
    expectCode(
      () => reserve(missingRoot, { ...current, judgeBinding: null, judgeBindingId: null }),
      "JUDGE_BINDING_REQUIRED",
    );
    const newJudge = { ...current.judgeBinding!, generation: 2 };
    expectCode(
      () =>
        reserve(missingRoot, {
          ...current,
          judgeBinding: newJudge,
          judgeBindingId: newJudge.binding_id,
        }),
      "JUDGE_LAG_VIOLATION",
    );
  } finally {
    cleanup(missingRoot);
  }
});

test("输入分布在 reservation 封存，start 不能成为第一个补写者", () => {
  const root = tempDir();
  try {
    const current = setup();
    saveTesterDefinition(root, current.tester);
    reserve(root, current);
    createChildContract(root, current.outerRunId, "tester-run-1", "tester");
    expectCode(
      () =>
        startTesterRun({
          project_root: root,
          tester_run_id: "tester-run-1",
          task_id: current.taskId,
          outer_run_id: current.outerRunId,
          outer_iteration: 1,
          wave_id: current.waveId,
          wave_kind: "module",
          generation: 1,
          promotion_trial_id: current.trialId,
          tester: current.tester,
          task_setup_revision: current.taskSetupRevision,
          input_snapshot_sha256: HASH_E,
          harness_sha256: current.tester.harness_sha256,
          matching_baseline_artifact_sha256: HASH_C,
          finalist_artifact_sha256: HASH_D,
          model_assignment_sha256: current.modelAssignmentSha256,
          input_distribution_sha256: HASH_A,
          judge_binding: current.judgeBinding,
        }),
      "IDENTITY_MISMATCH",
    );
  } finally {
    cleanup(root);
  }
});

test("终态同语义重试返回同一 gate 结果，bundle 变化返回冲突", () => {
  const root = tempDir();
  try {
    const current = setup();
    const { baseline, finalist } = readyRun(root, current);
    const first = consumePromotionGate({
      project_root: root,
      tester_run_id: "tester-run-1",
      definition: current.tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    });
    const second = consumePromotionGate({
      project_root: root,
      tester_run_id: "tester-run-1",
      definition: current.tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    });
    assert.deepEqual(second, first);
    const changed = { ...finalist, metrics: { tester_score: 0.4 } };
    expectCode(
      () =>
        consumePromotionGate({
          project_root: root,
          tester_run_id: "tester-run-1",
          definition: current.tester,
          baseline,
          finalist: changed,
          workflow_constraints_passed: true,
        }),
      "TESTER_GATE_CONFLICT",
    );
  } finally {
    cleanup(root);
  }
});

test("tester review 重新读取 assignment、evidence 和 command index，任一篡改都拒绝", () => {
  const evidenceRoot = tempDir();
  try {
    const current = setup();
    sealedRun(evidenceRoot, current);
    const review = writeTesterReview(evidenceRoot, current, "tester-run-1");
    fs.appendFileSync(
      path.join(
        evidenceRoot,
        ".aris",
        "runs",
        "tester-run-1",
        "workers",
        "tester-worker",
        "outputs",
        "evidence.json",
      ),
      "tampered\n",
    );
    expectCode(
      () => recordTesterReview(evidenceRoot, "tester-run-1", review),
      "EVIDENCE_HASH_MISMATCH",
    );
  } finally {
    cleanup(evidenceRoot);
  }

  const indexRoot = tempDir();
  try {
    const current = setup();
    sealedRun(indexRoot, current);
    const review = writeTesterReview(indexRoot, current, "tester-run-1");
    const indexPath = reviewCommandIndexPath(indexRoot, review.command_id);
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    index.receipt_sha256 = HASH_A;
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    expectCode(
      () => recordTesterReview(indexRoot, "tester-run-1", review),
      "REVIEW_RECEIPT_CONFLICT",
    );
  } finally {
    cleanup(indexRoot);
  }
});

test("反馈文件已落盘但账本未结算时恢复只补事件和结算一次", () => {
  const root = tempDir();
  try {
    const current = setup();
    const { baseline, finalist } = readyRun(root, current);
    consumePromotionGate({
      project_root: root,
      tester_run_id: "tester-run-1",
      definition: current.tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    });
    const ledgerPath = testerTrialLedgerPath(root, current.taskId);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      test_trials: Array<Record<string, unknown>>;
    };
    ledger.test_trials[0]!.status = "reserved";
    ledger.test_trials[0]!.tester_started = false;
    ledger.test_trials[0]!.test_result_sha256 = null;
    ledger.test_trials[0]!.feedback_event_id = null;
    ledger.test_trials[0]!.settled_at = null;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const feedback = buildTesterFeedback({
      schema_version: 1,
      task_id: current.taskId,
      task_setup_revision: current.taskSetupRevision,
      input_snapshot_sha256: HASH_E,
      promotion_trial_id: current.trialId,
      tester_version: current.tester.version,
      conclusion: "improved",
      directions: ["long_horizon_stability"],
      advice: ["increase_long_horizon_consistency"],
      confidence: "high",
      metrics: { tester_score: 0.9 },
    });
    fs.mkdirSync(path.dirname(testerFeedbackPath(root, "tester-run-1")), { recursive: true });
    fs.writeFileSync(
      testerFeedbackPath(root, "tester-run-1"),
      `${JSON.stringify(feedback, null, 2)}\n`,
    );
    const published = publishTesterFeedback({
      project_root: root,
      tester_run_id: "tester-run-1",
      actor: "outer_committer",
      feedback,
    });
    const replay = publishTesterFeedback({
      project_root: root,
      tester_run_id: "tester-run-1",
      actor: "outer_committer",
      feedback,
    });
    assert.equal(replay.feedback_event_id, published.feedback_event_id);
    const settled = readTesterTrialLedger(root, current.taskId,);
    assert.equal(settled.test_trials[0]!.status, "settled");
    assert.equal(settled.test_trials[0]!.feedback_event_id, feedback.feedback_event_id);
  } finally {
    cleanup(root);
  }
});

test("纯 gate 与封存路径使用同一 arm 规范，代码 tester 不接受 judge", () => {
  const deterministic = deterministicTester();
  const deterministicSetup = setup(deterministic);
  const baseline = arm(deterministicSetup, "matching_baseline", 0.5);
  const finalist = arm(deterministicSetup, "finalist", 0.6);
  expectCode(
    () =>
      evaluatePromotionGate({
        definition: deterministic,
        baseline: { ...baseline, case_ids: [] },
        finalist,
        workflow_constraints_passed: true,
      }),
    "INVALID_TESTER_RESULT",
  );
  expectCode(
    () =>
      evaluatePromotionGate({
        definition: deterministic,
        baseline: { ...baseline, judge_binding_id: "judge:unexpected" },
        finalist: { ...finalist, judge_binding_id: "judge:unexpected" },
        workflow_constraints_passed: true,
      }),
    "JUDGE_BINDING_FORBIDDEN",
  );
  expectCode(
    () =>
      evaluatePromotionGate({
        definition: deterministic,
        baseline: { ...baseline, judge_binding_id: null, model_assignment_sha256: null as never },
        finalist,
        workflow_constraints_passed: true,
      }),
    "MODEL_ASSIGNMENT_REQUIRED",
  );

  const llmSetup = setup();
  const llmBaseline = arm(llmSetup, "matching_baseline", 0.5, { judge_binding_id: null });
  const llmFinalist = arm(llmSetup, "finalist", 0.6, { judge_binding_id: null });
  expectCode(
    () =>
      evaluatePromotionGate({
        definition: llmSetup.tester,
        baseline: llmBaseline,
        finalist: llmFinalist,
        workflow_constraints_passed: true,
      }),
    "JUDGE_BINDING_REQUIRED",
  );
});

test("测试结果的 case manifest id 也必须来自封存 tester", () => {
  const root = tempDir();
  try {
    const current = setup();
    const sealed = sealedRun(root, current);
    expectCode(
      () =>
        recordTesterResult(root, "tester-run-1", {
          ...sealed.testResult,
          case_manifest: {
            case_manifest_id: "cases:other",
            case_manifest_sha256: current.tester.case_manifest_sha256,
            seed_manifest_sha256: current.tester.seed_manifest_sha256,
          },
        }),
      "IDENTITY_MISMATCH",
    );
  } finally {
    cleanup(root);
  }
});

test("tester 一旦真正启动就记录trial执行，不能再释放", () => {
  const root = tempDir();
  try {
    const current = setup();
    saveTesterDefinition(root, current.tester);
    reserve(root, current);
    start(root, current);
    recordTesterStarted(root, "tester-run-1");
    assert.equal(
      readTesterTrialLedger(root, current.taskId,).test_trials[0]
        ?.status,
      "settled",
    );
    expectCode(
      () =>
        releaseTesterTrial(
          root,
          current.taskId,
          current.trialId,
          "failed_irrecoverable",
        ),
      "TESTER_TRIAL_TERMINAL",
    );
  } finally {
    cleanup(root);
  }
});

test("tester设施可使用普通子任务部署和执行benchmark",()=>{
 const root=tempDir();try {
  const current=setup(deterministicTester());saveTesterDefinition(root,current.tester);reserve(root,current);
  createChildContract(root,current.outerRunId,"tester-with-child","tester",true);
  start(root,current,"tester-with-child");
  createChildContract(root,"tester-with-child","benchmark-worker","benchmark");
  recordTesterStarted(root,"tester-with-child");
  assert.equal(readTesterRunState(root,"tester-with-child").status,"running");
 } finally {cleanup(root);}
});

let passed = 0;
for (const current of tests) {
  try {
    current.fn();
    passed += 1;
    console.log(`ok - ${current.name}`);
  } catch (error: unknown) {
    console.error(`not ok - ${current.name}`);
    throw error;
  }
}
console.log(`A1 tester tests passed: ${passed}`);
