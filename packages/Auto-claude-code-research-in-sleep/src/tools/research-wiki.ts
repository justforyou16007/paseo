#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { createCli, runCli } from "../lib/cli.js";
import { quarantine } from "./threat-scan.js";
import { anyJsonSchema, canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertWikiSchemaSupported,
  commitWikiChange,
  eventLogHead,
  initializeWikiSchema,
  readWikiEvents,
  readWikiEventsLocked,
  type WikiDelta,
  type WikiEvent,
  type WikiAppendResult,
} from "./wiki-event-store.js";
import {
  WIKI_EDGE_TYPES,
  WIKI_SIGNAL_KINDS,
  WIKI_SIGNAL_SOURCES,
  isWikiEdgeType,
  parseWikiPayload,
  type WikiPayloadContext,
  type WikiSignal,
  type WikiSignalKind,
  type WikiSignalSource,
} from "./wiki-operations.js";
import {
  projectWiki,
  projectWikiFromEvents,
  queryWiki as projectQueryWiki,
  readWikiModel,
  replayWikiEvents,
  type WikiModel,
  type WikiPageKind,
  type WikiQueryRequest,
} from "./wiki-projector.js";
import {
  assertOuterWikiScope,
  assertResearchVisible,
  resolveRunWikiScope,
  runWikiRoot,
  validateWikiScope,
} from "./wiki-scope.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";
import { readVerifiedTesterFeedback, verifyTesterFeedback } from "./tester-public-receipt.js";
import { exportResultPackage, planResultExport } from "./result-export.js";
import { saveResultReview } from "./result-review.js";
import type { ResultStatus } from "./result-package.js";
import { canonicalStatePath, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import crypto from "node:crypto";
import type { WikiHead } from "./wiki-projector.js";

export interface RunWikiBinding {
  wiki_root: string;
  wiki_head: WikiHead;
  input_snapshot: { ref: string; sha256: string } | null;
}

export const WIKI_MODULE_WORKERS = [
  "idea-discovery",
  "idea-creator",
  "experiment-bridge",
  "analyze-results",
  "result-to-claim",
] as const;
type WikiWorker = (typeof WIKI_MODULE_WORKERS)[number] | "scorer-loop" | "tester";

export interface WikiWorkerManifestInput {
  project_root: string;
  run_id: string;
  worker: WikiWorker;
  scope?: string;
  input_snapshot?: { ref: string; sha256: string } | null;
}

type WikiManifestIdentity = {
  project_root: string;
  run_id: string;
  scope: string;
  input_snapshot_sha256?: string | null;
};

export type WikiWorkerManifest = WikiManifestIdentity &
  ({ role: "tester" } | ({ role: "module" | "scorer" } & RunWikiBinding));

export function wikiWorkerManifestPath(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, runId, "input-manifest.json");
}

function assertInputSnapshot(
  input: Pick<WikiWorkerManifestInput, "project_root" | "run_id" | "input_snapshot">,
): void {
  const run = requireRunContract(input.project_root, input.run_id);
  const snapshot = input.input_snapshot;
  if (snapshot == null) {
    if (run.parent_run_id !== null) throw new Error("PARENT_INPUT_SNAPSHOT_REQUIRED");
    return;
  }
  const localRoot = runOwnedPath(input.project_root, input.run_id);
  const ref = path.resolve(input.project_root, snapshot.ref);
  const relative = path.relative(canonicalStatePath(localRoot), canonicalStatePath(ref));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("INPUT_SNAPSHOT_ESCAPE");
  const bytes = fs.readFileSync(ref);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== snapshot.sha256 || run.output_hashes[relative] !== hash)
    throw new Error("INPUT_SNAPSHOT_NOT_SEALED");
  const payload: unknown = JSON.parse(bytes.toString("utf8"));
  assertResearchVisible(payload);
  if (
    !isObject(payload) ||
    payload.input_snapshot_sha256 !== run.identity_material.input_snapshot_sha256
  )
    throw new Error("INPUT_SNAPSHOT_MISMATCH");
}

/** The dispatch manifest is the only persisted Wiki binding; retries read its old head. */
export function sealWikiWorkerManifest(input: WikiWorkerManifestInput): WikiWorkerManifest {
  const allowed = ["project_root", "run_id", "worker", "scope", "input_snapshot"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("UNKNOWN_WORKER_MANIFEST_FIELD");
  if (![...WIKI_MODULE_WORKERS, "scorer-loop", "tester"].includes(input.worker))
    throw new Error("INVALID_WORKER_IDENTITY");
  const runScope = resolveRunWikiScope(input.project_root, input.run_id);
  const scope = input.worker === "scorer-loop" ? `${runScope}/scorers/${input.run_id}` : runScope;
  if (input.scope !== undefined && input.scope !== scope) throw new Error("WIKI_SCOPE_CONFLICT");
  const file = wikiWorkerManifestPath(input.project_root, input.run_id);
  return withStateFileLock(file, () => {
    const existing = fs.existsSync(file) ? readJsonObject(file) : null;
    const base = {
      project_root: path.resolve(input.project_root),
      run_id: input.run_id,
      scope,
    };
    const role =
      input.worker === "tester" ? "tester" : input.worker === "scorer-loop" ? "scorer" : "module";
    if (existing && existing.role !== role) throw new Error("IMMUTABLE_WORKER_MANIFEST_CONFLICT");
    let manifest: WikiWorkerManifest;
    if (input.worker !== "tester") {
      assertInputSnapshot(input);
      const wikiRoot = runWikiRoot(input.project_root, input.run_id);
      initializeWikiSchema(wikiRoot);
      const head =
        (existing?.wiki_head as WikiHead | undefined) ??
        eventLogHead(readWikiEventsLocked(wikiRoot));
      manifest = {
        ...base,
        input_snapshot_sha256: requireRunContract(input.project_root, input.run_id)
          .identity_material.input_snapshot_sha256,
        role: input.worker === "scorer-loop" ? "scorer" : "module",
        wiki_root: wikiRoot,
        wiki_head: head,
        input_snapshot: input.input_snapshot ?? null,
      };
      // Validate the complete hash, including the empty-prefix case.
      const actual = eventLogHead(readWikiEventsLocked(wikiRoot).slice(0, head.seq));
      if (canonicalJsonSha256(actual, anyJsonSchema) !== canonicalJsonSha256(head, anyJsonSchema))
        throw new Error("WIKI_HEAD_MISMATCH");
    } else {
      if (input.input_snapshot !== undefined) throw new Error("TESTER_MANIFEST_INPUT_FORBIDDEN");
      manifest = { ...base, role: "tester" };
    }
    assertResearchVisible(manifest);
    if (
      existing &&
      canonicalJsonSha256(existing, anyJsonSchema) !== canonicalJsonSha256(manifest, anyJsonSchema)
    )
      throw new Error("IMMUTABLE_WORKER_MANIFEST_CONFLICT");
    if (!existing) writeStateJsonAtomic(file, manifest);
    return manifest;
  });
}

/** Read and verify a previously sealed binding without advancing its Wiki head. */
export function readWikiWorkerManifest(projectRoot: string, runId: string): WikiWorkerManifest {
  const file = wikiWorkerManifestPath(projectRoot, runId);
  if (!fs.existsSync(file)) throw new Error("WORKER_MANIFEST_REQUIRED");
  const raw = readJsonObject(file);
  const run = requireRunContract(projectRoot, runId);
  const scope = resolveRunWikiScope(projectRoot, runId);
  if (
    raw.project_root !== path.resolve(projectRoot) ||
    raw.run_id !== runId ||
    raw.scope !== (raw.role === "scorer" ? `${scope}/scorers/${runId}` : scope) ||
    (raw.role !== "tester" &&
      raw.input_snapshot_sha256 !== run.identity_material.input_snapshot_sha256)
  )
    throw new Error("IMMUTABLE_WORKER_MANIFEST_CONFLICT");
  if (raw.role === "tester") {
    if (Object.keys(raw).some((key) => !["project_root", "run_id", "scope", "role"].includes(key)))
      throw new Error("TESTER_MANIFEST_INPUT_FORBIDDEN");
  } else {
    if (raw.role !== "module" && raw.role !== "scorer") throw new Error("INVALID_WORKER_IDENTITY");
    const binding = raw as unknown as WikiWorkerManifestInput;
    assertInputSnapshot(binding);
    if (raw.wiki_root !== runWikiRoot(projectRoot, runId) || !isObject(raw.wiki_head))
      throw new Error("WIKI_SCOPE_CONFLICT");
    const head = raw.wiki_head as unknown as WikiHead;
    if (!Number.isSafeInteger(head.seq) || head.seq < 0) throw new Error("WIKI_HEAD_MISMATCH");
    const actual = eventLogHead(readWikiEventsLocked(raw.wiki_root).slice(0, head.seq));
    if (canonicalJsonSha256(actual, anyJsonSchema) !== canonicalJsonSha256(head, anyJsonSchema))
      throw new Error("WIKI_HEAD_MISMATCH");
  }
  assertResearchVisible(raw);
  return raw as unknown as WikiWorkerManifest;
}

export interface ResearchWikiQueryRequest extends WikiQueryRequest {
  manifest_path?: string;
  consumer?: "research" | "outer-gate" | "stop-gate" | "candidate-selection";
}

/** Public query entry. The projector is a storage primitive, not a worker API. */
export function queryWiki(wikiRoot: string, request: ResearchWikiQueryRequest) {
  if (/tester|sanitizer/i.test(request.requester)) throw new Error("WIKI_QUERY_IDENTITY_FORBIDDEN");
  if (request.consumer !== undefined && request.consumer !== "research")
    assertOuterWikiScope(request.scope, request.allow_standalone);
  let bounded = request;
  if (request.manifest_path !== undefined) {
    const raw = readJsonObject(request.manifest_path);
    if (raw.role === "tester") throw new Error("WIKI_QUERY_IDENTITY_FORBIDDEN");
    assertResearchVisible(raw);
    const input = raw as unknown as WikiWorkerManifest;
    if (input.role === "tester") throw new Error("WIKI_QUERY_IDENTITY_FORBIDDEN");
    if (
      canonicalStatePath(wikiWorkerManifestPath(input.project_root, input.run_id)) !==
      canonicalStatePath(request.manifest_path)
    )
      throw new Error("WORKER_MANIFEST_PATH_MISMATCH");
    const expectedScope = resolveRunWikiScope(input.project_root, input.run_id);
    const scope =
      input.role === "scorer" ? `${expectedScope}/scorers/${input.run_id}` : expectedScope;
    if (
      raw.scope !== scope ||
      request.scope !== scope ||
      path.resolve(wikiRoot) !== runWikiRoot(input.project_root, input.run_id) ||
      raw.wiki_root !== path.resolve(wikiRoot)
    )
      throw new Error("WIKI_SCOPE_CONFLICT");
    if (
      input.role === "scorer"
        ? request.requester !== "scorer-loop"
        : input.role !== "module" ||
          !(WIKI_MODULE_WORKERS as readonly string[]).includes(request.requester)
    )
      throw new Error("WIKI_QUERY_IDENTITY_FORBIDDEN");
    assertInputSnapshot(input);
    if (!isObject(raw.wiki_head)) throw new Error("FROZEN_WIKI_HEAD_REQUIRED");
    const head = raw.wiki_head as unknown as WikiHead;
    const actual = eventLogHead(readWikiEventsLocked(wikiRoot).slice(0, head.seq));
    if (
      canonicalJsonSha256(head, anyJsonSchema) !== canonicalJsonSha256(actual, anyJsonSchema) ||
      (request.head !== undefined &&
        canonicalJsonSha256(request.head, anyJsonSchema) !==
          canonicalJsonSha256(head, anyJsonSchema))
    )
      throw new Error("WIKI_HEAD_MISMATCH");
    if (request.allow_standalone) throw new Error("STANDALONE_OUTER_DECISION_FORBIDDEN");
    bounded = { ...request, head, allow_standalone: false };
  } else if (request.scope !== "standalone" || /scorer/i.test(request.requester)) {
    throw new Error("WORKER_MANIFEST_REQUIRED");
  }
  const result = projectQueryWiki(wikiRoot, bounded);
  assertResearchVisible(result);
  return result;
}

const ARXIV_API = "https://export.arxiv.org/api/query?id_list={ids}";

type JsonObject = Record<string, unknown>;
type Operation = JsonObject;

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Commander hands back "" for an unset string option; that means "absent". */
function optionalCliNumber(value: string, flag: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number`);
  return parsed;
}

function optionalCliInteger(value: string, flag: string, minimum: number): number | undefined {
  const parsed = optionalCliNumber(value, flag);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  return parsed;
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function slugify(title: string, authorLast = "", year = 0): string {
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "of",
    "for",
    "in",
    "on",
    "with",
    "via",
    "and",
    "to",
    "by",
  ]);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/);
  const keywords = words.filter((word) => !stopWords.has(word) && word.length > 2);
  const keyword = keywords.length > 0 ? keywords.slice(0, 3).join("_") : "untitled";
  const author = authorLast ? authorLast.toLowerCase().replace(/[^a-z]/g, "") : "unknown";
  return `${author}${year ? String(year) : "0000"}_${keyword}`;
}

function xmlFindAll(xml: string, localName: string): string[] {
  const pattern = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${localName}>`,
    "g",
  );
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) values.push(match[1]!);
  return values;
}

function xmlFindFirst(xml: string, localName: string): string | null {
  const match = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${localName}>`,
  ).exec(xml);
  return match ? match[1]! : null;
}

function xmlSelfClosingAttr(xml: string, localName: string, attribute: string): string | null {
  const match = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${localName}[^>]*?\\b${attribute}="([^"]*)"[^>]*\\/?>`,
  ).exec(xml);
  return match ? match[1]! : null;
}

function arxivUserAgent(): string {
  const contact = (process.env.ARIS_VERIFY_EMAIL ?? "").trim();
  const base =
    "ARIS-research-wiki/1.0 (+https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)";
  return contact ? `${base} (mailto:${contact})` : base;
}

function httpGet(url: string, timeout: number, userAgent: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const request = client.get(
      url,
      { headers: { "User-Agent": userAgent }, timeout },
      (response) => {
        if (response.statusCode === 429) {
          reject(new Error("HTTP 429"));
          return;
        }
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          httpGet(response.headers.location, timeout, userAgent).then(resolve, reject);
          return;
        }
        if (response.statusCode && response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function arxivApiGet(url: string, what: string, timeout = 15_000): Promise<string> {
  const userAgent = arxivUserAgent();
  try {
    const body = await httpGet(url, timeout, userAgent);
    const text = body.toString("utf-8");
    if (text.trim() === "Rate exceeded.") throw new Error("arXiv API rate-limited");
    return text;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`arXiv API fetch failed for ${what}: ${message}`);
  }
}

function normalizeArxivId(value: string): string {
  let normalized = value.trim();
  for (const prefix of ["arXiv:", "arxiv:", "http://arxiv.org/abs/", "https://arxiv.org/abs/"]) {
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      normalized = normalized.slice(prefix.length);
    }
  }
  return normalized.replace(/v\d+$/, "");
}

interface ArxivMeta {
  arxiv_id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  primary_category: string;
  doi?: string;
  s2_id?: string;
}

function parseArxivEntry(entry: string): ArxivMeta {
  const title = (xmlFindFirst(entry, "title") ?? "").replace(/\s+/g, " ").trim();
  const abstract = (xmlFindFirst(entry, "summary") ?? "").replace(/\s+/g, " ").trim();
  const published = (xmlFindFirst(entry, "published") ?? "").trim();
  const year = /^\d{4}$/.test(published.slice(0, 4))
    ? Number.parseInt(published.slice(0, 4), 10)
    : 0;
  const authors = xmlFindAll(entry, "author")
    .map((author) => (xmlFindFirst(author, "name") ?? "").trim())
    .filter(Boolean);
  const rawId = (xmlFindFirst(entry, "id") ?? "").trim();
  const arxivId = rawId.includes("/abs/") ? normalizeArxivId(rawId.split("/abs/")[1]!) : "";
  return {
    arxiv_id: arxivId,
    title,
    authors,
    year,
    venue: (xmlFindFirst(entry, "journal_ref") ?? "").trim() || "arXiv",
    abstract,
    primary_category: xmlSelfClosingAttr(entry, "primary_category", "term") ?? "",
  };
}

async function fetchArxivMetadata(arxivId: string, timeout = 15_000): Promise<ArxivMeta> {
  const normalized = normalizeArxivId(arxivId);
  const body = await arxivApiGet(ARXIV_API.replace("{ids}", normalized), normalized, timeout);
  const entry = xmlFindFirst(body, "entry");
  if (!entry) throw new Error(`arXiv API returned no entry for ${normalized}`);
  const metadata = parseArxivEntry(entry);
  metadata.arxiv_id = normalized;
  return metadata;
}

async function fetchArxivMetadataBatch(
  ids: string[],
  timeout = 30_000,
): Promise<Record<string, ArxivMeta>> {
  const normalized = ids.map(normalizeArxivId).filter(Boolean);
  if (normalized.length === 0) return {};
  const url = `${ARXIV_API.replace("{ids}", normalized.join(","))}&max_results=${normalized.length}`;
  const body = await arxivApiGet(url, `id_list[${normalized.length}]`, timeout);
  const result: Record<string, ArxivMeta> = {};
  for (const entry of xmlFindAll(body, "entry")) {
    const metadata = parseArxivEntry(entry);
    if (metadata.arxiv_id) result[metadata.arxiv_id] = metadata;
  }
  return result;
}

const VALID_EDGE_TYPES = new Set<string>(WIKI_EDGE_TYPES);

const EDGE_ENDPOINT_KINDS: Record<string, { from: string[]; to: string[] }> = {
  extends: { from: ["paper", "claim"], to: ["paper"] },
  contradicts: { from: ["paper"], to: ["paper"] },
  supersedes: { from: ["paper"], to: ["paper"] },
  addresses: { from: ["idea", "claim"], to: ["problem"] },
  child_of: { from: ["problem"], to: ["problem"] },
  inspired_by: { from: ["idea"], to: ["paper"] },
  tested_by: { from: ["idea", "claim"], to: ["exp"] },
  supports: { from: ["exp"], to: ["claim", "idea"] },
  invalidates: { from: ["exp"], to: ["claim", "idea"] },
  uses: { from: ["claim"], to: ["paper"] },
  depends_on: { from: ["claim"], to: ["claim"] },
  refutes: { from: ["claim"], to: ["claim"] },
};

function nodeKindOf(nodeId: string): string {
  const separator = nodeId.indexOf(":");
  return separator > 0 ? nodeId.slice(0, separator) : "";
}

function edgeTypesForKinds(fromKind: string, toKind: string): string[] {
  return Object.entries(EDGE_ENDPOINT_KINDS)
    .filter(([, spec]) => spec.from.includes(fromKind) && spec.to.includes(toKind))
    .map(([type]) => type);
}

function assertEdgeEndpointKinds(fromId: string, toId: string, edgeType: string): void {
  const spec = EDGE_ENDPOINT_KINDS[edgeType];
  if (!spec) return;
  const fromKind = nodeKindOf(fromId);
  const toKind = nodeKindOf(toId);
  if (spec.from.includes(fromKind) && spec.to.includes(toKind)) return;
  const alternatives = edgeTypesForKinds(fromKind, toKind);
  const hint =
    alternatives.length > 0 ? ` For ${fromKind} → ${toKind} use: ${alternatives.join(", ")}.` : "";
  throw new Error(
    `add_edge: '${edgeType}' connects ${spec.from.join("|")} --${edgeType}--> ${spec.to.join("|")}, got ${fromKind || "?"} --${edgeType}--> ${toKind || "?"}.${hint}`,
  );
}

function normalizeNodeId(value: string, defaultPrefix: string): string {
  const trimmed = value.trim();
  assertNotAbsoluteIdentifier(trimmed, "node id");
  return trimmed ? (trimmed.includes(":") ? trimmed : `${defaultPrefix}${trimmed}`) : "";
}

function pageExists(model: WikiModel, nodeId: string): boolean {
  const separator = nodeId.indexOf(":");
  if (separator <= 0) return false;
  const kind = nodeId.slice(0, separator) as WikiPageKind;
  const slug = nodeId.slice(separator + 1);
  return (
    ["paper", "idea", "experiment", "claim", "problem"].includes(kind) &&
    model.pages[kind]?.has(slug) === true
  );
}

function warnIfDangling(model: WikiModel, nodeId: string, operation: string): void {
  if (nodeId && !pageExists(model, nodeId)) {
    throw new Error(`${operation}: edge target ${nodeId} not found in this wiki`);
  }
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function appendEvidenceOnce(existing: string, incoming: string): string {
  const current = existing.trim();
  const next = incoming.trim();
  if (!next || !current) return current || next;
  if (current === next) return current;
  if (current.split("\n\n").some((part) => part.trim() === next)) return current;
  return `${current}\n\n${next}`;
}

function sanitizeText(value: string, label: string, operations: Operation[]): string {
  if (!value) return value;
  const [safe, findings] = quarantine(value, "strict", label);
  if (findings.length > 0) {
    operations.push({ op: "quarantine", target: label, findings, raw_text: value });
    console.error(`Warning: ${label} was quarantined (${findings.join(", ")}).`);
  }
  return safe;
}

function captureProjectDirection(wikiRoot: string): string | null {
  const briefPath = path.join(path.dirname(path.resolve(wikiRoot)), "RESEARCH_BRIEF.md");
  return fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf-8") : null;
}

function assertNotAbsoluteIdentifier(value: string, label: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const pathPart = trimmed.includes(":") ? trimmed.slice(trimmed.indexOf(":") + 1) : trimmed;
  if (
    path.isAbsolute(trimmed) ||
    path.isAbsolute(pathPart) ||
    /^[\\/]/.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(pathPart)
  ) {
    throw new Error(`${label} must be a relative identifier, not an absolute path`);
  }
}

function withProjectionContext(
  wikiRoot: string,
  model: WikiModel,
  operations: Operation[],
): Operation[] {
  const result = [...operations];
  const direction = captureProjectDirection(wikiRoot) ?? "";
  if (direction !== (model.project_direction ?? "")) {
    result.push({ op: "set_project_direction", text: direction });
  }
  return result;
}

type EvidenceBundleId = string | ((events: readonly WikiEvent[], model: WikiModel) => string);
type OperationBuilder = (model: WikiModel, events: readonly WikiEvent[]) => Operation[] | null;

interface CommitOperationOptions {
  scope?: string;
  context?: WikiPayloadContext;
  producerKind?: string;
  eventType?: string;
}

function commitOperations(
  wikiRoot: string,
  subjectId: string,
  evidenceBundleId: EvidenceBundleId,
  build: OperationBuilder,
  options: CommitOperationOptions = {},
): WikiAppendResult | { status: "skipped"; event: null } {
  const result = commitWikiChange(
    wikiRoot,
    (events: readonly WikiEvent[]): WikiDelta | null => {
      const model = replayWikiEvents(events);
      const operations = build(model, events);
      if (operations === null) return null;
      const evidence =
        typeof evidenceBundleId === "function" ? evidenceBundleId(events, model) : evidenceBundleId;
      return {
        producer_kind: options.producerKind ?? "standalone-research-wiki",
        scope: options.scope ?? "standalone",
        subject_id: subjectId,
        evidence_bundle_id: evidence || subjectId,
        ...(options.eventType === undefined ? {} : { event_type: options.eventType }),
        payload: {
          operations: withProjectionContext(wikiRoot, model, operations),
          ...(options.context === undefined ? {} : { context: options.context }),
        },
      };
    },
    (events) => projectWikiFromEvents(wikiRoot, events),
  );
  if (result.status === "conflict") {
    throw new Error(
      `WIKI_COMMAND_CONFLICT: command ${result.command_id} conflicts with an existing payload`,
    );
  }
  return result;
}

function projectionConfigEvidence(events: readonly WikiEvent[], model: WikiModel): string {
  const previousStateHash = canonicalJsonSha256(
    {
      project_direction: model.project_direction ?? "",
      max_query_chars: model.max_query_chars,
    },
    anyJsonSchema,
  );
  const head = eventLogHead(events);
  return `projection-config-v1:${previousStateHash}:${head.event_id ?? "genesis"}`;
}

function addLog(operations: Operation[], message: string): void {
  operations.push({ op: "append_log", message });
}

function nodeSlugify(name: string, supplied: string): string {
  if (supplied.trim()) {
    assertNotAbsoluteIdentifier(supplied, "node slug");
    const value = supplied
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "");
    if (value) return value;
  }
  return slugify(name).replace(/^_+|^0+|_+$/g, "") || "node";
}

function parseExisting(model: WikiModel, kind: WikiPageKind, id: string): JsonObject | null {
  const page = model.pages[kind].get(id);
  return page ? { ...page.data } : null;
}

function initWiki(wikiRoot: string): void {
  initializeWikiSchema(wikiRoot);
  projectWiki(wikiRoot);
  console.log(`Research wiki initialized at ${path.resolve(wikiRoot)}`);
}

function addEdge(
  wikiRoot: string,
  fromId: string,
  toId: string,
  edgeType: string,
  evidence = "",
): void {
  assertNotAbsoluteIdentifier(fromId, "edge source");
  assertNotAbsoluteIdentifier(toId, "edge target");
  if (!isWikiEdgeType(edgeType)) {
    console.error(
      `Warning: unknown edge type '${edgeType}'. Valid: ${[...VALID_EDGE_TYPES].join(", ")}`,
    );
    throw new Error(`add_edge: unknown edge type '${edgeType}'`);
  }
  assertEdgeEndpointKinds(fromId, toId, edgeType);
  const root = path.resolve(wikiRoot);
  const result = commitOperations(
    root,
    `edge:${fromId}:${edgeType}:${toId}`,
    evidence || `${fromId}->${toId}`,
    (model) => {
      if (
        model.edges.some(
          (edge) => edge.from === fromId && edge.to === toId && edge.type === edgeType,
        )
      ) {
        console.log(`Edge already exists: ${fromId} --${edgeType}--> ${toId}`);
        return null;
      }
      const operations: Operation[] = [];
      const safeEvidence = sanitizeText(evidence, `edge ${fromId} -> ${toId}`, operations);
      operations.push({
        op: "upsert_edge",
        edge: { from: fromId, to: toId, type: edgeType, evidence: safeEvidence },
      });
      addLog(operations, `add_edge: ${fromId} --${edgeType}--> ${toId}`);
      return operations;
    },
  );
  if (result.status === "skipped") return;
  console.log(`Edge added: ${fromId} --${edgeType}--> ${toId}`);
}

function arxivFromPage(page: JsonObject): string {
  const external = isObject(page.external_ids) ? page.external_ids : {};
  return typeof external.arxiv === "string" ? external.arxiv : "";
}

function findExistingPaper(model: WikiModel, arxivId: string): string | null {
  for (const page of model.pages.paper.values()) {
    if (arxivFromPage(page.data) === arxivId) return page.id;
  }
  return null;
}

async function ingestPaper(
  wikiRoot: string,
  options: {
    arxivId?: string;
    title?: string;
    authors?: string[];
    year?: number;
    venue?: string;
    doi?: string;
    thesis?: string;
    tags?: string[];
    updateOnExist?: boolean;
    prefetchedMeta?: ArxivMeta | null;
  },
): Promise<string> {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const metadata: ArxivMeta = options.arxivId
    ? { ...(options.prefetchedMeta ?? (await fetchArxivMetadata(options.arxivId))) }
    : {
        arxiv_id: "",
        title: options.title ?? "",
        authors: options.authors ?? [],
        year: options.year ?? 0,
        venue: options.venue || "unknown",
        abstract: "",
        primary_category: "",
      };
  if (!options.arxivId && !(options.title && options.authors?.length && options.year)) {
    throw new Error(
      "Manual ingest requires --title, --authors, and --year when --arxiv-id is not supplied.",
    );
  }
  const normalizedArxiv = options.arxivId ? normalizeArxivId(options.arxivId) : "";
  metadata.arxiv_id = normalizedArxiv || metadata.arxiv_id;
  if (options.title) metadata.title = options.title;
  if (options.authors?.length) metadata.authors = options.authors;
  if (options.year) metadata.year = options.year;
  if (options.venue) metadata.venue = options.venue;
  if (options.doi) metadata.doi = options.doi;

  const authorLast = metadata.authors[0]?.trim().split(/\s+/).at(-1) ?? "";
  let slug = slugify(metadata.title, authorLast, metadata.year);
  const existingSlug = normalizedArxiv
    ? findExistingPaper(readWikiModel(root), normalizedArxiv)
    : null;
  if (existingSlug) slug = existingSlug;
  const pagePath = path.join(root, "papers", `${slug}.md`);
  const subject = `paper:${slug}`;
  let existedBefore = existingSlug !== null;
  const result = commitOperations(
    root,
    subject,
    options.doi || normalizedArxiv || subject,
    (model) => {
      const existing = parseExisting(model, "paper", slug);
      existedBefore = existing !== null;
      if ((existing || model.pages.paper.has(slug)) && !options.updateOnExist) {
        console.log(`Paper already ingested: ${path.basename(pagePath)} — skipping.`);
        return null;
      }
      const operations: Operation[] = [
        {
          op: "upsert_page",
          kind: "paper",
          id: slug,
          data: {
            title: metadata.title,
            authors: [...metadata.authors],
            year: metadata.year,
            venue: metadata.venue || "arXiv",
            external_ids: {
              arxiv: metadata.arxiv_id,
              doi: metadata.doi ?? "",
              s2: metadata.s2_id ?? "",
            },
            tags: options.tags ?? [],
            thesis: options.thesis ?? "",
            abstract: metadata.abstract,
            primary_category: metadata.primary_category,
          },
        },
      ];
      addLog(
        operations,
        `ingest_paper: ${options.updateOnExist ? "updated" : "ingested"} paper:${slug} (arxiv:${metadata.arxiv_id || "-"})`,
      );
      return operations;
    },
  );
  if (result.status === "skipped") return pagePath;
  console.log(`Paper ${existedBefore ? "updated" : "ingested"}: ${pagePath}`);
  return pagePath;
}

const CLAIM_STATUSES = new Set([
  "drafted",
  "unproven",
  "sound-modulo-imports",
  "verified",
  "refuted",
  "retracted",
]);

function addClaim(
  wikiRoot: string,
  suppliedSlug: string,
  name: string,
  options: {
    description?: string;
    status?: string;
    provenance?: string;
    statement?: string;
    scope?: string;
    evidence?: string;
    tags?: string[];
    addresses?: string[];
    extends?: string[];
    uses?: string[];
    dependsOn?: string[];
    refutes?: string[];
    updateOnExist?: boolean;
  },
): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const status = options.status ?? "drafted";
  if (!CLAIM_STATUSES.has(status)) throw new Error(`unknown claim status '${status}'`);
  const slug = nodeSlugify(name, suppliedSlug);
  const subject = `claim:${slug}`;
  let existedBefore = false;
  const result = commitOperations(root, subject, options.provenance || subject, (model) => {
    existedBefore = model.pages.claim.has(slug);
    if (model.pages.claim.has(slug) && !options.updateOnExist) {
      console.log(`Claim already exists: ${slug}.md (slug dedup) — skipping.`);
      return null;
    }
    const operations: Operation[] = [];
    const data = {
      name,
      description: sanitizeText(options.description ?? "", `claim ${slug}.description`, operations),
      status,
      provenance: options.provenance ?? "",
      statement: sanitizeText(options.statement ?? "", `claim ${slug}.statement`, operations),
      scope: sanitizeText(options.scope ?? "", `claim ${slug}.scope`, operations),
      evidence: sanitizeText(options.evidence ?? "", `claim ${slug}.evidence`, operations),
      tags: options.tags ?? [],
      date: "",
    };
    operations.unshift({ op: "upsert_page", kind: "claim", id: slug, data });
    const addReferences = (
      values: string[] | undefined,
      prefix: string,
      edgeType: string,
      targetKind: string,
    ) => {
      for (const raw of values ?? []) {
        const target = normalizeNodeId(raw, prefix);
        if (!target) continue;
        warnIfDangling(model, target, "add_claim");
        if (nodeKindOf(target) !== targetKind)
          throw new Error(`add_claim: ${edgeType} target must be ${targetKind}`);
        operations.push({
          op: "upsert_edge",
          edge: {
            from: subject,
            to: target,
            type: edgeType,
            evidence: `${subject} ${edgeType} ${target}`,
          },
        });
      }
    };
    addReferences(options.addresses, "problem:", "addresses", "problem");
    addReferences(options.extends, "paper:", "extends", "paper");
    addReferences(options.uses, "paper:", "uses", "paper");
    addReferences(options.dependsOn, "claim:", "depends_on", "claim");
    addReferences(options.refutes, "claim:", "refutes", "claim");
    addLog(
      operations,
      `add_claim: ${options.updateOnExist ? "updated" : "added"} ${subject} [status=${status}]`,
    );
    return operations;
  });
  if (result.status === "skipped") {
    console.log(`Claim skipped: ${path.join(root, "claims", `${slug}.md`)}`);
    return;
  }
  console.log(
    `Claim ${existedBefore ? "updated" : "added"}: ${path.join(root, "claims", `${slug}.md`)} [status=${status}]`,
  );
}

const IDEA_OUTCOMES = new Set(["unknown", "pending", "negative", "mixed", "positive"]);
const IDEA_STAGES = new Set(["proposed", "active", "piloted", "archived"]);

function upsertIdea(
  wikiRoot: string,
  suppliedSlug: string,
  title: string,
  options: {
    description?: string;
    stage?: string;
    outcome?: string;
    thesis?: string;
    risks?: string;
    tags?: string[];
    basedOn?: string[];
    targetProblems?: string[];
    updateOnExist?: boolean;
  },
): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const stage = options.stage ?? "proposed";
  const outcome = options.outcome ?? "pending";
  if (!IDEA_STAGES.has(stage)) throw new Error(`unknown idea stage '${stage}'`);
  if (!IDEA_OUTCOMES.has(outcome)) throw new Error(`unknown idea outcome '${outcome}'`);
  const slug = nodeSlugify(title, suppliedSlug);
  const subject = `idea:${slug}`;
  let existedBefore = false;
  const result = commitOperations(root, subject, subject, (model) => {
    existedBefore = model.pages.idea.has(slug);
    if (model.pages.idea.has(slug) && !options.updateOnExist) {
      console.log(`Idea already exists: ${slug}.md (slug dedup) — skipping.`);
      return null;
    }
    const operations: Operation[] = [];
    const basedOnIds: string[] = [];
    const targetProblems = [...(options.targetProblems ?? [])];
    for (const raw of options.basedOn ?? []) {
      const target = normalizeNodeId(raw, "paper:");
      if (!target) continue;
      if (nodeKindOf(target) === "problem") targetProblems.push(target);
      else if (nodeKindOf(target) === "paper") basedOnIds.push(target);
      else throw new Error(`upsert_idea: --based-on takes paper ids, got '${target}'`);
    }
    const targetProblemIds = dedupeIds(
      targetProblems.map((item) => normalizeNodeId(item, "problem:")).filter(Boolean),
    );
    for (const target of [...basedOnIds, ...targetProblemIds])
      warnIfDangling(model, target, "upsert_idea");
    operations.unshift({
      op: "upsert_page",
      kind: "idea",
      id: slug,
      data: {
        title,
        description: sanitizeText(
          options.description ?? "",
          `idea ${slug}.description`,
          operations,
        ),
        stage,
        outcome,
        thesis: sanitizeText(options.thesis ?? "", `idea ${slug}.thesis`, operations),
        risks: sanitizeText(options.risks ?? "", `idea ${slug}.risks`, operations),
        based_on: basedOnIds,
        target_problems: targetProblemIds,
        tags: options.tags ?? [],
      },
    });
    for (const target of basedOnIds)
      operations.push({
        op: "upsert_edge",
        edge: {
          from: subject,
          to: target,
          type: "inspired_by",
          evidence: `${subject} inspired by paper`,
        },
      });
    for (const target of targetProblemIds)
      operations.push({
        op: "upsert_edge",
        edge: {
          from: subject,
          to: target,
          type: "addresses",
          evidence: `${subject} addresses problem`,
        },
      });
    addLog(
      operations,
      `upsert_idea: ${options.updateOnExist ? "updated" : "added"} ${subject} [stage=${stage} outcome=${outcome}]`,
    );
    return operations;
  });
  if (result.status === "skipped") return;
  console.log(
    `Idea ${existedBefore ? "updated" : "added"}: ${path.join(root, "ideas", `${slug}.md`)} [stage=${stage} outcome=${outcome}]`,
  );
}

const EXPERIMENT_VERDICTS = new Set(["yes", "partial", "no"]);
const EXPERIMENT_CONFIDENCE = new Set(["high", "medium", "low"]);

export function addExperiment(
  wikiRoot: string,
  slugInput: string,
  options: {
    title?: string;
    idea?: string;
    verdict?: string;
    confidence?: string;
    date?: string;
    hardware?: string;
    duration?: string;
    metrics?: string;
    reasoning?: string;
    provenance?: string;
    tags?: string[];
    /** Outer loop iteration this experiment belongs to; the export orders by it. */
    iteration?: number;
    /** This iteration's metric-gate reading, cross-checked against the dashboard on export. */
    gateMetric?: number;
    /**
     * A signed public tester receipt plus the key that verifies it. Tester
     * numbers may only enter the wiki this way; there is no flag for typing
     * them in by hand.
     *
     * Two forms, both of which verify the signature. The path form is what the
     * CLI uses and additionally requires the public key to be root-owned and
     * unwritable by anyone else, which is what stops a run from pointing at a
     * key it generated itself. The in-memory form exists so this path can be
     * tested at all: a test process cannot create a root-owned file, and
     * without it the only thing checking that the wiki is wired to the verifier
     * would be the type system.
     */
    testerReceipt?:
      | { receipt: string; publicKey: string }
      | { signed: unknown; publicKey: crypto.KeyObject };
    updateOnExist?: boolean;
  },
): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  assertNotAbsoluteIdentifier(slugInput, "experiment slug");
  const slug = slugInput
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("experiment slug (exp id) is required and must be non-empty");
  const verdict = options.verdict ?? "no";
  const confidence = options.confidence ?? "medium";
  if (!EXPERIMENT_VERDICTS.has(verdict)) throw new Error(`unknown experiment verdict '${verdict}'`);
  if (!EXPERIMENT_CONFIDENCE.has(confidence)) throw new Error(`unknown confidence '${confidence}'`);
  const testerEnvelope =
    options.testerReceipt === undefined
      ? null
      : "signed" in options.testerReceipt
        ? verifyTesterFeedback(options.testerReceipt.signed, options.testerReceipt.publicKey)
        : readVerifiedTesterFeedback(
            options.testerReceipt.receipt,
            options.testerReceipt.publicKey,
          );
  // The receipt already names the iteration it judged, so a supplied one is
  // only allowed to agree with it -- otherwise the export would rank a tester
  // score against the wrong round.
  if (
    testerEnvelope !== null &&
    options.iteration !== undefined &&
    options.iteration !== testerEnvelope.outer_iteration
  )
    throw new Error(
      `experiment iteration ${options.iteration} contradicts the tester receipt's outer_iteration ${testerEnvelope.outer_iteration}`,
    );
  const iteration = options.iteration ?? testerEnvelope?.outer_iteration;
  const subject = `exp:${slug}`;
  let existedBefore = false;
  const result = commitOperations(root, subject, options.provenance || subject, (model) => {
    existedBefore = model.pages.experiment.has(slug);
    if (model.pages.experiment.has(slug) && !options.updateOnExist) {
      console.log(`Experiment already exists: ${slug}.md (slug dedup) — skipping.`);
      return null;
    }
    const operations: Operation[] = [];
    const ideaId = options.idea ? normalizeNodeId(options.idea, "idea:") : "";
    if (ideaId) warnIfDangling(model, ideaId, "add_experiment");
    if (options.updateOnExist || model.pages.experiment.has(slug)) {
      operations.push({ op: "remove_edges", from: subject, type: "supports" });
      operations.push({ op: "remove_edges", from: subject, type: "invalidates" });
    }
    operations.push({
      op: "upsert_page",
      kind: "experiment",
      id: slug,
      data: {
        title: options.title ?? "",
        idea_id: ideaId,
        verdict,
        confidence,
        date: options.date ?? "",
        hardware: options.hardware ?? "",
        duration: options.duration ?? "",
        provenance: options.provenance ?? "",
        metrics: sanitizeText(options.metrics ?? "", `experiment ${slug}.metrics`, operations),
        reasoning: sanitizeText(
          options.reasoning ?? "",
          `experiment ${slug}.reasoning`,
          operations,
        ),
        tags: options.tags ?? [],
        ...(iteration === undefined ? {} : { iteration }),
        ...(options.gateMetric === undefined ? {} : { gate_metric: options.gateMetric }),
        ...(testerEnvelope === null
          ? {}
          : {
              tester_metrics: { ...testerEnvelope.feedback.metrics },
              tester_definition_sha256: testerEnvelope.tester_definition_sha256,
              // The coarse verdict is the other half of what the tester is
              // allowed to say. It is what makes a bad number actionable --
              // which direction regressed -- without naming a single case.
              tester_conclusion: testerEnvelope.feedback.conclusion,
              tester_confidence: testerEnvelope.feedback.confidence,
              tester_directions: [...testerEnvelope.feedback.directions],
              tester_advice: [...testerEnvelope.feedback.advice],
            }),
      },
    });
    if (ideaId)
      operations.push({
        op: "upsert_edge",
        edge: {
          from: ideaId,
          to: subject,
          type: "tested_by",
          evidence: `${subject} tests ${ideaId}`,
        },
      });
    addLog(
      operations,
      `add_experiment: ${options.updateOnExist ? "updated" : "added"} ${subject} [verdict=${verdict} confidence=${confidence}]`,
    );
    return operations;
  });
  if (result.status === "skipped") {
    console.log(`Experiment skipped: ${path.join(root, "experiments", `${slug}.md`)}`);
    return;
  }
  console.log(
    `Experiment ${existedBefore ? "updated" : "added"}: ${path.join(root, "experiments", `${slug}.md`)} [verdict=${verdict} confidence=${confidence}]`,
  );
}

const PROBLEM_STATUSES = new Set(["open", "solved", "refuted", "deferred"]);
const PROBLEM_SEVERITIES = new Set(["high", "medium", "low"]);

function addProblem(
  wikiRoot: string,
  suppliedSlug: string,
  suppliedTitle: string,
  options: {
    status?: string;
    severity?: string;
    parent?: string;
    statement?: string;
    origin?: string;
    evidence?: string;
    whatWouldSolve?: string;
    caveats?: string;
    tags?: string[];
    updateOnExist?: boolean;
  },
): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const slug = nodeSlugify(suppliedTitle, suppliedSlug);
  const subject = `problem:${slug}`;
  let existedBefore = false;
  const result = commitOperations(root, subject, options.evidence || subject, (model) => {
    const existing = parseExisting(model, "problem", slug);
    existedBefore = existing !== null;
    const title = suppliedTitle || (typeof existing?.title === "string" ? existing.title : "");
    if (!title) throw new Error("add_problem: --title is required when creating a new problem");
    if (existing && !options.updateOnExist) {
      console.log(`Problem already exists: ${slug}.md (slug dedup) — skipping.`);
      return null;
    }
    const status =
      options.status ?? (typeof existing?.status === "string" ? existing.status : "open");
    const severity =
      options.severity ?? (typeof existing?.severity === "string" ? existing.severity : "medium");
    if (!PROBLEM_STATUSES.has(status)) throw new Error(`unknown problem status '${status}'`);
    if (!PROBLEM_SEVERITIES.has(severity)) throw new Error(`unknown severity '${severity}'`);
    const operations: Operation[] = [];
    const existingEvidence = typeof existing?.evidence === "string" ? existing.evidence : "";
    const evidence =
      options.evidence === undefined
        ? existingEvidence
        : appendEvidenceOnce(existingEvidence, options.evidence);
    const parent = options.parent ?? (typeof existing?.parent === "string" ? existing.parent : "");
    const parentId = parent && !parent.includes(":") ? `problem:${parent}` : parent;
    if (parentId) {
      if (parentId === subject)
        throw new Error(`add_problem: problem ${subject} cannot be its own parent`);
      warnIfDangling(model, parentId, "add_problem");
    }
    operations.push({
      op: "upsert_page",
      kind: "problem",
      id: slug,
      data: {
        title,
        status,
        severity,
        parent: parentId,
        statement: sanitizeText(
          options.statement ?? (typeof existing?.statement === "string" ? existing.statement : ""),
          `problem ${slug}.statement`,
          operations,
        ),
        origin: sanitizeText(
          options.origin ?? (typeof existing?.origin === "string" ? existing.origin : ""),
          `problem ${slug}.origin`,
          operations,
        ),
        evidence: sanitizeText(evidence, `problem ${slug}.evidence`, operations),
        whatWouldSolve: sanitizeText(
          options.whatWouldSolve ??
            (typeof existing?.whatWouldSolve === "string" ? existing.whatWouldSolve : ""),
          `problem ${slug}.whatWouldSolve`,
          operations,
        ),
        caveats: sanitizeText(
          options.caveats ?? (typeof existing?.caveats === "string" ? existing.caveats : ""),
          `problem ${slug}.caveats`,
          operations,
        ),
        tags: options.tags ?? (Array.isArray(existing?.tags) ? existing.tags : []),
      },
    });
    if (parentId)
      operations.push({
        op: "upsert_edge",
        edge: {
          from: subject,
          to: parentId,
          type: "child_of",
          evidence: `${subject} is a sub-problem`,
        },
      });
    addLog(
      operations,
      `add_problem: ${options.updateOnExist ? "updated" : "added"} ${subject} [status=${status} severity=${severity}]`,
    );
    return operations;
  });
  if (result.status === "skipped") return;
  console.log(
    `Problem ${existedBefore ? "updated" : "added"}: ${path.join(root, "problems", `${slug}.md`)}`,
  );
}

function getStats(wikiRoot: string, asJson: boolean): void {
  const model = readWikiModel(path.resolve(wikiRoot));
  const counts = {
    papers: model.pages.paper.size,
    ideas: model.pages.idea.size,
    experiments: model.pages.experiment.size,
    claims: model.pages.claim.size,
    problems: model.pages.problem.size,
  };
  const byStatus = (status: string): string[] =>
    [...model.pages.problem.values()]
      .filter(
        (page) => (typeof page.data.status === "string" ? page.data.status : "open") === status,
      )
      .map((page) => `problem:${page.id}`)
      .sort();
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...counts,
          problems: {
            open: byStatus("open"),
            closed: [...byStatus("solved"), ...byStatus("refuted")].sort(),
            deferred: byStatus("deferred"),
            total: counts.problems,
          },
          edges: model.edges.length,
          wiki_root: path.resolve(wikiRoot),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("Research Wiki Stats");
  console.log(`Papers:      ${counts.papers}`);
  console.log(`Ideas:       ${counts.ideas}`);
  console.log(`Experiments: ${counts.experiments}`);
  console.log(`Claims:      ${counts.claims}`);
  console.log(`Problems:    ${counts.problems}`);
  console.log(`Edges:       ${model.edges.length}`);
  console.log(`Wiki root:   ${path.resolve(wikiRoot)}`);
}

function rebuildWiki(wikiRoot: string): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  projectWiki(root);
  console.log("Research Wiki projections rebuilt");
}

function rebuildQueryPack(wikiRoot: string, maxChars?: number): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 200))
    throw new Error("max-chars must be an integer >= 200");
  commitOperations(root, "projection:query-pack", projectionConfigEvidence, (model) => {
    const operations: Operation[] = [];
    const direction = captureProjectDirection(root) ?? "";
    if (direction !== (model.project_direction ?? "")) {
      operations.push({ op: "set_project_direction", text: direction });
    }
    if (maxChars !== undefined && maxChars !== model.max_query_chars) {
      operations.push({ op: "set_projection_config", max_query_chars: maxChars });
    }
    return operations.length > 0 ? operations : null;
  });
  console.log("query_pack.md rebuilt");
}

function rebuildIndex(wikiRoot: string): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  projectWiki(root);
  console.log("index.md rebuilt");
}

function appendLog(wikiRoot: string, message: string): void {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  commitOperations(root, `log:${message}`, `log:${message}`, () => [{ op: "append_log", message }]);
}

export interface SignalWriteOptions {
  projectRoot?: string;
  runId?: string;
  scope?: string;
  evidenceBundleId?: string;
  context?: WikiPayloadContext;
}

function signalWriteScope(wikiRoot: string, options: SignalWriteOptions): string {
  if (
    options.runId === undefined &&
    options.projectRoot === undefined &&
    (options.scope === undefined || options.scope === "standalone")
  )
    return "standalone";
  if (options.runId === undefined || options.projectRoot === undefined)
    throw new Error("WIKI_RUN_BINDING_REQUIRED");
  const runScope = resolveRunWikiScope(options.projectRoot, options.runId);
  const manifestPath = wikiWorkerManifestPath(options.projectRoot, options.runId);
  const manifest = fs.existsSync(manifestPath) ? readJsonObject(manifestPath) : null;
  if (manifest?.role === "tester") throw new Error("WIKI_WRITE_IDENTITY_FORBIDDEN");
  const scope = manifest?.role === "scorer" ? `${runScope}/scorers/${options.runId}` : runScope;
  if (options.scope !== undefined && options.scope !== scope)
    throw new Error("WIKI_SCOPE_CONFLICT");
  if (path.resolve(wikiRoot) !== runWikiRoot(options.projectRoot, options.runId))
    throw new Error("WIKI_SCOPE_CONFLICT");
  return scope;
}

function signalHash(signal: WikiSignal): string {
  return canonicalJsonSha256(signal, anyJsonSchema);
}

function assertSignalProducerScope(signal: WikiSignal, scope: string): void {
  validateWikiScope(scope);
  if (scope.startsWith("modules/") && scope !== `modules/${signal.producer.module_id}`) {
    throw new Error(
      `SIGNAL_SCOPE_CONFLICT: ${signal.signal_id} producer module '${signal.producer.module_id}' does not match '${scope}'`,
    );
  }
}

function assertSignalEventScope(
  events: readonly WikiEvent[],
  signalId: string,
  scope: string,
): void {
  validateWikiScope(scope);
  const scopes = new Set<string>();
  for (const event of events) {
    for (const operation of parseWikiPayload(event.payload).operations) {
      if (
        (operation.op === "publish_signal" || operation.op === "upsert_signal") &&
        operation.signal.signal_id === signalId
      ) {
        scopes.add(event.producer.scope);
      }
    }
  }
  if (scopes.size > 0 && (scopes.size !== 1 || !scopes.has(scope))) {
    throw new Error(
      `SIGNAL_SCOPE_CONFLICT: ${signalId} belongs to ${[...scopes].sort().join(", ")}, not ${scope}`,
    );
  }
}

function assertSignalSupersedes(model: WikiModel, signal: WikiSignal): void {
  for (const supersededId of signal.supersedes) {
    const superseded = model.signals.get(supersededId);
    if (!superseded) {
      throw new Error(`SIGNAL_NOT_FOUND: ${supersededId} referenced by ${signal.signal_id}`);
    }
    if (superseded.status !== "active") {
      throw new Error(`SIGNAL_STATE_CONFLICT: ${supersededId} is already ${superseded.status}`);
    }
  }
}

function assertSignalCanBePublished(model: WikiModel, signal: WikiSignal): boolean {
  const existing = model.signals.get(signal.signal_id);
  if (!existing) {
    assertSignalSupersedes(model, signal);
    return true;
  }
  if (existing.status !== "active") {
    throw new Error(`SIGNAL_ID_IMMUTABLE: ${signal.signal_id} is already ${existing.status}`);
  }
  if (signalHash({ ...existing, status: "active" }) !== signalHash(signal)) {
    throw new Error(`SIGNAL_ID_CONFLICT: ${signal.signal_id} already has different content`);
  }
  return false;
}

function signalEvidence(signal: WikiSignal, options: SignalWriteOptions): string {
  return options.evidenceBundleId || signal.evidence_refs[0] || signal.signal_id;
}

export function publishSignal(
  wikiRoot: string,
  signal: WikiSignal,
  options: SignalWriteOptions = {},
): WikiAppendResult | { status: "skipped"; event: null } {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const scope = signalWriteScope(wikiRoot, options);
  assertResearchVisible(signal);
  if (options.runId !== undefined && signal.producer.run_id !== options.runId)
    throw new Error("SIGNAL_RUN_CONFLICT");
  assertSignalProducerScope(signal, scope);
  const result = commitOperations(
    root,
    signal.signal_id,
    signalEvidence(signal, options),
    (model, events) => {
      assertSignalEventScope(events, signal.signal_id, scope);
      if (!assertSignalCanBePublished(model, signal)) return null;
      return [{ op: "publish_signal", signal }];
    },
    {
      scope,
      context: options.context ?? signalContext(signal),
      producerKind: "research-wiki-signal",
      eventType: signal.supersedes.length > 0 ? "signal_superseded" : "signal_published",
    },
  );
  if (result.status === "conflict") {
    throw new Error(
      `WIKI_COMMAND_CONFLICT: command ${result.command_id} conflicts with an existing payload`,
    );
  }
  return result;
}

export interface SignalRetractionOptions extends SignalWriteOptions {
  reason?: string;
  evidenceRefs?: string[];
}

export function retractSignal(
  wikiRoot: string,
  signalId: string,
  options: SignalRetractionOptions = {},
): WikiAppendResult | { status: "skipped"; event: null } {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const scope = signalWriteScope(wikiRoot, options);
  const result = commitOperations(
    root,
    signalId,
    options.evidenceBundleId || signalId,
    (model, events) => {
      const existing = model.signals.get(signalId);
      if (!existing) throw new Error(`SIGNAL_NOT_FOUND: ${signalId}`);
      assertSignalEventScope(events, signalId, scope);
      if (existing.status === "retracted") return null;
      if (existing.status === "superseded") {
        throw new Error(`SIGNAL_STATE_CONFLICT: ${signalId} is already superseded`);
      }
      return [
        {
          op: "retract_signal",
          signal_id: signalId,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
          ...(options.evidenceRefs === undefined ? {} : { evidence_refs: options.evidenceRefs }),
        },
      ];
    },
    {
      scope,
      context: options.context,
      producerKind: "research-wiki-signal",
      eventType: "signal_retracted",
    },
  );
  if (result.status === "conflict") {
    throw new Error(
      `WIKI_COMMAND_CONFLICT: command ${result.command_id} conflicts with an existing payload`,
    );
  }
  return result;
}

export function supersedeSignal(
  wikiRoot: string,
  signalId: string,
  replacement: WikiSignal,
  options: SignalWriteOptions = {},
): WikiAppendResult | { status: "skipped"; event: null } {
  const root = path.resolve(wikiRoot);
  assertWikiSchemaSupported(root);
  const scope = signalWriteScope(wikiRoot, options);
  const replacementWithLink: WikiSignal = {
    ...replacement,
    supersedes: [...new Set([signalId, ...replacement.supersedes])],
  };
  if (replacementWithLink.signal_id === signalId) {
    throw new Error(`SIGNAL_ID_CONFLICT: replacement signal must use a new signal_id`);
  }
  assertResearchVisible(replacementWithLink);
  if (options.runId !== undefined && replacementWithLink.producer.run_id !== options.runId)
    throw new Error("SIGNAL_RUN_CONFLICT");
  assertSignalProducerScope(replacementWithLink, scope);
  const result = commitOperations(
    root,
    replacementWithLink.signal_id,
    signalEvidence(replacementWithLink, options),
    (model, events) => {
      const previous = model.signals.get(signalId);
      if (!previous) throw new Error(`SIGNAL_NOT_FOUND: ${signalId}`);
      assertSignalEventScope(events, signalId, scope);
      const existingReplacement = model.signals.get(replacementWithLink.signal_id);
      if (existingReplacement) assertSignalEventScope(events, replacementWithLink.signal_id, scope);
      if (previous.status === "superseded" && existingReplacement) {
        const existingHash = signalHash({ ...existingReplacement, status: "active" });
        if (existingHash !== signalHash(replacementWithLink)) {
          throw new Error(
            `SIGNAL_ID_CONFLICT: ${replacementWithLink.signal_id} already has different content`,
          );
        }
        return [
          { op: "publish_signal", signal: replacementWithLink },
          {
            op: "supersede_signal",
            signal_id: signalId,
            replacement_signal_id: replacementWithLink.signal_id,
          },
        ];
      }
      if (previous.status !== "active") {
        throw new Error(`SIGNAL_STATE_CONFLICT: ${signalId} is already ${previous.status}`);
      }
      assertSignalCanBePublished(model, replacementWithLink);
      return [
        { op: "publish_signal", signal: replacementWithLink },
        {
          op: "supersede_signal",
          signal_id: signalId,
          replacement_signal_id: replacementWithLink.signal_id,
        },
      ];
    },
    {
      scope,
      context: options.context ?? signalContext(replacementWithLink),
      producerKind: "research-wiki-signal",
      eventType: "signal_superseded",
    },
  );
  if (result.status === "conflict") {
    throw new Error(
      `WIKI_COMMAND_CONFLICT: command ${result.command_id} conflicts with an existing payload`,
    );
  }
  return result;
}

function printSignalWriteResult(
  result: WikiAppendResult | { status: "skipped"; event: null },
  signalId: string,
  wikiRoot: string,
): void {
  const event = "event" in result ? result.event : null;
  console.log(
    JSON.stringify({
      status: result.status,
      signal_id: signalId,
      event_id: event?.event_id ?? null,
      command_id: event?.command_id ?? null,
      wiki_head: eventLogHead(readWikiEvents(wikiRoot)),
    }),
  );
}

function readJsonObject(filePath: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error: unknown) {
    throw new Error(
      `cannot read JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(value)) throw new Error(`JSON file ${filePath} must contain an object`);
  return value;
}

function signalFromJson(value: JsonObject): WikiSignal {
  const signal = value.signal && isObject(value.signal) ? value.signal : value;
  return signal as unknown as WikiSignal;
}

function parseSignalOptions(options: {
  signalFile?: string;
  signalId?: string;
  kind?: string;
  source?: string;
  producerModuleId?: string;
  producerModuleVersion?: string;
  producerRunId?: string;
  workflowId?: string;
  workflowRevision?: string;
  inputSnapshotId?: string;
  contractVersions?: string;
  scorerRevision?: string;
  scorerTarget?: string;
  constraints?: string;
  evidenceRefs?: string;
  supersedes?: string;
  summary?: string;
  observation?: string;
  inference?: string;
  recommendation?: string;
}): WikiSignal {
  const fromFile: JsonObject = options.signalFile
    ? (signalFromJson(readJsonObject(options.signalFile)) as unknown as JsonObject)
    : {};
  const appliesTo = (isObject(fromFile.applies_to) ? fromFile.applies_to : {}) as unknown as {
    workflow_id?: string;
    workflow_revision?: string;
    input_snapshot_id?: string;
    contract_versions?: unknown;
    scorer_revision?: string;
    scorer_target?: unknown;
    constraints?: unknown[];
  };
  const producer = isObject(fromFile.producer) ? fromFile.producer : {};
  const list = (value: string | undefined, fallback: unknown): string[] =>
    value === undefined ? (Array.isArray(fallback) ? (fallback as string[]) : []) : splitCsv(value);
  const kind = options.kind ?? fromFile.kind;
  const source = options.source ?? fromFile.source;
  if (!WIKI_SIGNAL_KINDS.includes(kind as WikiSignalKind)) {
    throw new Error(`signal kind must be one of ${WIKI_SIGNAL_KINDS.join(", ")}`);
  }
  if (!WIKI_SIGNAL_SOURCES.includes(source as WikiSignalSource)) {
    throw new Error(`signal source must be one of ${WIKI_SIGNAL_SOURCES.join(", ")}`);
  }
  const scorerTarget =
    options.scorerTarget === undefined
      ? appliesTo.scorer_target
      : parseJsonOrString(options.scorerTarget);
  let constraints = appliesTo.constraints;
  if (options.constraints !== undefined) {
    const parsed = JSON.parse(options.constraints) as unknown;
    if (!Array.isArray(parsed)) throw new Error("--constraints must be a JSON array");
    constraints = parsed;
  }
  return {
    ...(fromFile as unknown as WikiSignal),
    signal_id: options.signalId ?? (fromFile.signal_id as string),
    kind: kind as WikiSignalKind,
    source: source as WikiSignalSource,
    producer: {
      module_id: options.producerModuleId ?? (producer.module_id as string),
      module_version: options.producerModuleVersion ?? (producer.module_version as string),
      run_id: options.producerRunId ?? (producer.run_id as string),
    },
    applies_to: {
      ...appliesTo,
      ...(options.workflowId === undefined ? {} : { workflow_id: options.workflowId }),
      ...(options.workflowRevision === undefined
        ? {}
        : { workflow_revision: options.workflowRevision }),
      ...(options.inputSnapshotId === undefined
        ? {}
        : { input_snapshot_id: options.inputSnapshotId }),
      ...(options.scorerRevision === undefined ? {} : { scorer_revision: options.scorerRevision }),
      ...(scorerTarget === undefined ? {} : { scorer_target: scorerTarget }),
      ...(constraints === undefined ? {} : { constraints }),
      contract_versions: list(options.contractVersions, appliesTo.contract_versions),
    },
    evidence_refs: list(options.evidenceRefs, fromFile.evidence_refs),
    supersedes: list(options.supersedes, fromFile.supersedes),
    status: "active",
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.observation === undefined ? {} : { observation: options.observation }),
    ...(options.inference === undefined ? {} : { inference: options.inference }),
    ...(options.recommendation === undefined ? {} : { recommendation: options.recommendation }),
  };
}

function signalWriteCommandOptions(command: {
  signalFile?: string;
  signalId?: string;
  kind?: string;
  source?: string;
  producerModuleId?: string;
  producerModuleVersion?: string;
  producerRunId?: string;
  workflowId?: string;
  workflowRevision?: string;
  inputSnapshotId?: string;
  contractVersions?: string;
  scorerRevision?: string;
  scorerTarget?: string;
  constraints?: string;
  evidenceRefs?: string;
  supersedes?: string;
  summary?: string;
  observation?: string;
  inference?: string;
  recommendation?: string;
  scope?: string;
  evidenceBundleId?: string;
}): WikiSignal {
  return parseSignalOptions(command);
}

type SignalCliOptions = {
  projectRoot?: string;
  runId?: string;
  signalFile?: string;
  signalId?: string;
  kind?: string;
  source?: string;
  producerModuleId?: string;
  producerModuleVersion?: string;
  producerRunId?: string;
  workflowId?: string;
  workflowRevision?: string;
  inputSnapshotId?: string;
  contractVersions?: string;
  scorerRevision?: string;
  scorerTarget?: string;
  constraints?: string;
  evidenceRefs?: string;
  supersedes?: string;
  summary?: string;
  observation?: string;
  inference?: string;
  recommendation?: string;
  scope?: string;
  evidenceBundleId?: string;
};

function addSignalPublishOptions(command: Command): Command {
  return command
    .option("--signal-file <path>", "JSON file containing a complete signal")
    .option("--signal-id <id>", "Stable signal id, for example signal:rl-t3")
    .option("--kind <kind>", `Signal kind: ${WIKI_SIGNAL_KINDS.join(" | ")}`)
    .option("--source <source>", `Evidence source: ${WIKI_SIGNAL_SOURCES.join(" | ")}`)
    .option("--producer-module-id <id>", "Producing module id")
    .option("--producer-module-version <version>", "Producing module version")
    .option("--producer-run-id <id>", "Producing run id")
    .option("--workflow-id <id>", "Workflow identity")
    .option("--workflow-revision <id>", "Frozen workflow revision")
    .option("--input-snapshot-id <id>", "Frozen input snapshot")
    .option("--contract-versions <list>", "Comma-separated contract versions")
    .option("--scorer-revision <id>", "Frozen scorer revision")
    .option("--scorer-target <value>", "Frozen scorer target identifier or JSON value")
    .option("--constraints <json>", "Frozen scorer/workflow constraints as a JSON array")
    .option("--evidence-refs <list>", "Comma-separated evidence references")
    .option("--supersedes <list>", "Comma-separated signal ids being replaced")
    .option("--summary <text>", "Short signal summary")
    .option("--observation <text>", "Observed fact")
    .option("--inference <text>", "Bounded inference")
    .option("--recommendation <text>", "Suggested direction")
    .option("--project-root <path>", "Contract project root for a scoped write")
    .option("--run-id <id>", "Owning run for a scoped write")
    .option("--scope <scope>", "Event scope; defaults to standalone")
    .option("--evidence-bundle-id <id>", "Stable evidence bundle id");
}

function signalContext(signal: WikiSignal): WikiPayloadContext {
  return {
    ...(signal.applies_to.workflow_id === undefined
      ? {}
      : { workflow_id: signal.applies_to.workflow_id }),
    module_version: signal.producer.module_version,
    ...(signal.applies_to.workflow_revision === undefined
      ? {}
      : { workflow_revision: signal.applies_to.workflow_revision }),
    ...(signal.applies_to.input_snapshot_id === undefined
      ? {}
      : { input_snapshot_id: signal.applies_to.input_snapshot_id }),
    contract_versions: [...signal.applies_to.contract_versions],
    ...(signal.applies_to.scorer_revision === undefined
      ? {}
      : { scorer_revision: signal.applies_to.scorer_revision }),
    ...(signal.applies_to.scorer_target === undefined
      ? {}
      : { scorer_target: signal.applies_to.scorer_target }),
    ...(signal.applies_to.constraints === undefined
      ? {}
      : { constraints: signal.applies_to.constraints }),
    module_id: signal.producer.module_id,
  };
}

type QueryCliOptions = {
  manifest?: string;
  consumer?: ResearchWikiQueryRequest["consumer"];
  requestFile?: string;
  scope?: string;
  purpose?: string;
  requester?: string;
  moduleId?: string;
  moduleVersion?: string;
  workflowId?: string;
  workflowRevision?: string;
  inputSnapshotId?: string;
  contractVersions?: string;
  scorerRevision?: string;
  scorerTarget?: string;
  constraints?: string;
  head?: string;
  headSeq?: string;
  headEventId?: string;
  headEventHash?: string;
  allowStandalone?: boolean;
  text?: boolean;
};

function queryRequestFromOptions(options: QueryCliOptions): ResearchWikiQueryRequest {
  const fromFile = options.requestFile ? readJsonObject(options.requestFile) : {};
  const request: ResearchWikiQueryRequest = {
    ...(fromFile as unknown as ResearchWikiQueryRequest),
    ...(options.manifest === undefined ? {} : { manifest_path: options.manifest }),
    ...(options.consumer === undefined ? {} : { consumer: options.consumer }),
    scope: options.scope ?? (fromFile.scope as string | undefined) ?? "standalone",
    purpose: options.purpose ?? (fromFile.purpose as string | undefined) ?? "manual-query",
    requester: options.requester ?? (fromFile.requester as string | undefined) ?? "human",
    ...(options.moduleId === undefined ? {} : { module_id: options.moduleId }),
    ...(options.moduleVersion === undefined ? {} : { module_version: options.moduleVersion }),
    ...(options.workflowId === undefined ? {} : { workflow_id: options.workflowId }),
    ...(options.workflowRevision === undefined
      ? {}
      : { workflow_revision: options.workflowRevision }),
    ...(options.inputSnapshotId === undefined
      ? {}
      : { input_snapshot_id: options.inputSnapshotId }),
    ...(options.contractVersions === undefined
      ? {}
      : { contract_versions: splitCsv(options.contractVersions) }),
    ...(options.scorerRevision === undefined ? {} : { scorer_revision: options.scorerRevision }),
    ...(options.scorerTarget === undefined
      ? {}
      : { scorer_target: parseJsonOrString(options.scorerTarget) }),
    ...(options.constraints === undefined
      ? {}
      : { constraints: JSON.parse(options.constraints) as unknown[] }),
    ...(options.allowStandalone === undefined ? {} : { allow_standalone: options.allowStandalone }),
  };
  if (options.head !== undefined) request.head = options.head;
  else if (
    options.headSeq !== undefined ||
    options.headEventId !== undefined ||
    options.headEventHash !== undefined
  ) {
    request.head = {
      seq: options.headSeq === undefined ? 0 : Number.parseInt(options.headSeq, 10),
      event_id: options.headEventId ?? null,
      event_hash: options.headEventHash ?? null,
    };
  }
  return request;
}

function runQueryCommand(wikiRoot: string, options: QueryCliOptions): void {
  const result = queryWiki(path.resolve(wikiRoot), queryRequestFromOptions(options));
  if (options.text === true) console.log(result.query_pack);
  else console.log(JSON.stringify(result, null, 2));
}

function addSignalRetractionOptions(command: Command): Command {
  return command
    .option("--signal-id <id>", "Signal id to retract")
    .option("--reason <text>", "Why the signal is no longer valid", "")
    .option("--evidence-refs <list>", "Comma-separated replacement evidence references")
    .option("--project-root <path>", "Contract project root for a scoped write")
    .option("--run-id <id>", "Owning run for a scoped write")
    .option("--scope <scope>", "Event scope; defaults to standalone")
    .option("--evidence-bundle-id <id>", "Stable evidence bundle id");
}

function publishSignalCommand(wikiRoot: string, options: SignalCliOptions): void {
  const signal = signalWriteCommandOptions(options);
  const result = publishSignal(path.resolve(wikiRoot), signal, {
    projectRoot: options.projectRoot,
    runId: options.runId,
    scope: options.scope,
    evidenceBundleId: options.evidenceBundleId,
    context: signalContext(signal),
  });
  printSignalWriteResult(result, signal.signal_id, wikiRoot);
}

function retractSignalCommand(
  wikiRoot: string,
  options: SignalCliOptions & { reason?: string },
): void {
  if (!options.signalId) throw new Error("--signal-id is required");
  const result = retractSignal(path.resolve(wikiRoot), options.signalId, {
    projectRoot: options.projectRoot,
    runId: options.runId,
    scope: options.scope,
    evidenceBundleId: options.evidenceBundleId,
    reason: options.reason || undefined,
    evidenceRefs: options.evidenceRefs ? splitCsv(options.evidenceRefs) : undefined,
  });
  printSignalWriteResult(result, options.signalId, wikiRoot);
}

function registerSignalCommands(parent: Command): void {
  const signalParent = parent
    .command("signal")
    .description("Publish, retract, or supersede a Wiki signal");
  const publish = addSignalPublishOptions(
    signalParent
      .command("publish")
      .description("Publish one evidence-backed Signal through the event log")
      .argument("<wiki_root>"),
  );
  publish.action((wikiRoot: string, options: SignalCliOptions) =>
    publishSignalCommand(wikiRoot, options),
  );

  const retract = addSignalRetractionOptions(
    signalParent
      .command("retract")
      .description("Retract an existing Signal through the event log")
      .argument("<wiki_root>"),
  );
  retract.action((wikiRoot: string, options: SignalCliOptions & { reason?: string }) =>
    retractSignalCommand(wikiRoot, options),
  );

  const supersede = addSignalPublishOptions(
    signalParent
      .command("supersede")
      .description("Publish a replacement Signal and mark the old one superseded")
      .argument("<wiki_root>")
      .requiredOption("--previous-signal-id <id>", "Existing Signal being replaced"),
  );
  supersede.action((wikiRoot: string, options: SignalCliOptions & { previousSignalId: string }) => {
    const replacement = signalWriteCommandOptions(options);
    const result = supersedeSignal(path.resolve(wikiRoot), options.previousSignalId, replacement, {
      projectRoot: options.projectRoot,
      runId: options.runId,
      scope: options.scope,
      evidenceBundleId: options.evidenceBundleId,
      context: signalContext(replacement),
    });
    printSignalWriteResult(result, replacement.signal_id, wikiRoot);
  });

  const flatPublish = addSignalPublishOptions(
    parent
      .command("publish_signal")
      .description("Stable alias for `signal publish`")
      .argument("<wiki_root>"),
  );
  flatPublish.action((wikiRoot: string, options: SignalCliOptions) =>
    publishSignalCommand(wikiRoot, options),
  );

  const flatRetract = addSignalRetractionOptions(
    parent
      .command("retract_signal")
      .description("Stable alias for `signal retract`")
      .argument("<wiki_root>"),
  );
  flatRetract.action((wikiRoot: string, options: SignalCliOptions & { reason?: string }) =>
    retractSignalCommand(wikiRoot, options),
  );

  const flatSupersede = addSignalPublishOptions(
    parent
      .command("supersede_signal")
      .description("Stable alias for `signal supersede`")
      .argument("<wiki_root>")
      .requiredOption("--previous-signal-id <id>", "Existing Signal being replaced"),
  );
  flatSupersede.action(
    (wikiRoot: string, options: SignalCliOptions & { previousSignalId: string }) => {
      const replacement = signalWriteCommandOptions(options);
      const result = supersedeSignal(
        path.resolve(wikiRoot),
        options.previousSignalId,
        replacement,
        {
          projectRoot: options.projectRoot,
          runId: options.runId,
          scope: options.scope,
          evidenceBundleId: options.evidenceBundleId,
          context: signalContext(replacement),
        },
      );
      printSignalWriteResult(result, replacement.signal_id, wikiRoot);
    },
  );
}

function addQueryOptions(command: Command): Command {
  return command
    .option("--manifest <path>", "Sealed worker input manifest")
    .option("--consumer <kind>", "research, outer-gate, stop-gate, or candidate-selection")
    .option("--request-file <path>", "JSON file containing the complete query request")
    .option("--scope <scope>", "Visible event scope; defaults to standalone")
    .option("--purpose <text>", "Why the caller needs this query")
    .option("--requester <id>", "Requesting worker or user")
    .option("--module-id <id>", "Requesting module identity")
    .option("--module-version <version>", "Frozen module version")
    .option("--workflow-id <id>", "Workflow identity")
    .option("--workflow-revision <id>", "Frozen workflow revision")
    .option("--input-snapshot-id <id>", "Frozen input snapshot")
    .option("--contract-versions <list>", "Comma-separated contract versions")
    .option("--scorer-revision <id>", "Frozen scorer revision")
    .option("--scorer-target <value>", "Frozen scorer target identifier or JSON value")
    .option("--constraints <json>", "Frozen scorer/workflow constraints as a JSON array")
    .option("--head <event-id>", "Freeze the query at this event id")
    .option("--head-seq <n>", "Freeze the query at this event sequence")
    .option("--head-event-id <event-id>", "Expected event id at --head-seq")
    .option("--head-event-hash <sha256>", "Expected event hash at --head-seq")
    .option(
      "--allow-standalone",
      "Explicitly include standalone events in a scoped query; never enables decisions",
    )
    .option("--text", "Print only the deterministic query pack");
}

async function syncPapers(root: string, ids: string[], updateOnExist: boolean): Promise<void> {
  const metadata = await fetchArxivMetadataBatch(ids);
  for (const original of ids) {
    const normalized = normalizeArxivId(original);
    await ingestPaper(root, {
      arxivId: original,
      prefetchedMeta: metadata[normalized],
      updateOnExist,
    });
  }
}

const program = createCli("research-wiki", "ARIS Research Wiki utilities");

program
  .command("seal-worker-manifest")
  .requiredOption("--input <path>", "Dispatch assignment JSON")
  .action((options: { input: string }) => {
    console.log(
      JSON.stringify(
        sealWikiWorkerManifest(readJsonObject(options.input) as unknown as WikiWorkerManifestInput),
      ),
    );
  });

const queryCommand = addQueryOptions(
  program
    .command("query")
    .description("Query one frozen Wiki scope and return a deterministic, read-only result")
    .argument("<wiki_root>"),
);
queryCommand.action((wikiRoot: string, options: QueryCliOptions) =>
  runQueryCommand(wikiRoot, options),
);

const queryPackCommand = addQueryOptions(
  program
    .command("query_pack")
    .description("Stable alias for `query`; returns the same frozen scope result")
    .argument("<wiki_root>"),
);
queryPackCommand.action((wikiRoot: string, options: QueryCliOptions) =>
  runQueryCommand(wikiRoot, options),
);

registerSignalCommands(program);

program
  .command("init")
  .description("Initialize an event-sourced schema v2 wiki directory")
  .argument("<wiki_root>")
  .action((wikiRoot: string) => initWiki(wikiRoot));

program
  .command("slug")
  .description("Generate a canonical slug for a paper title")
  .argument("<title>")
  .option("--author <name>", "Author last name", "")
  .option("--year <n>", "Publication year", "0")
  .action((title: string, options: { author: string; year: string }) => {
    console.log(slugify(title, options.author, Number.parseInt(options.year, 10)));
  });

program
  .command("add_edge")
  .description("Add a typed edge to the relationship graph")
  .argument("<wiki_root>")
  .requiredOption("--from <id>")
  .requiredOption("--to <id>")
  .requiredOption("--type <type>")
  .option("--evidence <text>", "Evidence text", "")
  .action(
    (wikiRoot: string, options: { from: string; to: string; type: string; evidence: string }) =>
      addEdge(wikiRoot, options.from, options.to, options.type, options.evidence),
  );

program
  .command("rebuild_query_pack")
  .description("Regenerate query_pack.md from events")
  .argument("<wiki_root>")
  .option("--max-chars <n>", "Persist a new query-pack size limit")
  .action((wikiRoot: string, options: { maxChars?: string }) =>
    rebuildQueryPack(
      wikiRoot,
      options.maxChars === undefined ? undefined : Number.parseInt(options.maxChars, 10),
    ),
  );

program
  .command("rebuild_index")
  .description("Regenerate index.md from events")
  .argument("<wiki_root>")
  .action((wikiRoot: string) => rebuildIndex(wikiRoot));

program
  .command("rebuild")
  .description("Rebuild every projection from schema.json and events.jsonl")
  .argument("<wiki_root>")
  .action((wikiRoot: string) => rebuildWiki(wikiRoot));

program
  .command("stats")
  .description("Print wiki statistics")
  .argument("<wiki_root>")
  .option("--json", "Emit machine-readable stats")
  .action((wikiRoot: string, options: { json?: boolean }) =>
    getStats(wikiRoot, options.json === true),
  );

program
  .command("log")
  .description("Append a timeline entry to the event log")
  .argument("<wiki_root>")
  .argument("<message>")
  .action((wikiRoot: string, message: string) => appendLog(wikiRoot, message));

program
  .command("ingest_paper")
  .description("Create or update a paper page through an event")
  .argument("<wiki_root>")
  .option("--arxiv-id <id>", "arXiv identifier", "")
  .option("--title <title>", "Paper title", "")
  .option("--authors <list>", "Comma-separated author list", "")
  .option("--year <n>", "Publication year", "0")
  .option("--venue <venue>", "Venue", "")
  .option("--external-id-doi <doi>", "DOI", "")
  .option("--thesis <text>", "One-line thesis", "")
  .option("--tags <list>", "Comma-separated tag list", "")
  .option("--update-on-exist", "Overwrite an existing page", false)
  .action(
    async (
      wikiRoot: string,
      options: {
        arxivId: string;
        title: string;
        authors: string;
        year: string;
        venue: string;
        externalIdDoi: string;
        thesis: string;
        tags: string;
        updateOnExist: boolean;
      },
    ) => {
      await ingestPaper(wikiRoot, {
        arxivId: options.arxivId || undefined,
        title: options.title || undefined,
        authors: splitCsv(options.authors),
        year: Number.parseInt(options.year, 10),
        venue: options.venue,
        doi: options.externalIdDoi,
        thesis: options.thesis,
        tags: splitCsv(options.tags),
        updateOnExist: options.updateOnExist,
      });
    },
  );

program
  .command("add_claim")
  .description("Create or update a claim page through an event")
  .argument("<wiki_root>")
  .option("--slug <slug>", "Stable claim id", "")
  .requiredOption("--name <name>", "Human-readable claim name")
  .option("--description <text>", "One-line description", "")
  .option("--status <status>", "Claim status", "drafted")
  .option("--provenance <path>", "Run directory", "")
  .option("--statement <text>", "Formal statement", "")
  .option("--scope <text>", "Honest scope", "")
  .option("--evidence <text>", "Evidence chain", "")
  .option("--tags <list>", "Comma-separated tag list", "")
  .option("--addresses <list>", "Problem ids", "")
  .option("--extends <list>", "Paper ids", "")
  .option("--uses <list>", "Paper ids", "")
  .option("--depends-on <list>", "Claim ids", "")
  .option("--refutes <list>", "Claim ids", "")
  .option("--update-on-exist", "Overwrite an existing claim", false)
  .action(
    (
      wikiRoot: string,
      options: {
        slug: string;
        name: string;
        description: string;
        status: string;
        provenance: string;
        statement: string;
        scope: string;
        evidence: string;
        tags: string;
        addresses: string;
        extends: string;
        uses: string;
        dependsOn: string;
        refutes: string;
        updateOnExist: boolean;
      },
    ) => {
      addClaim(wikiRoot, options.slug, options.name, {
        description: options.description,
        status: options.status,
        provenance: options.provenance,
        statement: options.statement,
        scope: options.scope,
        evidence: options.evidence,
        tags: splitCsv(options.tags),
        addresses: splitCsv(options.addresses),
        extends: splitCsv(options.extends),
        uses: splitCsv(options.uses),
        dependsOn: splitCsv(options.dependsOn),
        refutes: splitCsv(options.refutes),
        updateOnExist: options.updateOnExist,
      });
    },
  );

program
  .command("upsert_idea")
  .description("Create or update an idea page through an event")
  .argument("<wiki_root>")
  .option("--slug <slug>", "Stable idea id", "")
  .requiredOption("--title <title>", "Human-readable idea title")
  .option("--description <text>", "One-line description", "")
  .option("--stage <stage>", "Idea stage", "proposed")
  .option("--outcome <outcome>", "Idea outcome", "pending")
  .option("--thesis <text>", "Core hypothesis", "")
  .option("--risks <text>", "Risks", "")
  .option("--tags <list>", "Comma-separated tag list", "")
  .option("--based-on <list>", "Paper ids", "")
  .option("--target-problems <list>", "Problem ids", "")
  .option("--update-on-exist", "Overwrite an existing idea", false)
  .action(
    (
      wikiRoot: string,
      options: {
        slug: string;
        title: string;
        description: string;
        stage: string;
        outcome: string;
        thesis: string;
        risks: string;
        tags: string;
        basedOn: string;
        targetProblems: string;
        updateOnExist: boolean;
      },
    ) => {
      upsertIdea(wikiRoot, options.slug, options.title, {
        description: options.description,
        stage: options.stage,
        outcome: options.outcome,
        thesis: options.thesis,
        risks: options.risks,
        tags: splitCsv(options.tags),
        basedOn: splitCsv(options.basedOn),
        targetProblems: splitCsv(options.targetProblems),
        updateOnExist: options.updateOnExist,
      });
    },
  );

program
  .command("add_problem")
  .description("Create or update a problem page through an event")
  .argument("<wiki_root>")
  .option("--title <title>", "Human-readable problem title")
  .option("--slug <slug>", "Stable problem id", "")
  .option("--status <status>", "Problem status")
  .option("--severity <severity>", "Problem severity")
  .option("--parent <id>", "Parent problem id", "")
  .option("--statement <text>", "What is unsolved", "")
  .option("--origin <text>", "Why it exists", "")
  .option("--evidence <text>", "Evidence", "")
  .option("--what-would-solve <text>", "Closing result", "")
  .option("--caveats <text>", "Caveats", "")
  .option("--tags <list>", "Comma-separated tag list", "")
  .option("--update-on-exist", "Overwrite an existing problem", false)
  .action(
    (
      wikiRoot: string,
      options: {
        title?: string;
        slug: string;
        status?: string;
        severity?: string;
        parent: string;
        statement: string;
        origin: string;
        evidence: string;
        whatWouldSolve: string;
        caveats: string;
        tags: string;
        updateOnExist: boolean;
      },
    ) => {
      addProblem(wikiRoot, options.slug, options.title ?? "", {
        status: options.status,
        severity: options.severity,
        parent: options.parent || undefined,
        statement: options.statement || undefined,
        origin: options.origin || undefined,
        evidence: options.evidence || undefined,
        whatWouldSolve: options.whatWouldSolve || undefined,
        caveats: options.caveats || undefined,
        tags: options.tags ? splitCsv(options.tags) : undefined,
        updateOnExist: options.updateOnExist,
      });
    },
  );

program
  .command("add_experiment")
  .description("Create or update an experiment page through an event")
  .argument("<wiki_root>")
  .requiredOption("--slug <slug>", "Stable experiment id")
  .option("--title <title>", "Human-readable label", "")
  .option("--idea <id>", "Idea id", "")
  .option("--verdict <verdict>", "yes | partial | no", "no")
  .option("--confidence <confidence>", "high | medium | low", "medium")
  .option("--date <date>", "Run date", "")
  .option("--hardware <hardware>", "Hardware", "")
  .option("--duration <duration>", "Duration", "")
  .option("--metrics <text>", "Key metrics", "")
  .option("--reasoning <text>", "Reasoning", "")
  .option("--provenance <path>", "Run directory", "")
  .option("--tags <list>", "Comma-separated tag list", "")
  .option("--iteration <n>", "Outer loop iteration this experiment belongs to", "")
  .option("--gate-metric <value>", "This iteration's metric-gate reading", "")
  .option("--tester-feedback <path>", "Signed public tester feedback receipt", "")
  .option("--tester-public-key <path>", "Public key that verifies the receipt", "")
  .option("--update-on-exist", "Overwrite an existing experiment", false)
  .action(
    (
      wikiRoot: string,
      options: {
        slug: string;
        title: string;
        idea: string;
        verdict: string;
        confidence: string;
        date: string;
        hardware: string;
        duration: string;
        metrics: string;
        reasoning: string;
        provenance: string;
        tags: string;
        iteration: string;
        gateMetric: string;
        testerFeedback: string;
        testerPublicKey: string;
        updateOnExist: boolean;
      },
    ) => {
      // A receipt without its key cannot be verified, and a key without a
      // receipt has nothing to verify, so neither half is accepted alone.
      if (Boolean(options.testerFeedback) !== Boolean(options.testerPublicKey))
        throw new Error("--tester-feedback and --tester-public-key must be given together");
      addExperiment(wikiRoot, options.slug, {
        title: options.title,
        idea: options.idea,
        verdict: options.verdict,
        confidence: options.confidence,
        date: options.date,
        hardware: options.hardware,
        duration: options.duration,
        metrics: options.metrics,
        reasoning: options.reasoning,
        provenance: options.provenance,
        tags: splitCsv(options.tags),
        iteration: optionalCliInteger(options.iteration, "--iteration", 1),
        gateMetric: optionalCliNumber(options.gateMetric, "--gate-metric"),
        testerReceipt: options.testerFeedback
          ? { receipt: options.testerFeedback, publicKey: options.testerPublicKey }
          : undefined,
        updateOnExist: options.updateOnExist,
      });
    },
  );

program
  .command("sync")
  .description("Batch ingest papers from arXiv ids")
  .argument("<wiki_root>")
  .option("--arxiv-ids <list>", "Comma-separated ids", "")
  .option("--from-file <path>", "Newline-delimited ids", "")
  .option("--update-on-exist", "Overwrite existing pages", false)
  .action(
    async (
      wikiRoot: string,
      options: { arxivIds: string; fromFile: string; updateOnExist: boolean },
    ) => {
      const ids: string[] = [];
      if (options.arxivIds) ids.push(...splitCsv(options.arxivIds));
      if (options.fromFile) {
        if (!fs.existsSync(options.fromFile)) {
          console.error(`--from-file not found: ${options.fromFile}`);
          process.exit(2);
        }
        for (const line of fs.readFileSync(options.fromFile, "utf-8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) ids.push(trimmed);
        }
      }
      if (ids.length === 0) {
        console.error("sync: no arxiv ids supplied (use --arxiv-ids or --from-file)");
        process.exit(2);
      }
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const id of ids) {
        const normalized = normalizeArxivId(id);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(id);
      }
      console.log(`sync: ${unique.length} unique arxiv id(s)`);
      await syncPapers(wikiRoot, unique, options.updateOnExist);
    },
  );

// Two commands, because a package cannot be reviewed after it is published and
// cannot be published before it is reviewed. `plan_result_package` shows the
// reviewer exactly what would be written, including the digest it has to sign;
// `export_result_package` writes it and refuses unless a stored approval names
// that same digest.
program
  .command("plan_result_package")
  .description("Show the result package this run would publish, without publishing it")
  .argument("<project_root>")
  .requiredOption("--run <run_id>", "Run whose Wiki and dashboard are read")
  .option("--wiki-root <path>", "Wiki directory; defaults to the run's own Wiki", "")
  .option("--tester-definition <path>", "Frozen tester definition naming the declared metrics", "")
  .option("--summary <text>", "Package summary; a default one is written when omitted", "")
  .option(
    "--status <status>",
    "succeeded | failed | not_executable | infra_unavailable",
    "succeeded",
  )
  .action(
    (
      projectRoot: string,
      options: {
        run: string;
        wikiRoot: string;
        testerDefinition: string;
        summary: string;
        status: string;
      },
    ) => {
      const plan = planResultExport({
        project_root: projectRoot,
        run_id: options.run,
        wiki_root: options.wikiRoot || undefined,
        tester_definition_path: options.testerDefinition || undefined,
        summary: options.summary || undefined,
        status: options.status as ResultStatus,
      });
      console.log(
        JSON.stringify(
          {
            winner: plan.winner,
            ranked_iterations: plan.ranked.map((candidate) => candidate.iteration),
            package_sha256: plan.candidate.package_sha256,
            candidate: plan.candidate,
          },
          null,
          2,
        ),
      );
    },
  );

program
  .command("submit_result_review")
  .description("Record a reviewer's verdict on a planned result package")
  .argument("<project_root>")
  .requiredOption("--run <run_id>", "Run whose package was reviewed")
  .requiredOption("--review-id <id>", "Names this acceptance")
  .requiredOption("--reviewer <worker_id>", "Reviewer; never the run being reviewed")
  .requiredOption("--package-sha256 <hex>", "Digest from plan_result_package")
  .requiredOption("--verdict <verdict>", "approved | rejected")
  .option("--evidence <ref...>", "What the reviewer read", [])
  .option("--reason <code...>", "Coarse reason codes", [])
  .action(
    (
      projectRoot: string,
      options: {
        run: string;
        reviewId: string;
        reviewer: string;
        packageSha256: string;
        verdict: string;
        evidence: string[];
        reason: string[];
      },
    ) => {
      const review = saveResultReview(projectRoot, {
        schema_version: 1,
        review_id: options.reviewId,
        run_id: options.run,
        reviewer_worker_id: options.reviewer,
        package_sha256: options.packageSha256,
        verdict: options.verdict,
        evidence_refs: options.evidence,
        reason_codes: options.reason,
      });
      console.log(JSON.stringify(review, null, 2));
    },
  );

program
  .command("export_result_package")
  .description("Pick this run's best iteration from the Wiki and write its result package")
  .argument("<project_root>")
  .requiredOption("--run <run_id>", "Run whose Wiki and dashboard are read")
  .requiredOption("--review-id <id>", "The stored acceptance that approved this package")
  .option("--wiki-root <path>", "Wiki directory; defaults to the run's own Wiki", "")
  .option("--tester-definition <path>", "Frozen tester definition naming the declared metrics", "")
  .option("--summary <text>", "Package summary; a default one is written when omitted", "")
  .option(
    "--status <status>",
    "succeeded | failed | not_executable | infra_unavailable",
    "succeeded",
  )
  .action(
    (
      projectRoot: string,
      options: {
        run: string;
        reviewId: string;
        wikiRoot: string;
        testerDefinition: string;
        summary: string;
        status: string;
      },
    ) => {
      const exported = exportResultPackage({
        project_root: projectRoot,
        run_id: options.run,
        wiki_root: options.wikiRoot || undefined,
        tester_definition_path: options.testerDefinition || undefined,
        summary: options.summary || undefined,
        status: options.status as ResultStatus,
        review: { review_id: options.reviewId },
      });
      console.log(
        JSON.stringify(
          {
            winner: exported.winner,
            ranked_iterations: exported.ranked.map((candidate) => candidate.iteration),
            result_package: exported.result_package,
          },
          null,
          2,
        ),
      );
    },
  );

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(program);
}
