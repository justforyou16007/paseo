import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beginOuterCycle, advanceOuterPhase } from "../src/tools/workflow-runtime.js";
import { registerScorerWaveForOuter } from "../src/tools/scorer-wave-runtime.js";
import { scorerWaveRegistrationPath } from "../src/tools/scorer-state.js";
import {
  cleanup,
  evidence,
  makeFixture,
  recover,
  startFixture,
  tempDir,
  writeJson,
} from "./test_workflow_runtime.js";

const root = tempDir("aris-scorer-wave-runtime-project-");
const executionRoot = tempDir("aris-scorer-wave-runtime-execution-");
try {
  const fixture = makeFixture(root, executionRoot, "outer-fixed");
  startFixture(fixture);
  recover(fixture, "init");
  beginOuterCycle({
    ...fixture.identity,
    wave_id: "wave:scorer",
    wave_kind: "scorer",
    evidence_paths: [evidence(root, "scorer-cycle")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "diagnosis",
    to_phase: "workset",
    evidence_paths: [evidence(root, "scorer-diagnosis")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "workset",
    to_phase: "wave",
    evidence_paths: [evidence(root, "scorer-workset")],
  });

  const workflowDirectory = path.join(root, ".aris", "workflows", "workflow:fixed");
  writeJson(path.join(workflowDirectory, "definition.json"), {
    schema_version: 1,
    workflow_id: "workflow:fixed",
    validation_policy: { scorer_id: "scorer:fixed" },
    scorers: [{ id: "scorer:fixed" }],
    scorer_wave_policy: {
      exclusive: true,
      max_candidates: 1,
      experiment_parallelism: 1,
      execution_order: "baseline_then_candidate",
      blocks_other_wave_kinds: true,
    },
  });
  writeJson(path.join(workflowDirectory, "active-scorer.json"), {
    schema_version: 1,
    workflow_id: "workflow:fixed",
    scorer_id: "scorer:fixed",
    revision: "scorer:parent",
    scorer_run_id: "active-parent",
  });

  const start = {
    project_root: root,
    workflow_id: "workflow:fixed",
    scorer_run_id: "scorer-run-fixed",
    scorer_id: "scorer:fixed",
    outer_run_id: "outer-fixed",
    outer_iteration: 1,
    wave_id: "wave:scorer",
    generation: 1,
    parent_revision: "scorer:parent",
    candidate_revision: "scorer:candidate",
    delta_id: "delta:fixed",
  };
  const registered = registerScorerWaveForOuter({
    ...fixture.identity,
    outer_iteration: 1,
    generation: 1,
    start,
  });
  assert.deepEqual(registered, start);
  assert.equal(fs.existsSync(scorerWaveRegistrationPath(root, "outer-fixed", 1)), true);
  assert.throws(
    () =>
      registerScorerWaveForOuter({
        ...fixture.identity,
        outer_iteration: 1,
        generation: 1,
        start: { ...start, workflow_id: "workflow:other" },
      }),
    (error: unknown) => (error as { code?: string }).code === "IDENTITY_MISMATCH",
  );
  console.log("test_scorer_wave_runtime: ok");
} finally {
  cleanup(root);
  cleanup(executionRoot);
}
