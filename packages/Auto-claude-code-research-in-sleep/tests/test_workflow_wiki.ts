import { evaluateDashboard } from "../src/tools/metric-gate.js";
import crypto from "node:crypto";
import { createRootRun, runOwnedPath, updateRun } from "../src/tools/run-contract.js";
import { createChildContract } from "./helpers/child-contract.js";
import {
  resolveRunWikiScope,
  runWikiRoot,
  assertResearchVisible,
} from "../src/tools/wiki-scope.js";
import {
  WIKI_MODULE_WORKERS,
  readWikiWorkerManifest,
  wikiWorkerManifestPath,
  sealWikiWorkerManifest,
  queryWiki as queryResearchWiki,
  publishSignal,
} from "../src/tools/research-wiki.js";
import type { WikiSignal } from "../src/tools/wiki-operations.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendWikiEvent,
  eventLogHead,
  initializeWikiSchema,
  readWikiEvents,
  type WikiEvent,
} from "../src/tools/wiki-event-store.js";
import {
  projectWiki,
  queryWiki,
  readWikiModel,
  type WikiQueryRequest,
} from "../src/tools/wiki-projector.js";

const PACKAGE_ROOT = path.resolve(".");
const RESEARCH_WIKI = path.resolve("src/tools/research-wiki.ts");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-workflow-wiki-test-"));
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runTsx(...args: string[]): CommandResult {
  try {
    return {
      stdout: execFileSync("npx", ["--no-install", "tsx", RESEARCH_WIKI, ...args], {
        cwd: PACKAGE_ROOT,
        encoding: "utf-8",
        timeout: 30_000,
      }),
      stderr: "",
      exitCode: 0,
    };
  } catch (error: unknown) {
    const result = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

interface Context {
  module_id: string;
  module_version: string;
  workflow_id: string;
  workflow_revision: string;
  input_snapshot_id: string;
  contract_versions: string[];
  scorer_revision: string;
  scorer_target: string;
  constraints: Array<{ name: string; op: string; value: number }>;
}

const CONTEXT: Context = {
  module_id: "rl",
  module_version: "rl@1",
  workflow_id: "flow",
  workflow_revision: "flow@1",
  input_snapshot_id: "input@1",
  contract_versions: ["contract@1"],
  scorer_revision: "scorer@1",
  scorer_target: "validation_score",
  constraints: [{ name: "safety_score", op: ">=", value: 0.9 }],
};

function appendIdea(
  root: string,
  scope: string,
  id: string,
  title: string,
  context: Partial<Context> = CONTEXT,
): WikiEvent {
  const result = appendWikiEvent(root, {
    producer_kind: "workflow-wiki-test",
    scope,
    subject_id: `idea:${id}`,
    evidence_bundle_id: `bundle:${scope}:${id}`,
    payload: {
      context,
      operations: [
        {
          op: "upsert_page",
          kind: "idea",
          id,
          data: {
            title,
            description: `${title} description`,
            stage: "tested",
            outcome: "negative",
            thesis: "bounded test",
            risks: "known risk",
            based_on: [],
            target_problems: [],
            tags: [],
          },
        },
      ],
    },
  });
  assert.equal(result.status, "appended");
  return result.event;
}

function signal(
  signalId: string,
  kind: "observation" | "proposal" = "observation",
  summary = signalId,
): Record<string, unknown> {
  return {
    signal_id: signalId,
    kind,
    source: kind === "proposal" ? "workflow_validation" : "module_experiment",
    producer: {
      module_id: "rl",
      module_version: CONTEXT.module_version,
      run_id: "run-rl-1",
    },
    applies_to: {
      workflow_id: CONTEXT.workflow_id,
      workflow_revision: CONTEXT.workflow_revision,
      input_snapshot_id: CONTEXT.input_snapshot_id,
      contract_versions: CONTEXT.contract_versions,
      scorer_revision: CONTEXT.scorer_revision,
      scorer_target: CONTEXT.scorer_target,
      constraints: CONTEXT.constraints,
    },
    evidence_refs: [`experiment:${signalId}`],
    supersedes: [],
    status: "active",
    summary,
  };
}

function queryRequest(scope: string, overrides: Partial<WikiQueryRequest> = {}): WikiQueryRequest {
  return {
    purpose: "module-next-idea",
    requester: "rl",
    scope,
    module_id: "rl",
    workflow_id: CONTEXT.workflow_id,
    workflow_revision: CONTEXT.workflow_revision,
    input_snapshot_id: CONTEXT.input_snapshot_id,
    contract_versions: [...CONTEXT.contract_versions],
    scorer_revision: CONTEXT.scorer_revision,
    scorer_target: CONTEXT.scorer_target,
    constraints: CONTEXT.constraints,
    ...overrides,
  };
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

test("query isolates scope and context, freezes the head, and writes distinct scope views", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    projectWiki(root);
    const moduleA = appendIdea(root, "modules/rl", "a", "Idea A");
    const moduleAHead = eventLogHead(readWikiEvents(root));
    appendIdea(root, "modules/other", "b", "Idea B", { ...CONTEXT, module_id: "other" });
    appendIdea(root, "standalone", "standalone", "Standalone idea");
    appendIdea(root, "modules/rl", "wrong-context", "Wrong context", {
      ...CONTEXT,
      workflow_revision: "flow@old",
    });
    projectWiki(root);

    const frozen = queryWiki(root, {
      ...queryRequest("modules/rl"),
      head: moduleA.event_id,
    });
    assert.equal(frozen.status, "ok");
    assert.deepEqual(
      frozen.pages.map((page) => page.id),
      ["a"],
    );
    assert.equal(frozen.head.seq, 1);
    assert.equal(frozen.decision_eligible, false);
    assert.equal(frozen.decision, null);
    assert.equal(frozen.request.head?.seq, 1);
    assert.equal(frozen.query_pack.includes("Idea A"), true);
    assert.equal(frozen.query_pack.includes("Idea B"), false);
    assert.equal(frozen.query_pack.includes("Standalone idea"), false);

    const current = queryWiki(root, queryRequest("modules/rl"));
    assert.equal(current.status, "ok");
    assert.deepEqual(
      current.pages.map((page) => page.id),
      ["a"],
    );
    assert.equal(
      current.excluded.some((item) => item.reason === "context_mismatch"),
      true,
    );
    assert.equal(current.head.seq, 4);

    const sameQueryWithReorderedInput = queryWiki(
      root,
      queryRequest("modules/rl", {
        contract_versions: ["contract@1"],
        head: { ...moduleAHead },
      }),
    );
    assert.equal(sameQueryWithReorderedInput.query_id, frozen.query_id);

    const wrongContext = queryWiki(
      root,
      queryRequest("modules/rl", { workflow_revision: "flow@missing" }),
    );
    assert.equal(wrongContext.status, "insufficient_context");
    assert.equal(wrongContext.pages.length, 0);
    assert.equal(wrongContext.unsupported.length > 0, true);
    const wrongModuleVersion = queryWiki(
      root,
      queryRequest("modules/rl", { module_version: "rl@old" }),
    );
    assert.equal(wrongModuleVersion.status, "insufficient_context");
    const wrongScorerTarget = queryWiki(
      root,
      queryRequest("modules/rl", { scorer_target: "other_score" }),
    );
    assert.equal(wrongScorerTarget.status, "insufficient_context");

    const scopeA = JSON.parse(
      fs.readFileSync(path.join(root, "scopes", "modules", "rl", "query_pack.json"), "utf-8"),
    ) as { query_pack: string };
    const scopeOther = JSON.parse(
      fs.readFileSync(path.join(root, "scopes", "modules", "other", "query_pack.json"), "utf-8"),
    ) as { query_pack: string };
    assert.equal(scopeA.query_pack.includes("Idea A"), true);
    assert.equal(scopeA.query_pack.includes("Idea B"), false);
    assert.equal(scopeOther.query_pack.includes("Idea B"), true);
    assert.equal(scopeOther.query_pack.includes("Idea A"), false);
  } finally {
    cleanup(root);
  }
});

test("standalone Signal CLI preserves publish, replay, supersede and retract behavior", () => {
  const root = tmpDir();
  try {
    assert.equal(runTsx("init", root).exitCode, 0);
    const original = path.join(root, "original.json");
    const replacement = path.join(root, "replacement.json");
    writeJson(original, signal("signal:original"));
    writeJson(replacement, signal("signal:replacement"));
    for (const command of ["publish_signal", "publish_signal"]) {
      const result = runTsx(command, root, "--signal-file", original);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    assert.equal(readWikiEvents(root).length, 1);
    const originalHead = eventLogHead(readWikiEvents(root));
    for (let retry = 0; retry < 2; retry++) {
      const result = runTsx(
        "supersede_signal",
        root,
        "--previous-signal-id",
        "signal:original",
        "--signal-file",
        replacement,
      );
      assert.equal(result.exitCode, 0, result.stderr);
    }
    assert.equal(readWikiEvents(root).length, 2);
    assert.deepEqual(
      queryWiki(root, { ...queryRequest("standalone"), head: originalHead }).signals.map(
        (item) => item.signal_id,
      ),
      ["signal:original"],
    );
    const requestPath = path.join(root, "request.json");
    writeJson(requestPath, queryRequest("standalone"));
    const queried = runTsx("query", root, "--request-file", requestPath);
    assert.equal(queried.exitCode, 0, queried.stderr);
    assert.deepEqual(
      JSON.parse(queried.stdout).signals.map((item: WikiSignal) => item.signal_id),
      ["signal:replacement"],
    );
    for (let retry = 0; retry < 2; retry++) {
      const result = runTsx("retract_signal", root, "--signal-id", "signal:replacement");
      assert.equal(result.exitCode, 0, result.stderr);
    }
    assert.equal(readWikiEvents(root).length, 3);
    assert.equal(readWikiModel(root).signals.get("signal:replacement")?.status, "retracted");
    assert.notEqual(
      runTsx("publish_signal", root, "--signal-file", original, "--scope", "modules/rl").exitCode,
      0,
    );
  } finally {
    cleanup(root);
  }
});

test("run scopes enforce parent ownership, isolate evidence and preserve frozen heads", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "parent",
      
      
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:test",
    });
    createChildContract(root, "parent", "training-a", "training");
    createChildContract(root, "parent", "training-b", "inference");
    const scopeA = resolveRunWikiScope(root, "training-a");
    const scopeB = resolveRunWikiScope(root, "training-b");
    assert.notEqual(scopeA, scopeB);
    assert.equal(scopeA, "runs/training-a");
    assert.equal(scopeA.includes("parent"), false);
    assert.throws(() => resolveRunWikiScope(root, "training-a", scopeB), /WIKI_SCOPE_CONFLICT/);
    assert.throws(() => resolveRunWikiScope(root, "missing"), /RUN_CONTRACT_NOT_FOUND/);
    const parentWiki = runWikiRoot(root, "parent");
    initializeWikiSchema(parentWiki);
    appendIdea(
      parentWiki,
      resolveRunWikiScope(root, "parent"),
      "parent-old",
      "sealed parent input",
    );
    const snapshotPath = runOwnedPath(root, "parent", "input-snapshot.json");
    writeJson(snapshotPath, {
      input_snapshot_sha256: "c".repeat(64),
      wiki_head: eventLogHead(readWikiEvents(parentWiki)),
    });
    const snapshotHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(snapshotPath))
      .digest("hex");
    updateRun(root, "parent", { output_hashes: { "input-snapshot.json": snapshotHash } });
    const snapshot = { ref: path.relative(root, snapshotPath), sha256: snapshotHash };
    const bindings = ["training-a", "training-b"].map((runId) => {
      const wikiRoot = runWikiRoot(root, runId);
      initializeWikiSchema(wikiRoot);
      const scope = resolveRunWikiScope(root, runId);
      appendIdea(wikiRoot, scope, runId, runId);
      const localSnapshotPath = runOwnedPath(root, runId, "input-snapshot.json");
      fs.copyFileSync(snapshotPath, localSnapshotPath);
      updateRun(root, runId, {output_hashes:{"input-snapshot.json":snapshotHash}});
      const input = {
        project_root: root,
        run_id: runId,
        worker: "idea-discovery" as const,
        input_snapshot: {ref:path.relative(root,localSnapshotPath),sha256:snapshotHash},
      };
      return { input, manifest: sealWikiWorkerManifest(input) };
    });
    appendIdea(parentWiki, resolveRunWikiScope(root, "parent"), "parent-new", "not dispatched");
    for (const { input, manifest } of bindings) {
      assert.ok(manifest.role !== "tester");
      const wikiRoot = manifest.wiki_root;
      appendIdea(wikiRoot, manifest.scope, "late", "late evidence");
      // Even a foreign event in this log cannot become visible through this run's query.
      appendIdea(wikiRoot, "modules/other", "foreign", "foreign evidence");
      assert.deepEqual(sealWikiWorkerManifest(input), manifest);
      assert.deepEqual(sealWikiWorkerManifest({ ...input, worker: "analyze-results" }), manifest);
      const manifestPath = runOwnedPath(root, input.run_id, "input-manifest.json");
      const request = {
        ...queryRequest(manifest.scope),
        requester: "idea-discovery",
        manifest_path: manifestPath,
      };
      const result = queryResearchWiki(wikiRoot, request);
      assert.deepEqual(
        result.pages.map((page) => page.id),
        [input.run_id],
      );
      assert.deepEqual(result.head, manifest.wiki_head);
      assert.equal(JSON.stringify(result).includes("parent-new"), false);
      assert.throws(
        () => queryResearchWiki(wikiRoot, { ...request, scope: `${manifest.scope}/other` }),
        /WIKI_SCOPE_CONFLICT/,
      );
      assert.throws(
        () =>
          queryResearchWiki(wikiRoot, { ...request, head: eventLogHead(readWikiEvents(wikiRoot)) }),
        /WIKI_HEAD_MISMATCH/,
      );
      assert.throws(
        () => queryResearchWiki(wikiRoot, { ...request, allow_standalone: true }),
        /STANDALONE/,
      );
      const cli = runTsx(
        "query",
        wikiRoot,
        "--manifest",
        manifestPath,
        "--scope",
        manifest.scope,
        "--requester",
        "idea-discovery",
      );
      assert.equal(cli.exitCode, 0, cli.stderr);
      assert.deepEqual(JSON.parse(cli.stdout).head, manifest.wiki_head);
    }
    fs.appendFileSync(runOwnedPath(root, "training-a", "input-snapshot.json"), " ");
    assert.throws(
      () => sealWikiWorkerManifest(bindings[0]!.input),
      /INPUT_SNAPSHOT_NOT_SEALED/,
    );
  } finally {
    cleanup(root);
  }
});

test("child dispatch seals one binding, validates optional fields and preserves its head on recovery", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "parent",
      input_snapshot_sha256: "c".repeat(64),
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:test",
    });
    createChildContract(root, "parent", "child--one", "training");
    const snapshotRef = path.relative(root, runOwnedPath(root, "child--one", "input-snapshot.json"));
    const snapshotSha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, snapshotRef)))
      .digest("hex");
    const input = {
      project_root: root,
      run_id: "child--one",
      worker: "idea-discovery" as const,
      input_snapshot: { ref: snapshotRef, sha256: snapshotSha256 },
    };
    for (const bad of [
      { scope: "training" },
      { wiki_root: null },
      { wiki_head: { seq: 0, event_id: "bad", event_hash: null } },
      { input_snapshot: null },
      { input_snapshot: { ref: "../escape", sha256: "c".repeat(64) } },
      { input_snapshot: { ref: snapshotRef, sha256: "c".repeat(64) } },
    ]) {
      assert.throws(() => sealWikiWorkerManifest({ ...input, ...bad } as typeof input));
      assert.equal(fs.existsSync(wikiWorkerManifestPath(root, input.run_id)), false);
    }
    const binding = sealWikiWorkerManifest(input);
    assert.ok(binding.role !== "tester");
    assert.equal(binding.scope, resolveRunWikiScope(root, input.run_id));
    assert.deepEqual(Object.keys(binding.input_snapshot!).sort(), ["ref", "sha256"]);
    assert.equal(
      binding.input_snapshot!.ref,
      path.relative(root, runOwnedPath(root, input.run_id, "input-snapshot.json")),
    );
    const before = fs.readFileSync(wikiWorkerManifestPath(root, input.run_id));
    // A retry after the parent's Wiki moved on must keep the head it was
    // dispatched against, not adopt whatever arrived since.
    appendIdea(binding.wiki_root, binding.scope, "late-child", "arrived after dispatch");
    assert.deepEqual(sealWikiWorkerManifest(input), binding);
    assert.deepEqual(fs.readFileSync(wikiWorkerManifestPath(root, input.run_id)), before);
    assert.deepEqual(readWikiWorkerManifest(root, input.run_id), binding);
    assert.throws(
      () => sealWikiWorkerManifest({ ...input, scope: "training" }),
      /WIKI_SCOPE_CONFLICT/,
    );
  } finally {
    cleanup(root);
  }
});

test("scorer is bound to its scorer scope and tester has neither Wiki fields nor query access", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "scorer",
      
      
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:test",
    });
    const scorer = sealWikiWorkerManifest({
      project_root: root,
      run_id: "scorer",
      worker: "scorer-loop",
    });
    assert.ok(scorer.role !== "tester");
    const manifestPath = runOwnedPath(root, "scorer", "input-manifest.json");
    const request = {
      ...queryRequest(scorer.scope),
      requester: "scorer-loop",
      manifest_path: manifestPath,
    };
    assert.equal(queryResearchWiki(scorer.wiki_root!, request).scope, scorer.scope);
    assert.throws(
      () =>
        queryResearchWiki(scorer.wiki_root!, {
          ...request,
          scope: resolveRunWikiScope(root, "scorer"),
        }),
      /WIKI_SCOPE_CONFLICT/,
    );
    assert.throws(
      () => queryResearchWiki(scorer.wiki_root!, { ...request, manifest_path: undefined }),
      /WORKER_MANIFEST_REQUIRED/,
    );
    createChildContract(root, "scorer", "tester", "tester");
    const testerInput = { project_root: root, run_id: "tester", worker: "tester" as const };
    const tester = sealWikiWorkerManifest(testerInput);
    assert.equal("wiki_root" in tester, false);
    assert.equal("wiki_head" in tester, false);
    assert.equal("input_snapshot" in tester, false);
    assert.equal("parent_run_id" in tester, false);
    assert.equal(fs.existsSync(runWikiRoot(root, "tester")), false);
    assert.throws(
      () =>
        sealWikiWorkerManifest({
          ...testerInput,
          wiki_root: scorer.wiki_root,
        } as typeof testerInput),
      /UNKNOWN_WORKER_MANIFEST_FIELD/,
    );
    assert.throws(
      () =>
        queryResearchWiki(scorer.wiki_root!, {
          ...queryRequest("standalone"),
          requester: "tester",
        }),
      /WIKI_QUERY_IDENTITY_FORBIDDEN/,
    );
    assert.throws(
      () =>
        queryResearchWiki(scorer.wiki_root!, {
          ...request,
          requester: "human",
          manifest_path: runOwnedPath(root, "tester", "input-manifest.json"),
        }),
      /WIKI_QUERY_IDENTITY_FORBIDDEN/,
    );
    for (const privateData of [
      { tester_cases: ["secret"] },
      { per_case_scores: [1] },
      { private_artifact_uri: "s3://secret" },
      { text: "tester-private://secret" },
    ]) {
      assert.throws(() => assertResearchVisible(privateData), /TESTER_PRIVATE_DATA_FORBIDDEN/);
    }
  } finally {
    cleanup(root);
  }
});

test("standalone remains writable but every public outer query purpose refuses it", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    appendIdea(root, "standalone", "old", "standalone remains available");
    assert.equal(queryResearchWiki(root, queryRequest("standalone")).pages.length, 1);
    const requestFile = path.join(root, "outer-request.json");
    writeJson(requestFile, { ...queryRequest("standalone"), consumer: "research" });
    const denied = runTsx("query", root, "--request-file", requestFile, "--consumer", "stop-gate");
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.stderr, /STANDALONE_OUTER_DECISION_FORBIDDEN/);
    for (const consumer of ["outer-gate", "stop-gate", "candidate-selection"] as const) {
      assert.throws(
        () => queryResearchWiki(root, { ...queryRequest("standalone"), consumer }),
        /STANDALONE_OUTER_DECISION_FORBIDDEN/,
      );
      assert.throws(
        () =>
          queryResearchWiki(root, {
            ...queryRequest("modules/a"),
            allow_standalone: true,
            consumer,
          }),
        /STANDALONE_OUTER_DECISION_FORBIDDEN/,
      );
    }
  } finally {
    cleanup(root);
  }
});

test("run-bound Signal retries append one event and reject caller scope or producer changes", () => {
  const root = tmpDir();
  try {
    createRootRun({ project_root: root, run_id: "run-rl-1",   });
    const wikiRoot = runWikiRoot(root, "run-rl-1");
    initializeWikiSchema(wikiRoot);
    const options = { projectRoot: root, runId: "run-rl-1" };
    const item = signal("signal:scoped-delta") as unknown as WikiSignal;
    assert.equal(publishSignal(wikiRoot, item, options).status, "appended");
    const before = fs.readFileSync(path.join(wikiRoot, "events.jsonl"));
    assert.equal(publishSignal(wikiRoot, item, options).status, "skipped");
    assert.deepEqual(fs.readFileSync(path.join(wikiRoot, "events.jsonl")), before);
    assert.throws(
      () => publishSignal(wikiRoot, item, { ...options, scope: "modules/rl" }),
      /WIKI_SCOPE_CONFLICT/,
    );
    assert.throws(
      () =>
        publishSignal(
          wikiRoot,
          { ...item, producer: { ...item.producer, run_id: "different" } },
          options,
        ),
      /SIGNAL_RUN_CONFLICT/,
    );
  } finally {
    cleanup(root);
  }
});

test("dashboard merge rejects review, scorer, tester and private data without touching the dashboard", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "parent",
      
      
      input_snapshot_sha256: "c".repeat(64),
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:test",
    });
    createChildContract(root, "parent", "module", "training");
    const dashboard = runOwnedPath(root, "module", "dashboard.json");
    writeJson(dashboard, {
      run_id: "module",
      scope: "training",
      iteration: 1,
      current_phase: "idea-discovery",
      status: "running",
      applied_receipts: [],
    });
    const before = fs.readFileSync(dashboard);
    const receiptPath = runOwnedPath(root, "module", "receipt.json");
    for (const receipt of [
      // Rejected on the `reviewed_run_kind` field, not on the worker name: a
      // verdict on someone else's run never merges into a dashboard, whoever
      // wrote it.
      { worker: "reviewer", reviewed_run_kind: "workflow" },
      { worker: "scorer-loop" },
      { worker: "tester" },
      { worker: "idea-discovery", summary: { tester_answers: ["private answer"] } },
    ]) {
      writeJson(receiptPath, receipt);
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              "/home/liu/paseo/node_modules/tsx/dist/cli.mjs",
              "src/tools/dashboard-merge.ts",
              "apply",
              "--root",
              root,
              "--run-id",
              "module",
              "--receipt",
              receiptPath,
            ],
            { encoding: "utf8", stdio: "pipe" },
          ),
        (error: unknown) => {
          assert.match(
            String((error as { stderr: string }).stderr),
            /review receipts cannot|unsupported worker|TESTER_PRIVATE_DATA_FORBIDDEN/,
          );
          return true;
        },
      );
      assert.deepEqual(fs.readFileSync(dashboard), before);
    }
  } finally {
    cleanup(root);
  }
});

test("documented module query workers match the enforced role boundary", () => {
  const reference = fs.readFileSync("skills/shared-references/worker-manifest.md", "utf8");
  const contract = reference.match(
    /<!-- WIKI-ACCESS:START -->\s*```json\s*([\s\S]*?)```\s*<!-- WIKI-ACCESS:END -->/,
  );
  assert.ok(contract);
  const declared = JSON.parse(contract[1]!);
  assert.deepEqual(declared.module_query_workers, [...WIKI_MODULE_WORKERS]);
  assert.deepEqual(declared.scorer_query_workers, ["scorer-loop"]);
  assert.deepEqual(declared.tester_query_workers, []);
  assert.equal(declared.manifest_path, ".aris/runs/<run_id>/input-manifest.json");
});

test("standalone metric evaluation is unchanged and module evaluation refuses standalone Wiki provenance", () => {
  const root = tmpDir();
  try {
    createRootRun({ project_root: root, run_id: "metric",   });
    const file = runOwnedPath(root, "metric", "dashboard.json");
    const dashboard = {
      scope: "standalone",
      metric: { current: 0.9, target: 0.8, direction: "higher_better", tolerance: 0, history: [] },
      iteration: 1,
      
    };
    writeJson(file, dashboard);
    assert.equal(evaluateDashboard(root, "metric").stop_reason, "metric_met");
    writeJson(file, { ...dashboard, mode: "module", module_id: "rl" });
    assert.throws(() => evaluateDashboard(root, "metric"), /STANDALONE_OUTER_DECISION_FORBIDDEN/);
    writeJson(file, {
      ...dashboard,
      mode: "module",
      module_id: "rl",
      scope: "training",
      wiki_scope: "standalone",
    });
    assert.throws(() => evaluateDashboard(root, "metric"), /STANDALONE_OUTER_DECISION_FORBIDDEN/);
  } finally {
    cleanup(root);
  }
});

let passed = 0;
let failed = 0;
for (const current of tests) {
  try {
    current.fn();
    console.log(`  PASS ${current.name}`);
    passed += 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  FAIL ${current.name}: ${message}`);
    failed += 1;
    if (process.argv.includes("--bail")) break;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
