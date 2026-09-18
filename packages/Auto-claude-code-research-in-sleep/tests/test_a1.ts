import { makePromotionFixture } from "./helpers/promotion-fixture.js";
import { adoptCurrentRunScopeLease, createRootRun } from "../src/tools/run-contract.js";
import { createChildContract } from "./helpers/child-contract.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import {
  createArtifactRegistry,
  crossCheckArtifactIdentity,
  assertNoSelfEvaluationByLineage,
} from "../src/tools/artifact-registry.js";
import {
  buildAblationPlan,
  candidateIdFromSnapshot,
  compileWorkflow,
  assertParallelModuleSet,
} from "../src/tools/workflow-compiler.js";
import {
  buildTesterJudgeBinding,
  buildTesterDefinition,
  markTesterStarted,
  readExposureLedger,
  recordTesterPrivateResult,
  recoverExposureLedger,
  recordTesterReview,
  recordTesterStarted,
  recordTesterFeedbackEvent,
  reservePromotionTrial as reserveStoredPromotionTrial,
  releaseExposure,
  saveTesterDefinition,
  sealPrivateTesterResult,
  settleExposure,
  startTesterRun,
  type ExposureRecord,
  type TesterDefinition,
} from "../src/tools/tester-state.js";
import {
  consumePromotionGate,
  evaluatePromotionGate,
  selectUniqueFinalist,
} from "../src/tools/promotion-gate.js";
import {
  validationBindingSha256,
  validationEvidenceSetSha256,
} from "../src/tools/validation-gate.js";
import {
  buildTesterFeedback,
  publishTesterFeedback,
  sanitizeTesterFeedback,
} from "../src/tools/tester-feedback.js";
import { createReviewAssignment, submitReviewReceipt } from "../src/tools/review-submit.js";
import { createTaskSetup, saveTaskSetup } from "../src/tools/task-setup.js";
import {
  assertAssignmentLineageSafe,
  resolveModelAssignment,
  saveModelAssignment,
} from "../src/tools/model-assignment.js";
import {
  createWorkflowDashboard,
  frozenPolicyFingerprint,
  readFrozenPolicy,
  saveCycleWikiHead,
  saveFrozenPolicy,
  updateWorkflowDashboard,
} from "../src/tools/workflow-state.js";
import {
  computeCoverageDelta,
  materializeCoverageMap,
  validateCoverageMap,
} from "../src/tools/scorer-coverage.js";
import {
  materializeScorerRevision,
  saveImmutableScorerDelta,
  saveImmutableScorerRevision,
  validateScorerDelta,
  validateScorerRevision,
  type ScorerRevision,
} from "../src/tools/scorer-definition.js";
import {
  materializeSharedProbe,
  runStandaloneScorerComparison,
} from "../src/tools/scorer-experiment.js";
import {
  assertWaveKindExclusive,
  beginOrdinaryWave,
  finishOrdinaryWave,
  finishScorerWave,
  saveScorerWaveRegistration,
  startScorerRun,
} from "../src/tools/scorer-state.js";
import {
  validateWorkflowSpec,
  type OwnerLimits,
  type WorkflowSpec,
} from "../src/tools/workflow-spec.js";

const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a1-test-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function policy(): Record<string, unknown> {
  return {
    revision: "policy:r1",
    approval_id: "approval:roles",
    roles: [
      {
        role_id: "main-model",
        allowed_modules: ["a", "b", "c", "d"],
        allowed_uses: ["generate", "train"],
        judge_targets: [],
        judge_generation_lag: null,
        artifact_binding: "previous_promoted",
        promotion_output: "main.model",
        user_confirmed: true,
        approval_id: "approval:main",
      },
      {
        role_id: "main-judge",
        allowed_modules: ["validation-scorer", "promotion-tester"],
        allowed_uses: ["judge"],
        judge_targets: ["main-model.next"],
        judge_generation_lag: 1,
        artifact_binding: {
          source: "previous_promoted",
          source_role: "main-model",
          artifact_id: null,
        },
        promotion_output: null,
        user_confirmed: true,
        approval_id: "approval:judge",
      },
    ],
  };
}

function moduleSpec(
  id: string,
  input: string,
  output: string,
  scope: string,
): Record<string, unknown> {
  return {
    id,
    evolvable: true,
    inputs: input === "" ? [] : [input],
    outputs: [output],
    write_scope: [scope],
    local_metric: `${id}_score`,
    execution: {
      max_jobs: 1,
      max_compute: { amount: 1, unit: "gpu_hours" },
    },
  };
}

function rawSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "task:model-factory",
    workflow_id: "workflow:model-factory",
    revision: "flow:r1",
    objective: {
      primary: { name: "tester_score", direction: "higher_better" },
      constraints: [],
    },
    task_setup_revision: "setup:r1",
    model_usage_policy: policy(),
    validation_policy: {
      scorer_id: "rule-checker",
      scorer_revision_binding: "from_active_scorer_pointer",
      research_feedback: "detailed",
      cross_judge_score_comparison: "forbidden",
    },
    scorers: [
      {
        id: "rule-checker",
        kind: "deterministic_rules",
        definition_binding: "from_active_scorer_revision",
        judge_binding: null,
      },
      {
        id: "quality-judge",
        kind: "llm_rubric",
        definition_binding: "from_active_scorer_revision",
        judge_binding: "from_model_usage_policy",
      },
    ],
    promotion_tester: {
      tester_id: "tester:final",
      definition_version: "tester:v1",
      research_feedback: "fuzzy_advice_only",
      max_exposures_per_task: 4,
    },
    wave_policy: {
      max_parallel_modules: 2,
      dependent_modules: "sequential",
      ablation_design: "full_factorial",
    },
    structure_wave_policy: {
      exclusive: true,
      max_candidates: 1,
      module_versions: "frozen",
    },
    scorer_wave_policy: {
      exclusive: true,
      max_candidates: 1,
      experiment_parallelism: 1,
      execution_order: "baseline_then_candidate",
      blocks_other_wave_kinds: true,
    },
    owner_limits: {
      revision: "limits:r1",
      max_nodes: 20,
      max_edges: 20,
      max_fan_out_per_node: 4,
      max_unrolled_cycles: 2,
      max_jobs_per_candidate: 20,
      max_compute_per_candidate: { amount: 20, unit: "gpu_hours" },
    },
    enabled_module_ids: ["a", "b", "c", "d"],
    modules: [
      moduleSpec("a", "", "a@1", "src/a/**"),
      moduleSpec("b", "a@1", "b@1", "src/b/**"),
      moduleSpec("c", "b@1", "c@1", "src/c/**"),
      moduleSpec("d", "", "d@1", "src/d/**"),
    ],
    edges: [
      { from: "a.out", to: "b.in", contract: "a@1" },
      { from: "b.out", to: "c.in", contract: "b@1" },
    ],
    feedback_edges: [
      { from: "evaluation.error_profile", to: "a.feedback", barrier: "next_outer_iteration" },
    ],
    cycles: [],
    ...overrides,
  };
}

function validSpec(): WorkflowSpec {
  return validateWorkflowSpec(rawSpec());
}

function candidateSnapshot(): Record<string, unknown> {
  return {
    schema_version: 1,
    workflow_revision: "flow:r1",
    parent_candidate_id: null,
    module_versions: [
      {
        module_id: "b",
        version: "b:v1",
        patch_sha256: HASH_B,
        input_artifact_ids: ["artifact:a"],
        code_paths: ["src/b.ts", "src/b/config.json"],
      },
      {
        module_id: "a",
        version: "a:v1",
        patch_sha256: HASH,
        input_artifact_ids: ["artifact:seed"],
        code_paths: ["src/a.ts"],
      },
    ],
    input_artifact_ids: ["artifact:b", "artifact:a"],
    model_assignments: [
      {
        role_id: "main-judge",
        module_ids: ["validation-scorer"],
        uses: ["judge"],
        artifact_id: "artifact:judge-v1",
        judge_targets: ["main-model.next"],
        resolved_from: "previous_promoted",
        generation: 1,
      },
      {
        role_id: "main-model",
        module_ids: ["a", "b"],
        uses: ["train", "generate"],
        artifact_id: "artifact:main-v1",
        judge_targets: [],
        resolved_from: "previous_promoted",
        generation: 1,
      },
    ],
    finite_cycles: 1,
    random_seed: "seed-1",
    owner_limits: validSpec().owner_limits,
    execution_graph: {
      nodes: [
        { module_id: "a", version: "a:v1", input_ports: [], output_ports: [] },
        { module_id: "b", version: "b:v1", input_ports: [], output_ports: [] },
      ],
      edges: [],
      feedback_edges: [],
    },
    patch_paths: ["src/b.ts", "src/a.ts"],
    run_id: "run-a",
    attempt_id: "attempt-1",
    wave_id: "wave-1",
    status: "running",
    output_artifact_ids: ["artifact:output"],
    scorer_revision: "scorer:r1",
    judge_binding_id: "judge-binding:r1",
    tester_result_id: "tester-result:r1",
    receipt_id: "receipt:r1",
    created_at: "2026-09-07T00:00:00Z",
  };
}

function rootCoverage(id: string, parent: string | null): Record<string, unknown> {
  return {
    schema_version: 1,
    coverage_map_id: id,
    parent_coverage_map_id: parent,
    dimensions: [
      {
        dimension_id: "difficulty",
        source: "scorer_discovered",
        values: ["basic", "stress"],
        ordered_values: ["basic", "stress"],
      },
    ],
    coverage_cells: [
      {
        coverage_cell_id: "cell:basic",
        coordinates: { difficulty: "basic" },
        benchmark_item_refs: ["benchmark:basic@1"],
        evidence_refs: ["evidence:basic"],
      },
    ],
    delta_summary: {
      added_cells: [],
      deepened_relations: [],
      superseded_items: [],
      retired_invalid_items: [],
    },
  };
}

function baseScorer(): ScorerRevision {
  const coverage = validateCoverageMap(rootCoverage("coverage:r1", null));
  const base = {
    schema_version: 1 as const,
    scorer_id: "scorer:validation",
    revision: "scorer:r1",
    parent_revision: null,
    benchmark_items: [
      {
        benchmark_id: "benchmark:basic@1",
        content_hash: HASH,
        status: "active" as const,
        generator_id: null,
        supersedes: null,
        evidence_refs: ["evidence:basic"],
      },
    ],
    scoring_rules: [
      {
        rule_id: "rule:quality",
        kind: "deterministic_rule" as const,
        content_hash: HASH_B,
        active: true,
        deleted_in_revision: null,
      },
    ],
    coverage_map: coverage,
  };
  return {
    ...base,
    coverage_map_sha256: canonicalJsonSha256(coverage, undefined, {
      schemaVersion: "coverage-map-v1",
    }),
    definition_sha256: canonicalJsonSha256(
      {
        schema_version: 1,
        scorer_id: base.scorer_id,
        parent_revision: base.parent_revision,
        benchmark_items: base.benchmark_items,
        scoring_rules: base.scoring_rules,
        coverage_map: base.coverage_map,
      },
      undefined,
      { schemaVersion: "scorer-revision-v1" },
    ),
  };
}

function testerDefinition(): TesterDefinition {
  return buildTesterDefinition({
    schema_version: 1,
    tester_id: "tester:final",
    version: "tester:v1",
    immutable: true,
    case_manifest_id: "cases:v1",
    case_manifest_sha256: HASH,
    seed_manifest_sha256: HASH_B,
    harness_sha256: HASH_C,
    research_feedback: "fuzzy_advice_only",
    max_exposures_per_task: 4,
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

function testerJudgeBinding() {
  return buildTesterJudgeBinding({
    artifact_id: "artifact:judge-v1",
    artifact_sha256: HASH_C,
    source: "previous_promoted",
    generation: 0,
    target_generation: 1,
    task_setup_revision: "setup:r1",
    source_incumbent_id: "candidate:incumbent",
  });
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

test("workflow入口拒绝未知字段、普通环和非法跨轮边", () => {
  assert.doesNotThrow(() => validSpec());
  expectCode(() => validateWorkflowSpec({ ...rawSpec(), unexpected: true }), "UNKNOWN_FIELD");
  const cyclic = rawSpec({
    modules: [moduleSpec("a", "b@1", "a@1", "src/a/**"), moduleSpec("b", "a@1", "b@1", "src/b/**")],
    enabled_module_ids: ["a", "b"],
    edges: [
      { from: "a.out", to: "b.in", contract: "a@1" },
      { from: "b.out", to: "a.in", contract: "b@1" },
    ],
  });
  expectCode(() => validateWorkflowSpec(cyclic), "WORKFLOW_CYCLE");
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({ feedback_edges: [{ from: "a.x", to: "b.y", barrier: "same_iteration" }] }),
      ),
    "INVALID_FEEDBACK_EDGE",
  );
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({ edges: [{ from: "a.out", to: "b.in", contract: "wrong@1" }] }),
      ),
    "CONTRACT_MISMATCH",
  );
});

test("workflow入口只接受1或2个并行模块并且保留传递依赖", () => {
  const spec = validSpec();
  assert.deepEqual(buildAblationPlan(spec, ["a"]), [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: ["a"] },
  ]);
  assert.deepEqual(
    buildAblationPlan(spec, ["a", "d"]).map((cell) => cell.cell_id),
    ["00", "10", "01", "11"],
  );
  assert.doesNotThrow(() => assertParallelModuleSet(spec, ["a", "d"]));
  expectCode(() => assertParallelModuleSet(spec, ["a", "c"]), "MODULE_DEPENDENCY_CONFLICT");
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({
          wave_policy: {
            max_parallel_modules: 3,
            dependent_modules: "sequential",
            ablation_design: "full_factorial",
          },
        }),
      ),
    "INVALID_WAVE_POLICY",
  );
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({
          wave_policy: {
            max_parallel_modules: 0,
            dependent_modules: "sequential",
            ablation_design: "full_factorial",
          },
        }),
      ),
    "INVALID_WAVE_POLICY",
  );
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({
          wave_policy: {
            max_parallel_modules: "2",
            dependent_modules: "sequential",
            ablation_design: "full_factorial",
          },
        }),
      ),
    "INVALID_WAVE_POLICY",
  );
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({
          wave_policy: { dependent_modules: "sequential", ablation_design: "full_factorial" },
        }),
      ),
    "INVALID_WAVE_POLICY",
  );
});

test("compiler在花费资源前执行owner limits并拒绝修改限制", () => {
  const spec = validSpec();
  const compiled = compileWorkflow(spec, { wave_kind: "module", unrolled_cycles: 1 });
  assert.equal(compiled.summary.worst_case_jobs, 8);
  expectCode(
    () =>
      compileWorkflow(
        validateWorkflowSpec(rawSpec({ owner_limits: { ...spec.owner_limits, max_nodes: 1 } })),
      ),
    "rejected_limit",
  );
  expectCode(
    () =>
      compileWorkflow(
        validateWorkflowSpec(
          rawSpec({
            owner_limits: {
              ...spec.owner_limits,
              max_compute_per_candidate: { amount: 0, unit: "gpu_hours" },
            },
          }),
        ),
      ),
    "rejected_limit",
  );
});

test("candidate身份只包含生产语义，不包含运行和评价状态", () => {
  const first = candidateSnapshot();
  const second = {
    ...first,
    run_id: "run-b",
    attempt_id: "attempt-9",
    wave_id: "wave-9",
    status: "failed",
    output_artifact_ids: ["artifact:other"],
    scorer_revision: "scorer:r9",
    judge_binding_id: "judge:r9",
    tester_result_id: "tester:r9",
    receipt_id: "receipt:r9",
    created_at: "2027-01-01T00:00:00Z",
  };
  assert.equal(candidateIdFromSnapshot(first), candidateIdFromSnapshot(second));
  const reordered = {
    ...first,
    input_artifact_ids: ["artifact:a", "artifact:b"],
    patch_paths: ["src/a.ts", "src/b.ts"],
    module_versions: [...(first.module_versions as unknown[]).reverse()],
    model_assignments: [...(first.model_assignments as unknown[]).reverse()],
  };
  assert.equal(candidateIdFromSnapshot(first), candidateIdFromSnapshot(reordered));
  const changedProduction = {
    ...first,
    model_assignments: (first.model_assignments as Record<string, unknown>[]).map((assignment) =>
      assignment.role_id === "main-model"
        ? { ...assignment, artifact_id: "artifact:main-v2" }
        : assignment,
    ),
  };
  assert.notEqual(candidateIdFromSnapshot(first), candidateIdFromSnapshot(changedProduction));
  const changedJudgeOnly = {
    ...first,
    model_assignments: (first.model_assignments as Record<string, unknown>[]).map((assignment) =>
      assignment.role_id === "main-judge"
        ? { ...assignment, artifact_id: "artifact:judge-v2" }
        : assignment,
    ),
  };
  assert.equal(candidateIdFromSnapshot(first), candidateIdFromSnapshot(changedJudgeOnly));
  expectCode(() => candidateIdFromSnapshot({ ...first, unknown: true }), "UNKNOWN_FIELD");
  expectCode(
    () => candidateIdFromSnapshot({ ...first, patch_paths: ["/absolute/path.ts"] }),
    "PATH_ESCAPE",
  );
  expectCode(
    () => candidateIdFromSnapshot({ ...first, patch_paths: ["../escape.ts"] }),
    "PATH_ESCAPE",
  );
  expectCode(
    () => candidateIdFromSnapshot({ ...first, random_seed: Number.NaN }),
    "INVALID_CANDIDATE",
  );
  expectCode(
    () => candidateIdFromSnapshot({ ...first, workflow_revision: "e\u0301" }),
    "INVALID_UNICODE",
  );
});

test("artifact registry校验哈希、路径、ID和传递自评", () => {
  const root = tempDir();
  try {
    const artifactFile = path.join(root, "artifacts", "base.bin");
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
    fs.writeFileSync(artifactFile, "base");
    createRootRun({ project_root: root, run_id: "outer-1" });
    const registry = createArtifactRegistry(root, "outer-1");
    registry.register({
      schema_version: 1,
      artifact_id: "artifact:base",
      contract: "model@1",
      uri: "artifacts/base.bin",
      file_path: "artifacts/base.bin",
      sha256: digest("base"),
      producer_module: "external",
      producer_version: "v1",
      input_artifact_ids: [],
      status: "sealed",
      generation: 0,
      source_type: "fixed_external",
    });
    const candidateFile = path.join(root, "artifacts", "candidate.bin");
    fs.writeFileSync(candidateFile, "candidate");
    registry.register({
      schema_version: 1,
      artifact_id: "artifact:candidate",
      contract: "model@1",
      uri: "artifacts/candidate.bin",
      file_path: "artifacts/candidate.bin",
      sha256: digest("candidate"),
      producer_module: "a",
      producer_version: "a:v1",
      producer_run_id: "outer-1",
      candidate_id: "candidate:a",
      input_artifact_ids: ["artifact:base"],
      status: "sealed",
      generation: 1,
      role_id: "main-model",
      output_slot: "model",
      source_type: "workflow_output",
    });
    const descendantFile = path.join(root, "artifacts", "descendant.bin");
    fs.writeFileSync(descendantFile, "descendant");
    registry.register({
      schema_version: 1,
      artifact_id: "artifact:descendant",
      contract: "judge@1",
      uri: "artifacts/descendant.bin",
      file_path: "artifacts/descendant.bin",
      sha256: digest("descendant"),
      producer_module: "judge-prep",
      producer_version: "v1",
      producer_run_id: "outer-1",
      candidate_id: "candidate:descendant",
      input_artifact_ids: ["artifact:candidate"],
      status: "sealed",
      generation: 1,
      role_id: "main-judge",
      output_slot: "judge",
      source_type: "workflow_output",
    });
    assertNoSelfEvaluationByLineage({
      registry,
      candidate_artifact_ids: ["artifact:candidate"],
      candidate_output_artifact_ids: [],
      judge_artifact_ids: ["artifact:base"],
    });
    expectCode(
      () =>
        assertNoSelfEvaluationByLineage({
          registry,
          candidate_artifact_ids: ["artifact:candidate"],
          candidate_output_artifact_ids: [],
          judge_artifact_ids: ["artifact:descendant"],
        }),
      "JUDGE_LAG_VIOLATION",
    );
    expectCode(
      () =>
        registry.register({
          schema_version: 1,
          artifact_id: "artifact:bad",
          contract: "x@1",
          uri: "/tmp/bad",
          sha256: HASH,
          producer_module: "a",
          producer_version: "v1",
          input_artifact_ids: [],
          status: "sealed",
          generation: 1,
          source_type: "fixed_external",
        }),
      "PATH_ESCAPE",
    );
    expectCode(
      () =>
        crossCheckArtifactIdentity({
          artifact_id: "artifact:a",
          directory_artifact_id: "artifact:a",
          manifest_artifact_id: "artifact:b",
          command_artifact_id: "artifact:a",
        }),
      "IDENTITY_MISMATCH",
    );
  } finally {
    cleanup(root);
  }
});

test("setup和assignment拒绝用户确认绕过的自评与非法judge绑定", () => {
  const base = policy();
  const badLag = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const badLagRoles = badLag.roles as Record<string, unknown>[];
  badLagRoles[1]!.judge_generation_lag = 0;
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:model-factory",
        workflow_id: "workflow:model-factory",
        setup_revision: "setup:bad-lag",
        model_usage_policy: badLag,
        tester_id: "tester:final",
        tester_version: "tester:v1",
      }),
    "INVALID_VALUE",
  );
  const currentBinding = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const currentRoles = currentBinding.roles as Record<string, unknown>[];
  currentRoles[1]!.artifact_binding = { revision: "current", source_role: "main-model" };
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:model-factory",
        workflow_id: "workflow:model-factory",
        setup_revision: "setup:current",
        model_usage_policy: currentBinding,
        tester_id: "tester:final",
        tester_version: "tester:v1",
      }),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  const selfBinding = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const selfRoles = selfBinding.roles as Record<string, unknown>[];
  selfRoles[1]!.artifact_binding = { source: "fixed_external", artifact_id: "artifact:candidate" };
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:model-factory",
        workflow_id: "workflow:model-factory",
        setup_revision: "setup:self",
        model_usage_policy: selfBinding,
        tester_id: "tester:final",
        tester_version: "tester:v1",
        validation: {
          candidate_artifact_ids: ["artifact:candidate"],
          candidate_output_artifact_ids: [],
        },
      }),
    "ARTIFACT_REGISTRY_REQUIRED",
  );
  const transitive = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const transitiveRoles = transitive.roles as Record<string, unknown>[];
  transitiveRoles[1]!.artifact_binding = {
    source: "fixed_external",
    artifact_id: "artifact:judge-descendant",
  };
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:model-factory",
        workflow_id: "workflow:model-factory",
        setup_revision: "setup:transitive",
        model_usage_policy: transitive,
        tester_id: "tester:final",
        tester_version: "tester:v1",
        validation: {
          candidate_artifact_ids: ["artifact:candidate"],
          candidate_output_artifact_ids: ["artifact:output"],
          candidate_lineage: new Map([["artifact:judge-descendant", ["artifact:output"]]]),
        },
      }),
    "UNKNOWN_FIELD",
  );
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-1" });
    const setup = saveTaskSetup(root, {
      task_id: "task:model-factory",
      workflow_id: "workflow:model-factory",
      setup_revision: "setup:r1",
      model_usage_policy: base,
      tester_id: "tester:final",
      tester_version: "tester:v1",
    });
    const artifactDir = path.join(root, "artifacts");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "main-v1.bin"), "main-v1");
    fs.writeFileSync(path.join(artifactDir, "main-v2.bin"), "main-v2");
    const registry = createArtifactRegistry(root, "outer-1");
    registry.register({
      schema_version: 1,
      artifact_id: "artifact:main-v1",
      contract: "model@1",
      uri: "artifacts/main-v1.bin",
      file_path: "artifacts/main-v1.bin",
      sha256: digest("main-v1"),
      producer_module: "main",
      producer_version: "main:v1",
      producer_run_id: "outer-1",
      candidate_id: "candidate:incumbent",
      input_artifact_ids: [],
      status: "sealed",
      generation: 1,
      role_id: "main-model",
      output_slot: "model",
      source_type: "workflow_output",
    });
    registry.register({
      schema_version: 1,
      artifact_id: "artifact:main-v2",
      contract: "model@1",
      uri: "artifacts/main-v2.bin",
      file_path: "artifacts/main-v2.bin",
      sha256: digest("main-v2"),
      producer_module: "main",
      producer_version: "main:v2",
      producer_run_id: "outer-1",
      candidate_id: "candidate:next",
      input_artifact_ids: ["artifact:main-v1"],
      status: "sealed",
      generation: 2,
      role_id: "main-model",
      output_slot: "model",
      source_type: "workflow_output",
    });
    const assignment = resolveModelAssignment({
      policy: setup.model_usage_policy,
      task_setup_revision: setup.setup_revision,
      outer_run_id: "outer-1",
      outer_iteration: 1,
      incumbent: {
        candidate_id: "candidate:incumbent",
        generation: 1,
        role_artifacts: [{ role_id: "main-model", artifact_id: "artifact:main-v1", generation: 1 }],
      },
      candidate: {
        candidate_id: "candidate:next",
        producer_run_id: "outer-1",
        candidate_artifact_ids: ["artifact:main-v2"],
        candidate_output_artifact_ids: ["artifact:main-v2"],
        target_generations: { "main-model.next": 2 },
      },
      registry,
    });
    assert.equal(
      assignment.assignments.find((entry) => entry.role_id === "main-judge")?.artifact_id,
      "artifact:main-v1",
    );
    expectCode(
      () =>
        assertAssignmentLineageSafe(
          assignment,
          {
            candidate_id: "candidate:incumbent",
            producer_run_id: "outer-1",
            candidate_artifact_ids: ["artifact:main-v1"],
            candidate_output_artifact_ids: [],
            target_generations: {},
          },
          registry,
        ),
      "JUDGE_LAG_VIOLATION",
    );
    saveModelAssignment(root, assignment);
    assert.equal(
      fs.existsSync(
        path.join(root, ".aris", "runs", "outer-1", "cycles", "1", "model-assignment.json"),
      ),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("outer run冻结policy和dashboard只从run目录恢复", () => {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-1" });
    const spec = validSpec();
    const setup = createTaskSetup({
      task_id: spec.task_id,
      workflow_id: spec.workflow_id,
      setup_revision: "setup:r1",
      model_usage_policy: policy(),
      tester_id: "tester:final",
      tester_version: "tester:v1",
    });
    const frozen = saveFrozenPolicy({
      project_root: root,
      outer_run_id: "outer-1",
      task_id: spec.task_id,
      owner_limits: spec.owner_limits,
      task_setup_revision: setup.setup_revision,
      task_setup: setup,
      model_usage_policy_revision: setup.model_usage_policy.revision,
      model_usage_policy: setup.model_usage_policy,
      tester_id: "tester:final",
      tester_version: "tester:v1",
      tester_definition: testerDefinition(),
      incumbent_candidate_id: "candidate:incumbent",
      incumbent_generation: 1,
      incumbent: {
        candidate_id: "candidate:incumbent",
        generation: 1,
        role_artifacts: [{ role_id: "main-model", artifact_id: "artifact:main-v1", generation: 1 }],
      },
    });
    const dashboard = createWorkflowDashboard(root, "outer-1", frozenPolicyFingerprint(frozen));
    assert.equal(
      updateWorkflowDashboard(root, "outer-1", { current_phase: "loop", wave_kind: "module" })
        .current_phase,
      "loop",
    );
    saveCycleWikiHead(root, "outer-1", 1, "event:1", HASH);
    const activeScorerPath = path.join(
      root,
      ".aris",
      "workflows",
      spec.workflow_id,
      "active-scorer.json",
    );
    fs.mkdirSync(path.dirname(activeScorerPath), { recursive: true });
    fs.writeFileSync(activeScorerPath, JSON.stringify({ revision: "scorer:changed" }));
    assert.equal(readFrozenPolicy(root, "outer-1").model_usage_policy_revision, "policy:r1");
    assert.equal(dashboard.run_id, "outer-1");
    adoptCurrentRunScopeLease({ project_root: root, run_id: "outer-1", scope_path: "/" }).release();
    createRootRun({ project_root: root, run_id: "outer-2" });
    expectCode(
      () => updateWorkflowDashboard(root, "outer-2", { current_phase: "loop" }),
      "DASHBOARD_NOT_FOUND",
    );
  } finally {
    cleanup(root);
  }
});

test("scorer coverage和实验只按delta更新并且父版本串行在前", () => {
  const parent = baseScorer();
  const candidateCoverage = rootCoverage("coverage:r2", "coverage:r1");
  (candidateCoverage.coverage_cells as Record<string, unknown>[]).push({
    coverage_cell_id: "cell:stress",
    coordinates: { difficulty: "stress" },
    benchmark_item_refs: ["benchmark:stress@1"],
    evidence_refs: ["evidence:stress"],
  });
  const delta = validateScorerDelta({
    schema_version: 1,
    delta_id: "delta:quality-1",
    scorer_id: parent.scorer_id,
    parent_revision: parent.revision,
    delta_kind: "compound",
    operations: [
      {
        op: "add_benchmark_item",
        benchmark_id: "benchmark:stress@1",
        content_hash: HASH_C,
        evidence_refs: ["evidence:stress"],
      },
      { op: "delete_rule", rule_id: "rule:quality", reason_evidence_refs: ["evidence:bad-rule"] },
    ],
    producer_scorer_run_id: "scorer-run-1",
    evidence_refs: ["evidence:stress", "evidence:bad-rule"],
  });
  const candidate = materializeScorerRevision(parent, delta, candidateCoverage);
  assert.equal(
    candidate.benchmark_items.find((item) => item.benchmark_id === "benchmark:stress@1")?.status,
    "active",
  );
  assert.equal(
    candidate.scoring_rules.find((rule) => rule.rule_id === "rule:quality")?.active,
    false,
  );
  assert.deepEqual(computeCoverageDelta(parent.coverage_map, candidate.coverage_map).added_cells, [
    "cell:stress",
  ]);
  assert.doesNotThrow(() => validateScorerRevision(candidate));
  const order: string[] = [];
  const seenInputs: string[] = [];
  const materialize = (caseId: string, revision: string) => ({
    item_id: caseId,
    input: { value: `${caseId}:${revision}` },
    contract: "eval@1",
    source: revision,
  });
  const freeze = {
    seed_manifest: { seed: 1 },
    representative_artifact_id: "artifact:representative",
    representative_artifact_sha256: HASH,
    input_snapshot_sha256: HASH_B,
    model_assignment_sha256: HASH_C,
    judge_binding_id: "judge:r1",
  };
  const comparison = runStandaloneScorerComparison({
    lock_path: path.join(tempDir(), "scorer.lock"),
    parent,
    candidate,
    freeze,
    materialize,
    evaluate_parent: (request) => {
      order.push(`parent:${request.scorer_revision}`);
      return {
        item_id: request.evaluation_item.item_id,
        score: 1,
        labels: [],
        output_sha256: HASH,
      };
    },
    evaluate_candidate: (request) => {
      order.push(`candidate:${request.scorer_revision}`);
      return {
        item_id: request.evaluation_item.item_id,
        score: 2,
        labels: [],
        output_sha256: HASH_B,
      };
    },
  });
  const comparisonWithInputTrace = runStandaloneScorerComparison({
    lock_path: path.join(tempDir(), "scorer-input.lock"),
    parent,
    candidate,
    freeze,
    materialize,
    evaluate_parent: (request) => {
      seenInputs.push(String((request.evaluation_item.input as { value: string }).value));
      return {
        item_id: request.evaluation_item.item_id,
        score: 1,
        labels: [],
        output_sha256: HASH,
      };
    },
    evaluate_candidate: (request) => {
      seenInputs.push(String((request.evaluation_item.input as { value: string }).value));
      return {
        item_id: request.evaluation_item.item_id,
        score: 2,
        labels: [],
        output_sha256: HASH_B,
      };
    },
  });
  assert.deepEqual(comparison.execution_order, ["parent", "candidate"]);
  assert.deepEqual(
    comparisonWithInputTrace.parent_results.map((result) => result.item_id),
    comparisonWithInputTrace.candidate_results.map((result) => result.item_id),
  );
  assert.deepEqual(
    seenInputs.slice(0, comparisonWithInputTrace.parent_results.length),
    seenInputs.slice(comparisonWithInputTrace.parent_results.length),
  );
  assert.equal(
    order.every((item) => item.startsWith("parent:")) ||
      order.some((item) => item.startsWith("candidate:")),
    true,
  );
  assert.equal(
    order.findIndex((item) => item.startsWith("parent:")) <
      order.findIndex((item) => item.startsWith("candidate:")),
    true,
  );
});

test("scorer wave拥有全局独占锁，不能与普通wave或第二个scorer并行", () => {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-1",   charter_sha256: HASH, input_snapshot_sha256: HASH_B, execution_plan_sha256: HASH_C, code_baseline_sha256: HASH, policy_revision: "policy:scorer" });
    createChildContract(root, "outer-1", "scorer-run-1", "scorer-1");
    createChildContract(root, "outer-1", "scorer-run-2", "scorer-2");
    const workflowId = "workflow:a1";
    const scorerId = "scorer:validation";
    const scorerRunId = "scorer-run-1";
    const outerRunId = "outer-1";
    const waveId = "wave-s";
    const parent = baseScorer();
    const delta = validateScorerDelta({
      schema_version: 1,
      delta_id: "delta:1",
      scorer_id: scorerId,
      parent_revision: parent.revision,
      delta_kind: "scoring",
      operations: [
        {
          op: "add_rule",
          rule_id: "rule:wave",
          kind: "deterministic_rule",
          content_hash: HASH_C,
        },
      ],
      producer_scorer_run_id: scorerRunId,
      evidence_refs: ["evidence:wave"],
    });
    const candidate = materializeScorerRevision(
      parent,
      delta,
      rootCoverage("coverage:r2", "coverage:r1"),
    );
    saveImmutableScorerDelta(root, delta);
    saveImmutableScorerRevision(root, parent);
    saveImmutableScorerRevision(root, candidate);
    beginOrdinaryWave(root, "module", "outer-1");
    expectCode(
      () =>
        startScorerRun({
          project_root: root,
          workflow_id: workflowId,
          scorer_run_id: scorerRunId,
          scorer_id: scorerId,
          outer_run_id: outerRunId,
          outer_iteration: 1,
          wave_id: waveId,
          generation: 1,
          parent_revision: parent.revision,
          candidate_revision: candidate.revision,
          delta_id: delta.delta_id,
        }),
      "SCORER_WAVE_EXCLUSIVE",
    );
    finishOrdinaryWave(root, "module", outerRunId, "completed");
    fs.mkdirSync(path.join(root, ".aris", "workflows", workflowId), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".aris", "workflows", workflowId, "definition.json"),
      JSON.stringify({
        schema_version: 1,
        workflow_id: workflowId,
        validation_policy: { scorer_id: scorerId },
        scorers: [{ id: scorerId }],
        scorer_wave_policy: {
          exclusive: true,
          max_candidates: 1,
          experiment_parallelism: 1,
          execution_order: "baseline_then_candidate",
          blocks_other_wave_kinds: true,
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, ".aris", "workflows", workflowId, "active-scorer.json"),
      JSON.stringify({
        schema_version: 1,
        workflow_id: workflowId,
        scorer_id: scorerId,
        revision: parent.revision,
        scorer_run_id: "active-scorer-parent",
      }),
    );
    saveScorerWaveRegistration({
      project_root: root,
      workflow_id: workflowId,
      scorer_id: scorerId,
      scorer_run_id: scorerRunId,
      outer_run_id: outerRunId,
      outer_iteration: 1,
      wave_id: waveId,
      parent_revision: parent.revision,
      candidate_revision: candidate.revision,
      delta_id: delta.delta_id,
    });
    startScorerRun({
      project_root: root,
      workflow_id: workflowId,
      scorer_run_id: scorerRunId,
      scorer_id: scorerId,
      outer_run_id: outerRunId,
      outer_iteration: 1,
      wave_id: waveId,
      generation: 1,
      parent_revision: parent.revision,
      candidate_revision: candidate.revision,
      delta_id: delta.delta_id,
    });
    assertWaveKindExclusive(root, "scorer", scorerRunId);
    expectCode(
      () =>
        startScorerRun({
          project_root: root,
          workflow_id: workflowId,
          scorer_run_id: "scorer-run-2",
          scorer_id: scorerId,
          outer_run_id: outerRunId,
          outer_iteration: 1,
          wave_id: "wave-s2",
          generation: 1,
          parent_revision: parent.revision,
          candidate_revision: candidate.revision,
          delta_id: delta.delta_id,
        }),
      "SCORER_WAVE_EXCLUSIVE",
    );
    finishScorerWave(root, scorerId, scorerRunId, "rejected");
  } finally {
    cleanup(root);
  }
});

function reservePromotionTrial(input: Parameters<typeof reserveStoredPromotionTrial>[0]) {
  const tester = testerDefinition();
  makePromotionFixture({
    project_root: input.project_root,
    outer_run_id: input.outer_run_id,
    wave_id: input.wave_id,
    task_id: input.task_id,
    setup_revision: input.task_setup_revision,
    tester,
    reviewer_worker_id: input.outer_run_id === "outer-gate" ? "reviewer-gate" : "reviewer:fixed",
    baseline_artifact_sha256: input.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: input.finalist_artifact_sha256,
  });
  return reserveStoredPromotionTrial(input);
}

test("tester只运行一次matching baseline/finalist，exposure三态和崩溃恢复可重放", () => {
  const root = tempDir();
  try {
    const tester = testerDefinition();
    saveTesterDefinition(root, tester);
    const common = {
      project_root: root,
      task_id: "task:model-factory",
      outer_run_id: "outer-1",
      wave_id: "wave-1",
      tester_id: tester.tester_id,
      tester_version: tester.version,
      tester_definition_sha256: tester.definition_sha256,
      harness_sha256: tester.harness_sha256,
      task_setup_revision: "setup:r1",
      case_manifest_sha256: tester.case_manifest_sha256,
      seed_manifest_sha256: tester.seed_manifest_sha256,
      matching_baseline_artifact_sha256: HASH,
      finalist_artifact_sha256: HASH_B,
      model_assignment_sha256: HASH_C,
      input_distribution_sha256: HASH_B,
      judge_binding: testerJudgeBinding(),
      max_exposures_per_task: tester.max_exposures_per_task,
    };
    reservePromotionTrial({ ...common, promotion_trial_id: "promotion:1" });
    const second = reservePromotionTrial({
      ...common,
      promotion_trial_id: "promotion:2",
      wave_id: "wave-2",
      outer_run_id: "outer-2",
      finalist_artifact_sha256: "d".repeat(64),
    });
    assert.equal(second.status, "reserved");
    markTesterStarted(root, "task:model-factory", "promotion:1", tester.max_exposures_per_task);
    sealPrivateTesterResult(
      root,
      "task:model-factory",
      "promotion:1",
      HASH_C,
      tester.max_exposures_per_task,
    );
    recordTesterFeedbackEvent(
      root,
      "task:model-factory",
      "promotion:1",
      "feedback:event-1",
      tester.max_exposures_per_task,
    );
    settleExposure(root, "task:model-factory", "promotion:1", tester.max_exposures_per_task);
    releaseExposure(
      root,
      "task:model-factory",
      "promotion:2",
      tester.max_exposures_per_task,
      "failed_irrecoverable",
    );
    reservePromotionTrial({
      ...common,
      promotion_trial_id: "promotion:3",
      wave_id: "wave-3",
      outer_run_id: "outer-3",
      finalist_artifact_sha256: "e".repeat(64),
    });
    const recovered = recoverExposureLedger({
      project_root: root,
      task_id: "task:model-factory",
      max_exposures_per_task: tester.max_exposures_per_task,
      trials: new Map([
        [
          "promotion:3",
          {
            tester_started: false,
            private_result_sha256: null,
            feedback_event_id: "feedback:event-3",
            parent_wave_status: "running",
          },
        ],
      ]),
    });
    assert.equal(
      recovered.exposures.find((exposure) => exposure.promotion_trial_id === "promotion:3")?.status,
      "settled",
    );
    assert.equal(
      readExposureLedger(
        root,
        "task:model-factory",
        tester.max_exposures_per_task,
      ).exposures.filter((exposure) => exposure.status === "settled").length,
      2,
    );
    expectCode(
      () =>
        releaseExposure(
          root,
          "task:model-factory",
          "promotion:1",
          tester.max_exposures_per_task,
          "failed_irrecoverable",
        ),
      "EXPOSURE_TERMINAL",
    );
    reservePromotionTrial({
      ...common,
      task_id: "task:other",
      outer_run_id: "outer-9",
      wave_id: "wave-9",
      promotion_trial_id: "promotion:9",
    });
    createChildContract(root, "outer-9", "tester-run-1", "tester");
    const testerRun = startTesterRun({
      project_root: root,
      tester_run_id: "tester-run-1",
      task_id: "task:other",
      outer_run_id: "outer-9",
      outer_iteration: 1,
      wave_id: "wave-9",
      wave_kind: "module",
      generation: 1,
      promotion_trial_id: "promotion:9",
      tester,
      task_setup_revision: "setup:r1",
      input_snapshot_sha256: HASH,
      harness_sha256: tester.harness_sha256,
      matching_baseline_artifact_sha256: HASH,
      finalist_artifact_sha256: HASH_B,
      model_assignment_sha256: HASH_C,
      input_distribution_sha256: HASH_B,
      judge_binding: testerJudgeBinding(),
    });
    assert.equal(testerRun.status, "queued");
  } finally {
    cleanup(root);
  }
});

test("promotion gate消费一次且tester反馈只发布模糊结论", () => {
  const tester = testerDefinition();
  const judgeBinding = testerJudgeBinding();
  const observations = [
    {
      case_id: "case:1",
      repeat_id: "repeat:1",
      metrics: { tester_score: 0.5 },
      constraint_metrics: { safety_score: 0.95 },
    },
    {
      case_id: "case:1",
      repeat_id: "repeat:2",
      metrics: { tester_score: 0.5 },
      constraint_metrics: { safety_score: 0.95 },
    },
    {
      case_id: "case:2",
      repeat_id: "repeat:1",
      metrics: { tester_score: 0.5 },
      constraint_metrics: { safety_score: 0.95 },
    },
    {
      case_id: "case:2",
      repeat_id: "repeat:2",
      metrics: { tester_score: 0.5 },
      constraint_metrics: { safety_score: 0.95 },
    },
  ];
  const baseline = {
    arm: "matching_baseline" as const,
    artifact_id: "artifact:baseline",
    artifact_sha256: HASH,
    tester_version: tester.version,
    tester_definition_sha256: tester.definition_sha256,
    harness_sha256: tester.harness_sha256,
    case_manifest_sha256: tester.case_manifest_sha256,
    seed_manifest_sha256: tester.seed_manifest_sha256,
    input_distribution_sha256: HASH_C,
    judge_binding_id: judgeBinding.binding_id,
    model_assignment_sha256: HASH_B,
    case_ids: ["case:1", "case:2"],
    repeat_ids: ["repeat:1", "repeat:2"],
    complete: true,
    observations,
    metrics: { tester_score: 0.5 },
    constraint_metrics: { safety_score: 0.95 },
  };
  const finalist = {
    ...baseline,
    arm: "finalist" as const,
    artifact_id: "artifact:finalist",
    artifact_sha256: HASH_B,
    observations: observations.map((observation) => ({
      ...observation,
      metrics: { tester_score: 0.6 },
    })),
    metrics: { tester_score: 0.6 },
    constraint_metrics: { safety_score: 0.95 },
  };
  assert.equal(
    evaluatePromotionGate({
      definition: tester,
      baseline,
      finalist,
      workflow_constraints_passed: true,
    }).status,
    "passed",
  );
  expectCode(
    () =>
      evaluatePromotionGate({
        definition: tester,
        baseline: {
          ...baseline,
          case_ids: ["case:1"],
          repeat_ids: ["repeat:1"],
          observations: [observations[0]!],
        },
        finalist,
        workflow_constraints_passed: true,
      }),
    "TESTER_ARMS_MISMATCH",
  );
  const validationPlan = [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: ["a"] },
    { cell_id: "01", module_ids: ["d"] },
    { cell_id: "11", module_ids: ["a", "d"] },
  ];
  const validationBinding = {
    active_scorer_revision: "scorer:r1",
    model_assignment_sha256: HASH,
    sample_plan_sha256: HASH_B,
    repeat_ids: ["repeat:1", "repeat:2"],
  };
  const validationResults = [
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
      candidate_id: "candidate:10",
      complete: true,
      primary_score: 1.1,
      hard_constraints_passed: true,
      cost: 2,
      changed_module_count: 1,
    },
    {
      cell_id: "01",
      candidate_id: "candidate:01",
      complete: true,
      primary_score: 1.2,
      hard_constraints_passed: true,
      cost: 2,
      changed_module_count: 1,
    },
    {
      cell_id: "11",
      candidate_id: "candidate:11",
      complete: true,
      primary_score: 1.3,
      hard_constraints_passed: true,
      cost: 3,
      changed_module_count: 2,
    },
  ].map((result) => ({
    ...result,
    status: "succeeded" as const,
    binding: validationBinding,
    evidence: { evidence_bundle_id: `evidence:${result.cell_id}`, evidence_sha256: HASH_C },
  }));
  const validationReview = {
    review_id: "review:validation",
    verdict: "approved" as const,
    plan_id: "plan:validation",
    binding_sha256: validationBindingSha256(validationBinding),
    evidence_set_sha256: validationEvidenceSetSha256(validationResults),
    reviewed_cell_ids: ["00", "01", "10", "11"],
    reviewed_candidate_ids: ["candidate:00", "candidate:01", "candidate:10", "candidate:11"],
  };
  assert.equal(
    selectUniqueFinalist(validationPlan, validationResults, {
      plan_id: "plan:validation",
      primary_direction: "higher_better",
      improvement: { policy: "relative", minimum_gain: 0.01 },
      binding: validationBinding,
      review: validationReview,
    }).selected_cell_id,
    "11",
  );
  const feedback = buildTesterFeedback({
    schema_version: 1,
    task_id: "task:model-factory",
    task_setup_revision: "setup:r1",
    input_snapshot_sha256: HASH,
    promotion_trial_id: "promotion:1",
    tester_version: tester.version,
    conclusion: "not_improved",
    directions: ["long_horizon_stability"],
    advice: ["increase_long_horizon_consistency"],
    confidence: "medium",
    metrics: { tester_score: 0.9 },
  });
  assert.equal(sanitizeTesterFeedback(feedback).conclusion, "not_improved");
  expectCode(
    () => sanitizeTesterFeedback({ ...feedback, case_id: "case:secret" }),
    "PRIVATE_EVIDENCE_LEAK",
  );
  const gateRoot = tempDir();
  try {
    // The reviewer now reads the parent contract, so the gate fixture needs a real one.
    saveTesterDefinition(gateRoot, tester);
    reservePromotionTrial({
      project_root: gateRoot,
      task_id: "task:model-factory",
      outer_run_id: "outer-gate",
      wave_id: "wave-gate",
      tester_id: tester.tester_id,
      tester_version: tester.version,
      tester_definition_sha256: tester.definition_sha256,
      harness_sha256: tester.harness_sha256,
      task_setup_revision: "setup:r1",
      case_manifest_sha256: tester.case_manifest_sha256,
      seed_manifest_sha256: tester.seed_manifest_sha256,
      matching_baseline_artifact_sha256: HASH,
      finalist_artifact_sha256: HASH_B,
      model_assignment_sha256: HASH_C,
      input_distribution_sha256: HASH_B,
      judge_binding: testerJudgeBinding(),
      max_exposures_per_task: tester.max_exposures_per_task,
      promotion_trial_id: "promotion:gate",
    });
    createChildContract(gateRoot, "outer-gate", "tester-run-gate", "gate");
    startTesterRun({
      project_root: gateRoot,
      tester_run_id: "tester-run-gate",
      task_id: "task:model-factory",
      outer_run_id: "outer-gate",
      outer_iteration: 1,
      wave_id: "wave-gate",
      wave_kind: "module",
      generation: 1,
      promotion_trial_id: "promotion:gate",
      tester,
      task_setup_revision: "setup:r1",
      input_snapshot_sha256: HASH,
      harness_sha256: tester.harness_sha256,
      matching_baseline_artifact_sha256: HASH,
      finalist_artifact_sha256: HASH_B,
      model_assignment_sha256: HASH_C,
      input_distribution_sha256: HASH_B,
      judge_binding: testerJudgeBinding(),
    });
    recordTesterStarted(gateRoot, "tester-run-gate");
    const privateResultState = recordTesterPrivateResult(gateRoot, "tester-run-gate", {
      schema_version: 1,
      tester_run_id: "tester-run-gate",
      task_id: "task:model-factory",
      outer_run_id: "outer-gate",
      outer_iteration: 1,
      wave_id: "wave-gate",
      wave_kind: "module",
      generation: 1,
      promotion_trial_id: "promotion:gate",
      task_setup_revision: "setup:r1",
      tester_id: tester.tester_id,
      tester_version: tester.version,
      tester_definition_sha256: tester.definition_sha256,
      tester_definition: tester,
      harness_sha256: tester.harness_sha256,
      case_manifest_id: tester.case_manifest_id,
      case_manifest_sha256: tester.case_manifest_sha256,
      seed_manifest_sha256: tester.seed_manifest_sha256,
      case_manifest: {
        case_manifest_id: tester.case_manifest_id,
        case_manifest_sha256: tester.case_manifest_sha256,
        seed_manifest_sha256: tester.seed_manifest_sha256,
      },
      input_snapshot_sha256: HASH,
      input_distribution_sha256: HASH_B,
      model_assignment_sha256: HASH_C,
      judge_binding: testerJudgeBinding(),
      workflow_constraints_passed: true,
      baseline: { ...baseline, model_assignment_sha256: HASH_C, input_distribution_sha256: HASH_B },
      finalist: { ...finalist, model_assignment_sha256: HASH_C, input_distribution_sha256: HASH_B },
    });
    const testerEvidencePath = path.join(
      gateRoot,
      ".aris",
      "runs",
      "tester-run-gate",
      "workers",
      "tester-worker",
      "outputs",
      "evidence.json",
    );
    const testerEvidenceSha = digest("tester-evidence");
    fs.mkdirSync(path.dirname(testerEvidencePath), { recursive: true });
    fs.writeFileSync(testerEvidencePath, "tester-evidence");
    fs.writeFileSync(
      path.join(path.dirname(path.dirname(testerEvidencePath)), "input-manifest.json"),
      JSON.stringify({
        schema_version: 1,
        run_id: "tester-run-gate",
        worker: "tester-worker",
        phase: "promotion_test",
        iteration: 1,
        output_dir: path.relative(gateRoot, path.dirname(testerEvidencePath)),
      }),
    );
    fs.writeFileSync(
      path.join(path.dirname(path.dirname(testerEvidencePath)), "receipt.json"),
      JSON.stringify({
        schema_version: 1,
        run_id: "tester-run-gate",
        worker: "tester-worker",
        phase: "promotion_test",
        iteration: 1,
        status: "done",
        primary_output: "evidence.json",
        primary_output_sha256: testerEvidenceSha,
      }),
    );
    const testerReceipt = {
      schema_version: 1,
      review_id: "review:tester-gate",
      reviewed_run_id: "tester-run-gate",
      reviewed_run_kind: "tester",
      outer_iteration: 1,
      wave_id: "wave-gate",
      wave_kind: "module",
      review_stage: "promotion_test",
      generation: 1,
      subject: {
        promotion_trial_id: "promotion:gate",
        tester_version: tester.version,
        case_manifest_sha256: HASH,
        matching_baseline_artifact_sha256: HASH,
        finalist_artifact_sha256: HASH_B,
        private_result_sha256: privateResultState.private_result_sha256,
      },
      reviewer_worker_id: "reviewer-gate",
      evidence_bundle_id: "evidence:tester-gate",
      evidence_sha256: testerEvidenceSha,
      verdict: "approved",
      reason_codes: ["complete"],
      evidence_refs: ["opaque:tester-evidence"],
      command_id: "review-submit:review:tester-gate",
    };
    const testerAssignment = createReviewAssignment({
      actor: "review_scheduler",
      project_root: gateRoot,
      review_id: "review:tester-gate",
      outer_run_id: "outer-gate",
      reviewed_run_id: "tester-run-gate",
      reviewed_run_kind: "tester",
      outer_iteration: 1,
      wave_id: "wave-gate",
      wave_kind: "module",
      review_stage: "promotion_test",
      generation: 1,
      subject: testerReceipt.subject,
      reviewer_worker_id: "reviewer-gate",
      evidence_producer_worker_id: "tester-worker",
      evidence_bundle_id: "evidence:tester-gate",
      evidence_path: path.relative(gateRoot, testerEvidencePath),
    });
    submitReviewReceipt({
      project_root: gateRoot,
      receipt: testerReceipt,
      assignment: testerAssignment,
      manifest_run_id: "tester-run-gate",
      command_run_id: "tester-run-gate",
    });
    recordTesterReview(gateRoot, "tester-run-gate", testerReceipt);
    const gateBaseline = {
      ...baseline,
      model_assignment_sha256: HASH_C,
      input_distribution_sha256: HASH_B,
    };
    const gateFinalist = {
      ...finalist,
      model_assignment_sha256: HASH_C,
      input_distribution_sha256: HASH_B,
    };
    const consumed = consumePromotionGate({
      project_root: gateRoot,
      tester_run_id: "tester-run-gate",
      definition: tester,
      baseline: gateBaseline,
      finalist: gateFinalist,
      workflow_constraints_passed: true,
    });
    assert.equal(consumed.status, "passed");
    assert.equal(
      consumePromotionGate({
        project_root: gateRoot,
        tester_run_id: "tester-run-gate",
        definition: tester,
        baseline: gateBaseline,
        finalist: gateFinalist,
        workflow_constraints_passed: true,
      }).status,
      "passed",
    );
    const gateFeedback = buildTesterFeedback({
      schema_version: 1,
      task_id: "task:model-factory",
      task_setup_revision: "setup:r1",
      input_snapshot_sha256: HASH,
      promotion_trial_id: "promotion:gate",
      tester_version: tester.version,
      conclusion: "improved",
      directions: ["long_horizon_stability"],
      advice: ["increase_long_horizon_consistency"],
      confidence: "medium",
      metrics: { tester_score: 0.9 },
    });
    expectCode(
      () =>
        publishTesterFeedback({
          project_root: gateRoot,
          tester_run_id: "tester-run-gate",
          actor: "outer_committer",
          feedback: buildTesterFeedback({
            schema_version: 1,
            task_id: gateFeedback.task_id,
            task_setup_revision: gateFeedback.task_setup_revision,
            input_snapshot_sha256: HASH_B,
            promotion_trial_id: gateFeedback.promotion_trial_id,
            tester_version: gateFeedback.tester_version,
            conclusion: gateFeedback.conclusion,
            directions: gateFeedback.directions,
            advice: gateFeedback.advice,
            confidence: gateFeedback.confidence,
            metrics: gateFeedback.metrics,
          }),
        }),
      "TESTER_FEEDBACK_NOT_READY",
    );
    assert.equal(
      publishTesterFeedback({
        project_root: gateRoot,
        tester_run_id: "tester-run-gate",
        actor: "outer_committer",
        feedback: gateFeedback,
      }).feedback_event_id,
      gateFeedback.feedback_event_id,
    );
    assert.equal(
      readExposureLedger(
        gateRoot,
        "task:model-factory",
        tester.max_exposures_per_task,
      ).exposures.find((exposure) => exposure.promotion_trial_id === "promotion:gate")
        ?.feedback_event_id,
      gateFeedback.feedback_event_id,
    );
    expectCode(
      () =>
        publishTesterFeedback({
          project_root: gateRoot,
          tester_run_id: "tester-run-gate",
          actor: "tester_worker",
          feedback: gateFeedback,
        }),
      "WRITE_SCOPE_FORBIDDEN",
    );
  } finally {
    cleanup(gateRoot);
  }
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
console.log(`A1 tests passed: ${passed}`);
