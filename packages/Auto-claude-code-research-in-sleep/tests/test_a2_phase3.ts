import { initializeRunBudget } from "../src/tools/run-budget.js";
import { bridgeFixture } from "./helpers/recursive-fixture.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  planExperimentBridge,
  type ExperimentBridgeInput,
  type BridgePositionInput,
} from "../src/tools/experiment-bridge.js";
import {
  createResourceInventory,
  saveResourceInventory,
  type ResourceInventory,
} from "../src/tools/resource-inventory.js";
import {
  beginOuterCycle,
  runAutoResearchBridge,
  startOuterRunForTest,
  type AutoResearchBridgeResult,
} from "../src/tools/workflow-runtime.js";
import {
  frozenPolicyPath,
  readWorkflowRuntimeState,
  workflowDashboardPath,
  workflowRuntimePath,
  type FreezeOuterRunInput,
} from "../src/tools/workflow-state.js";
import { createTaskSetup } from "../src/tools/task-setup.js";
import { buildTesterDefinition } from "../src/tools/tester-state.js";
import { createRootRun, runJsonPath, runOwnedPath } from "../src/tools/run-contract.js";
import { createRootCharter, saveRootCharter } from "../src/tools/root-charter.js";
import {
  createBaselineScope,
  saveBaselineScope,
  type BaselineScope,
} from "../src/tools/baseline-scope.js";
import { writeStateJsonAtomic } from "../src/tools/state-file.js";

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");
const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const ROOT_RUN_ID = "root-a2-5-phase3";
const TASK_ID = "task:a2-5-phase3";
const WORKFLOW_ID = "workflow:a2-5-phase3";
const POLICY_REVISION = "policy:a2-5-phase3";

function baseline(
  positionIds: readonly string[] = ["main"],
  optimizableScope = positionIds.map((position_id) => ({ position_id, mode: "independent" })),
  maxBundledPositionsPerGraph = 0,
): BaselineScope {
  return createBaselineScope({
    schema_version: 1,
    baseline_id: "W_0",
    workflow_definition: { modules: positionIds.map((id) => ({ id })), edges: [] },
    code_baseline: { ref: "commit:a2-5-phase3", sha256: HASH_A },
    position_artifacts: Object.fromEntries(
      positionIds.map((id, index) => [
        id,
        { artifact_ref: `artifact:${id}`, artifact_sha256: index === 0 ? HASH_B : HASH_C },
      ]),
    ),
    initial_validation: {
      scorer_revision: "scorer:a2-5-phase3",
      input_snapshot_sha256: HASH_C,
      judge_binding: { role: "fixed-judge", revision: "judge:a2-5-phase3" },
      metrics: { score: 0.4 },
    },
    optimizable_scope: optimizableScope,
    max_bundled_positions_per_graph: maxBundledPositionsPerGraph,
  });
}

function resourceInventory(): ResourceInventory {
  return createResourceInventory({
    schema_version: 1,
    inventory_id: "resources:a2-5-phase3",
    platforms: [
      {
        platform_id: "gpu-a",
        access_ref: "credential:a2-5-phase3",
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

function bridgeCharter(
  base: BaselineScope,
  resource: ResourceInventory,
  runId = ROOT_RUN_ID,
): Record<string, unknown> {
  return {
    schema_version: 1,
    charter_id: "charter:a2-5-phase3",
    run_id: runId,

    
    expected_output: "a candidate artifact with reproducible evidence",
    budget: { amount: 10, unit: "gpu_hours" },
    
    
    baseline_sha256: base.baseline_sha256,
    resource_inventory_sha256: resource.inventory_sha256,
    optimizable_scope: base.optimizable_scope,
    policy_revision: POLICY_REVISION,
    code_baseline_sha256: base.code_baseline.sha256,
  };
}

function bridgePosition(positionId = "main"): BridgePositionInput {
  return {
    position_id: positionId,
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
    candidate_id: `candidate:${positionId}`,
    result_status: "succeeded",
  };
}

function freezeInput(projectRoot: string, runId: string): FreezeOuterRunInput {
  const modelUsagePolicy = {
    revision: "policy:a2-5-phase3-model",
    approval_id: "approval:a2-5-phase3-model",
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
        approval_id: "approval:main-model",
      },
    ],
  } as const;
  const taskSetup = createTaskSetup({
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
    setup_revision: "setup:a2-5-phase3",
    model_usage_policy: modelUsagePolicy,
    tester_id: "tester:a2-5-phase3",
    tester_version: "tester:v1",
  });
  const tester = buildTesterDefinition({
    schema_version: 1,
    tester_id: "tester:a2-5-phase3",
    version: "tester:v1",
    immutable: true,
    case_manifest_id: "cases:a2-5-phase3",
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
      { kind: "deterministic_rules", definition_version: "rules:a2-5-phase3", judge_binding: null },
    ],
  });
  return {
    project_root: projectRoot,
    outer_run_id: runId,
    task_id: TASK_ID,
    owner_limits: {
      revision: "limits:a2-5-phase3",
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

interface PreparedRun {
  projectRoot: string;
  executionRoot: string;
  result: AutoResearchBridgeResult;
}

function prepareRun(): PreparedRun {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-phase3-project-"));
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-phase3-execution-"));
  const base = baseline();
  const resource = resourceInventory();
  createRootRun({
    project_root: projectRoot,
    run_id: ROOT_RUN_ID,
    
    
    
    charter_sha256: HASH_A,
    input_snapshot_sha256: HASH_C,
    execution_plan_sha256: HASH_B,
    code_baseline_sha256: HASH_A,
    policy_revision: POLICY_REVISION,
  });
  const evidencePath = path.join(projectRoot, "loop-evidence.txt");
  fs.writeFileSync(
    evidencePath,
    "idea, charter, baseline, resources, and evidence are ready\n",
    "utf8",
  );
  const bridge: ExperimentBridgeInput = bridgeFixture({
    charter: bridgeCharter(base, resource),
    baseline: base,
    resource_inventory: resource,
    positions: [bridgePosition()],
  });
  initializeRunBudget(projectRoot, ROOT_RUN_ID, {amount:10,unit:"gpu_hours"});
  const result = runAutoResearchBridge({
    execution_root: executionRoot,
    project_root: projectRoot,
    outer_run_id: ROOT_RUN_ID,
    parent_run_id: null,
    depth: 0,
    scope_path: "/",
    
    
    
    bridge,
    evidence_paths: [evidencePath],
  });
  return { projectRoot, executionRoot, result };
}

function cleanup(prepared: PreparedRun): void {
  fs.rmSync(prepared.projectRoot, { recursive: true, force: true });
  fs.rmSync(prepared.executionRoot, { recursive: true, force: true });
}

function directoryFileHashes(directory: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (current: string, relativeDirectory: string): void => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hashes[relativePath] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(absolutePath))
          .digest("hex");
      }
    }
  };
  visit(directory, "");
  return hashes;
}

function childIdentity(prepared: PreparedRun): {
  execution_root: string;
  project_root: string;
  outer_run_id: string;
  parent_run_id: string;
  depth: number;
  scope_path: string;
  
  
  
  task_id: string;
  workflow_id: string;
} {
  const child = prepared.result.plan.children[0]!;
  return {
    execution_root: prepared.executionRoot,
    project_root: prepared.projectRoot,
    outer_run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    depth: child.depth,
    scope_path: child.scope_path,
    
    
    
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
  };
}

function startChild(prepared: PreparedRun): void {
  const identity = childIdentity(prepared);
  startOuterRunForTest({
    ...identity,
    freeze_input: freezeInput(prepared.projectRoot, identity.outer_run_id),
  });
}

interface RuntimeBridgeFixture {
  projectRoot: string;
  executionRoot: string;
  runId: string;
  parentRunId: string | null;
  depth: number;
  scopePath: string;
  
  maxDepth: number;
  depthBudget: number;
  iteration: number;
  evidencePath: string;
  base: BaselineScope;
  resource: ResourceInventory;
  workerDirectory: string;
  manifestPath: string;
  ideaDiscoveryPath: string;
  receiptPath: string;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function directorySnapshot(root: string): Set<string> {
  const directories = new Set<string>();
  const visit = (directory: string): void => {
    const normalized = path.resolve(directory);
    directories.add(normalized);
    for (const entry of fs.readdirSync(normalized, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(normalized, entry.name));
    }
  };
  visit(root);
  return directories;
}

function documentedManifestPattern(): string {
  const shared = sharedBridgeReference();
  const manifestPattern = shared.match(
    /^\$PROJECT_ROOT\/\.aris\/runs\/\$OUTER_RUN_ID\/cycles\/\$\{OUTER_ITERATION\}\/workers\/<directory-containing-the-runtime-manifest>\/input-manifest\.json$/m,
  );
  assert.ok(
    manifestPattern,
    "shared bridge reference must define the verified cycle workers manifest pattern",
  );
  return manifestPattern![0]!;
}

function documentedCycleWorkerDirectory(
  projectRoot: string,
  runId: string,
  iteration: number,
): string {
  const manifestPath = path.resolve(
    documentedManifestPattern()
      .replace("$PROJECT_ROOT", projectRoot)
      .replace("$OUTER_RUN_ID", runId)
      .replace("${OUTER_ITERATION}", String(iteration))
      .replace("<directory-containing-the-runtime-manifest>", "documented-worker"),
  );
  return path.dirname(path.dirname(manifestPath));
}

function observeCreatedCycleDirectory(
  projectRoot: string,
  runId: string,
  iteration: number,
  before: ReadonlySet<string>,
): string {
  const runDirectory = runOwnedPath(projectRoot, runId);
  const created = [...directorySnapshot(runDirectory)].filter(
    (directory) => !before.has(directory),
  );
  const documentedWorkerDirectory = documentedCycleWorkerDirectory(projectRoot, runId, iteration);
  const documentedCycleDirectory = path.dirname(documentedWorkerDirectory);
  assert.ok(
    created.includes(documentedCycleDirectory),
    `beginOuterCycle must create the documented cycle directory\nworkflow-runtime.json.outer_iteration=${iteration} expects ${documentedCycleDirectory}; newly created directories: ${created.join(", ") || "<none>"}`,
  );
  const nestedCreated = created.filter((directory) => {
    const relative = path.relative(documentedCycleDirectory, directory);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  });
  assert.deepEqual(
    nestedCreated,
    [],
    "beginOuterCycle must not create nested directories under the documented cycle directory",
  );
  return documentedCycleDirectory;
}

/*
 * This observer proves that the cycle directory created in this call is the
 * directory described by the shared bridge pattern for the persisted outer
 * iteration. It cannot prove that a caller supplied the right iteration or
 * that beginOuterCycle chose the right next iteration. The production caller
 * validates and writes that value; the end-to-end fixtures read it back from
 * workflow-runtime.json before invoking this observer. The boundary matrix
 * below does not run beginOuterCycle, so its literal iteration 1 is only a
 * synthetic path-shape input. If two sibling cycle directories appear in the
 * same new-directory set, this observer cannot tell which one is the current
 * cycle and will accept the one named by persisted outer_iteration. The
 * beginOuterCycle writer must guarantee one cycle directory and persist the
 * matching runtime state before the caller reads it back.
 */

function sharedBridgeReference(): string {
  return fs.readFileSync(
    path.join(PACKAGE_ROOT, "skills/shared-references/bridge-expansion.md"),
    "utf8",
  );
}

function documentedBridgePaths(
  projectRoot: string,
  runId: string,
  iteration: number,
  workerDirectory: string,
): {
  manifestPath: string;
  ideaDiscoveryPath: string;
  bridgeInputPath: string;
  receiptPath: string;
} {
  const shared = sharedBridgeReference();
  const manifestPattern = documentedManifestPattern();
  const manifestPath = path.resolve(
    manifestPattern
      .replace("$PROJECT_ROOT", projectRoot)
      .replace("$OUTER_RUN_ID", runId)
      .replace("${OUTER_ITERATION}", String(iteration))
      .replace("<directory-containing-the-runtime-manifest>", path.basename(workerDirectory)),
  );

  const assignment = (variable: string): string => {
    const match = shared.match(new RegExp(`^${variable}="([^"]+)"$`, "m"));
    assert.ok(match, `shared bridge reference must define ${variable}`);
    return path.resolve(match![1]!.replace("$IDEA_DISCOVERY_WORKER_DIR", workerDirectory));
  };
  return {
    manifestPath,
    ideaDiscoveryPath: assignment("IDEA_DISCOVERY_JSON"),
    bridgeInputPath: assignment("BRIDGE_INPUT_JSON"),
    receiptPath: assignment("BRIDGE_EVIDENCE_PATH"),
  };
}

function createIdeaDiscoveryWorkerFixture(
  workerRoot: string,
  runId: string,
  iteration: number,
  workerDirectoryName: string,
  evidencePath: string,
  base: BaselineScope,
): Pick<
  RuntimeBridgeFixture,
  "workerDirectory" | "manifestPath" | "ideaDiscoveryPath" | "receiptPath"
> {
  const workerDirectory = path.join(workerRoot, workerDirectoryName);
  const outputDirectory = path.join(workerDirectory, "outputs");
  const manifestPath = path.join(workerDirectory, "input-manifest.json");
  const ideaDiscoveryPath = path.join(outputDirectory, "idea-discovery.json");
  const receiptPath = path.join(workerDirectory, "receipt.json");
  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(manifestPath, {
    worker: "idea-discovery",
    iteration,
    run_id: runId,
    inputs: {},
    context: {},
    output_dir: outputDirectory,
  });
  writeJson(ideaDiscoveryPath, {
    module_identity: { run_id: runId, iteration },
    frozen_wiki_query_hash: HASH_A,
    candidate_ids: ["candidate:main"],
    // The declared children must sit in the scope of the charter this run
    // actually works from, so they are built from that run's baseline rather
    // than from a second, unrelated one.
    children: bridgeFixture({charter: bridgeCharter(base,resourceInventory(),runId),baseline:base,resource_inventory:resourceInventory(),positions:[{...bridgePosition(), mode: "bundled"}]}).positions,
    strategy: "bfs",
    strategy_reason: "Compare the proposed local experiment before further decomposition",
    plan_hash: HASH_B,
    plan_paths: ["outputs/plan.json"],
    budget_used: { amount: 1, unit: "gpu_hours" },
    evidence_references: [evidencePath],
  });
  writeJson(receiptPath, {
    worker: "idea-discovery",
    iteration,
    run_id: runId,
    status: "done",
    error: null,
    primary_output: "idea-discovery.json",
    summary: { candidate_count: 1 },
    dashboard_patch: {},
    completed_at: "2026-09-12T00:00:00.000Z",
    has_errors: false,
    error_count: 0,
  });
  return { workerDirectory, manifestPath, ideaDiscoveryPath, receiptPath };
}

function createRootRuntimeBridgeFixture(): RuntimeBridgeFixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-phase3-chain-project-"));
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-phase3-chain-exec-"));
  const base = baseline(
    ["main", "second"],
    [{ position_id: "main", mode: "bundled", bundle_members: ["main", "second"] }],
    1,
  );
  const resource = resourceInventory();
  const charter = createRootCharter({
    run_id: ROOT_RUN_ID,
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
    setup_revision: "setup:a2-5-phase3",
    problem: "prove the bridge hand-off",
    expected_output: "a child contract with reproducible evidence",
    workflow_definition: base.workflow_definition,
    baseline: base,
    resource_inventory: resource,
    owner_limits: {
      revision: "limits:a2-5-phase3",
      
      max_bundled_positions_per_graph: 1,
      max_nodes: 4,
      max_edges: 4,
      max_fan_out_per_node: 2,
    },
    budget: { amount: 10, unit: "gpu_hours" },
    tester_ref: "tester:a2-5-phase3",
    exposure_limit: 4,
    task_setup_sha256: HASH_A,
    tester_definition_sha256: HASH_B,
    tester_agent_sha256: HASH_C,
    validation_thresholds_sha256: HASH_A,
    owner_limits_sha256: HASH_B,
    policy_revision: POLICY_REVISION,
    
  });
  createRootRun({
    project_root: projectRoot,
    run_id: ROOT_RUN_ID,
    
    
    
    charter_sha256: charter.charter_sha256,
    input_snapshot_sha256: HASH_C,
    execution_plan_sha256: HASH_B,
    code_baseline_sha256: HASH_A,
    policy_revision: POLICY_REVISION,
  });
  // setupRootRun opens the run's budget account from the charter budget. This
  // fixture writes the contract directly, so it opens the same account with the
  // same amount the charter above declares.
  initializeRunBudget(projectRoot, ROOT_RUN_ID, { amount: 10, unit: "gpu_hours" });
  saveBaselineScope(projectRoot, ROOT_RUN_ID, base);
  saveResourceInventory(projectRoot, ROOT_RUN_ID, resource);
  saveRootCharter(projectRoot, ROOT_RUN_ID, charter);

  const evidencePath = path.join(projectRoot, "root-cycle-evidence.txt");
  fs.writeFileSync(evidencePath, "root cycle evidence\n", "utf8");
  startOuterRunForTest({
    execution_root: executionRoot,
    project_root: projectRoot,
    outer_run_id: ROOT_RUN_ID,
    parent_run_id: null,
    depth: 0,
    scope_path: "/",
    
    
    
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
    freeze_input: freezeInput(projectRoot, ROOT_RUN_ID),
  });
  const directoriesBeforeCycle = directorySnapshot(runOwnedPath(projectRoot, ROOT_RUN_ID));
  beginOuterCycle({
    execution_root: executionRoot,
    project_root: projectRoot,
    outer_run_id: ROOT_RUN_ID,
    parent_run_id: null,
    depth: 0,
    scope_path: "/",
    
    
    
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
    wave_id: "wave:a2-5-phase3-root",
    wave_kind: "module",
    evidence_paths: [evidencePath],
  });
  const persistedRuntime = readWorkflowRuntimeState(projectRoot, ROOT_RUN_ID);
  const runtimeCycleDirectory = observeCreatedCycleDirectory(
    projectRoot,
    ROOT_RUN_ID,
    persistedRuntime.outer_iteration,
    directoriesBeforeCycle,
  );
  const worker = createIdeaDiscoveryWorkerFixture(
    path.join(runtimeCycleDirectory, "workers"),
    ROOT_RUN_ID,
    persistedRuntime.outer_iteration,
    "runtime-picked-root-worker",
    evidencePath,
    base,
  );
  return {
    projectRoot,
    executionRoot,
    runId: ROOT_RUN_ID,
    parentRunId: null,
    depth: 0,
    scopePath: "/",
    
    maxDepth: 2,
    depthBudget: 2,
    iteration: persistedRuntime.outer_iteration,
    evidencePath,
    base,
    resource,
    ...worker,
  };
}

function runBridgeHandoff(fixture: RuntimeBridgeFixture, label: string): AutoResearchBridgeResult {
  const documented = documentedBridgePaths(
    fixture.projectRoot,
    fixture.runId,
    fixture.iteration,
    fixture.workerDirectory,
  );

  const cliPath = path.join(PACKAGE_ROOT, "src/tools/workflow-cli.ts");
  const prep = spawnSync(
    process.execPath,
    [
      TSX_CLI,
      cliPath,
      "bridge-input",
      "--execution-root",
      fixture.executionRoot,
      "--project",
      fixture.projectRoot,
      "--run",
      fixture.runId,
      "--idea-discovery-manifest",
      fixture.manifestPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    prep.status,
    0,
    `${label} bridge-input preparation must succeed at the documented runtime path: ${prep.stderr}`,
  );
  const prepared = JSON.parse(prep.stdout) as {
    bridge_input_path: string;
    bridge: { positions: unknown[] } & Record<string, unknown>;
  };
  assert.equal(
    path.resolve(prepared.bridge_input_path),
    documented.bridgeInputPath,
    `${label} bridge-input must be written to the documented path`,
  );
  assert.deepEqual(
    Object.keys(prepared.bridge).sort(),
    [
      "baseline",
      "charter",
      "positions",
      "resource_inventory",
      "run",
      "strategy",
      "strategy_reason",
    ],
    `${label} conversion must emit exactly the bridge's top-level fields`,
  );
  // The conversion owns three fields on each position: which workflow position
  // it fills, how it runs there, and which candidate it answers for. The rest
  // of the position — the charter it works from, its execution plan, its
  // resource request, its declared result status — is what idea-discovery
  // wrote, carried through without edits, so check it against that file.
  const declaredChildren = (
    JSON.parse(fs.readFileSync(fixture.ideaDiscoveryPath, "utf8")) as {
      children: Record<string, unknown>[];
    }
  ).children;
  assert.equal(
    prepared.bridge.positions.length,
    declaredChildren.length,
    `${label} conversion must emit one position per declared child`,
  );
  const position = prepared.bridge.positions[0] as Record<string, unknown>;
  const conversionOwned = ["position_id", "mode", "candidate_id"] as const;
  assert.deepEqual(
    { position_id: position.position_id, mode: position.mode, candidate_id: position.candidate_id },
    { position_id: "main", mode: "bundled", candidate_id: "candidate:main" },
    `${label} conversion must map candidate_ids to explicit charter-aligned positions`,
  );
  const carried = { ...position };
  const declared = { ...declaredChildren[0] };
  for (const owned of conversionOwned) {
    delete carried[owned];
    delete declared[owned];
  }
  assert.deepEqual(
    carried,
    declared,
    `${label} conversion must carry the rest of each position through unchanged`,
  );

  const expand = spawnSync(
    process.execPath,
    [
      TSX_CLI,
      cliPath,
      "bridge-expand",
      "--execution-root",
      fixture.executionRoot,
      "--project",
      fixture.projectRoot,
      "--run",
      fixture.runId,
      "--input",
      prepared.bridge_input_path,
      "--evidence",
      fixture.receiptPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    expand.status,
    0,
    `${label} existing bridge-expand hand-off must succeed: ${expand.stderr}`,
  );
  const result = JSON.parse(expand.stdout) as AutoResearchBridgeResult;
  assert.equal(result.children.length, 1, `${label} must materialize one bridge child`);
  assert.equal(result.opened_children.length, 1, `${label} must open one bridge child`);
  const child = result.children[0]!;
  assert.deepEqual(
    result.opened_children[0],
    child,
    `${label} must open the materialized child unchanged`,
  );
  const childPath = runJsonPath(fixture.projectRoot, child.run_id);
  assert.equal(fs.existsSync(childPath), true, `${label} must write the child run contract`);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(childPath, "utf8")),
    child,
    `${label} persisted child contract must equal the bridge result`,
  );
  console.log(`${label.toUpperCase()}_CHILD_CONTRACT ${JSON.stringify(child)}`);
  return result;
}

function createRecursiveRuntimeBridgeFixture(
  root: RuntimeBridgeFixture,
  child: AutoResearchBridgeResult["plan"]["children"][number],
): RuntimeBridgeFixture {
  saveBaselineScope(root.projectRoot, child.run_id, root.base);
  saveResourceInventory(root.projectRoot, child.run_id, root.resource);
  // Materializing the child already wrote its charter from the parent's plan.
  // Only the baseline and resource inventory are per-run files the bridge does
  // not copy, so the fixture supplies those two and nothing else.
  const evidencePath = path.join(root.projectRoot, "recursive-cycle-evidence.txt");
  fs.writeFileSync(evidencePath, "recursive cycle evidence\n", "utf8");
  startOuterRunForTest({
    execution_root: root.executionRoot,
    project_root: root.projectRoot,
    outer_run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    depth: child.depth,
    scope_path: child.scope_path,
    
    
    
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
    freeze_input: freezeInput(root.projectRoot, child.run_id),
  });
  const directoriesBeforeCycle = directorySnapshot(runOwnedPath(root.projectRoot, child.run_id));
  beginOuterCycle({
    execution_root: root.executionRoot,
    project_root: root.projectRoot,
    outer_run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    depth: child.depth,
    scope_path: child.scope_path,
    
    
    
    task_id: TASK_ID,
    workflow_id: WORKFLOW_ID,
    wave_id: "wave:a2-5-phase3-recursive",
    wave_kind: "module",
    evidence_paths: [evidencePath],
  });
  const persistedRuntime = readWorkflowRuntimeState(root.projectRoot, child.run_id);
  const runtimeCycleDirectory = observeCreatedCycleDirectory(
    root.projectRoot,
    child.run_id,
    persistedRuntime.outer_iteration,
    directoriesBeforeCycle,
  );
  const worker = createIdeaDiscoveryWorkerFixture(
    path.join(runtimeCycleDirectory, "workers"),
    child.run_id,
    persistedRuntime.outer_iteration,
    "runtime-picked-recursive-worker",
    evidencePath,
    root.base,
  );
  return {
    ...root,
    runId: child.run_id,
    parentRunId: child.parent_run_id,
    depth: child.depth,
    scopePath: child.scope_path,
    
    maxDepth: child.max_depth,
    depthBudget: child.depth_budget,
    iteration: persistedRuntime.outer_iteration,
    evidencePath,
    ...worker,
  };
}

function expectError(
  action: () => unknown,
  expectedCode: string,
  assertionMessage: string,
): { code: string | undefined; message: string } {
  try {
    action();
  } catch (error: unknown) {
    return {
      code: (error as { code?: string }).code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  assert.fail(`${assertionMessage}: expected ${expectedCode}`);
}

interface CycleObserverScenario {
  name: string;
  createDirectories: (runDirectory: string) => void;
}

interface CycleObserverOutcome {
  name: string;
  behavior: "error" | "return";
  value: string;
}

function runCycleObserverScenario(
  scenario: CycleObserverScenario,
  index: number,
): CycleObserverOutcome {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-5-phase3-observer-project-"));
  const runId = `run-a2-5-observer-${index}`;
  try {
    createRootRun({
      project_root: projectRoot,
      run_id: runId,
      
      
      
      charter_sha256: HASH_A,
      input_snapshot_sha256: HASH_B,
      execution_plan_sha256: HASH_C,
      code_baseline_sha256: HASH_A,
      policy_revision: POLICY_REVISION,
    });
    const runDirectory = runOwnedPath(projectRoot, runId);
    const before = directorySnapshot(runDirectory);
    scenario.createDirectories(runDirectory);
    try {
      const observed = observeCreatedCycleDirectory(projectRoot, runId, 1, before);
      return {
        name: scenario.name,
        behavior: "return",
        value: path.relative(runDirectory, observed),
      };
    } catch (error: unknown) {
      return {
        name: scenario.name,
        behavior: "error",
        value: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("cycle observer reports all documented-shape boundary cases", () => {
  const scenarios: CycleObserverScenario[] = [
    {
      name: "NO_NEW_DIRECTORY",
      createDirectories: () => {},
    },
    {
      name: "TWO_SAME_DEPTH",
      createDirectories: (runDirectory) => {
        fs.mkdirSync(path.join(runDirectory, "cycles", "1"), { recursive: true });
        fs.mkdirSync(path.join(runDirectory, "same-depth", "1"), { recursive: true });
      },
    },
    {
      name: "DEEPER_THAN_CYCLE",
      createDirectories: (runDirectory) => {
        fs.mkdirSync(path.join(runDirectory, "cycles", "1", "runtime-only"), { recursive: true });
      },
    },
    {
      name: "SHALLOWER_THAN_CYCLE",
      createDirectories: (runDirectory) => {
        fs.mkdirSync(path.join(runDirectory, "cycles"), { recursive: true });
      },
    },
    {
      name: "UNRELATED_DEEPER_DIRECTORY",
      createDirectories: (runDirectory) => {
        fs.mkdirSync(path.join(runDirectory, "cycles", "1"), { recursive: true });
        fs.mkdirSync(path.join(runDirectory, "unrelated", "a", "b"), { recursive: true });
      },
    },
  ];
  const outcomes = scenarios.map(runCycleObserverScenario);
  console.log(`CYCLE_OBSERVER_CASES ${JSON.stringify(outcomes)}`);
  assert.deepEqual(
    outcomes.map(({ name, behavior, value }) => ({
      name,
      behavior,
      value: behavior === "error" ? value.split("\n", 1)[0] : value,
    })),
    [
      {
        name: "NO_NEW_DIRECTORY",
        behavior: "error",
        value: "beginOuterCycle must create the documented cycle directory",
      },
      { name: "TWO_SAME_DEPTH", behavior: "return", value: "cycles/1" },
      {
        name: "DEEPER_THAN_CYCLE",
        behavior: "error",
        value:
          "beginOuterCycle must not create nested directories under the documented cycle directory",
      },
      {
        name: "SHALLOWER_THAN_CYCLE",
        behavior: "error",
        value: "beginOuterCycle must create the documented cycle directory",
      },
      { name: "UNRELATED_DEEPER_DIRECTORY", behavior: "return", value: "cycles/1" },
    ],
  );
});

test("production bridge-input conversion and bridge-expand open the root child contract", () => {
  const prepared = createRootRuntimeBridgeFixture();
  try {
    runBridgeHandoff(prepared, "root");
  } finally {
    fs.rmSync(prepared.projectRoot, { recursive: true, force: true });
    fs.rmSync(prepared.executionRoot, { recursive: true, force: true });
  }
});

test("production bridge-input conversion and bridge-expand open a recursive child contract", () => {
  const root = createRootRuntimeBridgeFixture();
  try {
    const rootResult = runBridgeHandoff(root, "root-for-recursive");
    const childFixture = createRecursiveRuntimeBridgeFixture(root, rootResult.plan.children[0]!);
    const recursiveResult = runBridgeHandoff(childFixture, "recursive");
    assert.equal(
      recursiveResult.children.length,
      1,
      "recursive bridge must materialize one grandchild",
    );
    assert.equal(
      recursiveResult.children[0]!.parent_run_id,
      childFixture.runId,
      "recursive bridge child must point to the recursive run",
    );
  } finally {
    fs.rmSync(root.projectRoot, { recursive: true, force: true });
    fs.rmSync(root.executionRoot, { recursive: true, force: true });
  }
});

test("a bridge plan for another parent is rejected before child materialization", () => {
  const prepared = prepareRun();
  try {
    const mismatchedParentId = "root-a2-5-phase3-other";
    const base = baseline();
    const resource = resourceInventory();
    const bridge: ExperimentBridgeInput = bridgeFixture({
      charter: bridgeCharter(base, resource, mismatchedParentId),
      baseline: base,
      resource_inventory: resource,
      positions: [bridgePosition()],
    });
    const planned = planExperimentBridge(bridgeFixture(bridge));
    assert.equal(planned.parent_run_id, mismatchedParentId);
    const childRunId = planned.children[0]!.run_id;
    const childPath = runJsonPath(prepared.projectRoot, childRunId);
    const childDirectory = path.dirname(childPath);
    const runsDirectory = path.dirname(childDirectory);
    const runsBefore = fs.readdirSync(runsDirectory).sort();
    const error = expectError(
      () =>
        runAutoResearchBridge({
          execution_root: prepared.executionRoot,
          project_root: prepared.projectRoot,
          outer_run_id: ROOT_RUN_ID,
          parent_run_id: null,
          depth: 0,
          scope_path: "/",
          
          
          
          bridge,
          evidence_paths: [path.join(prepared.projectRoot, "loop-evidence.txt")],
        }),
      "IDENTITY_MISMATCH",
      "a bridge plan for another parent must be rejected",
    );
    assert.equal(error.code, "IDENTITY_MISMATCH");
    assert.equal(
      error.message,
      "IDENTITY_MISMATCH: bridge plan parent does not match the outer loop run",
    );
    assert.equal(
      fs.existsSync(childDirectory),
      false,
      "rejected plans must not create a child directory",
    );
    assert.equal(fs.existsSync(childPath), false, "rejected plans must not write child run.json");
    assert.deepEqual(
      fs.readdirSync(runsDirectory).sort(),
      runsBefore,
      "rejected plans must not add a run directory",
    );
  } finally {
    cleanup(prepared);
  }
});

test("a child with only the files B wrote starts successfully", () => {
  const prepared = prepareRun();
  try {
    const child = prepared.result.plan.children[0]!;
    const childDirectory = path.dirname(runJsonPath(prepared.projectRoot, child.run_id));
    // Materializing a child writes its contract, the charter it works from, the
    // inputs that charter is frozen against, and its own budget account. No
    // runtime state exists yet.
    assert.deepEqual(fs.readdirSync(childDirectory).sort(), [
      "budget.json",
      "charter.json",
      "input-snapshot.json",
      "run.json",
    ]);
    assert.doesNotThrow(
      () => startChild(prepared),
      "a child with only the B-written files must start successfully",
    );
    assert.equal(fs.existsSync(workflowRuntimePath(prepared.projectRoot, child.run_id)), true);
    assert.equal(fs.existsSync(workflowDashboardPath(prepared.projectRoot, child.run_id)), true);
    assert.equal(fs.existsSync(frozenPolicyPath(prepared.projectRoot, child.run_id)), true);
  } finally {
    cleanup(prepared);
  }
});

function assertStartupArtifactRejectsDuplicate(
  artifactPath: (projectRoot: string, runId: string) => string,
  otherArtifactPaths: Array<(projectRoot: string, runId: string) => string>,
  artifactName: string,
): void {
  const prepared = prepareRun();
  try {
    startChild(prepared);
    const child = prepared.result.plan.children[0]!;
    for (const otherPath of otherArtifactPaths)
      fs.rmSync(otherPath(prepared.projectRoot, child.run_id), { force: true });
    const childDirectory = path.dirname(runJsonPath(prepared.projectRoot, child.run_id));
    const beforeRejectedStart = directoryFileHashes(childDirectory);
    const error = expectError(
      () => startChild(prepared),
      "OUTER_RUN_EXISTS",
      `${artifactName} preflight must reject a duplicate child start`,
    );
    assert.equal(error.code, "OUTER_RUN_EXISTS");
    assert.match(error.message, /outer run files already exist/);
    assert.equal(fs.existsSync(artifactPath(prepared.projectRoot, child.run_id)), true);
    assert.deepEqual(
      directoryFileHashes(childDirectory),
      beforeRejectedStart,
      "a rejected duplicate start must not change any child file",
    );
  } finally {
    cleanup(prepared);
  }
}

test("an existing workflow-runtime.json still rejects a duplicate child start", () => {
  assertStartupArtifactRejectsDuplicate(
    workflowRuntimePath,
    [workflowDashboardPath, frozenPolicyPath],
    "workflow-runtime.json",
  );
});

test("an existing workflow-dashboard.json still rejects a duplicate child start", () => {
  // Keep the matching frozen policy so a preflight mutation cannot recreate it
  // and fail later while trying to reconcile the existing dashboard.
  assertStartupArtifactRejectsDuplicate(
    workflowDashboardPath,
    [workflowRuntimePath],
    "workflow-dashboard.json",
  );
});

test("an existing frozen-policy.json still rejects a duplicate child start", () => {
  assertStartupArtifactRejectsDuplicate(
    frozenPolicyPath,
    [workflowRuntimePath, workflowDashboardPath],
    "frozen-policy.json",
  );
});
