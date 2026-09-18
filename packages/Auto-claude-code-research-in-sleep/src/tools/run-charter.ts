import { canonicalJsonSha256 } from "./canonical-json.js";
import { normalizeOptimizableScope, type OptimizablePosition } from "./baseline-scope.js";
import { normalizeBudget, type BridgeBudget } from "./run-budget.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";

export interface RunMeasurement {
  validator_ref: string;
  tester_ref: string;
}
export interface RunCharter {
  schema_version: 1;
  charter_id: string;
  run_id: string;
  problem: string;
  expected_output: unknown;
  evidence_refs: string[];
  constraints: Record<string, unknown>;
  input_snapshot_refs: string[];
  baseline_ref: string;
  baseline_sha256: string;
  optimizable_scope: OptimizablePosition[];
  budget: BridgeBudget;
  measurement: RunMeasurement;
  resource_inventory_sha256: string;
  resource_inventory_ref: string;
  policy_revision: string;
  code_baseline_sha256: string;
  charter_sha256: string;
}
export type RunCharterInput = Omit<RunCharter, "charter_sha256">;
export function validateCharterContent(value: unknown): void {
  if (!isRecord(value)) failA1("CORRUPT_CHARTER", "charter must be an object");
  if (value.schema_version !== 1) failA1("CORRUPT_CHARTER", "unsupported charter schema");
  assertIdentifier(value.charter_id, "charter_id");
  assertIdentifier(value.run_id, "run_id");
  requireString(value.problem, "problem");
  if (
    value.expected_output == null ||
    (typeof value.expected_output === "string" && value.expected_output.trim() === "") ||
    (isRecord(value.expected_output) && Object.keys(value.expected_output).length === 0) ||
    (Array.isArray(value.expected_output) && value.expected_output.length === 0)
  )
    failA1("CORRUPT_CHARTER", "expected_output must describe the required content");
  if (!isRecord(value.constraints)) failA1("CORRUPT_CHARTER", "constraints must be an object");
  for (const key of ["evidence_refs", "input_snapshot_refs"] as const) {
    const refs = value[key];
    if (!Array.isArray(refs)) failA1("CORRUPT_CHARTER", `${key} must be an array`);
    refs.forEach((ref) => requireString(ref, key));
  }
  requireString(value.policy_revision, "policy_revision");
  assertSha256(value.code_baseline_sha256, "code_baseline_sha256");
  requireString(value.baseline_ref, "baseline_ref");
  assertSha256(value.baseline_sha256, "baseline_sha256");
  assertSha256(value.resource_inventory_sha256, "resource_inventory_sha256");
  requireString(value.resource_inventory_ref, "resource_inventory_ref");
  normalizeOptimizableScope(value.optimizable_scope, []);
  normalizeBudget(value.budget, "charter.budget");
  if (!isRecord(value.measurement))
    failA1("CORRUPT_CHARTER", "measurement must be frozen before starting a run");
  assertNoUnknownFields(value.measurement, ["validator_ref", "tester_ref"], "measurement");
  requireString(value.measurement.validator_ref, "measurement.validator_ref");
  requireString(value.measurement.tester_ref, "measurement.tester_ref");
}
export function charterSha256(value: object): string {
  const { charter_sha256: _hash, ...material } = value as Record<string, unknown>;
  validateCharterContent(material);
  return canonicalJsonSha256(material, undefined, { schemaVersion: "run-charter-v2" });
}
export function createRunCharter(input: RunCharterInput): RunCharter {
  validateCharterContent(input);
  return { ...input, charter_sha256: charterSha256(input) };
}
export function validateRunCharter(value: unknown): RunCharter {
  validateCharterContent(value);
  const charter = value as RunCharter;
  if (assertSha256(charter.charter_sha256, "charter_sha256") !== charterSha256(charter))
    failA1("CHARTER_HASH_MISMATCH", "charter content changed");
  return charter;
}
