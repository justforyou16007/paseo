import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  refreshSetupReview,
  confirmSetupReview,
  prepareSetupInputs,
  verifySetupInputs,
  setupDraftPath,
  validateSetupConfiguration,
  SetupReviewIncompleteError,
} from "../src/tools/setup-review.js";
import {
  assembleRootSetupInput,
  projectSlug,
  experimentSkillDir,
} from "../src/tools/project-setup.js";
import { facilityConfig, installedFacilityFixture } from "./helpers/tester-facility-fixture.js";
import { setupRootRun } from "../src/tools/task-setup.js";
import { readRunScopeLeaseTokens, releaseRunScope } from "../src/tools/run-contract.js";
import type { JsonObject } from "../src/tools/workflow-spec.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function write(root: string, relative: string, value: unknown) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
function fixture(action: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-review-"));
  try {
    action(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function configuration(root: string): JsonObject {
  return {
    project: {
      name: "Fixture research",
      language: "zh",
      constraints: "CPU fixture",
      non_goals: "",
    },
    research: {
      field: "NLP",
      sub_area: "evaluation",
      problem: "Improve fixture score",
      work_type: "improve_existing",
      reference_skills: [],
      reference_documents: [],
      reference_knowledge: [],
    },
    metric: {
      name: "score",
      target: 0.8,
      direction: "higher_better",
      tolerance: 0.01,
      constraints: [],
    },
    baseline: {
      method: "fixture baseline",
      code_ref: "fixture:baseline",
      expected_metric: "0.4",
      tolerance: "0.01",
    },
    environment: {
      backend: "local",
      prd: {
        version: 1,
        mode: "fresh",
        project: projectSlug(root),
        preparation: {
          files: {
            location: "local",
            remote_path: null,
            ssh_alias: null,
            transfer: null,
            excludes: [],
          },
          environment: {
            type: "system",
            activation: "",
            build_cmd: null,
            verify_cmd: "node --version",
          },
        },
        browser: {
          required: false,
          mode: "extract",
          browser_type: "chrome",
          uses: [],
          browser_id: null,
          smoke_url: null,
        },
        resources: {
          type: "cpu",
          ids: [0],
          label: "synthetic fixture",
          bind_env: "taskset -c",
          bind_mode: "prefix",
          free_check: null,
          exhaustion_patterns: [],
        },
        run: {
          entry_point: "fixture.py",
          arg_style: "cli",
          launch_mode: "foreground",
          gpu_selection: "cpu",
          template: "{{activation}} {{entry_point}} {{args}} # {{exp_name}}",
        },
        feedback: {
          error: {
            signal: "exit_code",
            log_path: "logs/${EXP_NAME}.log",
            task_type: "fixture",
            failure_patterns: [],
          },
          result: {
            path_template: "results/${EXP_NAME}.json",
            format: "json",
            primary_metric_key: "score",
            extra_keys: [],
          },
        },
        monitor: {
          interval_cron: "*/20 * * * *",
          escalate_cron: "23 * * * *",
          max_hours: 1,
          early_stop: { enabled: false },
          stall: {
            no_log_growth_minutes: 45,
            gpu_idle_threshold_pct: 5,
            consecutive_alert_ticks: 3,
          },
        },
        baseline: { kind: "real", simple_args: null, evidence_source: "RESEARCH_BRIEF.md" },
      },
    },
    tester: facilityConfig(root) as unknown as JsonObject,
    models: {
      orchestrator_provider: "claude/fixture",
      executor_provider: "claude/fixture",
      executor_mode: "auto",
      reviewer_provider: "codex/fixture",
      reviewer_mode: "auto",
      notify_on_finish: true,
      subagent_workspace: "current",
      model_usage: "Independent reviewer; synthetic fixture providers.",
    },
    run: {
      run_id: "run-fixture",
      task_id: "task:fixture",
      workflow_id: "workflow:fixture",
      setup_revision: "setup:v1",
      expected_output: "Measured candidate implementation",
      max_iterations: 2,
      max_repair_attempts: 3,
      max_depth: 2,
      owner_limits: {
        revision: "limits:v1",
        max_bundled_positions_per_graph: 1,
        max_nodes: 4,
        max_edges: 4,
        max_fan_out_per_node: 2,
        max_unrolled_cycles: 1,
        max_jobs_per_candidate: 4,
        max_compute_per_candidate: { amount: 1, unit: "cpu_hours" },
      },
      resource_inventory: {
        inventory_id: "resources:fixture",
        platforms: [
          {
            platform_id: "cpu-fixture",
            access_ref: "local",
            accelerators: [],
            cpu: { cores: 1, memory_gb: 1 },
            capacity: { max_parallel_nodes: 1 },
            quota: { amount: 1, unit: "cpu_hours" },
            writable_paths: [{ path: root, capacity_bytes: 1000 }],
            network: { internet: false, allowed_endpoints: [] },
            max_wall_clock_ms: 1000,
            time_window: { start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
          },
        ],
      },
      baseline_scope: {
        baseline_id: "W_0",
        workflow_definition: { modules: [{ id: "main" }], edges: [] },
        code_baseline: { ref: "fixture:baseline" },
        position_artifacts: {
          main: { artifact_ref: "fixture:main", artifact_sha256: "a".repeat(64) },
        },
        initial_validation: {
          scorer_revision: "scorer:v1",
          input_snapshot_sha256: "b".repeat(64),
          judge_binding: { role: "fixed-judge", revision: "judge:v1" },
          metrics: { score: 0.4 },
        },
        optimizable_scope: [{ position_id: "main", mode: "independent" }],
      },
    },
  };
}

test("an empty project shows every module, absent choice options, text guidance and all gaps", () =>
  fixture((root) => {
    const review = refreshSetupReview(root);
    assert.deepEqual(
      review.modules.map((m) => m.id),
      ["project", "research", "metric", "baseline", "environment", "tester", "models", "run"],
    );
    const fields = review.modules.flatMap((m) => m.fields);
    assert.deepEqual(fields.find((f) => f.path === "tester.execution.kind")?.options, [
      "local",
      "ssh",
    ]);
    assert.deepEqual(fields.find((f) => f.path === "tester.metrics.0.aggregation")?.options, [
      "mean",
      "sum",
      "external",
    ]);
    assert.match(fields.find((f) => f.path === "research.problem")!.recommendation, /concrete gap/);
    assert.equal(fields.find((f) => f.path === "tester.dataset.expected_samples")!.value, null);
    for (const field of [
      "research.problem",
      "metric.name",
      "environment.prd",
      "tester",
      "run.max_iterations",
      "run.resource_inventory",
    ])
      assert.ok(
        review.issues.some((issue) => issue.field === field),
        field,
      );
    assert.equal(review.ready_to_confirm, false);
    assert.throws(
      () => confirmSetupReview(root, review.configuration_sha256),
      SetupReviewIncompleteError,
    );
    assert.throws(() => prepareSetupInputs(root), /CONFIRMATION_REQUIRED/);
    assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
    assert.equal(fs.existsSync(path.join(root, ".aris/tester-config.json")), false);
    assert.equal(fs.existsSync(path.join(root, ".aris/runs")), false);
  }));

test("discovery preserves current files, reference lists, model lifecycle and legacy work type", () =>
  fixture((root) => {
    const config = configuration(root);
    write(
      root,
      "CLAUDE.md",
      `# Project: Existing title\n\n## Pipeline Status\n\`\`\`yaml\nlanguage: en\n\`\`\`\n## Metric Target\nprimary: 0.8 score\ndirection: higher_better\ntolerance: 0.02\n## Reference Knowledge\n\`\`\`yaml\nskills: ["/research-lit"]\ndocuments: ["docs/known.md"]\nknowledge: ["Actual constraint"]\n\`\`\`\n## ARIS Paseo\n\`\`\`yaml\nexecutor_provider: claude/fixture # retain model\nreviewer_provider: codex/fixture\nnotify_on_finish: false\nheartbeat_cron: "*/13 * * * *"\n\`\`\`\n## Model Usage\nUse independent review.\n`,
    );
    write(
      root,
      "RESEARCH_BRIEF.md",
      "## Problem Statement\nKnown problem.\n## Baseline Reproduction (first experiment)\n**Method**: Known baseline\n**Code / run location**: baseline.py\n**Expected metric**: 0.4\n**Tolerance**: 0.02\n",
    );
    const legacy = {
      answers: { work_type: "Improvement on existing method", reference_documents: ["old.md"] },
    };
    write(root, ".aris/setup-state.json", legacy);
    write(
      root,
      `.aris/env-config/${projectSlug(root)}/prd.json`,
      (config.environment as JsonObject).prd,
    );
    write(root, path.relative(root, path.join(experimentSkillDir(root), "env.json")), {
      backend_hint: "local",
    });
    write(root, ".aris/tester-config.json", config.tester);
    write(root, ".aris/root-setup-answers.json", config.run);
    const review = refreshSetupReview(root),
      draft = read(review.draft_path).configuration;
    assert.equal(draft.project.name, "Existing title");
    assert.equal(draft.project.language, "en");
    assert.equal(draft.research.problem, "Known problem.");
    assert.equal(draft.research.work_type, "improve_existing");
    assert.deepEqual(draft.research.reference_documents, ["docs/known.md"]);
    assert.equal(draft.baseline.method, "Known baseline");
    assert.equal(draft.models.executor_provider, "claude/fixture");
    assert.equal(draft.models.notify_on_finish, false);
    assert.equal(draft.models.heartbeat_cron, "*/13 * * * *");
    assert.deepEqual(read(path.join(root, ".aris/setup-state.json")), legacy);
    assert.match(
      review.modules
        .find((m) => m.id === "environment")!
        .fields.find((f) => f.path === "environment.prd.version")!.source,
      /env-config/,
    );
  }));

test("grouped edits preserve unrelated fields, replace lists, clear values and report conflicts together", () =>
  fixture((root) => {
    refreshSetupReview(root, configuration(root));
    const review = refreshSetupReview(root, {
      project: { language: "en" },
      research: { reference_documents: ["new.md"] },
      metric: { target: 0.9, direction: "wrong" },
      tester: { dataset: { expected_samples: 4 } },
      baseline: { method: null },
    });
    const draft = read(review.draft_path).configuration;
    assert.equal(draft.project.name, "Fixture research");
    assert.equal(draft.project.language, "en");
    assert.deepEqual(draft.research.reference_documents, ["new.md"]);
    assert.equal(draft.tester.dataset.expected_samples, 4);
    assert.equal(draft.tester.dataset.revision, "fixed");
    assert.equal(draft.baseline.method, null);
    assert.ok(review.issues.some((i) => i.field === "baseline.method"));
    assert.ok(review.issues.some((i) => i.field === "metric.direction"));
    assert.equal(
      review.modules
        .find((m) => m.id === "project")!
        .fields.find((f) => f.path === "project.language")!.source,
      "draft / user edits",
    );
    assert.equal(review.modules.length, 8);
  }));

test("confirmed inputs preserve the reviewed PRD and assemble all root items without sealing", () =>
  fixture((root) => {
    const config = configuration(root),
      review = refreshSetupReview(root, config);
    assert.deepEqual(review.issues, []);
    assert.equal(review.ready_to_confirm, true);
    assert.throws(() => prepareSetupInputs(root), /CONFIRMATION_REQUIRED/);
    confirmSetupReview(root, review.configuration_sha256);
    const prepared = prepareSetupInputs(root);
    assert.deepEqual(read(prepared.inputs.environment), (config.environment as JsonObject).prd);
    assert.deepEqual(read(prepared.inputs.tester), config.tester);
    assert.equal(
      verifySetupInputs(root, prepared.inputs.configuration, prepared.inputs.environment).status,
      "confirmed",
    );
    const answers = read(prepared.inputs.root_answers);
    assert.equal(answers.mode, "auto_research_loop");
    assert.equal(answers.validation_thresholds.primary.name, "score");
    assert.equal(answers.tester_definition.tester_id, "tester:a2");
    assert.equal(Object.hasOwn(answers, "budget"), false);
    const assembled = assembleRootSetupInput({ project_root: root, answers });
    assert.deepEqual(assembled.from_answers.sort(), [
      "baseline",
      "limits",
      "resource",
      "tester",
      "tester_facility",
      "thresholds",
    ]);
    assert.equal(fs.existsSync(path.join(root, ".aris/runs/run-fixture/charter.json")), false);
    assert.equal(refreshSetupReview(root).confirmed, true);
  }));

test("direct draft edits invalidate confirmation before prepare and before worker consumption", () =>
  fixture((root) => {
    const review = refreshSetupReview(root, configuration(root));
    confirmSetupReview(root, review.configuration_sha256);
    const prepared = prepareSetupInputs(root),
      draft = read(setupDraftPath(root));
    draft.configuration.run.max_iterations = 3;
    write(root, ".aris/setup-draft.json", draft);
    assert.throws(() => prepareSetupInputs(root), /CONFIRMATION_REQUIRED/);
    assert.throws(
      () => verifySetupInputs(root, prepared.inputs.configuration, prepared.inputs.environment),
      /CONFIRMATION_REQUIRED/,
    );
    assert.throws(
      () => confirmSetupReview(root, review.configuration_sha256),
      /CONFIGURATION_CHANGED/,
    );
    const updated = refreshSetupReview(root);
    assert.equal(updated.confirmed, false);
    confirmSetupReview(root, updated.configuration_sha256);
    assert.throws(
      () => verifySetupInputs(root, prepared.inputs.configuration, prepared.inputs.environment),
      /CONFIGURATION_CHANGED/,
    );
    const newer = prepareSetupInputs(root);
    assert.equal(read(newer.inputs.root_answers).max_iterations, 3);
  }));

test("changed prepared inputs fail verification even when the draft itself is unchanged", () =>
  fixture((root) => {
    const review = refreshSetupReview(root, configuration(root));
    confirmSetupReview(root, review.configuration_sha256);
    const prepared = prepareSetupInputs(root),
      prd = read(prepared.inputs.environment);
    prd.resources.ids = [9];
    write(root, path.relative(root, prepared.inputs.environment), prd);
    assert.throws(
      () => verifySetupInputs(root, prepared.inputs.configuration, prepared.inputs.environment),
      /CONFIGURATION_CHANGED/,
    );
  }));

test("validation catches invalid PRD, unknown fields, metric mismatch and resource defects before confirmation", () =>
  fixture((root) => {
    const config = configuration(root),
      prd = (config.environment as JsonObject).prd as JsonObject;
    (prd.resources as JsonObject).ids = [];
    prd.project = "wrong-project";
    (config.metric as JsonObject).name = "not-declared";
    (config.run as JsonObject).max_iteratons = 5;
    (config.run as JsonObject).resource_inventory = { bad: "invalid" };
    const issues = validateSetupConfiguration(config, root);
    for (const field of [
      "environment.prd.resources.ids",
      "environment.prd.project",
      "tester",
      "run.max_iteratons",
      "run.resource_inventory",
      "environment.prd.feedback.result.primary_metric_key",
    ])
      assert.ok(
        issues.some((i) => i.field === field),
        field,
      );
  }));

test("simple baseline arguments are resolved on the full sheet before execution", () =>
  fixture((root) => {
    const config = configuration(root),
      prd = (config.environment as JsonObject).prd as JsonObject;
    prd.baseline = { kind: "simple", simple_args: null };
    const incomplete = refreshSetupReview(root, config);
    assert.equal(incomplete.ready_to_confirm, false);
    assert.ok(
      incomplete.issues.some((issue) => issue.field === "environment.prd.baseline.simple_args"),
    );
    assert.throws(
      () => confirmSetupReview(root, incomplete.configuration_sha256),
      SetupReviewIncompleteError,
    );
    assert.equal(fs.existsSync(path.join(root, ".aris/setup-inputs")), false);
    const complete = refreshSetupReview(root, {
      environment: { prd: { baseline: { simple_args: "--max-steps 100" } } },
    });
    assert.equal(complete.ready_to_confirm, true);
    confirmSetupReview(root, complete.configuration_sha256);
    const prepared = prepareSetupInputs(root);
    assert.equal(read(prepared.inputs.environment).baseline.simple_args, "--max-steps 100");
  }));

test("CLI review accepts incomplete drafts, then confirms/prepares only a complete current version", () =>
  fixture((root) => {
    const cli = (args: string[]) =>
      spawnSync("npx", ["tsx", "src/tools/project-setup-cli.ts", ...args, "--project", root], {
        cwd: packageRoot,
        encoding: "utf8",
      });
    const initial = cli(["review"]);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).ready_to_confirm, false);
    assert.equal(cli(["prepare"]).status, 1);
    write(root, "changes.json", configuration(root));
    const refreshed = cli(["refresh", "--input", path.join(root, "changes.json")]);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const review = JSON.parse(refreshed.stdout);
    assert.equal(review.ready_to_confirm, true, JSON.stringify(review.issues));
    assert.equal(cli(["confirm", "--digest", "wrong"]).status, 1);
    assert.equal(cli(["confirm", "--digest", review.configuration_sha256]).status, 0);
    const prepared = cli(["prepare"]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const paths = JSON.parse(prepared.stdout).inputs;
    assert.equal(
      cli(["verify", "--configuration", paths.configuration, "--environment", paths.environment])
        .status,
      0,
    );
  }));

test("Chinese briefs, YAML block/single-quoted lists and field sources survive discovery", () =>
  fixture((root) => {
    write(
      root,
      "CLAUDE.md",
      "# Project: 中文项目\n## Pipeline Status\nlanguage: zh\n## Compute Budget\n已有预算 20 CPU-hours\n## Reference Knowledge\n```yaml\nskills: ['/research-lit']\ndocuments:\n  - 'docs/known.md'\nknowledge: ['Keep # in text, including commas'] # real comment\n```\n",
    );
    write(
      root,
      "RESEARCH_BRIEF.md",
      "## 问题陈述\n提高准确率，保留现有部署。\n## 背景\n- **领域**: NLP\n- **子方向**: 分类\n- **已尝试的方法**: 原有分类器\n- **失败经验**: 小数据过拟合\n## 约束条件\n- **时间线**: 两周\n- **目标会议/期刊**: 内部报告\n## 期望方向\n- [x] 改进现有方法\n## 领域知识\n保留现有接口。\n## 非目标\n不更改数据来源。\n## 已有结果（如有）\n准确率为 0.7。\n",
    );
    const review = refreshSetupReview(root),
      draft = read(review.draft_path).configuration;
    assert.equal(draft.research.problem, "提高准确率，保留现有部署。");
    assert.equal(draft.research.work_type, "improve_existing");
    assert.equal(draft.research.field, "NLP");
    assert.equal(draft.research.timeline, "两周");
    assert.deepEqual(draft.research.reference_documents, ["docs/known.md"]);
    assert.deepEqual(draft.research.reference_knowledge, ["Keep # in text, including commas"]);
    const fields = review.modules.flatMap((m) => m.fields);
    assert.equal(
      fields.find((f) => f.path === "research.compute_budget")!.source,
      "CLAUDE.md ## Compute Budget",
    );
    assert.equal(
      fields.find((f) => f.path === "research.reference_documents")!.source,
      "CLAUDE.md ## Reference Knowledge",
    );
    assert.equal(
      fields.find((f) => f.path === "models.executor_mode")!.source,
      "proposed lifecycle preference",
    );
    const sheet = fs.readFileSync(review.review_path, "utf8");
    assert.ok(sheet.startsWith("# ARIS 配置总览\n"));
    assert.ok(sheet.includes("待填写"));
    const english = refreshSetupReview(root, { project: { language: "en" } });
    assert.ok(
      fs.readFileSync(english.review_path, "utf8").startsWith("# ARIS Configuration Review\n"),
    );
  }));

test("sealed setup conflicts are returned before a new confirmation or execution", () =>
  fixture((root) => {
    const review = refreshSetupReview(root, configuration(root));
    confirmSetupReview(root, review.configuration_sha256);
    const prepared = prepareSetupInputs(root);
    installedFacilityFixture(root);
    const assembled = assembleRootSetupInput({
      project_root: root,
      answers: read(prepared.inputs.root_answers),
    });
    setupRootRun(assembled.input);
    const scope = {
      project_root: root,
      run_id: "run-fixture",
      parent_run_id: null,
      scope_path: "/",
    };
    for (const token of readRunScopeLeaseTokens(scope))
      releaseRunScope({ ...scope, lease_token: token });
    const charter = path.join(root, ".aris/runs/run-fixture/charter.json"),
      bytes = fs.readFileSync(charter);
    assert.deepEqual(refreshSetupReview(root).issues, []);
    const changed = refreshSetupReview(root, {
      metric: { target: 0.9 },
      run: { max_iterations: 8 },
    });
    assert.ok(changed.issues.some((i) => i.field === "run.run_id" && i.message.includes("sealed")));
    assert.equal(changed.ready_to_confirm, false);
    assert.throws(
      () => confirmSetupReview(root, changed.configuration_sha256),
      SetupReviewIncompleteError,
    );
    const newId = refreshSetupReview(root, { run: { run_id: "run-new" } });
    assert.ok(newId.issues.some((i) => i.field === "run.setup_revision"));
    const fresh = refreshSetupReview(root, { run: { setup_revision: "setup:v2" } });
    assert.deepEqual(fresh.issues, []);
    assert.equal(fresh.ready_to_confirm, true);
    assert.deepEqual(fs.readFileSync(charter), bytes);
  }));
