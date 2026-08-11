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
    "idea-discovery", "idea-creator", "experiment-bridge", "analyze-results",
    "auto-review-loop", "kill-argument", "paper-writing", "render-html",
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
    "idea-discovery", "idea-creator", "experiment-bridge", "analyze-results",
    "auto-review-loop", "kill-argument", "paper-writing", "render-html",
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
        !line.toLowerCase().includes("direct-call")
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

  const badPaths = inputLines.filter((l) =>
    (l.includes("$ROOT/idea-stage") || l.includes("$ROOT/refine-logs") || l.includes("$ROOT/review-stage")) &&
    !l.includes("BASELINE_PLAN")
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
    path.resolve("skills/research-pipeline/scripts/render_w_agent_prompt.sh"),
    "utf-8",
  );
  assert.ok(render.includes("under its output_dir"), "rendered worker prompt must require output_dir");
  assert.ok(!render.includes("standard stage dir"), "rendered prompt retains ambiguous stage dir");
});

test("contract: resume restores persisted run configuration", () => {
  const arl = fs.readFileSync(path.resolve("skills/auto-research-loop/SKILL.md"), "utf-8");
  for (const field of ["baseline_plan", "auto_write", "render_html", "patience"]) {
    assert.ok(arl.includes(`.config.${field}`), `auto-research-loop does not restore config.${field}`);
  }
  assert.ok(!arl.includes("older than 24h"), "valid old runs must not be discarded by age");

  const pipeline = fs.readFileSync(path.resolve("skills/research-pipeline/SKILL.md"), "utf-8");
  for (const field of ["auto_research_iterations", "auto_write", "venue", "render_html"]) {
    assert.ok(pipeline.includes(`.config.${field}`), `research-pipeline does not restore config.${field}`);
  }
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
