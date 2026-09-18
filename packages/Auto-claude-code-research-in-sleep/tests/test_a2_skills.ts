import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyBridgeResult } from "../src/tools/experiment-bridge.js";
import { resultStatusPolicy, type ResultStatus } from "../src/tools/result-package.js";
import { ROOT_SETUP_ITEMS } from "../src/tools/task-setup.js";
import { buildTesterFeedback, sanitizeTesterFeedback } from "../src/tools/tester-feedback.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function isExactLine(line: string | undefined, expected: string): boolean {
  return line?.trim() === expected;
}

function findExactLine(skill: string, expected: string, from = 0): number {
  let offset = 0;
  for (const line of skill.split("\n")) {
    if (offset >= from && isExactLine(line, expected)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function findExactLineIndex(lines: readonly string[], expected: string, from = 0): number {
  for (let index = from; index < lines.length; index += 1) {
    if (isExactLine(lines[index], expected)) return index;
  }
  return -1;
}

function assertExactLineBlock(skill: string, expected: readonly string[], message: string): void {
  assert.ok(expected.length > 0, `${message} must not be empty`);
  const lines = skill.split("\n");
  const start = findExactLineIndex(lines, expected[0]!);
  assert.notEqual(start, -1, `${message} start is required`);
  assert.deepEqual(
    lines.slice(start, start + expected.length).map((line) => line.trim()),
    [...expected],
    `${message} must match exactly`,
  );
}

function findExactLineEnding(skill: string, expected: string, message: string): string {
  const line = skill
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.endsWith(expected));
  assert.notEqual(line, undefined, `${message} is required`);
  return line!;
}

function assertExactTextSpan(skill: string, expected: string, message: string): void {
  const normalizedSkill = skill
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " "))
    .join("\n");
  const expectedWords = expected.trim().split(/[ \t\n]+/);
  const escapedExpected = expectedWords
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[ \\t\\n]+");
  assert.match(
    normalizedSkill,
    new RegExp(`(?:^|[ \\t\\n])${escapedExpected}(?=$|[ \\t]*\\n)`),
    `${message} is required`,
  );
}

function endOfLine(skill: string, start: number): number {
  const newline = skill.indexOf("\n", start);
  return newline === -1 ? skill.length : newline;
}

const autoSkill = () => read("skills/auto-research-loop/SKILL.md");
const setupSkill = () => read("skills/aris-setup/SKILL.md");
const testerSetupSkill = () => read("skills/tester-setup/SKILL.md");

const statuses: readonly ResultStatus[] = [
  "not_executable",
  "infra_unavailable",
  "succeeded",
  "failed",
];

interface StatusRow {
  failure_code: string | null;
  enters_validation: boolean;
  consumes_tester_exposure: boolean;
  counts_for_stop_gate: boolean;
}

function resultSection(skill: string, endHeading: string): string {
  const start = findExactLine(skill, "## Result status routing");
  assert.notEqual(start, -1, "status routing section is required");
  const after = skill.slice(endOfLine(skill, start) + 1);
  const end = findExactLine(after, endHeading);
  assert.notEqual(end, -1, `${endHeading} section boundary is required`);
  return after.slice(0, end);
}

function parseStatusTable(skill: string, endHeading: string): Map<ResultStatus, StatusRow> {
  const lines = resultSection(skill, endHeading).split("\n");
  const header = "| status | failure code | validation | tester exposure | stop gate |";
  const headerIndex = findExactLineIndex(lines, header);
  assert.notEqual(headerIndex, -1, "status routing table header is required");
  assert.equal(
    isExactLine(lines[headerIndex + 1], "| --- | --- | --- | --- | --- |"),
    true,
    "status routing table separator is required",
  );

  const rows = new Map<ResultStatus, StatusRow>();
  for (const line of lines.slice(headerIndex + 2)) {
    const tableLine = line.trim();
    if (tableLine[0] !== "|" || !tableLine.endsWith("|")) break;
    const cells = tableLine
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("`", ""));
    assert.equal(cells.length, 5, `unexpected status row: ${line}`);
    assert.ok(statuses.includes(cells[0] as ResultStatus), `unknown status row: ${cells[0]}`);
    const status = cells[0] as ResultStatus;
    assert.equal(rows.has(status), false, `duplicate status row: ${status}`);
    const bool = (value: string, column: string): boolean => {
      assert.ok(value === "yes" || value === "no", `${status}.${column} must be yes or no`);
      return value === "yes";
    };
    rows.set(status, {
      failure_code: cells[1] === "—" ? null : cells[1],
      enters_validation: bool(cells[2], "validation"),
      consumes_tester_exposure: bool(cells[3], "tester exposure"),
      counts_for_stop_gate: bool(cells[4], "stop gate"),
    });
  }
  assert.deepEqual(
    [...rows.keys()].sort(),
    [...statuses].sort(),
    "status table must cover four states",
  );
  return rows;
}

function parseBacktickList(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

function sourceInterfaceFields(source: string, interfaceName: string): string[] {
  const block = source.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `${interfaceName} source interface is required`);
  return [...block[1]!.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]!);
}

function sourceStringSet(source: string, declaration: string): string[] {
  const block = source.match(
    new RegExp(`${declaration}\\s*=\\s*new Set(?:<[^>]+>)?\\(\\[([\\s\\S]*?)\\]\\)`),
  );
  assert.ok(block, `${declaration} source set is required`);
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

const bridgeVariableSources = [
  {
    variable: "WORKFLOW_CLI",
    source: "- `WORKFLOW_CLI` is the one `workflow-cli.js` resolved by",
  },
  {
    variable: "PROJECT_ROOT",
    source: "- `PROJECT_ROOT` is the absolute `project root` from the dispatch contract's",
  },
  {
    variable: "OUTER_RUN_ID",
    source: "- `OUTER_RUN_ID` is `run.json.run_id` (`src/tools/run-contract.ts:32`).",
  },
  {
    variable: "EXECUTION_ROOT",
    source: "- `EXECUTION_ROOT` uses the exact `workflow-runtime.json.execution_root` entry",
  },
  {
    variable: "BRIDGE_INPUT_JSON",
    source: "- `BRIDGE_INPUT_JSON` uses the exact `.../outputs/bridge-input.json` entry in",
  },
  {
    variable: "BRIDGE_EVIDENCE_PATH",
    source: "- `BRIDGE_EVIDENCE_PATH` uses the exact sibling `.../receipt.json` entry in",
  },
] as const;

function bridgeCommand(skill: string): string {
  const marker = skill.indexOf('node "$WORKFLOW_CLI" bridge-expand');
  assert.notEqual(marker, -1, "bridge command variable block is required");
  const fenceStart = skill.lastIndexOf("```bash", marker);
  assert.notEqual(fenceStart, -1, "bridge command bash fence is required");
  const fenceEnd = skill.indexOf("\n```", marker);
  assert.notEqual(fenceEnd, -1, "bridge command closing fence is required");
  return skill.slice(fenceStart, fenceEnd);
}

function workflowDispatchBranch(): string {
  const dispatch = read("skills/shared-references/paseo-subagent-dispatch.md");
  const start = dispatch.indexOf("### Workflow outer-cycle dispatch branch");
  assert.notEqual(start, -1, "workflow outer-cycle dispatch branch is required");
  const end = dispatch.indexOf("### What the watchdog tick does", start);
  assert.notEqual(end, -1, "workflow dispatch branch boundary is required");
  return dispatch.slice(start, end);
}

function bridgeSourceSection(skill: string): string {
  const start = findExactLine(skill, "## Bridge variable sources");
  assert.notEqual(start, -1, "bridge variable source section is required");
  const after = skill.slice(endOfLine(skill, start) + 1);
  const end = findExactLine(after, "## Result status routing");
  assert.notEqual(end, -1, "bridge variable source section boundary is required");
  return after.slice(0, end).replace(/\s+/g, " ");
}

const bridgeSourceText: Record<string, string> = Object.fromEntries(
  bridgeVariableSources.map(({ variable, source }) => [variable, source]),
);

function assertBridgeSourceLines(name: string, sources: string): void {
  const inputSource =
    name === "outer"
      ? "- `BRIDGE_INPUT_JSON` uses the exact input-artifact path (including its filename)"
      : bridgeSourceText.BRIDGE_INPUT_JSON!;
  assert.equal(
    sources.includes(bridgeSourceText.WORKFLOW_CLI!),
    true,
    `${name} source for WORKFLOW_CLI`,
  );
  assert.equal(
    sources.includes(bridgeSourceText.PROJECT_ROOT!),
    true,
    `${name} source for PROJECT_ROOT`,
  );
  assert.equal(
    sources.includes(bridgeSourceText.OUTER_RUN_ID!),
    true,
    `${name} source for OUTER_RUN_ID`,
  );
  assert.equal(sources.includes(inputSource), true, `${name} source for BRIDGE_INPUT_JSON`);
  assert.equal(
    sources.includes(bridgeSourceText.EXECUTION_ROOT!),
    true,
    `${name} source for EXECUTION_ROOT`,
  );
  assert.equal(
    sources.includes(bridgeSourceText.BRIDGE_EVIDENCE_PATH!),
    true,
    `${name} source for BRIDGE_EVIDENCE_PATH`,
  );
}

test("four status rows match the shared policy and bridge priority", () => {
  const packageSource = read("src/tools/result-package.ts");
  const bridgeSource = read("src/tools/experiment-bridge.ts");
  const autoRows = parseStatusTable(autoSkill(), "## Phase boundaries");

  assert.equal(
    (bridgeSource.match(/export function planExperimentBridge\(/g) ?? []).length,
    1,
    "the bridge must expose one plan entry",
  );
  assert.match(packageSource, /export function resultStatusPolicy\(/);

  for (const status of statuses) {
    const row = autoRows.get(status)!;
    const policy = resultStatusPolicy(status);
    assert.deepEqual(
      {
        failure_code: row.failure_code,
        enters_validation: row.enters_validation,
        consumes_tester_exposure: row.consumes_tester_exposure,
        counts_for_stop_gate: row.counts_for_stop_gate,
      },
      {
        failure_code:
          status === "not_executable"
            ? "RESOURCE_SCOPE_ALIGNMENT_REQUIRED"
            : status === "infra_unavailable"
              ? "INFRA_UNAVAILABLE"
              : null,
        enters_validation: policy.enters_validation,
        consumes_tester_exposure: policy.consumes_tester_exposure,
        counts_for_stop_gate: policy.counts_for_stop_gate,
      },
      `${status} documentation does not match resultStatusPolicy`,
    );
  }

  const bridgeCases: Record<ResultStatus, Parameters<typeof classifyBridgeResult>[0]> = {
    not_executable: {
      resource_status: "not_executable",
      execution_outcome: "succeeded",
      result_package: { status: "succeeded" },
    },
    infra_unavailable: {
      resource_status: "infra_unavailable",
      execution_outcome: "failed",
    },
    succeeded: { resource_status: "succeeded", execution_outcome: "succeeded" },
    failed: { resource_status: "succeeded", execution_outcome: "failed" },
  };
  for (const status of statuses) {
    const route = classifyBridgeResult(bridgeCases[status]);
    assert.equal(route.status, status, `${status} bridge route`);
    assert.equal(route.failure_code, autoRows.get(status)!.failure_code, `${status} error code`);
  }
});

test("one recursive phase sequence and dispatch manifest match what the tools enforce", () => {
  const skill = autoSkill();
  const phaseSectionStart = findExactLine(skill, "## One sequence at depth 0, 1 and 2");
  const phaseSectionEnd = findExactLine(
    skill,
    "## Expansion is owned by one bridge",
    phaseSectionStart,
  );
  assert.notEqual(phaseSectionStart, -1, "recursive phase section is required");
  assert.notEqual(phaseSectionEnd, -1, "recursive expansion section is required");
  const phaseSection = skill.slice(phaseSectionStart, phaseSectionEnd);
  const phaseLines = phaseSection.split("\n");
  const phaseCodeStart = findExactLineIndex(phaseLines, "```text");
  const phaseCodeEnd = findExactLineIndex(phaseLines, "```", phaseCodeStart + 1);
  assert.notEqual(phaseCodeStart, -1, "recursive phase sequence must be in one text block");
  assert.notEqual(phaseCodeEnd, -1, "recursive phase sequence must be in one text block");
  // bridge-repair is drawn as a branch, not a step in the line, because it is
  // entered only from a failed bridge or a review that could not rule.
  const expectedPhaseLines = [
    "idea-discovery",
    "-> experiment-bridge",
    "-> auto-review-loop",
    "-> metric-gate",
    "-> completed",
    "branch: bridge-repair (from a bridge that failed, or a review that could not rule)",
  ];
  assert.deepEqual(
    phaseLines.slice(phaseCodeStart + 1, phaseCodeEnd).map((line) => line.trim()),
    expectedPhaseLines,
    "phase code lines must match the documented sequence",
  );
  // A child is a standalone run, so no single symbol owns the sequence above
  // any more. What src does own is narrower and still worth pinning: each
  // worker named in the line must be allowed to write from the phase of the
  // same name, and the branch phase must be reachable by the review worker.
  const mergeSource = read("src/tools/dashboard-merge.ts");
  const mergePhases = (worker: string): string[] => {
    const block = mergeSource.match(
      new RegExp(`"${worker}": \\{[\\s\\S]*?phases: \\[([^\\]]*)\\]`),
    );
    assert.ok(block, `${worker} must have a merge rule`);
    return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  };
  for (const worker of ["idea-discovery", "experiment-bridge", "auto-review-loop"])
    assert.ok(mergePhases(worker).includes(worker), `${worker} must write from its own phase`);
  assert.ok(
    mergePhases("auto-review-loop").includes("bridge-repair"),
    "the review worker is what opens and closes the bridge-repair branch",
  );

  const documentedManifestStart = findExactLine(
    skill,
    "`project_root`, `run_id`, `worker`, `scope`, `input_snapshot`",
  );
  assert.notEqual(documentedManifestStart, -1, "manifest field list is required");
  const documentedManifestLine = skill.slice(
    documentedManifestStart,
    endOfLine(skill, documentedManifestStart),
  );
  assert.deepEqual(
    parseBacktickList(documentedManifestLine),
    sourceInterfaceFields(read("src/tools/research-wiki.ts"), "WikiWorkerManifestInput"),
    "skill manifest fields must mirror what a dispatch may seal",
  );

  const setup = setupSkill();
  const setupItemsStart = findExactLine(
    setup,
    "`tester`, `tester_agent`, `thresholds`, `exposure`, `limits`, `resource`, `baseline`",
  );
  assert.notEqual(setupItemsStart, -1, "setup item list is required");
  const setupItemsLine = setup.slice(setupItemsStart, endOfLine(setup, setupItemsStart));
  assert.deepEqual(parseBacktickList(setupItemsLine), [...ROOT_SETUP_ITEMS]);
});

test("root entry documents the charter reader and the no-fallback rule", () => {
  const auto = autoSkill();
  const rootCharterSource = read("src/tools/root-charter.ts");
  const bridgeSource = read("src/tools/experiment-bridge.ts");

  assertExactLineBlock(
    auto,
    ["`readRootCharter` in `src/tools/root-charter.ts`; that reader checks the charter"],
    "root charter reader",
  );
  assertExactLineBlock(
    auto,
    ["against `run.json`. The run it belongs to has `parent_run_id: null`, `depth: 0`"],
    "root charter identity",
  );
  assertExactLineBlock(
    auto,
    ['names `baseline_ref: "W_0"` and carries the frozen resource inventory, owner'],
    "root charter baseline",
  );
  assert.match(rootCharterSource, /export function readRootCharter\(/);
  assert.match(bridgeSource, /export function planExperimentBridge\(/);
  assertExactLineBlock(
    auto,
    ["`planExperimentBridge` in `src/tools/experiment-bridge.ts`. Do not reproduce"],
    "root entry bridge call",
  );

  // The loop skill is the orchestrator, so it does run `dashboard-merge.js`,
  // `metric-gate.js` and `mkdir -p`. What it must not do is build the frozen
  // inputs it was handed; those arrive as manifest fields.
  for (const forbiddenConstruction of ["path.join", "path.resolve", "git worktree"])
    assert.equal(
      auto.includes(forbiddenConstruction),
      false,
      `root entry must not construct ${forbiddenConstruction}`,
    );
  assertExactLineBlock(
    auto,
    [
      "must not say that the old runtime is already using it. A missing connection is",
      "a hard stop and a report item, not a reason to call the old path.",
    ],
    "root entry no-fallback rule",
  );
});

test("workflow idea dispatch hands its manifest path to bridge-input", () => {
  const dispatch = workflowDispatchBranch();
  const manifestAssignment = dispatch.match(
    /^IDEA_DISCOVERY_MANIFEST_PATH\s*=\s*"\$WORKER_DIR\/input-manifest\.json"\s*$/m,
  );
  assert.ok(manifestAssignment, "workflow dispatch must assign the exact worker manifest path");
  const manifestVariable = manifestAssignment![0]!.match(/^([A-Z][A-Z0-9_]*)/)![1]!;
  assert.match(dispatch, /CYCLE_WORKERS_ROOT = <the verified root from bridge-expansion\.md>/);
  assert.match(
    dispatch,
    /create_agent\(provider,[\s\S]*manifest: \$IDEA_DISCOVERY_MANIFEST_PATH/,
  );

  const bridge = read("skills/shared-references/bridge-expansion.md");
  const bridgeManifestArgument = bridge.match(
    /--idea-discovery-manifest\s+"\$([A-Z][A-Z0-9_]*)"/,
  );
  assert.ok(bridgeManifestArgument, "bridge-input command must receive a manifest variable");
  assert.equal(
    bridgeManifestArgument![1],
    manifestVariable,
    "dispatch and bridge-input must use the same manifest variable",
  );

  for (const [name, skill] of [
    ["auto", autoSkill()],
  ] as const) {
    assert.match(
      skill,
      new RegExp("`" + manifestVariable + "`"),
      `${name} loop must retain the dispatch manifest variable`,
    );
  }
});

test("bridge command variables have deterministic sources", () => {
  const shared = read("skills/shared-references/bridge-expansion.md");
  const sharedFacts = [
    "`workflow-runtime.json.outer_iteration` as `OUTER_ITERATION`",
    "`workflow-runtime.json.execution_root` as `EXECUTION_ROOT`",
    "$PROJECT_ROOT/.aris/runs/$OUTER_RUN_ID/cycles/${OUTER_ITERATION}/workers/<directory-containing-the-runtime-manifest>/input-manifest.json",
    "IDEA_DISCOVERY_WORKER_DIR=\"$(dirname \"$IDEA_DISCOVERY_MANIFEST_PATH\")\"",
    "IDEA_DISCOVERY_JSON=\"$IDEA_DISCOVERY_WORKER_DIR/outputs/idea-discovery.json\"",
    "BRIDGE_INPUT_JSON=\"$IDEA_DISCOVERY_WORKER_DIR/outputs/bridge-input.json\"",
    "BRIDGE_EVIDENCE_PATH=\"$IDEA_DISCOVERY_WORKER_DIR/receipt.json\"",
    "--idea-discovery-manifest \"$IDEA_DISCOVERY_MANIFEST_PATH\"",
  ];
  for (const fact of sharedFacts)
    assert.equal(shared.includes(fact), true, `shared bridge convention must define ${fact}`);

  for (const [name, getSkill] of [
    ["auto", autoSkill],
  ] as const) {
    const skill = getSkill();
    const command = bridgeCommand(skill);
    const sources = bridgeSourceSection(skill);
    const preparation = skill.indexOf("`bridge-input`");
    const expansion = skill.indexOf('node "$WORKFLOW_CLI" bridge-expand');
    assert.notEqual(preparation, -1, `${name} must reference bridge-input preparation`);
    assert.ok(preparation < expansion, `${name} must prepare bridge input before bridge-expand`);
    for (const { variable } of bridgeVariableSources) {
      assert.equal(
        command.includes(`$${variable}`) || command.includes(`\${${variable}`),
        true,
        `${name} bridge command must use ${variable}`,
      );
    }
    assertBridgeSourceLines(name, sources);
  }
});

test("tester boundary documents selected response fields and sanitizer vocabulary", () => {
  const auto = autoSkill();
  const setup = setupSkill();
  const testerAgentSource = read("src/tools/tester-agent.ts");
  const feedbackSource = read("src/tools/tester-feedback.ts");
  const publicResponseFields = sourceInterfaceFields(testerAgentSource, "TesterAgentResponse");
  for (const field of ["status", "error_analysis", "signed_conclusion", "signed_feedback"])
    assert.ok(publicResponseFields.includes(field), `response source lost ${field}`);
  const testerBoundaryLines = [
    "It may not analyze the tester run.",
    "Never send or read tester case content, answers, prompts, per-case output,",
    "per-case scores, private observations, fine-grained categories or private URIs.",
    "The one numeric channel out of the tester is `tester_feedback.metrics`: the",
    "tester cannot widen its own disclosure later. There is still no defect list",
  ] as const;
  for (const line of testerBoundaryLines)
    findExactLineEnding(auto, line, `auto skill tester boundary for ${line}`);

  // What the tester may NOT send back is stated once, in the skill that owns the
  // tester machine. /aris-setup points at it rather than restating it, so this
  // is one whole-paragraph comparison against tester-setup instead of the seven
  // per-line checks the old merged copy allowed.
  assertExactTextSpan(
    testerSetupSkill(),
    "Do not analyze the tester run. Case content, answers, prompts, per-case output, per-case scores, private observations, fine-grained categories and private URIs never return to research. The declared metric aggregates and the coarse feedback are not experiment evidence and cannot be fed into analysis, evidence review or a research claim.",
    "tester-setup case-content boundary",
  );
  // The two facts tester-setup does not carry stay with the setup entry point.
  assertExactTextSpan(
    setup,
    "It has no defect-list field; do not promise that output until its producer and validator exist. Declared metrics and fixed coarse feedback are not experiment evidence and cannot be fed into analysis, evidence review or a research claim.",
    "setup skill public metric and defect-list boundary",
  );
  assertExactLineBlock(
    setup,
    [
      "`validateTesterAgentResponse` in `src/tools/tester-agent.ts` and",
      "`sanitizeTesterFeedback` in `src/tools/tester-feedback.ts`.",
    ],
    "setup tester validator mapping",
  );

  const sourceForbiddenKeys = sourceStringSet(feedbackSource, "FORBIDDEN_KEYS");
  const forbiddenLines = [
    "The sanitizer's forbidden key vocabulary includes `case_id`, `case_ids`,",
    "`prompt`, `question`, `answer`, `score`, `scores`, `per_case`,",
    "`private_uri`, `artifact_uri`, `result_uri`, `raw_result`, `exact_example` and",
    "`category`.",
  ];
  assertExactLineBlock(auto, forbiddenLines, "forbidden key vocabulary block");
  assert.deepEqual(parseBacktickList(forbiddenLines.join("\n")), sourceForbiddenKeys);
  // The isolation claim now rests on where the cases live, not on file
  // ownership. The comment wraps across lines in the source.
  assert.match(testerAgentSource, /cases[\s\S]{0,40}never leave that machine/);

  const validFeedback = buildTesterFeedback({
    schema_version: 1,
    task_id: "task-a2-4",
    task_setup_revision: "setup-a2-4",
    input_snapshot_sha256: "a".repeat(64),
    promotion_trial_id: "trial-a2-4",
    tester_version: "tester-v1",
    conclusion: "inconclusive",
    directions: ["long_horizon_stability"],
    advice: ["review_safety_margin"],
    confidence: "medium",
    metrics: { tester_score: 0.9 },
  });
  assert.equal(sanitizeTesterFeedback(validFeedback).conclusion, "inconclusive");
  assert.throws(
    () => sanitizeTesterFeedback({ ...validFeedback, score: 0.5 }),
    (error: unknown) => (error as { code?: string }).code === "PRIVATE_EVIDENCE_LEAK",
  );
});
