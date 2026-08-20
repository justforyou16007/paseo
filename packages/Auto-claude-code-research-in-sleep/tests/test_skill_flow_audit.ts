import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFlowAudit } from "../src/skill-flow-audit/extract.js";
import { renderFlowAuditHtml } from "../src/skill-flow-audit/render.js";

interface TestCase {
  name: string;
  run: () => void;
}

const tests: TestCase[] = [];

function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-flow-audit-"));
  writeFixture(
    root,
    "skills/main-flow/SKILL.md",
    `---
name: main-flow
description: 'Full pipeline that chains workers. Use when the user requests the complete flow.'
argument-hint: '[--resume <run-id>] [--max-rounds <n>]'
---

# Main Flow

## Phase 1: Produce evidence

Invoke /worker-task and write \`runs/EVIDENCE.json\`.

## Phase 2: Decide

Read \`runs/EVIDENCE.json\`. Retry this phase until the audit passes.
On failure, ask the user whether to continue. On resume, return to Phase 2.

## Phase 3: Run helper

HELPER="dist/tools/check-result.js"
node "$HELPER" --input runs/EVIDENCE.json --output runs/VERDICT.json
If the input is missing, exit 1.
If the helper fails, exit 1.
echo "Run /worker-task manually if you need diagnostics."
`,
  );
  writeFixture(
    root,
    "skills/worker-task/SKILL.md",
    `---
name: worker-task
description: 'Execute one bounded task and produce evidence.'
---

# Worker Task

## Step 1: Execute

Write \`runs/EVIDENCE.json\` and return.

For the full workflow, see /main-flow.

Use the less error-prone path.

\`\`\`markdown
## Example Output Heading
This heading belongs to an output template, not the workflow.
\`\`\`
`,
  );
  writeFixture(
    root,
    "src/tools/check-result.ts",
    `import fs from "node:fs";
import { Command } from "commander";
const program = new Command()
  .description("Validate experiment evidence and write a verdict.")
  .requiredOption("--input <file>", "Evidence JSON to read")
  .option("--output <file>", "Verdict JSON to write");
const evidence = fs.readFileSync("runs/EVIDENCE.json", "utf8");
fs.writeFileSync("runs/VERDICT.json", evidence);
`,
  );
  writeFixture(root, "legacy-python/tools/check-result.py", "print('stale')\n");
  return root;
}

test("extracts roles, calls, file lineage, controls, and source lines", () => {
  const root = createFixture();
  try {
    const audit = extractFlowAudit(root);
    const main = audit.skills.find((skill) => skill.name === "main-flow");
    const worker = audit.skills.find((skill) => skill.name === "worker-task");

    assert.ok(main);
    assert.ok(worker);
    assert.equal(main.classification, "entry");
    assert.equal(main.argumentHint, "[--resume <run-id>] [--max-rounds <n>]");
    assert.equal(worker.classification, "subtask");
    assert.equal(worker.steps.length, 1);
    assert.deepEqual(worker.steps[0]?.routes, []);
    assert.equal(audit.code.length, 1);
    assert.equal(audit.code[0]?.file, "src/tools/check-result.ts");
    assert.equal(
      audit.code[0]?.description,
      "Validate experiment evidence and write a verdict.",
    );
    assert.deepEqual(
      audit.code[0]?.parameters.map((parameter) => [
        parameter.syntax,
        parameter.description,
        parameter.required,
      ]),
      [
        ["--input <file>", "Evidence JSON to read", true],
        ["--output <file>", "Verdict JSON to write", false],
      ],
    );

    const skillCall = audit.calls.find(
      (call) => call.from === main.id && call.to === worker.id && call.relation === "call",
    );
    assert.ok(skillCall);
    assert.equal(skillCall.confidence, "explicit");
    assert.equal(skillCall.source.line, 11);
    assert.equal(
      audit.calls.filter(
        (call) => call.from === main.id && call.to === worker.id && call.relation === "call",
      ).length,
      1,
    );

    const toolCall = audit.calls.find(
      (call) => call.from === main.id && call.to === audit.code[0]?.id,
    );
    assert.ok(toolCall);
    assert.equal(toolCall.source.line, 21);

    const helperStep = main.steps.find((step) => step.title.includes("Run helper"));
    assert.ok(helperStep);
    const failureRoutes = helperStep.routes.filter(
      (route) => route.kind === "failure" && route.destination === "停止并报告失败",
    );
    assert.equal(failureRoutes.length, 1);
    assert.equal(failureRoutes[0]?.occurrences.length, 2);

    const evidence = audit.artifacts.find((artifact) => artifact.key === "evidence.json");
    assert.ok(evidence);
    assert.deepEqual(
      evidence.producers.map((use) => use.owner).sort(),
      [main.id, worker.id].sort(),
    );
    assert.deepEqual(
      [...new Set(evidence.consumers.map((use) => use.owner))].sort(),
      [audit.code[0]?.id, main.id].sort(),
    );

    const decision = main.steps.find((step) => step.title.includes("Decide"));
    assert.ok(decision);
    assert.deepEqual(
      decision.controls.map((control) => control.kind).sort(),
      ["loop", "pause", "retry"],
    );
    assert.deepEqual(
      decision.routes.map((route) => route.destination).sort(),
      ["等待用户", "本步骤", "Phase 2"].sort(),
    );
    assert.equal(decision.source.file, "skills/main-flow/SKILL.md");
    assert.equal(decision.source.line, 13);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renders a self-contained page with side expansion and source navigation", () => {
  const root = createFixture();
  try {
    const audit = extractFlowAudit(root);
    const html = renderFlowAuditHtml(audit);
    assert.match(html, /ARIS 程序执行流程审计图/);
    assert.match(html, /data-action="toggle-calls"/);
    assert.match(html, /decision-diamond/);
    assert.match(html, /flow-edge-spec/);
    assert.match(html, /入参与本次调用/);
    assert.match(html, /功能（中文）/);
    assert.match(html, /当前流程作用/);
    assert.match(html, /functionTextForSkill/);
    assert.match(html, /源码原文功能说明/);
    assert.match(html, /Validate experiment evidence and write a verdict/);
    assert.match(html, /openSource/);
    assert.match(html, /文件流/);
    assert.doesNotMatch(html, /<script\s+src=/);
    assert.doesNotMatch(html, /<link\s+[^>]*href=/);
    assert.equal(html, renderFlowAuditHtml(audit));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scans the full ARIS tree without treating explanatory sections as steps", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const audit = extractFlowAudit(repoRoot);
  assert.ok(audit.coverage.skillFiles >= 80);
  assert.ok(audit.coverage.scriptFiles >= 20);
  assert.ok(audit.coverage.toolFiles >= 40);
  assert.ok(audit.code.every((node) => !node.file.startsWith("legacy-python/")));

  const auto = audit.skills.find((skill) => skill.name === "auto-research-loop");
  const gap = audit.skills.find((skill) => skill.name === "gap-planner");
  assert.ok(auto);
  assert.ok(gap);
  assert.equal(auto.classification, "entry");
  assert.equal(auto.authority, "coordination");
  assert.equal(gap.classification, "subtask");
  assert.ok(auto.steps.some((step) => step.title.startsWith("Phase 4.5: Gap Planner")));
  assert.ok(auto.steps.every((step) => !/diagram|responsibility boundary/i.test(step.title)));
  assert.ok(auto.steps.every((step) => !/^(?:resume protocol|stop gate)/i.test(step.title)));

  const initialization = auto.steps.find((step) => step.title.startsWith("Phase 0:"));
  assert.ok(initialization);
  const initializationFailures = initialization.routes.filter(
    (route) => route.kind === "failure" && route.destination === "停止并报告失败",
  );
  assert.equal(initializationFailures.length, 1);
  assert.ok((initializationFailures[0]?.occurrences.length ?? 0) > 5);

  const metricEvaluation = auto.steps.find((step) => step.title.startsWith("Phase 3:"));
  assert.ok(metricEvaluation);
  assert.ok(
    metricEvaluation.routes.some(
      (route) => route.kind === "branch" && route.destination === "Phase 5" && route.targetStepId,
    ),
  );

  const gapStep = auto.steps.find((step) => step.title.startsWith("Phase 4.5:"));
  assert.ok(
    gapStep?.routes.some(
      (route) => route.kind === "branch" && route.destination === "Phase 1" && route.targetStepId,
    ),
  );

  const gapCall = audit.calls.find(
    (call) => call.from === auto.id && call.to === gap.id && call.confidence === "explicit",
  );
  assert.ok(gapCall);
  const sourcePath = path.join(repoRoot, gapCall.source.file);
  const sourceLines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
  assert.match(sourceLines[gapCall.source.line - 1] ?? "", /gap-planner/);
  const ownerStep = auto.steps.find((step) => step.id === gapCall.stepId);
  assert.ok(ownerStep?.title.startsWith("Phase 4.5: Gap Planner"));

  const plan = audit.artifacts.find((artifact) => artifact.key === "experiment_plan.md");
  assert.ok(plan);
  assert.ok(plan.producers.every((use) => use.owner !== auto.id));
  assert.ok(plan.consumers.some((use) => use.owner === "skill:auto-review-loop"));
});

let failures = 0;
for (const entry of tests) {
  try {
    entry.run();
    process.stdout.write(`PASS ${entry.name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${entry.name}\n`);
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

process.stdout.write(`\n${tests.length - failures} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
