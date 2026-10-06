import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  auditedTesterMetric,
  verifyTesterDeliverables,
  type TesterDeliverables,
} from "./tester-deliverables.js";
/**
 * Exporting a run's best iteration as its result package.
 *
 * A run's wiki records one experiment page per outer iteration. Which of those
 * iterations was the best is a question no single iteration can answer - the
 * loop only ever sees "is this round better than the last one", which is why
 * the metric gate stopping is not the same as the last round being the winner.
 * This module reads the whole series at once and picks from it.
 *
 * The order of preference follows the two evidence families the wiki keeps:
 *
 *   1. The tester's declared metrics. This is the held-out judgment, so it
 *      decides first. All declared metrics count together - an iteration wins
 *      on tester evidence only if no other iteration is at least as good on
 *      every metric and strictly better on one.
 *   2. The metric gate's own reading for that iteration. This is the run's
 *      internal stop-condition measurement, so it only breaks ties the tester
 *      left open.
 *   3. The later iteration, so the choice is deterministic either way.
 *
 * The gate value recorded on an experiment page is not a second source of
 * truth: it must equal the dashboard's reading for the same iteration, and the
 * export fails if it does not.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { hasDecomposition } from "./decomposition-graph.js";
import { readDashboardMetric } from "./metric-gate.js";
import {
  readFrozenPolicy,
  readWorkflowRuntimeState,
  workflowCycleRelativePath,
  workflowDashboardPath,
} from "./workflow-state.js";
import { readWorkflowStopDecision } from "./workflow-stop-gate.js";
import { collectOrchestrationRound, roundChildSummaries } from "./orchestration-round.js";
import {
  buildResultPackageForRun,
  readResultPackage,
  resultPackagePath,
  saveResultPackage,
  type ResultFailure,
  type ResultPackage,
  type ResultPackageInput,
  type ResultPackageReview,
  type ResultStatus,
  type ResultTerminationReason,
} from "./result-package.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";
import { readStateFile } from "./state-file.js";
import {
  readTesterFacilityConfig,
  testerFacilityConfigSha256,
  readAuditedTesterResult,
  evidenceFile,
  testerConfigPath,
} from "./tester-facility.js";
import { validateTesterDefinition, type TesterPrimaryMetric } from "./tester-state.js";
import { eventLogHead, readWikiEvents } from "./wiki-event-store.js";
import { readWikiModel, type WikiPage } from "./wiki-projector.js";
import { runWikiRoot } from "./wiki-scope.js";
import { failA1 } from "./workflow-spec.js";

/** One iteration's experiment page, reduced to what the ranking needs. */
export interface ExportCandidate {
  page_id: string;
  iteration: number;
  idea_id: string | null;
  tester_metrics: Record<string, number> | null;
  tester_definition_sha256: string | null;
  gate_metric: number | null;
  test_result_path?: string;
  test_audit_path?: string;
  artifact?: { ref: string; sha256: string };
  deliverables?: TesterDeliverables;
}

export interface ResultExportInput {
  project_root: string;
  run_id: string;
  /** Defaults to the run's own wiki. */
  wiki_root?: string;
  /**
   * The frozen tester definition whose `gate.primaries` name the metrics the
   * wiki recorded. Required as soon as any candidate carries tester metrics:
   * without it the export does not know which direction each metric improves.
   */
  tester_definition_path?: string;
  /** Free-text package summary; the default one is used when omitted. */
  summary?: string;
  status?: ResultStatus;
  review: ResultPackageReview;
}

export interface ResultExport {
  result_package: ResultPackage;
  winner: ExportCandidate | null;
  /** Every iteration that was eligible, best first. */
  ranked: ExportCandidate[];
}

/**
 * What a reviewer is shown. The candidate is byte-identical to what a later
 * export would write, so `candidate.package_sha256` is the digest the reviewer
 * signs and the digest the write is checked against.
 */
export interface ResultExportPlan {
  candidate: ResultPackage;
  result_input: ResultPackageInput;
  winner: ExportCandidate | null;
  ranked: ExportCandidate[];
}

function candidateFromPage(page: WikiPage, runId: string): ExportCandidate | null {
  const data = page.data;
  // An experiment without an iteration cannot be lined up against the metric
  // history, so it is not a candidate rather than a zero-scored one.
  if (typeof data.iteration !== "number") return null;
  const testerMetrics =
    typeof data.tester_metrics === "object" &&
    data.tester_metrics !== null &&
    !Array.isArray(data.tester_metrics)
      ? (data.tester_metrics as Record<string, number>)
      : null;
  if (testerMetrics !== null && data.tester_audit_status !== "pass") return null;
  let tested: Pick<
    ExportCandidate,
    "test_result_path" | "test_audit_path" | "artifact" | "deliverables"
  > = {};
  if (testerMetrics !== null) {
    const { result } = readAuditedTesterResult(
      String(data.test_result_path),
      String(data.test_audit_path),
      { iteration: data.iteration as number, experiment_id: page.id, run_id: runId },
    );
    if (
      canonicalJsonSha256(testerMetrics) !== canonicalJsonSha256(result.metrics) ||
      data.tester_definition_sha256 !== result.config_sha256 ||
      data.test_result_sha256 !== evidenceFile(String(data.test_result_path)).sha256 ||
      data.test_audit_sha256 !== evidenceFile(String(data.test_audit_path)).sha256
    )
      failA1("TESTER_METRIC_MISMATCH", "Wiki page differs from its audited benchmark result");
    // Historical pages predate explicit gate bindings. New Wiki writes always
    // carry the name; ARL exports additionally check their frozen target below.
    if (
      typeof data.gate_metric === "number" &&
      typeof data.gate_metric_name === "string" &&
      data.gate_metric !== auditedTesterMetric(result, data.gate_metric_name)
    )
      failA1("TESTER_METRIC_MISMATCH", "Wiki gate metric differs from audited tester evidence");
    tested = {
      test_result_path: String(data.test_result_path),
      test_audit_path: String(data.test_audit_path),
      artifact: result.request.artifact,
      deliverables: result.request.deliverables,
    };
  }
  return {
    ...tested,
    page_id: page.id,
    iteration: data.iteration,
    idea_id: typeof data.idea_id === "string" && data.idea_id !== "" ? data.idea_id : null,
    tester_metrics: testerMetrics,
    tester_definition_sha256:
      typeof data.tester_definition_sha256 === "string" && data.tester_definition_sha256 !== ""
        ? data.tester_definition_sha256
        : null,
    gate_metric: typeof data.gate_metric === "number" ? data.gate_metric : null,
  };
}

/**
 * The wiki's gate reading and the dashboard's are the same measurement written
 * down twice. Rather than pick one, the export requires them to agree, which
 * turns the duplication into a check that the experiment page belongs to the
 * iteration it claims.
 */
function reconcileGateMetric(
  candidate: ExportCandidate,
  dashboardByIteration: Map<number, number>,
  location: string,
): number | null {
  const dashboardValue = dashboardByIteration.get(candidate.iteration);
  if (candidate.gate_metric === null) return dashboardValue ?? null;
  if (dashboardValue === undefined)
    failA1(
      "GATE_METRIC_MISSING",
      `experiment ${candidate.page_id} records a gate metric for iteration ${candidate.iteration}, which the dashboard has no reading for`,
      location,
    );
  if (dashboardValue !== candidate.gate_metric)
    failA1(
      "GATE_METRIC_MISMATCH",
      `experiment ${candidate.page_id} records gate metric ${candidate.gate_metric} for iteration ${candidate.iteration}, but the dashboard reads ${dashboardValue}`,
      location,
    );
  return candidate.gate_metric;
}

function readPrimaries(
  input: Omit<ResultExportInput, "review">,
  candidates: readonly ExportCandidate[],
) {
  const judged = candidates.filter((candidate) => candidate.tester_metrics !== null);
  if (judged.length === 0) return null;
  const definitionPath = path.resolve(
    input.project_root,
    input.tester_definition_path ?? testerConfigPath(input.project_root),
  );
  if (!fs.existsSync(definitionPath))
    failA1(
      "TESTER_DEFINITION_REQUIRED",
      "tester facility configuration is required for benchmark ranking",
    );
  const rawDefinition = readStateFile<Record<string, unknown>>(definitionPath);
  const facility =
    rawDefinition.mode === "tester_facility" ? readTesterFacilityConfig(definitionPath) : null;
  const legacy = facility === null ? validateTesterDefinition(rawDefinition) : null;
  const declared = facility ? facility.metrics : legacy!.gate.primaries;
  const definitionHash = facility
    ? testerFacilityConfigSha256(facility)
    : legacy!.definition_sha256;
  const declaredNames = declared.map((primary) => primary.name).sort();
  for (const candidate of judged) {
    // A page whose metrics came from a different tester version cannot be
    // compared against these ones, so the whole export stops rather than
    // silently ranking across two definitions.
    if (candidate.tester_definition_sha256 !== definitionHash)
      failA1(
        "TESTER_DEFINITION_MISMATCH",
        `experiment ${candidate.page_id} was judged by tester definition ${candidate.tester_definition_sha256 ?? "(none recorded)"}, not ${definitionHash}`,
        "result_export.tester_definition_path",
      );
    const recorded = Object.keys(candidate.tester_metrics ?? {}).sort();
    if (recorded.join(",") !== declaredNames.join(","))
      failA1(
        "TESTER_METRIC_SET_MISMATCH",
        `experiment ${candidate.page_id} records tester metrics [${recorded.join(", ")}], but the definition declares [${declaredNames.join(", ")}]`,
        "result_export.tester_definition_path",
      );
  }
  return { definition: facility ?? legacy, declared, judged };
}

/** True when `left` is at least as good everywhere and strictly better once. */
function dominates(
  left: ExportCandidate,
  right: ExportCandidate,
  primaries: readonly Pick<TesterPrimaryMetric, "name" | "direction">[],
): boolean {
  let strictlyBetterSomewhere = false;
  for (const primary of primaries) {
    const leftValue = left.tester_metrics![primary.name]!;
    const rightValue = right.tester_metrics![primary.name]!;
    const better =
      primary.direction === "higher_better" ? leftValue > rightValue : leftValue < rightValue;
    const worse =
      primary.direction === "higher_better" ? leftValue < rightValue : leftValue > rightValue;
    if (worse) return false;
    if (better) strictlyBetterSomewhere = true;
  }
  return strictlyBetterSomewhere;
}

function betterOnGate(
  left: ExportCandidate,
  right: ExportCandidate,
  direction: "higher_better" | "lower_better",
): number {
  if (left.gate_metric === right.gate_metric) return 0;
  // An iteration with no gate reading loses to one that has any, rather than
  // being treated as a zero that could beat a negative metric.
  if (left.gate_metric === null) return 1;
  if (right.gate_metric === null) return -1;
  const leftWins =
    direction === "higher_better"
      ? left.gate_metric > right.gate_metric
      : left.gate_metric < right.gate_metric;
  return leftWins ? -1 : 1;
}

/**
 * Best first.
 *
 * Dominance is not a total order - two iterations can each be better on a
 * different metric - so it cannot be handed to `sort` directly. Instead the
 * candidates are peeled off in layers: everything nothing else dominates comes
 * first, then everything nothing in the remainder dominates, and so on. Inside
 * a layer the gate value decides, and a later iteration breaks what is left,
 * so the result never depends on the order the pages came out of the wiki.
 */
export function rankCandidates(
  candidates: readonly ExportCandidate[],
  primaries: readonly Pick<TesterPrimaryMetric, "name" | "direction">[] | null,
  gateDirection: "higher_better" | "lower_better",
): ExportCandidate[] {
  const withinLayer = (left: ExportCandidate, right: ExportCandidate): number =>
    betterOnGate(left, right, gateDirection) || right.iteration - left.iteration;
  if (primaries === null) return [...candidates].sort(withinLayer);
  let remaining = [...candidates];
  const ordered: ExportCandidate[] = [];
  while (remaining.length > 0) {
    const layer = remaining.filter(
      (candidate) =>
        !remaining.some((other) => other !== candidate && dominates(other, candidate, primaries)),
    );
    ordered.push(...layer.sort(withinLayer));
    remaining = remaining.filter((candidate) => !layer.includes(candidate));
  }
  return ordered;
}

/**
 * The run ended because bridge repair was exhausted. Workflow runs prove it
 * with the saved stop decision; standalone runs with the dashboard outcome
 * that `dashboard-merge` writes on exhausted repair.
 */
function noProposalStop(
  projectRoot: string,
  runId: string,
): { iteration: number; evidence_refs: string[] } | null {
  if (fs.existsSync(runOwnedPath(projectRoot, runId, "frozen-policy.json"))) {
    if (readFrozenPolicy(projectRoot, runId).mode !== "auto_research_loop") return null;
    const runtime = readWorkflowRuntimeState(projectRoot, runId);
    const latest = runtime.cycle_history.at(-1);
    if (
      latest?.outcome !== "no_proposal" ||
      runtime.stop_decision_ref === null ||
      readWorkflowStopDecision(projectRoot, runId, latest.outer_iteration).reason !== "no_proposal"
    )
      return null;
    return { iteration: latest.outer_iteration, evidence_refs: latest.evidence_refs };
  }
  const dashboardPath = runOwnedPath(projectRoot, runId, "dashboard.json");
  if (!fs.existsSync(dashboardPath)) return null;
  const dashboard = readStateFile<Record<string, unknown>>(dashboardPath);
  if (
    dashboard.outcome !== "no_proposal" ||
    dashboard.status !== "completed" ||
    typeof dashboard.iteration !== "number"
  )
    return null;
  const failure = dashboard.bridge_failure as Record<string, unknown> | null | undefined;
  // A failure that arrived after the repair cap was used up has no repair
  // receipt of its own; the bridge receipt it was raised against is the evidence.
  const ref = failure?.repair_receipt_ref ?? failure?.bridge_receipt_ref;
  return {
    iteration: dashboard.iteration,
    evidence_refs: typeof ref === "string" ? [ref] : [],
  };
}

/**
 * The run ended failed, and where. Workflow runs prove it with the
 * `bridge_failed` cycle and its saved stop decision; standalone runs with the
 * failed dashboard and the failure location `dashboard-merge` wrote. Both say
 * the same things: which worker broke, in which iteration and phase, and how
 * many repairs were spent on it.
 */
function failedStop(projectRoot: string, runId: string): ResultFailure | null {
  let location: Record<string, unknown>;
  let evidenceRefs: string[];
  if (fs.existsSync(runOwnedPath(projectRoot, runId, "frozen-policy.json"))) {
    if (readFrozenPolicy(projectRoot, runId).mode !== "auto_research_loop") return null;
    const runtime = readWorkflowRuntimeState(projectRoot, runId);
    const latest = runtime.cycle_history.at(-1);
    if (
      latest?.outcome !== "bridge_failed" ||
      latest.failure === undefined ||
      runtime.stop_decision_ref === null ||
      readWorkflowStopDecision(projectRoot, runId, latest.outer_iteration).reason !==
        "bridge_failed"
    )
      return null;
    location = { ...latest.failure };
    // The cycle keeps its receipt references relative to the cycle directory;
    // the package names them relative to the run like every other evidence ref.
    evidenceRefs = [latest.failure.bridge_receipt_ref, latest.failure.repair_receipt_ref]
      .filter((ref): ref is string => ref !== null)
      .map((ref) => workflowCycleRelativePath(latest.outer_iteration, ref));
  } else {
    const dashboardPath = runOwnedPath(projectRoot, runId, "dashboard.json");
    if (!fs.existsSync(dashboardPath)) return null;
    const dashboard = readStateFile<Record<string, unknown>>(dashboardPath);
    const failure = dashboard.failure;
    if (dashboard.status !== "failed" || typeof failure !== "object" || failure === null)
      return null;
    location = failure as Record<string, unknown>;
    const bridge = dashboard.bridge_failure as Record<string, unknown> | null | undefined;
    evidenceRefs = [location.bridge_receipt_ref, bridge?.repair_receipt_ref].filter(
      (ref): ref is string => typeof ref === "string",
    );
  }
  const exhausted = location.repair_status === "exhausted";
  const repairs = exhausted ? `; repair exhausted after ${String(location.repair_attempts)}` : "";
  return {
    reason: `${String(location.worker)} failed in iteration ${String(location.iteration)} at phase ${String(location.phase)}${repairs}`,
    failure_code: exhausted ? "BRIDGE_FAILED" : "WORKER_FAILED",
    evidence_refs: [...new Set(evidenceRefs)],
  };
}

/**
 * Pick the winning iteration and build the package it would publish, without
 * publishing it. Ranking reads only the Wiki and the dashboard, so it is a pure
 * read: running it twice on unchanged evidence gives the same candidate and the
 * same digest, which is what lets a reviewer rule on one run of it and a writer
 * act on another.
 */
export function planResultExport(input: Omit<ResultExportInput, "review">): ResultExportPlan {
  const projectRoot = path.resolve(input.project_root);
  const contract = requireRunContract(projectRoot, input.run_id);
  const wikiRoot =
    input.wiki_root === undefined
      ? runWikiRoot(projectRoot, input.run_id)
      : path.resolve(projectRoot, input.wiki_root);

  const model = readWikiModel(wikiRoot);
  const allCandidates = [...model.pages.experiment.values()]
    .map((page) => candidateFromPage(page, input.run_id))
    .filter((candidate): candidate is ExportCandidate => candidate !== null);
  const failure = failedStop(projectRoot, input.run_id);
  if (failure !== null && input.status !== undefined && input.status !== "failed")
    failA1(
      "INVALID_VALUE",
      "a failed run can only export a failed package",
      "result_export.status",
    );
  if (allCandidates.length === 0 && failure !== null) {
    // Nothing to rank, but the run still publishes, so a parent waiting on it
    // collects a failed child instead of waiting forever.
    const head = eventLogHead(readWikiEvents(wikiRoot));
    const resultInput: ResultPackageInput = {
      run_id: input.run_id,
      parent_run_id: contract.parent_run_id,
      scope_path: contract.scope_path,
      status: "failed",
      input_snapshot_sha256: contract.identity_material.input_snapshot_sha256,
      best_idea_ref: null,
      evidence_refs: failure.evidence_refs,
      wiki_head_ref: head.event_id,
      summary: input.summary ?? failure.reason,
      failure,
    };
    return {
      candidate: buildResultPackageForRun(projectRoot, input.run_id, resultInput).package,
      result_input: resultInput,
      winner: null,
      ranked: [],
    };
  }
  if (allCandidates.length === 0) {
    const stop = noProposalStop(projectRoot, input.run_id);
    if (stop === null)
      failA1(
        "NO_EXPORTABLE_EXPERIMENT",
        `wiki at ${wikiRoot} has no experiment page carrying an iteration and the run has no verified no_proposal stop`,
      );
    const head = eventLogHead(readWikiEvents(wikiRoot));
    const resultInput: ResultPackageInput = {
      run_id: input.run_id,
      parent_run_id: contract.parent_run_id,
      scope_path: contract.scope_path,
      status: "not_executable",
      termination_reason: "no_proposal",
      input_snapshot_sha256: contract.identity_material.input_snapshot_sha256,
      best_idea_ref: null,
      evidence_refs: stop.evidence_refs,
      local_metrics: { winning_iteration: stop.iteration },
      wiki_head_ref: head.event_id,
      summary: input.summary ?? "No proposal produced a valid metric",
      failure: {
        reason: "No proposal produced a valid metric",
        failure_code: "NO_PROPOSAL",
        evidence_refs: stop.evidence_refs,
      },
    };
    return {
      candidate: buildResultPackageForRun(projectRoot, input.run_id, resultInput).package,
      result_input: resultInput,
      winner: null,
      ranked: [],
    };
  }
  const frozenPath = runOwnedPath(projectRoot, input.run_id, "frozen-policy.json");
  const frozen = fs.existsSync(frozenPath) ? readFrozenPolicy(projectRoot, input.run_id) : null;
  if (frozen === null && fs.existsSync(workflowDashboardPath(projectRoot, input.run_id)))
    failA1("FROZEN_POLICY_NOT_FOUND", "Workflow result needs its frozen policy");
  let direction: "higher_better" | "lower_better";
  let dashboardByIteration: Map<number, number>;
  let terminationReason: ResultTerminationReason | undefined;
  const assessments = new Map<number, { result_path: string; audit_path: string }>();
  let requireRecordedAssessment = frozen?.mode === "auto_research_loop";
  if (frozen?.mode === "auto_research_loop") {
    const workflowDashboard = readStateFile<Record<string, unknown>>(
      workflowDashboardPath(projectRoot, input.run_id),
    );
    const runtime = readWorkflowRuntimeState(projectRoot, input.run_id);
    if (workflowDashboard.run_id !== input.run_id || runtime.outer_run_id !== input.run_id)
      failA1("IDENTITY_MISMATCH", "Workflow dashboard and runtime refer to a different run");
    direction = frozen.metric.direction;
    for (const candidate of allCandidates) {
      if (!candidate.test_result_path || !candidate.test_audit_path)
        failA1("TESTER_AUDIT_REQUIRED", "ARL export cannot use an unaudited historical experiment");
      const { result } = readAuditedTesterResult(
        candidate.test_result_path,
        candidate.test_audit_path,
        { run_id: input.run_id, iteration: candidate.iteration },
      );
      if (
        candidate.gate_metric !==
        auditedTesterMetric(result, frozen.metric.name, frozen.metric.direction)
      )
        failA1("TESTER_METRIC_MISMATCH", "ARL Wiki gate differs from the frozen audited metric");
    }
    dashboardByIteration = new Map();
    for (const cycle of runtime.cycle_history) {
      if (cycle.metric_value === undefined)
        failA1(
          "GATE_METRIC_MISSING",
          `Workflow cycle ${cycle.outer_iteration} has no metric receipt`,
        );
      if (cycle.review_receipt_ref !== undefined) {
        const receiptPath = runOwnedPath(projectRoot, input.run_id, cycle.review_receipt_ref);
        const bytes = fs.readFileSync(receiptPath);
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== cycle.review_receipt_sha256)
          failA1("INVALID_EXECUTION_RECEIPT", "review receipt changed after cycle completion");
        const receipt = readStateFile<Record<string, unknown>>(receiptPath);
        const patch = receipt.dashboard_patch as Record<string, unknown> | null;
        if (patch?.["metric.current"] !== cycle.metric_value)
          failA1("GATE_METRIC_MISMATCH", "Workflow summary differs from its review receipt");
        const summary = receipt.summary as Record<string, unknown>;
        if (
          typeof summary?.test_result_path !== "string" ||
          typeof summary?.test_audit_path !== "string"
        )
          failA1(
            "TESTER_AUDIT_REQUIRED",
            "completed ARL review must identify its final assessment",
          );
        assessments.set(cycle.outer_iteration, {
          result_path: path.resolve(summary.test_result_path),
          audit_path: path.resolve(summary.test_audit_path),
        });
      }
      if (cycle.metric_value !== null)
        dashboardByIteration.set(cycle.outer_iteration, cycle.metric_value);
    }
    if (runtime.stop_decision_ref === null)
      failA1("STOP_DECISION_REQUIRED", "ARL result requires a saved terminal stop decision");
    const latest = runtime.cycle_history.at(-1);
    if (!latest) failA1("OUTER_CYCLE_REQUIRED", "stop decision has no cycle");
    const decision = readWorkflowStopDecision(projectRoot, input.run_id, latest.outer_iteration);
    if (decision.reason === "target_reached") terminationReason = "metric_met";
    else if (decision.reason === "iteration_cap") terminationReason = "iteration_cap";
    else if (decision.reason === "no_proposal") terminationReason = "no_proposal";
    // A failed run has no termination reason; its failure says why it ended.
    else if (decision.reason !== "bridge_failed")
      failA1("STOP_DECISION_REQUIRED", "ARL result requires a terminal stop decision");
  } else {
    const dashboard = readDashboardMetric(projectRoot, input.run_id);
    const persistedDashboard = readStateFile<Record<string, unknown>>(
      runOwnedPath(projectRoot, input.run_id, "dashboard.json"),
    );
    direction = dashboard.direction;
    if (persistedDashboard.tester_facility_sha256 !== undefined) {
      requireRecordedAssessment = true;
      for (const assessment of (persistedDashboard.tested_iterations ?? []) as Array<{
        iteration: number;
        result_path: string;
        audit_path: string;
      }>)
        assessments.set(assessment.iteration, {
          result_path: path.resolve(assessment.result_path),
          audit_path: path.resolve(assessment.audit_path),
        });
    }
    dashboardByIteration = new Map(dashboard.history.map((entry) => [entry.iter, entry.value]));
    if (persistedDashboard.outcome === "no_proposal") terminationReason = "no_proposal";
    else if (
      persistedDashboard.stop_reason === "metric_met" ||
      persistedDashboard.stop_reason === "iteration_cap"
    )
      terminationReason = persistedDashboard.stop_reason;
  }
  const selected = allCandidates.filter((candidate) => {
    const assessment = assessments.get(candidate.iteration);
    if (assessment === undefined) return !requireRecordedAssessment;
    return (
      candidate.test_result_path !== undefined &&
      candidate.test_audit_path !== undefined &&
      path.resolve(candidate.test_result_path) === assessment.result_path &&
      path.resolve(candidate.test_audit_path) === assessment.audit_path
    );
  });
  if (!selected.length)
    failA1(
      "TESTER_RESULT_BINDING_MISMATCH",
      "Wiki has no experiment matching the completed assessment",
    );
  const iterations = selected.map((candidate) => candidate.iteration);
  if (new Set(iterations).size !== iterations.length)
    failA1(
      "DUPLICATE_ID",
      "two experiment pages claim the same completed assessment",
      "result_export.wiki_root",
    );
  const candidates = selected.map((candidate) => ({
    ...candidate,
    gate_metric: reconcileGateMetric(candidate, dashboardByIteration, "result_export.wiki_root"),
  }));

  const tester = readPrimaries(input, candidates);
  // Once any iteration has been judged by the tester, the unjudged ones are not
  // in the running: they have no reading on the evidence that decides first.
  const eligible = tester === null ? candidates : tester.judged;
  const ranked = rankCandidates(eligible, tester === null ? null : tester.declared, direction);
  const winner = ranked[0]!;
  if (frozen?.mode === "auto_research_loop" && winner.tester_metrics === null)
    failA1(
      "TESTER_AUDIT_REQUIRED",
      "ARL exports require an audited experiment and its tested deliverables",
    );
  const deliverables =
    winner.tester_metrics === null
      ? null
      : verifyTesterDeliverables(projectRoot, input.run_id, winner.artifact!, winner.deliverables);

  const localMetrics: Record<string, number> = {};
  for (const [name, value] of Object.entries(winner.tester_metrics ?? {}))
    // Prefix benchmark metric names to distinguish them from the gate metric.
    localMetrics[`primary.${name}`] = value;
  if (winner.gate_metric !== null) localMetrics.metric_gate = winner.gate_metric;
  localMetrics.winning_iteration = winner.iteration;

  // An orchestration run's result stands on the children it dispatched, so the
  // package names them. The list is read back from the current generation
  // rather than accumulated as the children finish: a position that was
  // re-dispatched in a later generation is represented by the run that
  // actually holds it now.
  const childSummaries = hasDecomposition(projectRoot, input.run_id)
    ? roundChildSummaries(
        collectOrchestrationRound({ project_root: projectRoot, parent_run_id: input.run_id }),
      )
    : frozen?.mode === "auto_research_loop"
      ? contract.child_run_ids.map((childId) => {
          if (!fs.existsSync(resultPackagePath(projectRoot, childId)))
            failA1("CHILD_RESULT_REQUIRED", `child ${childId} has no reviewed result package`);
          const child = readResultPackage(projectRoot, childId);
          if (child.parent_run_id !== input.run_id)
            failA1("IDENTITY_MISMATCH", "child result names a different parent");
          return { run_id: childId, status: child.status, summary_sha256: child.summary_sha256 };
        })
      : [];

  const head = eventLogHead(readWikiEvents(wikiRoot));
  const resultInput: ResultPackageInput = {
    run_id: input.run_id,
    parent_run_id: contract.parent_run_id,
    scope_path: contract.scope_path,
    status: failure === null ? (input.status ?? "succeeded") : "failed",
    ...(terminationReason === undefined ? {} : { termination_reason: terminationReason }),
    ...(failure === null ? {} : { failure }),
    input_snapshot_sha256: contract.identity_material.input_snapshot_sha256,
    ...(deliverables === null
      ? {}
      : {
          output_hashes: deliverables.output_hashes,
          execution_plan_ref: deliverables.execution_plan_ref ?? null,
          interface_record_ref: deliverables.interface_record_ref ?? null,
        }),
    best_idea_ref: winner.idea_id,
    evidence_refs: [`experiment:${winner.page_id}`],
    local_metrics: localMetrics,
    wiki_head_ref: head.event_id,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(childSummaries.length === 0 ? {} : { child_summaries: childSummaries }),
  };
  const built = buildResultPackageForRun(projectRoot, input.run_id, resultInput);
  return { candidate: built.package, result_input: resultInput, winner, ranked };
}

export function exportResultPackage(input: ResultExportInput): ResultExport {
  const plan = planResultExport(input);
  const resultPackage = saveResultPackage(
    path.resolve(input.project_root),
    input.run_id,
    plan.result_input,
    input.review,
  );
  return { result_package: resultPackage, winner: plan.winner, ranked: plan.ranked };
}
