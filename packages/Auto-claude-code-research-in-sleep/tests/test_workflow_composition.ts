import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  composeWorkflowModules,
  removeWorkflowComposition,
  readWorkflowComposition,
  type WorkflowCompositionInput,
} from "../src/tools/workflow-composition.js";
import { createModuleWorkspace, sealModuleWorkspace } from "../src/tools/workflow-workspace.js";
import {
  advanceOuterPhase,
  beginOuterCycle,
  hashOuterEvidence,
  reconcileOuterChildren,
  registerOuterChild,
} from "../src/tools/workflow-runtime.js";
import { readResultPackage, resultPackagePath } from "../src/tools/result-package.js";
import { validateWorkflowSpec, type WorkflowSpec } from "../src/tools/workflow-spec.js";
import {
  cleanup,
  completeModule,
  evidence,
  makeFixture,
  makeModule,
  startFixture,
  tempDir,
} from "./test_workflow_runtime.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function moduleSpec(id: string, scope: string): Record<string, unknown> {
  return {
    id,
    evolvable: true,
    inputs: [],
    outputs: [`output:${id}`],
    write_scope: [scope],
    local_metric: `${id}:score`,
    execution: { max_jobs: 1, max_compute: { amount: 1, unit: "gpu_hours" } },
  };
}

function workflowSpec(
  fixture: ReturnType<typeof makeFixture>,
  scopes: { a: string; b: string },
): WorkflowSpec {
  return validateWorkflowSpec({
    schema_version: 1,
    mode: "workflow",
    task_id: fixture.identity.task_id,
    workflow_id: fixture.identity.workflow_id,
    revision: "workflow:composition-v1",
    objective: {
      primary: { name: "workflow_score", direction: "higher_better" },
      constraints: [],
    },
    task_setup_revision: fixture.taskSetupRevision,
    model_usage_policy: fixture.freezeInput.model_usage_policy,
    validation_policy: {
      scorer_id: "scorer:fixed",
      scorer_revision_binding: "from_active_scorer_pointer",
      research_feedback: "detailed",
      cross_judge_score_comparison: "forbidden",
    },
    scorers: [
      {
        id: "scorer:fixed",
        kind: "deterministic_rules",
        definition_binding: "from_active_scorer_revision",
        judge_binding: null,
      },
    ],
    promotion_tester: {
      tester_id: fixture.tester.tester_id,
      definition_version: fixture.tester.version,
      research_feedback: "fuzzy_advice_only",
      max_exposures_per_task: fixture.tester.max_exposures_per_task,
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
    owner_limits: fixture.freezeInput.owner_limits,
    modules: [
      moduleSpec("module:a", scopes.a),
      moduleSpec("module:b", scopes.b),
      moduleSpec("module:c", "src/c/**"),
    ],
    enabled_module_ids: ["module:a", "module:b"],
    edges: [],
    feedback_edges: [],
    cycles: [],
  });
}

function candidate(
  fixture: ReturnType<typeof makeFixture>,
  patchHashes: { a: string; b: string },
  patchPaths: string[],
): Record<string, unknown> {
  return {
    schema_version: 1,
    workflow_revision: "workflow:composition-v1",
    parent_candidate_id: null,
    module_versions: [
      {
        module_id: "module:a",
        version: "module:a:v1",
        patch_sha256: patchHashes.a,
        input_artifact_ids: ["artifact:seed"],
        code_paths: ["src/a.txt"],
      },
      {
        module_id: "module:b",
        version: "module:b:v1",
        patch_sha256: patchHashes.b,
        input_artifact_ids: ["artifact:seed"],
        code_paths: ["src/b.txt"],
      },
    ],
    input_artifact_ids: ["artifact:seed"],
    model_assignments: [
      {
        role_id: "main-model",
        module_ids: ["module:a", "module:b"],
        uses: ["generate"],
        artifact_id: "artifact:model",
        judge_targets: [],
        resolved_from: "previous_promoted",
        generation: 1,
      },
    ],
    finite_cycles: 0,
    random_seed: "seed:composition",
    owner_limits: fixture.freezeInput.owner_limits,
    execution_graph: {
      nodes: [
        { module_id: "module:a", version: "module:a:v1", input_ports: [], output_ports: [] },
        { module_id: "module:b", version: "module:b:v1", input_ports: [], output_ports: [] },
      ],
      edges: [],
      feedback_edges: [],
    },
    patch_paths: patchPaths,
  };
}

function prepareScenario(scopeB = "src/b.txt"): {
  root: string;
  executionRoot: string;
  input: WorkflowCompositionInput;
} {
  const root = tempDir("aris-composition-project-");
  const executionRoot = tempDir("aris-composition-execution-");
  git(root, "init", "-q");
  git(root, "config", "user.name", "ARIS composition test");
  git(root, "config", "user.email", "aris-composition@example.invalid");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.txt"), "baseline a\n");
  fs.writeFileSync(path.join(root, "src", "b.txt"), "baseline b\n");
  fs.writeFileSync(path.join(root, "src", "c.txt"), "baseline c\n");
  git(root, "add", "src");
  git(root, "commit", "-qm", "composition baseline");
  const baseline = git(root, "rev-parse", "HEAD");

  const fixture = makeFixture(root, executionRoot, "outer-fixed");
  startFixture(fixture);
  beginOuterCycle({
    ...fixture.identity,
    wave_id: "wave:fixed",
    wave_kind: "module",
    evidence_paths: [evidence(root, "composition-cycle")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "diagnosis",
    to_phase: "workset",
    evidence_paths: [evidence(root, "composition-diagnosis")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "workset",
    to_phase: "wave",
    evidence_paths: [evidence(root, "composition-workset")],
  });

  const moduleInputs = [
    { moduleId: "module:a", runId: "module-run-a", scope: "src/a.txt", file: "a.txt" },
    { moduleId: "module:b", runId: "module-run-b", scope: scopeB, file: "b.txt" },
  ];
  const patchHashes: { a: string; b: string } = { a: "", b: "" };
  for (const moduleInput of moduleInputs) {
    makeModule(root, moduleInput.runId, moduleInput.moduleId);
    const workspace = createModuleWorkspace({
      project_root: root,
      module_run_id: moduleInput.runId,
      baseline_commit: baseline,
      write_scope: [moduleInput.scope],
    });
    fs.writeFileSync(
      path.join(workspace.workspace_root, "src", moduleInput.file),
      `candidate ${moduleInput.moduleId}\n`,
    );
    const sealed = sealModuleWorkspace(root, moduleInput.runId);
    patchHashes[moduleInput.moduleId === "module:a" ? "a" : "b"] = sealed.patch_sha256!;
    registerOuterChild({
      ...fixture.identity,
      child_run_id: moduleInput.runId,
      kind: "module",
      module_id: moduleInput.moduleId,
    });
  }
  completeModule(root, "module-run-a", "module:a");
  completeModule(root, "module-run-b", "module:b");
  reconcileOuterChildren(fixture.identity);

  const spec = workflowSpec(fixture, { a: "src/a.txt", b: scopeB });
  const candidateValue = candidate(fixture, patchHashes, ["src/a.txt", "src/b.txt"]);
  const modules = ["module-run-a", "module-run-b"].map((runId, index) => {
    const moduleId = index === 0 ? "module:a" : "module:b";
    const proposalRef = "outputs/proposal.json";
    return {
      module_id: moduleId,
      module_run_id: runId,
      proposal_ref: proposalRef,
      proposal_sha256: readResultPackage(root, runId).output_hashes[proposalRef]!,
      patch_sha256: patchHashes[index === 0 ? "a" : "b"],
      write_scope: [index === 0 ? "src/a.txt" : scopeB],
    };
  });
  const evidencePaths = modules.flatMap((module) => {
    const runRoot = path.join(root, ".aris", "runs", module.module_run_id);
    // The parent never re-reviews the child. What it has to carry up is the
    // package the child's own review let it publish, plus every file that
    // package sealed.
    const result = readResultPackage(root, module.module_run_id);
    return [
      resultPackagePath(root, module.module_run_id),
      ...result.output_paths.map((outputPath) => path.join(runRoot, outputPath)),
      path.join(runRoot, "workspace.patch"),
    ];
  });
  const evidenceBundle = hashOuterEvidence(root, evidencePaths);
  return {
    root,
    executionRoot,
    input: {
      schema_version: 1,
      project_root: root,
      outer_run_id: "outer-fixed",
      outer_iteration: 1,
      generation: 1,
      wave_id: "wave:fixed",
      composition_id: "composition:ab",
      baseline_commit: baseline,
      module_ids: ["module:a", "module:b"],
      workflow_spec: spec,
      candidate: candidateValue,
      modules,
      evidence_paths: evidencePaths,
      evidence_sha256: evidenceBundle.evidence_sha256,
    },
  };
}

const scenario = prepareScenario();
try {
  const first = composeWorkflowModules(scenario.input);
  assert.equal(first.status, "ready");
  assert.ok(first.worktree_root);
  assert.equal(
    fs.readFileSync(path.join(first.worktree_root!, "src", "a.txt"), "utf8"),
    "candidate module:a\n",
  );
  assert.equal(
    fs.readFileSync(path.join(first.worktree_root!, "src", "b.txt"), "utf8"),
    "candidate module:b\n",
  );

  const replay = composeWorkflowModules(scenario.input);
  assert.equal(replay.result_sha256, first.result_sha256);
  assert.equal(readWorkflowComposition(scenario.root, "composition:ab").status, "ready");

  const removed = removeWorkflowComposition(scenario.root, "composition:ab");
  assert.equal(removed.status, "ready");
  assert.equal(fs.existsSync(first.worktree_root!), false);

  const rebuilt = composeWorkflowModules(scenario.input);
  assert.equal(rebuilt.result_sha256, first.result_sha256);
  assert.equal(
    fs.readFileSync(path.join(rebuilt.worktree_root!, "src", "a.txt"), "utf8"),
    "candidate module:a\n",
  );

  assert.throws(
    () =>
      composeWorkflowModules({
        ...scenario.input,
        composition_id: "composition:tampered",
        evidence_sha256: "0".repeat(64),
      }),
    (error: unknown) => (error as { code?: string }).code === "EVIDENCE_HASH_MISMATCH",
  );
  console.log("test_workflow_composition: reviewed patch composition, replay, cleanup and recovery passed");
} finally {
  cleanup(scenario.root);
  cleanup(scenario.executionRoot);
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

const wrongPatch = prepareScenario();
try {
  const tamperedCandidate = structuredClone(wrongPatch.input.candidate) as Record<string, unknown>;
  const versions = tamperedCandidate.module_versions as Array<Record<string, unknown>>;
  versions[1] = { ...versions[1], patch_sha256: "f".repeat(64) };
  expectCode(
    () =>
      composeWorkflowModules({
        ...wrongPatch.input,
        composition_id: "composition:wrong-patch",
        candidate: tamperedCandidate,
      }),
    "COMPOSITION_PATCH_MISMATCH",
  );
  assert.equal(
    fs.existsSync(path.join(wrongPatch.root, ".aris", "runs", "outer-fixed", "compositions")),
    false,
  );
} finally {
  cleanup(wrongPatch.root);
  cleanup(wrongPatch.executionRoot);
}

const overlapping = prepareScenario("src");
try {
  expectCode(
    () => composeWorkflowModules({ ...overlapping.input, composition_id: "composition:overlap" }),
    "WRITE_SCOPE_CONFLICT",
  );
  assert.equal(
    fs.existsSync(path.join(overlapping.root, ".aris", "runs", "outer-fixed", "compositions")),
    false,
  );
} finally {
  cleanup(overlapping.root);
  cleanup(overlapping.executionRoot);
}

const incompleteEvidence = prepareScenario();
try {
  const evidencePaths = incompleteEvidence.input.evidence_paths.slice(1);
  const evidenceBundle = hashOuterEvidence(incompleteEvidence.root, evidencePaths);
  expectCode(
    () =>
      composeWorkflowModules({
        ...incompleteEvidence.input,
        composition_id: "composition:missing-evidence",
        evidence_paths: evidencePaths,
        evidence_sha256: evidenceBundle.evidence_sha256,
      }),
    "OUTER_EVIDENCE_REQUIRED",
  );
} finally {
  cleanup(incompleteEvidence.root);
  cleanup(incompleteEvidence.executionRoot);
}

console.log("test_workflow_composition: rejection paths passed");
