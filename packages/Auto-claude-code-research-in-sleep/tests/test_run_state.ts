/**
 * Tests for src/tools/run-state.ts — resumable run-state with done/accepted split.
 *
 * Run:  npm test                      (builds then tests dist)
 *       npx tsx tests/test_run_state.ts  (tests source directly)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PHASES = ["W1", "W1.5", "W2", "W3"];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-run-state-test-"));
}

function cleanup(d: string): void {
  fs.rmSync(d, { recursive: true, force: true });
}

// Determine which file to test: use dist if explicitly built, else source.
// The build-then-test script sets ARIS_TEST_DIST=1.
const DIST_JS = path.resolve("dist/tools/run-state.js");
const SRC_TS = path.resolve("src/tools/run-state.ts");
const USE_DIST = process.env.ARIS_TEST_DIST === "1" && fs.existsSync(DIST_JS);
const TEST_FILE = USE_DIST ? DIST_JS : SRC_TS;
const RUNNER = TEST_FILE.endsWith(".ts") ? "tsx" : "node";

console.log(`Testing: ${TEST_FILE} (runner: ${RUNNER})`);

function cli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(RUNNER, [TEST_FILE, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

function readState(root: string, runId: string): Record<string, unknown> {
  const p = path.join(root, ".aris", "runs", `${runId}.json`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function findPhase(
  state: Record<string, unknown>,
  phase: string,
): Record<string, unknown> {
  const phases = state.phases as Record<string, unknown>[];
  const found = phases.find((p) => p.phase === phase);
  if (!found) throw new Error(`phase '${phase}' not found`);
  return found;
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

// ============================================================================
// Basic lifecycle
// ============================================================================

test("start creates pending phases", () => {
  const d = tmpDir();
  try {
    const r = cli("start", d, "run-a", "--phases", "W1,W1.5,W2,W3");
    assert.equal(r.exitCode, 0, `start failed: ${r.stderr}`);
    const st = readState(d, "run-a");
    const phases = st.phases as Record<string, unknown>[];
    assert.deepEqual(phases.map((p) => p.phase), PHASES);
    assert.ok(phases.every((p) => p.status === "pending"));
  } finally { cleanup(d); }
});

test("start is idempotent (does not clobber progress)", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W1.5,W2,W3");
    cli("set", d, "run-a", "W1", "done");
    cli("start", d, "run-a", "--phases", "W1,W1.5,W2,W3");
    assert.equal(findPhase(readState(d, "run-a"), "W1").status, "done");
  } finally { cleanup(d); }
});

test("set_status transitions: pending→running→done", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "running");
    assert.equal(findPhase(readState(d, "run-a"), "W1").status, "running");
    cli("set", d, "run-a", "W1", "done", "--artifact", "output/result.md");
    const ph = findPhase(readState(d, "run-a"), "W1");
    assert.equal(ph.status, "done");
    assert.equal(ph.artifact, "output/result.md");
  } finally { cleanup(d); }
});

test("set_status cannot write 'accepted'", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    const r = cli("set", d, "run-a", "W1", "accepted");
    assert.notEqual(r.exitCode, 0);
  } finally { cleanup(d); }
});

test("set_status cannot regress terminal phases", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "codex");
    assert.notEqual(cli("set", d, "run-a", "W1", "running").exitCode, 0);
    assert.equal(findPhase(readState(d, "run-a"), "W1").status, "accepted");

    cli("set", d, "run-a", "W2", "skipped");
    assert.equal(cli("set", d, "run-a", "W2", "skipped").exitCode, 0);
    assert.notEqual(cli("set", d, "run-a", "W2", "running").exitCode, 0);
    assert.equal(findPhase(readState(d, "run-a"), "W2").status, "skipped");
  } finally { cleanup(d); }
});

test("set_status can write skipped and failed", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    assert.equal(cli("set", d, "run-a", "W1", "skipped").exitCode, 0);
    assert.equal(cli("set", d, "run-a", "W2", "failed").exitCode, 0);
    assert.equal(findPhase(readState(d, "run-a"), "W1").status, "skipped");
    assert.equal(findPhase(readState(d, "run-a"), "W2").status, "failed");
  } finally { cleanup(d); }
});

// ============================================================================
// Accept
// ============================================================================

test("accept requires verdict_id and reviewer", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    const r = cli("accept", d, "run-a", "W1", "--verdict-id", "", "--reviewer", "codex");
    assert.notEqual(r.exitCode, 0);
    const whitespace = cli(
      "accept",
      d,
      "run-a",
      "W1",
      "--verdict-id",
      " ",
      "--reviewer",
      "codex",
    );
    assert.notEqual(whitespace.exitCode, 0);
  } finally { cleanup(d); }
});

test("accept requires phase to be done (no force)", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    const r = cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "codex");
    assert.notEqual(r.exitCode, 0);
  } finally { cleanup(d); }
});

test("accept with --force bypasses done check", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    const r = cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "deterministic:x", "--force");
    assert.equal(r.exitCode, 0);
    assert.equal(findPhase(readState(d, "run-a"), "W1").status, "accepted");
  } finally { cleanup(d); }
});

test("accept records verdict_id and reviewer", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    cli("accept", d, "run-a", "W1", "--verdict-id", "codex:019e", "--reviewer", "codex-gpt-5.5");
    const ph = findPhase(readState(d, "run-a"), "W1");
    assert.equal(ph.status, "accepted");
    assert.equal(ph.verdict_id, "codex:019e");
    assert.equal(ph.reviewer, "codex-gpt-5.5");
  } finally { cleanup(d); }
});

test("accept is idempotent for the same provenance and rejects conflicts", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    assert.equal(
      cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "codex")
        .exitCode,
      0,
    );
    assert.equal(
      cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "codex")
        .exitCode,
      0,
    );
    assert.notEqual(
      cli("accept", d, "run-a", "W1", "--verdict-id", "v:2", "--reviewer", "codex")
        .exitCode,
      0,
    );
    const ph = findPhase(readState(d, "run-a"), "W1");
    assert.equal(ph.verdict_id, "v:1");
    assert.equal(ph.reviewer, "codex");
  } finally { cleanup(d); }
});

// ============================================================================
// Resume
// ============================================================================

test("resume of fresh run points at first phase", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W1.5,W2,W3");
    const r = cli("resume", d, "run-a");
    assert.ok(r.stdout.trim().startsWith("W1"));
  } finally { cleanup(d); }
});

test("resume skips accepted+skipped, returns first non-terminal", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W1.5,W2,W3");
    cli("set", d, "run-a", "W1", "done");
    cli("accept", d, "run-a", "W1", "--verdict-id", "v", "--reviewer", "codex");
    cli("set", d, "run-a", "W1.5", "skipped");
    assert.ok(cli("resume", d, "run-a").stdout.trim().startsWith("W2"));
  } finally { cleanup(d); }
});

test("done-but-unaccepted is still a resume target", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W1.5,W2,W3");
    cli("set", d, "run-a", "W1", "done");
    cli("accept", d, "run-a", "W1", "--verdict-id", "codex:1", "--reviewer", "codex");
    cli("set", d, "run-a", "W1.5", "done");
    assert.ok(cli("resume", d, "run-a").stdout.trim().startsWith("W1.5"));
  } finally { cleanup(d); }
});

test("resume COMPLETE when all accepted or skipped", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "deterministic:test");
    cli("set", d, "run-a", "W2", "skipped");
    assert.ok(cli("resume", d, "run-a").stdout.includes("COMPLETE"));
  } finally { cleanup(d); }
});

// ============================================================================
// Validation (D2)
// ============================================================================

test("start rejects empty phases", () => {
  const d = tmpDir();
  try {
    const r = cli("start", d, "run-a", "--phases", "");
    assert.notEqual(r.exitCode, 0);
  } finally { cleanup(d); }
});

test("start rejects duplicate phases", () => {
  const d = tmpDir();
  try {
    const r = cli("start", d, "run-a", "--phases", "W1,W2,W1");
    assert.notEqual(r.exitCode, 0, "duplicate phases must be rejected");
  } finally { cleanup(d); }
});

test("start rejects unsafe phase names", () => {
  const d = tmpDir();
  try {
    // ../escape fails the PHASE_NAME_RE (starts with .)
    assert.notEqual(cli("start", d, "run-a", "--phases", "../escape").exitCode, 0);
    // .hidden fails (starts with .)
    assert.notEqual(cli("start", d, "run-b", "--phases", ".hidden").exitCode, 0);
    // Phase with spaces: CLI trims whitespace, but if the actual name has a space it fails run_id regex
    // (this is tested via the run_id validation above)
  } finally { cleanup(d); }
});

test("invalid run_id rejected", () => {
  const d = tmpDir();
  try {
    for (const bad of ["../escape", "a/b", "a b", "a;rm"]) {
      assert.notEqual(cli("start", d, bad, "--phases", "W1").exitCode, 0);
    }
  } finally { cleanup(d); }
});

test("unknown phase raises error", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    assert.notEqual(cli("set", d, "run-a", "W9", "done").exitCode, 0);
  } finally { cleanup(d); }
});

test("load validates run_id consistency", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1");
    // Manually tamper the run_id inside the file
    const p = path.join(d, ".aris", "runs", "run-a.json");
    const st = JSON.parse(fs.readFileSync(p, "utf-8"));
    st.run_id = "run-b";
    fs.writeFileSync(p, JSON.stringify(st));
    const r = cli("set", d, "run-a", "W1", "done");
    assert.notEqual(r.exitCode, 0, "mismatched run_id must fail");
    assert.ok(r.stderr.includes("mismatch"));
  } finally { cleanup(d); }
});

test("load validates duplicate phases in file", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    const p = path.join(d, ".aris", "runs", "run-a.json");
    const st = JSON.parse(fs.readFileSync(p, "utf-8"));
    st.phases.push({ ...st.phases[0] }); // duplicate W1
    fs.writeFileSync(p, JSON.stringify(st));
    const r = cli("set", d, "run-a", "W1", "done");
    assert.notEqual(r.exitCode, 0, "duplicate phase in file must fail");
  } finally { cleanup(d); }
});

test("corrupt JSON on disk raises clear error", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1");
    fs.writeFileSync(path.join(d, ".aris", "runs", "run-a.json"), "NOT JSON{{{");
    const r = cli("set", d, "run-a", "W1", "done");
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("corrupt") || r.stderr.includes("JSON"));
  } finally { cleanup(d); }
});

test("corrupt state structure raises clear error", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1");
    fs.writeFileSync(
      path.join(d, ".aris", "runs", "run-a.json"),
      JSON.stringify({ run_id: "run-a" }),
    );
    assert.notEqual(cli("set", d, "run-a", "W1", "done").exitCode, 0);
  } finally { cleanup(d); }
});

test("load rejects accepted phases without verdict provenance", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    const p = path.join(d, ".aris", "runs", "run-a.json");
    const st = readState(d, "run-a");
    const phase = findPhase(st, "W1");
    phase.status = "accepted";
    phase.verdict_id = null;
    phase.reviewer = null;
    fs.writeFileSync(p, JSON.stringify(st), "utf-8");
    const r = cli("status", d, "run-a");
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("lacks verdict provenance"));
  } finally { cleanup(d); }
});

// ============================================================================
// List filtering (D4)
// ============================================================================

test("list only shows valid run-state files, not config/receipt json", () => {
  const d = tmpDir();
  try {
    cli("start", d, "alpha", "--phases", "W1");
    cli("start", d, "beta", "--phases", "W1");
    // Write a paseo-config and a non-run-state JSON
    const runsDir = path.join(d, ".aris", "runs");
    fs.writeFileSync(path.join(runsDir, "alpha.paseo-config.json"), "{}");
    fs.writeFileSync(path.join(runsDir, "some-receipt.json"), '{"not":"a run state"}');
    const r = cli("list", d);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("alpha"));
    assert.ok(r.stdout.includes("beta"));
    assert.ok(!r.stdout.includes("paseo-config"));
    assert.ok(!r.stdout.includes("some-receipt"));
  } finally { cleanup(d); }
});

// ============================================================================
// Persistence
// ============================================================================

test("state persists across separate CLI invocations", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2,W3");
    cli("set", d, "run-a", "W1", "done", "--artifact", "output.md");
    cli("accept", d, "run-a", "W1", "--verdict-id", "v:1", "--reviewer", "codex");
    cli("set", d, "run-a", "W2", "skipped");
    const st = readState(d, "run-a");
    assert.equal(findPhase(st, "W1").status, "accepted");
    assert.equal(findPhase(st, "W1").artifact, "output.md");
    assert.equal(findPhase(st, "W2").status, "skipped");
    assert.equal(findPhase(st, "W3").status, "pending");
  } finally { cleanup(d); }
});

// ============================================================================
// Concurrency (D3: lock ownership)
// ============================================================================

test("concurrent set operations do not lose updates (40 parallel writers)", () => {
  const d = tmpDir();
  try {
    const N = 40;
    const phaseNames = Array.from({ length: N }, (_, i) => `P${i}`);
    cli("start", d, "run-concurrent", "--phases", phaseNames.join(","));

    const driverScript = [
      `const { execFile } = require("child_process");`,
      `const promises = [];`,
      `for (let i = 0; i < ${N}; i++) {`,
      `  promises.push(new Promise((resolve, reject) => {`,
      `    execFile(`,
      `      ${JSON.stringify(RUNNER)},`,
      `      [${JSON.stringify(TEST_FILE)}, "set", ${JSON.stringify(d)}, "run-concurrent", "P" + i, "done", "--artifact", "out-" + i + ".md"],`,
      `      { timeout: 30000 },`,
      `      (err) => err ? reject(err) : resolve()`,
      `    );`,
      `  }));`,
      `}`,
      `Promise.all(promises).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });`,
    ].join("\n");

    execFileSync("node", ["-e", driverScript], { timeout: 60_000, encoding: "utf-8" });

    const st = readState(d, "run-concurrent");
    let doneCount = 0;
    for (let i = 0; i < N; i++) {
      if (findPhase(st, `P${i}`).status === "done") doneCount++;
    }
    assert.equal(doneCount, N, `expected all ${N} done, got ${doneCount} (lost ${N - doneCount})`);
  } finally { cleanup(d); }
});

// ============================================================================
// Workflow state sequences (E)
// ============================================================================

test("research-pipeline: fresh → all accepted → COMPLETE", () => {
  const d = tmpDir();
  try {
    const phases = "idea-discovery,experiment-bridge,auto-review-loop,summary,paper-writing";
    cli("start", d, "rp-1", "--phases", phases);

    // Simulate a full run
    for (const ph of phases.split(",").slice(0, 4)) {
      cli("set", d, "rp-1", ph, "running");
      cli("set", d, "rp-1", ph, "done", "--artifact", `${ph}/output.md`);
      cli("accept", d, "rp-1", ph, "--verdict-id", `v:${ph}`, "--reviewer", "deterministic:test");
    }
    // paper-writing skipped (AUTO_WRITE=false)
    cli("set", d, "rp-1", "paper-writing", "skipped");

    assert.ok(cli("resume", d, "rp-1").stdout.includes("COMPLETE"));
  } finally { cleanup(d); }
});

test("research-pipeline: done-unaccepted resume re-validates", () => {
  const d = tmpDir();
  try {
    const phases = "idea-discovery,experiment-bridge,auto-review-loop,summary,paper-writing";
    cli("start", d, "rp-2", "--phases", phases);

    cli("set", d, "rp-2", "idea-discovery", "done");
    cli("accept", d, "rp-2", "idea-discovery", "--verdict-id", "v:1", "--reviewer", "codex");
    cli("set", d, "rp-2", "experiment-bridge", "done");
    // Crash before accept → resume should return experiment-bridge
    assert.ok(cli("resume", d, "rp-2").stdout.trim().startsWith("experiment-bridge"));
  } finally { cleanup(d); }
});

test("auto-research-loop: outer lifecycle init→loop→summary→paper-writing", () => {
  const d = tmpDir();
  try {
    const phases = "init,loop,summary,paper-writing";
    cli("start", d, "arl-1", "--phases", phases);

    // Init
    cli("set", d, "arl-1", "init", "done", "--artifact", "dashboard.json");
    cli("accept", d, "arl-1", "init", "--verdict-id", "deterministic:preconditions", "--reviewer", "deterministic:preconditions");

    // Loop running (iteration loop active)
    cli("set", d, "arl-1", "loop", "running");
    assert.ok(cli("resume", d, "arl-1").stdout.trim().startsWith("loop"));

    // Loop done (stop gate fired)
    cli("set", d, "arl-1", "loop", "done", "--artifact", "dashboard.json");

    // Summary
    cli("set", d, "arl-1", "summary", "done", "--artifact", "NARRATIVE_REPORT.md");
    // Accept loop (the summary + review acquit it)
    cli("accept", d, "arl-1", "loop", "--verdict-id", "codex:123", "--reviewer", "codex-gpt-5.5");
    cli("accept", d, "arl-1", "summary", "--verdict-id", "deterministic:summary", "--reviewer", "deterministic:summary");

    // Paper-writing skipped
    cli("set", d, "arl-1", "paper-writing", "skipped");

    assert.ok(cli("resume", d, "arl-1").stdout.includes("COMPLETE"));
  } finally { cleanup(d); }
});

test("auto-research-loop: crash during loop resumes at loop (not summary)", () => {
  const d = tmpDir();
  try {
    cli("start", d, "arl-2", "--phases", "init,loop,summary,paper-writing");
    cli("set", d, "arl-2", "init", "done");
    cli("accept", d, "arl-2", "init", "--verdict-id", "d:p", "--reviewer", "deterministic:p");
    cli("set", d, "arl-2", "loop", "running");
    // Crash during iteration → resume returns loop
    assert.ok(cli("resume", d, "arl-2").stdout.trim().startsWith("loop"));
  } finally { cleanup(d); }
});

test("auto-research-loop: stop→finishing→summary not blocked", () => {
  const d = tmpDir();
  try {
    cli("start", d, "arl-3", "--phases", "init,loop,summary,paper-writing");
    cli("set", d, "arl-3", "init", "done");
    cli("accept", d, "arl-3", "init", "--verdict-id", "d:p", "--reviewer", "deterministic:p");
    // Loop done (stop gate fired, dashboard.status=finishing)
    cli("set", d, "arl-3", "loop", "done", "--artifact", "dashboard.json");
    // loop is done but not accepted → resume returns loop (needs acceptance)
    assert.ok(cli("resume", d, "arl-3").stdout.trim().startsWith("loop"));

    // After summary completes, accept loop
    cli("accept", d, "arl-3", "loop", "--verdict-id", "codex:x", "--reviewer", "codex-gpt-5.5");
    // Now resume should point at summary
    assert.ok(cli("resume", d, "arl-3").stdout.trim().startsWith("summary"));
  } finally { cleanup(d); }
});

test("auto-research-loop: AUTO_WRITE=false skips paper-writing → COMPLETE", () => {
  const d = tmpDir();
  try {
    cli("start", d, "arl-4", "--phases", "init,loop,summary,paper-writing");
    // Fast-forward all to terminal
    cli("set", d, "arl-4", "init", "done");
    cli("accept", d, "arl-4", "init", "--verdict-id", "d:p", "--reviewer", "deterministic:p");
    cli("set", d, "arl-4", "loop", "done");
    cli("accept", d, "arl-4", "loop", "--verdict-id", "codex:x", "--reviewer", "codex-gpt-5.5");
    cli("set", d, "arl-4", "summary", "done");
    cli("accept", d, "arl-4", "summary", "--verdict-id", "d:s", "--reviewer", "deterministic:summary");
    cli("set", d, "arl-4", "paper-writing", "skipped");
    assert.ok(cli("resume", d, "arl-4").stdout.includes("COMPLETE"));
  } finally { cleanup(d); }
});

test("auto-research-loop: AUTO_WRITE=true done+accept → COMPLETE", () => {
  const d = tmpDir();
  try {
    cli("start", d, "arl-5", "--phases", "init,loop,summary,paper-writing");
    cli("set", d, "arl-5", "init", "done");
    cli("accept", d, "arl-5", "init", "--verdict-id", "d:p", "--reviewer", "deterministic:p");
    cli("set", d, "arl-5", "loop", "done");
    cli("accept", d, "arl-5", "loop", "--verdict-id", "codex:x", "--reviewer", "codex-gpt-5.5");
    cli("set", d, "arl-5", "summary", "done");
    cli("accept", d, "arl-5", "summary", "--verdict-id", "d:s", "--reviewer", "deterministic:summary");
    cli("set", d, "arl-5", "paper-writing", "done", "--artifact", "paper/");
    cli("accept", d, "arl-5", "paper-writing", "--verdict-id", "d:v", "--reviewer", "deterministic:verify_paper_audits.sh");
    assert.ok(cli("resume", d, "arl-5").stdout.includes("COMPLETE"));
  } finally { cleanup(d); }
});

// ============================================================================
// Contract verification (E): deep checks
// ============================================================================

test("contract: all auto-research-loop workers declare manifest protocol with required elements", () => {
  const workers = [
    "experiment-bridge", "analyze-results",
    "auto-review-loop", "kill-argument", "gap-planner", "paper-writing", "render-html",
  ];
  const skillsDir = path.resolve("skills");
  const missing: string[] = [];

  for (const w of workers) {
    const skillPath = path.join(skillsDir, w, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      missing.push(`${w}: SKILL.md not found`);
      continue;
    }
    const content = fs.readFileSync(skillPath, "utf-8");
    if (!content.includes("Manifest Protocol")) {
      missing.push(`${w}: no '## Manifest Protocol' section`);
    }
    if (!content.includes("input-manifest")) {
      missing.push(`${w}: no input-manifest reference`);
    }
    if (!content.includes("output_dir") && !content.includes("OUTPUT_DIR")) {
      missing.push(`${w}: no output_dir reference`);
    }
    if (!content.includes("receipt.json")) {
      missing.push(`${w}: no receipt.json reference`);
    }
    if (!content.includes("dashboard_patch")) {
      missing.push(`${w}: no dashboard_patch reference`);
    }
  }

  assert.equal(
    missing.length, 0,
    `Workers missing manifest contract elements:\n${missing.join("\n")}`,
  );
});

test("contract: no unmarked old receipt paths in worker skills", () => {
  const workers = [
    "experiment-bridge", "analyze-results",
    "auto-review-loop", "kill-argument", "gap-planner", "paper-writing", "render-html",
  ];
  const skillsDir = path.resolve("skills");
  const conflicts: string[] = [];

  for (const w of workers) {
    const skillPath = path.join(skillsDir, w, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.includes(".done.json") &&
        !line.toLowerCase().includes("legacy") &&
        !line.toLowerCase().includes("internal") &&
        !line.toLowerCase().includes("direct-call") &&
        // The ops-layer experiment receipt is a current contract, not the old
        // worker receipt: collect-outputs.sh / the monitoring heartbeat's
        // terminal tick writes it, and analyzers read it as an input manifest.
        !/\.experiment\.[^ )`]*done\.json/.test(line)
      ) {
        conflicts.push(`${w}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }

  assert.equal(
    conflicts.length, 0,
    `Unmarked old receipt references (must be marked legacy/internal/direct-call):\n${conflicts.join("\n")}`,
  );
});

test("contract: paseo-subagent-dispatch.md has no old .done.json receipt contract", () => {
  const docPath = path.resolve("skills/shared-references/paseo-subagent-dispatch.md");
  const content = fs.readFileSync(docPath, "utf-8");
  const lines = content.split("\n");
  const oldRefs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(".done.json")) {
      oldRefs.push(`line ${i + 1}: ${lines[i].trim().slice(0, 80)}`);
    }
  }
  assert.equal(
    oldRefs.length, 0,
    `paseo-subagent-dispatch.md still has old .done.json references:\n${oldRefs.join("\n")}`,
  );
});

test("contract: worker output path chain — orchestrator reads from worker output_dir", () => {
  // Verify that auto-research-loop reads from $WORKERS_DIR/<iter>-<phase>/outputs/
  // instead of hardcoded project-root paths
  const arlPath = path.resolve("skills/auto-research-loop/SKILL.md");
  const content = fs.readFileSync(arlPath, "utf-8");

  // Check phase input tables reference $WORKERS_DIR for inter-phase data
  const inputLines = content.split("\n").filter((l) =>
    l.includes("| ") && (l.includes("WORKERS_DIR") || l.includes("$ROOT/idea-stage") || l.includes("$ROOT/refine-logs"))
  );

  // Exception: at loop start (iteration 1) the evidence is the setup-time
  // baseline reproduction, which lives under $ROOT/refine-logs by definition —
  // no worker in this run produced it. Those rows are labelled "loop start:".
  const badPaths = inputLines.filter((l) =>
    (l.includes("$ROOT/idea-stage") || l.includes("$ROOT/refine-logs") || l.includes("$ROOT/review-stage")) &&
    !l.includes("loop start:")
  );

  assert.equal(
    badPaths.length, 0,
    `auto-research-loop still reads from project-root instead of worker outputs:\n${badPaths.join("\n")}`,
  );

  assert.ok(
    content.includes('WORKER_DIR="$WORKERS_DIR/summary"') &&
      content.includes('WORKER_DIR="$WORKERS_DIR/paper-writing"'),
    "outer lifecycle workers must use stable, non-iteration directories",
  );
  assert.ok(!content.includes("$ROOT/paper/"), "paper output must stay under worker output_dir");

  const render = fs.readFileSync(
    path.resolve("tools/render_w_agent_prompt.sh"),
    "utf-8",
  );
  assert.ok(render.includes("under its output_dir"), "rendered worker prompt must require output_dir");
  assert.ok(!render.includes("standard stage dir"), "rendered prompt retains ambiguous stage dir");
});

test("contract: resume restores persisted run configuration", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  for (const field of ["auto_write", "render_html", "patience"]) {
    assert.ok(arl.includes(`.config.${field}`), `auto-research-loop does not restore config.${field}`);
  }
  assert.ok(!arl.includes(".config.baseline_plan"), "baseline_plan is no longer a run config field (baseline is anchored during /research-setup Phase 7.6)");
  assert.ok(!arl.includes("older than 24h"), "valid old runs must not be discarded by age");

  const pipeline = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");
  for (const field of ["research_direction", "auto_write", "venue", "render_html"]) {
    assert.ok(pipeline.includes(`.config.${field}`), `research-pipeline does not restore config.${field}`);
  }
});

test("contract: research-pipeline and auto-research-loop are decoupled", () => {
  const pipeline = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");
  const loop = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const setup = fs.readFileSync(path.resolve("skills/research-setup/SKILL.md"), "utf-8");

  // No pipeline-coupling configuration anywhere.
  for (const doc of [pipeline, loop, setup]) {
    assert.ok(!doc.includes("AUTO_RESEARCH_ITERATIONS"), "stale AUTO_RESEARCH_ITERATIONS reference");
    assert.ok(!doc.includes("auto_research_iterations"), "stale auto_research_iterations reference");
    assert.ok(!doc.includes("research-iteration"), "stale research-iteration phase reference");
  }

  // research-pipeline never dispatches the loop; its phase list is fixed.
  assert.ok(!pipeline.includes("dispatch `/auto-research-loop`"), "pipeline must not dispatch auto-research-loop");
  assert.ok(
    pipeline.includes('PHASES="idea-discovery,experiment-bridge,auto-review-loop,summary,paper-writing"'),
    "pipeline phase list must be the fixed single-pass list",
  );

  // research-setup no longer wires the loop into the pipeline.
  assert.ok(!setup.includes("Inserted between W1"), "setup must not describe loop insertion");

  // research-pipeline reads direction and chosen idea from stable sources,
  // not from unassigned shell variables.
  assert.ok(!pipeline.includes("$CHOSEN_IDEA_TITLE"), "chosen_idea must come from dashboard.best_idea.title");
  assert.ok(pipeline.includes("dashboard.config.research_direction"), "direction must come from dashboard config");
  assert.ok(pipeline.includes("dashboard.best_idea.title"), "chosen idea must come from dashboard");

  // auto-research-loop resolves providers via the shared paseo-config, not hardcoding.
  assert.ok(!loop.includes('"claude/claude-sonnet-4-6"'), "loop must not hardcode an executor provider");
  assert.ok(loop.includes("render_w_agent_prompt.sh"), "loop must use the shared paseo config emitter");

  // auto-research-loop DOES dispatch idea-discovery, but only in metric-gap
  // constrained mode (Phase 4, iteration 2+) — never research-pipeline's
  // open-ended, unconstrained algorithm-idea exploration.
  assert.ok(loop.includes("Dispatch: `/idea-discovery"), "auto-research-loop must dispatch /idea-discovery in Phase 4");
  assert.ok(loop.includes("metric_gap_constrained"), "auto-research-loop must constrain idea-discovery to metric_gap_constrained mode");
});

test("contract: dashboard_patch idempotency — applied_receipts in dashboard schema", () => {
  // Verify that both orchestrators declare applied_receipts in their dashboard init
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  assert.ok(arl.includes("applied_receipts"), "auto-research-loop dashboard must have applied_receipts");

  const rp = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");
  assert.ok(rp.includes("applied_receipts"), "research-pipeline dashboard must have applied_receipts");

  // Verify worker-manifest.md documents the idempotency mechanism
  const wm = fs.readFileSync(path.resolve("skills/shared-references/worker-manifest.md"), "utf-8");
  assert.ok(wm.includes("applied_receipts"), "worker-manifest.md must document applied_receipts");
  assert.ok(
    wm.includes("idempoten") || wm.includes("Idempoten"),
    "worker-manifest.md must describe idempotent merge",
  );
});

// ============================================================================
// metric-gate.ts — stop gate correctness
// ============================================================================

function makeDashboard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "test-run",
    project: "test",
    status: "running",
    iteration: 1,
    max_iterations: 5,
    current_phase: "experiment-bridge",
    config: { patience: 2 },
    metric: {
      name: "F1",
      target: 0.85,
      direction: "higher_better",
      tolerance: 0.01,
      current: 0.72,
      baseline: 0.65,
      history: [{ iter: 1, value: 0.65 }],
    },
    best_idea: null,
    gaps: { open: [], closed: [], total: 0 },
    last_review: { verdict: null, score: null, reviewer_id: null },
    stop_reason: null,
    system_errors: { total: 0, last: null },
    applied_receipts: [],
    ...overrides,
  };
}

function writeDash(root: string, runId: string, dash: Record<string, unknown>): string {
  const dir = path.join(root, ".aris", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "dashboard.json");
  fs.writeFileSync(p, JSON.stringify({ ...dash, run_id: runId }, null, 2));
  return p;
}

function metricGateCli(
  ...args: string[]
): { stdout: string; stderr: string; exitCode: number } {
  const METRIC_GATE_TS = path.resolve("src/tools/metric-gate.ts");
  try {
    const stdout = execFileSync("npx", ["tsx", METRIC_GATE_TS, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

function dashMergeCli(
  ...args: string[]
): { stdout: string; stderr: string; exitCode: number } {
  const MERGE_TS = path.resolve("src/tools/dashboard-merge.ts");
  try {
    const stdout = execFileSync("npx", ["tsx", MERGE_TS, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

function writeWorkerReceipt(
  root: string,
  runId: string,
  directory: string,
  receipt: Record<string, unknown>,
): string {
  const workerDir = path.join(root, ".aris", "runs", runId, "workers", directory);
  const outputDir = path.join(workerDir, "outputs");
  fs.mkdirSync(outputDir, { recursive: true });

  const complete = {
    worker: "analyze-results",
    iteration: 1,
    run_id: runId,
    status: "done",
    error: null,
    primary_output: "artifact.md",
    summary: {},
    dashboard_patch: { "metric.current": 0.72 },
    completed_at: "2026-08-20T00:00:00Z",
    has_errors: false,
    error_count: 0,
    ...receipt,
  };
  const primaryOutput = complete.primary_output;
  if (complete.status === "done" && typeof primaryOutput === "string") {
    const artifactPath = path.join(outputDir, primaryOutput);
    if (primaryOutput.endsWith("/")) {
      fs.mkdirSync(artifactPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, "artifact\n", "utf-8");
    }
  }
  fs.writeFileSync(
    path.join(workerDir, "input-manifest.json"),
    JSON.stringify({
      worker: complete.worker,
      iteration: complete.iteration,
      run_id: runId,
      inputs: {},
      context: {},
      output_dir: outputDir,
    }),
  );
  const receiptPath = path.join(workerDir, "receipt.json");
  fs.writeFileSync(receiptPath, JSON.stringify(complete));
  return receiptPath;
}

// Helper: write a CLAUDE.md with a given Metric Target block (or none).
function writeClaudeMd(root: string, content: string): void {
  fs.writeFileSync(path.join(root, "CLAUDE.md"), content, "utf-8");
}

// --- metric-gate config ---

test("metric-gate: config rejects missing Metric Target section", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Other Section\n\nnothing here\n");
    const r = metricGateCli("config", d);
    assert.notEqual(r.exitCode, 0, "should fail with no Metric Target section");
    assert.ok(r.stderr.includes("not configured") || r.stderr.includes("Metric Target"), r.stderr);
  } finally { cleanup(d); }
});

test("metric-gate: config rejects fully-commented template block", () => {
  const d = tmpDir();
  try {
    // The template ships the block inside HTML comments — this must NOT be parsed.
    writeClaudeMd(d, `# Project\n\n## Metric Target\n\n<!-- Metric Target\nprimary: 0.85 F1\ndirection: higher_better\nbaseline: ""\ntolerance: 0.01\n-->\n`);
    const r = metricGateCli("config", d);
    assert.notEqual(r.exitCode, 0, "commented block must not count as configured");
    assert.ok(r.stderr.includes("not configured") || r.stderr.includes("commented"), r.stderr);
  } finally { cleanup(d); }
});

test("metric-gate: config parses valid higher_better block", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\ntolerance: 0.01\n");
    const r = metricGateCli("config", d);
    assert.equal(r.exitCode, 0, `should succeed: ${r.stderr}`);
    const cfg = JSON.parse(r.stdout.trim());
    assert.equal(cfg.target, 0.85);
    assert.equal(cfg.direction, "higher_better");
    assert.equal(cfg.tolerance, 0.01);
    assert.equal(cfg.name, "F1");
  } finally { cleanup(d); }
});

test("metric-gate: config parses valid lower_better block", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: 3.2 perplexity\ndirection: lower_better\ntolerance: 0.02\n");
    const r = metricGateCli("config", d);
    assert.equal(r.exitCode, 0, r.stderr);
    const cfg = JSON.parse(r.stdout.trim());
    assert.equal(cfg.direction, "lower_better");
    assert.equal(cfg.target, 3.2);
  } finally { cleanup(d); }
});

test("metric-gate: config rejects invalid direction", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: sideways\n");
    const r = metricGateCli("config", d);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("direction"), r.stderr);
  } finally { cleanup(d); }
});

test("metric-gate: config rejects tolerance >= 1", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\ntolerance: 1.5\n");
    const r = metricGateCli("config", d);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("tolerance"), r.stderr);
  } finally { cleanup(d); }
});

test("metric-gate: config rejects NaN primary", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: bad F1\n");
    const r = metricGateCli("config", d);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("finite") || r.stderr.includes("primary") || r.stderr.includes("number"), r.stderr);
  } finally { cleanup(d); }
});

// --- metric-gate evaluate truth table ---

test("metric-gate evaluate: metric_met (higher_better, inside tolerance band)", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({ metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.845, baseline: 0.65, history: [{ iter: 1, value: 0.65 }, { iter: 2, value: 0.845 }] } });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "metric_met");
    assert.equal(dec.metric_met, true);
  } finally { cleanup(d); }
});

test("metric-gate evaluate: metric_met (lower_better)", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({ metric: { name: "perplexity", target: 3.0, direction: "lower_better", tolerance: 0.01, current: 3.01, baseline: 5.0, history: [{ iter: 1, value: 5.0 }, { iter: 2, value: 3.01 }] } });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "metric_met");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: budget_exhausted", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({ iteration: 5, max_iterations: 5, metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.72, baseline: 0.65, history: [{ iter: 1, value: 0.65 }, { iter: 2, value: 0.68 }, { iter: 3, value: 0.70 }, { iter: 4, value: 0.71 }, { iter: 5, value: 0.72 }] } });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "budget_exhausted");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: patience_exhausted (no improvement for 2 consecutive)", () => {
  const d = tmpDir();
  try {
    // iter 1=0.65 (baseline), iter 2=0.72 (improvement), iter 3=0.71 (no), iter 4=0.70 (no) -> streak=2
    const dash = makeDashboard({
      iteration: 4,
      max_iterations: 10,
      config: { patience: 2 },
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.70, baseline: 0.65, history: [{ iter: 1, value: 0.65 }, { iter: 2, value: 0.72 }, { iter: 3, value: 0.71 }, { iter: 4, value: 0.70 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "patience_exhausted");
    assert.equal(dec.no_progress_streak, 2);
  } finally { cleanup(d); }
});

test("metric-gate evaluate: no stop when patience streak < patience", () => {
  const d = tmpDir();
  try {
    // iter 1=0.65, iter 2=0.72 (improvement) -> streak=0
    const dash = makeDashboard({
      iteration: 2,
      max_iterations: 10,
      config: { patience: 2 },
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.72, baseline: 0.65, history: [{ iter: 1, value: 0.65 }, { iter: 2, value: 0.72 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, null);
    assert.equal(dec.no_progress_streak, 0);
  } finally { cleanup(d); }
});

test("metric-gate evaluate: invalid_metric when current is null", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({ metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: null, baseline: null, history: [] } });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: invalid_metric takes priority over metric_met", () => {
  // Even if the arithmetic would pass, a null current must fire invalid_metric first.
  const d = tmpDir();
  try {
    const dash = makeDashboard({ metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: null, baseline: 0.85, history: [] } });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
    assert.equal(dec.metric_met, false);
  } finally { cleanup(d); }
});

test("metric-gate evaluate: resume idempotency — same stop_reason on re-evaluate", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      iteration: 5,
      max_iterations: 5,
      stop_reason: null, // will be set by first evaluate
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.72, baseline: 0.65, history: [{ iter: 5, value: 0.72 }] },
    });
    writeDash(d, "run1", dash);
    const r1 = metricGateCli("evaluate", d, "run1");
    assert.equal(r1.exitCode, 0, r1.stderr);
    const d1 = JSON.parse(r1.stdout.trim());
    assert.equal(d1.stop_reason, "budget_exhausted");
    // Second call should produce the same reason.
    const r2 = metricGateCli("evaluate", d, "run1");
    assert.equal(r2.exitCode, 0, r2.stderr);
    const d2 = JSON.parse(r2.stdout.trim());
    assert.equal(d2.stop_reason, "budget_exhausted");
  } finally { cleanup(d); }
});

// --- dashboard-merge idempotency and crash safety ---

test("dashboard-merge: apply merges dashboard_patch atomically", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      current_phase: "analyze-results",
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: null, baseline: null, history: [] },
    });
    writeDash(d, "run1", dash);
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {});
    const r = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.applied, true);
    const updated = JSON.parse(fs.readFileSync(path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    assert.equal((updated.metric as Record<string, unknown>).current, 0.72);
    assert.ok(Array.isArray(updated.applied_receipts) && updated.applied_receipts.length > 0);
  } finally { cleanup(d); }
});

test("dashboard-merge: apply is idempotent — second call returns already-applied", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({ current_phase: "analyze-results" });
    writeDash(d, "run1", dash);
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {
      dashboard_patch: { "metric.current": 0.75 },
    });
    dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    // second call
    const r2 = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.equal(r2.exitCode, 0, r2.stderr);
    const out2 = JSON.parse(r2.stdout.trim());
    assert.equal(out2.applied, false);
    assert.equal(out2.reason, "already-applied");
  } finally { cleanup(d); }
});

test("dashboard-merge: apply metric.history entry is appended once per iteration", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      current_phase: "analyze-results",
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: null, baseline: null, history: [] },
    });
    writeDash(d, "run1", dash);
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {});
    dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    const updated = JSON.parse(fs.readFileSync(path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    const history = (updated.metric as Record<string, unknown>).history as unknown[];
    assert.equal(history.length, 1);
    // Calling apply again must NOT add another history entry.
    // (The receipt is already applied, so the call returns early.)
    dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    const updated2 = JSON.parse(fs.readFileSync(path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    const history2 = (updated2.metric as Record<string, unknown>).history as unknown[];
    assert.equal(history2.length, 1, "must not duplicate history on re-apply");
  } finally { cleanup(d); }
});

test("dashboard-merge: failed receipt is not merged", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({ current_phase: "analyze-results" });
    writeDash(d, "run1", dash);
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {
      status: "failed",
      error: { category: "env_error", message: "ssh down", recoverable: true },
      primary_output: null,
      summary: {},
      dashboard_patch: {},
      has_errors: true,
      error_count: 1,
    });
    const r = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.applied, false);
    assert.equal(out.reason, "failed-receipt");
    // applied_receipts must not record a failed receipt
    const updated = JSON.parse(fs.readFileSync(path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    assert.equal((updated.applied_receipts as string[]).length, 0);
  } finally { cleanup(d); }
});

test("dashboard-merge: rejects unauthorized fields without changing the dashboard", () => {
  const d = tmpDir();
  try {
    writeDash(d, "run1", makeDashboard({ current_phase: "analyze-results" }));
    const dashboardPath = path.join(d, ".aris", "runs", "run1", "dashboard.json");
    const before = fs.readFileSync(dashboardPath, "utf-8");
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {
      dashboard_patch: { status: "completed", "metric.target": 1 },
    });

    const result = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.notEqual(result.exitCode, 0, "analyze-results must not write orchestration or target fields");
    assert.equal(fs.readFileSync(dashboardPath, "utf-8"), before,
      "a rejected receipt must leave the dashboard byte-for-byte unchanged");
  } finally { cleanup(d); }
});

test("dashboard-merge: rejects a receipt whose manifest identity does not match", () => {
  const d = tmpDir();
  try {
    writeDash(d, "run1", makeDashboard({ current_phase: "analyze-results" }));
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {});
    const manifestPath = path.join(path.dirname(receiptPath), "input-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.iteration = 2;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.includes("does not match its input manifest"), result.stderr);
  } finally { cleanup(d); }
});

test("dashboard-merge: rejects dangerous nested keys", () => {
  const d = tmpDir();
  try {
    writeDash(d, "run1", makeDashboard({ current_phase: "analyze-results" }));
    const receiptPath = writeWorkerReceipt(d, "run1", "1-analyze-results", {});
    const receipt = fs.readFileSync(receiptPath, "utf-8");
    const poisoned = receipt.replace(
      '"summary":{}',
      '"summary":{"nested":{"__proto__":{"polluted":true}}}',
    );
    fs.writeFileSync(receiptPath, poisoned);

    const result = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.includes("forbidden key '__proto__'"), result.stderr);
  } finally { cleanup(d); }
});

test("dashboard-merge: accepts one complete post-idea gap-planner receipt", () => {
  const d = tmpDir();
  try {
    writeDash(d, "run1", makeDashboard({
      iteration: 2,
      current_phase: "gap-planner",
    }));
    const workerRel = ".aris/runs/run1/workers/2-gap-planner/outputs";
    const receiptPath = writeWorkerReceipt(d, "run1", "2-gap-planner", {
      worker: "gap-planner",
      iteration: 2,
      primary_output: "EXPERIMENT_PLAN.md",
      summary: { operation: "audit-and-plan", reviewer_id: "reviewer-2" },
      dashboard_patch: {
        "gaps.open": ["G3"],
        "gaps.closed": ["G1", "G2"],
        "gaps.total": 3,
        gap_audit_path: `${workerRel}/GAP_AUDIT.json`,
        plan_path: `${workerRel}/EXPERIMENT_PLAN.md`,
      },
    });
    const outputDir = path.join(path.dirname(receiptPath), "outputs");
    for (const name of ["GAP_AUDIT.json", "gap_map.md", "GAP_ANALYSIS.md"]) {
      fs.writeFileSync(path.join(outputDir, name), "artifact\n", "utf-8");
    }

    const result = dashMergeCli(
      "apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const updated = JSON.parse(fs.readFileSync(
      path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8",
    ));
    assert.deepEqual(updated.gaps.open, ["G3"]);
    assert.deepEqual(updated.gaps.closed, ["G1", "G2"]);
    assert.equal(updated.plan_path, `${workerRel}/EXPERIMENT_PLAN.md`);
  } finally { cleanup(d); }
});

test("dashboard-merge: rejects gap-planner before idea discovery or with split outputs", () => {
  const d = tmpDir();
  try {
    writeDash(d, "run1", makeDashboard({
      iteration: 2,
      current_phase: "idea-discovery",
    }));
    const workerRel = ".aris/runs/run1/workers/2-gap-planner/outputs";
    const receiptPath = writeWorkerReceipt(d, "run1", "2-gap-planner", {
      worker: "gap-planner",
      iteration: 2,
      primary_output: "EXPERIMENT_PLAN.md",
      summary: { operation: "audit-and-plan" },
      dashboard_patch: {
        "gaps.open": ["G1"],
        "gaps.closed": [],
        "gaps.total": 1,
        gap_audit_path: `${workerRel}/GAP_AUDIT.json`,
        plan_path: `${workerRel}/EXPERIMENT_PLAN.md`,
      },
    });
    const outputDir = path.join(path.dirname(receiptPath), "outputs");
    for (const name of ["GAP_AUDIT.json", "gap_map.md", "GAP_ANALYSIS.md"]) {
      fs.writeFileSync(path.join(outputDir, name), "artifact\n", "utf-8");
    }

    let result = dashMergeCli(
      "apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath,
    );
    assert.notEqual(result.exitCode, 0, "gap-planner must not merge during idea-discovery");

    const dashboardPath = path.join(d, ".aris", "runs", "run1", "dashboard.json");
    const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf-8"));
    dashboard.current_phase = "gap-planner";
    fs.writeFileSync(dashboardPath, JSON.stringify(dashboard));
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
    delete receipt.dashboard_patch.plan_path;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    result = dashMergeCli(
      "apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath,
    );
    assert.notEqual(result.exitCode, 0,
      "gap-planner must publish audit and plan fields in the same receipt");
  } finally { cleanup(d); }
});

test("contract: gap-planner skill contract correctness", () => {
  const gp = fs.readFileSync(path.resolve("skills/gap-planner/SKILL.md"), "utf-8");

  assert.ok(gp.includes("## Manifest Protocol"), "gap-planner must have Manifest Protocol section");
  assert.ok(gp.includes("manifest's `context`") || gp.includes("manifest.context"), "gap-planner must read metric from manifest context");
  assert.ok(gp.includes("Do not read or reinterpret\n`CLAUDE.md`"), "gap-planner must explicitly reject CLAUDE.md metric inference");
  assert.ok(gp.includes("Do not assume a paper or LaTeX directory exists"), "gap-planner must not assume paper context");

  assert.ok(gp.includes('"gaps.open"'), "receipt must patch gaps.open");
  assert.ok(gp.includes('"gaps.closed"'), "receipt must patch gaps.closed");
  assert.ok(gp.includes('"gaps.total"'), "receipt must patch gaps.total");
  assert.ok(gp.includes('"plan_path"'), "receipt must patch plan_path");

  assert.ok(gp.includes("GAP_ANALYSIS.md"), "must output GAP_ANALYSIS.md");
  assert.ok(gp.includes("EXPERIMENT_PLAN.md"), "must output EXPERIMENT_PLAN.md");
  assert.ok(gp.includes("gap_map.md"), "must output updated gap_map.md");

  assert.ok(gp.includes("Run once, after idea-discovery"),
    "gap-planner must be one post-idea stage");
  assert.ok(gp.includes("This skill is the gap audit stage"),
    "gap-planner itself must be the audit stage");
  assert.ok(gp.includes("Do not add a\nseparate gap-audit skill, dispatch another gap reviewer"),
    "gap-planner must not create another gap audit");
  assert.ok(gp.includes("Gap-planner owns every gap ruling"),
    "gap-planner must own merge, close, and priority decisions");
  assert.ok(gp.includes("Do not select a\ndifferent method"),
    "plan composition must not change the selected idea");
  assert.ok(gp.includes("fail instead of inventing it"),
    "plan composition must fail rather than invent missing idea details");
  assert.ok(gp.includes("experiment-bridge"), "the generated plan must be consumable by experiment-bridge");

  const loop = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const ideaPhase = loop.indexOf("## Phase 4: Idea Discovery");
  const gapPhase = loop.indexOf("## Phase 4.5: Gap Planner");
  assert.ok(ideaPhase >= 0 && ideaPhase < gapPhase,
    "the loop must discover an idea before its one gap-planner stage");
  assert.equal((loop.match(/^Dispatch: `\/gap-planner /gm) ?? []).length, 1,
    "auto-research-loop must dispatch gap-planner exactly once per continuing iteration");
  assert.ok(!fs.existsSync(path.resolve("skills/gap-audit")), "gap audit must remain an operation of gap-planner, not a separate skill");

  const catalog = fs.readFileSync(path.resolve("docs/SKILLS_CATALOG.md"), "utf-8");
  assert.ok(catalog.includes("`/gap-planner`"), "catalog must list /gap-planner");
});

test("contract: auto-research-loop writes experiments with the real wiki CLI fields", () => {
  const loop = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const postReceipt = loop.indexOf("**Post-receipt wiki writes:**");
  const codeStart = loop.indexOf("```bash", postReceipt);
  const codeEnd = loop.indexOf("```", codeStart + 7);
  const command = loop.slice(codeStart, codeEnd);
  for (const field of [
    "--slug",
    "--title",
    "--idea",
    "--verdict",
    "--confidence",
    "--metrics",
    "--reasoning",
    "--provenance",
    "--tags",
  ]) {
    assert.ok(command.includes(field), `experiment wiki write must pass ${field}`);
  }
  assert.ok(!/(^|\s)--id(?:\s|$)/m.test(command) && !/(^|\s)--status(?:\s|$)/m.test(command),
    "experiment wiki write must not use unsupported aliases");
  assert.ok(command.includes('EXP_TITLE=$(jq -er \'.title\''),
    "the title must come from each bounded receipt record");
});

test("contract: nested result analysis preserves the verifier's user decision", () => {
  const analyze = fs.readFileSync(path.resolve("skills/analyze-results/SKILL.md"), "utf-8");
  assert.ok(analyze.includes('**If `overall_verdict == "fail"`:** present gaps to the user'),
    "analyze-results must continue asking the user after verifier failure");

  for (const owner of ["experiment-bridge", "auto-review-loop"]) {
    const skill = fs.readFileSync(path.resolve(`skills/${owner}/SKILL.md`), "utf-8");
    assert.ok(skill.includes("must not auto-override") || skill.includes("do not answer on the user's\nbehalf"),
      `${owner} must wait for analyze-results' user choice`);
  }
});

test("contract: nested analyzers use their manifest snapshots instead of stale project results", () => {
  const analyze = fs.readFileSync(path.resolve("skills/analyze-results/SKILL.md"), "utf-8");
  // Compare against whitespace-normalized prose: these phrases must survive
  // rewrapping, so a line break or list indent must not fail the contract.
  const flat = analyze.replace(/\s+/g, " ");
  assert.ok(flat.includes("require `manifest.inputs.results` and `manifest.inputs.tracker`"),
    "analyze-results worker mode must bind results and tracker from its manifest");
  assert.ok(flat.includes("project-wide scan is forbidden in worker mode"),
    "worker analysis must not fall back to project-root result directories");

  const bridge = fs.readFileSync(path.resolve("skills/experiment-bridge/SKILL.md"), "utf-8");
  for (const input of ["experiment_plan", "experiment_skill"]) {
    assert.ok(bridge.includes(input),
      `experiment-bridge must pass ${input} to its internal analyzer`);
  }

  const review = fs.readFileSync(path.resolve("skills/auto-review-loop/SKILL.md"), "utf-8");
  assert.ok(review.includes("final-inputs paths in its manifest"),
    "auto-review's final analyzer must be checked against the final snapshots");
});

test("contract: auto-research-loop waits for environment setup before validation", () => {
  const loop = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const start = loop.indexOf("# 0b. Check experiment environment");
  const end = loop.indexOf("# 0c. Baseline must already be anchored");
  assert.ok(start >= 0 && end > start, "must find the 0b environment block");
  const env = loop.slice(start, end);
  const create = env.indexOf("mcp__paseo__create_agent:");
  // wait_for_agent no longer exists; the parent ends its turn and resumes on
  // the child's finish notification (see shared-references/paseo-subagent-dispatch.md).
  const wait = env.indexOf("Waiting is mandatory");
  const validate = env.indexOf("if jq -e", wait);
  const archive = env.indexOf("mcp__paseo__archive_agent:");
  assert.ok(create >= 0 && create < wait && wait < validate && validate < archive,
    "environment setup must create, wait, validate, then archive in that order");
  assert.ok(!env.includes("wait_for_agent"),
    "wait_for_agent was deleted upstream - waiting is done by ending the turn");
  assert.ok(env.includes("experiment-env-manager") && env.includes("— run-id: $RUN_ID"),
    "the parent must give env-manager a known run-scoped receipt path");
  assert.ok((env.match(/run-\$\{PROJECT_NAME\}-experiment\/scripts/g) ?? []).length >= 2,
    "both existing and newly-created environments must include the scripts directory");
});

test("contract: auto-review-loop does not claim stop/continue/pivot in dashboard_patch", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-review-loop/SKILL.md"), "utf-8");
  // Extract the JSON receipt block from the Manifest Protocol section.
  const manifestStart = arl.indexOf("## Manifest Protocol");
  const workflowStart = arl.indexOf("## Workflow");
  const workerModeSection = arl.slice(manifestStart, workflowStart);

  // Find the dashboard_patch JSON block inside the receipt example.
  const patchStart = workerModeSection.indexOf('"dashboard_patch"');
  const patchEnd = workerModeSection.indexOf("}", patchStart) + 1;
  assert.ok(patchStart >= 0, "receipt must have dashboard_patch block");
  const patchBlock = workerModeSection.slice(patchStart, patchEnd);
  assert.ok(!patchBlock.includes("metric_progress"),
    "dashboard_patch must not include metric_progress field (that field is not part of auto-review-loop's output contract)");
  assert.ok(!patchBlock.includes("stop") && !patchBlock.includes("continue") && !patchBlock.includes("pivot"),
    "dashboard_patch must not include stop/continue/pivot signals");
});

test("contract: auto-research-loop stop gate reads dashboard fields only (no reviewer verdicts)", () => {
  const loop = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  // The stop gate section must be metric-gate.js based, not compound reviewer gate.
  assert.ok(loop.includes("metric-gate.js evaluate"), "stop gate must use metric-gate.js evaluate");
  assert.ok(!loop.includes("TYPE_B_FIRES"), "must not have the old compound gate TYPE_B variable");
  assert.ok(!loop.includes("REVIEW_VERDICT") || !loop.includes("TYPE_B"), "must not have old TYPE_A/TYPE_B compound structure");
  // The gate logic must not read metric_progress from dashboard (that would couple to review output)
  // -- we test that the Phase 3 arithmetic section doesn't reference it.
  const gateStart = loop.indexOf("## Phase 3: Metric Evaluation");
  const gateEnd = loop.indexOf("## Phase 4:");
  const gateSection = loop.slice(gateStart, gateEnd);
  assert.ok(!gateSection.includes("metric_progress"), "stop gate (Phase 3) must not consume metric_progress");
  assert.ok(!gateSection.includes("REVIEW_VERDICT"), "stop gate must not use REVIEW_VERDICT");
  // Verify stop_reason vocabulary
  for (const reason of ["metric_met", "budget_exhausted", "patience_exhausted", "invalid_metric"]) {
    assert.ok(loop.includes(reason), `stop_reason '${reason}' must be defined`);
  }
  // Acceptance provenance must be deterministic, not from a reviewer id
  assert.ok(loop.includes("deterministic:${STOP_REASON}"), "loop accept provenance must use deterministic:<stop_reason>");
});

// ============================================================================
// metric-gate evaluate — crash/resume edge cases
// ============================================================================

test("metric-gate evaluate: NaN in metric.history returns invalid_metric JSON", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.72, baseline: 0.65, history: [{ iter: 1, value: NaN }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, "NaN history must return exit 0 with invalid_metric JSON");
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: Infinity current fires invalid_metric", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: Infinity, baseline: 0.65, history: [{ iter: 1, value: 0.65 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: priority — metric_met beats budget_exhausted", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      iteration: 5,
      max_iterations: 5,
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.85, baseline: 0.65, history: [{ iter: 1, value: 0.65 }, { iter: 5, value: 0.85 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "metric_met", "metric_met must take priority over budget_exhausted");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: patience streak recomputed from history (crash-safe, no double-count)", () => {
  const d = tmpDir();
  try {
    // Simulate: crash after iter 3, resume at iter 4.
    // history shows improvement at iter 2, then stagnation at iter 3 and 4.
    // streak should be 2, not 3+ (no double-counting from a counter).
    const dash = makeDashboard({
      iteration: 4,
      max_iterations: 10,
      config: { patience: 3 },
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.70, baseline: 0.65, history: [{ iter: 1, value: 0.65 }, { iter: 2, value: 0.72 }, { iter: 3, value: 0.71 }, { iter: 4, value: 0.70 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.no_progress_streak, 2, "streak must be derived from history, not accumulated");
    assert.equal(dec.stop_reason, null, "patience=3 means streak=2 does not stop");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: lower_better patience streak computed correctly", () => {
  const d = tmpDir();
  try {
    // lower_better: improvements = lower values
    // iter 1=5.0, iter 2=4.0 (better), iter 3=4.5 (worse), iter 4=4.8 (worse) -> streak=2
    const dash = makeDashboard({
      iteration: 4,
      max_iterations: 10,
      config: { patience: 2 },
      metric: { name: "perplexity", target: 3.0, direction: "lower_better", tolerance: 0.01, current: 4.8, baseline: 5.0, history: [{ iter: 1, value: 5.0 }, { iter: 2, value: 4.0 }, { iter: 3, value: 4.5 }, { iter: 4, value: 4.8 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "patience_exhausted");
    assert.equal(dec.no_progress_streak, 2);
  } finally { cleanup(d); }
});

test("metric-gate evaluate: empty history means streak=0", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      iteration: 1,
      max_iterations: 5,
      config: { patience: 2 },
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01, current: 0.72, baseline: 0.65, history: [] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.no_progress_streak, 0);
    assert.equal(dec.stop_reason, null);
  } finally { cleanup(d); }
});

test("metric-gate config: parses baseline value", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\ntolerance: 0.01\nbaseline: 0.65\n");
    const r = metricGateCli("config", d);
    assert.equal(r.exitCode, 0, r.stderr);
    const cfg = JSON.parse(r.stdout.trim());
    assert.equal(cfg.baseline, 0.65);
  } finally { cleanup(d); }
});

test("metric-gate config: rejects negative tolerance", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# Project\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\ntolerance: -0.1\n");
    const r = metricGateCli("config", d);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("tolerance"), r.stderr);
  } finally { cleanup(d); }
});

// ============================================================================
// Status command
// ============================================================================

test("status command shows run info", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    const r = cli("status", d, "run-a");
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("run-a"));
  } finally { cleanup(d); }
});

// ============================================================================
// Phase 4: metric configuration chain — worker receipt field alignment
// ============================================================================

test("contract: analyze-results patches metric.current, not primary_metric", () => {
  const ar = fs.readFileSync(path.resolve("skills/analyze-results/SKILL.md"), "utf-8");
  const manifestStart = ar.indexOf("## Manifest Protocol");
  const endIdx = ar.indexOf("## Phase 0:", manifestStart);
  const protocol = ar.slice(manifestStart, endIdx);

  // Must have metric.current in the dashboard_patch example
  assert.ok(protocol.includes('"metric.current"'), 'dashboard_patch must use "metric.current" (dot-notation path for dashboard-merge.js)');

  // Must NOT use the old flat key
  const patchStart = protocol.indexOf('"dashboard_patch"');
  assert.ok(patchStart >= 0, "protocol must have dashboard_patch block");
  const patchEnd = protocol.indexOf("\n}", patchStart) + 2;
  const patch = protocol.slice(patchStart, patchEnd);
  assert.ok(!patch.includes('"primary_metric"'), 'dashboard_patch must not use legacy "primary_metric" key');
  assert.ok(!patch.includes('"metric_delta"'), 'dashboard_patch must not use legacy "metric_delta" key (use "metric.delta")');
});

test("contract: experiment-bridge never patches metric.baseline (anchored at setup time)", () => {
  const eb = fs.readFileSync(path.resolve("skills/experiment-bridge/SKILL.md"), "utf-8");
  const manifestStart = eb.indexOf("## Manifest Protocol");
  const workflowStart = eb.indexOf("## Workflow");
  const protocol = eb.slice(manifestStart, workflowStart);

  // The baseline is reproduced in /research-setup Phase 7.6, not by this worker.
  assert.ok(!protocol.includes('"metric.baseline"'), 'dashboard_patch must not patch "metric.baseline" (baseline is anchored during /research-setup Phase 7.6)');

  // The protocol must say so, so a reader knows where the baseline comes from.
  assert.ok(protocol.includes("research-setup"), "manifest protocol must point at /research-setup as the baseline owner");

  // Must NOT use the old flat key in any receipt example
  assert.ok(!protocol.includes('"primary_metric"'), 'dashboard_patch must not use legacy "primary_metric" key');
});

test("contract: metric configuration chain is consistent across template, setup, and gate", () => {
  const template = fs.readFileSync(path.resolve("templates/CLAUDE_MD_TEMPLATE.md"), "utf-8");
  const setup = fs.readFileSync(path.resolve("skills/research-setup/SKILL.md"), "utf-8");

  // Template must have the metric block inside HTML comments (template is not a config)
  const templateSection = template.slice(template.indexOf("## Metric Target"));
  assert.ok(templateSection.includes("<!--"), "template Metric Target block must be commented out (prevents metric-gate from parsing example values)");
  assert.ok(templateSection.includes("higher_better"), "template must show higher_better as an option");
  assert.ok(templateSection.includes("lower_better"), "template must show lower_better as an option");

  // Research-setup must wire Q8 → direction field using higher_better/lower_better vocabulary
  assert.ok(setup.includes("higher_better"), "research-setup must use higher_better vocabulary");
  assert.ok(setup.includes("lower_better"), "research-setup must use lower_better vocabulary");

  // Research-setup's CLAUDE.md write must use direction: not direction-other-form
  const phase7 = setup.slice(setup.indexOf("## Phase 7"));
  assert.ok(phase7.includes("direction: <answers.metric_direction>") || phase7.includes("direction: $DIRECTION"), "Phase 7 must write direction field using metric_direction answer");

  // No deleted pipeline-coupling field in auto-research-loop
  const loop = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  assert.ok(!loop.includes("auto_research_iterations"), "auto-research-loop must not read auto_research_iterations (deleted coupling field)");
  assert.ok(!loop.includes("research-pipeline-coupling"), "no pipeline-coupling config references");
});

test("contract: dashboard-merge.js wires metric.current to metric.history", () => {
  // Verify the tool source handles the current-metric key
  const src = fs.readFileSync(path.resolve("src/tools/dashboard-merge.ts"), "utf-8");
  assert.ok(src.includes('"metric.current"') || src.includes("metric.current"), 'dashboard-merge must recognize metric.current patch key');
  assert.ok(!src.includes('"metric.baseline"'), 'no worker may patch metric.baseline (anchored during /research-setup Phase 7.6)');
  assert.ok(src.includes("metric.history"), 'dashboard-merge must append to metric.history');

  // Verify the history append is idempotent (checks by iteration number)
  const historyAppendIdx = src.indexOf("history.push");
  assert.ok(historyAppendIdx >= 0, "must append to history");
  const idempotencyCheckIdx = src.lastIndexOf("findIndex(", historyAppendIdx);
  assert.ok(idempotencyCheckIdx >= 0 && idempotencyCheckIdx < historyAppendIdx, "history append must be guarded by an idempotency check (findIndex())");
});

// ============================================================================
// metric-gate — negative target tolerance (abs-band)
// ============================================================================

test("metric-gate evaluate: negative target uses abs(target)*tolerance band (higher_better)", () => {
  // target = -2.5, tolerance = 0.1
  // Correct threshold: -2.5 - abs(-2.5)*0.1 = -2.5 - 0.25 = -2.75
  // So current = -2.6 (> -2.75) should be metric_met.
  // Old buggy formula: -2.5 * (1 - 0.1) = -2.5 * 0.9 = -2.25
  //   that would require current >= -2.25 (wrong, too strict for negative targets)
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "loss", target: -2.5, direction: "higher_better", tolerance: 0.1,
        current: -2.6, baseline: -3.0, history: [{ iter: 1, value: -3.0 }, { iter: 2, value: -2.6 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "metric_met", "current -2.6 is within abs-band of target -2.5 (threshold -2.75)");
    assert.equal(dec.metric_met, true);
  } finally { cleanup(d); }
});

test("metric-gate evaluate: negative target uses abs(target)*tolerance band (lower_better)", () => {
  // target = -1.0 (lower_better), tolerance = 0.1
  // Correct threshold: -1.0 + abs(-1.0)*0.1 = -1.0 + 0.1 = -0.9
  // current = -0.85 (< -0.9 is false, so NOT met)
  // current = -0.95 (< -0.9 is true → met!)
  // Old buggy: -1.0 * (1 + 0.1) = -1.1, so current <= -1.1 (wrong)
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "neg_loss", target: -1.0, direction: "lower_better", tolerance: 0.1,
        current: -0.95, baseline: -0.5, history: [{ iter: 1, value: -0.5 }, { iter: 2, value: -0.95 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "metric_met", "current -0.95 <= threshold -0.9 for lower_better");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: zero target with tolerance does not divide by zero", () => {
  // target = 0, tolerance = 0.05 → band = 0, threshold = 0
  // current = 0 → 0 >= 0 → met
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "error", target: 0, direction: "higher_better", tolerance: 0.05,
        current: 0, baseline: 0, history: [{ iter: 1, value: 0 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, r.stderr);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "metric_met");
  } finally { cleanup(d); }
});

// ============================================================================
// metric-gate config — empty baseline accepted
// ============================================================================

test("metric-gate config: empty-string baseline accepted as null", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, '# P\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\nbaseline: ""\n');
    const r = metricGateCli("config", d);
    assert.equal(r.exitCode, 0, `should succeed: ${r.stderr}`);
    const cfg = JSON.parse(r.stdout.trim());
    assert.equal(cfg.baseline, null, "quoted empty baseline must parse as null");
  } finally { cleanup(d); }
});

test("metric-gate config: absent baseline accepted as null", () => {
  const d = tmpDir();
  try {
    writeClaudeMd(d, "# P\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\n");
    const r = metricGateCli("config", d);
    assert.equal(r.exitCode, 0, r.stderr);
    const cfg = JSON.parse(r.stdout.trim());
    assert.equal(cfg.baseline, null, "absent baseline must parse as null");
  } finally { cleanup(d); }
});

// ============================================================================
// dashboard-merge — current overrides same-iteration baseline history
// ============================================================================

test("dashboard-merge: final review metric replaces the bridge metric for the same iteration", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      current_phase: "experiment-bridge",
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01,
        current: null, baseline: null, history: [] },
    });
    writeDash(d, "run1", dash);

    const experiments = [{
      slug: "iter-1-attempt",
      title: "Improvement attempt",
      idea: "idea-1",
      verdict: "yes",
      confidence: "high",
      metrics: "F1=0.65",
      reasoning: "Improved over the anchored baseline.",
      provenance: ".aris/runs/run1/workers/1-experiment-bridge/outputs/analysis/EXPERIMENT_RESULTS.md",
      tags: ["iteration-1"],
    }];
    const baseReceipt = writeWorkerReceipt(d, "run1", "1-experiment-bridge", {
      worker: "experiment-bridge",
      primary_output: "analysis/EXPERIMENT_RESULTS.md",
      summary: { experiments_run: 1, analysis_verdict: "pass" },
      dashboard_patch: {
        "metric.current": 0.65,
        "metric.delta": 0,
        statistical_significance: false,
        experiment_ids: ["iter-1-attempt"],
      },
      experiments,
    });
    dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", baseReceipt);

    let updated = JSON.parse(fs.readFileSync(
      path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    let history = (updated.metric as Record<string, unknown>).history as Record<string, unknown>[];
    assert.equal(history.length, 1, "bridge must create one history entry");
    assert.equal(history[0].value, 0.65, "bridge history entry value");

    updated.current_phase = "auto-review-loop";
    fs.writeFileSync(
      path.join(d, ".aris", "runs", "run1", "dashboard.json"),
      JSON.stringify(updated, null, 2),
    );
    const reviewReceipt = writeWorkerReceipt(d, "run1", "1-auto-review-loop", {
      worker: "auto-review-loop",
      primary_output: "AUTO_REVIEW.md",
      summary: { rounds: 2, final_verdict: "ready", analysis_verdict: "pass" },
      dashboard_patch: {
        "last_review.verdict": "ready",
        "last_review.score": 7,
        "last_review.reviewer_id": "reviewer-1",
        "metric.current": 0.72,
        "metric.delta": 0.07,
        statistical_significance: true,
      },
    });
    const applied = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", reviewReceipt);
    assert.equal(applied.exitCode, 0, applied.stderr);

    updated = JSON.parse(fs.readFileSync(
      path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    history = (updated.metric as Record<string, unknown>).history as Record<string, unknown>[];
    assert.equal(history.length, 1, "must still be 1 entry (overwritten, not appended)");
    assert.equal(history[0].value, 0.72,
      "the final reviewed value must overwrite the initial bridge value");
    assert.equal(history[0].source, "auto-review-loop");
  } finally { cleanup(d); }
});

test("dashboard-merge: an applied receipt remains idempotent after the phase advances", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      current_phase: "experiment-bridge",
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01,
        current: null, baseline: null, history: [] },
    });
    writeDash(d, "run1", dash);

    const receiptPath = writeWorkerReceipt(d, "run1", "1-experiment-bridge", {
      worker: "experiment-bridge",
      primary_output: "analysis/EXPERIMENT_RESULTS.md",
      dashboard_patch: {
        "metric.current": 0.65,
        experiment_ids: ["iter-1-attempt"],
      },
      experiments: [{
        slug: "iter-1-attempt",
        title: "Improvement attempt",
        idea: "idea-1",
        verdict: "yes",
        confidence: "high",
        metrics: "F1=0.65",
        reasoning: "Ran.",
        provenance: ".aris/runs/run1/workers/1-experiment-bridge/outputs/analysis/EXPERIMENT_RESULTS.md",
        tags: ["iteration-1"],
      }],
    });
    const first = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.equal(first.exitCode, 0, first.stderr);

    const updated = JSON.parse(fs.readFileSync(
      path.join(d, ".aris", "runs", "run1", "dashboard.json"), "utf-8"));
    updated.current_phase = "auto-review-loop";
    fs.writeFileSync(
      path.join(d, ".aris", "runs", "run1", "dashboard.json"),
      JSON.stringify(updated, null, 2),
    );

    const second = dashMergeCli("apply", "--root", d, "--run-id", "run1", "--receipt", receiptPath);
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).reason, "already-applied");
  } finally { cleanup(d); }
});

// ============================================================================
// Contract: invalid_metric must not reach completed or accepted
// ============================================================================

test("contract: auto-research-loop invalid_metric uses failed status, not accept or completed", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const metricEvalStart = arl.indexOf("## Phase 3: Metric Evaluation");
  const gapStart = arl.indexOf("## Phase 4:");
  const metricEval = arl.slice(metricEvalStart, gapStart);

  // Must handle invalid_metric
  assert.ok(metricEval.includes("invalid_metric"), "Phase 3 must handle invalid_metric");

  // Extract the invalid_metric code block (```bash ... ```)
  const invalidStart = metricEval.indexOf('stop_reason == "invalid_metric"');
  assert.ok(invalidStart >= 0, "must have explicit invalid_metric branch");
  const codeStart = metricEval.indexOf("```bash", invalidStart);
  const codeEnd = metricEval.indexOf("```", codeStart + 7);
  assert.ok(codeStart >= 0 && codeEnd >= 0, "must have a code block in the invalid_metric branch");
  const codeBlock = metricEval.slice(codeStart, codeEnd);

  // Code block must NOT call accept
  assert.ok(!codeBlock.includes("accept"), "invalid_metric code must NOT call accept");

  // Code block must NOT set status=completed
  assert.ok(!codeBlock.includes('"completed"'), "invalid_metric code must NOT set status completed");

  // Code block must set loop to failed
  assert.ok(codeBlock.includes("loop failed"), "invalid_metric must mark loop as failed");

  // Code block must set dashboard status to invalid
  assert.ok(codeBlock.includes('"invalid"'), "invalid_metric must set dashboard status to invalid");

  // Code block must skip summary and paper-writing
  assert.ok(codeBlock.includes("summary skipped"), "invalid_metric must skip summary");
  assert.ok(codeBlock.includes("paper-writing skipped"), "invalid_metric must skip paper-writing");

  // Code block must exit with error
  assert.ok(codeBlock.includes("exit 1"), "invalid_metric must exit with non-zero");
});

test("contract: auto-research-loop dashboard status vocabulary includes invalid", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const statusSection = arl.slice(arl.indexOf("**Status values:**"), arl.indexOf("On resume,"));
  assert.ok(statusSection.includes("`invalid`"), "dashboard status vocabulary must include invalid");
  const resumeSection = arl.slice(
    arl.indexOf("# ---- RESUME PATH ----"),
    arl.indexOf("# ---- FRESH START PATH ----"),
  );
  assert.ok(resumeSection.includes('[ "$STATUS" = "invalid" ]') &&
    resumeSection.includes("cannot resume"),
  "an invalid run must exit on resume instead of re-entering its failed loop");
});

// ============================================================================
// Contract: research-pipeline persists ALL constants for resume
// ============================================================================

test("contract: research-pipeline persists all override constants in dashboard.config", () => {
  const pipeline = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");

  // Every constant that a stage reads from its manifest context must be in config
  const requiredFields = [
    "research_direction", "auto_write", "venue", "render_html",
    "auto_proceed", "arxiv_download", "human_checkpoint",
    "reviewer_difficulty", "code_review", "base_repo", "compact",
  ];

  // Check they are all persisted in the dashboard init (between cat > "$DASHBOARD" and the closing DASH)
  const dashInitStart = pipeline.indexOf('cat > "$DASHBOARD"');
  const dashInitEnd = pipeline.indexOf("\nDASH", dashInitStart);
  assert.ok(dashInitStart >= 0 && dashInitEnd >= 0, "must find dashboard init block");
  const dashInit = pipeline.slice(dashInitStart, dashInitEnd);
  for (const field of requiredFields) {
    assert.ok(dashInit.includes(`"${field}"`),
      `dashboard init must persist "${field}" in config`);
  }

  // Check they are all restored in the resume path
  const resumeStart = pipeline.indexOf("# ---- RESUME PATH ----");
  const freshStart = pipeline.indexOf("# ---- FRESH START PATH ----");
  const resumeSection = pipeline.slice(resumeStart, freshStart);
  for (const field of requiredFields) {
    assert.ok(resumeSection.includes(`.config.${field}`),
      `resume path must restore config.${field} from dashboard`);
  }
});

test("contract: auto-research-loop persists all resume-needed constants", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const requiredFields = ["auto_write", "render_html", "patience"];

  const dashInitStart = arl.indexOf('cat > "$DASHBOARD"');
  const dashInitEnd = arl.indexOf("\nDASH", dashInitStart);
  assert.ok(dashInitStart >= 0 && dashInitEnd >= 0, "must find dashboard init block");
  const dashInit = arl.slice(dashInitStart, dashInitEnd);
  for (const field of requiredFields) {
    assert.ok(dashInit.includes(`"${field}"`),
      `auto-research-loop dashboard init must persist "${field}" in config`);
  }

  const resumeStart = arl.indexOf("# ---- RESUME PATH ----");
  const freshStart = arl.indexOf("# ---- FRESH START PATH ----");
  const resumeSection = arl.slice(resumeStart, freshStart);
  for (const field of requiredFields) {
    assert.ok(resumeSection.includes(`.config.${field}`),
      `auto-research-loop resume must restore config.${field}`);
  }
});

// ============================================================================
// Contract: analyze-results uses cross-model verifier
// ============================================================================

test("contract: analyze-results verifier is cross-model (not claude)", () => {
  const ar = fs.readFileSync(path.resolve("skills/analyze-results/SKILL.md"), "utf-8");
  const phase3Start = ar.indexOf("## Phase 3:");
  const phase4Start = ar.indexOf("## Phase 4:");
  const phase3 = ar.slice(phase3Start, phase4Start);

  // The provider in the dispatch block must not be claude
  assert.ok(!phase3.includes("provider: claude\n"),
    "Phase 3 verifier must not use provider: claude (same model family as executor)");
  // It must use codex or an explicit cross-model provider
  assert.ok(phase3.includes("codex") || phase3.includes("gpt-5.5"),
    "Phase 3 verifier must use a cross-model provider (codex/gpt-5.5)");
});

// ============================================================================
// Contract: one post-idea gap-planner owns the audit stage
// ============================================================================

test("contract: auto-research-loop runs one gap audit and plan stage after idea discovery", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const ideaStart = arl.indexOf("## Phase 4: Idea Discovery");
  const gapStart = arl.indexOf("## Phase 4.5: Gap Planner");
  const summaryStart = arl.indexOf("## Phase 5:");
  assert.ok(ideaStart >= 0 && ideaStart < gapStart && gapStart < summaryStart,
    "idea discovery must run before the single gap-planner stage");

  const gapPhase = arl.slice(gapStart, summaryStart);
  assert.ok(gapPhase.includes("Dispatch `/gap-planner` once"),
    "the loop must call gap-planner only once");
  assert.ok(gapPhase.includes("Gap-planner itself is the audit stage"),
    "gap-planner itself must own gap rulings");
  assert.ok(gapPhase.includes("dispatches no separate gap auditor"),
    "the loop must not add another gap audit inside gap-planner");
  assert.ok(gapPhase.includes("mechanically composes"),
    "the same stage must mechanically compose the selected idea and audited gaps");
  assert.ok(!arl.includes("gap-planner-audit") && !arl.includes("Phase 4.75"),
    "the loop must not retain a pre-idea audit or a second gap-planner phase");
});

// ============================================================================
// Contract: tolerance formula uses abs(target)
// ============================================================================

test("contract: auto-research-loop tolerance formula uses abs(target) not multiplication", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  // Must use the abs-based formula, not the old multiply-based one
  assert.ok(arl.includes("abs(target) * tolerance") || arl.includes("abs(target)*tolerance"),
    "tolerance formula must use abs(target) * tolerance");
  assert.ok(!arl.includes("target * (1 - tolerance)"),
    "old multiply-based tolerance formula must be removed");
  assert.ok(!arl.includes("target * (1 + tolerance)"),
    "old multiply-based tolerance formula must be removed");
});

test("contract: metric-gate.ts uses abs-based threshold", () => {
  const src = fs.readFileSync(path.resolve("src/tools/metric-gate.ts"), "utf-8");
  assert.ok(src.includes("Math.abs(target)"),
    "metric-gate.ts must use Math.abs(target) in threshold calculation");
  assert.ok(!src.includes("target * (1 +") && !src.includes("target * (1 -"),
    "metric-gate.ts must not use old target*(1±tolerance) formula");
});

// ============================================================================
// Contract: iteration 1 skips idea-discovery (baseline)
// ============================================================================

test("contract: auto-research-loop runs idea-discovery on every iteration (no baseline iteration)", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const phase1Start = arl.indexOf("## Phase 1: Experiment Bridge");
  const phase2Start = arl.indexOf("## Phase 2:");
  const phase1 = arl.slice(phase1Start, phase2Start);
  assert.ok(!/Iteration 1:.*baseline plan/i.test(phase1),
    "the loop no longer reproduces a baseline in iteration 1 (that moved to /research-setup Phase 7.6)");
  assert.ok(/every iteration/i.test(phase1),
    "Phase 1 must state that the plan+idea source is the same on every iteration");

  const ideaStart = arl.indexOf("## Phase 4: Idea Discovery");
  const gapStart = arl.indexOf("## Phase 4.5: Gap Planner");
  const ideaPhase = arl.slice(ideaStart, gapStart);
  // Loop start opens directly at idea-discovery with SOURCE_ITERATION=0; only
  // iteration transitions advance the dashboard, and they do so exactly once.
  assert.ok(/loop start/i.test(ideaPhase) && ideaPhase.includes("SOURCE_ITERATION = 0"),
    "Phase 4 must document the loop-start entry case reading setup-time baseline evidence");
  assert.ok(ideaPhase.includes("advance the dashboard") && ideaPhase.includes("exactly once"),
    "an iteration transition must advance the dashboard exactly once");
});

// ============================================================================
// Issue 1: manifest token — dispatch and detect tokens must match
// ============================================================================

test("contract: auto-research-loop dispatch tokens match worker detection tokens", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const workers = ["idea-discovery", "experiment-bridge", "auto-review-loop", "gap-planner"];
  const skillsDir = path.resolve("skills");

  for (const w of workers) {
    // Extract the dispatch line from auto-research-loop
    const dispatchRe = new RegExp(`Dispatch:.*/${w}\\s+(.+manifest:.+)`, "i");
    const dispatchMatch = arl.match(dispatchRe);
    assert.ok(dispatchMatch, `auto-research-loop must have a Dispatch line for ${w}`);
    const dispatchToken = dispatchMatch![1].includes("—") ? "—" : "-";

    // Extract the detection token from the worker SKILL.md
    const workerPath = path.join(skillsDir, w, "SKILL.md");
    if (!fs.existsSync(workerPath)) continue;
    const workerContent = fs.readFileSync(workerPath, "utf-8");
    const detectMatch = workerContent.match(/contains\s+"(.)\s+manifest:/);
    if (!detectMatch) continue;
    const detectToken = detectMatch[1];

    assert.equal(dispatchToken, detectToken,
      `${w}: dispatch token '${dispatchToken}' (U+${dispatchToken.charCodeAt(0).toString(16)}) ` +
      `!= detect token '${detectToken}' (U+${detectToken.charCodeAt(0).toString(16)})`);
  }

  // The canonical dispatch template must also use em dash
  const templateLine = arl.match(/initialPrompt:.*<skill-name>\s*(.)\s*manifest:/);
  assert.ok(templateLine, "dispatch template must exist");
  assert.equal(templateLine![1].trim(), "—",
    `dispatch template token must be em dash (U+2014), got U+${templateLine![1].trim().charCodeAt(0).toString(16)}`);

  assert.ok(!/^Dispatch:.*\/analyze-results/m.test(arl),
    "auto-research-loop must not dispatch a separate outer analyze-results phase");
  const bridge = fs.readFileSync(path.resolve("skills/experiment-bridge/SKILL.md"), "utf-8");
  assert.ok(bridge.includes("/analyze-results — manifest: <internal-manifest-path>"),
    "experiment-bridge must dispatch its own structured analysis worker");
});

// ============================================================================
// Gap-planner manifest context must use flat metric_* keys
// ============================================================================

test("contract: post-idea gap-planner context uses flat metric_* keys matching its schema", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  const gp = fs.readFileSync(path.resolve("skills/gap-planner/SKILL.md"), "utf-8");

  const gapPhaseStart = arl.indexOf("## Phase 4.5: Gap Planner");
  const summaryPhaseStart = arl.indexOf("## Phase 5:");
  const gapPhase = arl.slice(gapPhaseStart, summaryPhaseStart);
  const contextLine = gapPhase.slice(gapPhase.indexOf("Context:"), gapPhase.indexOf("\n\n", gapPhase.indexOf("Context:")));

  // Must NOT use nested "metric" object — gap-planner expects flat keys
  assert.ok(!contextLine.includes("`metric` (") && !contextLine.includes("`metric`("),
    "gap-planner context must not pass a nested metric object");

  // Extract the gap-planner manifest context keys
  const gpManifest = gp.slice(gp.indexOf('"context"'), gp.indexOf('"output_dir"'));
  const gpKeys = [...gpManifest.matchAll(/"(metric_\w+)"/g)].map(m => m[1]);
  assert.ok(gpKeys.length >= 5, `gap-planner must declare at least 5 metric_* keys (got ${gpKeys.length})`);

  // Every gap-planner flat key must appear in the one post-idea context.
  for (const key of gpKeys) {
    assert.ok(contextLine.includes(key),
      `post-idea gap-planner context must include '${key}'`);
  }
});

// ============================================================================
// Issue 3: metric-gate malformed metric → JSON with stop_reason=invalid_metric
// ============================================================================

test("metric-gate evaluate: malformed direction returns invalid_metric JSON (not exit 1)", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "F1", target: 0.85, direction: "sideways", tolerance: 0.01,
        current: 0.72, baseline: 0.65, history: [{ iter: 1, value: 0.65 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    // Must succeed (exit 0) with JSON containing stop_reason
    assert.equal(r.exitCode, 0, `malformed direction must return exit 0 with JSON, got exit ${r.exitCode}: ${r.stderr}`);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
    assert.ok(typeof dec.invalid_reason === "string" && dec.invalid_reason.length > 0,
      "must include invalid_reason explaining what's wrong");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: non-finite target returns invalid_metric JSON (not exit 1)", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "F1", target: "bad", direction: "higher_better", tolerance: 0.01,
        current: 0.72, baseline: 0.65, history: [{ iter: 1, value: 0.65 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, `non-finite target must return exit 0 with JSON, got exit ${r.exitCode}: ${r.stderr}`);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: negative tolerance returns invalid_metric JSON (not exit 1)", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: -0.1,
        current: 0.72, baseline: 0.65, history: [{ iter: 1, value: 0.65 }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, `negative tolerance must return exit 0 with JSON, got exit ${r.exitCode}: ${r.stderr}`);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: malformed history entry returns invalid_metric JSON (not exit 1)", () => {
  const d = tmpDir();
  try {
    const dash = makeDashboard({
      metric: { name: "F1", target: 0.85, direction: "higher_better", tolerance: 0.01,
        current: 0.72, baseline: 0.65, history: [{ iter: 1, value: "not_a_number" }] },
    });
    writeDash(d, "run1", dash);
    const r = metricGateCli("evaluate", d, "run1");
    assert.equal(r.exitCode, 0, `malformed history must return exit 0 with JSON, got exit ${r.exitCode}: ${r.stderr}`);
    const dec = JSON.parse(r.stdout.trim());
    assert.equal(dec.stop_reason, "invalid_metric");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: missing dashboard still exit 1 (cannot return JSON without it)", () => {
  const d = tmpDir();
  try {
    const r = metricGateCli("evaluate", d, "nonexistent");
    assert.notEqual(r.exitCode, 0, "missing dashboard must exit 1 (not a metric issue, infrastructure issue)");
  } finally { cleanup(d); }
});

test("metric-gate evaluate: rejects a run id that can escape the run directory", () => {
  const d = tmpDir();
  try {
    const r = metricGateCli("evaluate", d, "../../outside");
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("invalid run id"), r.stderr);
  } finally { cleanup(d); }
});

// ============================================================================
// Issue 5: verify_paper_audits.sh resolved via $AUDIT_VERIFIER
// ============================================================================

test("contract: auto-research-loop resolves verify_paper_audits.sh via AUDIT_VERIFIER helper chain", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");

  // Must have a resolver block for AUDIT_VERIFIER
  assert.ok(arl.includes('AUDIT_VERIFIER='), "must resolve AUDIT_VERIFIER via helper chain");
  assert.ok(arl.includes('.aris/tools/verify_paper_audits.sh') && arl.includes('tools/verify_paper_audits.sh'),
    "AUDIT_VERIFIER resolver must check both .aris/tools/ and tools/ paths");

  // Paper Writing phase must call via $AUDIT_VERIFIER, not bare path
  const phase6Start = arl.indexOf("## Phase 6: Paper Writing");
  const resumeStart = arl.indexOf("## Resume Protocol");
  const phase6 = arl.slice(phase6Start, resumeStart);

  // Must have $AUDIT_VERIFIER invocation
  assert.ok(phase6.includes('$AUDIT_VERIFIER') || phase6.includes('"$AUDIT_VERIFIER"'),
    "Phase 6 (Paper Writing) must invoke verify_paper_audits.sh via $AUDIT_VERIFIER variable");

  // Actual run commands (lines starting with bash/sh or standalone calls)
  // must not use bare verify_paper_audits.sh — provenance labels in --verdict-id are fine
  const codeBlocks = [...phase6.matchAll(/```[\s\S]*?```/g)].map(m => m[0]);
  for (const block of codeBlocks) {
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.includes("verify_paper_audits.sh") && !line.includes("$AUDIT_VERIFIER") &&
          !line.includes("--verdict-id") && !line.includes("--reviewer") &&
          !line.includes("AUDIT_VERIFIER=")) {
        assert.fail(`Phase 6 invokes verify_paper_audits.sh without $AUDIT_VERIFIER: ${line.trim()}`);
      }
    }
  }
});

// ============================================================================
// Issue 6: idea-discovery receipt carries Gate 1 provenance
// ============================================================================

test("contract: idea-discovery receipt includes gate1_provenance for verifiable acceptance", () => {
  const id = fs.readFileSync(path.resolve("skills/idea-discovery/SKILL.md"), "utf-8");
  const receiptStart = id.indexOf("receipt.json");
  const receiptEnd = id.indexOf("```", id.indexOf("```json", receiptStart) + 10);
  const receiptBlock = id.slice(receiptStart, receiptEnd);

  // Must include gate1_provenance
  assert.ok(receiptBlock.includes("gate1_provenance"),
    "idea-discovery receipt must include gate1_provenance block");

  // Must carry specific fields
  for (const field of ["novelty_verdict", "novelty_agent_id", "review_verdict", "review_agent_id", "reviewer_model"]) {
    assert.ok(receiptBlock.includes(field),
      `gate1_provenance must include '${field}'`);
  }
});

// ============================================================================
// Issue 7: integration-contract helper table includes new helpers
// ============================================================================

test("contract: integration-contract helper policy table registers metric-gate, dashboard-merge, render_w_agent_prompt", () => {
  const ic = fs.readFileSync(path.resolve("skills/shared-references/integration-contract.md"), "utf-8");
  const tableStart = ic.indexOf("| Helper (canonical name)");
  const tableEnd = ic.indexOf("When a SKILL invokes a helper not listed above");
  assert.ok(tableStart >= 0 && tableEnd >= 0, "must find helper policy table");
  const table = ic.slice(tableStart, tableEnd);

  assert.ok(table.includes("metric-gate.js"), "table must register metric-gate.js");
  assert.ok(table.includes("dashboard-merge.js"), "table must register dashboard-merge.js");
  assert.ok(table.includes("render_w_agent_prompt.sh"), "table must register render_w_agent_prompt.sh");

  // All three must be Policy A (gate)
  for (const helper of ["metric-gate.js", "dashboard-merge.js", "render_w_agent_prompt.sh"]) {
    const row = table.slice(table.indexOf(helper), table.indexOf("\n|", table.indexOf(helper) + 1));
    assert.ok(row.includes("A (gate)") || row.includes("A(gate)"),
      `${helper} must be Policy A (gate)`);
  }
});

// ============================================================================
// Issue 1: run-state transition test — done→failed is allowed but semantically wrong
// ============================================================================

test("run-state: pending→failed is valid (clean invalid_metric path)", () => {
  const d = tmpDir();
  try {
    cli("start", d, "run-a", "--phases", "W1,W2,W3");
    cli("set", d, "run-a", "W1", "running");
    // direct pending/running → failed (the clean path for invalid_metric)
    const r = cli("set", d, "run-a", "W1", "failed");
    assert.equal(r.exitCode, 0, "running→failed must succeed");
    assert.equal(findPhase(readState(d, "run-a"), "W1").status, "failed");
  } finally { cleanup(d); }
});

test("run-state: done→failed is technically allowed but auto-research-loop avoids it", () => {
  const d = tmpDir();
  try {
    // Prove the transition is legal in run-state
    cli("start", d, "run-a", "--phases", "W1,W2");
    cli("set", d, "run-a", "W1", "done");
    const r = cli("set", d, "run-a", "W1", "failed");
    assert.equal(r.exitCode, 0, "done→failed is technically allowed by run-state");

    // But auto-research-loop Phase 3 branches BEFORE setting done, so this path never fires
    const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
    const phase3Start = arl.indexOf("## Phase 3: Metric Evaluation");
    const phase4Start = arl.indexOf("## Phase 4:");
    const phase3 = arl.slice(phase3Start, phase4Start);

    // The "done" set must come AFTER the invalid_metric branch, not before
    const invalidBranchIdx = phase3.indexOf('invalid_metric');
    const doneSetIdx = phase3.indexOf("loop done");
    const failedSetIdx = phase3.indexOf("loop failed");
    assert.ok(invalidBranchIdx >= 0, "must have invalid_metric branch");
    assert.ok(failedSetIdx >= 0, "must have loop failed for invalid_metric");
    assert.ok(doneSetIdx >= 0, "must have loop done for normal stop");
    // failed must come before done in the source (invalid branch checked first)
    assert.ok(failedSetIdx < doneSetIdx,
      "loop failed (invalid_metric) must appear before loop done (normal stop) — branch before setting done");
  } finally { cleanup(d); }
});

// ============================================================================
// Issue 3: auto-research-loop dispatches metric-gap-constrained idea-discovery
// for iteration 2+, and experiment-bridge consumes both gap-planner's plan
// and idea-discovery's IDEA_REPORT.md together
// ============================================================================

test("contract: auto-research-loop dispatches idea-discovery for iteration 2+ (metric-gap constrained)", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");

  // Phase 4 exists and dispatches idea-discovery before gap-planner.
  const phase4Start = arl.indexOf("## Phase 4: Idea Discovery");
  const gapStart = arl.indexOf("## Phase 4.5: Gap Planner");
  const phase5Start = arl.indexOf("## Phase 5:");
  assert.ok(phase4Start >= 0 && phase4Start < gapStart,
    "auto-research-loop must run Phase 4 idea discovery before gap-planner");
  const phase4 = arl.slice(phase4Start, gapStart);

  assert.ok(phase4.includes("/idea-discovery"), "Phase 4 must dispatch /idea-discovery");
  assert.ok(phase4.includes("metric_gap_constrained"),
    "Phase 4 must set metric_gap_constrained in the idea-discovery context");
  assert.ok(phase4.includes("no literature survey") && phase4.includes("Every retry"),
    "iteration 2+ idea discovery must stay on the no-literature short branch");

  // Phase 4 advances once, then hands the selected idea to one gap-planner run.
  assert.ok(arl.includes('current_phase = "idea-discovery"'),
    "the continuing loop must set current_phase to idea-discovery");
  assert.ok(phase4.includes('current_phase = "gap-planner"'),
    "idea discovery must hand the selected idea to gap-planner");

  const gapPhase = arl.slice(gapStart, phase5Start);
  assert.ok(gapPhase.includes('current_phase = "experiment-bridge"'),
    "gap-planner must hand the completed plan to the next experiment-bridge run");

  const ideaSkill = fs.readFileSync(path.resolve("skills/idea-discovery/SKILL.md"), "utf-8");
  const shortBranch = ideaSkill.slice(
    ideaSkill.indexOf("### Metric-gap constrained branch"),
    ideaSkill.indexOf("## Phase 0:"),
  );
  assert.ok(shortBranch.includes("forbid web search, literature\n   lookup"),
    "the short branch's reviewer must not restart literature research");
});

test("contract: auto-research-loop experiment-bridge input references idea_report every iteration", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  // Phase 1 consumes artifacts prepared for the iteration that is now running.
  const phase1Start = arl.indexOf("## Phase 1: Experiment Bridge");
  const phase2Start = arl.indexOf("## Phase 2:");
  const phase1 = arl.slice(phase1Start, phase2Start);
  assert.ok(phase1.includes("idea_report"), "Phase 1 input must include idea_report");
  assert.ok(phase1.includes("${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md"),
    "Phase 1 idea_report must point at the current iteration's prepared idea");
  assert.ok(phase1.includes("${ITERATION}-gap-planner/outputs/EXPERIMENT_PLAN.md"),
    "Phase 1 plan must point at the current iteration's post-idea plan");
  assert.ok(!phase1.includes("${PREV_ITERATION}"),
    "Phase 1 must not look one iteration behind after the dashboard has advanced");
  assert.ok(!/omitted \(iter ?1\)/i.test(phase1),
    "idea_report is never omitted now - idea-discovery runs before every iteration's bridge");
});

// ============================================================================
// Issue 4: research-pipeline Gate 1 reads provenance from receipt
// ============================================================================

test("contract: research-pipeline Gate 1 reads gate1_provenance from receipt, not worker text", () => {
  const pipeline = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");
  const gate1Start = pipeline.indexOf("Gate 1");
  const stage2Start = pipeline.indexOf("### Stage 2:");
  const gate1 = pipeline.slice(gate1Start, stage2Start);

  // Must read from receipt.json
  assert.ok(gate1.includes("receipt.json"), "Gate 1 must read from receipt.json");
  assert.ok(gate1.includes("gate1_provenance"), "Gate 1 must reference gate1_provenance from receipt");
  assert.ok(gate1.includes("review_agent_id"), "Gate 1 must use review_agent_id from provenance");

  // Must NOT read worker output files
  assert.ok(!gate1.includes("IDEA_REPORT.md") || gate1.includes("primary_output"),
    "Gate 1 must not directly read IDEA_REPORT.md");

  // AUTO_PROCEED=false must use ranked_ideas from receipt
  assert.ok(gate1.includes("ranked_ideas"), "Gate 1 must present ranked_ideas from receipt");
});

test("contract: idea-discovery receipt provides ranked_ideas for orchestrator display", () => {
  const id = fs.readFileSync(path.resolve("skills/idea-discovery/SKILL.md"), "utf-8");
  const receiptStart = id.indexOf('"worker": "idea-discovery"');
  const receiptEnd = id.indexOf("```", id.indexOf("```json", receiptStart - 50) + 10);
  const receiptBlock = id.slice(receiptStart, receiptEnd);

  // Must have ranked_ideas
  assert.ok(receiptBlock.includes('"ranked_ideas"'), "receipt must include ranked_ideas array");

  // Each entry must have id, title, rank, score
  for (const field of ["id", "title", "rank", "score"]) {
    assert.ok(receiptBlock.includes(`"${field}"`),
      `ranked_ideas entries must include "${field}"`);
  }
});

test("contract: research-pipeline Gate 1 accept uses receipt provenance fields, not hardcoded agent id", () => {
  const pipeline = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");

  // The acceptance table must reference receipt-based provenance
  const tableStart = pipeline.indexOf("## Acceptance Authority Table");
  const resumeStart = pipeline.indexOf("## Resume");
  const table = pipeline.slice(tableStart, resumeStart);
  assert.ok(table.includes("receipt.gate1_provenance"),
    "acceptance table must reference receipt.gate1_provenance");

  // Gate 1 code block must use $REVIEW_AGENT_ID from receipt, not a hardcoded codex id
  const gate1Start = pipeline.indexOf("Gate 1");
  const stage2Start = pipeline.indexOf("### Stage 2:");
  const gate1 = pipeline.slice(gate1Start, stage2Start);
  assert.ok(gate1.includes("REVIEW_AGENT_ID") && gate1.includes("jq"),
    "Gate 1 must extract review_agent_id from receipt via jq");
});

// ============================================================================
// Runner
// ============================================================================

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`  PASS ${t.name}`);
      passed++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  FAIL ${t.name}: ${msg}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
