import { initializeRunBudget } from "../../src/tools/run-budget.js";
import path from "node:path";
import { bridgeFixture } from "./recursive-fixture.js";
import fs from "node:fs";
import crypto from "node:crypto";
import { sealWikiWorkerManifest, wikiWorkerManifestPath } from "../../src/tools/research-wiki.js";
import { updateRun } from "../../src/tools/run-contract.js";
import { createBaselineScope } from "../../src/tools/baseline-scope.js";
import { createResourceInventory } from "../../src/tools/resource-inventory.js";
import { planExperimentBridge } from "../../src/tools/experiment-bridge.js";
import { createBridgeChildRun, readRun, type RunRecord } from "../../src/tools/run-contract.js";

// State tests prepare children (module or tester) through B; their outer root must exist.
export function createChildContract(
  root: string,
  parentRunId: string,
  runId: string,
  positionId: string,
  // Whether this child carries the evidence that lets it expand further. Most
  // tests want a child that just runs, so the default is the plain shape.
  expandable = false,
  // How much the child may spend. Tests that need the child to actually run
  // out of budget pass the exact number of dispatches they make.
  childBudget = 10,
): RunRecord {
  const parent = readRun(root, parentRunId);
  if (!fs.existsSync(path.join(root, ".aris/runs", parentRunId, "budget.json"))) initializeRunBudget(root, parentRunId, { amount: 1000, unit: "gpu_hours" });
  if (!fs.existsSync(wikiWorkerManifestPath(root, parentRunId)))
    sealWikiWorkerManifest({ project_root: root, run_id: parentRunId, worker: "idea-discovery", input_snapshot: parent.parent_run_id === null ? null : { ref: `.aris/runs/${parentRunId}/input-snapshot.json`, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, ".aris/runs", parentRunId, "input-snapshot.json"))).digest("hex") } });
  updateRun(root, parentRunId, {
    output_hashes: {
      ...parent.output_hashes,
      "input-manifest.json": crypto
        .createHash("sha256")
        .update(fs.readFileSync(wikiWorkerManifestPath(root, parentRunId)))
        .digest("hex"),
    },
  });
  const baseline = createBaselineScope({
    schema_version: 1,
    baseline_id: "W_0",
    workflow_definition: { modules: [{ id: positionId }], edges: [] },
    code_baseline: { ref: "commit:module-fixture", sha256: "a".repeat(64) },
    position_artifacts: {
      [positionId]: { artifact_ref: "artifact:main", artifact_sha256: "b".repeat(64) },
    },
    initial_validation: {
      scorer_revision: "scorer:module-fixture",
      input_snapshot_sha256: "c".repeat(64),
      judge_binding: { role: "fixed-judge", revision: "judge:module-fixture" },
      metrics: { score: 0.4 },
    },
    optimizable_scope: [{ position_id: positionId, mode: "independent" }],
    max_bundled_positions_per_graph: 0,
  });
  const resource = createResourceInventory({
    schema_version: 1,
    inventory_id: "resources:module-fixture",
    platforms: [
      {
        platform_id: "gpu-a",
        access_ref: "credential:module-fixture",
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
    run: parent,
    strategy: expandable ? "dfs" : "bfs",
    charter: {
      schema_version: 1,
      charter_id: `charter:${parentRunId}`,
      run_id: parent.run_id,

      
      expected_output: "module state fixture child",
      budget: { amount: 1000, unit: "gpu_hours" },
      
      
      baseline_sha256: baseline.baseline_sha256,
      resource_inventory_sha256: resource.inventory_sha256,
      optimizable_scope: baseline.optimizable_scope,
      policy_revision: parent.identity_material.policy_revision,
      code_baseline_sha256: parent.identity_material.code_baseline_sha256 ?? "a".repeat(64),
    },
    baseline,
    resource_inventory: resource,
    positions: [
      {
        
        ...(expandable
          ? {
              evidence: {
                completed_round: true,
                bottleneck: true,
                relative_improvement: 0.01,
                validation_threshold: 0.1,
                acceptance: "independent",
              },
            }
          : {}),
        position_id: positionId,
        mode: "independent",
        child_run_id: runId,
        budget: { amount: childBudget, unit: "gpu_hours" },
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
  return createBridgeChildRun({ project_root: root, plan, child_run_id: runId });
}
