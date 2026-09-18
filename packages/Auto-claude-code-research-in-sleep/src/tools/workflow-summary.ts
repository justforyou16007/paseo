import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, writeStateJsonAtomic } from "./state-file.js";
import {
  readWorkflowRuntimeState,
  type OuterBudgetCategory,
  type OuterCycleSummary,
  type OuterChildRecord,
  type WorkflowRuntimeState,
} from "./workflow-state.js";
import { runDirectory } from "./workflow-state.js";
import {
  assertIdentifier,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
} from "./workflow-spec.js";
import { readScorerRunState } from "./scorer-state.js";
import { readTesterRunState } from "./tester-state.js";
import { validateCandidateSnapshot } from "./workflow-compiler.js";

export interface WorkflowSummaryInput {
  project_root: string;
  outer_run_id: string;
}

export interface CandidateLineageSummary {
  candidate_id: string;
  outer_iteration: number;
  generation: number;
  workflow_revision: string;
  parent_candidate_id: string | null;
  module_versions: Array<{ module_id: string; version: string; patch_sha256: string | null }>;
  source: "compiled" | "runtime-only";
}

export interface BudgetSummaryView {
  category: OuterBudgetCategory;
  unit: string;
  reserved: number;
  settled: number;
  released: number;
  active: number;
}

export interface ScorerRunSummary {
  scorer_run_id: string;
  scorer_id: string;
  outer_iteration: number;
  wave_id: string;
  status: string;
  parent_revision: string;
  candidate_revision: string;
  active_parent_revision: string;
  active_revision: string | null;
  review_id: string | null;
  parent_sealed: boolean;
  candidate_sealed: boolean;
  parent_result_sha256: string | null;
  candidate_result_sha256: string | null;
}

/** Public tester view. It intentionally contains no cases, observations, or private result URI. */
export interface TesterRunSummary {
  tester_run_id: string;
  outer_iteration: number;
  wave_id: string;
  status: string;
  promotion_trial_id: string;
  tester_id: string;
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  gate_consumed: boolean;
  gate_status: "passed" | "rejected" | null;
}

export interface WorkflowSummary {
  schema_version: 1;
  outer_run_id: string;
  task_id: string;
  workflow_id: string;
  status: WorkflowRuntimeState["status"];
  current_phase: WorkflowRuntimeState["current_phase"];
  outer_iteration: number;
  generation: number;
  active_cycle: WorkflowRuntimeState["active_cycle"];
  cycle_history: OuterCycleSummary[];
  children: Array<
    Pick<
      OuterChildRecord,
      "child_run_id" | "kind" | "outer_iteration" | "generation" | "status" | "terminal_at"
    >
  >;
  candidate_lineage: CandidateLineageSummary[];
  budgets: BudgetSummaryView[];
  scorer_runs: ScorerRunSummary[];
  tester_runs: TesterRunSummary[];
  summary_sha256: string;
  generated_at: string;
}

function summaryPath(projectRoot: string, outerRunId: string): string {
  return path.join(runDirectory(projectRoot, outerRunId), "workflow-summary.json");
}

function candidatePath(projectRoot: string, outerRunId: string, candidateId: string): string {
  return path.join(
    runDirectory(projectRoot, outerRunId),
    "compiled",
    assertIdentifier(candidateId, "candidate_id"),
    "candidate.json",
  );
}

function candidateLineage(
  projectRoot: string,
  outerRunId: string,
  state: WorkflowRuntimeState,
): CandidateLineageSummary[] {
  const seen = new Set<string>();
  const entries: CandidateLineageSummary[] = [];
  for (const cycle of state.cycle_history) {
    for (const candidateId of cycle.candidate_ids) {
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      const filePath = candidatePath(projectRoot, outerRunId, candidateId);
      if (!fs.existsSync(filePath)) {
        entries.push({
          candidate_id: candidateId,
          outer_iteration: cycle.outer_iteration,
          generation: cycle.generation,
          workflow_revision: "unknown",
          parent_candidate_id: null,
          module_versions: [],
          source: "runtime-only",
        });
        continue;
      }
      const candidate = validateCandidateSnapshot(readStateFile(filePath));
      entries.push({
        candidate_id: candidateId,
        outer_iteration: cycle.outer_iteration,
        generation: cycle.generation,
        workflow_revision: candidate.workflow_revision,
        parent_candidate_id: candidate.parent_candidate_id,
        module_versions: candidate.module_versions.map((module) => ({
          module_id: module.module_id,
          version: module.version,
          patch_sha256: module.patch_sha256 ?? null,
        })),
        source: "compiled",
      });
    }
  }
  return entries.sort((left, right) => {
    if (left.outer_iteration !== right.outer_iteration)
      return left.outer_iteration - right.outer_iteration;
    return left.candidate_id < right.candidate_id
      ? -1
      : left.candidate_id > right.candidate_id
        ? 1
        : 0;
  });
}

function budgetViews(state: WorkflowRuntimeState): BudgetSummaryView[] {
  const grouped = new Map<string, BudgetSummaryView>();
  for (const budget of state.budgets) {
    const key = `${budget.category}\u0000${budget.unit}`;
    const current = grouped.get(key) ?? {
      category: budget.category,
      unit: budget.unit,
      reserved: 0,
      settled: 0,
      released: 0,
      active: 0,
    };
    current.reserved += budget.amount;
    if (budget.status === "settled") current.settled += budget.amount;
    else if (budget.status === "released") current.released += budget.amount;
    else current.active += budget.amount;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    compareIdentityStrings(
      `${left.category}\u0000${left.unit}`,
      `${right.category}\u0000${right.unit}`,
    ),
  );
}

function scorerViews(
  projectRoot: string,
  children: readonly OuterChildRecord[],
): ScorerRunSummary[] {
  return children
    .filter((child) => child.kind === "scorer")
    .map((child) => {
      const state = readScorerRunState(projectRoot, child.child_run_id);
      return {
        scorer_run_id: state.scorer_run_id,
        scorer_id: state.scorer_id,
        outer_iteration: state.outer_iteration,
        wave_id: state.wave_id,
        status: state.status,
        parent_revision: state.parent_revision,
        candidate_revision: state.candidate_revision,
        active_parent_revision: state.active_parent_revision,
        active_revision: state.active_revision,
        review_id: state.review_id,
        parent_sealed: state.parent_sealed,
        candidate_sealed: state.candidate_sealed,
        parent_result_sha256: state.parent_result_sha256,
        candidate_result_sha256: state.candidate_result_sha256,
      };
    })
    .sort((left, right) => (left.scorer_run_id < right.scorer_run_id ? -1 : 1));
}

function testerViews(
  projectRoot: string,
  children: readonly OuterChildRecord[],
): TesterRunSummary[] {
  return children
    .filter((child) => child.kind === "tester")
    .map((child) => {
      const state = readTesterRunState(projectRoot, child.child_run_id);
      return {
        tester_run_id: state.tester_run_id,
        outer_iteration: state.outer_iteration,
        wave_id: state.wave_id,
        status: state.status,
        promotion_trial_id: state.promotion_trial_id,
        tester_id: state.tester_id,
        tester_version: state.tester_version,
        tester_definition_sha256: state.tester_definition_sha256,
        harness_sha256: state.harness_sha256,
        case_manifest_sha256: state.case_manifest_sha256,
        seed_manifest_sha256: state.seed_manifest_sha256,
        gate_consumed: state.gate_consumed,
        gate_status: state.gate_status,
      };
    })
    .sort((left, right) => (left.tester_run_id < right.tester_run_id ? -1 : 1));
}

function publicBase(
  projectRoot: string,
  outerRunId: string,
): Omit<WorkflowSummary, "summary_sha256" | "generated_at"> {
  const state = readWorkflowRuntimeState(projectRoot, outerRunId);
  return {
    schema_version: 1,
    outer_run_id: state.outer_run_id,
    task_id: state.task_id,
    workflow_id: state.workflow_id,
    status: state.status,
    current_phase: state.current_phase,
    outer_iteration: state.outer_iteration,
    generation: state.generation,
    active_cycle: state.active_cycle,
    cycle_history: state.cycle_history,
    children: state.children.map((child) => ({
      child_run_id: child.child_run_id,
      kind: child.kind,
      outer_iteration: child.outer_iteration,
      generation: child.generation,
      status: child.status,
      terminal_at: child.terminal_at,
    })),
    candidate_lineage: candidateLineage(projectRoot, outerRunId, state),
    budgets: budgetViews(state),
    scorer_runs: scorerViews(projectRoot, state.children),
    tester_runs: testerViews(projectRoot, state.children),
  };
}

export function buildWorkflowSummary(input: WorkflowSummaryInput): WorkflowSummary {
  const base = publicBase(input.project_root, input.outer_run_id);
  const summarySha256 = canonicalJsonSha256(base, undefined, {
    schemaVersion: "workflow-summary-v1",
  });
  return { ...base, summary_sha256: summarySha256, generated_at: new Date().toISOString() };
}

export function writeWorkflowSummary(input: WorkflowSummaryInput): WorkflowSummary {
  const summary = buildWorkflowSummary(input);
  const filePath = summaryPath(input.project_root, input.outer_run_id);
  writeStateJsonAtomic(filePath, summary);
  return summary;
}

export function readWorkflowSummary(input: WorkflowSummaryInput): WorkflowSummary {
  const filePath = summaryPath(input.project_root, input.outer_run_id);
  if (!fs.existsSync(filePath)) return writeWorkflowSummary(input);
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_WORKFLOW_SUMMARY", "workflow summary must be an object", filePath);
  const supplied = assertSha256(value.summary_sha256, `${filePath}.summary_sha256`);
  const copy = { ...value } as Record<string, unknown>;
  delete copy.summary_sha256;
  delete copy.generated_at;
  const expected = canonicalJsonSha256(copy, undefined, { schemaVersion: "workflow-summary-v1" });
  if (supplied !== expected)
    failA1("CORRUPT_WORKFLOW_SUMMARY", "workflow summary hash does not match", filePath);
  if (value.outer_run_id !== input.outer_run_id)
    failA1("IDENTITY_MISMATCH", "workflow summary run id differs", filePath);
  const rebuilt = buildWorkflowSummary(input);
  if (supplied !== rebuilt.summary_sha256) {
    writeStateJsonAtomic(filePath, rebuilt);
    return rebuilt;
  }
  return value as unknown as WorkflowSummary;
}

export function workflowSummaryPath(projectRoot: string, outerRunId: string): string {
  return summaryPath(projectRoot, outerRunId);
}
