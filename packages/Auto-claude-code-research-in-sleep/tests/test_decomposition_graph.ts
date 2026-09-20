import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChildContract } from "./helpers/child-contract.js";
import { createRootRun } from "../src/tools/run-contract.js";
import { acquireLineageHold, releaseLineageHold } from "../src/tools/lineage-lock.js";
import { publishEvolutionSignal } from "./helpers/evolution-signal.js";
import {
  applyDecompositionActions,
  decompositionSha256,
  hasDecomposition,
  latestDecompositionGeneration,
  parseDecompositionActions,
  prepareDecompositionWave,
  readDecompositionGraph,
  recordDecompositionGraph,
  validateDecompositionPositions,
  type DecompositionAction,
  type DecompositionPosition,
} from "../src/tools/decomposition-graph.js";

const PARENT = "decomp-parent";
const HASH = "a".repeat(64);

function position(
  id: string,
  dependsOn: string[] = [],
  problem = `answer ${id}`,
): DecompositionPosition {
  return {
    position_id: id,
    problem,
    expected_output: { kind: "report" },
    constraints: {},
    depends_on: dependsOn,
  };
}

/** A position's task without its edges: what an action that authors one carries. */
function task(id: string): { position_id: string; problem: string; expected_output: unknown; constraints: Record<string, unknown> } {
  const { depends_on: _edges, ...rest } = position(id);
  return rest;
}

/** A collect-then-compare shape: two surveys in parallel, one synthesis after both. */
const BASELINE: DecompositionPosition[] = [
  position("survey-a"),
  position("survey-b"),
  position("synthesis", ["survey-a", "survey-b"]),
];

function fixture(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-decomposition-"));
  createRootRun({
    project_root: projectRoot,
    run_id: PARENT,
    input_snapshot_sha256: HASH,
    code_baseline_sha256: "b".repeat(64),
    policy_revision: "policy:decomposition",
  });
  return projectRoot;
}

function expectFailure(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error: unknown) {
    assert.equal((error as { code?: string }).code, code, String(error));
    return;
  }
  assert.fail(`expected ${code}`);
}

function ids(positions: readonly DecompositionPosition[]): string[] {
  return positions.map((entry) => entry.position_id).sort();
}

function upstreams(positions: readonly DecompositionPosition[], id: string): string[] {
  const found = positions.find((entry) => entry.position_id === id);
  assert.ok(found, `no position '${id}'`);
  return [...found.depends_on].sort();
}

function apply(actions: unknown): DecompositionPosition[] {
  return applyDecompositionActions(BASELINE, parseDecompositionActions(actions));
}

test("the first generation is the baseline, and it is written once", () => {
  const projectRoot = fixture();
  try {
    assert.equal(hasDecomposition(projectRoot, PARENT), false);
    const recorded = recordDecompositionGraph(projectRoot, PARENT, 1, BASELINE);
    assert.equal(recorded.decomposition_sha256, decompositionSha256(BASELINE));
    assert.equal(latestDecompositionGeneration(projectRoot, PARENT), 1);

    // Replaying the same dispatch is the same decision, not a second one.
    recordDecompositionGraph(projectRoot, PARENT, 1, [...BASELINE].reverse());
    // A different one at the same generation is a rewrite of a settled fact.
    expectFailure(
      () => recordDecompositionGraph(projectRoot, PARENT, 1, [position("survey-a")]),
      "DECOMPOSITION_FROZEN",
    );

    // There is nothing before the creation to compare against.
    expectFailure(
      () =>
        prepareDecompositionWave({
          project_root: projectRoot,
          parent_run_id: PARENT,
          generation: 1,
          proposal_id: "proposal:1",
          baseline_sha256: recorded.decomposition_sha256,
          actions: [{ op: "remove_position", position_id: "survey-b" }],
        }),
      "DECOMPOSITION_BASELINE_GENERATION",
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a later generation exists only as the delta a tester signal opened", () => {
  const projectRoot = fixture();
  try {
    const baseline = recordDecompositionGraph(projectRoot, PARENT, 1, BASELINE);
    const proposal = {
      project_root: projectRoot,
      parent_run_id: PARENT,
      generation: 2,
      proposal_id: "proposal:2",
      baseline_sha256: baseline.decomposition_sha256,
      actions: [
        { op: "retask_position", position_id: "survey-b", problem: "answer survey-b differently" },
      ],
    };

    // Nothing has been measured yet, so nothing may change.
    expectFailure(() => prepareDecompositionWave(proposal), "EVOLUTION_SIGNAL_REQUIRED");
    publishEvolutionSignal(projectRoot, PARENT, 1);

    // A delta against a decomposition that was never dispatched is refused
    // even though the actions themselves are fine.
    expectFailure(
      () => prepareDecompositionWave({ ...proposal, baseline_sha256: HASH }),
      "DECOMPOSITION_BASELINE_CONFLICT",
    );
    // So is a delta that changes nothing: a generation has to be a comparison.
    expectFailure(
      () =>
        prepareDecompositionWave({
          ...proposal,
          actions: [{ op: "reconstrain_position", position_id: "survey-b", constraints: {} }],
        }),
      "DECOMPOSITION_DELTA_EMPTY",
    );

    const wave = prepareDecompositionWave(proposal);
    // S0 is the generation on disk, not anything the proposer supplied.
    assert.equal(wave.s0.generation, 1);
    assert.equal(wave.s0.decomposition_sha256, baseline.decomposition_sha256);
    assert.notEqual(wave.s1.decomposition_sha256, baseline.decomposition_sha256);
    assert.equal(wave.signal.summary.includes("not_improved"), true);
    // Retrying the identical proposal is the same frozen wave.
    assert.equal(
      prepareDecompositionWave(proposal).proposal_identity_sha256,
      wave.proposal_identity_sha256,
    );
    // A different proposal for the same generation is not.
    expectFailure(
      () =>
        prepareDecompositionWave({
          ...proposal,
          proposal_id: "proposal:2b",
          actions: [{ op: "remove_position", position_id: "survey-b" }],
        }),
      "IMMUTABLE_CONFLICT",
    );

    // What gets dispatched has to be what the wave froze.
    expectFailure(
      () => recordDecompositionGraph(projectRoot, PARENT, 2, BASELINE),
      "DECOMPOSITION_WAVE_REQUIRED",
    );
    const second = recordDecompositionGraph(projectRoot, PARENT, 2, wave.s1.positions);
    assert.equal(second.decomposition_sha256, wave.s1.decomposition_sha256);
    assert.equal(latestDecompositionGeneration(projectRoot, PARENT), 2);
    assert.equal(
      readDecompositionGraph(projectRoot, PARENT, 1).decomposition_sha256,
      baseline.decomposition_sha256,
    );

    // A third generation needs its own exposure; the first signal was spent
    // opening the second.
    const third = {
      ...proposal,
      generation: 3,
      proposal_id: "proposal:3",
      baseline_sha256: second.decomposition_sha256,
      actions: [{ op: "remove_position", position_id: "survey-b" }],
    };
    expectFailure(() => prepareDecompositionWave(third), "EVOLUTION_SIGNAL_REQUIRED");
    publishEvolutionSignal(projectRoot, PARENT, 2);
    assert.equal(prepareDecompositionWave(third).s0.generation, 2);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a generation cannot be reproposed under the children already running it", () => {
  const projectRoot = fixture();
  try {
    const baseline = recordDecompositionGraph(projectRoot, PARENT, 1, BASELINE);
    publishEvolutionSignal(projectRoot, PARENT, 1);
    createChildContract(projectRoot, PARENT, "decomp-child", "survey-a");
    acquireLineageHold(projectRoot, "decomp-child", "iteration");
    const proposal = {
      project_root: projectRoot,
      parent_run_id: PARENT,
      generation: 2,
      proposal_id: "proposal:locked",
      baseline_sha256: baseline.decomposition_sha256,
      actions: [{ op: "remove_position", position_id: "survey-b" }],
    };
    // The graph has not finished running, so its successor cannot be frozen.
    expectFailure(() => prepareDecompositionWave(proposal), "LINEAGE_LOCKED");
    releaseLineageHold(projectRoot, "decomp-child", "iteration");
    const wave = prepareDecompositionWave(proposal);
    // The wave holds the lineage while it is open, so no child may start.
    expectFailure(
      () => acquireLineageHold(projectRoot, "decomp-child", "iteration"),
      "LINEAGE_LOCKED",
    );
    // Recording the dispatch hands the lineage back to the children.
    recordDecompositionGraph(projectRoot, PARENT, 2, wave.s1.positions);
    acquireLineageHold(projectRoot, "decomp-child", "iteration");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("each action rewires everything it implies and freezes the rest", () => {
  // retask and reconstrain touch one position's task and no edges.
  const retasked = apply([
    { op: "retask_position", position_id: "survey-a", expected_output: { kind: "table" } },
  ]);
  assert.deepEqual(ids(retasked), ["survey-a", "survey-b", "synthesis"]);
  assert.deepEqual(upstreams(retasked, "synthesis"), ["survey-a", "survey-b"]);
  assert.deepEqual(
    retasked.find((entry) => entry.position_id === "survey-a")?.expected_output,
    { kind: "table" },
  );

  // A contract lands on the downstream, because that is whose charter it binds.
  const recontracted = apply([
    { op: "recontract_edge", from: "survey-a", to: "synthesis", contract: { rows: "csv" } },
  ]);
  assert.deepEqual(
    recontracted.find((entry) => entry.position_id === "synthesis")?.constraints,
    { input_contracts: { "survey-a": { rows: "csv" } } },
  );
  // An edge that does not exist cannot be given a contract.
  expectFailure(
    () =>
      apply([{ op: "recontract_edge", from: "synthesis", to: "survey-a", contract: {} }]),
    "INVALID_DECOMPOSITION_ACTION",
  );

  // Replacing keeps the position's place in the graph.
  const replaced = apply([
    { op: "replace_position", position_id: "survey-a", position: task("survey-c") },
  ]);
  assert.deepEqual(ids(replaced), ["survey-b", "survey-c", "synthesis"]);
  assert.deepEqual(upstreams(replaced, "synthesis"), ["survey-b", "survey-c"]);

  // Inserting splits one edge and leaves the parallel sibling alone.
  const inserted = apply([
    {
      op: "insert_position",
      from: "survey-a",
      to: "synthesis",
      position: task("cleanup"),
    },
  ]);
  assert.deepEqual(upstreams(inserted, "synthesis"), ["cleanup", "survey-b"]);
  assert.deepEqual(upstreams(inserted, "cleanup"), ["survey-a"]);

  // Removing hands the removed node's upstreams to whoever read from it.
  const removedMiddle = applyDecompositionActions(
    apply([
      {
        op: "insert_position",
        from: "survey-a",
        to: "synthesis",
        position: task("cleanup"),
      },
    ]),
    parseDecompositionActions([{ op: "remove_position", position_id: "cleanup" }]),
  );
  assert.deepEqual(upstreams(removedMiddle, "synthesis"), ["survey-a", "survey-b"]);

  // Fanning out splits one question into parallel ones with the same context.
  const fannedOut = apply([
    {
      op: "fan_out",
      position_id: "synthesis",
      branches: [task("synth-x"), task("synth-y")],
    },
  ]);
  assert.deepEqual(ids(fannedOut), ["survey-a", "survey-b", "synth-x", "synth-y"]);
  assert.deepEqual(upstreams(fannedOut, "synth-x"), ["survey-a", "survey-b"]);

  // Fanning in merges independent questions and keeps their readers.
  const fannedIn = apply([
    {
      op: "fan_in",
      position_ids: ["survey-a", "survey-b"],
      position: task("survey-all"),
    },
  ]);
  assert.deepEqual(ids(fannedIn), ["survey-all", "synthesis"]);
  assert.deepEqual(upstreams(fannedIn, "synthesis"), ["survey-all"]);
  // Merging a position with something it waits for would erase the order.
  expectFailure(
    () =>
      apply([
        {
          op: "fan_in",
          position_ids: ["survey-a", "synthesis"],
          position: task("everything"),
        },
      ]),
    "INVALID_DECOMPOSITION_ACTION",
  );

  // Reordering serializes a parallel pair.
  const reordered = apply([
    { op: "reorder", position_id: "survey-a", before_position_id: "survey-b" },
  ]);
  assert.deepEqual(upstreams(reordered, "survey-b"), ["survey-a"]);
  assert.deepEqual(upstreams(reordered, "survey-a"), []);

  // Reordering an existing pair reverses it: the old edge goes, so the graph
  // stays acyclic without the caller restating anything.
  const reversed = apply([
    { op: "reorder", position_id: "synthesis", before_position_id: "survey-a" },
  ]);
  assert.deepEqual(upstreams(reversed, "survey-a"), ["synthesis"]);
  assert.deepEqual(upstreams(reversed, "synthesis"), ["survey-b"]);

  // And a decomposition that arrives with a loop in it is not a decomposition.
  expectFailure(
    () =>
      validateDecompositionPositions([
        position("first", ["second"]),
        position("second", ["first"]),
      ]),
    "INVALID_DECOMPOSITION",
  );
  expectFailure(
    () => validateDecompositionPositions([position("lonely", ["nobody"])]),
    "INVALID_DECOMPOSITION",
  );
});

test("the decomposition hash is its content, not the order it was written in", () => {
  const shuffled = [...BASELINE].reverse().map((entry) => ({
    ...entry,
    depends_on: [...entry.depends_on].reverse(),
  }));
  assert.equal(decompositionSha256(shuffled), decompositionSha256(BASELINE));
  // Every action changes at least one field a child's task_sha256 covers, so
  // a landed action always produces different children.
  const actions: DecompositionAction[][] = [
    [{ op: "retask_position", position_id: "survey-a", problem: "something else" }],
    [{ op: "reconstrain_position", position_id: "survey-a", constraints: { depth: 2 } }],
    [{ op: "recontract_edge", from: "survey-a", to: "synthesis", contract: { rows: "csv" } }],
    [{ op: "reorder", position_id: "survey-a", before_position_id: "survey-b" }],
  ];
  for (const change of actions)
    assert.notEqual(
      decompositionSha256(applyDecompositionActions(BASELINE, change)),
      decompositionSha256(BASELINE),
      JSON.stringify(change),
    );
});
