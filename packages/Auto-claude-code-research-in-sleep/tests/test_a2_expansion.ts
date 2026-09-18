import { initializeRunBudget } from "../src/tools/run-budget.js";
import { bridgeFixture } from "./helpers/recursive-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import {
  assertWaveCreationAllowed,
  classifyBridgeResult,
  createBudgetLedger,
  checkExpansionScope,
  decideWave,
  planExperimentBridge,
  refundChildBudget,
  splitChildBudget,
  
  validateFrozenDynamicAblationPlan,
  buildDynamicAblationPlan,
  computeBridgeChildIdentityHash,
  materializeBridgeChildren,
  type BridgePositionInput,
  type DynamicAblationPlan,
} from "../src/tools/experiment-bridge.js";
import { createBaselineScope, type BaselineScope } from "../src/tools/baseline-scope.js";
import {
  classifyResourceRequest,
  createResourceInventory,
  type ResourceInventory,
} from "../src/tools/resource-inventory.js";
import { resultStatusPolicy } from "../src/tools/result-package.js";
import { selectUniqueFinalist } from "../src/tools/validation-gate.js";
import { evaluateWorkflowStopGate, type StopPolicy } from "../src/tools/workflow-stop-gate.js";
import {
  beginOuterCycle,
  readOuterRunStatus,
  reserveOuterBudget,
  startOuterRunForTest,
} from "../src/tools/workflow-runtime.js";
import { createTaskSetup } from "../src/tools/task-setup.js";
import { buildTesterDefinition } from "../src/tools/tester-state.js";
import { validateWorkflowSpec, type WorkflowSpec } from "../src/tools/workflow-spec.js";
import type { FreezeOuterRunInput, OuterCycleSummary } from "../src/tools/workflow-state.js";
import { createBridgeChildRun, createRootRun, createRun } from "../src/tools/run-contract.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function baselineFor(positionIds: readonly string[] = ["main"]): BaselineScope {
  return createBaselineScope({
    schema_version: 1,
    baseline_id: "W_0",
    workflow_definition: {
      modules: positionIds.map((id) => ({ id })),
      edges: [],
    },
    code_baseline: { ref: "commit:baseline", sha256: HASH_A },
    position_artifacts: Object.fromEntries(
      positionIds.map((id, index) => [
        id,
        { artifact_ref: `artifact:${id}`, artifact_sha256: index === 0 ? HASH_B : HASH_C },
      ]),
    ),
    initial_validation: {
      scorer_revision: "scorer:r1",
      input_snapshot_sha256: HASH_C,
      judge_binding: { role: "fixed-judge", revision: "judge:r1" },
      metrics: { score: 0.4 },
    },
    optimizable_scope: positionIds.map((position_id) => ({ position_id, mode: "independent" })),
    max_bundled_positions_per_graph: 0,
  });
}

function resources(): ResourceInventory {
  return createResourceInventory({
    schema_version: 1,
    inventory_id: "resources:a2-3",
    platforms: [
      {
        platform_id: "gpu-a",
        access_ref: "credential:a2-3",
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
}

function request(platform_id = "gpu-a"): Record<string, unknown> {
  return {
    platform_id,
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
  };
}

function charter(
  baseline: BaselineScope,
  resource: ResourceInventory,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    charter_id: "charter:a2-3",
    run_id: "root-a2-3",

    
    expected_output: "a candidate artifact with reproducible evidence",
    budget: { amount: 10, unit: "gpu_hours" },
    
    
    baseline_sha256: baseline.baseline_sha256,
    resource_inventory_sha256: resource.inventory_sha256,
    optimizable_scope: baseline.optimizable_scope,
    policy_revision: "policy:a2-3",
    code_baseline_sha256: baseline.code_baseline.sha256,
    ...overrides,
  };
}

/**
 * A minimal single-module spec. These tests are about A2 expansion, not about
 * how a spec is authored, so the fixture is a literal: it states every field
 * the validator requires rather than deriving them, and nothing here changes
 * when the authoring path does.
 */
function oneModuleSpec(): WorkflowSpec {
  const mainModule = {
    id: "main",
    evolvable: false,
    inputs: [] as string[],
    outputs: ["output@1"],
    write_scope: ["src/main/**"],
    local_metric: null,
    execution: { max_jobs: 1, max_compute: { amount: 1, unit: "gpu_hours" } },
  };
  return validateWorkflowSpec({
    schema_version: 1,
    mode: "standalone",
    task_id: "task:standalone",
    workflow_id: "workflow:standalone",
    revision: "flow:standalone-r1",
    objective: {
      primary: { name: "standalone_metric", direction: "higher_better" },
      constraints: [],
    },
    task_setup_revision: "setup:standalone",
    model_usage_policy: {
      revision: "flow:standalone-r1:policy",
      approval_id: "task:standalone:standalone-approval",
      roles: [
        {
          role_id: "standalone-model",
          allowed_modules: ["main"],
          allowed_uses: ["generate", "train"],
          judge_targets: [],
          judge_generation_lag: null,
          artifact_binding: {
            source: "previous_promoted",
            source_role: null,
            artifact_id: null,
          },
          promotion_output: "standalone.model",
          user_confirmed: true,
          approval_id: "task:standalone:standalone-model",
        },
      ],
    },
    validation_policy: {
      scorer_id: "standalone-rules",
      scorer_revision_binding: "from_active_scorer_pointer",
      research_feedback: "detailed",
      cross_judge_score_comparison: "forbidden",
    },
    scorers: [
      {
        id: "standalone-rules",
        kind: "deterministic_rules",
        definition_binding: "from_active_scorer_revision",
        judge_binding: null,
      },
    ],
    promotion_tester: {
      tester_id: "standalone-tester",
      definition_version: "standalone-v1",
      research_feedback: "fuzzy_advice_only",
      max_exposures_per_task: 1,
    },
    wave_policy: {
      max_parallel_modules: 1,
      dependent_modules: "sequential",
      ablation_design: "full_factorial",
    },
    structure_wave_policy: { exclusive: true, max_candidates: 1, module_versions: "frozen" },
    scorer_wave_policy: {
      exclusive: true,
      max_candidates: 1,
      experiment_parallelism: 1,
      execution_order: "baseline_then_candidate",
      blocks_other_wave_kinds: true,
    },
    owner_limits: {
      revision: "flow:standalone-r1:limits",
      max_nodes: 1,
      max_edges: 0,
      max_fan_out_per_node: 0,
      max_unrolled_cycles: 0,
      max_jobs_per_candidate: 1,
      max_compute_per_candidate: { amount: 1, unit: "gpu_hours" },
    },
    modules: [mainModule],
    module_catalog: [mainModule],
    enabled_module_ids: ["main"],
    active_module_ids: ["main"],
    edges: [],
    feedback_edges: [],
    cycles: [],
  });
}

function twoModuleSpec(): WorkflowSpec {
  const one = oneModuleSpec();
  const second = {
    ...one.modules[0]!,
    id: "other",
    write_scope: ["src/other/**"],
  };
  const roles = structuredClone(one.model_usage_policy);
  roles.roles[0]!.allowed_modules = ["main", "other"];
  return validateWorkflowSpec({
    ...one,
    mode: "workflow",
    model_usage_policy: roles,
    owner_limits: {
      ...one.owner_limits,
      max_nodes: 2,
      max_jobs_per_candidate: 2,
    },
    wave_policy: { ...one.wave_policy, max_parallel_modules: 2 },
    modules: [one.modules[0]!, second],
    module_catalog: [one.module_catalog[0]!, second],
    enabled_module_ids: ["main", "other"],
    active_module_ids: ["main", "other"],
  });
}

function position(
  position_id: string,
  changes: Partial<BridgePositionInput> = {},
): BridgePositionInput {
  return {
    position_id,
    mode: "independent",
    resource_request: request(),
    candidate_id: `candidate:${position_id}`,
    result_status: "succeeded",
    ...changes,
  };
}

function cycle(
  outer_iteration: number,
  changes: Partial<OuterCycleSummary> = {},
): OuterCycleSummary {
  return {
    schema_version: 1,
    outer_run_id: "outer-a2-3",
    outer_iteration,
    generation: 1,
    wave_id: `wave:${outer_iteration}`,
    wave_kind: "module",
    status: "completed",
    candidate_ids: ["candidate:baseline"],
    finalist_id: null,
    promotion_trial_id: null,
    validation_result: "rejected",
    promotion_result: "not_run",
    target_reached: false,
    valid_candidate: false,
    tester_improved: false,
    budget: { reserved: 0, consumed: 0, released: 0, unit: "gpu_hours" },
    evidence_refs: [`cycles/${outer_iteration}/evidence.json`],
    evidence_sha256: HASH_A,
    recorded_at: `2026-09-11T00:0${outer_iteration}:00.000Z`,
    ...changes,
  };
}

const noStopPolicy: StopPolicy = { max_no_finalist_cycles: 1 };

function minimalFreezeInput(projectRoot: string, outerRunId: string): FreezeOuterRunInput {
  const modelUsagePolicy = {
    revision: "policy:a2-3-budget",
    approval_id: "approval:a2-3-budget",
    roles: [
      {
        role_id: "main-model",
        allowed_modules: ["main"],
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
    task_id: "task:a2-3-budget",
    workflow_id: "workflow:a2-3-budget",
    setup_revision: "setup:a2-3-budget",
    model_usage_policy: modelUsagePolicy,
    tester_id: "tester:a2-3-budget",
    tester_version: "tester:v1",
  });
  const tester = buildTesterDefinition({
    schema_version: 1,
    tester_id: "tester:a2-3-budget",
    version: "tester:v1",
    immutable: true,
    case_manifest_id: "cases:a2-3-budget",
    case_manifest_sha256: HASH_A,
    seed_manifest_sha256: HASH_B,
    harness_sha256: HASH_C,
    research_feedback: "fuzzy_advice_only",
    max_exposures_per_task: 4,
    comparison: "paired_matching_baseline_vs_finalist",
    gate: {
      primaries: [{ name: "score", direction: "higher_better", improvement: { policy: "absolute", minimum_gain: 0.1 } }],
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
      { kind: "deterministic_rules", definition_version: "rules:a2-3", judge_binding: null },
    ],
  });
  return {
    project_root: projectRoot,
    outer_run_id: outerRunId,
    task_id: taskSetup.task_id,
    owner_limits: {
      revision: "limits:a2-3-budget",
      max_nodes: 4,
      max_edges: 4,
      max_fan_out_per_node: 2,
      max_unrolled_cycles: 1,
      max_jobs_per_candidate: 4,
      max_compute_per_candidate: { amount: 4, unit: "gpu_hours" },
    },
    task_setup_revision: taskSetup.setup_revision,
    task_setup: taskSetup,
    model_usage_policy_revision: modelUsagePolicy.revision,
    model_usage_policy: modelUsagePolicy,
    tester_id: tester.tester_id,
    tester_version: tester.version,
    tester_definition: tester,
    incumbent_candidate_id: "candidate:incumbent",
    incumbent_generation: 1,
    incumbent: {
      candidate_id: "candidate:incumbent",
      generation: 1,
      role_artifacts: [{ role_id: "main-model", artifact_id: "artifact:incumbent", generation: 1 }],
    },
  };
}

test("bridge routes each independently classified result state through the shared policy", () => {
  const outOfScope = classifyBridgeResult({
    resource_status: "not_executable",
    execution_outcome: "failed",
    result_package: { status: "succeeded" },
  });
  const unavailable = classifyBridgeResult({
    resource_status: "infra_unavailable",
    execution_outcome: "failed",
  });
  const failed = classifyBridgeResult({
    resource_status: "succeeded",
    execution_outcome: "failed",
  });
  const succeeded = classifyBridgeResult({
    resource_status: "succeeded",
    execution_outcome: "succeeded",
  });
  assert.equal(outOfScope.status, "not_executable");
  assert.equal(unavailable.status, "infra_unavailable");
  assert.equal(failed.status, "failed");
  assert.equal(succeeded.status, "succeeded");
  assert.equal(resultStatusPolicy(outOfScope.status).enters_validation, false);
  assert.equal(resultStatusPolicy(unavailable.status).consumes_tester_exposure, false);
  assert.equal(resultStatusPolicy(failed.status).counts_for_stop_gate, true);
  assert.equal(resultStatusPolicy(succeeded.status).counts_for_stop_gate, false);
});

test("resource classification checks frozen scope before runtime availability", () => {
  const result = classifyResourceRequest(
    resources(),
    { ...request(), accelerator_count: 3 },
    () => false,
  );
  assert.equal(result.status, "not_executable");
  assert.equal(result.failure_code, "RESOURCE_SCOPE_ALIGNMENT_REQUIRED");
});

test("scope checking preserves the declared mode and strategy comes from the experiment plan", () => {
 const base=baselineFor(), resource=resources();
 const input=bridgeFixture({charter:charter(base,resource),baseline:base,resource_inventory:resource,positions:[position("main")],strategy:"dfs",strategy_reason:"Resolve the measured bottleneck first"});
 assert.equal(checkExpansionScope(input.charter, input.positions[0]!),"independent");
 assert.equal(planExperimentBridge(input).strategy,"dfs");
 expectCode(()=>planExperimentBridge({...input,strategy_reason:""}),"INVALID_VALUE");
 expectCode(()=>checkExpansionScope(input.charter,position("outside")),"OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED");
});

test("dynamic wave width follows zero, one, or two returned candidates and keeps siblings visible", () => {
  const spec = oneModuleSpec();
  const resource = resources();
  const oneCandidate = decideWave({
    workflow_spec: spec,
    resource_inventory: resource,
    positions: [
      position("main"),
      position("missing", {
        resource_request: request("outside"),
        candidate_id: "candidate:missing",
        result_status: "not_executable",
      }),
    ],
  });
  assert.equal(oneCandidate.matrix?.width, 1);
  assert.deepEqual(oneCandidate.matrix?.cells, [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: ["main"] },
  ]);
  assert.deepEqual(oneCandidate.validation_candidate_ids, ["candidate:main"]);
  assert.deepEqual(oneCandidate.tester_candidate_ids, ["candidate:main"]);
  assert.deepEqual(oneCandidate.siblings_to_continue, ["main", "missing"]);

  const twoCandidates = decideWave({
    workflow_spec: twoModuleSpec(),
    resource_inventory: resource,
    positions: [position("main"), position("other")],
  });
  assert.equal(twoCandidates.matrix?.width, 2);
  assert.deepEqual(twoCandidates.matrix?.cells, [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: ["main"] },
    { cell_id: "01", module_ids: ["other"] },
    { cell_id: "11", module_ids: ["main", "other"] },
  ]);
  assert.deepEqual(twoCandidates.validation_candidate_ids, ["candidate:main", "candidate:other"]);

  const none = decideWave({
    workflow_spec: spec,
    resource_inventory: resource,
    positions: [
      position("main", { resource_request: request("outside"), result_status: "not_executable" }),
      position("missing", {
        resource_request: request("outside"),
        result_status: "infra_unavailable",
      }),
    ],
  });
  assert.equal(none.matrix, null);
  assert.deepEqual(none.validation_candidate_ids, []);
  assert.deepEqual(none.tester_candidate_ids, []);
  assert.equal(Object.hasOwn(none, "validation_budget"), false);
  assert.equal(Object.hasOwn(none, "finalist_id"), false);

  const emptyValidationPlan: Parameters<typeof selectUniqueFinalist>[0] = [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: ["main"] },
  ];
  const emptyValidationSelection = selectUniqueFinalist(emptyValidationPlan, [], {
    plan_id: "plan:a2-3-empty",
    primary_direction: "higher_better",
    improvement: { policy: "absolute", minimum_gain: 0 },
    binding: {
      active_scorer_revision: "scorer:a2-3",
      model_assignment_sha256: HASH_A,
      sample_plan_sha256: HASH_B,
      repeat_ids: ["repeat:a2-3"],
    },
    review: {
      review_id: "review:a2-3-empty",
      verdict: "approved",
      plan_id: "plan:a2-3-empty",
      binding_sha256: HASH_A,
      evidence_set_sha256: HASH_B,
      reviewed_cell_ids: [],
      reviewed_candidate_ids: [],
    },
  });
  assert.equal(emptyValidationSelection.selected_candidate_id, null);
  assert.equal(emptyValidationSelection.selected_cell_id, null);
  assert.equal(emptyValidationSelection.reason, "validation_incomplete");
});

test("zero-candidate wave leaves validation budget and finalist unset", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-3-zero-candidate-project-"));
  const executionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "aris-a2-3-zero-candidate-execution-"),
  );
  const identity = {
    execution_root: executionRoot,
    project_root: projectRoot,
    outer_run_id: "outer-a2-3-zero-candidate",
    task_id: "task:a2-3-budget",
    workflow_id: "workflow:a2-3-budget",
    
    
    
  };
  try {
    createRootRun({
      project_root: projectRoot,
      run_id: identity.outer_run_id,
      
      
      
    });
    startOuterRunForTest({
      ...identity,
      freeze_input: minimalFreezeInput(projectRoot, identity.outer_run_id),
    });
    const evidencePath = path.join(projectRoot, "zero-candidate-evidence.txt");
    fs.writeFileSync(evidencePath, "zero candidates\n", "utf8");
    beginOuterCycle({
      ...identity,
      wave_id: "wave:a2-3-zero-candidate",
      wave_kind: "module",
      evidence_paths: [evidencePath],
    });
    const before = readOuterRunStatus(identity).runtime;
    assert.ok(before);
    assert.deepEqual(before.budgets, []);

    const none = decideWave({
      workflow_spec: oneModuleSpec(),
      resource_inventory: resources(),
      positions: [
        position("main", { resource_request: request("outside"), result_status: "not_executable" }),
      ],
    });
    assert.equal(none.matrix, null);
    assert.deepEqual(none.validation_candidate_ids, []);
    assert.equal(Object.hasOwn(none, "finalist_id"), false);
    assert.equal(Object.hasOwn(none, "validation_budget"), false);

    const after = readOuterRunStatus(identity).runtime;
    assert.ok(after);
    assert.deepEqual(after.budgets, []);

    const reservation = reserveOuterBudget({
      ...identity,
      reservation_id: "budget:a2-3-validation",
      category: "validation",
      amount: 1,
      unit: "gpu_hours",
    });
    assert.deepEqual(
      reservation.budgets.map((budget) => ({
        reservation_id: budget.reservation_id,
        category: budget.category,
        amount: budget.amount,
        unit: budget.unit,
        status: budget.status,
      })),
      [
        {
          reservation_id: "budget:a2-3-validation",
          category: "validation",
          amount: 1,
          unit: "gpu_hours",
          status: "reserved",
        },
      ],
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test("frozen width rejects changes and an incomplete matrix rejects the whole wave", () => {
  const oneSpec = oneModuleSpec();
  const twoSpec = twoModuleSpec();
  const frozen = buildDynamicAblationPlan(oneSpec, ["main"]);
  assert.ok(frozen);
  const wider = buildDynamicAblationPlan(twoSpec, ["main", "other"]);
  assert.ok(wider);
  expectCode(() => validateFrozenDynamicAblationPlan(frozen!, wider!), "ABLATION_WIDTH_FROZEN");
  const renamed = {
    ...frozen!,
    candidate_position_ids: ["other"],
  };
  const renamedWithHash: DynamicAblationPlan = {
    ...renamed,
    plan_sha256: canonicalJsonSha256(
      {
        schema_version: 1,
        width: 1,
        candidate_position_ids: ["other"],
        cells: renamed.cells,
        frozen: true,
      },
      undefined,
      { schemaVersion: "dynamic-ablation-plan-v1" },
    ),
  };
  expectCode(
    () => validateFrozenDynamicAblationPlan(frozen!, renamedWithHash),
    "ABLATION_WIDTH_FROZEN",
  );
  expectCode(
    () =>
      decideWave({
        workflow_spec: oneSpec,
        resource_inventory: resources(),
        frozen_matrix: frozen!,
        positions: [
          position("main", {
            resource_request: request("outside"),
            result_status: "not_executable",
          }),
        ],
      }),
    "rejected_incompatible",
  );

  const frozenTwo = buildDynamicAblationPlan(twoSpec, ["main", "other"]);
  assert.ok(frozenTwo);
  expectCode(
    () =>
      decideWave({
        workflow_spec: twoSpec,
        resource_inventory: resources(),
        frozen_matrix: frozenTwo!,
        constructible_cell_ids: ["00", "10", "01"],
        positions: [position("main"), position("other")],
      }),
    "rejected_incompatible",
  );
});

test("refund returns a settled child's balance before the next split and is replay-safe", () => {
  const initial = createBudgetLedger({ amount: 10, unit: "gpu_hours" });
  const split = splitChildBudget(initial, "child-a", 6);
  const refunded = refundChildBudget(split, "child-a", 1);
  assert.equal(refunded.available, 9);
  const next = splitChildBudget(refunded, "child-b", 9);
  assert.equal(next.available, 0);
  assert.deepEqual(refundChildBudget(refunded, "child-a", 1), refunded);

  const baseline = baselineFor(["main", "other"]);
  const resource = resources();
  const root = charter(baseline, resource);
  const input = {
    charter: root,
    baseline,
    resource_inventory: resource,
    workflow_spec: twoModuleSpec(),
    positions: [
      position("other", { child_run_id: "child-other", cost_actual: 0 }),
      position("main", {
        child_run_id: "child-main",
        resource_request: request("outside"),
        result_status: "not_executable",
        budget: 6,
        cost_actual: 1,
      }),
    ],
  } as const;
  const first = planExperimentBridge(bridgeFixture(input));
  const replay = planExperimentBridge(bridgeFixture({ ...input, positions: [...input.positions].reverse() }));
  assert.deepEqual(replay, first);
  const main = first.children.find((child) => child.position_id === "main")!;
  const other = first.children.find((child) => child.position_id === "other")!;
  assert.equal(main.result.status, "not_executable");
  assert.equal(first.matrix?.width, 1);
  assert.equal(
    first.downstream.find((route) => route.position_id === "main")!.status,
    "not_executable",
  );
  assert.equal(first.budget.allocations.some(entry => entry.execution_id === main.run_id), false);
  assert.equal(other.budget.amount, 10);
});

test("stop gate excludes not-executable and infra-unavailable waves, counts real matrix comparisons, and replays identically", () => {
  const exposure = { max_exposures_per_task: 4, reserved: 0, settled: 0, released: 0 };
  for (const status of ["not_executable", "infra_unavailable"] as const) {
    const nonExecutable = evaluateWorkflowStopGate({
      outer_run_id: "outer-a2-3",
      policy: noStopPolicy,
      cycle_summaries: [cycle(1)],
      // matrix_compared=true makes this probe reach the eligibility decision;
      // the status itself must still keep the wave out of the streak.
      result_packages: [{ status, matrix_compared: true, matrix_improved: false }],
      exposure,
    });
    assert.equal(nonExecutable.reason, "continue");
    assert.equal(nonExecutable.no_finalist_streak, 0);
  }

  const noComparedMatrix = evaluateWorkflowStopGate({
    outer_run_id: "outer-a2-3",
    policy: noStopPolicy,
    cycle_summaries: [cycle(1)],
    result_packages: [{ status: "succeeded", matrix_compared: false, matrix_improved: false }],
    exposure,
  });
  assert.equal(noComparedMatrix.reason, "continue");
  assert.equal(noComparedMatrix.no_finalist_streak, 0);

  const compared = evaluateWorkflowStopGate({
    outer_run_id: "outer-a2-3",
    policy: noStopPolicy,
    cycle_summaries: [cycle(1)],
    result_packages: [{ status: "succeeded", matrix_compared: true, matrix_improved: false }],
    exposure,
  });
  assert.equal(compared.reason, "no_finalist");
  assert.equal(compared.no_finalist_streak, 1);
  assert.deepEqual(
    evaluateWorkflowStopGate({
      outer_run_id: "outer-a2-3",
      policy: noStopPolicy,
      cycle_summaries: [cycle(1)],
      result_packages: [{ status: "succeeded", matrix_compared: true, matrix_improved: false }],
      exposure,
    }),
    compared,
  );
});

test("children use their own frozen measurement and hash actual experiment content", () => {
 const base=baselineFor(), resource=resources();
 const input=bridgeFixture({charter:charter(base,resource),baseline:base,resource_inventory:resource,positions:[position("main",{child_run_id:"child-local"})]});
 const first=planExperimentBridge(input).children[0]!;
 assert.deepEqual(first.charter.measurement,{validator_ref:"validator:main",tester_ref:"tester:main"});
 const second=planExperimentBridge({...input,positions:[{...input.positions[0]!,execution_plan:{method:"a different experiment"}}]}).children[0]!;
 assert.notEqual(first.execution_plan_sha256,second.execution_plan_sha256);
 assert.equal(first.execution_plan_sha256,canonicalJsonSha256(first.execution_plan));
 assert.notEqual(first.execution_plan_sha256,first.child_identity_sha256);
 for(const key of ["parent_run_id","scope_path","depth","outer_iteration","wave_id","wave_kind","generation"]) assert.equal(Object.hasOwn(first.charter,key),false);
});

test("wave-creation guard rejects tester exposure exhaustion", () => {
  expectCode(
    () => assertWaveCreationAllowed({ decision: "stop", reason: "tester_exposure_exhausted" }),
    "STOP_GATE_CLOSED",
  );
  assert.doesNotThrow(() =>
    assertWaveCreationAllowed({ decision: "continue", reason: "continue" }),
  );
});

test("default child run ids are opaque and explicit ids use run-id rules", () => {
  const childId = (parent: string, positionId: string, explicit?: string) => {
    const baseline = baselineFor([positionId]);
    const resource = resources();
    const plan = planExperimentBridge(bridgeFixture({
      charter: charter(baseline, resource, { run_id: parent }),
      baseline,
      resource_inventory: resource,
      positions: [position(positionId, explicit === undefined ? {} : { child_run_id: explicit })],
    }));
    return plan.children[0]!.run_id;
  };
  const first = childId("a", "b-c");
  assert.notEqual(first, childId("a", "b-c"));
  assert.match(first, /^run-[0-9a-f-]+$/);
  assert.notEqual(first, childId("a-b", "c"));
  assert.notEqual(childId("a", "b:c"), childId("a", "b-c"));
  assert.notEqual(childId("a", "b@c"), childId("a", "b:c"));
  for (const id of [first, childId("a".repeat(128), "b:c@d")]) {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  }
  assert.equal(childId("a", "b:c", "explicit-child"), "explicit-child");
  assert.equal(childId("a", "b", "x".repeat(121)), "x".repeat(121));
  for (const length of [122, 128]) {
    assert.throws(() => childId("a", "b", "x".repeat(length)), {
      code: "INVALID_RUN_ID",
      location: "child_run_id",
    });
  }
  for (const invalid of ["child:invalid", "child@invalid"]) {
    expectCode(() => childId("a", "b", invalid), "INVALID_RUN_ID");
  }
});

test("materialization creates children from a complete preflighted plan", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-3-materialize-"));
  try {
    const baseline = baselineFor();
    const resource = resources();
    const root = charter(baseline, resource);
    createRun({
      project_root: projectRoot,
      run_id: "root-a2-3",
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:a2-3",
    });
    const plan = planExperimentBridge(bridgeFixture({
      charter: root,
      baseline,
      resource_inventory: resource,
      positions: [position("main")],
    }));
    initializeRunBudget(projectRoot, plan.parent_run_id, {amount:10,unit:"gpu_hours"});
    const children = materializeBridgeChildren(projectRoot, plan);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.depth, 1);
    assert.equal(children[0]!.execution, undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("direct narrow child creation is rejected before it can write a run", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-direct-child-"));
  try {
    createRun({
      project_root: projectRoot,
      run_id: "root-direct",
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:a2-5",
    });

    // This is deliberately the old narrow shape. The cast models an
    // untyped JavaScript caller and proves the check is at runtime.
    const narrowInput = {
      project_root: projectRoot,
      run_id: "root-direct-child",
      parent_run_id: "root-direct",
      depth: 1,
      scope_path: "/root-direct-child",
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:a2-5",
    } as any;
    expectCode(() => createBridgeChildRun(narrowInput), "BRIDGE_EXPANSION_PLAN_REQUIRED");

    const runsRoot = path.join(projectRoot, ".aris", "runs");
    assert.deepEqual(fs.readdirSync(runsRoot), ["root-direct"]);
    assert.deepEqual(fs.readdirSync(path.join(runsRoot, "root-direct")), ["run.json"]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("materialization writes no child when a later child fails preflight", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-3-materialize-preflight-"));
  try {
    const baseline = baselineFor(["main", "other"]);
    const resource = resources();
    const root = charter(baseline, resource);
    createRun({
      project_root: projectRoot,
      run_id: "root-a2-3",
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:a2-3",
    });
    const plan = planExperimentBridge(bridgeFixture({
      charter: root,
      baseline,
      resource_inventory: resource,
      workflow_spec: twoModuleSpec(),
      positions: [position("main"), position("other")],
    }));
    const invalidChildren = plan.children.map((child) =>
      child.position_id === "other" ? { ...child, depth: 0 } : child,
    );
    const invalidPlanBase = {
      schema_version: plan.schema_version,
      parent_run_id: plan.parent_run_id,
      parent_depth: plan.parent_depth,
      strategy: plan.strategy,
      children: invalidChildren,
      budget: plan.budget,
      matrix: plan.matrix,
      downstream: plan.downstream,
    };
    const invalidPlan = {
      ...plan,
      children: invalidChildren,
      plan_sha256: canonicalJsonSha256(invalidPlanBase, undefined, {
        schemaVersion: "bridge-expansion-plan-v1",
      }),
    };
    expectCode(() => materializeBridgeChildren(projectRoot, invalidPlan), "IDENTITY_MISMATCH");
    const firstChild = plan.children.find((child) => child.position_id === "main")!;
    assert.equal(
      fs.existsSync(path.join(projectRoot, ".aris", "runs", firstChild.run_id, "run.json")),
      false,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("materialization requires the complete bridge expansion plan", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-incomplete-plan-"));
  try {
    const baseline = baselineFor();
    const resource = resources();
    createRun({
      project_root: projectRoot,
      run_id: "root-a2-3",
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:a2-3",
    });
    const plan = planExperimentBridge(bridgeFixture({
      charter: charter(baseline, resource),
      baseline,
      resource_inventory: resource,
      positions: [position("main")],
    }));
    const incompletePlan = structuredClone(plan) as unknown as Record<string, unknown>;
    delete incompletePlan.downstream;
    expectCode(
      () => materializeBridgeChildren(projectRoot, incompletePlan as never),
      "INVALID_EXPANSION",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, ".aris", "runs", plan.children[0]!.run_id, "run.json")),
      false,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("bridge child identity binds both parent and child run ids", () => {
  const baseline = baselineFor();
  const resource = resources();
  const sharedPosition = position("main", { child_run_id: "child-a2-5-shared" });
  const first = planExperimentBridge(bridgeFixture({
    charter: charter(baseline, resource, { run_id: "root-a2-5-first" }),
    baseline,
    resource_inventory: resource,
    positions: [sharedPosition],
  }));
  const second = planExperimentBridge(bridgeFixture({
    charter: charter(baseline, resource, { run_id: "root-a2-5-second" }),
    baseline,
    resource_inventory: resource,
    positions: [sharedPosition],
  }));
  const firstChild = { ...first.children[0]!, charter_sha256: HASH_A };
  const secondChild = { ...second.children[0]!, charter_sha256: HASH_A };
  assert.notEqual(
    computeBridgeChildIdentityHash(firstChild, first.strategy),
    computeBridgeChildIdentityHash(secondChild, second.strategy),
  );
  assert.notEqual(
    computeBridgeChildIdentityHash(firstChild, first.strategy),
    computeBridgeChildIdentityHash({ ...firstChild, run_id: "child-a2-5-other" }, first.strategy),
  );
});

test("materialization rejects a plan hash that no longer matches the plan", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-plan-hash-"));
  try {
    const baseline = baselineFor();
    const resource = resources();
    createRun({
      project_root: projectRoot,
      run_id: "root-a2-3",
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_C,
      execution_plan_sha256: HASH_B,
      code_baseline_sha256: HASH_A,
      policy_revision: "policy:a2-3",
    });
    const plan = planExperimentBridge(bridgeFixture({
      charter: charter(baseline, resource),
      baseline,
      resource_inventory: resource,
      positions: [position("main")],
    }));
    expectCode(
      () => materializeBridgeChildren(projectRoot, { ...plan, plan_sha256: "0".repeat(64) }),
      "IDENTITY_MISMATCH",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, ".aris", "runs", plan.children[0]!.run_id, "run.json")),
      false,
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("zero balance still records resource-free positions without allocating funds", () => {
 const base=baselineFor(), resource=resources();
 const input=bridgeFixture({charter:charter(base,resource,{budget:{amount:0,unit:"gpu_hours"}}),baseline:base,resource_inventory:resource,positions:[position("main")]});
 expectCode(()=>planExperimentBridge(input),"BUDGET_EXHAUSTED");
 const result=planExperimentBridge({...input,positions:[{...input.positions[0]!,resource_request:{...request(),accelerator_count:99}}]});
 assert.equal(result.children[0]!.result.status,"not_executable");
 assert.deepEqual(result.budget.allocations,[]);
});
