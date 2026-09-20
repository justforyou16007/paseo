import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bridgeInputPaths,
  buildBridgeInput,
  prepareBridgeInput,
  type BridgeInputSources,
} from "../src/tools/bridge-input.js";
import { createBaselineScope, type BaselineScope } from "../src/tools/baseline-scope.js";
import type { DecompositionGraph } from "../src/tools/decomposition-graph.js";
import {
  createResourceInventory,
  type ResourceInventory,
} from "../src/tools/resource-inventory.js";
import { createRootRun, runJsonPath } from "../src/tools/run-contract.js";
import {
  createWorkflowRuntimeState,
  writeWorkflowRuntimeState,
  workflowRuntimePath,
  workflowCycleWorkerDirectory,
} from "../src/tools/workflow-state.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_RUN_ID = "run-a2-5-bridge-input";
const BRIDGE_ITERATION = 1;

function declaredBridgeContract(): Record<string, any> {
  const skill = fs.readFileSync(path.join(PACKAGE_ROOT, "skills/idea-discovery/SKILL.md"), "utf8");
  const match = skill.match(/<!-- A2-5-BRIDGE-CONTRACT:START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- A2-5-BRIDGE-CONTRACT:END -->/);
  assert.ok(match);
  const contract = JSON.parse(match[1]!);
  assert.equal(contract.contract, "idea-discovery.bridge-input");
  return contract.fields;
}

function baseline(): BaselineScope {
  return createBaselineScope({
    schema_version: 1,
    baseline_id: "W_0",
    workflow_definition: { modules: [{ id: "main" }], edges: [] },
    code_baseline: { ref: "commit:a2-5-phase3", sha256: HASH_A },
    position_artifacts: {
      main: { artifact_ref: "artifact:main", artifact_sha256: HASH_B },
    },
    initial_validation: {
      scorer_revision: "scorer:a2-5-phase3",
      input_snapshot_sha256: HASH_C,
      judge_binding: { role: "fixed-judge", revision: "judge:a2-5-phase3" },
      metrics: { score: 0.4 },
    },
    optimizable_scope: [{ position_id: "main", mode: "independent" }],
    max_bundled_positions_per_graph: 0,
  });
}

function resourceInventory(): ResourceInventory {
  return createResourceInventory({
    schema_version: 1,
    inventory_id: "resources:a2-5-phase3",
    platforms: [
      {
        platform_id: "cpu-a",
        access_ref: "credential:a2-5-phase3",
        accelerators: [],
        cpu: { cores: 4, memory_gb: 16 },
        capacity: { max_parallel_nodes: 1 },
        quota: { amount: 1, unit: "cpu_hours" },
        writable_paths: [{ path: "/workspace/**", capacity_bytes: 1_000_000 }],
        network: { internet: false, allowed_endpoints: [] },
        max_wall_clock_ms: 60_000,
        time_window: { start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
      },
    ],
  });
}

function sources(
  positionIds: readonly string[] = ["main"],
): BridgeInputSources {
  const base = baseline();
  return {
    run: { run_id: BRIDGE_RUN_ID, depth: 0, scope_path: "/" },
    charter: {
      optimizable_scope: base.optimizable_scope,
    },
    baseline: base,
    resource_inventory: resourceInventory(),
    idea_discovery: {
      module_identity: { module_id: "main" },
      frozen_wiki_query_hash: HASH_A,
      children: positionIds.map(position_id => ({position_id, candidate_id: `arbitrary:${position_id}`, execution_plan: {method: "compare local candidate"}, charter: {problem: "local task"}})),
      strategy: "dfs",
      strategy_reason: "Resolve the observed bottleneck before another comparison",
      plan_hash: HASH_B,
      plan_paths: ["outputs/plan.json"],
      budget_used: { amount: 1, unit: "gpu_hours" },
      evidence_references: ["evidence:idea-discovery"],
    },
  };
}

interface ManifestPathFixture {
  projectRoot: string;
  runId: string;
  iteration: number;
  workerRoot: string;
  workerDirectory: string;
  manifestPath: string;
  receiptPath: string;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeManifestPathFixtureAt(
  workerRoot: string,
  runId: string,
  iteration: number,
  workerDirectoryRelativePath: string,
  manifestOverrides: Record<string, unknown> = {},
): Pick<ManifestPathFixture, "workerDirectory" | "manifestPath" | "receiptPath"> {
  const workerDirectory = path.join(workerRoot, workerDirectoryRelativePath);
  const outputDirectory = path.join(workerDirectory, "outputs");
  const manifestPath = path.join(workerDirectory, "input-manifest.json");
  const receiptPath = path.join(workerDirectory, "receipt.json");
  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(manifestPath, {
    worker: "idea-discovery",
    run_id: runId,
    iteration,
    output_dir: outputDirectory,
    inputs: {},
    context: {},
    ...manifestOverrides,
  });
  writeJson(receiptPath, {
    worker: "idea-discovery",
    run_id: runId,
    iteration,
    status: "done",
    primary_output: "idea-discovery.json",
  });
  return { workerDirectory, manifestPath, receiptPath };
}

function createManifestPathFixture(
  manifestOverrides: Record<string, unknown> = {},
  workerDirectoryRelativePath = "worker",
): ManifestPathFixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-bridge-input-project-"));
  const runId = BRIDGE_RUN_ID;
  const iteration = BRIDGE_ITERATION;
  createRootRun({
    project_root: projectRoot,
    run_id: runId,
    
    
    
    charter_sha256: HASH_A,
    input_snapshot_sha256: HASH_B,
    execution_plan_sha256: HASH_C,
    code_baseline_sha256: HASH_A,
    policy_revision: "policy:a2-5-bridge-input",
  });
  const workerRoot = workflowCycleWorkerDirectory(projectRoot, runId, iteration);
  const paths = writeManifestPathFixtureAt(
    workerRoot,
    runId,
    iteration,
    workerDirectoryRelativePath,
    manifestOverrides,
  );
  return { projectRoot, runId, iteration, workerRoot, ...paths };
}

function expectError(
  action: () => unknown,
  code: string,
  message: string,
  onError?: (error: { code?: string; message?: string }) => void,
): void {
  assert.throws(action, (error: unknown) => {
    const actual = error as { code?: string; message?: string };
    assert.equal(actual.code, code);
    assert.equal(actual.message, `${code}: ${message}`);
    onError?.(actual);
    return true;
  });
}

test("the documented bridge contract requires explicit children and a reason for their order", () => {
  const fields = declaredBridgeContract();
  assert.equal(fields.children.required,true);
  assert.equal(fields.children.type,"array<object>");
  assert.equal(fields.strategy_reason.required,true);
  assert.ok(fields.children.required_item_fields.includes("execution_plan"));
});

test("bridge preserves declared child plans and does not infer positions from candidate IDs", () => {
  const input=sources(); const result=buildBridgeInput(input);
  assert.deepEqual(result.positions, (input.idea_discovery as any).children.map((child:any)=>({...child,mode:"independent"})));
  assert.equal(result.strategy,"dfs");
  assert.equal(result.strategy_reason,(input.idea_discovery as any).strategy_reason);
  assert.equal(result.run,input.run);
});

test("a run can perform its own experiment without dispatching children", () => {
  assert.deepEqual(buildBridgeInput(sources([])).positions,[]);
});

test("the production bridge reader rejects a missing dispatch list", () => {
  const input=sources(); delete (input.idea_discovery as any).children;
  expectError(()=>buildBridgeInput(input),"INVALID_VALUE","idea-discovery must explicitly list dispatched children (an empty list is allowed)");
});

test("bridge rejects positions outside the charter scope", () => {
  expectError(()=>buildBridgeInput(sources(["missing"])),"OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED","child position or mode is outside the charter scope");
});

test("manifest must be a direct child of the workflow cycle workers root", () => {
  const fixture = createManifestPathFixture({}, "nested/worker");
  expectError(
    () =>
      bridgeInputPaths(fixture.projectRoot, fixture.runId, fixture.iteration, fixture.manifestPath),
    "PATH_ESCAPE",
    "idea-discovery manifest must be directly below the cycle workers directory",
  );
});

test("the canonical workflow cycle worker root accepts the new path and rejects the alternate path", () => {
  const fixture = createManifestPathFixture();
  const accepted = bridgeInputPaths(
    fixture.projectRoot,
    fixture.runId,
    fixture.iteration,
    fixture.manifestPath,
  );
  assert.equal(accepted.worker_directory, fixture.workerDirectory);
  console.log(`CANONICAL_WORKER_ROOT_ACCEPTED ${fixture.workerRoot}`);

  const cycleDirectory = path.dirname(fixture.workerRoot);
  const cycleContainer = path.dirname(cycleDirectory);
  const alternateLayout = path.basename(cycleContainer) === "cycles" ? "cycle-dirs" : "cycles";
  const alternateWorkerRoot = path.join(
    path.dirname(cycleContainer),
    alternateLayout,
    String(fixture.iteration),
    "workers",
  );
  const alternate = writeManifestPathFixtureAt(
    alternateWorkerRoot,
    fixture.runId,
    fixture.iteration,
    "alternate-worker",
  );
  expectError(
    () =>
      bridgeInputPaths(
        fixture.projectRoot,
        fixture.runId,
        fixture.iteration,
        alternate.manifestPath,
      ),
    "PATH_ESCAPE",
    "idea-discovery manifest must be directly below the cycle workers directory",
    (error) => console.log(`ALTERNATE_WORKER_ROOT_REJECTED ${error.message}`),
  );
});

test("manifest worker identity is checked before bridge input preparation", () => {
  const fixture = createManifestPathFixture({ worker: "experiment-bridge" });
  expectError(
    () =>
      bridgeInputPaths(fixture.projectRoot, fixture.runId, fixture.iteration, fixture.manifestPath),
    "WORKER_NOT_ALLOWED",
    "the upstream manifest must belong to idea-discovery",
  );
});

test("manifest run identity is checked independently", () => {
  const fixture = createManifestPathFixture({ run_id: "run-a2-5-other" });
  expectError(
    () =>
      bridgeInputPaths(fixture.projectRoot, fixture.runId, fixture.iteration, fixture.manifestPath),
    "IDENTITY_MISMATCH",
    "idea-discovery manifest run_id does not match the active run",
  );
});

test("manifest iteration identity is checked independently", () => {
  const fixture = createManifestPathFixture({ iteration: 2 });
  expectError(
    () =>
      bridgeInputPaths(fixture.projectRoot, fixture.runId, fixture.iteration, fixture.manifestPath),
    "IDENTITY_MISMATCH",
    "idea-discovery manifest iteration does not match the active cycle",
  );
});

test("manifest output_dir must be its worker outputs directory", () => {
  const fixture = createManifestPathFixture({
    output_dir: path.join(fixtureOutputRootPlaceholder(), "wrong-outputs"),
  });
  expectError(
    () =>
      bridgeInputPaths(fixture.projectRoot, fixture.runId, fixture.iteration, fixture.manifestPath),
    "IDENTITY_MISMATCH",
    "idea-discovery manifest output_dir must be its worker outputs directory",
  );
});

function fixtureOutputRootPlaceholder(): string {
  return path.join(os.tmpdir(), "aris-a2-5-bridge-input-not-worker-outputs");
}

/** A generation the parent already recorded, in the shape it is read back in. */
function decomposition(positionIds: readonly string[]): DecompositionGraph {
  return {
    schema_version: 1,
    parent_run_id: BRIDGE_RUN_ID,
    generation: 2,
    positions: positionIds.map((position_id) => ({
      position_id,
      problem: `decided question for ${position_id}`,
      expected_output: "a report",
      constraints: { deadline: "one day" },
      depends_on: [],
    })),
    decomposition_sha256: HASH_C,
    created_at: "2026-01-01T00:00:00Z",
  };
}

test("an orchestration dispatch carries the task the decomposition froze, not the one the upstream restated", () => {
  const input = sources();
  const graph = decomposition(["main"]);
  const result = buildBridgeInput({ ...input, decomposition: graph });
  assert.equal(result.orchestration, true);
  assert.equal(result.generation, 2);
  // The upstream artifact said `problem: "local task"`; the recorded graph wins,
  // and the edges come with it.
  assert.deepEqual(result.positions[0]!.charter, {
    problem: "decided question for main",
    expected_output: "a report",
    constraints: { deadline: "one day" },
  });
  assert.deepEqual(result.positions[0]!.depends_on, []);
});

test("an orchestration dispatch cannot invent a position the decomposition does not have", () => {
  expectError(
    () => buildBridgeInput({ ...sources(), decomposition: decomposition(["other"]) }),
    "DECOMPOSITION_MISMATCH",
    "position 'main' is not in generation 2 of this run's decomposition",
  );
});

test("two child tasks cannot claim one position in the same plan", () => {
  expectError(()=>buildBridgeInput(sources(["main","main"])),"DUPLICATE_ID","candidate positions map to 'main' more than once");
});

function createRuntimeBridgeFixture() {
  const fixture = createManifestPathFixture();
  const runtime = createWorkflowRuntimeState({
    project_root: fixture.projectRoot,
    execution_root: fixture.projectRoot,
    outer_run_id: fixture.runId,
    task_id: "task:bridge-input",
    workflow_id: "workflow:bridge-input",
  });
  writeWorkflowRuntimeState(fixture.projectRoot, runtime);
  return {
    ...fixture,
    runtimePath: workflowRuntimePath(fixture.projectRoot, fixture.runId),
    request: {
      project_root: fixture.projectRoot,
      execution_root: fixture.projectRoot,
      outer_run_id: fixture.runId,
      idea_discovery_manifest_path: fixture.manifestPath,
    },
  };
}

test("bridge preparation rejects canonical/runtime identity disagreement without writes", () => {
  const fixture = createRuntimeBridgeFixture();
  try {
    const raw = JSON.parse(fs.readFileSync(fixture.runtimePath, "utf8"));
    writeJson(fixture.runtimePath, {
      ...raw,
      parent_run_id: "run-other",
      depth: 1,
      scope_path: "/different",
      
      
      
    });
    const contractPath = runJsonPath(fixture.projectRoot, fixture.runId);
    const contractBefore = fs.readFileSync(contractPath);
    const runtimeBefore = fs.readFileSync(fixture.runtimePath);
    expectError(
      () => prepareBridgeInput(fixture.request),
      "IDENTITY_MISMATCH",
      "workflow runtime and run.json identities differ",
    );
    assert.deepEqual(fs.readFileSync(contractPath), contractBefore);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), runtimeBefore);
    assert.equal(
      fs.existsSync(path.join(fixture.workerDirectory, "outputs/bridge-input.json")),
      false,
    );
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

for (const field of ["project_root", "execution_root"] as const) {
  test(`bridge preparation rejects a runtime ${field} different from the command locator`, () => {
    const fixture = createRuntimeBridgeFixture();
    try {
      const raw = JSON.parse(fs.readFileSync(fixture.runtimePath, "utf8"));
      writeJson(fixture.runtimePath, { ...raw, [field]: path.join(fixture.projectRoot, "other") });
      expectError(
        () => prepareBridgeInput(fixture.request),
        "IDENTITY_MISMATCH",
        "workflow-runtime.json roots differ from command locators",
      );
    } finally {
      fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
    }
  });
}
