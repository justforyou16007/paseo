import { makePromotionFixture } from "./helpers/promotion-fixture.js";
import { createChildContract } from "./helpers/child-contract.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importVerifiedTesterConclusion,
  importVerifiedTesterConclusionFromFiles,
} from "../src/tools/tester-public-receipt.js";
import { cleanup, signTesterConclusion, writeJson } from "./test_workflow_runtime.js";
import {
  readExposureLedger,
  readTesterRunState,
  recordTesterStarted,
  reservePromotionTrial,
  saveTesterDefinition,
  startTesterRun,
  testerDashboardPath,
  testerRunStatePath,
} from "../src/tools/tester-state.js";
import type { TesterPublicConclusion } from "../src/tools/tester-public-receipt.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function makePublicTesterRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-public-tester-project-"));
  const fixture = makePromotionFixture({
    project_root: root,
    outer_run_id: "outer-public-bridge",
    wave_id: "wave:public-bridge",
  });
  const testerRunId = "tester-public-bridge";
  createChildContract(root, fixture.identity.outer_run_id, testerRunId, "tester");
  saveTesterDefinition(root, fixture.tester);
  reservePromotionTrial({
    project_root: root,
    task_id: fixture.freezeInput.task_id,
    promotion_trial_id: "promotion:public-bridge",
    outer_run_id: fixture.identity.outer_run_id,
    wave_id: "wave:public-bridge",
    tester_id: fixture.tester.tester_id,
    tester_version: fixture.tester.version,
    tester_definition_sha256: fixture.tester.definition_sha256,
    harness_sha256: fixture.tester.harness_sha256,
    task_setup_revision: fixture.taskSetupRevision,
    case_manifest_sha256: fixture.tester.case_manifest_sha256,
    seed_manifest_sha256: fixture.tester.seed_manifest_sha256,
    matching_baseline_artifact_sha256: fixture.baselineArtifactSha256,
    finalist_artifact_sha256: fixture.finalistArtifactSha256,
    model_assignment_sha256: fixture.modelAssignmentSha256,
    input_distribution_sha256: fixture.inputDistributionSha256,
    judge_binding: null,
    max_exposures_per_task: fixture.tester.max_exposures_per_task,
  });
  startTesterRun({
    project_root: root,
    tester_run_id: testerRunId,
    task_id: fixture.freezeInput.task_id,
    outer_run_id: fixture.identity.outer_run_id,
    outer_iteration: 1,
    wave_id: "wave:public-bridge",
    wave_kind: "module",
    generation: 1,
    promotion_trial_id: "promotion:public-bridge",
    tester: fixture.tester,
    task_setup_revision: fixture.taskSetupRevision,
    input_snapshot_sha256: HASH_A,
    harness_sha256: fixture.tester.harness_sha256,
    matching_baseline_artifact_sha256: fixture.baselineArtifactSha256,
    finalist_artifact_sha256: fixture.finalistArtifactSha256,
    model_assignment_sha256: fixture.modelAssignmentSha256,
    input_distribution_sha256: fixture.inputDistributionSha256,
    judge_binding: null,
  });
  recordTesterStarted(root, testerRunId);

  // The research-side prebuilt state retains only opaque review identity and
  // receipt hash. It does not contain the private review body.
  const running = readTesterRunState(root, testerRunId);
  writeJson(testerRunStatePath(root, testerRunId), {
    ...running,
    review_id: "review:opaque-public",
    reviewer_worker_id: "reviewer:opaque-public",
    review_receipt_sha256: HASH_B,
  });
  return { root, fixture, testerRunId };
}

function conclusionFor(
  root: string,
  testerRunId: string,
  status: "passed" | "rejected",
): TesterPublicConclusion {
  const state = readTesterRunState(root, testerRunId);
  return {
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    outer_run_id: state.outer_run_id,
    task_id: state.task_id,
    promotion_trial_id: state.promotion_trial_id,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    wave_id: state.wave_id,
    tester_definition_sha256: state.tester_definition_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    input_snapshot_sha256: state.input_snapshot_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
    private_result_sha256: HASH_A,
    review_receipt_sha256: HASH_B,
    status,
  };
}

function run(): void {
  const bridge = makePublicTesterRun();
  try {
    const conclusion = conclusionFor(bridge.root, bridge.testerRunId, "passed");
    const signed = signTesterConclusion(conclusion);
    const signedReceipt = { conclusion: signed.conclusion, signature: signed.signature };

    expectCode(
      () =>
        importVerifiedTesterConclusion({
          project_root: bridge.root,
          tester_run_id: bridge.testerRunId,
          signed_conclusion: { ...signedReceipt, signature: "invalid" },
          public_key: signed.publicKey,
        }),
      "TESTER_SIGNATURE_INVALID",
    );
    assert.equal(readTesterRunState(bridge.root, bridge.testerRunId).status, "running");

    const imported = importVerifiedTesterConclusion({
      project_root: bridge.root,
      tester_run_id: bridge.testerRunId,
      signed_conclusion: signedReceipt,
      public_key: signed.publicKey,
    });
    assert.equal(imported.status, "passed");
    assert.equal(imported.gate_consumed, true);
    assert.equal(imported.gate_status, "passed");
    assert.equal(imported.private_result_sha256, HASH_A);
    assert.equal(imported.review_receipt_sha256, HASH_B);
    const exposure = readExposureLedger(
      bridge.root,
      bridge.fixture.freezeInput.task_id,
      bridge.fixture.tester.max_exposures_per_task,
    ).exposures.find((item) => item.promotion_trial_id === "promotion:public-bridge");
    assert.equal(exposure?.private_result_sha256, HASH_A);
    assert.equal(exposure?.status, "settled");
    const privateResultReference = JSON.parse(
      fs.readFileSync(
        path.join(bridge.root, ".aris", "runs", bridge.testerRunId, "private-result.ref.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(privateResultReference, {
      schema_version: 1,
      private_result_id: `private-result:sha256:${HASH_A}`,
      private_result_sha256: HASH_A,
    });
    assert.equal(
      fs.existsSync(
        path.join(bridge.root, ".aris", "runs", bridge.testerRunId, "private-result.json"),
      ),
      false,
    );
    const dashboard = JSON.parse(
      fs.readFileSync(testerDashboardPath(bridge.root, bridge.testerRunId), "utf8"),
    ) as {
      status: string;
      hashes: Record<string, string>;
    };
    assert.equal(dashboard.status, "passed");
    assert.equal(dashboard.hashes.private_result_sha256, HASH_A);
    assert.equal(dashboard.hashes.review_receipt_sha256, HASH_B);

    const replayed = importVerifiedTesterConclusion({
      project_root: bridge.root,
      tester_run_id: bridge.testerRunId,
      signed_conclusion: signedReceipt,
      public_key: signed.publicKey,
    });
    assert.equal(replayed.status, "passed");
    assert.equal(replayed.private_result_sha256, HASH_A);

    const conflicting = signTesterConclusion(
      conclusionFor(bridge.root, bridge.testerRunId, "rejected"),
    );
    expectCode(
      () =>
        importVerifiedTesterConclusion({
          project_root: bridge.root,
          tester_run_id: bridge.testerRunId,
          signed_conclusion: {
            conclusion: conflicting.conclusion,
            signature: conflicting.signature,
          },
          public_key: conflicting.publicKey,
        }),
      "TESTER_GATE_CONFLICT",
    );
    assert.equal(readTesterRunState(bridge.root, bridge.testerRunId).status, "passed");

    const untrustedKeyPath = path.join(bridge.root, "public-key.pem");
    writeJson(untrustedKeyPath, { key: "not-a-root-owned-key" });
    expectCode(
      () =>
        importVerifiedTesterConclusionFromFiles({
          project_root: bridge.root,
          tester_run_id: bridge.testerRunId,
          receipt_path: path.join(bridge.root, "receipt.json"),
          public_key_path: untrustedKeyPath,
        }),
      "TESTER_PATH_UNPROTECTED",
    );
  } finally {
    cleanup(bridge.root);
  }
}

run();
console.log(
  "test_tester_public_bridge: verified terminal import, replay, conflict and private-data boundary passed",
);
