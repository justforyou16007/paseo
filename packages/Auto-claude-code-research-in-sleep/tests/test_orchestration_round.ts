import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBaselineScope, type BaselineScope } from "../src/tools/baseline-scope.js";
import { childIndexPath, readChildIndex } from "../src/tools/child-index.js";
import { recordDecompositionGraph } from "../src/tools/decomposition-graph.js";
import {
  materializeBridgeChildren,
  planExperimentBridge,
  type BridgePositionInput,
} from "../src/tools/experiment-bridge.js";
import {
  collectOrchestrationRound,
  requireCompleteRound,
  roundChildSummaries,
} from "../src/tools/orchestration-round.js";
import { createResourceInventory, type ResourceInventory } from "../src/tools/resource-inventory.js";
import { planResultExport } from "../src/tools/result-export.js";
import { buildResultPackageForRun, saveResultPackage } from "../src/tools/result-package.js";
import { saveResultReview } from "../src/tools/result-review.js";
import { createRun, readRun, runOwnedPath } from "../src/tools/run-contract.js";
import { initializeRunBudget } from "../src/tools/run-budget.js";
import { appendWikiEvent, initializeWikiSchema } from "../src/tools/wiki-event-store.js";
import { runWikiRoot } from "../src/tools/wiki-scope.js";
import { bridgeFixture } from "./helpers/recursive-fixture.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const PARENT = "root-collect";

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function baseline(): BaselineScope {
  return createBaselineScope({
    schema_version: 1,
    baseline_id: "W_0",
    workflow_definition: { modules: [{ id: "survey" }, { id: "synthesis" }], edges: [] },
    code_baseline: { ref: "commit:baseline", sha256: HASH_A },
    position_artifacts: {
      survey: { artifact_ref: "artifact:survey", artifact_sha256: HASH_B },
      synthesis: { artifact_ref: "artifact:synthesis", artifact_sha256: HASH_C },
    },
    initial_validation: {
      scorer_revision: "scorer:r1",
      input_snapshot_sha256: HASH_C,
      judge_binding: { role: "fixed-judge", revision: "judge:r1" },
      metrics: { score: 0.4 },
    },
    optimizable_scope: [
      { position_id: "survey", mode: "independent" },
      { position_id: "synthesis", mode: "independent" },
    ],
    max_bundled_positions_per_graph: 0,
  });
}

function resources(): ResourceInventory {
  return createResourceInventory({
    schema_version: 1,
    inventory_id: "resources:collect",
    platforms: [
      {
        platform_id: "gpu-a",
        access_ref: "credential:collect",
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

function request(): Record<string, unknown> {
  return {
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
  };
}

function position(positionId: string, dependsOn?: string[]): BridgePositionInput {
  return {
    position_id: positionId,
    mode: "independent",
    resource_request: request(),
    candidate_id: `candidate:${positionId}`,
    result_status: "succeeded",
    budget: { amount: 4, unit: "gpu_hours" },
    ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
  };
}

function fixture(projectRoot: string, positions: readonly BridgePositionInput[]) {
  const scope = baseline();
  const resource = resources();
  return bridgeFixture({
    charter: {
      schema_version: 1,
      charter_id: "charter:collect",
      run_id: PARENT,
      expected_output: "a candidate artifact with reproducible evidence",
      budget: { amount: 12, unit: "gpu_hours" },
      baseline_sha256: scope.baseline_sha256,
      resource_inventory_sha256: resource.inventory_sha256,
      optimizable_scope: scope.optimizable_scope,
      policy_revision: "policy:collect",
      code_baseline_sha256: scope.code_baseline.sha256,
    },
    baseline: scope,
    resource_inventory: resource,
    project_root: projectRoot,
    orchestration: true,
    generation: 1,
    remaining_generations: 2,
    positions,
  });
}

/** What the parent decided, in the form the decomposition is recorded in. */
function decomposition(projectRoot: string, positions: readonly BridgePositionInput[]) {
  return fixture(projectRoot, positions).positions.map((entry) => ({
    position_id: entry.position_id,
    problem: entry.charter!.problem as string,
    expected_output: entry.charter!.expected_output,
    constraints: entry.charter!.constraints as Record<string, unknown>,
    depends_on: entry.depends_on === undefined ? [] : [...entry.depends_on],
  }));
}

function publish(
  projectRoot: string,
  runId: string,
  outputs: Record<string, string>,
  localMetrics?: Record<string, number>,
): void {
  const contract = readRun(projectRoot, runId);
  const succeeded = Object.keys(outputs).length > 0;
  const input = {
    run_id: runId,
    parent_run_id: contract.parent_run_id,
    scope_path: contract.scope_path,
    status: succeeded ? ("succeeded" as const) : ("failed" as const),
    input_snapshot_sha256: contract.identity_material.input_snapshot_sha256,
    output_hashes: outputs,
    ...(localMetrics === undefined ? {} : { local_metrics: localMetrics }),
    ...(succeeded
      ? {}
      : { failure: { reason: "stopped", failure_code: "EXECUTION_FAILED", evidence_refs: [] } }),
  };
  const built = buildResultPackageForRun(projectRoot, runId, input);
  const reviewId = `review:${runId}`;
  saveResultReview(projectRoot, {
    schema_version: 1,
    review_id: reviewId,
    run_id: runId,
    reviewer_worker_id: "reviewer-collect",
    package_sha256: built.package.package_sha256,
    verdict: "approved",
    evidence_refs: [],
    reason_codes: [],
  });
  saveResultPackage(projectRoot, runId, input, { review_id: reviewId });
}

function parentRoot(name: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `aris-collect-${name}-`));
  createRun({
    project_root: projectRoot,
    run_id: PARENT,
    charter_sha256: HASH_A,
    input_snapshot_sha256: HASH_C,
    execution_plan_sha256: HASH_B,
    code_baseline_sha256: HASH_A,
    policy_revision: "policy:collect",
  });
  initializeRunBudget(projectRoot, PARENT, { amount: 12, unit: "gpu_hours" });
  return projectRoot;
}

const SERIAL = [position("survey"), position("synthesis", ["survey"])];

test("a generation is collected only once every position it declared has a terminal child", () => {
  const projectRoot = parentRoot("serial");
  try {
    recordDecompositionGraph(projectRoot, PARENT, 1, decomposition(projectRoot, SERIAL));

    // Before anything is dispatched the round already knows the shape of the
    // generation, which is what tells the parent what it may start now.
    const declared = collectOrchestrationRound({
      project_root: projectRoot,
      parent_run_id: PARENT,
    });
    assert.equal(declared.complete, false);
    assert.deepEqual(declared.dispatchable, ["survey"]);
    assert.deepEqual(declared.waiting, ["synthesis"]);
    assert.deepEqual(
      declared.children.map((child) => [child.position_id, child.state, child.blocked_by]),
      [
        ["survey", "not_dispatched", []],
        ["synthesis", "not_dispatched", ["survey"]],
      ],
    );

    const first = planExperimentBridge(fixture(projectRoot, [position("survey")]));
    materializeBridgeChildren(projectRoot, first);
    const surveyRunId = first.children[0]!.run_id;
    const dispatched = collectOrchestrationRound({
      project_root: projectRoot,
      parent_run_id: PARENT,
    });
    assert.deepEqual(dispatched.running, ["survey"]);
    assert.equal(dispatched.children[0]!.child_run_id, surveyRunId);
    // A dispatched child carries the acceptance its parent froze for it, and
    // nothing can be said about its score before it publishes.
    assert.deepEqual(dispatched.children[0]!.metric, {
      name: "score",
      direction: "higher_better",
      threshold: 0.5,
    });
    assert.equal(dispatched.children[0]!.score, null);
    expectCode(() => requireCompleteRound(projectRoot, PARENT), "ROUND_INCOMPLETE");

    publish(projectRoot, surveyRunId, { "outputs/survey.json": HASH_B }, { score: 0.9 });
    const afterUpstream = collectOrchestrationRound({
      project_root: projectRoot,
      parent_run_id: PARENT,
    });
    assert.deepEqual(afterUpstream.accepted, ["survey"]);
    assert.equal(afterUpstream.children[0]!.score, 0.9);
    assert.equal(afterUpstream.children[0]!.rejected, null);
    // The edge is now crossable, so the downstream moves from waiting to
    // dispatchable without anyone restating the graph.
    assert.deepEqual(afterUpstream.dispatchable, ["synthesis"]);
    assert.deepEqual(afterUpstream.waiting, []);

    const second = planExperimentBridge(fixture(projectRoot, SERIAL));
    materializeBridgeChildren(projectRoot, second);
    expectCode(() => requireCompleteRound(projectRoot, PARENT), "ROUND_INCOMPLETE");

    const synthesisRunId = readChildIndex(childIndexPath(projectRoot, PARENT)).positions.find(
      (entry) => entry.position_id === "synthesis",
    )!.child_run_id;
    publish(projectRoot, synthesisRunId, { "outputs/report.md": HASH_C }, { score: 0.2 });

    const complete = requireCompleteRound(projectRoot, PARENT);
    assert.equal(complete.complete, true);
    // Both children are terminal; only one of them met the parent's standard,
    // and falling short is a judgement, not a failure.
    assert.deepEqual(complete.accepted, ["survey"]);
    const synthesis = complete.children.find((child) => child.position_id === "synthesis")!;
    assert.equal(synthesis.state, "succeeded");
    assert.equal(synthesis.accepted, false);
    assert.equal(synthesis.rejected, "below_threshold");
    assert.deepEqual(
      roundChildSummaries(complete).map((summary) => [summary.run_id, summary.status]),
      [
        [surveyRunId, "succeeded"],
        [synthesisRunId, "succeeded"],
      ],
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a failed child and a silent child are both terminal, and neither is accepted", () => {
  const projectRoot = parentRoot("terminal");
  const positions = [position("survey"), position("synthesis")];
  try {
    recordDecompositionGraph(projectRoot, PARENT, 1, decomposition(projectRoot, positions));
    const plan = planExperimentBridge(fixture(projectRoot, positions));
    materializeBridgeChildren(projectRoot, plan);
    const surveyRunId = plan.children.find((child) => child.position_id === "survey")!.run_id;
    const synthesisRunId = plan.children.find(
      (child) => child.position_id === "synthesis",
    )!.run_id;

    // One child failed outright; the other succeeded without ever reporting
    // the number its acceptance asks for.
    publish(projectRoot, surveyRunId, {});
    publish(projectRoot, synthesisRunId, { "outputs/report.md": HASH_C }, { other: 0.9 });

    const round = requireCompleteRound(projectRoot, PARENT);
    assert.deepEqual(round.accepted, []);
    const survey = round.children.find((child) => child.position_id === "survey")!;
    assert.equal(survey.state, "failed");
    assert.equal(survey.result_status, "failed");
    assert.equal(survey.rejected, "child_failed");
    const synthesis = round.children.find((child) => child.position_id === "synthesis")!;
    assert.equal(synthesis.state, "succeeded");
    assert.equal(synthesis.score, null);
    assert.equal(synthesis.rejected, "metric_missing");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("the parent's result package names the children the generation dispatched", () => {
  const projectRoot = parentRoot("export");
  const positions = [position("survey"), position("synthesis")];
  try {
    recordDecompositionGraph(projectRoot, PARENT, 1, decomposition(projectRoot, positions));
    const plan = planExperimentBridge(fixture(projectRoot, positions));
    materializeBridgeChildren(projectRoot, plan);
    for (const child of plan.children)
      publish(projectRoot, child.run_id, { [`outputs/${child.position_id}.json`]: HASH_B }, {
        score: 0.8,
      });

    const wikiRoot = runWikiRoot(projectRoot, PARENT);
    initializeWikiSchema(wikiRoot);
    appendWikiEvent(wikiRoot, {
      producer_kind: "orchestration-round-test",
      scope: `runs/${PARENT}`,
      subject_id: "exp:assembly",
      evidence_bundle_id: "bundle:assembly",
      payload: {
        context: {},
        operations: [
          {
            op: "upsert_page",
            kind: "experiment",
            id: "assembly",
            data: {
              title: "assembly",
              idea_id: "idea:assembly",
              verdict: "yes",
              confidence: "high",
              date: "2026-01-01",
              hardware: "",
              duration: "",
              provenance: "",
              metrics: "see comparable metrics",
              reasoning: "bounded test",
              tags: [],
              iteration: 1,
              gate_metric: 0.75,
            },
          },
        ],
      },
    });
    const dashboardPath = runOwnedPath(projectRoot, PARENT, "dashboard.json");
    fs.writeFileSync(
      dashboardPath,
      JSON.stringify({
        iteration: 1,
        metric: {
          name: "accuracy",
          target: 0.95,
          direction: "higher_better",
          tolerance: 0,
          baseline: 0.1,
          current: 0.75,
          history: [{ iter: 1, value: 0.75 }],
        },
        config: { patience: 2 },
      }),
    );

    const exported = planResultExport({ project_root: projectRoot, run_id: PARENT });
    assert.deepEqual(
      exported.candidate.child_summaries.map((summary) => summary.run_id).sort(),
      plan.children.map((child) => child.run_id).sort(),
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
