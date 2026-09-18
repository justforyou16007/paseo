import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  materializeCoverageMap,
  validateCoverageMap,
  type CoverageMap,
} from "./scorer-coverage.js";
import {
  assertIdentifier,
  assertSha256,
  failA1,
  isRecord,
  requireBoolean,
  requireString,
} from "./workflow-spec.js";

export type ScorerDeltaKind = "benchmark" | "scoring" | "compound";
export type BenchmarkStatus = "active" | "superseded" | "retired";

export interface BenchmarkEntry {
  benchmark_id: string;
  content_hash: string;
  status: BenchmarkStatus;
  generator_id: string | null;
  supersedes: string | null;
  evidence_refs: string[];
}

export interface BenchmarkGeneratorEntry {
  generator_id: string;
  content_hash: string;
}

export interface ScoringRuleEntry {
  rule_id: string;
  kind: "deterministic_rule" | "rubric_rule";
  content_hash: string;
  active: boolean;
  deleted_in_revision: string | null;
  supersedes_rule_id?: string;
}

export type ScorerDeltaOperation =
  | { op: "add_benchmark_generator"; generator_id: string; content_hash: string }
  | {
      op: "add_benchmark_item";
      benchmark_id: string;
      content_hash: string;
      generator_id?: string;
      evidence_refs: string[];
    }
  | {
      op: "supersede_benchmark";
      old_id: string;
      new_id: string;
      content_hash: string;
      generator_id?: string;
      evidence_refs: string[];
    }
  | { op: "retire_benchmark"; benchmark_id: string; reason_evidence_refs: string[] }
  | {
      op: "add_rule";
      rule_id: string;
      kind: "deterministic_rule" | "rubric_rule";
      content_hash: string;
      supersedes_rule_id?: string;
    }
  | {
      op: "add_rubric_rule";
      rule_id: string;
      kind: "rubric_rule";
      content_hash: string;
      supersedes_rule_id?: string;
    }
  | {
      op: "delete_rule";
      rule_id: string;
      reason_evidence_refs: string[];
      replacement_rule_id?: string;
    };

export interface ScorerDelta {
  schema_version: 1;
  delta_id: string;
  scorer_id: string;
  parent_revision: string;
  delta_kind: ScorerDeltaKind;
  operations: ScorerDeltaOperation[];
  producer_scorer_run_id: string;
  evidence_refs: string[];
  coverage_deepened_relations?: string[];
}

export interface ScorerRevision {
  schema_version: 1;
  scorer_id: string;
  revision: string;
  parent_revision: string | null;
  benchmark_generators?: BenchmarkGeneratorEntry[];
  benchmark_items: BenchmarkEntry[];
  scoring_rules: ScoringRuleEntry[];
  coverage_map: CoverageMap;
  coverage_map_sha256: string;
  definition_sha256: string;
}

function compareIdentity(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortIdentity(values: readonly string[]): string[] {
  return [...values].sort(compareIdentity);
}

function stringArray(
  value: unknown,
  location: string,
  allowEmpty = false,
  errorCode = "INVALID_SCORER_DELTA",
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  )
    failA1(
      errorCode,
      location + " must be a " + (allowEmpty ? "string" : "non-empty string") + " array",
    );
  const result = value.map((item, index) => requireString(item, location + "[" + index + "]"));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", location + " must not contain duplicate values", location);
  return result;
}

function assertExact(
  value: Record<string, unknown>,
  required: readonly string[],
  location: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      failA1("UNKNOWN_FIELD", "unknown scorer operation field '" + key + "'", location + "." + key);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      failA1("INVALID_SCORER_DELTA", "missing scorer operation field '" + key + "'", location);
}

function parseOperation(value: unknown, location: string): ScorerDeltaOperation {
  if (!isRecord(value))
    failA1("INVALID_SCORER_DELTA", "delta operation must be an object", location);
  const operation = value.op;
  if (operation === "add_benchmark_generator") {
    assertExact(value, ["op", "generator_id", "content_hash"], location);
    return {
      op: operation,
      generator_id: assertIdentifier(value.generator_id, location + ".generator_id"),
      content_hash: assertSha256(value.content_hash, location + ".content_hash"),
    };
  }
  if (operation === "add_benchmark_item") {
    assertExact(value, ["op", "benchmark_id", "content_hash", "evidence_refs"], location, [
      "generator_id",
    ]);
    return {
      op: operation,
      benchmark_id: assertIdentifier(value.benchmark_id, location + ".benchmark_id"),
      content_hash: assertSha256(value.content_hash, location + ".content_hash"),
      generator_id:
        value.generator_id === undefined
          ? undefined
          : assertIdentifier(value.generator_id, location + ".generator_id"),
      evidence_refs: stringArray(value.evidence_refs, location + ".evidence_refs"),
    };
  }
  if (operation === "supersede_benchmark") {
    assertExact(value, ["op", "old_id", "new_id", "content_hash", "evidence_refs"], location, [
      "generator_id",
    ]);
    return {
      op: operation,
      old_id: assertIdentifier(value.old_id, location + ".old_id"),
      new_id: assertIdentifier(value.new_id, location + ".new_id"),
      content_hash: assertSha256(value.content_hash, location + ".content_hash"),
      generator_id:
        value.generator_id === undefined
          ? undefined
          : assertIdentifier(value.generator_id, location + ".generator_id"),
      evidence_refs: stringArray(value.evidence_refs, location + ".evidence_refs"),
    };
  }
  if (operation === "retire_benchmark") {
    assertExact(value, ["op", "benchmark_id", "reason_evidence_refs"], location);
    return {
      op: operation,
      benchmark_id: assertIdentifier(value.benchmark_id, location + ".benchmark_id"),
      reason_evidence_refs: stringArray(
        value.reason_evidence_refs,
        location + ".reason_evidence_refs",
      ),
    };
  }
  if (operation === "add_rule") {
    assertExact(value, ["op", "rule_id", "kind", "content_hash"], location, ["supersedes_rule_id"]);
    if (value.kind !== "deterministic_rule" && value.kind !== "rubric_rule")
      failA1("INVALID_SCORER_DELTA", "invalid scoring rule kind", location + ".kind");
    return {
      op: operation,
      rule_id: assertIdentifier(value.rule_id, location + ".rule_id"),
      kind: value.kind,
      content_hash: assertSha256(value.content_hash, location + ".content_hash"),
      ...(value.supersedes_rule_id === undefined
        ? {}
        : {
            supersedes_rule_id: assertIdentifier(
              value.supersedes_rule_id,
              location + ".supersedes_rule_id",
            ),
          }),
    };
  }
  if (operation === "add_rubric_rule") {
    assertExact(value, ["op", "rule_id", "content_hash"], location, ["kind", "supersedes_rule_id"]);
    if (value.kind !== undefined && value.kind !== "rubric_rule")
      failA1(
        "INVALID_SCORER_DELTA",
        "a rubric rule must have rubric_rule kind",
        location + ".kind",
      );
    return {
      op: operation,
      rule_id: assertIdentifier(value.rule_id, location + ".rule_id"),
      kind: "rubric_rule",
      content_hash: assertSha256(value.content_hash, location + ".content_hash"),
      ...(value.supersedes_rule_id === undefined
        ? {}
        : {
            supersedes_rule_id: assertIdentifier(
              value.supersedes_rule_id,
              location + ".supersedes_rule_id",
            ),
          }),
    };
  }
  if (operation === "delete_rule") {
    assertExact(value, ["op", "rule_id", "reason_evidence_refs"], location, [
      "replacement_rule_id",
    ]);
    return {
      op: operation,
      rule_id: assertIdentifier(value.rule_id, location + ".rule_id"),
      reason_evidence_refs: stringArray(
        value.reason_evidence_refs,
        location + ".reason_evidence_refs",
      ),
      ...(value.replacement_rule_id === undefined
        ? {}
        : {
            replacement_rule_id: assertIdentifier(
              value.replacement_rule_id,
              location + ".replacement_rule_id",
            ),
          }),
    };
  }
  failA1(
    "INVALID_SCORER_DELTA",
    "unsupported scorer operation '" + String(operation) + "'",
    location,
  );
}

function operationEvidence(operation: ScorerDeltaOperation): string[] {
  if (operation.op === "add_benchmark_item" || operation.op === "supersede_benchmark")
    return operation.evidence_refs;
  if (operation.op === "retire_benchmark" || operation.op === "delete_rule")
    return operation.reason_evidence_refs;
  return [];
}

export function validateScorerDelta(value: unknown): ScorerDelta {
  if (!isRecord(value)) failA1("INVALID_SCORER_DELTA", "scorer delta must be an object");
  const allowed = [
    "schema_version",
    "delta_id",
    "scorer_id",
    "parent_revision",
    "delta_kind",
    "operations",
    "producer_scorer_run_id",
    "evidence_refs",
    "coverage_deepened_relations",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", "unknown scorer delta field '" + key + "'");
  if (value.schema_version !== 1) failA1("INVALID_SCORER_DELTA", "schema_version must be 1");
  if (!Array.isArray(value.operations) || value.operations.length === 0)
    failA1("INVALID_SCORER_DELTA", "delta must contain one or more operations");
  const operations = value.operations.map((operation, index) =>
    parseOperation(operation, "scorer_delta.operations[" + index + "]"),
  );
  const evidenceRefs = stringArray(value.evidence_refs, "scorer_delta.evidence_refs");
  const evidenceSet = new Set(evidenceRefs);
  for (const operation of operations)
    for (const evidenceRef of operationEvidence(operation))
      if (!evidenceSet.has(evidenceRef))
        failA1(
          "INVALID_SCORER_DELTA",
          "operation evidence must also be listed in delta evidence_refs",
        );

  const hasBenchmark = operations.some(
    (operation) =>
      operation.op === "add_benchmark_generator" ||
      operation.op === "add_benchmark_item" ||
      operation.op === "supersede_benchmark" ||
      operation.op === "retire_benchmark",
  );
  const hasScoring = operations.some(
    (operation) =>
      operation.op === "add_rule" ||
      operation.op === "add_rubric_rule" ||
      operation.op === "delete_rule",
  );
  const kind = value.delta_kind;
  if (kind !== "benchmark" && kind !== "scoring" && kind !== "compound")
    failA1("INVALID_SCORER_DELTA", "invalid delta_kind");
  if (
    (kind === "benchmark" && (!hasBenchmark || hasScoring)) ||
    (kind === "scoring" && (hasBenchmark || !hasScoring)) ||
    (kind === "compound" && (!hasBenchmark || !hasScoring))
  )
    failA1("INVALID_SCORER_DELTA", "delta_kind does not match its operations");

  const coverageRelations =
    value.coverage_deepened_relations === undefined
      ? undefined
      : sortIdentity(
          stringArray(
            value.coverage_deepened_relations,
            "scorer_delta.coverage_deepened_relations",
            true,
          ),
        );
  return {
    schema_version: 1,
    delta_id: assertIdentifier(value.delta_id, "scorer_delta.delta_id"),
    scorer_id: assertIdentifier(value.scorer_id, "scorer_delta.scorer_id"),
    parent_revision: assertIdentifier(value.parent_revision, "scorer_delta.parent_revision"),
    delta_kind: kind,
    operations,
    producer_scorer_run_id: assertIdentifier(
      value.producer_scorer_run_id,
      "scorer_delta.producer_scorer_run_id",
    ),
    evidence_refs: evidenceRefs,
    ...(coverageRelations === undefined ? {} : { coverage_deepened_relations: coverageRelations }),
  };
}

function cloneBenchmark(entry: BenchmarkEntry): BenchmarkEntry {
  return { ...entry, evidence_refs: [...entry.evidence_refs] };
}

function cloneRule(entry: ScoringRuleEntry): ScoringRuleEntry {
  return { ...entry };
}

function assertCoverageReferences(
  coverage: CoverageMap,
  benchmarkItems: readonly BenchmarkEntry[],
): void {
  const benchmarkById = new Map(benchmarkItems.map((item) => [item.benchmark_id, item]));
  const referencedIds = new Set<string>();
  for (const cell of coverage.coverage_cells)
    for (const itemId of cell.benchmark_item_refs) {
      referencedIds.add(itemId);
      if (!benchmarkById.has(itemId))
        failA1(
          "SCORER_ITEM_NOT_FOUND",
          "coverage cell '" +
            cell.coverage_cell_id +
            "' references an unknown benchmark '" +
            itemId +
            "'",
        );
    }
  for (const item of benchmarkItems) {
    if (item.status !== "active" || referencedIds.has(item.benchmark_id)) continue;
    failA1(
      "SCORER_ITEM_UNREFERENCED",
      "active benchmark '" + item.benchmark_id + "' must be referenced by a coverage cell",
    );
  }
}

export function materializeScorerRevision(
  parent: ScorerRevision,
  deltaValue: unknown,
  coverageValue: unknown,
): ScorerRevision {
  const parentRevision = validateScorerRevision(parent);
  const delta = validateScorerDelta(deltaValue);
  if (
    delta.scorer_id !== parentRevision.scorer_id ||
    delta.parent_revision !== parentRevision.revision
  )
    failA1("SCORER_PARENT_MISMATCH", "delta must name the active parent revision");

  const generators = (parentRevision.benchmark_generators ?? []).map((generator) => ({
    ...generator,
  }));
  const benchmarks = parentRevision.benchmark_items.map(cloneBenchmark);
  const rules = parentRevision.scoring_rules.map(cloneRule);

  for (const operation of delta.operations) {
    if (operation.op === "add_benchmark_generator") {
      if (generators.some((generator) => generator.generator_id === operation.generator_id))
        failA1(
          "SCORER_DUPLICATE_ITEM",
          "benchmark generator '" + operation.generator_id + "' already exists",
        );
      generators.push({
        generator_id: operation.generator_id,
        content_hash: operation.content_hash,
      });
      continue;
    }
    if (operation.op === "add_benchmark_item") {
      if (benchmarks.some((entry) => entry.benchmark_id === operation.benchmark_id))
        failA1(
          "SCORER_DUPLICATE_ITEM",
          "benchmark '" + operation.benchmark_id + "' already exists",
        );
      if (
        operation.generator_id !== undefined &&
        !generators.some((generator) => generator.generator_id === operation.generator_id)
      )
        failA1(
          "SCORER_ITEM_NOT_FOUND",
          "benchmark generator '" + operation.generator_id + "' does not exist",
        );
      benchmarks.push({
        benchmark_id: operation.benchmark_id,
        content_hash: operation.content_hash,
        status: "active",
        generator_id: operation.generator_id ?? null,
        supersedes: null,
        evidence_refs: [...operation.evidence_refs],
      });
      continue;
    }
    if (operation.op === "supersede_benchmark") {
      const old = benchmarks.find((entry) => entry.benchmark_id === operation.old_id);
      if (!old)
        failA1("SCORER_ITEM_NOT_FOUND", "benchmark '" + operation.old_id + "' does not exist");
      if (old.status !== "active")
        failA1("SCORER_ITEM_NOT_FOUND", "benchmark '" + operation.old_id + "' is already inactive");
      if (operation.old_id === operation.new_id)
        failA1("SCORER_DUPLICATE_ITEM", "a benchmark cannot supersede itself");
      if (benchmarks.some((entry) => entry.benchmark_id === operation.new_id))
        failA1("SCORER_DUPLICATE_ITEM", "benchmark '" + operation.new_id + "' already exists");
      if (
        operation.generator_id !== undefined &&
        !generators.some((generator) => generator.generator_id === operation.generator_id)
      )
        failA1(
          "SCORER_ITEM_NOT_FOUND",
          "benchmark generator '" + operation.generator_id + "' does not exist",
        );
      old.status = "superseded";
      old.evidence_refs = sortIdentity([
        ...new Set([...old.evidence_refs, ...operation.evidence_refs]),
      ]);
      benchmarks.push({
        benchmark_id: operation.new_id,
        content_hash: operation.content_hash,
        status: "active",
        generator_id: operation.generator_id ?? old.generator_id,
        supersedes: operation.old_id,
        evidence_refs: [...operation.evidence_refs],
      });
      continue;
    }
    if (operation.op === "retire_benchmark") {
      const entry = benchmarks.find(
        (candidate) => candidate.benchmark_id === operation.benchmark_id,
      );
      if (!entry)
        failA1(
          "SCORER_ITEM_NOT_FOUND",
          "benchmark '" + operation.benchmark_id + "' does not exist",
        );
      if (entry.status !== "active")
        failA1(
          "SCORER_ITEM_NOT_FOUND",
          "benchmark '" + operation.benchmark_id + "' is already inactive",
        );
      entry.status = "retired";
      entry.evidence_refs = sortIdentity([
        ...new Set([...entry.evidence_refs, ...operation.reason_evidence_refs]),
      ]);
      continue;
    }
    if (operation.op === "add_rule" || operation.op === "add_rubric_rule") {
      if (rules.some((entry) => entry.rule_id === operation.rule_id))
        failA1("SCORER_DUPLICATE_RULE", "rule '" + operation.rule_id + "' already exists");
      rules.push({
        rule_id: operation.rule_id,
        kind: operation.kind,
        content_hash: operation.content_hash,
        active: true,
        deleted_in_revision: null,
        ...(operation.supersedes_rule_id === undefined
          ? {}
          : { supersedes_rule_id: operation.supersedes_rule_id }),
      });
      continue;
    }
    if (operation.op === "delete_rule") {
      const rule = rules.find(
        (candidate) => candidate.rule_id === operation.rule_id && candidate.active,
      );
      if (!rule)
        failA1("SCORER_RULE_NOT_FOUND", "active rule '" + operation.rule_id + "' does not exist");
      if (
        operation.replacement_rule_id !== undefined &&
        operation.replacement_rule_id === operation.rule_id
      )
        failA1("SCORER_RULE_REPLACEMENT_INVALID", "a rule cannot replace itself");
      rule.active = false;
      rule.deleted_in_revision = delta.delta_id;
    }
  }

  for (const operation of delta.operations) {
    if (operation.op !== "delete_rule" || operation.replacement_rule_id === undefined) continue;
    const replacement = rules.find((rule) => rule.rule_id === operation.replacement_rule_id);
    if (replacement === undefined || !replacement.active)
      failA1(
        "SCORER_RULE_REPLACEMENT_INVALID",
        "deleted rule '" + operation.rule_id + "' must name an active replacement rule",
      );
    if (replacement.supersedes_rule_id !== operation.rule_id)
      failA1(
        "SCORER_RULE_REPLACEMENT_INVALID",
        "replacement rule '" +
          operation.replacement_rule_id +
          "' must record the deleted rule as its predecessor",
      );
  }
  for (const operation of delta.operations) {
    if (
      (operation.op !== "add_rule" && operation.op !== "add_rubric_rule") ||
      operation.supersedes_rule_id === undefined
    )
      continue;
    const predecessor = rules.find((rule) => rule.rule_id === operation.supersedes_rule_id);
    if (predecessor === undefined || predecessor.active)
      failA1(
        "SCORER_RULE_REPLACEMENT_INVALID",
        "replacement rule '" +
          operation.rule_id +
          "' must point to a deleted rule that remains in history",
      );
  }

  const coverage = materializeCoverageMap(coverageValue, parentRevision.coverage_map, delta);
  assertCoverageReferences(coverage, benchmarks);

  const definitionWithoutHash = {
    schema_version: 1,
    scorer_id: parentRevision.scorer_id,
    parent_revision: parentRevision.revision,
    benchmark_generators: generators,
    benchmark_items: benchmarks,
    scoring_rules: rules,
    coverage_map: coverage,
  };
  const definitionSha256 = canonicalJsonSha256(definitionWithoutHash, undefined, {
    schemaVersion: "scorer-revision-v1",
  });
  const coverageMapSha256 = canonicalJsonSha256(coverage, undefined, {
    schemaVersion: "coverage-map-v1",
  });
  return {
    schema_version: 1,
    scorer_id: parentRevision.scorer_id,
    revision: "scorer-revision:sha256:" + definitionSha256,
    parent_revision: parentRevision.revision,
    benchmark_generators: generators,
    benchmark_items: benchmarks,
    scoring_rules: rules,
    coverage_map: coverage,
    coverage_map_sha256: coverageMapSha256,
    definition_sha256: definitionSha256,
  };
}

export function validateScorerRevision(value: unknown): ScorerRevision {
  if (!isRecord(value)) failA1("INVALID_SCORER_REVISION", "scorer revision must be an object");
  const allowed = [
    "schema_version",
    "scorer_id",
    "revision",
    "parent_revision",
    "benchmark_generators",
    "benchmark_items",
    "scoring_rules",
    "coverage_map",
    "coverage_map_sha256",
    "definition_sha256",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", "unknown scorer revision field '" + key + "'");
  if (
    value.schema_version !== 1 ||
    !Array.isArray(value.benchmark_items) ||
    !Array.isArray(value.scoring_rules)
  )
    failA1("INVALID_SCORER_REVISION", "invalid scorer revision envelope");

  const benchmarkGenerators: BenchmarkGeneratorEntry[] =
    value.benchmark_generators === undefined
      ? []
      : (() => {
          if (!Array.isArray(value.benchmark_generators))
            failA1("INVALID_SCORER_REVISION", "benchmark_generators must be an array");
          return value.benchmark_generators.map((generator, index) => {
            if (!isRecord(generator))
              failA1(
                "INVALID_SCORER_REVISION",
                "benchmark generator must be an object",
                "benchmark_generators[" + index + "]",
              );
            const allowedGenerator = ["generator_id", "content_hash"];
            for (const key of Object.keys(generator))
              if (!allowedGenerator.includes(key))
                failA1(
                  "UNKNOWN_FIELD",
                  "unknown benchmark generator field '" + key + "'",
                  "benchmark_generators[" + index + "]",
                );
            return {
              generator_id: assertIdentifier(
                generator.generator_id,
                "benchmark_generators[" + index + "].generator_id",
              ),
              content_hash: assertSha256(
                generator.content_hash,
                "benchmark_generators[" + index + "].content_hash",
              ),
            };
          });
        })();
  if (
    new Set(benchmarkGenerators.map((generator) => generator.generator_id)).size !==
    benchmarkGenerators.length
  )
    failA1("DUPLICATE_ID", "benchmark generator ids must be unique");

  const benchmarkItems: BenchmarkEntry[] = value.benchmark_items.map((item, index) => {
    if (!isRecord(item))
      failA1(
        "INVALID_SCORER_REVISION",
        "benchmark item must be an object",
        "benchmark_items[" + index + "]",
      );
    const allowedItem = [
      "benchmark_id",
      "content_hash",
      "status",
      "generator_id",
      "supersedes",
      "evidence_refs",
    ];
    for (const key of Object.keys(item))
      if (!allowedItem.includes(key))
        failA1("UNKNOWN_FIELD", "unknown benchmark item field '" + key + "'");
    const status = item.status;
    if (status !== "active" && status !== "superseded" && status !== "retired")
      failA1("INVALID_SCORER_REVISION", "invalid benchmark status");
    const generatorId =
      item.generator_id === null
        ? null
        : assertIdentifier(item.generator_id, "benchmark_items[" + index + "].generator_id");
    if (
      generatorId !== null &&
      !benchmarkGenerators.some((generator) => generator.generator_id === generatorId)
    )
      failA1("SCORER_ITEM_NOT_FOUND", "benchmark generator '" + generatorId + "' does not exist");
    return {
      benchmark_id: assertIdentifier(
        item.benchmark_id,
        "benchmark_items[" + index + "].benchmark_id",
      ),
      content_hash: assertSha256(item.content_hash, "benchmark_items[" + index + "].content_hash"),
      status,
      generator_id: generatorId,
      supersedes:
        item.supersedes === null
          ? null
          : assertIdentifier(item.supersedes, "benchmark_items[" + index + "].supersedes"),
      evidence_refs: stringArray(
        item.evidence_refs,
        "benchmark_items[" + index + "].evidence_refs",
        false,
        "INVALID_SCORER_REVISION",
      ),
    };
  });
  const benchmarkById = new Map(benchmarkItems.map((item) => [item.benchmark_id, item]));
  for (const item of benchmarkItems) {
    if (item.supersedes === null) continue;
    const predecessor = benchmarkById.get(item.supersedes);
    if (
      item.supersedes === item.benchmark_id ||
      predecessor === undefined ||
      predecessor.status !== "superseded"
    )
      failA1(
        "SCORER_ITEM_NOT_FOUND",
        "benchmark '" + item.benchmark_id + "' does not point to a superseded benchmark",
      );
  }

  const scoringRules: ScoringRuleEntry[] = value.scoring_rules.map((item, index) => {
    if (!isRecord(item))
      failA1(
        "INVALID_SCORER_REVISION",
        "scoring rule must be an object",
        "scoring_rules[" + index + "]",
      );
    const allowedRule = [
      "rule_id",
      "kind",
      "content_hash",
      "active",
      "deleted_in_revision",
      "supersedes_rule_id",
    ];
    for (const key of Object.keys(item))
      if (!allowedRule.includes(key))
        failA1("UNKNOWN_FIELD", "unknown scoring rule field '" + key + "'");
    if (item.kind !== "deterministic_rule" && item.kind !== "rubric_rule")
      failA1("INVALID_SCORER_REVISION", "invalid scoring rule kind");
    const active = requireBoolean(item.active, "scoring_rules[" + index + "].active");
    const deletedInRevision =
      item.deleted_in_revision === null
        ? null
        : assertIdentifier(
            item.deleted_in_revision,
            "scoring_rules[" + index + "].deleted_in_revision",
          );
    if (active && deletedInRevision !== null)
      failA1("INVALID_SCORER_REVISION", "an active rule cannot have a deletion revision");
    if (!active && deletedInRevision === null)
      failA1("INVALID_SCORER_REVISION", "an inactive rule must record its deletion revision");
    const supersedesRuleId =
      item.supersedes_rule_id === undefined
        ? undefined
        : assertIdentifier(
            item.supersedes_rule_id,
            "scoring_rules[" + index + "].supersedes_rule_id",
          );
    if (supersedesRuleId === item.rule_id)
      failA1("INVALID_SCORER_REVISION", "a scoring rule cannot supersede itself");
    return {
      rule_id: assertIdentifier(item.rule_id, "scoring_rules[" + index + "].rule_id"),
      kind: item.kind,
      content_hash: assertSha256(item.content_hash, "scoring_rules[" + index + "].content_hash"),
      active,
      deleted_in_revision: deletedInRevision,
      ...(supersedesRuleId === undefined ? {} : { supersedes_rule_id: supersedesRuleId }),
    };
  });
  if (new Set(benchmarkItems.map((item) => item.benchmark_id)).size !== benchmarkItems.length)
    failA1("DUPLICATE_ID", "benchmark ids must be unique");
  if (new Set(scoringRules.map((rule) => rule.rule_id)).size !== scoringRules.length)
    failA1("DUPLICATE_ID", "scoring rule ids must be unique");
  const ruleById = new Map(scoringRules.map((rule) => [rule.rule_id, rule]));
  for (const rule of scoringRules) {
    if (rule.supersedes_rule_id === undefined) continue;
    const predecessor = ruleById.get(rule.supersedes_rule_id);
    if (predecessor === undefined || predecessor.active)
      failA1(
        "SCORER_RULE_REPLACEMENT_INVALID",
        "rule '" + rule.rule_id + "' must point to a deleted rule that remains in history",
      );
  }

  const scorerId = assertIdentifier(value.scorer_id, "scorer_revision.scorer_id");
  const revision = assertIdentifier(value.revision, "scorer_revision.revision");
  const parentRevision =
    value.parent_revision === null
      ? null
      : assertIdentifier(value.parent_revision, "scorer_revision.parent_revision");
  const coverage = validateCoverageMap(value.coverage_map);
  assertCoverageReferences(coverage, benchmarkItems);
  const coverageMapSha256 = assertSha256(
    value.coverage_map_sha256,
    "scorer_revision.coverage_map_sha256",
  );
  const definitionSha256 = assertSha256(
    value.definition_sha256,
    "scorer_revision.definition_sha256",
  );
  const expectedCoverageHash = canonicalJsonSha256(coverage, undefined, {
    schemaVersion: "coverage-map-v1",
  });
  const definitionFields = {
    schema_version: 1,
    scorer_id: scorerId,
    parent_revision: parentRevision,
    benchmark_items: benchmarkItems,
    scoring_rules: scoringRules,
    coverage_map: coverage,
  };
  const expectedDefinitionHash =
    value.benchmark_generators === undefined
      ? canonicalJsonSha256(definitionFields, undefined, { schemaVersion: "scorer-revision-v1" })
      : canonicalJsonSha256(
          { ...definitionFields, benchmark_generators: benchmarkGenerators },
          undefined,
          { schemaVersion: "scorer-revision-v1" },
        );
  if (coverageMapSha256 !== expectedCoverageHash || definitionSha256 !== expectedDefinitionHash)
    failA1("SCORER_HASH_MISMATCH", "scorer revision hashes do not match its immutable definition");
  if (parentRevision !== null && revision !== "scorer-revision:sha256:" + definitionSha256)
    failA1("SCORER_HASH_MISMATCH", "scorer revision id does not match its immutable definition");
  return {
    schema_version: 1,
    scorer_id: scorerId,
    revision,
    parent_revision: parentRevision,
    ...(value.benchmark_generators === undefined
      ? {}
      : { benchmark_generators: benchmarkGenerators }),
    benchmark_items: benchmarkItems,
    scoring_rules: scoringRules,
    coverage_map: coverage,
    coverage_map_sha256: coverageMapSha256,
    definition_sha256: definitionSha256,
  };
}

export function scorerPath(projectRoot: string, scorerId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".aris",
    "scorers",
    assertIdentifier(scorerId, "scorer_id"),
  );
}

function sameImmutableJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonSha256(left) === canonicalJsonSha256(right);
  } catch {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}

export function saveImmutableScorerDelta(projectRoot: string, deltaValue: unknown): ScorerDelta {
  const delta = validateScorerDelta(deltaValue);
  const filePath = path.join(
    scorerPath(projectRoot, delta.scorer_id),
    "deltas",
    delta.delta_id + ".json",
  );
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateScorerDelta(readStateFile(filePath));
      if (sameImmutableJson(existing, delta)) return existing;
      failA1("IMMUTABLE_CONFLICT", "scorer delta '" + delta.delta_id + "' cannot be overwritten");
    }
    writeStateJsonAtomic(filePath, delta);
    return delta;
  });
}

export function saveImmutableScorerRevision(
  projectRoot: string,
  revisionValue: unknown,
): ScorerRevision {
  const revision = validateScorerRevision(revisionValue);
  const filePath = path.join(
    scorerPath(projectRoot, revision.scorer_id),
    "revisions",
    revision.revision,
    "definition.json",
  );
  const coveragePath = path.join(path.dirname(filePath), "coverage-map.json");
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = validateScorerRevision(readStateFile(filePath));
      if (sameImmutableJson(existing, revision)) {
        if (fs.existsSync(coveragePath)) {
          const storedCoverage = validateCoverageMap(readStateFile(coveragePath));
          if (canonicalJsonSha256(storedCoverage) !== canonicalJsonSha256(existing.coverage_map))
            failA1(
              "IMMUTABLE_CONFLICT",
              "coverage map for scorer revision '" + revision.revision + "' cannot be overwritten",
            );
        } else {
          writeStateJsonAtomic(coveragePath, existing.coverage_map);
        }
        return existing;
      }
      failA1(
        "IMMUTABLE_CONFLICT",
        "scorer revision '" + revision.revision + "' cannot be overwritten",
      );
    }
    if (fs.existsSync(coveragePath)) {
      const storedCoverage = validateCoverageMap(readStateFile(coveragePath));
      if (canonicalJsonSha256(storedCoverage) !== canonicalJsonSha256(revision.coverage_map))
        failA1(
          "IMMUTABLE_CONFLICT",
          "coverage map for scorer revision '" + revision.revision + "' cannot be overwritten",
        );
    } else {
      writeStateJsonAtomic(coveragePath, revision.coverage_map);
    }
    writeStateJsonAtomic(filePath, revision);
    return revision;
  });
}
