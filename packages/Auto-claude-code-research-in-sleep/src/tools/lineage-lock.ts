import fs from "node:fs";
import path from "node:path";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";
import { assertIdentifier, failA1, isRecord } from "./workflow-spec.js";

/**
 * Who in a lineage is allowed to change things right now.
 *
 * A parent that restructures its children and a child that is mid-iteration
 * are editing the same thing from two ends: the parent decides which tasks
 * exist, the child is producing a result for one of them. Neither may proceed
 * while the other holds the lineage. So a structure hold excludes every hold
 * below it, and is refused while any hold exists below it.
 *
 * Nothing else conflicts. A parent iterates while its children iterate — that
 * is the shape of a dispatch — and a child restructuring its own children
 * does so inside its parent's cycle, so a hold above never blocks work below
 * unless it is a structure hold. Unrelated branches never meet.
 *
 * The scope is read from the run contract, never from the caller, so a run
 * cannot claim a broader lineage than the one it was created in.
 *
 * Holds span many processes: an iteration is a long series of separate tool
 * invocations, so process liveness says nothing about whether a hold is
 * still meant. The only proof that a holder is done is the same one the rest
 * of the system uses — its published result package.
 *
 * Failure messages carry no run id, scope or depth. A child that is told
 * "you are locked" learns nothing about who its ancestors are.
 */
export type LineageHoldKind = "structure" | "iteration";

interface LineageHold {
  run_id: string;
  scope_path: string;
  kind: LineageHoldKind;
  acquired_at: string;
}

interface LineageLockFile {
  schema_version: 1;
  holds: LineageHold[];
}

export function lineageLockPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".aris", "lineage-locks.json");
}

function readHolds(filePath: string): LineageHold[] {
  if (!fs.existsSync(filePath)) return [];
  const value = readStateFile(filePath);
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.holds))
    failA1("CORRUPT_LINEAGE_LOCKS", "lineage lock file is not a hold list", filePath);
  return value.holds.map((hold, index) => {
    if (
      !isRecord(hold) ||
      typeof hold.run_id !== "string" ||
      typeof hold.scope_path !== "string" ||
      (hold.kind !== "structure" && hold.kind !== "iteration") ||
      typeof hold.acquired_at !== "string"
    )
      failA1("CORRUPT_LINEAGE_LOCKS", "lineage hold is malformed", `${filePath}[${index}]`);
    return hold as unknown as LineageHold;
  });
}

function writeHolds(filePath: string, holds: LineageHold[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const value: LineageLockFile = { schema_version: 1, holds };
  writeStateJsonAtomic(filePath, value);
}

function holderFinished(projectRoot: string, hold: LineageHold): boolean {
  return fs.existsSync(runOwnedPath(projectRoot, hold.run_id, "result-package.json"));
}

/** Whether `scope` is `above` itself or somewhere below it. */
function within(above: string, scope: string): boolean {
  return above === "/" || scope === above || scope.startsWith(`${above}/`);
}

function conflicts(held: LineageHold, requested: LineageHold): boolean {
  if (held.run_id === requested.run_id) return false;
  if (held.kind === "structure" && within(held.scope_path, requested.scope_path)) return true;
  return requested.kind === "structure" && within(requested.scope_path, held.scope_path);
}

/** Idempotent for the same run and kind; fails with LINEAGE_LOCKED otherwise. */
export function acquireLineageHold(
  projectRoot: string,
  runId: string,
  kind: LineageHoldKind,
): void {
  const run = requireRunContract(projectRoot, assertIdentifier(runId, "run_id"));
  const requested: LineageHold = {
    run_id: run.run_id,
    scope_path: run.scope_path,
    kind,
    acquired_at: new Date().toISOString(),
  };
  const filePath = lineageLockPath(projectRoot);
  withStateFileLock(filePath, () => {
    const live = readHolds(filePath).filter((hold) => !holderFinished(projectRoot, hold));
    if (live.some((hold) => hold.run_id === requested.run_id && hold.kind === kind)) return;
    if (live.some((hold) => conflicts(hold, requested)))
      failA1(
        "LINEAGE_LOCKED",
        kind === "structure"
          ? "a run in this lineage is still iterating; its structure cannot change under it"
          : "this lineage is being restructured; no iteration can begin until that finishes",
      );
    writeHolds(filePath, [...live, requested]);
  });
}

/** Releasing a hold that is not held is a no-op, so a retried close is safe. */
export function releaseLineageHold(
  projectRoot: string,
  runId: string,
  kind: LineageHoldKind,
): void {
  const id = assertIdentifier(runId, "run_id");
  const filePath = lineageLockPath(projectRoot);
  withStateFileLock(filePath, () => {
    const holds = readHolds(filePath);
    const remaining = holds.filter((hold) => !(hold.run_id === id && hold.kind === kind));
    if (remaining.length !== holds.length) writeHolds(filePath, remaining);
  });
}
