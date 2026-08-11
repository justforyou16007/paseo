import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const EXECUTOR_STATUSES = new Set(["running", "done", "failed", "skipped"]);
const TERMINAL_STATUSES = new Set(["accepted", "skipped"]);
const ALL_STATUSES = new Set(["pending", ...EXECUTOR_STATUSES, "accepted"]);
const PHASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/;

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

// --- Advisory file locking with ownership token ---
// Lock file contains a unique token: PID:timestamp:random.
// Release verifies token ownership before unlinking.
// Stale-lock policy: a lock held by a dead local PID is broken immediately.
// A malformed lock older than LOCK_MAX_AGE_MS is broken as a last resort.
// PID ownership is host-local; cross-host shared-filesystem locking is outside
// this tool's single-orchestrator-per-run contract.

const LOCK_MAX_AGE_MS = 120_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

function lockPath(filePath: string): string {
  return filePath + ".lock";
}

function makeLockToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(filePath: string): string {
  const lp = lockPath(filePath);
  const token = makeLockToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = fs.openSync(
        lp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      try {
        fs.writeSync(fd, token + "\n");
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      try {
        const content = fs.readFileSync(lp, "utf-8").trim();
        const holderPid = parseInt(content.split(":")[0], 10);
        const lockTime = parseInt(content.split(":")[1], 10);

        // If holder PID is a valid local PID and still alive, never break.
        if (!isNaN(holderPid) && holderPid > 0 && isPidAlive(holderPid)) {
          // PID alive — wait, do not break regardless of age
        } else if (!isNaN(holderPid) && holderPid > 0 && !isPidAlive(holderPid)) {
          // PID confirmed dead — break immediately
          try {
            fs.unlinkSync(lp);
          } catch {
            /* race */
          }
          continue;
        } else if (!isNaN(lockTime) && Date.now() - lockTime > LOCK_MAX_AGE_MS) {
          // Malformed/unverifiable owner + old enough — break
          try {
            fs.unlinkSync(lp);
          } catch {
            /* race */
          }
          continue;
        }
      } catch {
        // The lock may have disappeared between open/read or may be unreadable.
        // Retry through the bounded timeout path below instead of spinning.
      }

      if (Date.now() >= deadline) {
        throw new Error(`run-state lock timeout after ${LOCK_TIMEOUT_MS}ms on ${filePath}`);
      }

      const sleepMs = LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
}

function releaseLock(filePath: string, token: string): void {
  const lp = lockPath(filePath);
  try {
    const content = fs.readFileSync(lp, "utf-8").trim();
    if (content === token) {
      fs.unlinkSync(lp);
    }
  } catch {
    /* lock file already gone */
  }
}

// --- Validation ---

function validatePhases(phases: string[]): void {
  if (phases.length === 0) {
    throw new Error("phases list must not be empty");
  }
  const seen = new Set<string>();
  for (const ph of phases) {
    if (!ph || !PHASE_NAME_RE.test(ph)) {
      throw new Error(`invalid phase name '${ph}' (must match [A-Za-z0-9][A-Za-z0-9-_.]*)`);
    }
    if (seen.has(ph)) {
      throw new Error(`duplicate phase name '${ph}'`);
    }
    seen.add(ph);
  }
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function validateState(state: unknown, filePath: string, expectedRunId?: string): RunState {
  if (
    typeof state !== "object" ||
    state === null ||
    typeof (state as RunState).run_id !== "string" ||
    typeof (state as RunState).created !== "string" ||
    typeof (state as RunState).updated !== "string" ||
    !Array.isArray((state as RunState).phases)
  ) {
    throw new Error(`corrupt run-state at ${filePath}: missing required top-level fields`);
  }
  const s = state as RunState;
  if (expectedRunId && s.run_id !== expectedRunId) {
    throw new Error(
      `run_id mismatch at ${filePath}: file contains '${s.run_id}' but requested '${expectedRunId}'`,
    );
  }
  if (s.phases.length === 0) {
    throw new Error(`corrupt run-state at ${filePath}: phases array is empty`);
  }
  const seenPhases = new Set<string>();
  for (const ph of s.phases) {
    if (typeof ph.phase !== "string" || typeof ph.status !== "string") {
      throw new Error(`corrupt run-state at ${filePath}: invalid phase record`);
    }
    if (!PHASE_NAME_RE.test(ph.phase)) {
      throw new Error(`corrupt run-state at ${filePath}: unsafe phase name '${ph.phase}'`);
    }
    if (!ALL_STATUSES.has(ph.status)) {
      throw new Error(
        `corrupt run-state at ${filePath}: phase '${ph.phase}' has unknown status '${ph.status}'`,
      );
    }
    if (seenPhases.has(ph.phase)) {
      throw new Error(`corrupt run-state at ${filePath}: duplicate phase '${ph.phase}'`);
    }
    seenPhases.add(ph.phase);
    if (typeof ph.updated !== "string") {
      throw new Error(`corrupt run-state at ${filePath}: phase '${ph.phase}' missing updated`);
    }
    if (!isStringOrNull(ph.artifact)) {
      throw new Error(
        `corrupt run-state at ${filePath}: phase '${ph.phase}' artifact not string|null`,
      );
    }
    if (!isStringOrNull(ph.verdict_id)) {
      throw new Error(
        `corrupt run-state at ${filePath}: phase '${ph.phase}' verdict_id not string|null`,
      );
    }
    if (!isStringOrNull(ph.reviewer)) {
      throw new Error(
        `corrupt run-state at ${filePath}: phase '${ph.phase}' reviewer not string|null`,
      );
    }
    if (
      ph.status === "accepted" &&
      (!ph.verdict_id || !ph.verdict_id.trim() || !ph.reviewer || !ph.reviewer.trim())
    ) {
      throw new Error(
        `corrupt run-state at ${filePath}: accepted phase '${ph.phase}' lacks verdict provenance`,
      );
    }
  }
  return s;
}

function load(root: string, runId: string): RunState {
  const p = runPath(root, runId);
  if (!fs.existsSync(p)) {
    throw new Error(`no run state at ${p}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (err) {
    throw new Error(`cannot read run state at ${p}: ${err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt JSON in run state at ${p}`);
  }
  return validateState(parsed, p, runId);
}

function save(state: RunState, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updated = now();
  const tmpPath = filePath + `.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
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

function withLock(root: string, runId: string, mutator: (state: RunState) => RunState): RunState {
  const p = runPath(root, runId);
  const token = acquireLock(p);
  try {
    const state = mutator(load(root, runId));
    save(state, p);
    return state;
  } finally {
    releaseLock(p, token);
  }
}

export function startRun(root: string, runId: string, phases: string[]): RunState {
  validatePhases(phases);
  const p = runPath(root, runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const token = acquireLock(p);
  try {
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
    save(state, p);
    return state;
  } finally {
    releaseLock(p, token);
  }
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
  return withLock(root, runId, (state) => {
    const ph = findPhase(state, phase);
    if (TERMINAL_STATUSES.has(ph.status)) {
      if (ph.status === status && (artifact == null || artifact === ph.artifact)) {
        return state;
      }
      throw new Error(
        `phase '${phase}' is terminal ('${ph.status}') and cannot transition to '${status}'`,
      );
    }
    ph.status = status;
    if (artifact != null) ph.artifact = artifact;
    ph.updated = now();
    return state;
  });
}

export function accept(
  root: string,
  runId: string,
  phase: string,
  verdictId: string,
  reviewer: string,
  force = false,
): RunState {
  if (!verdictId.trim() || !reviewer.trim()) {
    throw new Error(
      "accept requires a non-empty verdict_id AND reviewer — " +
        "a phase cannot be accepted without recording who acquitted it.",
    );
  }
  return withLock(root, runId, (state) => {
    const ph = findPhase(state, phase);
    if (ph.status === "accepted") {
      if (ph.verdict_id === verdictId && ph.reviewer === reviewer) {
        return state;
      }
      throw new Error(
        `phase '${phase}' is already accepted by '${ph.reviewer}' with verdict '${ph.verdict_id}'`,
      );
    }
    if (ph.status === "skipped") {
      throw new Error(`phase '${phase}' is terminal ('skipped') and cannot be accepted`);
    }
    if (!force && ph.status !== "done") {
      throw new Error(
        `phase '${phase}' is '${ph.status}', not 'done' — cannot accept a phase that ` +
          `has not completed execution. Set it 'done' first, or pass force=true.`,
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
    return state;
  });
}

export function resumePoint(root: string, runId: string): PhaseRecord | null {
  const state = load(root, runId);
  return state.phases.find((ph) => !TERMINAL_STATUSES.has(ph.status)) ?? null;
}

export function getStatus(root: string, runId: string): RunState {
  return load(root, runId);
}

function isRunStateFile(filePath: string): boolean {
  const stem = path.basename(filePath, ".json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    validateState(parsed, filePath, stem);
    return true;
  } catch {
    return false;
  }
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
      .filter((f) => f.endsWith(".json") && !f.includes(".paseo-config."))
      .sort();
    for (const f of files) {
      const fp = path.join(d, f);
      if (isRunStateFile(fp)) {
        console.log(f.replace(/\.json$/, ""));
      }
    }
  });

runCli(program);
