import path from "node:path";
import { anyJsonSchema, canonicalJsonSha256 } from "./canonical-json.js";

export type JsonObject = Record<string, unknown>;

export class A1Error extends Error {
  readonly code: string;
  readonly location: string | null;

  constructor(code: string, message: string, location: string | null = null) {
    super(`${code}: ${message}`);
    this.name = "A1Error";
    this.code = code;
    this.location = location;
  }
}

export type ModelUse = "generate" | "train" | "distill" | "aggregate" | "judge";
export type ArtifactBindingSource = "previous_promoted" | "fixed_external";

export interface ArtifactBinding {
  source: ArtifactBindingSource;
  source_role: string | null;
  artifact_id: string | null;
}

export interface ModelRolePolicy {
  role_id: string;
  allowed_modules: string[];
  allowed_uses: ModelUse[];
  judge_targets: string[];
  judge_generation_lag: number | null;
  artifact_binding: ArtifactBinding;
  promotion_output: string | null;
  user_confirmed: boolean;
  approval_id: string;
}

export interface ModelUsagePolicy {
  revision: string;
  approval_id: string;
  roles: ModelRolePolicy[];
}

export interface MetricObjective {
  name: string;
  direction: "higher_better" | "lower_better";
}

export interface ObjectiveConstraint {
  name: string;
  op: ">=" | "<=" | ">" | "<" | "=";
  value: number;
}

export interface ObjectiveSpec {
  primary: MetricObjective;
  constraints: ObjectiveConstraint[];
}

export interface ModuleExecutionBounds {
  max_jobs: number;
  max_compute: { amount: number; unit: string };
}

export interface WorkflowModule {
  id: string;
  evolvable: boolean;
  version?: string;
  patch_sha256?: string;
  inputs: string[];
  outputs: string[];
  input_ports?: string[];
  output_ports?: string[];
  input_cardinality?: Record<string, "one" | "many">;
  write_scope: string[];
  local_metric: string | null;
  execution: ModuleExecutionBounds;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  contract: string;
}

export interface WorkflowFeedbackEdge {
  from: string;
  to: string;
  barrier: "next_outer_iteration";
  contract?: string;
}

export interface FiniteCycleSpec {
  cycle_id: string;
  iterations: number;
  nodes: string[];
}

export interface OwnerLimits {
  revision: string;
  max_nodes: number;
  max_edges: number;
  max_fan_out_per_node: number;
  max_unrolled_cycles: number;
  max_jobs_per_candidate: number;
  max_compute_per_candidate: { amount: number; unit: string };
  /** Upper bound for recursive run depth; old specs omit it during migration. */
}

// The single number a human maintains. Everything below that scales with graph
// size is computed from it, so raising this cannot leave a second limit behind
// as the real binding constraint.
const MAX_NODES_CEILING = 100;
// How many direct branches one module may have. Kept small so one node cannot
// turn a single wave into a wide scheduling frontier.
const MAX_FAN_OUT_CEILING = 4;
// How many extra passes the compiler may unroll. The compiler multiplies work
// by (cycles + 1).
const MAX_UNROLLED_CYCLES_CEILING = 3;
// Feedback edges may start at these four fixed producers instead of at a node
// in the graph. They are counted in the edge total but in no node's fan-out,
// so the edge ceiling has to allow for them.
const EXTERNAL_FEEDBACK_SOURCES = new Set(["evaluation", "tester", "workflow", "scorer"]);
const EXTERNAL_FEEDBACK_SOURCE_COUNT = EXTERNAL_FEEDBACK_SOURCES.size;

const OWNER_LIMIT_MAXIMUMS = {
  max_nodes: MAX_NODES_CEILING,
  // Every node emits at most MAX_FAN_OUT_CEILING edges, and may additionally
  // receive feedback from each external producer. Deriving the ceiling keeps
  // the edge limit a backstop instead of the first limit a legal graph hits.
  max_edges: MAX_NODES_CEILING * (MAX_FAN_OUT_CEILING + EXTERNAL_FEEDBACK_SOURCE_COUNT),
  max_fan_out_per_node: MAX_FAN_OUT_CEILING,
  max_unrolled_cycles: MAX_UNROLLED_CYCLES_CEILING,
  // Worst case is one job per module on every pass. This is the arithmetic that
  // produced the previous fixed 96 (24 nodes x 4 passes), re-expressed so it
  // follows MAX_NODES_CEILING automatically. Derived from the ceilings above,
  // never from a spec's own max_nodes: a standalone spec declares max_nodes 1
  // while carrying its module's full job count, and a per-spec formula would
  // reject it.
  max_jobs_per_candidate: MAX_NODES_CEILING * (MAX_UNROLLED_CYCLES_CEILING + 1),
} as const;

export interface WavePolicy {
  max_parallel_modules: 1 | 2;
  dependent_modules: "sequential";
  ablation_design: "full_factorial";
}

export interface StructureWavePolicy {
  exclusive: true;
  max_candidates: 1;
  module_versions: "frozen";
}

export interface ScorerWavePolicy {
  exclusive: true;
  max_candidates: 1;
  experiment_parallelism: 1;
  execution_order: "baseline_then_candidate";
  blocks_other_wave_kinds: true;
}

export interface WorkflowValidationPolicy {
  scorer_id: string;
  scorer_revision_binding: "from_active_scorer_pointer";
  research_feedback: "detailed";
  cross_judge_score_comparison: "forbidden";
}

export interface WorkflowScorerReference {
  id: string;
  kind: "deterministic_rules" | "llm_rubric";
  definition_binding: "from_active_scorer_revision";
  judge_binding: "from_model_usage_policy" | null;
}

export interface WorkflowPromotionTesterReference {
  tester_id: string;
  definition_version: string;
  research_feedback: "fuzzy_advice_only";
  max_exposures_per_task: number;
}

export interface WorkflowSpec {
  schema_version: 1;
  mode?: "workflow" | "standalone";
  task_id: string;
  workflow_id: string;
  revision: string;
  objective: ObjectiveSpec;
  task_setup_revision: string;
  model_usage_policy: ModelUsagePolicy;
  validation_policy: WorkflowValidationPolicy;
  scorers: WorkflowScorerReference[];
  promotion_tester: WorkflowPromotionTesterReference;
  wave_policy: WavePolicy;
  structure_wave_policy: StructureWavePolicy;
  scorer_wave_policy: ScorerWavePolicy;
  owner_limits: OwnerLimits;
  /** The complete immutable catalog. Only enabled_module_ids are executable. */
  modules: WorkflowModule[];
  module_catalog: WorkflowModule[];
  enabled_module_ids: string[];
  /** Alias accepted at the boundary and emitted for callers that use active wording. */
  active_module_ids: string[];
  edges: WorkflowEdge[];
  feedback_edges: WorkflowFeedbackEdge[];
  cycles: FiniteCycleSpec[];
}

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function isRecord(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function failA1(code: string, message: string, location: string | null = null): never {
  throw new A1Error(code, message, location);
}

export function assertNoUnknownFields(
  value: JsonObject,
  allowed: readonly string[],
  location: string,
): void {
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      failA1("UNKNOWN_FIELD", `unknown field '${key}'`, `${location}.${key}`);
    }
  }
}

function assertNfc(value: string, location: string): void {
  if (value.normalize("NFC") !== value) {
    failA1("INVALID_UNICODE", "string must already be Unicode NFC", location);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        failA1("INVALID_UNICODE", "string contains an unpaired surrogate", location);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failA1("INVALID_UNICODE", "string contains an unpaired surrogate", location);
    }
  }
}

/** Sort identity-bearing strings by UTF-8 bytes, independent of locale. */
export function compareIdentityStrings(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failA1("INVALID_VALUE", "expected a non-empty string", location);
  }
  assertNfc(value, location);
  return value;
}

export function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") failA1("INVALID_VALUE", "expected a boolean", location);
  return value;
}

export function requireFiniteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failA1("INVALID_VALUE", "expected a finite number", location);
  }
  return value;
}

export function requireInteger(value: unknown, location: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failA1("INVALID_VALUE", `expected a safe integer >= ${minimum}`, location);
  }
  return value;
}

export function assertIdentifier(value: unknown, location: string): string {
  const identifier = requireString(value, location);
  if (identifier === "." || identifier === ".." || !IDENTIFIER_PATTERN.test(identifier)) {
    failA1("INVALID_ID", "must be a single safe identifier", location);
  }
  return identifier;
}

export function assertRunId(value: unknown, location: string): string {
  const runId = requireString(value, location);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))
    failA1(
      "INVALID_RUN_ID",
      "run id must use only letters, digits, dots, underscores and hyphens",
      location,
    );
  return runId;
}

export function assertSha256(value: unknown, location: string): string {
  const digest = requireString(value, location);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    failA1("INVALID_HASH", "must be a lowercase SHA-256 digest", location);
  }
  return digest;
}

export function assertRelativePath(value: unknown, location: string): string {
  const candidate = requireString(value, location);
  if (candidate.includes("\0")) failA1("INVALID_PATH", "must not contain NUL", location);
  const slashValue = candidate.replaceAll("\\", "/");
  if (
    path.isAbsolute(candidate) ||
    slashValue.startsWith("/") ||
    /^[A-Za-z]:\//.test(slashValue) ||
    slashValue.split("/").some((part) => part === "..")
  ) {
    failA1("PATH_ESCAPE", "must be a relative path inside the declared workspace", location);
  }
  if (slashValue === "." || slashValue.endsWith("/")) {
    failA1("INVALID_PATH", "must name a file or scoped path", location);
  }
  const normalized = path.posix.normalize(slashValue);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    failA1("PATH_ESCAPE", "must be a relative path inside the declared workspace", location);
  }
  return normalized;
}

function stringArray(value: unknown, location: string, unique = true): string[] {
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "expected an array", location);
  const result = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (unique && new Set(result).size !== result.length) {
    failA1("DUPLICATE_ID", "array contains duplicate values", location);
  }
  return result;
}

function identifierArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "expected an array", location);
  const result = value.map((item, index) => assertIdentifier(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", "array contains duplicate identifiers", location);
  return result;
}

function parseModelUse(value: unknown, location: string): ModelUse {
  const use = requireString(value, location);
  if (!(["generate", "train", "distill", "aggregate", "judge"] as string[]).includes(use)) {
    failA1("INVALID_MODEL_USE", `unsupported model use '${use}'`, location);
  }
  return use as ModelUse;
}

function parseArtifactBinding(value: unknown, location: string): ArtifactBinding {
  if (typeof value === "string") {
    if (value !== "previous_promoted" && value !== "fixed_external") {
      failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", `unsupported artifact binding '${value}'`, location);
    }
    if (value === "fixed_external") {
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        "fixed_external bindings must name a concrete registered artifact",
        location,
      );
    }
    return { source: value, source_role: null, artifact_id: null };
  }
  if (!isRecord(value))
    failA1("INVALID_VALUE", "artifact binding must be a string or object", location);
  assertNoUnknownFields(value, ["source", "source_role", "artifact_id", "revision"], location);
  if (
    value.source !== undefined &&
    value.revision !== undefined &&
    value.source !== value.revision
  ) {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "source and revision must describe the same immutable binding",
      location,
    );
  }
  const rawSource = value.source ?? value.revision;
  if (rawSource !== "previous_promoted" && rawSource !== "fixed_external") {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "artifact binding must name an immutable source",
      location,
    );
  }
  const source = rawSource as ArtifactBindingSource;
  const sourceRole =
    value.source_role === undefined || value.source_role === null
      ? null
      : assertIdentifier(value.source_role, `${location}.source_role`);
  const artifactId =
    value.artifact_id === undefined || value.artifact_id === null
      ? null
      : assertIdentifier(value.artifact_id, `${location}.artifact_id`);
  if (source === "fixed_external" && artifactId === null) {
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "fixed_external binding needs artifact_id", location);
  }
  if (source === "previous_promoted" && artifactId !== null) {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "previous_promoted bindings cannot pin a concrete artifact",
      location,
    );
  }
  if (source === "previous_promoted" && value.revision === "current") {
    failA1("JUDGE_LAG_VIOLATION", "current revision cannot be a judge binding", location);
  }
  return { source, source_role: sourceRole, artifact_id: artifactId };
}

function parseRole(value: unknown, location: string): ModelRolePolicy {
  if (!isRecord(value)) failA1("INVALID_VALUE", "model role must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "role_id",
      "allowed_modules",
      "allowed_uses",
      "judge_targets",
      "judge_generation_lag",
      "artifact_binding",
      "promotion_output",
      "user_confirmed",
      "approval_id",
    ],
    location,
  );
  const roleId = assertIdentifier(value.role_id, `${location}.role_id`);
  const allowedModules = identifierArray(value.allowed_modules, `${location}.allowed_modules`);
  if (!Array.isArray(value.allowed_uses) || value.allowed_uses.length === 0) {
    failA1("INVALID_MODEL_USE", "allowed_uses must not be empty", `${location}.allowed_uses`);
  }
  const allowedUses = value.allowed_uses.map((item, index) =>
    parseModelUse(item, `${location}.allowed_uses[${index}]`),
  );
  if (new Set(allowedUses).size !== allowedUses.length) {
    failA1("DUPLICATE_ID", "allowed_uses contains duplicates", `${location}.allowed_uses`);
  }
  const judgeTargets =
    value.judge_targets === undefined
      ? []
      : identifierArray(value.judge_targets, `${location}.judge_targets`);
  const lag =
    value.judge_generation_lag === undefined || value.judge_generation_lag === null
      ? null
      : requireInteger(value.judge_generation_lag, `${location}.judge_generation_lag`, 1);
  const binding = parseArtifactBinding(value.artifact_binding, `${location}.artifact_binding`);
  const promotionOutput =
    value.promotion_output === undefined || value.promotion_output === null
      ? null
      : assertIdentifier(value.promotion_output, `${location}.promotion_output`);
  const confirmed = requireBoolean(value.user_confirmed ?? false, `${location}.user_confirmed`);
  const approvalId = requireString(value.approval_id, `${location}.approval_id`);
  if (allowedUses.includes("judge")) {
    if (judgeTargets.length === 0 || lag === null || lag < 1) {
      failA1("JUDGE_LAG_VIOLATION", "judge roles need targets and a generation lag >= 1", location);
    }
  } else if (judgeTargets.length > 0 || lag !== null) {
    failA1("INVALID_MODEL_USE", "non-judge roles cannot declare judge targets or lag", location);
  }
  return {
    role_id: roleId,
    allowed_modules: allowedModules,
    allowed_uses: allowedUses,
    judge_targets: judgeTargets,
    judge_generation_lag: lag,
    artifact_binding: binding,
    promotion_output: promotionOutput,
    user_confirmed: confirmed,
    approval_id: approvalId,
  };
}

export function validateModelUsagePolicy(
  value: unknown,
  location = "model_usage_policy",
): ModelUsagePolicy {
  if (!isRecord(value)) failA1("INVALID_VALUE", "model usage policy must be an object", location);
  assertNoUnknownFields(value, ["revision", "approval_id", "roles"], location);
  const revision = assertIdentifier(value.revision, `${location}.revision`);
  const approvalId = requireString(value.approval_id, `${location}.approval_id`);
  if (!Array.isArray(value.roles) || value.roles.length === 0) {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "at least one model role is required",
      `${location}.roles`,
    );
  }
  const roles = value.roles.map((role, index) => parseRole(role, `${location}.roles[${index}]`));
  if (new Set(roles.map((role) => role.role_id)).size !== roles.length) {
    failA1("DUPLICATE_ID", "model role ids must be unique", `${location}.roles`);
  }
  const promotionOutputs = roles
    .map((role) => role.promotion_output)
    .filter((output): output is string => output !== null);
  if (new Set(promotionOutputs).size !== promotionOutputs.length) {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "promotion outputs must identify at most one role each",
      `${location}.roles`,
    );
  }
  const roleIds = new Set(roles.map((role) => role.role_id));
  for (const role of roles) {
    const sourceRole = role.artifact_binding.source_role;
    if (sourceRole !== null && !roleIds.has(sourceRole))
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        `role '${role.role_id}' binds to an unknown source role '${sourceRole}'`,
        `${location}.roles`,
      );
  }
  const policy = { revision, approval_id: approvalId, roles };
  assertModelUsagePolicyConfirmed(policy, location);
  return policy;
}

/** A parsed policy is executable only after every role scope was confirmed. */
export function assertModelUsagePolicyConfirmed(
  policy: ModelUsagePolicy,
  location = "model_usage_policy",
): void {
  for (const [index, role] of policy.roles.entries()) {
    const roleLocation = `${location}.roles[${index}]`;
    if (!role.user_confirmed || role.approval_id.trim() === "") {
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        `model role '${role.role_id}' needs user confirmation for its modules, uses, judge targets, artifact source, and promotion output`,
        roleLocation,
      );
    }
    if (role.allowed_modules.length === 0 || role.allowed_uses.length === 0) {
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        `model role '${role.role_id}' has no confirmed module or use scope`,
        roleLocation,
      );
    }
    if (role.allowed_uses.includes("judge") && role.judge_targets.length === 0) {
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        `judge role '${role.role_id}' has no confirmed target`,
        roleLocation,
      );
    }
  }
}

function parseObjective(value: unknown, location: string): ObjectiveSpec {
  if (!isRecord(value)) failA1("INVALID_VALUE", "objective must be an object", location);
  assertNoUnknownFields(value, ["primary", "constraints"], location);
  if (!isRecord(value.primary))
    failA1("INVALID_VALUE", "primary must be an object", `${location}.primary`);
  assertNoUnknownFields(value.primary, ["name", "direction"], `${location}.primary`);
  const name = requireString(value.primary.name, `${location}.primary.name`);
  const direction = value.primary.direction;
  if (direction !== "higher_better" && direction !== "lower_better") {
    failA1(
      "INVALID_VALUE",
      "direction must be higher_better or lower_better",
      `${location}.primary.direction`,
    );
  }
  if (!Array.isArray(value.constraints))
    failA1("INVALID_VALUE", "constraints must be an array", `${location}.constraints`);
  const constraints = value.constraints.map((constraint, index) => {
    const itemLocation = `${location}.constraints[${index}]`;
    if (!isRecord(constraint))
      failA1("INVALID_VALUE", "constraint must be an object", itemLocation);
    assertNoUnknownFields(constraint, ["name", "op", "value"], itemLocation);
    const op = constraint.op;
    if (op !== ">=" && op !== "<=" && op !== ">" && op !== "<" && op !== "=") {
      failA1("INVALID_VALUE", "unsupported constraint operator", `${itemLocation}.op`);
    }
    const normalizedOp = op as ObjectiveConstraint["op"];
    return {
      name: requireString(constraint.name, `${itemLocation}.name`),
      op: normalizedOp,
      value: requireFiniteNumber(constraint.value, `${itemLocation}.value`),
    };
  });
  return { primary: { name, direction }, constraints };
}

export function parseOwnerLimits(value: unknown, location: string): OwnerLimits {
  if (!isRecord(value))
    failA1("WORKFLOW_LIMITS_REQUIRED", "owner_limits must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "revision",
      "max_nodes",
      "max_edges",
      "max_fan_out_per_node",
      "max_unrolled_cycles",
      "max_jobs_per_candidate",
      "max_compute_per_candidate",
    ],
    location,
  );
  const compute = value.max_compute_per_candidate;
  if (!isRecord(compute))
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "compute limit is required",
      `${location}.max_compute_per_candidate`,
    );
  assertNoUnknownFields(compute, ["amount", "unit"], `${location}.max_compute_per_candidate`);
  const computeAmount = requireFiniteNumber(
    compute.amount,
    `${location}.max_compute_per_candidate.amount`,
  );
  if (computeAmount < 0)
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "compute amount cannot be negative",
      `${location}.max_compute_per_candidate.amount`,
    );
  const requireBoundedLimit = (
    candidate: unknown,
    field: keyof typeof OWNER_LIMIT_MAXIMUMS,
    minimum: number,
  ): number => {
    const result = requireInteger(candidate, `${location}.${field}`, minimum);
    const maximum = OWNER_LIMIT_MAXIMUMS[field];
    if (result > maximum)
      failA1(
        "INVALID_VALUE",
        `${field} must be <= ${maximum} for this workflow owner limit revision`,
        `${location}.${field}`,
      );
    return result;
  };
  return {
    revision: assertIdentifier(value.revision, `${location}.revision`),
    max_nodes: requireBoundedLimit(value.max_nodes, "max_nodes", 1),
    max_edges: requireBoundedLimit(value.max_edges, "max_edges", 0),
    max_fan_out_per_node: requireBoundedLimit(
      value.max_fan_out_per_node,
      "max_fan_out_per_node",
      0,
    ),
    max_unrolled_cycles: requireBoundedLimit(value.max_unrolled_cycles, "max_unrolled_cycles", 0),
    max_jobs_per_candidate: requireBoundedLimit(
      value.max_jobs_per_candidate,
      "max_jobs_per_candidate",
      1,
    ),
    max_compute_per_candidate: {
      amount: computeAmount,
      unit: requireString(compute.unit, `${location}.max_compute_per_candidate.unit`),
    },
  };
}

export const validateOwnerLimits = parseOwnerLimits;

function parseModule(value: unknown, location: string): WorkflowModule {
  if (!isRecord(value)) failA1("INVALID_VALUE", "module must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "id",
      "evolvable",
      "version",
      "patch_sha256",
      "inputs",
      "outputs",
      "input_ports",
      "output_ports",
      "input_cardinality",
      "write_scope",
      "local_metric",
      "execution",
    ],
    location,
  );
  const executionValue = value.execution;
  if (!isRecord(executionValue))
    failA1("INVALID_VALUE", "module execution bounds are required", `${location}.execution`);
  assertNoUnknownFields(executionValue, ["max_jobs", "max_compute"], `${location}.execution`);
  const maxCompute = executionValue.max_compute;
  if (!isRecord(maxCompute))
    failA1("INVALID_VALUE", "module max_compute is required", `${location}.execution.max_compute`);
  assertNoUnknownFields(maxCompute, ["amount", "unit"], `${location}.execution.max_compute`);
  const writeScope = stringArray(value.write_scope, `${location}.write_scope`).map((scope, index) =>
    assertRelativePath(scope, `${location}.write_scope[${index}]`),
  );
  const module: WorkflowModule = {
    id: assertIdentifier(value.id, `${location}.id`),
    evolvable: requireBoolean(value.evolvable, `${location}.evolvable`),
    inputs: stringArray(value.inputs, `${location}.inputs`),
    outputs: stringArray(value.outputs, `${location}.outputs`),
    write_scope: writeScope,
    local_metric:
      value.local_metric === null
        ? null
        : requireString(value.local_metric, `${location}.local_metric`),
    execution: {
      max_jobs: requireInteger(executionValue.max_jobs, `${location}.execution.max_jobs`, 1),
      max_compute: {
        amount: (() => {
          const amount = requireFiniteNumber(
            maxCompute.amount,
            `${location}.execution.max_compute.amount`,
          );
          if (amount < 0)
            failA1(
              "INVALID_VALUE",
              "module compute amount cannot be negative",
              `${location}.execution.max_compute.amount`,
            );
          return amount;
        })(),
        unit: requireString(maxCompute.unit, `${location}.execution.max_compute.unit`),
      },
    },
  };
  if (value.version !== undefined)
    module.version = assertIdentifier(value.version, `${location}.version`);
  if (value.patch_sha256 !== undefined)
    module.patch_sha256 = assertSha256(value.patch_sha256, `${location}.patch_sha256`);
  if (value.input_ports !== undefined)
    module.input_ports = identifierArray(value.input_ports, `${location}.input_ports`);
  if (value.output_ports !== undefined)
    module.output_ports = identifierArray(value.output_ports, `${location}.output_ports`);
  if (value.input_cardinality !== undefined) {
    if (!isRecord(value.input_cardinality))
      failA1(
        "INVALID_VALUE",
        "input_cardinality must be an object",
        `${location}.input_cardinality`,
      );
    const cardinality: Record<string, "one" | "many"> = {};
    for (const [port, portCardinality] of Object.entries(value.input_cardinality)) {
      assertIdentifier(port, `${location}.input_cardinality.${port}`);
      if (portCardinality !== "one" && portCardinality !== "many")
        failA1(
          "INVALID_VALUE",
          "input cardinality must be one or many",
          `${location}.input_cardinality.${port}`,
        );
      cardinality[port] = portCardinality;
    }
    module.input_cardinality = cardinality;
  }
  return module;
}

function endpoint(value: unknown, location: string): string {
  const text = requireString(value, location);
  const parts = text.split(".");
  if (parts.length !== 2 || parts.some((part) => !IDENTIFIER_PATTERN.test(part))) {
    failA1("INVALID_ID", "endpoint must have the form module.port", location);
  }
  return text;
}

function parseEdge(value: unknown, location: string): WorkflowEdge {
  if (!isRecord(value)) failA1("INVALID_VALUE", "edge must be an object", location);
  assertNoUnknownFields(value, ["from", "to", "contract"], location);
  return {
    from: endpoint(value.from, `${location}.from`),
    to: endpoint(value.to, `${location}.to`),
    contract: requireString(value.contract, `${location}.contract`),
  };
}

function parseFeedbackEdge(value: unknown, location: string): WorkflowFeedbackEdge {
  if (!isRecord(value)) failA1("INVALID_VALUE", "feedback edge must be an object", location);
  assertNoUnknownFields(value, ["from", "to", "barrier", "contract"], location);
  const barrier = value.barrier;
  if (barrier !== "next_outer_iteration") {
    failA1(
      "INVALID_FEEDBACK_EDGE",
      "feedback must target the next outer iteration",
      `${location}.barrier`,
    );
  }
  const feedback: WorkflowFeedbackEdge = {
    from: endpoint(value.from, `${location}.from`),
    to: endpoint(value.to, `${location}.to`),
    barrier,
  };
  if (value.contract !== undefined)
    feedback.contract = requireString(value.contract, `${location}.contract`);
  return feedback;
}

function parseCycles(value: unknown, location: string): FiniteCycleSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "cycles must be an array", location);
  const cycles = value.map((cycle, index) => {
    const cycleLocation = `${location}[${index}]`;
    if (!isRecord(cycle)) failA1("INVALID_VALUE", "cycle must be an object", cycleLocation);
    assertNoUnknownFields(cycle, ["cycle_id", "iterations", "nodes"], cycleLocation);
    return {
      cycle_id: assertIdentifier(cycle.cycle_id, `${cycleLocation}.cycle_id`),
      iterations: requireInteger(cycle.iterations, `${cycleLocation}.iterations`, 1),
      nodes: (() => {
        const nodes = identifierArray(cycle.nodes, `${cycleLocation}.nodes`);
        if (nodes.length === 0)
          failA1(
            "INVALID_VALUE",
            "a finite cycle must contain at least one node",
            `${cycleLocation}.nodes`,
          );
        return nodes;
      })(),
    };
  });
  if (new Set(cycles.map((cycle) => cycle.cycle_id)).size !== cycles.length)
    failA1("DUPLICATE_ID", "cycle ids must be unique", location);
  return cycles;
}

function parseScorerReference(value: unknown, location: string): WorkflowScorerReference {
  if (!isRecord(value)) failA1("INVALID_VALUE", "scorer reference must be an object", location);
  assertNoUnknownFields(value, ["id", "kind", "definition_binding", "judge_binding"], location);
  const kind = value.kind;
  if (kind !== "deterministic_rules" && kind !== "llm_rubric")
    failA1("INVALID_VALUE", "unsupported scorer kind", `${location}.kind`);
  if (value.definition_binding !== "from_active_scorer_revision")
    failA1(
      "INVALID_VALUE",
      "scorer definition must come from active revision",
      `${location}.definition_binding`,
    );
  const judgeBinding =
    value.judge_binding === undefined || value.judge_binding === null ? null : value.judge_binding;
  if (judgeBinding !== null && judgeBinding !== "from_model_usage_policy")
    failA1("INVALID_VALUE", "unsupported judge binding", `${location}.judge_binding`);
  return {
    id: assertIdentifier(value.id, `${location}.id`),
    kind,
    definition_binding: "from_active_scorer_revision",
    judge_binding: judgeBinding,
  };
}

function parseValidationPolicy(value: unknown, location: string): WorkflowValidationPolicy {
  if (!isRecord(value)) failA1("INVALID_VALUE", "validation_policy must be an object", location);
  assertNoUnknownFields(
    value,
    ["scorer_id", "scorer_revision_binding", "research_feedback", "cross_judge_score_comparison"],
    location,
  );
  if (value.scorer_revision_binding !== "from_active_scorer_pointer")
    failA1(
      "INVALID_VALUE",
      "validation scorer must use the active pointer",
      `${location}.scorer_revision_binding`,
    );
  if (value.research_feedback !== "detailed")
    failA1(
      "INVALID_FEEDBACK_TYPE",
      "validation feedback must be detailed",
      `${location}.research_feedback`,
    );
  if (value.cross_judge_score_comparison !== "forbidden")
    failA1(
      "INVALID_VALUE",
      "cross-judge score comparison must be forbidden",
      `${location}.cross_judge_score_comparison`,
    );
  return {
    scorer_id: assertIdentifier(value.scorer_id, `${location}.scorer_id`),
    scorer_revision_binding: "from_active_scorer_pointer",
    research_feedback: "detailed",
    cross_judge_score_comparison: "forbidden",
  };
}

function parseTesterReference(value: unknown, location: string): WorkflowPromotionTesterReference {
  if (!isRecord(value)) failA1("INVALID_VALUE", "promotion_tester must be an object", location);
  assertNoUnknownFields(
    value,
    ["tester_id", "definition_version", "research_feedback", "max_exposures_per_task"],
    location,
  );
  if (value.research_feedback !== "fuzzy_advice_only")
    failA1(
      "INVALID_FEEDBACK_TYPE",
      "tester feedback must be fuzzy_advice_only",
      `${location}.research_feedback`,
    );
  return {
    tester_id: assertIdentifier(value.tester_id, `${location}.tester_id`),
    definition_version: assertIdentifier(
      value.definition_version,
      `${location}.definition_version`,
    ),
    research_feedback: "fuzzy_advice_only",
    max_exposures_per_task: requireInteger(
      value.max_exposures_per_task,
      `${location}.max_exposures_per_task`,
      1,
    ),
  };
}

function parseWavePolicy(value: unknown, location: string): WavePolicy {
  if (!isRecord(value)) failA1("INVALID_WAVE_POLICY", "wave_policy is required", location);
  assertNoUnknownFields(
    value,
    ["max_parallel_modules", "dependent_modules", "ablation_design"],
    location,
  );
  const maxParallel = value.max_parallel_modules;
  if (maxParallel !== 1 && maxParallel !== 2)
    failA1(
      "INVALID_WAVE_POLICY",
      "max_parallel_modules must be integer 1 or 2",
      `${location}.max_parallel_modules`,
    );
  if (value.dependent_modules !== "sequential")
    failA1(
      "INVALID_WAVE_POLICY",
      "dependent_modules must be sequential",
      `${location}.dependent_modules`,
    );
  if (value.ablation_design !== "full_factorial")
    failA1(
      "INVALID_WAVE_POLICY",
      "ablation_design must be full_factorial",
      `${location}.ablation_design`,
    );
  return {
    max_parallel_modules: maxParallel,
    dependent_modules: "sequential",
    ablation_design: "full_factorial",
  };
}

function parseStructurePolicy(value: unknown, location: string): StructureWavePolicy {
  if (!isRecord(value))
    failA1("INVALID_WAVE_POLICY", "structure_wave_policy is required", location);
  assertNoUnknownFields(value, ["exclusive", "max_candidates", "module_versions"], location);
  if (value.exclusive !== true || value.max_candidates !== 1 || value.module_versions !== "frozen")
    failA1(
      "INVALID_WAVE_POLICY",
      "structure wave policy must be exclusive with one frozen candidate",
      location,
    );
  return { exclusive: true, max_candidates: 1, module_versions: "frozen" };
}

function parseScorerPolicy(value: unknown, location: string): ScorerWavePolicy {
  if (!isRecord(value)) failA1("INVALID_WAVE_POLICY", "scorer_wave_policy is required", location);
  assertNoUnknownFields(
    value,
    [
      "exclusive",
      "max_candidates",
      "experiment_parallelism",
      "execution_order",
      "blocks_other_wave_kinds",
    ],
    location,
  );
  if (
    value.exclusive !== true ||
    value.max_candidates !== 1 ||
    value.experiment_parallelism !== 1 ||
    value.execution_order !== "baseline_then_candidate" ||
    value.blocks_other_wave_kinds !== true
  ) {
    failA1("INVALID_WAVE_POLICY", "scorer wave must be exclusive and serial", location);
  }
  return {
    exclusive: true,
    max_candidates: 1,
    experiment_parallelism: 1,
    execution_order: "baseline_then_candidate",
    blocks_other_wave_kinds: true,
  };
}

function validateGraph(
  modules: WorkflowModule[],
  edges: WorkflowEdge[],
  feedbackEdges: WorkflowFeedbackEdge[],
  enabledModuleIds: readonly string[],
): void {
  const moduleIds = new Set(modules.map((module) => module.id));
  const enabledIds = new Set(enabledModuleIds);
  for (const moduleId of enabledModuleIds) {
    if (!moduleIds.has(moduleId)) {
      failA1(
        "INVALID_ID",
        `enabled module '${moduleId}' is not in the module catalog`,
        "enabled_module_ids",
      );
    }
  }
  const modulePorts = new Map<string, WorkflowModule>();
  for (const module of modules) modulePorts.set(module.id, module);
  const ordinaryAdjacency = new Map<string, string[]>();
  for (const moduleId of enabledModuleIds) ordinaryAdjacency.set(moduleId, []);
  const edgeKeys = new Set<string>();
  const incomingPorts = new Map<string, number>();
  for (const edge of edges) {
    const sourceParts = edge.from.split(".");
    const targetParts = edge.to.split(".");
    const source = sourceParts[0]!;
    const target = targetParts[0]!;
    const sourcePort = sourceParts[1]!;
    const targetPort = targetParts[1]!;
    if (!enabledIds.has(source) || !enabledIds.has(target))
      failA1(
        "INVALID_EDGE",
        "edge must reference only enabled modules; catalog-only modules are not executable",
        "edges",
      );
    if (source === target) failA1("WORKFLOW_CYCLE", "ordinary self-edges are not allowed", "edges");
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) failA1("INVALID_EDGE", "duplicate ordinary edge", "edges");
    edgeKeys.add(key);
    const sourceModule = modulePorts.get(source)!;
    const targetModule = modulePorts.get(target)!;
    if (
      !sourceModule.outputs.includes(edge.contract) ||
      !targetModule.inputs.includes(edge.contract)
    ) {
      failA1(
        "CONTRACT_MISMATCH",
        `edge contract '${edge.contract}' is not declared by both modules`,
        key,
      );
    }
    if (!sourcePort || !targetPort) failA1("INVALID_EDGE", "edge ports must be non-empty", key);
    if (sourceModule.output_ports && !sourceModule.output_ports.includes(sourcePort))
      failA1("INVALID_EDGE", `source port '${sourcePort}' is not registered`, key);
    if (targetModule.input_ports && !targetModule.input_ports.includes(targetPort))
      failA1("INVALID_EDGE", `target port '${targetPort}' is not registered`, key);
    ordinaryAdjacency.get(source)!.push(target);
    const incomingKey = edge.to;
    incomingPorts.set(incomingKey, (incomingPorts.get(incomingKey) ?? 0) + 1);
  }
  for (const [incomingKey, count] of incomingPorts) {
    if (count < 2) continue;
    const targetEndpoint = incomingKey.split("|")[0]!;
    const targetModule = modulePorts.get(targetEndpoint.split(".")[0]!)!;
    const targetPort = targetEndpoint.split(".")[1]!;
    if (targetModule.input_cardinality?.[targetPort] !== "many")
      failA1(
        "INVALID_EDGE",
        `input port '${targetEndpoint}' does not accept multiple sources`,
        targetEndpoint,
      );
  }
  const visitState = new Map<string, "visiting" | "visited">();
  function visit(moduleId: string): void {
    const state = visitState.get(moduleId);
    if (state === "visiting")
      failA1("WORKFLOW_CYCLE", "ordinary execution edges must form a DAG", moduleId);
    if (state === "visited") return;
    visitState.set(moduleId, "visiting");
    for (const child of ordinaryAdjacency.get(moduleId) ?? []) visit(child);
    visitState.set(moduleId, "visited");
  }
  for (const moduleId of enabledModuleIds) visit(moduleId);
  const feedbackKeys = new Set<string>();
  for (const feedback of feedbackEdges) {
    const source = feedback.from.split(".")[0]!;
    const target = feedback.to.split(".")[0]!;
    const sourcePort = feedback.from.split(".")[1]!;
    const targetPort = feedback.to.split(".")[1]!;
    if (feedback.from === feedback.to)
      failA1("INVALID_FEEDBACK_EDGE", "feedback endpoints must differ", "feedback_edges");
    if (!enabledIds.has(target))
      failA1(
        "INVALID_FEEDBACK_EDGE",
        `feedback targets inactive or unknown module '${target}'`,
        "feedback_edges",
      );
    if (!enabledIds.has(source) && !EXTERNAL_FEEDBACK_SOURCES.has(source)) {
      failA1(
        "INVALID_FEEDBACK_EDGE",
        `feedback starts at inactive or unknown producer '${source}'`,
        "feedback_edges",
      );
    }
    const targetModule = modulePorts.get(target)!;
    if (targetModule.input_ports && !targetModule.input_ports.includes(targetPort))
      failA1(
        "INVALID_FEEDBACK_EDGE",
        `target port '${targetPort}' is not registered`,
        "feedback_edges",
      );
    if (enabledIds.has(source)) {
      const sourceModule = modulePorts.get(source)!;
      if (sourceModule.output_ports && !sourceModule.output_ports.includes(sourcePort))
        failA1(
          "INVALID_FEEDBACK_EDGE",
          `source port '${sourcePort}' is not registered`,
          "feedback_edges",
        );
      if (feedback.contract !== undefined) {
        if (
          !sourceModule.outputs.includes(feedback.contract) ||
          !targetModule.inputs.includes(feedback.contract)
        )
          failA1(
            "CONTRACT_MISMATCH",
            "feedback source does not declare its contract",
            "feedback_edges",
          );
      } else {
        const sharedContracts = sourceModule.outputs.filter((contract) =>
          targetModule.inputs.includes(contract),
        );
        if (sharedContracts.length !== 1)
          failA1(
            "CONTRACT_MISMATCH",
            "feedback edge needs one unambiguous contract when it is omitted",
            "feedback_edges",
          );
      }
    } else if (
      feedback.contract !== undefined &&
      !targetModule.inputs.includes(feedback.contract)
    ) {
      failA1(
        "CONTRACT_MISMATCH",
        "feedback target does not declare its contract",
        "feedback_edges",
      );
    } else if (feedback.contract === undefined && targetModule.inputs.length > 1) {
      failA1(
        "CONTRACT_MISMATCH",
        "external feedback needs a contract when the target has multiple inputs",
        "feedback_edges",
      );
    }
    const key = `${feedback.from}->${feedback.to}`;
    if (feedbackKeys.has(key))
      failA1("INVALID_FEEDBACK_EDGE", "duplicate feedback edge", "feedback_edges");
    if (edgeKeys.has(key))
      failA1("INVALID_EDGE", "ordinary and feedback edges cannot share endpoints", key);
    feedbackKeys.add(key);
  }
}

export function validateWorkflowGraph(input: {
  modules?: unknown;
  module_catalog?: unknown;
  enabled_module_ids?: unknown;
  active_module_ids?: unknown;
  edges: unknown;
  feedback_edges: unknown;
}): { modules: WorkflowModule[]; edges: WorkflowEdge[]; feedback_edges: WorkflowFeedbackEdge[] } {
  if (input.module_catalog !== undefined && input.modules !== undefined)
    failA1("INVALID_VALUE", "provide either modules or module_catalog, not both", "module_catalog");
  if (input.enabled_module_ids !== undefined && input.active_module_ids !== undefined)
    failA1(
      "INVALID_VALUE",
      "provide either enabled_module_ids or active_module_ids, not both",
      "enabled_module_ids",
    );
  const modulesValue = input.module_catalog ?? input.modules;
  if (!Array.isArray(modulesValue))
    failA1("INVALID_VALUE", "module catalog must be an array", "module_catalog");
  if (!Array.isArray(input.edges)) failA1("INVALID_VALUE", "edges must be an array", "edges");
  if (!Array.isArray(input.feedback_edges))
    failA1("INVALID_VALUE", "feedback_edges must be an array", "feedback_edges");
  const modules = modulesValue.map((module, index) =>
    parseModule(module, `module_catalog[${index}]`),
  );
  if (new Set(modules.map((module) => module.id)).size !== modules.length)
    failA1("DUPLICATE_ID", "module ids must be unique", "module_catalog");
  const enabledValue = input.enabled_module_ids ?? input.active_module_ids;
  if (enabledValue === undefined)
    failA1(
      "WORKFLOW_MODULE_SET_REQUIRED",
      "the executable module set must be declared explicitly",
      "enabled_module_ids",
    );
  const enabledModuleIds = identifierArray(enabledValue, "enabled_module_ids");
  if (enabledModuleIds.length === 0)
    failA1(
      "WORKFLOW_MODULE_SET_REQUIRED",
      "the executable module set must contain at least one module",
      "enabled_module_ids",
    );
  const edges = input.edges.map((edge, index) => parseEdge(edge, `edges[${index}]`));
  const feedbackEdges = input.feedback_edges.map((edge, index) =>
    parseFeedbackEdge(edge, `feedback_edges[${index}]`),
  );
  validateGraph(modules, edges, feedbackEdges, enabledModuleIds);
  return { modules, edges, feedback_edges: feedbackEdges };
}

export function validateWorkflowSpec(value: unknown): WorkflowSpec {
  if (!isRecord(value)) failA1("INVALID_WORKFLOW_SPEC", "workflow spec must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "mode",
      "task_id",
      "workflow_id",
      "revision",
      "objective",
      "task_setup_revision",
      "model_usage_policy",
      "validation_policy",
      "scorers",
      "promotion_tester",
      "wave_policy",
      "structure_wave_policy",
      "scorer_wave_policy",
      "owner_limits",
      "modules",
      "module_catalog",
      "enabled_module_ids",
      "active_module_ids",
      "edges",
      "feedback_edges",
      "cycles",
    ],
    "workflow",
  );
  if (value.schema_version !== 1)
    failA1("INVALID_WORKFLOW_SPEC", "schema_version must be 1", "workflow.schema_version");
  if (value.mode !== undefined && value.mode !== "workflow" && value.mode !== "standalone")
    failA1("INVALID_WORKFLOW_SPEC", "mode must be workflow or standalone", "workflow.mode");
  const hasModules = Object.hasOwn(value, "modules");
  const hasModuleCatalog = Object.hasOwn(value, "module_catalog");
  if (hasModules && hasModuleCatalog) {
    if (!Array.isArray(value.modules) || !Array.isArray(value.module_catalog))
      failA1("INVALID_WORKFLOW_SPEC", "module catalog must be an array", "workflow.module_catalog");
    const normalizeCatalog = (catalog: unknown[]): unknown[] =>
      catalog
        .map((module, index) => {
          const parsed = parseModule(module, `workflow.module_catalog[${index}]`);
          const normalized: JsonObject = {
            id: parsed.id,
            evolvable: parsed.evolvable,
            inputs: parsed.inputs,
            outputs: parsed.outputs,
            write_scope: parsed.write_scope,
            local_metric: parsed.local_metric,
            execution: parsed.execution,
          };
          if (parsed.version !== undefined) normalized.version = parsed.version;
          if (parsed.patch_sha256 !== undefined) normalized.patch_sha256 = parsed.patch_sha256;
          if (parsed.input_ports !== undefined) normalized.input_ports = parsed.input_ports;
          if (parsed.output_ports !== undefined) normalized.output_ports = parsed.output_ports;
          if (parsed.input_cardinality !== undefined)
            normalized.input_cardinality = parsed.input_cardinality;
          return normalized;
        })
        .sort((left, right) => compareIdentityStrings(String(left.id), String(right.id)));
    const moduleDigest = (catalog: unknown[]): string =>
      canonicalJsonSha256(normalizeCatalog(catalog), anyJsonSchema, {
        schemaVersion: "workflow-module-catalog-v1",
      });
    if (moduleDigest(value.modules) !== moduleDigest(value.module_catalog))
      failA1(
        "INVALID_WORKFLOW_SPEC",
        "modules and module_catalog must describe the same catalog",
        "workflow.module_catalog",
      );
  }
  if (!hasModules && !hasModuleCatalog)
    failA1("INVALID_WORKFLOW_SPEC", "module catalog is required", "workflow.module_catalog");
  const hasEnabledModules = Object.hasOwn(value, "enabled_module_ids");
  const hasActiveModules = Object.hasOwn(value, "active_module_ids");
  if (hasEnabledModules && hasActiveModules) {
    const enabledIds = identifierArray(
      value.enabled_module_ids,
      "workflow.enabled_module_ids",
    ).sort(compareIdentityStrings);
    const activeIds = identifierArray(value.active_module_ids, "workflow.active_module_ids").sort(
      compareIdentityStrings,
    );
    if (
      enabledIds.length !== activeIds.length ||
      enabledIds.some((moduleId, index) => moduleId !== activeIds[index])
    )
      failA1(
        "INVALID_WORKFLOW_SPEC",
        "enabled_module_ids and active_module_ids must describe the same set",
        "workflow.active_module_ids",
      );
  }
  if (!hasEnabledModules && !hasActiveModules)
    failA1(
      "WORKFLOW_MODULE_SET_REQUIRED",
      "the executable module set must be declared explicitly",
      "workflow.enabled_module_ids",
    );
  const moduleCatalogValue = hasModuleCatalog ? value.module_catalog : value.modules;
  const enabledModuleValue = hasEnabledModules ? value.enabled_module_ids : value.active_module_ids;
  const graph = validateWorkflowGraph({
    modules: moduleCatalogValue,
    enabled_module_ids: enabledModuleValue,
    edges: value.edges,
    feedback_edges: value.feedback_edges,
  });
  const cycles = parseCycles(value.cycles, "workflow.cycles");
  const modelUsagePolicy = validateModelUsagePolicy(
    value.model_usage_policy,
    "workflow.model_usage_policy",
  );
  const ownerLimits = parseOwnerLimits(value.owner_limits, "workflow.owner_limits");
  const moduleIds = new Set(graph.modules.map((module) => module.id));
  for (const role of modelUsagePolicy.roles) {
    for (const moduleId of role.allowed_modules) {
      if (
        !moduleIds.has(moduleId) &&
        moduleId !== "validation-scorer" &&
        moduleId !== "promotion-tester"
      ) {
        failA1(
          "MODEL_SCOPE_ALIGNMENT_REQUIRED",
          `model role '${role.role_id}' names unknown module '${moduleId}'`,
          "workflow.model_usage_policy",
        );
      }
    }
  }
  const enabledModuleIds = identifierArray(enabledModuleValue, "workflow.enabled_module_ids").sort(
    compareIdentityStrings,
  );
  for (const cycle of cycles) {
    if (new Set(cycle.nodes).size !== cycle.nodes.length)
      failA1("DUPLICATE_ID", "cycle nodes must be unique", `cycles.${cycle.cycle_id}`);
    for (const node of cycle.nodes)
      if (!enabledModuleIds.includes(node))
        failA1(
          "INVALID_ID",
          `cycle references inactive or unknown module '${node}'`,
          `cycles.${cycle.cycle_id}`,
        );
  }
  const scorersValue = value.scorers;
  if (!Array.isArray(scorersValue) || scorersValue.length === 0)
    failA1("INVALID_VALUE", "at least one scorer is required", "workflow.scorers");
  const scorers = scorersValue.map((scorer, index) =>
    parseScorerReference(scorer, `workflow.scorers[${index}]`),
  );
  if (new Set(scorers.map((scorer) => scorer.id)).size !== scorers.length)
    failA1("DUPLICATE_ID", "scorer ids must be unique", "workflow.scorers");
  const validationPolicy = parseValidationPolicy(
    value.validation_policy,
    "workflow.validation_policy",
  );
  if (!scorers.some((scorer) => scorer.id === validationPolicy.scorer_id)) {
    failA1(
      "INVALID_ID",
      `validation scorer '${validationPolicy.scorer_id}' is not registered`,
      "workflow.validation_policy.scorer_id",
    );
  }
  const unrolledCycles = cycles.reduce((total, cycle) => total + cycle.iterations, 0);
  if (unrolledCycles > ownerLimits.max_unrolled_cycles) {
    failA1(
      "rejected_limit",
      "declared finite cycles exceed owner_limits.max_unrolled_cycles",
      "workflow.cycles",
    );
  }
  return {
    schema_version: 1,
    mode: value.mode === undefined ? "workflow" : value.mode,
    task_id: assertIdentifier(value.task_id, "workflow.task_id"),
    workflow_id: assertIdentifier(value.workflow_id, "workflow.workflow_id"),
    revision: assertIdentifier(value.revision, "workflow.revision"),
    objective: parseObjective(value.objective, "workflow.objective"),
    task_setup_revision: assertIdentifier(
      value.task_setup_revision,
      "workflow.task_setup_revision",
    ),
    model_usage_policy: modelUsagePolicy,
    validation_policy: validationPolicy,
    scorers,
    promotion_tester: parseTesterReference(value.promotion_tester, "workflow.promotion_tester"),
    wave_policy: parseWavePolicy(value.wave_policy, "workflow.wave_policy"),
    structure_wave_policy: parseStructurePolicy(
      value.structure_wave_policy,
      "workflow.structure_wave_policy",
    ),
    scorer_wave_policy: parseScorerPolicy(value.scorer_wave_policy, "workflow.scorer_wave_policy"),
    owner_limits: ownerLimits,
    modules: graph.modules,
    module_catalog: graph.modules,
    enabled_module_ids: enabledModuleIds,
    active_module_ids: [...enabledModuleIds],
    edges: graph.edges,
    feedback_edges: graph.feedback_edges,
    cycles,
  };
}

export const parseWorkflowSpec = validateWorkflowSpec;

export function getEnabledModules(spec: WorkflowSpec): WorkflowModule[] {
  const enabledIds = new Set(spec.enabled_module_ids);
  return spec.module_catalog.filter((module) => enabledIds.has(module.id));
}

export function getEnabledModuleIds(spec: WorkflowSpec): string[] {
  return [...spec.enabled_module_ids].sort(compareIdentityStrings);
}

export function assertLimitsUnchanged(original: OwnerLimits, proposed: OwnerLimits): void {
  if (
    original.revision !== proposed.revision ||
    original.max_nodes !== proposed.max_nodes ||
    original.max_edges !== proposed.max_edges ||
    original.max_fan_out_per_node !== proposed.max_fan_out_per_node ||
    original.max_unrolled_cycles !== proposed.max_unrolled_cycles ||
    original.max_jobs_per_candidate !== proposed.max_jobs_per_candidate ||
    original.max_compute_per_candidate.amount !== proposed.max_compute_per_candidate.amount ||
    original.max_compute_per_candidate.unit !== proposed.max_compute_per_candidate.unit
  ) {
    failA1("POLICY_MUTATION_FORBIDDEN", "a proposal cannot modify owner limits or cost units");
  }
}

export function validateWriteScopesDoNotOverlap(modules: readonly WorkflowModule[]): void {
  for (let firstIndex = 0; firstIndex < modules.length; firstIndex += 1) {
    const first = modules[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < modules.length; secondIndex += 1) {
      const second = modules[secondIndex]!;
      for (const firstScope of first.write_scope) {
        for (const secondScope of second.write_scope) {
          const a = firstScope.replace(/\*+$/, "");
          const b = secondScope.replace(/\*+$/, "");
          if (a === b || a.startsWith(b) || b.startsWith(a)) {
            failA1(
              "WRITE_SCOPE_CONFLICT",
              `modules '${first.id}' and '${second.id}' have overlapping write scopes`,
            );
          }
        }
      }
    }
  }
}
