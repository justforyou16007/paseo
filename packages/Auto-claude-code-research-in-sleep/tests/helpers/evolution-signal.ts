import path from "node:path";
import { publishSignal } from "../../src/tools/research-wiki.js";
import { buildTesterFeedback } from "../../src/tools/tester-feedback.js";
import { buildTesterFeedbackSignal } from "../../src/tools/tester-feedback-signal.js";
import { initializeWikiSchema } from "../../src/tools/wiki-event-store.js";
import { runWikiRoot } from "../../src/tools/wiki-scope.js";

/**
 * The signal a finished generation leaves behind: a sanitized tester outcome
 * in the parent's own Wiki. A decomposition may only change after one of
 * these exists, so tests that reach generation 2 have to publish it the way
 * the outer committer does — through the real signal builder, not a
 * hand-written event.
 */
export function publishEvolutionSignal(
  projectRoot: string,
  runId: string,
  generation: number,
): string {
  const feedback = buildTesterFeedback({
    schema_version: 1,
    task_id: "task:fixed",
    task_setup_revision: "setup:fixed",
    input_snapshot_sha256: "a".repeat(64),
    promotion_trial_id: `promotion:${generation}`,
    tester_version: "tester:v1",
    conclusion: "not_improved",
    directions: ["long_horizon_stability"],
    advice: ["increase_long_horizon_consistency"],
    confidence: "medium",
    metrics: { tester_score: 0.5 },
  });
  const signal = buildTesterFeedbackSignal(
    {
      actor: "outer_committer",
      project_root: projectRoot,
      wiki_root: runWikiRoot(projectRoot, runId),
      execution_root: path.join(projectRoot, "execution"),
      outer_run_id: runId,
      outer_iteration: generation,
      workflow_id: "workflow:decomposition",
      workflow_revision: `flow:r${generation}`,
      tester_run_id: `tester-run-${generation}`,
      targets: [],
    },
    feedback,
  );
  const root = runWikiRoot(projectRoot, runId);
  initializeWikiSchema(root);
  publishSignal(root, signal, {
    projectRoot,
    runId,
    evidenceBundleId: feedback.feedback_event_id,
  });
  return signal.signal_id;
}
