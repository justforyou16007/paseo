#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { quarantine } from "./threat-scan.js";
import { anyJsonSchema, canonicalJsonSha256 } from "./canonical-json.js";
import {
  assertWikiSchemaSupported,
  commitWikiChange,
  eventLogHead,
  initializeWikiSchema,
  type WikiDelta,
  type WikiEvent,
  type WikiAppendResult,
} from "./wiki-event-store.js";
import { WIKI_EDGE_TYPES, isWikiEdgeType } from "./wiki-operations.js";
import {
  projectWiki,
  projectWikiFromEvents,
  readWikiModel,
  replayWikiEvents,
  type WikiModel,
  type WikiPageKind,
} from "./wiki-projector.js";

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

/** task.md beside the wiki is the whole task; the query pack carries its sections. */
function captureProjectDirection(wikiRoot: string): string | null {
  const taskPath = path.join(path.dirname(path.resolve(wikiRoot)), "task.md");
  return fs.existsSync(taskPath) ? fs.readFileSync(taskPath, "utf-8") : null;
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

function commitOperations(
  wikiRoot: string,
  subjectId: string,
  evidenceBundleId: EvidenceBundleId,
  build: OperationBuilder,
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
        producer_kind: "standalone-research-wiki",
        scope: "standalone",
        subject_id: subjectId,
        evidence_bundle_id: evidence || subjectId,
        payload: { operations: withProjectionContext(wikiRoot, model, operations) },
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
    /** Validation service submission whose published result these metrics come from. */
    submissionId?: string;
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
  const subject = `exp:${slug}`;
  let existedBefore = false;
  let reused = false;
  const result = commitOperations(root, subject, options.provenance || subject, (model) => {
    existedBefore = model.pages.experiment.has(slug);
    reused = false;
    // An experiment that already supports or invalidates a claim has been
    // judged. Writing it again under the same id would either replace the
    // evidence those claims stand on or strip their edges, so the existing
    // page is reused as it is, even with --update-on-exist.
    if (
      existedBefore &&
      model.edges.some(
        (edge) =>
          edge.from === subject &&
          (edge.type === "supports" || edge.type === "invalidates") &&
          edge.to.startsWith("claim:"),
      )
    ) {
      reused = true;
      return null;
    }
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
        ...(options.submissionId ? { submission_id: options.submissionId } : {}),
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
  if (reused) {
    console.log(
      `Experiment reused: ${path.join(root, "experiments", `${slug}.md`)} already formed claims; page and claim edges kept.`,
    );
    return;
  }
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
  .option(
    "--submission <id>",
    "Validation submission whose published result the metrics come from",
    "",
  )
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
        submission: string;
        updateOnExist: boolean;
      },
    ) => {
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
        submissionId: options.submission || undefined,
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(program);
}
