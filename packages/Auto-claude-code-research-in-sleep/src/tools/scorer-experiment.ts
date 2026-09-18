import { runOwnedPath } from "./run-contract.js";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  beginScorerParentExperiment,
  assertScorerWaveRegistration,
  assertScorerRunArtifacts,
  readScorerRunState,
  sealScorerCandidate,
  sealScorerParent,
  type ScorerRunState,
} from "./scorer-state.js";
import {
  assertIdentifier,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";
import { validateScorerRevision, type ScorerRevision } from "./scorer-definition.js";

export interface EvaluationItem {
  item_id: string;
  input: unknown;
  contract: string;
  source: string;
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface EvaluationRequest {
  evaluation_item: DeepReadonly<EvaluationItem>;
  scorer_revision: DeepReadonly<ScorerRevision>;
  judge_binding_id: string | null;
}

export interface EvaluationResult {
  item_id: string;
  score: number;
  labels: string[];
  output_sha256: string;
}

export interface CaseManifest {
  schema_version: 1;
  manifest_id: string;
  scorer_revision: string;
  case_ids: string[];
  seed_manifest_sha256: string;
  manifest_sha256: string;
}

export interface SharedProbeManifest {
  schema_version: 1;
  shared_probe_manifest_id: string;
  case_ids: string[];
  source_revisions: Record<string, string[]>;
  case_source_revisions: Record<string, string>;
  seed_manifest_sha256: string;
  item_hashes: Record<string, string>;
  output_hashes: Record<string, string>;
  manifest_sha256: string;
}

export interface ScorerComparison {
  schema_version: 1;
  experiment_plan_sha256: string;
  parent_revision: string;
  candidate_revision: string;
  judge_binding_id: string | null;
  model_assignment_sha256: string;
  representative_artifact_id: string;
  representative_artifact_sha256: string;
  input_snapshot_sha256: string;
  parent_case_manifest: CaseManifest;
  candidate_case_manifest: CaseManifest;
  shared_probe_manifest: SharedProbeManifest;
  parent_results: EvaluationResult[];
  candidate_results: EvaluationResult[];
  execution_order: ["parent", "candidate"];
}

export interface ScorerExperimentFreeze {
  seed_manifest: unknown;
  representative_artifact_id: string;
  representative_artifact_sha256: string;
  input_snapshot_sha256: string;
  model_assignment_sha256: string;
  judge_binding_id: string | null;
}

export interface ScorerExperimentPlan extends ScorerExperimentFreeze {
  schema_version: 1;
  workflow_id: string;
  scorer_id: string;
  scorer_run_id: string;
  parent_revision: string;
  candidate_revision: string;
  parent_coverage_map_sha256: string;
  candidate_coverage_map_sha256: string;
  shared_probe_manifest_sha256: string;
  seed_manifest_sha256: string;
  plan_sha256: string;
}

/**
 * The evaluator receives the same narrow envelope a worker can receive from
 * the runner.  The runner keeps workflow state, candidate ranking, and the
 * model assignment outside this envelope.
 */
export type ScorerEvaluator = (request: Readonly<EvaluationRequest>) => EvaluationResult;
export type ProbeMaterializer = (
  caseId: string,
  sourceRevision: string,
  seedManifest?: unknown,
) => EvaluationItem;

const FORBIDDEN_EVALUATION_KEYS = new Set([
  "candidate",
  "candidate_rank",
  "candidate_ranking",
  "candidate_revision",
  "cell_scores",
  "dashboard",
  "incumbent",
  "model",
  "model_id",
  "model_override",
  "other_cell_scores",
  "prompt",
  "prompt_override",
  "selected_candidate_id",
  "scorer_revision",
  "scores",
  "wiki",
  "workflow",
  "workflow_id",
  "workflow_state",
  "adoption_state",
  "active_revision",
  "judge_binding_id",
]);

function compareIdentity(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortIdentity(values: readonly string[]): string[] {
  return [...values].sort(compareIdentity);
}

function rejectForbidden(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbidden(item, location + "[" + index + "]"));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVALUATION_KEYS.has(key))
      failA1(
        "EVALUATION_SCOPE_VIOLATION",
        "evaluation input contains forbidden '" + key + "'",
        location,
      );
    rejectForbidden(child, location + "." + key);
  }
}

function assertJsonEvaluationItem(item: EvaluationItem): void {
  try {
    canonicalJsonSha256(item, undefined, { schemaVersion: "evaluation-item-v1" });
  } catch (error: unknown) {
    failA1(
      "INVALID_EVALUATION_ITEM",
      "evaluation item must contain only canonical JSON values: " + String(error),
    );
  }
}

function freezeValue<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return Object.freeze(value);
  for (const child of Object.values(value)) freezeValue(child);
  return Object.freeze(value);
}

export function validateEvaluationItem(value: unknown): EvaluationItem {
  if (!isRecord(value)) failA1("INVALID_EVALUATION_ITEM", "evaluation item must be an object");
  const allowed = ["item_id", "input", "contract", "source"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("EVALUATION_SCOPE_VIOLATION", "unknown evaluation item field '" + key + "'");
  if (!Object.hasOwn(value, "input"))
    failA1("INVALID_EVALUATION_ITEM", "evaluation item input is required");
  const item: EvaluationItem = {
    item_id: assertIdentifier(value.item_id, "evaluation_item.item_id"),
    input: value.input,
    contract: requireString(value.contract, "evaluation_item.contract"),
    source: requireString(value.source, "evaluation_item.source"),
  };
  rejectForbidden(item.input, "evaluation_item.input");
  assertJsonEvaluationItem(item);
  return item;
}

export function validateEvaluationRequest(value: unknown): EvaluationRequest {
  if (!isRecord(value))
    failA1("INVALID_EVALUATION_REQUEST", "evaluation request must be an object");
  const allowed = ["evaluation_item", "scorer_revision", "judge_binding_id"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("EVALUATION_SCOPE_VIOLATION", "unknown evaluation request field '" + key + "'");
  return {
    evaluation_item: validateEvaluationItem(value.evaluation_item),
    scorer_revision: validateScorerRevision(value.scorer_revision),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, "evaluation_request.judge_binding_id"),
  };
}

export function validateEvaluationResult(
  value: unknown,
  expectedItemId?: string,
): EvaluationResult {
  if (!isRecord(value)) failA1("INVALID_EVALUATION_RESULT", "evaluation result must be an object");
  const allowed = ["item_id", "score", "labels", "output_sha256"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", "unknown evaluation result field '" + key + "'");
  const itemId = assertIdentifier(value.item_id, "evaluation_result.item_id");
  if (expectedItemId !== undefined && itemId !== expectedItemId)
    failA1("IDENTITY_MISMATCH", "evaluation result item id differs from request");
  if (typeof value.score !== "number" || !Number.isFinite(value.score))
    failA1("INVALID_EVALUATION_RESULT", "score must be finite");
  if (!Array.isArray(value.labels) || !value.labels.every((label) => typeof label === "string"))
    failA1("INVALID_EVALUATION_RESULT", "labels must be a string array");
  return {
    item_id: itemId,
    score: value.score,
    labels: value.labels.map((label, index) =>
      requireString(label, "evaluation_result.labels[" + index + "]"),
    ),
    output_sha256: assertSha256(value.output_sha256, "evaluation_result.output_sha256"),
  };
}

function activeCaseIds(revision: ScorerRevision): string[] {
  return sortIdentity(
    revision.benchmark_items
      .filter((item) => item.status === "active")
      .map((item) => item.benchmark_id),
  );
}

export function materializeCaseManifest(
  revisionValue: ScorerRevision,
  seedManifest: unknown,
): CaseManifest {
  const revision = validateScorerRevision(revisionValue);
  const seedHash = canonicalJsonSha256(seedManifest, undefined, {
    schemaVersion: "scorer-seed-manifest-v1",
  });
  const caseIds = activeCaseIds(revision);
  const base = {
    schema_version: 1 as const,
    scorer_revision: revision.revision,
    case_ids: caseIds,
    seed_manifest_sha256: seedHash,
  };
  const manifestSha256 = canonicalJsonSha256(base, undefined, {
    schemaVersion: "scorer-case-manifest-v1",
  });
  return {
    ...base,
    manifest_id: "case-manifest:sha256:" + manifestSha256,
    manifest_sha256: manifestSha256,
  };
}

function sourceRevisionFor(
  caseId: string,
  parentIds: readonly string[],
  candidateRevision: string,
  parentRevision: string,
): string {
  return parentIds.includes(caseId) ? parentRevision : candidateRevision;
}

function materializeProbeItem(
  caseId: string,
  sourceRevision: string,
  candidateOnly: boolean,
  materialize: ProbeMaterializer,
  seedManifest: unknown,
  preMaterializedItems?: ReadonlyMap<string, EvaluationItem>,
): EvaluationItem {
  try {
    const supplied = preMaterializedItems?.get(caseId);
    const item = validateEvaluationItem(
      supplied === undefined
        ? materialize(caseId, sourceRevision, structuredClone(seedManifest))
        : structuredClone(supplied),
    );
    if (item.item_id !== caseId)
      failA1(
        "SCORER_CASE_MISMATCH",
        "materialized item '" + item.item_id + "' does not match case '" + caseId + "'",
      );
    if (item.source !== sourceRevision)
      failA1(
        "SCORER_CASE_SOURCE_MISMATCH",
        "case '" +
          caseId +
          "' declares source '" +
          item.source +
          "' but was materialized from '" +
          sourceRevision +
          "'",
      );
    return structuredClone(item);
  } catch (error: unknown) {
    if (candidateOnly)
      failA1(
        "SCORER_CANDIDATE_INVALID",
        "candidate case '" +
          caseId +
          "' cannot be materialized in the frozen workflow: " +
          String(error),
      );
    throw error;
  }
}

interface SharedProbeBuild {
  manifest: SharedProbeManifest;
  items: Map<string, EvaluationItem>;
}

function buildSharedProbe(
  parentValue: ScorerRevision,
  candidateValue: ScorerRevision,
  seedManifest: unknown,
  materialize: ProbeMaterializer,
  preMaterializedItems?: ReadonlyMap<string, EvaluationItem>,
): SharedProbeBuild {
  const parent = validateScorerRevision(parentValue);
  const candidate = validateScorerRevision(candidateValue);
  if (candidate.parent_revision !== parent.revision)
    failA1("SCORER_PARENT_MISMATCH", "candidate revision does not name parent revision");
  const parentIds = activeCaseIds(parent);
  const candidateIds = activeCaseIds(candidate);
  const caseIds = sortIdentity([...new Set([...parentIds, ...candidateIds])]);
  const seedHash = canonicalJsonSha256(seedManifest, undefined, {
    schemaVersion: "scorer-seed-manifest-v1",
  });
  const sourceRevisions: Record<string, string[]> = {};
  const caseSourceRevisions: Record<string, string> = {};
  const itemHashes: Record<string, string> = {};
  const outputHashes: Record<string, string> = {};
  const items = new Map<string, EvaluationItem>();

  for (const caseId of caseIds) {
    const sourceRevision = sourceRevisionFor(
      caseId,
      parentIds,
      candidate.revision,
      parent.revision,
    );
    const item = materializeProbeItem(
      caseId,
      sourceRevision,
      candidateIds.includes(caseId) && !parentIds.includes(caseId),
      materialize,
      seedManifest,
      preMaterializedItems,
    );
    items.set(caseId, item);
    const sources: string[] = [];
    if (parentIds.includes(caseId)) sources.push(parent.revision);
    if (candidateIds.includes(caseId)) sources.push(candidate.revision);
    sourceRevisions[caseId] = sources;
    caseSourceRevisions[caseId] = sourceRevision;
    const itemHash = canonicalJsonSha256(
      { evaluation_item: item, seed_manifest: seedManifest },
      undefined,
      { schemaVersion: "shared-probe-item-v1" },
    );
    itemHashes[caseId] = itemHash;
    outputHashes[caseId] = itemHash;
  }
  const base = {
    schema_version: 1 as const,
    case_ids: caseIds,
    source_revisions: sourceRevisions,
    case_source_revisions: caseSourceRevisions,
    seed_manifest_sha256: seedHash,
    item_hashes: itemHashes,
    output_hashes: outputHashes,
  };
  const manifestSha256 = canonicalJsonSha256(base, undefined, {
    schemaVersion: "shared-probe-manifest-v1",
  });
  return {
    items,
    manifest: {
      ...base,
      shared_probe_manifest_id: "shared-probe:sha256:" + manifestSha256,
      manifest_sha256: manifestSha256,
    },
  };
}

export function materializeSharedProbe(
  parent: ScorerRevision,
  candidate: ScorerRevision,
  seedManifest: unknown,
  materialize: ProbeMaterializer,
  preMaterializedItems?: ReadonlyMap<string, EvaluationItem>,
): SharedProbeManifest {
  return buildSharedProbe(parent, candidate, seedManifest, materialize, preMaterializedItems)
    .manifest;
}

function evaluateRevision(
  revision: ScorerRevision,
  caseIds: readonly string[],
  sharedItems: ReadonlyMap<string, EvaluationItem>,
  judgeBindingId: string | null,
  evaluate: ScorerEvaluator,
): EvaluationResult[] {
  const frozenRevision = freezeValue(structuredClone(revision));
  return caseIds.map((caseId) => {
    const item = sharedItems.get(caseId);
    if (item === undefined)
      failA1("SCORER_CASE_MISMATCH", "shared probe has no materialized item for '" + caseId + "'");
    const sealedItem = freezeValue(validateEvaluationItem(structuredClone(item)));
    const request = freezeValue(
      validateEvaluationRequest({
        evaluation_item: sealedItem,
        scorer_revision: frozenRevision,
        judge_binding_id: judgeBindingId,
      }),
    );
    const resultValue = evaluate(request);
    return validateEvaluationResult(resultValue, caseId);
  });
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_COMPARISON", "unknown field '" + key + "'", location);
  }
}

function validateCaseManifest(value: unknown, location: string): CaseManifest {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_COMPARISON", location + " must be an object");
  assertKnownFields(
    value,
    [
      "schema_version",
      "manifest_id",
      "scorer_revision",
      "case_ids",
      "seed_manifest_sha256",
      "manifest_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1 || !Array.isArray(value.case_ids))
    failA1("CORRUPT_SCORER_COMPARISON", location + " has an invalid envelope");
  const caseIds = value.case_ids.map((caseId, index) =>
    assertIdentifier(caseId, location + ".case_ids[" + index + "]"),
  );
  const sortedCaseIds = sortIdentity(caseIds);
  if (
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id, index) => id !== sortedCaseIds[index])
  )
    failA1("CORRUPT_SCORER_COMPARISON", location + ".case_ids must be sorted and unique");
  const scorerRevision = assertIdentifier(value.scorer_revision, location + ".scorer_revision");
  const seedManifestSha256 = assertSha256(
    value.seed_manifest_sha256,
    location + ".seed_manifest_sha256",
  );
  const manifestSha256 = assertSha256(value.manifest_sha256, location + ".manifest_sha256");
  const base = {
    schema_version: 1 as const,
    scorer_revision: scorerRevision,
    case_ids: caseIds,
    seed_manifest_sha256: seedManifestSha256,
  };
  if (
    manifestSha256 !==
    canonicalJsonSha256(base, undefined, { schemaVersion: "scorer-case-manifest-v1" })
  )
    failA1("CORRUPT_SCORER_COMPARISON", location + " has an invalid manifest hash");
  if (value.manifest_id !== "case-manifest:sha256:" + manifestSha256)
    failA1("CORRUPT_SCORER_COMPARISON", location + " has an invalid manifest id");
  return {
    ...base,
    manifest_id: "case-manifest:sha256:" + manifestSha256,
    manifest_sha256: manifestSha256,
  };
}

function validateHashRecord(
  value: unknown,
  caseIds: readonly string[],
  location: string,
): Record<string, string> {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_COMPARISON", location + " must be an object");
  const expected = new Set(caseIds);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      failA1("CORRUPT_SCORER_COMPARISON", location + " has an unknown case id '" + key + "'");
  }
  const records: Record<string, string> = {};
  for (const caseId of caseIds) {
    if (!Object.hasOwn(value, caseId))
      failA1("CORRUPT_SCORER_COMPARISON", location + " is missing case '" + caseId + "'");
    records[caseId] = assertSha256(value[caseId], location + "." + caseId);
  }
  return records;
}

function validateSourceRecord(
  value: unknown,
  caseIds: readonly string[],
  location: string,
): Record<string, string[]> {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_COMPARISON", location + " must be an object");
  const expected = new Set(caseIds);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      failA1("CORRUPT_SCORER_COMPARISON", location + " has an unknown case id '" + key + "'");
  }
  const records: Record<string, string[]> = {};
  for (const caseId of caseIds) {
    const rawRevisions = value[caseId];
    if (!Array.isArray(rawRevisions) || rawRevisions.length === 0)
      failA1("CORRUPT_SCORER_COMPARISON", location + " is missing case '" + caseId + "'");
    const revisions = rawRevisions.map((revision, index) =>
      assertIdentifier(revision, location + "." + caseId + "[" + index + "]"),
    );
    if (new Set(revisions).size !== revisions.length)
      failA1(
        "CORRUPT_SCORER_COMPARISON",
        location + " has duplicate revisions for '" + caseId + "'",
      );
    records[caseId] = revisions;
  }
  return records;
}

function validateSharedProbeManifest(value: unknown, location: string): SharedProbeManifest {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_COMPARISON", location + " must be an object");
  assertKnownFields(
    value,
    [
      "schema_version",
      "shared_probe_manifest_id",
      "case_ids",
      "source_revisions",
      "case_source_revisions",
      "seed_manifest_sha256",
      "item_hashes",
      "output_hashes",
      "manifest_sha256",
    ],
    location,
  );
  if (value.schema_version !== 1 || !Array.isArray(value.case_ids))
    failA1("CORRUPT_SCORER_COMPARISON", location + " has an invalid envelope");
  const caseIds = value.case_ids.map((caseId, index) =>
    assertIdentifier(caseId, location + ".case_ids[" + index + "]"),
  );
  const sortedCaseIds = sortIdentity(caseIds);
  if (
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id, index) => id !== sortedCaseIds[index])
  )
    failA1("CORRUPT_SCORER_COMPARISON", location + ".case_ids must be sorted and unique");
  const sourceRevisions = validateSourceRecord(
    value.source_revisions,
    caseIds,
    location + ".source_revisions",
  );
  if (!isRecord(value.case_source_revisions))
    failA1("CORRUPT_SCORER_COMPARISON", location + ".case_source_revisions must be an object");
  const caseSourceRevisions: Record<string, string> = {};
  for (const key of Object.keys(value.case_source_revisions)) {
    if (!new Set(caseIds).has(key))
      failA1("CORRUPT_SCORER_COMPARISON", location + " has an unknown source case '" + key + "'");
  }
  for (const caseId of caseIds) {
    const source = assertIdentifier(
      value.case_source_revisions[caseId],
      location + ".case_source_revisions." + caseId,
    );
    if (!sourceRevisions[caseId]!.includes(source))
      failA1(
        "CORRUPT_SCORER_COMPARISON",
        location + " has a source not listed for '" + caseId + "'",
      );
    caseSourceRevisions[caseId] = source;
  }
  const itemHashes = validateHashRecord(value.item_hashes, caseIds, location + ".item_hashes");
  const outputHashes = validateHashRecord(
    value.output_hashes,
    caseIds,
    location + ".output_hashes",
  );
  const seedManifestSha256 = assertSha256(
    value.seed_manifest_sha256,
    location + ".seed_manifest_sha256",
  );
  const base = {
    schema_version: 1 as const,
    case_ids: caseIds,
    source_revisions: sourceRevisions,
    case_source_revisions: caseSourceRevisions,
    seed_manifest_sha256: seedManifestSha256,
    item_hashes: itemHashes,
    output_hashes: outputHashes,
  };
  const manifestSha256 = assertSha256(value.manifest_sha256, location + ".manifest_sha256");
  if (
    manifestSha256 !==
    canonicalJsonSha256(base, undefined, { schemaVersion: "shared-probe-manifest-v1" })
  )
    failA1("CORRUPT_SCORER_COMPARISON", location + " has an invalid manifest hash");
  if (value.shared_probe_manifest_id !== "shared-probe:sha256:" + manifestSha256)
    failA1("CORRUPT_SCORER_COMPARISON", location + " has an invalid manifest id");
  return {
    ...base,
    shared_probe_manifest_id: "shared-probe:sha256:" + manifestSha256,
    manifest_sha256: manifestSha256,
  };
}

export function validateScorerComparison(value: unknown): ScorerComparison {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_COMPARISON", "scorer comparison must be an object");
  const allowed = [
    "schema_version",
    "experiment_plan_sha256",
    "parent_revision",
    "candidate_revision",
    "judge_binding_id",
    "model_assignment_sha256",
    "representative_artifact_id",
    "representative_artifact_sha256",
    "input_snapshot_sha256",
    "parent_case_manifest",
    "candidate_case_manifest",
    "shared_probe_manifest",
    "parent_results",
    "candidate_results",
    "execution_order",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_COMPARISON", "unknown comparison field '" + key + "'");
  if (value.schema_version !== 1 || value.execution_order === undefined)
    failA1("CORRUPT_SCORER_COMPARISON", "invalid scorer comparison envelope");
  if (
    !Array.isArray(value.parent_results) ||
    !Array.isArray(value.candidate_results) ||
    !Array.isArray(value.execution_order) ||
    value.execution_order.length !== 2 ||
    value.execution_order[0] !== "parent" ||
    value.execution_order[1] !== "candidate"
  )
    failA1("CORRUPT_SCORER_COMPARISON", "scorer comparison results are incomplete");
  const experimentPlanSha256 = assertSha256(
    value.experiment_plan_sha256,
    "comparison.experiment_plan_sha256",
  );
  const parentRevision = assertIdentifier(value.parent_revision, "comparison.parent_revision");
  const candidateRevision = assertIdentifier(
    value.candidate_revision,
    "comparison.candidate_revision",
  );
  const judgeBindingId =
    value.judge_binding_id === null
      ? null
      : assertIdentifier(value.judge_binding_id, "comparison.judge_binding_id");
  const modelAssignmentSha256 = assertSha256(
    value.model_assignment_sha256,
    "comparison.model_assignment_sha256",
  );
  const representativeArtifactId = assertIdentifier(
    value.representative_artifact_id,
    "comparison.representative_artifact_id",
  );
  const representativeArtifactSha256 = assertSha256(
    value.representative_artifact_sha256,
    "comparison.representative_artifact_sha256",
  );
  const inputSnapshotSha256 = assertSha256(
    value.input_snapshot_sha256,
    "comparison.input_snapshot_sha256",
  );
  const parentManifest = validateCaseManifest(
    value.parent_case_manifest,
    "comparison.parent_case_manifest",
  );
  const candidateManifest = validateCaseManifest(
    value.candidate_case_manifest,
    "comparison.candidate_case_manifest",
  );
  const sharedManifest = validateSharedProbeManifest(
    value.shared_probe_manifest,
    "comparison.shared_probe_manifest",
  );
  const parentResults = value.parent_results.map((result) => validateEvaluationResult(result));
  const candidateResults = value.candidate_results.map((result) =>
    validateEvaluationResult(result),
  );
  const expectedSharedCaseIds = sortIdentity([
    ...new Set([...parentManifest.case_ids, ...candidateManifest.case_ids]),
  ]);
  if (
    parentManifest.scorer_revision !== parentRevision ||
    candidateManifest.scorer_revision !== candidateRevision ||
    parentManifest.seed_manifest_sha256 !== candidateManifest.seed_manifest_sha256 ||
    sharedManifest.seed_manifest_sha256 !== parentManifest.seed_manifest_sha256 ||
    JSON.stringify(sharedManifest.case_ids) !== JSON.stringify(expectedSharedCaseIds) ||
    sharedManifest.case_ids.length !== parentResults.length ||
    sharedManifest.case_ids.length !== candidateResults.length ||
    parentResults.some((result, index) => result.item_id !== sharedManifest.case_ids[index]) ||
    candidateResults.some((result, index) => result.item_id !== sharedManifest.case_ids[index])
  )
    failA1("CORRUPT_SCORER_COMPARISON", "comparison does not contain complete shared results");
  return {
    schema_version: 1,
    experiment_plan_sha256: experimentPlanSha256,
    parent_revision: parentRevision,
    candidate_revision: candidateRevision,
    judge_binding_id: judgeBindingId,
    model_assignment_sha256: modelAssignmentSha256,
    representative_artifact_id: representativeArtifactId,
    representative_artifact_sha256: representativeArtifactSha256,
    input_snapshot_sha256: inputSnapshotSha256,
    parent_case_manifest: parentManifest,
    candidate_case_manifest: candidateManifest,
    shared_probe_manifest: sharedManifest,
    parent_results: parentResults,
    candidate_results: candidateResults,
    execution_order: ["parent", "candidate"],
  };
}

function strictLockPath(projectRoot: string, workflowId: string): string {
  return path.join(path.resolve(projectRoot), ".aris", "workflows", workflowId, "scorer-wave.lock");
}

function scorerRunDirectory(projectRoot: string, scorerRunId: string): string {
  return runOwnedPath(projectRoot, scorerRunId);
}

function experimentPlanPath(projectRoot: string, scorerRunId: string): string {
  return path.join(scorerRunDirectory(projectRoot, scorerRunId), "experiment-plan.json");
}

function caseManifestPath(
  projectRoot: string,
  scorerRunId: string,
  side: "parent" | "candidate" | "shared-probe",
): string {
  return path.join(scorerRunDirectory(projectRoot, scorerRunId), "case-manifests", side + ".json");
}

function sharedProbeItemsPath(projectRoot: string, scorerRunId: string): string {
  return path.join(scorerRunDirectory(projectRoot, scorerRunId), "shared-probe-inputs.json");
}

function resultCheckpointPath(
  projectRoot: string,
  scorerRunId: string,
  side: "parent" | "candidate",
): string {
  return path.join(scorerRunDirectory(projectRoot, scorerRunId), side + "-results.json");
}

function assertScorerWaveMembership(input: {
  project_root: string;
  workflow_id: string;
  scorer_id: string;
  scorer_run_id: string;
  parent_revision: string;
  candidate_revision: string;
}): ScorerRunState {
  const state = readScorerRunState(input.project_root, input.scorer_run_id);
  if (
    state.workflow_id !== input.workflow_id ||
    state.scorer_id !== input.scorer_id ||
    state.parent_revision !== input.parent_revision ||
    state.candidate_revision !== input.candidate_revision
  )
    failA1("IDENTITY_MISMATCH", "comparison does not belong to the requested scorer wave");
  if (state.status === "activated" || state.status === "rejected" || state.status === "failed")
    failA1("SCORER_STATE_ORDER", "a terminal scorer run cannot run another comparison");

  assertScorerWaveRegistration({
    project_root: input.project_root,
    workflow_id: input.workflow_id,
    scorer_id: input.scorer_id,
    scorer_run_id: input.scorer_run_id,
    outer_run_id: state.outer_run_id,
    outer_iteration: state.outer_iteration,
    wave_id: state.wave_id,
    parent_revision: state.parent_revision,
    candidate_revision: state.candidate_revision,
    delta_id: state.delta_id,
  });

  const activeWavePath = path.join(path.resolve(input.project_root), ".aris", "active-wave.json");
  if (!fs.existsSync(activeWavePath))
    failA1("SCORER_WAVE_NOT_FOUND", "scorer wave marker does not exist");
  const activeWave = readStateFile(activeWavePath);
  if (
    !isRecord(activeWave) ||
    activeWave.status !== "running" ||
    activeWave.wave_kind !== "scorer" ||
    activeWave.scorer_run_id !== input.scorer_run_id ||
    activeWave.scorer_id !== input.scorer_id
  )
    failA1("SCORER_WAVE_EXCLUSIVE", "comparison is not owned by the active scorer wave");

  const scorerMarkerPath = path.join(
    path.resolve(input.project_root),
    ".aris",
    "scorers",
    input.scorer_id,
    "active-run.json",
  );
  if (!fs.existsSync(scorerMarkerPath))
    failA1("SCORER_WAVE_NOT_FOUND", "scorer run marker does not exist");
  const scorerMarker = readStateFile(scorerMarkerPath);
  if (
    !isRecord(scorerMarker) ||
    scorerMarker.schema_version !== 1 ||
    scorerMarker.status !== "running" ||
    scorerMarker.workflow_id !== input.workflow_id ||
    scorerMarker.scorer_id !== input.scorer_id ||
    scorerMarker.scorer_run_id !== input.scorer_run_id
  )
    failA1("SCORER_WAVE_EXCLUSIVE", "comparison is not owned by its scorer run marker");

  return state;
}

function normalizeFreeze(value: ScorerExperimentFreeze): ScorerExperimentFreeze {
  if (!isRecord(value)) failA1("INVALID_SCORER_INPUT", "scorer freeze must be an object");
  let seedManifest: unknown;
  try {
    seedManifest = structuredClone(value.seed_manifest);
    canonicalJsonSha256(seedManifest, undefined, { schemaVersion: "scorer-seed-manifest-v1" });
  } catch (error: unknown) {
    failA1("INVALID_SCORER_INPUT", "seed manifest is not canonical JSON: " + String(error));
  }
  return {
    seed_manifest: seedManifest,
    representative_artifact_id: assertIdentifier(
      value.representative_artifact_id,
      "scorer_freeze.representative_artifact_id",
    ),
    representative_artifact_sha256: assertSha256(
      value.representative_artifact_sha256,
      "scorer_freeze.representative_artifact_sha256",
    ),
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      "scorer_freeze.input_snapshot_sha256",
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      "scorer_freeze.model_assignment_sha256",
    ),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, "scorer_freeze.judge_binding_id"),
  };
}

function planBase(
  state: ScorerRunState,
  parent: ScorerRevision,
  candidate: ScorerRevision,
  freeze: ScorerExperimentFreeze,
  sharedProbeManifestSha256: string,
): Omit<ScorerExperimentPlan, "plan_sha256"> {
  const normalizedFreeze = normalizeFreeze(freeze);
  const seedManifestSha256 = canonicalJsonSha256(normalizedFreeze.seed_manifest, undefined, {
    schemaVersion: "scorer-seed-manifest-v1",
  });
  return {
    schema_version: 1,
    workflow_id: state.workflow_id,
    scorer_id: state.scorer_id,
    scorer_run_id: state.scorer_run_id,
    parent_revision: parent.revision,
    candidate_revision: candidate.revision,
    parent_coverage_map_sha256: parent.coverage_map_sha256,
    candidate_coverage_map_sha256: candidate.coverage_map_sha256,
    shared_probe_manifest_sha256: assertSha256(
      sharedProbeManifestSha256,
      "scorer_freeze.shared_probe_manifest_sha256",
    ),
    seed_manifest: normalizedFreeze.seed_manifest,
    seed_manifest_sha256: seedManifestSha256,
    representative_artifact_id: normalizedFreeze.representative_artifact_id,
    representative_artifact_sha256: normalizedFreeze.representative_artifact_sha256,
    input_snapshot_sha256: normalizedFreeze.input_snapshot_sha256,
    model_assignment_sha256: normalizedFreeze.model_assignment_sha256,
    judge_binding_id: normalizedFreeze.judge_binding_id,
  };
}

function makePlan(
  state: ScorerRunState,
  parent: ScorerRevision,
  candidate: ScorerRevision,
  freeze: ScorerExperimentFreeze,
  sharedProbeManifestSha256: string,
): ScorerExperimentPlan {
  const base = planBase(state, parent, candidate, freeze, sharedProbeManifestSha256);
  const planSha256 = canonicalJsonSha256(base, undefined, {
    schemaVersion: "scorer-experiment-plan-v1",
  });
  return { ...base, plan_sha256: planSha256 };
}

function validatePlan(value: unknown, location: string): ScorerExperimentPlan {
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_INPUT", "experiment plan must be an object", location);
  const allowed = [
    "schema_version",
    "workflow_id",
    "scorer_id",
    "scorer_run_id",
    "parent_revision",
    "candidate_revision",
    "parent_coverage_map_sha256",
    "candidate_coverage_map_sha256",
    "shared_probe_manifest_sha256",
    "seed_manifest",
    "seed_manifest_sha256",
    "representative_artifact_id",
    "representative_artifact_sha256",
    "input_snapshot_sha256",
    "model_assignment_sha256",
    "judge_binding_id",
    "plan_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_INPUT", "unknown plan field '" + key + "'", location);
  if (value.schema_version !== 1)
    failA1("CORRUPT_SCORER_INPUT", "experiment plan schema_version must be 1", location);
  const seedManifest = structuredClone(value.seed_manifest);
  const seedManifestSha256 = assertSha256(
    value.seed_manifest_sha256,
    location + ".seed_manifest_sha256",
  );
  if (
    seedManifestSha256 !==
    canonicalJsonSha256(seedManifest, undefined, { schemaVersion: "scorer-seed-manifest-v1" })
  )
    failA1(
      "SCORER_INPUT_HASH_MISMATCH",
      "seed manifest hash does not match frozen contents",
      location,
    );
  const base = {
    schema_version: 1 as const,
    workflow_id: assertIdentifier(value.workflow_id, location + ".workflow_id"),
    scorer_id: assertIdentifier(value.scorer_id, location + ".scorer_id"),
    scorer_run_id: assertIdentifier(value.scorer_run_id, location + ".scorer_run_id"),
    parent_revision: assertIdentifier(value.parent_revision, location + ".parent_revision"),
    candidate_revision: assertIdentifier(
      value.candidate_revision,
      location + ".candidate_revision",
    ),
    parent_coverage_map_sha256: assertSha256(
      value.parent_coverage_map_sha256,
      location + ".parent_coverage_map_sha256",
    ),
    candidate_coverage_map_sha256: assertSha256(
      value.candidate_coverage_map_sha256,
      location + ".candidate_coverage_map_sha256",
    ),
    shared_probe_manifest_sha256: assertSha256(
      value.shared_probe_manifest_sha256,
      location + ".shared_probe_manifest_sha256",
    ),
    seed_manifest: seedManifest,
    seed_manifest_sha256: seedManifestSha256,
    representative_artifact_id: assertIdentifier(
      value.representative_artifact_id,
      location + ".representative_artifact_id",
    ),
    representative_artifact_sha256: assertSha256(
      value.representative_artifact_sha256,
      location + ".representative_artifact_sha256",
    ),
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      location + ".input_snapshot_sha256",
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      location + ".model_assignment_sha256",
    ),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, location + ".judge_binding_id"),
  };
  const planSha256 = assertSha256(value.plan_sha256, location + ".plan_sha256");
  if (
    planSha256 !==
    canonicalJsonSha256(base, undefined, { schemaVersion: "scorer-experiment-plan-v1" })
  )
    failA1(
      "SCORER_INPUT_HASH_MISMATCH",
      "experiment plan hash does not match frozen contents",
      location,
    );
  return { ...base, plan_sha256: planSha256 };
}

function assertFreezeMatchesPlan(
  plan: ScorerExperimentPlan,
  freezeValue: ScorerExperimentFreeze,
): void {
  const normalized = normalizeFreeze(freezeValue);
  if (
    canonicalJsonSha256(normalized.seed_manifest, undefined, {
      schemaVersion: "scorer-seed-manifest-v1",
    }) !== plan.seed_manifest_sha256 ||
    normalized.representative_artifact_id !== plan.representative_artifact_id ||
    normalized.representative_artifact_sha256 !== plan.representative_artifact_sha256 ||
    normalized.input_snapshot_sha256 !== plan.input_snapshot_sha256 ||
    normalized.model_assignment_sha256 !== plan.model_assignment_sha256 ||
    normalized.judge_binding_id !== plan.judge_binding_id
  )
    failA1("SCORER_INPUT_CONFLICT", "comparison input differs from the frozen experiment plan");
}

function readStoredRevision(
  projectRoot: string,
  scorerId: string,
  revisionId: string,
): ScorerRevision {
  const filePath = path.join(
    path.resolve(projectRoot),
    ".aris",
    "scorers",
    assertIdentifier(scorerId, "scorer_id"),
    "revisions",
    assertIdentifier(revisionId, "scorer_revision"),
    "definition.json",
  );
  if (!fs.existsSync(filePath))
    failA1("SCORER_REVISION_NOT_FOUND", "immutable scorer revision is missing at " + filePath);
  const revision = validateScorerRevision(readStateFile(filePath));
  if (revision.scorer_id !== scorerId || revision.revision !== revisionId)
    failA1("IDENTITY_MISMATCH", "stored scorer revision does not match the wave identity");
  return revision;
}

function readPlan(projectRoot: string, scorerRunId: string): ScorerExperimentPlan {
  const filePath = experimentPlanPath(projectRoot, scorerRunId);
  if (!fs.existsSync(filePath))
    failA1("SCORER_INPUTS_NOT_FROZEN", "experiment plan is missing at " + filePath);
  return validatePlan(readStateFile(filePath), filePath);
}

export interface FreezeScorerComparisonInput {
  project_root: string;
  workflow_id: string;
  scorer_id: string;
  scorer_run_id: string;
  parent: ScorerRevision;
  candidate: ScorerRevision;
  freeze: ScorerExperimentFreeze;
  /** Shared probe inputs are fixed by the scheduler before any evaluator runs. */
  materialize: ProbeMaterializer;
}

export function freezeScorerComparisonInput(
  input: FreezeScorerComparisonInput,
): ScorerExperimentPlan {
  if (
    !isRecord(input) ||
    input.project_root === undefined ||
    input.workflow_id === undefined ||
    input.scorer_id === undefined ||
    input.scorer_run_id === undefined
  )
    failA1("IDENTITY_MISMATCH", "scorer comparison freeze needs an input object");
  requireString(input.project_root, "project_root");
  if (typeof input.materialize !== "function")
    failA1(
      "INVALID_SCORER_INPUT",
      "shared probe inputs must be materialized during the explicit freeze step",
    );
  const workflowId = assertIdentifier(input.workflow_id, "workflow_id");
  const scorerId = assertIdentifier(input.scorer_id, "scorer_id");
  const scorerRunId = assertIdentifier(input.scorer_run_id, "scorer_run_id");
  const state = assertScorerWaveMembership({
    project_root: input.project_root,
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    parent_revision: input.parent.revision,
    candidate_revision: input.candidate.revision,
  });
  assertScorerRunArtifacts(input.project_root, input.scorer_run_id);
  if (state.status !== "materialized")
    failA1("SCORER_STATE_ORDER", "comparison inputs must be frozen after materialization");
  const parent = readStoredRevision(input.project_root, scorerId, state.parent_revision);
  const candidate = readStoredRevision(input.project_root, scorerId, state.candidate_revision);
  if (
    parent.definition_sha256 !== validateScorerRevision(input.parent).definition_sha256 ||
    candidate.definition_sha256 !== validateScorerRevision(input.candidate).definition_sha256
  )
    failA1("SCORER_INPUT_CONFLICT", "comparison revisions differ from immutable stored revisions");
  const freeze = normalizeFreeze(input.freeze);
  const lockPath = strictLockPath(input.project_root, workflowId);
  return withStateFileLock(lockPath, () => {
    // This is the only place where the caller-provided materializer may select
    // probe contents.  The resulting manifest and item snapshot are written
    // under the same lock as the plan before an evaluator can start.
    const parentManifest = materializeCaseManifest(parent, freeze.seed_manifest);
    const candidateManifest = materializeCaseManifest(candidate, freeze.seed_manifest);
    const shared = buildSharedProbe(parent, candidate, freeze.seed_manifest, input.materialize);
    const plan = makePlan(state, parent, candidate, freeze, shared.manifest.manifest_sha256);
    const planPath = experimentPlanPath(input.project_root, scorerRunId);
    const existing = fs.existsSync(planPath)
      ? validatePlan(readStateFile(planPath), planPath)
      : null;
    if (existing !== null && existing.plan_sha256 !== plan.plan_sha256)
      failA1("SCORER_INPUT_CONFLICT", "experiment plan is immutable and already differs");

    immutableJson(
      caseManifestPath(input.project_root, scorerRunId, "parent"),
      parentManifest,
      "SCORER_INPUT_CONFLICT",
    );
    immutableJson(
      caseManifestPath(input.project_root, scorerRunId, "candidate"),
      candidateManifest,
      "SCORER_INPUT_CONFLICT",
    );
    immutableJson(
      caseManifestPath(input.project_root, scorerRunId, "shared-probe"),
      shared.manifest,
      "SCORER_INPUT_CONFLICT",
    );
    immutableJson(
      sharedProbeItemsPath(input.project_root, scorerRunId),
      sharedProbeInputValue(shared.manifest, shared.items),
      "SCORER_INPUT_CONFLICT",
    );
    immutableJson(planPath, plan, "SCORER_INPUT_CONFLICT");
    return existing ?? plan;
  });
}

export const freezeScorerExperiment = freezeScorerComparisonInput;

interface FrozenSharedProbeItems {
  schema_version: 1;
  shared_probe_manifest_sha256: string;
  items: EvaluationItem[];
}

function validateFrozenItems(
  value: unknown,
  expected: SharedProbeManifest,
  seedManifest: unknown,
): Map<string, EvaluationItem> {
  if (!isRecord(value)) failA1("CORRUPT_SCORER_INPUT", "shared probe inputs must be an object");
  const allowed = ["schema_version", "shared_probe_manifest_sha256", "items"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_INPUT", "unknown shared probe input field '" + key + "'");
  if (value.schema_version !== 1 || !Array.isArray(value.items))
    failA1("CORRUPT_SCORER_INPUT", "shared probe inputs have an invalid envelope");
  const hash = assertSha256(
    value.shared_probe_manifest_sha256,
    "shared_probe_inputs.shared_probe_manifest_sha256",
  );
  if (hash !== expected.manifest_sha256)
    failA1("SCORER_INPUT_HASH_MISMATCH", "shared probe input snapshot names another manifest");
  const items = value.items.map((item) => validateEvaluationItem(item));
  const itemIds = items.map((item) => item.item_id);
  if (
    new Set(itemIds).size !== itemIds.length ||
    itemIds.some((itemId, index) => itemId !== expected.case_ids[index]) ||
    items.length !== expected.case_ids.length
  )
    failA1("CORRUPT_SCORER_INPUT", "shared probe inputs do not cover the frozen case manifest");
  for (const item of items) {
    if (item.source !== expected.case_source_revisions[item.item_id])
      failA1("SCORER_INPUT_CONFLICT", "shared probe item source differs from its frozen manifest");
    const itemHash = canonicalJsonSha256(
      { evaluation_item: item, seed_manifest: seedManifest },
      undefined,
      { schemaVersion: "shared-probe-item-v1" },
    );
    if (itemHash !== expected.item_hashes[item.item_id])
      failA1("SCORER_INPUT_CONFLICT", "shared probe item differs from its frozen hash");
  }
  return new Map(items.map((item) => [item.item_id, item]));
}

function sharedProbeInputValue(
  manifest: SharedProbeManifest,
  items: ReadonlyMap<string, EvaluationItem>,
): FrozenSharedProbeItems {
  return {
    schema_version: 1,
    shared_probe_manifest_sha256: manifest.manifest_sha256,
    items: manifest.case_ids.map((caseId) => {
      const item = items.get(caseId);
      if (item === undefined)
        failA1("CORRUPT_SCORER_INPUT", "missing frozen item '" + caseId + "'");
      return structuredClone(item);
    }),
  };
}

function immutableJson(pathValue: string, expected: unknown, code: string): void {
  if (fs.existsSync(pathValue)) {
    if (canonicalJsonSha256(readStateFile(pathValue)) !== canonicalJsonSha256(expected))
      failA1(code, "immutable scorer input differs at " + pathValue);
    return;
  }
  writeStateJsonAtomic(pathValue, expected);
}

function loadFrozenSharedProbe(
  projectRoot: string,
  scorerRunId: string,
  parent: ScorerRevision,
  candidate: ScorerRevision,
  plan: ScorerExperimentPlan,
): { manifest: SharedProbeManifest; items: Map<string, EvaluationItem> } {
  const parentManifestPath = caseManifestPath(projectRoot, scorerRunId, "parent");
  const candidateManifestPath = caseManifestPath(projectRoot, scorerRunId, "candidate");
  const sharedManifestFile = caseManifestPath(projectRoot, scorerRunId, "shared-probe");
  const itemsFile = sharedProbeItemsPath(projectRoot, scorerRunId);
  for (const fixedPath of [
    parentManifestPath,
    candidateManifestPath,
    sharedManifestFile,
    itemsFile,
  ])
    if (!fs.existsSync(fixedPath))
      failA1("SCORER_INPUTS_NOT_FROZEN", "fixed scorer input is missing at " + fixedPath);

  const expectedParentManifest = materializeCaseManifest(parent, plan.seed_manifest);
  const expectedCandidateManifest = materializeCaseManifest(candidate, plan.seed_manifest);
  const parentManifest = validateCaseManifest(
    readStateFile(parentManifestPath),
    parentManifestPath,
  );
  const candidateManifest = validateCaseManifest(
    readStateFile(candidateManifestPath),
    candidateManifestPath,
  );
  if (
    canonicalJsonSha256(parentManifest) !== canonicalJsonSha256(expectedParentManifest) ||
    canonicalJsonSha256(candidateManifest) !== canonicalJsonSha256(expectedCandidateManifest)
  )
    failA1("SCORER_INPUT_CONFLICT", "fixed case manifests differ from the frozen revisions");

  const sharedManifest = validateSharedProbeManifest(
    readStateFile(sharedManifestFile),
    sharedManifestFile,
  );
  if (sharedManifest.manifest_sha256 !== plan.shared_probe_manifest_sha256)
    failA1("SCORER_INPUT_CONFLICT", "shared probe differs from the frozen experiment plan");
  const items = validateFrozenItems(readStateFile(itemsFile), sharedManifest, plan.seed_manifest);
  const noMaterialization: ProbeMaterializer = () =>
    failA1(
      "SCORER_INPUTS_NOT_FROZEN",
      "a scorer comparison may only use probe items frozen before execution",
    );
  const rebuilt = buildSharedProbe(parent, candidate, plan.seed_manifest, noMaterialization, items);
  if (rebuilt.manifest.manifest_sha256 !== sharedManifest.manifest_sha256)
    failA1("SCORER_INPUT_CONFLICT", "shared probe no longer matches its frozen input snapshot");
  return { manifest: sharedManifest, items };
}

interface ResultCheckpoint {
  schema_version: 1;
  scorer_run_id: string;
  side: "parent" | "candidate";
  scorer_revision: string;
  shared_probe_manifest_sha256: string;
  complete: boolean;
  results: EvaluationResult[];
  results_sha256: string;
}

function resultsSha256(results: readonly EvaluationResult[]): string {
  return canonicalJsonSha256(results, undefined, { schemaVersion: "scorer-results-v1" });
}

function readResultCheckpoint(
  filePath: string,
  scorerRunId: string,
  side: "parent" | "candidate",
  revision: ScorerRevision,
  manifest: SharedProbeManifest,
): ResultCheckpoint | null {
  if (!fs.existsSync(filePath)) return null;
  const value = readStateFile(filePath);
  if (!isRecord(value))
    failA1("CORRUPT_SCORER_RESULTS", "result checkpoint must be an object", filePath);
  const allowed = [
    "schema_version",
    "scorer_run_id",
    "side",
    "scorer_revision",
    "shared_probe_manifest_sha256",
    "complete",
    "results",
    "results_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("CORRUPT_SCORER_RESULTS", "unknown result checkpoint field '" + key + "'", filePath);
  if (
    value.schema_version !== 1 ||
    value.scorer_run_id !== scorerRunId ||
    value.side !== side ||
    value.scorer_revision !== revision.revision ||
    value.shared_probe_manifest_sha256 !== manifest.manifest_sha256 ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.results)
  )
    failA1(
      "SCORER_RESULTS_IDENTITY_MISMATCH",
      "result checkpoint identity differs from frozen input",
      filePath,
    );
  const results = value.results.map((result) => validateEvaluationResult(result));
  if (results.length > manifest.case_ids.length)
    failA1("CORRUPT_SCORER_RESULTS", "result checkpoint has too many results", filePath);
  if (results.some((result, index) => result.item_id !== manifest.case_ids[index]))
    failA1(
      "CORRUPT_SCORER_RESULTS",
      "result checkpoint is not a prefix of the shared probe",
      filePath,
    );
  if (value.complete !== (results.length === manifest.case_ids.length))
    failA1("CORRUPT_SCORER_RESULTS", "result checkpoint completion flag is incorrect", filePath);
  const resultsSha = assertSha256(value.results_sha256, filePath + ".results_sha256");
  if (resultsSha !== resultsSha256(results))
    failA1(
      "SCORER_RESULTS_HASH_MISMATCH",
      "result checkpoint hash does not match contents",
      filePath,
    );
  return {
    schema_version: 1,
    scorer_run_id: scorerRunId,
    side,
    scorer_revision: revision.revision,
    shared_probe_manifest_sha256: manifest.manifest_sha256,
    complete: value.complete,
    results,
    results_sha256: resultsSha,
  };
}

function writeResultCheckpoint(
  filePath: string,
  scorerRunId: string,
  side: "parent" | "candidate",
  revision: ScorerRevision,
  manifest: SharedProbeManifest,
  results: EvaluationResult[],
): ResultCheckpoint {
  const checkpoint: ResultCheckpoint = {
    schema_version: 1,
    scorer_run_id: scorerRunId,
    side,
    scorer_revision: revision.revision,
    shared_probe_manifest_sha256: manifest.manifest_sha256,
    complete: results.length === manifest.case_ids.length,
    results: structuredClone(results),
    results_sha256: resultsSha256(results),
  };
  writeStateJsonAtomic(filePath, checkpoint);
  return checkpoint;
}

function runSideWithRecovery(
  projectRoot: string,
  scorerRunId: string,
  side: "parent" | "candidate",
  revision: ScorerRevision,
  manifest: SharedProbeManifest,
  items: ReadonlyMap<string, EvaluationItem>,
  judgeBindingId: string | null,
  evaluate: ScorerEvaluator,
  sealed: boolean,
): EvaluationResult[] {
  const filePath = resultCheckpointPath(projectRoot, scorerRunId, side);
  const existing = readResultCheckpoint(filePath, scorerRunId, side, revision, manifest);
  if (sealed && (existing === null || !existing.complete))
    failA1(
      "SCORER_RESULTS_INCOMPLETE",
      "sealed " + side + " results cannot be recomputed after their checkpoint is lost",
      filePath,
    );
  const results = existing?.results ?? [];
  if (existing?.complete) return results;
  for (const caseId of manifest.case_ids.slice(results.length)) {
    const evaluated = evaluateRevision(revision, [caseId], items, judgeBindingId, evaluate);
    const result = evaluated[0];
    if (result === undefined) failA1("SCORER_RESULTS_INCOMPLETE", "scorer returned no result");
    results.push(result);
    writeResultCheckpoint(filePath, scorerRunId, side, revision, manifest, results);
  }
  return results;
}

function comparisonFromPlan(
  plan: ScorerExperimentPlan,
  parentManifest: CaseManifest,
  candidateManifest: CaseManifest,
  sharedManifest: SharedProbeManifest,
  parentResults: EvaluationResult[],
  candidateResults: EvaluationResult[],
): ScorerComparison {
  return validateScorerComparison({
    schema_version: 1,
    experiment_plan_sha256: plan.plan_sha256,
    parent_revision: plan.parent_revision,
    candidate_revision: plan.candidate_revision,
    judge_binding_id: plan.judge_binding_id,
    model_assignment_sha256: plan.model_assignment_sha256,
    representative_artifact_id: plan.representative_artifact_id,
    representative_artifact_sha256: plan.representative_artifact_sha256,
    input_snapshot_sha256: plan.input_snapshot_sha256,
    parent_case_manifest: parentManifest,
    candidate_case_manifest: candidateManifest,
    shared_probe_manifest: sharedManifest,
    parent_results: parentResults,
    candidate_results: candidateResults,
    execution_order: ["parent", "candidate"],
  });
}

function assertComparisonMatchesPlan(
  comparison: ScorerComparison,
  plan: ScorerExperimentPlan,
): void {
  if (
    comparison.experiment_plan_sha256 !== plan.plan_sha256 ||
    comparison.parent_revision !== plan.parent_revision ||
    comparison.candidate_revision !== plan.candidate_revision ||
    comparison.judge_binding_id !== plan.judge_binding_id ||
    comparison.model_assignment_sha256 !== plan.model_assignment_sha256 ||
    comparison.representative_artifact_id !== plan.representative_artifact_id ||
    comparison.representative_artifact_sha256 !== plan.representative_artifact_sha256 ||
    comparison.input_snapshot_sha256 !== plan.input_snapshot_sha256 ||
    comparison.parent_case_manifest.seed_manifest_sha256 !== plan.seed_manifest_sha256 ||
    comparison.candidate_case_manifest.seed_manifest_sha256 !== plan.seed_manifest_sha256 ||
    comparison.shared_probe_manifest.seed_manifest_sha256 !== plan.seed_manifest_sha256 ||
    comparison.shared_probe_manifest.manifest_sha256 !== plan.shared_probe_manifest_sha256
  )
    failA1("SCORER_INPUT_CONFLICT", "stored comparison differs from the frozen experiment plan");
}

export interface RunScorerComparisonInput {
  project_root: string;
  workflow_id: string;
  scorer_id: string;
  scorer_run_id: string;
  lock_path?: string;
  parent: ScorerRevision;
  candidate: ScorerRevision;
  freeze: ScorerExperimentFreeze;
  materialize: ProbeMaterializer;
  evaluate_parent: ScorerEvaluator;
  evaluate_candidate: ScorerEvaluator;
}

export function runScorerComparison(input: RunScorerComparisonInput): ScorerComparison {
  if (!isRecord(input)) failA1("IDENTITY_MISMATCH", "scorer comparison needs an input object");
  if (
    input.project_root === undefined ||
    input.workflow_id === undefined ||
    input.scorer_id === undefined ||
    input.scorer_run_id === undefined
  )
    failA1("IDENTITY_MISMATCH", "scorer comparison always needs workflow, scorer and run identity");
  requireString(input.project_root, "project_root");
  const workflowId = assertIdentifier(input.workflow_id, "workflow_id");
  const scorerId = assertIdentifier(input.scorer_id, "scorer_id");
  const scorerRunId = assertIdentifier(input.scorer_run_id, "scorer_run_id");
  const suppliedParent = validateScorerRevision(input.parent);
  const suppliedCandidate = validateScorerRevision(input.candidate);
  if (scorerId !== suppliedParent.scorer_id || scorerId !== suppliedCandidate.scorer_id)
    failA1("IDENTITY_MISMATCH", "comparison scorer id differs from scorer revisions");
  if (suppliedCandidate.parent_revision !== suppliedParent.revision)
    failA1("SCORER_PARENT_MISMATCH", "candidate revision does not name parent revision");
  const initialState = assertScorerWaveMembership({
    project_root: input.project_root,
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    parent_revision: suppliedParent.revision,
    candidate_revision: suppliedCandidate.revision,
  });
  assertScorerRunArtifacts(input.project_root, input.scorer_run_id);
  const plan = readPlan(input.project_root, scorerRunId);
  assertFreezeMatchesPlan(plan, input.freeze);
  if (
    plan.workflow_id !== workflowId ||
    plan.scorer_id !== scorerId ||
    plan.scorer_run_id !== scorerRunId ||
    plan.parent_revision !== initialState.parent_revision ||
    plan.candidate_revision !== initialState.candidate_revision
  )
    failA1("IDENTITY_MISMATCH", "experiment plan does not match the scorer run identity");
  const lockPath = strictLockPath(input.project_root, workflowId);
  const comparisonPath = path.join(
    scorerRunDirectory(input.project_root, scorerRunId),
    "comparison.json",
  );
  return withStateFileLock(lockPath, () => {
    const state = assertScorerWaveMembership({
      project_root: input.project_root,
      workflow_id: workflowId,
      scorer_id: scorerId,
      scorer_run_id: scorerRunId,
      parent_revision: suppliedParent.revision,
      candidate_revision: suppliedCandidate.revision,
    });
    const parent = readStoredRevision(input.project_root, scorerId, state.parent_revision);
    const candidate = readStoredRevision(input.project_root, scorerId, state.candidate_revision);
    if (
      parent.definition_sha256 !== suppliedParent.definition_sha256 ||
      candidate.definition_sha256 !== suppliedCandidate.definition_sha256 ||
      parent.coverage_map_sha256 !== plan.parent_coverage_map_sha256 ||
      candidate.coverage_map_sha256 !== plan.candidate_coverage_map_sha256
    )
      failA1(
        "SCORER_INPUT_CONFLICT",
        "comparison revisions differ from the frozen experiment plan",
      );
    const currentPlan = validatePlan(
      readStateFile(experimentPlanPath(input.project_root, scorerRunId)),
      experimentPlanPath(input.project_root, scorerRunId),
    );
    if (currentPlan.plan_sha256 !== plan.plan_sha256)
      failA1("SCORER_INPUT_CONFLICT", "experiment plan changed while comparison was starting");
    const shared = loadFrozenSharedProbe(input.project_root, scorerRunId, parent, candidate, plan);
    const parentManifestPath = caseManifestPath(input.project_root, scorerRunId, "parent");
    const candidateManifestPath = caseManifestPath(input.project_root, scorerRunId, "candidate");
    const parentManifest = validateCaseManifest(
      readStateFile(parentManifestPath),
      parentManifestPath,
    );
    const candidateManifest = validateCaseManifest(
      readStateFile(candidateManifestPath),
      candidateManifestPath,
    );
    if (
      parentManifest.scorer_revision !== parent.revision ||
      candidateManifest.scorer_revision !== candidate.revision ||
      parentManifest.seed_manifest_sha256 !== plan.seed_manifest_sha256 ||
      candidateManifest.seed_manifest_sha256 !== plan.seed_manifest_sha256 ||
      shared.manifest.seed_manifest_sha256 !== plan.seed_manifest_sha256
    )
      failA1("SCORER_INPUT_CONFLICT", "case manifests differ from the frozen experiment plan");
    const existingComparison = fs.existsSync(comparisonPath)
      ? (() => {
          const existing = validateScorerComparison(readStateFile(comparisonPath));
          assertComparisonMatchesPlan(existing, plan);
          if (
            canonicalJsonSha256(existing.parent_case_manifest) !==
              canonicalJsonSha256(parentManifest) ||
            canonicalJsonSha256(existing.candidate_case_manifest) !==
              canonicalJsonSha256(candidateManifest) ||
            canonicalJsonSha256(existing.shared_probe_manifest) !==
              canonicalJsonSha256(shared.manifest)
          )
            failA1(
              "SCORER_INPUT_CONFLICT",
              "stored comparison does not use the fixed case and probe manifests",
            );
          return existing;
        })()
      : null;
    const taskMarker = path.join(
      path.resolve(input.project_root),
      ".aris",
      "workflows",
      workflowId,
      "scorer-active-task.json",
    );
    if (fs.existsSync(taskMarker)) {
      const existing = readStateFile(taskMarker);
      if (
        isRecord(existing) &&
        existing.status === "running" &&
        existing.scorer_run_id !== scorerRunId
      )
        failA1("SCORER_WAVE_EXCLUSIVE", "another scorer experiment task is active");
    }
    writeStateJsonAtomic(taskMarker, {
      schema_version: 1,
      workflow_id: workflowId,
      scorer_id: scorerId,
      scorer_run_id: scorerRunId,
      status: "running",
    });
    try {
      let runningState = readScorerRunState(input.project_root, scorerRunId);
      if (runningState.status === "materialized")
        runningState = beginScorerParentExperiment(input.project_root, scorerRunId);
      if (
        runningState.status !== "experimenting_parent" &&
        runningState.status !== "experimenting_candidate"
      )
        failA1("SCORER_STATE_ORDER", "scorer comparison must start from a materialized run");
      const parentResults = runSideWithRecovery(
        input.project_root,
        scorerRunId,
        "parent",
        parent,
        shared.manifest,
        shared.items,
        plan.judge_binding_id,
        input.evaluate_parent,
        runningState.parent_sealed,
      );
      runningState = readScorerRunState(input.project_root, scorerRunId);
      if (!runningState.parent_sealed)
        runningState = sealScorerParent(input.project_root, scorerRunId, parentResults);
      if (runningState.status !== "experimenting_candidate")
        failA1("SCORER_STATE_ORDER", "candidate cannot start before parent results are sealed");
      const candidateResults = runSideWithRecovery(
        input.project_root,
        scorerRunId,
        "candidate",
        candidate,
        shared.manifest,
        shared.items,
        plan.judge_binding_id,
        input.evaluate_candidate,
        runningState.candidate_sealed,
      );
      const comparison =
        existingComparison ??
        comparisonFromPlan(
          plan,
          parentManifest,
          candidateManifest,
          shared.manifest,
          parentResults,
          candidateResults,
        );
      if (
        existingComparison !== null &&
        (canonicalJsonSha256(existingComparison.parent_results) !==
          canonicalJsonSha256(parentResults) ||
          canonicalJsonSha256(existingComparison.candidate_results) !==
            canonicalJsonSha256(candidateResults))
      )
        failA1("SCORER_RESULTS_HASH_MISMATCH", "stored comparison differs from result checkpoints");
      immutableJson(comparisonPath, comparison, "IMMUTABLE_CONFLICT");
      runningState = readScorerRunState(input.project_root, scorerRunId);
      if (
        (runningState.parent_sealed &&
          runningState.parent_result_sha256 !==
            canonicalJsonSha256(parentResults, undefined, {
              schemaVersion: "scorer-results-v1",
            })) ||
        (runningState.candidate_sealed &&
          runningState.candidate_result_sha256 !==
            canonicalJsonSha256(candidateResults, undefined, {
              schemaVersion: "scorer-results-v1",
            })) ||
        (runningState.shared_probe_manifest_sha256 !== null &&
          runningState.shared_probe_manifest_sha256 !== shared.manifest.manifest_sha256)
      )
        failA1(
          "SCORER_RESULTS_HASH_MISMATCH",
          "sealed scorer state differs from result checkpoints",
        );
      if (!runningState.candidate_sealed)
        sealScorerCandidate(input.project_root, scorerRunId, candidateResults);
      return comparison;
    } finally {
      writeStateJsonAtomic(taskMarker, {
        schema_version: 1,
        workflow_id: workflowId,
        scorer_id: scorerId,
        scorer_run_id: scorerRunId,
        status: "idle",
      });
    }
  });
}

export interface StandaloneScorerComparisonInput {
  parent: ScorerRevision;
  candidate: ScorerRevision;
  freeze: ScorerExperimentFreeze;
  lock_path: string;
  materialize: ProbeMaterializer;
  evaluate_parent: ScorerEvaluator;
  evaluate_candidate: ScorerEvaluator;
}

export function runStandaloneScorerComparison(
  input: StandaloneScorerComparisonInput,
): ScorerComparison {
  const parent = validateScorerRevision(input.parent);
  const candidate = validateScorerRevision(input.candidate);
  if (candidate.parent_revision !== parent.revision)
    failA1("SCORER_PARENT_MISMATCH", "candidate revision does not name parent revision");
  const freeze = normalizeFreeze(input.freeze);
  return withStateFileLock(input.lock_path, () => {
    const parentManifest = materializeCaseManifest(parent, freeze.seed_manifest);
    const candidateManifest = materializeCaseManifest(candidate, freeze.seed_manifest);
    const shared = buildSharedProbe(parent, candidate, freeze.seed_manifest, input.materialize);
    const planBaseValue = {
      schema_version: 1,
      standalone: true,
      parent_revision: parent.revision,
      candidate_revision: candidate.revision,
      parent_coverage_map_sha256: parent.coverage_map_sha256,
      candidate_coverage_map_sha256: candidate.coverage_map_sha256,
      shared_probe_manifest_sha256: shared.manifest.manifest_sha256,
      ...freeze,
      seed_manifest_sha256: canonicalJsonSha256(freeze.seed_manifest, undefined, {
        schemaVersion: "scorer-seed-manifest-v1",
      }),
    };
    const planSha256 = canonicalJsonSha256(planBaseValue, undefined, {
      schemaVersion: "standalone-scorer-experiment-v1",
    });
    const parentResults = evaluateRevision(
      parent,
      shared.manifest.case_ids,
      shared.items,
      freeze.judge_binding_id,
      input.evaluate_parent,
    );
    const candidateResults = evaluateRevision(
      candidate,
      shared.manifest.case_ids,
      shared.items,
      freeze.judge_binding_id,
      input.evaluate_candidate,
    );
    return comparisonFromPlan(
      {
        schema_version: 1,
        workflow_id: "standalone:isolated",
        scorer_id: parent.scorer_id,
        scorer_run_id: "standalone-comparison",
        parent_revision: parent.revision,
        candidate_revision: candidate.revision,
        parent_coverage_map_sha256: parent.coverage_map_sha256,
        candidate_coverage_map_sha256: candidate.coverage_map_sha256,
        shared_probe_manifest_sha256: shared.manifest.manifest_sha256,
        seed_manifest: freeze.seed_manifest,
        seed_manifest_sha256: planBaseValue.seed_manifest_sha256,
        representative_artifact_id: freeze.representative_artifact_id,
        representative_artifact_sha256: freeze.representative_artifact_sha256,
        input_snapshot_sha256: freeze.input_snapshot_sha256,
        model_assignment_sha256: freeze.model_assignment_sha256,
        judge_binding_id: freeze.judge_binding_id,
        plan_sha256: planSha256,
      },
      parentManifest,
      candidateManifest,
      shared.manifest,
      parentResults,
      candidateResults,
    );
  });
}
