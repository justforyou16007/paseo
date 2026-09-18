import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { type ArtifactRegistry, type ArtifactRegistryEntry } from "./artifact-registry.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireInteger,
  requireString,
  validateModelUsagePolicy,
  type ModelRolePolicy,
  type ModelUsagePolicy,
} from "./workflow-spec.js";
import { workflowCycleDirectory } from "./workflow-state.js";

export interface IncumbentArtifact {
  artifact_id: string;
  generation: number;
  role_id: string;
}

export interface IncumbentSnapshot {
  candidate_id: string;
  generation: number;
  role_artifacts: IncumbentArtifact[];
}

export interface CandidateArtifactContext {
  candidate_id?: string;
  producer_run_id?: string;
  candidate_artifact_ids: string[];
  candidate_output_artifact_ids: string[];
  target_generations: Record<string, number>;
  candidate_generation?: number;
}

export interface ModelRoleRequest {
  role_id: string;
  allowed_modules?: readonly string[];
  allowed_uses?: readonly ModelRolePolicy["allowed_uses"][number][];
  judge_targets?: readonly string[];
}

export interface ModelAssignment {
  schema_version: 1;
  task_setup_revision: string;
  outer_run_id: string;
  outer_iteration: number;
  assignments: ModelAssignmentEntry[];
  policy_sha256: string;
  assignment_sha256: string;
}

export interface ModelAssignmentEntry {
  role_id: string;
  module_ids: string[];
  uses: ModelRolePolicy["allowed_uses"];
  judge_targets: string[];
  artifact_id: string;
  resolved_from: "previous_promoted" | "fixed_external";
  resolved_generation: number | null;
  source_incumbent_id: string | null;
}

export interface ResolveAssignmentInput {
  policy: ModelUsagePolicy;
  task_setup_revision: string;
  outer_run_id: string;
  outer_iteration: number;
  incumbent: IncumbentSnapshot;
  candidate?: CandidateArtifactContext;
  registry?: ArtifactRegistry;
  requested_artifact_ids?: Readonly<Record<string, string>>;
  requested_roles?: readonly ModelRoleRequest[];
  requested_role_ids?: readonly string[];
}

function incumbentRole(incumbent: IncumbentSnapshot, role: ModelRolePolicy): IncumbentArtifact {
  const sourceRole = role.artifact_binding.source_role ?? role.role_id;
  const artifact = incumbent.role_artifacts.find((candidate) => candidate.role_id === sourceRole);
  if (!artifact)
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      `no incumbent artifact is available for role '${sourceRole}'`,
    );
  return artifact;
}

function assertIncumbentArtifactProvenance(
  registered: ArtifactRegistryEntry,
  artifact: IncumbentArtifact,
  incumbent: IncumbentSnapshot,
  sourceRole: string,
  location: string,
): void {
  if (registered.generation !== artifact.generation)
    failA1(
      "GENERATION_MISMATCH",
      `incumbent artifact '${artifact.artifact_id}' has a different registered generation`,
      location,
    );
  if (registered.source_type === "fixed_external") {
    if (!registered.candidate_id && !registered.producer_run_id && registered.role_id === null)
      return;
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      `fixed external incumbent artifact '${artifact.artifact_id}' claims workflow provenance`,
      location,
    );
  }
  if (
    registered.candidate_id !== incumbent.candidate_id ||
    registered.role_id !== sourceRole ||
    registered.generation !== incumbent.generation
  )
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      `incumbent artifact '${artifact.artifact_id}' is not the registered output for '${sourceRole}'`,
      location,
    );
}

export function validateIncumbentSnapshot(value: unknown): IncumbentSnapshot {
  if (!isRecord(value)) failA1("INVALID_VALUE", "incumbent must be an object");
  assertNoUnknownFields(
    value,
    ["schema_version", "candidate_id", "generation", "role_artifacts"],
    "incumbent",
  );
  if (value.schema_version !== undefined && value.schema_version !== 1)
    failA1("INVALID_VALUE", "incumbent schema_version must be 1", "incumbent.schema_version");
  if (!Array.isArray(value.role_artifacts))
    failA1(
      "INVALID_VALUE",
      "incumbent role_artifacts must be an array",
      "incumbent.role_artifacts",
    );
  const roleArtifacts = value.role_artifacts.map((artifact, index) => {
    if (!isRecord(artifact))
      failA1(
        "INVALID_VALUE",
        "incumbent role artifact must be an object",
        `incumbent.role_artifacts[${index}]`,
      );
    assertNoUnknownFields(
      artifact,
      ["artifact_id", "generation", "role_id"],
      `incumbent.role_artifacts[${index}]`,
    );
    return {
      artifact_id: assertIdentifier(
        artifact.artifact_id,
        `incumbent.role_artifacts[${index}].artifact_id`,
      ),
      generation: requireInteger(
        artifact.generation,
        `incumbent.role_artifacts[${index}].generation`,
        0,
      ),
      role_id: assertIdentifier(artifact.role_id, `incumbent.role_artifacts[${index}].role_id`),
    };
  });
  if (new Set(roleArtifacts.map((artifact) => artifact.role_id)).size !== roleArtifacts.length)
    failA1("DUPLICATE_ID", "incumbent role ids must be unique", "incumbent.role_artifacts");
  const incumbentGeneration = requireInteger(value.generation, "incumbent.generation", 0);
  for (const artifact of roleArtifacts) {
    if (artifact.generation > incumbentGeneration)
      failA1(
        "GENERATION_MISMATCH",
        `incumbent role '${artifact.role_id}' is from a future generation`,
        "incumbent.role_artifacts",
      );
  }
  return {
    candidate_id: assertIdentifier(value.candidate_id, "incumbent.candidate_id"),
    generation: incumbentGeneration,
    role_artifacts: roleArtifacts,
  };
}

function validateCandidateContext(
  value: CandidateArtifactContext | undefined,
): CandidateArtifactContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) failA1("INVALID_VALUE", "candidate artifact context must be an object");
  assertNoUnknownFields(
    value,
    [
      "candidate_artifact_ids",
      "candidate_output_artifact_ids",
      "target_generations",
      "candidate_id",
      "producer_run_id",
      "candidate_generation",
    ],
    "candidate",
  );
  const rawCandidateArtifactIds = value.candidate_artifact_ids;
  const rawCandidateOutputArtifactIds = value.candidate_output_artifact_ids;
  if (
    !Array.isArray(rawCandidateArtifactIds) ||
    !Array.isArray(rawCandidateOutputArtifactIds) ||
    !isRecord(value.target_generations)
  )
    failA1("INVALID_VALUE", "candidate artifact context fields are invalid");
  const targetGenerations: Record<string, number> = {};
  for (const [target, generation] of Object.entries(value.target_generations)) {
    targetGenerations[assertIdentifier(target, "candidate.target_generations.key")] =
      requireInteger(generation, `candidate.target_generations.${target}`, 0);
  }
  const candidateArtifactIds = rawCandidateArtifactIds.map((id, index) =>
    assertIdentifier(id, `candidate.candidate_artifact_ids[${index}]`),
  );
  const candidateOutputArtifactIds = rawCandidateOutputArtifactIds.map((id, index) =>
    assertIdentifier(id, `candidate.candidate_output_artifact_ids[${index}]`),
  );
  if (new Set(candidateArtifactIds).size !== candidateArtifactIds.length)
    failA1(
      "DUPLICATE_ID",
      "candidate artifact ids must be unique",
      "candidate.candidate_artifact_ids",
    );
  if (new Set(candidateOutputArtifactIds).size !== candidateOutputArtifactIds.length)
    failA1(
      "DUPLICATE_ID",
      "candidate output artifact ids must be unique",
      "candidate.candidate_output_artifact_ids",
    );
  const candidateId =
    value.candidate_id === undefined
      ? undefined
      : assertIdentifier(value.candidate_id, "candidate.candidate_id");
  const producerRunId =
    value.producer_run_id === undefined
      ? undefined
      : assertIdentifier(value.producer_run_id, "candidate.producer_run_id");
  const candidateGeneration =
    value.candidate_generation === undefined
      ? undefined
      : requireInteger(value.candidate_generation, "candidate.candidate_generation", 0);
  return {
    candidate_id: candidateId,
    producer_run_id: producerRunId,
    candidate_artifact_ids: candidateArtifactIds,
    candidate_output_artifact_ids: candidateOutputArtifactIds,
    target_generations: targetGenerations,
    candidate_generation: candidateGeneration,
  };
}

function assertRoleRequestSubset(
  policy: ModelUsagePolicy,
  requestedRoles: readonly ModelRoleRequest[] | undefined,
  requestedRoleIds: readonly string[] | undefined,
): void {
  const policyByRole = new Map(policy.roles.map((role) => [role.role_id, role]));
  const ids = new Set<string>();
  for (const [index, roleIdValue] of (requestedRoleIds ?? []).entries()) {
    const roleId = assertIdentifier(roleIdValue, `requested_role_ids[${index}]`);
    if (ids.has(roleId)) failA1("DUPLICATE_ID", "requested role ids must be unique");
    ids.add(roleId);
    if (!policyByRole.has(roleId))
      failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", `requested role '${roleId}' is not in policy`);
  }
  for (const [index, requestValue] of (requestedRoles ?? []).entries()) {
    if (!isRecord(requestValue))
      failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "requested role must be an object");
    assertNoUnknownFields(
      requestValue,
      ["role_id", "allowed_modules", "allowed_uses", "judge_targets"],
      `requested_roles[${index}]`,
    );
    const roleId = assertIdentifier(requestValue.role_id, `requested_roles[${index}].role_id`);
    if (ids.has(roleId)) failA1("DUPLICATE_ID", `requested role '${roleId}' appears twice`);
    ids.add(roleId);
    const policyRole = policyByRole.get(roleId);
    if (!policyRole)
      failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", `requested role '${roleId}' is not in policy`);
    const assertSubset = (
      field: "allowed_modules" | "allowed_uses" | "judge_targets",
      allowed: readonly string[],
    ): void => {
      const requested = requestValue[field];
      if (requested === undefined) return;
      if (!Array.isArray(requested))
        failA1(
          "MODEL_SCOPE_ALIGNMENT_REQUIRED",
          `${field} must be an array`,
          `requested_roles[${index}]`,
        );
      const normalized = requested.map((item, itemIndex) =>
        requireString(item, `requested_roles[${index}].${field}[${itemIndex}]`),
      );
      if (new Set(normalized).size !== normalized.length)
        failA1("DUPLICATE_ID", `${field} must be unique`, `requested_roles[${index}]`);
      for (const item of normalized)
        if (!allowed.includes(item))
          failA1(
            "MODEL_SCOPE_ALIGNMENT_REQUIRED",
            `requested role '${roleId}' expands ${field} with '${item}'`,
            `requested_roles[${index}].${field}`,
          );
    };
    assertSubset("allowed_modules", policyRole.allowed_modules);
    assertSubset("allowed_uses", policyRole.allowed_uses);
    assertSubset("judge_targets", policyRole.judge_targets);
  }
}

interface CandidateArtifactFacts {
  artifact_ids: string[];
  output_artifact_ids: string[];
  generation: number;
  entries: ArtifactRegistryEntry[];
}

function assertCandidateArtifactContext(
  candidate: CandidateArtifactContext,
  registry: ArtifactRegistry,
  defaultProducerRunId?: string,
): CandidateArtifactFacts {
  if (candidate.candidate_id === undefined)
    failA1(
      "ARTIFACT_REGISTRY_REQUIRED",
      "candidate lineage must name the immutable candidate identity",
    );
  const producerRunId = candidate.producer_run_id ?? defaultProducerRunId;
  const entries = registry.findByCandidate(candidate.candidate_id, producerRunId);
  if (entries.length === 0)
    failA1(
      "ARTIFACT_NOT_FOUND",
      `candidate '${candidate.candidate_id}' has no registered workflow outputs`,
    );
  const generations = new Set(
    entries.map((entry) => {
      if (entry.generation === null)
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `candidate Artifact '${entry.artifact_id}' has no generation`,
        );
      return entry.generation;
    }),
  );
  if (generations.size !== 1)
    failA1("ARTIFACT_PROVENANCE_MISMATCH", "candidate workflow outputs must share one generation");
  const generation = [...generations][0]!;
  if (candidate.candidate_generation !== undefined && candidate.candidate_generation !== generation)
    failA1(
      "GENERATION_MISMATCH",
      "candidate_generation does not match the registered Artifact generation",
    );
  const artifactIds = entries.map((entry) => entry.artifact_id).sort(compareIdentityStrings);
  const outputArtifactIds = entries
    .filter((entry) => entry.role_id !== null && entry.output_slot !== null)
    .map((entry) => entry.artifact_id)
    .sort(compareIdentityStrings);
  const suppliedIds = [...candidate.candidate_artifact_ids].sort(compareIdentityStrings);
  if (
    suppliedIds.length !== artifactIds.length ||
    suppliedIds.some((artifactId, index) => artifactId !== artifactIds[index])
  )
    failA1(
      "ARTIFACT_PROVENANCE_MISMATCH",
      "candidate_artifact_ids do not match the registered candidate outputs",
    );
  for (const artifactId of candidate.candidate_output_artifact_ids) {
    if (!outputArtifactIds.includes(artifactId))
      failA1(
        "ARTIFACT_PROVENANCE_MISMATCH",
        `candidate output '${artifactId}' is not registered for this candidate`,
      );
  }
  for (const [target, targetGeneration] of Object.entries(candidate.target_generations)) {
    if (targetGeneration !== generation)
      failA1(
        "GENERATION_MISMATCH",
        `target '${target}' does not use the registered candidate generation`,
      );
  }
  return { artifact_ids: artifactIds, output_artifact_ids: outputArtifactIds, generation, entries };
}

function resolveRole(role: ModelRolePolicy, input: ResolveAssignmentInput): ModelAssignmentEntry {
  const requested = input.requested_artifact_ids?.[role.role_id];
  const sourceRole = role.artifact_binding.source_role ?? role.role_id;
  let artifactId: string;
  let generation: number | null;
  let sourceIncumbentId: string | null;
  if (role.artifact_binding.source === "fixed_external") {
    if (role.artifact_binding.artifact_id === null)
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        `fixed external role '${role.role_id}' has no artifact`,
      );
    if (!input.registry)
      failA1(
        "ARTIFACT_REGISTRY_REQUIRED",
        `fixed external role '${role.role_id}' must resolve through the Artifact registry`,
      );
    const external = input.registry.assertFixedExternal(role.artifact_binding.artifact_id);
    artifactId = external.artifact_id;
    generation = external.generation;
    sourceIncumbentId = null;
  } else {
    const artifact = incumbentRole(input.incumbent, role);
    artifactId = artifact.artifact_id;
    generation = artifact.generation;
    sourceIncumbentId = input.incumbent.candidate_id;
    if (!input.registry)
      failA1(
        "ARTIFACT_REGISTRY_REQUIRED",
        `role '${role.role_id}' must resolve through the Artifact registry`,
      );
    const registered = input.registry.assertSealed(artifact.artifact_id);
    if (registered.source_type === "fixed_external")
      input.registry.assertFixedExternal(artifact.artifact_id);
    assertIncumbentArtifactProvenance(
      registered,
      artifact,
      input.incumbent,
      sourceRole,
      `incumbent.role_artifacts.${sourceRole}`,
    );
  }
  if (requested !== undefined && requested !== artifactId) {
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      `role '${role.role_id}' cannot choose a different artifact at runtime`,
    );
  }
  if (role.allowed_uses.includes("judge")) {
    if (role.judge_generation_lag === null || role.judge_generation_lag < 1)
      failA1("JUDGE_LAG_VIOLATION", `judge role '${role.role_id}' has insufficient generation lag`);
    for (const target of role.judge_targets) {
      const targetGeneration = input.candidate?.target_generations[target];
      if (!input.candidate || targetGeneration === undefined) {
        failA1(
          "JUDGE_LAG_VIOLATION",
          `judge target '${target}' has no frozen candidate generation`,
        );
      }
      if (
        role.artifact_binding.source === "previous_promoted" &&
        targetGeneration !== undefined &&
        generation !== null &&
        generation > targetGeneration - role.judge_generation_lag
      ) {
        failA1(
          "JUDGE_LAG_VIOLATION",
          `judge role '${role.role_id}' is not behind target '${target}' by one promoted generation`,
        );
      }
    }
  }
  return {
    role_id: role.role_id,
    module_ids: [...role.allowed_modules].sort(compareIdentityStrings),
    uses: [...role.allowed_uses].sort(compareIdentityStrings),
    judge_targets: [...role.judge_targets].sort(compareIdentityStrings),
    artifact_id: artifactId,
    resolved_from: role.artifact_binding.source,
    resolved_generation: generation,
    source_incumbent_id: sourceIncumbentId,
  };
}

export function assertAssignmentLineageSafe(
  assignment: ModelAssignment,
  candidate: CandidateArtifactContext | undefined,
  registry: ArtifactRegistry | undefined,
): void {
  const judgeArtifactIds = assignment.assignments
    .filter((entry) => entry.uses.includes("judge"))
    .map((entry) => entry.artifact_id);
  if (judgeArtifactIds.length > 0 && !candidate)
    failA1("JUDGE_LAG_VIOLATION", "judge safety requires the current candidate context");
  if (!registry)
    failA1(
      "ARTIFACT_REGISTRY_REQUIRED",
      "model assignments must resolve every Artifact through the system registry",
    );
  for (const artifactId of assignment.assignments.map((entry) => entry.artifact_id))
    registry.assertSealed(artifactId);
  if (!candidate) return;
  const facts = assertCandidateArtifactContext(candidate, registry, assignment.outer_run_id);
  const forbidden = facts.artifact_ids;
  if (judgeArtifactIds.some((judgeId) => forbidden.includes(judgeId))) {
    failA1(
      "JUDGE_LAG_VIOLATION",
      "a judge cannot be the current candidate or its promotion output",
    );
  }
  registry.assertNoSelfEvaluation(forbidden, judgeArtifactIds);
}

export function resolveModelAssignment(input: ResolveAssignmentInput): ModelAssignment {
  if (!isRecord(input)) failA1("INVALID_VALUE", "model assignment input must be an object");
  assertNoUnknownFields(
    input,
    [
      "policy",
      "task_setup_revision",
      "outer_run_id",
      "outer_iteration",
      "incumbent",
      "candidate",
      "registry",
      "requested_artifact_ids",
      "requested_roles",
      "requested_role_ids",
    ],
    "model_assignment",
  );
  const policy = validateModelUsagePolicy(input.policy, "model_usage_policy");
  const incumbent = validateIncumbentSnapshot(input.incumbent);
  const parsedCandidate = validateCandidateContext(input.candidate);
  const taskSetupRevision = assertIdentifier(input.task_setup_revision, "task_setup_revision");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  if (!Number.isInteger(input.outer_iteration) || input.outer_iteration < 1)
    failA1("INVALID_VALUE", "outer_iteration must be >= 1");
  if (!Number.isInteger(incumbent.generation) || incumbent.generation < 0)
    failA1("INVALID_VALUE", "incumbent generation must be non-negative");
  const requested = input.requested_artifact_ids;
  if (requested !== undefined) {
    if (!isRecord(requested))
      failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "requested artifact bindings must be an object");
    if (Object.keys(requested).length > 0)
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        "agents cannot choose concrete Artifact bindings; the resolver uses policy and incumbent only",
      );
  }
  assertRoleRequestSubset(policy, input.requested_roles, input.requested_role_ids);
  if (!input.registry)
    failA1("ARTIFACT_REGISTRY_REQUIRED", "model assignment must use the system Artifact registry");
  const candidate = parsedCandidate
    ? {
        ...parsedCandidate,
        producer_run_id: parsedCandidate.producer_run_id ?? outerRunId,
      }
    : undefined;
  if (candidate) {
    const candidateFacts = assertCandidateArtifactContext(candidate, input.registry, outerRunId);
    const expectedGeneration = incumbent.generation + 1;
    if (candidateFacts.generation !== expectedGeneration)
      failA1(
        "GENERATION_MISMATCH",
        `candidate outputs must use the next generation after incumbent ${incumbent.generation}`,
      );
  }
  const resolvedInput = { ...input, policy, incumbent, candidate };
  const assignments = policy.roles
    .map((role) => resolveRole(role, resolvedInput))
    .sort((left, right) => compareIdentityStrings(left.role_id, right.role_id));
  const policySha256 = canonicalJsonSha256(policy, undefined, {
    schemaVersion: "model-usage-policy-v1",
  });
  const withoutHash: Omit<ModelAssignment, "assignment_sha256"> = {
    schema_version: 1,
    task_setup_revision: taskSetupRevision,
    outer_run_id: outerRunId,
    outer_iteration: input.outer_iteration,
    assignments,
    policy_sha256: policySha256,
  };
  const assignmentSha256 = canonicalJsonSha256(withoutHash, undefined, {
    schemaVersion: "model-assignment-v1",
  });
  const result: ModelAssignment = { ...withoutHash, assignment_sha256: assignmentSha256 };
  assertAssignmentLineageSafe(result, candidate, input.registry);
  return result;
}

export function modelAssignmentPath(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): string {
  return path.join(
    workflowCycleDirectory(projectRoot, outerRunId, outerIteration),
    "model-assignment.json",
  );
}

export function saveModelAssignment(
  projectRoot: string,
  assignment: ModelAssignment,
): ModelAssignment {
  const filePath = modelAssignmentPath(
    projectRoot,
    assignment.outer_run_id,
    assignment.outer_iteration,
  );
  return withStateFileLock(filePath, () => {
    if (fs.existsSync(filePath)) {
      const existing = readStateFile(filePath);
      if (
        canonicalJsonSha256(existing, undefined, { schemaVersion: "model-assignment-v1" }) ===
        canonicalJsonSha256(assignment, undefined, { schemaVersion: "model-assignment-v1" })
      )
        return assignment;
      failA1("IMMUTABLE_CONFLICT", `model assignment already exists at ${filePath}`);
    }
    writeStateJsonAtomic(filePath, assignment);
    return assignment;
  });
}

export function loadModelAssignment(
  projectRoot: string,
  outerRunId: string,
  outerIteration: number,
): ModelAssignment {
  const filePath = modelAssignmentPath(projectRoot, outerRunId, outerIteration);
  if (!fs.existsSync(filePath))
    failA1("ASSIGNMENT_NOT_FOUND", `model assignment does not exist at ${filePath}`);
  const parsed = readStateFile(filePath);
  if (!isRecord(parsed))
    failA1("CORRUPT_ASSIGNMENT", "model assignment is not an object", filePath);
  if (parsed.outer_run_id !== outerRunId || parsed.outer_iteration !== outerIteration)
    failA1("IDENTITY_MISMATCH", "model assignment path and content disagree", filePath);
  const allowed = [
    "schema_version",
    "task_setup_revision",
    "outer_run_id",
    "outer_iteration",
    "assignments",
    "policy_sha256",
    "assignment_sha256",
  ];
  assertNoUnknownFields(parsed, allowed, filePath);
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.assignments))
    failA1("CORRUPT_ASSIGNMENT", "model assignment envelope is invalid", filePath);
  const assignments = parsed.assignments.map((entry, index) => {
    if (!isRecord(entry))
      failA1(
        "CORRUPT_ASSIGNMENT",
        "model assignment entry is invalid",
        `${filePath}.assignments[${index}]`,
      );
    assertNoUnknownFields(
      entry,
      [
        "role_id",
        "module_ids",
        "uses",
        "judge_targets",
        "artifact_id",
        "resolved_from",
        "resolved_generation",
        "source_incumbent_id",
      ],
      `${filePath}.assignments[${index}]`,
    );
    if (
      !Array.isArray(entry.module_ids) ||
      !Array.isArray(entry.uses) ||
      !Array.isArray(entry.judge_targets)
    )
      failA1(
        "CORRUPT_ASSIGNMENT",
        "assignment arrays are invalid",
        `${filePath}.assignments[${index}]`,
      );
    if (entry.resolved_from !== "previous_promoted" && entry.resolved_from !== "fixed_external")
      failA1(
        "CORRUPT_ASSIGNMENT",
        "assignment source is invalid",
        `${filePath}.assignments[${index}].resolved_from`,
      );
    return {
      role_id: assertIdentifier(entry.role_id, `${filePath}.assignments[${index}].role_id`),
      module_ids: entry.module_ids.map((id, itemIndex) =>
        assertIdentifier(id, `${filePath}.assignments[${index}].module_ids[${itemIndex}]`),
      ),
      uses: entry.uses.map((use, itemIndex) => {
        const text = requireString(use, `${filePath}.assignments[${index}].uses[${itemIndex}]`);
        if (!["generate", "train", "distill", "aggregate", "judge"].includes(text))
          failA1("CORRUPT_ASSIGNMENT", "assignment use is invalid", filePath);
        return text as ModelRolePolicy["allowed_uses"][number];
      }),
      judge_targets: entry.judge_targets.map((id, itemIndex) =>
        assertIdentifier(id, `${filePath}.assignments[${index}].judge_targets[${itemIndex}]`),
      ),
      artifact_id: assertIdentifier(
        entry.artifact_id,
        `${filePath}.assignments[${index}].artifact_id`,
      ),
      resolved_from: entry.resolved_from as "previous_promoted" | "fixed_external",
      resolved_generation:
        entry.resolved_generation === null
          ? null
          : requireInteger(
              entry.resolved_generation,
              `${filePath}.assignments[${index}].resolved_generation`,
              0,
            ),
      source_incumbent_id:
        entry.source_incumbent_id === null
          ? null
          : assertIdentifier(
              entry.source_incumbent_id,
              `${filePath}.assignments[${index}].source_incumbent_id`,
            ),
    };
  });
  const assignment: ModelAssignment = {
    schema_version: 1,
    task_setup_revision: assertIdentifier(
      parsed.task_setup_revision,
      `${filePath}.task_setup_revision`,
    ),
    outer_run_id: assertIdentifier(parsed.outer_run_id, `${filePath}.outer_run_id`),
    outer_iteration: requireInteger(parsed.outer_iteration, `${filePath}.outer_iteration`, 1),
    assignments,
    policy_sha256: assertSha256(parsed.policy_sha256, `${filePath}.policy_sha256`),
    assignment_sha256: assertSha256(parsed.assignment_sha256, `${filePath}.assignment_sha256`),
  };
  const withoutHash = {
    schema_version: 1 as const,
    task_setup_revision: assignment.task_setup_revision,
    outer_run_id: assignment.outer_run_id,
    outer_iteration: assignment.outer_iteration,
    assignments: assignment.assignments,
    policy_sha256: assignment.policy_sha256,
  };
  if (
    canonicalJsonSha256(withoutHash, undefined, { schemaVersion: "model-assignment-v1" }) !==
    assignment.assignment_sha256
  )
    failA1("CORRUPT_ASSIGNMENT", "model assignment hash does not match its contents", filePath);
  return assignment;
}

export function assertSingleModelJudgeUsesIncumbent(
  assignment: ModelAssignment,
  incumbent: IncumbentSnapshot,
): void {
  const incumbentIds = new Set(incumbent.role_artifacts.map((artifact) => artifact.artifact_id));
  for (const entry of assignment.assignments) {
    if (
      entry.uses.includes("judge") &&
      entry.resolved_from === "previous_promoted" &&
      !incumbentIds.has(entry.artifact_id)
    ) {
      failA1(
        "JUDGE_LAG_VIOLATION",
        `judge '${entry.role_id}' is not bound to an incumbent artifact`,
      );
    }
  }
}

export interface PromotionCommit {
  /** Null means initialize only; otherwise compare this frozen parent inside the pointer lock. */
  expected_parent_sha256: string | null;
  candidate_id: string;
  generation: number;
  role_artifacts: IncumbentArtifact[];
  producer_run_id?: string;
  /** The frozen policy and registry are required to prove a promotion is allowed. */
  policy?: ModelUsagePolicy;
  registry?: ArtifactRegistry;
  /** Maps each policy promotion_output name to its registered candidate Artifact. */
  promotion_outputs?: Readonly<Record<string, string>>;
  candidate_output_artifact_ids?: readonly string[];
}

interface PromotionOutputFacts {
  entries: ArtifactRegistryEntry[];
  promotionEntries: ArtifactRegistryEntry[];
  byRole: Map<string, ArtifactRegistryEntry>;
  byOutput: Map<string, ArtifactRegistryEntry>;
  generation: number;
  producerRunId: string;
}

function assertSameIdSet(
  actual: readonly string[],
  expected: readonly string[],
  location: string,
): void {
  const actualIds = [...new Set(actual)].sort(compareIdentityStrings);
  const expectedIds = [...new Set(expected)].sort(compareIdentityStrings);
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((artifactId, index) => artifactId !== expectedIds[index])
  )
    failA1("ARTIFACT_PROVENANCE_MISMATCH", "artifact ids do not match registry facts", location);
}

function derivePromotionOutputs(
  registry: ArtifactRegistry,
  candidateId: string,
  requestedProducerRunId: string | undefined,
  policyByOutput: ReadonlyMap<string, ModelRolePolicy>,
  policyOutputRoles: readonly ModelRolePolicy[],
): PromotionOutputFacts {
  const entries = registry.findByCandidate(candidateId, requestedProducerRunId);
  if (entries.length === 0)
    failA1(
      "ARTIFACT_NOT_FOUND",
      `candidate '${candidateId}' has no registered workflow output Artifacts`,
    );
  const producerRunIds = new Set(
    entries.map((entry) => {
      if (entry.producer_run_id === null)
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `workflow output '${entry.artifact_id}' has no producer run`,
        );
      return entry.producer_run_id;
    }),
  );
  if (producerRunIds.size !== 1)
    failA1("ARTIFACT_PROVENANCE_MISMATCH", "a candidate must be promoted from one producer run");
  const producerRunId = [...producerRunIds][0]!;
  const generations = new Set(
    entries.map((entry) => {
      if (entry.generation === null)
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `workflow output '${entry.artifact_id}' has no generation`,
        );
      return entry.generation;
    }),
  );
  if (generations.size !== 1)
    failA1("ARTIFACT_PROVENANCE_MISMATCH", "candidate outputs must share one generation");
  const generation = [...generations][0]!;
  const promotionEntries: ArtifactRegistryEntry[] = [];
  const byRole = new Map<string, ArtifactRegistryEntry>();
  const byOutput = new Map<string, ArtifactRegistryEntry>();
  for (const entry of entries) {
    if (
      entry.source_type !== "workflow_output" ||
      entry.role_id === null ||
      entry.output_slot === null
    )
      failA1(
        "ARTIFACT_PROVENANCE_MISMATCH",
        `candidate Artifact '${entry.artifact_id}' lacks workflow output provenance`,
      );
    const role = policyByOutput.get(entry.output_slot);
    if (!role) continue;
    if (role.role_id !== entry.role_id)
      failA1(
        "ARTIFACT_PROVENANCE_MISMATCH",
        `candidate output slot '${entry.output_slot}' is registered for the wrong role`,
      );
    promotionEntries.push(entry);
    if (byRole.has(entry.role_id))
      failA1("DUPLICATE_ID", `candidate has multiple output Artifacts for role '${entry.role_id}'`);
    if (byOutput.has(entry.output_slot))
      failA1("DUPLICATE_ID", `candidate has duplicate output slot '${entry.output_slot}'`);
    byRole.set(entry.role_id, entry);
    byOutput.set(entry.output_slot, entry);
  }
  const expectedRoles = policyOutputRoles.map((role) => role.role_id);
  assertSameIdSet([...byRole.keys()], expectedRoles, "promotion.output_roles");
  for (const role of policyOutputRoles) {
    if (role.promotion_output === null || !byOutput.has(role.promotion_output))
      failA1(
        "MODEL_SCOPE_ALIGNMENT_REQUIRED",
        `candidate is missing policy output '${role.promotion_output ?? role.role_id}'`,
      );
  }
  return { entries, promotionEntries, byRole, byOutput, generation, producerRunId };
}

export function commitPromotionAtomically(
  projectRoot: string,
  workflowId: string,
  commit: PromotionCommit,
): void {
  if (!isRecord(commit)) failA1("INVALID_VALUE", "promotion commit must be an object");
  assertNoUnknownFields(
    commit,
    [
      "candidate_id",
      "expected_parent_sha256",
      "generation",
      "role_artifacts",
      "producer_run_id",
      "policy",
      "registry",
      "promotion_outputs",
      "candidate_output_artifact_ids",
    ],
    "promotion",
  );
  const expectedParent =
    commit.expected_parent_sha256 === null
      ? null
      : assertSha256(commit.expected_parent_sha256, "promotion.expected_parent_sha256");
  const safeWorkflowId = assertIdentifier(workflowId, "workflow_id");
  const candidateId = assertIdentifier(commit.candidate_id, "candidate_id");
  if (!Number.isInteger(commit.generation) || commit.generation < 0)
    failA1("INVALID_VALUE", "promotion generation must be non-negative");
  const policy = commit.policy
    ? validateModelUsagePolicy(commit.policy, "promotion.model_usage_policy")
    : null;
  if (!policy)
    failA1(
      "MODEL_SCOPE_ALIGNMENT_REQUIRED",
      "promotion needs the sealed model usage policy to validate output mapping",
    );
  if (!commit.registry)
    failA1(
      "ARTIFACT_REGISTRY_REQUIRED",
      "promotion needs a registry to prove artifacts are sealed",
    );
  const registry = commit.registry;
  const producerRunId =
    commit.producer_run_id === undefined
      ? undefined
      : assertIdentifier(commit.producer_run_id, "promotion.producer_run_id");
  const updates = commit.role_artifacts.map((artifact, index) => {
    if (!isRecord(artifact))
      failA1(
        "INVALID_VALUE",
        "promotion role artifact must be an object",
        `promotion.role_artifacts[${index}]`,
      );
    assertNoUnknownFields(
      artifact,
      ["artifact_id", "generation", "role_id"],
      `promotion.role_artifacts[${index}]`,
    );
    return {
      artifact_id: assertIdentifier(
        artifact.artifact_id,
        `promotion.role_artifacts[${index}].artifact_id`,
      ),
      generation: requireInteger(
        artifact.generation,
        `promotion.role_artifacts[${index}].generation`,
        0,
      ),
      role_id: assertIdentifier(artifact.role_id, `promotion.role_artifacts[${index}].role_id`),
    };
  });
  if (updates.length === 0) failA1("INVALID_VALUE", "promotion must update at least one role");
  if (new Set(updates.map((artifact) => artifact.role_id)).size !== updates.length)
    failA1("DUPLICATE_ID", "promotion role ids must be unique");
  const policyByOutput = new Map(
    policy.roles
      .filter((role) => role.promotion_output !== null)
      .map((role) => [role.promotion_output!, role]),
  );
  const policyOutputRoles = policy.roles.filter((role) => role.promotion_output !== null);
  if (policyOutputRoles.length === 0)
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "promotion policy has no output roles");
  const promotionOutputs = commit.promotion_outputs;
  if (promotionOutputs === undefined)
    failA1("MODEL_SCOPE_ALIGNMENT_REQUIRED", "promotion output mapping is required");
  if (!isRecord(promotionOutputs)) failA1("INVALID_VALUE", "promotion_outputs must be an object");
  const suppliedCandidateOutputs =
    commit.candidate_output_artifact_ids === undefined
      ? undefined
      : commit.candidate_output_artifact_ids.map((artifactId, index) =>
          assertIdentifier(artifactId, `promotion.candidate_output_artifact_ids[${index}]`),
        );
  if (
    suppliedCandidateOutputs !== undefined &&
    new Set(suppliedCandidateOutputs).size !== suppliedCandidateOutputs.length
  )
    failA1(
      "DUPLICATE_ID",
      "promotion candidate output artifact ids must be unique",
      "promotion.candidate_output_artifact_ids",
    );
  const suppliedPromotionOutputs = new Map<string, string>();
  for (const [output, artifactIdValue] of Object.entries(promotionOutputs)) {
    const outputId = assertIdentifier(output, "promotion_outputs.output_slot");
    if (suppliedPromotionOutputs.has(outputId))
      failA1("DUPLICATE_ID", `promotion output '${outputId}' appears twice`);
    suppliedPromotionOutputs.set(
      outputId,
      assertIdentifier(artifactIdValue, `promotion_outputs.${outputId}`),
    );
  }
  const expectedOutputIds = policyOutputRoles.map((role) => role.promotion_output!);
  assertSameIdSet([...suppliedPromotionOutputs.keys()], expectedOutputIds, "promotion_outputs");
  const filePath = path.join(
    path.resolve(projectRoot),
    ".aris",
    "workflows",
    safeWorkflowId,
    "active-incumbent.json",
  );
  withStateFileLock(filePath, () => {
    const outputFacts = derivePromotionOutputs(
      registry,
      candidateId,
      producerRunId,
      policyByOutput,
      policyOutputRoles,
    );
    if (suppliedCandidateOutputs !== undefined)
      assertSameIdSet(
        suppliedCandidateOutputs,
        outputFacts.promotionEntries.map((entry) => entry.artifact_id),
        "promotion.candidate_output_artifact_ids",
      );
    const existing = fs.existsSync(filePath)
      ? validateIncumbentSnapshot(readStateFile(filePath))
      : null;
    const actualParent =
      existing === null
        ? null
        : canonicalJsonSha256(existing, undefined, { schemaVersion: "incumbent-v1" });
    if (actualParent !== expectedParent)
      failA1(
        "PROMOTION_PARENT_CONFLICT",
        "active incumbent differs from the frozen promotion parent",
      );
    const expectedGeneration = existing === null ? 0 : existing.generation + 1;
    if (commit.generation !== expectedGeneration)
      failA1(
        "GENERATION_MISMATCH",
        `promotion generation must be ${expectedGeneration} from the sealed incumbent`,
      );
    if (existing?.candidate_id === candidateId)
      failA1("IMMUTABLE_CONFLICT", "the active incumbent already names this candidate");
    if (outputFacts.generation !== expectedGeneration)
      failA1(
        "GENERATION_MISMATCH",
        "candidate Artifact generation does not follow the sealed incumbent",
      );
    if (existing)
      for (const artifact of existing.role_artifacts) registry.assertSealed(artifact.artifact_id);
    for (const entry of outputFacts.entries) registry.assertSealed(entry.artifact_id);
    for (const [output, artifactId] of suppliedPromotionOutputs) {
      const registered = outputFacts.byOutput.get(output);
      if (!registered || registered.artifact_id !== artifactId)
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `promotion output '${output}' does not match its registered candidate Artifact`,
        );
    }
    const updatesByRole = new Map(updates.map((artifact) => [artifact.role_id, artifact]));
    assertSameIdSet(
      [...updatesByRole.keys()],
      policyOutputRoles.map((role) => role.role_id),
      "promotion.role_artifacts",
    );
    for (const role of policyOutputRoles) {
      const update = updatesByRole.get(role.role_id);
      const registered = outputFacts.byRole.get(role.role_id);
      if (!update || !registered || role.promotion_output === null)
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `promotion output for role '${role.role_id}' is missing`,
        );
      if (
        update.artifact_id !== registered.artifact_id ||
        update.generation !== expectedGeneration ||
        registered.generation !== expectedGeneration ||
        registered.candidate_id !== candidateId ||
        registered.producer_run_id !== outputFacts.producerRunId ||
        registered.output_slot !== role.promotion_output ||
        registered.role_id !== role.role_id
      )
        failA1(
          "ARTIFACT_PROVENANCE_MISMATCH",
          `promotion role '${role.role_id}' does not match its registered producer facts`,
        );
    }
    const finalByRole = new Map(
      (existing?.role_artifacts ?? []).map((artifact) => [artifact.role_id, artifact]),
    );
    for (const update of updates) finalByRole.set(update.role_id, update);
    const normalized = {
      schema_version: 1,
      candidate_id: candidateId,
      generation: commit.generation,
      role_artifacts: [...finalByRole.values()].sort((left, right) =>
        compareIdentityStrings(left.role_id, right.role_id),
      ),
    };
    writeStateJsonAtomic(filePath, normalized);
  });
}
