import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  freezeScorerComparisonInput,
  runScorerComparison,
  type ProbeMaterializer,
  type RunScorerComparisonInput,
  type ScorerComparison,
  type ScorerExperimentFreeze,
} from "./scorer-experiment.js";
import {
  activateScorerRevision,
  recordScorerReview,
  rejectScorerRevision,
  saveScorerWaveRegistration,
  startScorerRun,
  transitionScorerState,
  type ScorerRunState,
  type StartScorerRunInput,
} from "./scorer-state.js";
import {
  markOuterChildTerminal,
  readOuterRunState,
  registerOuterChild,
  type OuterRunIdentity,
} from "./workflow-runtime.js";
import { failA1, assertSha256 } from "./workflow-spec.js";
import type { ScorerRevision } from "./scorer-definition.js";
import type { ScorerReviewReceipt } from "./review-submit.js";

/**
 * One scorer wave is deliberately a single function at this boundary. The
 * lower-level files still own the durable checkpoints, but callers cannot
 * accidentally run the candidate before the parent or activate without the
 * stored breadth/depth review.
 */
export interface ExecuteScorerWaveInput extends OuterRunIdentity {
  outer_iteration: number;
  generation: number;
  start: StartScorerRunInput;
  parent: ScorerRevision;
  candidate: ScorerRevision;
  freeze: ScorerExperimentFreeze;
  materialize: ProbeMaterializer;
  evaluate_parent: RunScorerComparisonInput["evaluate_parent"];
  evaluate_candidate: RunScorerComparisonInput["evaluate_candidate"];
  review: unknown;
}

export interface ScorerWaveExecutionResult {
  status: "activated" | "rejected";
  scorer_run: ScorerRunState;
  comparison: ScorerComparison;
  review_id: string;
  review_sha256: string;
}

export interface RegisterScorerWaveForOuterInput extends OuterRunIdentity {
  outer_iteration: number;
  generation: number;
  start: StartScorerRunInput;
}

function reviewSha256(review: ScorerReviewReceipt): string {
  return canonicalJsonSha256(review, undefined, { schemaVersion: "review-receipt-v1" });
}

function assertScorerOuterSlot(
  input: Pick<
    ExecuteScorerWaveInput,
    "execution_root" | "project_root" | "outer_run_id" | "outer_iteration" | "generation" | "start"
  >,
): void {
  const outer = readOuterRunState(input);
  const iteration = input.outer_iteration;
  if (
    outer.active_cycle === null ||
    outer.active_cycle.outer_iteration !== iteration ||
    outer.active_cycle.generation !== input.generation ||
    outer.active_cycle.wave_kind !== "scorer" ||
    outer.active_cycle.wave_id !== input.start.wave_id
  )
    failA1("SCORER_WAVE_REQUIRED", "the outer run does not own the requested scorer wave");
  if (input.start.workflow_id !== outer.workflow_id)
    failA1("IDENTITY_MISMATCH", "scorer run workflow does not match the outer run");
  if (outer.current_phase !== "wave")
    failA1("OUTER_PHASE_ORDER", "a scorer child can start only during the wave phase");
  const sameChild = outer.children.find(
    (child) =>
      child.outer_iteration === iteration && child.child_run_id === input.start.scorer_run_id,
  );
  if (
    outer.children.some(
      (child) =>
        child.outer_iteration === iteration && child.child_run_id !== input.start.scorer_run_id,
    )
  )
    failA1(
      "SCORER_WAVE_EXCLUSIVE",
      "a scorer wave cannot share its outer iteration with another child",
    );
  if (sameChild?.kind !== undefined && sameChild.kind !== "scorer")
    failA1("IDENTITY_MISMATCH", "the existing scorer child has another kind");
  if (input.start.outer_run_id !== input.outer_run_id || input.start.outer_iteration !== iteration)
    failA1("IDENTITY_MISMATCH", "scorer run start input does not match the outer cycle");
  if (input.start.generation !== input.generation)
    failA1("IDENTITY_MISMATCH", "scorer run generation does not match the outer cycle");
}

/**
 * Bridge the outer runtime's cycle ownership into the scorer state machine.
 * The registration is written only after the outer cycle has been checked;
 * scorer-state then treats it as an immutable prerequisite for every later
 * parent/candidate action.
 */
export function registerScorerWaveForOuter(
  input: RegisterScorerWaveForOuterInput,
): RegisterScorerWaveForOuterInput["start"] {
  assertScorerOuterSlot(input);
  const start = input.start;
  if (
    start.project_root !== input.project_root ||
    start.outer_run_id !== input.outer_run_id ||
    start.outer_iteration !== input.outer_iteration ||
    start.generation !== input.generation
  )
    failA1("IDENTITY_MISMATCH", "scorer registration does not match the outer cycle");
  saveScorerWaveRegistration({
    project_root: input.project_root,
    workflow_id: start.workflow_id,
    scorer_id: start.scorer_id,
    scorer_run_id: start.scorer_run_id,
    outer_run_id: start.outer_run_id,
    outer_iteration: start.outer_iteration,
    wave_id: start.wave_id,
    parent_revision: start.parent_revision,
    candidate_revision: start.candidate_revision,
    delta_id: start.delta_id,
  });
  return start;
}

function assertReviewShape(review: unknown, input: ExecuteScorerWaveInput): ScorerReviewReceipt {
  if (
    typeof review !== "object" ||
    review === null ||
    !Object.hasOwn(review, "reviewed_run_kind") ||
    (review as { reviewed_run_kind?: unknown }).reviewed_run_kind !== "scorer"
  )
    failA1("REVIEW_TYPE_MISMATCH", "scorer wave needs a stored scorer review receipt");
  const typed = review as ScorerReviewReceipt;
  if (
    typed.reviewed_run_id !== input.start.scorer_run_id ||
    typed.outer_iteration !== input.outer_iteration ||
    typed.wave_id !== input.start.wave_id ||
    typed.generation !== input.generation
  )
    failA1("IDENTITY_MISMATCH", "scorer review does not belong to this wave");
  return typed;
}

export function executeScorerWave(input: ExecuteScorerWaveInput): ScorerWaveExecutionResult {
  assertScorerOuterSlot(input);
  registerScorerWaveForOuter({
    execution_root: input.execution_root,
    project_root: input.project_root,
    outer_run_id: input.outer_run_id,
    outer_iteration: input.outer_iteration,
    generation: input.generation,
    start: input.start,
  });
  const started = startScorerRun(input.start);
  let childRegistered = false;
  try {
    registerOuterChild({
      execution_root: input.execution_root,
      project_root: input.project_root,
      outer_run_id: input.outer_run_id,
      child_run_id: started.scorer_run_id,
      kind: "scorer",
      outer_iteration: input.outer_iteration,
      generation: input.generation,
    });
    childRegistered = true;
    let state = started;
    if (state.status === "proposed")
      state = transitionScorerState(input.project_root, state.scorer_run_id, "materialized");
    freezeScorerComparisonInput({
      project_root: input.project_root,
      workflow_id: input.start.workflow_id,
      scorer_id: input.start.scorer_id,
      scorer_run_id: input.start.scorer_run_id,
      parent: input.parent,
      candidate: input.candidate,
      freeze: input.freeze,
      materialize: input.materialize,
    });
    const comparison = runScorerComparison({
      project_root: input.project_root,
      workflow_id: input.start.workflow_id,
      scorer_id: input.start.scorer_id,
      scorer_run_id: input.start.scorer_run_id,
      parent: input.parent,
      candidate: input.candidate,
      freeze: input.freeze,
      materialize: input.materialize,
      evaluate_parent: input.evaluate_parent,
      evaluate_candidate: input.evaluate_candidate,
    });
    const review = assertReviewShape(input.review, input);
    state = recordScorerReview(input.project_root, started.scorer_run_id, review);
    const approved =
      review.verdict === "approved" &&
      review.breadth_verdict === "approved" &&
      review.depth_verdict === "approved";
    state = approved
      ? activateScorerRevision(input.project_root, started.scorer_run_id, review)
      : rejectScorerRevision(input.project_root, started.scorer_run_id);
    if (childRegistered)
      markOuterChildTerminal({
        execution_root: input.execution_root,
        project_root: input.project_root,
        outer_run_id: input.outer_run_id,
        child_run_id: started.scorer_run_id,
      });
    return {
      status: approved ? "activated" : "rejected",
      scorer_run: state,
      comparison,
      review_id: review.review_id,
      review_sha256: assertSha256(reviewSha256(review), "review_sha256"),
    };
  } catch (error: unknown) {
    try {
      const current = transitionScorerState(input.project_root, started.scorer_run_id, "failed");
      if (childRegistered)
        markOuterChildTerminal({
          execution_root: input.execution_root,
          project_root: input.project_root,
          outer_run_id: input.outer_run_id,
          child_run_id: started.scorer_run_id,
        });
      void current;
    } catch {
      // Preserve the original failure. Recovery can reconcile the durable run.
    }
    throw error;
  }
}
