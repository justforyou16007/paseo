import path from "node:path";
import { anyJsonSchema, canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertIdentifier,
  assertLimitsUnchanged,
  assertNoUnknownFields,
  assertRelativePath,
  assertSha256,
  compareIdentityStrings,
  failA1,
  getEnabledModuleIds,
  isRecord,
  parseOwnerLimits,
  requireFiniteNumber,
  requireInteger,
  requireString,
  validateWorkflowSpec,
  type JsonObject,
  type ModelUse,
  type OwnerLimits,
  type WorkflowEdge,
  type WorkflowFeedbackEdge,
  type WorkflowModule,
  type WorkflowSpec,
} from "./workflow-spec.js";
import { workflowCycleDirectory } from "./workflow-state.js";

export interface ModuleVersionIdentity {
  module_id: string;
  version: string;
  patch_sha256: string;
  input_artifact_ids: string[];
  code_paths: string[];
}

export interface CandidateModelAssignment {
  role_id: string;
  module_ids: string[];
  uses: ModelUse[];
  artifact_id: string;
  judge_targets: string[];
  resolved_from: "previous_promoted" | "fixed_external";
  generation: number | null;
}

export interface CandidateSnapshot {
  schema_version: 1;
  workflow_revision: string;
  parent_candidate_id: string | null;
  module_versions: ModuleVersionIdentity[];
  input_artifact_ids: string[];
  model_assignments: CandidateModelAssignment[];
  finite_cycles: number;
  random_seed: string | number;
  owner_limits: OwnerLimits;
  execution_graph: CandidateExecutionGraph;
  patch_paths: string[];
  run_id: string | null;
  attempt_id: string | null;
  wave_id: string | null;
  status: string | null;
  output_artifact_ids: string[];
  scorer_revision: string | null;
  judge_binding_id: string | null;
  tester_result_id: string | null;
  receipt_id: string | null;
  created_at: string | null;
}

export interface CandidateIdentityInput {
  workflow_revision: string;
  module_versions: ModuleVersionIdentity[];
  input_artifact_ids: string[];
  model_assignments: CandidateModelAssignment[];
  finite_cycles: number;
  random_seed: string | number;
  owner_limits: OwnerLimits;
  execution_graph?: unknown;
  final_graph?: unknown;
  graph?: unknown;
  patch_paths?: string[];
  run_id?: string;
  attempt_id?: string;
  wave_id?: string;
  status?: string;
  output_artifact_ids?: string[];
  scorer_revision?: string;
  judge_binding_id?: string;
  tester_result_id?: string;
  receipt_id?: string;
  created_at?: string;
  parent_candidate_id?: string;
}

export interface CandidateGraphNode {
  module_id: string;
  version: string;
  input_ports: string[];
  output_ports: string[];
}

export interface CandidateExecutionGraph {
  nodes: CandidateGraphNode[];
  edges: WorkflowEdge[];
  feedback_edges: WorkflowFeedbackEdge[];
}

export interface StructureActionReplace {
  op: "replace_module";
  module_id: string;
  replacement_module_id: string;
}

export interface StructureActionInsert {
  op: "insert_module";
  edge: string;
  module_id: string;
  input_port: string;
  output_port: string;
  contract: string;
}

export interface StructureEdgeReconnection {
  remove_edges: string[];
  add_edges: WorkflowEdge[];
}

export interface StructureActionRemove {
  op: "remove_module";
  module_id: string;
  reconnections: StructureEdgeReconnection;
}

export interface StructureActionFanOut {
  op: "fan_out";
  module_id: string;
  source: string;
  contract: string;
  branches: Array<{ to: string; contract: string }>;
  remove_edges: string[];
}

export interface StructureActionFanIn {
  op: "fan_in";
  module_id: string;
  target: string;
  contract: string;
  sources: Array<{ from: string; contract: string }>;
  remove_edges: string[];
}

export interface StructureActionReorder {
  op: "reorder";
  module_id: string;
  before_module_id: string;
  reconnections: StructureEdgeReconnection;
}

export type StructureAction =
  | StructureActionReplace
  | StructureActionInsert
  | StructureActionRemove
  | StructureActionFanOut
  | StructureActionFanIn
  | StructureActionReorder;

export interface AblationCell {
  cell_id: "00" | "10" | "01" | "11" | "S0" | "S1";
  module_ids: string[];
}

export interface AblationPlanIdentity {
  schema_version: 1;
  plan_id: string;
  workflow_revision: string;
  module_ids: string[];
  baseline_candidate_id: string;
  candidate_ids: Record<string, string>;
  cells: AblationCell[];
}

export interface AblationPlanIdentityInput {
  spec: WorkflowSpec;
  module_ids: readonly string[];
  baseline_candidate_id: string;
  candidate_ids: Readonly<Record<string, string>>;
}

export interface AblationResultRecord {
  complete: boolean;
  candidate_id?: string;
  plan_id?: string;
}

export interface AblationPlanValidationContext {
  spec: WorkflowSpec;
  module_ids: readonly string[];
  baseline_candidate_id: string;
  candidate_ids: Readonly<Record<string, string>>;
  plan_id?: string;
  /** The first frozen matrix. A later request may only validate this exact plan. */
  frozen_plan?: readonly AblationCell[];
}

export interface CompilationSummary {
  node_count: number;
  edge_count: number;
  max_fan_out: number;
  unrolled_cycles: number;
  worst_case_jobs: number;
  worst_case_compute: { amount: number; unit: string };
}

export interface CompiledWorkflow {
  schema_version: 1;
  workflow_id: string;
  workflow_revision: string;
  wave_kind: "module" | "structure" | "scorer";
  structure_delta_id: string | null;
  summary: CompilationSummary;
  execution_order: string[];
  expanded_execution_order: string[];
  candidate_id: string | null;
  execution_graph: CandidateExecutionGraph;
  owner_limits_sha256: string;
}

export interface CompileOptions {
  wave_kind?: "module" | "structure" | "scorer";
  structure_actions?: readonly StructureAction[];
  unrolled_cycles?: number;
  validation_repeats?: number;
  infrastructure_attempts?: number;
  workspace_root?: string;
  candidate?: CandidateIdentityInput;
}

const CANDIDATE_ALLOWED_FIELDS = [
  "schema_version",
  "workflow_revision",
  "parent_candidate_id",
  "module_versions",
  "input_artifact_ids",
  "model_assignments",
  "finite_cycles",
  "random_seed",
  "owner_limits",
  "execution_graph",
  "final_graph",
  "graph",
  "patch_paths",
  "run_id",
  "attempt_id",
  "wave_id",
  "status",
  "output_artifact_ids",
  "scorer_revision",
  "judge_binding_id",
  "tester_result_id",
  "receipt_id",
  "created_at",
] as const;

function parseModuleVersion(value: unknown, location: string): ModuleVersionIdentity {
  if (!isRecord(value)) failA1("INVALID_VALUE", "module version must be an object", location);
  const keys = new Set([
    "module_id",
    "version",
    "patch_sha256",
    "input_artifact_ids",
    "code_paths",
  ]);
  for (const key of Object.keys(value))
    if (!keys.has(key)) failA1("UNKNOWN_FIELD", `unknown field '${key}'`, `${location}.${key}`);
  const artifactIds = value.input_artifact_ids;
  if (!Array.isArray(artifactIds))
    failA1(
      "INVALID_VALUE",
      "input_artifact_ids must be an array",
      `${location}.input_artifact_ids`,
    );
  const codePaths = value.code_paths;
  if (!Array.isArray(codePaths))
    failA1("INVALID_VALUE", "code_paths must be an array", `${location}.code_paths`);
  const inputArtifactIds = artifactIds.map((item, index) =>
    assertIdentifier(item, `${location}.input_artifact_ids[${index}]`),
  );
  if (new Set(inputArtifactIds).size !== inputArtifactIds.length)
    failA1("DUPLICATE_ID", "module input artifact ids must be unique", location);
  return {
    module_id: assertIdentifier(value.module_id, `${location}.module_id`),
    version: assertIdentifier(value.version, `${location}.version`),
    patch_sha256: assertSha256(value.patch_sha256, `${location}.patch_sha256`),
    input_artifact_ids: inputArtifactIds,
    code_paths: codePaths.map((item, index) =>
      assertRelativePath(item, `${location}.code_paths[${index}]`),
    ),
  };
}

function parseAssignment(value: unknown, location: string): CandidateModelAssignment {
  if (!isRecord(value)) failA1("INVALID_VALUE", "model assignment must be an object", location);
  const allowed = [
    "role_id",
    "module_ids",
    "uses",
    "artifact_id",
    "judge_targets",
    "resolved_from",
    "generation",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown field '${key}'`, `${location}.${key}`);
  if (
    !Array.isArray(value.module_ids) ||
    !Array.isArray(value.uses) ||
    !Array.isArray(value.judge_targets)
  )
    failA1("INVALID_VALUE", "assignment arrays are required", location);
  const uses = value.uses.map((item, index) => {
    const use = requireString(item, `${location}.uses[${index}]`);
    if (!["generate", "train", "distill", "aggregate", "judge"].includes(use))
      failA1("INVALID_MODEL_USE", `unsupported use '${use}'`, `${location}.uses[${index}]`);
    return use as ModelUse;
  });
  if (new Set(uses).size !== uses.length)
    failA1("DUPLICATE_ID", "assignment uses must be unique", `${location}.uses`);
  const resolvedFrom = value.resolved_from;
  if (resolvedFrom !== "previous_promoted" && resolvedFrom !== "fixed_external")
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "assignment must name a permitted source",
      `${location}.resolved_from`,
    );
  const generation =
    value.generation === null || value.generation === undefined
      ? null
      : requireInteger(value.generation, `${location}.generation`, 0);
  const moduleIds = value.module_ids.map((item, index) =>
    assertIdentifier(item, `${location}.module_ids[${index}]`),
  );
  const judgeTargets = value.judge_targets.map((item, index) =>
    assertIdentifier(item, `${location}.judge_targets[${index}]`),
  );
  if (new Set(moduleIds).size !== moduleIds.length)
    failA1("DUPLICATE_ID", "assignment module ids must be unique", `${location}.module_ids`);
  if (new Set(judgeTargets).size !== judgeTargets.length)
    failA1("DUPLICATE_ID", "assignment judge targets must be unique", `${location}.judge_targets`);
  return {
    role_id: assertIdentifier(value.role_id, `${location}.role_id`),
    module_ids: moduleIds,
    uses,
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    judge_targets: judgeTargets,
    resolved_from: resolvedFrom,
    generation,
  };
}

function parseCandidateEndpoint(value: unknown, location: string): string {
  const endpoint = requireString(value, location);
  const parts = endpoint.split(".");
  if (parts.length !== 2)
    failA1("INVALID_CANDIDATE", "graph endpoint must be module.port", location);
  assertIdentifier(parts[0], `${location}.module`);
  assertIdentifier(parts[1], `${location}.port`);
  return endpoint;
}

function parseCandidateGraphEdge(value: unknown, location: string): WorkflowEdge {
  if (!isRecord(value)) failA1("INVALID_CANDIDATE", "graph edge must be an object", location);
  assertNoUnknownFields(value, ["from", "to", "contract"], location);
  return {
    from: parseCandidateEndpoint(value.from, `${location}.from`),
    to: parseCandidateEndpoint(value.to, `${location}.to`),
    contract: requireString(value.contract, `${location}.contract`),
  };
}

function parseCandidateGraphNode(value: unknown, location: string): CandidateGraphNode {
  if (!isRecord(value)) failA1("INVALID_CANDIDATE", "graph node must be an object", location);
  assertNoUnknownFields(
    value,
    ["module_id", "id", "version", "input_ports", "output_ports"],
    location,
  );
  const moduleIdValue = value.module_id ?? value.id;
  if (value.module_id !== undefined && value.id !== undefined && value.module_id !== value.id)
    failA1("INVALID_CANDIDATE", "graph node id and module_id disagree", location);
  const inputPorts =
    value.input_ports === undefined
      ? []
      : value.input_ports instanceof Array
        ? value.input_ports.map((port, index) =>
            assertIdentifier(port, `${location}.input_ports[${index}]`),
          )
        : failA1("INVALID_CANDIDATE", "graph node input_ports must be an array", location);
  const outputPorts =
    value.output_ports === undefined
      ? []
      : value.output_ports instanceof Array
        ? value.output_ports.map((port, index) =>
            assertIdentifier(port, `${location}.output_ports[${index}]`),
          )
        : failA1("INVALID_CANDIDATE", "graph node output_ports must be an array", location);
  if (new Set(inputPorts).size !== inputPorts.length)
    failA1("DUPLICATE_ID", "graph node input ports must be unique", `${location}.input_ports`);
  if (new Set(outputPorts).size !== outputPorts.length)
    failA1("DUPLICATE_ID", "graph node output ports must be unique", `${location}.output_ports`);
  return {
    module_id: assertIdentifier(moduleIdValue, `${location}.module_id`),
    version: assertIdentifier(value.version, `${location}.version`),
    input_ports: inputPorts,
    output_ports: outputPorts,
  };
}

function parseCandidateFeedbackEdge(value: unknown, location: string): WorkflowFeedbackEdge {
  if (!isRecord(value)) failA1("INVALID_CANDIDATE", "feedback edge must be an object", location);
  assertNoUnknownFields(value, ["from", "to", "barrier", "contract"], location);
  if (value.barrier !== "next_outer_iteration")
    failA1(
      "INVALID_CANDIDATE",
      "feedback edge must target the next outer iteration",
      `${location}.barrier`,
    );
  const feedback: WorkflowFeedbackEdge = {
    from: parseCandidateEndpoint(value.from, `${location}.from`),
    to: parseCandidateEndpoint(value.to, `${location}.to`),
    barrier: "next_outer_iteration",
  };
  if (value.contract !== undefined)
    feedback.contract = requireString(value.contract, `${location}.contract`);
  return feedback;
}

function parseCandidateGraph(value: unknown, location: string): CandidateExecutionGraph {
  if (!isRecord(value)) failA1("INVALID_CANDIDATE", "execution graph must be an object", location);
  assertNoUnknownFields(value, ["nodes", "edges", "feedback_edges"], location);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
    failA1("INVALID_CANDIDATE", "execution graph needs nodes and edges", location);
  const nodes = value.nodes.map((node, index) =>
    parseCandidateGraphNode(node, `${location}.nodes[${index}]`),
  );
  if (nodes.length === 0)
    failA1("INVALID_CANDIDATE", "execution graph needs a node", `${location}.nodes`);
  if (new Set(nodes.map((node) => node.module_id)).size !== nodes.length)
    failA1("DUPLICATE_ID", "execution graph node ids must be unique", `${location}.nodes`);
  const edges = value.edges.map((edge, index) =>
    parseCandidateGraphEdge(edge, `${location}.edges[${index}]`),
  );
  const feedbackEdges =
    value.feedback_edges === undefined
      ? []
      : Array.isArray(value.feedback_edges)
        ? value.feedback_edges.map((edge, index) =>
            parseCandidateFeedbackEdge(edge, `${location}.feedback_edges[${index}]`),
          )
        : failA1("INVALID_CANDIDATE", "feedback_edges must be an array", location);
  const nodeIds = new Set(nodes.map((node) => node.module_id));
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    const source = moduleFromEndpoint(edge.from);
    const target = moduleFromEndpoint(edge.to);
    if (!nodeIds.has(source) || !nodeIds.has(target))
      failA1("INVALID_CANDIDATE", "execution graph edge references an unknown node", location);
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) failA1("DUPLICATE_ID", "execution graph edges must be unique", location);
    edgeKeys.add(key);
    const sourceNode = nodes.find((node) => node.module_id === source)!;
    const targetNode = nodes.find((node) => node.module_id === target)!;
    const sourcePort = edge.from.split(".")[1]!;
    const targetPort = edge.to.split(".")[1]!;
    if (sourceNode.output_ports.length > 0 && !sourceNode.output_ports.includes(sourcePort))
      failA1("INVALID_CANDIDATE", `edge source port '${sourcePort}' is not declared`, location);
    if (targetNode.input_ports.length > 0 && !targetNode.input_ports.includes(targetPort))
      failA1("INVALID_CANDIDATE", `edge target port '${targetPort}' is not declared`, location);
  }
  topologicalOrderNodes(
    nodes.map((node) => node.module_id),
    edges.map((edge) => [moduleFromEndpoint(edge.from), moduleFromEndpoint(edge.to)] as const),
  );
  const externalFeedbackSources = new Set(["evaluation", "tester", "workflow", "scorer"]);
  const feedbackKeys = new Set<string>();
  for (const feedback of feedbackEdges) {
    const source = moduleFromEndpoint(feedback.from);
    const target = moduleFromEndpoint(feedback.to);
    if (!nodeIds.has(target) || (!nodeIds.has(source) && !externalFeedbackSources.has(source)))
      failA1("INVALID_CANDIDATE", "feedback edge references an unknown graph node", location);
    if (source === target)
      failA1("INVALID_CANDIDATE", "feedback edge endpoints must differ", location);
    const sourceNode = nodeIds.has(source)
      ? nodes.find((node) => node.module_id === source)!
      : null;
    const targetNode = nodes.find((node) => node.module_id === target)!;
    const sourcePort = feedback.from.split(".")[1]!;
    const targetPort = feedback.to.split(".")[1]!;
    if (
      sourceNode &&
      sourceNode.output_ports.length > 0 &&
      !sourceNode.output_ports.includes(sourcePort)
    )
      failA1("INVALID_CANDIDATE", `feedback source port '${sourcePort}' is not declared`, location);
    if (targetNode.input_ports.length > 0 && !targetNode.input_ports.includes(targetPort))
      failA1("INVALID_CANDIDATE", `feedback target port '${targetPort}' is not declared`, location);
    const key = `${feedback.from}->${feedback.to}`;
    if (edgeKeys.has(key))
      failA1("DUPLICATE_ID", "ordinary and feedback edges must not share endpoints", location);
    if (feedbackKeys.has(key))
      failA1("DUPLICATE_ID", "execution graph feedback edges must be unique", location);
    feedbackKeys.add(key);
  }
  return {
    nodes: nodes.map((node) => ({
      ...node,
      input_ports: [...node.input_ports].sort(compareIdentityStrings),
      output_ports: [...node.output_ports].sort(compareIdentityStrings),
    })),
    edges,
    feedback_edges: feedbackEdges,
  };
}

function parseCandidateExecutionGraph(value: JsonObject): CandidateExecutionGraph {
  const graphValues = [value.execution_graph, value.final_graph, value.graph].filter(
    (candidate): candidate is unknown => candidate !== undefined,
  );
  if (graphValues.length !== 1)
    failA1(
      "INVALID_CANDIDATE",
      "candidate must contain exactly one execution_graph",
      "candidate.execution_graph",
    );
  return parseCandidateGraph(graphValues[0], "candidate.execution_graph");
}

export function validateCandidateSnapshot(value: unknown): CandidateSnapshot {
  if (!isRecord(value)) failA1("INVALID_CANDIDATE", "candidate snapshot must be an object");
  for (const key of Object.keys(value))
    if (!CANDIDATE_ALLOWED_FIELDS.includes(key as (typeof CANDIDATE_ALLOWED_FIELDS)[number]))
      failA1("UNKNOWN_FIELD", `unknown field '${key}'`, `candidate.${key}`);
  if (value.schema_version !== 1)
    failA1("INVALID_CANDIDATE", "schema_version must be 1", "candidate.schema_version");
  const moduleVersionsValue = value.module_versions;
  const assignmentValue = value.model_assignments;
  if (!Array.isArray(moduleVersionsValue) || !Array.isArray(assignmentValue))
    failA1("INVALID_CANDIDATE", "module_versions and model_assignments are required", "candidate");
  const inputArtifactIds = value.input_artifact_ids;
  const outputArtifactIds =
    value.output_artifact_ids === undefined ? [] : value.output_artifact_ids;
  if (!Array.isArray(inputArtifactIds) || !Array.isArray(outputArtifactIds))
    failA1("INVALID_CANDIDATE", "artifact id arrays are required", "candidate");
  const patchPaths = value.patch_paths === undefined ? [] : value.patch_paths;
  if (!Array.isArray(patchPaths))
    failA1("INVALID_CANDIDATE", "patch_paths must be an array", "candidate.patch_paths");
  const parsedInputArtifacts = inputArtifactIds.map((item, index) =>
    assertIdentifier(item, `candidate.input_artifact_ids[${index}]`),
  );
  const parsedOutputArtifacts = outputArtifactIds.map((item, index) =>
    assertIdentifier(item, `candidate.output_artifact_ids[${index}]`),
  );
  if (new Set(parsedInputArtifacts).size !== parsedInputArtifacts.length)
    failA1(
      "DUPLICATE_ID",
      "candidate input artifact ids must be unique",
      "candidate.input_artifact_ids",
    );
  if (new Set(parsedOutputArtifacts).size !== parsedOutputArtifacts.length)
    failA1(
      "DUPLICATE_ID",
      "candidate output artifact ids must be unique",
      "candidate.output_artifact_ids",
    );
  const optionalString = (field: string): string | null =>
    value[field] === undefined || value[field] === null
      ? null
      : assertIdentifier(value[field], `candidate.${field}`);
  const randomSeed =
    typeof value.random_seed === "string"
      ? requireString(value.random_seed, "candidate.random_seed")
      : value.random_seed;
  if (
    typeof randomSeed !== "string" &&
    !(typeof randomSeed === "number" && Number.isFinite(randomSeed))
  )
    failA1(
      "INVALID_CANDIDATE",
      "random_seed must be a string or finite number",
      "candidate.random_seed",
    );
  const moduleVersions = moduleVersionsValue.map((item, index) =>
    parseModuleVersion(item, `candidate.module_versions[${index}]`),
  );
  const executionGraph = parseCandidateExecutionGraph(value);
  if (new Set(moduleVersions.map((module) => module.module_id)).size !== moduleVersions.length) {
    failA1("DUPLICATE_ID", "candidate module ids must be unique", "candidate.module_versions");
  }
  const modelAssignments = assignmentValue.map((item, index) =>
    parseAssignment(item, `candidate.model_assignments[${index}]`),
  );
  if (
    new Set(modelAssignments.map((assignment) => assignment.role_id)).size !==
    modelAssignments.length
  ) {
    failA1(
      "DUPLICATE_ID",
      "candidate model role ids must be unique",
      "candidate.model_assignments",
    );
  }
  const moduleVersionsById = new Map(
    moduleVersions.map((moduleVersion) => [moduleVersion.module_id, moduleVersion]),
  );
  if (moduleVersionsById.size !== executionGraph.nodes.length) {
    failA1(
      "CANDIDATE_GRAPH_MISMATCH",
      "execution graph nodes and module versions must describe the same modules",
      "candidate.execution_graph.nodes",
    );
  }
  for (const node of executionGraph.nodes) {
    const moduleVersion = moduleVersionsById.get(node.module_id);
    if (!moduleVersion || moduleVersion.version !== node.version)
      failA1(
        "CANDIDATE_GRAPH_MISMATCH",
        `execution graph node '${node.module_id}' does not match its module version`,
        "candidate.execution_graph.nodes",
      );
  }
  const normalizedPatchPaths = patchPaths.map((item, index) =>
    assertRelativePath(item, `candidate.patch_paths[${index}]`),
  );
  if (new Set(normalizedPatchPaths).size !== normalizedPatchPaths.length) {
    failA1("DUPLICATE_ID", "candidate patch paths must be unique", "candidate.patch_paths");
  }
  const finiteCycles = requireInteger(value.finite_cycles, "candidate.finite_cycles", 0);
  const ownerLimits = parseOwnerLimits(value.owner_limits, "candidate.owner_limits");
  if (finiteCycles > ownerLimits.max_unrolled_cycles) {
    failA1(
      "rejected_limit",
      "candidate finite cycles exceed the frozen owner limit",
      "candidate.finite_cycles",
    );
  }
  return {
    schema_version: 1,
    workflow_revision: assertIdentifier(value.workflow_revision, "candidate.workflow_revision"),
    parent_candidate_id: optionalString("parent_candidate_id"),
    module_versions: moduleVersions,
    input_artifact_ids: parsedInputArtifacts,
    model_assignments: modelAssignments,
    finite_cycles: finiteCycles,
    random_seed: randomSeed,
    owner_limits: ownerLimits,
    execution_graph: executionGraph,
    patch_paths: normalizedPatchPaths,
    run_id: optionalString("run_id"),
    attempt_id: optionalString("attempt_id"),
    wave_id: optionalString("wave_id"),
    status:
      value.status === undefined || value.status === null
        ? null
        : requireString(value.status, "candidate.status"),
    output_artifact_ids: parsedOutputArtifacts,
    scorer_revision: optionalString("scorer_revision"),
    judge_binding_id: optionalString("judge_binding_id"),
    tester_result_id: optionalString("tester_result_id"),
    receipt_id: optionalString("receipt_id"),
    created_at:
      value.created_at === undefined || value.created_at === null
        ? null
        : requireString(value.created_at, "candidate.created_at"),
  };
}

function semanticAssignment(assignment: CandidateModelAssignment): Record<string, unknown> | null {
  const productionUses = assignment.uses
    .filter((use) => use !== "judge")
    .sort(compareIdentityStrings);
  if (productionUses.length === 0) return null;
  return {
    role_id: assignment.role_id,
    module_ids: [...assignment.module_ids].sort(compareIdentityStrings),
    uses: productionUses,
    artifact_id: assignment.artifact_id,
    resolved_from: assignment.resolved_from,
    generation: assignment.generation,
  };
}

function semanticCandidate(
  snapshot: CandidateSnapshot,
  workspaceRoot?: string,
): Record<string, unknown> {
  const moduleVersions = [...snapshot.module_versions]
    .sort((left, right) => compareIdentityStrings(left.module_id, right.module_id))
    .map((module) => ({
      module_id: module.module_id,
      version: module.version,
      patch_sha256: module.patch_sha256,
      input_artifact_ids: [...module.input_artifact_ids].sort(compareIdentityStrings),
      code_paths: module.code_paths
        .map((codePath) =>
          workspaceRoot
            ? assertRelativePath(codePath, "candidate.module_versions.code_paths")
            : codePath,
        )
        .sort(compareIdentityStrings),
    }));
  const modelAssignments = snapshot.model_assignments
    .map(semanticAssignment)
    .filter((assignment): assignment is Record<string, unknown> => assignment !== null)
    .sort((left, right) => compareIdentityStrings(String(left.role_id), String(right.role_id)));
  const paths = snapshot.patch_paths
    .map((patchPath) =>
      workspaceRoot ? assertRelativePath(patchPath, "candidate.patch_paths") : patchPath,
    )
    .sort(compareIdentityStrings);
  const executionGraph = {
    nodes: [...snapshot.execution_graph.nodes]
      .sort((left, right) => compareIdentityStrings(left.module_id, right.module_id))
      .map((node) => ({
        module_id: node.module_id,
        version: node.version,
        input_ports: [...node.input_ports].sort(compareIdentityStrings),
        output_ports: [...node.output_ports].sort(compareIdentityStrings),
      })),
    edges: [...snapshot.execution_graph.edges]
      .sort((left, right) => {
        const leftKey = `${edgeKey(left)}|${left.contract}`;
        const rightKey = `${edgeKey(right)}|${right.contract}`;
        return compareIdentityStrings(leftKey, rightKey);
      })
      .map((edge) => ({ ...edge })),
    feedback_edges: [...snapshot.execution_graph.feedback_edges]
      .sort((left, right) => {
        const leftKey = `${left.from}->${left.to}|${left.barrier}`;
        const rightKey = `${right.from}->${right.to}|${right.barrier}`;
        return compareIdentityStrings(leftKey, rightKey);
      })
      .map((edge) => ({ ...edge })),
  };
  return {
    schema_version: 1,
    workflow_revision: snapshot.workflow_revision,
    module_versions: moduleVersions,
    input_artifact_ids: [...snapshot.input_artifact_ids].sort(compareIdentityStrings),
    model_assignments: modelAssignments,
    finite_cycles: snapshot.finite_cycles,
    random_seed: snapshot.random_seed,
    owner_limits: snapshot.owner_limits,
    execution_graph: executionGraph,
    patch_paths: paths,
  };
}

export function candidateIdFromSnapshot(value: unknown, workspaceRoot?: string): string {
  const snapshot = validateCandidateSnapshot(value);
  const semantic = semanticCandidate(snapshot, workspaceRoot);
  const digest = canonicalJsonSha256(semantic, anyJsonSchema, { schemaVersion: "candidate-id-v1" });
  return `candidate:sha256:${digest}`;
}

export const buildCandidateId = candidateIdFromSnapshot;

export function candidateSemanticObject(
  value: unknown,
  workspaceRoot?: string,
): Record<string, unknown> {
  return semanticCandidate(validateCandidateSnapshot(value), workspaceRoot);
}

function moduleMap(spec: WorkflowSpec): Map<string, WorkflowModule> {
  return new Map(spec.module_catalog.map((module) => [module.id, module]));
}

function moduleFromEndpoint(endpoint: string): string {
  return endpoint.split(".")[0]!;
}

function adjacency(spec: WorkflowSpec): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const moduleId of getEnabledModuleIds(spec)) result.set(moduleId, new Set());
  for (const edge of spec.edges)
    result.get(moduleFromEndpoint(edge.from))!.add(moduleFromEndpoint(edge.to));
  for (const edge of spec.feedback_edges) {
    const source = moduleFromEndpoint(edge.from);
    const target = moduleFromEndpoint(edge.to);
    if (result.has(source) && result.has(target)) result.get(source)!.add(target);
  }
  return result;
}

function reaches(graph: Map<string, Set<string>>, start: string, target: string): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const child of graph.get(current) ?? []) pending.push(child);
  }
  return false;
}

export function assertParallelModuleSet(spec: WorkflowSpec, moduleIds: readonly string[]): void {
  const validatedSpec = validateWorkflowSpec(spec);
  if (moduleIds.length < 1 || moduleIds.length > validatedSpec.wave_policy.max_parallel_modules) {
    failA1(
      "INVALID_WAVE_POLICY",
      `module wave width must be between 1 and ${validatedSpec.wave_policy.max_parallel_modules}`,
    );
  }
  if (new Set(moduleIds).size !== moduleIds.length)
    failA1("DUPLICATE_ID", "parallel module ids must be unique");
  const modules = moduleMap(validatedSpec);
  const enabledIds = new Set(getEnabledModuleIds(validatedSpec));
  for (const moduleId of moduleIds) {
    if (!modules.has(moduleId)) failA1("INVALID_ID", `unknown module '${moduleId}' in workset`);
    if (!enabledIds.has(moduleId))
      failA1(
        "INACTIVE_MODULE",
        `catalog-only module '${moduleId}' cannot be scheduled in a workset`,
      );
  }
  const graph = adjacency(validatedSpec);
  for (let firstIndex = 0; firstIndex < moduleIds.length; firstIndex += 1) {
    const first = moduleIds[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < moduleIds.length; secondIndex += 1) {
      const second = moduleIds[secondIndex]!;
      if (reaches(graph, first, second) || reaches(graph, second, first)) {
        failA1(
          "MODULE_DEPENDENCY_CONFLICT",
          `modules '${first}' and '${second}' have a direct or transitive dependency`,
        );
      }
    }
  }
  const selected = moduleIds.map((moduleId) => modules.get(moduleId)!);
  for (let firstIndex = 0; firstIndex < selected.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < selected.length; secondIndex += 1) {
      const first = selected[firstIndex]!;
      const second = selected[secondIndex]!;
      for (const firstScope of first.write_scope) {
        for (const secondScope of second.write_scope) {
          const firstRoot = firstScope.replace(/(?:\/\*\*)|(?:\/\*)|\*+$/g, "");
          const secondRoot = secondScope.replace(/(?:\/\*\*)|(?:\/\*)|\*+$/g, "");
          if (
            firstRoot === secondRoot ||
            firstRoot.startsWith(`${secondRoot}/`) ||
            secondRoot.startsWith(`${firstRoot}/`)
          ) {
            failA1(
              "WRITE_SCOPE_CONFLICT",
              `modules '${first.id}' and '${second.id}' write overlapping paths`,
            );
          }
        }
      }
    }
  }
}

export function buildAblationPlan(
  spec: WorkflowSpec,
  moduleIds: readonly string[],
): AblationCell[] {
  // The bridge passes the positions that actually returned a candidate. An
  // empty set therefore means "no matrix", not an invalid parallel workset.
  if (moduleIds.length === 0) return [];
  assertParallelModuleSet(spec, moduleIds);
  const orderedModuleIds = [...moduleIds].sort(compareIdentityStrings);
  if (orderedModuleIds.length === 1) {
    return [
      { cell_id: "00", module_ids: [] },
      { cell_id: "10", module_ids: [orderedModuleIds[0]!] },
    ];
  }
  return [
    { cell_id: "00", module_ids: [] },
    { cell_id: "10", module_ids: [orderedModuleIds[0]!] },
    { cell_id: "01", module_ids: [orderedModuleIds[1]!] },
    { cell_id: "11", module_ids: [...orderedModuleIds] },
  ];
}

function expectedAblationCells(moduleIds: readonly string[]): AblationCell[] {
  if (moduleIds.length === 0) return [];
  if (moduleIds.length === 1)
    return [
      { cell_id: "00", module_ids: [] },
      { cell_id: "10", module_ids: [moduleIds[0]!] },
    ];
  if (moduleIds.length === 2)
    return [
      { cell_id: "00", module_ids: [] },
      { cell_id: "10", module_ids: [moduleIds[0]!] },
      { cell_id: "01", module_ids: [moduleIds[1]!] },
      { cell_id: "11", module_ids: [...moduleIds] },
    ];
  failA1("INVALID_WAVE_POLICY", "ablation width must be exactly 1 or 2");
}

function assertAblationCellShape(
  actual: readonly AblationCell[],
  expected: readonly AblationCell[],
): void {
  if (actual.length !== expected.length)
    failA1("ABLATION_INCOMPLETE", "ablation plan does not contain the complete expected matrix");
  const expectedById = new Map<string, AblationCell>(expected.map((cell) => [cell.cell_id, cell]));
  const seen = new Set<string>();
  for (const cell of actual) {
    if (seen.has(cell.cell_id) || !expectedById.has(cell.cell_id))
      failA1("ABLATION_INCOMPLETE", "unexpected or duplicate ablation cell '" + cell.cell_id + "'");
    seen.add(cell.cell_id);
    const expectedCell = expectedById.get(cell.cell_id)!;
    if (
      cell.module_ids.length !== expectedCell.module_ids.length ||
      cell.module_ids.some((moduleId, index) => moduleId !== expectedCell.module_ids[index])
    )
      failA1(
        "ABLATION_INCOMPLETE",
        "ablation cell '" + cell.cell_id + "' does not contain the expected module set",
      );
  }
}

export function buildAblationPlanIdentity(input: AblationPlanIdentityInput): AblationPlanIdentity {
  const spec = validateWorkflowSpec(input.spec);
  if (input.module_ids.length > 0) assertParallelModuleSet(spec, input.module_ids);
  if (input.module_ids.length > 2)
    failA1("INVALID_WAVE_POLICY", "ablation width must be at most 2");
  const moduleIds = [...input.module_ids].sort(compareIdentityStrings);
  const cells = expectedAblationCells(moduleIds);
  const expectedCandidateCells = cells.filter((cell) => cell.cell_id !== "00");
  const candidateKeys = Object.keys(input.candidate_ids).sort(compareIdentityStrings);
  const expectedKeys = expectedCandidateCells
    .map((cell) => cell.cell_id)
    .sort(compareIdentityStrings);
  if (
    candidateKeys.length !== expectedKeys.length ||
    candidateKeys.some((key, index) => key !== expectedKeys[index])
  )
    failA1("ABLATION_CANDIDATE_MISMATCH", "candidate identities do not cover the expected cells");
  const candidateIds: Record<string, string> = {};
  for (const cellId of expectedKeys) {
    const candidateId = input.candidate_ids[cellId];
    if (candidateId === undefined)
      failA1("ABLATION_CANDIDATE_MISMATCH", "missing candidate identity for cell '" + cellId + "'");
    candidateIds[cellId] = assertIdentifier(candidateId, "candidate_ids." + cellId);
  }
  const baselineCandidateId = assertIdentifier(
    input.baseline_candidate_id,
    "baseline_candidate_id",
  );
  const identityFields = {
    schema_version: 1 as const,
    workflow_revision: spec.revision,
    module_ids: moduleIds,
    baseline_candidate_id: baselineCandidateId,
    candidate_ids: candidateIds,
    cells,
  };
  const digest = canonicalJsonSha256(identityFields, anyJsonSchema, {
    schemaVersion: "ablation-plan-v1",
  });
  return { ...identityFields, plan_id: "ablation-plan:sha256:" + digest };
}

export function validateCompleteAblationPlan(
  plan: readonly AblationCell[],
  results: ReadonlyMap<string, AblationResultRecord>,
  context?: AblationPlanValidationContext,
): void {
  const moduleIds = context
    ? [...context.module_ids].sort(compareIdentityStrings)
    : [...new Set(plan.flatMap((cell) => cell.module_ids))];
  if (context?.frozen_plan !== undefined) {
    assertAblationPlanConstructible(
      context.frozen_plan,
      plan.map((cell) => cell.cell_id),
    );
    assertAblationPlanFrozen(context.frozen_plan, plan);
  }
  const identity = context
    ? buildAblationPlanIdentity({
        spec: context.spec,
        module_ids: moduleIds,
        baseline_candidate_id: context.baseline_candidate_id,
        candidate_ids: context.candidate_ids,
      })
    : null;
  if (context?.plan_id !== undefined && context.plan_id !== identity?.plan_id)
    failA1("ABLATION_PLAN_ID_MISMATCH", "ablation results use a different plan identity");
  if (!context && moduleIds.length > 2)
    failA1("ABLATION_INCOMPLETE", "ablation plan does not identify at most two wave modules");
  const expected = expectedAblationCells(moduleIds);
  assertAblationCellShape(plan, expected);
  if (results.size !== expected.length)
    failA1("ABLATION_INCOMPLETE", "ablation results contain missing or unexpected cells");
  const expectedById = new Map<string, AblationCell>(expected.map((cell) => [cell.cell_id, cell]));
  for (const [cellId, result] of results) {
    if (!expectedById.has(cellId))
      failA1("ABLATION_INCOMPLETE", "unexpected ablation result for cell '" + cellId + "'");
    if (!result.complete)
      failA1("ABLATION_INCOMPLETE", "ablation cell '" + cellId + "' is incomplete");
    if (context) {
      const expectedCandidateId =
        cellId === "00" ? identity!.baseline_candidate_id : identity!.candidate_ids[cellId];
      if (result.candidate_id !== expectedCandidateId)
        failA1(
          "ABLATION_CANDIDATE_MISMATCH",
          "ablation cell '" + cellId + "' is bound to the wrong candidate",
        );
      if (context.plan_id !== undefined && result.plan_id !== context.plan_id)
        failA1(
          "ABLATION_PLAN_ID_MISMATCH",
          "ablation cell '" + cellId + "' is bound to a different plan",
        );
    }
  }
  for (const cell of expected) {
    if (!results.has(cell.cell_id))
      failA1("ABLATION_INCOMPLETE", "ablation cell '" + cell.cell_id + "' is missing");
  }
}

/**
 * A matrix is a frozen input to validation. Once it is frozen, a caller may
 * not widen it, narrow it, or replace one cell with another candidate.
 */
export function assertAblationPlanFrozen(
  frozenPlan: readonly AblationCell[],
  requestedPlan: readonly AblationCell[],
): void {
  const canonical = (value: readonly AblationCell[]) =>
    value.map((cell) => ({ cell_id: cell.cell_id, module_ids: [...cell.module_ids] }));
  if (
    canonicalJsonSha256(canonical(frozenPlan), anyJsonSchema, {
      schemaVersion: "frozen-ablation-plan-v1",
    }) !==
    canonicalJsonSha256(canonical(requestedPlan), anyJsonSchema, {
      schemaVersion: "frozen-ablation-plan-v1",
    })
  )
    failA1(
      "ABLATION_WIDTH_FROZEN",
      "the ablation matrix width and cells cannot change after freezing",
    );
}

/**
 * Check construction before validation starts. A missing frozen cell rejects
 * the whole wave; the caller must not compare the cells that happened to run.
 */
export function assertAblationPlanConstructible(
  frozenPlan: readonly AblationCell[],
  constructibleCellIds: readonly string[],
): void {
  if (new Set(constructibleCellIds).size !== constructibleCellIds.length)
    failA1("DUPLICATE_ID", "constructible ablation cell ids must be unique");
  const expected = new Set<string>(frozenPlan.map((cell) => cell.cell_id));
  const actual = new Set(constructibleCellIds);
  for (const cellId of expected) {
    if (!actual.has(cellId))
      failA1(
        "rejected_incompatible",
        `frozen ablation cell '${cellId}' cannot be constructed; reject the entire wave`,
      );
  }
  for (const cellId of actual) {
    if (!expected.has(cellId))
      failA1(
        "ABLATION_WIDTH_FROZEN",
        `ablation cell '${cellId}' was requested after the matrix was frozen`,
      );
  }
}

function parseActionEndpoint(value: unknown, location: string): string {
  const endpoint = requireString(value, location);
  const parts = endpoint.split(".");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(part))
  ) {
    failA1("INVALID_STRUCTURE_DELTA", "structure edge must use module.port endpoints", location);
  }
  return endpoint;
}

function parseEdgeKey(value: unknown, location: string): string {
  const text = requireString(value, location);
  const endpoints = text.split("->");
  if (endpoints.length !== 2)
    failA1("INVALID_STRUCTURE_DELTA", "edge key must contain one ->", location);
  return `${parseActionEndpoint(endpoints[0], `${location}.from`)}->${parseActionEndpoint(endpoints[1], `${location}.to`)}`;
}

function parseActionEdge(value: unknown, location: string): WorkflowEdge {
  if (!isRecord(value))
    failA1("INVALID_STRUCTURE_DELTA", "reconnected edge must be an object", location);
  assertNoUnknownFields(value, ["from", "to", "contract"], location);
  return {
    from: parseActionEndpoint(value.from, `${location}.from`),
    to: parseActionEndpoint(value.to, `${location}.to`),
    contract: requireString(value.contract, `${location}.contract`),
  };
}

function parseReconnections(value: unknown, location: string): StructureEdgeReconnection {
  if (!isRecord(value))
    failA1("INVALID_STRUCTURE_DELTA", "reconnections must be an object", location);
  assertNoUnknownFields(value, ["remove_edges", "add_edges"], location);
  if (!Array.isArray(value.remove_edges) || !Array.isArray(value.add_edges))
    failA1("INVALID_STRUCTURE_DELTA", "reconnections need remove_edges and add_edges", location);
  const removeEdges = value.remove_edges.map((edge, index) =>
    parseEdgeKey(edge, `${location}.remove_edges[${index}]`),
  );
  const addEdges = value.add_edges.map((edge, index) =>
    parseActionEdge(edge, `${location}.add_edges[${index}]`),
  );
  if (new Set(removeEdges).size !== removeEdges.length)
    failA1("DUPLICATE_ID", "reconnections remove_edges must be unique", location);
  return { remove_edges: removeEdges, add_edges: addEdges };
}

function parseStructureAction(value: unknown, location: string): StructureAction {
  if (!isRecord(value))
    failA1("INVALID_STRUCTURE_DELTA", "structure action must be an object", location);
  const operation = value.op;
  if (operation === "replace_module") {
    assertNoUnknownFields(value, ["op", "module_id", "replacement_module_id"], location);
    return {
      op: operation,
      module_id: assertIdentifier(value.module_id, `${location}.module_id`),
      replacement_module_id: assertIdentifier(
        value.replacement_module_id,
        `${location}.replacement_module_id`,
      ),
    };
  }
  if (operation === "insert_module") {
    assertNoUnknownFields(
      value,
      ["op", "edge", "module_id", "input_port", "output_port", "contract"],
      location,
    );
    const edge = requireString(value.edge, `${location}.edge`);
    const endpoints = edge.split("->");
    if (endpoints.length !== 2)
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "insert_module edge must contain one ->",
        `${location}.edge`,
      );
    return {
      op: operation,
      edge: `${parseActionEndpoint(endpoints[0], `${location}.edge.from`)}->${parseActionEndpoint(endpoints[1], `${location}.edge.to`)}`,
      module_id: assertIdentifier(value.module_id, `${location}.module_id`),
      input_port: assertIdentifier(value.input_port, `${location}.input_port`),
      output_port: assertIdentifier(value.output_port, `${location}.output_port`),
      contract: requireString(value.contract, `${location}.contract`),
    };
  }
  if (operation === "remove_module") {
    assertNoUnknownFields(value, ["op", "module_id", "reconnections"], location);
    return {
      op: operation,
      module_id: assertIdentifier(value.module_id, `${location}.module_id`),
      reconnections: parseReconnections(value.reconnections, `${location}.reconnections`),
    };
  }
  if (operation === "fan_out") {
    assertNoUnknownFields(
      value,
      ["op", "module_id", "source", "contract", "branches", "remove_edges"],
      location,
    );
    if (!Array.isArray(value.branches) || !Array.isArray(value.remove_edges))
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "fan_out needs branches and explicit remove_edges",
        location,
      );
    const branches = value.branches.map((branch, index) => {
      if (!isRecord(branch))
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "fan_out branch must be an object",
          `${location}.branches[${index}]`,
        );
      assertNoUnknownFields(branch, ["to", "contract"], `${location}.branches[${index}]`);
      return {
        to: parseActionEndpoint(branch.to, `${location}.branches[${index}].to`),
        contract: requireString(branch.contract, `${location}.branches[${index}].contract`),
      };
    });
    if (
      branches.length < 2 ||
      new Set(branches.map((branch) => branch.to)).size !== branches.length
    )
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "fan_out needs at least two unique branches",
        `${location}.branches`,
      );
    return {
      op: operation,
      module_id: assertIdentifier(value.module_id, `${location}.module_id`),
      source: parseActionEndpoint(value.source, `${location}.source`),
      contract: requireString(value.contract, `${location}.contract`),
      branches,
      remove_edges: value.remove_edges.map((edge, index) =>
        parseEdgeKey(edge, `${location}.remove_edges[${index}]`),
      ),
    };
  }
  if (operation === "fan_in") {
    assertNoUnknownFields(
      value,
      ["op", "module_id", "target", "contract", "sources", "remove_edges"],
      location,
    );
    if (!Array.isArray(value.sources) || !Array.isArray(value.remove_edges))
      failA1("INVALID_STRUCTURE_DELTA", "fan_in needs sources and explicit remove_edges", location);
    const sources = value.sources.map((source, index) => {
      if (!isRecord(source))
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "fan_in source must be an object",
          `${location}.sources[${index}]`,
        );
      assertNoUnknownFields(source, ["from", "contract"], `${location}.sources[${index}]`);
      return {
        from: parseActionEndpoint(source.from, `${location}.sources[${index}].from`),
        contract: requireString(source.contract, `${location}.sources[${index}].contract`),
      };
    });
    if (sources.length < 2 || new Set(sources.map((source) => source.from)).size !== sources.length)
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "fan_in needs at least two unique sources",
        `${location}.sources`,
      );
    return {
      op: operation,
      module_id: assertIdentifier(value.module_id, `${location}.module_id`),
      target: parseActionEndpoint(value.target, `${location}.target`),
      contract: requireString(value.contract, `${location}.contract`),
      sources,
      remove_edges: value.remove_edges.map((edge, index) =>
        parseEdgeKey(edge, `${location}.remove_edges[${index}]`),
      ),
    };
  }
  if (operation === "reorder") {
    assertNoUnknownFields(
      value,
      ["op", "module_id", "before_module_id", "reconnections"],
      location,
    );
    return {
      op: operation,
      module_id: assertIdentifier(value.module_id, `${location}.module_id`),
      before_module_id: assertIdentifier(value.before_module_id, `${location}.before_module_id`),
      reconnections: parseReconnections(value.reconnections, `${location}.reconnections`),
    };
  }
  failA1(
    "INVALID_STRUCTURE_DELTA",
    `unsupported structure action '${String(operation)}'`,
    location,
  );
}

export function parseStructureActions(value: unknown): StructureAction[] {
  if (!Array.isArray(value))
    failA1("INVALID_STRUCTURE_DELTA", "structure_actions must be an array", "structure_actions");
  if (value.length === 0)
    failA1(
      "INVALID_STRUCTURE_DELTA",
      "a structure proposal needs at least one action",
      "structure_actions",
    );
  return value.map((action, index) => parseStructureAction(action, `structure_actions[${index}]`));
}

export function validateStructureActions(
  spec: WorkflowSpec,
  actions: readonly StructureAction[] | unknown,
): void {
  const parsedActions = parseStructureActions(actions);
  applyStructureActions(spec, parsedActions);
}

function topologicalOrderNodes(
  nodes: readonly string[],
  edgePairs: readonly (readonly [string, string])[],
): string[] {
  const graph = new Map<string, Set<string>>();
  for (const node of nodes) graph.set(node, new Set());
  for (const [source, target] of edgePairs) {
    if (!graph.has(source) || !graph.has(target))
      failA1("INVALID_STRUCTURE_DELTA", "compiled edge references a removed module");
    graph.get(source)!.add(target);
  }
  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node, 0);
  for (const children of graph.values())
    for (const child of children) incoming.set(child, incoming.get(child)! + 1);
  const ready = [...nodes]
    .filter((moduleId) => incoming.get(moduleId) === 0)
    .sort(compareIdentityStrings);
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const child of [...(graph.get(current) ?? [])].sort(compareIdentityStrings)) {
      const next = incoming.get(child)! - 1;
      incoming.set(child, next);
      if (next === 0) ready.push(child);
    }
    ready.sort(compareIdentityStrings);
  }
  if (order.length !== nodes.length)
    failA1("WORKFLOW_CYCLE", "workflow cannot be compiled because the graph is cyclic");
  return order;
}

function topologicalOrder(spec: WorkflowSpec): string[] {
  return topologicalOrderNodes(
    getEnabledModuleIds(spec),
    spec.edges.map((edge) => [moduleFromEndpoint(edge.from), moduleFromEndpoint(edge.to)] as const),
  );
}

interface CompiledLogicalGraph {
  nodes: string[];
  edges: WorkflowEdge[];
  feedback_edges: WorkflowFeedbackEdge[];
}

function edgeKey(edge: Pick<WorkflowEdge, "from" | "to">): string {
  return `${edge.from}->${edge.to}`;
}

function modulePortsForEdge(
  modules: ReadonlyMap<string, WorkflowModule>,
  edge: WorkflowEdge,
  nodes: ReadonlySet<string>,
): void {
  const source = moduleFromEndpoint(edge.from);
  const target = moduleFromEndpoint(edge.to);
  if (!nodes.has(source) || !nodes.has(target))
    failA1("INVALID_STRUCTURE_DELTA", "structure edge references an unknown module");
  const sourceModule = modules.get(source)!;
  const targetModule = modules.get(target)!;
  const sourcePort = edge.from.split(".")[1]!;
  const targetPort = edge.to.split(".")[1]!;
  if (sourceModule.output_ports && !sourceModule.output_ports.includes(sourcePort))
    failA1("INVALID_STRUCTURE_DELTA", `source port '${sourcePort}' is not registered`);
  if (targetModule.input_ports && !targetModule.input_ports.includes(targetPort))
    failA1("INVALID_STRUCTURE_DELTA", `target port '${targetPort}' is not registered`);
  if (!sourceModule.outputs.includes(edge.contract) || !targetModule.inputs.includes(edge.contract))
    failA1("CONTRACT_MISMATCH", `edge '${edgeKey(edge)}' has an incompatible contract`);
}

function inputEndpoint(edge: Pick<WorkflowEdge, "to">): string {
  return edge.to;
}

function assertInputCardinality(
  edges: readonly WorkflowEdge[],
  modules: ReadonlyMap<string, WorkflowModule>,
  allowManyTargetEndpoints: ReadonlySet<string> = new Set(),
): void {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const endpoint = inputEndpoint(edge);
    counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
  }
  for (const [endpoint, count] of counts) {
    if (count < 2 || allowManyTargetEndpoints.has(endpoint)) continue;
    const module = modules.get(moduleFromEndpoint(endpoint));
    const port = endpoint.split(".")[1]!;
    if (module?.input_cardinality?.[port] !== "many")
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "input port '" + endpoint + "' does not accept multiple sources",
      );
  }
}

function validateFeedbackForGraph(
  feedback: WorkflowFeedbackEdge,
  modules: ReadonlyMap<string, WorkflowModule>,
  nodes: ReadonlySet<string>,
  location: string,
): void {
  const source = moduleFromEndpoint(feedback.from);
  const target = moduleFromEndpoint(feedback.to);
  const sourcePort = feedback.from.split(".")[1]!;
  const targetPort = feedback.to.split(".")[1]!;
  const externalSources = new Set(["evaluation", "tester", "workflow", "scorer"]);
  if (!nodes.has(target) || (!nodes.has(source) && !externalSources.has(source)))
    failA1("INVALID_STRUCTURE_DELTA", "feedback edge references an inactive module", location);
  if (source === target)
    failA1("INVALID_STRUCTURE_DELTA", "feedback edge endpoints must differ", location);
  const targetModule = modules.get(target)!;
  const sourceModule = nodes.has(source) ? modules.get(source)! : null;
  if (targetModule.input_ports && !targetModule.input_ports.includes(targetPort))
    failA1("INVALID_STRUCTURE_DELTA", "feedback target port is not registered", location);
  if (sourceModule && sourceModule.output_ports && !sourceModule.output_ports.includes(sourcePort))
    failA1("INVALID_STRUCTURE_DELTA", "feedback source port is not registered", location);
  if (feedback.contract !== undefined) {
    if (
      (sourceModule && !sourceModule.outputs.includes(feedback.contract)) ||
      !targetModule.inputs.includes(feedback.contract)
    )
      failA1(
        "CONTRACT_MISMATCH",
        "feedback edge contract is not declared by both modules",
        location,
      );
  } else if (sourceModule) {
    const sharedContracts = sourceModule.outputs.filter((contract) =>
      targetModule.inputs.includes(contract),
    );
    if (sharedContracts.length !== 1)
      failA1("CONTRACT_MISMATCH", "feedback edge contract is ambiguous", location);
  } else if (targetModule.inputs.length > 1) {
    failA1("CONTRACT_MISMATCH", "external feedback needs an explicit contract", location);
  }
}

function assertRequiredInputSources(
  requiredInputs: ReadonlySet<string>,
  edges: readonly WorkflowEdge[],
  nodes: ReadonlySet<string>,
): void {
  for (const endpoint of requiredInputs) {
    const target = moduleFromEndpoint(endpoint);
    if (nodes.has(target) && !edges.some((edge) => edge.to === endpoint))
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "active input '" + endpoint + "' has no current-round source",
      );
  }
}

function removeEdges(
  edges: WorkflowEdge[],
  keys: readonly string[],
  location: string,
): WorkflowEdge[] {
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length)
    failA1("DUPLICATE_ID", "reconnection edges must be unique", location);
  const remaining = [...edges];
  for (const key of keys) {
    const index = remaining.findIndex((edge) => edgeKey(edge) === key);
    if (index < 0)
      failA1(
        "INVALID_STRUCTURE_DELTA",
        `reconnection edge '${key}' is not in the current graph`,
        location,
      );
    remaining.splice(index, 1);
  }
  return remaining;
}

function addEdges(
  edges: WorkflowEdge[],
  additions: readonly WorkflowEdge[],
  modules: ReadonlyMap<string, WorkflowModule>,
  nodes: ReadonlySet<string>,
  location: string,
  allowManyTargetEndpoints: ReadonlySet<string> = new Set(),
): WorkflowEdge[] {
  const result = [...edges];
  const existing = new Set(result.map(edgeKey));
  for (const edge of additions) {
    modulePortsForEdge(modules, edge, nodes);
    if (existing.has(edgeKey(edge)))
      failA1("INVALID_STRUCTURE_DELTA", `edge '${edgeKey(edge)}' already exists`, location);
    existing.add(edgeKey(edge));
    result.push(edge);
  }
  assertInputCardinality(result, modules, allowManyTargetEndpoints);
  return result;
}

function assertActionModule(
  modules: ReadonlyMap<string, WorkflowModule>,
  nodes: ReadonlySet<string>,
  moduleId: string,
  location: string,
): WorkflowModule {
  const module = modules.get(moduleId);
  if (!module || !nodes.has(moduleId))
    failA1("INVALID_STRUCTURE_DELTA", `unknown active module '${moduleId}'`, location);
  return module;
}

function assertContract(
  value: string,
  module: WorkflowModule,
  direction: "input" | "output",
  location: string,
): void {
  const contracts = direction === "input" ? module.inputs : module.outputs;
  if (!contracts.includes(value))
    failA1(
      "CONTRACT_MISMATCH",
      `${direction} contract '${value}' is not declared by module '${module.id}'`,
      location,
    );
}

function applyReconnections(
  edges: WorkflowEdge[],
  reconnections: StructureEdgeReconnection,
  modules: ReadonlyMap<string, WorkflowModule>,
  nodes: ReadonlySet<string>,
  location: string,
): WorkflowEdge[] {
  const removed = new Set(reconnections.remove_edges);
  for (const edge of reconnections.add_edges)
    if (removed.has(edgeKey(edge)))
      failA1(
        "INVALID_STRUCTURE_DELTA",
        "a structure action cannot remove and re-add the same edge",
        location,
      );
  const withoutRemoved = removeEdges(edges, reconnections.remove_edges, `${location}.remove_edges`);
  return addEdges(withoutRemoved, reconnections.add_edges, modules, nodes, `${location}.add_edges`);
}

export function applyStructureActions(
  spec: WorkflowSpec,
  actions: readonly StructureAction[],
): CompiledLogicalGraph {
  const modules = moduleMap(spec);
  const nodes = new Set(getEnabledModuleIds(spec));
  let edges = spec.edges.map((edge) => ({ ...edge }));
  let feedbackEdges = spec.feedback_edges.map((edge) => ({ ...edge }));
  const originalNodes = new Set(nodes);
  const originalEdges = new Set(spec.edges.map((edge) => edgeKey(edge) + "|" + edge.contract));
  const originalFeedbackEdges = new Set(
    spec.feedback_edges.map(
      (edge) => edgeKey(edge) + "|" + edge.barrier + "|" + (edge.contract ?? ""),
    ),
  );
  const requiredInputs = new Set(spec.edges.map((edge) => edge.to));
  for (const action of actions) {
    if (action.op === "replace_module") {
      const original = assertActionModule(
        modules,
        nodes,
        action.module_id,
        "replace_module.module_id",
      );
      const replacement = modules.get(action.replacement_module_id);
      if (!replacement)
        failA1("INVALID_STRUCTURE_DELTA", "replace_module references an unknown module");
      if (
        action.module_id === action.replacement_module_id ||
        nodes.has(action.replacement_module_id)
      )
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "replacement module must be a registered inactive module",
        );
      if (
        [...original.inputs].sort(compareIdentityStrings).join("\n") !==
          [...replacement.inputs].sort(compareIdentityStrings).join("\n") ||
        [...original.outputs].sort(compareIdentityStrings).join("\n") !==
          [...replacement.outputs].sort(compareIdentityStrings).join("\n")
      ) {
        failA1(
          "CONTRACT_MISMATCH",
          "replacement module does not expose the original module contracts",
        );
      }
      for (const edge of edges) modulePortsForEdge(modules, edge, nodes);
      for (const endpoint of [...requiredInputs]) {
        if (endpoint.startsWith(action.module_id + ".")) {
          requiredInputs.delete(endpoint);
          requiredInputs.add(action.replacement_module_id + "." + endpoint.split(".")[1]);
        }
      }
      nodes.delete(action.module_id);
      nodes.add(action.replacement_module_id);
      edges = edges.map((edge) => ({
        ...edge,
        from: edge.from.startsWith(`${action.module_id}.`)
          ? `${action.replacement_module_id}.${edge.from.split(".")[1]}`
          : edge.from,
        to: edge.to.startsWith(`${action.module_id}.`)
          ? `${action.replacement_module_id}.${edge.to.split(".")[1]}`
          : edge.to,
      }));
      feedbackEdges = feedbackEdges.map((edge) => ({
        ...edge,
        from: edge.from.startsWith(`${action.module_id}.`)
          ? `${action.replacement_module_id}.${edge.from.split(".")[1]}`
          : edge.from,
        to: edge.to.startsWith(`${action.module_id}.`)
          ? `${action.replacement_module_id}.${edge.to.split(".")[1]}`
          : edge.to,
      }));
      for (const edge of edges) modulePortsForEdge(modules, edge, nodes);
    } else if (action.op === "insert_module") {
      const edgeIndex = edges.findIndex((edge) => edgeKey(edge) === action.edge);
      if (edgeIndex < 0)
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "insert_module edge is not present in the compiled graph",
        );
      const current = edges[edgeIndex]!;
      const inserted = modules.get(action.module_id);
      if (!inserted || nodes.has(action.module_id))
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "insert_module must reference a registered inactive module",
        );
      if (current.contract !== action.contract)
        failA1("CONTRACT_MISMATCH", "insert_module contract does not match the selected edge");
      assertContract(current.contract, inserted, "input", "insert_module.contract");
      assertContract(current.contract, inserted, "output", "insert_module.contract");
      if (inserted.input_ports && !inserted.input_ports.includes(action.input_port))
        failA1("INVALID_STRUCTURE_DELTA", "insert_module input port is not registered");
      if (inserted.output_ports && !inserted.output_ports.includes(action.output_port))
        failA1("INVALID_STRUCTURE_DELTA", "insert_module output port is not registered");
      const inputEdge: WorkflowEdge = {
        from: current.from,
        to: `${action.module_id}.${action.input_port}`,
        contract: current.contract,
      };
      const outputEdge: WorkflowEdge = {
        from: `${action.module_id}.${action.output_port}`,
        to: current.to,
        contract: current.contract,
      };
      nodes.add(action.module_id);
      edges.splice(edgeIndex, 1);
      edges = addEdges(edges, [inputEdge, outputEdge], modules, nodes, "insert_module");
    } else if (action.op === "remove_module") {
      const module = assertActionModule(
        modules,
        nodes,
        action.module_id,
        "remove_module.module_id",
      );
      if (!module.evolvable)
        failA1("INVALID_STRUCTURE_DELTA", "only optional/evolvable modules can be removed");
      const incidentEdges = edges.filter(
        (edge) =>
          moduleFromEndpoint(edge.from) === action.module_id ||
          moduleFromEndpoint(edge.to) === action.module_id,
      );
      if (
        feedbackEdges.some(
          (edge) =>
            moduleFromEndpoint(edge.from) === action.module_id ||
            moduleFromEndpoint(edge.to) === action.module_id,
        )
      )
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "remove_module must explicitly handle every incident feedback edge",
        );
      const incidentKeys = incidentEdges.map(edgeKey).sort(compareIdentityStrings);
      const declaredRemoved = [...action.reconnections.remove_edges].sort(compareIdentityStrings);
      if (
        incidentKeys.length !== declaredRemoved.length ||
        incidentKeys.some((key, index) => key !== declaredRemoved[index])
      ) {
        failA1(
          "INVALID_STRUCTURE_DELTA",
          "remove_module must explicitly remove every incident edge and no other edge",
          "remove_module.reconnections.remove_edges",
        );
      }
      edges = removeEdges(edges, action.reconnections.remove_edges, "remove_module.reconnections");
      for (const endpoint of [...requiredInputs])
        if (endpoint.startsWith(action.module_id + ".")) requiredInputs.delete(endpoint);
      nodes.delete(action.module_id);
      edges = addEdges(
        edges,
        action.reconnections.add_edges,
        modules,
        nodes,
        "remove_module.reconnections.add_edges",
      );
    } else if (action.op === "fan_out") {
      const sourceModule = assertActionModule(
        modules,
        nodes,
        action.module_id,
        "fan_out.module_id",
      );
      if (moduleFromEndpoint(action.source) !== action.module_id)
        failA1("INVALID_STRUCTURE_DELTA", "fan_out source must belong to module_id");
      assertContract(action.contract, sourceModule, "output", "fan_out.contract");
      for (const branch of action.branches) {
        const targetModule = modules.get(moduleFromEndpoint(branch.to));
        if (!targetModule || !nodes.has(targetModule.id))
          failA1("INVALID_STRUCTURE_DELTA", "fan_out branch references an unknown module");
        if (branch.contract !== action.contract)
          failA1("CONTRACT_MISMATCH", "fan_out branches must use the declared contract");
        assertContract(branch.contract, targetModule, "input", "fan_out.branch.contract");
      }
      for (const removedKey of action.remove_edges) {
        const removed = edges.find((edge) => edgeKey(edge) === removedKey);
        if (!removed || removed.from !== action.source || removed.contract !== action.contract)
          failA1(
            "INVALID_STRUCTURE_DELTA",
            "fan_out can remove only edges from its declared source and contract",
            "fan_out.remove_edges",
          );
      }
      edges = removeEdges(edges, action.remove_edges, "fan_out.remove_edges");
      edges = addEdges(
        edges,
        action.branches.map((branch) => ({
          from: action.source,
          to: branch.to,
          contract: branch.contract,
        })),
        modules,
        nodes,
        "fan_out.branches",
      );
    } else if (action.op === "fan_in") {
      const targetModule = assertActionModule(modules, nodes, action.module_id, "fan_in.module_id");
      if (moduleFromEndpoint(action.target) !== action.module_id)
        failA1("INVALID_STRUCTURE_DELTA", "fan_in target must belong to module_id");
      assertContract(action.contract, targetModule, "input", "fan_in.contract");
      for (const source of action.sources) {
        const sourceModule = modules.get(moduleFromEndpoint(source.from));
        if (!sourceModule || !nodes.has(sourceModule.id))
          failA1("INVALID_STRUCTURE_DELTA", "fan_in source references an unknown module");
        if (source.contract !== action.contract)
          failA1("CONTRACT_MISMATCH", "fan_in sources must use the declared contract");
        assertContract(source.contract, sourceModule, "output", "fan_in.source.contract");
      }
      for (const removedKey of action.remove_edges) {
        const removed = edges.find((edge) => edgeKey(edge) === removedKey);
        if (!removed || removed.to !== action.target || removed.contract !== action.contract)
          failA1(
            "INVALID_STRUCTURE_DELTA",
            "fan_in can remove only edges to its declared target and contract",
            "fan_in.remove_edges",
          );
      }
      edges = removeEdges(edges, action.remove_edges, "fan_in.remove_edges");
      edges = addEdges(
        edges,
        action.sources.map((source) => ({
          from: source.from,
          to: action.target,
          contract: source.contract,
        })),
        modules,
        nodes,
        "fan_in.sources",
      );
    } else if (action.op === "reorder") {
      assertActionModule(modules, nodes, action.module_id, "reorder.module_id");
      assertActionModule(modules, nodes, action.before_module_id, "reorder.before_module_id");
      const before = new Set(edges.map((edge) => `${edge.from}|${edge.to}|${edge.contract}`));
      edges = applyReconnections(
        edges,
        action.reconnections,
        modules,
        nodes,
        "reorder.reconnections",
      );
      const after = new Set(edges.map((edge) => `${edge.from}|${edge.to}|${edge.contract}`));
      if (before.size === after.size && [...before].every((edge) => after.has(edge)))
        failA1("INVALID_STRUCTURE_DELTA", "reorder must change the execution graph");
      const order = topologicalOrderNodes(
        [...nodes],
        edges.map((edge) => [moduleFromEndpoint(edge.from), moduleFromEndpoint(edge.to)] as const),
      );
      if (order.indexOf(action.module_id) >= order.indexOf(action.before_module_id))
        failA1("INVALID_STRUCTURE_DELTA", "reorder did not place the module before its target");
    }
  }
  const uniqueEdges = new Map<string, WorkflowEdge>();
  for (const edge of edges) {
    if (moduleFromEndpoint(edge.from) === moduleFromEndpoint(edge.to))
      failA1("WORKFLOW_CYCLE", "structure actions create a self-edge");
    modulePortsForEdge(modules, edge, nodes);
    if (uniqueEdges.has(edgeKey(edge)))
      failA1("INVALID_STRUCTURE_DELTA", `duplicate edge '${edgeKey(edge)}'`);
    uniqueEdges.set(edgeKey(edge), edge);
  }
  const normalizedEdges = [...uniqueEdges.values()].sort((left, right) =>
    compareIdentityStrings(edgeKey(left), edgeKey(right)),
  );
  assertInputCardinality(normalizedEdges, modules);
  assertRequiredInputSources(requiredInputs, normalizedEdges, nodes);
  topologicalOrderNodes(
    [...nodes].sort(compareIdentityStrings),
    normalizedEdges.map(
      (edge) => [moduleFromEndpoint(edge.from), moduleFromEndpoint(edge.to)] as const,
    ),
  );
  const externalFeedbackSources = new Set(["evaluation", "tester", "workflow", "scorer"]);
  const uniqueFeedbackEdges = new Map<string, WorkflowFeedbackEdge>();
  for (const feedback of feedbackEdges) {
    const source = moduleFromEndpoint(feedback.from);
    const target = moduleFromEndpoint(feedback.to);
    if (!nodes.has(target) || (!nodes.has(source) && !externalFeedbackSources.has(source)))
      failA1("INVALID_STRUCTURE_DELTA", "structure actions leave a dangling feedback edge");
    if (source === target)
      failA1("INVALID_STRUCTURE_DELTA", "structure actions create a feedback self-edge");
    const key = edgeKey(feedback);
    if (uniqueEdges.has(key))
      failA1("INVALID_STRUCTURE_DELTA", "ordinary and feedback edges cannot share endpoints");
    validateFeedbackForGraph(feedback, modules, nodes, "feedback_edges");
    if (uniqueFeedbackEdges.has(key))
      failA1("INVALID_STRUCTURE_DELTA", `duplicate feedback edge '${key}'`);
    uniqueFeedbackEdges.set(key, feedback);
  }
  const normalizedFeedbackEdges = [...uniqueFeedbackEdges.values()].sort((left, right) =>
    compareIdentityStrings(edgeKey(left), edgeKey(right)),
  );
  if (actions.length > 0) {
    const finalNodes = new Set(nodes);
    const finalEdges = new Set(normalizedEdges.map((edge) => edgeKey(edge) + "|" + edge.contract));
    const finalFeedbackEdges = new Set(
      normalizedFeedbackEdges.map(
        (edge) => edgeKey(edge) + "|" + edge.barrier + "|" + (edge.contract ?? ""),
      ),
    );
    if (
      finalNodes.size === originalNodes.size &&
      [...finalNodes].every((node) => originalNodes.has(node)) &&
      finalEdges.size === originalEdges.size &&
      [...finalEdges].every((edge) => originalEdges.has(edge)) &&
      finalFeedbackEdges.size === originalFeedbackEdges.size &&
      [...finalFeedbackEdges].every((edge) => originalFeedbackEdges.has(edge))
    )
      failA1("INVALID_STRUCTURE_DELTA", "structure actions must change the final execution graph");
  }
  return {
    nodes: [...nodes].sort(compareIdentityStrings),
    edges: normalizedEdges,
    feedback_edges: normalizedFeedbackEdges,
  };
}

function executionGraphFromLogicalGraph(
  spec: WorkflowSpec,
  graph: CompiledLogicalGraph,
): CandidateExecutionGraph {
  const modules = moduleMap(spec);
  const nodes = graph.nodes.map((moduleId) => {
    const module = modules.get(moduleId);
    if (!module) failA1("INVALID_STRUCTURE_DELTA", `compiled graph lost module '${moduleId}'`);
    return {
      module_id: module.id,
      version: module.version ?? "catalog",
      input_ports: [...(module.input_ports ?? [])].sort(compareIdentityStrings),
      output_ports: [...(module.output_ports ?? [])].sort(compareIdentityStrings),
    };
  });
  return {
    nodes,
    edges: [...graph.edges],
    feedback_edges: [...graph.feedback_edges],
  };
}

function normalizedExecutionGraph(graph: CandidateExecutionGraph): CandidateExecutionGraph {
  return {
    nodes: [...graph.nodes]
      .sort((left, right) => compareIdentityStrings(left.module_id, right.module_id))
      .map((node) => ({
        module_id: node.module_id,
        version: node.version,
        input_ports: [...node.input_ports].sort(compareIdentityStrings),
        output_ports: [...node.output_ports].sort(compareIdentityStrings),
      })),
    edges: [...graph.edges]
      .sort((left, right) => {
        const leftKey = `${edgeKey(left)}|${left.contract}`;
        const rightKey = `${edgeKey(right)}|${right.contract}`;
        return compareIdentityStrings(leftKey, rightKey);
      })
      .map((edge) => ({ ...edge })),
    feedback_edges: [...graph.feedback_edges]
      .sort((left, right) => {
        const leftKey = `${edgeKey(left)}|${left.barrier}`;
        const rightKey = `${edgeKey(right)}|${right.barrier}`;
        return compareIdentityStrings(leftKey, rightKey);
      })
      .map((edge) => ({ ...edge })),
  };
}

function assertCandidateAssignmentsMatchSpec(
  candidate: CandidateSnapshot,
  spec: WorkflowSpec,
  activeModuleIds: readonly string[],
): void {
  const roles = new Map(spec.model_usage_policy.roles.map((role) => [role.role_id, role]));
  const activeIds = new Set(activeModuleIds);
  const assignments = new Map(
    candidate.model_assignments.map((assignment) => [assignment.role_id, assignment]),
  );
  for (const assignment of candidate.model_assignments) {
    const role = roles.get(assignment.role_id);
    if (!role)
      failA1(
        "CANDIDATE_SPEC_MISMATCH",
        `candidate assignment names unknown model role '${assignment.role_id}'`,
      );
    const assertSubset = (values: readonly string[], allowed: readonly string[], field: string) => {
      const allowedSet = new Set(allowed);
      for (const value of values)
        if (!allowedSet.has(value))
          failA1(
            "CANDIDATE_SPEC_MISMATCH",
            `candidate assignment '${assignment.role_id}' expands ${field} with '${value}'`,
          );
    };
    assertSubset(assignment.module_ids, role.allowed_modules, "module_ids");
    assertSubset(assignment.uses, role.allowed_uses, "uses");
    assertSubset(assignment.judge_targets, role.judge_targets, "judge_targets");
    const productionUses = assignment.uses.filter((use) => use !== "judge");
    if (productionUses.length > 0) {
      if (assignment.module_ids.some((moduleId) => !activeIds.has(moduleId)))
        failA1(
          "CANDIDATE_SPEC_MISMATCH",
          "candidate assignment '" +
            assignment.role_id +
            "' names a module outside the final graph",
        );
      if (!assignment.module_ids.some((moduleId) => activeIds.has(moduleId)))
        failA1(
          "CANDIDATE_SPEC_MISMATCH",
          "candidate assignment '" + assignment.role_id + "' does not bind an active module",
        );
    }
    if (assignment.resolved_from !== role.artifact_binding.source)
      failA1(
        "CANDIDATE_SPEC_MISMATCH",
        `candidate assignment '${assignment.role_id}' uses a different Artifact source`,
      );
  }
  for (const role of spec.model_usage_policy.roles) {
    const activeAllowedModules = role.allowed_modules.filter((moduleId) => activeIds.has(moduleId));
    const requiresProductionAssignment =
      activeAllowedModules.length > 0 && role.allowed_uses.some((use) => use !== "judge");
    if (!requiresProductionAssignment) continue;
    const assignment = assignments.get(role.role_id);
    if (!assignment)
      failA1(
        "CANDIDATE_SPEC_MISMATCH",
        "candidate is missing the active model role '" + role.role_id + "'",
      );
    const productionUses = assignment.uses.filter((use) => use !== "judge");
    if (productionUses.length === 0)
      failA1(
        "CANDIDATE_SPEC_MISMATCH",
        "candidate role '" + role.role_id + "' has no production model use",
      );
    if (!activeAllowedModules.every((moduleId) => assignment.module_ids.includes(moduleId)))
      failA1(
        "CANDIDATE_SPEC_MISMATCH",
        "candidate role '" +
          role.role_id +
          "' does not cover every active module in its policy scope",
      );
  }
}

function assertCandidateMatchesCompilation(
  candidate: CandidateSnapshot,
  spec: WorkflowSpec,
  graph: CompiledLogicalGraph,
  executionGraph: CandidateExecutionGraph,
  cycles: number,
): void {
  if (candidate.workflow_revision !== spec.revision)
    failA1(
      "CANDIDATE_SPEC_MISMATCH",
      "candidate workflow revision differs from the inspected workflow spec",
    );
  if (candidate.finite_cycles !== cycles)
    failA1("CANDIDATE_SPEC_MISMATCH", "candidate finite cycles differ from the compiled graph");
  assertCandidateAssignmentsMatchSpec(candidate, spec, graph.nodes);
  if (
    canonicalJsonSha256(candidate.owner_limits, anyJsonSchema, {
      schemaVersion: "owner-limits-v1",
    }) !==
    canonicalJsonSha256(spec.owner_limits, anyJsonSchema, { schemaVersion: "owner-limits-v1" })
  )
    failA1("CANDIDATE_SPEC_MISMATCH", "candidate owner limits differ from the inspected spec");
  const expected = normalizedExecutionGraph(executionGraph);
  const actual = normalizedExecutionGraph(candidate.execution_graph);
  if (
    canonicalJsonSha256(actual, anyJsonSchema, { schemaVersion: "execution-graph-v1" }) !==
    canonicalJsonSha256(expected, anyJsonSchema, { schemaVersion: "execution-graph-v1" })
  )
    failA1(
      "CANDIDATE_GRAPH_MISMATCH",
      "candidate final execution graph differs from the graph being compiled",
    );
  const moduleById = moduleMap(spec);
  for (const node of candidate.execution_graph.nodes) {
    const module = moduleById.get(node.module_id);
    if (!module)
      failA1("CANDIDATE_GRAPH_MISMATCH", `candidate names unknown module '${node.module_id}'`);
    const expectedVersion = module.version ?? "catalog";
    if (node.version !== expectedVersion)
      failA1(
        "CANDIDATE_GRAPH_MISMATCH",
        `candidate module '${node.module_id}' uses a different version than the spec`,
      );
    const moduleVersion = candidate.module_versions.find(
      (candidateModule) => candidateModule.module_id === node.module_id,
    );
    if (!moduleVersion)
      failA1(
        "CANDIDATE_GRAPH_MISMATCH",
        `candidate module '${node.module_id}' has no matching module version record`,
      );
    if (
      moduleVersion.version !== expectedVersion ||
      (module.patch_sha256 !== undefined && moduleVersion.patch_sha256 !== module.patch_sha256)
    )
      failA1(
        "CANDIDATE_GRAPH_MISMATCH",
        `candidate module '${node.module_id}' uses a different patch than the spec`,
      );
  }
  if (graph.nodes.length !== candidate.module_versions.length)
    failA1("CANDIDATE_GRAPH_MISMATCH", "candidate module versions do not cover the final graph");
}

function structureDeltaId(actions: readonly StructureAction[]): string {
  const digest = canonicalJsonSha256(actions, anyJsonSchema, {
    schemaVersion: "structure-delta-v1",
  });
  return `structure-delta:sha256:${digest}`;
}

export function compileWorkflow(
  spec: WorkflowSpec,
  options: CompileOptions = {},
): CompiledWorkflow {
  const validatedSpec = validateWorkflowSpec(spec);
  const waveKind = options.wave_kind ?? "module";
  if (waveKind !== "module" && waveKind !== "structure" && waveKind !== "scorer")
    failA1("INVALID_WAVE_POLICY", "wave_kind must be module, structure, or scorer");
  const rawActions = options.structure_actions ?? [];
  if (validatedSpec.mode === "standalone" && (waveKind === "structure" || rawActions.length > 0))
    failA1(
      "INVALID_STRUCTURE_DELTA",
      "standalone workflows cannot be extended with structure actions",
    );
  if (waveKind !== "structure" && (!Array.isArray(rawActions) || rawActions.length > 0))
    failA1("INVALID_STRUCTURE_DELTA", "module/scorer waves cannot carry structure actions");
  const actions = waveKind === "structure" ? parseStructureActions(rawActions) : [];
  if (waveKind === "structure") validateStructureActions(validatedSpec, actions);
  const cycles =
    options.unrolled_cycles ??
    validatedSpec.cycles.reduce((total, cycle) => total + cycle.iterations, 0);
  if (!Number.isInteger(cycles) || cycles < 0)
    failA1("INVALID_VALUE", "unrolled_cycles must be a non-negative integer");
  if (cycles > validatedSpec.owner_limits.max_unrolled_cycles)
    failA1("rejected_limit", "unrolled cycles exceed owner_limits.max_unrolled_cycles");
  const validationRepeats = options.validation_repeats ?? 1;
  const infrastructureAttempts = options.infrastructure_attempts ?? 1;
  if (
    !Number.isInteger(validationRepeats) ||
    validationRepeats < 1 ||
    !Number.isInteger(infrastructureAttempts) ||
    infrastructureAttempts < 1
  )
    failA1(
      "INVALID_VALUE",
      "validation repeats and infrastructure attempts must be positive integers",
    );
  const logicalGraph =
    waveKind === "structure"
      ? applyStructureActions(validatedSpec, actions)
      : {
          nodes: getEnabledModuleIds(validatedSpec),
          edges: validatedSpec.edges.map((edge) => ({ ...edge })),
          feedback_edges: validatedSpec.feedback_edges.map((edge) => ({ ...edge })),
        };
  const logicalNodes = logicalGraph.nodes;
  const nodeCount = new Set(logicalNodes).size;
  const edgeCount = logicalGraph.edges.length + logicalGraph.feedback_edges.length;
  if (nodeCount > validatedSpec.owner_limits.max_nodes)
    failA1("rejected_limit", "candidate node count exceeds owner limit");
  if (edgeCount > validatedSpec.owner_limits.max_edges)
    failA1("rejected_limit", "candidate edge count exceeds owner limit");
  const outgoing = new Map<string, number>();
  for (const node of logicalNodes) outgoing.set(node, 0);
  for (const edge of logicalGraph.edges) {
    const source = moduleFromEndpoint(edge.from);
    outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
  }
  for (const edge of logicalGraph.feedback_edges) {
    const source = moduleFromEndpoint(edge.from);
    if (outgoing.has(source)) outgoing.set(source, outgoing.get(source)! + 1);
  }
  const maxFanOut = Math.max(0, ...outgoing.values());
  if (maxFanOut > validatedSpec.owner_limits.max_fan_out_per_node)
    failA1("rejected_limit", "candidate fan-out exceeds owner limit");
  const factor = (cycles + 1) * validationRepeats * infrastructureAttempts;
  const moduleById = moduleMap(validatedSpec);
  let worstCaseJobs = 0;
  let computeAmount = 0;
  let computeUnit: string | null = null;
  for (const moduleId of logicalNodes) {
    const module = moduleById.get(moduleId);
    if (!module) continue;
    worstCaseJobs += module.execution.max_jobs * factor;
    computeUnit ??= module.execution.max_compute.unit;
    if (computeUnit !== module.execution.max_compute.unit)
      failA1("COMPUTE_UNIT_MISMATCH", "all module compute bounds must use one unit");
    computeAmount += module.execution.max_compute.amount * factor;
  }
  if (worstCaseJobs > validatedSpec.owner_limits.max_jobs_per_candidate)
    failA1("rejected_limit", "worst-case jobs exceed owner limit");
  if (computeUnit === null) computeUnit = validatedSpec.owner_limits.max_compute_per_candidate.unit;
  if (computeUnit !== validatedSpec.owner_limits.max_compute_per_candidate.unit)
    failA1("COMPUTE_UNIT_MISMATCH", "module and owner compute units differ");
  if (computeAmount > validatedSpec.owner_limits.max_compute_per_candidate.amount)
    failA1("rejected_limit", "worst-case compute exceeds owner limit");
  const executionOrder = topologicalOrderNodes(
    logicalNodes,
    logicalGraph.edges.map(
      (edge) => [moduleFromEndpoint(edge.from), moduleFromEndpoint(edge.to)] as const,
    ),
  );
  const expandedExecutionOrder: string[] = [];
  for (let iteration = 0; iteration <= cycles; iteration += 1)
    for (const moduleId of executionOrder) expandedExecutionOrder.push(`${moduleId}[${iteration}]`);
  const executionGraph = executionGraphFromLogicalGraph(validatedSpec, logicalGraph);
  const candidateSnapshot = options.candidate ? validateCandidateSnapshot(options.candidate) : null;
  let candidateId: string | null = null;
  if (candidateSnapshot) {
    assertCandidateMatchesCompilation(
      candidateSnapshot,
      validatedSpec,
      logicalGraph,
      executionGraph,
      cycles,
    );
    candidateId = candidateIdFromSnapshot(candidateSnapshot, options.workspace_root);
  }
  const ownerLimitsSha256 = canonicalJsonSha256(validatedSpec.owner_limits, anyJsonSchema, {
    schemaVersion: "owner-limits-v1",
  });
  return {
    schema_version: 1,
    workflow_id: validatedSpec.workflow_id,
    workflow_revision: validatedSpec.revision,
    wave_kind: waveKind,
    structure_delta_id: waveKind === "structure" ? structureDeltaId(actions) : null,
    summary: {
      node_count: nodeCount,
      edge_count: edgeCount,
      max_fan_out: maxFanOut,
      unrolled_cycles: cycles,
      worst_case_jobs: worstCaseJobs,
      worst_case_compute: { amount: computeAmount, unit: computeUnit },
    },
    execution_order: executionOrder,
    expanded_execution_order: expandedExecutionOrder,
    candidate_id: candidateId,
    execution_graph: executionGraph,
    owner_limits_sha256: ownerLimitsSha256,
  };
}

export function assertCandidateWithinFrozenLimits(
  original: OwnerLimits,
  candidateLimits: OwnerLimits,
): void {
  assertLimitsUnchanged(original, candidateLimits);
}

export function pathForCompiledCandidate(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
  candidateId: unknown,
  snapshot: unknown,
): string {
  const safeCandidate = assertIdentifier(candidateId, "candidate_id");
  const derivedCandidate = candidateIdFromSnapshot(snapshot, projectRoot);
  if (safeCandidate !== derivedCandidate)
    failA1(
      "CANDIDATE_IDENTITY_MISMATCH",
      "candidate_id does not match the supplied candidate snapshot",
      "candidate_id",
    );
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "compiled",
    safeCandidate,
  );
}
