import { createRootRun, openExistingRun } from "../src/tools/run-contract.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import { buildTesterDefinition, type TesterDefinition } from "../src/tools/tester-state.js";
import { createTaskSetup } from "../src/tools/task-setup.js";
import {
  createWorkflowRuntimeState,
  readWorkflowRuntimeState,
  saveFrozenPolicy,
  writeWorkflowRuntimeState,
} from "../src/tools/workflow-state.js";
import { prepareStructureWave, readStructureWave } from "../src/tools/structure-wave.js";
import {
  buildWorkflowSummary,
  readWorkflowSummary,
  writeWorkflowSummary,
  workflowSummaryPath,
} from "../src/tools/workflow-summary.js";
import { validateWorkflowSpec } from "../src/tools/workflow-spec.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-evolution-test-"));
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

function test(name: string, fn: () => void): void {
  fn();
  console.log(`ok - ${name}`);
}

function policy() {
  return {
    revision: "policy:r1",
    approval_id: "approval:roles",
    roles: [
      {
        role_id: "main-model",
        allowed_modules: ["a", "b", "e"],
        allowed_uses: ["generate", "train"],
        judge_targets: [],
        judge_generation_lag: null,
        artifact_binding: "previous_promoted",
        promotion_output: "main.model",
        user_confirmed: true,
        approval_id: "approval:main",
      },
    ],
  };
}

function moduleSpec(id: string, inputs: string[], outputs: string[]) {
  return {
    id,
    evolvable: true,
    version: `${id}:v1`,
    patch_sha256: HASH_A,
    inputs,
    outputs,
    write_scope: [`src/${id}/**`],
    local_metric: `${id}_score`,
    execution: { max_jobs: 1, max_compute: { amount: 1, unit: "gpu_hours" } },
  };
}

function spec() {
  const modules = [
    moduleSpec("a", [], ["x@1"]),
    moduleSpec("b", ["x@1"], ["y@1"]),
    moduleSpec("e", ["x@1"], ["x@1"]),
  ];
  return {
    schema_version: 1,
    task_id: "task:evolution",
    workflow_id: "workflow:evolution",
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
      revision: "limits:r1",
      max_nodes: 8,
      max_edges: 12,
      max_fan_out_per_node: 3,
      max_unrolled_cycles: 1,
      max_jobs_per_candidate: 10,
      max_compute_per_candidate: { amount: 10, unit: "gpu_hours" },
    },
    modules,
    module_catalog: modules,
    enabled_module_ids: ["a", "b"],
    active_module_ids: ["a", "b"],
    edges: [{ from: "a.out", to: "b.in", contract: "x@1" }],
    feedback_edges: [],
    cycles: [],
  };
}

function candidate(nodes: string[], edges: Array<{ from: string; to: string; contract: string }>) {
  const modules = new Map([
    ["a", moduleSpec("a", [], ["x@1"])],
    ["b", moduleSpec("b", ["x@1"], ["y@1"])],
    ["e", moduleSpec("e", ["x@1"], ["x@1"])],
  ]);
  return {
    schema_version: 1,
    workflow_revision: "flow:r1",
    parent_candidate_id: null,
    module_versions: nodes.map((moduleId) => ({
      module_id: moduleId,
      version: modules.get(moduleId)!.version,
      patch_sha256: HASH_A,
      input_artifact_ids: [],
      code_paths: [`src/${moduleId}/main.ts`],
    })),
    input_artifact_ids: [],
    model_assignments: [
      {
        role_id: "main-model",
        module_ids: nodes,
        uses: ["generate", "train"],
        artifact_id: "artifact:main",
        judge_targets: [],
        resolved_from: "previous_promoted",
        generation: 1,
      },
    ],
    finite_cycles: 0,
    random_seed: "seed:evolution",
    owner_limits: spec().owner_limits,
    execution_graph: {
      nodes: nodes.map((moduleId) => ({
        module_id: moduleId,
        version: modules.get(moduleId)!.version,
        input_ports: [],
        output_ports: [],
      })),
      edges,
      feedback_edges: [],
    },
    patch_paths: [],
    output_artifact_ids: [],
  };
}

function testerDefinition(): TesterDefinition {
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
      statistics: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 2 },
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

function taskSetup() {
  return createTaskSetup({
    task_id: "task:evolution",
    workflow_id: "workflow:evolution",
    setup_revision: "setup:r1",
    model_usage_policy: policy(),
    tester_id: "tester:fixed",
    tester_version: "tester:v1",
  });
}

function ownerLimits() {
  return spec().owner_limits;
}

function setupRoot(): {
  root: string;
  execution: string;
  input: Parameters<typeof prepareStructureWave>[0];
} {
  const root = tempDir();
  const execution = path.join(root, "execution");
  fs.mkdirSync(execution, { recursive: true });
  const outerRunId = "outer-evolution";
  createRootRun({ project_root: root, run_id: outerRunId });
  openExistingRun({ project_root: root, run_id: outerRunId });
  const tester = testerDefinition();
  const setup = taskSetup();
  saveFrozenPolicy({
    project_root: root,
    outer_run_id: outerRunId,
    task_id: "task:evolution",
    owner_limits: ownerLimits(),
    task_setup_revision: "setup:r1",
    task_setup: setup,
    model_usage_policy_revision: "policy:r1",
    model_usage_policy: setup.model_usage_policy,
    tester_id: tester.tester_id,
    tester_version: tester.version,
    tester_definition: tester,
    incumbent_candidate_id: "candidate:incumbent",
    incumbent_generation: 1,
    incumbent: {
      candidate_id: "candidate:incumbent",
      generation: 1,
      role_artifacts: [{ role_id: "main-model", artifact_id: "artifact:main", generation: 1 }],
    },
  });
  const runtime = createWorkflowRuntimeState({
    execution_root: execution,
    project_root: root,
    outer_run_id: outerRunId,
    task_id: "task:evolution",
    workflow_id: "workflow:evolution",
  });
  runtime.current_phase = "wave";
  runtime.active_cycle = {
    outer_iteration: 1,
    generation: 1,
    wave_id: "wave:structure",
    wave_kind: "structure",
    promotion_commit_ref: null,
  };
  runtime.phase_history = [
    {
      ...runtime.phase_history[0]!,
      status: "completed",
      evidence_refs: ["setup"],
      evidence_sha256: HASH_A,
      completed_at: runtime.created_at,
    },
    {
      phase: "diagnosis",
      outer_iteration: 1,
      generation: 1,
      status: "completed",
      evidence_refs: ["diagnosis"],
      evidence_sha256: HASH_A,
      started_at: runtime.created_at,
      completed_at: runtime.created_at,
    },
    {
      phase: "workset",
      outer_iteration: 1,
      generation: 1,
      status: "completed",
      evidence_refs: ["workset"],
      evidence_sha256: HASH_A,
      started_at: runtime.created_at,
      completed_at: runtime.created_at,
    },
    {
      phase: "wave",
      outer_iteration: 1,
      generation: 1,
      status: "active",
      evidence_refs: [],
      evidence_sha256: null,
      started_at: runtime.created_at,
      completed_at: null,
    },
  ];
  writeWorkflowRuntimeState(root, runtime);
  const workflow = spec();
  const baselineSpecSha256 = canonicalJsonSha256(validateWorkflowSpec(workflow), undefined, {
    schemaVersion: "workflow-spec-v1",
  });
  const input = {
    execution_root: execution,
    project_root: root,
    outer_run_id: outerRunId,
    outer_iteration: 1,
    generation: 1,
    wave_id: "wave:structure",
    workflow_spec: workflow,
    proposals: [
      {
        proposal_id: "proposal:structure-1",
        baseline_revision: "flow:r1",
        baseline_spec_sha256: baselineSpecSha256,
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
        module_version_manifest: { a: "a:v1", b: "b:v1", e: "e:v1" },
        model_scope_confirmation: {
          status: "confirmed",
          task_setup_revision: "setup:r1",
          role_ids: ["main-model"],
        },
        s0_candidate: candidate(["a", "b"], [{ from: "a.out", to: "b.in", contract: "x@1" }]),
        s1_candidate: candidate(
          ["a", "e", "b"],
          [
            { from: "a.out", to: "e.in", contract: "x@1" },
            { from: "e.out", to: "b.in", contract: "x@1" },
          ],
        ),
        comparison_binding: {
          input_snapshot_sha256: HASH_A,
          scorer_revision: "scorer:r1",
          model_assignment_sha256: HASH_B,
          seed_manifest_sha256: HASH_A,
          repeat_ids: ["repeat:1", "repeat:2"],
        },
      },
    ],
  } satisfies Parameters<typeof prepareStructureWave>[0];
  return { root, execution, input };
}

test("structure wave freezes one S0/S1 proposal and replays it", () => {
  const fixture = setupRoot();
  try {
    const first = prepareStructureWave(fixture.input);
    const replay = prepareStructureWave(fixture.input);
    assert.equal(first.status, "prepared");
    assert.equal(first.s0.label, "S0");
    assert.equal(first.s1.label, "S1");
    assert.equal(first.s0.candidate_id, replay.s0.candidate_id);
    assert.equal(first.s1.compilation.structure_delta_id, first.structure_delta_id);
    assert.ok(fs.existsSync(path.join(fixture.root, ".aris", "active-wave.json")));
    assert.equal(
      readStructureWave(fixture.root, fixture.input.outer_run_id, 1).proposal_id,
      "proposal:structure-1",
    );
  } finally {
    cleanup(fixture.root);
  }
});

test("structure wave rejects a second proposal and missing confirmation", () => {
  const fixture = setupRoot();
  try {
    expectCode(
      () =>
        prepareStructureWave({
          ...fixture.input,
          proposals: [...fixture.input.proposals, fixture.input.proposals[0]!],
        }),
      "STRUCTURE_PROPOSAL_REQUIRED",
    );
    const proposal = fixture.input.proposals[0]!;
    expectCode(
      () =>
        prepareStructureWave({
          ...fixture.input,
          proposals: [
            {
              ...proposal,
              model_scope_confirmation: {
                ...proposal.model_scope_confirmation,
                status: "pending",
              } as never,
            },
          ],
        }),
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
    );
  } finally {
    cleanup(fixture.root);
  }
});

test("workflow summary keeps tester view public and includes stable outer facts", () => {
  const fixture = setupRoot();
  try {
    const summary = buildWorkflowSummary({
      project_root: fixture.root,
      outer_run_id: fixture.input.outer_run_id,
    });
    assert.equal(summary.workflow_id, "workflow:evolution");
    assert.deepEqual(summary.tester_runs, []);
    assert.ok(!Object.hasOwn(summary, "private-result.json"));
    assert.equal(
      readWorkflowSummary({ project_root: fixture.root, outer_run_id: fixture.input.outer_run_id })
        .summary_sha256,
      summary.summary_sha256,
    );
  } finally {
    cleanup(fixture.root);
  }
});

test("workflow summary refreshes persisted runtime changes and keeps unchanged files", () => {
  const fixture = setupRoot();
  try {
    const input = { project_root: fixture.root, outer_run_id: fixture.input.outer_run_id };
    const original = writeWorkflowSummary(input);
    const filePath = workflowSummaryPath(fixture.root, input.outer_run_id);
    const originalBytes = fs.readFileSync(filePath, "utf8");
    assert.deepEqual(readWorkflowSummary(input), original);
    assert.equal(fs.readFileSync(filePath, "utf8"), originalBytes);
    const runtime = readWorkflowRuntimeState(fixture.root, input.outer_run_id);
    runtime.outer_iteration += 1;
    runtime.active_cycle!.outer_iteration = runtime.outer_iteration;
    writeWorkflowRuntimeState(fixture.root, runtime);
    const refreshed = readWorkflowSummary(input);
    assert.equal(refreshed.outer_iteration, runtime.outer_iteration);
    assert.equal(refreshed.active_cycle!.outer_iteration, runtime.outer_iteration);
    assert.notEqual(refreshed.summary_sha256, original.summary_sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), refreshed);
  } finally {
    cleanup(fixture.root);
  }
});

test("workflow summary rejects edited and wrong-run files without overwriting them", () => {
  const fixture = setupRoot();
  try {
    const input = { project_root: fixture.root, outer_run_id: fixture.input.outer_run_id };
    const summary = writeWorkflowSummary(input);
    const filePath = workflowSummaryPath(fixture.root, input.outer_run_id);
    const edited = { ...summary, outer_iteration: 99 };
    fs.writeFileSync(filePath, JSON.stringify(edited));
    expectCode(() => readWorkflowSummary(input), "CORRUPT_WORKFLOW_SUMMARY");
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), edited);
    const { summary_sha256, generated_at, ...base } = summary;
    const wrongBase = { ...base, outer_run_id: "other-run" };
    const wrongRun = {
      ...wrongBase,
      generated_at,
      summary_sha256: canonicalJsonSha256(wrongBase, undefined, {
        schemaVersion: "workflow-summary-v1",
      }),
    };
    fs.writeFileSync(filePath, JSON.stringify(wrongRun));
    expectCode(() => readWorkflowSummary(input), "IDENTITY_MISMATCH");
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), wrongRun);
  } finally {
    cleanup(fixture.root);
  }
});

for (const status of ["completed", "failed", "stopped"] as const) {
  test(`workflow summary refreshes and reads retained ${status} runtime`, () => {
    const fixture = setupRoot();
    try {
      const input = { project_root: fixture.root, outer_run_id: fixture.input.outer_run_id };
      writeWorkflowSummary(input);
      const runtime = readWorkflowRuntimeState(fixture.root, input.outer_run_id);
      runtime.status = status;
      runtime.current_phase = "summary";
      runtime.active_cycle = null;
      runtime.phase_history.push({
        phase: "summary",
        outer_iteration: runtime.outer_iteration,
        generation: runtime.generation,
        status,
        evidence_refs: ["summary-evidence"],
        evidence_sha256: HASH_A,
        started_at: runtime.created_at,
        completed_at: runtime.created_at,
      });
      writeWorkflowRuntimeState(fixture.root, runtime);
      assert.equal(readWorkflowSummary(input).status, status);
      assert.equal(readWorkflowSummary(input).status, status);
    } finally {
      cleanup(fixture.root);
    }
  });
}

console.log("workflow evolution tests passed");
