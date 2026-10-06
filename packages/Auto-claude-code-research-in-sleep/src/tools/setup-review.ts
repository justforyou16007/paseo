/** The single editable configuration surface used by all setup entry names. */
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  detectSetupStages,
  experimentSkillDir,
  inferSetupItems,
  projectSlug,
} from "./project-setup.js";
import { readMetricConfig } from "./metric-gate.js";
import { createRootCharter, readRootCharter, type RootCharterInput } from "./root-charter.js";
import {
  createBaselineScope,
  validateBaselineScope,
  type BaselineScope,
} from "./baseline-scope.js";
import {
  createResourceInventory,
  validateResourceInventory,
  type ResourceInventory,
} from "./resource-inventory.js";
import { validateTesterFacilityConfig, testerFacilityConfigSha256 } from "./tester-facility.js";
import { testerMetricName } from "./tester-deliverables.js";
import {
  normalizeThresholds,
  normalizeOwnerLimitsForRoot,
  setupRevisionPath,
} from "./task-setup.js";
import { readStateFile, writeStateJsonAtomic, withStateFileLock } from "./state-file.js";
import { failA1, isRecord, type JsonObject } from "./workflow-spec.js";

export interface SetupDraft {
  schema_version: 1;
  project_root: string;
  configuration: JsonObject;
}
export interface SetupIssue {
  field: string;
  message: string;
}
export interface SetupReviewField {
  path: string;
  value: unknown;
  source: string;
  options?: readonly unknown[];
  recommendation: string;
}
export interface SetupReview {
  language: "en" | "zh";
  draft_path: string;
  review_path: string;
  configuration_sha256: string;
  ready_to_confirm: boolean;
  confirmed: boolean;
  modules: { id: string; title: string; fields: SetupReviewField[] }[];
  issues: SetupIssue[];
  stages: ReturnType<typeof detectSetupStages>["stages"];
}
export class SetupReviewIncompleteError extends Error {
  readonly issues: SetupIssue[];
  constructor(issues: SetupIssue[]) {
    super(
      "SETUP_CONFIGURATION_INCOMPLETE: edit all reported fields, then refresh the configuration",
    );
    this.issues = issues;
  }
}
export const SETUP_MODULES = [
  ["project", "项目基础 / Project"],
  ["research", "研究背景与目标 / Research"],
  ["metric", "评测目标 / Metric target"],
  ["baseline", "基线复现说明 / Baseline"],
  ["environment", "执行环境与监控 / Execution"],
  ["tester", "Benchmark 与 tester 设施 / Tester"],
  ["models", "模型与角色 / Models"],
  ["run", "运行限制、资源与交付 / Run"],
] as const;
const CHOICES: Record<string, readonly unknown[]> = {
  "project.language": ["zh", "en"],
  "research.work_type": ["new_direction", "improve_existing", "diagnostic"],
  "metric.direction": ["higher_better", "lower_better"],
  "environment.backend": ["local", "remote", "docker", "vast", "modal"],
  "environment.prd.preparation.files.location": ["local", "remote", "docker"],
  "environment.prd.preparation.files.transfer": ["rsync", "git", "shared"],
  "environment.prd.preparation.environment.type": ["conda", "venv", "docker", "system"],
  "environment.prd.browser.mode": ["extract", "session"],
  "environment.prd.browser.browser_type": ["chrome", "chrome-direct", "stealth"],
  "environment.prd.browser.required": [true, false],
  "environment.prd.resources.type": ["gpu", "cpu", "node", "custom"],
  "environment.prd.resources.bind_mode": ["env", "prefix"],
  "environment.prd.resources.free_check.compare": ["lt", "gt", "eq"],
  "environment.prd.resources.free_check.index_by": ["physical", "positional"],
  "environment.prd.run.arg_style": ["cli", "config", "env"],
  "environment.prd.run.launch_mode": ["screen", "nohup", "scheduler", "foreground"],
  "environment.prd.feedback.error.signal": ["exit_code", "log_pattern", "both"],
  "environment.prd.feedback.result.format": ["json", "csv", "log", "wandb"],
  "environment.prd.monitor.early_stop.enabled": [true, false],
  "environment.prd.baseline.kind": ["real", "simple"],
  "tester.execution.kind": ["local", "ssh"],
  "tester.metrics.*.direction": ["higher_better", "lower_better"],
  "tester.metrics.*.aggregation": ["mean", "sum", "external"],
  "models.executor_mode": ["bypassPermissions", "auto", "plan"],
  "models.reviewer_mode": ["full-access", "auto", "read-only"],
  "models.notify_on_finish": [true, false],
  "models.subagent_workspace": ["current", "worktree"],
  "run.baseline_scope.optimizable_scope.*.mode": ["independent", "bundled"],
};
const MODULE_FIELDS: Record<string, readonly string[]> = {
  project: ["name", "language", "constraints", "non_goals"],
  research: [
    "field",
    "sub_area",
    "problem",
    "work_type",
    "venue",
    "compute_budget",
    "timeline",
    "key_papers",
    "prior_attempts",
    "failures",
    "existing_results",
    "domain_knowledge",
    "reference_skills",
    "reference_documents",
    "reference_knowledge",
  ],
  metric: ["name", "target", "direction", "tolerance", "constraints"],
  baseline: ["method", "code_ref", "expected_metric", "tolerance"],
  environment: ["backend", "prd"],
  models: [
    "orchestrator_provider",
    "executor_provider",
    "executor_mode",
    "executor_thinking",
    "reviewer_provider",
    "reviewer_mode",
    "reviewer_thinking",
    "notify_on_finish",
    "subagent_workspace",
    "dispatch_heartbeat_cron",
    "dispatch_heartbeat_expires",
    "heartbeat_cron",
    "heartbeat_max_runs",
    "max_phase_idle",
    "model_usage",
  ],
  run: [
    "run_id",
    "task_id",
    "workflow_id",
    "setup_revision",
    "expected_output",
    "max_iterations",
    "max_repair_attempts",
    "max_depth",
    "owner_limits",
    "resource_inventory",
    "baseline_scope",
  ],
};
const REQUIRED = [
  "project.name",
  "project.language",
  "research.problem",
  "research.work_type",
  "metric.name",
  "metric.target",
  "metric.direction",
  "metric.tolerance",
  "baseline.method",
  "baseline.code_ref",
  "environment.backend",
  "environment.prd",
  "tester",
  "models.orchestrator_provider",
  "models.executor_provider",
  "models.reviewer_provider",
  "models.model_usage",
  "run.run_id",
  "run.task_id",
  "run.workflow_id",
  "run.setup_revision",
  "run.expected_output",
  "run.max_iterations",
  "run.max_repair_attempts",
  "run.max_depth",
  "run.owner_limits",
  "run.resource_inventory",
  "run.baseline_scope",
];
const PRD_REQUIRED = [
  "version",
  "mode",
  "project",
  "preparation.files.location",
  "preparation.files.excludes",
  "preparation.environment.type",
  "preparation.environment.activation",
  "preparation.environment.verify_cmd",
  "browser.required",
  "resources.type",
  "resources.ids",
  "resources.bind_mode",
  "run.entry_point",
  "run.arg_style",
  "run.launch_mode",
  "run.gpu_selection",
  "run.template",
  "feedback.error.signal",
  "feedback.error.log_path",
  "feedback.result.path_template",
  "feedback.result.format",
  "feedback.result.primary_metric_key",
  "monitor",
  "monitor.interval_cron",
  "monitor.escalate_cron",
  "monitor.max_hours",
  "monitor.early_stop.enabled",
  "monitor.stall.no_log_growth_minutes",
  "monitor.stall.consecutive_alert_ticks",
  "baseline.kind",
];

function get(object: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        isRecord(value) || Array.isArray(value) ? (value as JsonObject)[part] : undefined,
      object,
    );
}
function json(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  const value = readStateFile<unknown>(file);
  if (!isRecord(value)) failA1("INVALID_VALUE", `configuration at ${file} must be an object`);
  return value;
}
function text(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function section(content: string, heading: string | readonly string[]): string | null {
  if (typeof heading !== "string") {
    for (const candidate of heading) {
      const found = section(content, candidate);
      if (found) return found;
    }
    return null;
  }
  const lines = content.split("\n"),
    start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  const tail = lines.slice(start + 1),
    next = tail.findIndex((line) => /^## /.test(line));
  return (
    tail
      .slice(0, next < 0 ? undefined : next)
      .join("\n")
      .trim() || null
  );
}
function field(content: string, label: string | readonly string[]): string | null {
  if (typeof label !== "string") {
    for (const candidate of label) {
      const found = field(content, candidate);
      if (found) return found;
    }
    return null;
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`\\*\\*${escaped}\\*\\*\\s*[:：]\\s*(.+)`))?.[1]?.trim() ?? null;
}
/** Read the flat YAML sections generated by setup without interpreting arbitrary YAML. */
function flatYaml(content: string): JsonObject {
  const result: JsonObject = {};
  let listKey: string | undefined;
  const scalar = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      if (/^\[.*\]$/.test(raw)) {
        const inner = raw.slice(1, -1),
          parts: string[] = [];
        let quote = "",
          start = 0;
        for (let i = 0; i < inner.length; i++) {
          const char = inner[i];
          if ((char === '"' || char === "'") && inner[i - 1] !== "\\")
            quote = quote === char ? "" : quote || char;
          if (!quote && char === ",") {
            parts.push(inner.slice(start, i).trim());
            start = i + 1;
          }
        }
        parts.push(inner.slice(start).trim());
        return parts.filter(Boolean).map(scalar);
      }
      return raw.replace(/^['"]|['"]$/g, "");
    }
  };
  for (const line of content.split("\n")) {
    let quote = "",
      end = line.length;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if ((char === '"' || char === "'") && line[i - 1] !== "\\")
        quote = quote === char ? "" : quote || char;
      if (!quote && char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        end = i;
        break;
      }
    }
    const cleaned = line.slice(0, end).trimEnd(),
      match = cleaned.match(/^([a-z_]+):\s*(.*)$/);
    if (match) {
      listKey = match[2] ? undefined : match[1];
      result[match[1]] = listKey ? [] : scalar(match[2]);
    } else if (listKey && /^\s+-\s+/.test(cleaned)) {
      (result[listKey] as unknown[]).push(scalar(cleaned.replace(/^\s+-\s+/, "")));
    } else if (cleaned.trim()) listKey = undefined;
  }
  return result;
}
function workType(value: unknown, brief: string): unknown {
  if (typeof value === "string") {
    if (/new.*direction|from scratch|从零|新研究方向/i.test(value)) return "new_direction";
    if (/improv|改进现有/i.test(value)) return "improve_existing";
    if (/diagnos|analysis|诊断|分析型/i.test(value)) return "diagnostic";
    return value;
  }
  const chosen = brief.match(/^- \[[xX]\]\s*(.+)$/m)?.[1];
  return chosen ? workType(chosen, "") : null;
}
function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(out[key], value);
  return out;
}
function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (isRecord(value) && !Object.keys(value).length)
  );
}
export function setupDraftPath(root: string): string {
  return path.join(path.resolve(root), ".aris/setup-draft.json");
}
function statePath(root: string): string {
  return path.join(path.resolve(root), ".aris/global-setup-state.json");
}

function seed(root: string): { draft: SetupDraft; sources: Record<string, string> } {
  const claude = text(path.join(root, "CLAUDE.md")),
    brief = text(path.join(root, "RESEARCH_BRIEF.md"));
  const legacy = json(path.join(root, ".aris/setup-state.json"));
  const a = isRecord(legacy.answers) ? legacy.answers : {};
  const global = json(statePath(root));
  const rawAnswers = json(path.join(root, ".aris/root-setup-answers.json"));
  const answers = Object.keys(rawAnswers).length
    ? rawAnswers
    : isRecord(global.answers)
      ? global.answers
      : json(path.join(root, ".aris/root-setup-input.json"));
  const inference = inferSetupItems(root);
  const resource =
    answers.resource_inventory ?? answers.resource ?? inference.inferred.resource?.value ?? null;
  const baselineScope =
    answers.baseline_scope ?? answers.baseline ?? inference.inferred.baseline?.value ?? null;
  const env = json(path.join(experimentSkillDir(root), "env.json"));
  const prdFile = fs.existsSync(path.join(root, `.aris/env-config/${projectSlug(root)}/prd.json`))
    ? path.join(root, `.aris/env-config/${projectSlug(root)}/prd.json`)
    : path.join(root, ".aris/env-config/prd.json");
  const prd = json(prdFile);
  const metric = readMetricConfig(root);
  const baseline =
    section(brief, "Baseline Reproduction (first experiment)") ??
    section(brief, "Baseline Reproduction") ??
    "";
  const paseo = flatYaml(section(claude, "ARIS Paseo") ?? "");
  const lifecycle: JsonObject = {
    executor_mode: "auto",
    reviewer_mode: "auto",
    notify_on_finish: true,
    subagent_workspace: "current",
    dispatch_heartbeat_cron: "*/30 * * * *",
    dispatch_heartbeat_expires: "24h",
    heartbeat_cron: "off",
    max_phase_idle: 1800,
  };
  const references = flatYaml(section(claude, "Reference Knowledge") ?? "");
  const envPrd = Object.keys(prd).length
    ? prd
    : Object.fromEntries(
        Object.entries(env).filter(([key]) =>
          [
            "preparation",
            "browser",
            "resources",
            "run",
            "feedback",
            "monitor",
            "baseline",
          ].includes(key),
        ),
      );
  const proposed: JsonObject = {
    project: {
      name: claude.match(/^# Project:\s*(.+)$/m)?.[1] ?? a.project_name ?? projectSlug(root),
      language: claude.match(/^language:\s*(en|zh)\b/m)?.[1] ?? a.language ?? "zh",
      constraints: section(claude, "Project Constraints") ?? a.constraints ?? "",
      non_goals:
        section(claude, "Non-Goals") ??
        section(brief, ["Non-Goals", "非目标"]) ??
        a.non_goals ??
        "",
    },
    research: {
      field: field(brief, ["Field", "领域"]) ?? a.field ?? "",
      sub_area: field(brief, ["Sub-area", "子方向"]) ?? a.sub_area ?? "",
      problem:
        section(brief, ["Problem Statement", "问题陈述"]) ??
        a.problem_statement ??
        answers.problem ??
        "",
      work_type: workType(a.work_type, brief),
      venue: field(brief, ["Target venue", "目标会议/期刊"]) ?? a.target_venue ?? "",
      compute_budget:
        section(claude, "Compute Budget") ??
        field(brief, ["Compute", "算力"]) ??
        a.compute_budget ??
        "",
      timeline: field(brief, ["Timeline", "时间线"]) ?? a.timeline ?? "",
      key_papers: field(brief, ["Key papers I've read", "已读关键论文"]) ?? a.key_papers ?? [],
      prior_attempts:
        field(brief, ["What I already tried", "已尝试的方法"]) ?? a.prior_attempts ?? "",
      failures: field(brief, ["What didn't work", "失败经验"]) ?? a.failures ?? "",
      existing_results:
        section(brief, ["Existing Results (if any)", "已有结果（如有）"]) ??
        a.existing_results ??
        "",
      domain_knowledge:
        section(brief, ["Domain Knowledge", "领域知识"]) ?? a.domain_knowledge ?? "",
      reference_skills: references.skills ?? a.reference_skills ?? [],
      reference_documents: references.documents ?? a.reference_documents ?? [],
      reference_knowledge: references.knowledge ?? a.reference_knowledge ?? [],
    },
    metric: {
      name: metric.status === "ok" ? metric.config.name : (a.primary_metric ?? null),
      target: metric.status === "ok" ? metric.config.target : (a.metric_target ?? null),
      direction: metric.status === "ok" ? metric.config.direction : (a.metric_direction ?? null),
      tolerance: metric.status === "ok" ? metric.config.tolerance : 0.01,
      constraints: get(answers, "validation_thresholds.constraints") ?? [],
    },
    baseline: {
      method: field(baseline, "Method") ?? a.baseline_method ?? null,
      code_ref:
        field(baseline, "Code / run location") ?? get(baselineScope, "code_baseline.ref") ?? null,
      expected_metric: field(baseline, "Expected metric") ?? null,
      tolerance: field(baseline, "Tolerance") ?? null,
    },
    environment: {
      backend: env.backend_hint ?? get(envPrd, "preparation.files.location") ?? null,
      prd: Object.keys(envPrd).length
        ? { ...envPrd, version: 1, mode: "fresh", project: projectSlug(root) }
        : null,
    },
    tester: Object.keys(json(path.join(root, ".aris/tester-config.json"))).length
      ? json(path.join(root, ".aris/tester-config.json"))
      : null,
    models: {
      ...Object.fromEntries(
        MODULE_FIELDS.models
          .filter((key) => key !== "model_usage")
          .map((key) => [key, paseo[key] ?? a[key] ?? lifecycle[key] ?? null]),
      ),
      model_usage: section(claude, "Model Usage") ?? "",
    },
    run: {
      run_id: answers.run_id ?? global.run_id ?? null,
      task_id: answers.task_id ?? null,
      workflow_id: answers.workflow_id ?? null,
      setup_revision: answers.setup_revision ?? null,
      expected_output: answers.expected_output ?? null,
      max_iterations: answers.max_iterations ?? null,
      max_repair_attempts: answers.max_repair_attempts ?? 3,
      max_depth: answers.max_depth ?? 2,
      owner_limits: answers.owner_limits ?? answers.limits ?? null,
      resource_inventory: resource,
      baseline_scope: baselineScope,
    },
  };
  const sources: Record<string, string> = {
    project: fs.existsSync(path.join(root, "CLAUDE.md"))
      ? "CLAUDE.md / legacy setup answers"
      : "detected project directory; proposed preferences",
    research: brief ? "RESEARCH_BRIEF.md / legacy setup answers" : "legacy setup answers / unset",
    metric:
      metric.status === "ok"
        ? "CLAUDE.md ## Metric Target"
        : "legacy setup answers / proposed tolerance",
    baseline: baseline
      ? "RESEARCH_BRIEF.md ## Baseline Reproduction"
      : "root setup answers / unset",
    environment: Object.keys(prd).length
      ? path.relative(root, prdFile)
      : `${path.relative(root, experimentSkillDir(root))}/env.json`,
    tester: ".aris/tester-config.json",
    models: section(claude, "ARIS Paseo")
      ? "CLAUDE.md ## ARIS Paseo / Model Usage"
      : "proposed lifecycle preferences; provider/model usage unset",
    run: ".aris/root-setup-answers.json / prior setup / inferred items",
  };
  for (const key of MODULE_FIELDS.models.filter((key) => key !== "model_usage"))
    sources[`models.${key}`] =
      paseo[key] !== undefined
        ? "CLAUDE.md ## ARIS Paseo"
        : a[key] !== undefined
          ? "legacy setup answers"
          : lifecycle[key] !== undefined
            ? "proposed lifecycle preference"
            : "unset";
  const from = (key: string, candidates: readonly (readonly [unknown, string])[]) => {
    sources[key] =
      candidates.find(([value]) => value !== null && value !== undefined)?.[1] ?? "unset";
  };
  const legacySource = ".aris/setup-state.json answers";
  const answerSource = Object.keys(rawAnswers).length
    ? ".aris/root-setup-answers.json"
    : isRecord(global.answers)
      ? ".aris/global-setup-state.json legacy answers"
      : ".aris/root-setup-input.json";
  const briefFields: Record<string, readonly [readonly string[], string]> = {
    field: [["Field", "领域"], "field"],
    sub_area: [["Sub-area", "子方向"], "sub_area"],
    venue: [["Target venue", "目标会议/期刊"], "target_venue"],
    timeline: [["Timeline", "时间线"], "timeline"],
    key_papers: [["Key papers I've read", "已读关键论文"], "key_papers"],
    prior_attempts: [["What I already tried", "已尝试的方法"], "prior_attempts"],
    failures: [["What didn't work", "失败经验"], "failures"],
  };
  for (const [key, [labels, legacyKey]] of Object.entries(briefFields))
    from(`research.${key}`, [
      [field(brief, labels), "RESEARCH_BRIEF.md"],
      [a[legacyKey], legacySource],
    ]);
  for (const [key, headings] of Object.entries({
    problem: ["Problem Statement", "问题陈述"],
    existing_results: ["Existing Results (if any)", "已有结果（如有）"],
    domain_knowledge: ["Domain Knowledge", "领域知识"],
  }))
    from(`research.${key}`, [
      [section(brief, headings), "RESEARCH_BRIEF.md"],
      [a[key === "problem" ? "problem_statement" : key], legacySource],
      [key === "problem" ? answers.problem : null, answerSource],
    ]);
  from("research.compute_budget", [
    [section(claude, "Compute Budget"), "CLAUDE.md ## Compute Budget"],
    [field(brief, ["Compute", "算力"]), "RESEARCH_BRIEF.md constraints"],
    [a.compute_budget, legacySource],
  ]);
  for (const [key, referenceKey] of [
    ["reference_skills", "skills"],
    ["reference_documents", "documents"],
    ["reference_knowledge", "knowledge"],
  ])
    from(`research.${key}`, [
      [references[referenceKey], "CLAUDE.md ## Reference Knowledge"],
      [a[key], legacySource],
    ]);
  from("research.work_type", [
    [a.work_type, legacySource],
    [brief.match(/^- \[[xX]\]\s*(.+)$/m)?.[1], "RESEARCH_BRIEF.md work type"],
  ]);
  from("project.name", [
    [claude.match(/^# Project:\s*(.+)$/m)?.[1], "CLAUDE.md project title"],
    [a.project_name, legacySource],
    [projectSlug(root), "detected project directory"],
  ]);
  from("project.language", [
    [claude.match(/^language:\s*(en|zh)\b/m)?.[1], "CLAUDE.md language"],
    [a.language, legacySource],
    ["zh", "proposed collaboration language"],
  ]);
  from("project.constraints", [
    [section(claude, "Project Constraints"), "CLAUDE.md ## Project Constraints"],
    [a.constraints, legacySource],
  ]);
  from("project.non_goals", [
    [section(claude, "Non-Goals"), "CLAUDE.md ## Non-Goals"],
    [section(brief, ["Non-Goals", "非目标"]), "RESEARCH_BRIEF.md"],
    [a.non_goals, legacySource],
  ]);
  from("environment.backend", [
    [env.backend_hint, `${path.relative(root, experimentSkillDir(root))}/env.json backend_hint`],
    [
      get(envPrd, "preparation.files.location"),
      `${sources.environment} preparation.files.location`,
    ],
  ]);
  sources["environment.prd"] = sources.environment;
  sources["models.model_usage"] = section(claude, "Model Usage")
    ? "CLAUDE.md ## Model Usage"
    : "unset";
  for (const key of MODULE_FIELDS.run)
    sources[`run.${key}`] = !empty(get(proposed, `run.${key}`)) ? answerSource : "unset";
  if (answers.max_repair_attempts === undefined)
    sources["run.max_repair_attempts"] = "proposed repair limit";
  if (answers.max_depth === undefined) sources["run.max_depth"] = "proposed depth limit";
  if (answers.resource_inventory === undefined && answers.resource === undefined)
    sources["run.resource_inventory"] = inference.inferred.resource?.source ?? "unset";
  if (answers.baseline_scope === undefined && answers.baseline === undefined)
    sources["run.baseline_scope"] = inference.inferred.baseline?.source ?? "unset";
  return { draft: { schema_version: 1, project_root: root, configuration: proposed }, sources };
}

function recommendations(key: string, value: unknown): string {
  const advice: Record<string, string> = {
    "project.name":
      "Keep the existing project title; otherwise use a short descriptive project name.",
    "project.constraints": "List actual engineering, data, interface and operational constraints.",
    "project.non_goals":
      "State directions and changes the project should exclude; empty means none declared.",
    "research.field":
      "Name the research field, such as NLP, computer vision or reinforcement learning.",
    "research.sub_area": "Name the concrete task and family of methods being studied.",
    "research.venue": "Use the intended venue if known; leave empty when undecided.",
    "research.compute_budget":
      "Describe the actual available budget and its unit; do not substitute a default allocation.",
    "research.timeline":
      "Record the real milestone or deadline; leave empty if no schedule is set.",
    "research.prior_attempts": "Describe methods already tried and where their code/results live.",
    "research.failures":
      "Record negative results and likely causes so later iterations do not repeat them.",
    "research.existing_results":
      "Reference existing result tables/logs, with measured values and conditions.",
    "research.domain_knowledge":
      "Describe relevant assumptions, hypotheses and known domain constraints.",
    "metric.name": "Name a declared tester metric and use the same key in experiment feedback.",
    "metric.target": "Set the numeric closing target in the metric's native unit.",
    "models.notify_on_finish":
      "true is recommended so the parent receives terminal child notifications.",
    "models.subagent_workspace": "current is recommended for shared project and tester facilities.",
    "models.executor_mode":
      "auto is a proposed writable mode; plan cannot produce setup artifacts.",
    "models.reviewer_mode":
      "auto or full-access can write verdicts; read-only cannot complete the audit.",
    "models.dispatch_heartbeat_cron": "Keep a dispatch watchdog; a 30-minute interval is proposed.",
    "models.dispatch_heartbeat_expires":
      "24h is a proposed expiry; retain the current declared duration if suitable.",
    "models.max_phase_idle": "1800 seconds matches the proposed 30-minute watchdog window.",
    "models.heartbeat_cron":
      "off is proposed unless the project needs an overnight driver cadence.",
    "run.run_id": "Use a unique run ID; changed sealed setup requires a new run.",
    "run.task_id": "Use the project's concrete task identifier.",
    "run.workflow_id": "Use the concrete workflow identifier for this research run.",
    "run.setup_revision":
      "Name this setup revision explicitly; change it with a changed sealed protocol.",
    "run.expected_output":
      "Describe required implementation/deployment files, measured results and evidence.",
  };
  if (advice[key]) return advice[key];
  if (key === "project.language")
    return "zh for Chinese collaboration; en for English collaboration.";
  if (key === "research.work_type")
    return "improve_existing when a baseline exists; new_direction for a new question.";
  if (key === "research.problem")
    return "State the concrete gap, its significance and a measurable closing condition.";
  if (key === "metric.direction" || key.endsWith(".direction"))
    return "higher_better for accuracy/F1; lower_better for loss, latency or perplexity.";
  if (key === "metric.tolerance")
    return "0.01 is a proposed relative tolerance; use 0 for a strict target.";
  if (key === "environment.backend" || key === "tester.execution.kind")
    return "Reuse the current execution account; local for available local resources, remote/ssh for the existing server.";
  if (key.includes("aggregation"))
    return "mean for per-case means; sum for counts; external only with native scorer evidence.";
  if (key.includes("revision") || key.includes("benchmark.source"))
    return "Pin an exact source/data revision; keep the current revision if the protocol is unchanged.";
  if (key.includes("expected_samples"))
    return "Use the actual full evaluation count, including repeats; do not use the smoke count.";
  if (key.startsWith("models."))
    return "Use providers available in this project; use an independent reviewer family and describe model roles explicitly.";
  if (key === "run.max_iterations")
    return "10 is a suggested starting limit; set the desired number explicitly.";
  if (key.includes("resource_inventory"))
    return "Fill actual hardware, memory, quota, writable paths, endpoints and availability; do not treat suggested values as observed capacity.";
  if (key.includes("baseline_scope"))
    return "Describe the existing W_0 graph, artifact digests and positions that may be optimized.";
  if (key.includes("browser"))
    return "Keep browser use disabled unless the declared experiment needs web interactions.";
  if (key.startsWith("baseline."))
    return "Record the known baseline method/code and expected reading; setup describes it and iteration 1 reproduces it.";
  if (Array.isArray(value))
    return "Preserve the existing list; edits replace the whole list, and [] clears it.";
  if (key.endsWith(".timeout_ms"))
    return "Set a positive timeout in milliseconds covering this command; retain the declared timeout for the unchanged workload.";
  if (key.includes(".argv"))
    return "Use explicit executable/argument tokens under the declared execution account; prefer the existing reproducible command.";
  if (key.includes(".monitor."))
    return "Use concrete cadence, time and stopping criteria appropriate to the declared experiment duration.";
  if (key.includes(".preparation."))
    return "Describe the actual files, activation/build/verification commands and dependency environment on the declared backend.";
  if (key.includes(".feedback."))
    return "Name actual logs/result paths and keys emitted by the declared entry point.";
  if (key.startsWith("tester."))
    return "Pin this benchmark setting to the declared protocol and retain reproducible runner/data evidence.";
  const options = CHOICES[key.replace(/\.\d+(?=\.|$)/g, ".*")];
  if (options)
    return `Use ${JSON.stringify(empty(value) ? options[0] : value)} when appropriate for this project; alternatives are listed in Options.`;
  return empty(value)
    ? "Supply the actual value when this setting is used; otherwise explicitly leave optional text empty."
    : `Suggested starting value: ${JSON.stringify(value)}. Change it if the project's requirements differ.`;
}

function rows(value: unknown, key: string, source: string): SetupReviewField[] {
  if (isRecord(value) && Object.keys(value).length)
    return Object.entries(value).flatMap(([k, v]) => rows(v, `${key}.${k}`, source));
  if (Array.isArray(value) && value.some(isRecord))
    return value.flatMap((v, i) => rows(v, `${key}.${i}`, source));
  const options =
    CHOICES[key.replace(/\.\d+(?=\.|$)/g, ".*")] ??
    (typeof value === "boolean" ? [true, false] : undefined);
  return [
    {
      path: key,
      value: value ?? null,
      source,
      ...(options ? { options } : {}),
      recommendation: recommendations(key, value),
    },
  ];
}
/** Even an unconfigured module shows its choice fields and text recommendations. */
function reviewRows(configuration: JsonObject, module: string, source: string): SetupReviewField[] {
  const present = rows(configuration[module], module, source);
  const catalogue = [
    ...REQUIRED,
    ...Object.keys(CHOICES).map((key) => key.replace(/\.\*/g, ".0")),
    ...PRD_REQUIRED.map((key) => `environment.prd.${key}`),
    ...[
      "tester_id",
      "project_id",
      "version",
      "benchmark.name",
      "benchmark.source",
      "benchmark.revision",
      "dataset.name",
      "dataset.revision",
      "dataset.split",
      "dataset.expected_samples",
      "execution.cwd",
      "setup",
      "healthcheck",
      "smoke",
      "test",
      "evidence_files",
    ].map((key) => `tester.${key}`),
  ];
  for (const key of catalogue) {
    if (
      key.startsWith(`${module}.`) &&
      !present.some((row) => row.path === key || row.path.startsWith(`${key}.`))
    )
      present.push(...rows(get(configuration, key) ?? null, key, "unset / needs an edit"));
  }
  return present;
}

export function buildSetupRootAnswers(configuration: JsonObject): JsonObject {
  const run = isRecord(configuration.run) ? configuration.run : {};
  const metric = isRecord(configuration.metric) ? configuration.metric : {};
  const research = isRecord(configuration.research) ? configuration.research : {};
  const facility = isRecord(configuration.tester) ? configuration.tester : {};
  return {
    ...run,
    mode: "auto_research_loop",
    problem: research.problem,
    tester_definition: { tester_id: facility.tester_id, version: facility.version },
    tester_facility_config: facility,
    validation_thresholds: {
      primary: { name: metric.name, direction: metric.direction, target: metric.target },
      constraints: metric.constraints ?? [],
    },
  };
}

export function validateSetupConfiguration(
  configuration: JsonObject,
  projectRoot?: string,
): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  for (const [module] of SETUP_MODULES)
    if (!Object.hasOwn(configuration, module)) add(module, "module is missing");
    else if (configuration[module] !== null && !isRecord(configuration[module]))
      add(module, "module must be an object");
  for (const [module, allowed] of Object.entries(MODULE_FIELDS)) {
    const value = configuration[module];
    if (isRecord(value))
      for (const key of Object.keys(value))
        if (!allowed.includes(key)) add(`${module}.${key}`, "unknown configuration field");
  }
  for (const key of Object.keys(configuration))
    if (!SETUP_MODULES.some(([module]) => module === key)) add(key, "unknown configuration module");
  for (const key of REQUIRED)
    if (empty(get(configuration, key)))
      add(key, "required value is unset; edit the configuration sheet");
  for (const key of [
    "project.name",
    "project.language",
    "research.problem",
    "research.work_type",
    "metric.name",
    "metric.direction",
    "baseline.method",
    "baseline.code_ref",
    "environment.backend",
    "models.orchestrator_provider",
    "models.executor_provider",
    "models.reviewer_provider",
    "models.model_usage",
    "run.run_id",
    "run.task_id",
    "run.workflow_id",
    "run.setup_revision",
  ])
    if (!empty(get(configuration, key)) && typeof get(configuration, key) !== "string")
      add(key, "must be text");
  for (const key of [
    "metric.constraints",
    "research.reference_skills",
    "research.reference_documents",
    "research.reference_knowledge",
  ])
    if (get(configuration, key) !== undefined && !Array.isArray(get(configuration, key)))
      add(key, "must be a list; use [] to clear it");
  if (get(configuration, "models.executor_mode") === "plan")
    add("models.executor_mode", "setup requires a writable executor mode");
  if (get(configuration, "models.reviewer_mode") === "read-only")
    add("models.reviewer_mode", "the reviewer must be able to write its audit verdict");
  for (const [module] of SETUP_MODULES)
    for (const row of rows(configuration[module], module, "")) {
      if (row.options && !empty(row.value) && !row.options.includes(row.value))
        add(row.path, `choose one of ${JSON.stringify(row.options)}`);
      if (
        typeof row.value === "string" &&
        /YOUR_|PINNED_COMMIT|PINNED_DATA_REVISION|\/absolute\/path/.test(row.value)
      )
        add(row.path, "template placeholder must be replaced with the actual configuration");
    }
  for (const key of [
    "metric.target",
    "metric.tolerance",
    "run.max_iterations",
    "run.max_repair_attempts",
    "run.max_depth",
  ]) {
    const value = get(configuration, key);
    if (!empty(value) && (typeof value !== "number" || !Number.isFinite(value)))
      add(key, "must be a finite number");
  }
  for (const key of ["run.max_iterations", "run.max_repair_attempts", "run.max_depth"]) {
    const value = get(configuration, key),
      minimum = key === "run.max_iterations" ? 1 : 0;
    if (typeof value === "number" && (!Number.isInteger(value) || value < minimum))
      add(key, `must be an integer >= ${minimum}`);
  }
  const tolerance = get(configuration, "metric.tolerance");
  if (typeof tolerance === "number" && (tolerance < 0 || tolerance >= 1))
    add("metric.tolerance", "must be in [0, 1)");
  const attempt = (field: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      add(field, (error as Error).message);
    }
  };
  if (isRecord(configuration.tester))
    attempt("tester", () => {
      const facility = validateTesterFacilityConfig(configuration.tester);
      if (!empty(get(configuration, "metric.name")))
        testerMetricName(
          facility,
          String(get(configuration, "metric.name")),
          get(configuration, "metric.direction") as "higher_better" | "lower_better",
        );
    });
  const prd = get(configuration, "environment.prd");
  if (isRecord(prd)) {
    for (const key of PRD_REQUIRED)
      if (
        empty(get(prd, key)) &&
        !(key === "preparation.environment.activation" && get(prd, key) === "")
      )
        add(`environment.prd.${key}`, "required environment PRD value is missing");
    if (get(prd, "preparation.files.location") === "remote")
      for (const key of ["remote_path", "ssh_alias", "transfer"])
        if (empty(get(prd, `preparation.files.${key}`)))
          add(`environment.prd.preparation.files.${key}`, "remote execution requires this value");
    if (prd.version !== 1 || prd.mode !== "fresh")
      add("environment.prd", "unified setup requires version 1 and mode fresh");
    if (
      get(prd, "baseline.kind") === "simple" &&
      (empty(get(prd, "baseline.simple_args")) ||
        typeof get(prd, "baseline.simple_args") !== "string")
    )
      add(
        "environment.prd.baseline.simple_args",
        "simple baseline requires the reviewed reduced-scale entry-point arguments",
      );
    if (projectRoot && prd.project !== projectSlug(projectRoot))
      add(
        "environment.prd.project",
        `must match the discovered project slug ${projectSlug(projectRoot)}`,
      );
    if (
      !Array.isArray(get(prd, "resources.ids")) ||
      !(get(prd, "resources.ids") as unknown[]).length
    )
      add("environment.prd.resources.ids", "list the actual execution resources");
    for (const key of [
      "preparation.environment.activation",
      "preparation.environment.verify_cmd",
      "run.entry_point",
      "run.template",
      "feedback.error.log_path",
      "feedback.result.path_template",
      "feedback.result.primary_metric_key",
    ])
      if (!empty(get(prd, key)) && typeof get(prd, key) !== "string")
        add(`environment.prd.${key}`, "must be text");
    for (const key of [
      "monitor.max_hours",
      "monitor.stall.no_log_growth_minutes",
      "monitor.stall.consecutive_alert_ticks",
    ])
      if (
        !empty(get(prd, key)) &&
        (typeof get(prd, key) !== "number" || Number(get(prd, key)) <= 0)
      )
        add(`environment.prd.${key}`, "must be a positive number");
    const freeCheck = get(prd, "resources.free_check");
    if (freeCheck !== null && freeCheck !== undefined) {
      if (!isRecord(freeCheck))
        add("environment.prd.resources.free_check", "must be null or a complete probe object");
      else
        for (const key of ["cmd", "threshold", "unit", "compare", "index_by"])
          if (empty(freeCheck[key]))
            add(
              `environment.prd.resources.free_check.${key}`,
              "complete the probe or set free_check to null",
            );
    }
    if (get(prd, "browser.required") === true)
      for (const key of ["mode", "browser_type", "smoke_url"])
        if (empty(get(prd, `browser.${key}`)))
          add(`environment.prd.browser.${key}`, "browser use requires this value");
    if (
      get(prd, "browser.required") === true &&
      get(prd, "browser.mode") === "session" &&
      empty(get(prd, "browser.browser_id"))
    )
      add("environment.prd.browser.browser_id", "session mode requires an existing browser ID");
    const metricKey = get(prd, "feedback.result.primary_metric_key");
    if (
      !empty(metricKey) &&
      !empty(get(configuration, "metric.name")) &&
      metricKey !== get(configuration, "metric.name")
    )
      add("environment.prd.feedback.result.primary_metric_key", "must match metric.name");
  }
  const answers = buildSetupRootAnswers(configuration);
  if (!empty(answers.owner_limits))
    attempt("run.owner_limits", () => {
      normalizeOwnerLimitsForRoot(answers.owner_limits);
    });
  if (!empty(get(configuration, "metric.name")) && !empty(get(configuration, "metric.target")))
    attempt("metric", () => {
      normalizeThresholds(answers.validation_thresholds);
    });
  let resource: ResourceInventory | undefined, baseline: BaselineScope | undefined;
  const rawResource = get(configuration, "run.resource_inventory"),
    rawBaseline = get(configuration, "run.baseline_scope");
  if (!empty(rawResource))
    attempt("run.resource_inventory", () => {
      resource =
        isRecord(rawResource) && Object.hasOwn(rawResource, "inventory_sha256")
          ? validateResourceInventory(rawResource)
          : createResourceInventory(rawResource);
    });
  if (!empty(rawBaseline))
    attempt("run.baseline_scope", () => {
      if (!isRecord(rawBaseline)) failA1("INVALID_VALUE", "baseline_scope must be an object");
      baseline = Object.hasOwn(rawBaseline, "baseline_sha256")
        ? validateBaselineScope(rawBaseline)
        : createBaselineScope({ ...rawBaseline, owner_limits: answers.owner_limits });
    });
  if (resource && baseline && isRecord(answers.owner_limits))
    attempt("run", () => {
      if (
        baseline!.max_bundled_positions_per_graph !==
        (answers.owner_limits as JsonObject).max_bundled_positions_per_graph
      )
        failA1(
          "WORKFLOW_LIMITS_REQUIRED",
          "baseline_scope and owner_limits disagree on max_bundled_positions_per_graph",
        );
      const charter = createRootCharter({
        ...answers,
        resource_inventory: resource,
        baseline_scope: baseline,
      } as unknown as RootCharterInput);
      if (
        projectRoot &&
        fs.existsSync(path.join(projectRoot, ".aris/runs", charter.run_id, "charter.json"))
      ) {
        const sealed = readRootCharter(projectRoot, charter.run_id);
        const changed = [
          "task_id",
          "workflow_id",
          "setup_revision",
          "problem",
          "expected_output",
          "mode",
          "max_iterations",
          "max_repair_attempts",
          "max_depth",
          "owner_limits",
          "baseline_sha256",
          "resource_inventory_sha256",
        ].filter(
          (key) =>
            canonicalJsonSha256(get(sealed, key) ?? null) !==
            canonicalJsonSha256(get(charter, key) ?? null),
        );
        const refs = {
          tester_definition_sha256: canonicalJsonSha256(answers.tester_definition, undefined, {
            schemaVersion: "tester-definition-v1",
          }),
          tester_facility_sha256: testerFacilityConfigSha256(
            validateTesterFacilityConfig(answers.tester_facility_config),
          ),
          validation_thresholds_sha256: canonicalJsonSha256(
            normalizeThresholds(answers.validation_thresholds),
            undefined,
            { schemaVersion: "validation-thresholds-v1" },
          ),
          owner_limits_sha256: canonicalJsonSha256(
            normalizeOwnerLimitsForRoot(answers.owner_limits),
            undefined,
            { schemaVersion: "owner-limits-v1" },
          ),
        };
        for (const [key, value] of Object.entries(refs))
          if (get(sealed.setup_refs, key) !== value) changed.push(`setup_refs.${key}`);
        if (changed.length)
          add(
            "run.run_id",
            `run ${charter.run_id} is sealed; edits to ${changed.join(", ")} require a new run ID and setup revision before confirmation`,
          );
      } else if (
        projectRoot &&
        fs.existsSync(setupRevisionPath(projectRoot, charter.task_id, charter.setup_revision))
      ) {
        add(
          "run.setup_revision",
          "this task setup revision is already bound to another root charter; choose a new revision for the new run",
        );
      }
    });
  if (Object.hasOwn(answers, "budget") || Object.hasOwn(answers, "model_usage_policy"))
    add(
      "run",
      "loop budgets and structured model policy are not setup answers; put model usage prose in models.model_usage",
    );
  return issues;
}

function loadDraft(root: string): SetupDraft {
  const file = setupDraftPath(root),
    draft = fs.existsSync(file) ? readStateFile<SetupDraft>(file) : seed(root).draft;
  if (draft.schema_version !== 1 || draft.project_root !== root || !isRecord(draft.configuration))
    failA1("IDENTITY_MISMATCH", "setup draft must identify this project and schema");
  return draft;
}
function draftDigest(draft: SetupDraft): string {
  return canonicalJsonSha256(draft);
}
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
}
function show(value: unknown): string {
  return escapeCell(JSON.stringify(value));
}
function markdown(review: SetupReview): string {
  const t = (en: string, zh: string) => (review.language === "en" ? en : zh);
  const lines = [
    t("# ARIS Configuration Review", "# ARIS 配置总览"),
    "",
    `${t("Configuration version", "配置版本")}: \`${review.configuration_sha256}\``,
    "",
    `${t("Editable draft", "可编辑草稿")}: \`${review.draft_path}\``,
    "",
    t(
      "Edit the draft or describe changes together, then refresh. Confirm the complete refreshed configuration once. Suggestions do not replace missing observed resources or configuration.",
      "集中修改草稿或直接描述多项修改，然后刷新整份配置，最后确认一次。建议不会替代缺失的实际资源或配置。",
    ),
  ];
  for (const module of review.modules) {
    lines.push(
      "",
      `## ${module.title}`,
      "",
      t(
        "| Field | Current draft | Source | Options | Recommendation |",
        "| 配置项 | 当前草稿 | 来源 | 可选项 | 建议 |",
      ),
      "| --- | --- | --- | --- | --- |",
    );
    for (const row of module.fields)
      lines.push(
        `| ${row.path} | ${row.value === null ? t("unset", "待填写") : show(row.value)} | ${escapeCell(row.source)} | ${row.options ? show(row.options) : t("text/JSON", "文本/JSON")} | ${escapeCell(row.recommendation)} |`,
      );
  }
  lines.push("", t("## Validation", "## 配置检查"), "");
  lines.push(
    ...(review.issues.length
      ? review.issues.map((issue) => `- ${issue.field}: ${issue.message}`)
      : [
          t(
            "- Required configuration fields pass validation; review the complete sheet for final confirmation.",
            "- 全部配置字段通过检查；审阅整份配置后可以最终确认。",
          ),
        ]),
  );
  lines.push("", t("## Execution readiness", "## 执行就绪状态"), "");
  lines.push(
    ...review.stages.map(
      (stage) => `- ${stage.id}: ${stage.ready ? "ready" : `pending (${stage.reason})`}`,
    ),
  );
  lines.push(
    "",
    t(
      "Configuration confirmation precedes execution: project files, environment, facilities and root sealing follow it. Healthcheck and smoke must pass before runtime readiness; they do not constitute full evaluation or audit.",
      "配置确认与运行就绪是不同状态。确认后才生成项目文件、配置环境、安装设施并封存 root；healthcheck 和 smoke 通过不等于完整评测或审计通过。",
    ),
    "",
  );
  return lines.join("\n");
}

/** Refresh is the only draft writer; it never installs facilities or seals a run. */
export function refreshSetupReview(projectRoot: string, patch?: unknown): SetupReview {
  const root = path.resolve(projectRoot),
    stateFile = statePath(root);
  return withStateFileLock(stateFile, () => {
    const draft = loadDraft(root),
      initial = seed(root);
    if (patch !== undefined) {
      if (!isRecord(patch)) failA1("INVALID_VALUE", "configuration changes must be an object");
      if (Object.hasOwn(patch, "configuration") && !isRecord(patch.configuration))
        failA1("INVALID_VALUE", "configuration must be an object");
      if (
        Object.hasOwn(patch, "schema_version") &&
        (patch.schema_version !== 1 ||
          patch.project_root !== root ||
          !isRecord(patch.configuration))
      )
        failA1("IDENTITY_MISMATCH", "replacement draft belongs to another project");
      draft.configuration = merge(
        draft.configuration,
        Object.hasOwn(patch, "configuration") ? patch.configuration : patch,
      ) as JsonObject;
    }
    const digest = draftDigest(draft),
      previous = json(stateFile),
      issues = validateSetupConfiguration(draft.configuration, root),
      language = get(draft.configuration, "project.language") === "en" ? "en" : "zh";
    const sourceFor = (key: string): string | undefined => {
      const parts = key.split(".");
      while (parts.length) {
        const found = initial.sources[parts.join(".")];
        if (found) return found;
        parts.pop();
      }
      return undefined;
    };
    const modules = SETUP_MODULES.map(([id, title]) => ({
      id,
      title: title.split(" / ")[language === "en" ? 1 : 0],
      fields: reviewRows(draft.configuration, id, initial.sources[id]).map((row) => ({
        ...row,
        source:
          canonicalJsonSha256(row.value) ===
          canonicalJsonSha256(get(initial.draft.configuration, row.path) ?? null)
            ? (sourceFor(row.path) ?? row.source)
            : "draft / user edits",
      })),
    }));
    const review: SetupReview = {
      language,
      draft_path: setupDraftPath(root),
      review_path: path.join(root, ".aris/setup-review.md"),
      configuration_sha256: digest,
      ready_to_confirm: issues.length === 0,
      confirmed: previous.confirmed_sha256 === digest && issues.length === 0,
      modules,
      issues,
      stages: detectSetupStages({
        project_root: root,
        run_id:
          typeof get(draft.configuration, "run.run_id") === "string"
            ? String(get(draft.configuration, "run.run_id"))
            : null,
      }).stages,
    };
    writeStateJsonAtomic(review.draft_path, draft);
    fs.writeFileSync(review.review_path, markdown(review));
    writeStateJsonAtomic(stateFile, {
      ...previous,
      version: 2,
      run_id: get(draft.configuration, "run.run_id"),
      review_sha256: digest,
      confirmed_sha256: review.confirmed ? digest : null,
      status: review.confirmed ? "confirmed" : "review",
      issues,
    });
    return review;
  });
}

export function confirmSetupReview(
  projectRoot: string,
  reviewedDigest: string,
): { status: "confirmed"; configuration_sha256: string } {
  const root = path.resolve(projectRoot),
    stateFile = statePath(root);
  return withStateFileLock(stateFile, () => {
    const draft = loadDraft(root),
      digest = draftDigest(draft),
      state = json(stateFile);
    if (digest !== reviewedDigest || state.review_sha256 !== digest)
      failA1(
        "SETUP_CONFIGURATION_CHANGED",
        "refresh and confirm the current complete configuration",
      );
    const issues = validateSetupConfiguration(draft.configuration, root);
    if (issues.length) throw new SetupReviewIncompleteError(issues);
    writeStateJsonAtomic(stateFile, {
      ...state,
      status: "confirmed",
      confirmed_sha256: digest,
      confirmed_at: new Date().toISOString(),
    });
    return { status: "confirmed", configuration_sha256: digest };
  });
}

function confirmedDraft(root: string): SetupDraft {
  const draft = loadDraft(root),
    digest = draftDigest(draft),
    state = json(statePath(root));
  if (state.confirmed_sha256 !== digest || state.review_sha256 !== digest)
    failA1(
      "SETUP_CONFIGURATION_CONFIRMATION_REQUIRED",
      "the owner must confirm the current refreshed configuration before execution",
    );
  const issues = validateSetupConfiguration(draft.configuration, root);
  if (issues.length) throw new SetupReviewIncompleteError(issues);
  return draft;
}

/** Workers verify the prepared snapshots before consuming them; no interview or writes. */
export function verifySetupInputs(
  projectRoot: string,
  configurationFile: string,
  environmentFile: string,
): { status: "confirmed"; configuration_sha256: string } {
  const root = path.resolve(projectRoot),
    draft = confirmedDraft(root);
  if (
    canonicalJsonSha256(json(configurationFile)) !== draftDigest(draft) ||
    canonicalJsonSha256(json(environmentFile)) !==
      canonicalJsonSha256(get(draft.configuration, "environment.prd"))
  )
    failA1(
      "SETUP_CONFIGURATION_CHANGED",
      "execution inputs differ from the currently confirmed configuration; refresh the unified sheet",
    );
  return { status: "confirmed", configuration_sha256: draftDigest(draft) };
}

/** Produce declared inputs after confirmation; the established helpers own execution. */
export function prepareSetupInputs(projectRoot: string): {
  configuration_sha256: string;
  inputs: Record<string, string>;
} {
  const root = path.resolve(projectRoot),
    draft = confirmedDraft(root),
    digest = draftDigest(draft);
  const dir = path.join(root, ".aris/setup-inputs");
  const inputs = {
    configuration: path.join(dir, "configuration.json"),
    environment: path.join(dir, "environment-prd.json"),
    tester: path.join(dir, "tester-facility.json"),
    root_answers: path.join(root, ".aris/root-setup-answers.json"),
  };
  writeStateJsonAtomic(inputs.configuration, draft);
  writeStateJsonAtomic(inputs.environment, get(draft.configuration, "environment.prd"));
  writeStateJsonAtomic(inputs.tester, draft.configuration.tester);
  writeStateJsonAtomic(inputs.root_answers, buildSetupRootAnswers(draft.configuration));
  return { configuration_sha256: digest, inputs };
}
