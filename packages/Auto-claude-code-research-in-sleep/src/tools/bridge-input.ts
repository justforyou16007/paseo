import fs from "node:fs";
import path from "node:path";
import type { ExperimentBridgeInput, BridgePositionInput } from "./experiment-bridge.js";
import {
  readBaselineScope,
  type BaselineScope,
  type OptimizablePosition,
} from "./baseline-scope.js";
import {
  hasDecomposition,
  latestDecompositionGeneration,
  readDecompositionGraph,
  type DecompositionGraph,
} from "./decomposition-graph.js";
import { readResourceInventory, type ResourceInventory } from "./resource-inventory.js";
import { readRootCharter } from "./root-charter.js";
import { requireRunContract, runOwnedPath, type RunRecord } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { readWorkflowRuntimeState, workflowCycleWorkerDirectory } from "./workflow-state.js";
import {
  assertIdentifier,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

export interface BridgeInputRequest {
  execution_root: string;
  project_root: string;
  outer_run_id: string;
  idea_discovery_manifest_path: string;
}

export interface BridgeInputPaths {
  manifest_path: string;
  worker_directory: string;
  idea_discovery_path: string;
  bridge_input_path: string;
  receipt_path: string;
}

export interface PreparedBridgeInput {
  idea_discovery_path: string;
  bridge_input_path: string;
  receipt_path: string;
  bridge: ExperimentBridgeInput;
}

export interface BridgeInputSources {
  run: Pick<RunRecord, "run_id" | "depth" | "scope_path">;
  charter: unknown;
  baseline: BaselineScope;
  resource_inventory: ResourceInventory;
  idea_discovery: unknown;
  /**
   * The decomposition this run already recorded for the generation it is about
   * to dispatch, if it is an orchestration run. The tasks come from here and
   * not from the upstream artifact: the graph was decided and frozen before
   * this command ran, so an artifact that restated a task differently would be
   * a second writer of the same fact.
   */
  decomposition?: DecompositionGraph;
}

const IDEA_DISCOVERY_CANDIDATE_IDS_FIELD = "candidate_ids";

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function readCurrentCharter(projectRoot: string, run: RunRecord): unknown {
  if (run.parent_run_id === null && run.depth === 0)
    return readRootCharter(projectRoot, run.run_id);
  if (run.parent_run_id === null || run.depth === 0)
    failA1("RUN_DEPTH_MISMATCH", "a recursive charter must have a parent and positive depth");

  const filePath = runOwnedPath(projectRoot, run.run_id, "charter.json");
  if (!fs.existsSync(filePath))
    failA1("CHARTER_NOT_FOUND", `recursive charter is missing at ${filePath}`, filePath);
  const charter = readStateFile<unknown>(filePath);
  if (!isRecord(charter)) failA1("CORRUPT_CHARTER", "charter must be an object", filePath);
  if (charter.run_id !== run.run_id)
    failA1("IDENTITY_MISMATCH", "recursive charter run_id does not match run.json", filePath);
  return charter;
}

function candidateIds(ideaDiscovery: unknown): string[] {
  if (!isRecord(ideaDiscovery) || !Array.isArray(ideaDiscovery[IDEA_DISCOVERY_CANDIDATE_IDS_FIELD]))
    failA1(
      "INVALID_VALUE",
      `idea-discovery artifact must contain ${IDEA_DISCOVERY_CANDIDATE_IDS_FIELD}`,
      `idea_discovery.${IDEA_DISCOVERY_CANDIDATE_IDS_FIELD}`,
    );
  const candidateIdList = ideaDiscovery[IDEA_DISCOVERY_CANDIDATE_IDS_FIELD];
  const ids = candidateIdList.map((candidate, index) =>
    assertIdentifier(candidate, `idea_discovery.${IDEA_DISCOVERY_CANDIDATE_IDS_FIELD}[${index}]`),
  );
  if (new Set(ids).size !== ids.length)
    failA1(
      "DUPLICATE_ID",
      `idea-discovery ${IDEA_DISCOVERY_CANDIDATE_IDS_FIELD} must be unique`,
      `idea_discovery.${IDEA_DISCOVERY_CANDIDATE_IDS_FIELD}`,
    );
  return ids;
}

function charterScope(charter: unknown): Map<string, OptimizablePosition> {
  if (!isRecord(charter) || !Array.isArray(charter.optimizable_scope))
    failA1(
      "CORRUPT_CHARTER",
      "charter optimizable_scope must be an array",
      "charter.optimizable_scope",
    );
  const scope = new Map<string, OptimizablePosition>();
  for (const [index, entry] of charter.optimizable_scope.entries()) {
    if (!isRecord(entry))
      failA1(
        "CORRUPT_CHARTER",
        "charter scope entry must be an object",
        `charter.optimizable_scope[${index}]`,
      );
    const positionId = assertIdentifier(
      entry.position_id,
      `charter.optimizable_scope[${index}].position_id`,
    );
    if (entry.mode !== "independent" && entry.mode !== "bundled")
      failA1(
        "CORRUPT_CHARTER",
        "charter scope mode is invalid",
        `charter.optimizable_scope[${index}].mode`,
      );
    if (!Array.isArray(entry.bundle_members))
      failA1(
        "CORRUPT_CHARTER",
        "charter bundle_members must be an array",
        `charter.optimizable_scope[${index}].bundle_members`,
      );
    if (scope.has(positionId))
      failA1(
        "DUPLICATE_ID",
        `charter position '${positionId}' is repeated`,
        "charter.optimizable_scope",
      );
    scope.set(positionId, {
      position_id: positionId,
      mode: entry.mode,
      bundle_members: [...entry.bundle_members] as string[],
    });
  }
  return scope;
}

function positionIdForCandidate(
  candidateId: string,
  scope: Map<string, OptimizablePosition>,
): string {
  if (scope.has(candidateId)) return candidateId;
  const prefix = "candidate:";
  if (candidateId.startsWith(prefix)) {
    const positionId = candidateId.slice(prefix.length);
    if (scope.has(positionId)) return positionId;
  }
  failA1(
    "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED",
    `candidate '${candidateId}' does not identify a charter position`,
    `idea_discovery.${IDEA_DISCOVERY_CANDIDATE_IDS_FIELD}`,
  );
}

function assertDirectWorkerDirectory(workerRoot: string, workerDirectory: string): void {
  const relative = path.relative(path.resolve(workerRoot), path.resolve(workerDirectory));
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  )
    failA1(
      "PATH_ESCAPE",
      "idea-discovery manifest must be directly below the cycle workers directory",
      "idea_discovery_manifest_path",
    );

  let realRoot: string;
  let realWorker: string;
  try {
    realRoot = fs.realpathSync.native(workerRoot);
    realWorker = fs.realpathSync.native(workerDirectory);
  } catch {
    failA1(
      "PATH_ESCAPE",
      "idea-discovery worker directory must exist below the cycle workers directory",
      "idea_discovery_manifest_path",
    );
  }
  const realRelative = path.relative(realRoot!, realWorker!);
  if (
    realRelative === "" ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative) ||
    realRelative.includes(path.sep)
  )
    failA1(
      "PATH_ESCAPE",
      "idea-discovery manifest must be directly below the cycle workers directory",
      "idea_discovery_manifest_path",
    );
}

function validateUpstreamManifest(
  manifestPath: string,
  workerDirectory: string,
  runId: string,
  outerIteration: number,
): Record<string, unknown> {
  if (path.basename(manifestPath) !== "input-manifest.json")
    failA1(
      "INVALID_PATH",
      "idea-discovery manifest path must name input-manifest.json",
      "idea_discovery_manifest_path",
    );
  const manifest = readStateFile<unknown>(manifestPath);
  if (!isRecord(manifest))
    failA1("INVALID_VALUE", "idea-discovery manifest must be a JSON object", manifestPath);
  if (manifest.worker !== "idea-discovery")
    failA1(
      "WORKER_NOT_ALLOWED",
      "the upstream manifest must belong to idea-discovery",
      manifestPath,
    );
  if (manifest.run_id !== runId)
    failA1(
      "IDENTITY_MISMATCH",
      "idea-discovery manifest run_id does not match the active run",
      manifestPath,
    );
  if (manifest.iteration !== outerIteration)
    failA1(
      "IDENTITY_MISMATCH",
      "idea-discovery manifest iteration does not match the active cycle",
      manifestPath,
    );
  const outputDirectory = requireString(manifest.output_dir, `${manifestPath}.output_dir`);
  if (
    !path.isAbsolute(outputDirectory) ||
    path.resolve(outputDirectory) !== path.resolve(workerDirectory, "outputs")
  )
    failA1(
      "IDENTITY_MISMATCH",
      "idea-discovery manifest output_dir must be its worker outputs directory",
      `${manifestPath}.output_dir`,
    );
  return manifest;
}

export function buildBridgeInput(sources: BridgeInputSources): ExperimentBridgeInput {
  const scope = charterScope(sources.charter);
  if (!isRecord(sources.idea_discovery) || !Array.isArray(sources.idea_discovery.children))
    failA1(
      "INVALID_VALUE",
      "idea-discovery must explicitly list dispatched children (an empty list is allowed)",
    );
  const positions: BridgePositionInput[] = sources.idea_discovery.children.map((child, index) => {
    if (!isRecord(child)) failA1("INVALID_VALUE", `children[${index}] must be an object`);
    const positionId = assertIdentifier(child.position_id, "child.position_id");
    const entry = scope.get(positionId);
    if (entry === undefined || (child.mode !== undefined && child.mode !== entry.mode))
      failA1(
        "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED",
        "child position or mode is outside the charter scope",
      );
    return {
      ...child,
      position_id: positionId,
      mode: entry.mode,
    } as unknown as BridgePositionInput;
  });
  const seen = new Set<string>();
  for (const position of positions) {
    if (seen.has(position.position_id))
      failA1(
        "DUPLICATE_ID",
        `candidate positions map to '${position.position_id}' more than once`,
        "positions",
      );
    seen.add(position.position_id);
  }
  // How many generations the parent still intends to run, itself included. The
  // bridge splits the parent budget across them, so a first generation that
  // claimed all of it would leave the later ones unable to dispatch anything.
  const remaining = sources.idea_discovery.remaining_generations;
  const decomposition = sources.decomposition;
  return {
    run: sources.run,
    charter: sources.charter,
    baseline: sources.baseline,
    resource_inventory: sources.resource_inventory,
    positions:
      decomposition === undefined
        ? positions
        : positions.map((position) => decomposedPosition(decomposition, position)),
    strategy: sources.idea_discovery.strategy as ExperimentBridgeInput["strategy"],
    strategy_reason: requireString(
      isRecord(sources.idea_discovery) ? sources.idea_discovery.strategy_reason : undefined,
      "idea_discovery.strategy_reason",
    ),
    ...(decomposition === undefined
      ? {}
      : { orchestration: true, generation: decomposition.generation }),
    ...(remaining === undefined
      ? {}
      : {
          remaining_generations: requireInteger(
            remaining,
            "idea_discovery.remaining_generations",
            1,
          ),
        }),
  };
}

/**
 * Put the frozen task back on a dispatched position.
 *
 * The upstream artifact decides which positions this dispatch covers and how
 * each one is run - its resources, its budget, its validator. What the child
 * is being asked is not its decision: that is the decomposition, and a
 * dispatch may only be a subset of it. Filling the task in here means the
 * bridge's own check against the recorded graph can only fail on a document
 * that was edited after this command wrote it.
 */
function decomposedPosition(
  decomposition: DecompositionGraph,
  position: BridgePositionInput,
): BridgePositionInput {
  const declared = decomposition.positions.find(
    (entry) => entry.position_id === position.position_id,
  );
  if (declared === undefined)
    failA1(
      "DECOMPOSITION_MISMATCH",
      `position '${position.position_id}' is not in generation ${decomposition.generation} of this run's decomposition`,
      "positions",
    );
  if (position.charter === undefined)
    failA1(
      "INVALID_VALUE",
      `position '${position.position_id}' needs a charter to carry its task and validator`,
      `positions.${position.position_id}.charter`,
    );
  return {
    ...position,
    charter: {
      ...position.charter,
      problem: declared.problem,
      expected_output: declared.expected_output,
      constraints: declared.constraints,
    },
    depends_on: [...declared.depends_on],
  };
}

export function bridgeInputPaths(
  projectRoot: string,
  runId: string,
  outerIteration: number,
  ideaDiscoveryManifestPath: string,
): BridgeInputPaths {
  const suppliedManifestPath = requireString(
    ideaDiscoveryManifestPath,
    "idea_discovery_manifest_path",
  );
  if (!path.isAbsolute(suppliedManifestPath))
    failA1(
      "INVALID_PATH",
      "idea-discovery manifest path must be absolute",
      "idea_discovery_manifest_path",
    );
  const manifestPath = path.resolve(suppliedManifestPath);
  const workerDirectory = path.dirname(manifestPath);
  const workerRoot = workflowCycleWorkerDirectory(projectRoot, runId, outerIteration);
  assertDirectWorkerDirectory(workerRoot, workerDirectory);
  if (!fs.existsSync(manifestPath))
    failA1(
      "IDEA_DISCOVERY_MANIFEST_NOT_FOUND",
      `idea-discovery manifest is missing at ${manifestPath}`,
      manifestPath,
    );
  validateUpstreamManifest(manifestPath, workerDirectory, runId, outerIteration);
  const outputDirectory = path.join(workerDirectory, "outputs");
  const receiptPath = path.join(workerDirectory, "receipt.json");
  if (!fs.existsSync(receiptPath))
    failA1(
      "IDEA_DISCOVERY_RECEIPT_NOT_FOUND",
      `idea-discovery receipt is missing at ${receiptPath}`,
      receiptPath,
    );
  const receipt = readStateFile<unknown>(receiptPath);
  if (
    !isRecord(receipt) ||
    receipt.worker !== "idea-discovery" ||
    receipt.run_id !== runId ||
    receipt.iteration !== outerIteration
  )
    failA1(
      "IDENTITY_MISMATCH",
      "idea-discovery receipt identity does not match the active run",
      receiptPath,
    );
  return {
    manifest_path: manifestPath,
    worker_directory: workerDirectory,
    idea_discovery_path: path.join(outputDirectory, "idea-discovery.json"),
    bridge_input_path: path.join(outputDirectory, "bridge-input.json"),
    receipt_path: receiptPath,
  };
}

function writeImmutableBridgeInput(filePath: string, bridge: ExperimentBridgeInput): void {
  const contents = `${JSON.stringify(bridge, null, 2)}\n`;
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      if (fs.readFileSync(filePath, "utf8") === contents) return;
      failA1("IMMUTABLE_CONFLICT", "bridge input is immutable", filePath);
    }
    writeStateJsonAtomic(filePath, bridge);
  });
}

export function prepareBridgeInput(input: BridgeInputRequest): PreparedBridgeInput {
  const run = requireRunContract(input.project_root, input.outer_run_id);
  const runtime = readWorkflowRuntimeState(input.project_root, input.outer_run_id);
  if (
    !samePath(runtime.project_root, input.project_root) ||
    !samePath(runtime.execution_root, input.execution_root)
  )
    failA1("IDENTITY_MISMATCH", "workflow-runtime.json roots differ from command locators");
  const paths = bridgeInputPaths(
    input.project_root,
    input.outer_run_id,
    runtime.outer_iteration,
    input.idea_discovery_manifest_path,
  );
  if (!fs.existsSync(paths.idea_discovery_path))
    failA1(
      "IDEA_DISCOVERY_NOT_FOUND",
      `idea-discovery artifact is missing at ${paths.idea_discovery_path}`,
      paths.idea_discovery_path,
    );
  if (!fs.existsSync(paths.receipt_path))
    failA1(
      "IDEA_DISCOVERY_RECEIPT_NOT_FOUND",
      `idea-discovery receipt is missing at ${paths.receipt_path}`,
      paths.receipt_path,
    );
  const orchestrating = hasDecomposition(input.project_root, run.run_id);
  const bridge = buildBridgeInput({
    run,
    charter: readCurrentCharter(input.project_root, run),
    baseline: readBaselineScope(input.project_root, run.run_id),
    resource_inventory: readResourceInventory(input.project_root, run.run_id),
    idea_discovery: readStateFile<unknown>(paths.idea_discovery_path),
    ...(orchestrating
      ? {
          decomposition: readDecompositionGraph(
            input.project_root,
            run.run_id,
            latestDecompositionGeneration(input.project_root, run.run_id),
          ),
        }
      : {}),
  });
  // The stored document names no storage root. bridge-expand receives the
  // project through its own --project locator and rejects a document that
  // carries one, so writing it here would make the file unusable as the
  // next step's input.
  writeImmutableBridgeInput(paths.bridge_input_path, bridge);
  return { ...paths, bridge };
}
