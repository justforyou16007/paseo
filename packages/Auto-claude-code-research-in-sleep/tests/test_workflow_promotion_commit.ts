import { enterPromotion } from "./helpers/promotion-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanup,
  evidence,
  feedbackForTester,
  makeFixture,
  prepareTester,
  publicTesterConclusion,
  recover,
  signTesterFeedback,
  signTesterConclusion,
  writeJson,
  type Fixture,
} from "./test_workflow_runtime.js";
import {
  commitPromotionForTest,
  preparePromotionCommitForTest,
  recoverPromotionCommitForTest,
} from "../src/tools/workflow-promotion-commit.js";
import {
  markOuterChildTerminal,
  readOuterRunStatus,
  recordPromotionGateResult,
  reconcileOuterChildren,
  registerOuterChild,
  reserveOuterBudget,
} from "../src/tools/workflow-runtime.js";
import { consumePromotionGate } from "../src/tools/promotion-gate.js";
import { readExposureLedger } from "../src/tools/tester-state.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function reachPromotion(
  fixture: Fixture,
  finalistScores: readonly [number, number, number, number],
): ReturnType<typeof prepareTester> & { promotionResult: "passed" | "rejected" } {
  enterPromotion(fixture);

  // prepareTester builds the finalist producer run it needs.
  const tester = prepareTester(fixture, finalistScores);
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
  reconcileOuterChildren(fixture.identity);
  markOuterChildTerminal({ ...fixture.identity, child_run_id: tester.testerRunId });
  recordPromotionGateResult({
    ...fixture.identity,
    tester_run_id: tester.testerRunId,
    evidence_paths: [evidence(fixture.root, "promotion")],
  });
  assert.equal(gate.status, finalistScores[0] > 1.2 ? "passed" : "rejected");
  recover(fixture, "promotion");
  return { ...tester, promotionResult: gate.status };
}

function commitInput(fixture: Fixture, testerRunId: string) {
  const signed = signTesterConclusion(publicTesterConclusion(fixture, testerRunId));
  const receipt = { conclusion: signed.conclusion, signature: signed.signature };
  return {
    signed,
    receipt,
  };
}

function prepareCommitFixture(finalistScores: readonly [number, number, number, number]): {
  fixture: Fixture;
  testerRunId: string;
  result: "passed" | "rejected";
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-promotion-project-"));
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-promotion-execution-"));
  const fixture = makeFixture(root, executionRoot, "outer-fixed");
  const prepared = reachPromotion(fixture, finalistScores);
  return { fixture, testerRunId: prepared.testerRunId, result: prepared.promotionResult };
}

function run(): void {
  const crash = prepareCommitFixture([1.4, 1.4, 1.6, 1.6]);
  try {
    const input = commitInput(crash.fixture, crash.testerRunId);
    const feedback = feedbackForTester(crash.fixture, crash.testerRunId, crash.result);
    const signedFeedback = signTesterFeedback(
      crash.fixture,
      crash.testerRunId,
      crash.result,
      feedback,
    );
    const prepared = preparePromotionCommitForTest({
      ...crash.fixture.identity,
      registry: crash.fixture.registry,
      signed_tester_public_receipt: input.receipt,
      tester_public_key: input.signed.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
      evidence_paths: [evidence(crash.fixture.root, "commit-evidence")],
    });
    assert.equal(prepared.status, "prepared");
    assert.equal(
      readOuterRunStatus(crash.fixture.identity).runtime?.active_cycle?.promotion_commit_ref,
      null,
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(
            crash.fixture.root,
            ".aris",
            "workflows",
            "workflow:fixed",
            "active-incumbent.json",
          ),
          "utf8",
        ),
      ).candidate_id,
      "candidate:incumbent",
    );

    const recovered = recoverPromotionCommitForTest({
      ...crash.fixture.identity,
      registry: crash.fixture.registry,
      signed_tester_public_receipt: input.receipt,
      tester_public_key: input.signed.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
    });
    assert.equal(recovered.status, "committed");
    assert.equal(recovered.replaced, true);
    assert.equal(recovered.active_incumbent.candidate_id, "candidate:111");
    assert.equal(recovered.intent.status, "committed");
    assert.equal(
      readOuterRunStatus(crash.fixture.identity).runtime?.budgets.every(
        (b) => b.status !== "reserved",
      ),
      true,
    );
    const ledger = readExposureLedger(
      crash.fixture.root,
      crash.fixture.freezeInput.task_id,
      crash.fixture.tester.max_exposures_per_task,
    );
    const exposure = ledger.exposures.find((item) => item.promotion_trial_id === "promotion:fixed");
    assert.equal(exposure?.status, "settled");
    const replay = recoverPromotionCommitForTest({
      ...crash.fixture.identity,
      registry: crash.fixture.registry,
      signed_tester_public_receipt: input.receipt,
      tester_public_key: input.signed.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
    });
    assert.equal(replay.replaced, false);
    assert.equal(replay.intent.intent_sha256, recovered.intent.intent_sha256);
    assert.equal(replay.feedback_event_id, recovered.feedback_event_id);
  } finally {
    cleanup(crash.fixture.root);
    cleanup(crash.fixture.executionRoot);
  }

  const conflict = prepareCommitFixture([1.4, 1.4, 1.6, 1.6]);
  try {
    const input = commitInput(conflict.fixture, conflict.testerRunId);
    const feedback = feedbackForTester(conflict.fixture, conflict.testerRunId, conflict.result);
    const signedFeedback = signTesterFeedback(
      conflict.fixture,
      conflict.testerRunId,
      conflict.result,
      feedback,
    );
    const evidencePath = evidence(conflict.fixture.root, "commit-evidence");
    preparePromotionCommitForTest({
      ...conflict.fixture.identity,
      registry: conflict.fixture.registry,
      signed_tester_public_receipt: input.receipt,
      tester_public_key: input.signed.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
      evidence_paths: [evidencePath],
    });
    writeJson(
      path.join(
        conflict.fixture.root,
        ".aris",
        "workflows",
        "workflow:fixed",
        "active-incumbent.json",
      ),
      {
        schema_version: 1,
        candidate_id: "candidate:other",
        generation: 1,
        role_artifacts: [
          { artifact_id: "artifact:incumbent", generation: 1, role_id: "main-model" },
        ],
      },
    );
    expectCode(
      () =>
        recoverPromotionCommitForTest({
          ...conflict.fixture.identity,
          registry: conflict.fixture.registry,
          signed_tester_public_receipt: input.receipt,
          tester_public_key: input.signed.publicKey,
          signed_tester_feedback: {
            feedback: signedFeedback.feedback,
            signature: signedFeedback.signature,
          },
          tester_feedback_public_key: signedFeedback.publicKey,
        }),
      "PROMOTION_PARENT_CONFLICT",
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(
            conflict.fixture.root,
            ".aris",
            "workflows",
            "workflow:fixed",
            "active-incumbent.json",
          ),
          "utf8",
        ),
      ).candidate_id,
      "candidate:other",
    );
  } finally {
    cleanup(conflict.fixture.root);
    cleanup(conflict.fixture.executionRoot);
  }

  const rejected = prepareCommitFixture([1.05, 1.05, 1.15, 1.15]);
  try {
    const input = commitInput(rejected.fixture, rejected.testerRunId);
    const feedback = feedbackForTester(rejected.fixture, rejected.testerRunId, rejected.result);
    const signedFeedback = signTesterFeedback(
      rejected.fixture,
      rejected.testerRunId,
      rejected.result,
      feedback,
    );
    const result = commitPromotionForTest({
      ...rejected.fixture.identity,
      registry: rejected.fixture.registry,
      signed_tester_public_receipt: input.receipt,
      tester_public_key: input.signed.publicKey,
      signed_tester_feedback: {
        feedback: signedFeedback.feedback,
        signature: signedFeedback.signature,
      },
      tester_feedback_public_key: signedFeedback.publicKey,
      evidence_paths: [evidence(rejected.fixture.root, "commit-evidence")],
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.replaced, false);
    assert.equal(result.active_incumbent.candidate_id, "candidate:incumbent");
  } finally {
    cleanup(rejected.fixture.root);
    cleanup(rejected.fixture.executionRoot);
  }
}

run();
console.log("workflow promotion commit: 3 passed, 0 failed");
