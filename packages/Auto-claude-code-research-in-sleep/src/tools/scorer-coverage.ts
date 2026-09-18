import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertIdentifier,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";

export interface CoverageDimension {
  dimension_id: string;
  source: "task_defined" | "scorer_discovered";
  values: string[];
  ordered_values: string[];
}

export interface CoverageCell {
  coverage_cell_id: string;
  coordinates: Record<string, string>;
  benchmark_item_refs: string[];
  evidence_refs: string[];
}

export interface CoverageDeltaSummary {
  added_cells: string[];
  deepened_relations: string[];
  superseded_items: string[];
  retired_invalid_items: string[];
}

export interface CoverageMap {
  schema_version: 1;
  coverage_map_id: string;
  parent_coverage_map_id: string | null;
  dimensions: CoverageDimension[];
  coverage_cells: CoverageCell[];
  delta_summary: CoverageDeltaSummary;
}

/*
 * The scorer-definition module passes the validated delta as an unknown value
 * to keep the two modules independent. Only these operation facts are used
 * here; a map cannot authorize its own summary.
 */
interface CoverageDeltaAuthorization {
  added_benchmark_ids: string[];
  superseded_benchmark_ids: string[];
  superseded_replacements: Record<string, string>;
  retired_benchmark_ids: string[];
  deepened_relations: string[] | null;
}

function compareIdentity(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortIdentity(values: readonly string[]): string[] {
  return [...values].sort(compareIdentity);
}

function stringArray(value: unknown, location: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  )
    failA1(
      "INVALID_COVERAGE_MAP",
      location + " must be a " + (allowEmpty ? "string" : "non-empty string") + " array",
    );
  const result = value.map((item, index) => requireString(item, location + "[" + index + "]"));
  if (new Set(result).size !== result.length)
    failA1("DUPLICATE_ID", location + " must not contain duplicate values", location);
  return result;
}

function parseDimension(value: unknown, location: string): CoverageDimension {
  if (!isRecord(value)) failA1("INVALID_COVERAGE_MAP", "dimension must be an object", location);
  const allowed = ["dimension_id", "source", "values", "ordered_values"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1(
        "UNKNOWN_FIELD",
        "unknown coverage dimension field '" + key + "'",
        location + "." + key,
      );

  const source = value.source;
  if (source !== "task_defined" && source !== "scorer_discovered")
    failA1("INVALID_COVERAGE_MAP", "invalid dimension source", location + ".source");

  const hasValues = Object.hasOwn(value, "values");
  const hasOrderedValues = Object.hasOwn(value, "ordered_values");
  if (!hasValues && !hasOrderedValues)
    failA1(
      "INVALID_COVERAGE_MAP",
      "an unordered dimension needs values, and an ordered dimension needs ordered_values",
      location,
    );

  const orderedValues = hasOrderedValues
    ? stringArray(value.ordered_values, location + ".ordered_values", true)
    : [];
  const values = hasValues
    ? stringArray(value.values, location + ".values")
    : sortIdentity(orderedValues);
  if (values.length === 0)
    failA1(
      "INVALID_COVERAGE_MAP",
      "a coverage dimension must declare at least one value",
      location,
    );
  if (orderedValues.length > 0 && orderedValues.some((item) => !values.includes(item)))
    failA1("INVALID_COVERAGE_MAP", "ordered_values must be a subset of values", location);

  return {
    dimension_id: assertIdentifier(value.dimension_id, location + ".dimension_id"),
    source,
    values: sortIdentity(values),
    ordered_values: orderedValues,
  };
}

function parseCell(
  value: unknown,
  location: string,
  dimensions: readonly CoverageDimension[],
): CoverageCell {
  if (!isRecord(value)) failA1("INVALID_COVERAGE_MAP", "coverage cell must be an object", location);
  const allowed = ["coverage_cell_id", "coordinates", "benchmark_item_refs", "evidence_refs"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", "unknown coverage cell field '" + key + "'", location + "." + key);
  if (!isRecord(value.coordinates))
    failA1("INVALID_COVERAGE_MAP", "coordinates must be an object", location + ".coordinates");

  const dimensionsById = new Map(
    dimensions.map((dimension) => [dimension.dimension_id, dimension]),
  );
  const coordinates: Record<string, string> = {};
  for (const dimension of dimensions) {
    if (!Object.hasOwn(value.coordinates, dimension.dimension_id))
      failA1(
        "INVALID_COVERAGE_MAP",
        "every dimension needs a coordinate",
        location + ".coordinates." + dimension.dimension_id,
      );
    const coordinate = requireString(
      value.coordinates[dimension.dimension_id],
      location + ".coordinates." + dimension.dimension_id,
    );
    if (!dimension.values.includes(coordinate))
      failA1(
        "INVALID_COVERAGE_MAP",
        "coordinate '" +
          coordinate +
          "' is not declared by dimension '" +
          dimension.dimension_id +
          "'",
        location + ".coordinates." + dimension.dimension_id,
      );
    coordinates[dimension.dimension_id] = coordinate;
  }
  for (const dimensionId of Object.keys(value.coordinates)) {
    if (!dimensionsById.has(dimensionId))
      failA1(
        "INVALID_COVERAGE_MAP",
        "unknown coordinate dimension '" + dimensionId + "'",
        location + ".coordinates",
      );
  }

  return {
    coverage_cell_id: assertIdentifier(value.coverage_cell_id, location + ".coverage_cell_id"),
    coordinates,
    benchmark_item_refs: sortIdentity(
      stringArray(value.benchmark_item_refs, location + ".benchmark_item_refs"),
    ),
    evidence_refs: sortIdentity(stringArray(value.evidence_refs, location + ".evidence_refs")),
  };
}

function parseDeltaSummary(value: unknown, location: string): CoverageDeltaSummary {
  if (!isRecord(value)) failA1("INVALID_COVERAGE_MAP", "delta_summary must be an object", location);
  const allowed = [
    "added_cells",
    "deepened_relations",
    "superseded_items",
    "retired_invalid_items",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", "unknown coverage delta field '" + key + "'", location + "." + key);
  return {
    added_cells: sortIdentity(stringArray(value.added_cells, location + ".added_cells", true)),
    deepened_relations: sortIdentity(
      stringArray(value.deepened_relations, location + ".deepened_relations", true),
    ),
    superseded_items: sortIdentity(
      stringArray(value.superseded_items, location + ".superseded_items", true),
    ),
    retired_invalid_items: sortIdentity(
      stringArray(value.retired_invalid_items, location + ".retired_invalid_items", true),
    ),
  };
}

export function validateCoverageMap(value: unknown): CoverageMap {
  if (!isRecord(value)) failA1("INVALID_COVERAGE_MAP", "coverage map must be an object");
  const allowed = [
    "schema_version",
    "coverage_map_id",
    "parent_coverage_map_id",
    "dimensions",
    "coverage_cells",
    "delta_summary",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) failA1("UNKNOWN_FIELD", "unknown coverage map field '" + key + "'");
  if (value.schema_version !== 1) failA1("INVALID_COVERAGE_MAP", "schema_version must be 1");
  if (!Array.isArray(value.dimensions) || !Array.isArray(value.coverage_cells))
    failA1("INVALID_COVERAGE_MAP", "dimensions and coverage_cells are required");
  if (value.dimensions.length === 0)
    failA1("INVALID_COVERAGE_MAP", "coverage map needs at least one dimension");

  const dimensions = value.dimensions
    .map((dimension, index) => parseDimension(dimension, "coverage_map.dimensions[" + index + "]"))
    .sort((left, right) => compareIdentity(left.dimension_id, right.dimension_id));
  if (new Set(dimensions.map((dimension) => dimension.dimension_id)).size !== dimensions.length)
    failA1("DUPLICATE_ID", "coverage dimension ids must be unique");

  const cells = value.coverage_cells
    .map((cell, index) => parseCell(cell, "coverage_map.coverage_cells[" + index + "]", dimensions))
    .sort((left, right) => compareIdentity(left.coverage_cell_id, right.coverage_cell_id));
  if (new Set(cells.map((cell) => cell.coverage_cell_id)).size !== cells.length)
    failA1("DUPLICATE_ID", "coverage cell ids must be unique");

  return {
    schema_version: 1,
    coverage_map_id: assertIdentifier(value.coverage_map_id, "coverage_map.coverage_map_id"),
    parent_coverage_map_id:
      value.parent_coverage_map_id === null
        ? null
        : assertIdentifier(value.parent_coverage_map_id, "coverage_map.parent_coverage_map_id"),
    dimensions,
    coverage_cells: cells,
    delta_summary: parseDeltaSummary(value.delta_summary, "coverage_map.delta_summary"),
  };
}

function coordinateKey(cell: CoverageCell, dimensions: readonly CoverageDimension[]): string {
  return dimensions
    .map((dimension) => dimension.dimension_id)
    .sort(compareIdentity)
    .map((key) => key + "=" + cell.coordinates[key])
    .join("|");
}

function dimensionById(map: CoverageMap): Map<string, CoverageDimension> {
  return new Map(map.dimensions.map((dimension) => [dimension.dimension_id, dimension]));
}

function assertDimensionsPreserved(parent: CoverageMap, candidate: CoverageMap): void {
  const candidateDimensions = dimensionById(candidate);
  for (const parentDimension of parent.dimensions) {
    const candidateDimension = candidateDimensions.get(parentDimension.dimension_id);
    if (candidateDimension === undefined)
      failA1(
        "COVERAGE_DIMENSION_REMOVED",
        "coverage dimension '" + parentDimension.dimension_id + "' cannot be removed",
      );
    if (candidateDimension.source !== parentDimension.source)
      failA1(
        "COVERAGE_DIMENSION_MUTATION",
        "coverage dimension '" + parentDimension.dimension_id + "' changed source",
      );
    const missingValues = parentDimension.values.filter(
      (value) => !candidateDimension.values.includes(value),
    );
    if (missingValues.length > 0)
      failA1(
        "COVERAGE_VALUE_REMOVED",
        "coverage dimension '" +
          parentDimension.dimension_id +
          "' removed existing values: " +
          missingValues.join(", "),
      );
    if (parentDimension.ordered_values.length === 0) {
      if (candidateDimension.ordered_values.length > 0)
        failA1(
          "COVERAGE_DIMENSION_MUTATION",
          "unordered coverage dimension '" +
            parentDimension.dimension_id +
            "' cannot gain ordering",
        );
      continue;
    }
    let candidateIndex = 0;
    for (const value of parentDimension.ordered_values) {
      const nextIndex = candidateDimension.ordered_values.indexOf(value, candidateIndex);
      if (nextIndex < 0)
        failA1(
          "COVERAGE_VALUE_REMOVED",
          "ordered coverage dimension '" +
            parentDimension.dimension_id +
            "' lost an existing value",
        );
      candidateIndex = nextIndex + 1;
    }
  }
}

function parseAuthorization(value: unknown): CoverageDeltaAuthorization {
  const added = new Set<string>();
  const superseded = new Set<string>();
  const replacements: Record<string, string> = {};
  const retired = new Set<string>();
  let explicitDeepened: string[] | null = null;

  const addExplicit = (candidate: unknown): void => {
    if (candidate === undefined) return;
    const values = stringArray(candidate, "scorer_delta.deepened_relations", true);
    explicitDeepened = sortIdentity(values);
  };

  const addOperation = (operation: unknown): void => {
    if (!isRecord(operation) || typeof operation.op !== "string") return;
    if (operation.op === "add_benchmark_item" && typeof operation.benchmark_id === "string") {
      added.add(operation.benchmark_id);
    } else if (operation.op === "supersede_benchmark") {
      if (typeof operation.old_id === "string" && typeof operation.new_id === "string") {
        superseded.add(operation.old_id);
        replacements[operation.old_id] = operation.new_id;
        added.add(operation.new_id);
      }
    } else if (operation.op === "retire_benchmark" && typeof operation.benchmark_id === "string") {
      retired.add(operation.benchmark_id);
    }
  };

  if (value === undefined) {
    return {
      added_benchmark_ids: [],
      superseded_benchmark_ids: [],
      superseded_replacements: {},
      retired_benchmark_ids: [],
      deepened_relations: null,
    };
  }
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    typeof value.delta_id !== "string" ||
    typeof value.scorer_id !== "string" ||
    typeof value.parent_revision !== "string" ||
    typeof value.producer_scorer_run_id !== "string" ||
    !Array.isArray(value.evidence_refs)
  )
    failA1(
      "INVALID_COVERAGE_MAP",
      "coverage authorization must be a complete validated scorer delta",
    );
  value.operations.forEach(addOperation);
  addExplicit(value.coverage_deepened_relations);
  if (explicitDeepened !== null) explicitDeepened = sortIdentity(explicitDeepened);
  return {
    added_benchmark_ids: sortIdentity([...added]),
    superseded_benchmark_ids: sortIdentity([...superseded]),
    superseded_replacements: replacements,
    retired_benchmark_ids: sortIdentity([...retired]),
    deepened_relations: explicitDeepened,
  };
}

function isAuthorizedBenchmark(
  cell: CoverageCell,
  authorization: CoverageDeltaAuthorization,
): boolean {
  const added = new Set(authorization.added_benchmark_ids);
  return cell.benchmark_item_refs.some((item) => added.has(item));
}

function assertExistingCellsPreserved(
  parent: CoverageMap,
  candidate: CoverageMap,
  authorization: CoverageDeltaAuthorization,
): void {
  const candidateCells = new Map(
    candidate.coverage_cells.map((cell) => [cell.coverage_cell_id, cell]),
  );
  const removableItems = new Set([
    ...authorization.superseded_benchmark_ids,
    ...authorization.retired_benchmark_ids,
  ]);
  for (const parentCell of parent.coverage_cells) {
    const candidateCell = candidateCells.get(parentCell.coverage_cell_id);
    if (candidateCell === undefined) {
      const canRemove = parentCell.benchmark_item_refs.every((itemId) =>
        removableItems.has(itemId),
      );
      if (!canRemove)
        failA1(
          "COVERAGE_CELL_REMOVED",
          "coverage cell '" +
            parentCell.coverage_cell_id +
            "' can only be removed when every referenced benchmark is retired or superseded",
        );
      continue;
    }
    // Adding a dimension necessarily adds one coordinate to every existing
    // cell.  The old coordinates, benchmark references, and evidence are the
    // immutable part; coordinates for a newly declared dimension are the
    // additive part of the map.
    if (
      coordinateKey(parentCell, parent.dimensions) !==
      coordinateKey(candidateCell, parent.dimensions)
    )
      failA1(
        "COVERAGE_CELL_MUTATION",
        "coverage cell '" + parentCell.coverage_cell_id + "' changed coordinates",
      );
    if (
      canonicalJsonSha256({
        benchmark_item_refs: parentCell.benchmark_item_refs,
        evidence_refs: parentCell.evidence_refs,
      }) !==
      canonicalJsonSha256({
        benchmark_item_refs: candidateCell.benchmark_item_refs,
        evidence_refs: candidateCell.evidence_refs,
      })
    )
      failA1(
        "COVERAGE_CELL_MUTATION",
        "coverage cell '" + parentCell.coverage_cell_id + "' changed its immutable references",
      );
  }
}

function relationFor(
  parentCell: CoverageCell,
  candidateCell: CoverageCell,
  dimensions: readonly CoverageDimension[],
): string | null {
  let changedDimension: CoverageDimension | null = null;
  for (const dimension of dimensions) {
    const parentValue = parentCell.coordinates[dimension.dimension_id];
    const candidateValue = candidateCell.coordinates[dimension.dimension_id];
    if (parentValue === candidateValue) continue;
    if (changedDimension !== null || dimension.ordered_values.length === 0) return null;
    const parentIndex = dimension.ordered_values.indexOf(parentValue);
    const candidateIndex = dimension.ordered_values.indexOf(candidateValue);
    if (parentIndex < 0 || candidateIndex <= parentIndex) return null;
    changedDimension = dimension;
  }
  if (changedDimension === null) return null;
  return "coverage-relation:" + parentCell.coverage_cell_id + "->" + candidateCell.coverage_cell_id;
}

export function computeCoverageDelta(
  parentValue: CoverageMap,
  candidateValue: CoverageMap,
  authorizationValue?: unknown,
): CoverageDeltaSummary {
  const parent = validateCoverageMap(parentValue);
  const candidate = validateCoverageMap(candidateValue);
  if (candidate.parent_coverage_map_id !== parent.coverage_map_id)
    failA1("COVERAGE_PARENT_MISMATCH", "candidate coverage map does not name the parent map");
  if (candidate.coverage_map_id === parent.coverage_map_id)
    failA1("COVERAGE_ID_REUSE", "candidate coverage map must have a new immutable id");

  assertDimensionsPreserved(parent, candidate);

  const parentCells = new Map(parent.coverage_cells.map((cell) => [cell.coverage_cell_id, cell]));
  const candidateCells = new Map(
    candidate.coverage_cells.map((cell) => [cell.coverage_cell_id, cell]),
  );
  for (const [cellId, parentCell] of parentCells) {
    const candidateCell = candidateCells.get(cellId);
    if (
      candidateCell &&
      coordinateKey(parentCell, parent.dimensions) !==
        coordinateKey(candidateCell, parent.dimensions)
    )
      failA1("COVERAGE_CELL_MUTATION", "coverage cell '" + cellId + "' changed coordinates");
  }

  const addedCells = sortIdentity([...candidateCells.keys()].filter((id) => !parentCells.has(id)));
  const authorization = parseAuthorization(authorizationValue);
  assertExistingCellsPreserved(parent, candidate, authorization);
  const deepenedRelations = new Set<string>();
  for (const candidateCell of candidate.coverage_cells) {
    if (parentCells.has(candidateCell.coverage_cell_id)) continue;
    if (!isAuthorizedBenchmark(candidateCell, authorization)) continue;
    for (const parentCell of parent.coverage_cells) {
      const relation = relationFor(parentCell, candidateCell, parent.dimensions);
      if (relation === null) continue;
      if (
        authorization.deepened_relations === null ||
        authorization.deepened_relations.includes(relation)
      )
        deepenedRelations.add(relation);
    }
  }

  const parentItems = new Set(parent.coverage_cells.flatMap((cell) => cell.benchmark_item_refs));
  const candidateItems = new Set(
    candidate.coverage_cells.flatMap((cell) => cell.benchmark_item_refs),
  );
  const supersededItems = authorization.superseded_benchmark_ids.filter((oldId) => {
    const replacement = authorization.superseded_replacements[oldId];
    return parentItems.has(oldId) && replacement !== undefined && candidateItems.has(replacement);
  });
  const retiredItems = authorization.retired_benchmark_ids.filter((item) => parentItems.has(item));
  return {
    added_cells: addedCells,
    deepened_relations: sortIdentity([...deepenedRelations]),
    superseded_items: sortIdentity(supersededItems),
    retired_invalid_items: sortIdentity(retiredItems),
  };
}

export function materializeCoverageMap(
  value: unknown,
  parent: CoverageMap | null,
  authorizationValue?: unknown,
): CoverageMap {
  const candidate = validateCoverageMap(value);
  if (parent === null) {
    if (candidate.parent_coverage_map_id !== null)
      failA1("COVERAGE_PARENT_MISMATCH", "root coverage map cannot name a parent");
    return {
      ...candidate,
      delta_summary: {
        added_cells: sortIdentity(
          candidate.coverage_cells.map((current) => current.coverage_cell_id),
        ),
        deepened_relations: [],
        superseded_items: [],
        retired_invalid_items: [],
      },
    };
  }
  const normalizedParent = validateCoverageMap(parent);
  const deltaSummary = computeCoverageDelta(normalizedParent, candidate, authorizationValue);
  return { ...candidate, delta_summary: deltaSummary };
}

export function coverageMapSha256(map: CoverageMap): string {
  return assertSha256(
    canonicalJsonSha256(map, undefined, { schemaVersion: "coverage-map-v1" }),
    "coverage_map_sha256",
  );
}
