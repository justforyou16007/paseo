import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJsonSha256 } from "../../src/tools/canonical-json.js";
import { writeStateJsonAtomic } from "../../src/tools/state-file.js";
import {
  auditTesterResult,
  evidenceFile,
  testerFacilityConfigSha256,
  testerConfigPath,
  type TesterFacilityConfig,
  type TesterTestRequest,
  type TesterTestResult,
} from "../../src/tools/tester-facility.js";
import type {
  TesterPromotionConclusion,
  TesterPromotionFeedback,
} from "../../src/tools/tester-promotion-result.js";

export function facilityConfig(root: string): TesterFacilityConfig {
  const noop = { argv: [process.execPath, "-e", ""], timeout_ms: 1000 };
  return {
    schema_version: 1,
    mode: "tester_facility",
    tester_id: "tester:a2",
    project_id: "project:a2",
    version: "tester:v1",
    benchmark: { name: "fixture", source: "fixture", revision: "fixed" },
    dataset: { name: "fixture", revision: "fixed", split: "test", expected_samples: 2 },
    metrics: [{ name: "score", direction: "higher_better", aggregation: "mean" }],
    execution: { kind: "local", cwd: path.resolve(root), env: {} },
    setup: [],
    healthcheck: noop,
    smoke: noop,
    test: noop,
    evidence_files: ["runner-fixture.txt"],
  };
}
/** Synthetic provisioned installation for tests of callers, not setup itself. */
export function installedFacilityFixture(root: string): TesterFacilityConfig {
  const config = facilityConfig(root);
  fs.mkdirSync(root, { recursive: true });
  const pinned = path.join(root, "runner-fixture.txt");
  fs.writeFileSync(pinned, "fixed runner\n");
  writeStateJsonAtomic(testerConfigPath(root), config);
  writeStateJsonAtomic(`${testerConfigPath(root)}.setup.json`, {
    schema_version: 1,
    status: "ready",
    config_sha256: testerFacilityConfigSha256(config),
    evidence: [evidenceFile(pinned)],
    completed_at: "fixture",
  });
  return config;
}
/** Results are synthetic; all audits still pass through the production gate. */
export function auditedResultFixture(
  root: string,
  request: TesterTestRequest,
  metrics: Record<string, number>,
  promotion?: unknown,
  facility?: TesterFacilityConfig,
) {
  if (request.deliverables === undefined) {
    const outputRef = `outputs/${request.test_id}/candidate.json`;
    const output = path.join(root, ".aris", "runs", request.run_id, outputRef);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ model: request.artifact, synthetic_fixture: true }));
    request = { ...request, deliverables: { output_hashes: { [outputRef]: crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex") } } };
  }
  const dir = path.join(root, "fixture-results", request.test_id);
  fs.mkdirSync(dir, { recursive: true });
  const config = facility ?? facilityConfig(root);
  config.metrics = Object.keys(metrics).map((name) => ({
    ...config.metrics.find((m) => m.name === name),
    name,
    direction: config.metrics.find((m) => m.name === name)?.direction ?? "higher_better",
    aggregation: "mean",
  }));
  const rawPath = path.join(dir, "benchmark-output.json");
  writeStateJsonAtomic(rawPath, {
    artifact_sha256: request.artifact.sha256,
    metrics,
    samples: [0, 1].map((i) => ({ id: String(i), status: "ok", metrics })),
    evidence_files: [],
    ...(promotion ? { promotion } : {}),
  });
  const result: TesterTestResult = {
    schema_version: 1,
    test_id: request.test_id,
    request,
    request_sha256: canonicalJsonSha256(request),
    config,
    config_sha256: testerFacilityConfigSha256(config),
    status: "completed",
    metrics,
    sample_count: 2,
    failed_samples: 0,
    evidence: [evidenceFile(rawPath)],
    completed_at: "fixture",
  };
  const result_path = path.join(dir, "test-result.json"),
    review = path.join(dir, "review.json"),
    audit_path = path.join(dir, "test-audit.json");
  writeStateJsonAtomic(result_path, result);
  writeStateJsonAtomic(review, {
    schema_version: 1,
    result_sha256: evidenceFile(result_path).sha256,
    reviewer_id: "independent-fixture-reviewer",
    status: "pass",
    checks: { protocol: true, scoring: true, coverage: true, comparability: true },
    findings: [],
  });
  auditTesterResult(result_path, review);
  return { result_path, audit_path };
}
export function auditedPromotionFixture(
  root: string,
  conclusion: TesterPromotionConclusion,
  feedback: TesterPromotionFeedback,
) {
  return auditedResultFixture(
    root,
    {
      schema_version: 1,
      test_id: `promotion-${conclusion.outer_iteration}`,
      run_id: conclusion.outer_run_id,
      iteration: conclusion.outer_iteration,
      experiment_id: "promotion",
      artifact: { ref: "fixture-artifact", sha256: conclusion.finalist_artifact_sha256 },
      mode: "full",
    },
    { tester_score: 1.5 },
    { conclusion, feedback },
  );
}
