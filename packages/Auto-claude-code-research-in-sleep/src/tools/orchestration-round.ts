import fs from "node:fs";
import { requireChildAcceptance, type ChildAcceptanceMetric } from "./child-acceptance.js";
import { childIndexPath, entryGeneration, readChildIndex } from "./child-index.js";
import {
  latestDecompositionGeneration,
  readDecompositionGraph,
  type DecompositionPosition,
} from "./decomposition-graph.js";
import { readResultPackage, type ResultChildSummary, type ResultStatus } from "./result-package.js";
import { runOwnedPath } from "./run-contract.js";
import { validateRunCharter } from "./run-charter.js";
import { readStateFile } from "./state-file.js";
import { assertIdentifier, failA1 } from "./workflow-spec.js";

/**
 * Collecting one generation of a decomposition back into its parent.
 *
 * An orchestration round is not finished when the parent has dispatched its
 * children; it is finished when every position of the generation has a
 * terminal child. Until then the parent has nothing to assemble, and any
 * number it publishes would be a number about a partial graph. This module is
 * the read that answers "is the generation over, and what came back".
 *
 * Nothing here is written to disk. Every field is derived from three files
 * that already exist and already have one writer each: the generation's
 * decomposition (which positions the parent decided on), `children.json`
 * (which run carries each position), and each child's own published
 * `result-package.json` (what it produced). A fourth file would be a fourth
 * thing to keep in step, and would go stale the moment a child publishes.
 *
 * Scoring works the same way. A child's score is its published metric read
 * through the acceptance its parent froze before dispatch, so "score each
 * child once" is a property of the inputs, not of a write: the acceptance
 * cannot change under a running child (its id is the hash of its content), and
 * a published result package cannot change either. Recomputing gives the same
 * verdict, so there is nothing to record.
 *
 * The parent's own measurement of the assembled whole is a different number
 * and belongs elsewhere: it goes through the ordinary metric gate as
 * `metric.current`, and `dashboard-merge.ts` refuses to accept it until this
 * collection reports `complete`.
 */
export type CollectedChildState = "not_dispatched" | "running" | "succeeded" | "failed";

/** Why a terminal child did not meet the parent's acceptance. */
export type ChildRejection = "child_failed" | "metric_missing" | "below_threshold";

export interface CollectedChild {
  position_id: string;
  /** The upstream positions this one consumes, from the decomposition. */
  depends_on: string[];
  /** Absent until the position has been dispatched in this generation. */
  child_run_id: string | null;
  state: CollectedChildState;
  /** The published status, which says more than `failed` does. */
  result_status: ResultStatus | null;
  /** Upstream positions that have not published a usable result yet. */
  blocked_by: string[];
  /** The parent-owned standard this child's charter named. */
  acceptance_id: string | null;
  metric: ChildAcceptanceMetric | null;
  /** The child's own reading of that metric, when it published one. */
  score: number | null;
  accepted: boolean | null;
  rejected: ChildRejection | null;
  summary_sha256: string | null;
}

export interface OrchestrationRound {
  parent_run_id: string;
  generation: number;
  decomposition_sha256: string;
  children: CollectedChild[];
  /** Every position of the generation has a terminal child. */
  complete: boolean;
  /** Undispatched positions whose upstreams have all published. */
  dispatchable: string[];
  /** Undispatched positions still waiting on an upstream. */
  waiting: string[];
  /** Dispatched children that have not published yet. */
  running: string[];
  /** Terminal children that met the parent's acceptance. */
  accepted: string[];
}

/** The predicate `experiment-bridge.ts` enforces before it materializes a downstream child. */
function publishedUsableOutput(projectRoot: string, childRunId: string): boolean {
  if (!fs.existsSync(runOwnedPath(projectRoot, childRunId, "result-package.json"))) return false;
  const published = readResultPackage(projectRoot, childRunId);
  return published.status === "succeeded" && Object.keys(published.output_hashes).length > 0;
}

/**
 * The acceptance a dispatched child is judged by.
 *
 * The binding lives in the child's frozen charter, not in the parent's index,
 * so a parent that wrote several acceptances for one position over several
 * generations still judges each child by the one it was actually dispatched
 * against.
 */
function acceptanceOf(
  projectRoot: string,
  parentRunId: string,
  positionId: string,
  childRunId: string,
) {
  const filePath = runOwnedPath(projectRoot, childRunId, "charter.json");
  if (!fs.existsSync(filePath))
    failA1("CHARTER_NOT_FOUND", `dispatched child has no charter at ${filePath}`, filePath);
  const charter = validateRunCharter(readStateFile(filePath));
  return requireChildAcceptance(
    projectRoot,
    parentRunId,
    charter.measurement.tester_ref,
    `children.${positionId}.charter.measurement.tester_ref`,
  );
}

function judge(
  metric: ChildAcceptanceMetric,
  status: ResultStatus,
  localMetrics: Record<string, number> | undefined,
): { score: number | null; accepted: boolean; rejected: ChildRejection | null } {
  const score = localMetrics?.[metric.name];
  if (status !== "succeeded")
    return { score: score ?? null, accepted: false, rejected: "child_failed" };
  if (score === undefined) return { score: null, accepted: false, rejected: "metric_missing" };
  const meets =
    metric.direction === "higher_better" ? score >= metric.threshold : score <= metric.threshold;
  return { score, accepted: meets, rejected: meets ? null : "below_threshold" };
}

function collectPosition(
  projectRoot: string,
  parentRunId: string,
  generation: number,
  position: DecompositionPosition,
  runFor: Map<string, string>,
): CollectedChild {
  const base = {
    position_id: position.position_id,
    depends_on: [...position.depends_on],
  };
  const childRunId = runFor.get(position.position_id);
  if (childRunId === undefined)
    return {
      ...base,
      child_run_id: null,
      state: "not_dispatched",
      result_status: null,
      // A position can only be dispatched once every upstream has handed it
      // something, so an undispatched position reports what it is waiting for.
      blocked_by: position.depends_on.filter((upstream) => {
        const upstreamRun = runFor.get(upstream);
        return upstreamRun === undefined || !publishedUsableOutput(projectRoot, upstreamRun);
      }),
      acceptance_id: null,
      metric: null,
      score: null,
      accepted: null,
      rejected: null,
      summary_sha256: null,
    };

  const acceptance = acceptanceOf(projectRoot, parentRunId, position.position_id, childRunId);
  if (acceptance.position_id !== position.position_id)
    failA1(
      "IDENTITY_MISMATCH",
      `child of position '${position.position_id}' was dispatched against another position's acceptance`,
      childIndexPath(projectRoot, parentRunId),
    );
  const dispatched = {
    ...base,
    child_run_id: childRunId,
    blocked_by: [],
    acceptance_id: acceptance.acceptance_id,
    metric: acceptance.metric,
  };
  if (!fs.existsSync(runOwnedPath(projectRoot, childRunId, "result-package.json")))
    return {
      ...dispatched,
      state: "running",
      result_status: null,
      score: null,
      accepted: null,
      rejected: null,
      summary_sha256: null,
    };

  const published = readResultPackage(projectRoot, childRunId);
  return {
    ...dispatched,
    state: published.status === "succeeded" ? "succeeded" : "failed",
    result_status: published.status,
    ...judge(acceptance.metric, published.status, published.local_metrics),
    summary_sha256: published.summary_sha256,
  };
}

/**
 * Read back one generation of a decomposition.
 *
 * The decomposition decides which positions the round contains, so a child in
 * `children.json` that the generation never decided on is a contradiction
 * between two files the same plan wrote, and is refused rather than ignored.
 */
export function collectOrchestrationRound(input: {
  project_root: string;
  parent_run_id: string;
  generation?: number;
}): OrchestrationRound {
  const projectRoot = input.project_root;
  const parentRunId = assertIdentifier(input.parent_run_id, "parent_run_id");
  const generation = input.generation ?? latestDecompositionGeneration(projectRoot, parentRunId);
  if (generation < 1)
    failA1("DECOMPOSITION_NOT_FOUND", "this run has not recorded a decomposition", parentRunId);
  const graph = readDecompositionGraph(projectRoot, parentRunId, generation);

  const index = readChildIndex(childIndexPath(projectRoot, parentRunId));
  const runFor = new Map<string, string>();
  for (const entry of index.positions) {
    if (entryGeneration(entry) !== generation) continue;
    if (!graph.positions.some((position) => position.position_id === entry.position_id))
      failA1(
        "IDENTITY_MISMATCH",
        `position '${entry.position_id}' was dispatched but is not in this generation's decomposition`,
        childIndexPath(projectRoot, parentRunId),
      );
    runFor.set(entry.position_id, entry.child_run_id);
  }

  const children = graph.positions.map((position) =>
    collectPosition(projectRoot, parentRunId, generation, position, runFor),
  );
  const isTerminal = (child: CollectedChild) =>
    child.state === "succeeded" || child.state === "failed";
  return {
    parent_run_id: parentRunId,
    generation,
    decomposition_sha256: graph.decomposition_sha256,
    children,
    complete: children.every(isTerminal),
    dispatchable: children
      .filter((child) => child.state === "not_dispatched" && child.blocked_by.length === 0)
      .map((child) => child.position_id),
    waiting: children
      .filter((child) => child.state === "not_dispatched" && child.blocked_by.length > 0)
      .map((child) => child.position_id),
    running: children
      .filter((child) => child.state === "running")
      .map((child) => child.position_id),
    accepted: children.filter((child) => child.accepted === true).map((child) => child.position_id),
  };
}

/**
 * The generation must be over before the parent may speak about the whole.
 *
 * This is the read side of the rule: a parent measures an assembly, and there
 * is no assembly while a child is still running.
 */
export function requireCompleteRound(projectRoot: string, parentRunId: string): OrchestrationRound {
  const round = collectOrchestrationRound({
    project_root: projectRoot,
    parent_run_id: parentRunId,
  });
  if (!round.complete)
    failA1(
      "ROUND_INCOMPLETE",
      `generation ${round.generation} still has children to collect: ${[
        ...round.waiting,
        ...round.dispatchable,
        ...round.running,
      ].join(", ")}`,
      parentRunId,
    );
  return round;
}

/**
 * What the parent's own result package says about the children it dispatched.
 *
 * Only dispatched positions appear: the summaries are keyed by child run id,
 * and a position that was never dispatched has no run to name.
 */
export function roundChildSummaries(round: OrchestrationRound): ResultChildSummary[] {
  const summaries: ResultChildSummary[] = [];
  for (const child of round.children) {
    if (child.child_run_id === null || child.result_status === null) continue;
    if (child.summary_sha256 === null) continue;
    summaries.push({
      run_id: child.child_run_id,
      status: child.result_status,
      summary_sha256: child.summary_sha256,
    });
  }
  return summaries;
}
