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
import path from "node:path";
import { readDashboardMetric } from "./metric-gate.js";
import {
  buildResultPackageForRun,
  saveResultPackage,
  type ResultPackage,
  type ResultPackageInput,
  type ResultPackageReview,
  type ResultStatus,
} from "./result-package.js";
import { requireRunContract } from "./run-contract.js";
import { readStateFile } from "./state-file.js";
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
  winner: ExportCandidate;
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
  winner: ExportCandidate;
  ranked: ExportCandidate[];
}

function candidateFromPage(page: WikiPage): ExportCandidate | null {
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
  return {
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
  if (input.tester_definition_path === undefined)
    failA1(
      "TESTER_DEFINITION_REQUIRED",
      "the wiki records tester metrics, so the frozen tester definition is needed to rank by them",
      "result_export.tester_definition_path",
    );
  const definitionPath = path.resolve(input.project_root, input.tester_definition_path);
  if (!fs.existsSync(definitionPath))
    failA1(
      "TESTER_DEFINITION_NOT_FOUND",
      `tester definition does not exist at ${definitionPath}`,
      "result_export.tester_definition_path",
    );
  const definition = validateTesterDefinition(readStateFile(definitionPath));
  const declared = definition.gate.primaries;
  const declaredNames = declared.map((primary) => primary.name).sort();
  for (const candidate of judged) {
    // A page whose metrics came from a different tester version cannot be
    // compared against these ones, so the whole export stops rather than
    // silently ranking across two definitions.
    if (candidate.tester_definition_sha256 !== definition.definition_sha256)
      failA1(
        "TESTER_DEFINITION_MISMATCH",
        `experiment ${candidate.page_id} was judged by tester definition ${candidate.tester_definition_sha256 ?? "(none recorded)"}, not ${definition.definition_sha256}`,
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
  return { definition, declared, judged };
}

/** True when `left` is at least as good everywhere and strictly better once. */
function dominates(
  left: ExportCandidate,
  right: ExportCandidate,
  primaries: readonly TesterPrimaryMetric[],
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
  primaries: readonly TesterPrimaryMetric[] | null,
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
    .map(candidateFromPage)
    .filter((candidate): candidate is ExportCandidate => candidate !== null);
  if (allCandidates.length === 0)
    failA1(
      "NO_EXPORTABLE_EXPERIMENT",
      `wiki at ${wikiRoot} has no experiment page carrying an iteration`,
      "result_export.wiki_root",
    );
  const iterations = allCandidates.map((candidate) => candidate.iteration);
  if (new Set(iterations).size !== iterations.length)
    failA1(
      "DUPLICATE_ID",
      "two experiment pages claim the same iteration",
      "result_export.wiki_root",
    );

  const dashboard = readDashboardMetric(projectRoot, input.run_id);
  const dashboardByIteration = new Map(dashboard.history.map((entry) => [entry.iter, entry.value]));
  const candidates = allCandidates.map((candidate) => ({
    ...candidate,
    gate_metric: reconcileGateMetric(candidate, dashboardByIteration, "result_export.wiki_root"),
  }));

  const tester = readPrimaries(input, candidates);
  // Once any iteration has been judged by the tester, the unjudged ones are not
  // in the running: they have no reading on the evidence that decides first.
  const eligible = tester === null ? candidates : tester.judged;
  const ranked = rankCandidates(
    eligible,
    tester === null ? null : tester.declared,
    dashboard.direction,
  );
  const winner = ranked[0]!;

  const localMetrics: Record<string, number> = {};
  for (const [name, value] of Object.entries(winner.tester_metrics ?? {}))
    // Prefixed so a declared name that looks like private tester data
    // (`tester_scores`, say) cannot trip the private-key screen downstream.
    localMetrics[`primary.${name}`] = value;
  if (winner.gate_metric !== null) localMetrics.metric_gate = winner.gate_metric;
  localMetrics.winning_iteration = winner.iteration;

  const head = eventLogHead(readWikiEvents(wikiRoot));
  const resultInput: ResultPackageInput = {
    run_id: input.run_id,
    parent_run_id: contract.parent_run_id,
    scope_path: contract.scope_path,
    status: input.status ?? "succeeded",
    input_snapshot_sha256: contract.identity_material.input_snapshot_sha256,
    best_idea_ref: winner.idea_id,
    evidence_refs: [`experiment:${winner.page_id}`],
    local_metrics: localMetrics,
    wiki_head_ref: head.event_id,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
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
