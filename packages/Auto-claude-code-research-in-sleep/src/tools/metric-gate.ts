import fs from "fs";
import path from "path";
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
// patience_exhausted. Quality verdicts (auto-review-loop's ready/almost)
// are recorded on the dashboard but never participate in this decision -
// they end the current idea's review rounds, not the research loop.

const DIRECTIONS = new Set(["higher_better", "lower_better"]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface MetricConfig {
  configured: true;
  name: string | null;
  target: number;
  direction: "higher_better" | "lower_better";
  tolerance: number;
  baseline: number | null;
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

function parseNumber(raw: string, field: string): number {
  const v = Number(raw.trim());
  if (!Number.isFinite(v)) {
    fail(`Metric Target '${field}' is not a finite number: '${raw.trim()}'`);
  }
  return v;
}

function parseMetricConfig(root: string): MetricConfig | null {
  const claudePath = path.join(root, "CLAUDE.md");
  if (!fs.existsSync(claudePath)) {
    fail(`no CLAUDE.md at ${claudePath} - /auto-research-loop requires a '## Metric Target' block`);
  }
  const section = stripHtmlComments(extractSection(fs.readFileSync(claudePath, "utf-8")));
  if (section.trim() === "") {
    return null; // absent or fully commented out -> not configured
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
    fail(
      "'## Metric Target' has no active 'primary: <number> <unit>' line (a commented-out template block does not count)",
    );
  }
  const parts = primary.split(/\s+/);
  const target = parseNumber(parts[0], "primary");
  const name = parts.slice(1).join(" ") || null;

  const directionRaw = values.get("direction") || "higher_better";
  if (!DIRECTIONS.has(directionRaw)) {
    fail(`Metric Target 'direction' must be higher_better or lower_better, got '${directionRaw}'`);
  }
  const direction = directionRaw as MetricConfig["direction"];

  const toleranceRaw = values.get("tolerance");
  let tolerance = 0.01;
  if (toleranceRaw !== undefined && toleranceRaw !== "") {
    tolerance = parseNumber(toleranceRaw, "tolerance");
    if (tolerance < 0 || tolerance >= 1) {
      fail(`Metric Target 'tolerance' must be in [0, 1), got ${tolerance}`);
    }
  }

  const baselineRaw = values.get("baseline");
  let baseline: number | null = null;
  if (baselineRaw !== undefined && baselineRaw !== "" && baselineRaw !== '""') {
    baseline = parseNumber(baselineRaw, "baseline");
  }

  return { configured: true, name, target, direction, tolerance, baseline };
}

// ---------------------------------------------------------------------------
// Stop-gate evaluation
// ---------------------------------------------------------------------------

interface HistoryEntry {
  iter: number;
  value: number;
}

interface Decision {
  stop_reason: "metric_met" | "budget_exhausted" | "patience_exhausted" | "invalid_metric" | null;
  metric_met: boolean;
  current: number | null;
  target: number;
  direction: "higher_better" | "lower_better";
  tolerance: number;
  threshold: number;
  iteration: number;
  max_iterations: number;
  no_progress_streak: number;
  patience: number;
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
    max_iterations: 0,
    no_progress_streak: 0,
    patience: 0,
    invalid_reason: reason,
  };
}

function evaluateDashboard(root: string, runId: string): Decision {
  if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) {
    fail(`invalid run id '${runId}'`);
  }
  const dashPath = path.join(root, ".aris", "runs", runId, "dashboard.json");
  if (!fs.existsSync(dashPath)) {
    fail(`no dashboard at ${dashPath}`);
  }
  let dash: Record<string, unknown>;
  try {
    dash = JSON.parse(fs.readFileSync(dashPath, "utf-8"));
  } catch (err) {
    fail(`corrupt dashboard at ${dashPath}: ${err}`);
  }

  // Malformed metric fields → invalid_metric JSON (not exit 1).
  // The orchestrator reads stop_reason from the JSON and handles it
  // deterministically. Crashing would leave the loop in a limbo state.
  const metric = (dash.metric ?? {}) as Record<string, unknown>;
  const direction = metric.direction;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) {
    return invalidMetricDecision(
      `dashboard metric.direction must be higher_better or lower_better, got '${String(direction)}'`,
    );
  }
  if (!isFiniteNumber(metric.target)) {
    return invalidMetricDecision("dashboard metric.target is not a finite number");
  }
  if (
    !isFiniteNumber(metric.tolerance) ||
    (metric.tolerance as number) < 0 ||
    (metric.tolerance as number) >= 1
  ) {
    return invalidMetricDecision(
      `dashboard metric.tolerance must be a finite number in [0, 1), got '${String(metric.tolerance)}'`,
    );
  }
  const target = metric.target as number;
  const tolerance = metric.tolerance as number;
  // Use abs(target) so the band works correctly when target is negative
  // (e.g. a loss of -2.5 with tolerance 0.01 should allow -2.525 for lower_better).
  const band = Math.abs(target) * tolerance;
  const threshold = direction === "lower_better" ? target + band : target - band;

  const iteration = dash.iteration;
  const maxIterations = dash.max_iterations;
  if (!Number.isInteger(iteration) || (iteration as number) < 1) {
    return invalidMetricDecision(
      `dashboard.iteration must be an integer >= 1, got '${String(iteration)}'`,
    );
  }
  if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1) {
    return invalidMetricDecision(
      `dashboard.max_iterations must be an integer >= 1, got '${String(maxIterations)}'`,
    );
  }

  const config = (dash.config ?? {}) as Record<string, unknown>;
  const patience = config.patience ?? 2;
  if (!Number.isInteger(patience) || (patience as number) < 1) {
    return invalidMetricDecision(
      `dashboard.config.patience must be an integer >= 1, got '${String(patience)}'`,
    );
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
  const baseline = isFiniteNumber(metric.baseline) ? metric.baseline : null;
  let stopReason: Decision["stop_reason"] = null;
  if (!isFiniteNumber(current)) {
    stopReason = "invalid_metric";
  } else if (direction === "lower_better" ? current <= threshold : current >= threshold) {
    stopReason = "metric_met";
  } else if ((iteration as number) >= (maxIterations as number)) {
    stopReason = "budget_exhausted";
  } else {
    const streak = noProgressStreak(history, direction, baseline);
    if (streak >= (patience as number)) {
      stopReason = "patience_exhausted";
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
    max_iterations: maxIterations as number,
    no_progress_streak: streak,
    patience: patience as number,
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
  .action((root: string) => {
    const cfg = parseMetricConfig(path.resolve(root));
    if (cfg === null) {
      fail(
        "'## Metric Target' is not configured in CLAUDE.md. " +
          "Uncomment the block from templates/CLAUDE_MD_TEMPLATE.md and fill in " +
          "'primary: <number> <unit>'. A commented-out template block is not a configuration.",
      );
    }
    console.log(JSON.stringify(cfg));
  });

program
  .command("evaluate")
  .argument("<root>", "project root")
  .argument("<run_id>", "run id (dashboard at .aris/runs/<run_id>/dashboard.json)")
  .action((root: string, runId: string) => {
    const decision = evaluateDashboard(path.resolve(root), runId);
    const dashPath = path.join(path.resolve(root), ".aris", "runs", runId, "dashboard.json");
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
  });

runCli(program);
