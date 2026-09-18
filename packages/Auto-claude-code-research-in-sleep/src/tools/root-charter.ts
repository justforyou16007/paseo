import { charterSha256, validateCharterContent } from "./run-charter.js";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
import {
  normalizeOptimizableScope,
  validateBaselineScope,
  type BaselineScope,
  type OptimizablePosition,
} from "./baseline-scope.js";
import { validateResourceInventory, type ResourceInventory } from "./resource-inventory.js";
import { requireRunContract, runOwnedPath, type RunRecord } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";

export interface RootMeasurement {
  validator_ref: string;
  tester_ref: string;
}

export interface RootSetupReferences {
  task_setup_sha256: string;
  tester_definition_sha256: string;
  tester_agent_sha256: string;
  validation_thresholds_sha256: string;
  exposure_limit: number;
  owner_limits_sha256: string;
  resource_inventory_sha256: string;
  baseline_sha256: string;
}

export interface RootCharter {
  schema_version: 1;
  charter_id: string;
  run_id: string;
  task_id: string;
  workflow_id: string;
  setup_revision: string;
  policy_revision: string;
  code_baseline_sha256: string;

  problem: string;
  expected_output: unknown;
  evidence_refs: string[];
  constraints: Record<string, unknown>;
  input_snapshot_refs: string[];
  baseline_ref: "W_0";
  baseline_sha256: string;
  optimizable_scope: OptimizablePosition[];
  budget: unknown;

  owner_limits: Record<string, unknown>;
  measurement: RootMeasurement;
  resource_inventory_sha256: string;
  resource_inventory_ref: string;
  setup_refs: RootSetupReferences;
  charter_sha256: string;
}

export interface RootCharterInput {
  run_id: string;
  task_id: string;
  workflow_id: string;
  setup_revision: string;
  problem: string;
  expected_output: unknown;
  workflow_definition?: unknown;
  baseline?: unknown;
  baseline_scope?: unknown;
  resource_inventory?: unknown;
  resource?: unknown;
  owner_limits: unknown;
  tester_definition?: unknown;
  tester_ref?: string;
  validator_ref?: string;
  tester_agent_config?: unknown;
  validation_thresholds?: unknown;
  exposure_limit: number;
  task_setup_sha256?: string;
  tester_definition_sha256?: string;
  tester_agent_sha256?: string;
  validation_thresholds_sha256?: string;
  owner_limits_sha256?: string;
  resource_inventory_ref?: string;
  evidence_refs?: readonly string[];
  input_snapshot_refs?: readonly string[];
  constraints?: Record<string, unknown>;
  budget?: unknown;

  charter_id?: string;
  [key: string]: unknown;
}

const CHARTER_SCHEMA = "root-charter-v1";

function listOfStrings(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "expected an array", location);
  const result = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", "array contains duplicates", location);
  return result.sort(compareIdentityStrings);
}

function nonEmptyExpectedOutput(value: unknown): unknown {
  if (value === null || value === undefined)
    failA1("INVALID_VALUE", "expected_output is required", "root_charter.expected_output");
  if (typeof value === "string") return requireString(value, "root_charter.expected_output");
  if (Array.isArray(value) && value.length === 0)
    failA1(
      "INVALID_VALUE",
      "expected_output must describe content",
      "root_charter.expected_output",
    );
  if (isRecord(value) && Object.keys(value).length === 0)
    failA1(
      "INVALID_VALUE",
      "expected_output must describe content",
      "root_charter.expected_output",
    );
  return value;
}

function normalizeOwnerLimits(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    failA1("WORKFLOW_LIMITS_REQUIRED", "owner_limits must be an object", "owner_limits");

  if (
    !Object.hasOwn(value, "max_bundled_positions_per_graph") ||
    value.max_bundled_positions_per_graph === undefined
  )
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "root setup requires owner_limits.max_bundled_positions_per_graph",
      "owner_limits.max_bundled_positions_per_graph",
    );
  const maxBundled = requireInteger(
    value.max_bundled_positions_per_graph,
    "owner_limits.max_bundled_positions_per_graph",
    0,
  );
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = item;

  result.max_bundled_positions_per_graph = maxBundled;
  return result;
}

function normalizeReferenceHash(value: unknown, fallback: unknown, location: string): string {
  if (value !== undefined) return assertSha256(value, location);
  if (fallback === undefined) failA1("SETUP_INCOMPLETE", `${location} is required`, location);
  return canonicalJsonSha256(fallback, undefined, { schemaVersion: `${location}-v1` });
}

function setupReferences(
  input: RootCharterInput,
  baseline: BaselineScope,
  resource: ResourceInventory,
  ownerLimits: Record<string, unknown>,
): RootSetupReferences {
  const testerDefinition = input.tester_definition;
  const testerAgent = input.tester_agent_config;
  const thresholds = input.validation_thresholds;
  if (testerDefinition === null)
    failA1("INVALID_VALUE", "tester_definition must not be null", "tester_definition");
  if (testerAgent === null)
    failA1("INVALID_VALUE", "tester_agent_config must not be null", "tester_agent_config");
  if (thresholds === null)
    failA1("INVALID_VALUE", "validation_thresholds must not be null", "validation_thresholds");
  return {
    task_setup_sha256: normalizeReferenceHash(
      input.task_setup_sha256,
      {
        task_id: input.task_id,
        workflow_id: input.workflow_id,
        setup_revision: input.setup_revision,
      },
      "root_charter.setup_refs.task_setup_sha256",
    ),
    tester_definition_sha256: normalizeReferenceHash(
      input.tester_definition_sha256,
      testerDefinition,
      "root_charter.setup_refs.tester_definition_sha256",
    ),
    tester_agent_sha256: normalizeReferenceHash(
      input.tester_agent_sha256,
      testerAgent,
      "root_charter.setup_refs.tester_agent_sha256",
    ),
    validation_thresholds_sha256: normalizeReferenceHash(
      input.validation_thresholds_sha256,
      thresholds,
      "root_charter.setup_refs.validation_thresholds_sha256",
    ),
    exposure_limit: requireInteger(
      input.exposure_limit,
      "root_charter.setup_refs.exposure_limit",
      1,
    ),
    owner_limits_sha256: normalizeReferenceHash(
      input.owner_limits_sha256,
      ownerLimits,
      "root_charter.setup_refs.owner_limits_sha256",
    ),
    resource_inventory_sha256: resource.inventory_sha256,
    baseline_sha256: baseline.baseline_sha256,
  };
}

function charterWithoutHash(value: Omit<RootCharter, "charter_sha256">): object {
  return {
    schema_version: value.schema_version,
    charter_id: value.charter_id,
    run_id: value.run_id,
    task_id: value.task_id,
    workflow_id: value.workflow_id,
    setup_revision: value.setup_revision,
    policy_revision: value.policy_revision,
    code_baseline_sha256: value.code_baseline_sha256,

    problem: value.problem,
    expected_output: value.expected_output,
    evidence_refs: value.evidence_refs,
    constraints: value.constraints,
    input_snapshot_refs: value.input_snapshot_refs,
    baseline_ref: value.baseline_ref,
    baseline_sha256: value.baseline_sha256,
    optimizable_scope: value.optimizable_scope,
    budget: value.budget,

    owner_limits: value.owner_limits,
    measurement: value.measurement,
    resource_inventory_sha256: value.resource_inventory_sha256,
    resource_inventory_ref: value.resource_inventory_ref,
    setup_refs: value.setup_refs,
  };
}

function charterHash(value: Omit<RootCharter, "charter_sha256">): string {
  return charterSha256(charterWithoutHash(value));
}

function baselineInput(input: RootCharterInput): BaselineScope {
  const value = input.baseline_scope !== undefined ? input.baseline_scope : input.baseline;
  if (value === undefined) failA1("SETUP_INCOMPLETE", "baseline is required", "setup.baseline");
  const baseline = validateBaselineScope(value);
  if (baseline.baseline_id !== "W_0")
    failA1("INVALID_BASELINE", "root charter baseline must be W_0", "baseline.baseline_id");
  return baseline;
}

function resourceInput(input: RootCharterInput): ResourceInventory {
  const value = input.resource_inventory !== undefined ? input.resource_inventory : input.resource;
  if (value === undefined)
    failA1("SETUP_INCOMPLETE", "resource inventory is required", "setup.resource_inventory");
  return validateResourceInventory(value);
}

function testerRef(input: RootCharterInput): string {
  if (input.tester_ref !== undefined)
    return assertIdentifier(input.tester_ref, "root_charter.measurement.tester_ref");
  if (isRecord(input.tester_definition)) {
    const raw = input.tester_definition.tester_id;
    if (raw !== undefined) return assertIdentifier(raw, "root_charter.measurement.tester_ref");
  }
  failA1(
    "TESTER_REQUIRED",
    "root charter requires a root-only tester_ref",
    "root_charter.measurement.tester_ref",
  );
}

export function createRootCharter(input: RootCharterInput): RootCharter {
  if (!isRecord(input))
    failA1("INVALID_VALUE", "root charter input must be an object", "root_charter");
  const runId = assertIdentifier(input.run_id, "root_charter.run_id");
  const taskId = assertIdentifier(input.task_id, "root_charter.task_id");
  const workflowId = assertIdentifier(input.workflow_id, "root_charter.workflow_id");
  const setupRevision = assertIdentifier(input.setup_revision, "root_charter.setup_revision");
  const problem = requireString(input.problem, "root_charter.problem");
  const expectedOutput = nonEmptyExpectedOutput(input.expected_output);
  const baseline = baselineInput(input);
  const resource = resourceInput(input);
  const ownerLimits = normalizeOwnerLimits(input.owner_limits);

  if (
    baseline.optimizable_scope.filter((entry) => entry.mode === "bundled").length >
    (ownerLimits.max_bundled_positions_per_graph as number)
  )
    failA1(
      "WORKFLOW_LIMITS_REQUIRED",
      "bundled positions exceed the owner limit",
      "root_charter.optimizable_scope",
    );
  const refs = setupReferences(input, baseline, resource, ownerLimits);
  const base: Omit<RootCharter, "charter_sha256"> = {
    schema_version: 1,
    charter_id:
      input.charter_id === undefined
        ? assertIdentifier(`charter:${setupRevision}`, "root_charter.charter_id")
        : assertIdentifier(input.charter_id, "root_charter.charter_id"),
    run_id: runId,
    task_id: taskId,
    workflow_id: workflowId,
    setup_revision: setupRevision,
    policy_revision: setupRevision,
    code_baseline_sha256: baseline.code_baseline.sha256,

    problem,
    expected_output: expectedOutput,
    evidence_refs:
      input.evidence_refs === undefined
        ? []
        : listOfStrings(input.evidence_refs, "root_charter.evidence_refs"),
    constraints:
      input.constraints === undefined
        ? {
            validation_thresholds_sha256: refs.validation_thresholds_sha256,
            exposure_limit: refs.exposure_limit,
          }
        : input.constraints,
    input_snapshot_refs:
      input.input_snapshot_refs === undefined
        ? []
        : listOfStrings(input.input_snapshot_refs, "root_charter.input_snapshot_refs"),
    baseline_ref: "W_0",
    baseline_sha256: baseline.baseline_sha256,
    optimizable_scope: baseline.optimizable_scope,
    budget: input.budget === undefined ? null : input.budget,

    owner_limits: ownerLimits,
    measurement: {
      validator_ref:
        input.validator_ref === undefined
          ? "validation-scorer"
          : assertIdentifier(input.validator_ref, "root_charter.measurement.validator_ref"),
      tester_ref: testerRef(input),
    },
    resource_inventory_sha256: resource.inventory_sha256,
    resource_inventory_ref:
      input.resource_inventory_ref === undefined
        ? "resource-inventory.json"
        : requireString(input.resource_inventory_ref, "root_charter.resource_inventory_ref"),
    setup_refs: refs,
  };
  const charter = { ...base, charter_sha256: charterHash(base) };
  return validateRootCharter(charter);
}

export function validateRootCharter(value: unknown, location = "root_charter"): RootCharter {
  if (!isRecord(value)) failA1("CORRUPT_CHARTER", "root charter must be an object", location);
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "charter_id",
      "run_id",
      "task_id",
      "workflow_id",
      "setup_revision",
      "policy_revision",
      "code_baseline_sha256",

      "problem",
      "expected_output",
      "evidence_refs",
      "constraints",
      "input_snapshot_refs",
      "baseline_ref",
      "baseline_sha256",
      "optimizable_scope",
      "budget",

      "owner_limits",
      "measurement",
      "resource_inventory_sha256",
      "resource_inventory_ref",
      "setup_refs",
      "charter_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1) failA1("CORRUPT_CHARTER", "schema_version must be 1", location);
  if (!Object.hasOwn(value, "budget"))
    failA1("CORRUPT_CHARTER", "budget is required", `${location}.budget`);
  if (value.baseline_ref !== "W_0")
    failA1("INVALID_BASELINE", "root baseline_ref must be W_0", `${location}.baseline_ref`);

  if (!isRecord(value.owner_limits))
    failA1("WORKFLOW_LIMITS_REQUIRED", "owner_limits is required", `${location}.owner_limits`);
  const normalizedOwnerLimits = normalizeOwnerLimits(value.owner_limits);

  const measurement = value.measurement;
  if (!isRecord(measurement))
    failA1("CORRUPT_CHARTER", "measurement is required", `${location}.measurement`);
  assertNoUnknownFields(measurement, ["validator_ref", "tester_ref"], `${location}.measurement`);
  const normalizedMeasurement: RootMeasurement = {
    validator_ref: assertIdentifier(
      measurement.validator_ref,
      `${location}.measurement.validator_ref`,
    ),
    tester_ref: assertIdentifier(measurement.tester_ref, `${location}.measurement.tester_ref`),
  };
  const scopeValue = normalizeOptimizableScope(value.optimizable_scope, []);
  const refs = value.setup_refs;
  if (!isRecord(refs))
    failA1("CORRUPT_CHARTER", "setup_refs is required", `${location}.setup_refs`);
  assertNoUnknownFields(
    refs,
    [
      "task_setup_sha256",
      "tester_definition_sha256",
      "tester_agent_sha256",
      "validation_thresholds_sha256",
      "exposure_limit",
      "owner_limits_sha256",
      "resource_inventory_sha256",
      "baseline_sha256",
    ],
    `${location}.setup_refs`,
  );
  const normalizedRefs: RootSetupReferences = {
    task_setup_sha256: assertSha256(
      refs.task_setup_sha256,
      `${location}.setup_refs.task_setup_sha256`,
    ),
    tester_definition_sha256: assertSha256(
      refs.tester_definition_sha256,
      `${location}.setup_refs.tester_definition_sha256`,
    ),
    tester_agent_sha256: assertSha256(
      refs.tester_agent_sha256,
      `${location}.setup_refs.tester_agent_sha256`,
    ),
    validation_thresholds_sha256: assertSha256(
      refs.validation_thresholds_sha256,
      `${location}.setup_refs.validation_thresholds_sha256`,
    ),
    exposure_limit: requireInteger(refs.exposure_limit, `${location}.setup_refs.exposure_limit`, 1),
    owner_limits_sha256: assertSha256(
      refs.owner_limits_sha256,
      `${location}.setup_refs.owner_limits_sha256`,
    ),
    resource_inventory_sha256: assertSha256(
      value.resource_inventory_sha256,
      `${location}.resource_inventory_sha256`,
    ),
    baseline_sha256: assertSha256(value.baseline_sha256, `${location}.baseline_sha256`),
  };
  if (
    normalizedRefs.resource_inventory_sha256 !== value.resource_inventory_sha256 ||
    normalizedRefs.baseline_sha256 !== value.baseline_sha256
  )
    failA1("IDENTITY_MISMATCH", "charter setup references do not match direct hashes", location);
  const base: Omit<RootCharter, "charter_sha256"> = {
    schema_version: 1,
    charter_id: assertIdentifier(value.charter_id, `${location}.charter_id`),
    run_id: assertIdentifier(value.run_id, `${location}.run_id`),
    task_id: assertIdentifier(value.task_id, `${location}.task_id`),
    workflow_id: assertIdentifier(value.workflow_id, `${location}.workflow_id`),
    setup_revision: assertIdentifier(value.setup_revision, `${location}.setup_revision`),
    policy_revision: requireString(value.policy_revision, `${location}.policy_revision`),
    code_baseline_sha256: assertSha256(
      value.code_baseline_sha256,
      `${location}.code_baseline_sha256`,
    ),

    problem: requireString(value.problem, `${location}.problem`),
    expected_output: nonEmptyExpectedOutput(value.expected_output),
    evidence_refs: listOfStrings(value.evidence_refs, `${location}.evidence_refs`),
    constraints: (() => {
      if (!isRecord(value.constraints))
        failA1("CORRUPT_CHARTER", "constraints must be an object", `${location}.constraints`);
      return value.constraints;
    })(),
    input_snapshot_refs: listOfStrings(
      value.input_snapshot_refs,
      `${location}.input_snapshot_refs`,
    ),
    baseline_ref: "W_0",
    baseline_sha256: normalizedRefs.baseline_sha256,
    optimizable_scope: scopeValue as OptimizablePosition[],
    budget: value.budget,

    owner_limits: normalizedOwnerLimits,
    measurement: normalizedMeasurement,
    resource_inventory_sha256: normalizedRefs.resource_inventory_sha256,
    resource_inventory_ref: requireString(
      value.resource_inventory_ref,
      `${location}.resource_inventory_ref`,
    ),
    setup_refs: normalizedRefs,
  };
  validateCharterContent(base);
  const digest = assertSha256(value.charter_sha256, `${location}.charter_sha256`);
  if (digest !== charterHash(base))
    failA1("CHARTER_HASH_MISMATCH", "charter hash does not match its fields", location);
  return { ...base, charter_sha256: digest };
}

export function rootCharterPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, assertIdentifier(runId, "run_id"), "charter.json");
}

function assertCharterMatchesRun(
  charter: RootCharter,
  contract: RunRecord,
  location: string,
): void {
  if (
    charter.run_id !== contract.run_id ||
    contract.parent_run_id !== null ||
    contract.depth !== 0 ||
    contract.scope_path !== "/" ||
    contract.identity_material.charter_sha256 !== charter.charter_sha256
  )
    failA1("IDENTITY_MISMATCH", "root charter does not match run.json", location);
}

export function saveRootCharter(
  projectRoot: string,
  runId: string,
  value: RootCharter | RootCharterInput,
): RootCharter;
export function saveRootCharter(input: {
  project_root: string;
  run_id: string;
  charter: RootCharter | RootCharterInput;
}): RootCharter;
export function saveRootCharter(
  first: string | { project_root: string; run_id: string; charter: RootCharter | RootCharterInput },
  second?: string,
  third?: RootCharter | RootCharterInput,
): RootCharter {
  const projectRoot = typeof first === "string" ? first : first.project_root;
  const runId = typeof first === "string" ? second : first.run_id;
  const value = typeof first === "string" ? third : first.charter;
  if (runId === undefined || value === undefined)
    failA1("INVALID_VALUE", "run_id and charter are required");
  const contract = requireRunContract(projectRoot, runId);
  const charter =
    isRecord(value) && value.charter_sha256 !== undefined
      ? validateRootCharter(value)
      : createRootCharter({ ...(value as RootCharterInput), run_id: runId });
  const filePath = rootCharterPath(projectRoot, runId);
  assertCharterMatchesRun(charter, contract, filePath);
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateRootCharter(readStateFile(filePath), filePath);
      assertCharterMatchesRun(existing, contract, filePath);
      if (existing.charter_sha256 === charter.charter_sha256) return existing;
      failA1("IMMUTABLE_CONFLICT", "root charter is immutable", filePath);
    }
    writeStateJsonAtomic(filePath, charter);
    return charter;
  });
}

export function readRootCharter(projectRoot: string, runId: string): RootCharter {
  const contract = requireRunContract(projectRoot, runId);
  const filePath = rootCharterPath(projectRoot, runId);
  if (!fs.existsSync(filePath))
    failA1("CHARTER_NOT_FOUND", `root charter is missing at ${filePath}`, filePath);
  const charter = validateRootCharter(readStateFile(filePath), filePath);
  assertCharterMatchesRun(charter, contract, filePath);
  return charter;
}

export const createCharter = createRootCharter;
export const validateCharter = validateRootCharter;
export const saveCharter = saveRootCharter;
export const readCharter = readRootCharter;
