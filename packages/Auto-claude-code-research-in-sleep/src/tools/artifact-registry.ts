import { runOwnedPath } from "./run-contract.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonString } from "./canonical-json.js";
import { readStateFile, stateLockPath, withStateFileLock } from "./state-file.js";
import {
  assertIdentifier,
  assertRelativePath,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";

export interface ArtifactReference {
  schema_version: 1;
  artifact_id: string;
  contract: string;
  uri: string;
  sha256: string;
  producer_module: string;
  producer_version: string;
  producer_run_id: string | null;
  candidate_id: string | null;
  input_artifact_ids: string[];
  status: "sealed";
  generation: number | null;
  role_id: string | null;
  output_slot: string | null;
  source_type: "workflow_output" | "fixed_external";
  file_path: string | null;
}

export interface ArtifactRegistryEntry extends ArtifactReference {
  registered_at: string;
}

export interface ArtifactRegistry {
  readonly projectRoot: string;
  readonly runId: string;
  readonly filePath: string;
  register(reference: unknown): ArtifactRegistryEntry;
  list(): ArtifactRegistryEntry[];
  get(artifactId: string): ArtifactRegistryEntry;
  assertSealed(artifactId: string): ArtifactRegistryEntry;
  assertFixedExternal(artifactId: string): ArtifactRegistryEntry;
  findByCandidate(candidateId: string, producerRunId?: string): ArtifactRegistryEntry[];
  isDescendant(artifactId: string, ancestorArtifactId: string): boolean;
  assertNoSelfEvaluation(
    candidateArtifactIds: readonly string[],
    judgeArtifactIds: readonly string[],
  ): void;
}

function registryPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, runId, "artifacts", "index.jsonl");
}

function validateUri(value: unknown, location: string): string {
  const uri = requireString(value, location);
  if (uri.includes("\0")) failA1("INVALID_PATH", "artifact uri must not contain NUL", location);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return uri;
  return assertRelativePath(uri, location);
}

export function validateArtifactReference(
  value: unknown,
  location = "artifact",
): ArtifactReference {
  if (!isRecord(value)) {
    failA1("INVALID_ARTIFACT", "artifact reference must be an object", location);
  }
  const allowed = [
    "schema_version",
    "artifact_id",
    "contract",
    "uri",
    "sha256",
    "producer_module",
    "producer_version",
    "producer_run_id",
    "candidate_id",
    "input_artifact_ids",
    "status",
    "generation",
    "role_id",
    "output_slot",
    "source_type",
    "file_path",
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      failA1("UNKNOWN_FIELD", `unknown field '${key}'`, `${location}.${key}`);
  }
  if (value.schema_version !== 1) {
    failA1("INVALID_ARTIFACT", "schema_version must be 1", `${location}.schema_version`);
  }
  if (!Array.isArray(value.input_artifact_ids)) {
    failA1(
      "INVALID_ARTIFACT",
      "input_artifact_ids must be an array",
      `${location}.input_artifact_ids`,
    );
  }
  const inputIds = value.input_artifact_ids.map((item, index) =>
    assertIdentifier(item, `${location}.input_artifact_ids[${index}]`),
  );
  if (new Set(inputIds).size !== inputIds.length) {
    failA1("DUPLICATE_ID", "input artifact ids must be unique", `${location}.input_artifact_ids`);
  }
  if (value.status !== "sealed") {
    failA1(
      "ARTIFACT_NOT_SEALED",
      "only sealed artifacts can enter the registry",
      `${location}.status`,
    );
  }
  const filePath =
    value.file_path === undefined || value.file_path === null
      ? null
      : assertRelativePath(value.file_path, `${location}.file_path`);
  const generation =
    value.generation === undefined || value.generation === null ? null : value.generation;
  if (
    generation !== null &&
    (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0)
  ) {
    failA1(
      "INVALID_ARTIFACT",
      "generation must be a non-negative integer or null",
      `${location}.generation`,
    );
  }
  const producerRunId =
    value.producer_run_id === undefined || value.producer_run_id === null
      ? null
      : assertIdentifier(value.producer_run_id, `${location}.producer_run_id`);
  const candidateId =
    value.candidate_id === undefined || value.candidate_id === null
      ? null
      : assertIdentifier(value.candidate_id, `${location}.candidate_id`);
  const roleId =
    value.role_id === undefined || value.role_id === null
      ? null
      : assertIdentifier(value.role_id, `${location}.role_id`);
  const outputSlot =
    value.output_slot === undefined || value.output_slot === null
      ? null
      : assertIdentifier(value.output_slot, `${location}.output_slot`);
  if (value.source_type !== "workflow_output" && value.source_type !== "fixed_external") {
    failA1(
      "INVALID_ARTIFACT",
      "source_type must be workflow_output or fixed_external",
      `${location}.source_type`,
    );
  }
  const sourceType = value.source_type;
  if (sourceType === "workflow_output") {
    if (producerRunId === null || candidateId === null || generation === null) {
      failA1(
        "INVALID_ARTIFACT",
        "workflow output needs producer_run_id, candidate_id and generation",
        location,
      );
    }
    if (roleId === null || outputSlot === null) {
      failA1("INVALID_ARTIFACT", "workflow output needs role_id and output_slot", location);
    }
  } else if (
    producerRunId !== null ||
    candidateId !== null ||
    roleId !== null ||
    outputSlot !== null
  ) {
    failA1(
      "INVALID_ARTIFACT",
      "fixed external artifacts cannot claim workflow provenance",
      location,
    );
  }
  return {
    schema_version: 1,
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    contract: requireString(value.contract, `${location}.contract`),
    uri: validateUri(value.uri, `${location}.uri`),
    sha256: assertSha256(value.sha256, `${location}.sha256`),
    producer_module: assertIdentifier(value.producer_module, `${location}.producer_module`),
    producer_version: assertIdentifier(value.producer_version, `${location}.producer_version`),
    producer_run_id: producerRunId,
    candidate_id: candidateId,
    input_artifact_ids: inputIds,
    status: "sealed",
    generation: generation as number | null,
    role_id: roleId,
    output_slot: outputSlot,
    source_type: sourceType,
    file_path: filePath,
  };
}

function parseRegistryEntry(
  parsed: unknown,
  filePath: string,
  lineNumber: number,
): ArtifactRegistryEntry {
  if (!isRecord(parsed)) {
    failA1("CORRUPT_ARTIFACT_REGISTRY", `line ${lineNumber} is not an object`, filePath);
  }
  const referenceValue: Record<string, unknown> = { ...parsed };
  delete referenceValue.registered_at;
  const reference = validateArtifactReference(referenceValue, `${filePath}:${lineNumber}`);
  const registeredAt = requireString(
    parsed.registered_at,
    `${filePath}:${lineNumber}.registered_at`,
  );
  if (Number.isNaN(Date.parse(registeredAt))) {
    failA1("CORRUPT_ARTIFACT_REGISTRY", "registered_at must be an ISO-8601 timestamp", filePath);
  }
  return { ...reference, registered_at: registeredAt };
}

function parseRegistryLine(
  line: string,
  filePath: string,
  lineNumber: number,
): ArtifactRegistryEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    failA1("CORRUPT_ARTIFACT_REGISTRY", `invalid JSON at line ${lineNumber}`, filePath);
  }
  return parseRegistryEntry(parsed, filePath, lineNumber);
}

function parseRegistryLines(contents: string, filePath: string): ArtifactRegistryEntry[] {
  const entries: ArtifactRegistryEntry[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = parseRegistryLine(line, filePath, index + 1);
    if (entries.some((candidate) => candidate.artifact_id === entry.artifact_id)) {
      failA1(
        "CORRUPT_ARTIFACT_REGISTRY",
        `artifact '${entry.artifact_id}' is registered more than once`,
        filePath,
      );
    }
    entries.push(entry);
  }
  return entries;
}

function truncateRegistryTail(filePath: string, length: number): void {
  fs.truncateSync(filePath, length);
  const fd = fs.openSync(filePath, fs.constants.O_RDWR);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function appendRegistryBytes(filePath: string, bytes: Buffer): void {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) failA1("ARTIFACT_REGISTRY_WRITE", "artifact index write made no progress");
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * This function is called only while the registry lock is held. A final line
 * without a newline is either a valid record whose terminator was interrupted,
 * or an unparseable short tail from an interrupted append.
 */
function readRegistryUnlocked(filePath: string): ArtifactRegistryEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath);
  if (raw.length === 0) return [];

  if (raw[raw.length - 1] === 0x0a) {
    return parseRegistryLines(raw.toString("utf8"), filePath);
  }

  const boundary = raw.lastIndexOf(0x0a) + 1;
  const completeBytes = raw.subarray(0, boundary);
  const tailText = raw.subarray(boundary).toString("utf8");
  let tailValue: unknown;
  try {
    tailValue = JSON.parse(tailText);
  } catch {
    truncateRegistryTail(filePath, completeBytes.length);
    return parseRegistryLines(completeBytes.toString("utf8"), filePath);
  }

  const entries = parseRegistryLines(completeBytes.toString("utf8"), filePath);
  const tailEntry = parseRegistryEntry(
    tailValue,
    filePath,
    completeBytes.toString("utf8").split("\n").length,
  );
  if (entries.some((entry) => entry.artifact_id === tailEntry.artifact_id)) {
    failA1(
      "CORRUPT_ARTIFACT_REGISTRY",
      `artifact '${tailEntry.artifact_id}' is registered more than once`,
      filePath,
    );
  }
  appendRegistryBytes(filePath, Buffer.from("\n", "utf8"));
  entries.push(tailEntry);
  return entries;
}

function assertRealPathInside(parent: string, child: string, message: string): void {
  let realParent: string;
  let realChild: string;
  try {
    realParent = fs.realpathSync.native(parent);
    realChild = fs.realpathSync.native(child);
  } catch {
    failA1("PATH_ESCAPE", message);
  }
  const relative = path.relative(realParent, realChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    failA1("PATH_ESCAPE", message);
  }
}

function assertRegistryPathInside(projectRoot: string, filePath: string): void {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) failA1("PATH_ESCAPE", "artifact registry project root does not exist");
  const parent = path.dirname(filePath);
  if (fs.existsSync(filePath)) {
    assertRealPathInside(root, filePath, "artifact registry path escapes project root");
    return;
  }
  let existing = parent;
  while (!fs.existsSync(existing)) {
    const next = path.dirname(existing);
    if (next === existing) failA1("PATH_ESCAPE", "artifact registry path has no valid parent");
    existing = next;
  }
  assertRealPathInside(root, existing, "artifact registry directory escapes project root");
}

function validateRegistrySnapshot(
  projectRoot: string,
  entries: readonly ArtifactRegistryEntry[],
  filePath: string,
): void {
  const byId = new Map(entries.map((entry) => [entry.artifact_id, entry]));
  for (const entry of entries) {
    verifyFileHash(projectRoot, entry);
    for (const inputId of entry.input_artifact_ids) {
      if (!byId.has(inputId)) {
        failA1(
          "CORRUPT_ARTIFACT_REGISTRY",
          `artifact '${entry.artifact_id}' references missing input '${inputId}'`,
          filePath,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(artifactId: string): void {
    if (visited.has(artifactId)) return;
    if (visiting.has(artifactId)) {
      failA1("CORRUPT_ARTIFACT_REGISTRY", "artifact lineage contains a cycle", filePath);
    }
    visiting.add(artifactId);
    const entry = byId.get(artifactId);
    if (!entry) {
      failA1("CORRUPT_ARTIFACT_REGISTRY", `artifact '${artifactId}' is missing`, filePath);
    }
    for (const inputId of entry.input_artifact_ids) visit(inputId);
    visiting.delete(artifactId);
    visited.add(artifactId);
  }
  for (const entry of entries) visit(entry.artifact_id);
}

function appendRegistryEntry(filePath: string, entry: ArtifactRegistryEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  appendRegistryBytes(filePath, Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"));
}

function verifyFileHash(projectRoot: string, reference: ArtifactReference): void {
  if (reference.file_path === null) return;
  const target = path.resolve(projectRoot, reference.file_path);
  const relative = path.relative(path.resolve(projectRoot), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    failA1("PATH_ESCAPE", "artifact file_path escapes project root");
  }
  if (!fs.existsSync(target))
    failA1("ARTIFACT_NOT_FOUND", `artifact file does not exist: ${reference.file_path}`);
  if (!fs.statSync(target).isFile())
    failA1("ARTIFACT_NOT_FOUND", `artifact is not a file: ${reference.file_path}`);
  assertRealPathInside(
    projectRoot,
    target,
    `artifact '${reference.artifact_id}' file_path escapes project root`,
  );
  const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (digest !== reference.sha256) {
    failA1(
      "ARTIFACT_HASH_MISMATCH",
      `artifact '${reference.artifact_id}' hash does not match its file`,
    );
  }
}

export function crossCheckArtifactIdentity(input: {
  artifact_id: string;
  directory_artifact_id: string;
  manifest_artifact_id: string;
  command_artifact_id: string;
}): void {
  const values = [
    input.artifact_id,
    input.directory_artifact_id,
    input.manifest_artifact_id,
    input.command_artifact_id,
  ];
  values.forEach((value, index) => assertIdentifier(value, `artifact_identity[${index}]`));
  if (new Set(values).size !== 1) {
    failA1("IDENTITY_MISMATCH", "artifact path, manifest and command ids must agree");
  }
}

function sameEntry(existing: ArtifactRegistryEntry, reference: ArtifactReference): boolean {
  return (
    canonicalJsonString(existing) ===
    canonicalJsonString({ ...reference, registered_at: existing.registered_at })
  );
}

export function createArtifactRegistry(projectRoot: string, runId: string): ArtifactRegistry {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const safeRunId = runId;
  const filePath = registryPath(resolvedProjectRoot, safeRunId);

  function withSnapshot<T>(reader: (entries: ArtifactRegistryEntry[]) => T): T {
    const filePath = registryPath(resolvedProjectRoot, safeRunId);
    assertRegistryPathInside(resolvedProjectRoot, filePath);
    return withStateFileLock(filePath, () => {
      assertRegistryPathInside(resolvedProjectRoot, filePath);
      const entries = readRegistryUnlocked(filePath);
      validateRegistrySnapshot(resolvedProjectRoot, entries, filePath);
      return reader(entries);
    });
  }

  function list(): ArtifactRegistryEntry[] {
    return withSnapshot((entries) =>
      entries.map((entry) => ({ ...entry, input_artifact_ids: [...entry.input_artifact_ids] })),
    );
  }

  function get(artifactId: string): ArtifactRegistryEntry {
    const safeId = assertIdentifier(artifactId, "artifact_id");
    return withSnapshot((entries) => {
      const entry = entries.find((candidate) => candidate.artifact_id === safeId);
      if (!entry) failA1("ARTIFACT_NOT_FOUND", `artifact '${safeId}' is not registered`);
      return { ...entry, input_artifact_ids: [...entry.input_artifact_ids] };
    });
  }

  function findByCandidate(candidateId: string, producerRunId?: string): ArtifactRegistryEntry[] {
    const safeCandidateId = assertIdentifier(candidateId, "candidate_id");
    const safeProducerRunId =
      producerRunId === undefined ? undefined : assertIdentifier(producerRunId, "producer_run_id");
    return withSnapshot((entries) =>
      entries
        .filter(
          (entry) =>
            entry.source_type === "workflow_output" &&
            entry.candidate_id === safeCandidateId &&
            (safeProducerRunId === undefined || entry.producer_run_id === safeProducerRunId),
        )
        .map((entry) => ({ ...entry, input_artifact_ids: [...entry.input_artifact_ids] })),
    );
  }

  function register(referenceValue: unknown): ArtifactRegistryEntry {
    const filePath = registryPath(resolvedProjectRoot, safeRunId);
    const reference = validateArtifactReference(referenceValue);
    if (reference.source_type === "workflow_output" && reference.producer_run_id !== safeRunId)
      failA1(
        "ARTIFACT_PROVENANCE_MISMATCH",
        `workflow output producer_run_id must equal registry run '${safeRunId}'`,
      );
    assertRegistryPathInside(resolvedProjectRoot, filePath);
    return withStateFileLock(filePath, () => {
      assertRegistryPathInside(resolvedProjectRoot, filePath);
      // Verify immediately before append. A file may have changed after the
      // caller constructed the reference but before it acquired the lock.
      verifyFileHash(resolvedProjectRoot, reference);
      const entries = readRegistryUnlocked(filePath);
      validateRegistrySnapshot(resolvedProjectRoot, entries, filePath);
      const existing = entries.find((entry) => entry.artifact_id === reference.artifact_id);
      if (existing) {
        if (sameEntry(existing, reference)) return existing;
        failA1(
          "ARTIFACT_CONFLICT",
          `artifact '${reference.artifact_id}' is already registered with different content`,
        );
      }
      for (const inputId of reference.input_artifact_ids) {
        if (!entries.some((entry) => entry.artifact_id === inputId)) {
          failA1("ARTIFACT_NOT_FOUND", `input artifact '${inputId}' is not registered`);
        }
      }
      const entry: ArtifactRegistryEntry = {
        ...reference,
        registered_at: new Date().toISOString(),
      };
      appendRegistryEntry(filePath, entry);
      return entry;
    });
  }

  function assertSealed(artifactId: string): ArtifactRegistryEntry {
    const entry = get(artifactId);
    if (entry.status !== "sealed") {
      failA1("ARTIFACT_NOT_SEALED", `artifact '${artifactId}' is not sealed`);
    }
    return entry;
  }

  function assertFixedExternal(artifactId: string): ArtifactRegistryEntry {
    const safeId = assertIdentifier(artifactId, "artifact_id");
    return withSnapshot((entries) => {
      const byId = new Map(entries.map((entry) => [entry.artifact_id, entry]));
      const entry = byId.get(safeId);
      if (!entry) failA1("ARTIFACT_NOT_FOUND", `artifact '${safeId}' is not registered`);
      if (entry.status !== "sealed")
        failA1("ARTIFACT_NOT_SEALED", `artifact '${safeId}' is not sealed`);
      if (entry.source_type !== "fixed_external")
        failA1(
          "MODEL_SCOPE_ALIGNMENT_REQUIRED",
          `artifact '${safeId}' is a workflow output, not a fixed external artifact`,
        );
      const visited = new Set<string>();
      const visit = (currentId: string): void => {
        if (visited.has(currentId)) return;
        visited.add(currentId);
        const current = byId.get(currentId);
        if (!current) failA1("ARTIFACT_NOT_FOUND", `artifact '${currentId}' is not registered`);
        if (current.source_type === "workflow_output")
          failA1(
            "MODEL_SCOPE_ALIGNMENT_REQUIRED",
            `fixed external artifact '${safeId}' has workflow-produced lineage`,
          );
        for (const inputId of current.input_artifact_ids) visit(inputId);
      };
      for (const inputId of entry.input_artifact_ids) visit(inputId);
      return { ...entry, input_artifact_ids: [...entry.input_artifact_ids] };
    });
  }

  function isDescendant(artifactId: string, ancestorArtifactId: string): boolean {
    const target = assertIdentifier(artifactId, "artifact_id");
    const ancestor = assertIdentifier(ancestorArtifactId, "ancestor_artifact_id");
    return withSnapshot((entries) => {
      const byId = new Map(entries.map((entry) => [entry.artifact_id, entry]));
      if (!byId.has(target)) failA1("ARTIFACT_NOT_FOUND", `artifact '${target}' is not registered`);
      if (!byId.has(ancestor))
        failA1("ARTIFACT_NOT_FOUND", `artifact '${ancestor}' is not registered`);
      const visited = new Set<string>();
      function visit(currentId: string): boolean {
        if (visited.has(currentId)) return false;
        visited.add(currentId);
        const current = byId.get(currentId);
        if (!current) failA1("ARTIFACT_NOT_FOUND", `artifact '${currentId}' is not registered`);
        if (currentId === ancestor) return true;
        return current.input_artifact_ids.some((inputId) => visit(inputId));
      }
      return visit(target);
    });
  }

  function assertNoSelfEvaluation(
    candidateArtifactIds: readonly string[],
    judgeArtifactIds: readonly string[],
  ): void {
    const candidateIds = candidateArtifactIds.map((id) =>
      assertIdentifier(id, "candidate_artifact_id"),
    );
    const judgeIds = judgeArtifactIds.map((id) => assertIdentifier(id, "judge_artifact_id"));
    withSnapshot((entries) => {
      const byId = new Map(entries.map((entry) => [entry.artifact_id, entry]));
      for (const artifactId of [...candidateIds, ...judgeIds]) {
        if (!byId.has(artifactId))
          failA1("ARTIFACT_NOT_FOUND", `artifact '${artifactId}' is not registered`);
      }
      const descendants = (targetId: string, ancestorId: string): boolean => {
        const visited = new Set<string>();
        function visit(currentId: string): boolean {
          if (visited.has(currentId)) return false;
          visited.add(currentId);
          const current = byId.get(currentId);
          if (!current) failA1("ARTIFACT_NOT_FOUND", `artifact '${currentId}' is not registered`);
          if (currentId === ancestorId) return true;
          return current.input_artifact_ids.some((inputId) => visit(inputId));
        }
        return visit(targetId);
      };
      for (const judgeId of judgeIds) {
        for (const candidateId of candidateIds) {
          if (descendants(judgeId, candidateId)) {
            failA1(
              "JUDGE_LAG_VIOLATION",
              `judge artifact '${judgeId}' is produced by candidate lineage '${candidateId}'`,
            );
          }
        }
      }
    });
  }

  return {
    projectRoot: resolvedProjectRoot,
    runId: safeRunId,
    filePath,
    register,
    list,
    get,
    assertSealed,
    assertFixedExternal,
    findByCandidate,
    isDescendant,
    assertNoSelfEvaluation,
  };
}

export function assertNoSelfEvaluationByLineage(input: {
  registry: ArtifactRegistry;
  candidate_artifact_ids: readonly string[];
  candidate_output_artifact_ids: readonly string[];
  judge_artifact_ids: readonly string[];
}): void {
  const forbidden = [...input.candidate_artifact_ids, ...input.candidate_output_artifact_ids];
  input.registry.assertNoSelfEvaluation(forbidden, input.judge_artifact_ids);
}

export function artifactRegistryLockPath(projectRoot: string, runId: string): string {
  return stateLockPath(registryPath(projectRoot, runId));
}
