import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { runOwnedPath } from "./run-contract.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireString,
} from "./workflow-spec.js";

/**
 * What a parent promises to judge one dispatched child by.
 *
 * A child never reaches the task's tester. The tester is a scarce resource
 * owned by the root run: every exposure is counted against one task-wide limit,
 * so a child that could call it would spend the whole task's remaining
 * exposures answering a local question. Instead the parent writes an acceptance
 * before it dispatches, and that acceptance is what the child's charter names
 * as its `measurement.tester_ref`.
 *
 * The parent's run directory holds the file, so the parent is the only writer
 * and the child only ever sees the id inside its own frozen charter. The id is
 * the hash of the acceptance's own content, which means a parent that changes
 * what "good" means for a position gets a different id, a different child
 * charter, and therefore a different child — an acceptance can never be edited
 * out from under a child that is already running against it.
 */
export interface ChildAcceptanceMetric {
  name: string;
  direction: "higher_better" | "lower_better";
  threshold: number;
}

export interface ChildAcceptance {
  schema_version: 1;
  acceptance_id: string;
  /** The parent run that wrote it. */
  owner_run_id: string;
  /** The position it judges; a sibling's acceptance never applies here. */
  position_id: string;
  metric: ChildAcceptanceMetric;
}

export interface ChildAcceptanceIndex {
  schema_version: 1;
  owner_run_id: string;
  acceptances: ChildAcceptance[];
}

export function childAcceptancePath(projectRoot: string, ownerRunId: string): string {
  return runOwnedPath(projectRoot, ownerRunId, "child-acceptance.json");
}

export function validateChildAcceptanceMetric(
  value: unknown,
  location: string,
): ChildAcceptanceMetric {
  if (!isRecord(value))
    failA1("INVALID_ACCEPTANCE", "child acceptance metric must be an object", location);
  assertNoUnknownFields(value, ["name", "direction", "threshold"], location);
  const direction = value.direction;
  if (direction !== "higher_better" && direction !== "lower_better")
    failA1(
      "INVALID_ACCEPTANCE",
      "child acceptance direction must be higher_better or lower_better",
      `${location}.direction`,
    );
  return {
    name: requireString(value.name, `${location}.name`),
    direction,
    threshold: requireFiniteNumber(value.threshold, `${location}.threshold`),
  };
}

function acceptanceIdentity(value: Omit<ChildAcceptance, "acceptance_id" | "schema_version">) {
  return `acceptance:sha256:${canonicalJsonSha256(
    { owner_run_id: value.owner_run_id, position_id: value.position_id, metric: value.metric },
    undefined,
    { schemaVersion: "child-acceptance-v1" },
  )}`;
}

export function buildChildAcceptance(input: {
  owner_run_id: string;
  position_id: string;
  metric: unknown;
}): ChildAcceptance {
  const content = {
    owner_run_id: assertIdentifier(input.owner_run_id, "acceptance.owner_run_id"),
    position_id: assertIdentifier(input.position_id, "acceptance.position_id"),
    metric: validateChildAcceptanceMetric(input.metric, "acceptance.metric"),
  };
  return { schema_version: 1, acceptance_id: acceptanceIdentity(content), ...content };
}

export function validateChildAcceptance(value: unknown, location: string): ChildAcceptance {
  if (!isRecord(value))
    failA1("INVALID_ACCEPTANCE", "child acceptance must be an object", location);
  assertNoUnknownFields(
    value,
    ["schema_version", "acceptance_id", "owner_run_id", "position_id", "metric"],
    location,
  );
  if (value.schema_version !== 1)
    failA1("INVALID_ACCEPTANCE", "unsupported child acceptance schema", location);
  const acceptance = buildChildAcceptance({
    owner_run_id: value.owner_run_id as string,
    position_id: value.position_id as string,
    metric: value.metric,
  });
  if (
    assertIdentifier(value.acceptance_id, `${location}.acceptance_id`) !== acceptance.acceptance_id
  )
    failA1("IDENTITY_MISMATCH", "child acceptance id does not match its content", location);
  return acceptance;
}

/**
 * Reject an id that names a tester in the task's tester store.
 *
 * Nothing stops a caller from choosing an acceptance id; this is what stops it
 * from choosing the task tester's id and getting a child's local verdict
 * treated as a tester result downstream.
 */
function assertNotATester(projectRoot: string, acceptanceId: string, location: string): void {
  const testerDir = path.join(path.resolve(projectRoot), ".aris", "testers", acceptanceId);
  if (fs.existsSync(testerDir))
    failA1("CHILD_TESTER_FORBIDDEN", "a child acceptance cannot take the id of a tester", location);
}

export function readChildAcceptances(
  projectRoot: string,
  ownerRunId: string,
): ChildAcceptanceIndex {
  const filePath = childAcceptancePath(projectRoot, ownerRunId);
  if (!fs.existsSync(filePath))
    return { schema_version: 1, owner_run_id: ownerRunId, acceptances: [] };
  const index = readStateFile<ChildAcceptanceIndex>(filePath);
  if (!isRecord(index) || !Array.isArray(index.acceptances))
    failA1("INVALID_ACCEPTANCE", "child acceptance index is malformed", filePath);
  if (index.owner_run_id !== ownerRunId)
    failA1("IDENTITY_MISMATCH", "child acceptance index belongs to another run", filePath);
  return {
    schema_version: 1,
    owner_run_id: ownerRunId,
    acceptances: index.acceptances.map((entry, position) =>
      validateChildAcceptance(entry, `${filePath}.acceptances[${position}]`),
    ),
  };
}

/**
 * Record an acceptance in its owner's run directory.
 *
 * Writing the same acceptance twice is a no-op, which is what makes
 * re-materializing a plan safe. Two different contents can never collide on one
 * id, because the id is the hash of the content.
 */
export function saveChildAcceptance(
  projectRoot: string,
  value: ChildAcceptance | unknown,
): ChildAcceptance {
  const acceptance = validateChildAcceptance(value, "acceptance");
  const filePath = childAcceptancePath(projectRoot, acceptance.owner_run_id);
  assertNotATester(projectRoot, acceptance.acceptance_id, "acceptance.acceptance_id");
  return withStateFileLock(filePath, () => {
    const index = readChildAcceptances(projectRoot, acceptance.owner_run_id);
    if (index.acceptances.some((entry) => entry.acceptance_id === acceptance.acceptance_id))
      return acceptance;
    const acceptances = [...index.acceptances, acceptance].sort((left, right) =>
      left.acceptance_id < right.acceptance_id ? -1 : 1,
    );
    writeStateJsonAtomic(filePath, { ...index, acceptances });
    return acceptance;
  });
}

/**
 * Resolve what a child charter's `measurement.tester_ref` points at.
 *
 * A ref that no parent-owned acceptance answers to is the case this exists to
 * catch: it means the child was pointed at something outside its parent, and
 * the only thing outside its parent worth pointing at is the task tester.
 */
export function requireChildAcceptance(
  projectRoot: string,
  ownerRunId: string,
  acceptanceId: string,
  location: string,
): ChildAcceptance {
  const index = readChildAcceptances(projectRoot, ownerRunId);
  const found = index.acceptances.find((entry) => entry.acceptance_id === acceptanceId);
  if (found === undefined)
    failA1(
      "CHILD_TESTER_FORBIDDEN",
      "a child is judged by an acceptance its parent wrote, and this run wrote no such acceptance",
      location,
    );
  return found;
}
