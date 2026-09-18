import { resolveRunWikiScope, runWikiRoot } from "../src/tools/wiki-scope.js";
import { readWikiEvents } from "../src/tools/wiki-event-store.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTesterFeedback } from "../src/tools/tester-feedback.js";
import {
  buildTesterFeedbackSignal,
  publishTesterFeedbackSignals,
} from "../src/tools/tester-feedback-signal.js";
import { initializeWikiSchema } from "../src/tools/wiki-event-store.js";
import { queryWiki } from "../src/tools/wiki-projector.js";
import { commitPromotionForTest } from "../src/tools/workflow-promotion-commit.js";
import {
  advanceOuterPhase,
  beginOuterCycle,
  markOuterChildTerminal,
  recordPromotionGateResult,
  recordValidationGateResult,
  reconcileOuterChildren,
  registerOuterChild,
  reserveOuterBudget,
  settleOuterBudget,
} from "../src/tools/workflow-runtime.js";
import { consumePromotionGate } from "../src/tools/promotion-gate.js";
import {
  cleanup,
  completeModule,
  evidence,
  feedbackForTester,
  makeFixture,
  makeModule,
  prepareTester,
  publicTesterConclusion,
  recover,
  signTesterConclusion,
  signTesterFeedback,
  startFixture,
  validationInputs,
} from "./test_workflow_runtime.js";

const HASH = "a".repeat(64);

const feedback = buildTesterFeedback({
  schema_version: 1,
  task_id: "task:fixed",
  task_setup_revision: "setup:fixed",
  input_snapshot_sha256: HASH,
  promotion_trial_id: "promotion:1",
  tester_version: "tester:v1",
  conclusion: "not_improved",
  directions: ["long_horizon_stability"],
  advice: ["increase_long_horizon_consistency"],
  confidence: "medium",
  metrics: { tester_score: 0.9 },
});

const signal = buildTesterFeedbackSignal(
  {
    actor: "outer_committer",
    project_root: "/tmp/project",
    wiki_root: "/tmp/wiki",
    execution_root: "/tmp/execution",
    outer_run_id: "outer-1",
    outer_iteration: 2,
    workflow_id: "workflow:fixed",
    workflow_revision: "flow:r2",
    tester_run_id: "tester-run-1",
    targets: [],
  },
  feedback,
);

assert.equal(signal.source, "tester_feedback");
assert.equal(signal.kind, "failure");
assert.equal(signal.producer.module_id, "workflow:fixed");
assert.equal(signal.producer.run_id, "outer-1");
assert.deepEqual(signal.applies_to.contract_versions, []);
assert.equal(signal.evidence_refs[0], feedback.feedback_event_id);
assert.equal(signal.summary?.includes("not_improved"), true);
assert.equal(signal.recommendation?.includes("increase_long_horizon_consistency"), true);
const serialized = JSON.stringify(signal);
for (const privateField of ["case_id", "prompt", "score", "private_uri", "raw_result"]) {
  assert.equal(new RegExp(`\\"${privateField}\\"\\s*:`).test(serialized), false, privateField);
}

const same = buildTesterFeedbackSignal(
  {
    actor: "outer_committer",
    project_root: "/tmp/project",
    wiki_root: "/tmp/wiki",
    execution_root: "/tmp/execution",
    outer_run_id: "outer-1",
    outer_iteration: 2,
    workflow_id: "workflow:fixed",
    workflow_revision: "flow:r2",
    tester_run_id: "tester-run-1",
    targets: [],
  },
  feedback,
);
assert.equal(same.signal_id, signal.signal_id);

function runClosedPromotion(fixture: ReturnType<typeof makeFixture>): string {
  startFixture(fixture);
  recover(fixture, "init");
  beginOuterCycle({
    ...fixture.identity,
    wave_id: "wave:fixed",
    wave_kind: "module",
    evidence_paths: [evidence(fixture.root, "cycle-begin")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "diagnosis",
    to_phase: "workset",
    evidence_paths: [evidence(fixture.root, "diagnosis")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "workset",
    to_phase: "wave",
    evidence_paths: [evidence(fixture.root, "workset")],
  });
  for (const [moduleRunId, moduleId] of [
    ["module-run-a", "module:a"],
    ["module-run-b", "module:b"],
    ["module-run-c", "module:c"],
  ] as const) {
    makeModule(fixture.root, moduleRunId, moduleId);
    registerOuterChild({
      ...fixture.identity,
      child_run_id: moduleRunId,
      kind: "module",
      module_id: moduleId,
    });
  }
  reserveOuterBudget({
    ...fixture.identity,
    reservation_id: "budget:module",
    category: "module",
    amount: 1,
    unit: "gpu_hours",
    child_run_id: "module-run-a",
  });
  completeModule(fixture.root, "module-run-a", "module:a");
  completeModule(fixture.root, "module-run-b", "module:b");
  completeModule(fixture.root, "module-run-c", "module:c");
  reconcileOuterChildren(fixture.identity);
  settleOuterBudget({
    ...fixture.identity,
    reservation_id: "budget:module",
    evidence_paths: [evidence(fixture.root, "module-budget")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "wave",
    to_phase: "validation",
    evidence_paths: [evidence(fixture.root, "wave")],
  });
  const validation = validationInputs();
  recordValidationGateResult({
    ...fixture.identity,
    evidence_paths: [evidence(fixture.root, "validation")],
    gate_input: {
      plan: validation.plan,
      results: validation.results,
      plan_id: "plan:fixed-3",
      primary_direction: "higher_better",
      improvement: { policy: "absolute", minimum_gain: 0.2 },
      binding: validation.binding,
      review: validation.review,
    },
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "validation",
    to_phase: "promotion",
    evidence_paths: [evidence(fixture.root, "validation-complete")],
  });
  const tester = prepareTester(fixture, [1.4, 1.4, 1.6, 1.6]);
  registerOuterChild({
    ...fixture.identity,
    child_run_id: tester.testerRunId,
    kind: "tester",
  });
  reserveOuterBudget({
    ...fixture.identity,
    reservation_id: "budget:promotion",
    category: "promotion",
    amount: 1,
    unit: "gpu_hours",
    child_run_id: tester.testerRunId,
  });
  const gate = consumePromotionGate({
    project_root: fixture.root,
    tester_run_id: tester.testerRunId,
    definition: fixture.tester,
    baseline: tester.baseline,
    finalist: tester.finalist,
    workflow_constraints_passed: true,
  });
  assert.equal(gate.status, "passed");
  reconcileOuterChildren(fixture.identity);
  markOuterChildTerminal({ ...fixture.identity, child_run_id: tester.testerRunId });
  recordPromotionGateResult({
    ...fixture.identity,
    tester_run_id: tester.testerRunId,
    evidence_paths: [evidence(fixture.root, "promotion")],
  });
  recover(fixture, "promotion");
  const conclusion = signTesterConclusion(publicTesterConclusion(fixture, tester.testerRunId));
  const feedback = feedbackForTester(fixture, tester.testerRunId, "passed");
  const signedFeedback = signTesterFeedback(fixture, tester.testerRunId, "passed", feedback);
  commitPromotionForTest({
    ...fixture.identity,
    registry: fixture.registry,
    signed_tester_public_receipt: {
      conclusion: conclusion.conclusion,
      signature: conclusion.signature,
    },
    tester_public_key: conclusion.publicKey,
    signed_tester_feedback: {
      feedback: signedFeedback.feedback,
      signature: signedFeedback.signature,
    },
    tester_feedback_public_key: signedFeedback.publicKey,
    evidence_paths: [evidence(fixture.root, "promotion-commit")],
  });
  return tester.testerRunId;
}

const integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-feedback-project-"));
const integrationExecution = fs.mkdtempSync(path.join(os.tmpdir(), "aris-feedback-execution-"));
const integrationWiki = fs.mkdtempSync(path.join(os.tmpdir(), "aris-feedback-wiki-"));
try {
  const fixture = makeFixture(integrationRoot, integrationExecution, "outer-fixed");
  const testerRunId = runClosedPromotion(fixture);
  const publishedFeedback = feedbackForTester(fixture, testerRunId, "passed");
  initializeWikiSchema(integrationWiki);
  const input = {
    actor: "outer_committer" as const,
    project_root: integrationRoot,
    wiki_root: integrationWiki,
    execution_root: integrationExecution,
    outer_run_id: fixture.identity.outer_run_id,
    outer_iteration: 1,
    workflow_id: "workflow:fixed",
    workflow_revision: "flow:r1",
    tester_run_id: testerRunId,
    targets: [
      { module_id: "modulea", module_version: "modulea:v1", contract_versions: ["model@1"] },
      { module_id: "moduleb", module_version: "moduleb:v1", contract_versions: ["model@2"] },
    ],
  };
  const published = publishTesterFeedbackSignals(input);
  const replayed = publishTesterFeedbackSignals({
    ...input,
    targets: [...input.targets].reverse(),
  });
  assert.equal(published.signals[0]?.status, "appended");
  assert.equal(replayed.signals[0]?.status, "skipped");
  assert.equal(published.signals.length, 1);
  assert.equal(
    readWikiEvents(runWikiRoot(integrationRoot, fixture.identity.outer_run_id)).length,
    1,
  );
  assert.equal(readWikiEvents(integrationWiki).length, 0);
  const scoped = queryWiki(runWikiRoot(integrationRoot, fixture.identity.outer_run_id), {
    purpose: "next module diagnosis",
    requester: "modulea",
    scope: resolveRunWikiScope(integrationRoot, fixture.identity.outer_run_id),
    module_id: "workflow:fixed",
    module_version: "flow:r1",
    workflow_id: "workflow:fixed",
    workflow_revision: "flow:r1",
    input_snapshot_id: publishedFeedback.input_snapshot_sha256,
    contract_versions: [],
  });
  assert.equal(scoped.signals.length, 1);
  assert.equal(scoped.signals[0]?.source, "tester_feedback");
  const other = queryWiki(integrationWiki, {
    purpose: "unrelated module diagnosis",
    requester: "moduleb",
    scope: "modules/moduleb",
    module_id: "moduleb",
    module_version: "moduleb:v1",
    workflow_id: "workflow:fixed",
    workflow_revision: "flow:r1",
    input_snapshot_id: publishedFeedback.input_snapshot_sha256,
    contract_versions: ["model@1"],
  });
  assert.equal(other.signals.length, 0);
} finally {
  cleanup(integrationRoot);
  cleanup(integrationExecution);
  cleanup(integrationWiki);
}

console.log("test_tester_feedback_signal: ok");
