#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const ARXIV_API = "https://export.arxiv.org/api/query";
const CROSSREF_API = "https://api.crossref.org/works";
const S2_API = "https://api.semanticscholar.org/graph/v1/paper/search";

const DEFAULT_BATCH_SIZE = 40;
const DEFAULT_FUZZY_THRESHOLD = 0.6;
const DEFAULT_CACHE_TTL_DAYS = 30;
const DEFAULT_HALLUCINATION_WARN_THRESHOLD = 0.2;

function arxivUserAgent(): string {
  const contact = (process.env.ARIS_VERIFY_EMAIL ?? "").trim();
  const base =
    "verify-papers/1.0 (+https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)";
  return contact ? `${base} (mailto:${contact})` : base;
}

const ARXIV_VERSION_RE = /v\d+$/;
const TITLE_NORMALIZE_RE = /[^\w\s]/gu;
const WHITESPACE_RE = /\s+/g;

// --- Data shapes ---

interface PaperInput {
  id: string;
  arxiv_id?: string | null;
  doi?: string | null;
  title?: string | null;
}

interface PaperResult {
  id: string;
  status: string;
  method: string | null;
  confidence: string | null;
  reason: string | null;
  identifiers: Record<string, string>;
}

interface CacheEntry {
  status: string;
  method?: string | null;
  confidence?: string | null;
  reason?: string | null;
  identifiers?: Record<string, string>;
  ts: number;
}

// --- Normalization & cache keys ---

function normalizeArxivId(raw: string): { id: string; version: string | null } {
  raw = raw.trim();
  const m = ARXIV_VERSION_RE.exec(raw);
  if (m) return { id: raw.slice(0, m.index), version: m[0] };
  return { id: raw, version: null };
}

function normalizeDoi(raw: string): string {
  let d = raw.trim().toLowerCase();
  for (const prefix of ["https://doi.org/", "doi.org/"]) {
    if (d.startsWith(prefix)) {
      d = d.slice(prefix.length);
      break;
    }
  }
  return d;
}

function normalizeTitle(raw: string): string {
  let t = raw.normalize("NFKD").toLowerCase();
  t = t.replace(TITLE_NORMALIZE_RE, " ");
  t = t.replace(WHITESPACE_RE, " ").trim();
  return t;
}

function titleHash(normalized: string): string {
  return crypto.createHash("sha1").update(normalized, "utf-8").digest("hex").slice(0, 16);
}

function cacheKeyFor(paper: PaperInput): string | null {
  if (paper.arxiv_id) {
    const { id } = normalizeArxivId(paper.arxiv_id);
    return `arxiv:${id}`;
  }
  if (paper.doi) return `doi:${normalizeDoi(paper.doi)}`;
  if (paper.title) return `title:${titleHash(normalizeTitle(paper.title))}`;
  return null;
}

// --- Cache I/O ---

function resolveCachePath(scope: string, cacheDir: string | null): string | null {
  if (cacheDir) return path.join(cacheDir, "verify_papers.json");
  if (scope === "user") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    return path.join(home, ".aris-cache", "verify_papers.json");
  }
  if (scope === "project") return ".aris/cache/verify_papers.json";
  return null;
}

function loadCache(cachePath: string, ttlDays: number): Record<string, CacheEntry> {
  try {
    if (!fs.existsSync(cachePath)) return {};
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, CacheEntry>;
    const cutoff = Date.now() / 1000 - ttlDays * 86400;
    const result: Record<string, CacheEntry> = {};
    for (const [k, v] of Object.entries(raw)) {
      if ((v.ts ?? 0) >= cutoff) result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function saveCache(cachePath: string, cache: Record<string, CacheEntry>): void {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// --- HTTP + retry ---

async function httpGet(
  url: string,
  headers?: Record<string, string>,
  timeout = 30000,
): Promise<{ status: number; body: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: headers ?? {},
      signal: controller.signal,
    });
    const body = await resp.text();
    return { status: resp.status, body };
  } catch {
    return { status: -1, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function isTransient(status: number): boolean {
  return status === -1 || status === 429 || (status >= 500 && status < 600);
}

function backoff(attempt: number): number {
  return Math.min(2 ** attempt + Math.random(), 30);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

// --- Layer 1: arXiv batch verification ---

async function verifyArxivBatch(
  ids: string[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const result: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResult = await verifyArxivBatchWithRetry(batch);
    Object.assign(result, batchResult);
  }
  return result;
}

async function verifyArxivBatchWithRetry(batch: string[]): Promise<Record<string, string>> {
  const baseIds = batch.map((x) => normalizeArxivId(x).id);
  const url = `${ARXIV_API}?id_list=${baseIds.join(",")}&max_results=${baseIds.length}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, body } = await httpGet(url, { "User-Agent": arxivUserAgent() }, 30000);
    if (status === 200 && body !== null) {
      const found = new Set<string>();
      for (const bid of baseIds) {
        if (body.includes(`<id>http://arxiv.org/abs/${bid}`)) {
          found.add(bid);
        }
      }
      const result: Record<string, string> = {};
      for (const orig of batch) {
        result[orig] = found.has(normalizeArxivId(orig).id) ? "verified" : "unverified";
      }
      return result;
    }
    if (!isTransient(status)) {
      const result: Record<string, string> = {};
      for (const orig of batch) result[orig] = "unverified";
      return result;
    }
    await sleep(backoff(attempt));
  }
  if (batch.length > 1) {
    const mid = Math.floor(batch.length / 2);
    const left = await verifyArxivBatchWithRetry(batch.slice(0, mid));
    const right = await verifyArxivBatchWithRetry(batch.slice(mid));
    return { ...left, ...right };
  }
  return { [batch[0]]: "verify_pending" };
}

// --- Layer 2: CrossRef DOI verification ---

async function verifyDoi(doi: string, userEmail: string): Promise<string> {
  const encoded = encodeURIComponent(normalizeDoi(doi)).replace(/%2F/gi, "/");
  const url = `${CROSSREF_API}/${encoded}`;
  const headers = { "User-Agent": `ARIS-verify-papers/1.0 (mailto:${userEmail})` };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status } = await httpGet(url, headers, 15000);
    if (status === 200) return "verified";
    if (status === 404) return "unverified";
    if (!isTransient(status)) return "unverified";
    await sleep(backoff(attempt));
  }
  return "verify_pending";
}

// --- Layer 3: Semantic Scholar fuzzy title match ---

async function verifyTitleS2(
  title: string,
  fuzzyThreshold: number,
): Promise<{ status: string; identifiers: Record<string, string> | null }> {
  const normalized = normalizeTitle(title);
  if (!normalized) return { status: "unverified", identifiers: null };
  const q = encodeURIComponent(normalized.slice(0, 200));
  const url = `${S2_API}?query=${q}&limit=3&fields=title,year,externalIds`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, body } = await httpGet(url, undefined, 15000);
    if (status === 200 && body !== null) {
      let data: { data?: Array<{ title?: string; externalIds?: Record<string, string> }> };
      try {
        data = JSON.parse(body);
      } catch {
        return { status: "verify_pending", identifiers: null };
      }
      const userWords = new Set(normalized.split(" ").filter(Boolean));
      if (userWords.size === 0) return { status: "unverified", identifiers: null };
      for (const p of data.data ?? []) {
        const pNorm = normalizeTitle(p.title ?? "");
        const pWords = new Set(pNorm.split(" ").filter(Boolean));
        if (pWords.size === 0) continue;
        let overlapCount = 0;
        for (const w of userWords) {
          if (pWords.has(w)) overlapCount++;
        }
        const overlap = overlapCount / Math.max(userWords.size, pWords.size);
        if (overlap >= fuzzyThreshold) {
          const ext = p.externalIds ?? {};
          return {
            status: "verified",
            identifiers: {
              s2_title: p.title ?? "",
              arxiv_id: ext.ArXiv ?? "",
              doi: ext.DOI ?? "",
            },
          };
        }
      }
      return { status: "unverified", identifiers: null };
    }
    if (status === 429) return { status: "verify_pending", identifiers: null };
    if (!isTransient(status)) return { status: "unverified", identifiers: null };
    await sleep(backoff(attempt));
  }
  return { status: "verify_pending", identifiers: null };
}

// --- Orchestration ---

async function verifyPapers(
  papers: PaperInput[],
  opts: {
    arxivBatchSize: number;
    fuzzyThreshold: number;
    userEmail: string;
    cache: Record<string, CacheEntry> | null;
  },
): Promise<PaperResult[]> {
  const now = Date.now() / 1000;
  const results: Record<string, PaperResult> = {};
  const toVerifyArxiv: Record<string, string[]> = {};
  const toVerifyDoi: PaperInput[] = [];
  const toVerifyTitle: PaperInput[] = [];

  for (const p of papers) {
    const key = cacheKeyFor(p);
    if (opts.cache !== null && key && key in opts.cache) {
      const cached = opts.cache[key];
      results[p.id] = {
        id: p.id,
        status: cached.status,
        method: cached.method ?? null,
        confidence: cached.confidence ?? null,
        reason: cached.reason ?? null,
        identifiers: cached.identifiers ?? {},
      };
      continue;
    }
    if (p.arxiv_id) {
      const { id: baseId } = normalizeArxivId(p.arxiv_id);
      if (!toVerifyArxiv[baseId]) toVerifyArxiv[baseId] = [];
      toVerifyArxiv[baseId].push(p.id);
    } else if (p.doi) {
      toVerifyDoi.push(p);
    } else if (p.title) {
      toVerifyTitle.push(p);
    } else {
      results[p.id] = {
        id: p.id,
        status: "error",
        method: null,
        confidence: null,
        reason: "no_identifier_no_title",
        identifiers: {},
      };
    }
  }

  // Layer 1: arXiv batch
  if (Object.keys(toVerifyArxiv).length > 0) {
    const arxivResults = await verifyArxivBatch(Object.keys(toVerifyArxiv), opts.arxivBatchSize);
    for (const [baseId, paperIds] of Object.entries(toVerifyArxiv)) {
      const status = arxivResults[baseId] ?? "verify_pending";
      for (const pid of paperIds) {
        results[pid] = {
          id: pid,
          status,
          method: status === "verified" ? "arxiv" : null,
          confidence: status === "verified" ? "high" : null,
          reason: status === "verified" ? null : `arxiv_${status}`,
          identifiers: { arxiv_id: baseId },
        };
        if (opts.cache !== null) {
          opts.cache[`arxiv:${baseId}`] = {
            status,
            method: status === "verified" ? "arxiv" : null,
            confidence: status === "verified" ? "high" : null,
            reason: status === "verified" ? null : `arxiv_${status}`,
            identifiers: { arxiv_id: baseId },
            ts: now,
          };
        }
      }
    }
  }

  // Layer 2: CrossRef
  for (const p of toVerifyDoi) {
    const status = await verifyDoi(p.doi ?? "", opts.userEmail);
    let result: PaperResult = {
      id: p.id,
      status,
      method: status === "verified" ? "crossref" : null,
      confidence: status === "verified" ? "high" : null,
      reason: status === "verified" ? null : `crossref_${status}`,
      identifiers: { doi: normalizeDoi(p.doi ?? "") },
    };
    if (status === "unverified" && p.title) {
      const s2 = await verifyTitleS2(p.title, opts.fuzzyThreshold);
      if (s2.status === "verified") {
        result = {
          id: p.id,
          status: "verified",
          method: "s2_fallback_from_doi",
          confidence: "medium",
          reason: null,
          identifiers: { doi: normalizeDoi(p.doi ?? ""), ...(s2.identifiers ?? {}) },
        };
      } else if (s2.status === "verify_pending") {
        result.status = "verify_pending";
        result.reason = "crossref_unverified_s2_pending";
      }
    }
    results[p.id] = result;
    if (opts.cache !== null) {
      opts.cache[`doi:${normalizeDoi(p.doi ?? "")}`] = {
        status: result.status,
        method: result.method,
        confidence: result.confidence,
        reason: result.reason,
        identifiers: result.identifiers,
        ts: now,
      };
    }
  }

  // Layer 3: S2 title only
  for (const p of toVerifyTitle) {
    const s2 = await verifyTitleS2(p.title ?? "", opts.fuzzyThreshold);
    const result: PaperResult = {
      id: p.id,
      status: s2.status,
      method: s2.status === "verified" ? "s2" : null,
      confidence: s2.status === "verified" ? "medium" : null,
      reason: s2.status === "verified" ? null : `s2_${s2.status}`,
      identifiers: s2.identifiers ?? {},
    };
    results[p.id] = result;
    if (opts.cache !== null) {
      opts.cache[`title:${titleHash(normalizeTitle(p.title ?? ""))}`] = {
        status: result.status,
        method: result.method,
        confidence: result.confidence,
        reason: result.reason,
        identifiers: result.identifiers,
        ts: now,
      };
    }
  }

  return papers.map((p) => results[p.id]);
}

// --- CLI ---

function parseInput(opts: {
  input?: string;
  arxivIds?: string;
  titlesFile?: string;
}): PaperInput[] {
  if (opts.input) {
    const raw =
      opts.input === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(opts.input, "utf-8");
    return JSON.parse(raw) as PaperInput[];
  }
  if (opts.arxivIds) {
    return opts.arxivIds
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x, i) => ({ id: `arxiv-${i}`, arxiv_id: x }));
  }
  if (opts.titlesFile) {
    let lines: string[];
    if (opts.titlesFile === "-") {
      lines = fs.readFileSync(0, "utf-8").split("\n");
    } else {
      lines = fs.readFileSync(opts.titlesFile, "utf-8").split("\n");
    }
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((t, i) => ({ id: `title-${i}`, title: t }));
  }
  console.error("error: provide --input, --arxiv-ids, or --titles-file");
  return process.exit(1) as never;
}

function computeVerdict(
  results: PaperResult[],
  threshold: number,
): { verdict: string; metrics: Record<string, unknown> } {
  const terminal = results.filter((r) => r.status === "verified" || r.status === "unverified");
  const pending = results.filter((r) => r.status === "verify_pending");
  const errors = results.filter((r) => r.status === "error");
  const unverified = results.filter((r) => r.status === "unverified");

  const hRate = terminal.length > 0 ? unverified.length / terminal.length : 0;
  const pRate = results.length > 0 ? pending.length / results.length : 0;

  const warnings: string[] = [];
  if (hRate > threshold) warnings.push("high_hallucination_rate");
  if (pending.length > 0) warnings.push("transient_failures_present");
  if (errors.length > 0) warnings.push("malformed_inputs_present");

  let verdict: string;
  if (results.length === 0) {
    verdict = "BLOCKED";
  } else if (errors.length > 0 && terminal.length === 0 && pending.length === 0) {
    verdict = "ERROR";
  } else if (warnings.length > 0) {
    verdict = "WARN";
  } else {
    verdict = "PASS";
  }

  return {
    verdict,
    metrics: {
      hallucination_rate: Math.round(hRate * 10000) / 10000,
      pending_rate: Math.round(pRate * 10000) / 10000,
      warnings,
    },
  };
}

const program = createCli("verify-papers", "Pre-search paper-existence verification helper.");
program.option("--input <path>", "Path to papers.json, or - for stdin");
program.option("--output <path>", "Path to verified.json, or - for stdout (default)");
program.option("--arxiv-ids <ids>", "Convenience: comma-separated arXiv IDs");
program.option("--titles-file <path>", "Convenience: file with one title per line, or -");
program.option("--arxiv-batch-size <n>", "arXiv batch size", String(DEFAULT_BATCH_SIZE));
program.option(
  "--s2-fuzzy-threshold <n>",
  "Semantic Scholar fuzzy threshold",
  String(DEFAULT_FUZZY_THRESHOLD),
);
program.option("--cache-scope <scope>", "Cache scope: project, user, none", "project");
program.option("--cache-dir <path>", "Explicit cache directory (overrides --cache-scope)");
program.option("--cache-ttl-days <n>", "Cache TTL in days", String(DEFAULT_CACHE_TTL_DAYS));
program.option("--no-cache", "Disable caching");
program.option(
  "--hallucination-warn-threshold <n>",
  "Hallucination rate warning threshold",
  String(DEFAULT_HALLUCINATION_WARN_THRESHOLD),
);
program.action(
  async (opts: {
    input?: string;
    output?: string;
    arxivIds?: string;
    titlesFile?: string;
    arxivBatchSize: string;
    s2FuzzyThreshold: string;
    cacheScope: string;
    cacheDir?: string;
    cache: boolean;
    cacheTtlDays: string;
    hallucinationWarnThreshold: string;
  }) => {
    let papers: PaperInput[];
    try {
      papers = parseInput(opts);
    } catch (e) {
      const out = {
        verdict: "BLOCKED",
        hallucination_rate: 0,
        pending_rate: 0,
        warnings: ["input_unreadable"],
        papers: [],
        error: String(e),
      };
      console.log(JSON.stringify(out, null, 2));
      return process.exit(2) as never;
    }

    const userEmail = (process.env.ARIS_VERIFY_EMAIL ?? "aris-research@anonymous.local").trim();
    const noCache = opts.cache === false;
    const cacheScope = opts.cacheScope;
    const cacheTtlDays = parseInt(opts.cacheTtlDays, 10);

    let cache: Record<string, CacheEntry> | null = null;
    let cachePath: string | null = null;
    if (!noCache && cacheScope !== "none") {
      cachePath = resolveCachePath(cacheScope, opts.cacheDir ?? null);
      if (cachePath) cache = loadCache(cachePath, cacheTtlDays);
    }

    const results = await verifyPapers(papers, {
      arxivBatchSize: parseInt(opts.arxivBatchSize, 10),
      fuzzyThreshold: parseFloat(opts.s2FuzzyThreshold),
      userEmail,
      cache,
    });

    if (cache !== null && cachePath) saveCache(cachePath, cache);

    const { verdict, metrics } = computeVerdict(
      results,
      parseFloat(opts.hallucinationWarnThreshold),
    );

    const output = {
      verdict,
      ...metrics,
      papers: results,
    };

    const payload = JSON.stringify(output, null, 2);
    if (opts.output && opts.output !== "-") {
      fs.writeFileSync(opts.output, payload);
    } else {
      console.log(payload);
    }
  },
);

runCli(program);
