/** Detect and assemble project basics, execution resources, reusable tester facilities and root setup. */
import fs from "node:fs";
import path from "node:path";

import { readMetricConfig } from "./metric-gate.js";
import { rootCharterPath } from "./root-charter.js";
import type { RootSetupInput, RootSetupItem } from "./task-setup.js";
import { SetupIncompleteError, collectMissingSetupItems } from "./task-setup.js";
import {
  validateTesterFacilityConfig,
  testerFacilityConfigSha256,
  assertTesterSetupReady,
} from "./tester-facility.js";
import { failA1, isRecord } from "./workflow-spec.js";

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

/**
 * The same slug `/auto-research-loop` step 0b computes from the project
 * directory name. It has to match character for character, or this reports a
 * configured environment as missing (or the reverse).
 */
export function projectSlug(projectRoot: string): string {
  return path
    .basename(path.resolve(projectRoot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}

export function experimentSkillDir(projectRoot: string): string {
  return path.join(projectRoot, ".claude", "skills", `run-${projectSlug(projectRoot)}-experiment`);
}

/** Canonical configuration written by tester-facility setup. */
export function testerConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".aris", "tester-config.json");
}

export function globalSetupStatePath(projectRoot: string): string {
  return path.join(projectRoot, ".aris", "global-setup-state.json");
}

// ---------------------------------------------------------------------------
// Stage detection
// ---------------------------------------------------------------------------

export const SETUP_STAGES = [
  "project_basics",
  "metric_target",
  "experiment_env",
  "tester_facility",
  "root_charter",
] as const;

export type SetupStageId = (typeof SETUP_STAGES)[number];

export interface SetupStage {
  id: SetupStageId;
  ready: boolean;
  /** Files or facts that made it ready. Empty while it is not. */
  evidence: string[];
  /** Why it is not ready, in one sentence. Absent once it is. */
  reason?: string;
  /** The command or skill that makes it ready. Absent once it is. */
  next?: string;
  /** Stages that have to be ready first; running `next` before them fails. */
  blocked_by?: SetupStageId[];
  /** `root_charter` only: the root setup items still without a value. */
  missing_items?: RootSetupItem[];
  /** Counts and digests. Never a blocked term. */
  detail?: Record<string, unknown>;
}

export interface SetupStatus {
  project_root: string;
  project_name: string;
  run_id: string | null;
  stages: SetupStage[];
  blocking: SetupStageId[];
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function isNonEmptyDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory() && fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function detectProjectBasics(root: string): SetupStage {
  const wanted = ["CLAUDE.md", "RESEARCH_BRIEF.md"];
  const missing = wanted.filter((name) => !fs.existsSync(path.join(root, name)));
  const wikiReady = isNonEmptyDir(path.join(root, "research-wiki"));
  if (missing.length === 0 && wikiReady) {
    return { id: "project_basics", ready: true, evidence: [...wanted, "research-wiki/"] };
  }
  const absent = [...missing, ...(wikiReady ? [] : ["research-wiki/"])];
  return {
    id: "project_basics",
    ready: false,
    evidence: [],
    reason: `missing: ${absent.join(", ")}`,
    next: "/research-setup",
  };
}

function detectMetricTarget(root: string): SetupStage {
  const read = readMetricConfig(root);
  if (read.status === "ok") {
    return {
      id: "metric_target",
      ready: true,
      evidence: ["CLAUDE.md ## Metric Target"],
      detail: {
        name: read.config.name,
        target: read.config.target,
        direction: read.config.direction,
      },
    };
  }
  return {
    id: "metric_target",
    ready: false,
    evidence: [],
    reason: read.reason,
    next: "fill '## Metric Target' in CLAUDE.md (templates/CLAUDE_MD_TEMPLATE.md has the block)",
    blocked_by: read.status === "missing_file" ? ["project_basics"] : undefined,
  };
}

/**
 * The same two conditions step 0b checks, for the same reason: a `complete`
 * env.json without a `scripts/` directory is a configuration that claims to be
 * finished and cannot run anything.
 */
function detectExperimentEnv(root: string): SetupStage {
  const skillDir = experimentSkillDir(root);
  const envPath = path.join(skillDir, "env.json");
  const env = readJsonFile(envPath);
  const scriptsReady = fs.existsSync(path.join(skillDir, "scripts"));
  const statusComplete = isRecord(env) && env.status === "complete";
  if (statusComplete && scriptsReady) {
    return {
      id: "experiment_env",
      ready: true,
      evidence: [path.relative(root, envPath), path.relative(root, path.join(skillDir, "scripts"))],
    };
  }
  const reason =
    env === undefined
      ? `no env.json at ${path.relative(root, envPath)}`
      : !statusComplete
        ? "env.json status is not 'complete'"
        : "env.json is complete but the scripts/ directory is missing";
  return {
    id: "experiment_env",
    ready: false,
    evidence: [],
    reason,
    next: "/experiment-env-manager — mode: setup",
    blocked_by: ["project_basics"],
  };
}

function detectTesterFacility(root: string): SetupStage {
  const configPath = testerConfigPath(root);
  const raw = readJsonFile(configPath);
  if (raw === undefined) {
    return {
      id: "tester_facility",
      ready: false,
      evidence: [],
      reason: `no tester facility config at ${path.relative(root, configPath)}`,
      next: "/aris-setup Phase 3: /tester-setup",
    };
  }
  try {
    const config = validateTesterFacilityConfig(raw);
    assertTesterSetupReady(configPath);
    return {
      id: "tester_facility",
      ready: true,
      evidence: [path.relative(root, configPath)],
      detail: {
        tester_id: config.tester_id,
        project_id: config.project_id,
        benchmark: config.benchmark.name,
        config_sha256: testerFacilityConfigSha256(config),
      },
    };
  } catch (error) {
    return {
      id: "tester_facility",
      ready: false,
      evidence: [],
      reason: `tester facility config is invalid: ${(error as Error).message}`,
      next: "re-run tester-facility-cli.js setup",
    };
  }
}

/**
 * `rootCharterPath` refuses to build a path when the run has no `run.json`,
 * which is exactly the state this stage is reporting on: `setupRootRun` writes
 * the run contract and the charter together, so "no run contract" and "no
 * charter" are two views of the same unfinished setup. The refusal is caught
 * and turned into a reason rather than allowed to abort the whole report.
 */
function detectRootCharter(
  root: string,
  runId: string | null,
  missingItems: RootSetupItem[],
): SetupStage {
  let reason: string;
  if (runId === null) {
    reason = "no run id given, so no charter to look for";
  } else {
    try {
      const charterPath = rootCharterPath(root, runId);
      if (fs.existsSync(charterPath)) {
        return {
          id: "root_charter",
          ready: true,
          evidence: [path.relative(root, charterPath)],
        };
      }
      reason = `run ${runId} exists but has no charter.json`;
    } catch (error) {
      reason = `run ${runId} has no run contract yet: ${(error as Error).message}`;
    }
  }
  return {
    id: "root_charter",
    ready: false,
    evidence: [],
    reason,
    next: "project-setup-cli.js assemble … then workflow-tools-cli.js root-setup --project <root> --input <path>",
    blocked_by: ["tester_facility", "experiment_env"],
    missing_items: missingItems,
  };
}

export interface DetectOptions {
  project_root: string;
  run_id?: string | null;
}

export function detectSetupStages(options: DetectOptions): SetupStatus {
  const root = path.resolve(options.project_root);
  const runId = options.run_id ?? null;

  // What the charter would still be missing if it were assembled right now,
  // from what is already on disk. The owner-answered items always show up here
  // until `assemble` runs, which is the point: they are what Phase 4 asks for.
  const inference = inferSetupItems(root);
  const onDisk: Record<string, unknown> = {};
  for (const [item, value] of Object.entries(inference.inferred)) {
    onDisk[item] = value.value;
  }
  const missingItems = collectMissingSetupItems(onDisk);

  const stages: SetupStage[] = [
    detectProjectBasics(root),
    detectMetricTarget(root),
    detectExperimentEnv(root),
    detectTesterFacility(root),
    detectRootCharter(root, runId, missingItems),
  ];

  return {
    project_root: root,
    project_name: projectSlug(root),
    run_id: runId,
    stages,
    blocking: stages.filter((stage) => !stage.ready).map((stage) => stage.id),
  };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export interface InferredValue {
  value: unknown;
  /** File and field the value was read from. Printed next to the value. */
  source: string;
}

export interface OwnerQuestion {
  item: RootSetupItem;
  /** Dotted path inside that item, e.g. `platforms[0].accelerators[0].model`. */
  field: string;
  /** Why no file answers it. */
  why: string;
}

export interface SetupInference {
  inferred: Partial<Record<RootSetupItem, InferredValue>>;
  needs_owner: OwnerQuestion[];
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** `**Method**: value` from the brief's Baseline Reproduction section. */
function briefField(section: string, label: string): string | null {
  const match = section.match(new RegExp(`\\*\\*${label}\\*\\*\\s*:\\s*(.+)`));
  if (match === null) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function inferThresholds(root: string, out: SetupInference): void {
  const read = readMetricConfig(root);
  if (read.status !== "ok") {
    out.needs_owner.push({
      item: "thresholds",
      field: "primary",
      why: `CLAUDE.md '## Metric Target' is unusable: ${read.reason}`,
    });
    return;
  }
  // The two vocabularies already agree: `direction` is the same enum on both
  // sides, so this is a rename, not a translation.
  out.inferred.thresholds = {
    value: {
      primary: {
        name: read.config.name ?? "metric",
        direction: read.config.direction,
        target: read.config.target,
      },
      constraints: [],
    },
    source: "CLAUDE.md '## Metric Target' (primary, direction)",
  };
  out.needs_owner.push({
    item: "thresholds",
    field: "constraints",
    why: "CLAUDE.md carries one target and no hard constraints; the inferred value is an empty list",
  });
}

/**
 * env.json describes how to reach the machine and start a job. It does not
 * describe the hardware: there is no accelerator model, no memory size, no
 * quota, no wall-clock ceiling and no endpoint list anywhere in the v2 schema.
 * Those five are asked, not guessed -- they are what `classifyResourceRequest`
 * later uses to tell "the plan asked for something outside the frozen
 * inventory" (a research negative) from "the machine was unreachable" (an
 * infrastructure fault), and a fabricated inventory makes that call wrong in a
 * way nothing downstream can detect.
 */
function inferResource(root: string, out: SetupInference): void {
  const envPath = path.join(experimentSkillDir(root), "env.json");
  const env = readJsonFile(envPath);
  const relEnv = path.relative(root, envPath);
  if (!isRecord(env)) {
    out.needs_owner.push({
      item: "resource",
      field: "platforms",
      why: `no readable ${relEnv}; run /experiment-env-manager first`,
    });
    return;
  }
  const preparation = isRecord(env.preparation) ? env.preparation : {};
  const files = isRecord(preparation.files) ? preparation.files : {};
  const resources = isRecord(env.resources) ? env.resources : {};
  const backend = typeof env.backend_hint === "string" ? env.backend_hint : "local";
  const sshAlias = typeof files.ssh_alias === "string" ? files.ssh_alias : "local";
  const remotePath = typeof files.remote_path === "string" ? files.remote_path : null;
  const ids = Array.isArray(resources.ids) ? resources.ids : [];

  const platform: Record<string, unknown> = {
    platform_id: `platform:${backend}`,
    access_ref: sshAlias,
    accelerators: [{ count: ids.length }],
    writable_paths: remotePath === null ? [] : [{ path: remotePath }],
  };
  out.inferred.resource = {
    value: { inventory_id: `inventory:${projectSlug(root)}`, platforms: [platform] },
    source: `${relEnv} (backend_hint, preparation.files.ssh_alias, preparation.files.remote_path, resources.ids)`,
  };
  for (const [field, why] of [
    ["platforms[0].accelerators[0].model", "env.json records device ids, not the device model"],
    ["platforms[0].accelerators[0].memory_gb", "env.json has no accelerator memory size"],
    ["platforms[0].cpu", "env.json has no cpu core or memory figures"],
    ["platforms[0].capacity.max_parallel_nodes", "env.json has no parallelism ceiling"],
    ["platforms[0].quota", "env.json has no quota; this is a billing fact, not a runtime one"],
    ["platforms[0].writable_paths[0].capacity_bytes", "env.json has the path but not its size"],
    ["platforms[0].network.allowed_endpoints", "env.json has no egress list"],
    ["platforms[0].max_wall_clock_ms", "env.json has no wall-clock ceiling"],
    ["platforms[0].time_window", "env.json has no availability window"],
  ] as const) {
    out.needs_owner.push({ item: "resource", field, why });
  }
}

function inferBaseline(root: string, out: SetupInference): void {
  const briefPath = path.join(root, "RESEARCH_BRIEF.md");
  const brief = readTextFile(briefPath);
  const heading = "## Baseline Reproduction";
  const start = brief === null ? -1 : brief.indexOf(heading);
  if (brief === null || start === -1) {
    out.needs_owner.push({
      item: "baseline",
      field: "baseline_id, code_baseline.ref",
      why: "RESEARCH_BRIEF.md has no '## Baseline Reproduction' section (a from-scratch project has none)",
    });
  } else {
    const rest = brief.slice(start + heading.length);
    const nextHeading = rest.search(/\n## /);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    const location = briefField(section, "Code / run location");
    out.inferred.baseline = {
      value: {
        baseline_id: "W_0",
        code_baseline: { ref: location ?? "HEAD" },
      },
      source: `RESEARCH_BRIEF.md '## Baseline Reproduction' (Code / run location${location === null ? " absent, defaulted to HEAD" : ""})`,
    };
  }
  for (const [field, why] of [
    [
      "workflow_definition",
      "the brief describes the baseline in prose; the module/edge graph is not written anywhere",
    ],
    ["position_artifacts", "no file records which artifact sits at each optimizable position"],
    [
      "initial_validation",
      "the baseline has not been scored yet, so there is no scorer revision or metric to copy",
    ],
    [
      "optimizable_scope",
      "which positions may be changed is an owner decision, not a fact on disk",
    ],
  ] as const) {
    out.needs_owner.push({ item: "baseline", field, why });
  }
}

function inferTesterItems(root: string, out: SetupInference): void {
  const configPath = testerConfigPath(root);
  const raw = readJsonFile(configPath);
  if (raw === undefined) {
    out.needs_owner.push({
      item: "tester_facility",
      field: "(whole item)",
      why: `no ${path.relative(root, configPath)}; it is produced by tester-facility-cli.js setup, not by hand`,
    });
    out.needs_owner.push({
      item: "tester",
      field: "tester_id, version",
      why: "the tester definition names the configured tester, which does not exist yet",
    });
    return;
  }
  try {
    const config = validateTesterFacilityConfig(raw);
    assertTesterSetupReady(configPath);
    out.inferred.tester_facility = {
      value: config,
      source: path.relative(root, configPath),
    };
    out.inferred.tester = {
      value: {
        tester_id: config.tester_id,
        version: config.version,
      },
      source: `${path.relative(root, configPath)} (tester_id, version)`,
    };
  } catch (error) {
    out.needs_owner.push({
      item: "tester_facility",
      field: "(whole item)",
      why: `${path.relative(root, configPath)} is invalid: ${(error as Error).message}`,
    });
    out.needs_owner.push({
      item: "tester",
      field: "tester_id, version",
      why: "the tester facility config it would be read from is invalid",
    });
  }
}

/**
 * `testTrial` and `limits` have no source at all. They are printed with a
 * conservative default and an explicit "no source" so the owner is confirming a
 * number rather than accepting one that looks derived.
 */
function inferOwnerOnlyItems(out: SetupInference): void {}

export function inferSetupItems(projectRoot: string): SetupInference {
  const root = path.resolve(projectRoot);
  const out: SetupInference = { inferred: {}, needs_owner: [] };
  inferTesterItems(root, out);
  inferThresholds(root, out);
  inferResource(root, out);
  inferBaseline(root, out);
  inferOwnerOnlyItems(out);
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Plain objects merge key by key; everything else (arrays, scalars, null)
 * replaces. An answer that supplies `platforms` replaces the whole inferred
 * platform list rather than merging element by element, because a half-merged
 * platform is harder to reason about than a rewritten one.
 */
function mergeValue(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeValue(merged[key], value) : value;
  }
  return merged;
}

/** The keys `collectMissingSetupItems` accepts for each item, canonical first. */
const ITEM_FIELD: Record<RootSetupItem, string> = {
  tester: "tester_definition",
  tester_facility: "tester_facility_config",
  thresholds: "validation_thresholds",
  limits: "owner_limits",
  resource: "resource_inventory",
  baseline: "baseline_scope",
};

/** Both spellings of each item, so an answers file may use either. */
const ITEM_ALIASES: Record<RootSetupItem, readonly string[]> = {
  tester: ["tester_definition", "tester"],
  tester_facility: ["tester_facility_config", "tester_facility"],
  thresholds: ["validation_thresholds", "thresholds"],
  limits: ["owner_limits", "limits"],
  resource: ["resource_inventory", "resource"],
  baseline: ["baseline_scope", "baseline"],
};

const REQUIRED_ANSWER_FIELDS = [
  "run_id",
  "task_id",
  "workflow_id",
  "setup_revision",
  "problem",
  "expected_output",
] as const;

/**
 * Auto Research Loop fields have no file to infer them from, so they come only
 * from the answers. They are carried through untouched; `setupRootRun` owns
 * their validation, including the refusal of a budget in loop mode.
 */
const LOOP_ANSWER_FIELDS = ["mode", "max_iterations", "max_repair_attempts", "max_depth"] as const;

export interface AssembleOptions {
  project_root: string;
  /** The owner-confirmed answers file. Items may use either spelling. */
  answers: unknown;
}

export interface AssembleResult {
  input: RootSetupInput;
  /** Which items came from inference untouched, for the skill to print back. */
  from_inference: RootSetupItem[];
  from_answers: RootSetupItem[];
}

export function assembleRootSetupInput(options: AssembleOptions): AssembleResult {
  const root = path.resolve(options.project_root);
  const answers = options.answers;
  if (!isRecord(answers)) failA1("INVALID_VALUE", "answers must be an object", "answers");

  const missingHeader = REQUIRED_ANSWER_FIELDS.filter((key) => answers[key] === undefined);
  if (missingHeader.length > 0) {
    failA1(
      "INVALID_VALUE",
      `answers is missing: ${missingHeader.join(", ")}`,
      `answers.${missingHeader[0]}`,
    );
  }

  // Unknown answer keys are otherwise dropped; this one is refused so the owner
  // learns where the model rule goes instead of losing it.
  if (answers.model_usage_policy !== undefined)
    failA1(
      "INVALID_VALUE",
      "model usage is not a setup answer; write it in CLAUDE.md under ## Model Usage",
      "answers.model_usage_policy",
    );

  const inference = inferSetupItems(root);
  const document: Record<string, unknown> = { project_root: root };
  for (const key of REQUIRED_ANSWER_FIELDS) document[key] = answers[key];
  for (const key of LOOP_ANSWER_FIELDS)
    if (answers[key] !== undefined) document[key] = answers[key];

  const fromInference: RootSetupItem[] = [];
  const fromAnswers: RootSetupItem[] = [];
  for (const [item, aliases] of Object.entries(ITEM_ALIASES) as Array<
    [RootSetupItem, readonly string[]]
  >) {
    const answered = aliases.map((alias) => answers[alias]).find((value) => value !== undefined);
    const inferred = inference.inferred[item]?.value;
    if (answered === undefined && inferred === undefined) continue;
    document[ITEM_FIELD[item]] =
      answered === undefined
        ? inferred
        : inferred === undefined
          ? answered
          : mergeValue(inferred, answered);
    (answered === undefined ? fromInference : fromAnswers).push(item);
  }

  // The same check `setupRootRun` runs, done here so the failure names the
  // missing items while the owner is still in the questionnaire, instead of
  // after a file has been handed to the sealing command.
  const missing = collectMissingSetupItems(document);
  if (missing.length > 0) throw new SetupIncompleteError(missing);

  return {
    input: document as unknown as RootSetupInput,
    from_inference: fromInference,
    from_answers: fromAnswers,
  };
}
