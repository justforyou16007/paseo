import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { anyJsonSchema, canonicalJsonBytes, canonicalJsonSha256 } from "./canonical-json.js";
import { computeWikiCommandId } from "./wiki-command-id.js";
import { readStateFile, withStateFileLock, writeStateFileAtomic } from "./state-file.js";
import { validateWikiPayload } from "./wiki-operations.js";
import { validateWikiScope } from "./wiki-scope.js";

export const WIKI_SCHEMA_VERSION = 2;
export const WIKI_SCHEMA_FILE = "schema.json";
export const WIKI_EVENTS_FILE = "events.jsonl";

export interface WikiProducer {
  kind: string;
  scope: string;
  subject_id: string;
}

export interface WikiEvent {
  schema_version: 2;
  seq: number;
  event_id: string;
  command_id: string;
  payload_sha256: string;
  previous_event_hash: string | null;
  committed_at: string;
  evidence_bundle_id: string;
  producer: WikiProducer;
  event_type: string;
  payload: unknown;
}

export interface WikiDelta {
  producer_kind: string;
  scope: string;
  subject_id: string;
  evidence_bundle_id: string;
  payload: unknown;
  event_type?: string;
}

export type WikiAppendResult =
  | { status: "appended"; event: WikiEvent }
  | { status: "skipped"; event: WikiEvent }
  | { status: "conflict"; command_id: string; existing: WikiEvent };

export interface WikiAppendOptions {
  /**
   * Infrastructure-only retry guard. The store still recomputes the command
   * ID and never accepts this value as the authority written to an event.
   */
  expectedCommandId?: string;
}

export interface WikiSchemaDocument {
  schema_version: 2;
  format: "aris-research-wiki";
  event_log: "events.jsonl";
  canonicalization: "RFC8785-equivalent";
  projection_version: 1;
}

const HEX64 = /^[0-9a-f]{64}$/;

export class WikiSchemaUnsupportedError extends Error {
  readonly code = "WIKI_SCHEMA_UNSUPPORTED";

  constructor(message: string) {
    super(`WIKI_SCHEMA_UNSUPPORTED: ${message}`);
    this.name = "WikiSchemaUnsupportedError";
  }
}

export function wikiEventsPath(wikiRoot: string): string {
  return path.join(path.resolve(wikiRoot), WIKI_EVENTS_FILE);
}

export function wikiSchemaPath(wikiRoot: string): string {
  return path.join(path.resolve(wikiRoot), WIKI_SCHEMA_FILE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nowUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid Wiki event: ${label} must be a non-empty string`);
  }
}

function assertSchemaDocument(value: unknown, schemaPath: string): WikiSchemaDocument {
  const allowedKeys = new Set([
    "schema_version",
    "format",
    "event_log",
    "canonicalization",
    "projection_version",
  ]);
  if (
    !isObject(value) ||
    value.schema_version !== WIKI_SCHEMA_VERSION ||
    value.format !== "aris-research-wiki" ||
    value.event_log !== WIKI_EVENTS_FILE ||
    value.canonicalization !== "RFC8785-equivalent" ||
    value.projection_version !== 1
  ) {
    throw new WikiSchemaUnsupportedError(`unsupported schema at ${schemaPath}`);
  }
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WikiSchemaUnsupportedError(`unsupported schema at ${schemaPath}`);
  }
  return value as unknown as WikiSchemaDocument;
}

export function readWikiSchema(wikiRoot: string): WikiSchemaDocument {
  const schemaPath = wikiSchemaPath(wikiRoot);
  if (!fs.existsSync(schemaPath)) {
    throw new WikiSchemaUnsupportedError(
      `${path.resolve(wikiRoot)} has no schema.json; old page-only Wikis are not migrated`,
    );
  }
  try {
    return assertSchemaDocument(readStateFile(schemaPath), schemaPath);
  } catch (error: unknown) {
    if (error instanceof WikiSchemaUnsupportedError) throw error;
    throw new WikiSchemaUnsupportedError(`cannot read schema.json at ${schemaPath}`);
  }
}

export function assertWikiSchemaSupported(wikiRoot: string): WikiSchemaDocument {
  const schema = readWikiSchema(wikiRoot);
  const eventsPath = wikiEventsPath(wikiRoot);
  if (!fs.existsSync(eventsPath) || !fs.statSync(eventsPath).isFile()) {
    throw new WikiSchemaUnsupportedError(`schema v2 Wiki is missing ${WIKI_EVENTS_FILE}`);
  }
  return schema;
}

export function initializeWikiSchema(wikiRoot: string): void {
  const root = path.resolve(wikiRoot);
  fs.mkdirSync(root, { recursive: true });
  withWikiEventLock(root, () => {
    const entries = fs.readdirSync(root).filter((entry) => entry !== `${WIKI_EVENTS_FILE}.lock`);
    const schemaPath = wikiSchemaPath(root);
    const eventsPath = wikiEventsPath(root);
    if (fs.existsSync(schemaPath)) {
      // A schema without its fact log is an unsafe, incomplete Wiki. Never
      // recreate an empty log here: doing so would silently erase history.
      assertWikiSchemaSupported(root);
      return;
    }
    if (entries.length > 0) {
      throw new WikiSchemaUnsupportedError(
        `${root} contains files without schema.json; choose an empty directory or a new wiki_root`,
      );
    }

    const schema: WikiSchemaDocument = {
      schema_version: WIKI_SCHEMA_VERSION,
      format: "aris-research-wiki",
      event_log: WIKI_EVENTS_FILE,
      canonicalization: "RFC8785-equivalent",
      projection_version: 1,
    };
    // Create the fact log before the schema. A crash can leave an unusable
    // directory, but never a schema that invites an empty-log replacement.
    writeStateFileAtomic(eventsPath, "");
    writeStateFileAtomic(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  });
}

function assertNoAgentCommandId(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAgentCommandId(item, `${location}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  if (Object.hasOwn(value, "command_id")) {
    throw new Error(`${location}.command_id is agent-supplied and forbidden`);
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoAgentCommandId(child, `${location}.${key}`);
  }
}

function validateDelta(delta: WikiDelta): void {
  if (!isObject(delta)) throw new Error("Wiki delta must be an object");
  if (Object.hasOwn(delta, "command_id")) {
    throw new Error("agent-supplied command_id is forbidden; the system computes it");
  }
  const deltaKeys = new Set([
    "producer_kind",
    "scope",
    "subject_id",
    "evidence_bundle_id",
    "payload",
    "event_type",
  ]);
  for (const key of Object.keys(delta)) {
    if (!deltaKeys.has(key)) throw new Error(`invalid Wiki delta: unknown field '${key}'`);
  }
  assertString(delta.producer_kind, "producer_kind");
  assertString(delta.scope, "scope");
  validateWikiScope(delta.scope);
  assertString(delta.subject_id, "subject_id");
  assertString(delta.evidence_bundle_id, "evidence_bundle_id");
  if (delta.event_type !== undefined) assertString(delta.event_type, "event_type");
  assertNoAgentCommandId(delta.payload, "payload");
  validateWikiPayload(delta.payload);
}

interface PreparedWikiDelta {
  payloadHash: string;
  computedCommandId: string;
  commandId: string;
}

function prepareDelta(delta: WikiDelta, options: WikiAppendOptions): PreparedWikiDelta {
  // Do this before taking the lock. Apart from making validation cheap for the
  // caller, it prevents a rejected append from repairing an unrelated tail.
  validateDelta(delta);
  const payloadHash = canonicalJsonSha256(delta.payload, anyJsonSchema);
  const computedCommandId = computeWikiCommandId({
    producer_kind: delta.producer_kind,
    scope: delta.scope,
    subject_id: delta.subject_id,
    evidence_bundle_id: delta.evidence_bundle_id,
    canonical_payload_sha256: payloadHash,
  });
  const commandId = options.expectedCommandId ?? computedCommandId;
  if (!/^command:sha256:[0-9a-f]{64}$/.test(commandId)) {
    throw new Error("expectedCommandId must be a system-generated command ID");
  }
  return { payloadHash, computedCommandId, commandId };
}

function eventHash(eventWithoutId: Omit<WikiEvent, "event_id">): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJsonBytes(eventWithoutId, anyJsonSchema))
    .digest("hex");
}

export function wikiEventHash(event: WikiEvent): string {
  const { event_id: _eventId, ...withoutId } = event;
  return eventHash(withoutId);
}

function parseEvent(value: unknown, filePath: string, lineNumber: number): WikiEvent {
  if (!isObject(value)) throw new Error(`invalid Wiki event at ${filePath}:${lineNumber}`);
  const envelopeKeys = new Set([
    "schema_version",
    "seq",
    "event_id",
    "command_id",
    "payload_sha256",
    "previous_event_hash",
    "committed_at",
    "evidence_bundle_id",
    "producer",
    "event_type",
    "payload",
  ]);
  for (const key of Object.keys(value)) {
    if (!envelopeKeys.has(key)) {
      throw new Error(`invalid Wiki event at ${filePath}:${lineNumber}: unknown field '${key}'`);
    }
  }
  if (
    value.schema_version !== WIKI_SCHEMA_VERSION ||
    !Number.isInteger(value.seq) ||
    (value.seq as number) < 1 ||
    typeof value.event_id !== "string" ||
    typeof value.command_id !== "string" ||
    typeof value.payload_sha256 !== "string" ||
    !(value.previous_event_hash === null || typeof value.previous_event_hash === "string") ||
    typeof value.committed_at !== "string" ||
    typeof value.evidence_bundle_id !== "string" ||
    !isObject(value.producer) ||
    typeof value.event_type !== "string" ||
    !Object.hasOwn(value, "payload")
  ) {
    throw new Error(`invalid Wiki event envelope at ${filePath}:${lineNumber}`);
  }
  const producer = value.producer;
  for (const key of Object.keys(producer)) {
    if (!["kind", "scope", "subject_id"].includes(key)) {
      throw new Error(`invalid Wiki producer at ${filePath}:${lineNumber}: unknown field '${key}'`);
    }
  }
  assertString(producer.kind, `producer.kind at ${filePath}:${lineNumber}`);
  assertString(producer.scope, `producer.scope at ${filePath}:${lineNumber}`);
  assertString(producer.subject_id, `producer.subject_id at ${filePath}:${lineNumber}`);
  validateWikiScope(producer.scope);
  if (!HEX64.test(value.payload_sha256 as string)) {
    throw new Error(`invalid payload_sha256 at ${filePath}:${lineNumber}`);
  }
  if (value.previous_event_hash !== null && !HEX64.test(value.previous_event_hash as string)) {
    throw new Error(`invalid previous_event_hash at ${filePath}:${lineNumber}`);
  }
  if (!/^event:sha256:[0-9a-f]{64}$/.test(value.event_id as string)) {
    throw new Error(`invalid event_id at ${filePath}:${lineNumber}`);
  }
  if (!/^command:sha256:[0-9a-f]{64}$/.test(value.command_id as string)) {
    throw new Error(`invalid command_id at ${filePath}:${lineNumber}`);
  }

  const event = value as unknown as WikiEvent;
  assertNoAgentCommandId(event.payload, "payload");
  validateWikiPayload(event.payload);
  const expectedPayloadHash = canonicalJsonSha256(event.payload, anyJsonSchema);
  if (expectedPayloadHash !== event.payload_sha256) {
    throw new Error(`payload hash mismatch at ${filePath}:${lineNumber}`);
  }
  const expectedCommandId = computeWikiCommandId({
    producer_kind: producer.kind,
    scope: producer.scope,
    subject_id: producer.subject_id,
    evidence_bundle_id: event.evidence_bundle_id,
    canonical_payload_sha256: event.payload_sha256,
  });
  if (expectedCommandId !== event.command_id) {
    throw new Error(`command_id mismatch at ${filePath}:${lineNumber}`);
  }
  const expectedHash = eventHash({
    schema_version: event.schema_version,
    seq: event.seq,
    command_id: event.command_id,
    payload_sha256: event.payload_sha256,
    previous_event_hash: event.previous_event_hash,
    committed_at: event.committed_at,
    evidence_bundle_id: event.evidence_bundle_id,
    producer: event.producer,
    event_type: event.event_type,
    payload: event.payload,
  });
  if (event.event_id !== `event:sha256:${expectedHash}`) {
    throw new Error(`event hash mismatch at ${filePath}:${lineNumber}`);
  }
  return event;
}

function readEventsLocked(wikiRoot: string): WikiEvent[] {
  assertWikiSchemaSupported(wikiRoot);
  const eventsPath = wikiEventsPath(wikiRoot);
  if (!fs.existsSync(eventsPath)) return [];
  const bytes = fs.readFileSync(eventsPath);
  if (bytes.length === 0) return [];

  const text = bytes.toString("utf-8");
  const rawLines = text.split("\n");
  const hasFinalNewline = bytes.at(-1) === 0x0a;
  // A newline is part of the commit record. The last segment of a file that
  // lacks it is never parsed, even when it happens to be valid JSON with valid
  // hashes. This avoids turning a crash fragment into a committed fact.
  const contentLines = rawLines.slice(0, -1);
  const events: WikiEvent[] = [];

  const truncateToLastCompleteLine = (): void => {
    const fd = fs.openSync(eventsPath, fs.constants.O_RDWR);
    try {
      const lastNewline = bytes.lastIndexOf(0x0a);
      fs.ftruncateSync(fd, lastNewline < 0 ? 0 : lastNewline + 1);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  for (let index = 0; index < contentLines.length; index += 1) {
    const line = contentLines[index]!;
    if (line.trim() === "") {
      throw new Error(`WIKI_EVENT_LOG_CORRUPT: blank event line at ${eventsPath}:${index + 1}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error: unknown) {
      throw new Error(`WIKI_EVENT_LOG_CORRUPT: invalid JSON at ${eventsPath}:${index + 1}`);
    }
    try {
      events.push(parseEvent(parsed, eventsPath, index + 1));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`WIKI_EVENT_LOG_CORRUPT: ${message}`);
    }
  }

  let previousHash: string | null = null;
  const commands = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.seq !== index + 1) {
      throw new Error(`WIKI_EVENT_LOG_CORRUPT: sequence break at ${eventsPath}:${index + 1}`);
    }
    if (event.previous_event_hash !== previousHash) {
      throw new Error(`WIKI_EVENT_LOG_CORRUPT: hash chain break at ${eventsPath}:${index + 1}`);
    }
    if (commands.has(event.command_id)) {
      throw new Error(`WIKI_EVENT_LOG_CORRUPT: duplicate command_id at ${eventsPath}:${index + 1}`);
    }
    commands.add(event.command_id);
    previousHash = event.event_id.slice("event:sha256:".length);
  }
  if (!hasFinalNewline) truncateToLastCompleteLine();
  return events;
}

export function withWikiEventLock<T>(wikiRoot: string, action: () => T): T {
  const root = path.resolve(wikiRoot);
  fs.mkdirSync(root, { recursive: true });
  return withStateFileLock(wikiEventsPath(root), action);
}

export function readWikiEvents(wikiRoot: string): WikiEvent[] {
  return withWikiEventLock(wikiRoot, () => readEventsLocked(path.resolve(wikiRoot)));
}

/** Caller must already hold withWikiEventLock for this variant. */
export function readWikiEventsLocked(wikiRoot: string): WikiEvent[] {
  return readEventsLocked(path.resolve(wikiRoot));
}

function appendWikiEventLocked(
  wikiRoot: string,
  delta: WikiDelta,
  existing: WikiEvent[],
  options: WikiAppendOptions = {},
  prepared: PreparedWikiDelta = prepareDelta(delta, options),
): WikiAppendResult {
  const { payloadHash, computedCommandId, commandId } = prepared;
  const sameCommand = existing.find((event) => event.command_id === commandId);
  if (sameCommand) {
    if (sameCommand.payload_sha256 === payloadHash) {
      return { status: "skipped", event: sameCommand };
    }
    return { status: "conflict", command_id: commandId, existing: sameCommand };
  }
  if (commandId !== computedCommandId) throw new Error("prepared Wiki delta is inconsistent");

  const previous = existing[existing.length - 1];
  const eventWithoutId: Omit<WikiEvent, "event_id"> = {
    schema_version: WIKI_SCHEMA_VERSION,
    seq: existing.length + 1,
    command_id: commandId,
    payload_sha256: payloadHash,
    previous_event_hash: previous ? previous.event_id.slice("event:sha256:".length) : null,
    committed_at: nowUtcIso(),
    evidence_bundle_id: delta.evidence_bundle_id,
    producer: {
      kind: delta.producer_kind,
      scope: delta.scope,
      subject_id: delta.subject_id,
    },
    event_type: delta.event_type ?? "knowledge_delta_committed",
    payload: delta.payload,
  };
  const event: WikiEvent = {
    ...eventWithoutId,
    event_id: `event:sha256:${eventHash(eventWithoutId)}`,
  };
  const line = `${canonicalJsonBytes(event, anyJsonSchema).toString("utf-8")}\n`;
  const eventsPath = wikiEventsPath(wikiRoot);
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const lineBytes = Buffer.from(line, "utf-8");
  const fd = fs.openSync(
    eventsPath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < lineBytes.length) {
      const written = fs.writeSync(fd, lineBytes, offset, lineBytes.length - offset);
      if (written <= 0) throw new Error("failed to append a complete Wiki event line");
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { status: "appended", event };
}

export function appendWikiEvent(
  wikiRoot: string,
  delta: WikiDelta,
  options: WikiAppendOptions = {},
): WikiAppendResult {
  const prepared = prepareDelta(delta, options);
  return withWikiEventLock(wikiRoot, () => {
    const existing = readEventsLocked(path.resolve(wikiRoot));
    return appendWikiEventLocked(path.resolve(wikiRoot), delta, existing, options, prepared);
  });
}

export function commitWikiChange(
  wikiRoot: string,
  build: (events: readonly WikiEvent[]) => WikiDelta | null,
  project: (events: readonly WikiEvent[]) => void,
): WikiAppendResult | { status: "skipped"; event: null } {
  return withWikiEventLock(wikiRoot, () => {
    const root = path.resolve(wikiRoot);
    const existing = readEventsLocked(root);
    const delta = build(existing);
    if (delta === null) {
      project(existing);
      return { status: "skipped", event: null };
    }
    const result = appendWikiEventLocked(root, delta, existing);
    if (result.status === "appended") project([...existing, result.event]);
    else project(existing);
    return result;
  });
}

export function eventLogHead(events: readonly WikiEvent[]): {
  seq: number;
  event_id: string | null;
  event_hash: string | null;
} {
  const last = events[events.length - 1];
  return {
    seq: last?.seq ?? 0,
    event_id: last?.event_id ?? null,
    event_hash: last ? last.event_id.slice("event:sha256:".length) : null,
  };
}
