import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRootRun, runOwnedPath } from "../src/tools/run-contract.js";
import {
  advanceStandaloneTesterPhase,
  assertStandaloneTesterAssessment,
} from "../src/tools/standalone-tester.js";
import {
  installedFacilityFixture,
  auditedResultFixture,
} from "./helpers/tester-facility-fixture.js";
import { addExperiment } from "../src/tools/research-wiki.js";
import {
  initializeWikiSchema,
  appendWikiEvent,
  readWikiEvents,
} from "../src/tools/wiki-event-store.js";
import { runWikiRoot } from "../src/tools/wiki-scope.js";
import { readWikiModel } from "../src/tools/wiki-projector.js";
import { planResultExport, exportResultPackage } from "../src/tools/result-export.js";
import { saveResultReview } from "../src/tools/result-review.js";
import { evidenceFile, type TesterTestRequest } from "../src/tools/tester-facility.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-tester-delivery-")),
    run = "root";
  createRootRun({
    project_root: root,
    run_id: run,
    input_snapshot_sha256: "a".repeat(64),
    code_baseline_sha256: "b".repeat(64),
    policy_revision: "review:r1",
  });
  const facility = installedFacilityFixture(root);
  const dashboard = {
    run_id: run,
    project: "tester",
    status: "running",
    iteration: 1,
    current_phase: "experiment-bridge",
    config: { max_iterations: 2, max_repair_attempts: 3, patience: 2 },
    metric: {
      name: "score",
      target: 0.95,
      direction: "higher_better",
      tolerance: 0,
      baseline: 0.2,
      current: 0.2,
      history: [{ iter: 1, value: 0.2 }],
    },
    problems: { open: [], closed: [], total: 0 },
    last_review: {},
    system_errors: { total: 0, last: null },
    applied_receipts: [],
  };
  fs.writeFileSync(runOwnedPath(root, run, "dashboard.json"), JSON.stringify(dashboard));
  const wiki = runWikiRoot(root, run);
  initializeWikiSchema(wiki);
  return { root, run, facility, wiki };
}
function measured(f: ReturnType<typeof fixture>, id: string, score = 0.6, experiment = "iter-1") {
  const ref = `outputs/${id}/model.json`,
    file = runOwnedPath(f.root, f.run, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: id }));
  const planRef = `outputs/${id}/deploy.json`,
    plan = runOwnedPath(f.root, f.run, planRef);
  fs.writeFileSync(plan, JSON.stringify({ model_path: ref }));
  const request: TesterTestRequest = {
    schema_version: 1,
    test_id: id,
    run_id: f.run,
    iteration: 1,
    experiment_id: experiment,
    artifact: { ref: file, sha256: evidenceFile(file).sha256 },
    deliverables: {
      output_hashes: { [ref]: evidenceFile(file).sha256, [planRef]: evidenceFile(plan).sha256 },
      execution_plan_ref: planRef,
    },
    mode: "full",
  };
  return {
    ...auditedResultFixture(f.root, request, { score }, undefined, f.facility),
    request,
    file,
  };
}
function worker(
  f: ReturnType<typeof fixture>,
  name: string,
  id: string,
  summary: Record<string, unknown>,
  patch: Record<string, unknown>,
  primary?: string,
) {
  const dir = runOwnedPath(f.root, f.run, "workers", `1-${name}-${id}`),
    out = path.join(dir, "outputs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "input-manifest.json"),
    JSON.stringify({
      worker: name,
      run_id: f.run,
      iteration: 1,
      inputs: {},
      context: {},
      output_dir: out,
    }),
  );
  const content = primary ? fs.readFileSync(primary) : Buffer.from("complete\n");
  fs.writeFileSync(path.join(out, "result.json"), content);
  const receipt = path.join(dir, "receipt.json");
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      worker: name,
      phase: name,
      run_id: f.run,
      iteration: 1,
      status: "done",
      error: null,
      primary_output: "result.json",
      primary_output_sha256: crypto.createHash("sha256").update(content).digest("hex"),
      summary,
      dashboard_patch: patch,
      completed_at: "2026-10-05T00:00:00Z",
      has_errors: false,
      error_count: 0,
    }),
  );
  return receipt;
}
function cli(tool: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [...process.execArgv, path.join(packageRoot, "src/tools", `${tool}.ts`), ...args],
    { cwd: packageRoot, encoding: "utf8" },
  );
}
function merge(f: ReturnType<typeof fixture>, receipt: string) {
  return cli("dashboard-merge", [
    "apply",
    "--root",
    f.root,
    "--run-id",
    f.run,
    "--receipt",
    receipt,
  ]);
}
function stage(
  f: ReturnType<typeof fixture>,
  from: string,
  to: string,
  binding?: ReturnType<typeof measured>,
) {
  return advanceStandaloneTesterPhase({
    project_root: f.root,
    run_id: f.run,
    from_phase: from,
    to_phase: to,
    test_result_path: binding?.result_path,
    test_audit_path: binding?.audit_path,
  });
}
function bridge(f: ReturnType<typeof fixture>) {
  const result = merge(
    f,
    worker(f, "experiment-bridge", "v1", {}, { "metric.current": 0.2, experiment_ids: ["iter-1"] }),
  );
  assert.equal(result.status, 0, result.stderr);
}
function assess(
  f: ReturnType<typeof fixture>,
  binding: ReturnType<typeof measured>,
  from = "experiment-bridge",
) {
  stage(f, from, "tester-test");
  const testReceipt = worker(
    f,
    "tester-test",
    binding.request.test_id,
    { test_result_path: binding.result_path },
    {},
    binding.result_path,
  );
  assert.equal(merge(f, testReceipt).status, 0);
  stage(f, "tester-test", "tester-audit", binding);
  const auditReceipt = worker(
    f,
    "tester-audit",
    binding.request.test_id,
    { test_result_path: binding.result_path, test_audit_path: binding.audit_path },
    {},
    binding.audit_path,
  );
  assert.equal(merge(f, auditReceipt).status, 0);
  stage(f, "tester-audit", "auto-review-loop", binding);
}
function review(
  f: ReturnType<typeof fixture>,
  binding: ReturnType<typeof measured>,
  value: number,
  id: string,
) {
  const receipt = worker(
    f,
    "auto-review-loop",
    id,
    { test_result_path: binding.result_path, test_audit_path: binding.audit_path },
    {
      "last_review.verdict": "ready",
      "last_review.score": 7,
      "last_review.reviewer_id": "reviewer:quality",
      "metric.current": value,
    },
  );
  return { receipt, result: merge(f, receipt) };
}

test("standalone test/audit recovery binds the review metric and exports the tested files", () => {
  const f = fixture();
  try {
    bridge(f);
    const binding = measured(f, "v1");
    assert.throws(
      () => stage(f, "experiment-bridge", "auto-review-loop", binding),
      /test then audit/,
    );
    assess(f, binding);
    assert.deepEqual(
      stage(f, "tester-audit", "auto-review-loop", binding),
      JSON.parse(fs.readFileSync(runOwnedPath(f.root, f.run, "dashboard.json"), "utf8")),
    );
    const reading = cli("tester-facility-cli", [
      "measure",
      "--project",
      f.root,
      "--run",
      f.run,
      "--iteration",
      "1",
      "--metric",
      "primary.score",
      "--result",
      binding.result_path,
      "--audit",
      binding.audit_path,
    ]);
    assert.equal(reading.status, 0, reading.stderr);
    assert.deepEqual(JSON.parse(reading.stdout), {
      metric_name: "score",
      metric_value: 0.6,
      experiment_id: binding.request.experiment_id,
      test_result_path: binding.result_path,
      test_audit_path: binding.audit_path,
    });
    const wrong = review(f, binding, 0.99, "wrong");
    assert.notEqual(wrong.result.status, 0);
    assert.match(wrong.result.stderr, /TESTER_METRIC_MISMATCH/);
    addExperiment(f.wiki, "iter-1", {
      iteration: 1,
      runId: f.run,
      gateMetric: 0.6,
      testResult: { result: binding.result_path, audit: binding.audit_path },
    });
    assert.equal(review(f, binding, 0.6, "final").result.status, 0);
    const planned = planResultExport({ project_root: f.root, run_id: f.run });
    const cliPlan = cli("result-export-cli", [
      "plan",
      "--project",
      f.root,
      "--run",
      f.run,
      "--wiki-root",
      f.wiki,
    ]);
    assert.equal(cliPlan.status, 0, cliPlan.stderr);
    assert.equal(
      JSON.parse(cliPlan.stdout).candidate.package_sha256,
      planned.candidate.package_sha256,
    );
    assert.deepEqual(planned.candidate.output_hashes, binding.request.deliverables!.output_hashes);
    assert.equal(
      planned.candidate.execution_plan_ref,
      binding.request.deliverables!.execution_plan_ref,
    );
    saveResultReview(f.root, {
      schema_version: 1,
      review_id: "review:publish",
      run_id: f.run,
      reviewer_worker_id: "external-reviewer",
      package_sha256: planned.candidate.package_sha256,
      verdict: "approved",
      evidence_refs: [],
      reason_codes: [],
    });
    const published = exportResultPackage({
      project_root: f.root,
      run_id: f.run,
      review: { review_id: "review:publish" },
    });
    assert.equal(published.result_package.local_metrics?.["primary.score"], 0.6);
    fs.appendFileSync(binding.file, "changed");
    assert.throws(
      () => planResultExport({ project_root: f.root, run_id: f.run }),
      /output file changed after testing/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("same-score replacement cannot reuse claims; a new experiment revision binds the final export", () => {
  const f = fixture();
  try {
    bridge(f);
    const first = measured(f, "v1", 0.2);
    assess(f, first);
    addExperiment(f.wiki, "iter-1", {
      iteration: 1,
      runId: f.run,
      gateMetric: 0.2,
      testResult: { result: first.result_path, audit: first.audit_path },
    });
    assert.equal(review(f, first, 0.2, "first").result.status, 0);
    appendWikiEvent(f.wiki, {
      producer_kind: "claim-fixture",
      scope: `runs/${f.run}`,
      subject_id: "exp:iter-1",
      evidence_bundle_id: "claim",
      payload: {
        context: {},
        operations: [
          {
            op: "upsert_edge",
            edge: { from: "exp:iter-1", to: "claim:one", type: "supports", evidence: "measured" },
          },
        ],
      },
    });
    const count = readWikiEvents(f.wiki).length;
    addExperiment(f.wiki, "iter-1", {
      iteration: 1,
      runId: f.run,
      gateMetric: 0.2,
      updateOnExist: true,
      testResult: { result: first.result_path, audit: first.audit_path },
    });
    assert.equal(readWikiEvents(f.wiki).length, count);
    const replacement = measured(f, "v2", 0.2);
    assert.throws(
      () =>
        addExperiment(f.wiki, "iter-1", {
          iteration: 1,
          runId: f.run,
          gateMetric: 0.2,
          updateOnExist: true,
          testResult: { result: replacement.result_path, audit: replacement.audit_path },
        }),
      /different tested evidence/,
    );
    const revised = measured(f, "v3", 0.2, "iter-1-v3");
    assess(f, revised, "auto-review-loop");
    addExperiment(f.wiki, "iter-1-v3", {
      iteration: 1,
      runId: f.run,
      gateMetric: 0.2,
      testResult: { result: revised.result_path, audit: revised.audit_path },
    });
    assert.equal(review(f, revised, 0.2, "revised").result.status, 0);
    const exported = planResultExport({ project_root: f.root, run_id: f.run });
    assert.equal(exported.winner!.page_id, "iter-1-v3");
    assert.deepEqual(exported.candidate.output_hashes, revised.request.deliverables!.output_hashes);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("Wiki refuses a forged stop reading and standalone refuses changed audit evidence", () => {
  const f = fixture();
  try {
    bridge(f);
    const binding = measured(f, "v1");
    assess(f, binding);
    assert.throws(
      () =>
        addExperiment(f.wiki, "iter-1", {
          iteration: 1,
          runId: f.run,
          gateMetric: 0.99,
          testResult: { result: binding.result_path, audit: binding.audit_path },
        }),
      /gate metric differs/,
    );
    fs.appendFileSync(binding.audit_path, " ");
    const dashboard = JSON.parse(
      fs.readFileSync(runOwnedPath(f.root, f.run, "dashboard.json"), "utf8"),
    );
    assert.throws(
      () => assertStandaloneTesterAssessment(f.root, f.run, dashboard),
      /recorded standalone tester evidence changed/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("reviewed idea outcome and lessons survive subsequent Wiki projection", () => {
  const f = fixture();
  try {
    const base = [
      "upsert_idea",
      f.wiki,
      "--slug",
      "candidate",
      "--title",
      "Candidate",
      "--stage",
      "active",
      "--thesis",
      "Frozen hypothesis",
      "--risks",
      "Known limitation",
      "--tags",
      "benchmark",
      "--based-on",
      "",
      "--target-problems",
      "",
    ];
    const initial = cli("research-wiki", [
      ...base,
      "--description",
      "Original",
      "--outcome",
      "pending",
    ]);
    assert.equal(initial.status, 0, initial.stderr);
    const update = cli("research-wiki", [
      ...base,
      "--description",
      "Original; reviewed improvement and lessons",
      "--outcome",
      "positive",
      "--update-on-exist",
    ]);
    assert.equal(update.status, 0, update.stderr);
    const log = cli("research-wiki", ["log", f.wiki, "result-to-claim completed"]);
    assert.equal(log.status, 0, log.stderr);
    const idea = readWikiModel(f.wiki).pages.idea.get("candidate")!.data;
    assert.equal(idea.outcome, "positive");
    assert.equal(idea.stage, "active");
    assert.equal(idea.thesis, "Frozen hypothesis");
    assert.equal(idea.risks, "Known limitation");
    assert.equal(idea.description, "Original; reviewed improvement and lessons");
    assert.match(
      fs.readFileSync(path.join(f.wiki, "ideas/candidate.md"), "utf8"),
      /reviewed improvement/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("standalone stage CLI works without Workflow ownership and requires bridge evidence", () => {
  const f = fixture();
  try {
    const args = [
      "stage",
      "--project",
      f.root,
      "--run",
      f.run,
      "--from",
      "experiment-bridge",
      "--to",
      "tester-test",
    ];
    assert.match(cli("tester-facility-cli", args).stderr, /BRIDGE_SUCCESS_REQUIRED/);
    bridge(f);
    const result = cli("tester-facility-cli", args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).current_phase, "tester-test");
    assert.equal(fs.existsSync(runOwnedPath(f.root, f.run, "workflow-runtime.json")), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
