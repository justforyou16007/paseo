import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDashboardMetric } from "../src/tools/metric-gate.js";
import {
  exportResultPackage,
  planResultExport,
  rankCandidates,
  type ResultExport,
  type ResultExportInput,
} from "../src/tools/result-export.js";
import { saveResultReview } from "../src/tools/result-review.js";
import { addExperiment } from "../src/tools/research-wiki.js";
import { buildTesterFeedback } from "../src/tools/tester-feedback.js";
import type { TesterPublicFeedbackEnvelope } from "../src/tools/tester-public-receipt.js";
import { canonicalJsonBytes } from "../src/tools/canonical-json.js";
import crypto from "node:crypto";
import { readResultPackage } from "../src/tools/result-package.js";
import { createRootRun, runOwnedPath } from "../src/tools/run-contract.js";
import { appendWikiEvent, initializeWikiSchema } from "../src/tools/wiki-event-store.js";
import { projectWiki, queryWikiFromEvents, readWikiModel } from "../src/tools/wiki-projector.js";
import { readWikiEvents } from "../src/tools/wiki-event-store.js";
import { runWikiRoot } from "../src/tools/wiki-scope.js";
import {
  buildTesterDefinition,
  type TesterDefinition,
  type TesterPrimaryMetric,
} from "../src/tools/tester-state.js";

const RUN_ID = "run-export";
const SCOPE = `runs/${RUN_ID}`;

const CONTEXT = {};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-result-export-test-"));
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

interface ExperimentInput {
  id: string;
  iteration: number;
  gate_metric?: number;
  tester_metrics?: Record<string, number>;
  tester_definition_sha256?: string;
  tester_verdict?: {
    conclusion: string;
    confidence: string;
    directions: string[];
    advice: string[];
  };
  idea_id?: string;
}

function appendExperiment(wikiRoot: string, input: ExperimentInput): void {
  const result = appendWikiEvent(wikiRoot, {
    producer_kind: "result-export-test",
    scope: SCOPE,
    subject_id: `exp:${input.id}`,
    evidence_bundle_id: `bundle:${input.id}`,
    payload: {
      context: CONTEXT,
      operations: [
        {
          op: "upsert_page",
          kind: "experiment",
          id: input.id,
          data: {
            title: input.id,
            idea_id: input.idea_id ?? "",
            verdict: "yes",
            confidence: "high",
            date: "2026-01-01",
            hardware: "",
            duration: "",
            provenance: "",
            metrics: "see comparable metrics",
            reasoning: "bounded test",
            tags: [],
            iteration: input.iteration,
            ...(input.gate_metric === undefined ? {} : { gate_metric: input.gate_metric }),
            ...(input.tester_metrics === undefined
              ? {}
              : {
                  tester_metrics: input.tester_metrics,
                  tester_definition_sha256:
                    input.tester_definition_sha256 ?? activeDefinitionSha,
                }),
            ...(input.tester_verdict === undefined
              ? {}
              : {
                  tester_conclusion: input.tester_verdict.conclusion,
                  tester_confidence: input.tester_verdict.confidence,
                  tester_directions: input.tester_verdict.directions,
                  tester_advice: input.tester_verdict.advice,
                }),
          },
        },
      ],
    },
  });
  assert.equal(result.status, "appended");
}

function writeDashboard(
  root: string,
  history: Array<{ iter: number; value: number }>,
  direction: "higher_better" | "lower_better" = "higher_better",
): void {
  const dashboardPath = runOwnedPath(root, RUN_ID, "dashboard.json");
  fs.mkdirSync(path.dirname(dashboardPath), { recursive: true });
  fs.writeFileSync(
    dashboardPath,
    JSON.stringify({
      iteration: history.length,
      metric: {
        name: "accuracy",
        target: 0.95,
        direction,
        tolerance: 0,
        baseline: 0.1,
        current: history[history.length - 1]?.value ?? 0,
        history,
      },
      config: { patience: 2 },
    }),
  );
}

function primary(
  name: string,
  direction: "higher_better" | "lower_better" = "higher_better",
): TesterPrimaryMetric {
  return { name, direction, improvement: { policy: "absolute", minimum_gain: 0 } };
}

/** A sealed definition whose only interesting part is the metrics it declares. */
function testerDefinition(primaries: TesterPrimaryMetric[]): TesterDefinition {
  return buildTesterDefinition({
    schema_version: 1,
    tester_id: "tester:fixed",
    version: "tester:v1",
    immutable: true,
    case_manifest_id: "cases:v1",
    case_manifest_sha256: "a".repeat(64),
    seed_manifest_sha256: "b".repeat(64),
    harness_sha256: "c".repeat(64),
    research_feedback: "fuzzy_advice_only",
    max_exposures_per_task: 4,
    comparison: "paired_matching_baseline_vs_finalist",
    gate: {
      primaries,
      paired_delta: "finalist_minus_matching_baseline",
      statistics: { method: "paired_student_t", confidence_level: 0.95, min_repeats: 2 },
      case_aggregation: "mean_of_complete_case_set",
      repeat_aggregation: "lower_confidence_bound",
      tie_policy: "reject_finalist",
      missing_result_policy: "fail_closed",
      constraints: [],
      workflow_constraints: "must_also_pass",
    },
    scoring: [{ kind: "deterministic_rules", definition_version: "rules:v1", judge_binding: null }],
  });
}

function writeTesterDefinition(root: string, definition: TesterDefinition): string {
  const definitionPath = path.join(root, "definition.json");
  fs.writeFileSync(definitionPath, JSON.stringify(definition));
  return definitionPath;
}

/** The definition the experiments in the test being run were judged under. */
let activeDefinitionSha = "";

function setup(
  root: string,
  primaries: TesterPrimaryMetric[] = [primary("score")],
): { wikiRoot: string; definition: TesterDefinition; definitionPath: string } {
  createRootRun({
    project_root: root,
    run_id: RUN_ID,
    input_snapshot_sha256: "e".repeat(64),
    code_baseline_sha256: "f".repeat(64),
    policy_revision: "policy:test",
  });
  const wikiRoot = runWikiRoot(root, RUN_ID);
  initializeWikiSchema(wikiRoot);
  const definition = testerDefinition(primaries);
  activeDefinitionSha = definition.definition_sha256;
  return { wikiRoot, definition, definitionPath: writeTesterDefinition(root, definition) };
}

const REVIEWER = "reviewer-1";
const REVIEW = { review_id: "review:1" };

/**
 * Export the way a run actually has to: plan the package, let a reviewer sign
 * off on that exact digest, then publish. Splitting it is not ceremony -- the
 * digest is the only thing tying the verdict to the bytes, and it cannot exist
 * before the package is built or be trusted after the package is written.
 */
function exportWithReview(input: Omit<ResultExportInput, "review">): ResultExport {
  const plan = planResultExport(input);
  saveResultReview(input.project_root, {
    schema_version: 1,
    review_id: REVIEW.review_id,
    run_id: input.run_id,
    reviewer_worker_id: REVIEWER,
    package_sha256: plan.candidate.package_sha256,
    verdict: "approved",
    evidence_refs: ["experiment:reviewed"],
    reason_codes: [],
  });
  return exportResultPackage({ ...input, review: REVIEW });
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

test("the best tester iteration wins even when a later one leads on the gate", () => {
  const root = tmpDir();
  try {
    const { wikiRoot, definitionPath } = setup(root);
    appendExperiment(wikiRoot, {
      id: "exp-1",
      iteration: 1,
      gate_metric: 0.4,
      tester_metrics: { score: 0.9 },
      idea_id: "idea:winner",
    });
    appendExperiment(wikiRoot, {
      id: "exp-2",
      iteration: 2,
      gate_metric: 0.8,
      tester_metrics: { score: 0.5 },
    });
    writeDashboard(root, [
      { iter: 1, value: 0.4 },
      { iter: 2, value: 0.8 },
    ]);
    const exported = exportWithReview({
      project_root: root,
      run_id: RUN_ID,
      tester_definition_path: definitionPath,
    });
    assert.equal(exported.winner.page_id, "exp-1");
    assert.deepEqual(
      exported.ranked.map((candidate) => candidate.iteration),
      [1, 2],
    );
    assert.equal(exported.result_package.best_idea_ref, "idea:winner");
    assert.deepEqual(exported.result_package.evidence_refs, ["experiment:exp-1"]);
    assert.deepEqual(exported.result_package.local_metrics, {
      "primary.score": 0.9,
      metric_gate: 0.4,
      winning_iteration: 1,
    });
    // The package landed through saveResultPackage, so it is readable back and
    // carries the reviewer that accepted it.
    assert.equal(
      readResultPackage(root, RUN_ID).package_sha256,
      exported.result_package.package_sha256,
    );
  } finally {
    cleanup(root);
  }
});

test("the gate value only breaks a tie the tester left open", () => {
  const root = tmpDir();
  try {
    const { wikiRoot, definitionPath } = setup(root, [
      primary("accuracy"),
      primary("latency", "lower_better"),
    ]);
    // Neither iteration dominates: each leads on one metric.
    appendExperiment(wikiRoot, {
      id: "exp-1",
      iteration: 1,
      gate_metric: 0.4,
      tester_metrics: { accuracy: 0.9, latency: 20 },
    });
    appendExperiment(wikiRoot, {
      id: "exp-2",
      iteration: 2,
      gate_metric: 0.8,
      tester_metrics: { accuracy: 0.8, latency: 10 },
    });
    writeDashboard(root, [
      { iter: 1, value: 0.4 },
      { iter: 2, value: 0.8 },
    ]);
    const exported = exportWithReview({
      project_root: root,
      run_id: RUN_ID,
      tester_definition_path: definitionPath,
    });
    assert.equal(exported.winner.page_id, "exp-2");
  } finally {
    cleanup(root);
  }
});

test("an iteration the tester never judged is not in the running", () => {
  const root = tmpDir();
  try {
    const { wikiRoot, definitionPath } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.9 });
    appendExperiment(wikiRoot, {
      id: "exp-2",
      iteration: 2,
      gate_metric: 0.2,
      tester_metrics: { score: 0.5 },
    });
    writeDashboard(root, [
      { iter: 1, value: 0.9 },
      { iter: 2, value: 0.2 },
    ]);
    const exported = exportWithReview({
      project_root: root,
      run_id: RUN_ID,
      tester_definition_path: definitionPath,
    });
    assert.equal(exported.winner.page_id, "exp-2");
    assert.deepEqual(
      exported.ranked.map((candidate) => candidate.page_id),
      ["exp-2"],
    );
  } finally {
    cleanup(root);
  }
});

test("with no tester evidence at all the gate decides, then the later iteration", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    appendExperiment(wikiRoot, { id: "exp-2", iteration: 2, gate_metric: 0.5 });
    appendExperiment(wikiRoot, { id: "exp-3", iteration: 3, gate_metric: 0.1 });
    writeDashboard(root, [
      { iter: 1, value: 0.5 },
      { iter: 2, value: 0.5 },
      { iter: 3, value: 0.1 },
    ]);
    const exported = exportWithReview({
      project_root: root,
      run_id: RUN_ID,
    });
    assert.equal(exported.winner.page_id, "exp-2");
  } finally {
    cleanup(root);
  }
});

test("a lower_better dashboard flips which gate reading wins", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    appendExperiment(wikiRoot, { id: "exp-2", iteration: 2, gate_metric: 0.9 });
    writeDashboard(
      root,
      [
        { iter: 1, value: 0.5 },
        { iter: 2, value: 0.9 },
      ],
      "lower_better",
    );
    const exported = exportWithReview({
      project_root: root,
      run_id: RUN_ID,
    });
    assert.equal(exported.winner.page_id, "exp-1");
  } finally {
    cleanup(root);
  }
});

test("a wiki gate value that contradicts the dashboard stops the export", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.4 });
    writeDashboard(root, [{ iter: 1, value: 0.7 }]);
    assert.throws(
      () => exportWithReview({ project_root: root, run_id: RUN_ID }),
      /GATE_METRIC_MISMATCH/,
    );
  } finally {
    cleanup(root);
  }
});

test("tester metrics without the frozen definition cannot be ranked", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, tester_metrics: { score: 0.5 } });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    assert.throws(
      () => exportWithReview({ project_root: root, run_id: RUN_ID }),
      /TESTER_DEFINITION_REQUIRED/,
    );
  } finally {
    cleanup(root);
  }
});

test("metrics recorded under a different tester definition are refused", () => {
  const root = tmpDir();
  try {
    const { wikiRoot, definitionPath } = setup(root);
    appendExperiment(wikiRoot, {
      id: "exp-1",
      iteration: 1,
      tester_metrics: { score: 0.5 },
      tester_definition_sha256: "9".repeat(64),
    });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    assert.throws(
      () =>
        exportWithReview({
          project_root: root,
          run_id: RUN_ID,
          tester_definition_path: definitionPath,
        }),
      /TESTER_DEFINITION_MISMATCH/,
    );
  } finally {
    cleanup(root);
  }
});

test("a recorded metric set that is not the declared one is refused", () => {
  const root = tmpDir();
  try {
    const { wikiRoot, definitionPath } = setup(root, [
      primary("score"),
      primary("latency", "lower_better"),
    ]);
    // Judged under the same definition, but only one of the two declared
    // metrics made it onto the page.
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, tester_metrics: { score: 0.5 } });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    assert.throws(
      () =>
        exportWithReview({
          project_root: root,
          run_id: RUN_ID,
          tester_definition_path: definitionPath,
        }),
      /TESTER_METRIC_SET_MISMATCH/,
    );
  } finally {
    cleanup(root);
  }
});

test("a wiki with no iteration-bearing experiment has nothing to export", () => {
  const root = tmpDir();
  try {
    setup(root);
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    assert.throws(
      () => exportWithReview({ project_root: root, run_id: RUN_ID }),
      /NO_EXPORTABLE_EXPERIMENT/,
    );
  } finally {
    cleanup(root);
  }
});

test("a package with no stored acceptance cannot be published", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    // Naming a review is not having one. Before this check existed, the two
    // strings a caller passed here went straight onto the write receipt and
    // nothing ever looked for the document they named.
    assert.throws(
      () => exportResultPackage({ project_root: root, run_id: RUN_ID, review: REVIEW }),
      /RESULT_REVIEW_NOT_FOUND/,
    );
  } finally {
    cleanup(root);
  }
});

test("an acceptance of a different package does not publish this one", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    saveResultReview(root, {
      schema_version: 1,
      review_id: REVIEW.review_id,
      run_id: RUN_ID,
      reviewer_worker_id: REVIEWER,
      package_sha256: "a".repeat(64),
      verdict: "approved",
      evidence_refs: [],
      reason_codes: [],
    });
    // This is the substitution the digest exists to stop: get one package
    // approved, publish another under the same review id.
    assert.throws(
      () => exportResultPackage({ project_root: root, run_id: RUN_ID, review: REVIEW }),
      /RESULT_REVIEW_SUBJECT_MISMATCH/,
    );
  } finally {
    cleanup(root);
  }
});

test("a rejected package is not published", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    const plan = planResultExport({ project_root: root, run_id: RUN_ID });
    saveResultReview(root, {
      schema_version: 1,
      review_id: REVIEW.review_id,
      run_id: RUN_ID,
      reviewer_worker_id: REVIEWER,
      package_sha256: plan.candidate.package_sha256,
      verdict: "rejected",
      evidence_refs: [],
      reason_codes: ["evidence_thin"],
    });
    assert.throws(
      () => exportResultPackage({ project_root: root, run_id: RUN_ID, review: REVIEW }),
      /RESULT_REVIEW_REJECTED/,
    );
  } finally {
    cleanup(root);
  }
});

test("a run cannot sign off on its own package", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    const plan = planResultExport({ project_root: root, run_id: RUN_ID });
    assert.throws(
      () =>
        saveResultReview(root, {
          schema_version: 1,
          review_id: REVIEW.review_id,
          run_id: RUN_ID,
          reviewer_worker_id: RUN_ID,
          package_sha256: plan.candidate.package_sha256,
          verdict: "approved",
          evidence_refs: [],
          reason_codes: [],
        }),
      /REVIEWER_NOT_INDEPENDENT/,
    );
  } finally {
    cleanup(root);
  }
});

test("a reviewer cannot change its verdict after the fact", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    const plan = planResultExport({ project_root: root, run_id: RUN_ID });
    const base = {
      schema_version: 1 as const,
      review_id: REVIEW.review_id,
      run_id: RUN_ID,
      reviewer_worker_id: REVIEWER,
      package_sha256: plan.candidate.package_sha256,
      evidence_refs: [],
      reason_codes: [],
    };
    saveResultReview(root, { ...base, verdict: "approved" });
    // The package may already be published on the strength of the first
    // answer, so there is no taking it back under the same id.
    assert.throws(
      () => saveResultReview(root, { ...base, verdict: "rejected" }),
      /IMMUTABLE_CONFLICT/,
    );
  } finally {
    cleanup(root);
  }
});

/**
 * A tester's signed public feedback envelope, plus the key that verifies it.
 * The envelope's contents are fixed shapes -- ids, digests, enum values and a
 * metric map -- because there is nowhere in it for a sentence to go. That is
 * the actual reason a tester cannot leak case content into the wiki: not a
 * scan of its prose for forbidden words, but that it has no prose channel.
 */
const TESTER_FEEDBACK_INPUT = {
  schema_version: 1,
  task_id: "task:export",
  task_setup_revision: "setup:export",
  input_snapshot_sha256: "1".repeat(64),
  promotion_trial_id: "promotion:export",
  tester_version: "v1",
  conclusion: "improved",
  directions: ["long_horizon_stability"],
  advice: ["increase_long_horizon_consistency"],
  confidence: "high",
  metrics: { score: 0.9 },
} as const;

function signedTesterFeedback(): {
  signed: { feedback: TesterPublicFeedbackEnvelope; signature: string };
  publicKey: crypto.KeyObject;
  otherPublicKey: crypto.KeyObject;
} {
  const feedback = buildTesterFeedback({
    ...TESTER_FEEDBACK_INPUT,
    directions: [...TESTER_FEEDBACK_INPUT.directions],
    advice: [...TESTER_FEEDBACK_INPUT.advice],
    metrics: { ...TESTER_FEEDBACK_INPUT.metrics },
  });
  const envelope: TesterPublicFeedbackEnvelope = {
    schema_version: 1,
    tester_run_id: "tester-run",
    outer_run_id: "outer-run",
    task_id: "task:export",
    promotion_trial_id: "promotion:export",
    outer_iteration: 1,
    generation: 1,
    wave_id: "wave:export",
    tester_definition_sha256: activeDefinitionSha,
    harness_sha256: "2".repeat(64),
    matching_baseline_artifact_sha256: "3".repeat(64),
    finalist_artifact_sha256: "4".repeat(64),
    input_snapshot_sha256: "1".repeat(64),
    input_distribution_sha256: "5".repeat(64),
    tester_version: "v1",
    tester_conclusion_status: "passed",
    feedback,
  };
  const bytes = Buffer.concat([
    Buffer.from("aris-tester-public-feedback-v1\n"),
    canonicalJsonBytes(envelope),
  ]);
  const keyPair = crypto.generateKeyPairSync("ed25519");
  return {
    signed: {
      feedback: envelope,
      signature: crypto.sign(null, bytes, keyPair.privateKey).toString("base64"),
    },
    publicKey: keyPair.publicKey,
    otherPublicKey: crypto.generateKeyPairSync("ed25519").publicKey,
  };
}

test("tester numbers enter the wiki only through a verified envelope", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    const { signed, publicKey } = signedTesterFeedback();
    addExperiment(wikiRoot, "exp-signed", {
      verdict: "yes",
      confidence: "high",
      testerReceipt: { signed, publicKey },
    });
    const page = readWikiModel(wikiRoot).pages.experiment.get("exp-signed");
    assert.notEqual(page, undefined);
    // Every tester field on the page was copied off the verified envelope.
    // There is no flag that writes any of them directly.
    assert.deepEqual({ ...(page?.data.tester_metrics as Record<string, number>) }, { score: 0.9 });
    assert.equal(page?.data.tester_conclusion, "improved");
    assert.equal(page?.data.tester_confidence, "high");
    assert.deepEqual(page?.data.tester_directions, ["long_horizon_stability"]);
    assert.deepEqual(page?.data.tester_advice, ["increase_long_horizon_consistency"]);
    assert.equal(page?.data.iteration, 1);
  } finally {
    cleanup(root);
  }
});

test("a tester envelope signed by the wrong key never reaches the wiki", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    const { signed, otherPublicKey } = signedTesterFeedback();
    assert.throws(
      () =>
        addExperiment(wikiRoot, "exp-forged", {
          verdict: "yes",
          confidence: "high",
          testerReceipt: { signed, publicKey: otherPublicKey },
        }),
      /TESTER_SIGNATURE_INVALID/,
    );
    assert.equal(readWikiModel(wikiRoot).pages.experiment.has("exp-forged"), false);
  } finally {
    cleanup(root);
  }
});

test("editing a tester's numbers after it signed them invalidates the envelope", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    const { signed, publicKey } = signedTesterFeedback();
    // The producing run wants a better number than the tester gave it. It can
    // rebuild the feedback so its self-digest agrees with the new number, but
    // the signature is over the whole envelope, and it does not hold the key.
    const tampered = {
      ...signed,
      feedback: {
        ...signed.feedback,
        feedback: buildTesterFeedback({
          ...TESTER_FEEDBACK_INPUT,
          directions: [...TESTER_FEEDBACK_INPUT.directions],
          advice: [...TESTER_FEEDBACK_INPUT.advice],
          metrics: { score: 0.99 },
        }),
      },
    };
    assert.throws(
      () =>
        addExperiment(wikiRoot, "exp-tampered", {
          verdict: "yes",
          confidence: "high",
          testerReceipt: { signed: tampered, publicKey },
        }),
      /TESTER_SIGNATURE_INVALID/,
    );
  } finally {
    cleanup(root);
  }
});

test("an iteration that contradicts the tester receipt is refused", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    const { signed, publicKey } = signedTesterFeedback();
    // The envelope names the round it judged. Letting the caller relabel it
    // would file a tester score against an iteration it never saw.
    assert.throws(
      () =>
        addExperiment(wikiRoot, "exp-mislabelled", {
          verdict: "yes",
          confidence: "high",
          iteration: 7,
          testerReceipt: { signed, publicKey },
        }),
      /contradicts the tester receipt/,
    );
  } finally {
    cleanup(root);
  }
});

test("re-exporting the same winner is idempotent", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, { id: "exp-1", iteration: 1, gate_metric: 0.5 });
    writeDashboard(root, [{ iter: 1, value: 0.5 }]);
    const first = exportWithReview({ project_root: root, run_id: RUN_ID });
    const second = exportWithReview({ project_root: root, run_id: RUN_ID });
    assert.equal(second.result_package.package_sha256, first.result_package.package_sha256);
  } finally {
    cleanup(root);
  }
});

test("a research query reads the same tester numbers the export ranks by", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, {
      id: "exp-1",
      iteration: 1,
      gate_metric: 0.4,
      tester_metrics: { score: 0.9 },
    });
    const model = readWikiModel(wikiRoot);
    assert.deepEqual({ ...(model.pages.experiment.get("exp-1")!.data.tester_metrics as object) }, {
      score: 0.9,
    });

    const result = queryWikiFromEvents(readWikiEvents(wikiRoot), {
      purpose: "idea discovery",
      requester: "idea-discovery",
      scope: SCOPE,
    });
    const page = result.pages.find((candidate) => candidate.id === "exp-1")!;
    // The tester publishes aggregates, not test content, so a research skill
    // reads the same values the export ranks by. What stays private is the
    // cases behind them, which never enter the wiki at all.
    assert.deepEqual({ ...(page.data.tester_metrics as object) }, { score: 0.9 });
    assert.equal(page.data.gate_metric, 0.4);
  } finally {
    cleanup(root);
  }
});

test("the tester's coarse verdict is readable next to its numbers", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    appendExperiment(wikiRoot, {
      id: "exp-1",
      iteration: 1,
      gate_metric: 0.4,
      tester_metrics: { score: 0.9 },
      tester_verdict: {
        conclusion: "not_improved",
        confidence: "medium",
        directions: ["long_horizon_stability"],
        advice: ["increase_long_horizon_consistency"],
      },
    });
    const result = queryWikiFromEvents(readWikiEvents(wikiRoot), {
      purpose: "idea discovery",
      requester: "idea-discovery",
      scope: SCOPE,
    });
    const page = result.pages.find((candidate) => candidate.id === "exp-1")!;
    // A number alone says the run got worse; the direction says where to look.
    // Both are aggregates, so both are ordinary wiki content.
    assert.equal(page.data.tester_conclusion, "not_improved");
    assert.deepEqual(page.data.tester_directions, ["long_horizon_stability"]);
    assert.deepEqual(page.data.tester_advice, ["increase_long_horizon_consistency"]);

    projectWiki(wikiRoot);
    const markdown = fs.readFileSync(path.join(wikiRoot, "experiments", "exp-1.md"), "utf8");
    assert.ok(markdown.includes("- tester metrics: `score`: 0.9"), markdown);
    assert.ok(markdown.includes("- tester conclusion: not_improved (confidence: medium)"), markdown);
    assert.ok(markdown.includes("- tester directions: `long_horizon_stability`"), markdown);
    assert.ok(!markdown.includes("withheld"), markdown);
  } finally {
    cleanup(root);
  }
});

test("a repeated tester direction is refused at the wiki write", () => {
  const root = tmpDir();
  try {
    const { wikiRoot } = setup(root);
    assert.throws(
      () =>
        appendExperiment(wikiRoot, {
          id: "exp-dup",
          iteration: 1,
          tester_verdict: {
            conclusion: "not_improved",
            confidence: "low",
            directions: ["cost_efficiency", "cost_efficiency"],
            advice: ["reduce_cost_variance"],
          },
        }),
      /tester_directions must not repeat a value/,
    );
  } finally {
    cleanup(root);
  }
});

test("rankCandidates orders mutually non-dominated candidates deterministically", () => {
  const base = { page_id: "", idea_id: null, tester_definition_sha256: "d".repeat(64) };
  const candidates = [
    { ...base, page_id: "a", iteration: 1, tester_metrics: { x: 1, y: 2 }, gate_metric: 0.1 },
    { ...base, page_id: "b", iteration: 2, tester_metrics: { x: 2, y: 1 }, gate_metric: 0.1 },
    { ...base, page_id: "c", iteration: 3, tester_metrics: { x: 0, y: 0 }, gate_metric: 0.9 },
  ];
  const primaries = [primary("x"), primary("y")];
  const forward = rankCandidates(candidates, primaries, "higher_better");
  const reversed = rankCandidates([...candidates].reverse(), primaries, "higher_better");
  assert.deepEqual(
    forward.map((candidate) => candidate.page_id),
    ["b", "a", "c"],
  );
  // Input order must not change the answer; c is dominated, so its better gate
  // reading cannot lift it above the front.
  assert.deepEqual(
    reversed.map((candidate) => candidate.page_id),
    forward.map((candidate) => candidate.page_id),
  );
});

test("readDashboardMetric reports the series the export cross-checks against", () => {
  const root = tmpDir();
  try {
    setup(root);
    writeDashboard(root, [
      { iter: 1, value: 0.5 },
      { iter: 2, value: 0.7 },
    ]);
    const metric = readDashboardMetric(root, RUN_ID);
    assert.equal(metric.direction, "higher_better");
    assert.deepEqual(metric.history, [
      { iter: 1, value: 0.5 },
      { iter: 2, value: 0.7 },
    ]);
  } finally {
    cleanup(root);
  }
});

let passed = 0;
let failed = 0;
for (const current of tests) {
  try {
    current.fn();
    console.log(`  PASS ${current.name}`);
    passed += 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  FAIL ${current.name}: ${message}`);
    failed += 1;
    if (process.argv.includes("--bail")) break;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
