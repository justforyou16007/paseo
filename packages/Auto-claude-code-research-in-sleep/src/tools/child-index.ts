import fs from "node:fs";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile } from "./state-file.js";
import { runOwnedPath } from "./run-contract.js";
import { failA1 } from "./workflow-spec.js";

/**
 * Who a parent dispatched, and how those dispatches are wired to each other.
 *
 * The parent owns this file. Children receive only their own frozen task, so a
 * child never learns a sibling's run id from here — the index exists so the
 * parent can tell "the same task, dispatched again" from "a new generation of
 * this position", and so a later reader can ask what the structure was.
 */
export interface ChildPositionEntry {
  position_id: string;
  /** Canonical hash of the position's task: its id, execution plan and charter. */
  task_sha256: string;
  child_run_id: string;
  /** Absent in indexes written before generations existed; that is generation 1. */
  generation?: number;
  /** Positions whose published outputs this one consumes. Absent means parallel. */
  depends_on?: string[];
  /** The run that held this position in the generation before. */
  predecessor_run_id?: string;
  /** Whether that predecessor was doing the same task. */
  inherits_wiki?: boolean;
}

export interface ChildPositionIndex {
  schema_version: 1;
  positions: ChildPositionEntry[];
}

export function childIndexPath(projectRoot: string, parentRunId: string): string {
  return runOwnedPath(projectRoot, parentRunId, "children.json");
}

export function readChildIndex(filePath: string): ChildPositionIndex {
  return fs.existsSync(filePath) ? readStateFile(filePath) : { schema_version: 1, positions: [] };
}

export function entryGeneration(entry: { generation?: number }): number {
  return entry.generation ?? 1;
}

export interface DispatchStructure {
  generation: number;
  /** The children dispatched in that generation, in position order. */
  child_run_ids: string[];
  structure_sha256: string;
}

/**
 * Describe the structure the parent most recently dispatched.
 *
 * The hash covers what the parent decided — which positions exist, what task
 * each one was given, and which positions wait for which — and nothing else.
 * The generation number is deliberately left out: two generations that arrived
 * at the same structure have to hash the same, otherwise the number alone would
 * make every round look like a change and "did the structure change?" could not
 * be answered by comparing hashes.
 *
 * Child run ids are listed but not hashed, for the same reason: re-dispatching
 * an identical structure produces different run ids, and that is not a
 * structural difference.
 */
export function readDispatchStructure(projectRoot: string, parentRunId: string): DispatchStructure {
  const index = readChildIndex(childIndexPath(projectRoot, parentRunId));
  if (index.positions.length === 0)
    failA1("INVALID_EXPANSION", "this run has not dispatched any children");
  const generation = Math.max(...index.positions.map((entry) => entryGeneration(entry)));
  const current = index.positions
    .filter((entry) => entryGeneration(entry) === generation)
    .sort((left, right) => (left.position_id < right.position_id ? -1 : 1));
  return {
    generation,
    child_run_ids: current.map((entry) => entry.child_run_id),
    structure_sha256: canonicalJsonSha256(
      current.map((entry) => ({
        position_id: entry.position_id,
        task_sha256: entry.task_sha256,
        depends_on: entry.depends_on ?? [],
      })),
      undefined,
      { schemaVersion: "dispatch-structure-v1" },
    ),
  };
}
