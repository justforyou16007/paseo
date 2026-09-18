import { createRootRun, ensureRun } from "../src/tools/run-contract.js";
import assert from "node:assert/strict";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildTesterDefinition } from "../src/tools/tester-state.js";
import {
  commitPromotionAtomically,
  validateIncumbentSnapshot,
  resolveModelAssignment,
  type IncumbentSnapshot,
} from "../src/tools/model-assignment.js";
import { createArtifactRegistry } from "../src/tools/artifact-registry.js";
import {
  assertParallelModuleSet,
  buildAblationPlan,
  buildAblationPlanIdentity,
  candidateIdFromSnapshot,
  compileWorkflow,
  pathForCompiledCandidate,
  validateCompleteAblationPlan,
} from "../src/tools/workflow-compiler.js";
import {
  createTaskSetup,
  loadTaskSetup,
  loadModelUsagePolicyRevision,
  modelUsagePolicyPath,
  saveTaskSetup,
  taskSetupPath,
} from "../src/tools/task-setup.js";
import {
  readFrozenPolicy,
  saveFrozenPolicy,
  writeCycleFile,
  readCycleFile,
} from "../src/tools/workflow-state.js";
import { validateWorkflowSpec, type WorkflowSpec } from "../src/tools/workflow-spec.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a1-workflow-model-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function policy(confirmed = true): Record<string, unknown> {
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
        user_confirmed: confirmed,
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
  inputs: string[],
  outputs: string[],
  scope = `src/${id}/**`,
): Record<string, unknown> {
  return {
    id,
    evolvable: true,
    version: `${id}:v1`,
    patch_sha256: HASH_A,
    inputs,
    outputs,
    write_scope: [scope],
    local_metric: `${id}_score`,
    execution: { max_jobs: 1, max_compute: { amount: 1, unit: "gpu_hours" } },
  };
}

function rawSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const defaultModules = [
    moduleSpec("a", [], ["x@1"]),
    moduleSpec("b", ["x@1"], ["y@1"]),
    moduleSpec("c", ["x@1"], ["z@1"]),
    moduleSpec("d", ["x@1"], ["y@1"]),
    moduleSpec("e", ["x@1"], ["x@1"]),
  ];
  const modules = overrides.modules ?? defaultModules;
  const enabledModuleIds =
    overrides.enabled_module_ids ??
    (Array.isArray(modules)
      ? modules
          .map((module) => (module as Record<string, unknown>).id)
          .filter((moduleId) => moduleId !== "e")
      : []);
  return {
    schema_version: 1,
    task_id: "task:a1",
    workflow_id: "workflow:a1",
    revision: "flow:r1",
    objective: { primary: { name: "score", direction: "higher_better" }, constraints: [] },
    task_setup_revision: "setup:r1",
    model_usage_policy: policy(),
    validation_policy: {
      scorer_id: "rules",
      scorer_revision_binding: "from_active_scorer_pointer",
      research_feedback: "detailed",
      cross_judge_score_comparison: "forbidden",
    },
    scorers: [
      {
        id: "rules",
        kind: "deterministic_rules",
        definition_binding: "from_active_scorer_revision",
        judge_binding: null,
      },
    ],
    promotion_tester: {
      tester_id: "tester:fixed",
      definition_version: "tester:v1",
      research_feedback: "fuzzy_advice_only",
      max_exposures_per_task: 2,
    },
    wave_policy: {
      max_parallel_modules: 2,
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
      revision: "limits:r1",
      max_nodes: 10,
      max_edges: 20,
      max_fan_out_per_node: 4,
      max_unrolled_cycles: 2,
      max_jobs_per_candidate: 20,
      max_compute_per_candidate: { amount: 20, unit: "gpu_hours" },
    },
    modules,
    enabled_module_ids: enabledModuleIds,
    edges: [{ from: "a.out", to: "b.in", contract: "x@1" }],
    feedback_edges: [],
    cycles: [],
    ...overrides,
  };
}

function incumbent(): IncumbentSnapshot {
  return {
    candidate_id: "candidate:incumbent",
    generation: 1,
    role_artifacts: [{ role_id: "main-model", artifact_id: "artifact:main-v1", generation: 1 }],
  };
}

function candidateSnapshotFor(
  spec: WorkflowSpec,
  graph: { nodes: string[]; edges: WorkflowSpec["edges"] } = {
    nodes: [...spec.enabled_module_ids],
    edges: spec.edges,
  },
): Record<string, unknown> {
  const modules = new Map(spec.module_catalog.map((module) => [module.id, module]));
  const nodes = graph.nodes.map((moduleId) => {
    const module = modules.get(moduleId);
    assert.ok(module, `test graph module ${moduleId} must be in the catalog`);
    return {
      module_id: module.id,
      version: module.version ?? "catalog",
      input_ports: [...(module.input_ports ?? [])],
      output_ports: [...(module.output_ports ?? [])],
    };
  });
  const activeNodeIds = new Set(graph.nodes);
  const modelAssignments = spec.model_usage_policy.roles
    .filter(
      (role) =>
        role.allowed_uses.some((use) => use !== "judge") &&
        role.allowed_modules.some((moduleId) => activeNodeIds.has(moduleId)),
    )
    .map((role) => ({
      role_id: role.role_id,
      module_ids: graph.nodes.filter((moduleId) => role.allowed_modules.includes(moduleId)),
      uses: role.allowed_uses.filter((use) => use !== "judge"),
      artifact_id: "artifact:" + role.role_id,
      judge_targets: [],
      resolved_from: role.artifact_binding.source,
      generation: 1,
    }));
  return {
    schema_version: 1,
    workflow_revision: spec.revision,
    parent_candidate_id: null,
    module_versions: nodes.map((node) => ({
      module_id: node.module_id,
      version: node.version,
      patch_sha256: modules.get(node.module_id)!.patch_sha256 ?? HASH_A,
      input_artifact_ids: [],
      code_paths: [`src/${node.module_id}.ts`],
    })),
    input_artifact_ids: [],
    model_assignments: modelAssignments,
    finite_cycles: 0,
    random_seed: "seed:a1",
    owner_limits: spec.owner_limits,
    execution_graph: {
      nodes,
      edges: graph.edges.map((edge) => ({ ...edge })),
      feedback_edges: spec.feedback_edges.map((edge) => ({ ...edge })),
    },
    patch_paths: [],
    output_artifact_ids: [],
  };
}

function testerDefinition() {
  return buildTesterDefinition({
    schema_version: 1,
    tester_id: "tester:fixed",
    version: "tester:v1",
    immutable: true,
    case_manifest_id: "cases:v1",
    case_manifest_sha256: HASH_A,
    seed_manifest_sha256: HASH_B,
    harness_sha256: HASH_A,
    research_feedback: "fuzzy_advice_only",
    max_exposures_per_task: 2,
    comparison: "paired_matching_baseline_vs_finalist",
    gate: {
      primaries: [{ name: "score", direction: "higher_better", improvement: { policy: "relative", minimum_gain: 0.01 } }],
      paired_delta: "finalist_minus_matching_baseline",
      statistics: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 3 },
      case_aggregation: "mean_of_complete_case_set",
      repeat_aggregation: "lower_confidence_bound",
      tie_policy: "reject_finalist",
      missing_result_policy: "fail_closed",
      constraints: [],
      workflow_constraints: "must_also_pass",
    },
    scoring: [{ kind: "deterministic_rules", definition_version: "rules:v1", judge_binding: null }],
  });
}

function registerArtifact(
  registry: ReturnType<typeof createArtifactRegistry>,
  input: {
    artifact_id: string;
    source_type: "workflow_output" | "fixed_external";
    producer_run_id?: string | null;
    candidate_id?: string | null;
    generation?: number | null;
    role_id?: string | null;
    output_slot?: string | null;
    input_artifact_ids?: string[];
  },
): void {
  registry.register({
    schema_version: 1,
    artifact_id: input.artifact_id,
    contract: "model@1",
    uri: `memory:${input.artifact_id}`,
    sha256: HASH_A,
    producer_module: input.source_type === "fixed_external" ? "external" : "main",
    producer_version: "v1",
    producer_run_id: input.producer_run_id ?? null,
    candidate_id: input.candidate_id ?? null,
    input_artifact_ids: input.input_artifact_ids ?? [],
    status: "sealed",
    generation: input.generation ?? null,
    role_id: input.role_id ?? null,
    output_slot: input.output_slot ?? null,
    source_type: input.source_type,
    file_path: null,
  });
}


const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

test("未确认的模型角色不能进入可执行 workflow，setup 不接受 benchmark 维度", () => {
  expectCode(
    () => validateWorkflowSpec(rawSpec({ model_usage_policy: policy(false) })),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:a1",
        workflow_id: "workflow:a1",
        setup_revision: "setup:unconfirmed",
        model_usage_policy: policy(false),
        tester_id: "tester:fixed",
        tester_version: "tester:v1",
      }),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:a1",
        workflow_id: "workflow:a1",
        setup_revision: "setup:benchmark",
        model_usage_policy: { ...policy(), benchmark_coverage: ["new-dimension"] },
        tester_id: "tester:fixed",
        tester_version: "tester:v1",
      }),
    "UNKNOWN_FIELD",
  );
});

test("resolver拒绝agent Artifact选择、缺registry和越权角色请求", () => {
  const base = {
    policy: policy() as never,
    task_setup_revision: "setup:r1",
    outer_run_id: "outer-1",
    outer_iteration: 1,
    incumbent: incumbent(),
  };
  expectCode(
    () =>
      resolveModelAssignment({
        ...base,
        requested_artifact_ids: { "main-model": "artifact:main-v1" },
      }),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  expectCode(
    () => resolveModelAssignment({ ...base, candidate_lineage: new Map() } as never),
    "UNKNOWN_FIELD",
  );
  expectCode(() => resolveModelAssignment(base), "ARTIFACT_REGISTRY_REQUIRED");
  expectCode(
    () =>
      resolveModelAssignment({
        ...base,
        requested_roles: [{ role_id: "main-model", allowed_uses: ["judge"] }],
        candidate: {
          candidate_artifact_ids: ["artifact:candidate"],
          candidate_output_artifact_ids: ["artifact:output"],
          target_generations: { "main-model.next": 2 },
        },
      }),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  expectCode(
    () =>
      resolveModelAssignment({
        ...base,
        requested_roles: [{ role_id: "unapproved-role" }],
        candidate: {
          candidate_artifact_ids: ["artifact:candidate"],
          candidate_output_artifact_ids: ["artifact:output"],
          target_generations: { "main-model.next": 2 },
        },
      }),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
});

test("fixed external judge必须来自registry，伪造lineage和空external都失败", () => {
  const emptyExternal = policy();
  (emptyExternal.roles as Array<Record<string, unknown>>)[1]!.artifact_binding = "fixed_external";
  expectCode(
    () => validateWorkflowSpec(rawSpec({ model_usage_policy: emptyExternal })),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  const pinnedPrevious = policy();
  (pinnedPrevious.roles as Array<Record<string, unknown>>)[0]!.artifact_binding = {
    source: "previous_promoted",
    artifact_id: "artifact:pinned",
  };
  expectCode(
    () => validateWorkflowSpec(rawSpec({ model_usage_policy: pinnedPrevious })),
    "MODEL_SCOPE_ALIGNMENT_REQUIRED",
  );
  const fixed = policy();
  const roles = fixed.roles as Array<Record<string, unknown>>;
  roles[1]!.artifact_binding = { source: "fixed_external", artifact_id: "artifact:external" };
  const input = {
    policy: fixed as never,
    task_setup_revision: "setup:r1",
    outer_run_id: "outer-1",
    outer_iteration: 1,
    incumbent: incumbent(),
    candidate: {
      candidate_id: "candidate:current",
      producer_run_id: "outer-1",
      candidate_artifact_ids: ["artifact:candidate"],
      candidate_output_artifact_ids: ["artifact:candidate"],
      target_generations: { "main-model.next": 2 },
    },
  };
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:a1",
        workflow_id: "workflow:a1",
        setup_revision: "setup:fixed-no-registry",
        model_usage_policy: fixed,
        tester_id: "tester:fixed",
        tester_version: "tester:v1",
      }),
    "ARTIFACT_REGISTRY_REQUIRED",
  );
  expectCode(
    () =>
      createTaskSetup({
        task_id: "task:a1",
        workflow_id: "workflow:a1",
        setup_revision: "setup:forged-lineage",
        model_usage_policy: policy(),
        tester_id: "tester:fixed",
        tester_version: "tester:v1",
        validation: { candidate_lineage: new Map() } as never,
      }),
    "UNKNOWN_FIELD",
  );
  expectCode(() => resolveModelAssignment(input), "ARTIFACT_REGISTRY_REQUIRED");
  expectCode(
    () =>
      resolveModelAssignment({
        ...input,
        candidate: { ...input.candidate, candidate_lineage: new Map([["artifact:external", []]]) },
        registry: undefined,
      } as never),
    "UNKNOWN_FIELD",
  );
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-1" });
    const registry = createArtifactRegistry(root, "outer-1");
    registerArtifact(registry, {
      artifact_id: "artifact:main-v1",
      source_type: "fixed_external",
      generation: 1,
    });
    registerArtifact(registry, {
      artifact_id: "artifact:external",
      source_type: "fixed_external",
      generation: 100,
    });
    registerArtifact(registry, {
      artifact_id: "artifact:candidate",
      source_type: "workflow_output",
      producer_run_id: "outer-1",
      candidate_id: "candidate:current",
      generation: 2,
      role_id: "main-model",
      output_slot: "main.model",
    });
    const fixedSetup = createTaskSetup({
      task_id: "task:a1",
      workflow_id: "workflow:a1",
      setup_revision: "setup:fixed-registered",
      model_usage_policy: fixed,
      tester_id: "tester:fixed",
      tester_version: "tester:v1",
      validation: { registry },
    });
    assert.equal(fixedSetup.model_usage_policy.roles[1]!.artifact_binding.source, "fixed_external");
    expectCode(
      () =>
        registerArtifact(registry, {
          artifact_id: "artifact:pretend-external",
          source_type: "fixed_external",
          candidate_id: "candidate:current",
        }),
      "INVALID_ARTIFACT",
    );
    expectCode(
      () => registry.assertFixedExternal("artifact:candidate"),
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
    );
    registerArtifact(registry, {
      artifact_id: "artifact:derived-external",
      source_type: "fixed_external",
      input_artifact_ids: ["artifact:candidate"],
    });
    const derivedPolicy = policy();
    (derivedPolicy.roles as Array<Record<string, unknown>>)[1]!.artifact_binding = {
      source: "fixed_external",
      artifact_id: "artifact:derived-external",
    };
    expectCode(
      () =>
        resolveModelAssignment({
          ...input,
          policy: derivedPolicy as never,
          registry,
        }),
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
    );
    expectCode(
      () => registry.assertNoSelfEvaluation(["artifact:missing"], ["artifact:external"]),
      "ARTIFACT_NOT_FOUND",
    );
    registerArtifact(registry, {
      artifact_id: "artifact:future-candidate",
      source_type: "workflow_output",
      producer_run_id: "outer-1",
      candidate_id: "candidate:future",
      generation: 3,
      role_id: "main-model",
      output_slot: "main.model",
    });
    expectCode(
      () =>
        resolveModelAssignment({
          ...input,
          candidate: {
            ...input.candidate,
            candidate_id: "candidate:future",
            candidate_artifact_ids: ["artifact:future-candidate"],
            candidate_output_artifact_ids: ["artifact:future-candidate"],
            target_generations: { "main-model.next": 3 },
          },
          registry,
        }),
      "GENERATION_MISMATCH",
    );
    const first = resolveModelAssignment({ ...input, registry });
    const second = resolveModelAssignment({ ...input, registry });
    assert.deepEqual(first, second);
  } finally {
    cleanup(root);
  }
});

test("policy revision独立封存，task setup和frozen policy按revision/hash恢复", () => {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-1" });
    const setup = saveTaskSetup(root, {
      task_id: "task:a1",
      workflow_id: "workflow:a1",
      setup_revision: "setup:r1",
      model_usage_policy: policy(),
      tester_id: "tester:fixed",
      tester_version: "tester:v1",
    });
    const policyPath = modelUsagePolicyPath(root, "workflow:a1", "policy:r1");
    const setupPath = taskSetupPath(root, "workflow:a1", "setup:r1");
    assert.equal(fs.existsSync(policyPath), true);
    assert.equal(fs.existsSync(setupPath), true);
    assert.equal(
      loadModelUsagePolicyRevision(root, "workflow:a1", "policy:r1").policy_sha256,
      setup.policy_sha256,
    );
    assert.deepEqual(loadTaskSetup(root, "workflow:a1", "setup:r1"), setup);

    const frozen = saveFrozenPolicy({
      project_root: root,
      outer_run_id: "outer-1",
      task_id: "task:a1",
      owner_limits: validateWorkflowSpec(rawSpec()).owner_limits,
      task_setup_revision: setup.setup_revision,
      task_setup: setup,
      model_usage_policy_revision: setup.model_usage_policy.revision,
      model_usage_policy: setup.model_usage_policy,
      tester_id: "tester:fixed",
      tester_version: "tester:v1",
      tester_definition: testerDefinition(),
      incumbent_candidate_id: "candidate:incumbent",
      incumbent_generation: 1,
      incumbent: incumbent(),
    });
    fs.rmSync(policyPath);
    fs.rmSync(setupPath);
    const activePointerDir = path.join(root, ".aris", "workflows", "workflow:a1");
    fs.mkdirSync(activePointerDir, { recursive: true });
    fs.writeFileSync(
      path.join(activePointerDir, "active-policy.json"),
      '{"revision":"policy:changed"}\n',
    );
    fs.writeFileSync(
      path.join(activePointerDir, "active-task-setup.json"),
      '{"revision":"setup:changed"}\n',
    );
    const resumed = readFrozenPolicy(root, "outer-1");
    assert.equal(resumed.model_usage_policy_sha256, frozen.model_usage_policy_sha256);
    assert.deepEqual(resumed.task_setup, setup);
    assert.deepEqual(resumed.model_usage_policy, setup.model_usage_policy);
    assert.deepEqual(resumed.owner_limits, frozen.owner_limits);
  } finally {
    cleanup(root);
  }
});

test("cycle关键文件同内容幂等、不同内容冲突且不被覆盖", () => {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-1" });
    writeCycleFile(root, "outer-1", 1, "wave.json", { semantic: "S0", count: 1 });
    writeCycleFile(root, "outer-1", 1, "wave.json", { count: 1, semantic: "S0" });
    expectCode(
      () => writeCycleFile(root, "outer-1", 1, "wave.json", { semantic: "S1", count: 1 }),
      "IMMUTABLE_CONFLICT",
    );
    assert.deepEqual(readCycleFile(root, "outer-1", 1, "wave.json"), { semantic: "S0", count: 1 });
  } finally {
    cleanup(root);
  }
});

test("fan_out和fan_in改真实边集合，reorder缺重连直接拒绝", () => {
  const fanSpec = validateWorkflowSpec(rawSpec());
  const fanOut = compileWorkflow(fanSpec, {
    wave_kind: "structure",
    structure_actions: [
      {
        op: "fan_out",
        module_id: "a",
        source: "a.out",
        contract: "x@1",
        branches: [
          { to: "b.in", contract: "x@1" },
          { to: "c.in", contract: "x@1" },
        ],
        remove_edges: ["a.out->b.in"],
      },
    ],
  });
  assert.equal(fanOut.summary.edge_count, 2);
  assert.equal(fanOut.summary.max_fan_out, 2);
  assert.deepEqual(fanOut.execution_order.slice(0, 1), ["a"]);

  const fanInSpec = validateWorkflowSpec(
    rawSpec({
      modules: [
        moduleSpec("a", [], ["x@1"]),
        moduleSpec("b", [], ["x@1"]),
        { ...moduleSpec("c", ["x@1"], ["z@1"]), input_cardinality: { in: "many" } },
      ],
      edges: [{ from: "a.out", to: "c.in", contract: "x@1" }],
      model_usage_policy: {
        ...policy(),
        roles: [
          {
            ...(policy().roles as Array<Record<string, unknown>>)[0]!,
            allowed_modules: ["a", "b", "c"],
          },
          (policy().roles as Array<Record<string, unknown>>)[1],
        ],
      },
    }),
  );
  const fanIn = compileWorkflow(fanInSpec, {
    wave_kind: "structure",
    structure_actions: [
      {
        op: "fan_in",
        module_id: "c",
        target: "c.in",
        contract: "x@1",
        sources: [
          { from: "a.out", contract: "x@1" },
          { from: "b.out", contract: "x@1" },
        ],
        remove_edges: ["a.out->c.in"],
      },
    ],
  });
  assert.equal(fanIn.summary.edge_count, 2);
  const reorderSpec = validateWorkflowSpec(
    rawSpec({
      modules: [
        moduleSpec("a", [], ["x@1"]),
        moduleSpec("b", ["x@1"], ["y@1"]),
        moduleSpec("c", [], ["x@1"]),
      ],
      edges: [{ from: "a.out", to: "b.in", contract: "x@1" }],
      model_usage_policy: {
        ...policy(),
        roles: [
          {
            ...(policy().roles as Array<Record<string, unknown>>)[0]!,
            allowed_modules: ["a", "b", "c"],
          },
          (policy().roles as Array<Record<string, unknown>>)[1],
        ],
      },
    }),
  );
  const reordered = compileWorkflow(reorderSpec, {
    wave_kind: "structure",
    structure_actions: [
      {
        op: "reorder",
        module_id: "c",
        before_module_id: "b",
        reconnections: {
          remove_edges: ["a.out->b.in"],
          add_edges: [{ from: "c.out", to: "b.in", contract: "x@1" }],
        },
      },
    ],
  });
  assert.ok(reordered.execution_order.indexOf("c") < reordered.execution_order.indexOf("b"));
  expectCode(
    () =>
      compileWorkflow(fanSpec, {
        wave_kind: "structure",
        structure_actions: [{ op: "reorder", module_id: "b", before_module_id: "a" }] as never,
      }),
    "INVALID_STRUCTURE_DELTA",
  );
  expectCode(
    () =>
      compileWorkflow(reorderSpec, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "reorder",
            module_id: "c",
            before_module_id: "b",
            reconnections: {
              remove_edges: ["a.out->b.in"],
              add_edges: [{ from: "a.out", to: "b.in", contract: "x@1" }],
            },
          },
        ],
      }),
    "INVALID_STRUCTURE_DELTA",
  );
  expectCode(
    () =>
      compileWorkflow(fanSpec, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "fan_out",
            module_id: "a",
            source: "a.out",
            contract: "wrong@1",
            branches: [
              { to: "b.in", contract: "wrong@1" },
              { to: "c.in", contract: "wrong@1" },
            ],
            remove_edges: ["a.out->b.in"],
          },
        ],
      }),
    "CONTRACT_MISMATCH",
  );
});

test("目录与启用集合决定最终图，insert、replace、remove都重新校验重连", () => {
  const catalogSpec = validateWorkflowSpec(rawSpec({ enabled_module_ids: ["a", "b"] }));
  const unchanged = compileWorkflow(catalogSpec, { wave_kind: "module" });
  assert.deepEqual(
    unchanged.execution_graph.nodes.map((node) => node.module_id),
    ["a", "b"],
  );
  assert.equal(unchanged.summary.node_count, 2);
  expectCode(
    () =>
      validateWorkflowSpec(
        rawSpec({
          enabled_module_ids: ["a", "b"],
          edges: [{ from: "a.out", to: "e.in", contract: "x@1" }],
        }),
      ),
    "INVALID_EDGE",
  );
  expectCode(() => assertParallelModuleSet(catalogSpec, ["e"]), "INACTIVE_MODULE");

  const inserted = compileWorkflow(catalogSpec, {
    wave_kind: "structure",
    structure_actions: [
      {
        op: "insert_module",
        edge: "a.out->b.in",
        module_id: "e",
        input_port: "in",
        output_port: "out",
        contract: "x@1",
      },
    ],
  });
  assert.deepEqual(
    inserted.execution_graph.nodes.map((node) => node.module_id),
    ["a", "b", "e"],
  );
  assert.deepEqual(
    inserted.execution_graph.edges.map((edge) => `${edge.from}->${edge.to}`),
    ["a.out->e.in", "e.out->b.in"],
  );

  const replaced = compileWorkflow(catalogSpec, {
    wave_kind: "structure",
    structure_actions: [{ op: "replace_module", module_id: "b", replacement_module_id: "d" }],
  });
  assert.deepEqual(
    replaced.execution_graph.nodes.map((node) => node.module_id),
    ["a", "d"],
  );
  assert.deepEqual(replaced.execution_graph.edges, [
    { from: "a.out", to: "d.in", contract: "x@1" },
  ]);

  const removePolicy = policy();
  (removePolicy.roles as Array<Record<string, unknown>>)[0]!.allowed_modules = ["a", "b", "c"];
  const removeSpec = validateWorkflowSpec(
    rawSpec({
      modules: [
        moduleSpec("a", [], ["x@1"]),
        moduleSpec("b", ["x@1"], ["x@1"]),
        moduleSpec("c", ["x@1"], ["z@1"]),
      ],
      enabled_module_ids: ["a", "b", "c"],
      model_usage_policy: removePolicy,
      edges: [
        { from: "a.out", to: "b.in", contract: "x@1" },
        { from: "b.out", to: "c.in", contract: "x@1" },
      ],
    }),
  );
  const removed = compileWorkflow(removeSpec, {
    wave_kind: "structure",
    structure_actions: [
      {
        op: "remove_module",
        module_id: "b",
        reconnections: {
          remove_edges: ["a.out->b.in", "b.out->c.in"],
          add_edges: [{ from: "a.out", to: "c.in", contract: "x@1" }],
        },
      },
    ],
  });
  assert.deepEqual(
    removed.execution_graph.nodes.map((node) => node.module_id),
    ["a", "c"],
  );
  assert.deepEqual(removed.execution_graph.edges, [{ from: "a.out", to: "c.in", contract: "x@1" }]);
  expectCode(
    () =>
      compileWorkflow(removeSpec, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "remove_module",
            module_id: "b",
            reconnections: {
              remove_edges: ["a.out->b.in"],
              add_edges: [{ from: "a.out", to: "c.in", contract: "x@1" }],
            },
          },
        ],
      }),
    "INVALID_STRUCTURE_DELTA",
  );
  expectCode(
    () =>
      compileWorkflow(removeSpec, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "remove_module",
            module_id: "b",
            reconnections: {
              remove_edges: ["a.out->b.in", "b.out->c.in"],
              add_edges: [
                { from: "a.out", to: "c.in", contract: "x@1" },
                { from: "c.out", to: "a.in", contract: "z@1" },
              ],
            },
          },
        ],
      }),
    "CONTRACT_MISMATCH",
  );
  expectCode(
    () =>
      compileWorkflow(removeSpec, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "remove_module",
            module_id: "b",
            reconnections: {
              remove_edges: ["a.out->b.in", "b.out->c.in"],
              add_edges: [],
            },
          },
        ],
      }),
    "INVALID_STRUCTURE_DELTA",
  );

  const cycleSpec = validateWorkflowSpec(
    rawSpec({
      modules: [
        moduleSpec("a", ["z@1"], ["x@1"]),
        moduleSpec("b", ["x@1"], ["x@1"]),
        moduleSpec("c", ["x@1"], ["z@1"]),
      ],
      enabled_module_ids: ["a", "b", "c"],
      model_usage_policy: removePolicy,
      edges: [
        { from: "a.out", to: "b.in", contract: "x@1" },
        { from: "b.out", to: "c.in", contract: "x@1" },
      ],
    }),
  );
  expectCode(
    () =>
      compileWorkflow(cycleSpec, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "remove_module",
            module_id: "b",
            reconnections: {
              remove_edges: ["a.out->b.in", "b.out->c.in"],
              add_edges: [
                { from: "a.out", to: "c.in", contract: "x@1" },
                { from: "c.out", to: "a.in", contract: "z@1" },
              ],
            },
          },
        ],
      }),
    "WORKFLOW_CYCLE",
  );

  const limited = validateWorkflowSpec(
    rawSpec({
      enabled_module_ids: ["a", "b"],
      owner_limits: { ...catalogSpec.owner_limits, max_nodes: 2 },
    }),
  );
  expectCode(
    () =>
      compileWorkflow(limited, {
        wave_kind: "structure",
        structure_actions: [
          {
            op: "insert_module",
            edge: "a.out->b.in",
            module_id: "e",
            input_port: "in",
            output_port: "out",
            contract: "x@1",
          },
        ],
      }),
    "rejected_limit",
  );
});

test("candidate身份包含规范化最终图，等价顺序相同而不同图不同", () => {
  const spec = validateWorkflowSpec(rawSpec());
  const first = candidateSnapshotFor(spec);
  const runtimeVariant = {
    ...first,
    run_id: "run-retry",
    attempt_id: "attempt:9",
    wave_id: "wave:other",
    status: "failed",
    output_artifact_ids: ["artifact:ignored"],
    scorer_revision: "scorer:other",
    judge_binding_id: "judge:other",
    tester_result_id: "tester:other",
    receipt_id: "receipt:other",
    created_at: "2027-01-01T00:00:00Z",
  };
  assert.equal(candidateIdFromSnapshot(first), candidateIdFromSnapshot(runtimeVariant));
  const graph = first.execution_graph as Record<string, unknown>;
  const equivalentOrder = {
    ...first,
    module_versions: [...(first.module_versions as unknown[])].reverse(),
    execution_graph: {
      nodes: [...(graph.nodes as unknown[])].reverse(),
      edges: [...(graph.edges as unknown[])].reverse(),
    },
  };
  assert.equal(candidateIdFromSnapshot(first), candidateIdFromSnapshot(equivalentOrder));
  expectCode(() => candidateIdFromSnapshot({ ...first, unknown: true }), "UNKNOWN_FIELD");
  expectCode(
    () => candidateIdFromSnapshot({ ...first, random_seed: Number.NaN }),
    "INVALID_CANDIDATE",
  );
  expectCode(
    () => candidateIdFromSnapshot({ ...first, patch_paths: ["/absolute/path.ts"] }),
    "PATH_ESCAPE",
  );
  expectCode(
    () => candidateIdFromSnapshot({ ...first, workflow_revision: "e\u0301" }),
    "INVALID_UNICODE",
  );

  const differentGraph = candidateSnapshotFor(spec, {
    nodes: [...spec.enabled_module_ids],
    edges: [{ from: "a.out", to: "c.in", contract: "x@1" }],
  });
  assert.notEqual(candidateIdFromSnapshot(first), candidateIdFromSnapshot(differentGraph));

  const structureSpec = validateWorkflowSpec(rawSpec({ enabled_module_ids: ["a", "b"] }));
  const inserted = compileWorkflow(structureSpec, {
    wave_kind: "structure",
    structure_actions: [
      {
        op: "insert_module",
        edge: "a.out->b.in",
        module_id: "e",
        input_port: "in",
        output_port: "out",
        contract: "x@1",
      },
    ],
  });
  const insertedCandidate = candidateSnapshotFor(structureSpec, {
    nodes: ["a", "e", "b"],
    edges: inserted.execution_graph.edges,
  });
  const sameFinalGraph = candidateSnapshotFor(structureSpec, {
    nodes: ["b", "e", "a"],
    edges: [...inserted.execution_graph.edges].reverse(),
  });
  assert.equal(candidateIdFromSnapshot(insertedCandidate), candidateIdFromSnapshot(sameFinalGraph));
});

test("compileWorkflow拒绝candidate与被检查spec、限制或最终图不一致", () => {
  const spec = validateWorkflowSpec(rawSpec());
  const candidate = candidateSnapshotFor(spec);
  const compiled = compileWorkflow(spec, { candidate: candidate as never });
  assert.equal(compiled.candidate_id, candidateIdFromSnapshot(candidate));
  const compiledRoot = tempDir();
  try {
    createRootRun({ project_root: compiledRoot, run_id: "run-path" });
    assert.match(
      pathForCompiledCandidate(compiledRoot, "run-path", 1, compiled.candidate_id, candidate),
      new RegExp(String(compiled.candidate_id) + "$"),
    );
    expectCode(
      () => pathForCompiledCandidate(compiledRoot, "run-path", 1, "candidate:wrong", candidate),
      "CANDIDATE_IDENTITY_MISMATCH",
    );
  } finally {
    cleanup(compiledRoot);
  }

  const changedRevision = validateWorkflowSpec(rawSpec({ revision: "flow:r2" }));
  expectCode(
    () => compileWorkflow(changedRevision, { candidate: candidate as never }),
    "CANDIDATE_SPEC_MISMATCH",
  );
  const changedLimits = validateWorkflowSpec(
    rawSpec({
      owner_limits: { ...spec.owner_limits, revision: "limits:r2" },
    }),
  );
  expectCode(
    () => compileWorkflow(changedLimits, { candidate: candidate as never }),
    "CANDIDATE_SPEC_MISMATCH",
  );
  const changedGraph = validateWorkflowSpec(
    rawSpec({ edges: [{ from: "a.out", to: "c.in", contract: "x@1" }] }),
  );
  expectCode(
    () => compileWorkflow(changedGraph, { candidate: candidate as never }),
    "CANDIDATE_GRAPH_MISMATCH",
  );
  expectCode(
    () => compileWorkflow(spec, { unrolled_cycles: 1, candidate: candidate as never }),
    "CANDIDATE_SPEC_MISMATCH",
  );

  const versionModules = (rawSpec().modules as Array<Record<string, unknown>>).map((module) =>
    module.id === "a" ? { ...module, version: "a:v2" } : module,
  );
  const changedVersion = validateWorkflowSpec(rawSpec({ modules: versionModules }));
  expectCode(
    () => compileWorkflow(changedVersion, { candidate: candidate as never }),
    "CANDIDATE_GRAPH_MISMATCH",
  );
  const patchModules = (rawSpec().modules as Array<Record<string, unknown>>).map((module) =>
    module.id === "a" ? { ...module, patch_sha256: HASH_B } : module,
  );
  const changedPatch = validateWorkflowSpec(rawSpec({ modules: patchModules }));
  expectCode(
    () => compileWorkflow(changedPatch, { candidate: candidate as never }),
    "CANDIDATE_GRAPH_MISMATCH",
  );
});

test("反馈依赖、宽度上限和完整消融不能由调用者缩小", () => {
  const feedbackSpec = validateWorkflowSpec(
    rawSpec({
      edges: [],
      feedback_edges: [{ from: "a.out", to: "b.in", barrier: "next_outer_iteration" }],
    }),
  );
  expectCode(() => assertParallelModuleSet(feedbackSpec, ["a", "b"]), "MODULE_DEPENDENCY_CONFLICT");
  expectCode(() => assertParallelModuleSet(feedbackSpec, ["a", "b", "c"]), "INVALID_WAVE_POLICY");
  const transitiveFeedbackSpec = validateWorkflowSpec(
    rawSpec({
      modules: [
        moduleSpec("a", [], ["x@1"]),
        moduleSpec("b", ["x@1"], ["y@1"]),
        moduleSpec("c", ["y@1"], ["z@1"]),
      ],
      enabled_module_ids: ["a", "b", "c"],
      model_usage_policy: {
        ...policy(),
        roles: [
          {
            ...(policy().roles as Array<Record<string, unknown>>)[0]!,
            allowed_modules: ["a", "b", "c"],
          },
          (policy().roles as Array<Record<string, unknown>>)[1],
        ],
      },
      edges: [{ from: "a.out", to: "b.in", contract: "x@1" }],
      feedback_edges: [{ from: "b.out", to: "c.in", barrier: "next_outer_iteration" }],
    }),
  );
  expectCode(
    () => assertParallelModuleSet(transitiveFeedbackSpec, ["a", "c"]),
    "MODULE_DEPENDENCY_CONFLICT",
  );
  const plan = buildAblationPlan(feedbackSpec, ["a", "c"]);
  assert.deepEqual(
    plan.map((cell) => cell.cell_id),
    ["00", "10", "01", "11"],
  );
  const identity = buildAblationPlanIdentity({
    spec: feedbackSpec,
    module_ids: ["a", "c"],
    baseline_candidate_id: "candidate:baseline",
    candidate_ids: {
      "10": "candidate:10",
      "01": "candidate:01",
      "11": "candidate:11",
    },
  });
  validateCompleteAblationPlan(
    plan,
    new Map([
      ["00", { complete: true, candidate_id: "candidate:baseline", plan_id: identity.plan_id }],
      ["10", { complete: true, candidate_id: "candidate:10", plan_id: identity.plan_id }],
      ["01", { complete: true, candidate_id: "candidate:01", plan_id: identity.plan_id }],
      ["11", { complete: true, candidate_id: "candidate:11", plan_id: identity.plan_id }],
    ]),
    {
      spec: feedbackSpec,
      module_ids: ["a", "c"],
      baseline_candidate_id: "candidate:baseline",
      candidate_ids: {
        "10": "candidate:10",
        "01": "candidate:01",
        "11": "candidate:11",
      },
      plan_id: identity.plan_id,
    },
  );
  expectCode(
    () =>
      validateCompleteAblationPlan(
        plan,
        new Map([
          ["00", { complete: true, candidate_id: "candidate:baseline", plan_id: identity.plan_id }],
          ["10", { complete: true, candidate_id: "candidate:wrong", plan_id: identity.plan_id }],
          ["01", { complete: true, candidate_id: "candidate:01", plan_id: identity.plan_id }],
          ["11", { complete: true, candidate_id: "candidate:11", plan_id: identity.plan_id }],
        ]),
        {
          spec: feedbackSpec,
          module_ids: ["a", "c"],
          baseline_candidate_id: "candidate:baseline",
          candidate_ids: {
            "10": "candidate:10",
            "01": "candidate:01",
            "11": "candidate:11",
          },
          plan_id: identity.plan_id,
        },
      ),
    "ABLATION_CANDIDATE_MISMATCH",
  );
  expectCode(
    () =>
      validateCompleteAblationPlan(
        [{ cell_id: "00", module_ids: [] }],
        new Map([["00", { complete: true }]]),
      ),
    "ABLATION_INCOMPLETE",
  );
});

test("候选模型角色必须覆盖 active execution graph", () => {
  const spec = validateWorkflowSpec(rawSpec());
  const candidate = candidateSnapshotFor(spec);
  expectCode(
    () => compileWorkflow(spec, { candidate: { ...candidate, model_assignments: [] } as never }),
    "CANDIDATE_SPEC_MISMATCH",
  );
});

test("task setup拒绝重复candidate输出Artifact", () => {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "setup-run" });
    const registry = createArtifactRegistry(root, "setup-run");
    registerArtifact(registry, {
      artifact_id: "artifact:output",
      source_type: "workflow_output",
      producer_run_id: "setup-run",
      candidate_id: "candidate:setup",
      generation: 1,
      role_id: "main-model",
      output_slot: "main.model",
    });
    expectCode(
      () =>
        createTaskSetup({
          task_id: "task:a1",
          workflow_id: "workflow:a1",
          setup_revision: "setup:duplicate-output",
          model_usage_policy: policy(),
          tester_id: "tester:fixed",
          tester_version: "tester:v1",
          validation: {
            registry,
            candidate_id: "candidate:setup",
            candidate_output_artifact_ids: ["artifact:output", "artifact:output"],
          },
        }),
      "DUPLICATE_ID",
    );
  } finally {
    cleanup(root);
  }
});

test("多模型晋升只接受registry登记的完整mapping，并保持失败前状态", () => {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "promotion-run" });
    const registry = createArtifactRegistry(root, "promotion-run");
    const promotionPolicy = {
      ...policy(),
      roles: [
        {
          ...(policy().roles as Array<Record<string, unknown>>)[0],
          allowed_modules: ["a"],
        },
        ...(policy().roles as Array<Record<string, unknown>>).slice(1),
      ],
    };
    const registerOutput = (
      artifactId: string,
      candidateId: string,
      generation: number,
      overrides: Record<string, unknown> = {},
    ) =>
      registerArtifact(registry, {
        artifact_id: artifactId,
        source_type: "workflow_output",
        producer_run_id: "promotion-run",
        candidate_id: candidateId,
        generation,
        role_id: "main-model",
        output_slot: "main.model",
        ...(overrides as {
          input_artifact_ids?: string[];
          role_id?: string | null;
          output_slot?: string | null;
        }),
      });
    const pointerPath = path.join(
      root,
      ".aris",
      "workflows",
      "workflow:a1",
      "active-incumbent.json",
    );
    const parentHash = () =>
      fs.existsSync(pointerPath)
        ? canonicalJsonSha256(
            validateIncumbentSnapshot(JSON.parse(fs.readFileSync(pointerPath, "utf8"))),
            undefined,
            { schemaVersion: "incumbent-v1" },
          )
        : null;
    const commit = (
      candidateId: string,
      generation: number,
      artifactId: string,
      candidateOutputs?: string[],
    ) =>
      commitPromotionAtomically(root, "workflow:a1", {
        expected_parent_sha256: parentHash(),
        candidate_id: candidateId,
        generation,
        role_artifacts: [{ role_id: "main-model", artifact_id: artifactId, generation }],
        policy: promotionPolicy as never,
        registry,
        promotion_outputs: { "main.model": artifactId },
        candidate_output_artifact_ids: candidateOutputs,
      });

    registerOutput("artifact:base", "candidate:base", 0);
    commit("candidate:base", 0, "artifact:base", ["artifact:base"]);
    registerOutput("artifact:next", "candidate:next", 1, {
      input_artifact_ids: ["artifact:base"],
    });
    commit("candidate:next", 1, "artifact:next", ["artifact:next"]);
    const incumbentPath = path.join(
      root,
      ".aris",
      "workflows",
      "workflow:a1",
      "active-incumbent.json",
    );
    const before = fs.readFileSync(incumbentPath, "utf8");
    registerOutput("artifact:stale-parent", "candidate:stale-parent", 2);
    for (const expectedParent of [null, "0".repeat(64)]) {
      expectCode(
        () =>
          commitPromotionAtomically(root, "workflow:a1", {
            expected_parent_sha256: expectedParent,
            candidate_id: "candidate:stale-parent",
            generation: 2,
            role_artifacts: [
              { role_id: "main-model", artifact_id: "artifact:stale-parent", generation: 2 },
            ],
            policy: promotionPolicy as never,
            registry,
            promotion_outputs: { "main.model": "artifact:stale-parent" },
            candidate_output_artifact_ids: ["artifact:stale-parent"],
          }),
        "PROMOTION_PARENT_CONFLICT",
      );
      assert.equal(fs.readFileSync(incumbentPath, "utf8"), before);
    }

    registerOutput("artifact:future", "candidate:future", 4);
    expectCode(() => commit("candidate:future", 2, "artifact:future"), "GENERATION_MISMATCH");

    registerOutput("artifact:bad-mapping", "candidate:bad-mapping", 2);
    expectCode(
      () =>
        commitPromotionAtomically(root, "workflow:a1", {
          expected_parent_sha256: parentHash(),
          candidate_id: "candidate:bad-mapping",
          generation: 2,
          role_artifacts: [
            { role_id: "main-model", artifact_id: "artifact:bad-mapping", generation: 2 },
          ],
          policy: promotionPolicy as never,
          registry,
          promotion_outputs: { "main.model": "artifact:next" },
          candidate_output_artifact_ids: ["artifact:bad-mapping"],
        }),
      "ARTIFACT_PROVENANCE_MISMATCH",
    );

    expectCode(
      () => commit("candidate:missing", 2, "artifact:next", ["artifact:next"]),
      "ARTIFACT_NOT_FOUND",
    );

    registerOutput("artifact:duplicate-a", "candidate:duplicate", 2);
    registerOutput("artifact:duplicate-b", "candidate:duplicate", 2);
    expectCode(() => commit("candidate:duplicate", 2, "artifact:duplicate-a"), "DUPLICATE_ID");

    registerOutput("artifact:wrong-role", "candidate:wrong-role", 2, {
      role_id: "main-judge",
    });
    expectCode(
      () => commit("candidate:wrong-role", 2, "artifact:wrong-role"),
      "ARTIFACT_PROVENANCE_MISMATCH",
    );

    registerOutput("artifact:forged-list", "candidate:forged-list", 2);
    expectCode(
      () => commit("candidate:forged-list", 2, "artifact:forged-list", ["artifact:next"]),
      "ARTIFACT_PROVENANCE_MISMATCH",
    );
    assert.equal(fs.readFileSync(incumbentPath, "utf8"), before);
  } finally {
    cleanup(root);
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
console.log(`A1 workflow/model tests passed: ${passed}`);
