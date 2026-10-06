import {auditedResultFixture} from "./helpers/tester-facility-fixture.js";
import {appendHistoricalWikiFixture} from "./helpers/wiki-history-fixture.js";
import {advanceAutoResearchPhase} from "../src/tools/workflow-runtime.js";
function assessmentSummary(identity:any) {
 const current=readWorkflowRuntimeState(identity.project_root,identity.outer_run_id).active_cycle!.tester_assessment!;
 return {test_result_path:path.resolve(identity.project_root,current.result_ref),test_audit_path:path.resolve(identity.project_root,current.audit_ref!)};
}
function prepareAssessment(identity:any, refresh=false) {
 const root=identity.project_root,run=identity.outer_run_id,state=readWorkflowRuntimeState(root,run);
 if(state.current_phase==="auto-review-loop"&&!refresh)return;
 const config=JSON.parse(fs.readFileSync(path.join(root,".aris/tester-config.json"),"utf8"));
 const binding=auditedResultFixture(root,{schema_version:1,test_id:`${run}-${state.active_cycle!.outer_iteration}${refresh?"-refreshed":""}`,run_id:run,iteration:state.active_cycle!.outer_iteration,experiment_id:"assessment",artifact:{ref:"fixture",sha256:"a".repeat(64)},mode:"full"},{score:.82},undefined,config);
 if(!refresh)assert.throws(()=>advanceAutoResearchPhase({...identity,from_phase:"workset",to_phase:"auto-review-loop",evidence_paths:[binding.result_path]}),/test then audit/);
 advanceAutoResearchPhase({...identity,from_phase:state.current_phase,to_phase:"tester-test",evidence_paths:[binding.result_path]});
 advanceAutoResearchPhase({...identity,from_phase:"tester-test",to_phase:"tester-audit",test_result_path:binding.result_path,evidence_paths:[binding.result_path]});
 advanceAutoResearchPhase({...identity,from_phase:"tester-audit",to_phase:"auto-review-loop",test_audit_path:binding.audit_path,evidence_paths:[binding.audit_path]});
}
import { installedFacilityFixture } from "./helpers/tester-facility-fixture.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import {
  assertOptimizableScopeSubset,
  createBaselineScope,
  type BaselineScope,
} from "../src/tools/baseline-scope.js";
import {
  createResourceInventory,
  classifyResourceRequest,
  resourceInventoryPath,
} from "../src/tools/resource-inventory.js";
import {
  buildResultPackageForRun,
  createResultPackage,
  resultPackagePath,
  readResultPackage,
  resultStatusPolicy,
  saveResultPackage,
  type ResultPackage,
  type ResultPackageInput,
} from "../src/tools/result-package.js";
import { saveResultReview } from "../src/tools/result-review.js";
import {
  collectMissingSetupItems,
  computeSetupReentryDiff,
  setupRootRun,
  SetupIncompleteError,
  type RootSetupInput,
} from "../src/tools/task-setup.js";
import { createRootCharter, readRootCharter, rootCharterPath } from "../src/tools/root-charter.js";
import { readFrozenPolicy, readWorkflowRuntimeState } from "../src/tools/workflow-state.js";
import { planExperimentBridge, materializeBridgeChildren } from "../src/tools/experiment-bridge.js";
import { readBaselineScope } from "../src/tools/baseline-scope.js";
import { readResourceInventory } from "../src/tools/resource-inventory.js";
import { runOwnedPath } from "../src/tools/run-contract.js";
import { beginOuterCycle, advanceOuterPhase, recordOuterBridgeSuccess, recordOuterBridgeFailure, recordOuterBridgeRepair, recordAutoResearchInsufficient, completeAutoResearchCycle, completeOuterCycle, recordWorkflowStopDecision, finishOuterRun, resumeAutoResearchRun, startAutoResearchRun } from "../src/tools/workflow-runtime.js";
import { appendWikiEvent, initializeWikiSchema } from "../src/tools/wiki-event-store.js";
import { runWikiRoot } from "../src/tools/wiki-scope.js";
import { planResultExport, exportResultPackage } from "../src/tools/result-export.js";
import { prepareBridgeInput } from "../src/tools/bridge-input.js";
import {
  createRun,
  readRun,
  readRunScopeLeaseTokens,
  releaseRunScope,
} from "../src/tools/run-contract.js";

const HASH_A = "a".repeat(64);

function writeReviewManifest(workerDir: string, runId: string): void {
  const outputDir = path.join(workerDir, "outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(workerDir, "input-manifest.json"), JSON.stringify({
    run_id: runId, iteration: 1, worker: "auto-review-loop", phase: "auto-review-loop",
    output_dir: outputDir,
  }));
}

function releaseTestProcessScope(root: string, runId: string): void {
  const run = readRun(root, runId);
  const scope = { project_root: root, run_id: runId, parent_run_id: run.parent_run_id, scope_path: run.scope_path };
  for (const token of readRunScopeLeaseTokens(scope))
    releaseRunScope({ ...scope, lease_token: token });
}

test("ARL root setup and charter-only Workflow start/resume use a finite round limit without budget", () => {
  const root = tempRoot();
  try {
    const input = baseInput(root, "root-arl", "setup:arl");
    delete input.budget;
    input.mode = "auto_research_loop";
    input.max_iterations = 2;
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "## Metric Target\nprimary: 0.8 score\ndirection: higher_better\ntolerance: 0.01\n");
    // Model choice is a CLAUDE.md rule in the loop, never a sealed setup item.
    assert.throws(
      () => setupRootRun({ ...input, model_usage_policy: { revision: "policy:arl" } }),
      /## Model Usage/,
    );
    const setup = setupRootRun(input);
    assert.equal(setup.root_charter.mode, "auto_research_loop");
    assert.equal(Object.hasOwn(setup.root_charter, "budget"), false);
    assert.equal(fs.existsSync(path.join(root, ".aris", "runs", "root-arl", "budget.json")), false);
    // Omitted loop limits are frozen at their defaults, never left implicit.
    assert.equal(setup.root_charter.max_repair_attempts, 3);
    assert.equal(setup.root_charter.max_depth, 2);
    releaseTestProcessScope(root, "root-arl");
    const executionRoot = path.join(root, "execution");
    const command = ["tsx", "src/tools/workflow-cli.ts", "start", "--execution-root", executionRoot, "--project", root, "--run", "root-arl", "--charter", rootCharterPath(root, "root-arl")];
    const started = spawnSync("npx", command, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    const policy = readFrozenPolicy(root, "root-arl");
    assert.equal(policy.mode, "auto_research_loop");
    assert.equal(policy.max_iterations, 2);
    assert.equal(policy.max_repair_attempts, 3);
    assert.equal(policy.max_depth, 2);
    assert.equal(Object.hasOwn(policy, "model_usage_policy"), false);
    assert.equal(readWorkflowRuntimeState(root, "root-arl").outer_run_id, "root-arl");
    const resumed = spawnSync("npx", command.map((part) => part === "start" ? "resume" : part), { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(fs.existsSync(path.join(root, ".aris", "runs", "root-arl", "dashboard.json")), false);
    const charter = setup.root_charter;
    const childContent = {
      problem: "Improve main", expected_output: "A measured candidate", evidence_refs: [], constraints: {}, input_snapshot_refs: [],
      baseline_ref: "W_0", baseline_sha256: charter.baseline_sha256, optimizable_scope: [],
      resource_inventory_sha256: charter.resource_inventory_sha256, resource_inventory_ref: charter.resource_inventory_ref,
      policy_revision: charter.policy_revision, code_baseline_sha256: charter.code_baseline_sha256,
      measurement: { validator_ref: "validator:main" },
    };
    const plan = planExperimentBridge({
      project_root: root,
      run: { run_id: "root-arl", depth: 0, scope_path: "/" },
      charter,
      baseline: readBaselineScope(root, "root-arl"),
      resource_inventory: readResourceInventory(root, "root-arl"),
      strategy_reason: "One declared position",
      positions: [{ position_id: "main", child_run_id: "child-arl", execution_plan: { method: "improve main" }, resource_request: { platform_id: "gpu-a" }, charter: childContent, acceptance: { metric: { name: "score", direction: "higher_better", threshold: 0.8 } } }],
    });
    assert.equal(plan.children.length, 1);
    assert.equal(plan.children[0]!.result.status, "succeeded", JSON.stringify(plan.children[0]!.result));
    materializeBridgeChildren(root, plan);
    releaseTestProcessScope(root, "child-arl");
    const childCharterPath = runOwnedPath(root, "child-arl", "charter.json");
    const childCharter = JSON.parse(fs.readFileSync(childCharterPath, "utf8"));
    assert.equal(childCharter.mode, "auto_research_loop");
    assert.equal(Object.hasOwn(childCharter, "budget"), false);
    const childCommand = ["tsx", "src/tools/workflow-cli.ts", "start", "--execution-root", executionRoot, "--project", root, "--run", "child-arl", "--charter", childCharterPath];
    const childStarted = spawnSync("npx", childCommand, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(childStarted.status, 0, childStarted.stderr);
    const childPolicy = readFrozenPolicy(root, "child-arl");
    assert.equal(childPolicy.mode, "auto_research_loop");
    // The child charter carries no depth facts; both limits come from the parent's policy.
    assert.equal(Object.hasOwn(childCharter, "max_depth"), false);
    assert.equal(childPolicy.max_repair_attempts, 3);
    assert.equal(childPolicy.max_depth, 2);
    const childResumed = spawnSync("npx", childCommand.map((part) => part === "start" ? "resume" : part), { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(childResumed.status, 0, childResumed.stderr);
    const childRun = readRun(root, "child-arl");
    const childIdentity = { execution_root: executionRoot, project_root: root, outer_run_id: "child-arl", parent_run_id: childRun.parent_run_id, depth: childRun.depth, scope_path: childRun.scope_path };
    const evidencePath = path.join(root, "evidence.json");
    fs.writeFileSync(evidencePath, "{}");
    beginOuterCycle({ ...childIdentity, wave_id: "wave:1", wave_kind: "module", evidence_paths: [evidencePath] });
    const ideaDir = runOwnedPath(root, "child-arl", "cycles", "1", "workers", "1-idea-discovery");
    fs.mkdirSync(path.join(ideaDir, "outputs"), { recursive: true });
    const ideaManifest = path.join(ideaDir, "input-manifest.json");
    fs.writeFileSync(ideaManifest, JSON.stringify({ worker: "idea-discovery", run_id: "child-arl", iteration: 1, output_dir: path.join(ideaDir, "outputs") }));
    fs.writeFileSync(path.join(ideaDir, "receipt.json"), JSON.stringify({ worker: "idea-discovery", run_id: "child-arl", iteration: 1 }));
    fs.writeFileSync(path.join(ideaDir, "outputs", "idea-discovery.json"), JSON.stringify({ candidate_ids: [], children: [], strategy_reason: "No further decomposition" }));
    const prepared = prepareBridgeInput({ ...childIdentity, idea_discovery_manifest_path: ideaManifest });
    assert.equal(prepared.bridge.baseline.baseline_sha256, charter.baseline_sha256);
    assert.equal(fs.existsSync(prepared.bridge_input_path), true);
    advanceOuterPhase({ ...childIdentity, from_phase: "diagnosis", to_phase: "workset", evidence_paths: [evidencePath] });
    const bridgeDir = runOwnedPath(root, "child-arl", "cycles", "1", "workers", "1-experiment-bridge");
    fs.mkdirSync(path.join(bridgeDir, "outputs"), { recursive: true });
    const bridgeOutput = path.join(bridgeDir, "outputs", "result.json");
    fs.writeFileSync(bridgeOutput, "{}");
    const bridgeManifest = path.join(bridgeDir, "input-manifest.json");
    fs.writeFileSync(bridgeManifest, JSON.stringify({ run_id: "child-arl", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", inputs: { plan: "frozen" }, context: {}, output_dir: path.join(bridgeDir, "outputs") }));
    const bridgeReceipt = path.join(bridgeDir, "receipt.json");
    fs.writeFileSync(bridgeReceipt, JSON.stringify({ run_id: "child-arl", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", status: "done", error: null, primary_output: "result.json", primary_output_sha256: crypto.createHash("sha256").update("{}").digest("hex"), summary: {}, dashboard_patch: {} }));
    recordOuterBridgeSuccess({ ...childIdentity, receipt_path: bridgeReceipt, manifest_path: bridgeManifest, evidence_paths: [bridgeReceipt, bridgeManifest] });
    const insufficientDir = runOwnedPath(root, "child-arl", "cycles", "1", "workers", "1-insufficient-review");
    fs.mkdirSync(insufficientDir, { recursive: true });
    const insufficientReceipt = path.join(insufficientDir, "receipt.json");
    fs.writeFileSync(insufficientReceipt, JSON.stringify({ run_id: "child-arl", iteration: 1, worker: "auto-review-loop", phase: "auto-review-loop", status: "done", dashboard_patch: { "last_review.verdict": "insufficient", "metric.current": null } }));
    prepareAssessment(childIdentity);
    prepareAssessment(childIdentity,true);
    assert.match(readWorkflowRuntimeState(root,"child-arl").active_cycle!.tester_assessment!.result_ref, /refreshed/);
    assert.throws(() => recordAutoResearchInsufficient({ ...childIdentity, review_receipt_path: insufficientReceipt, evidence_paths: [insufficientReceipt] }), /bridge file does not exist/);
    writeReviewManifest(insufficientDir, "child-arl");
    const pending = recordAutoResearchInsufficient({ ...childIdentity, review_receipt_path: insufficientReceipt, evidence_paths: [insufficientReceipt] });
    assert.equal(pending.current_phase, "bridge-repair");
    assert.equal(recordAutoResearchInsufficient({ ...childIdentity, review_receipt_path: insufficientReceipt, evidence_paths: [insufficientReceipt] }).active_cycle?.bridge_failure?.repair_attempts, 0);
    assert.equal(resumeAutoResearchRun(childIdentity).current_phase, "bridge-repair");
    const repairDir = runOwnedPath(root, "child-arl", "cycles", "1", "workers", "1-repair");
    fs.mkdirSync(path.join(repairDir, "outputs"), { recursive: true });
    const repairManifest = path.join(repairDir, "input-manifest.json");
    fs.writeFileSync(repairManifest, JSON.stringify({ run_id: "child-arl", iteration: 1, worker: "auto-review-loop", phase: "bridge-repair", inputs: { bridge: bridgeManifest }, context: { purpose: "bridge_repair", frozen_input_sha256: pending.active_cycle?.bridge_failure?.frozen_input_sha256 }, output_dir: path.join(repairDir, "outputs") }));
    const repairReceipt = path.join(repairDir, "receipt.json");
    fs.writeFileSync(repairReceipt, JSON.stringify({ run_id: "child-arl", iteration: 1, worker: "auto-review-loop", phase: "bridge-repair", status: "done", primary_output: null, summary: { repair_status: "fixed", repair_round: 1 }, dashboard_patch: null }));
    const fixed = recordOuterBridgeRepair({ ...childIdentity, repair_receipt_path: repairReceipt, repair_manifest_path: repairManifest, evidence_paths: [repairReceipt] });
    assert.equal(fixed.current_phase, "workset");
    assert.equal(recordOuterBridgeRepair({ ...childIdentity, repair_receipt_path: repairReceipt, repair_manifest_path: repairManifest, evidence_paths: [repairReceipt] }).active_cycle?.bridge_failure?.repair_attempts, 1);
    recordOuterBridgeSuccess({ ...childIdentity, receipt_path: bridgeReceipt, manifest_path: bridgeManifest, evidence_paths: [bridgeReceipt, bridgeManifest] });
    prepareAssessment(childIdentity);
    const reviewDir = runOwnedPath(root, "child-arl", "cycles", "1", "workers", "1-auto-review-loop");
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewReceipt = path.join(reviewDir, "receipt.json");
    fs.writeFileSync(reviewReceipt, JSON.stringify({ run_id: "child-arl", iteration: 1, worker: "auto-review-loop", phase: "auto-review-loop", status: "done", summary: assessmentSummary(childIdentity), dashboard_patch: { "last_review.verdict": "ready", "metric.current": 0.82 } }));
    writeReviewManifest(reviewDir, "child-arl");
    completeAutoResearchCycle({ ...childIdentity, review_receipt_path: reviewReceipt, evidence_paths: [evidencePath] });
    const wikiRoot = runWikiRoot(root, "child-arl");
    initializeWikiSchema(wikiRoot);
    appendHistoricalWikiFixture(wikiRoot, { producer_kind: "result-to-claim", scope: "runs/child-arl", subject_id: "exp-child-arl", evidence_bundle_id: "bundle:child-arl", payload: { context: {}, operations: [{ op: "upsert_page", kind: "experiment", id: "exp-child-arl", data: { title: "Child result", idea_id: "idea:main", verdict: "yes", confidence: "high", date: "2026-01-01", hardware: "", duration: "", provenance: "", metrics: "score 0.82", reasoning: "measured", tags: [], iteration: 1, gate_metric: 0.82 } }] } });
    assert.throws(() => planResultExport({ project_root: root, run_id: "child-arl" }), /saved terminal stop decision/);
    const stop = recordWorkflowStopDecision({ ...childIdentity });
    assert.equal(stop.reason, "target_reached");
    releaseTestProcessScope(root, "child-arl");
    const childFinish = spawnSync("npx", ["tsx", "src/tools/workflow-cli.ts", "finish", "--execution-root", executionRoot, "--project", root, "--run", "child-arl", "--outcome", "completed", "--evidence", runOwnedPath(root, "child-arl", "cycles", "1", "stop-decision.json")], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(childFinish.status, 0, childFinish.stderr);
    const exported = planResultExport({ project_root: root, run_id: "child-arl" });
    assert.equal(exported.candidate.parent_run_id, "root-arl");
    assert.equal(exported.candidate.termination_reason, "metric_met");
    assert.equal(exported.candidate.local_metrics?.metric_gate, 0.82);
    saveResultReview(root, { schema_version: 1, review_id: "review:child-arl", run_id: "child-arl", reviewer_worker_id: "reviewer:child-arl", package_sha256: exported.candidate.package_sha256, verdict: "approved", evidence_refs: [], reason_codes: [] });
    const published = exportResultPackage({ project_root: root, run_id: "child-arl", review: { review_id: "review:child-arl" } });
    assert.equal(published.result_package.parent_run_id, "root-arl");
    assert.equal(readResultPackage(root, "child-arl").termination_reason, "metric_met");
    const rootIdentity = { execution_root: executionRoot, project_root: root, outer_run_id: "root-arl", parent_run_id: null, depth: 0, scope_path: "/" };
    beginOuterCycle({ ...rootIdentity, wave_id: "wave:root", wave_kind: "module", evidence_paths: [evidencePath] });
    advanceOuterPhase({ ...rootIdentity, from_phase: "diagnosis", to_phase: "workset", evidence_paths: [evidencePath] });
    const rootBridgeDir = runOwnedPath(root, "root-arl", "cycles", "1", "workers", "1-experiment-bridge");
    fs.mkdirSync(path.join(rootBridgeDir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(rootBridgeDir, "outputs", "result.json"), "{}");
    const rootBridgeManifest = path.join(rootBridgeDir, "input-manifest.json");
    fs.writeFileSync(rootBridgeManifest, JSON.stringify({ run_id: "root-arl", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", inputs: { plan: "frozen" }, context: {}, output_dir: path.join(rootBridgeDir, "outputs") }));
    const rootBridgeReceipt = path.join(rootBridgeDir, "receipt.json");
    fs.writeFileSync(rootBridgeReceipt, JSON.stringify({ run_id: "root-arl", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", status: "done", error: null, primary_output: "result.json", primary_output_sha256: crypto.createHash("sha256").update("{}").digest("hex"), summary: {}, dashboard_patch: {} }));
    recordOuterBridgeSuccess({ ...rootIdentity, receipt_path: rootBridgeReceipt, manifest_path: rootBridgeManifest, evidence_paths: [rootBridgeReceipt, rootBridgeManifest] });
    const rootReviewDir = runOwnedPath(root, "root-arl", "cycles", "1", "workers", "1-auto-review-loop");
    fs.mkdirSync(rootReviewDir, { recursive: true });
    const rootReviewReceipt = path.join(rootReviewDir, "receipt.json");
    fs.writeFileSync(rootReviewReceipt, JSON.stringify({ run_id: "root-arl", iteration: 1, worker: "auto-review-loop", phase: "auto-review-loop", status: "done", dashboard_patch: { "last_review.verdict": "ready", "metric.current": 0.83 } }));
    writeReviewManifest(rootReviewDir, "root-arl");
    prepareAssessment(rootIdentity);
    // The parent's round is not over until its child has published: with the
    // child's package out of the way, closing the iteration waits for it.
    const childPackage = runOwnedPath(root, "child-arl", "result-package.json");
    fs.renameSync(childPackage, `${childPackage}.held`);
    const waiting = (() => {
      try {
        completeAutoResearchCycle({ ...rootIdentity, review_receipt_path: rootReviewReceipt, evidence_paths: [evidencePath] });
      } catch (error) {
        return error as Error;
      }
      return null;
    })();
    assert.equal(thrownCode(waiting), "ROUND_INCOMPLETE");
    assert.match(waiting!.message, /child-arl/);
    assert.equal(readWorkflowRuntimeState(root, "root-arl").current_phase, "auto-review-loop");
    fs.renameSync(`${childPackage}.held`, childPackage);
    const assessment=readWorkflowRuntimeState(root,"root-arl").active_cycle!.tester_assessment!;
    const finalReview=JSON.parse(fs.readFileSync(rootReviewReceipt,"utf8"));
    assert.throws(()=>completeAutoResearchCycle({...rootIdentity,review_receipt_path:rootReviewReceipt,evidence_paths:[evidencePath]}),/final tested and audited assessment/);
    finalReview.summary={};
    fs.writeFileSync(rootReviewReceipt,JSON.stringify(finalReview));
    assert.throws(()=>completeAutoResearchCycle({...rootIdentity,review_receipt_path:rootReviewReceipt,evidence_paths:[evidencePath]}),/expected a non-empty string/);
    finalReview.summary={test_result_path:path.join(root,"stale-result.json"),test_audit_path:path.resolve(root,assessment.audit_ref!)};
    fs.writeFileSync(rootReviewReceipt,JSON.stringify(finalReview));
    assert.throws(()=>completeAutoResearchCycle({...rootIdentity,review_receipt_path:rootReviewReceipt,evidence_paths:[evidencePath]}),/record the final review assessment/);
    finalReview.summary.test_result_path=path.resolve(root,assessment.result_ref);
    fs.writeFileSync(rootReviewReceipt,JSON.stringify(finalReview));
    completeAutoResearchCycle({ ...rootIdentity, review_receipt_path: rootReviewReceipt, evidence_paths: [evidencePath] });
    assert.equal(recordWorkflowStopDecision(rootIdentity).reason, "target_reached");
    releaseTestProcessScope(root, "root-arl");
    const rootFinish = spawnSync("npx", ["tsx", "src/tools/workflow-cli.ts", "finish", "--execution-root", executionRoot, "--project", root, "--run", "root-arl", "--outcome", "completed", "--evidence", runOwnedPath(root, "root-arl", "cycles", "1", "stop-decision.json")], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(rootFinish.status, 0, rootFinish.stderr);
    const rootWiki = runWikiRoot(root, "root-arl");
    initializeWikiSchema(rootWiki);
    appendHistoricalWikiFixture(rootWiki, { producer_kind: "result-to-claim", scope: "runs/root-arl", subject_id: "exp-root-arl", evidence_bundle_id: "bundle:root-arl", payload: { context: {}, operations: [{ op: "upsert_page", kind: "experiment", id: "exp-root-arl", data: { title: "Root result", idea_id: "idea:root", verdict: "yes", confidence: "high", date: "2026-01-01", hardware: "", duration: "", provenance: "", metrics: "score 0.83", reasoning: "measured", tags: [], iteration: 1, gate_metric: 0.83 } }] } });
    const rootExport = planResultExport({ project_root: root, run_id: "root-arl" });
    assert.equal(rootExport.candidate.parent_run_id, null);
    assert.deepEqual(rootExport.candidate.child_summaries.map((child) => child.run_id), ["child-arl"]);
    assert.equal(rootExport.candidate.termination_reason, "metric_met");
    saveResultReview(root, { schema_version: 1, review_id: "review:root-arl", run_id: "root-arl", reviewer_worker_id: "reviewer:root-arl", package_sha256: rootExport.candidate.package_sha256, verdict: "approved", evidence_refs: [], reason_codes: [] });
    exportResultPackage({ project_root: root, run_id: "root-arl", review: { review_id: "review:root-arl" } });
    assert.equal(readResultPackage(root, "root-arl").termination_reason, "metric_met");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ARL exhausted execution repair fails the run and names where it failed", () => {
  const root = tempRoot();
  try {
    const input = baseInput(root, "root-no-proposal", "setup:no-proposal");
    delete input.budget;
    input.mode = "auto_research_loop";
    input.max_iterations = 3;
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "## Metric Target\nprimary: 0.8 score\ndirection: higher_better\n");
    setupRootRun(input);
    const identity = { execution_root: path.join(root, "execution"), project_root: root, outer_run_id: "root-no-proposal", parent_run_id: null, depth: 0, scope_path: "/" };
    startAutoResearchRun(identity);
    const evidencePath = path.join(root, "evidence.json");
    fs.writeFileSync(evidencePath, "{}");
    beginOuterCycle({ ...identity, wave_id: "wave:1", wave_kind: "module", evidence_paths: [evidencePath] });
    advanceOuterPhase({ ...identity, from_phase: "diagnosis", to_phase: "workset", evidence_paths: [evidencePath] });
    const bridgeDir = runOwnedPath(root, identity.outer_run_id, "cycles", "1", "workers", "failed-bridge");
    fs.mkdirSync(path.join(bridgeDir, "outputs"), { recursive: true });
    const bridgeManifest = path.join(bridgeDir, "input-manifest.json");
    fs.writeFileSync(bridgeManifest, JSON.stringify({ run_id: identity.outer_run_id, iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", inputs: { plan: "frozen" }, context: {}, output_dir: path.join(bridgeDir, "outputs") }));
    const bridgeReceipt = path.join(bridgeDir, "receipt.json");
    fs.writeFileSync(bridgeReceipt, JSON.stringify({ run_id: identity.outer_run_id, iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", status: "failed", error: { category: "environment" }, primary_output: null, summary: {}, dashboard_patch: {} }));
    const pending = recordOuterBridgeFailure({ ...identity, receipt_path: bridgeReceipt, manifest_path: bridgeManifest, evidence_paths: [bridgeReceipt] });
    assert.equal(pending.current_phase, "bridge-repair");
    assert.equal(resumeAutoResearchRun(identity).active_cycle?.bridge_failure?.status, "pending");
    const repairDir = runOwnedPath(root, identity.outer_run_id, "cycles", "1", "workers", "repair-1");
    fs.mkdirSync(path.join(repairDir, "outputs"), { recursive: true });
    const repairManifest = path.join(repairDir, "input-manifest.json");
    fs.writeFileSync(repairManifest, JSON.stringify({ run_id: identity.outer_run_id, iteration: 1, worker: "auto-review-loop", phase: "bridge-repair", inputs: { failed_bridge: bridgeManifest }, context: { purpose: "bridge_repair", frozen_input_sha256: pending.active_cycle?.bridge_failure?.frozen_input_sha256 }, output_dir: path.join(repairDir, "outputs") }));
    const repairReceipt = path.join(repairDir, "receipt.json");
    fs.writeFileSync(repairReceipt, JSON.stringify({ run_id: identity.outer_run_id, iteration: 1, worker: "auto-review-loop", phase: "bridge-repair", status: "done", primary_output: null, summary: { repair_status: "exhausted", repair_round: 1 }, dashboard_patch: null }));
    assert.equal(recordOuterBridgeRepair({ ...identity, repair_receipt_path: repairReceipt, repair_manifest_path: repairManifest, evidence_paths: [repairReceipt] }).active_cycle?.bridge_failure?.status, "exhausted");
    assert.equal(recordOuterBridgeRepair({ ...identity, repair_receipt_path: repairReceipt, repair_manifest_path: repairManifest, evidence_paths: [repairReceipt] }).active_cycle?.bridge_failure?.repair_attempts, 1);
    const completed = completeOuterCycle({ ...identity, evidence_paths: [repairReceipt] });
    // The experiment kept failing, so this is a failure, located the way the
    // standalone dashboard locates one: worker, iteration, phase, error, repairs.
    assert.equal(completed.cycle_history[0]?.status, "failed");
    assert.equal(completed.cycle_history[0]?.outcome, "bridge_failed");
    assert.equal(completed.cycle_history[0]?.metric_value, null);
    assert.deepEqual(completed.cycle_history[0]?.failure, {
      worker: "experiment-bridge",
      iteration: 1,
      phase: "experiment-bridge",
      error: { category: "environment" },
      repair_status: "exhausted",
      repair_attempts: 1,
      bridge_receipt_ref: "workers/failed-bridge/receipt.json",
      repair_receipt_ref: "workers/repair-1/receipt.json",
    });
    assert.equal(recordWorkflowStopDecision(identity).reason, "bridge_failed");
    const stopEvidence = [runOwnedPath(root, identity.outer_run_id, "cycles", "1", "stop-decision.json")];
    assert.throws(() => finishOuterRun({ ...identity, outcome: "completed", evidence_paths: stopEvidence }), /bridge_failed finishes as failed/);
    assert.equal(finishOuterRun({ ...identity, outcome: "failed", evidence_paths: stopEvidence }).status, "failed");
    initializeWikiSchema(runWikiRoot(root, identity.outer_run_id));
    assert.throws(() => planResultExport({ project_root: root, run_id: identity.outer_run_id, status: "succeeded" }), /failed run can only export a failed package/);
    const planned = planResultExport({ project_root: root, run_id: identity.outer_run_id });
    assert.equal(planned.winner, null);
    assert.equal(planned.candidate.status, "failed");
    assert.equal(planned.candidate.termination_reason, undefined);
    assert.equal(Object.hasOwn(planned.candidate.local_metrics ?? {}, "metric_gate"), false);
    assert.deepEqual(planned.candidate.failure, {
      reason: "experiment-bridge failed in iteration 1 at phase experiment-bridge; repair exhausted after 1",
      failure_code: "BRIDGE_FAILED",
      evidence_refs: ["cycles/1/workers/failed-bridge/receipt.json", "cycles/1/workers/repair-1/receipt.json"],
    });
    saveResultReview(root, { schema_version: 1, review_id: "review:bridge-failed", run_id: identity.outer_run_id, reviewer_worker_id: "reviewer:bridge-failed", package_sha256: planned.candidate.package_sha256, verdict: "approved", evidence_refs: [], reason_codes: [] });
    exportResultPackage({ project_root: root, run_id: identity.outer_run_id, review: { review_id: "review:bridge-failed" } });
    assert.equal(readResultPackage(root, identity.outer_run_id).status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("loop limits outside an Auto Research Loop are refused at setup", () => {
  const root = tempRoot();
  try {
    for (const field of ["max_repair_attempts", "max_depth"] as const) {
      const input = { ...baseInput(root, `root-${field}`, `setup:${field}`), [field]: 1 };
      assert.throws(() => setupRootRun(input), /require Auto Research Loop mode/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ARL repair cap is counted per iteration across bridge failure and insufficient review", () => {
  const root = tempRoot();
  try {
    const input = baseInput(root, "root-cap", "setup:cap");
    delete input.budget;
    input.mode = "auto_research_loop";
    input.max_iterations = 3;
    input.max_repair_attempts = 1;
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "## Metric Target\nprimary: 0.8 score\ndirection: higher_better\n");
    setupRootRun(input);
    const identity = { execution_root: path.join(root, "execution"), project_root: root, outer_run_id: "root-cap", parent_run_id: null, depth: 0, scope_path: "/" };
    startAutoResearchRun(identity);
    assert.equal(readFrozenPolicy(root, "root-cap").max_repair_attempts, 1);
    const evidencePath = path.join(root, "evidence.json");
    fs.writeFileSync(evidencePath, "{}");
    beginOuterCycle({ ...identity, wave_id: "wave:1", wave_kind: "module", evidence_paths: [evidencePath] });
    advanceOuterPhase({ ...identity, from_phase: "diagnosis", to_phase: "workset", evidence_paths: [evidencePath] });
    const bridgeDir = runOwnedPath(root, "root-cap", "cycles", "1", "workers", "failed-bridge");
    fs.mkdirSync(path.join(bridgeDir, "outputs"), { recursive: true });
    const bridgeManifest = path.join(bridgeDir, "input-manifest.json");
    fs.writeFileSync(bridgeManifest, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", inputs: { plan: "frozen" }, context: {}, output_dir: path.join(bridgeDir, "outputs") }));
    const failedReceipt = path.join(bridgeDir, "receipt.json");
    fs.writeFileSync(failedReceipt, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", status: "failed", error: { category: "environment" }, primary_output: null, summary: {}, dashboard_patch: {} }));
    const pending = recordOuterBridgeFailure({ ...identity, receipt_path: failedReceipt, manifest_path: bridgeManifest, evidence_paths: [failedReceipt] });
    assert.equal(pending.active_cycle?.bridge_failure?.status, "pending");
    const repairDir = runOwnedPath(root, "root-cap", "cycles", "1", "workers", "repair-1");
    fs.mkdirSync(path.join(repairDir, "outputs"), { recursive: true });
    const repairManifest = path.join(repairDir, "input-manifest.json");
    fs.writeFileSync(repairManifest, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "auto-review-loop", phase: "bridge-repair", inputs: { failed_bridge: bridgeManifest }, context: { purpose: "bridge_repair", frozen_input_sha256: pending.active_cycle?.bridge_failure?.frozen_input_sha256 }, output_dir: path.join(repairDir, "outputs") }));
    const repairReceipt = path.join(repairDir, "receipt.json");
    fs.writeFileSync(repairReceipt, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "auto-review-loop", phase: "bridge-repair", status: "done", primary_output: null, summary: { repair_status: "fixed", repair_round: 1 }, dashboard_patch: null }));
    assert.equal(recordOuterBridgeRepair({ ...identity, repair_receipt_path: repairReceipt, repair_manifest_path: repairManifest, evidence_paths: [repairReceipt] }).current_phase, "workset");
    const retryDir = runOwnedPath(root, "root-cap", "cycles", "1", "workers", "retry-bridge");
    fs.mkdirSync(path.join(retryDir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(retryDir, "outputs", "result.json"), "{}");
    const retryManifest = path.join(retryDir, "input-manifest.json");
    fs.writeFileSync(retryManifest, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", inputs: { plan: "frozen" }, context: {}, output_dir: path.join(retryDir, "outputs") }));
    const retryReceipt = path.join(retryDir, "receipt.json");
    fs.writeFileSync(retryReceipt, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "experiment-bridge", phase: "experiment-bridge", status: "done", error: null, primary_output: "result.json", primary_output_sha256: crypto.createHash("sha256").update("{}").digest("hex"), summary: {}, dashboard_patch: {} }));
    recordOuterBridgeSuccess({ ...identity, receipt_path: retryReceipt, manifest_path: retryManifest, evidence_paths: [retryReceipt, retryManifest] });
    const reviewDir = runOwnedPath(root, "root-cap", "cycles", "1", "workers", "insufficient-review");
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewReceipt = path.join(reviewDir, "receipt.json");
    fs.writeFileSync(reviewReceipt, JSON.stringify({ run_id: "root-cap", iteration: 1, worker: "auto-review-loop", phase: "auto-review-loop", status: "done", dashboard_patch: { "last_review.verdict": "insufficient", "metric.current": null } }));
    writeReviewManifest(reviewDir, "root-cap");
    // The execution repair already spent this iteration's single repair, so the
    // insufficient review is final at intake instead of opening a second one.
    prepareAssessment(identity);
    const exhausted = recordAutoResearchInsufficient({ ...identity, review_receipt_path: reviewReceipt, evidence_paths: [reviewReceipt] });
    assert.equal(exhausted.active_cycle?.bridge_failure?.status, "exhausted");
    assert.equal(exhausted.active_cycle?.bridge_failure?.repair_attempts, 1);
    const completed = completeOuterCycle({ ...identity, evidence_paths: [reviewReceipt] });
    assert.equal(completed.cycle_history[0]?.outcome, "no_proposal");
    assert.equal(recordWorkflowStopDecision(identity).reason, "no_proposal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// A result package only lands once a reviewer outside the run has approved its
// exact digest. These tests are about the package itself, so the acceptance is
// produced mechanically here.
const REVIEW = { review_id: "review:a2" } as const;

function saveReviewedResultPackage(
  root: string,
  runId: string,
  input: ResultPackageInput,
): ResultPackage {
  const built = buildResultPackageForRun(root, runId, input);
  saveResultReview(root, {
    schema_version: 1,
    review_id: REVIEW.review_id,
    run_id: runId,
    reviewer_worker_id: "reviewer-a2",
    package_sha256: built.package.package_sha256,
    verdict: "approved",
    evidence_refs: [],
    reason_codes: [],
  });
  return saveResultPackage(root, runId, input, REVIEW);
}
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
// Changing this hash scheme invalidates every confirmation stored in existing run directories. If
// intentional, update this value and expect old runs to require all seven confirmations on re-entry.
const EXPECTED_THRESHOLD_CONFIRMATION_HASH =
  "25728218bf903d132b60aee24c64cefaff1749488f0bd082807aa67312f2783b";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-setup-"));
}

function baseInput(root: string, runId = "root-a2", revision = "setup-a2"): RootSetupInput {
  return {
    project_root: root,
    run_id: runId,
    task_id: "task:a2",
    workflow_id: "workflow:a2",
    setup_revision: revision,
    problem: "improve the workflow",
    budget: { amount: 100, unit: "gpu_hours" },
    expected_output: "a reproducible candidate and its evidence",
    baseline: {
      baseline_id: "W_0",
      workflow_definition: {
        modules: [{ id: "main" }, { id: "eval" }],
        edges: [{ from: "main.output", to: "eval.input" }],
      },
      code_baseline: { ref: "commit:baseline" },
      position_artifacts: {
        main: { artifact_ref: "artifact:main", artifact_sha256: HASH_A },
        eval: { artifact_ref: "artifact:eval", artifact_sha256: HASH_B },
      },
      initial_validation: {
        scorer_revision: "scorer:r1",
        input_snapshot_sha256: HASH_C,
        judge_binding: { role: "fixed-judge", revision: "judge:r1" },
        metrics: { score: 0.4 },
      },
      optimizable_scope: [{ position_id: "main", mode: "independent" }],
    },
    tester_definition: { tester_id: "tester:a2", version: "tester:v1" },
    tester_facility_config: installedFacilityFixture(root),
    validation_thresholds: {
      primary: { name: "score", direction: "higher_better", target: 0.5 },
      constraints: [],
    },
    owner_limits: {
      revision: "limits:a2",
      
      max_bundled_positions_per_graph: 1,
      max_nodes: 4,
      max_edges: 4,
      max_fan_out_per_node: 2,
      max_unrolled_cycles: 1,
      max_jobs_per_candidate: 4,
      max_compute_per_candidate: { amount: 4, unit: "gpu_hours" },
    },
    resource_inventory: {
      inventory_id: "resources:a2",
      platforms: [
        {
          platform_id: "gpu-a",
          access_ref: "credential-ref:a2",
          accelerators: [{ model: "A100", count: 2, memory_gb: 80 }],
          cpu: { cores: 16, memory_gb: 64 },
          capacity: { max_parallel_nodes: 2 },
          quota: { amount: 20, unit: "gpu_hours" },
          writable_paths: [{ path: "/work/aris", capacity_bytes: 1_000_000 }],
          network: { internet: true, allowed_endpoints: ["https://models.example.invalid"] },
          max_wall_clock_ms: 60_000,
          time_window: { start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
        },
      ],
    },
  };
}

function lockRecords(root: string): unknown[] {
  const filePath = path.join(root, ".aris", "run-scope-locks.json");
  return fs.existsSync(filePath)
    ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown[])
    : [];
}

interface DiskSnapshot {
  files: Record<string, string>;
  directories: string[];
  lockFiles: string[];
  scopeLockCount: number;
}

function filesUnder(root: string, current = root): string[] {
  if (!fs.existsSync(current)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, entryPath));
    else result.push(path.relative(root, entryPath));
  }
  return result.sort();
}

function directoriesUnder(root: string, current = root): string[] {
  if (!fs.existsSync(current)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(path.relative(root, entryPath));
      result.push(...directoriesUnder(root, entryPath));
    }
  }
  return result.sort();
}

function diskSnapshot(root: string): DiskSnapshot {
  const files: Record<string, string> = {};
  for (const relativePath of filesUnder(root))
    files[relativePath] = fs.readFileSync(path.join(root, relativePath), "utf8");
  return {
    files,
    directories: directoriesUnder(root),
    lockFiles: Object.keys(files)
      .filter((filePath) => filePath.endsWith(".lock"))
      .sort(),
    scopeLockCount: lockRecords(root).length,
  };
}

function assertDiskUnchanged(root: string, before: DiskSnapshot): void {
  const after = diskSnapshot(root);
  assert.deepEqual(after, before);
}

function thrownCode(error: unknown): string {
  return error !== undefined && error !== null && typeof error === "object"
    ? ((error as { code?: string }).code ?? "")
    : "";
}

function expectFailure(
  root: string,
  expectedCode: string,
  action: () => unknown,
  before = diskSnapshot(root),
): unknown {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrownCode(thrown), expectedCode);
  // Every rejected input must leave both state files and all lock forms as they were.
  assertDiskUnchanged(root, before);
  return thrown;
}

function releaseRootScope(root: string, runId: string): void {
  const input = {
    project_root: root,
    run_id: runId,
    parent_run_id: null,
    scope_path: "/",
  } as const;
  for (const token of readRunScopeLeaseTokens(input))
    releaseRunScope({ ...input, lease_token: token });
}

function readRunInNewProcess(root: string, runId: string): { status: number | null; code: string } {
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { readRun } from './src/tools/run-contract.ts'; try { readRun(${JSON.stringify(root)}, ${JSON.stringify(runId)}); process.exit(3); } catch (error) { process.stdout.write(error.code ?? ''); }`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { status: probe.status, code: probe.stdout.trim() };
}

function readArtifactInNewProcess(
  root: string,
  runId: string,
  artifact: "baseline" | "resource",
): { status: number | null; output: string } {
  const modulePath =
    artifact === "baseline" ? "./src/tools/baseline-scope.ts" : "./src/tools/resource-inventory.ts";
  const functionName = artifact === "baseline" ? "readBaselineScope" : "readResourceInventory";
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { ${functionName} } from '${modulePath}'; try { ${functionName}(${JSON.stringify(root)}, ${JSON.stringify(runId)}); process.stdout.write('SUCCEEDED'); } catch (error) { process.stdout.write(error.code ?? ''); }`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { status: probe.status, output: probe.stdout.trim() };
}

function setupInNewProcess(input: RootSetupInput): { status: number | null; output: string } {
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { setupRootRun } from './src/tools/task-setup.ts'; try { const result = setupRootRun(${JSON.stringify(input)}); process.stdout.write(JSON.stringify({ ok: true, diff: result.reentry_diff })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? '' })); }`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { status: probe.status, output: probe.stdout.trim() };
}

function readSetupRevisionInNewProcess(
  root: string,
  taskId: string,
  setupRevision: string,
): { status: number | null; output: string } {
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { loadRootSetupRevision } from './src/tools/task-setup.ts'; try { const revision = loadRootSetupRevision(${JSON.stringify(root)}, ${JSON.stringify(taskId)}, ${JSON.stringify(setupRevision)}); process.stdout.write(JSON.stringify({ ok: true, thresholds: revision.confirmation_hashes.thresholds })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? '' })); process.exitCode = 1; }`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { status: probe.status, output: probe.stdout.trim() };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]),
    );
  }
  return value;
}

test("setup reports every missing item before touching disk", () => {
  const root = tempRoot();
  try {
    const input = {
      project_root: root,
      run_id: "missing-a2",
      task_id: "task:a2",
      workflow_id: "workflow:a2",
      setup_revision: "setup:missing",
      problem: "problem",
      expected_output: "output",
    } as RootSetupInput;
    assert.deepEqual(collectMissingSetupItems(input), [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);
    let error: unknown;
    try {
      setupRootRun(input);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error instanceof SetupIncompleteError, true);
    assert.deepEqual((error as SetupIncompleteError).missing, [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);
    assert.equal(fs.existsSync(path.join(root, ".aris")), false);
    assert.deepEqual(lockRecords(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup collects missing items before unknown-field validation", () => {
  const root = tempRoot();
  try {
    const input = baseInput(root, "missing-with-unknown");
    for (const field of [
      "tester_definition",
      "tester_facility_config",
      "validation_thresholds",
      "owner_limits",
      "resource_inventory",
      "baseline",
    ])
      delete input[field];
    input.unexpected = true;
    const error = expectFailure(root, "SETUP_INCOMPLETE", () =>
      setupRootRun(input),
    ) as SetupIncompleteError;
    assert.deepEqual(error.missing, [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);

    const completeInput = baseInput(root, "unknown-only");
    completeInput.unexpected = true;
    expectFailure(root, "UNKNOWN_FIELD", () => setupRootRun(completeInput));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup distinguishes null, explicit undefined, and absent fields", () => {
  const cases = [
    ["tester_definition", "tester", "INVALID_VALUE"],
    ["tester_facility_config", "tester_facility", "INVALID_VALUE"],
    ["validation_thresholds", "thresholds", "INVALID_VALUE"],
    ["owner_limits", "limits", "INVALID_VALUE"],
    ["resource_inventory", "resource", "RESOURCE_INVENTORY_REQUIRED"],
    ["baseline", "baseline", "INVALID_BASELINE"],
  ] as const;

  for (const [field, item, nullCode] of cases) {
    const nullRoot = tempRoot();
    try {
      const input = baseInput(nullRoot, `null-${item}`);
      input[field] = null;
      assert.deepEqual(collectMissingSetupItems(input), []);
      expectFailure(nullRoot, nullCode, () => setupRootRun(input));
    } finally {
      fs.rmSync(nullRoot, { recursive: true, force: true });
    }

    for (const kind of ["explicit undefined", "absent"] as const) {
      const root = tempRoot();
      try {
        const input = baseInput(root, `${kind.replace(" ", "-")}-${item}`);
        if (kind === "explicit undefined") input[field] = undefined;
        else delete input[field];
        assert.deepEqual(collectMissingSetupItems(input), [item]);
        const error = expectFailure(root, "SETUP_INCOMPLETE", () =>
          setupRootRun(input),
        ) as SetupIncompleteError;
        assert.deepEqual(error.missing, [item]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("setup keeps missing-item priority stable with invalid content", () => {
  const root = tempRoot();
  try {
    const input = baseInput(root, "missing-with-invalid-content");
    input.tester_definition = null;
    delete input.tester_facility_config;
    delete input.validation_thresholds;
    const before = diskSnapshot(root);
    const first = expectFailure(root, "SETUP_INCOMPLETE", () =>
      setupRootRun(input),
    ) as SetupIncompleteError;
    const second = expectFailure(
      root,
      "SETUP_INCOMPLETE",
      () => setupRootRun(input),
      before,
    ) as SetupIncompleteError;
    assert.deepEqual(first.missing, ["tester_facility", "thresholds"]);
    assert.deepEqual(second.missing, first.missing);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup missing-item matrix reports every selected item", () => {
  const cases = [
    ["tester_definition", "tester"],
    ["tester_facility_config", "tester_facility"],
    ["validation_thresholds", "thresholds"],
    ["owner_limits", "limits"],
    ["resource_inventory", "resource"],
    ["baseline", "baseline"],
  ] as const;
  const combinations = [
    [0, 1],
    [0, 1, 2, 3],
    [0, 1, 2, 3, 4, 5],
    ...cases.map((_, index) => [index]),
  ];
  for (const [caseIndex, indexes] of combinations.entries()) {
    const root = tempRoot();
    try {
      const input = baseInput(root, `missing-matrix-${caseIndex}`);
      for (const index of indexes) delete input[cases[index]![0]];
      const error = expectFailure(root, "SETUP_INCOMPLETE", () =>
        setupRootRun(input),
      ) as SetupIncompleteError;
      assert.deepEqual(
        error.missing,
        cases.filter((_, index) => indexes.includes(index)).map(([, item]) => item),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("setup creates W_0 root artifacts only after the run contract", () => {
  const root = tempRoot();
  try {
    const result = setupRootRun(baseInput(root));
    const contract = readRun(root, "root-a2");
    assert.equal(contract.parent_run_id, null);
    assert.equal(contract.depth, 0);
    assert.equal(contract.scope_path, "/");
    assert.equal(contract.max_depth, undefined);
    assert.equal(contract.depth_budget, undefined);
    assert.equal(contract.execution, undefined);
    assert.equal(result.root_charter.baseline_ref, "W_0");
    assert.equal(result.baseline.baseline_id, "W_0");
    assert.equal(result.root_charter.depth_budget, undefined);
    assert.equal(fs.existsSync(rootCharterPath(root, "root-a2")), true);
    assert.equal(fs.existsSync(resourceInventoryPath(root, "root-a2")), true);
    assert.equal(lockRecords(root).length, 1);

    const tampered = JSON.parse(
      fs.readFileSync(rootCharterPath(root, "root-a2"), "utf8"),
    ) as Record<string, unknown>;
    tampered.problem = "tampered";
    fs.writeFileSync(rootCharterPath(root, "root-a2"), `${JSON.stringify(tampered)}\n`);
    const beforeProbe = diskSnapshot(root);
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { readRootCharter } from './src/tools/root-charter.ts'; try { readRootCharter(${JSON.stringify(root)}, 'root-a2'); process.exit(3); } catch (error) { process.stdout.write(error.code ?? ''); }`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, "CHARTER_HASH_MISMATCH");
    assertDiskUnchanged(root, beforeProbe);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow-tools root-setup CLI delegates the complete root input", () => {
  const root = tempRoot();
  try {
    const inputPath = path.join(root, "root-setup-input.json");
    fs.writeFileSync(inputPath, JSON.stringify(baseInput(root, "cli-root-a2")));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(process.cwd(), "src/tools/workflow-tools-cli.ts"),
        "root-setup",
        "--project",
        root,
        "--input",
        inputPath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, ".aris", "runs", "cli-root-a2", "run.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new process rejects depth, scope, and charter-hash tampering in run.json", () => {
  const mutations: Array<[string, (run: Record<string, unknown>) => void, string]> = [
    ["depth", (run) => (run.depth = 999), "RUN_IDENTITY_MISMATCH"],
    ["scope", (run) => (run.scope_path = "/tampered"), "RUN_IDENTITY_MISMATCH"],
    [
      "charter hash",
      (run) => {
        const material = run.identity_material as Record<string, unknown>;
        material.charter_sha256 = HASH_B;
      },
      "RUN_IDENTITY_MISMATCH",
    ],
  ];
  for (const [label, mutate, expectedCode] of mutations) {
    const root = tempRoot();
    try {
      setupRootRun(baseInput(root, `tamper-${label.replaceAll(" ", "-")}`));
      const runPath = path.join(
        root,
        ".aris",
        "runs",
        `tamper-${label.replaceAll(" ", "-")}`,
        "run.json",
      );
      const run = JSON.parse(fs.readFileSync(runPath, "utf8")) as Record<string, unknown>;
      mutate(run);
      fs.writeFileSync(runPath, `${JSON.stringify(run)}\n`);
      const beforeRead = diskSnapshot(root);
      const probe = readRunInNewProcess(root, `tamper-${label.replaceAll(" ", "-")}`);
      assert.equal(probe.status, 0, label);
      assert.equal(probe.code, expectedCode, label);
      assertDiskUnchanged(root, beforeRead);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("new processes reject tampered baseline and resource bytes and accept restored bytes", () => {
  const root = tempRoot();
  const runId = "artifact-tamper";
  try {
    setupRootRun(baseInput(root, runId));
    const artifactCases = [
      {
        name: "baseline",
        filePath: path.join(root, ".aris", "runs", runId, "baseline.json"),
        expectedCode: "BASELINE_HASH_MISMATCH",
        mutate: (value: Record<string, unknown>) => {
          (value.code_baseline as Record<string, unknown>).ref = "commit:tampered";
        },
      },
      {
        name: "resource",
        filePath: path.join(root, ".aris", "runs", runId, "resource-inventory.json"),
        expectedCode: "RESOURCE_INVENTORY_HASH_MISMATCH",
        mutate: (value: Record<string, unknown>) => {
          value.inventory_id = "resources:tampered";
        },
      },
    ] as const;

    for (const item of artifactCases) {
      const original = fs.readFileSync(item.filePath, "utf8");
      const tampered = JSON.parse(original) as Record<string, unknown>;
      item.mutate(tampered);
      fs.writeFileSync(item.filePath, `${JSON.stringify(tampered)}\n`);
      const beforeReject = diskSnapshot(root);
      const rejected = readArtifactInNewProcess(root, runId, item.name);
      assert.equal(rejected.status, 0, item.name);
      assert.equal(rejected.output, item.expectedCode, item.name);
      assertDiskUnchanged(root, beforeReject);

      fs.writeFileSync(item.filePath, original);
      const beforeRecovery = diskSnapshot(root);
      const recovered = readArtifactInNewProcess(root, runId, item.name);
      assert.equal(recovered.status, 0, item.name);
      assert.equal(recovered.output, "SUCCEEDED", item.name);
      assertDiskUnchanged(root, beforeRecovery);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup cleans the contract and locks after a middle write failure", () => {
  const root = tempRoot();
  const runId = "middle-write-failure";
  const runDirectory = path.join(root, ".aris", "runs", runId);
  const baselinePath = path.join(runDirectory, "baseline.json");
  try {
    fs.mkdirSync(baselinePath, { recursive: true });
    const setupInput=baseInput(root,runId);
    const before = diskSnapshot(root);
    let thrown: unknown;
    try {
      setupRootRun(setupInput);
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown instanceof Error, true);
    assert.match((thrown as Error).message, /cannot read state file/);
    assert.match((thrown as Error).message, /EISDIR/);
    assert.equal(thrownCode(thrown), "");
    assert.deepEqual(diskSnapshot(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup surfaces cleanup failure and releases every lock it can release", () => {
  const root = tempRoot();
  const runId = "cleanup-failure";
  const resourcePath = path.join(root, ".aris", "runs", runId, "resource-inventory.json");
  fs.mkdirSync(path.join(root, ".aris", "runs", runId, "baseline.json"), { recursive: true });
  const setupInput=baseInput(root,runId);
  const before = diskSnapshot(root);
  const expectedResource = createResourceInventory(setupInput.resource_inventory);
  const originalUnlinkSync = fs.unlinkSync;
  const mutableFs = fs as typeof fs & { unlinkSync: typeof fs.unlinkSync };
  try {
    mutableFs.unlinkSync = ((filePath: fs.PathLike) => {
      if (String(filePath) === resourcePath) throw new Error("blocked cleanup");
      return originalUnlinkSync(filePath);
    }) as typeof fs.unlinkSync;
    let thrown: unknown;
    try {
      setupRootRun(baseInput(root, runId));
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrownCode(thrown), "SETUP_CLEANUP_FAILED");
    const expected: DiskSnapshot = {
      ...before,
      files: {
        ...before.files,
        [path.relative(root, resourcePath)]: `${JSON.stringify(expectedResource, null, 2)}\n`,
      },
    };
    assert.deepEqual(diskSnapshot(root), expected);
  } finally {
    mutableFs.unlinkSync = originalUnlinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("root setup needs no depth limit and freezes the resource budget",()=>{
 const root=tempRoot();try {const result=setupRootRun(baseInput(root));assert.equal(Object.hasOwn(result.root_charter,"depth_budget"),false);assert.deepEqual(result.root_charter.budget,{amount:100,unit:"gpu_hours"});assert.equal(result.root_charter.owner_limits.max_nodes,4);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

function directCharterInput(root: string, maxDepth: unknown): Record<string, unknown> {
  const input = baseInput(root, "direct-charter", "direct-charter-revision");
  const ownerLimits = { ...(input.owner_limits as Record<string, unknown>),  };
  return {
    ...input,
    baseline_scope: createBaselineScope({
      ...(input.baseline as Record<string, unknown>),
      owner_limits: ownerLimits,
    }),
    resource_inventory: createResourceInventory(input.resource_inventory),
    owner_limits: ownerLimits,
  };
}

test("resource budgets reject invalid amounts before creating a run",()=>{
 for(const amount of [-1,NaN,Infinity,"100",null]) { const root=tempRoot();try {const input=baseInput(root);input.budget={amount,unit:"gpu_hours"};expectFailure(root,"INVALID_VALUE",()=>setupRootRun(input));}finally{fs.rmSync(root,{recursive:true,force:true});}}
 for(const amount of [0,0.5,100]) { const root=tempRoot();try {const input=baseInput(root);input.budget={amount,unit:"gpu_hours"};assert.deepEqual(setupRootRun(input).root_charter.budget,input.budget);}finally{fs.rmSync(root,{recursive:true,force:true});}}
});

test("re-entry compares hashes and reuses unchanged confirmations", () => {
  const root = tempRoot();
  const first = setupRootRun(baseInput(root, "reentry-a", "setup:a"));
  try {
    const beforeRetry = diskSnapshot(root);
    const second = setupRootRun(baseInput(root, "reentry-a", "setup:a"));
    assert.deepEqual(second.reentry_diff.changed, []);
    assert.deepEqual(second.reentry_diff.confirmation_required, []);
    assert.deepEqual(second.reentry_diff.reused, [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);
    assertDiskUnchanged(root, beforeRetry);
    const same = computeSetupReentryDiff(first, first.confirmation_hashes);
    assert.deepEqual(same.added, []);
    assert.deepEqual(same.changed, []);
    assert.deepEqual(same.reused, [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);
    const changed = {
      ...first.confirmation_hashes,
      thresholds: canonicalJsonSha256({ thresholds: 3 }),
    };
    const diff = computeSetupReentryDiff(first, changed);
    assert.deepEqual(diff.changed, ["thresholds"]);
    assert.deepEqual(diff.confirmation_required, ["thresholds"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-contract setup re-entry reuses old confirmations and seals the root afterward", () => {
  const root = tempRoot();
  try {
    const incomplete = baseInput(root, "precontract-reentry", "setup:precontract");
    delete incomplete.validation_thresholds;
    const incompleteError = expectFailure(root, "SETUP_INCOMPLETE", () =>
      setupRootRun(incomplete),
    ) as SetupIncompleteError;
    assert.deepEqual(incompleteError.missing, ["thresholds"]);

    const completed = baseInput(root, "precontract-reentry", "setup:precontract");
    completed.validation_thresholds = {primary:{name:"score",direction:"higher_better",target:0.6},constraints:[]};
    const completedResult = setupRootRun(completed);
    assert.deepEqual(completedResult.reentry_diff.added, ["thresholds"]);
    assert.deepEqual(completedResult.reentry_diff.changed, []);
    assert.deepEqual(completedResult.reentry_diff.confirmation_required, ["thresholds"]);
    assert.deepEqual(completedResult.reentry_diff.reused, [
      "tester",
      "tester_facility",
      "limits",
      "resource",
      "baseline",
    ]);
    assert.equal(
      fs.existsSync(path.join(root, ".aris", "runs", "precontract-reentry", "run.json")),
      true,
    );

    const beforeSealedRetry = diskSnapshot(root);
    const changed = baseInput(root, "precontract-reentry", "setup:precontract");
    changed.validation_thresholds = {primary:{name:"score",direction:"higher_better",target:0.7},constraints:[]};
    expectFailure(root, "ROOT_SETUP_SEALED", () => setupRootRun(changed), beforeSealedRetry);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sealed root rejects each changed setup item without changing bytes or scope lock", () => {
  const mutations: Array<[string, (input: RootSetupInput) => void]> = [
    [
      "tester",
      (input) => (input.tester_definition = { tester_id: "tester:changed", version: "tester:v1" }),
    ],
    [
      "tester_facility",
      (input) =>
        ((input.tester_facility_config as any).test.timeout_ms = 2000),
    ],
    [
      "thresholds",
      (input) =>
        ((input.validation_thresholds as Record<string, unknown>).primary = {
          name: "score",
          direction: "higher_better",
          target: 0.6,
        }),
    ],
    ["limits", (input) => ((input.owner_limits as Record<string, unknown>).max_depth = 3)],
    [
      "resource",
      (input) =>
        ((input.resource_inventory as Record<string, unknown>).inventory_id = "resources:changed"),
    ],
    [
      "baseline",
      (input) =>
        ((input.baseline as Record<string, unknown>).code_baseline = { ref: "commit:changed" }),
    ],
  ];

  for (const [item, mutate] of mutations) {
    const root = tempRoot();
    const runId = `sealed-${item}`;
    try {
      setupRootRun(baseInput(root, runId, "setup:sealed"));
      const before = diskSnapshot(root);
      assert.equal(before.scopeLockCount, 1);
      const changed = baseInput(root, runId, "setup:sealed");
      mutate(changed);
      const child = setupInNewProcess(changed);
      assert.equal(child.status, 0, item);
      assert.deepEqual(JSON.parse(child.output), { ok: false, code: item === "tester_facility" ? "TESTER_CONFIG_CHANGED" : "ROOT_SETUP_SEALED" }, item);
      assertDiskUnchanged(root, before);
      assert.equal(diskSnapshot(root).scopeLockCount, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("re-entry reuses reordered fields and pins persisted threshold confirmations", () => {
  const root = tempRoot();
  try {
    const first = setupRootRun(baseInput(root, "reentry-order", "setup:order"));
    const before = diskSnapshot(root);
    const same = setupRootRun(baseInput(root, "reentry-order", "setup:order"));
    assert.deepEqual(same.reentry_diff.reused, [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);
    assert.deepEqual(same.reentry_diff.confirmation_required, []);

    const reordered = setupRootRun(
      reverseObjectKeys(baseInput(root, "reentry-order", "setup:order")) as RootSetupInput,
    );
    assert.deepEqual(reordered.reentry_diff.reused, [
      "tester",
      "tester_facility",
      "thresholds",
      "limits",
      "resource",
      "baseline",
    ]);
    assert.deepEqual(reordered.reentry_diff.confirmation_required, []);
    assert.equal(reordered.root_charter.charter_sha256, first.root_charter.charter_sha256);
    assertDiskUnchanged(root, before);

    const alternateRoot = tempRoot();
    try {
      const alternateInput = baseInput(
        alternateRoot,
        "reentry-threshold-change",
        "setup:threshold",
      );
      alternateInput.validation_thresholds = {
        primary: { name: "score", direction: "higher_better", target: 0.6 },
        constraints: [],
      };
      const alternate = setupRootRun(alternateInput);
      const firstThresholdHash = first.confirmation_hashes.thresholds;
      const alternateThresholdHash = alternate.confirmation_hashes.thresholds;

      assert.equal(firstThresholdHash, EXPECTED_THRESHOLD_CONFIRMATION_HASH);
      assert.equal(first.setup_revision.confirmation_hashes.thresholds, firstThresholdHash);
      assert.equal(alternate.setup_revision.confirmation_hashes.thresholds, alternateThresholdHash);
      assert.notEqual(firstThresholdHash, alternateThresholdHash);
      const diskRevision = readSetupRevisionInNewProcess(root, "task:a2", "setup:order");
      assert.equal(diskRevision.status, 0);
      assert.deepEqual(JSON.parse(diskRevision.output), {
        ok: true,
        thresholds: EXPECTED_THRESHOLD_CONFIRMATION_HASH,
      });

      const sameThresholds = computeSetupReentryDiff(first, first.confirmation_hashes);
      assert.deepEqual(sameThresholds.reused, [
        "tester",
        "tester_facility",
        "thresholds",
        "limits",
        "resource",
        "baseline",
      ]);
      assert.deepEqual(sameThresholds.confirmation_required, []);

      const changedThresholds = computeSetupReentryDiff(first, alternate.confirmation_hashes);
      assert.deepEqual(changedThresholds.changed, ["tester_facility","thresholds"]);
      assert.deepEqual(changedThresholds.confirmation_required, ["tester_facility","thresholds"]);
    } finally {
      fs.rmSync(alternateRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup distinguishes missing thresholds from invalid null and unset values", () => {
  type CapturedResult = { code: string; missing?: string[] };
  const captureThresholdVariant = (kind: "missing" | "null" | "string"): CapturedResult => {
    const variantRoot = tempRoot();
    try {
      const input = baseInput(variantRoot, `tri-state-${kind}`, "setup:tri-state");
      if (kind === "missing") delete input.validation_thresholds;
      if (kind === "null") input.validation_thresholds = null;
      if (kind === "string") input.validation_thresholds = "unset";
      const before = diskSnapshot(variantRoot);
      let thrown: unknown;
      try {
        setupRootRun(input);
      } catch (error) {
        thrown = error;
      }
      assert.notEqual(thrown, undefined, `${kind} threshold variant unexpectedly succeeded`);
      assert.equal(thrown instanceof SetupIncompleteError, kind === "missing");
      if (kind === "null") {
        const errorObject = thrown as Record<string, unknown>;
        assert.equal("missing" in errorObject, false);
        assert.equal("missing_items" in errorObject, false);
      }
      const result: CapturedResult = { code: thrownCode(thrown) };
      if (thrown instanceof SetupIncompleteError) result.missing = thrown.missing;
      assertDiskUnchanged(variantRoot, before);
      return result;
    } finally {
      fs.rmSync(variantRoot, { recursive: true, force: true });
    }
  };

  const missing = captureThresholdVariant("missing");
  const nullValue = captureThresholdVariant("null");
  const stringValue = captureThresholdVariant("string");
  assert.deepEqual(missing, { code: "SETUP_INCOMPLETE", missing: ["thresholds"] });
  assert.deepEqual(nullValue, { code: "INVALID_VALUE" });
  assert.deepEqual(stringValue, { code: "INVALID_VALUE" });
  assert.notDeepEqual(missing, nullValue);
  assert.notDeepEqual(missing, stringValue);
});

test("resource inventory separates out-of-scope from temporarily unavailable", () => {
  const root = tempRoot();
  try {
    const inventory = createResourceInventory(baseInput(root).resource_inventory);
    const before = diskSnapshot(root);
    const outside = classifyResourceRequest(inventory, {
      platform_id: "gpu-b",
      accelerator_model: "A100",
    });
    assert.equal(outside.status, "not_executable");
    assert.equal(outside.failure_code, "RESOURCE_SCOPE_ALIGNMENT_REQUIRED");
    assertDiskUnchanged(root, before);

    const unavailable = classifyResourceRequest(
      inventory,
      { platform_id: "gpu-a", accelerator_model: "A100" },
      { available: false },
    );
    assert.equal(unavailable.status, "infra_unavailable");
    assert.equal(unavailable.failure_code, "INFRA_UNAVAILABLE");
    assertDiskUnchanged(root, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resource classification checks the listed dimensions before runtime availability", () => {
  const root = tempRoot();
  try {
    const inventory = createResourceInventory(baseInput(root).resource_inventory);
    const cases = [
      ["platform", { platform_id: "gpu-b" }],
      ["accelerator model", { platform_id: "gpu-a", accelerator_model: "H100" }],
      [
        "accelerator count",
        { platform_id: "gpu-a", accelerator_model: "A100", accelerator_count: 3 },
      ],
      [
        "accelerator memory",
        { platform_id: "gpu-a", accelerator_model: "A100", accelerator_memory_gb: 81 },
      ],
      ["CPU", { platform_id: "gpu-a", cpu_cores: 17 }],
      ["memory", { platform_id: "gpu-a", memory_gb: 65 }],
      ["parallel nodes", { platform_id: "gpu-a", parallel_nodes: 3 }],
      ["writable path", { platform_id: "gpu-a", writable_path: "/work/other" }],
      ["endpoint", { platform_id: "gpu-a", endpoint: "https://other.example.invalid" }],
      ["quota amount", { platform_id: "gpu-a", quota: { amount: 21, unit: "gpu_hours" } }],
      ["quota unit", { platform_id: "gpu-a", quota: { amount: 1, unit: "requests" } }],
      ["wall clock", { platform_id: "gpu-a", wall_clock_ms: 60_001 }],
    ] as const;
    for (const [label, request] of cases) {
      const before = diskSnapshot(root);
      const result = classifyResourceRequest(inventory, request, { available: false });
      assert.equal(result.status, "not_executable", label);
      assert.equal(result.failure_code, "RESOURCE_SCOPE_ALIGNMENT_REQUIRED", label);
      assertDiskUnchanged(root, before);
    }

    expectFailure(root, "INVALID_RESOURCE_REQUEST", () =>
      classifyResourceRequest(inventory, {
        platform_id: "gpu-a",
        accelerator_memory_gb: 80,
      }),
    );
    expectFailure(root, "INVALID_RESOURCE_REQUEST", () =>
      classifyResourceRequest(inventory, {
        platform_id: "gpu-a",
        accelerator_count: 1,
      }),
    );

    for (const request of [
      { platform_id: "gpu-b", accelerator_model: "A100" },
      { platform_id: "gpu-a", endpoint: "https://other.example.invalid" },
    ]) {
      const mixedBefore = diskSnapshot(root);
      const first = classifyResourceRequest(inventory, request, { available: false });
      const second = classifyResourceRequest(inventory, request, { available: false });
      for (const result of [first, second]) {
        assert.equal(result.status, "not_executable");
        assert.equal(result.failure_code, "RESOURCE_SCOPE_ALIGNMENT_REQUIRED");
      }
      assertDiskUnchanged(root, mixedBefore);
    }

    const throwingProbe = classifyResourceRequest(
      inventory,
      { platform_id: "gpu-a", accelerator_model: "A100" },
      () => {
        throw new Error("runtime probe failed");
      },
    );
    assert.equal(throwingProbe.status, "infra_unavailable");
    assert.equal(throwingProbe.failure_code, "INFRA_UNAVAILABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("result package policy keeps failed in validation and excludes the two unavailable classes", () => {
  assert.deepEqual(resultStatusPolicy("failed"), {
    enters_validation: true,
    counts_for_stop_gate: true,
    requires_tester: true,
  });
  assert.deepEqual(resultStatusPolicy("succeeded"), {
    enters_validation: true,
    counts_for_stop_gate: false,
    requires_tester: true,
  });
  assert.deepEqual(resultStatusPolicy("not_executable"), {
    enters_validation: false,
    counts_for_stop_gate: false,
    requires_tester: false,
  });
  assert.deepEqual(resultStatusPolicy("infra_unavailable"), {
    enters_validation: false,
    counts_for_stop_gate: false,
    requires_tester: false,
  });
});

function resultInput(status: "succeeded" | "failed" | "not_executable" | "infra_unavailable") {
  return {
    run_id: "result-input",
    status,
    input_snapshot_sha256: HASH_A,
    ...(status === "succeeded"
      ? {}
      : {
          failure: {
            reason: `${status} reason`,
            failure_code: status === "failed" ? "EXECUTION_FAILED" : "RESOURCE_FAILURE",
            evidence_refs: [],
          },
        }),
  } as const;
}

test("result package materializes all four statuses and rejects null defaults", () => {
  const root = tempRoot();
  try {
    for (const status of ["succeeded", "failed", "not_executable", "infra_unavailable"] as const) {
      const result = createResultPackage(resultInput(status));
      assert.equal(result.status, status);
      assert.equal(status === "succeeded", result.failure === undefined);
    }
    expectFailure(root, "INVALID_RESULT_PACKAGE", () =>
      createResultPackage({ ...resultInput("succeeded"), output_hashes: null } as never),
    );
    expectFailure(root, "INVALID_VALUE", () =>
      createResultPackage({ ...resultInput("succeeded"), run_version: null } as never),
    );
    expectFailure(root, "INVALID_RESULT_PACKAGE", () =>
      createResultPackage({ ...resultInput("failed"), failure: undefined } as never),
    );
    expectFailure(root, "INVALID_RESULT_PACKAGE", () =>
      createResultPackage({
        ...resultInput("succeeded"),
        failure: {
          reason: "unexpected",
          failure_code: "EXECUTION_FAILED",
          evidence_refs: [],
        },
      } as never),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("result writer requires the run contract before writing package state", () => {
  const root = tempRoot();
  try {
    const resultInput = {
      run_id: "no-contract",
      status: "not_executable",
      input_snapshot_sha256: HASH_A,
      summary: "outside resource inventory",
      failure: {
        reason: "resource outside inventory",
        failure_code: "RESOURCE_SCOPE_ALIGNMENT_REQUIRED",
        evidence_refs: [],
      },
    } as const;
    expectFailure(root, "RUN_CONTRACT_NOT_FOUND", () =>
      saveReviewedResultPackage(root, "no-contract", resultInput),
    );
    expectFailure(root, "RUN_CONTRACT_NOT_FOUND", () => resultPackagePath(root, "no-contract"));
    assert.equal(
      fs.existsSync(path.join(root, ".aris", "runs", "no-contract", "result-package.json")),
      false,
    );
    assert.deepEqual(lockRecords(root), []);

    createRun({
      project_root: root,
      run_id: "result-run",
      
      scope_path: "/result",
      identity: {
        charter_sha256: "charter",
        input_snapshot_sha256: "snapshot",
        execution_plan_sha256: "plan",
        code_baseline_sha256: "code",
        policy_revision: "policy",
      },
    });
    const saved = saveReviewedResultPackage(root, "result-run", {
      run_id: "result-run",
      scope_path: "/result",
      status: "failed",
      input_snapshot_sha256: HASH_A,
      summary: "candidate failed validation",
      failure: { reason: "bad metric", failure_code: "METRIC_FAILED", evidence_refs: [] },
    });
    assert.equal(saved.status, "failed");
    assert.equal(fs.existsSync(resultPackagePath(root, "result-run")), true);
    fs.unlinkSync(path.join(root, ".aris", "runs", "result-run", "result-summary.md"));
    expectFailure(root, "RESULT_SUMMARY_NOT_FOUND", () => readResultPackage(root, "result-run"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("child optimizable scope cannot escape parent position or bundle", () => {
  const root = tempRoot();
  try {
    assert.doesNotThrow(() =>
      assertOptimizableScopeSubset(
        [{ position_id: "main", mode: "independent" }],
        [{ position_id: "main", mode: "independent" }],
      ),
    );
    expectFailure(root, "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED", () =>
      assertOptimizableScopeSubset(
        [{ position_id: "main", mode: "independent" }],
        [{ position_id: "eval", mode: "independent" }],
      ),
    );
    const parent: BaselineScope = createBaselineScope({
      workflow_definition: { modules: [{ id: "main" }, { id: "eval" }] },
      code_baseline: "commit:baseline",
      position_artifacts: {
        main: { artifact_ref: "main", artifact_sha256: HASH_A },
        eval: { artifact_ref: "eval", artifact_sha256: HASH_B },
      },
      initial_validation: {
        scorer_revision: "scorer",
        input_snapshot_sha256: HASH_C,
        judge_binding: "judge",
      },
      optimizable_scope: [
        { position_id: "main", mode: "bundled", bundle_members: ["main", "eval"] },
      ],
      max_bundled_positions_per_graph: 1,
    });
    assert.doesNotThrow(() =>
      assertOptimizableScopeSubset(parent, [
        { position_id: "main", mode: "bundled", bundle_members: ["main", "eval"] },
      ]),
    );
    expectFailure(root, "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED", () =>
      assertOptimizableScopeSubset(parent, [{ position_id: "eval", mode: "independent" }]),
    );
    expectFailure(root, "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED", () =>
      assertOptimizableScopeSubset(parent, [{ position_id: "main", mode: "independent" }]),
    );
    expectFailure(root, "INVALID_BASELINE", () =>
      assertOptimizableScopeSubset(parent, [
        { position_id: "main", mode: "bundled", bundle_members: ["main"] },
      ]),
    );
    expectFailure(root, "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED", () =>
      assertOptimizableScopeSubset(parent, [
        { position_id: "main", mode: "bundled", bundle_members: ["main", "eval", "extra"] },
      ]),
    );

    const parentWithThreeMembers: BaselineScope = createBaselineScope({
      workflow_definition: {
        modules: [{ id: "main" }, { id: "eval" }, { id: "extra" }],
      },
      code_baseline: "commit:baseline",
      position_artifacts: {
        main: { artifact_ref: "main", artifact_sha256: HASH_A },
        eval: { artifact_ref: "eval", artifact_sha256: HASH_B },
        extra: { artifact_ref: "extra", artifact_sha256: HASH_C },
      },
      initial_validation: {
        scorer_revision: "scorer",
        input_snapshot_sha256: HASH_C,
        judge_binding: "judge",
      },
      optimizable_scope: [
        { position_id: "main", mode: "bundled", bundle_members: ["main", "eval", "extra"] },
      ],
      max_bundled_positions_per_graph: 1,
    });
    assert.doesNotThrow(() =>
      assertOptimizableScopeSubset(parentWithThreeMembers, [
        { position_id: "main", mode: "bundled", bundle_members: ["main", "eval", "extra"] },
      ]),
    );
    expectFailure(root, "OPTIMIZABLE_SCOPE_ALIGNMENT_REQUIRED", () =>
      assertOptimizableScopeSubset(parentWithThreeMembers, [
        { position_id: "main", mode: "bundled", bundle_members: ["main", "eval"] },
      ]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline rejects the covered invalid independent and bundled shapes", () => {
  const root = tempRoot();
  try {
    const baseline = () => ({
      workflow_definition: { modules: [{ id: "main" }, { id: "eval" }] },
      code_baseline: "commit:baseline",
      position_artifacts: {
        main: { artifact_ref: "main", artifact_sha256: HASH_A },
        eval: { artifact_ref: "eval", artifact_sha256: HASH_B },
      },
      initial_validation: {
        scorer_revision: "scorer",
        input_snapshot_sha256: HASH_C,
        judge_binding: "judge",
      },
      max_bundled_positions_per_graph: 1,
    });
    const invalidCases = [
      {
        scope: [{ position_id: "main", mode: "independent", bundle_members: ["main"] }],
        code: "INVALID_BASELINE",
      },
      {
        scope: [{ position_id: "main", mode: "independent", bundle_members: null }],
        code: "INVALID_BASELINE",
      },
      {
        scope: [{ position_id: "main", mode: "bundled", bundle_members: ["main"] }],
        code: "INVALID_BASELINE",
      },
      {
        scope: [{ position_id: "main", mode: "bundled", bundle_members: ["eval"] }],
        code: "INVALID_BASELINE",
      },
      {
        scope: [{ position_id: "main", mode: "bundled", bundle_members: ["main", "main"] }],
        code: "DUPLICATE_ID",
      },
      {
        scope: [
          { position_id: "main", mode: "independent" },
          { position_id: "main", mode: "independent" },
        ],
        code: "DUPLICATE_ID",
      },
      {
        scope: [
          { position_id: "main", mode: "bundled", bundle_members: ["main", "eval"] },
          { position_id: "eval", mode: "independent" },
        ],
        code: "INVALID_BASELINE",
      },
      {
        scope: [{ position_id: "main", mode: "bundled", bundle_members: ["main", "eval"] }],
        max_bundled_positions_per_graph: 0,
        code: "WORKFLOW_LIMITS_REQUIRED",
      },
    ] as const;
    for (const invalid of invalidCases) {
      const input = { ...baseline(), optimizable_scope: invalid.scope } as Record<string, unknown>;
      if (invalid.max_bundled_positions_per_graph !== undefined)
        input.max_bundled_positions_per_graph = invalid.max_bundled_positions_per_graph;
      expectFailure(root, invalid.code, () => createBaselineScope(input));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
