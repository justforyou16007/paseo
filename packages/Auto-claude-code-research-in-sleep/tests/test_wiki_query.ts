import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { WikiSignal } from "../src/tools/wiki-operations.js";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-wiki-query-test-"));
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
