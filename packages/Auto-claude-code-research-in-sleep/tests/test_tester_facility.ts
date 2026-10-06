import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import { createRootRun } from "../src/tools/run-contract.js";
import { runWikiRoot } from "../src/tools/wiki-scope.js";
import {
  initializeWikiSchema,
  appendWikiEvent,
  readWikiEvents,
} from "../src/tools/wiki-event-store.js";
import { readWikiModel } from "../src/tools/wiki-projector.js";
import { addExperiment } from "../src/tools/research-wiki.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  setupTesterFacility,
  testerConfigPath,
  assertTesterSetupReady,
  prepareTesterJob,
  executeTesterJob,
  testerJobDirectory,
  readTesterJob,
  checkTesterResult,
  auditTesterResult,
  readAuditedTesterResult,
  evidenceFile,
  type TesterTestRequest,
} from "../src/tools/tester-facility.js";
import { writeStateJsonAtomic, readStateFile } from "../src/tools/state-file.js";
import { facilityConfig } from "./helpers/tester-facility-fixture.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-facility-"));
try {
  const runner = path.join(root, "runner.mjs");
  fs.writeFileSync(
    runner,
    `import fs from 'node:fs'; if(process.env.ARIS_TEST_OUTPUT) fs.writeFileSync(process.env.ARIS_TEST_OUTPUT,JSON.stringify({artifact_sha256:process.env.ARIS_ARTIFACT_SHA256,metrics:{score:0.75},samples:[{id:'a',status:'ok',metrics:{score:0.5}},{id:'b',status:'ok',metrics:{score:1}}],evidence_files:[]}));`,
  );
  const config = facilityConfig(root);
  config.evidence_files = ["runner.mjs"];
  config.test = { argv: [process.execPath, runner], timeout_ms: 1000 };
  config.smoke = config.test;
  fs.mkdirSync(path.join(root, ".claude"));
  writeStateJsonAtomic(path.join(root, ".claude/settings.json"), {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { command: 'node ".aris/dist/templates/search-guard.js"' },
            { command: "node other-hook.js" },
          ],
        },
      ],
    },
  });
  await setupTesterFacility(root, config);
  assertTesterSetupReady(testerConfigPath(root));
  await setupTesterFacility(root, config);
  assert.equal(
    JSON.stringify(readStateFile(path.join(root, ".claude/settings.json"))).includes(
      "search-guard",
    ),
    false,
  );
  const request: TesterTestRequest = {
    schema_version: 1,
    test_id: "trial-1",
    run_id: "root-run",
    iteration: 1,
    experiment_id: "exp-1",
    artifact: { ref: "model-revision", sha256: "a".repeat(64) },
    mode: "full",
  };
  prepareTesterJob(root, testerConfigPath(root), request);
  assert.throws(
    () => prepareTesterJob(root, testerConfigPath(root), { ...request, iteration: 2 }),
    /another request/,
  );
  const result = await executeTesterJob(root, request.test_id);
  assert.equal(result.metrics.score, 0.75);
  assert.equal(readTesterJob(root, request.test_id).status, "completed");
  assert.deepEqual(await executeTesterJob(root, request.test_id), result);
  const dir = testerJobDirectory(root, request.test_id),
    resultPath = path.join(dir, "test-result.json"),
    auditPath = path.join(dir, "test-audit.json"),
    review = path.join(dir, "review.json");
  // Recompute hashes so these cases exercise semantic checks, rather than tamper detection.
  const mutantRaw = path.join(dir, "mutant-raw.json"),
    mutantResult = path.join(dir, "mutant-result.json");
  const rawOriginal = readStateFile<any>(path.join(dir, "benchmark-output.json"));
  function rejectsInvalidMeasurement(change: (raw: any, changed: any) => void, code: string) {
    const raw = structuredClone(rawOriginal),
      changed = structuredClone(result);
    change(raw, changed);
    writeStateJsonAtomic(mutantRaw, raw);
    changed.evidence = [evidenceFile(mutantRaw)];
    changed.request_sha256 = canonicalJsonSha256(changed.request);
    writeStateJsonAtomic(mutantResult, changed);
    assert.throws(() => checkTesterResult(mutantResult), new RegExp(code));
  }
  rejectsInvalidMeasurement((_raw, changed) => {
    changed.request.mode = "smoke";
  }, "TESTER_FULL_RESULT_REQUIRED");
  rejectsInvalidMeasurement((raw, changed) => {
    raw.samples.pop();
    changed.sample_count = 1;
  }, "TESTER_COVERAGE_INCOMPLETE");
  rejectsInvalidMeasurement((raw) => {
    raw.samples[1].id = raw.samples[0].id;
  }, "TESTER_COVERAGE_INCOMPLETE");
  rejectsInvalidMeasurement((raw, changed) => {
    raw.samples[0].status = "failed";
    changed.failed_samples = 1;
  }, "TESTER_COVERAGE_INCOMPLETE");
  rejectsInvalidMeasurement((raw, changed) => {
    raw.metrics.score = changed.metrics.score = 100;
  }, "TESTER_AGGREGATION_MISMATCH");
  rejectsInvalidMeasurement((raw) => {
    delete raw.samples[0].metrics.score;
  }, "TESTER_SCORE_MISSING");
  checkTesterResult(resultPath);
  assert.throws(() => readAuditedTesterResult(resultPath, auditPath));
  const reviewValue = {
    schema_version: 1,
    result_sha256: evidenceFile(resultPath).sha256,
    reviewer_id: "independent-reviewer",
    status: "pass",
    checks: { protocol: true, scoring: true, coverage: true, comparability: true },
    findings: [],
  };
  writeStateJsonAtomic(review, reviewValue);
  auditTesterResult(resultPath, review);
  const recordedAudit = readStateFile<any>(auditPath);
  recordedAudit.completed_at = "2026-01-01T00:00:00.000Z";
  writeStateJsonAtomic(auditPath, recordedAudit);
  const originalAuditBytes = fs.readFileSync(auditPath, "utf8");
  assert.deepEqual(auditTesterResult(resultPath, review), recordedAudit);
  assert.equal(fs.readFileSync(auditPath, "utf8"), originalAuditBytes,
    "recovering a completed audit must retain its exact evidence digest");
  readAuditedTesterResult(resultPath, auditPath, {
    run_id: "root-run",
    iteration: 1,
    experiment_id: "exp-1",
  });
  assert.throws(
    () => readAuditedTesterResult(resultPath, auditPath, { iteration: 2 }),
    /iteration/,
  );
  writeStateJsonAtomic(review, { ...reviewValue, status: "warn" });
  auditTesterResult(resultPath, review);
  assert.throws(() => readAuditedTesterResult(resultPath, auditPath), /passing tester audit/);
  writeStateJsonAtomic(review, reviewValue);
  auditTesterResult(resultPath, review);
  createRootRun({
    project_root: root,
    run_id: "root-run",
    input_snapshot_sha256: "b".repeat(64),
    code_baseline_sha256: "c".repeat(64),
    policy_revision: "fixture",
  });
  const wiki = runWikiRoot(root, "root-run");
  initializeWikiSchema(wiki);
  assert.throws(
    () => addExperiment(wiki, "untested", { iteration: 1, metrics: "score 1" }),
    /TESTER_AUDIT_REQUIRED/,
  );
  assert.throws(
    () =>
      appendWikiEvent(wiki, {
        producer_kind: "fixture",
        scope: "runs/root-run",
        subject_id: "exp:untested",
        evidence_bundle_id: "fixture",
        payload: {
          operations: [
            {
              op: "upsert_page",
              kind: "experiment",
              id: "untested",
              data: { title: "untested", metrics: "score 1", iteration: 1 },
            },
          ],
        },
      }),
    /TESTER_AUDIT_REQUIRED/,
  );
  assert.throws(
    () =>
      addExperiment(wiki, "exp-1", {
        iteration: 2,
        testResult: { result: resultPath, audit: auditPath },
        runId: "root-run",
      }),
    /iteration/,
  );
  addExperiment(wiki, "exp-1", {
    iteration: 1,
    testResult: { result: resultPath, audit: auditPath },
    runId: "root-run",
  });
  const page = readWikiModel(wiki).pages.experiment.get("exp-1")!;
  assert.equal(page.data.tester_audit_status, "pass");
  assert.equal((page.data.tester_metrics as any).score, 0.75);
  assert.equal(page.data.metrics, JSON.stringify(result.metrics));
  const before = readWikiEvents(wiki).length;
  writeStateJsonAtomic(review, { ...reviewValue, status: "warn" });
  auditTesterResult(resultPath, review);
  assert.throws(
    () =>
      addExperiment(wiki, "exp-1", {
        testResult: { result: resultPath, audit: auditPath },
        runId: "root-run",
      }),
    /passing tester audit/,
  );
  assert.equal(readWikiEvents(wiki).length, before);
  writeStateJsonAtomic(review, reviewValue);
  auditTesterResult(resultPath, review);
  fs.appendFileSync(path.join(dir, "benchmark-output.json"), " ");
  assert.throws(() => checkTesterResult(resultPath), /benchmark-output/);
  // Failed worker attempts can resume, completed IDs cannot bind different requests.
  const model = path.join(root, "retry-model");
  fs.writeFileSync(model, "wrong artifact");
  const retry = {
    ...request,
    test_id: "retry",
    artifact: { ref: model, sha256: evidenceFile(runner).sha256 },
  };
  prepareTesterJob(root, testerConfigPath(root), retry);
  await assert.rejects(executeTesterJob(root, retry.test_id), /artifact differs/);
  assert.equal(readTesterJob(root, retry.test_id).status, "failed");
  fs.copyFileSync(runner, model);
  await executeTesterJob(root, retry.test_id);
  assert.equal(readTesterJob(root, retry.test_id).attempt, 2);
  const cli = path.resolve(import.meta.dirname, "../src/tools/tester-facility-cli.ts");
  const requestPath = path.join(root, "request.json");
  writeStateJsonAtomic(requestPath, { ...request, test_id: "cli-background" });
  const spawned = spawnSync(
    process.execPath,
    [...process.execArgv, cli, "test", "--project", root, "--input", requestPath],
    { encoding: "utf8" },
  );
  assert.equal(spawned.status, 0, spawned.stderr);
  for (let i = 0; i < 100; i++) {
    const job = readTesterJob(root, "cli-background");
    if (job.status === "completed") break;
    assert.notEqual(job.status, "failed", job.error ?? "");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(readTesterJob(root, "cli-background").status, "completed");
  // Exercise SSH execution/transfer with a local transport fixture; no remote host is contacted.
  const oldPath = process.env.PATH,
    bin = path.join(root, "ssh-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), '#!/bin/bash\nshift 4\nexec bash -c "$1"\n', {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const sshConfig = {
      ...config,
      execution: { ...config.execution, kind: "ssh" as const, host: "fixture-host" },
    };
    await setupTesterFacility(root, sshConfig);
    const sshRequest = { ...request, test_id: "ssh-fixture" };
    prepareTesterJob(root, testerConfigPath(root), sshRequest);
    const remote = await executeTesterJob(root, sshRequest.test_id);
    assert.equal(remote.sample_count, 2);
    const remoteResult = path.join(
      testerJobDirectory(root, sshRequest.test_id),
      "test-result.json",
    );
    checkTesterResult(remoteResult);
    const stale = { ...request, test_id: "interrupted" };
    prepareTesterJob(root, testerConfigPath(root), stale);
    const jobFile = path.join(testerJobDirectory(root, stale.test_id), "job.json");
    writeStateJsonAtomic(jobFile, {
      ...readTesterJob(root, stale.test_id),
      status: "running",
      pid: 2147483647,
    });
    assert.equal(readTesterJob(root, stale.test_id).status, "failed");
    await executeTesterJob(root, stale.test_id);
  } finally {
    process.env.PATH = oldPath;
  }
  console.log(
    "tester facility: setup, migration, jobs, retries, background CLI, audit and evidence checks passed",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
