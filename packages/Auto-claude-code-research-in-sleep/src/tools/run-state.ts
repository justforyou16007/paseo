import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";
import {
  openExistingRun,
  legacyRunStatePath,
  requireRunContract,
  readRun,
  type RunRecord,
} from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import { A1Error } from "./workflow-spec.js";

const EXECUTOR_STATUSES = new Set(["running", "done", "failed", "skipped"]);
const TERMINAL_STATUSES = new Set(["accepted", "skipped"]);
const ALL_STATUSES = new Set(["pending", ...EXECUTOR_STATUSES, "accepted"]);
const PHASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/;
const RUN_STATE_FIELDS = ["run_id", "created", "updated", "phases"] as const;
const PHASE_RECORD_FIELDS = [
  "phase",
  "status",
  "artifact",
  "verdict_id",
  "reviewer",
  "updated",
] as const;

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
  requireRunContract(root, runId);
  return legacyRunStatePath(root, runId);
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

function failRunState(code: string, message: string, filePath: string): never {
  throw new A1Error(code, message, filePath);
}

function validateState(state: unknown, filePath: string, expectedRunId?: string): RunState {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    failRunState("CORRUPT_RUN_STATE", "run-state must be an object", filePath);
  }
  const stateObject = state as Record<string, unknown>;
  const allowedStateFields = new Set<string>(RUN_STATE_FIELDS);
  for (const key of Object.keys(stateObject)) {
    if (!allowedStateFields.has(key)) {
      failRunState("UNKNOWN_FIELD", `unknown run-state top-level field '${key}'`, filePath);
    }
  }
  if (
    typeof stateObject.run_id !== "string" ||
    typeof stateObject.created !== "string" ||
    typeof stateObject.updated !== "string" ||
    !Array.isArray(stateObject.phases)
  ) {
    failRunState("CORRUPT_RUN_STATE", "run-state is missing required top-level fields", filePath);
  }
  const s = state as RunState;
  if (expectedRunId && s.run_id !== expectedRunId) {
    failRunState(
      "IDENTITY_MISMATCH",
      `run_id mismatch: file contains '${s.run_id}' but requested '${expectedRunId}'`,
      filePath,
    );
  }
  if (s.phases.length === 0) {
    failRunState("CORRUPT_RUN_STATE", "phases array is empty", filePath);
  }
  const seenPhases = new Set<string>();
  const allowedPhaseFields = new Set<string>(PHASE_RECORD_FIELDS);
  for (const rawPhase of s.phases as unknown[]) {
    if (typeof rawPhase !== "object" || rawPhase === null || Array.isArray(rawPhase)) {
      failRunState("CORRUPT_RUN_STATE", "invalid phase record", filePath);
    }
    const phaseObject = rawPhase as Record<string, unknown>;
    const phaseName = typeof phaseObject.phase === "string" ? phaseObject.phase : "<unknown>";
    for (const key of Object.keys(phaseObject)) {
      if (!allowedPhaseFields.has(key)) {
        failRunState(
          "UNKNOWN_FIELD",
          `unknown run-state phase field '${key}' in phase '${phaseName}'`,
          filePath,
        );
      }
    }
    const ph = rawPhase as PhaseRecord;
    if (typeof ph.phase !== "string" || typeof ph.status !== "string") {
      failRunState("CORRUPT_RUN_STATE", "invalid phase record", filePath);
    }
    if (!PHASE_NAME_RE.test(ph.phase)) {
      failRunState("CORRUPT_RUN_STATE", `unsafe phase name '${ph.phase}'`, filePath);
    }
    if (!ALL_STATUSES.has(ph.status)) {
      failRunState(
        "CORRUPT_RUN_STATE",
        `phase '${ph.phase}' has unknown status '${ph.status}'`,
        filePath,
      );
    }
    if (seenPhases.has(ph.phase)) {
      failRunState("CORRUPT_RUN_STATE", `duplicate phase '${ph.phase}'`, filePath);
    }
    seenPhases.add(ph.phase);
    if (typeof ph.updated !== "string") {
      failRunState("CORRUPT_RUN_STATE", `phase '${ph.phase}' missing updated`, filePath);
    }
    if (!isStringOrNull(ph.artifact)) {
      failRunState("CORRUPT_RUN_STATE", `phase '${ph.phase}' artifact not string|null`, filePath);
    }
    if (!isStringOrNull(ph.verdict_id)) {
      failRunState("CORRUPT_RUN_STATE", `phase '${ph.phase}' verdict_id not string|null`, filePath);
    }
    if (!isStringOrNull(ph.reviewer)) {
      failRunState("CORRUPT_RUN_STATE", `phase '${ph.phase}' reviewer not string|null`, filePath);
    }
    if (
      ph.status === "accepted" &&
      (!ph.verdict_id || !ph.verdict_id.trim() || !ph.reviewer || !ph.reviewer.trim())
    ) {
      failRunState(
        "CORRUPT_RUN_STATE",
        `accepted phase '${ph.phase}' lacks verdict provenance`,
        filePath,
      );
    }
  }
  return s;
}

function readValidatedState(filePath: string, expectedRunId: string): RunState {
  try {
    return readStateFile(filePath, (parsed, currentPath) =>
      validateState(parsed, currentPath, expectedRunId),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("corrupt JSON in state file at ")) {
      failRunState("CORRUPT_RUN_STATE", `corrupt JSON in run-state file`, filePath);
    }
    throw error;
  }
}

function load(root: string, runId: string): RunState {
  const p = runPath(root, runId);
  if (!fs.existsSync(p)) {
    throw new Error(`no run state at ${p}`);
  }
  return readValidatedState(p, runId);
}

function readExistingStateBeforeBootstrap(filePath: string, runId: string): RunState | null {
  if (!fs.existsSync(filePath)) return null;
  return readValidatedState(filePath, runId);
}

function save(state: RunState, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updated = now();
  writeStateJsonAtomic(filePath, state);
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
  return withStateFileLock(p, () => {
    const state = mutator(load(root, runId));
    save(state, p);
    return state;
  });
}

export function startRun(root: string, runId: string, phases: string[]): RunState {
  validatePhases(phases);
  // Start only opens an existing contract; A/B own contract creation.
  // It initializes the legacy phase file after the contract has been checked.
  const p = legacyRunStatePath(root, runId);

  // Validate an existing legacy file before opening the contract.
  // The second read under the state lock closes the race where
  // another process changes the file between this preflight and the bootstrap.
  readExistingStateBeforeBootstrap(p, runId);

  // The old phase file remains at its historical path. Identity stays in
  // the existing run.json, separate from phase transitions.
  return withStateFileLock(p, () => {
    const existingState = readExistingStateBeforeBootstrap(p, runId);
    openExistingRun({
      project_root: root,
      run_id: runId,
    });
    if (existingState !== null) return existingState;

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
  });
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

/** Read the canonical identity belonging to a phase run. */
export function getRunContract(root: string, runId: string): RunRecord {
  return readRun(root, runId);
}

type RunStateListEntry = "valid" | "missing-contract" | "ignore";

function classifyRunStateFile(root: string, filePath: string): RunStateListEntry {
  const stem = path.basename(filePath, ".json");
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    parsed = JSON.parse(raw);
    validateState(parsed, filePath, stem);
  } catch {
    return "ignore";
  }
  try {
    requireRunContract(root, stem);
    return "valid";
  } catch (error) {
    if ((error as { code?: unknown }).code === "RUN_CONTRACT_NOT_FOUND") return "missing-contract";
    throw error;
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
    printStatus(getStatus(root, runId));
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
      const entry = classifyRunStateFile(root, fp);
      if (entry === "valid") {
        console.log(f.replace(/\.json$/, ""));
      } else if (entry === "missing-contract") {
        console.log(`${f.replace(/\.json$/, "")} [contract missing]`);
      }
    }
  });

runCli(program);
