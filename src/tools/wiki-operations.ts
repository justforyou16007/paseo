export type WikiPageKind = "paper" | "idea" | "experiment" | "claim" | "problem";

export const WIKI_EDGE_TYPES = [
  "extends",
  "contradicts",
  "addresses",
  "child_of",
  "inspired_by",
  "tested_by",
  "supports",
  "invalidates",
  "supersedes",
  "depends_on",
  "refutes",
  "uses",
] as const;

export type WikiEdgeType = (typeof WIKI_EDGE_TYPES)[number];

export type WikiOperation =
  | { op: "upsert_page"; kind: WikiPageKind; id: string; data: Record<string, unknown> }
  | { op: "remove_page"; kind: WikiPageKind; id: string }
  | {
      op: "upsert_edge";
      edge: { from: string; to: string; type: WikiEdgeType; evidence?: string };
    }
  | { op: "remove_edges"; from?: string; to?: string; type?: WikiEdgeType }
  | { op: "append_log"; message: string }
  | { op: "quarantine"; target: string; findings: string[]; raw_text: string }
  | { op: "set_project_direction"; text: string }
  | { op: "set_projection_config"; max_query_chars: number };

const PAGE_KINDS = new Set<WikiPageKind>(["paper", "idea", "experiment", "claim", "problem"]);
const EDGE_TYPE_SET = new Set<string>(WIKI_EDGE_TYPES);
const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NODE_ID_PATTERN = /^(paper|idea|exp|claim|problem):[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PAGE_DATA_KEYS: Record<WikiPageKind, readonly string[]> = {
  paper: [
    "title",
    "authors",
    "year",
    "venue",
    "external_ids",
    "tags",
    "thesis",
    "abstract",
    "primary_category",
  ],
  idea: [
    "title",
    "description",
    "stage",
    "outcome",
    "thesis",
    "risks",
    "based_on",
    "target_problems",
    "tags",
  ],
  experiment: [
    "title",
    "idea_id",
    "verdict",
    "confidence",
    "date",
    "hardware",
    "duration",
    "provenance",
    "metrics",
    "reasoning",
    "submission_id",
    // The fields below were written by the removed research loop. They stay
    // accepted so Wikis it wrote still replay; nothing writes them now.
    "iteration",
    "gate_metric",
    "gate_metric_name",
    "tester_metrics",
    "test_result_path",
    "test_audit_path",
    "test_result_sha256",
    "test_audit_sha256",
    "tester_run_id",
    "benchmark",
    "dataset_split",
    "test_sample_count",
    "tester_audit_status",
    "tester_definition_sha256",
    "tester_conclusion",
    "tester_confidence",
    "tester_directions",
    "tester_advice",
    "tags",
  ],
  claim: [
    "name",
    "description",
    "status",
    "provenance",
    "statement",
    "scope",
    "evidence",
    "tags",
    "date",
  ],
  problem: [
    "title",
    "status",
    "severity",
    "parent",
    "statement",
    "origin",
    "evidence",
    "whatWouldSolve",
    "caveats",
    "tags",
  ],
};

export function isWikiEdgeType(value: unknown): value is WikiEdgeType {
  return typeof value === "string" && EDGE_TYPE_SET.has(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`invalid Wiki operation ${location}: unknown field '${key}'`);
    }
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid Wiki operation: ${label} must be a string`);
  }
  return value;
}

function assertPageId(value: string, location: string): void {
  if (!PAGE_ID_PATTERN.test(value)) {
    throw new Error(
      `invalid Wiki page id '${value}' at ${location}; ids must be single relative path components`,
    );
  }
}

function assertNodeId(value: string, location: string): void {
  if (!NODE_ID_PATTERN.test(value)) {
    throw new Error(`invalid Wiki node id '${value}' at ${location}`);
  }
}

function assertStringArray(value: unknown, location: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${location} must be a string array`);
  }
}

/**
 * A machine-readable metric block: plain names, finite numbers, nothing nested.
 * The export ranks candidates by these, so they have to be comparable without
 * anyone re-reading the free-text `metrics` prose next to them.
 */
function assertNumberRecord(value: unknown, location: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new Error(`${location} must be a non-empty object of metric values`);
  }
  for (const [name, score] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw new Error(`${location} has an invalid metric name '${name}'`);
    if (typeof score !== "number" || !Number.isFinite(score))
      throw new Error(`${location}.${name} must be a finite number`);
  }
}

function assertOptionalStrings(
  data: Record<string, unknown>,
  fields: readonly string[],
  location: string,
): void {
  for (const field of fields) {
    if (data[field] !== undefined && typeof data[field] !== "string") {
      throw new Error(`${location}.${field} must be a string`);
    }
  }
}

function validatePageData(
  kind: WikiPageKind,
  data: Record<string, unknown>,
  location: string,
): void {
  assertKeys(data, PAGE_DATA_KEYS[kind], location);
  switch (kind) {
    case "paper": {
      assertOptionalStrings(
        data,
        ["title", "venue", "thesis", "abstract", "primary_category"],
        location,
      );
      if (data.authors !== undefined) assertStringArray(data.authors, `${location}.authors`);
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      if (
        data.year !== undefined &&
        (!Number.isInteger(data.year) || !Number.isFinite(data.year))
      ) {
        throw new Error(`${location}.year must be a finite integer`);
      }
      if (data.external_ids !== undefined) {
        if (!isObject(data.external_ids))
          throw new Error(`${location}.external_ids must be an object`);
        assertKeys(data.external_ids, ["arxiv", "doi", "s2"], `${location}.external_ids`);
        assertOptionalStrings(
          data.external_ids,
          ["arxiv", "doi", "s2"],
          `${location}.external_ids`,
        );
      }
      return;
    }
    case "idea":
      assertOptionalStrings(
        data,
        ["title", "description", "stage", "outcome", "thesis", "risks"],
        location,
      );
      for (const field of ["based_on", "target_problems", "tags"]) {
        if (data[field] !== undefined) assertStringArray(data[field], `${location}.${field}`);
      }
      return;
    case "experiment":
      assertOptionalStrings(
        data,
        [
          "title",
          "idea_id",
          "verdict",
          "confidence",
          "date",
          "hardware",
          "duration",
          "provenance",
          "metrics",
          "reasoning",
        ],
        location,
      );
      assertOptionalStrings(
        data,
        [
          "submission_id",
          "tester_definition_sha256",
          "test_result_path",
          "test_audit_path",
          "test_result_sha256",
          "test_audit_sha256",
          "tester_run_id",
          "benchmark",
          "dataset_split",
          "tester_audit_status",
        ],
        location,
      );
      for (const field of ["test_result_sha256", "test_audit_sha256"])
        if (data[field] !== undefined && !/^[0-9a-f]{64}$/.test(String(data[field])))
          throw new Error(`${location}.${field} must be a sha256 digest`);
      if (
        data.tester_audit_status !== undefined &&
        !["pass", "warn", "fail"].includes(String(data.tester_audit_status))
      )
        throw new Error(`${location}.tester_audit_status is invalid`);
      if (
        data.sample_count !== undefined &&
        (!Number.isInteger(data.sample_count) || (data.sample_count as number) < 1)
      )
        throw new Error(`${location}.sample_count must be positive`);
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      if (data.idea_id !== undefined && data.idea_id !== "")
        assertNodeId(data.idea_id as string, `${location}.idea_id`);
      if (
        data.iteration !== undefined &&
        (!Number.isInteger(data.iteration) || (data.iteration as number) < 1)
      )
        throw new Error(`${location}.iteration must be an integer >= 1`);
      if (
        data.gate_metric !== undefined &&
        (typeof data.gate_metric !== "number" || !Number.isFinite(data.gate_metric))
      )
        throw new Error(`${location}.gate_metric must be a finite number`);
      if (data.tester_metrics !== undefined)
        assertNumberRecord(data.tester_metrics, `${location}.tester_metrics`);
      if (
        data.tester_definition_sha256 !== undefined &&
        data.tester_definition_sha256 !== "" &&
        !/^[0-9a-f]{64}$/.test(data.tester_definition_sha256 as string)
      )
        throw new Error(`${location}.tester_definition_sha256 must be a sha256 hex digest`);
      // Descriptive feedback stays readable; publication checks live in the event store.
      assertOptionalStrings(data, ["tester_conclusion", "tester_confidence"], location);
      for (const field of ["tester_directions", "tester_advice"] as const) {
        if (data[field] === undefined) continue;
        assertStringArray(data[field], `${location}.${field}`);
        const items = data[field] as string[];
        if (new Set(items).size !== items.length)
          throw new Error(`${location}.${field} must not repeat a value`);
      }
      return;
    case "claim":
      assertOptionalStrings(
        data,
        ["name", "description", "status", "provenance", "statement", "scope", "evidence", "date"],
        location,
      );
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      return;
    case "problem":
      assertOptionalStrings(
        data,
        [
          "title",
          "status",
          "severity",
          "parent",
          "statement",
          "origin",
          "evidence",
          "whatWouldSolve",
          "caveats",
        ],
        location,
      );
      if (data.tags !== undefined) assertStringArray(data.tags, `${location}.tags`);
      if (data.parent !== undefined && data.parent !== "")
        assertNodeId(data.parent as string, `${location}.parent`);
      return;
  }
}

export function parseWikiOperation(value: unknown, location: string): WikiOperation {
  if (!isObject(value)) throw new Error(`invalid Wiki operation at ${location}`);
  const op = stringField(value.op, `${location}.op`);
  switch (op) {
    case "upsert_page": {
      assertKeys(value, ["op", "kind", "id", "data"], location);
      const kind = stringField(value.kind, `${location}.kind`) as WikiPageKind;
      if (!PAGE_KINDS.has(kind)) throw new Error(`invalid Wiki page kind '${kind}'`);
      const id = stringField(value.id, `${location}.id`);
      if (!isObject(value.data)) throw new Error(`${location}.data must be an object`);
      assertPageId(id, `${location}.id`);
      validatePageData(kind, value.data, `${location}.data`);
      return { op, kind, id, data: value.data };
    }
    case "remove_page": {
      assertKeys(value, ["op", "kind", "id"], location);
      const kind = stringField(value.kind, `${location}.kind`) as WikiPageKind;
      if (!PAGE_KINDS.has(kind)) throw new Error(`invalid Wiki page kind '${kind}'`);
      const id = stringField(value.id, `${location}.id`);
      assertPageId(id, `${location}.id`);
      return { op, kind, id };
    }
    case "upsert_edge": {
      assertKeys(value, ["op", "edge"], location);
      if (!isObject(value.edge)) throw new Error(`${location}.edge must be an object`);
      assertKeys(value.edge, ["from", "to", "type", "evidence"], `${location}.edge`);
      const from = stringField(value.edge.from, `${location}.edge.from`);
      const to = stringField(value.edge.to, `${location}.edge.to`);
      const type = stringField(value.edge.type, `${location}.edge.type`);
      if (!EDGE_TYPE_SET.has(type)) throw new Error(`invalid Wiki edge type '${type}'`);
      assertNodeId(from, `${location}.edge.from`);
      assertNodeId(to, `${location}.edge.to`);
      return {
        op,
        edge: {
          from,
          to,
          type: type as WikiEdgeType,
          evidence:
            value.edge.evidence === undefined
              ? ""
              : stringField(value.edge.evidence, `${location}.edge.evidence`),
        },
      };
    }
    case "remove_edges": {
      assertKeys(value, ["op", "from", "to", "type"], location);
      for (const key of ["from", "to", "type"] as const) {
        if (value[key] !== undefined) stringField(value[key], `${location}.${key}`);
      }
      if (value.from !== undefined) assertNodeId(value.from as string, `${location}.from`);
      if (value.to !== undefined) assertNodeId(value.to as string, `${location}.to`);
      if (value.type !== undefined && !EDGE_TYPE_SET.has(value.type as string)) {
        throw new Error(`invalid Wiki edge type '${value.type}'`);
      }
      return {
        op,
        from: value.from as string | undefined,
        to: value.to as string | undefined,
        type: value.type as WikiEdgeType | undefined,
      };
    }
    case "append_log":
      assertKeys(value, ["op", "message"], location);
      return { op, message: stringField(value.message, `${location}.message`) };
    case "quarantine":
      assertKeys(value, ["op", "target", "findings", "raw_text"], location);
      if (
        !Array.isArray(value.findings) ||
        !value.findings.every((item) => typeof item === "string")
      ) {
        throw new Error(`${location}.findings must be a string array`);
      }
      return {
        op,
        target: stringField(value.target, `${location}.target`),
        findings: [...value.findings],
        raw_text: stringField(value.raw_text, `${location}.raw_text`),
      };
    case "set_project_direction":
      assertKeys(value, ["op", "text"], location);
      return { op, text: stringField(value.text, `${location}.text`) };
    case "set_projection_config": {
      assertKeys(value, ["op", "max_query_chars"], location);
      if (
        typeof value.max_query_chars !== "number" ||
        !Number.isInteger(value.max_query_chars) ||
        value.max_query_chars < 200
      ) {
        throw new Error(`${location}.max_query_chars must be an integer >= 200`);
      }
      return { op, max_query_chars: value.max_query_chars };
    }
    default:
      throw new Error(`invalid Wiki operation '${op}' at ${location}`);
  }
}

// Event logs written by the removed research loop carry signal operations and a
// payload `context`. Reading drops both so those logs still replay; new writes
// may not contain them.
const LEGACY_OPS = new Set([
  "publish_signal",
  "upsert_signal",
  "retract_signal",
  "supersede_signal",
]);

export interface WikiPayload {
  operations: WikiOperation[];
}

export function parseWikiPayload(payload: unknown): WikiPayload {
  if (!isObject(payload)) throw new Error("Wiki payload must be an object");
  assertKeys(payload, ["operations", "context"], "payload");
  if (!Array.isArray(payload.operations)) {
    throw new Error("Wiki payload.operations must be an array");
  }
  return {
    operations: payload.operations
      .filter((item) => !(isObject(item) && LEGACY_OPS.has(item.op as string)))
      .map((item, index) => parseWikiOperation(item, `payload.operations[${index}]`)),
  };
}

/** A payload about to be appended: the legacy shapes are rejected. */
export function validateWikiPayload(payload: unknown): void {
  if (isObject(payload)) {
    if (payload.context !== undefined)
      throw new Error("Wiki payload.context is no longer accepted");
    if (Array.isArray(payload.operations)) {
      for (const item of payload.operations) {
        if (isObject(item) && LEGACY_OPS.has(item.op as string)) {
          throw new Error(`invalid Wiki operation '${String(item.op)}'`);
        }
      }
    }
  }
  parseWikiPayload(payload);
}
