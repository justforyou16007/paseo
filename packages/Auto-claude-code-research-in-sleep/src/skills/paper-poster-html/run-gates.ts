#!/usr/bin/env node
/**
 * run_gates — canonical gate orchestrator for HTML academic posters.
 *
 * Runs 5 gates in fixed order: preflight -> style -> asset -> measure -> polish
 * and writes a single GATE_REPORT.json.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createCli, runCli } from "../../lib/cli.js";
import { asciiSafe } from "./posterly/textutil.js";

const SCHEMA_VERSION = 1;
const SKILL_NAME = "paper-poster-html";
const TAIL_LINES = 8;

const CANONICAL_ORDER = ["preflight", "style", "asset", "measure", "polish"] as const;
type GateName = (typeof CANONICAL_ORDER)[number];

const GATE_SEVERITY: Record<GateName, string> = {
  preflight: "hard",
  style: "hard",
  asset: "hard",
  measure: "hard",
  polish: "soft",
};

interface GateEntry {
  name: string;
  severity: string;
  status: string;
  command: string[];
  summary: unknown;
  artifacts: string[];
}

interface CanvasInfo {
  source: string;
  width_cm: number;
  height_cm: number;
  orientation: string;
  source_url: string | null;
}

interface GateReport {
  schema_version: number;
  skill: string;
  timestamp: string;
  poster_html: string;
  canvas: CanvasInfo;
  overall: string;
  hard_failures: number;
  warnings: number;
  gates: GateEntry[];
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function tail(text: string, n = TAIL_LINES): string {
  const lines = text
    .split("\n")
    .filter((ln) => ln.trim())
    .slice(-n);
  return asciiSafe(lines.join("\n"));
}

function orientation(width: number, height: number): string {
  return width > height ? "landscape" : "portrait";
}

function canvasFromState(statePath: string): CanvasInfo {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (error) {
    throw new Error(`POSTER_STATE.json is unreadable: ${String(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("POSTER_STATE.json must contain an object");
  }
  const canvas = (data as Record<string, unknown>).canvas;
  if (typeof canvas !== "object" || canvas === null || Array.isArray(canvas)) {
    throw new Error("POSTER_STATE.json must contain a canvas object");
  }
  const stateCanvas = canvas as Record<string, unknown>;
  const width = stateCanvas.width_cm;
  const height = stateCanvas.height_cm;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error(
      "POSTER_STATE.json canvas.width_cm and canvas.height_cm must be positive numbers",
    );
  }
  const orient = stateCanvas.orientation;
  if (orient !== undefined && orient !== "landscape" && orient !== "portrait") {
    throw new Error("POSTER_STATE.json canvas.orientation must be landscape or portrait");
  }
  return {
    source: typeof stateCanvas.source === "string" ? stateCanvas.source : "poster-state",
    width_cm: Math.round(width * 100) / 100,
    height_cm: Math.round(height * 100) / 100,
    orientation: orient === undefined ? orientation(width, height) : orient,
    source_url: typeof stateCanvas.source_url === "string" ? stateCanvas.source_url : null,
  };
}

function resolveCanvasInfo(htmlPath: string): CanvasInfo {
  const statePath = path.join(path.dirname(htmlPath), "POSTER_STATE.json");
  if (!fs.existsSync(statePath)) {
    throw new Error(`required POSTER_STATE.json is missing: ${statePath}`);
  }
  return canvasFromState(statePath);
}

function runChild(
  argv: string[],
  cwd: string,
): { returncode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(argv.join(" "), {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { returncode: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      returncode: err.status || 2,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

function statusFromReturncode(returncode: number, severity: string): string {
  if (returncode === 0) return "PASS";
  if (returncode === 1) return severity === "hard" ? "FAIL" : "WARN";
  return "ERROR";
}

interface RunGateOpts {
  tokens?: string | null;
  manifest?: string | null;
  waiveTotalArea?: boolean;
  noRender?: boolean;
  strictPolish?: boolean;
  failFast?: boolean;
}

function buildArgv(
  gate: GateName,
  scriptsDir: string,
  htmlPath: string,
  opts: RunGateOpts,
  reportJsonDir: string,
): string[] {
  const node = process.execPath;
  const html = htmlPath;

  if (gate === "preflight") {
    return [node, path.join(scriptsDir, "poster-check.js"), "preflight", html];
  }

  if (gate === "style") {
    const argv = [node, path.join(scriptsDir, "style-check.js"), html];
    if (opts.tokens) argv.push("--tokens", path.resolve(opts.tokens));
    if (opts.noRender) argv.push("--no-render");
    argv.push("--json", path.join(reportJsonDir, "style_check.json"));
    return argv;
  }

  if (gate === "asset") {
    const argv = [node, path.join(scriptsDir, "asset-check.js"), html];
    if (opts.manifest) argv.push("--manifest", path.resolve(opts.manifest));
    if (opts.waiveTotalArea) argv.push("--waive-total-area");
    if (opts.noRender) argv.push("--no-render");
    argv.push("--json", path.join(reportJsonDir, "asset_check.json"));
    return argv;
  }

  if (gate === "measure") {
    return [node, path.join(scriptsDir, "poster-check.js"), "measure", html];
  }

  if (gate === "polish") {
    const argv = [node, path.join(scriptsDir, "poster-check.js"), "polish", html];
    if (opts.strictPolish) argv.push("--strict");
    return argv;
  }

  throw new Error(`unknown gate: ${gate}`);
}

function summarizeGate(
  gate: GateName,
  returncode: number,
  stdout: string,
  stderr: string,
  reportJsonDir: string,
): { summary: unknown; artifacts: string[]; error: string | null } {
  const artifacts: string[] = [];

  if (gate === "style" || gate === "asset") {
    const sidecar = path.join(reportJsonDir, `${gate}_check.json`);
    if (!fs.existsSync(sidecar)) {
      return {
        summary: { error: `required gate report is missing: ${sidecar}` },
        artifacts,
        error: `required gate report is missing: ${sidecar}`,
      };
    }
    try {
      const obj = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
      artifacts.push(sidecar);
      return { summary: obj, artifacts, error: null };
    } catch (e) {
      const error = `required gate report is invalid: ${sidecar}: ${String(e)}`;
      return { summary: { error }, artifacts: [sidecar], error };
    }
  }

  const combined = (stdout + "\n" + stderr).trim();
  return {
    summary: { exit_code: returncode, tail: tail(combined) },
    artifacts,
    error: null,
  };
}

function runGate(
  gate: GateName,
  scriptsDir: string,
  htmlPath: string,
  opts: RunGateOpts,
  reportJsonDir: string,
): GateEntry {
  const severity = GATE_SEVERITY[gate];
  const argv = buildArgv(gate, scriptsDir, htmlPath, opts, reportJsonDir);
  const { returncode, stdout, stderr } = runChild(argv, path.dirname(htmlPath));
  const summaryResult = summarizeGate(gate, returncode, stdout, stderr, reportJsonDir);
  const status = summaryResult.error ? "ERROR" : statusFromReturncode(returncode, severity);
  const { summary, artifacts } = summaryResult;
  return { name: gate, severity, status, command: argv, summary, artifacts };
}

function skippedRemainder(stoppedAt: GateName): GateEntry[] {
  const idx = CANONICAL_ORDER.indexOf(stoppedAt);
  return CANONICAL_ORDER.slice(idx + 1).map((gate) => ({
    name: gate,
    severity: GATE_SEVERITY[gate],
    status: "SKIPPED",
    command: [],
    summary: { skipped: "fail-fast: a prior hard gate failed" },
    artifacts: [],
  }));
}

function runAll(htmlPath: string, opts: RunGateOpts): GateReport {
  const scriptsDir = path.dirname(path.resolve(__filename));
  const reportPath = path.join(path.dirname(htmlPath), "GATE_REPORT.json");
  const reportJsonDir = path.dirname(reportPath);
  const canvas = resolveCanvasInfo(htmlPath);

  const gates: GateEntry[] = [];
  let hardFailures = 0;
  let warnings = 0;

  for (const gate of CANONICAL_ORDER) {
    const entry = runGate(gate, scriptsDir, htmlPath, opts, reportJsonDir);
    gates.push(entry);
    const isHard = entry.severity === "hard";

    if (entry.status === "FAIL" || entry.status === "ERROR") {
      if (isHard || entry.status === "ERROR") hardFailures++;
      if (opts.failFast) {
        gates.push(...skippedRemainder(gate));
        break;
      }
    } else if (entry.status === "WARN") {
      warnings++;
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    skill: SKILL_NAME,
    timestamp: nowIso(),
    poster_html: htmlPath,
    canvas,
    overall: hardFailures === 0 ? "PASS" : "FAIL",
    hard_failures: hardFailures,
    warnings,
    gates,
  };
}

function printHumanSummary(report: GateReport): void {
  console.log(`[run_gates] ${asciiSafe(report.poster_html)}`);
  const canvas = report.canvas;
  console.log(
    `  canvas: ${canvas.width_cm} x ${canvas.height_cm} cm ` +
      `${canvas.orientation} (source: ${canvas.source})`,
  );
  for (const g of report.gates) {
    console.log(`  ${g.name.padEnd(9)} [${g.severity.padEnd(4)}] -> ${g.status}`);
  }
  console.log(
    `  overall: ${report.overall}   hard_failures: ${report.hard_failures}   ` +
      `warnings: ${report.warnings}`,
  );
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const program = createCli(
  "run_gates",
  "Run the canonical poster gate sequence (preflight -> style -> asset -> measure -> polish) " +
    "and write GATE_REPORT.json.",
);

program
  .argument("<html>", "path to poster.html")
  .option("--report <path>", "output GATE_REPORT.json path")
  .option("--fail-fast", "stop at the first HARD failure instead of accumulating")
  .option("--strict-polish", "treat polish warnings as failures")
  .option("--tokens <path>", "design tokens JSON, passed to style_check")
  .option("--manifest <path>", "FIGURE_MANIFEST.json, passed to asset_check")
  .option("--waive-total-area", "theory-paper waiver, passed to asset_check")
  .option("--no-render", "skip render-dependent checks")
  .action((html: string, opts: Record<string, string | boolean | undefined>) => {
    const htmlPath = path.resolve(html);
    if (!fs.existsSync(htmlPath)) {
      process.stderr.write(`ERROR: HTML not found: ${asciiSafe(htmlPath)}\n`);
      process.exit(2);
    }

    const runOpts: RunGateOpts = {
      tokens: (opts.tokens as string) || null,
      manifest: (opts.manifest as string) || null,
      waiveTotalArea: !!opts.waiveTotalArea,
      noRender: !!opts.noRender || !!opts["no-render"],
      strictPolish: !!opts.strictPolish,
      failFast: !!opts.failFast,
    };

    const report = runAll(htmlPath, runOpts);

    const reportPath = opts.report
      ? path.resolve(opts.report as string)
      : path.join(path.dirname(htmlPath), "GATE_REPORT.json");

    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    } catch (e) {
      process.stderr.write(
        `ERROR: cannot write report ${asciiSafe(reportPath)}: ${asciiSafe(String(e))}\n`,
      );
      process.exit(2);
    }

    printHumanSummary(report);
    console.log(`[run_gates] report -> ${asciiSafe(reportPath)}`);

    process.exit(report.overall === "PASS" ? 0 : 1);
  });

runCli(program);
