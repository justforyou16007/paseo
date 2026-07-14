import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const EXECUTOR_STATUSES = new Set(["pending", "running", "done", "failed", "skipped"]);
const TERMINAL_STATUSES = new Set(["accepted", "skipped"]);

interface PhaseRecord {
  phase: string;
  status: string;
  artifact: string | null;
  verdict_id: string | null;
  reviewer: string | null;
  updated: string;
}

interface RunState {
  run_id: string;
  created: string;
  updated: string;
  phases: PhaseRecord[];
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runPath(root: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9\-_.]/g, "");
  if (!safe || safe !== runId || runId === "." || runId === "..") {
    throw new Error(`invalid run_id '${runId}' (use [A-Za-z0-9-_.])`);
  }
  return path.join(root, ".aris", "runs", `${runId}.json`);
}

function load(root: string, runId: string): RunState {
  const p = runPath(root, runId);
  if (!fs.existsSync(p)) {
    throw new Error(`no run state at ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as RunState;
}

function save(root: string, runId: string, state: RunState): void {
  const p = runPath(root, runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  state.updated = now();
  const tmpDir = path.dirname(p);
  const tmpPath = path.join(tmpDir, `.${runId}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function findPhase(state: RunState, phase: string): PhaseRecord {
  const ph = state.phases.find((p) => p.phase === phase);
  if (!ph) {
    throw new Error(
      `phase '${phase}' not in run (have: ${state.phases.map((p) => p.phase).join(", ")})`,
    );
  }
  return ph;
}

export function startRun(root: string, runId: string, phases: string[]): RunState {
  const p = runPath(root, runId);
  if (fs.existsSync(p)) {
    return load(root, runId);
  }
  const ts = now();
  const state: RunState = {
    run_id: runId,
    created: ts,
    updated: ts,
    phases: phases.map((ph) => ({
      phase: ph,
      status: "pending",
      artifact: null,
      verdict_id: null,
      reviewer: null,
      updated: ts,
    })),
  };
  save(root, runId, state);
  return state;
}

export function setStatus(
  root: string,
  runId: string,
  phase: string,
  status: string,
  artifact?: string,
): RunState {
  if (!EXECUTOR_STATUSES.has(status)) {
    throw new Error(
      `set_status may only write [${[...EXECUTOR_STATUSES].sort().join(", ")}]; ` +
        `'accepted' is reserved for accept() (needs a cross-model/deterministic verdict).`,
    );
  }
  const state = load(root, runId);
  const ph = findPhase(state, phase);
  ph.status = status;
  if (artifact != null) ph.artifact = artifact;
  ph.updated = now();
  save(root, runId, state);
  return state;
}

export function accept(
  root: string,
  runId: string,
  phase: string,
  verdictId: string,
  reviewer: string,
  force = false,
): RunState {
  if (!verdictId || !reviewer) {
    throw new Error(
      "accept requires a non-empty verdict_id AND reviewer — " +
        "a phase cannot be accepted without recording who acquitted it.",
    );
  }
  const state = load(root, runId);
  const ph = findPhase(state, phase);
  if (!force && ph.status !== "done" && ph.status !== "accepted") {
    throw new Error(
      `phase '${phase}' is '${ph.status}', not 'done' — cannot accept a phase that ` +
        `has not completed execution. Set it 'done' first, or pass force=True.`,
    );
  }
  const low = reviewer.toLowerCase();
  if (low.startsWith("claude") || low.includes("claude-opus") || low.includes("claude-sonnet")) {
    console.error(
      `⚠️  accept: reviewer='${reviewer}' looks like the executor family (Claude). ` +
        `A cross-model verdict must come from a DIFFERENT family (codex/gemini) or a ` +
        `deterministic verifier. Recording anyway, but this is likely self-acquittal.`,
    );
  }
  ph.status = "accepted";
  ph.verdict_id = verdictId;
  ph.reviewer = reviewer;
  ph.updated = now();
  save(root, runId, state);
  return state;
}

export function resumePoint(root: string, runId: string): PhaseRecord | null {
  const state = load(root, runId);
  return state.phases.find((ph) => !TERMINAL_STATUSES.has(ph.status)) ?? null;
}

function printStatus(state: RunState): void {
  console.log(`run ${state.run_id}  (updated ${state.updated ?? "?"})`);
  const glyph: Record<string, string> = {
    pending: "·",
    running: "▶",
    done: "✓(unaccepted)",
    failed: "✗",
    accepted: "✅",
    skipped: "⊘(skipped)",
  };
  for (const ph of state.phases) {
    let line = `  ${(glyph[ph.status] ?? "?").padStart(14)}  ${ph.phase}  [${ph.status}]`;
    if (ph.status === "accepted") {
      line += `  ← ${ph.reviewer} / ${ph.verdict_id}`;
    } else if (ph.artifact) {
      line += `  → ${ph.artifact}`;
    }
    console.log(line);
  }
  const rp = state.phases.find((p) => !TERMINAL_STATUSES.has(p.status));
  console.log(`  resume → ${rp ? rp.phase : "COMPLETE (all phases accepted/skipped)"}`);
}

const program = createCli("run-state", "ARIS resumable run-state (done vs accepted).");

program
  .command("start")
  .argument("<root>")
  .argument("<run_id>")
  .requiredOption("--phases <phases>", "comma-separated phase names")
  .action((root: string, runId: string, opts: { phases: string }) => {
    const phases = opts.phases
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    printStatus(startRun(root, runId, phases));
  });

program
  .command("set")
  .argument("<root>")
  .argument("<run_id>")
  .argument("<phase>")
  .argument("<status>")
  .option("--artifact <artifact>")
  .action(
    (root: string, runId: string, phase: string, status: string, opts: { artifact?: string }) => {
      if (!EXECUTOR_STATUSES.has(status)) {
        console.error(`error: status must be one of: ${[...EXECUTOR_STATUSES].sort().join(", ")}`);
        process.exit(1);
      }
      printStatus(setStatus(root, runId, phase, status, opts.artifact));
    },
  );

program
  .command("accept")
  .argument("<root>")
  .argument("<run_id>")
  .argument("<phase>")
  .requiredOption("--verdict-id <verdictId>")
  .requiredOption("--reviewer <reviewer>")
  .option("--force", "", false)
  .action(
    (
      root: string,
      runId: string,
      phase: string,
      opts: { verdictId: string; reviewer: string; force: boolean },
    ) => {
      printStatus(accept(root, runId, phase, opts.verdictId, opts.reviewer, opts.force));
    },
  );

program
  .command("resume")
  .argument("<root>")
  .argument("<run_id>")
  .action((root: string, runId: string) => {
    const rp = resumePoint(root, runId);
    if (!rp) {
      console.log("COMPLETE");
      return;
    }
    console.log(rp.phase);
    console.error(JSON.stringify(rp));
  });

program
  .command("status")
  .argument("<root>")
  .argument("<run_id>")
  .action((root: string, runId: string) => {
    printStatus(load(root, runId));
  });

program
  .command("list")
  .argument("<root>")
  .action((root: string) => {
    const d = path.join(root, ".aris", "runs");
    if (!fs.existsSync(d)) return;
    const files = fs
      .readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files) {
      console.log(f.replace(/\.json$/, ""));
    }
  });

runCli(program);
