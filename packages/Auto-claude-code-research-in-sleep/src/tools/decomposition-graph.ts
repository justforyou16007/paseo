import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { acquireLineageHold, releaseLineageHold } from "./lineage-lock.js";
import { runOwnedPath } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { readWikiEvents } from "./wiki-event-store.js";
import { parseWikiPayload } from "./wiki-operations.js";
import { runWikiRoot } from "./wiki-scope.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

/**
 * What a parent decided to decompose its question into, one generation at a
 * time.
 *
 * An orchestration run optimizes this graph rather than an experiment: the
 * nodes are the positions it dispatches children to, and the edges are the
 * `depends_on` relation that makes a pair serial. The graph is what the round
 * is scored on, so it is written once per generation and never edited in
 * place — a changed decomposition is the next generation, with its own
 * children.
 *
 * The graph stores only the part of a child's task the parent decides: the
 * question, the required output, the constraints, and who waits for whom.
 * Everything else about a child (its run id, its budget, its Wiki) belongs to
 * `children.json` and the child's own contract. The two files answer different
 * questions and are hashed differently: this one answers "did the
 * decomposition change", `children.json` answers "which runs carry it".
 */
export interface DecompositionTask {
  problem: string;
  expected_output: unknown;
  constraints: Record<string, unknown>;
}

export interface DecompositionPosition extends DecompositionTask {
  position_id: string;
  /** Positions whose published outputs this one consumes. Empty means parallel. */
  depends_on: string[];
}

export interface DecompositionGraph {
  schema_version: 1;
  parent_run_id: string;
  generation: number;
  positions: DecompositionPosition[];
  decomposition_sha256: string;
  created_at: string;
}

/**
 * One indivisible change to the decomposition, with everything it does not
 * name left frozen.
 *
 * These are the module-graph structure actions read on a decomposition: the
 * same six verbs (replace, insert, remove, fan out, fan in, reorder) plus the
 * three that only exist here, because a position carries a task and a module
 * does not. They cannot be the same objects as `StructureAction` in
 * `workflow-compiler.ts`: those name a registered module out of a catalog and
 * wire typed ports with contracts, while a position is authored on the spot
 * and has one implicit input (its upstreams' outputs) and one output. The
 * rewiring here is total and deterministic, so an action never asks the caller
 * to restate the edges it implies.
 *
 * Each of the nine changes `problem`, `expected_output`, `constraints` or
 * `depends_on` of at least one position, and all four are inside the charter
 * the child's `task_sha256` is taken over. So any action that lands produces a
 * new task hash for the positions it touched, and therefore new child runs.
 */
export type DecompositionAction =
  | { op: "retask_position"; position_id: string; problem?: string; expected_output?: unknown }
  | { op: "reconstrain_position"; position_id: string; constraints: Record<string, unknown> }
  | { op: "recontract_edge"; from: string; to: string; contract: unknown }
  | { op: "replace_position"; position_id: string; position: DecompositionTaskInput }
  | { op: "insert_position"; from: string; to: string; position: DecompositionTaskInput }
  | { op: "remove_position"; position_id: string }
  | { op: "fan_out"; position_id: string; branches: DecompositionTaskInput[] }
  | { op: "fan_in"; position_ids: string[]; position: DecompositionTaskInput }
  | { op: "reorder"; position_id: string; before_position_id: string };

export interface DecompositionTaskInput extends DecompositionTask {
  position_id: string;
}

export interface DecompositionSignal {
  signal_id: string;
  feedback_event_id: string;
  summary: string;
  observation: string;
  recommendation: string;
}

export interface DecompositionWaveRecord {
  schema_version: 1;
  parent_run_id: string;
  /** The generation this wave proposes. The baseline is the one before it. */
  generation: number;
  proposal_id: string;
  /** Hash of the frozen proposal: the baseline it targets, the actions, the result. */
  proposal_identity_sha256: string;
  /** The tester outcome that let this wave open. Direction only; never a score. */
  signal: DecompositionSignal;
  actions: DecompositionAction[];
  s0: { generation: number; decomposition_sha256: string; positions: DecompositionPosition[] };
  s1: { decomposition_sha256: string; positions: DecompositionPosition[] };
  created_at: string;
}

function decompositionDirectory(projectRoot: string, parentRunId: string): string {
  return runOwnedPath(projectRoot, parentRunId, "decomposition");
}

export function decompositionGraphPath(
  projectRoot: string,
  parentRunId: string,
  generation: number,
): string {
  return path.join(
    decompositionDirectory(projectRoot, parentRunId),
    `generation-${requireInteger(generation, "generation", 1)}.json`,
  );
}

export function decompositionWavePath(
  projectRoot: string,
  parentRunId: string,
  generation: number,
): string {
  return path.join(
    decompositionDirectory(projectRoot, parentRunId),
    `wave-${requireInteger(generation, "generation", 2)}.json`,
  );
}

/**
 * The identity of a decomposition: which positions exist, what each one was
 * asked for, and who waits for whom. The generation number is not part of it,
 * so two generations that arrived at the same decomposition hash the same and
 * "did anything change?" is answered by comparing hashes.
 */
export function decompositionSha256(positions: readonly DecompositionPosition[]): string {
  return canonicalJsonSha256(
    orderPositions(positions).map((position) => ({
      position_id: position.position_id,
      problem: position.problem,
      expected_output: position.expected_output,
      constraints: position.constraints,
      depends_on: position.depends_on,
    })),
    undefined,
    { schemaVersion: "decomposition-graph-v1" },
  );
}

function orderPositions(positions: readonly DecompositionPosition[]): DecompositionPosition[] {
  return [...positions]
    .map((position) => ({
      ...position,
      depends_on: [...position.depends_on].sort(compareIdentityStrings),
    }))
    .sort((left, right) => compareIdentityStrings(left.position_id, right.position_id));
}

function validateTask(value: unknown, location: string): DecompositionTask {
  if (!isRecord(value)) failA1("INVALID_DECOMPOSITION", `${location} must be an object`, location);
  const expectedOutput = value.expected_output;
  if (expectedOutput === undefined || expectedOutput === null)
    failA1("INVALID_DECOMPOSITION", "a position must say what it has to produce", location);
  if (value.constraints !== undefined && !isRecord(value.constraints))
    failA1("INVALID_DECOMPOSITION", "position constraints must be an object", location);
  return {
    problem: requireString(value.problem, `${location}.problem`),
    expected_output: expectedOutput,
    constraints: (value.constraints ?? {}) as Record<string, unknown>,
  };
}

function validateTaskInput(value: unknown, location: string): DecompositionTaskInput {
  if (!isRecord(value)) failA1("INVALID_DECOMPOSITION", `${location} must be an object`, location);
  assertNoUnknownFields(
    value,
    ["position_id", "problem", "expected_output", "constraints"],
    location,
  );
  return {
    position_id: assertIdentifier(value.position_id, `${location}.position_id`),
    ...validateTask(value, location),
  };
}

export function validateDecompositionPositions(value: unknown): DecompositionPosition[] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_DECOMPOSITION", "a decomposition needs at least one position", "positions");
  const seen = new Set<string>();
  const positions = value.map((entry, index) => {
    const location = `positions[${index}]`;
    if (!isRecord(entry)) failA1("INVALID_DECOMPOSITION", "a position must be an object", location);
    assertNoUnknownFields(
      entry,
      ["position_id", "problem", "expected_output", "constraints", "depends_on"],
      location,
    );
    const positionId = assertIdentifier(entry.position_id, `${location}.position_id`);
    if (seen.has(positionId))
      failA1("DUPLICATE_ID", `position '${positionId}' appears twice`, location);
    seen.add(positionId);
    const dependsOn =
      entry.depends_on === undefined
        ? []
        : (() => {
            if (!Array.isArray(entry.depends_on))
              failA1("INVALID_DECOMPOSITION", "depends_on must be an array", location);
            return entry.depends_on.map((dependency, dependencyIndex) =>
              assertIdentifier(dependency, `${location}.depends_on[${dependencyIndex}]`),
            );
          })();
    return { position_id: positionId, ...validateTask(entry, location), depends_on: dependsOn };
  });
  return assertWiring(positions);
}

/** Every edge points at a position that exists, and no edge closes a loop. */
function assertWiring(positions: readonly DecompositionPosition[]): DecompositionPosition[] {
  const ordered = orderPositions(positions);
  const known = new Set(ordered.map((position) => position.position_id));
  for (const position of ordered) {
    if (new Set(position.depends_on).size !== position.depends_on.length)
      failA1("DUPLICATE_ID", `position '${position.position_id}' names an upstream twice`);
    for (const dependency of position.depends_on) {
      if (dependency === position.position_id)
        failA1("INVALID_DECOMPOSITION", `position '${position.position_id}' depends on itself`);
      if (!known.has(dependency))
        failA1(
          "INVALID_DECOMPOSITION",
          `position '${position.position_id}' depends on unknown position '${dependency}'`,
        );
    }
  }
  const settled = new Set<string>();
  let progressed = true;
  while (progressed && settled.size < ordered.length) {
    progressed = false;
    for (const position of ordered) {
      if (settled.has(position.position_id)) continue;
      if (position.depends_on.every((dependency) => settled.has(dependency))) {
        settled.add(position.position_id);
        progressed = true;
      }
    }
  }
  if (settled.size !== ordered.length)
    failA1("INVALID_DECOMPOSITION", "the decomposition contains a dependency cycle");
  return ordered;
}

function parseAction(value: unknown, location: string): DecompositionAction {
  if (!isRecord(value))
    failA1("INVALID_DECOMPOSITION_ACTION", "a structure action must be an object", location);
  const op = value.op;
  if (op === "retask_position") {
    assertNoUnknownFields(value, ["op", "position_id", "problem", "expected_output"], location);
    if (value.problem === undefined && value.expected_output === undefined)
      failA1(
        "INVALID_DECOMPOSITION_ACTION",
        "retask_position must change the question or the required output",
        location,
      );
    return {
      op,
      position_id: assertIdentifier(value.position_id, `${location}.position_id`),
      ...(value.problem === undefined
        ? {}
        : { problem: requireString(value.problem, `${location}.problem`) }),
      ...(value.expected_output === undefined ? {} : { expected_output: value.expected_output }),
    };
  }
  if (op === "reconstrain_position") {
    assertNoUnknownFields(value, ["op", "position_id", "constraints"], location);
    if (!isRecord(value.constraints))
      failA1("INVALID_DECOMPOSITION_ACTION", "constraints must be an object", location);
    return {
      op,
      position_id: assertIdentifier(value.position_id, `${location}.position_id`),
      constraints: value.constraints as Record<string, unknown>,
    };
  }
  if (op === "recontract_edge") {
    assertNoUnknownFields(value, ["op", "from", "to", "contract"], location);
    if (value.contract === undefined)
      failA1("INVALID_DECOMPOSITION_ACTION", "recontract_edge needs a contract", location);
    return {
      op,
      from: assertIdentifier(value.from, `${location}.from`),
      to: assertIdentifier(value.to, `${location}.to`),
      contract: value.contract,
    };
  }
  if (op === "replace_position") {
    assertNoUnknownFields(value, ["op", "position_id", "position"], location);
    return {
      op,
      position_id: assertIdentifier(value.position_id, `${location}.position_id`),
      position: validateTaskInput(value.position, `${location}.position`),
    };
  }
  if (op === "insert_position") {
    assertNoUnknownFields(value, ["op", "from", "to", "position"], location);
    return {
      op,
      from: assertIdentifier(value.from, `${location}.from`),
      to: assertIdentifier(value.to, `${location}.to`),
      position: validateTaskInput(value.position, `${location}.position`),
    };
  }
  if (op === "remove_position") {
    assertNoUnknownFields(value, ["op", "position_id"], location);
    return { op, position_id: assertIdentifier(value.position_id, `${location}.position_id`) };
  }
  if (op === "fan_out") {
    assertNoUnknownFields(value, ["op", "position_id", "branches"], location);
    if (!Array.isArray(value.branches) || value.branches.length < 2)
      failA1("INVALID_DECOMPOSITION_ACTION", "fan_out needs at least two branches", location);
    return {
      op,
      position_id: assertIdentifier(value.position_id, `${location}.position_id`),
      branches: value.branches.map((branch, index) =>
        validateTaskInput(branch, `${location}.branches[${index}]`),
      ),
    };
  }
  if (op === "fan_in") {
    assertNoUnknownFields(value, ["op", "position_ids", "position"], location);
    if (!Array.isArray(value.position_ids) || value.position_ids.length < 2)
      failA1("INVALID_DECOMPOSITION_ACTION", "fan_in needs at least two positions", location);
    return {
      op,
      position_ids: value.position_ids.map((id, index) =>
        assertIdentifier(id, `${location}.position_ids[${index}]`),
      ),
      position: validateTaskInput(value.position, `${location}.position`),
    };
  }
  if (op === "reorder") {
    assertNoUnknownFields(value, ["op", "position_id", "before_position_id"], location);
    return {
      op,
      position_id: assertIdentifier(value.position_id, `${location}.position_id`),
      before_position_id: assertIdentifier(
        value.before_position_id,
        `${location}.before_position_id`,
      ),
    };
  }
  failA1("INVALID_DECOMPOSITION_ACTION", `unsupported structure action '${String(op)}'`, location);
}

export function parseDecompositionActions(value: unknown): DecompositionAction[] {
  if (!Array.isArray(value))
    failA1("INVALID_DECOMPOSITION_ACTION", "structure actions must be an array", "actions");
  if (value.length === 0)
    failA1(
      "INVALID_DECOMPOSITION_ACTION",
      "a structure proposal needs at least one action",
      "actions",
    );
  return value.map((action, index) => parseAction(action, `actions[${index}]`));
}

function requirePosition(
  positions: readonly DecompositionPosition[],
  positionId: string,
  location: string,
): DecompositionPosition {
  const found = positions.find((position) => position.position_id === positionId);
  if (found === undefined)
    failA1(
      "INVALID_DECOMPOSITION_ACTION",
      `position '${positionId}' is not in the graph`,
      location,
    );
  return found;
}

function requireAbsent(
  positions: readonly DecompositionPosition[],
  positionId: string,
  location: string,
): void {
  if (positions.some((position) => position.position_id === positionId))
    failA1(
      "INVALID_DECOMPOSITION_ACTION",
      `position '${positionId}' is already in the graph`,
      location,
    );
}

function withUpstream(
  position: DecompositionPosition,
  replaced: string,
  replacements: readonly string[],
): DecompositionPosition {
  if (!position.depends_on.includes(replaced)) return position;
  const kept = position.depends_on.filter((dependency) => dependency !== replaced);
  return { ...position, depends_on: [...new Set([...kept, ...replacements])] };
}

function newPosition(
  task: DecompositionTaskInput,
  dependsOn: readonly string[],
): DecompositionPosition {
  return {
    position_id: task.position_id,
    problem: task.problem,
    expected_output: task.expected_output,
    constraints: task.constraints,
    depends_on: [...dependsOn],
  };
}

/**
 * Read one action onto the graph. Everything the action does not name keeps
 * its task and its edges, which is what makes a generation a controlled
 * comparison against the one before it.
 */
function applyAction(
  positions: readonly DecompositionPosition[],
  action: DecompositionAction,
  location: string,
): DecompositionPosition[] {
  if (action.op === "retask_position") {
    const target = requirePosition(positions, action.position_id, location);
    return positions.map((position) =>
      position.position_id === target.position_id
        ? {
            ...position,
            ...(action.problem === undefined ? {} : { problem: action.problem }),
            ...(action.expected_output === undefined
              ? {}
              : { expected_output: action.expected_output }),
          }
        : position,
    );
  }
  if (action.op === "reconstrain_position") {
    const target = requirePosition(positions, action.position_id, location);
    return positions.map((position) =>
      position.position_id === target.position_id
        ? { ...position, constraints: action.constraints }
        : position,
    );
  }
  if (action.op === "recontract_edge") {
    const downstream = requirePosition(positions, action.to, location);
    if (!downstream.depends_on.includes(action.from))
      failA1(
        "INVALID_DECOMPOSITION_ACTION",
        `'${action.to}' does not read from '${action.from}'`,
        location,
      );
    // The contract between two positions is a constraint on the downstream:
    // it is the shape the downstream is entitled to receive, and it travels
    // with that child's charter rather than in a separate edge record.
    const existing = isRecord(downstream.constraints.input_contracts)
      ? downstream.constraints.input_contracts
      : {};
    return positions.map((position) =>
      position.position_id === downstream.position_id
        ? {
            ...position,
            constraints: {
              ...position.constraints,
              input_contracts: { ...existing, [action.from]: action.contract },
            },
          }
        : position,
    );
  }
  if (action.op === "replace_position") {
    const target = requirePosition(positions, action.position_id, location);
    if (action.position.position_id !== target.position_id)
      requireAbsent(positions, action.position.position_id, location);
    const replacement = newPosition(action.position, target.depends_on);
    return positions
      .filter((position) => position.position_id !== target.position_id)
      .map((position) => withUpstream(position, target.position_id, [replacement.position_id]))
      .concat(replacement);
  }
  if (action.op === "insert_position") {
    const downstream = requirePosition(positions, action.to, location);
    requirePosition(positions, action.from, location);
    if (!downstream.depends_on.includes(action.from))
      failA1(
        "INVALID_DECOMPOSITION_ACTION",
        `'${action.to}' does not read from '${action.from}'`,
        location,
      );
    requireAbsent(positions, action.position.position_id, location);
    const inserted = newPosition(action.position, [action.from]);
    return positions
      .map((position) =>
        position.position_id === downstream.position_id
          ? withUpstream(position, action.from, [inserted.position_id])
          : position,
      )
      .concat(inserted);
  }
  if (action.op === "remove_position") {
    const target = requirePosition(positions, action.position_id, location);
    if (positions.length === 1)
      failA1("INVALID_DECOMPOSITION_ACTION", "the last position cannot be removed", location);
    // Whoever read from this position now reads from what it read from, so
    // removing a step never silently drops the inputs of the steps after it.
    return positions
      .filter((position) => position.position_id !== target.position_id)
      .map((position) => withUpstream(position, target.position_id, target.depends_on));
  }
  if (action.op === "fan_out") {
    const target = requirePosition(positions, action.position_id, location);
    const branchIds = action.branches.map((branch) => branch.position_id);
    if (new Set(branchIds).size !== branchIds.length)
      failA1("DUPLICATE_ID", "fan_out branches must have distinct positions", location);
    for (const branch of action.branches)
      if (branch.position_id !== target.position_id)
        requireAbsent(positions, branch.position_id, location);
    // One question becomes several that can be answered at the same time:
    // each branch inherits what the original waited for, and everything that
    // waited for the original now waits for all of them.
    const branches = action.branches.map((branch) => newPosition(branch, target.depends_on));
    return positions
      .filter((position) => position.position_id !== target.position_id)
      .map((position) => withUpstream(position, target.position_id, branchIds))
      .concat(branches);
  }
  if (action.op === "fan_in") {
    const merged = action.position_ids.map((id) => requirePosition(positions, id, location));
    if (new Set(action.position_ids).size !== action.position_ids.length)
      failA1("DUPLICATE_ID", "fan_in must name distinct positions", location);
    for (const position of merged)
      if (position.depends_on.some((dependency) => action.position_ids.includes(dependency)))
        failA1(
          "INVALID_DECOMPOSITION_ACTION",
          "fan_in only merges positions that do not wait for each other",
          location,
        );
    if (!action.position_ids.includes(action.position.position_id))
      requireAbsent(positions, action.position.position_id, location);
    const upstreams = [...new Set(merged.flatMap((position) => position.depends_on))];
    const replacement = newPosition(action.position, upstreams);
    let next = positions.filter((position) => !action.position_ids.includes(position.position_id));
    for (const id of action.position_ids)
      next = next.map((position) => withUpstream(position, id, [replacement.position_id]));
    return next.concat(replacement);
  }
  const moved = requirePosition(positions, action.position_id, location);
  const after = requirePosition(positions, action.before_position_id, location);
  if (moved.position_id === after.position_id)
    failA1(
      "INVALID_DECOMPOSITION_ACTION",
      "a position cannot be reordered against itself",
      location,
    );
  if (after.depends_on.includes(moved.position_id))
    failA1(
      "INVALID_DECOMPOSITION_ACTION",
      `'${after.position_id}' already waits for '${moved.position_id}'`,
      location,
    );
  // Serializing a pair is one edge plus the removal of the opposite edge, so
  // "run A before B" is expressible whether they were parallel or reversed.
  return positions.map((position) => {
    if (position.position_id === after.position_id)
      return { ...position, depends_on: [...position.depends_on, moved.position_id] };
    if (position.position_id === moved.position_id)
      return {
        ...position,
        depends_on: position.depends_on.filter((dependency) => dependency !== after.position_id),
      };
    return position;
  });
}

export function applyDecompositionActions(
  positions: readonly DecompositionPosition[],
  actions: readonly DecompositionAction[],
): DecompositionPosition[] {
  let next = orderPositions(positions);
  for (const [index, action] of actions.entries())
    next = assertWiring(applyAction(next, action, `actions[${index}]`));
  return next;
}

/**
 * Write a record the first time and refuse a different one afterwards. The
 * identity is the caller's hash, not the file bytes, so a retry that arrives
 * at the same decision is allowed even though its timestamp differs.
 */
function writeOnce(filePath: string, value: unknown, identity: string, code: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (!isRecord(existing) || existing[identityField(value)] !== identity)
        failA1(code, "this generation has already recorded another decision", filePath);
      return;
    }
    writeStateJsonAtomic(filePath, value);
  });
}

function identityField(value: unknown): string {
  return isRecord(value) && Object.hasOwn(value, "proposal_id")
    ? "proposal_identity_sha256"
    : "decomposition_sha256";
}

export function readDecompositionGraph(
  projectRoot: string,
  parentRunId: string,
  generation: number,
): DecompositionGraph {
  const filePath = decompositionGraphPath(projectRoot, parentRunId, generation);
  if (!fs.existsSync(filePath))
    failA1("DECOMPOSITION_NOT_FOUND", `no decomposition generation at ${filePath}`);
  const value = readStateFile(filePath);
  if (!isRecord(value) || value.schema_version !== 1)
    failA1("CORRUPT_DECOMPOSITION", "decomposition generation is malformed", filePath);
  const positions = validateDecompositionPositions(value.positions);
  const hash = decompositionSha256(positions);
  if (value.decomposition_sha256 !== hash)
    failA1("CORRUPT_DECOMPOSITION", "decomposition hash does not match its positions", filePath);
  return {
    schema_version: 1,
    parent_run_id: requireString(value.parent_run_id, `${filePath}.parent_run_id`),
    generation: requireInteger(value.generation, `${filePath}.generation`, 1),
    positions,
    decomposition_sha256: hash,
    created_at: requireString(value.created_at, `${filePath}.created_at`),
  };
}

/** The newest generation on disk, or 0 when this run has decomposed nothing. */
export function latestDecompositionGeneration(projectRoot: string, parentRunId: string): number {
  const directory = decompositionDirectory(projectRoot, parentRunId);
  if (!fs.existsSync(directory)) return 0;
  const generations = fs
    .readdirSync(directory)
    .map((name) => /^generation-(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return generations.length === 0 ? 0 : Math.max(...generations);
}

export function hasDecomposition(projectRoot: string, parentRunId: string): boolean {
  return latestDecompositionGeneration(projectRoot, parentRunId) > 0;
}

/**
 * The tester outcome that lets a decomposition change.
 *
 * Structure only evolves after a whole generation ran, was assembled, and was
 * measured through the parent's tester gate, so the proof that a generation is
 * over is the tester feedback signal the outer committer published for it. One
 * generation burns one exposure and produces one signal, so generation N can
 * only be proposed once N-1 of them exist.
 *
 * The signal is direction, never score: it says what the fixed tester noticed,
 * and the proposer turns that into actions. S0 and S1 produce the numbers.
 */
export function readEvolutionSignal(
  projectRoot: string,
  parentRunId: string,
  generation: number,
): DecompositionSignal {
  const required = requireInteger(generation, "generation", 2) - 1;
  const root = runWikiRoot(projectRoot, parentRunId);
  const published: DecompositionSignal[] = [];
  for (const event of fs.existsSync(root) ? readWikiEvents(root) : []) {
    for (const operation of parseWikiPayload(event.payload).operations) {
      if (operation.op !== "publish_signal" && operation.op !== "upsert_signal") continue;
      const signal = operation.signal;
      if (signal.source !== "tester_feedback") continue;
      published.push({
        signal_id: signal.signal_id,
        feedback_event_id: signal.evidence_refs[0] ?? signal.signal_id,
        summary: signal.summary ?? "",
        observation: signal.observation ?? "",
        recommendation: signal.recommendation ?? "",
      });
    }
  }
  if (published.length < required)
    failA1(
      "EVOLUTION_SIGNAL_REQUIRED",
      "a decomposition changes only after its generation was measured and the tester feedback signal was published",
    );
  return published[published.length - 1]!;
}

export interface PrepareDecompositionWaveInput {
  project_root: string;
  parent_run_id: string;
  /** The generation being proposed. Generation 1 is the creation, not a wave. */
  generation: number;
  proposal_id: string;
  /** The hash of the generation this proposal is a delta against. */
  baseline_sha256: string;
  actions: readonly DecompositionAction[] | unknown;
}

export function readDecompositionWave(
  projectRoot: string,
  parentRunId: string,
  generation: number,
): DecompositionWaveRecord {
  const filePath = decompositionWavePath(projectRoot, parentRunId, generation);
  if (!fs.existsSync(filePath))
    failA1("DECOMPOSITION_WAVE_REQUIRED", `no decomposition wave at ${filePath}`);
  const value = readStateFile(filePath);
  if (!isRecord(value) || value.schema_version !== 1)
    failA1("CORRUPT_DECOMPOSITION", "decomposition wave is malformed", filePath);
  return value as unknown as DecompositionWaveRecord;
}

/**
 * Freeze the one change this generation makes, against the generation before
 * it read from disk.
 *
 * The baseline is never assembled from memory: S0 is the previous generation's
 * recorded file, so a proposer cannot compare against a decomposition that was
 * never dispatched. The wave takes the lineage structure hold, which is what
 * makes "the whole graph finished first" a check rather than a convention — a
 * child still inside its own cycle refuses the hold.
 */
export function prepareDecompositionWave(
  input: PrepareDecompositionWaveInput,
): DecompositionWaveRecord {
  const projectRoot = requireString(input.project_root, "project_root");
  const parentRunId = assertIdentifier(input.parent_run_id, "parent_run_id");
  const generation = requireInteger(input.generation, "generation", 1);
  if (generation < 2)
    failA1(
      "DECOMPOSITION_BASELINE_GENERATION",
      "the first decomposition is the creation, and the creation is the baseline",
    );
  const proposalId = assertIdentifier(input.proposal_id, "proposal_id");
  const baseline = readDecompositionGraph(projectRoot, parentRunId, generation - 1);
  if (assertSha256(input.baseline_sha256, "baseline_sha256") !== baseline.decomposition_sha256)
    failA1(
      "DECOMPOSITION_BASELINE_CONFLICT",
      "the proposal is a delta against another decomposition than the one on disk",
    );
  if (latestDecompositionGeneration(projectRoot, parentRunId) >= generation)
    failA1(
      "DECOMPOSITION_FROZEN",
      "this generation has already been dispatched and cannot be reproposed",
    );
  const actions = parseDecompositionActions(input.actions);
  const signal = readEvolutionSignal(projectRoot, parentRunId, generation);
  const positions = applyDecompositionActions(baseline.positions, actions);
  const s1Hash = decompositionSha256(positions);
  if (s1Hash === baseline.decomposition_sha256)
    failA1("DECOMPOSITION_DELTA_EMPTY", "the proposed actions leave the decomposition unchanged");
  acquireLineageHold(projectRoot, parentRunId, "structure");
  const record: DecompositionWaveRecord = {
    schema_version: 1,
    parent_run_id: parentRunId,
    generation,
    proposal_id: proposalId,
    proposal_identity_sha256: canonicalJsonSha256(
      { proposal_id: proposalId, baseline: baseline.decomposition_sha256, actions, s1: s1Hash },
      undefined,
      { schemaVersion: "decomposition-proposal-v1" },
    ),
    signal,
    actions,
    s0: {
      generation: baseline.generation,
      decomposition_sha256: baseline.decomposition_sha256,
      positions: baseline.positions,
    },
    s1: { decomposition_sha256: s1Hash, positions },
    created_at: new Date().toISOString(),
  };
  const filePath = decompositionWavePath(projectRoot, parentRunId, generation);
  writeOnce(filePath, record, record.proposal_identity_sha256, "IMMUTABLE_CONFLICT");
  return readDecompositionWave(projectRoot, parentRunId, generation);
}

/**
 * Record the decomposition this generation will be dispatched from.
 *
 * Generation 1 is free: it is the creation, and its measurement becomes the
 * baseline every later generation is compared against. From generation 2 on,
 * the decomposition has to be the one the wave froze, so the only way the
 * structure changes is through a wave that a tester signal opened.
 *
 * This happens before the first child is dispatched, not as a side effect of
 * dispatching. A generation is decided once and dispatched in as many rounds
 * as its edges require — a position with an upstream cannot be materialized
 * until that upstream has published — so a decomposition derived from a
 * dispatch would contain only the positions that happened to be dispatchable
 * first, and the collection could never tell that the rest are still missing.
 */
export function recordDecompositionGraph(
  projectRoot: string,
  parentRunId: string,
  generation: number,
  positions: readonly DecompositionPosition[],
): DecompositionGraph {
  const ordered = validateDecompositionPositions(positions);
  const hash = decompositionSha256(ordered);
  if (generation > 1) {
    const wave = readDecompositionWave(projectRoot, parentRunId, generation);
    if (wave.s1.decomposition_sha256 !== hash)
      failA1(
        "DECOMPOSITION_WAVE_REQUIRED",
        "the dispatched decomposition is not the one this generation's wave froze",
      );
  }
  const record: DecompositionGraph = {
    schema_version: 1,
    parent_run_id: parentRunId,
    generation,
    positions: ordered,
    decomposition_sha256: hash,
    created_at: new Date().toISOString(),
  };
  const filePath = decompositionGraphPath(projectRoot, parentRunId, generation);
  writeOnce(filePath, record, hash, "DECOMPOSITION_FROZEN");
  if (generation > 1) releaseLineageHold(projectRoot, parentRunId, "structure");
  return readDecompositionGraph(projectRoot, parentRunId, generation);
}

/** The part of a position a dispatch has to reproduce exactly. */
function taskIdentity(position: DecompositionPosition): string {
  return canonicalJsonSha256(
    {
      problem: position.problem,
      expected_output: position.expected_output,
      constraints: position.constraints,
      depends_on: [...position.depends_on].sort(compareIdentityStrings),
    },
    undefined,
    { schemaVersion: "decomposition-position-v1" },
  );
}

/**
 * Check a dispatch against the decomposition it claims to be carrying out.
 *
 * A dispatch may be a subset — the positions whose upstreams have published —
 * but it may not invent a position, and it may not hand a position a task the
 * decomposition did not give it. Both would make the recorded graph a
 * description of something other than what is running.
 */
export function assertDispatchInDecomposition(
  projectRoot: string,
  parentRunId: string,
  generation: number,
  dispatched: readonly DecompositionPosition[],
): DecompositionGraph {
  if (!fs.existsSync(decompositionGraphPath(projectRoot, parentRunId, generation)))
    failA1(
      "DECOMPOSITION_NOT_FOUND",
      `generation ${generation} has no recorded decomposition; record it before dispatching it`,
    );
  const graph = readDecompositionGraph(projectRoot, parentRunId, generation);
  for (const position of dispatched) {
    const recorded = graph.positions.find((entry) => entry.position_id === position.position_id);
    if (recorded === undefined)
      failA1(
        "DECOMPOSITION_MISMATCH",
        `position '${position.position_id}' is not in this generation's decomposition`,
      );
    if (taskIdentity(recorded) !== taskIdentity(position))
      failA1(
        "DECOMPOSITION_MISMATCH",
        `position '${position.position_id}' is being dispatched with a task this generation's decomposition does not give it`,
      );
  }
  return graph;
}
