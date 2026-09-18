import { assertIdentifier, failA1, requireString, type JsonObject } from "./workflow-spec.js";
import type {
  StructureAction,
  StructureActionFanIn,
  StructureActionFanOut,
} from "./workflow-compiler.js";

export interface StructureBranchInput {
  module_id: string;
  input_port: string;
  contract?: string;
}

export interface StructureSourceInput {
  module_id: string;
  output_port: string;
  contract?: string;
}

export interface BuildFanOutInput {
  module_id: string;
  output_port: string;
  contract: string;
  branches: readonly StructureBranchInput[];
  remove_edges: readonly string[];
}

export interface BuildFanInInput {
  module_id: string;
  input_port: string;
  contract: string;
  sources: readonly StructureSourceInput[];
  remove_edges: readonly string[];
}

export interface BuildMultiTeacherMoPDInput {
  teacher_source: {
    module_id: string;
    output_port: string;
    contract: string;
  };
  teachers: ReadonlyArray<{
    module_id: string;
    input_port: string;
    output_port: string;
    contract?: string;
  }>;
  mopd: {
    module_id: string;
    input_port: string;
  };
  fan_out_remove_edges: readonly string[];
  fan_in_remove_edges: readonly string[];
}

function endpoint(moduleId: string, port: string, location: string): string {
  return `${assertIdentifier(moduleId, `${location}.module_id`)}.${assertIdentifier(port, `${location}.port`)}`;
}

function edgeList(value: readonly string[], location: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    failA1("INVALID_STRUCTURE_DELTA", `${location} must contain at least one edge`);
  return value.map((edge, index) => requireString(edge, `${location}[${index}]`));
}

function sortedUnique<T extends JsonObject>(
  values: readonly T[],
  key: (value: T) => string,
  location: string,
): T[] {
  const result = [...values].map((value) => ({ ...value }));
  const keys = result.map(key);
  if (result.length < 2 || new Set(keys).size !== keys.length)
    failA1("INVALID_STRUCTURE_DELTA", `${location} must contain at least two unique entries`);
  return result.sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Build the compiler's explicit fan-out action from a small readable input. */
export function buildFanOutAction(input: BuildFanOutInput): StructureActionFanOut {
  const moduleId = assertIdentifier(input.module_id, "fan_out.module_id");
  const outputPort = assertIdentifier(input.output_port, "fan_out.output_port");
  const contract = requireString(input.contract, "fan_out.contract");
  const branches = sortedUnique(
    input.branches.map((branch) => ({
      to: endpoint(branch.module_id, branch.input_port, "fan_out.branch"),
      contract:
        branch.contract === undefined
          ? contract
          : requireString(branch.contract, "fan_out.branch.contract"),
    })),
    (branch) => branch.to,
    "fan_out.branches",
  );
  return {
    op: "fan_out",
    module_id: moduleId,
    source: `${moduleId}.${outputPort}`,
    contract,
    branches,
    remove_edges: edgeList(input.remove_edges, "fan_out.remove_edges"),
  };
}

/** Build the compiler's explicit fan-in action from a small readable input. */
export function buildFanInAction(input: BuildFanInInput): StructureActionFanIn {
  const moduleId = assertIdentifier(input.module_id, "fan_in.module_id");
  const inputPort = assertIdentifier(input.input_port, "fan_in.input_port");
  const contract = requireString(input.contract, "fan_in.contract");
  const sources = sortedUnique(
    input.sources.map((source) => ({
      from: endpoint(source.module_id, source.output_port, "fan_in.source"),
      contract:
        source.contract === undefined
          ? contract
          : requireString(source.contract, "fan_in.source.contract"),
    })),
    (source) => source.from,
    "fan_in.sources",
  );
  return {
    op: "fan_in",
    module_id: moduleId,
    target: `${moduleId}.${inputPort}`,
    contract,
    sources,
    remove_edges: edgeList(input.remove_edges, "fan_in.remove_edges"),
  };
}

/**
 * Construct the two graph actions used by the common multi-teacher/MoPD
 * pattern. The teacher and MoPD modules must already be registered and active
 * in the candidate; the compiler remains responsible for checking their ports
 * and contracts. Existing edges are named explicitly so a proposal cannot
 * silently disconnect an old path.
 */
export function buildMultiTeacherMoPDDelta(input: BuildMultiTeacherMoPDInput): StructureAction[] {
  const source = {
    module_id: assertIdentifier(input.teacher_source.module_id, "teacher_source.module_id"),
    output_port: assertIdentifier(input.teacher_source.output_port, "teacher_source.output_port"),
    contract: requireString(input.teacher_source.contract, "teacher_source.contract"),
  };
  const mopd = {
    module_id: assertIdentifier(input.mopd.module_id, "mopd.module_id"),
    input_port: assertIdentifier(input.mopd.input_port, "mopd.input_port"),
  };
  if (source.module_id === mopd.module_id)
    failA1("INVALID_STRUCTURE_DELTA", "teacher source and MoPD aggregator must differ");
  const teachers = [...input.teachers];
  const teacherIds = teachers.map((teacher) =>
    assertIdentifier(teacher.module_id, "teacher.module_id"),
  );
  if (teacherIds.includes(source.module_id) || teacherIds.includes(mopd.module_id))
    failA1("INVALID_STRUCTURE_DELTA", "teacher branches must be distinct from source and MoPD");
  const fanOut = buildFanOutAction({
    module_id: source.module_id,
    output_port: source.output_port,
    contract: source.contract,
    branches: teachers.map((teacher) => ({
      module_id: teacher.module_id,
      input_port: teacher.input_port,
      contract: teacher.contract,
    })),
    remove_edges: input.fan_out_remove_edges,
  });
  const fanIn = buildFanInAction({
    module_id: mopd.module_id,
    input_port: mopd.input_port,
    contract: source.contract,
    sources: teachers.map((teacher) => ({
      module_id: teacher.module_id,
      output_port: teacher.output_port,
      contract: teacher.contract,
    })),
    remove_edges: input.fan_in_remove_edges,
  });
  return [fanOut, fanIn];
}
