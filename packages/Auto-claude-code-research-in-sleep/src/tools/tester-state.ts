import crypto from "node:crypto";
import fs from "node:fs";
import { sealWikiWorkerManifest } from "./research-wiki.js";
import { requireRunContract, runOwnedPath, type RunRecord } from "./run-contract.js";
import { readResultPackage, resultStatusPolicy, type ResultStatus } from "./result-package.js";
import { createArtifactRegistry } from "./artifact-registry.js";
import { readOuterValidationGateRecord } from "./workflow-runtime.js";
import { readLegacyFrozenPolicy, readWorkflowRuntimeState } from "./workflow-state.js";
import path from "node:path";
import { canonicalJsonSha256, canonicalJsonString } from "./canonical-json.js";
import {
  computeCompleteGridMeans,
  type CompleteGridMetricObservation,
  type PairedStatisticsConfig,
} from "./paired-statistics.js";
import { readStoredReviewReceipt, type TesterReviewReceipt } from "./review-submit.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireBoolean,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

export type TesterTrialStatus = "reserved" | "settled" | "released";
export type TesterRunStatus =
  | "queued"
  | "running"
  | "sealed"
  | "reviewed"
  | "passed"
  | "rejected"
  | "retryable_infra_failure";

export interface TesterConstraint {
  name: string;
  absolute: { op: ">=" | "<=" | ">" | "<" | "="; value: number };
  paired_regression: { op: ">=" | "<=" | ">" | "<" | "="; value: number };
}

/**
 * One metric the finalist has to improve, with the bar it has to clear. The
 * bar sits on the metric rather than on the gate because a gain of 0.1 is a
 * different claim for an accuracy than for a latency, so a single shared
 * number stops meaning anything once a tester reports more than one metric.
 */
export interface TesterPrimaryMetric {
  name: string;
  direction: "higher_better" | "lower_better";
  improvement: {
    policy: "relative" | "absolute";
    minimum_gain: number;
  };
}

export interface TesterGateDefinition {
  /**
   * Every metric this tester must report and the finalist must improve. They
   * are conjunctive: one metric missing its bar rejects the finalist, which is
   * the same fail-closed rule `missing_result_policy` and `tie_policy` use.
   */
  primaries: TesterPrimaryMetric[];
  paired_delta: "finalist_minus_matching_baseline";
  statistics: PairedStatisticsConfig;
  case_aggregation: "mean_of_complete_case_set";
  repeat_aggregation: "lower_confidence_bound";
  tie_policy: "reject_finalist";
  missing_result_policy: "fail_closed";
  constraints: TesterConstraint[];
  workflow_constraints: "must_also_pass";
}

export interface TesterObservation {
  case_id: string;
  repeat_id: string;
  metrics: Record<string, number>;
  constraint_metrics: Record<string, number>;
}

export interface TesterJudgeBinding {
  binding_id: string;
  artifact_id: string;
  artifact_sha256: string;
  source: "previous_promoted";
  generation: number;
  target_generation: number;
  task_setup_revision: string;
  source_incumbent_id: string;
}

export interface TesterArmResult {
  arm: "matching_baseline" | "finalist";
  artifact_id: string;
  artifact_sha256: string;
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  input_distribution_sha256: string;
  judge_binding_id: string | null;
  model_assignment_sha256: string;
  case_ids: string[];
  repeat_ids: string[];
  complete: boolean;
  metrics: Record<string, number>;
  constraint_metrics: Record<string, number>;
  observations: TesterObservation[];
}

export interface TesterDefinition {
  schema_version: 1;
  tester_id: string;
  version: string;
  immutable: true;
  case_manifest_id: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  harness_sha256: string;
  research_feedback: "detailed";
  comparison: "paired_matching_baseline_vs_finalist";
  gate: TesterGateDefinition;
  scoring: Array<{
    kind: "deterministic_rules" | "llm_rubric";
    definition_version: string;
    judge_binding: "from_model_usage_policy" | null;
  }>;
  definition_sha256: string;
}

export interface TesterTrialRecord {
  promotion_trial_id: string;
  status: TesterTrialStatus;
  outer_run_id: string;
  wave_id: string;
  tester_id: string;
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  task_setup_revision: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  model_assignment_sha256: string;
  input_distribution_sha256: string;
  judge_binding_id: string | null;
  judge_binding: TesterJudgeBinding | null;
  tester_run_id: string | null;
  tester_started: boolean;
  test_result_sha256: string | null;
  feedback_event_id: string | null;
  reserved_at: string;
  settled_at: string | null;
  released_at: string | null;
}

export interface TesterTrialLedger {
  schema_version: 1;
  task_id: string;
  ledger_revision: string;
  test_trials: TesterTrialRecord[];
}

export interface PromotionReservationInput {
  project_root: string;
  task_id: string;
  promotion_trial_id: string;
  outer_run_id: string;
  wave_id: string;
  tester_id: string;
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  task_setup_revision: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  model_assignment_sha256: string;
  input_distribution_sha256: string;
  judge_binding?: TesterJudgeBinding | null;
  /** Kept only to reject stale callers that still try to provide an id alone. */
  judge_binding_id?: string | null;
}

export interface TesterRunState {
  schema_version: 1;
  run_id: string;
  tester_run_id: string;
  task_id: string;
  outer_run_id: string;
  outer_iteration: number;
  wave_id: string;
  wave_kind: "module" | "structure";
  generation: number;
  promotion_trial_id: string;
  tester_id: string;
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  task_setup_revision: string;
  input_snapshot_sha256: string;
  input_distribution_sha256: string;
  judge_binding_id: string | null;
  judge_binding: TesterJudgeBinding | null;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  model_assignment_sha256: string;
  status: TesterRunStatus;
  attempt: number;
  test_result_sha256: string | null;
  review_id: string | null;
  reviewer_worker_id: string | null;
  review_receipt_sha256: string | null;
  gate_consumed: boolean;
  gate_status: "passed" | "rejected" | null;
  updated_at: string;
}

export interface TesterResultBundle {
  schema_version: 1;
  tester_run_id: string;
  task_id: string;
  outer_run_id: string;
  outer_iteration: number;
  wave_id: string;
  wave_kind: "module" | "structure";
  generation: number;
  promotion_trial_id: string;
  task_setup_revision: string;
  tester_id: string;
  tester_version: string;
  tester_definition_sha256: string;
  tester_definition: TesterDefinition;
  harness_sha256: string;
  case_manifest: {
    case_manifest_id: string;
    case_manifest_sha256: string;
    seed_manifest_sha256: string;
  };
  case_manifest_id: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  input_snapshot_sha256: string;
  input_distribution_sha256: string;
  model_assignment_sha256: string;
  judge_binding: TesterJudgeBinding | null;
  workflow_constraints_passed: boolean;
  baseline: TesterArmResult;
  finalist: TesterArmResult;
}

function taskDirectory(projectRoot: string, taskId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "tasks",
    assertIdentifier(taskId, "task_id"),
  );
}

export function testerTrialLedgerPath(projectRoot: string, taskId: string): string {
  return path.join(taskDirectory(projectRoot, taskId), "tester-trial-state.json");
}

function testerDirectory(projectRoot: string, testerId: string, version: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "testers",
    assertIdentifier(testerId, "tester_id"),
    "versions",
    assertIdentifier(version, "tester_version"),
  );
}

export function testerDefinitionPath(
  projectRoot: string,
  testerId: string,
  version: string,
): string {
  return path.join(testerDirectory(projectRoot, testerId, version), "definition.json");
}

function testerRunDirectory(projectRoot: string, testerRunId: string): string {
  return runOwnedPath(projectRoot, testerRunId);
}

export function testerRunStatePath(projectRoot: string, testerRunId: string): string {
  return runOwnedPath(projectRoot, testerRunId, "tester-state.json");
}

export function testerDashboardPath(projectRoot: string, testerRunId: string): string {
  return runOwnedPath(projectRoot, testerRunId, "dashboard.json");
}

export function testerResultPath(projectRoot: string, testerRunId: string): string {
  return runOwnedPath(projectRoot, testerRunId, "test-result.json");
}

function judgeBindingIdentity(binding: Omit<TesterJudgeBinding, "binding_id">): string {
  return `judge-binding:sha256:${canonicalJsonSha256(binding, undefined, {
    schemaVersion: "tester-judge-binding-v1",
  })}`;
}

function validateJudgeBindingShape(value: unknown, location: string): TesterJudgeBinding {
  if (!isRecord(value))
    failA1("INVALID_JUDGE_BINDING", "judge binding must be an object", location);
  const allowed = [
    "binding_id",
    "artifact_id",
    "artifact_sha256",
    "source",
    "generation",
    "target_generation",
    "task_setup_revision",
    "source_incumbent_id",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("INVALID_JUDGE_BINDING", `unknown judge binding field '${key}'`, location);
  if (value.source !== "previous_promoted")
    failA1(
      "JUDGE_LAG_VIOLATION",
      "tester LLM judges must come from a previous promoted generation",
      location,
    );
  const bindingWithoutId = {
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    artifact_sha256: assertSha256(value.artifact_sha256, `${location}.artifact_sha256`),
    source: "previous_promoted" as const,
    generation: requireInteger(value.generation, `${location}.generation`, 0),
    target_generation: requireInteger(value.target_generation, `${location}.target_generation`, 1),
    task_setup_revision: assertIdentifier(
      value.task_setup_revision,
      `${location}.task_setup_revision`,
    ),
    source_incumbent_id: assertIdentifier(
      value.source_incumbent_id,
      `${location}.source_incumbent_id`,
    ),
  };
  if (bindingWithoutId.generation >= bindingWithoutId.target_generation)
    failA1(
      "JUDGE_LAG_VIOLATION",
      "tester judge must be at least one generation behind its target",
      location,
    );
  const bindingId = assertIdentifier(value.binding_id, `${location}.binding_id`);
  if (bindingId !== judgeBindingIdentity(bindingWithoutId))
    failA1(
      "INVALID_JUDGE_BINDING",
      "judge binding id does not match its immutable binding facts",
      location,
    );
  return { binding_id: bindingId, ...bindingWithoutId };
}

export function buildTesterJudgeBinding(
  input: Omit<TesterJudgeBinding, "binding_id">,
): TesterJudgeBinding {
  const binding = validateJudgeBindingShape(
    { ...input, binding_id: judgeBindingIdentity(input) },
    "tester.judge_binding",
  );
  return binding;
}

function testerUsesLlm(definition: TesterDefinition): boolean {
  return definition.scoring.some((entry) => entry.kind === "llm_rubric");
}

function resolveJudgeBinding(
  definition: TesterDefinition,
  value: unknown,
  taskSetupRevision: string,
  matchingBaselineArtifactSha256: string,
  finalistArtifactSha256: string,
  location: string,
): TesterJudgeBinding | null {
  const needsJudge = testerUsesLlm(definition);
  if (value === undefined || value === null) {
    if (needsJudge)
      failA1(
        "JUDGE_BINDING_REQUIRED",
        "an LLM tester must receive the setup-selected previous judge",
        location,
      );
    return null;
  }
  if (!needsJudge)
    failA1(
      "JUDGE_BINDING_FORBIDDEN",
      "a deterministic tester cannot receive a judge binding",
      location,
    );
  const binding = validateJudgeBindingShape(value, location);
  if (binding.task_setup_revision !== taskSetupRevision)
    failA1(
      "IDENTITY_MISMATCH",
      "judge binding must belong to the frozen task setup revision",
      location,
    );
  if (
    binding.artifact_sha256 === matchingBaselineArtifactSha256 ||
    binding.artifact_sha256 === finalistArtifactSha256 ||
    binding.artifact_id === "artifact:matching-baseline" ||
    binding.artifact_id === "artifact:finalist"
  )
    failA1(
      "JUDGE_LAG_VIOLATION",
      "the current tester arms cannot be used as their own judge",
      location,
    );
  return binding;
}

function judgeBindingId(binding: TesterJudgeBinding | null): string | null {
  return binding?.binding_id ?? null;
}

function operation(value: unknown, location: string): ">=" | "<=" | ">" | "<" | "=" {
  if (value !== ">=" && value !== "<=" && value !== ">" && value !== "<" && value !== "=")
    failA1("INVALID_TESTER_DEFINITION", "invalid constraint operator", location);
  return value;
}

function validateConstraint(value: unknown, location: string): TesterConstraint {
  if (!isRecord(value))
    failA1("INVALID_TESTER_DEFINITION", "constraint must be an object", location);
  const allowed = ["name", "absolute", "paired_regression"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown tester constraint field '${key}'`, location);
  function bound(
    boundValue: unknown,
    boundLocation: string,
  ): { op: ">=" | "<=" | ">" | "<" | "="; value: number } {
    if (!isRecord(boundValue))
      failA1("INVALID_TESTER_DEFINITION", "constraint bound must be an object", boundLocation);
    for (const key of Object.keys(boundValue))
      if (!(["op", "value"] as string[]).includes(key))
        failA1("UNKNOWN_FIELD", `unknown tester bound field '${key}'`, boundLocation);
    return {
      op: operation(boundValue.op, `${boundLocation}.op`),
      value: requireFiniteNumber(boundValue.value, `${boundLocation}.value`),
    };
  }
  return {
    name: assertIdentifier(value.name, `${location}.name`),
    absolute: bound(value.absolute, `${location}.absolute`),
    paired_regression: bound(value.paired_regression, `${location}.paired_regression`),
  };
}

function validateStatisticsConfig(value: unknown): PairedStatisticsConfig {
  const location = "tester.gate.statistics";
  if (!isRecord(value))
    failA1("INVALID_TESTER_DEFINITION", "tester statistics must be an object", location);
  for (const key of Object.keys(value))
    if (!["method", "confidence_level", "min_repeats"].includes(key))
      failA1("UNKNOWN_FIELD", `unknown tester statistics field '${key}'`, location);
  if (value.method !== "paired_student_t")
    failA1(
      "STATISTICS_UNSUPPORTED_METHOD",
      "tester statistics must explicitly select paired_student_t",
      `${location}.method`,
    );
  const confidenceLevel = requireFiniteNumber(
    value.confidence_level,
    `${location}.confidence_level`,
  );
  if (confidenceLevel <= 0.5 || confidenceLevel >= 1)
    failA1(
      "INVALID_STATISTICS_CONFIGURATION",
      "confidence_level must be greater than 0.5 and less than 1",
      `${location}.confidence_level`,
    );
  return {
    method: "paired_student_t",
    confidence_level: confidenceLevel,
    min_repeats: requireInteger(value.min_repeats, `${location}.min_repeats`, 2),
  };
}

function validateImprovement(value: unknown, location: string): TesterPrimaryMetric["improvement"] {
  if (!isRecord(value))
    failA1("INVALID_TESTER_DEFINITION", "tester improvement must be an object", location);
  for (const key of Object.keys(value))
    if (!["policy", "minimum_gain"].includes(key))
      failA1("UNKNOWN_FIELD", `unknown tester improvement field '${key}'`, location);
  if (value.policy !== "relative" && value.policy !== "absolute")
    failA1("INVALID_TESTER_DEFINITION", "tester improvement policy is invalid", location);
  const minimumGain = requireFiniteNumber(value.minimum_gain, `${location}.minimum_gain`);
  if (minimumGain < 0)
    failA1("INVALID_TESTER_DEFINITION", "minimum_gain cannot be negative", location);
  return { policy: value.policy, minimum_gain: minimumGain };
}

/**
 * The tester's declared metric set. It is frozen into `definition_sha256`, so
 * this list is also the whitelist of numbers the tester is ever allowed to
 * publish as formal metrics; raw measurements remain readable.
 */
function validatePrimaries(value: unknown): TesterPrimaryMetric[] {
  const location = "tester.gate.primaries";
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_TESTER_DEFINITION", `${location} must be a non-empty array`, location);
  const primaries = value.map((entry, index): TesterPrimaryMetric => {
    const entryLocation = `${location}[${index}]`;
    if (!isRecord(entry))
      failA1("INVALID_TESTER_DEFINITION", "tester primary metric must be an object", entryLocation);
    for (const key of Object.keys(entry))
      if (!["name", "direction", "improvement"].includes(key))
        failA1("UNKNOWN_FIELD", `unknown tester primary field '${key}'`, entryLocation);
    const direction = entry.direction;
    if (direction !== "higher_better" && direction !== "lower_better")
      failA1("INVALID_TESTER_DEFINITION", "invalid tester primary direction", entryLocation);
    return {
      name: assertIdentifier(entry.name, `${entryLocation}.name`),
      direction,
      improvement: validateImprovement(entry.improvement, `${entryLocation}.improvement`),
    };
  });
  const names = primaries.map((primary) => primary.name);
  if (new Set(names).size !== names.length)
    failA1("INVALID_TESTER_DEFINITION", `${location} must not repeat a metric name`, location);
  // Sorted so two definitions that declare the same metrics hash the same
  // whatever order the author listed them in.
  return primaries.sort((left, right) => compareIdentityStrings(left.name, right.name));
}

function validateGate(value: unknown): TesterGateDefinition {
  if (!isRecord(value)) failA1("INVALID_TESTER_DEFINITION", "tester gate must be an object");
  const allowed = [
    "primaries",
    "paired_delta",
    "statistics",
    "case_aggregation",
    "repeat_aggregation",
    "tie_policy",
    "missing_result_policy",
    "constraints",
    "workflow_constraints",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", `unknown tester gate field '${key}'`);
  const primaries = validatePrimaries(value.primaries);
  if (
    value.paired_delta !== "finalist_minus_matching_baseline" ||
    value.case_aggregation !== "mean_of_complete_case_set" ||
    value.repeat_aggregation !== "lower_confidence_bound" ||
    value.tie_policy !== "reject_finalist" ||
    value.missing_result_policy !== "fail_closed" ||
    value.workflow_constraints !== "must_also_pass"
  )
    failA1(
      "INVALID_TESTER_DEFINITION",
      "tester gate uses an unsupported aggregation or tie policy",
    );
  if (!Array.isArray(value.constraints))
    failA1("INVALID_TESTER_DEFINITION", "tester constraints must be an array");
  return {
    primaries,
    paired_delta: "finalist_minus_matching_baseline",
    statistics: validateStatisticsConfig(value.statistics),
    case_aggregation: "mean_of_complete_case_set",
    repeat_aggregation: "lower_confidence_bound",
    tie_policy: "reject_finalist",
    missing_result_policy: "fail_closed",
    constraints: value.constraints.map((constraint, index) =>
      validateConstraint(constraint, `tester.gate.constraints[${index}]`),
    ),
    workflow_constraints: "must_also_pass",
  };
}

function validateScoring(value: unknown): TesterDefinition["scoring"] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_TESTER_DEFINITION", "tester scoring definitions must be a non-empty array");
  return value.map((entry, index) => {
    const location = `tester.scoring[${index}]`;
    if (!isRecord(entry))
      failA1("INVALID_TESTER_DEFINITION", "tester scoring entry must be an object", location);
    const allowed = ["kind", "definition_version", "judge_binding"];
    for (const key of Object.keys(entry))
      if (!allowed.includes(key))
        failA1("UNKNOWN_FIELD", `unknown tester scoring field '${key}'`, location);
    if (!Object.hasOwn(entry, "judge_binding"))
      failA1(
        "INVALID_TESTER_DEFINITION",
        "tester scoring entries must explicitly declare judge_binding",
        location,
      );
    if (entry.kind !== "deterministic_rules" && entry.kind !== "llm_rubric")
      failA1("INVALID_TESTER_DEFINITION", "invalid tester scoring kind", location);
    const judgeBinding = entry.judge_binding;
    if (judgeBinding !== null && judgeBinding !== "from_model_usage_policy")
      failA1(
        "INVALID_TESTER_DEFINITION",
        "tester judge binding must come from model policy",
        location,
      );
    if (entry.kind === "deterministic_rules" && judgeBinding !== null)
      failA1(
        "INVALID_TESTER_DEFINITION",
        "deterministic tester rules cannot declare a judge binding",
        location,
      );
    if (entry.kind === "llm_rubric" && judgeBinding !== "from_model_usage_policy")
      failA1(
        "INVALID_TESTER_DEFINITION",
        "LLM tester rules must declare a model-policy judge binding",
        location,
      );
    return {
      kind: entry.kind,
      definition_version: assertIdentifier(
        entry.definition_version,
        `${location}.definition_version`,
      ),
      judge_binding: judgeBinding,
    };
  });
}

export function validateTesterDefinition(value: unknown): TesterDefinition {
  if (!isRecord(value)) failA1("INVALID_TESTER_DEFINITION", "tester definition must be an object");
  const allowed = [
    "schema_version",
    "tester_id",
    "version",
    "immutable",
    "case_manifest_id",
    "case_manifest_sha256",
    "seed_manifest_sha256",
    "harness_sha256",
    "research_feedback",
    "comparison",
    "gate",
    "scoring",
    "definition_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", `unknown tester definition field '${key}'`);
  if (
    value.schema_version !== 1 ||
    value.immutable !== true ||
    value.research_feedback !== "detailed" ||
    value.comparison !== "paired_matching_baseline_vs_finalist"
  )
    failA1(
      "INVALID_TESTER_DEFINITION",
      "tester must be immutable, paired, and configured for detailed feedback",
    );
  const gate = validateGate(value.gate);
  const definition: TesterDefinition = {
    schema_version: 1,
    tester_id: assertIdentifier(value.tester_id, "tester.tester_id"),
    version: assertIdentifier(value.version, "tester.version"),
    immutable: true,
    case_manifest_id: assertIdentifier(value.case_manifest_id, "tester.case_manifest_id"),
    case_manifest_sha256: assertSha256(value.case_manifest_sha256, "tester.case_manifest_sha256"),
    seed_manifest_sha256: assertSha256(value.seed_manifest_sha256, "tester.seed_manifest_sha256"),
    harness_sha256: assertSha256(value.harness_sha256, "tester.harness_sha256"),
    research_feedback: "detailed",

    comparison: "paired_matching_baseline_vs_finalist",
    gate,
    scoring: validateScoring(value.scoring),
    definition_sha256: assertSha256(value.definition_sha256, "tester.definition_sha256"),
  };
  const expectedDefinitionSha256 = canonicalJsonSha256(
    {
      schema_version: definition.schema_version,
      tester_id: definition.tester_id,
      version: definition.version,
      immutable: definition.immutable,
      case_manifest_id: definition.case_manifest_id,
      case_manifest_sha256: definition.case_manifest_sha256,
      seed_manifest_sha256: definition.seed_manifest_sha256,
      harness_sha256: definition.harness_sha256,
      research_feedback: definition.research_feedback,
      comparison: definition.comparison,
      gate: definition.gate,
      scoring: definition.scoring,
    },
    undefined,
    { schemaVersion: "tester-definition-v1" },
  );
  if (definition.definition_sha256 !== expectedDefinitionSha256)
    failA1("TESTER_HASH_MISMATCH", "tester definition hash does not match its immutable fields");
  return definition;
}

export function buildTesterDefinition(
  value: Omit<TesterDefinition, "definition_sha256">,
): TesterDefinition {
  // Hash the normalized form rather than the caller's. Validation sorts
  // gate.primaries by name, so hashing the list as written would disagree with
  // the check whenever the author happened to declare the metrics in another
  // order -- which only shows up once a tester declares more than one.
  const normalized = {
    ...value,
    gate: {
      ...value.gate,
      primaries: [...value.gate.primaries].sort((left, right) =>
        compareIdentityStrings(left.name, right.name),
      ),
    },
  };
  const definitionSha256 = canonicalJsonSha256(normalized, undefined, {
    schemaVersion: "tester-definition-v1",
  });
  return validateTesterDefinition({ ...normalized, definition_sha256: definitionSha256 });
}

function normalizeStringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_TESTER_RESULT", `${location} must be a non-empty array`);
  const values = value.map((item, index) => assertIdentifier(item, `${location}[${index}]`));
  if (new Set(values).size !== values.length)
    failA1("INVALID_TESTER_RESULT", `${location} must not contain duplicate ids`);
  return values.sort(compareIdentityStrings);
}

function normalizeMetricRecord(value: unknown, location: string): Record<string, number> {
  if (!isRecord(value)) failA1("INVALID_TESTER_RESULT", `${location} must be an object`);
  const result: Record<string, number> = {};
  for (const [name, score] of Object.entries(value)) {
    const metricName = assertIdentifier(name, `${location}.${name}`);
    result[metricName] = requireFiniteNumber(score, `${location}.${name}`);
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => compareIdentityStrings(left, right)),
  );
}

function normalizeTesterObservations(value: unknown, location: string): TesterObservation[] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_TESTER_RESULT", `${location} must be a non-empty array`);
  const observations = value.map((entry, index) => {
    const entryLocation = `${location}[${index}]`;
    if (!isRecord(entry))
      failA1("INVALID_TESTER_RESULT", "tester observation must be an object", entryLocation);
    for (const key of Object.keys(entry))
      if (!["case_id", "repeat_id", "metrics", "constraint_metrics"].includes(key))
        failA1("UNKNOWN_FIELD", `unknown tester observation field '${key}'`, entryLocation);
    return {
      case_id: assertIdentifier(entry.case_id, `${entryLocation}.case_id`),
      repeat_id: assertIdentifier(entry.repeat_id, `${entryLocation}.repeat_id`),
      metrics: normalizeMetricRecord(entry.metrics, `${entryLocation}.metrics`),
      constraint_metrics: normalizeMetricRecord(
        entry.constraint_metrics,
        `${entryLocation}.constraint_metrics`,
      ),
    };
  });
  observations.sort(
    (left, right) =>
      compareIdentityStrings(left.case_id, right.case_id) ||
      compareIdentityStrings(left.repeat_id, right.repeat_id),
  );
  return observations;
}

function sameMetricRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}

function sameMetricKeys(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left).sort(compareIdentityStrings);
  const rightKeys = Object.keys(right).sort(compareIdentityStrings);
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

export function normalizeTesterArmResult(
  value: unknown,
  location: string,
  definition: TesterDefinition,
): TesterArmResult {
  if (!isRecord(value)) failA1("INVALID_TESTER_RESULT", `${location} must be an object`);
  const allowed = [
    "arm",
    "artifact_id",
    "artifact_sha256",
    "tester_version",
    "tester_definition_sha256",
    "harness_sha256",
    "case_manifest_sha256",
    "seed_manifest_sha256",
    "input_distribution_sha256",
    "judge_binding_id",
    "model_assignment_sha256",
    "case_ids",
    "repeat_ids",
    "complete",
    "metrics",
    "constraint_metrics",
    "observations",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown tester result field '${key}'`, location);
  if (value.arm !== "matching_baseline" && value.arm !== "finalist")
    failA1("INVALID_TESTER_RESULT", `${location}.arm is invalid`);
  if (typeof value.complete !== "boolean")
    failA1("INVALID_TESTER_RESULT", `${location}.complete must be boolean`);
  if (value.model_assignment_sha256 === undefined || value.model_assignment_sha256 === null)
    failA1("MODEL_ASSIGNMENT_REQUIRED", `${location}.model_assignment_sha256 is required`);
  const requiresJudge = testerUsesLlm(definition);
  if (requiresJudge && (value.judge_binding_id === undefined || value.judge_binding_id === null))
    failA1("JUDGE_BINDING_REQUIRED", `${location}.judge_binding_id is required for an LLM tester`);
  if (!requiresJudge && value.judge_binding_id !== null)
    failA1(
      "JUDGE_BINDING_FORBIDDEN",
      `${location}.judge_binding_id must be null for a code tester`,
    );
  const caseIds = normalizeStringList(value.case_ids, `${location}.case_ids`);
  const repeatIds = normalizeStringList(value.repeat_ids, `${location}.repeat_ids`);
  const observations = normalizeTesterObservations(value.observations, `${location}.observations`);
  const firstObservation = observations[0];
  if (!firstObservation)
    failA1("INVALID_TESTER_RESULT", `${location}.observations must not be empty`);
  for (const observation of observations) {
    if (
      !sameMetricKeys(observation.metrics, firstObservation.metrics) ||
      !sameMetricKeys(observation.constraint_metrics, firstObservation.constraint_metrics)
    )
      failA1(
        "INVALID_TESTER_RESULT",
        `${location}.observations must use the same metric names in every cell`,
      );
  }
  for (const constraint of definition.gate.constraints) {
    if (!Object.hasOwn(firstObservation.constraint_metrics, constraint.name))
      failA1(
        "MISSING_CONSTRAINT_METRIC",
        `${location}.observations is missing '${constraint.name}'`,
      );
  }
  const means = computeCompleteGridMeans({
    observations: observations as CompleteGridMetricObservation[],
    case_ids: caseIds,
    repeat_ids: repeatIds,
  });
  const metrics =
    value.metrics === undefined
      ? means.metrics
      : normalizeMetricRecord(value.metrics, `${location}.metrics`);
  if (!sameMetricKeys(metrics, means.metrics) || !sameMetricRecord(metrics, means.metrics))
    failA1(
      "AGGREGATE_MISMATCH",
      `${location}.metrics must equal the means recomputed from observations`,
    );
  const constraintMetrics =
    value.constraint_metrics === undefined
      ? means.constraint_metrics
      : normalizeMetricRecord(value.constraint_metrics, `${location}.constraint_metrics`);
  if (
    !sameMetricKeys(constraintMetrics, means.constraint_metrics) ||
    !sameMetricRecord(constraintMetrics, means.constraint_metrics)
  )
    failA1(
      "AGGREGATE_MISMATCH",
      `${location}.constraint_metrics must equal the means recomputed from observations`,
    );
  // Every declared metric has to be here. The gate is conjunctive, so a
  // missing metric is not a partial result the gate could still rule on.
  for (const primary of definition.gate.primaries)
    if (!Object.hasOwn(metrics, primary.name))
      failA1("MISSING_PRIMARY_METRIC", `${location}.metrics is missing '${primary.name}'`);
  const testerDefinitionSha256 = assertSha256(
    value.tester_definition_sha256,
    `${location}.tester_definition_sha256`,
  );
  if (testerDefinitionSha256 !== definition.definition_sha256)
    failA1(
      "TESTER_DEFINITION_MISMATCH",
      `${location}.tester_definition_sha256 must match the sealed tester definition`,
    );
  const harnessSha256 = assertSha256(value.harness_sha256, `${location}.harness_sha256`);
  if (harnessSha256 !== definition.harness_sha256)
    failA1("HARNESS_MISMATCH", `${location}.harness_sha256 must match the tester definition`);
  return {
    arm: value.arm,
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    artifact_sha256: assertSha256(value.artifact_sha256, `${location}.artifact_sha256`),
    tester_version: assertIdentifier(value.tester_version, `${location}.tester_version`),
    tester_definition_sha256: testerDefinitionSha256,
    harness_sha256: harnessSha256,
    case_manifest_sha256: assertSha256(
      value.case_manifest_sha256,
      `${location}.case_manifest_sha256`,
    ),
    seed_manifest_sha256: assertSha256(
      value.seed_manifest_sha256,
      `${location}.seed_manifest_sha256`,
    ),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      `${location}.input_distribution_sha256`,
    ),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, `${location}.judge_binding_id`),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      `${location}.model_assignment_sha256`,
    ),
    case_ids: caseIds,
    repeat_ids: repeatIds,
    complete: value.complete,
    metrics,
    constraint_metrics: constraintMetrics,
    observations,
  };
}

export function validateTesterArmResult(
  value: unknown,
  location: string,
  definition: TesterDefinition,
): TesterArmResult {
  return normalizeTesterArmResult(value, location, definition);
}

function assertSameTesterArmSets(baseline: TesterArmResult, finalist: TesterArmResult): void {
  const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((item, index) => item === right[index]);
  if (!sameList(baseline.case_ids, finalist.case_ids))
    failA1("TESTER_ARMS_MISMATCH", "case manifest differs between tester arms");
  if (!sameList(baseline.repeat_ids, finalist.repeat_ids))
    failA1("TESTER_ARMS_MISMATCH", "repeat set differs between tester arms");
  if (baseline.tester_definition_sha256 !== finalist.tester_definition_sha256)
    failA1("TESTER_ARMS_MISMATCH", "tester definition differs between tester arms");
  if (baseline.harness_sha256 !== finalist.harness_sha256)
    failA1("HARNESS_MISMATCH", "harness differs between tester arms");
  const baselineObservationKeys = baseline.observations.map(
    (observation) => `${observation.case_id}\u0000${observation.repeat_id}`,
  );
  const finalistObservationKeys = finalist.observations.map(
    (observation) => `${observation.case_id}\u0000${observation.repeat_id}`,
  );
  if (!sameList(baselineObservationKeys, finalistObservationKeys))
    failA1("TESTER_ARMS_MISMATCH", "tester observation pairs differ between tester arms");
  const baselineMetrics = Object.keys(baseline.metrics).sort(compareIdentityStrings);
  const finalistMetrics = Object.keys(finalist.metrics).sort(compareIdentityStrings);
  if (!sameList(baselineMetrics, finalistMetrics))
    failA1("TESTER_ARMS_MISMATCH", "tester metrics differ between tester arms");
  const baselineConstraints = Object.keys(baseline.constraint_metrics).sort(compareIdentityStrings);
  const finalistConstraints = Object.keys(finalist.constraint_metrics).sort(compareIdentityStrings);
  if (!sameList(baselineConstraints, finalistConstraints))
    failA1("TESTER_ARMS_MISMATCH", "tester constraints differ between tester arms");
}

export function assertTesterArmsComparable(
  baseline: TesterArmResult,
  finalist: TesterArmResult,
): void {
  if (baseline.arm !== "matching_baseline" || finalist.arm !== "finalist")
    failA1("MATCHING_BASELINE_REQUIRED", "tester must compare matching baseline against finalist");
  if (
    baseline.artifact_id === finalist.artifact_id ||
    baseline.artifact_sha256 === finalist.artifact_sha256
  )
    failA1("MATCHING_BASELINE_REQUIRED", "tester arms must use different artifacts");
  const commonFields: Array<[string, string | null, string | null]> = [
    ["tester_version", baseline.tester_version, finalist.tester_version],
    [
      "tester_definition_sha256",
      baseline.tester_definition_sha256,
      finalist.tester_definition_sha256,
    ],
    ["harness_sha256", baseline.harness_sha256, finalist.harness_sha256],
    ["case_manifest_sha256", baseline.case_manifest_sha256, finalist.case_manifest_sha256],
    ["seed_manifest_sha256", baseline.seed_manifest_sha256, finalist.seed_manifest_sha256],
    [
      "input_distribution_sha256",
      baseline.input_distribution_sha256,
      finalist.input_distribution_sha256,
    ],
    ["judge_binding_id", baseline.judge_binding_id, finalist.judge_binding_id],
    ["model_assignment_sha256", baseline.model_assignment_sha256, finalist.model_assignment_sha256],
  ];
  for (const [field, left, right] of commonFields)
    if (left !== right) failA1("TESTER_ARMS_MISMATCH", `${field} must match between tester arms`);
  assertSameTesterArmSets(baseline, finalist);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}

function expectedResultIdentity(
  state: TesterRunState,
  definition: TesterDefinition,
): Omit<TesterResultBundle, "baseline" | "finalist" | "workflow_constraints_passed"> {
  return {
    schema_version: 1,
    tester_run_id: state.tester_run_id,
    task_id: state.task_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    wave_kind: state.wave_kind,
    generation: state.generation,
    promotion_trial_id: state.promotion_trial_id,
    task_setup_revision: state.task_setup_revision,
    tester_id: state.tester_id,
    tester_version: state.tester_version,
    tester_definition_sha256: state.tester_definition_sha256,
    tester_definition: definition,
    harness_sha256: state.harness_sha256,
    case_manifest: {
      case_manifest_id: definition.case_manifest_id,
      case_manifest_sha256: state.case_manifest_sha256,
      seed_manifest_sha256: state.seed_manifest_sha256,
    },
    case_manifest_id: definition.case_manifest_id,
    case_manifest_sha256: state.case_manifest_sha256,
    seed_manifest_sha256: state.seed_manifest_sha256,
    input_snapshot_sha256: state.input_snapshot_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
    judge_binding: state.judge_binding,
  };
}

function normalizeCaseManifest(
  value: unknown,
  state: TesterRunState,
  location: string,
): {
  case_manifest_id: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
} {
  if (!isRecord(value)) failA1("INVALID_TESTER_RESULT", `${location} must be an object`);
  const allowed = ["case_manifest_id", "case_manifest_sha256", "seed_manifest_sha256"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown case manifest field '${key}'`, location);
  const manifest = {
    case_manifest_id: assertIdentifier(value.case_manifest_id, `${location}.case_manifest_id`),
    case_manifest_sha256: assertSha256(
      value.case_manifest_sha256,
      `${location}.case_manifest_sha256`,
    ),
    seed_manifest_sha256: assertSha256(
      value.seed_manifest_sha256,
      `${location}.seed_manifest_sha256`,
    ),
  };
  if (
    manifest.case_manifest_sha256 !== state.case_manifest_sha256 ||
    manifest.seed_manifest_sha256 !== state.seed_manifest_sha256
  )
    failA1("IDENTITY_MISMATCH", "test result case manifest differs from the frozen tester");
  return manifest;
}

function requireResultIdentityField(
  value: Record<string, unknown>,
  field: string,
  expected: string | number,
  allowOmitted: boolean,
  location: string,
): void {
  if (value[field] === undefined) {
    if (!allowOmitted) failA1("CORRUPT_TEST_RESULT", `missing '${field}'`, location);
    return;
  }
  const actual =
    typeof expected === "number"
      ? requireInteger(value[field], `${location}.${field}`, 1)
      : assertIdentifier(value[field], `${location}.${field}`);
  if (actual !== expected)
    failA1("IDENTITY_MISMATCH", `test result '${field}' differs from tester state`, location);
}

function normalizeTestResult(
  value: unknown,
  state: TesterRunState,
  definition: TesterDefinition,
  allowOmittedIdentity: boolean,
): TesterResultBundle {
  if (!isRecord(value)) failA1("CORRUPT_TEST_RESULT", "test result must be an object");
  const allowed = [
    "schema_version",
    "tester_run_id",
    "task_id",
    "outer_run_id",
    "outer_iteration",
    "wave_id",
    "wave_kind",
    "generation",
    "promotion_trial_id",
    "task_setup_revision",
    "tester_id",
    "tester_version",
    "tester_definition_sha256",
    "tester_definition",
    "harness_sha256",
    "case_manifest_id",
    "case_manifest_sha256",
    "seed_manifest_sha256",
    "case_manifest",
    "input_snapshot_sha256",
    "input_distribution_sha256",
    "model_assignment_sha256",
    "judge_binding",
    "workflow_constraints_passed",
    "baseline",
    "finalist",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", `unknown test result field '${key}'`);
  if (value.schema_version !== undefined && value.schema_version !== 1)
    failA1("CORRUPT_TEST_RESULT", "test result schema_version must be 1");
  if (value.schema_version === undefined && !allowOmittedIdentity)
    failA1("CORRUPT_TEST_RESULT", "test result schema_version is required");
  const identity = expectedResultIdentity(state, definition);
  requireResultIdentityField(
    value,
    "tester_run_id",
    identity.tester_run_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "task_id",
    identity.task_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "outer_run_id",
    identity.outer_run_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "outer_iteration",
    identity.outer_iteration,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "wave_id",
    identity.wave_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "generation",
    identity.generation,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "promotion_trial_id",
    identity.promotion_trial_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "task_setup_revision",
    identity.task_setup_revision,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "tester_id",
    identity.tester_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "tester_version",
    identity.tester_version,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "tester_definition_sha256",
    identity.tester_definition_sha256,
    allowOmittedIdentity,
    "test result",
  );
  if (value.harness_sha256 === undefined)
    failA1("CORRUPT_TEST_RESULT", "test result harness_sha256 is required");
  const harnessSha256 = assertSha256(value.harness_sha256, "test result.harness_sha256");
  if (harnessSha256 !== state.harness_sha256 || harnessSha256 !== definition.harness_sha256)
    failA1("HARNESS_MISMATCH", "test result harness does not match the frozen tester");
  requireResultIdentityField(
    value,
    "case_manifest_id",
    identity.case_manifest_id,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "case_manifest_sha256",
    identity.case_manifest_sha256,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "seed_manifest_sha256",
    identity.seed_manifest_sha256,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "input_snapshot_sha256",
    identity.input_snapshot_sha256,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "input_distribution_sha256",
    identity.input_distribution_sha256,
    allowOmittedIdentity,
    "test result",
  );
  requireResultIdentityField(
    value,
    "model_assignment_sha256",
    identity.model_assignment_sha256,
    allowOmittedIdentity,
    "test result",
  );
  if (value.wave_kind !== undefined && value.wave_kind !== state.wave_kind)
    failA1("IDENTITY_MISMATCH", "test result wave kind differs from tester state");
  if (value.wave_kind === undefined && !allowOmittedIdentity)
    failA1("CORRUPT_TEST_RESULT", "test result wave_kind is required");
  const testerDefinition =
    value.tester_definition === undefined
      ? definition
      : validateTesterDefinition(value.tester_definition);
  if (value.tester_definition === undefined && !allowOmittedIdentity)
    failA1("CORRUPT_TEST_RESULT", "test result tester_definition is required");
  if (testerDefinition.definition_sha256 !== state.tester_definition_sha256)
    failA1("IDENTITY_MISMATCH", "test result tester definition differs from tester state");
  const caseManifest =
    value.case_manifest === undefined
      ? {
          case_manifest_id: definition.case_manifest_id,
          case_manifest_sha256: state.case_manifest_sha256,
          seed_manifest_sha256: state.seed_manifest_sha256,
        }
      : normalizeCaseManifest(value.case_manifest, state, "test result.case_manifest");
  if (value.case_manifest === undefined && !allowOmittedIdentity)
    failA1("CORRUPT_TEST_RESULT", "test result case_manifest is required");
  if (caseManifest.case_manifest_id !== definition.case_manifest_id)
    failA1("IDENTITY_MISMATCH", "test result case manifest id differs from the tester definition");
  const rawJudgeBinding =
    value.judge_binding === undefined ? state.judge_binding : value.judge_binding;
  if (value.judge_binding === undefined && !allowOmittedIdentity)
    failA1("CORRUPT_TEST_RESULT", "test result judge_binding is required");
  const binding = resolveJudgeBinding(
    definition,
    rawJudgeBinding,
    state.task_setup_revision,
    state.matching_baseline_artifact_sha256,
    state.finalist_artifact_sha256,
    "test result.judge_binding",
  );
  if (!sameJson(binding, state.judge_binding))
    failA1("IDENTITY_MISMATCH", "test result judge binding differs from tester state");
  if (
    value.workflow_constraints_passed !== undefined &&
    typeof value.workflow_constraints_passed !== "boolean"
  )
    failA1("INVALID_TESTER_RESULT", "workflow_constraints_passed must be boolean");
  if (value.workflow_constraints_passed === undefined)
    failA1("INVALID_TESTER_RESULT", "test result must include workflow constraints result");
  const baseline = normalizeTesterArmResult(value.baseline, "test result.baseline", definition);
  const finalist = normalizeTesterArmResult(value.finalist, "test result.finalist", definition);
  assertTesterArmsComparable(baseline, finalist);
  const expectedBindingId = judgeBindingId(binding);
  for (const arm of [baseline, finalist]) {
    if (
      arm.tester_version !== state.tester_version ||
      arm.case_manifest_sha256 !== state.case_manifest_sha256 ||
      arm.seed_manifest_sha256 !== state.seed_manifest_sha256 ||
      arm.input_distribution_sha256 !== state.input_distribution_sha256 ||
      arm.tester_definition_sha256 !== state.tester_definition_sha256 ||
      arm.harness_sha256 !== state.harness_sha256 ||
      arm.judge_binding_id !== expectedBindingId ||
      arm.model_assignment_sha256 !== state.model_assignment_sha256
    )
      failA1("TESTER_ARMS_MISMATCH", "test result arm does not match frozen tester state");
  }
  if (baseline.artifact_sha256 !== state.matching_baseline_artifact_sha256)
    failA1("TESTER_ARMS_MISMATCH", "matching baseline result is not the reserved artifact");
  if (finalist.artifact_sha256 !== state.finalist_artifact_sha256)
    failA1("TESTER_ARMS_MISMATCH", "finalist result is not the reserved artifact");
  if (
    binding !== null &&
    (binding.artifact_id === baseline.artifact_id ||
      binding.artifact_id === finalist.artifact_id ||
      binding.artifact_sha256 === baseline.artifact_sha256 ||
      binding.artifact_sha256 === finalist.artifact_sha256)
  )
    failA1("JUDGE_LAG_VIOLATION", "tester arms or their artifacts cannot become the judge");
  return {
    ...identity,
    tester_definition: testerDefinition,
    harness_sha256: harnessSha256,
    case_manifest: caseManifest,
    case_manifest_id: caseManifest.case_manifest_id,
    case_manifest_sha256: caseManifest.case_manifest_sha256,
    seed_manifest_sha256: caseManifest.seed_manifest_sha256,
    input_distribution_sha256: state.input_distribution_sha256,
    judge_binding: binding,
    workflow_constraints_passed: value.workflow_constraints_passed,
    baseline,
    finalist,
  };
}

export function testerResultSha256(value: TesterResultBundle): string {
  return canonicalJsonSha256(value, undefined, { schemaVersion: "tester-test-result-v1" });
}

export function saveTesterDefinition(projectRoot: string, value: unknown): TesterDefinition {
  const definition = validateTesterDefinition(value);
  const filePath = testerDefinitionPath(projectRoot, definition.tester_id, definition.version);
  const caseManifestPath = path.join(path.dirname(filePath), "case-manifest.ref.json");

  function validateCaseManifestRef(value: unknown): void {
    if (!isRecord(value))
      failA1("IMMUTABLE_CONFLICT", "case manifest reference must be an object", caseManifestPath);
    const allowed = [
      "schema_version",
      "case_manifest_id",
      "case_manifest_sha256",
      "seed_manifest_sha256",
    ];
    for (const key of Object.keys(value))
      if (!allowed.includes(key))
        failA1(
          "IMMUTABLE_CONFLICT",
          `unknown case manifest reference field '${key}'`,
          caseManifestPath,
        );
    if (
      value.schema_version !== 1 ||
      value.case_manifest_id !== definition.case_manifest_id ||
      value.case_manifest_sha256 !== definition.case_manifest_sha256 ||
      value.seed_manifest_sha256 !== definition.seed_manifest_sha256
    )
      failA1(
        "IMMUTABLE_CONFLICT",
        "case manifest reference does not match the frozen tester definition",
        caseManifestPath,
      );
    assertIdentifier(value.case_manifest_id, `${caseManifestPath}.case_manifest_id`);
    assertSha256(value.case_manifest_sha256, `${caseManifestPath}.case_manifest_sha256`);
    assertSha256(value.seed_manifest_sha256, `${caseManifestPath}.seed_manifest_sha256`);
  }

  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateTesterDefinition(readStateFile(filePath));
      if (existing.definition_sha256 !== definition.definition_sha256)
        failA1("IMMUTABLE_CONFLICT", `tester version '${definition.version}' cannot be changed`);
    } else if (fs.existsSync(caseManifestPath)) {
      // A reference without its definition cannot be silently adopted. It may
      // belong to a different immutable version that was only partly written.
      validateCaseManifestRef(readStateFile(caseManifestPath));
    }
    if (!fs.existsSync(filePath)) writeStateJsonAtomic(filePath, definition);
    if (fs.existsSync(caseManifestPath)) validateCaseManifestRef(readStateFile(caseManifestPath));
    else
      writeStateJsonAtomic(caseManifestPath, {
        schema_version: 1,
        case_manifest_id: definition.case_manifest_id,
        case_manifest_sha256: definition.case_manifest_sha256,
        seed_manifest_sha256: definition.seed_manifest_sha256,
      });
    return definition;
  });
}

function validateTesterTrial(value: unknown, location: string): TesterTrialRecord {
  if (!isRecord(value))
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "testTrial must be an object", location);
  const allowed = [
    "promotion_trial_id",
    "status",
    "outer_run_id",
    "wave_id",
    "tester_id",
    "tester_version",
    "tester_definition_sha256",
    "harness_sha256",
    "task_setup_revision",
    "case_manifest_sha256",
    "seed_manifest_sha256",
    "matching_baseline_artifact_sha256",
    "finalist_artifact_sha256",
    "model_assignment_sha256",
    "input_distribution_sha256",
    "judge_binding_id",
    "judge_binding",
    "tester_run_id",
    "tester_started",
    "test_result_sha256",
    "feedback_event_id",
    "reserved_at",
    "settled_at",
    "released_at",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown testTrial field '${key}'`, location);
  if (value.status !== "reserved" && value.status !== "settled" && value.status !== "released")
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "invalid testTrial status", location);
  const record: TesterTrialRecord = {
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      `${location}.promotion_trial_id`,
    ),
    status: value.status,
    outer_run_id: assertIdentifier(value.outer_run_id, `${location}.outer_run_id`),
    wave_id: assertIdentifier(value.wave_id, `${location}.wave_id`),
    tester_id: assertIdentifier(value.tester_id, `${location}.tester_id`),
    tester_version: assertIdentifier(value.tester_version, `${location}.tester_version`),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      `${location}.tester_definition_sha256`,
    ),
    harness_sha256: assertSha256(value.harness_sha256, `${location}.harness_sha256`),
    task_setup_revision: assertIdentifier(
      value.task_setup_revision,
      `${location}.task_setup_revision`,
    ),
    case_manifest_sha256: assertSha256(
      value.case_manifest_sha256,
      `${location}.case_manifest_sha256`,
    ),
    seed_manifest_sha256: assertSha256(
      value.seed_manifest_sha256,
      `${location}.seed_manifest_sha256`,
    ),
    matching_baseline_artifact_sha256: assertSha256(
      value.matching_baseline_artifact_sha256,
      `${location}.matching_baseline_artifact_sha256`,
    ),
    finalist_artifact_sha256: assertSha256(
      value.finalist_artifact_sha256,
      `${location}.finalist_artifact_sha256`,
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      `${location}.model_assignment_sha256`,
    ),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      `${location}.input_distribution_sha256`,
    ),
    judge_binding_id:
      value.judge_binding_id === undefined || value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, `${location}.judge_binding_id`),
    judge_binding:
      value.judge_binding === null
        ? null
        : validateJudgeBindingShape(value.judge_binding, `${location}.judge_binding`),
    tester_run_id:
      value.tester_run_id === undefined || value.tester_run_id === null
        ? null
        : assertIdentifier(value.tester_run_id, `${location}.tester_run_id`),
    tester_started: requireBoolean(value.tester_started, `${location}.tester_started`),
    test_result_sha256:
      value.test_result_sha256 === null
        ? null
        : assertSha256(value.test_result_sha256, `${location}.test_result_sha256`),
    feedback_event_id:
      value.feedback_event_id === null
        ? null
        : assertIdentifier(value.feedback_event_id, `${location}.feedback_event_id`),
    reserved_at: requireString(value.reserved_at, `${location}.reserved_at`),
    settled_at:
      value.settled_at === null ? null : requireString(value.settled_at, `${location}.settled_at`),
    released_at:
      value.released_at === null
        ? null
        : requireString(value.released_at, `${location}.released_at`),
  };
  if (record.status === "reserved" && (record.settled_at !== null || record.released_at !== null))
    failA1(
      "CORRUPT_TESTER_TRIAL_LEDGER",
      "reserved testTrial cannot have a terminal timestamp",
      location,
    );
  if (
    record.status === "reserved" &&
    (record.tester_started ||
      record.test_result_sha256 !== null ||
      record.feedback_event_id !== null)
  )
    failA1(
      "CORRUPT_TESTER_TRIAL_LEDGER",
      "reserved testTrial cannot contain observed tester facts",
      location,
    );
  if (record.status === "settled" && (record.settled_at === null || record.released_at !== null))
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "settled testTrial timestamps are invalid", location);
  if (
    record.status === "settled" &&
    !record.tester_started &&
    record.test_result_sha256 === null &&
    record.feedback_event_id === null
  )
    failA1(
      "CORRUPT_TESTER_TRIAL_LEDGER",
      "settled testTrial must show a started tester, test result, or feedback event",
      location,
    );
  if (
    record.status === "released" &&
    (record.released_at === null ||
      record.settled_at !== null ||
      record.tester_started ||
      record.test_result_sha256 !== null ||
      record.feedback_event_id !== null)
  )
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "released testTrial must be untouched", location);
  if (record.judge_binding_id !== judgeBindingId(record.judge_binding))
    failA1(
      "CORRUPT_TESTER_TRIAL_LEDGER",
      "judge binding id does not match its frozen binding",
      location,
    );
  return record;
}

function emptyLedger(taskId: string): TesterTrialLedger {
  return {
    schema_version: 1,
    task_id: taskId,
    ledger_revision: "ledger-v1",
    test_trials: [],
  };
}

function loadLedger(projectRoot: string, taskId: string): TesterTrialLedger {
  const filePath = testerTrialLedgerPath(projectRoot, taskId);
  if (!fs.existsSync(filePath)) return emptyLedger(taskId);
  const parsed = readStateFile(filePath);
  if (!isRecord(parsed) || parsed.schema_version !== 1 || parsed.task_id !== taskId)
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "testTrial ledger identity is invalid", filePath);
  if (!Array.isArray(parsed.test_trials))
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "test_trials must be an array", filePath);
  const test_trials = parsed.test_trials.map((testTrial, index) =>
    validateTesterTrial(testTrial, `${filePath}.test_trials[${index}]`),
  );
  if (
    new Set(test_trials.map((testTrial) => testTrial.promotion_trial_id)).size !==
    test_trials.length
  )
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "promotion trial ids must be unique", filePath);
  const boundRuns = test_trials
    .map((testTrial) => testTrial.tester_run_id)
    .filter((runId): runId is string => runId !== null);
  if (new Set(boundRuns).size !== boundRuns.length)
    failA1("CORRUPT_TESTER_TRIAL_LEDGER", "tester run ids must be unique", filePath);
  return {
    schema_version: 1,
    task_id: taskId,
    ledger_revision: assertIdentifier(parsed.ledger_revision, `${filePath}.ledger_revision`),
    test_trials,
  };
}

function writeLedger(filePath: string, ledger: TesterTrialLedger): void {
  writeStateJsonAtomic(filePath, ledger);
}

function bindTesterRun(
  testTrial: TesterTrialRecord,
  testerRunId: string,
  inputDistributionSha256: string,
  binding: TesterJudgeBinding | null,
): void {
  if (testTrial.status === "released")
    failA1("TESTER_TRIAL_TERMINAL", "a released testTrial cannot bind a tester run");
  if (testTrial.tester_run_id !== null && testTrial.tester_run_id !== testerRunId)
    failA1("TESTER_ONCE_PER_WAVE", "a promotion trial can have only one tester run");
  if (testTrial.input_distribution_sha256 !== inputDistributionSha256)
    failA1("IDENTITY_MISMATCH", "tester input distribution differs from its reservation");
  if (testTrial.judge_binding_id !== judgeBindingId(binding))
    failA1("IDENTITY_MISMATCH", "tester judge binding differs from its reservation");
  if (!sameJson(testTrial.judge_binding, binding))
    failA1("IDENTITY_MISMATCH", "tester judge binding facts differ from its reservation");
  testTrial.tester_run_id = testerRunId;
}

function markTrialObserved(testTrial: TesterTrialRecord): void {
  if (testTrial.status === "released")
    failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot receive tester facts");
  testTrial.tester_started = true;
  if (testTrial.status === "reserved") {
    testTrial.status = "settled";
    testTrial.settled_at ??= new Date().toISOString();
  }
}

export function readTesterFinalistStatus(
  projectRoot: string,
  outerRunId: string,
  waveId: string,
  finalistArtifactSha256: string,
): ResultStatus {
  const root = requireRunContract(projectRoot, outerRunId);
  if (root.depth !== 0 || root.parent_run_id !== null)
    failA1("TESTER_ROOT_ONLY", "only the root run may request a tester");
  const runtime = readWorkflowRuntimeState(projectRoot, outerRunId);
  const cycle = runtime.active_cycle;
  if (runtime.current_phase !== "promotion" || cycle === null || cycle.wave_id !== waveId)
    failA1("TESTER_NOT_ALLOWED", "tester requires the active promotion wave");
  const validation = readOuterValidationGateRecord({
    project_root: projectRoot,
    execution_root: runtime.execution_root,
    outer_run_id: outerRunId,
    outer_iteration: cycle.outer_iteration,
  });
  if (validation.validation_result !== "passed" || validation.finalist_id === null)
    failA1("TESTER_NOT_ALLOWED", "tester requires the unique workflow validation finalist");
  // Output registries belong to the producer run, not necessarily the controller.
  for (const runId of [root.run_id, ...root.child_run_ids]) {
    const registry = createArtifactRegistry(projectRoot, runId);
    const finalist = registry
      .findByCandidate(validation.finalist_id)
      .find((artifact) => artifact.sha256 === finalistArtifactSha256);
    if (!finalist || finalist.producer_run_id !== runId) continue;
    registry.assertSealed(finalist.artifact_id);
    return readResultPackage(projectRoot, runId).status;
  }
  failA1("TESTER_FINALIST_MISMATCH", "tester artifact must belong to the selected finalist");
}

export function reservePromotionTrial(input: PromotionReservationInput): TesterTrialRecord {
  const status = readTesterFinalistStatus(
    input.project_root,
    input.outer_run_id,
    input.wave_id,
    input.finalist_artifact_sha256,
  );
  if (!resultStatusPolicy(status).requires_tester)
    failA1("TESTER_NOT_ALLOWED", "non-executable results cannot reserve tester testTrial");
  const frozen = readLegacyFrozenPolicy(input.project_root, input.outer_run_id);
  if (
    frozen.task_id !== input.task_id ||
    frozen.task_setup_revision !== input.task_setup_revision ||
    frozen.tester_definition.definition_sha256 !== input.tester_definition_sha256
  )
    failA1("IDENTITY_MISMATCH", "reservation must use the root's frozen task and tester");
  const taskId = assertIdentifier(input.task_id, "task_id");
  const trialId = assertIdentifier(input.promotion_trial_id, "promotion_trial_id");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const waveId = assertIdentifier(input.wave_id, "wave_id");
  const testerId = assertIdentifier(input.tester_id, "tester_id");
  const testerVersion = assertIdentifier(input.tester_version, "tester_version");
  const taskSetupRevision = assertIdentifier(input.task_setup_revision, "task_setup_revision");
  const fields = [
    "tester_definition_sha256",
    "harness_sha256",
    "case_manifest_sha256",
    "seed_manifest_sha256",
    "matching_baseline_artifact_sha256",
    "finalist_artifact_sha256",
    "model_assignment_sha256",
  ] as const;
  for (const field of fields) assertSha256(input[field], field);
  const inputDistributionSha256 = assertSha256(
    input.input_distribution_sha256,
    "input_distribution_sha256",
  );
  if (input.matching_baseline_artifact_sha256 === input.finalist_artifact_sha256)
    failA1("MATCHING_BASELINE_REQUIRED", "matching baseline and finalist artifacts must differ");
  const definitionPath = testerDefinitionPath(input.project_root, testerId, testerVersion);
  if (!fs.existsSync(definitionPath))
    failA1("TESTER_DEFINITION_NOT_FOUND", `tester definition does not exist at ${definitionPath}`);
  const definition = validateTesterDefinition(readStateFile(definitionPath));
  if (
    definition.tester_id !== testerId ||
    definition.version !== testerVersion ||
    definition.definition_sha256 !== input.tester_definition_sha256 ||
    definition.harness_sha256 !== input.harness_sha256 ||
    definition.case_manifest_sha256 !== input.case_manifest_sha256 ||
    definition.seed_manifest_sha256 !== input.seed_manifest_sha256
  )
    failA1(
      "IDENTITY_MISMATCH",
      "promotion reservation does not match the sealed tester definition",
    );
  if (
    input.judge_binding_id !== undefined &&
    input.judge_binding_id !== null &&
    input.judge_binding === undefined
  )
    failA1(
      "JUDGE_BINDING_REQUIRED",
      "a judge binding id cannot replace the setup-selected judge facts",
    );
  const binding = resolveJudgeBinding(
    definition,
    input.judge_binding,
    taskSetupRevision,
    input.matching_baseline_artifact_sha256,
    input.finalist_artifact_sha256,
    "promotion.judge_binding",
  );
  if (
    input.judge_binding_id !== undefined &&
    input.judge_binding_id !== null &&
    input.judge_binding_id !== judgeBindingId(binding)
  )
    failA1("IDENTITY_MISMATCH", "judge_binding_id does not match the frozen judge binding");
  const filePath = testerTrialLedgerPath(input.project_root, taskId);
  return withStateFileLock(filePath, () => {
    const ledger = loadLedger(input.project_root, taskId);
    const existing = ledger.test_trials.find(
      (testTrial) => testTrial.promotion_trial_id === trialId,
    );
    if (existing) {
      const same =
        existing.outer_run_id === outerRunId &&
        existing.wave_id === waveId &&
        existing.tester_id === testerId &&
        existing.tester_version === testerVersion &&
        existing.tester_definition_sha256 === input.tester_definition_sha256 &&
        existing.harness_sha256 === input.harness_sha256 &&
        existing.task_setup_revision === taskSetupRevision &&
        existing.case_manifest_sha256 === input.case_manifest_sha256 &&
        existing.seed_manifest_sha256 === input.seed_manifest_sha256 &&
        existing.finalist_artifact_sha256 === input.finalist_artifact_sha256 &&
        existing.matching_baseline_artifact_sha256 === input.matching_baseline_artifact_sha256 &&
        existing.model_assignment_sha256 === input.model_assignment_sha256 &&
        existing.input_distribution_sha256 === inputDistributionSha256 &&
        existing.judge_binding_id === judgeBindingId(binding) &&
        sameJson(existing.judge_binding, binding);
      if (!same)
        failA1("TESTER_TRIAL_CONFLICT", `promotion trial '${trialId}' has different semantics`);
      return existing;
    }
    const now = new Date().toISOString();
    const testTrial: TesterTrialRecord = {
      promotion_trial_id: trialId,
      status: "reserved",
      outer_run_id: outerRunId,
      wave_id: waveId,
      tester_id: testerId,
      tester_version: testerVersion,
      tester_definition_sha256: input.tester_definition_sha256,
      harness_sha256: input.harness_sha256,
      task_setup_revision: taskSetupRevision,
      case_manifest_sha256: input.case_manifest_sha256,
      seed_manifest_sha256: input.seed_manifest_sha256,
      matching_baseline_artifact_sha256: input.matching_baseline_artifact_sha256,
      finalist_artifact_sha256: input.finalist_artifact_sha256,
      model_assignment_sha256: input.model_assignment_sha256,
      input_distribution_sha256: inputDistributionSha256,
      judge_binding_id: judgeBindingId(binding),
      judge_binding: binding,
      tester_run_id: null,
      tester_started: false,
      test_result_sha256: null,
      feedback_event_id: null,
      reserved_at: now,
      settled_at: null,
      released_at: null,
    };
    ledger.test_trials.push(testTrial);
    writeLedger(filePath, ledger);
    return testTrial;
  });
}

function updateTesterTrial(
  projectRoot: string,
  taskId: string,
  trialId: string,
  update: (testTrial: TesterTrialRecord, ledger: TesterTrialLedger) => void,
): TesterTrialRecord {
  const filePath = testerTrialLedgerPath(projectRoot, taskId);
  return withStateFileLock(filePath, () => {
    const ledger = loadLedger(projectRoot, taskId);
    const testTrial = ledger.test_trials.find(
      (candidate) => candidate.promotion_trial_id === trialId,
    );
    if (!testTrial)
      failA1("TESTER_TRIAL_NOT_FOUND", `promotion trial '${trialId}' is not reserved`);
    update(testTrial, ledger);
    writeLedger(filePath, ledger);
    return testTrial;
  });
}

export function markTesterStarted(
  projectRoot: string,
  taskId: string,
  trialId: string,
): TesterTrialRecord {
  return updateTesterTrial(projectRoot, taskId, trialId, (testTrial) => {
    if (testTrial.status === "released")
      failA1("TESTER_TRIAL_TERMINAL", "tester cannot start after testTrial is released");
    if (
      testTrial.status === "settled" &&
      !testTrial.tester_started &&
      testTrial.test_result_sha256 === null &&
      testTrial.feedback_event_id === null
    )
      failA1("TESTER_TRIAL_TERMINAL", "tester cannot start an untouched settled testTrial");
    markTrialObserved(testTrial);
  });
}

export function sealTesterResult(
  projectRoot: string,
  taskId: string,
  trialId: string,
  testResultSha256: string,
): TesterTrialRecord {
  const resultHash = assertSha256(testResultSha256, "test_result_sha256");
  return updateTesterTrial(projectRoot, taskId, trialId, (testTrial) => {
    if (testTrial.status === "released")
      failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot receive a test result");
    if (!testTrial.tester_started)
      failA1("TESTER_TRIAL_STATE_ORDER", "test result requires a started tester");
    if (testTrial.test_result_sha256 !== null && testTrial.test_result_sha256 !== resultHash)
      failA1("TESTER_TRIAL_CONFLICT", "test result for a trial cannot change");
    testTrial.test_result_sha256 = resultHash;
  });
}

export function recordTesterFeedbackEvent(
  projectRoot: string,
  taskId: string,
  trialId: string,
  feedbackEventId: string,
): TesterTrialRecord {
  const eventId = assertIdentifier(feedbackEventId, "feedback_event_id");
  return updateTesterTrial(projectRoot, taskId, trialId, (testTrial) => {
    if (testTrial.status === "released")
      failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot receive feedback");
    if (testTrial.feedback_event_id !== null && testTrial.feedback_event_id !== eventId)
      failA1("TESTER_TRIAL_CONFLICT", "feedback event for a trial cannot change");
    if (!testTrial.tester_started && testTrial.test_result_sha256 === null)
      failA1("TESTER_TRIAL_STATE_ORDER", "feedback requires an observed tester trial");
    testTrial.feedback_event_id = eventId;
  });
}

export function settleTesterTrial(
  projectRoot: string,
  taskId: string,
  trialId: string,
): TesterTrialRecord {
  return updateTesterTrial(projectRoot, taskId, trialId, (testTrial) => {
    if (testTrial.status === "settled") return;
    if (testTrial.status === "released")
      failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot be settled");
    if (
      !testTrial.tester_started &&
      testTrial.test_result_sha256 === null &&
      testTrial.feedback_event_id === null
    )
      failA1(
        "TESTER_TRIAL_STATE_ORDER",
        "an untouched reservation cannot be settled without a tester result or feedback event",
      );
    testTrial.status = "settled";
    testTrial.settled_at = new Date().toISOString();
  });
}

export function releaseTesterTrial(
  projectRoot: string,
  taskId: string,
  trialId: string,
  parentWaveStatus: "failed_irrecoverable" | "abandoned",
): TesterTrialRecord {
  return updateTesterTrial(projectRoot, taskId, trialId, (testTrial) => {
    if (testTrial.status === "released") return;
    if (testTrial.status === "settled")
      failA1("TESTER_TRIAL_TERMINAL", "settled testTrial cannot be released");
    if (
      testTrial.tester_started ||
      testTrial.test_result_sha256 !== null ||
      testTrial.feedback_event_id !== null
    )
      failA1(
        "TESTER_TRIAL_RELEASE_FORBIDDEN",
        "started or observed tester trials must settle, never release",
      );
    if (parentWaveStatus !== "failed_irrecoverable" && parentWaveStatus !== "abandoned")
      failA1(
        "TESTER_TRIAL_RELEASE_FORBIDDEN",
        "only an irrecoverable parent wave or explicit abandonment can release a reservation",
      );
    testTrial.status = "released";
    testTrial.released_at = new Date().toISOString();
  });
}

export function recoverTesterTrialLedger(input: {
  project_root: string;
  task_id: string;
  trials: ReadonlyMap<
    string,
    {
      tester_started: boolean;
      test_result_sha256: string | null;
      feedback_event_id: string | null;
      parent_wave_status:
        | "running"
        | "retryable_infra_failure"
        | "failed_irrecoverable"
        | "abandoned";
    }
  >;
}): TesterTrialLedger {
  const filePath = testerTrialLedgerPath(input.project_root, input.task_id);
  return withStateFileLock(filePath, () => {
    const ledger = loadLedger(input.project_root, input.task_id);
    for (const testTrial of ledger.test_trials) {
      const trial = input.trials.get(testTrial.promotion_trial_id);
      if (!trial) continue;
      if (testTrial.status === "released") {
        if (
          trial.tester_started ||
          trial.test_result_sha256 !== null ||
          trial.feedback_event_id !== null
        )
          failA1("TESTER_TRIAL_CONFLICT", "released testTrial has observed trial facts");
        continue;
      }
      if (trial.test_result_sha256 !== null && testTrial.test_result_sha256 === null)
        testTrial.test_result_sha256 = assertSha256(
          trial.test_result_sha256,
          "trial.test_result_sha256",
        );
      if (
        trial.test_result_sha256 !== null &&
        testTrial.test_result_sha256 !== null &&
        testTrial.test_result_sha256 !== trial.test_result_sha256
      )
        failA1(
          "TESTER_TRIAL_CONFLICT",
          "recovery found a different test result for the same trial",
        );
      if (trial.feedback_event_id !== null && testTrial.feedback_event_id === null)
        testTrial.feedback_event_id = assertIdentifier(
          trial.feedback_event_id,
          "trial.feedback_event_id",
        );
      if (
        trial.feedback_event_id !== null &&
        testTrial.feedback_event_id !== null &&
        testTrial.feedback_event_id !== trial.feedback_event_id
      )
        failA1(
          "TESTER_TRIAL_CONFLICT",
          "recovery found a different feedback event for the same trial",
        );
      testTrial.tester_started = testTrial.tester_started || trial.tester_started;
      if (
        testTrial.tester_started ||
        testTrial.test_result_sha256 !== null ||
        testTrial.feedback_event_id !== null
      ) {
        testTrial.status = "settled";
        testTrial.settled_at ??= new Date().toISOString();
      } else if (
        trial.parent_wave_status === "failed_irrecoverable" ||
        trial.parent_wave_status === "abandoned"
      ) {
        testTrial.status = "released";
        testTrial.released_at ??= new Date().toISOString();
      }
    }
    writeLedger(filePath, ledger);
    return ledger;
  });
}

export function saveResultReference(
  projectRoot: string,
  testerRunId: string,
  testResultSha256: string,
): string {
  const hash = assertSha256(testResultSha256, "test_result_sha256");
  const filePath = path.join(testerRunDirectory(projectRoot, testerRunId), "test-result.ref.json");
  withStateFileLock(filePath, () => {
    const reference = {
      schema_version: 1,
      test_result_id: `test-result:sha256:${hash}`,
      test_result_sha256: hash,
    };
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (!isRecord(existing))
        failA1("CORRUPT_TEST_RESULT_REF", "test result reference must be an object", filePath);
      const allowed = ["schema_version", "test_result_id", "test_result_sha256"];
      for (const key of Object.keys(existing))
        if (!allowed.includes(key))
          failA1("CORRUPT_TEST_RESULT_REF", `unknown test result field '${key}'`, filePath);
      if (
        existing.schema_version !== 1 ||
        existing.test_result_id !== reference.test_result_id ||
        existing.test_result_sha256 !== reference.test_result_sha256
      )
        failA1("IMMUTABLE_CONFLICT", "test result reference cannot change", filePath);
      assertIdentifier(existing.test_result_id, `${filePath}.test_result_id`);
      assertSha256(existing.test_result_sha256, `${filePath}.test_result_sha256`);
      return;
    }
    writeStateJsonAtomic(filePath, reference);
  });
  return filePath;
}

function testResultReferencePath(projectRoot: string, testerRunId: string): string {
  return path.join(testerRunDirectory(projectRoot, testerRunId), "test-result.ref.json");
}

function validateTestResultReference(value: unknown, expectedHash: string, filePath: string): void {
  if (!isRecord(value))
    failA1("CORRUPT_TEST_RESULT_REF", "test result reference must be an object", filePath);
  const allowed = ["schema_version", "test_result_id", "test_result_sha256"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_TEST_RESULT_REF", `unknown test result field '${key}'`, filePath);
  if (
    value.schema_version !== 1 ||
    value.test_result_id !== `test-result:sha256:${expectedHash}` ||
    value.test_result_sha256 !== expectedHash
  )
    failA1(
      "TEST_RESULT_HASH_MISMATCH",
      "test result reference does not match the bundle",
      filePath,
    );
  assertIdentifier(value.test_result_id, `${filePath}.test_result_id`);
  assertSha256(value.test_result_sha256, `${filePath}.test_result_sha256`);
}

export function readStoredTesterResult(
  projectRoot: string,
  testerRunId: string,
): TesterResultBundle {
  const state = readTesterState(projectRoot, assertIdentifier(testerRunId, "tester_run_id"));
  if (state.test_result_sha256 === null)
    failA1("TEST_RESULT_NOT_SEALED", "tester run has no sealed test result");
  if (
    state.status !== "sealed" &&
    state.status !== "reviewed" &&
    state.status !== "passed" &&
    state.status !== "rejected"
  )
    failA1("TEST_RESULT_NOT_SEALED", "test result cannot be consumed before sealing");
  const definition = readTesterDefinitionForRun(projectRoot, state);
  const filePath = testerResultPath(projectRoot, state.tester_run_id);
  if (!fs.existsSync(filePath))
    failA1("TEST_RESULT_NOT_FOUND", `test result does not exist at ${filePath}`);
  let bundle: TesterResultBundle;
  try {
    bundle = normalizeTestResult(readStateFile(filePath), state, definition, false);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "AGGREGATE_MISMATCH" || code === "PRIMARY_SCORE_MISMATCH")
      failA1("TEST_RESULT_HASH_MISMATCH", "stored test result differs from tester state");
    throw error;
  }
  const hash = testerResultSha256(bundle);
  if (hash !== state.test_result_sha256)
    failA1("TEST_RESULT_HASH_MISMATCH", "stored test result differs from tester state");
  const referencePath = testResultReferencePath(projectRoot, state.tester_run_id);
  if (fs.existsSync(referencePath))
    validateTestResultReference(readStateFile(referencePath), hash, referencePath);
  return bundle;
}

function testerDashboardValue(state: TesterRunState): Record<string, unknown> {
  const hashes: Record<string, string> = {
    input_snapshot_sha256: state.input_snapshot_sha256,
    case_manifest_sha256: state.case_manifest_sha256,
    seed_manifest_sha256: state.seed_manifest_sha256,
    harness_sha256: state.harness_sha256,
    matching_baseline_artifact_sha256: state.matching_baseline_artifact_sha256,
    finalist_artifact_sha256: state.finalist_artifact_sha256,
    model_assignment_sha256: state.model_assignment_sha256,
  };
  if (state.input_distribution_sha256 !== null)
    hashes.input_distribution_sha256 = state.input_distribution_sha256;
  if (state.test_result_sha256 !== null) hashes.test_result_sha256 = state.test_result_sha256;
  if (state.judge_binding_id !== null) hashes.judge_binding_id = state.judge_binding_id;
  return {
    schema_version: 1,
    run_id: state.run_id,
    tester_run_id: state.tester_run_id,
    phase: state.status,
    status: state.status,
    attempt: state.attempt,
    arms: {
      matching_baseline: { status: state.status },
      finalist: { status: state.status },
    },
    hashes,
    review: { review_id: state.review_id },
    gate: { consumed: state.gate_consumed, status: state.gate_status },
    updated_at: state.updated_at,
  };
}

function writeTesterDashboard(projectRoot: string, state: TesterRunState): void {
  writeStateJsonAtomic(
    testerDashboardPath(projectRoot, state.tester_run_id),
    testerDashboardValue(state),
  );
}

export function startTesterRun(input: {
  project_root: string;
  tester_run_id: string;
  task_id: string;
  outer_run_id: string;
  outer_iteration: number;
  wave_id: string;
  wave_kind: "module" | "structure";
  generation: number;
  promotion_trial_id: string;
  tester: TesterDefinition;
  task_setup_revision: string;
  input_snapshot_sha256: string;
  harness_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  model_assignment_sha256: string;
  input_distribution_sha256: string;
  judge_binding?: TesterJudgeBinding | null;
  /** Kept only to reject stale callers that still try to provide an id alone. */
  judge_binding_id?: string | null;
}): TesterRunState {
  const testerRunId = assertIdentifier(input.tester_run_id, "tester_run_id");
  const contract = requireRunContract(input.project_root, testerRunId);
  const parent = requireRunContract(input.project_root, input.outer_run_id);
  if (parent.depth !== 0 || parent.parent_run_id !== null)
    failA1("TESTER_ROOT_ONLY", "only the root run may create a tester");
  if (contract.parent_run_id !== parent.run_id || !parent.child_run_ids.includes(testerRunId))
    failA1("IDENTITY_MISMATCH", "tester must be registered under its root contract");
  const filePath = testerRunStatePath(input.project_root, testerRunId);
  const taskId = assertIdentifier(input.task_id, "task_id");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const waveId = assertIdentifier(input.wave_id, "wave_id");
  const trialId = assertIdentifier(input.promotion_trial_id, "promotion_trial_id");
  const tester = validateTesterDefinition(input.tester);
  const taskSetupRevision = assertIdentifier(input.task_setup_revision, "task_setup_revision");
  const inputSnapshotSha256 = assertSha256(input.input_snapshot_sha256, "input_snapshot_sha256");
  const requestedHarnessSha256 = assertSha256(input.harness_sha256, "harness_sha256");
  if (requestedHarnessSha256 !== tester.harness_sha256)
    failA1("HARNESS_MISMATCH", "tester run harness does not match its definition");
  const baselineHash = assertSha256(
    input.matching_baseline_artifact_sha256,
    "matching_baseline_artifact_sha256",
  );
  const finalistHash = assertSha256(input.finalist_artifact_sha256, "finalist_artifact_sha256");
  const assignmentHash = assertSha256(input.model_assignment_sha256, "model_assignment_sha256");
  const requestedInputDistributionSha256 = assertSha256(
    input.input_distribution_sha256,
    "input_distribution_sha256",
  );
  if (input.wave_kind !== "module" && input.wave_kind !== "structure")
    failA1("CORRUPT_TESTER_STATE", "invalid tester wave kind");
  const outerIteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
  const generation = requireInteger(input.generation, "generation", 1);
  if (
    input.judge_binding_id !== undefined &&
    input.judge_binding_id !== null &&
    input.judge_binding === undefined
  )
    failA1(
      "JUDGE_BINDING_REQUIRED",
      "a judge binding id cannot replace the setup-selected judge facts",
    );
  const requestedJudgeBinding = resolveJudgeBinding(
    tester,
    input.judge_binding,
    taskSetupRevision,
    baselineHash,
    finalistHash,
    "tester.judge_binding",
  );
  if (
    input.judge_binding_id !== undefined &&
    input.judge_binding_id !== null &&
    input.judge_binding_id !== judgeBindingId(requestedJudgeBinding)
  )
    failA1("IDENTITY_MISMATCH", "judge_binding_id does not match the frozen judge binding");
  const ledgerFile = testerTrialLedgerPath(input.project_root, taskId);
  return withStateFileLock(ledgerFile, () =>
    withStateFileLock(filePath, () => {
      const ledger = loadLedger(input.project_root, taskId);
      const testTrial = ledger.test_trials.find(
        (candidate) => candidate.promotion_trial_id === trialId,
      );
      if (!testTrial) failA1("TESTER_TRIAL_NOT_RESERVED", "tester run needs a reserved testTrial");
      if (
        testTrial.outer_run_id !== outerRunId ||
        testTrial.wave_id !== waveId ||
        testTrial.tester_id !== tester.tester_id ||
        testTrial.tester_version !== tester.version ||
        testTrial.tester_definition_sha256 !== tester.definition_sha256 ||
        testTrial.harness_sha256 !== requestedHarnessSha256 ||
        testTrial.task_setup_revision !== taskSetupRevision ||
        testTrial.case_manifest_sha256 !== tester.case_manifest_sha256 ||
        testTrial.seed_manifest_sha256 !== tester.seed_manifest_sha256 ||
        testTrial.finalist_artifact_sha256 !== finalistHash ||
        testTrial.matching_baseline_artifact_sha256 !== baselineHash ||
        testTrial.model_assignment_sha256 !== assignmentHash ||
        testTrial.input_distribution_sha256 !== requestedInputDistributionSha256 ||
        testTrial.judge_binding_id !== judgeBindingId(requestedJudgeBinding) ||
        !sameJson(testTrial.judge_binding, requestedJudgeBinding)
      )
        failA1("IDENTITY_MISMATCH", "tester run does not match its frozen testTrial reservation");
      const frozenInputDistributionSha256 = testTrial.input_distribution_sha256;
      const frozenJudgeBinding = testTrial.judge_binding;
      if (fs.existsSync(filePath)) {
        const existing = validateTesterRunState(readStateFile(filePath), testerRunId, filePath);
        if (
          existing.task_id !== taskId ||
          existing.outer_run_id !== outerRunId ||
          existing.outer_iteration !== outerIteration ||
          existing.wave_id !== waveId ||
          existing.wave_kind !== input.wave_kind ||
          existing.generation !== generation ||
          existing.promotion_trial_id !== trialId ||
          existing.tester_id !== tester.tester_id ||
          existing.tester_version !== tester.version ||
          existing.harness_sha256 !== requestedHarnessSha256 ||
          existing.task_setup_revision !== taskSetupRevision ||
          existing.input_snapshot_sha256 !== inputSnapshotSha256 ||
          existing.input_distribution_sha256 !== frozenInputDistributionSha256 ||
          existing.judge_binding_id !== judgeBindingId(frozenJudgeBinding) ||
          !sameJson(existing.judge_binding, frozenJudgeBinding) ||
          existing.case_manifest_sha256 !== tester.case_manifest_sha256 ||
          existing.seed_manifest_sha256 !== tester.seed_manifest_sha256 ||
          existing.matching_baseline_artifact_sha256 !== baselineHash ||
          existing.finalist_artifact_sha256 !== finalistHash ||
          existing.model_assignment_sha256 !== assignmentHash
        )
          failA1("IDENTITY_MISMATCH", "tester run retry changed its frozen identity");
        bindTesterRun(testTrial, testerRunId, frozenInputDistributionSha256, frozenJudgeBinding);
        writeLedger(ledgerFile, ledger);
        sealWikiWorkerManifest({
          project_root: input.project_root,
          run_id: testerRunId,
          worker: "tester",
          input_snapshot:
            requireRunContract(input.project_root, testerRunId).parent_run_id === null
              ? null
              : {
                  ref: runOwnedPath(input.project_root, testerRunId, "input-snapshot.json"),
                  sha256: crypto
                    .createHash("sha256")
                    .update(
                      fs.readFileSync(
                        runOwnedPath(input.project_root, testerRunId, "input-snapshot.json"),
                      ),
                    )
                    .digest("hex"),
                },
        });
        writeTesterDashboard(input.project_root, existing);
        return existing;
      }
      if (testTrial.status !== "reserved")
        failA1("TESTER_TRIAL_NOT_RESERVED", "tester run needs a reserved testTrial");
      const now = new Date().toISOString();
      const state: TesterRunState = {
        schema_version: 1,
        run_id: testerRunId,
        tester_run_id: testerRunId,
        task_id: taskId,
        outer_run_id: outerRunId,
        outer_iteration: outerIteration,
        wave_id: waveId,
        wave_kind: input.wave_kind,
        generation,
        promotion_trial_id: trialId,
        tester_id: tester.tester_id,
        tester_version: tester.version,
        tester_definition_sha256: tester.definition_sha256,
        harness_sha256: requestedHarnessSha256,
        task_setup_revision: taskSetupRevision,
        input_snapshot_sha256: inputSnapshotSha256,
        input_distribution_sha256: frozenInputDistributionSha256,
        judge_binding_id: judgeBindingId(frozenJudgeBinding),
        judge_binding: frozenJudgeBinding,
        case_manifest_sha256: tester.case_manifest_sha256,
        seed_manifest_sha256: tester.seed_manifest_sha256,
        matching_baseline_artifact_sha256: baselineHash,
        finalist_artifact_sha256: finalistHash,
        model_assignment_sha256: assignmentHash,
        status: "queued",
        attempt: 0,
        test_result_sha256: null,
        review_id: null,
        reviewer_worker_id: null,
        review_receipt_sha256: null,
        gate_consumed: false,
        gate_status: null,
        updated_at: now,
      };
      bindTesterRun(testTrial, testerRunId, frozenInputDistributionSha256, frozenJudgeBinding);
      writeLedger(ledgerFile, ledger);
      sealWikiWorkerManifest({
        project_root: input.project_root,
        run_id: testerRunId,
        worker: "tester",
        input_snapshot:
          requireRunContract(input.project_root, testerRunId).parent_run_id === null
            ? null
            : {
                ref: runOwnedPath(input.project_root, testerRunId, "input-snapshot.json"),
                sha256: crypto
                  .createHash("sha256")
                  .update(
                    fs.readFileSync(
                      runOwnedPath(input.project_root, testerRunId, "input-snapshot.json"),
                    ),
                  )
                  .digest("hex"),
              },
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeStateJsonAtomic(filePath, state);
      writeTesterDashboard(input.project_root, state);
      return state;
    }),
  );
}

function testerTransitionAllowed(current: TesterRunStatus, next: TesterRunStatus): boolean {
  const transitions: Readonly<Record<TesterRunStatus, readonly TesterRunStatus[]>> = {
    queued: ["running"],
    running: ["sealed", "retryable_infra_failure"],
    retryable_infra_failure: ["running"],
    sealed: ["reviewed"],
    reviewed: ["passed", "rejected"],
    passed: [],
    rejected: [],
  };
  return transitions[current].includes(next);
}

function writeTesterStateAndDashboard(
  projectRoot: string,
  statePath: string,
  state: TesterRunState,
): void {
  writeStateJsonAtomic(statePath, state);
  writeTesterDashboard(projectRoot, state);
}

function assertTrialMatchesState(testTrial: TesterTrialRecord, state: TesterRunState): void {
  if (
    testTrial.promotion_trial_id !== state.promotion_trial_id ||
    testTrial.outer_run_id !== state.outer_run_id ||
    testTrial.wave_id !== state.wave_id ||
    testTrial.tester_id !== state.tester_id ||
    testTrial.tester_version !== state.tester_version ||
    testTrial.tester_definition_sha256 !== state.tester_definition_sha256 ||
    testTrial.harness_sha256 !== state.harness_sha256 ||
    testTrial.task_setup_revision !== state.task_setup_revision ||
    testTrial.case_manifest_sha256 !== state.case_manifest_sha256 ||
    testTrial.seed_manifest_sha256 !== state.seed_manifest_sha256 ||
    testTrial.matching_baseline_artifact_sha256 !== state.matching_baseline_artifact_sha256 ||
    testTrial.finalist_artifact_sha256 !== state.finalist_artifact_sha256 ||
    testTrial.model_assignment_sha256 !== state.model_assignment_sha256 ||
    testTrial.input_distribution_sha256 !== state.input_distribution_sha256 ||
    testTrial.judge_binding_id !== state.judge_binding_id ||
    !sameJson(testTrial.judge_binding, state.judge_binding)
  )
    failA1("IDENTITY_MISMATCH", "tester testTrial does not match its run state");
  if (testTrial.tester_run_id !== null && testTrial.tester_run_id !== state.tester_run_id)
    failA1("TESTER_ONCE_PER_WAVE", "tester testTrial is bound to another run");
}

function validateTesterRunState(
  value: unknown,
  testerRunId: string,
  filePath: string,
): TesterRunState {
  if (!isRecord(value)) failA1("CORRUPT_TESTER_STATE", "tester state must be an object", filePath);
  const allowed = [
    "schema_version",
    "run_id",
    "tester_run_id",
    "task_id",
    "outer_run_id",
    "outer_iteration",
    "wave_id",
    "wave_kind",
    "generation",
    "promotion_trial_id",
    "tester_id",
    "tester_version",
    "tester_definition_sha256",
    "harness_sha256",
    "task_setup_revision",
    "input_snapshot_sha256",
    "input_distribution_sha256",
    "judge_binding_id",
    "judge_binding",
    "case_manifest_sha256",
    "seed_manifest_sha256",
    "matching_baseline_artifact_sha256",
    "finalist_artifact_sha256",
    "model_assignment_sha256",
    "status",
    "attempt",
    "test_result_sha256",
    "review_id",
    "reviewer_worker_id",
    "review_receipt_sha256",
    "gate_consumed",
    "gate_status",
    "updated_at",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown tester state field '${key}'`, filePath);
  if (
    value.schema_version !== 1 ||
    value.run_id !== testerRunId ||
    value.tester_run_id !== testerRunId
  )
    failA1("IDENTITY_MISMATCH", "tester state and path ids differ", filePath);
  const statuses: TesterRunStatus[] = [
    "queued",
    "running",
    "sealed",
    "reviewed",
    "passed",
    "rejected",
    "retryable_infra_failure",
  ];
  if (typeof value.status !== "string" || !statuses.includes(value.status as TesterRunStatus))
    failA1("CORRUPT_TESTER_STATE", "invalid tester state status", filePath);
  if (value.wave_kind !== "module" && value.wave_kind !== "structure")
    failA1("CORRUPT_TESTER_STATE", "invalid tester wave kind", filePath);
  if (
    value.gate_status !== null &&
    value.gate_status !== "passed" &&
    value.gate_status !== "rejected"
  )
    failA1("CORRUPT_TESTER_STATE", "invalid tester gate status", filePath);
  const state: TesterRunState = {
    schema_version: 1,
    run_id: testerRunId,
    tester_run_id: testerRunId,
    task_id: assertIdentifier(value.task_id, `${filePath}.task_id`),
    outer_run_id: assertIdentifier(value.outer_run_id, `${filePath}.outer_run_id`),
    outer_iteration: requireInteger(value.outer_iteration, `${filePath}.outer_iteration`, 1),
    wave_id: assertIdentifier(value.wave_id, `${filePath}.wave_id`),
    wave_kind: value.wave_kind,
    generation: requireInteger(value.generation, `${filePath}.generation`, 1),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      `${filePath}.promotion_trial_id`,
    ),
    tester_id: assertIdentifier(value.tester_id, `${filePath}.tester_id`),
    tester_version: assertIdentifier(value.tester_version, `${filePath}.tester_version`),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      `${filePath}.tester_definition_sha256`,
    ),
    harness_sha256: assertSha256(value.harness_sha256, `${filePath}.harness_sha256`),
    task_setup_revision: assertIdentifier(
      value.task_setup_revision,
      `${filePath}.task_setup_revision`,
    ),
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      `${filePath}.input_snapshot_sha256`,
    ),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      `${filePath}.input_distribution_sha256`,
    ),
    judge_binding_id:
      value.judge_binding_id === undefined || value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, `${filePath}.judge_binding_id`),
    judge_binding:
      value.judge_binding === null
        ? null
        : validateJudgeBindingShape(value.judge_binding, `${filePath}.judge_binding`),
    case_manifest_sha256: assertSha256(
      value.case_manifest_sha256,
      `${filePath}.case_manifest_sha256`,
    ),
    seed_manifest_sha256: assertSha256(
      value.seed_manifest_sha256,
      `${filePath}.seed_manifest_sha256`,
    ),
    matching_baseline_artifact_sha256: assertSha256(
      value.matching_baseline_artifact_sha256,
      `${filePath}.matching_baseline_artifact_sha256`,
    ),
    finalist_artifact_sha256: assertSha256(
      value.finalist_artifact_sha256,
      `${filePath}.finalist_artifact_sha256`,
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      `${filePath}.model_assignment_sha256`,
    ),
    status: value.status as TesterRunStatus,
    attempt: requireInteger(value.attempt, `${filePath}.attempt`, 0),
    test_result_sha256:
      value.test_result_sha256 === null
        ? null
        : assertSha256(value.test_result_sha256, `${filePath}.test_result_sha256`),
    review_id:
      value.review_id === null ? null : assertIdentifier(value.review_id, `${filePath}.review_id`),
    reviewer_worker_id:
      value.reviewer_worker_id === null
        ? null
        : assertIdentifier(value.reviewer_worker_id, `${filePath}.reviewer_worker_id`),
    review_receipt_sha256:
      value.review_receipt_sha256 === null
        ? null
        : assertSha256(value.review_receipt_sha256, `${filePath}.review_receipt_sha256`),
    gate_consumed: requireBoolean(value.gate_consumed, `${filePath}.gate_consumed`),
    gate_status: value.gate_status,
    updated_at: requireString(value.updated_at, `${filePath}.updated_at`),
  };
  if (state.gate_consumed !== (state.gate_status !== null))
    failA1("CORRUPT_TESTER_STATE", "gate status and gate_consumed disagree", filePath);
  if ((state.status === "passed" || state.status === "rejected") && !state.gate_consumed)
    failA1("CORRUPT_TESTER_STATE", "terminal tester state must have consumed the gate", filePath);
  if (
    (state.status === "sealed" ||
      state.status === "reviewed" ||
      state.status === "passed" ||
      state.status === "rejected") &&
    state.test_result_sha256 === null
  )
    failA1("CORRUPT_TESTER_STATE", "sealed or terminal tester state needs a test result", filePath);
  if (
    (state.status === "reviewed" || state.status === "passed" || state.status === "rejected") &&
    state.review_id === null
  )
    failA1("CORRUPT_TESTER_STATE", "reviewed or terminal tester state needs a review", filePath);
  if (state.judge_binding_id !== judgeBindingId(state.judge_binding))
    failA1("CORRUPT_TESTER_STATE", "judge binding id does not match its frozen binding", filePath);
  if ((state.review_id === null) !== (state.reviewer_worker_id === null))
    failA1("CORRUPT_TESTER_STATE", "tester review identity is incomplete", filePath);
  if ((state.review_id === null) !== (state.review_receipt_sha256 === null))
    failA1("CORRUPT_TESTER_STATE", "tester review hash is incomplete", filePath);
  if (
    (state.status === "queued" ||
      state.status === "running" ||
      state.status === "sealed" ||
      state.status === "retryable_infra_failure") &&
    state.gate_consumed
  )
    failA1("CORRUPT_TESTER_STATE", "non-terminal tester state cannot consume the gate", filePath);
  return state;
}

function readTesterState(projectRoot: string, testerRunId: string): TesterRunState {
  const filePath = testerRunStatePath(projectRoot, testerRunId);
  if (!fs.existsSync(filePath)) failA1("TESTER_RUN_NOT_FOUND", `no tester run at ${filePath}`);
  return validateTesterRunState(readStateFile(filePath), testerRunId, filePath);
}

export function readTesterRunState(projectRoot: string, testerRunId: string): TesterRunState {
  return readTesterState(projectRoot, assertIdentifier(testerRunId, "tester_run_id"));
}

export function transitionTesterState(
  projectRoot: string,
  testerRunId: string,
  nextStatus: TesterRunStatus,
): TesterRunState {
  const filePath = testerRunStatePath(projectRoot, testerRunId);
  const validStatuses: readonly TesterRunStatus[] = [
    "queued",
    "running",
    "sealed",
    "reviewed",
    "passed",
    "rejected",
    "retryable_infra_failure",
  ];
  if (!validStatuses.includes(nextStatus))
    failA1("CORRUPT_TESTER_STATE", `invalid tester next status '${nextStatus}'`);

  function transition(state: TesterRunState): TesterRunState {
    if (state.status === nextStatus) {
      writeTesterDashboard(projectRoot, state);
      return state;
    }
    if (!testerTransitionAllowed(state.status, nextStatus))
      failA1(
        "TESTER_STATE_ORDER",
        `cannot transition tester from '${state.status}' to '${nextStatus}'`,
      );
    if (nextStatus === "passed" || nextStatus === "rejected")
      failA1("TESTER_GATE_REQUIRED", "terminal tester state must be written by the promotion gate");
    if (nextStatus === "sealed" && state.test_result_sha256 === null)
      failA1("TESTER_STATE_ORDER", "sealed tester state requires a test result");
    if (nextStatus === "reviewed" && state.review_id === null)
      failA1("TESTER_STATE_ORDER", "reviewed tester state requires a review receipt");
    const next: TesterRunState = {
      ...state,
      status: nextStatus,
      attempt:
        nextStatus === "running" && state.status === "retryable_infra_failure"
          ? state.attempt + 1
          : state.attempt,
      updated_at: new Date().toISOString(),
    };
    writeTesterStateAndDashboard(projectRoot, filePath, next);
    return next;
  }

  if (nextStatus !== "running")
    return withStateFileLock(filePath, () => transition(readTesterState(projectRoot, testerRunId)));

  const current = readTesterState(projectRoot, testerRunId);
  const definition = readTesterDefinitionForRun(projectRoot, current);
  const ledgerFile = testerTrialLedgerPath(projectRoot, current.task_id);
  return withStateFileLock(ledgerFile, () =>
    withStateFileLock(filePath, () => {
      const state = readTesterState(projectRoot, testerRunId);
      const ledger = loadLedger(projectRoot, state.task_id);
      const testTrial = ledger.test_trials.find(
        (candidate) => candidate.promotion_trial_id === state.promotion_trial_id,
      );
      if (!testTrial) failA1("TESTER_TRIAL_NOT_FOUND", "tester run has no testTrial reservation");
      assertTrialMatchesState(testTrial, state);
      if (testTrial.status === "released")
        failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot start");
      bindTesterRun(
        testTrial,
        state.tester_run_id,
        state.input_distribution_sha256,
        state.judge_binding,
      );
      markTrialObserved(testTrial);
      writeLedger(ledgerFile, ledger);
      return transition(state);
    }),
  );
}

export function recordTesterStarted(projectRoot: string, testerRunId: string): TesterRunState {
  const state = readTesterState(projectRoot, testerRunId);
  if (
    state.status !== "queued" &&
    state.status !== "retryable_infra_failure" &&
    state.status !== "running"
  )
    failA1(
      "TESTER_STATE_ORDER",
      "tester can start only from queued or retryable infrastructure failure",
    );
  return transitionTesterState(projectRoot, testerRunId, "running");
}

function readTesterDefinitionForRun(projectRoot: string, state: TesterRunState): TesterDefinition {
  const definitionPath = testerDefinitionPath(projectRoot, state.tester_id, state.tester_version);
  if (!fs.existsSync(definitionPath))
    failA1("TESTER_DEFINITION_NOT_FOUND", `tester definition does not exist at ${definitionPath}`);
  const definition = readStateFile(definitionPath);
  const validated = validateTesterDefinition(definition);
  if (
    validated.tester_id !== state.tester_id ||
    validated.version !== state.tester_version ||
    validated.definition_sha256 !== state.tester_definition_sha256 ||
    validated.harness_sha256 !== state.harness_sha256 ||
    validated.case_manifest_sha256 !== state.case_manifest_sha256 ||
    validated.seed_manifest_sha256 !== state.seed_manifest_sha256
  )
    failA1("IDENTITY_MISMATCH", "tester run does not match its frozen tester definition");
  return validated;
}

export function recordTesterResult(
  projectRoot: string,
  testerRunId: string,
  testResultValue: unknown,
): TesterRunState {
  const statePath = testerRunStatePath(projectRoot, testerRunId);
  const current = readTesterState(projectRoot, testerRunId);
  const allowedStatuses: readonly TesterRunStatus[] = [
    "running",
    "sealed",
    "reviewed",
    "passed",
    "rejected",
  ];
  if (!allowedStatuses.includes(current.status))
    failA1("TESTER_STATE_ORDER", "test result requires an observed tester run");
  const definition = readTesterDefinitionForRun(projectRoot, current);
  const bundle = normalizeTestResult(testResultValue, current, definition, true);
  const hash = testerResultSha256(bundle);
  const ledgerPath = testerTrialLedgerPath(projectRoot, current.task_id);
  return withStateFileLock(ledgerPath, () =>
    withStateFileLock(statePath, () => {
      const state = readTesterState(projectRoot, testerRunId);
      if (!allowedStatuses.includes(state.status))
        failA1("TESTER_STATE_ORDER", "test result requires an observed tester run");
      const currentDefinition = readTesterDefinitionForRun(projectRoot, state);
      const normalizedBundle = normalizeTestResult(testResultValue, state, currentDefinition, true);
      const normalizedHash = testerResultSha256(normalizedBundle);
      if (normalizedHash !== hash)
        failA1("TEST_RESULT_CONFLICT", "test result changed while it was being sealed");
      if (state.test_result_sha256 !== null && state.test_result_sha256 !== hash)
        failA1("TEST_RESULT_CONFLICT", "test result for a tester run cannot change");
      const resultPath = testerResultPath(projectRoot, testerRunId);
      if (fs.existsSync(resultPath)) {
        const existingBundle = normalizeTestResult(
          readStateFile(resultPath),
          state,
          currentDefinition,
          false,
        );
        if (testerResultSha256(existingBundle) !== hash)
          failA1("TEST_RESULT_CONFLICT", "test result file cannot change", resultPath);
      } else {
        writeStateJsonAtomic(resultPath, normalizedBundle);
      }
      const ledger = loadLedger(projectRoot, state.task_id);
      const testTrial = ledger.test_trials.find(
        (candidate) => candidate.promotion_trial_id === state.promotion_trial_id,
      );
      if (!testTrial) failA1("TESTER_TRIAL_NOT_FOUND", "tester run has no testTrial reservation");
      assertTrialMatchesState(testTrial, state);
      if (testTrial.status === "released")
        failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot receive a test result");
      bindTesterRun(
        testTrial,
        state.tester_run_id,
        state.input_distribution_sha256,
        state.judge_binding,
      );
      markTrialObserved(testTrial);
      if (testTrial.test_result_sha256 !== null && testTrial.test_result_sha256 !== hash)
        failA1("TEST_RESULT_CONFLICT", "test result for a trial cannot change");
      testTrial.test_result_sha256 = hash;
      writeLedger(ledgerPath, ledger);
      saveResultReference(projectRoot, testerRunId, hash);
      if (state.status !== "running") {
        writeTesterDashboard(projectRoot, state);
        return state;
      }
      const next: TesterRunState = {
        ...state,
        status: "sealed",
        test_result_sha256: hash,
        updated_at: new Date().toISOString(),
      };
      writeTesterStateAndDashboard(projectRoot, statePath, next);
      return next;
    }),
  );
}

export function recordTesterReview(
  projectRoot: string,
  testerRunId: string,
  reviewValue: unknown,
): TesterRunState {
  const review = readStoredReviewReceipt(projectRoot, reviewValue);
  if (review.reviewed_run_kind !== "tester")
    failA1("REVIEW_TYPE_MISMATCH", "tester state accepts only tester receipts");
  if (review.verdict !== "approved")
    failA1("TESTER_REVIEW_REJECTED", "a tester gate needs an approved tester review");
  const testerRun = assertIdentifier(testerRunId, "tester_run_id");
  const testResult = readStoredTesterResult(projectRoot, testerRun);
  if (review.subject.test_result_sha256 !== testerResultSha256(testResult))
    failA1("TEST_RESULT_HASH_MISMATCH", "tester review does not identify the stored test result");
  if (testResult.tester_run_id !== testerRun)
    failA1("IDENTITY_MISMATCH", "test result does not belong to the reviewed tester run");
  const statePath = testerRunStatePath(projectRoot, testerRunId);
  return withStateFileLock(statePath, () => {
    const state = readTesterState(projectRoot, testerRun);
    if (state.review_id !== null && state.review_id !== review.review_id)
      failA1("IMMUTABLE_CONFLICT", "tester review for a run cannot change");
    if (
      state.status !== "sealed" &&
      state.status !== "reviewed" &&
      state.status !== "passed" &&
      state.status !== "rejected"
    )
      failA1("TESTER_STATE_ORDER", "tester review requires sealed test results");
    if (state.test_result_sha256 === null)
      failA1("TESTER_STATE_ORDER", "tester review requires sealed test results");
    if (
      review.reviewed_run_id !== testerRunId ||
      review.outer_iteration !== state.outer_iteration ||
      review.wave_id !== state.wave_id ||
      review.wave_kind !== state.wave_kind ||
      review.generation !== state.generation ||
      review.subject.promotion_trial_id !== state.promotion_trial_id ||
      review.subject.tester_version !== state.tester_version ||
      review.subject.case_manifest_sha256 !== state.case_manifest_sha256 ||
      review.subject.matching_baseline_artifact_sha256 !==
        state.matching_baseline_artifact_sha256 ||
      review.subject.finalist_artifact_sha256 !== state.finalist_artifact_sha256 ||
      review.subject.test_result_sha256 !== state.test_result_sha256
    )
      failA1("IDENTITY_MISMATCH", "tester review does not match the run");
    if (testResult.tester_definition_sha256 !== state.tester_definition_sha256)
      failA1("IDENTITY_MISMATCH", "reviewed test result does not match the tester definition");
    saveResultReference(projectRoot, testerRunId, state.test_result_sha256);
    if (state.status !== "sealed") {
      writeTesterDashboard(projectRoot, state);
      return state;
    }
    const next: TesterRunState = {
      ...state,
      status: "reviewed",
      review_id: review.review_id,
      reviewer_worker_id: review.reviewer_worker_id,
      review_receipt_sha256: canonicalJsonSha256(review, undefined, {
        schemaVersion: "tester-review-receipt-v1",
      }),
      updated_at: new Date().toISOString(),
    };
    writeTesterStateAndDashboard(projectRoot, statePath, next);
    return next;
  });
}

export function readStoredTesterReview(
  projectRoot: string,
  testerRunId: string,
): TesterReviewReceipt {
  const state = readTesterState(projectRoot, assertIdentifier(testerRunId, "tester_run_id"));
  if (state.review_id === null || state.reviewer_worker_id === null)
    failA1("REVIEW_NOT_FOUND", "tester run has no stored review receipt");
  const reviewPath = path.join(
    testerRunDirectory(projectRoot, state.tester_run_id),
    "workers",
    state.reviewer_worker_id,
    "outputs",
    "reviews",
    `${state.review_id}.json`,
  );
  if (!fs.existsSync(reviewPath))
    failA1("REVIEW_NOT_FOUND", `tester review receipt must be stored at ${reviewPath}`);
  const review = readStoredReviewReceipt(projectRoot, readStateFile(reviewPath));
  if (review.reviewed_run_kind !== "tester")
    failA1("REVIEW_TYPE_MISMATCH", "stored tester review has the wrong run kind");
  const testResult = readStoredTesterResult(projectRoot, state.tester_run_id);
  if (review.subject.test_result_sha256 !== testerResultSha256(testResult))
    failA1("TEST_RESULT_HASH_MISMATCH", "tester review does not identify the stored test result");
  if (
    review.review_id !== state.review_id ||
    review.reviewer_worker_id !== state.reviewer_worker_id ||
    review.reviewed_run_id !== state.tester_run_id ||
    review.outer_iteration !== state.outer_iteration ||
    review.wave_id !== state.wave_id ||
    review.wave_kind !== state.wave_kind ||
    review.generation !== state.generation ||
    review.subject.promotion_trial_id !== state.promotion_trial_id ||
    review.subject.tester_version !== state.tester_version ||
    review.subject.case_manifest_sha256 !== state.case_manifest_sha256 ||
    review.subject.matching_baseline_artifact_sha256 !== state.matching_baseline_artifact_sha256 ||
    review.subject.finalist_artifact_sha256 !== state.finalist_artifact_sha256 ||
    review.subject.test_result_sha256 !== state.test_result_sha256 ||
    canonicalJsonSha256(review, undefined, { schemaVersion: "tester-review-receipt-v1" }) !==
      state.review_receipt_sha256
  )
    failA1("REVIEW_RECEIPT_CONFLICT", "stored tester review differs from tester state");
  return review;
}

export interface TesterGateBinding {
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  case_manifest_sha256: string;
  seed_manifest_sha256: string;
  input_distribution_sha256: string;
  matching_baseline_artifact_sha256: string;
  finalist_artifact_sha256: string;
  judge_binding_id: string | null;
  judge_binding: TesterJudgeBinding | null;
  model_assignment_sha256: string;
}

function assertGateBindingMatchesState(
  binding: TesterGateBinding,
  state: TesterRunState,
  testTrial: TesterTrialRecord,
): void {
  assertIdentifier(binding.tester_version, "gate.tester_version");
  assertSha256(binding.tester_definition_sha256, "gate.tester_definition_sha256");
  assertSha256(binding.harness_sha256, "gate.harness_sha256");
  assertSha256(binding.case_manifest_sha256, "gate.case_manifest_sha256");
  assertSha256(binding.seed_manifest_sha256, "gate.seed_manifest_sha256");
  assertSha256(binding.input_distribution_sha256, "gate.input_distribution_sha256");
  assertSha256(binding.matching_baseline_artifact_sha256, "gate.matching_baseline_artifact_sha256");
  assertSha256(binding.finalist_artifact_sha256, "gate.finalist_artifact_sha256");
  if (binding.judge_binding_id !== null)
    assertIdentifier(binding.judge_binding_id, "gate.judge_binding_id");
  if (binding.judge_binding !== null)
    validateJudgeBindingShape(binding.judge_binding, "gate.judge_binding");
  assertSha256(binding.model_assignment_sha256, "gate.model_assignment_sha256");
  if (
    binding.tester_version !== state.tester_version ||
    binding.tester_definition_sha256 !== state.tester_definition_sha256 ||
    binding.harness_sha256 !== state.harness_sha256 ||
    binding.case_manifest_sha256 !== state.case_manifest_sha256 ||
    binding.seed_manifest_sha256 !== state.seed_manifest_sha256 ||
    binding.matching_baseline_artifact_sha256 !== state.matching_baseline_artifact_sha256 ||
    binding.finalist_artifact_sha256 !== state.finalist_artifact_sha256 ||
    binding.input_distribution_sha256 !== state.input_distribution_sha256 ||
    binding.judge_binding_id !== state.judge_binding_id ||
    !sameJson(binding.judge_binding, state.judge_binding) ||
    binding.model_assignment_sha256 !== state.model_assignment_sha256
  )
    failA1("TESTER_ARMS_MISMATCH", "promotion gate input does not match the frozen tester run");
  if (testTrial.input_distribution_sha256 !== binding.input_distribution_sha256)
    failA1(
      "TESTER_ARMS_MISMATCH",
      "promotion gate input distribution differs from the reservation",
    );
  if (testTrial.judge_binding_id !== binding.judge_binding_id)
    failA1("TESTER_ARMS_MISMATCH", "promotion gate judge binding differs from the reservation");
  if (!sameJson(testTrial.judge_binding, binding.judge_binding))
    failA1("TESTER_ARMS_MISMATCH", "promotion gate judge facts differ from the reservation");
  if (
    testTrial.harness_sha256 !== binding.harness_sha256 ||
    testTrial.matching_baseline_artifact_sha256 !== binding.matching_baseline_artifact_sha256 ||
    testTrial.finalist_artifact_sha256 !== binding.finalist_artifact_sha256 ||
    testTrial.model_assignment_sha256 !== binding.model_assignment_sha256
  )
    failA1("TESTER_ARMS_MISMATCH", "promotion gate artifacts differ from the reservation");
}

function settleObservedTrial(testTrial: TesterTrialRecord, state: TesterRunState): void {
  if (testTrial.status === "released")
    failA1("TESTER_TRIAL_TERMINAL", "released testTrial cannot settle");
  if (testTrial.tester_run_id !== null && testTrial.tester_run_id !== state.tester_run_id)
    failA1("TESTER_ONCE_PER_WAVE", "testTrial is bound to another tester run");
  testTrial.tester_run_id = state.tester_run_id;
  testTrial.tester_started = true;
  if (state.test_result_sha256 !== null) {
    if (
      testTrial.test_result_sha256 !== null &&
      testTrial.test_result_sha256 !== state.test_result_sha256
    )
      failA1("TESTER_TRIAL_CONFLICT", "state and testTrial contain different test results");
    testTrial.test_result_sha256 = state.test_result_sha256;
  }
  if (testTrial.status === "reserved") {
    testTrial.status = "settled";
    testTrial.settled_at ??= new Date().toISOString();
  }
}

export function consumeTesterGate(
  projectRoot: string,
  testerRunId: string,
  result: "passed" | "rejected",
  binding: TesterGateBinding,
): TesterRunState {
  const runId = assertIdentifier(testerRunId, "tester_run_id");
  if (result !== "passed" && result !== "rejected")
    failA1("INVALID_TESTER_RESULT", "promotion gate result must be passed or rejected");
  readStoredTesterResult(projectRoot, runId);
  readStoredTesterReview(projectRoot, runId);
  const statePath = testerRunStatePath(projectRoot, runId);
  const initialState = readTesterState(projectRoot, runId);
  const definition = readTesterDefinitionForRun(projectRoot, initialState);
  const ledgerPath = testerTrialLedgerPath(projectRoot, initialState.task_id);
  return withStateFileLock(ledgerPath, () =>
    withStateFileLock(statePath, () => {
      const state = readTesterState(projectRoot, runId);
      const ledger = loadLedger(projectRoot, state.task_id);
      const testTrial = ledger.test_trials.find(
        (candidate) => candidate.promotion_trial_id === state.promotion_trial_id,
      );
      if (!testTrial) failA1("TESTER_TRIAL_NOT_FOUND", "tester run has no testTrial reservation");
      assertTrialMatchesState(testTrial, state);
      assertGateBindingMatchesState(binding, state, testTrial);

      if (state.status === "passed" || state.status === "rejected") {
        if (state.gate_status !== result)
          failA1("TESTER_GATE_CONFLICT", "a tester run cannot change its consumed gate result");
        settleObservedTrial(testTrial, state);
        writeLedger(ledgerPath, ledger);
        writeTesterDashboard(projectRoot, state);
        return state;
      }
      if (state.status !== "reviewed" || state.gate_consumed || state.gate_status !== null)
        failA1("TESTER_GATE_ONCE", "promotion gate requires one reviewed tester result");
      const updated: TesterRunState = {
        ...state,
        status: result,
        gate_consumed: true,
        gate_status: result,
        updated_at: new Date().toISOString(),
      };
      // State is the durable decision. If the process stops before the ledger
      // write, the same gate result above repairs the reservation on retry.
      writeStateJsonAtomic(statePath, updated);
      settleObservedTrial(testTrial, updated);
      writeLedger(ledgerPath, ledger);
      writeTesterDashboard(projectRoot, updated);
      return updated;
    }),
  );
}

export function retryTesterInfrastructure(
  projectRoot: string,
  testerRunId: string,
  semanticFingerprint: string,
  expectedFingerprint: string,
): TesterRunState {
  if (semanticFingerprint !== expectedFingerprint)
    failA1("RETRY_SEMANTICS_CHANGED", "tester retry changed the frozen trial semantics");
  const state = readTesterState(projectRoot, testerRunId);
  if (state.status !== "running")
    failA1(
      "TESTER_STATE_ORDER",
      "only a running tester can enter retryable infrastructure failure",
    );
  return transitionTesterState(projectRoot, testerRunId, "retryable_infra_failure");
}

export function readTesterTrialLedger(projectRoot: string, taskId: string): TesterTrialLedger {
  return loadLedger(projectRoot, assertIdentifier(taskId, "task_id"));
}
