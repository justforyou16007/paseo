import fs from "node:fs";
import path from "node:path";
import type { TesterFacilityConfig } from "../../src/tools/tester-facility.js";

/**
 * A two-sample benchmark whose runner scores each sample by whether the
 * artifact's answers.json matches the hidden labels. Runs anywhere Node runs.
 */
export function facilityConfig(root: string): TesterFacilityConfig {
  const bench = path.join(path.resolve(root), "bench");
  fs.mkdirSync(bench, { recursive: true });
  fs.writeFileSync(
    path.join(bench, "labels.json"),
    JSON.stringify({ "sample-alpha": "the quick brown fox", "sample-bravo": "jumps over" }),
  );
  fs.writeFileSync(
    path.join(bench, "runner.mjs"),
    `import fs from "node:fs";
import path from "node:path";
const labels = JSON.parse(fs.readFileSync(new URL("./labels.json", import.meta.url), "utf8"));
const out = process.env.ARIS_TEST_OUTPUT;
if (out) {
  const ref = process.env.ARIS_ARTIFACT_REF;
  const file = fs.existsSync(ref) && fs.statSync(ref).isDirectory() ? path.join(ref, "answers.json") : ref;
  let answers = {};
  try { answers = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const ids = process.env.ARIS_TEST_MODE === "smoke" ? Object.keys(labels).slice(0, 1) : Object.keys(labels);
  const samples = ids.map((id) => ({ id, status: "ok", metrics: { score: answers[id] === labels[id] ? 1 : 0 } }));
  const score = samples.reduce((a, s) => a + s.metrics.score, 0) / samples.length;
  fs.writeFileSync(out, JSON.stringify({ artifact_sha256: process.env.ARIS_ARTIFACT_SHA256, metrics: { score }, samples, evidence_files: [] }));
}
`,
  );
  const runner = { argv: [process.execPath, path.join(bench, "runner.mjs")], timeout_ms: 10_000 };
  return {
    schema_version: 1,
    mode: "tester_facility",
    tester_id: "fixture-tester",
    project_id: "fixture-project",
    version: "v1",
    benchmark: { name: "fixture", source: "fixture", revision: "fixed" },
    dataset: { name: "fixture", revision: "fixed", split: "test", expected_samples: 2 },
    metrics: [{ name: "score", direction: "higher_better", aggregation: "mean" }],
    execution: { cwd: bench, env: {} },
    setup: [],
    healthcheck: { argv: [process.execPath, "-e", ""], timeout_ms: 10_000 },
    smoke: runner,
    test: runner,
    evidence_files: ["runner.mjs", "labels.json"],
  };
}
