/**
 * The one editable configuration sheet behind `/aris-setup worker|validation`.
 * refresh writes the draft and its review, confirm records the owner's approval
 * of one digest, and apply is the only step that changes the project.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  setupTesterFacility,
  testerFacilityConfigSha256,
  validateTesterFacilityConfig,
  type TesterFacilityConfig,
} from "./tester-facility.js";
import { failA1, isRecord, type JsonObject } from "./validate.js";
import {
  DEFAULT_LIMITS,
  ensureValidationToken,
  validateValidationConfig,
  validationConfigPath,
  type ValidationConfig,
} from "./validation/config.js";
import { countedSubmissions } from "./validation/store.js";

export type SetupRole = "worker" | "validation";
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
  options?: readonly unknown[];
  recommendation: string;
}
export interface SetupReview {
  role: SetupRole | null;
  language: "en" | "zh";
  draft_path: string;
  review_path: string;
  task: { path: string; sha256: string | null };
  configuration_sha256: string;
  ready_to_confirm: boolean;
  confirmed: boolean;
  modules: { id: string; title: string; fields: SetupReviewField[] }[];
  issues: SetupIssue[];
}
export class SetupReviewIncompleteError extends Error {
  readonly issues: SetupIssue[];
  constructor(issues: SetupIssue[]) {
    super("SETUP_CONFIGURATION_INCOMPLETE: edit the reported fields, then refresh");
    this.issues = issues;
  }
}

const TITLES: Record<string, string> = {
  project: "项目 / Project",
  environment: "执行环境 / Environment",
  connection: "验证服务连接 / Validation service",
  validation: "验证条款 / Validation terms",
};
const ROLE_MODULES: Record<SetupRole, readonly string[]> = {
  worker: ["project", "environment", "connection"],
  validation: ["project", "environment", "validation"],
};
const MODULE_FIELDS: Record<string, readonly string[]> = {
  project: ["role", "name", "language"],
  environment: ["prd"],
  connection: ["url", "token"],
  validation: [
    "metric",
    "benchmark",
    "adapter_contract",
    "limits",
    "leak_check",
    "agent",
    "service",
  ],
};
const CHOICES: Record<string, readonly unknown[]> = {
  "project.role": ["worker", "validation"],
  "project.language": ["zh", "en"],
  "environment.prd.preparation.files.location": ["local", "remote", "docker"],
  "environment.prd.preparation.files.transfer": ["rsync", "git", "shared"],
  "environment.prd.preparation.environment.type": ["conda", "venv", "docker", "system"],
  "environment.prd.browser.mode": ["extract", "session"],
  "environment.prd.browser.browser_type": ["chrome", "chrome-direct", "stealth"],
  "environment.prd.resources.type": ["gpu", "cpu", "node", "custom"],
  "environment.prd.resources.bind_mode": ["env", "prefix"],
  "environment.prd.resources.free_check.compare": ["lt", "gt", "eq"],
  "environment.prd.resources.free_check.index_by": ["physical", "positional"],
  "environment.prd.run.arg_style": ["cli", "config", "env"],
  "environment.prd.run.launch_mode": ["screen", "nohup", "scheduler", "foreground"],
  "environment.prd.feedback.error.signal": ["exit_code", "log_pattern", "both"],
  "environment.prd.feedback.result.format": ["json", "csv", "log", "wandb"],
  "environment.prd.baseline.kind": ["real", "simple"],
  "validation.benchmark.metrics.*.direction": ["higher_better", "lower_better"],
  "validation.benchmark.metrics.*.aggregation": ["mean", "sum", "external"],
  "validation.service.host": ["127.0.0.1", "0.0.0.0"],
};
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
const ADAPTER_CONTRACT =
  'The runner calls `python <ARIS_ADAPTER_DIR>/predict.py <inputs.jsonl> <predictions.jsonl>`. predict.py runs the deliverable in ARIS_ARTIFACT_REF as USAGE.md describes and writes one JSON line {"id", "prediction"} per input. The runner scores the predictions and writes ARIS_TEST_OUTPUT.';
const ROLE_BEGIN = "<!-- ARIS ROLE BEGIN -->";
const ROLE_END = "<!-- ARIS ROLE END -->";
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");

function get(object: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        isRecord(value) || Array.isArray(value) ? (value as JsonObject)[part] : undefined,
      object,
    );
}
/** Objects merge, arrays and scalars replace, null clears. */
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
function readJson(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  const value = readStateFile<unknown>(file);
  if (!isRecord(value)) failA1("INVALID_VALUE", `${file} must hold a JSON object`);
  return value;
}

export function projectSlug(projectRoot: string): string {
  return path
    .basename(path.resolve(projectRoot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}
/** Where /experiment-env-configuration writes the project's run scripts. */
export function experimentSkillDir(projectRoot: string): string {
  return path.join(projectRoot, ".claude", "skills", `run-${projectSlug(projectRoot)}-experiment`);
}
export const setupDraftPath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "setup-draft.json");
const statePath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "setup-state.json");
export const taskPath = (root: string): string => path.join(path.resolve(root), "task.md");

function taskSha256(root: string): string | null {
  const file = taskPath(root);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file);
  return text.toString("utf8").trim()
    ? crypto.createHash("sha256").update(text).digest("hex")
    : null;
}
function roleOf(configuration: JsonObject): SetupRole | null {
  const role = get(configuration, "project.role");
  return role === "worker" || role === "validation" ? role : null;
}

function moduleDefaults(root: string, module: string): JsonObject {
  if (module === "project")
    return { role: null, name: path.basename(path.resolve(root)), language: "zh" };
  if (module === "environment") return { prd: null };
  if (module === "connection") return { url: null, token: null };
  const installed = path.join(root, ".aris", "tester-config.json");
  const benchmark = fs.existsSync(installed)
    ? readJson(installed)
    : readJson(path.join(TEMPLATES, "TESTER_FACILITY_CONFIG_TEMPLATE.json"));
  return {
    metric: { name: null, target: null },
    benchmark,
    adapter_contract: ADAPTER_CONTRACT,
    limits: DEFAULT_LIMITS,
    leak_check: { hidden_paths: [], min_match_chars: 40 },
    agent: { provider: null, model: null, mode: null, thinking: null, paseo_command: ["paseo"] },
    service: { host: "127.0.0.1", port: null, public_url: null },
  };
}
/** A draft carries only the modules of its role; choosing a role fills in that role's modules. */
function completeModules(root: string, configuration: JsonObject): JsonObject {
  const role = roleOf(configuration);
  const modules = role ? ROLE_MODULES[role] : ["project"];
  const out: JsonObject = {};
  for (const module of modules)
    out[module] = merge(moduleDefaults(root, module), configuration[module] ?? {});
  return out;
}
function loadDraft(root: string): SetupDraft {
  const file = setupDraftPath(root);
  if (!fs.existsSync(file))
    return { schema_version: 1, project_root: root, configuration: completeModules(root, {}) };
  const draft = readStateFile<SetupDraft>(file);
  if (draft.schema_version !== 1 || draft.project_root !== root || !isRecord(draft.configuration))
    failA1("IDENTITY_MISMATCH", "setup draft must identify this project and schema");
  return draft;
}
/** The task text is part of what the owner approves, so editing task.md needs a new confirmation. */
function draftDigest(root: string, draft: SetupDraft): string {
  return canonicalJsonSha256({ draft: draft as unknown as JsonObject, task: taskSha256(root) });
}

function recommendation(key: string, value: unknown): string {
  const advice: Record<string, string> = {
    "project.role":
      "worker builds the deliverable; validation hosts the frozen benchmark and judges submissions.",
    "project.language": "zh for Chinese collaboration; en for English.",
    "environment.prd":
      "null when the agent manages its own environment; a PRD when /experiment-env-configuration should generate run scripts.",
    "connection.url": "The `url` printed by `/aris-setup validation` on the validation machine.",
    "connection.token":
      "The `token` printed by `/aris-setup validation`; .mcp.json will hold it, so keep that file out of git.",
    "validation.metric.name": "One of the benchmark's metric names.",
    "validation.metric.target":
      "The value that ends the task, in the metric's unit; the benchmark metric decides the direction.",
    "validation.adapter_contract":
      "Exactly how your runner calls ARIS_ADAPTER_DIR; a validation agent writes each submission's adapter to this contract.",
    "validation.leak_check.hidden_paths":
      "Absolute paths of the hidden samples, labels and references; feedback quoting them is held back.",
    "validation.agent.provider": "Provider for the per-submission validation agent, e.g. claude.",
    "validation.agent.paseo_command":
      'On Windows use ["node", "<install dir>\\\\bin\\\\paseo"]; the paseo.cmd shim cannot be spawned directly.',
    "validation.service.host":
      "127.0.0.1 behind the Paseo service proxy; 0.0.0.0 when the worker connects directly over a private network.",
    "validation.service.port":
      "null lets Paseo pick a port on every start; a direct connection needs a fixed one, e.g. 8765, open in the firewall.",
    "validation.service.public_url":
      "The address the worker machine reaches: the Paseo service proxy URL, or http://<this machine's address>:<port>.",
  };
  if (advice[key]) return advice[key];
  if (key.startsWith("validation.limits."))
    return "Keep the default unless the benchmark or upload size needs otherwise.";
  if (key.startsWith("validation.benchmark."))
    return "Pin the benchmark to exact revisions and Windows-runnable argv; it freezes once a submission is counted.";
  if (key.startsWith("environment.prd."))
    return "Describe the actual files, commands, logs and resources of this machine.";
  if (Array.isArray(value)) return "Edits replace the whole list; [] clears it.";
  return empty(value) ? "Supply the actual value." : "Keep this value unless it is wrong here.";
}
function rows(value: unknown, key: string): SetupReviewField[] {
  if (isRecord(value) && Object.keys(value).length)
    return Object.entries(value).flatMap(([k, v]) => rows(v, `${key}.${k}`));
  if (Array.isArray(value) && value.some(isRecord))
    return value.flatMap((v, i) => rows(v, `${key}.${i}`));
  const options =
    CHOICES[key.replace(/\.\d+(?=\.|$)/g, ".*")] ??
    (typeof value === "boolean" ? [true, false] : undefined);
  return [
    {
      path: key,
      value: value ?? null,
      ...(options ? { options } : {}),
      recommendation: recommendation(key, value),
    },
  ];
}

function validatePrd(prd: JsonObject, root: string, add: (f: string, m: string) => void): void {
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
    add("environment.prd", "the PRD must be version 1 with mode fresh");
  if (
    get(prd, "baseline.kind") === "simple" &&
    typeof get(prd, "baseline.simple_args") !== "string"
  )
    add("environment.prd.baseline.simple_args", "a simple baseline needs its reduced arguments");
  if (prd.project !== projectSlug(root))
    add("environment.prd.project", `must be the project slug ${projectSlug(root)}`);
  const ids = get(prd, "resources.ids");
  if (!Array.isArray(ids) || !ids.length)
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
    if (!empty(get(prd, key)) && (typeof get(prd, key) !== "number" || Number(get(prd, key)) <= 0))
      add(`environment.prd.${key}`, "must be a positive number");
  const freeCheck = get(prd, "resources.free_check");
  if (freeCheck !== null && freeCheck !== undefined) {
    if (!isRecord(freeCheck))
      add("environment.prd.resources.free_check", "must be null or a complete probe");
    else
      for (const key of ["cmd", "threshold", "unit", "compare", "index_by"])
        if (empty(freeCheck[key]))
          add(`environment.prd.resources.free_check.${key}`, "complete the probe or set null");
  }
  if (get(prd, "browser.required") === true) {
    for (const key of ["mode", "browser_type", "smoke_url"])
      if (empty(get(prd, `browser.${key}`)))
        add(`environment.prd.browser.${key}`, "browser use requires this value");
    if (get(prd, "browser.mode") === "session" && empty(get(prd, "browser.browser_id")))
      add("environment.prd.browser.browser_id", "session mode requires an existing browser ID");
  }
}

/** The validation config this draft would freeze; the benchmark digest is filled in by apply. */
function draftValidationConfig(
  validation: JsonObject,
  benchmark: TesterFacilityConfig,
): ValidationConfig {
  const metricName = get(validation, "metric.name");
  const declared = benchmark.metrics.find((metric) => metric.name === metricName);
  if (!declared)
    failA1(
      "INVALID_VALUE",
      `choose one of ${JSON.stringify(benchmark.metrics.map((metric) => metric.name))}`,
      "validation.metric.name",
    );
  const { metric: _metric, benchmark: _benchmark, ...rest } = validation;
  // The port belongs to the paseo.json service entry; Paseo hands it to the service as PASEO_PORT.
  const { port: _port, ...service } = isRecord(validation.service) ? validation.service : {};
  return validateValidationConfig({
    ...rest,
    service,
    schema_version: 1,
    metric: {
      name: declared.name,
      direction: declared.direction,
      target: get(validation, "metric.target"),
    },
    tester_config_sha256: testerFacilityConfigSha256(benchmark),
  });
}

export function validateSetupConfiguration(configuration: JsonObject, root: string): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const attempt = (field: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      add(field, (error as Error).message);
    }
  };
  const role = roleOf(configuration);
  if (!role) add("project.role", "choose worker or validation");
  const modules = role ? ROLE_MODULES[role] : ["project"];
  for (const key of Object.keys(configuration))
    if (!modules.includes(key)) add(key, `not a ${role ?? "setup"} module`);
  for (const module of modules) {
    const value = configuration[module];
    if (!isRecord(value)) {
      add(module, "module must be an object");
      continue;
    }
    for (const key of Object.keys(value))
      if (!MODULE_FIELDS[module]!.includes(key)) add(`${module}.${key}`, "unknown field");
    for (const row of rows(value, module)) {
      if (row.options && !empty(row.value) && !row.options.includes(row.value))
        add(row.path, `choose one of ${JSON.stringify(row.options)}`);
      if (
        typeof row.value === "string" &&
        /YOUR_|PINNED_COMMIT|PINNED_DATA_REVISION|\/absolute\/path/.test(row.value)
      )
        add(row.path, "replace the template placeholder");
    }
  }
  if (empty(get(configuration, "project.name"))) add("project.name", "required");
  if (!taskSha256(root)) add("task.md", "write the task in task.md at the project root");
  const prd = get(configuration, "environment.prd");
  if (isRecord(prd)) validatePrd(prd, root, add);
  else if (prd !== null && prd !== undefined)
    add("environment.prd", "must be null or an environment PRD object");

  if (role === "worker") {
    const url = get(configuration, "connection.url");
    if (typeof url !== "string" || !/^https?:\/\/[^/]+\/mcp$/.test(url))
      add("connection.url", "must be the validation service's http(s)://…/mcp URL");
    const token = get(configuration, "connection.token");
    if (typeof token !== "string" || token.length < 32)
      add("connection.token", "paste the token printed by the validation setup");
  }
  if (role === "validation" && isRecord(configuration.validation)) {
    const validation = configuration.validation;
    const port = get(validation, "service.port");
    if (
      port !== null &&
      port !== undefined &&
      !(Number.isInteger(port) && Number(port) > 0 && Number(port) < 65_536)
    )
      add("validation.service.port", "must be null or a TCP port number");
    let benchmark: TesterFacilityConfig | undefined;
    attempt("validation.benchmark", () => {
      benchmark = validateTesterFacilityConfig(validation.benchmark);
    });
    if (benchmark)
      attempt("validation", () => {
        const next = draftValidationConfig(validation, benchmark!);
        for (const hidden of next.leak_check.hidden_paths)
          if (!fs.existsSync(hidden))
            add("validation.leak_check.hidden_paths", `${hidden} is missing`);
        const frozenFile = validationConfigPath(root);
        if (fs.existsSync(frozenFile) && countedSubmissions(root) > 0) {
          const frozen = validateValidationConfig(readStateFile(frozenFile));
          if (
            frozen.tester_config_sha256 !== next.tester_config_sha256 ||
            canonicalJsonSha256(frozen.metric) !== canonicalJsonSha256(next.metric)
          )
            add(
              "validation",
              "submissions were already scored against the frozen benchmark and metric; start a new validation project to change them",
            );
        }
      });
  }
  return issues;
}

function markdown(review: SetupReview): string {
  const t = (en: string, zh: string) => (review.language === "en" ? en : zh);
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
  const lines = [
    t("# ARIS Configuration Review", "# ARIS 配置总览"),
    "",
    `${t("Role", "角色")}: ${review.role ?? t("unset", "待选择")}`,
    `${t("Configuration version", "配置版本")}: \`${review.configuration_sha256}\``,
    `${t("Editable draft", "可编辑草稿")}: \`${review.draft_path}\``,
    `${t("Task", "任务")}: \`${review.task.path}\` ${review.task.sha256 ? `(sha256 ${review.task.sha256.slice(0, 12)})` : t("(missing)", "（缺失）")}`,
    "",
    t(
      "Edit the draft or describe several changes at once, refresh, then confirm the whole sheet once.",
      "集中修改草稿或一次描述多项修改，刷新后整份确认一次。",
    ),
  ];
  for (const module of review.modules) {
    lines.push(
      "",
      `## ${module.title}`,
      "",
      t(
        "| Field | Current draft | Options | Recommendation |",
        "| 配置项 | 当前草稿 | 可选项 | 建议 |",
      ),
      "| --- | --- | --- | --- |",
    );
    for (const row of module.fields)
      lines.push(
        `| ${row.path} | ${row.value === null ? t("unset", "待填写") : cell(JSON.stringify(row.value))} | ${row.options ? cell(JSON.stringify(row.options)) : t("text/JSON", "文本/JSON")} | ${cell(row.recommendation)} |`,
      );
  }
  lines.push("", t("## Validation", "## 配置检查"), "");
  lines.push(
    ...(review.issues.length
      ? review.issues.map((issue) => `- ${issue.field}: ${issue.message}`)
      : [
          t(
            "- All fields pass; review the sheet, then confirm.",
            "- 全部字段通过检查；审阅后确认。",
          ),
        ]),
    "",
  );
  return lines.join("\n");
}

/** Refresh is the only draft writer; it never changes the project outside `.aris/`. */
export function refreshSetupReview(projectRoot: string, patch?: unknown): SetupReview {
  const root = path.resolve(projectRoot),
    stateFile = statePath(root);
  return withStateFileLock(stateFile, () => {
    const draft = loadDraft(root);
    if (patch !== undefined) {
      if (!isRecord(patch)) failA1("INVALID_VALUE", "configuration changes must be an object");
      draft.configuration = merge(draft.configuration, patch) as JsonObject;
    }
    draft.configuration = completeModules(root, draft.configuration);
    const digest = draftDigest(root, draft),
      previous = readJson(stateFile),
      issues = validateSetupConfiguration(draft.configuration, root),
      role = roleOf(draft.configuration),
      language = get(draft.configuration, "project.language") === "en" ? "en" : "zh";
    const review: SetupReview = {
      role,
      language,
      draft_path: setupDraftPath(root),
      review_path: path.join(root, ".aris", "setup-review.md"),
      task: { path: taskPath(root), sha256: taskSha256(root) },
      configuration_sha256: digest,
      ready_to_confirm: issues.length === 0,
      confirmed: previous.confirmed_sha256 === digest && issues.length === 0,
      modules: (role ? ROLE_MODULES[role] : ["project"]).map((id) => ({
        id,
        title: TITLES[id]!.split(" / ")[language === "en" ? 1 : 0]!,
        fields: rows(draft.configuration[id], id),
      })),
      issues,
    };
    writeStateJsonAtomic(review.draft_path, draft);
    fs.writeFileSync(review.review_path, markdown(review));
    writeStateJsonAtomic(stateFile, {
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
      digest = draftDigest(root, draft),
      state = readJson(stateFile);
    if (digest !== reviewedDigest || state.review_sha256 !== digest)
      failA1("SETUP_CONFIGURATION_CHANGED", "refresh and confirm the current configuration");
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
    digest = draftDigest(root, draft),
    state = readJson(statePath(root));
  if (state.confirmed_sha256 !== digest || state.review_sha256 !== digest)
    failA1(
      "SETUP_CONFIGURATION_CONFIRMATION_REQUIRED",
      "the owner must confirm the current refreshed configuration first",
    );
  const issues = validateSetupConfiguration(draft.configuration, root);
  if (issues.length) throw new SetupReviewIncompleteError(issues);
  return draft;
}

/** Replace only the marked block so the owner's own CLAUDE.md text survives re-runs. */
function writeRoleBlock(root: string, role: SetupRole): void {
  const file = path.join(root, "CLAUDE.md");
  const block = `${ROLE_BEGIN}\n${fs.readFileSync(path.join(TEMPLATES, `ROLE_${role.toUpperCase()}.md`), "utf8").trim()}\n${ROLE_END}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const start = current.indexOf(ROLE_BEGIN),
    end = current.indexOf(ROLE_END);
  const next =
    start >= 0 && end > start
      ? `${current.slice(0, start)}${block}${current.slice(end + ROLE_END.length)}`
      : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(file, next);
}
/** Add or replace one entry of a JSON object file without touching its other entries. */
function mergeJsonEntry(file: string, key: string, name: string, entry: JsonObject): void {
  const current = readJson(file);
  const section = isRecord(current[key]) ? current[key] : {};
  writeStateJsonAtomic(file, { ...current, [key]: { ...section, [name]: entry } });
}

export type SetupApplyResult =
  | { role: "worker"; mcp_config: string; environment_prd: boolean }
  | {
      role: "validation";
      validation_config: string;
      environment_prd: boolean;
      service_script: string;
      worker_connection: { url: string; token: string };
    };

/** Apply the confirmed sheet: role block, then the role's own wiring. */
export async function applySetup(projectRoot: string): Promise<SetupApplyResult> {
  const root = path.resolve(projectRoot),
    configuration = confirmedDraft(root).configuration,
    role = roleOf(configuration)!,
    environmentPrd = isRecord(get(configuration, "environment.prd"));
  if (environmentPrd)
    writeStateJsonAtomic(
      path.join(root, ".aris", "environment-prd.json"),
      get(configuration, "environment.prd"),
    );
  if (role === "worker") {
    const file = path.join(root, ".mcp.json");
    mergeJsonEntry(file, "mcpServers", "aris-validation", {
      type: "http",
      url: get(configuration, "connection.url"),
      headers: { Authorization: `Bearer ${String(get(configuration, "connection.token"))}` },
    });
    writeRoleBlock(root, role);
    return { role, mcp_config: file, environment_prd: environmentPrd };
  }
  const validation = configuration.validation as JsonObject;
  const benchmark = await setupTesterFacility(root, validation.benchmark);
  const config = draftValidationConfig(validation, benchmark);
  writeStateJsonAtomic(validationConfigPath(root), config);
  const token = ensureValidationToken(root);
  const port = get(validation, "service.port");
  mergeJsonEntry(path.join(root, "paseo.json"), "scripts", "aris-validation", {
    type: "service",
    command: "node .aris/dist/tools/validation-cli.js serve --project .",
    ...(typeof port === "number" ? { port } : {}),
  });
  writeRoleBlock(root, role);
  return {
    role,
    validation_config: validationConfigPath(root),
    environment_prd: environmentPrd,
    service_script: "aris-validation",
    worker_connection: { url: `${config.service.public_url}/mcp`, token },
  };
}
