import { runBudgetExhausted, settleExecutionReceipt } from "./run-budget.js";
import { runOwnedPath } from "./run-contract.js";
import { assertOuterWikiScope, assertResearchVisible } from "./wiki-scope.js";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createCli, runCli } from "../lib/cli.js";

// metric-gate - the deterministic metric configuration + stop-gate evaluator
// for /auto-research-loop.
//
// Two responsibilities, both pure dashboard/CLAUDE.md arithmetic (Type-A):
//   config   <root>        parse + validate the `## Metric Target` block in
//                          CLAUDE.md. Rejects HTML-commented template blocks,
//                          non-finite numbers, invalid directions, and
//                          out-of-bounds tolerance. Prints JSON on success.
//   evaluate <root> <run>  read the run's dashboard.json and decide whether
//                          the iteration loop stops. The decision is a pure
//                          function of the dashboard's metric fields, so
//                          re-running it (resume, crash, retry) always yields
//                          the same answer - patience is DERIVED from
//                          metric.history, never accumulated.
//
// Stop reasons are mutually exclusive; the first match in this priority
// order wins: invalid_metric > metric_met > budget_exhausted >
// patience_exhausted > iteration_cap. Quality verdicts (auto-review-loop's
// ready/almost) are recorded on the dashboard but never participate in this
// decision - they end the current idea's review rounds, not the research loop.
//
// A round count is not a stop criterion. What a run is allowed to spend is its
// budget ledger, and what it has to reach is its metric target; `budget_exhausted`
// means the ledger cannot fund another reservation, never `iteration >= N`.
// `config.max_iterations` is an optional backstop for a run whose budget is
// large enough that a non-terminating loop would burn it all before anyone
// looks: omit it and there is no round limit at all, set it and it fires last,
// after every criterion that carries meaning about the research itself.

const DIRECTIONS = new Set(["higher_better", "lower_better"]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MetricConfig {
  configured: true;
  name: string | null;
  target: number;
  direction: "higher_better" | "lower_better";
  tolerance: number;
  baseline: number | null;
}

export interface ModuleMetricConfig extends MetricConfig {
  module_id: string;
  patience: number;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// `## Metric Target` parsing
// ---------------------------------------------------------------------------

function extractSection(claudeMd: string): string {
  const lines = claudeMd.split("\n");
  const start = lines.findIndex((l) => /^##\s+Metric\s+Target\s*$/.test(l));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// Strip HTML comment spans (`<!-- ... -->`, possibly multiline). The shipped
// template ships the block commented out; a commented block is NOT a
// configured metric - parsing it would silently adopt the example values.
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

// Reading the `## Metric Target` block has two callers with opposite needs. The
// `config` CLI must die on anything unusable - /auto-research-loop cannot run on
// a half-filled target. /aris-setup's status report must do the opposite: say
// "metric_target: not ready", name the reason, and keep checking the remaining
// stages. So the reader reports why it could not produce a config and lets the
// caller choose; `parseMetricConfig` is the fatal wrapper the CLI keeps using.
export type MetricConfigRead =
  | { status: "ok"; config: MetricConfig }
  | { status: "missing_file"; reason: string }
  | { status: "not_configured"; reason: string }
  | { status: "invalid"; reason: string };

export function readMetricConfig(root: string): MetricConfigRead {
  const claudePath = path.join(root, "CLAUDE.md");
  if (!fs.existsSync(claudePath)) {
    return {
      status: "missing_file",
      reason: `no CLAUDE.md at ${claudePath} - /auto-research-loop requires a '## Metric Target' block`,
    };
  }
  const section = stripHtmlComments(extractSection(fs.readFileSync(claudePath, "utf-8")));
  if (section.trim() === "") {
    // absent or fully commented out -> not configured
    return {
      status: "not_configured",
      reason: "'## Metric Target' is absent from CLAUDE.md or fully commented out",
    };
  }

  const values = new Map<string, string>();
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    // strip trailing `# comment`
    values.set(m[1], m[2].replace(/\s+#.*$/, "").trim());
  }

  const primary = values.get("primary");
  if (primary === undefined || primary === "") {
    return {
      status: "invalid",
      reason:
        "'## Metric Target' has no active 'primary: <number> <unit>' line (a commented-out template block does not count)",
    };
  }
  const parts = primary.split(/\s+/);
  const target = Number(parts[0].trim());
  if (!Number.isFinite(target)) {
    return {
      status: "invalid",
      reason: `Metric Target 'primary' is not a finite number: '${parts[0].trim()}'`,
    };
  }
  const name = parts.slice(1).join(" ") || null;

  const directionRaw = values.get("direction") || "higher_better";
  if (!DIRECTIONS.has(directionRaw)) {
    return {
      status: "invalid",
      reason: `Metric Target 'direction' must be higher_better or lower_better, got '${directionRaw}'`,
    };
  }
  const direction = directionRaw as MetricConfig["direction"];

  const toleranceRaw = values.get("tolerance");
  let tolerance = 0.01;
  if (toleranceRaw !== undefined && toleranceRaw !== "") {
    tolerance = Number(toleranceRaw.trim());
    if (!Number.isFinite(tolerance)) {
      return {
        status: "invalid",
        reason: `Metric Target 'tolerance' is not a finite number: '${toleranceRaw.trim()}'`,
      };
    }
    if (tolerance < 0 || tolerance >= 1) {
      return {
        status: "invalid",
        reason: `Metric Target 'tolerance' must be in [0, 1), got ${tolerance}`,
      };
    }
  }

  const baselineRaw = values.get("baseline");
  let baseline: number | null = null;
  if (baselineRaw !== undefined && baselineRaw !== "" && baselineRaw !== '""') {
    baseline = Number(baselineRaw.trim());
    if (!Number.isFinite(baseline)) {
      return {
        status: "invalid",
        reason: `Metric Target 'baseline' is not a finite number: '${baselineRaw.trim()}'`,
      };
    }
  }

  return {
    status: "ok",
    config: { configured: true, name, target, direction, tolerance, baseline },
  };
}

function parseMetricConfig(root: string): MetricConfig | null {
  const read = readMetricConfig(root);
  if (read.status === "missing_file" || read.status === "invalid") {
    fail(read.reason);
  }
  return read.status === "ok" ? read.config : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${location} has unknown field '${key}'`);
  }
}

function requiredFiniteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${location} must be a finite number`);
  }
  return value;
}

function requiredNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

export function parseModuleMetricConfig(
  metricPath: string,
  expectedModuleId?: string,
): ModuleMetricConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metricPath, "utf-8"));
  } catch (error: unknown) {
    throw new Error(
      `cannot read module metric file ${metricPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(raw)) throw new Error(`module metric at ${metricPath} must be a JSON object`);
  assertExactKeys(raw, ["schema_version", "module_id", "primary", "patience"], metricPath);
  if (raw.schema_version !== 1) throw new Error(`${metricPath}.schema_version must be 1`);
  const moduleId = requiredNonEmptyString(raw.module_id, `${metricPath}.module_id`);
  if (!RUN_ID_PATTERN.test(moduleId))
    throw new Error(`${metricPath}.module_id is not a valid identifier`);
  if (expectedModuleId !== undefined && moduleId !== expectedModuleId) {
    throw new Error(
      `module metric module_id '${moduleId}' does not match dashboard module_id '${expectedModuleId}'`,
    );
  }
  if (!isObject(raw.primary)) throw new Error(`${metricPath}.primary must be an object`);
  assertExactKeys(
    raw.primary,
    ["name", "target", "direction", "tolerance", "baseline"],
    `${metricPath}.primary`,
  );
  const name = requiredNonEmptyString(raw.primary.name, `${metricPath}.primary.name`);
  const target = requiredFiniteNumber(raw.primary.target, `${metricPath}.primary.target`);
  const direction = raw.primary.direction;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) {
    throw new Error(`${metricPath}.primary.direction must be higher_better or lower_better`);
  }
  const tolerance = requiredFiniteNumber(raw.primary.tolerance, `${metricPath}.primary.tolerance`);
  if (tolerance < 0 || tolerance >= 1) {
    throw new Error(`${metricPath}.primary.tolerance must be in [0, 1)`);
  }
  const baseline = requiredFiniteNumber(raw.primary.baseline, `${metricPath}.primary.baseline`);
  if (typeof raw.patience !== "number" || !Number.isInteger(raw.patience) || raw.patience < 1) {
    throw new Error(`${metricPath}.patience must be a positive integer`);
  }
  return {
    configured: true,
    module_id: moduleId,
    name,
    target,
    direction: direction as MetricConfig["direction"],
    tolerance,
    baseline,
    patience: raw.patience,
  };
}

function resolveMetricPath(
  root: string,
  positional: string | undefined,
  optionPath: string | undefined,
): string | undefined {
  if (positional !== undefined && optionPath !== undefined) {
    throw new Error(
      "provide module-metric.json either as a positional path or --module-metric, not both",
    );
  }
  const value = optionPath ?? positional;
  if (value === undefined) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function selectMetricOption(
  moduleMetric: string | undefined,
  metricFile: string | undefined,
): string | undefined {
  if (moduleMetric !== undefined && metricFile !== undefined) {
    throw new Error("provide only one of --module-metric and --metric-file");
  }
  return moduleMetric ?? metricFile;
}

// ---------------------------------------------------------------------------
// Stop-gate evaluation
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  iter: number;
  value: number;
}

interface Decision {
  stop_reason:
    | "metric_met"
    | "budget_exhausted"
    | "patience_exhausted"
    | "iteration_cap"
    | "invalid_metric"
    | null;
  metric_met: boolean;
  current: number | null;
  target: number;
  direction: "higher_better" | "lower_better";
  tolerance: number;
  threshold: number;
  iteration: number;

  no_progress_streak: number;
  patience: number;
  /** null when the run set no backstop, which is the default. */
  max_iterations: number | null;
  invalid_reason?: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBetter(candidate: number, incumbent: number, direction: string): boolean {
  return direction === "lower_better" ? candidate < incumbent : candidate > incumbent;
}

// Trailing count of history entries that did not improve on the best value
// seen before them. Derived from history alone - no counter to double-count
// across a crash + resume.
//
// The incumbent is seeded from `metric.baseline` when it is anchored, because
// the baseline is the value a run has to beat: without it, a run whose every
// iteration sits far below its own baseline still scores streak 0 as long as
// each iteration edges past the previous one, and burns the whole budget. When
// the baseline is anchored, iteration 1 is the reproduction that produced it,
// not a challenger, so it does not count against patience.
function noProgressStreak(
  history: HistoryEntry[],
  direction: string,
  baseline: number | null,
): number {
  const hasBaseline = isFiniteNumber(baseline);
  // One entry per iteration: duplicate rows in damaged or hand-edited state
  // must not count as extra no-progress rounds. Last occurrence wins.
  const byIter = new Map<number, HistoryEntry>();
  for (const e of history) byIter.set(e.iter, e);
  const entries = [...byIter.values()]
    .sort((a, b) => a.iter - b.iter)
    .filter((e) => !hasBaseline || e.iter > 1);
  let best: number | null = hasBaseline ? baseline : null;
  let streak = 0;
  for (const e of entries) {
    if (best === null || isBetter(e.value, best, direction)) {
      best = e.value;
      streak = 0;
    } else {
      streak += 1;
    }
  }
  return streak;
}

function invalidMetricDecision(reason: string): Decision {
  console.error(`warning: ${reason}`);
  return {
    stop_reason: "invalid_metric",
    metric_met: false,
    current: null,
    target: 0,
    direction: "higher_better",
    tolerance: 0,
    threshold: 0,
    iteration: 0,

    no_progress_streak: 0,
    patience: 0,
    max_iterations: null,
    invalid_reason: reason,
  };
}

function dashboardPath(root: string, runId: string): string {
  return runOwnedPath(root, runId, "dashboard.json");
}

export interface DashboardMetricRecord {
  direction: "higher_better" | "lower_better";
  /** One reading per outer iteration, in the order the loop appended them. */
  history: HistoryEntry[];
}

/**
 * The dashboard's per-iteration readings, for callers that need the series
 * rather than the stop decision. `evaluateDashboard` answers "should the loop
 * stop now"; this answers "what did iteration N measure". It throws instead of
 * exiting, because its callers are libraries rather than the gate CLI.
 */
export function readDashboardMetric(root: string, runId: string): DashboardMetricRecord {
  const dashPath = dashboardPath(root, runId);
  if (!fs.existsSync(dashPath)) throw new Error(`DASHBOARD_NOT_FOUND: ${dashPath}`);
  const dash = JSON.parse(fs.readFileSync(dashPath, "utf-8")) as Record<string, unknown>;
  assertResearchVisible(dash);
  const metric = (dash.metric ?? {}) as Record<string, unknown>;
  const direction = metric.direction;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction))
    throw new Error("INVALID_DASHBOARD_METRIC: metric.direction is missing or unknown");
  const history: HistoryEntry[] = [];
  for (const entry of Array.isArray(metric.history) ? (metric.history as unknown[]) : []) {
    const row = entry as Record<string, unknown>;
    if (!Number.isInteger(row?.iter) || !isFiniteNumber(row?.value))
      throw new Error(`INVALID_DASHBOARD_METRIC: malformed history entry ${JSON.stringify(entry)}`);
    history.push({ iter: row.iter as number, value: row.value as number });
  }
  return { direction: direction as DashboardMetricRecord["direction"], history };
}

export function evaluateDashboard(
  root: string,
  runId: string,
  moduleMetricPath?: string,
): Decision {
  const dashPath = dashboardPath(root, runId);
  if (!fs.existsSync(dashPath)) {
    fail(`no dashboard at ${dashPath}`);
  }
  let dash: Record<string, unknown>;
  try {
    dash = JSON.parse(fs.readFileSync(dashPath, "utf-8"));
  } catch (err) {
    fail(`corrupt dashboard at ${dashPath}: ${err}`);
  }

  assertResearchVisible(dash);
  const dashboardModuleId =
    typeof dash.module_id === "string"
      ? dash.module_id
      : typeof dash.module === "string"
        ? dash.module
        : undefined;
  const workflowMode =
    dash.workflow_mode === true ||
    dash.run_kind === "module" ||
    dash.mode === "workflow" ||
    dash.mode === "module" ||
    dashboardModuleId !== undefined ||
    typeof dash.workflow_id === "string";
  if (workflowMode && (dash.scope === "standalone" || dash.allow_standalone === true)) {
    throw new Error("STANDALONE_OUTER_DECISION_FORBIDDEN");
  }
  if (workflowMode && dash.wiki_scope !== undefined) {
    if (typeof dash.wiki_scope !== "string") throw new Error("INVALID_WIKI_SCOPE");
    assertOuterWikiScope(dash.wiki_scope, dash.allow_standalone === true);
  }
  if (workflowMode && moduleMetricPath === undefined) {
    fail("workflow/module mode requires an explicit module-metric.json input");
  }
  const moduleMetric =
    moduleMetricPath === undefined
      ? undefined
      : parseModuleMetricConfig(moduleMetricPath, dashboardModuleId);

  // Malformed metric fields → invalid_metric JSON (not exit 1).
  // The orchestrator reads stop_reason from the JSON and handles it
  // deterministically. Crashing would leave the loop in a limbo state.
  const metric = (dash.metric ?? {}) as Record<string, unknown>;
  const direction = moduleMetric?.direction ?? metric.direction;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) {
    return invalidMetricDecision(
      `dashboard metric.direction must be higher_better or lower_better, got '${String(direction)}'`,
    );
  }
  const targetValue = moduleMetric?.target ?? metric.target;
  if (!isFiniteNumber(targetValue)) {
    return invalidMetricDecision("dashboard metric.target is not a finite number");
  }
  const toleranceValue = moduleMetric?.tolerance ?? metric.tolerance;
  if (!isFiniteNumber(toleranceValue) || toleranceValue < 0 || toleranceValue >= 1) {
    return invalidMetricDecision(
      `dashboard metric.tolerance must be a finite number in [0, 1), got '${String(toleranceValue)}'`,
    );
  }
  const target = targetValue as number;
  const tolerance = toleranceValue;
  // Use abs(target) so the band works correctly when target is negative
  // (e.g. a loss of -2.5 with tolerance 0.01 should allow -2.525 for lower_better).
  const band = Math.abs(target) * tolerance;
  const threshold = direction === "lower_better" ? target + band : target - band;

  const iteration = dash.iteration;

  if (!Number.isInteger(iteration) || (iteration as number) < 1) {
    return invalidMetricDecision(
      `dashboard.iteration must be an integer >= 1, got '${String(iteration)}'`,
    );
  }

  const config = (dash.config ?? {}) as Record<string, unknown>;
  const patience = moduleMetric?.patience ?? config.patience ?? 2;
  if (!Number.isInteger(patience) || (patience as number) < 1) {
    return invalidMetricDecision(
      `dashboard.config.patience must be an integer >= 1, got '${String(patience)}'`,
    );
  }

  // Optional. `undefined` and `null` both mean "no round limit"; anything else
  // has to be a usable count, because a malformed backstop that silently does
  // nothing is worse than no backstop.
  const maxIterationsRaw = config.max_iterations;
  let maxIterations: number | null = null;
  if (maxIterationsRaw !== undefined && maxIterationsRaw !== null) {
    if (!Number.isInteger(maxIterationsRaw) || (maxIterationsRaw as number) < 1) {
      return invalidMetricDecision(
        `dashboard.config.max_iterations must be an integer >= 1 when set, got '${String(maxIterationsRaw)}'`,
      );
    }
    maxIterations = maxIterationsRaw as number;
  }

  const historyRaw = Array.isArray(metric.history) ? (metric.history as unknown[]) : [];
  const history: HistoryEntry[] = [];
  for (const h of historyRaw) {
    const entry = h as Record<string, unknown>;
    if (!Number.isInteger(entry?.iter) || !isFiniteNumber(entry?.value)) {
      return invalidMetricDecision(
        `dashboard metric.history has a non-finite or malformed entry: ${JSON.stringify(h)}`,
      );
    }
    history.push({ iter: entry.iter as number, value: entry.value as number });
  }

  const current = metric.current;
  const baselineValue = moduleMetric?.baseline ?? metric.baseline;
  const baseline = isFiniteNumber(baselineValue) ? baselineValue : null;
  let stopReason: Decision["stop_reason"] = null;
  if (!isFiniteNumber(current)) {
    stopReason = "invalid_metric";
  } else if (direction === "lower_better" ? current <= threshold : current >= threshold) {
    stopReason = "metric_met";
  } else if (runBudgetExhausted(root, runId)) {
    stopReason = "budget_exhausted";
  } else {
    const streak = noProgressStreak(history, direction, baseline);
    if (streak >= (patience as number)) {
      stopReason = "patience_exhausted";
    } else if (maxIterations !== null && (iteration as number) >= maxIterations) {
      stopReason = "iteration_cap";
    }
  }

  const streak = noProgressStreak(history, direction, baseline);
  return {
    stop_reason: stopReason,
    metric_met:
      isFiniteNumber(current) &&
      (direction === "lower_better" ? current <= threshold : current >= threshold),
    current: isFiniteNumber(current) ? current : null,
    target,
    direction: direction as Decision["direction"],
    tolerance,
    threshold,
    iteration: iteration as number,

    no_progress_streak: streak,
    patience: patience as number,
    max_iterations: maxIterations,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = createCli(
  "metric-gate",
  "Metric Target config parsing + deterministic stop-gate evaluation.",
);

program
  .command("config")
  .argument("<root>", "project root (contains CLAUDE.md)")
  .argument("[module_metric]", "explicit module-metric.json path")
  .option("--module-metric <path>", "explicit module-metric.json path")
  .option("--metric-file <path>", "alias for --module-metric")
  .action(
    (
      root: string,
      positional: string | undefined,
      options: { moduleMetric?: string; metricFile?: string },
    ) => {
      const rootPath = path.resolve(root);
      const explicitPath = resolveMetricPath(
        rootPath,
        positional,
        selectMetricOption(options.moduleMetric, options.metricFile),
      );
      const cfg = explicitPath
        ? parseModuleMetricConfig(explicitPath)
        : parseMetricConfig(rootPath);
      if (cfg === null) {
        fail(
          "'## Metric Target' is not configured in CLAUDE.md. " +
            "Uncomment the block from templates/CLAUDE_MD_TEMPLATE.md and fill in " +
            "'primary: <number> <unit>'. A commented-out template block is not a configuration.",
        );
      }
      console.log(JSON.stringify(cfg));
    },
  );

program
  .command("evaluate")
  .argument("<root>", "project root")
  .argument("<run_id>", "run id (dashboard at .aris/runs/<run_id>/dashboard.json)")
  .argument("[module_metric]", "explicit module-metric.json path")
  .option("--module-metric <path>", "explicit module-metric.json path")
  .option("--metric-file <path>", "alias for --module-metric")
  .action(
    (
      root: string,
      runId: string,
      positional: string | undefined,
      options: { moduleMetric?: string; metricFile?: string },
    ) => {
      const rootPath = path.resolve(root);
      const explicitPath = resolveMetricPath(
        rootPath,
        positional,
        selectMetricOption(options.moduleMetric, options.metricFile),
      );
      const decision = evaluateDashboard(rootPath, runId, explicitPath);
      const dashPath = dashboardPath(rootPath, runId);
      const dash = JSON.parse(fs.readFileSync(dashPath, "utf-8"));
      const nextStop = decision.stop_reason;
      const changed = dash.stop_reason !== nextStop;
      if (changed) {
        dash.stop_reason = nextStop;
        dash.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        const tmp = `${dashPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(dash, null, 2)}\n`, "utf-8");
        fs.renameSync(tmp, dashPath);
      }
      console.log(JSON.stringify({ ...decision, persisted: changed }));
    },
  );

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(program);
}
