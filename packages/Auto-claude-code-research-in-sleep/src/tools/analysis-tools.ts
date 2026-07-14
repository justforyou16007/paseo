#!/usr/bin/env node

/**
 * analysis-tools.ts — Analysis-tool registry (shared ARIS helper, Policy B).
 *
 * Subcommands: register, query, get, load, resource, test, categories,
 * add-category, deprecate, stats.
 */

import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createCli, runCli } from "../lib/cli.js";

const DEFAULT_CATEGORIES = [
  {
    key: "ablation",
    name: "Ablation analysis",
    description: "Per-component contribution by removing / replacing modules.",
  },
  {
    key: "statistical-test",
    name: "Statistical testing",
    description: "Hypothesis tests, confidence intervals, multiple-comparison correction.",
  },
  {
    key: "significance",
    name: "Significance analysis",
    description: "Is the gain real? effect size, bootstrap CIs, paired tests vs baselines.",
  },
  {
    key: "error-analysis",
    name: "Error analysis",
    description: "Per-sample / per-slice failure taxonomy and confusion structure.",
  },
  {
    key: "visualization",
    name: "Visualization",
    description: "Render results as plots / tables / figures for inspection.",
  },
  {
    key: "scaling-law",
    name: "Scaling-law analysis",
    description: "Fit power-law / exponent trends across compute / data / params.",
  },
  {
    key: "efficiency",
    name: "Efficiency / cost analysis",
    description: "Throughput, latency, memory, FLOPs, $ per result.",
  },
  {
    key: "robustness",
    name: "Robustness analysis",
    description: "Stability under distribution shift, noise, adversarial perturbation.",
  },
  {
    key: "data-coverage",
    name: "Data coverage analysis",
    description: "Slice coverage, demographic / group breakdown, missing-data audit.",
  },
  {
    key: "baseline-comparison",
    name: "Baseline comparison",
    description: "Head-to-head vs prior work tables with matched settings.",
  },
  {
    key: "reproducibility",
    name: "Reproducibility analysis",
    description: "Variance across seeds / runs, determinism, rerun agreement.",
  },
];

const ACTIVE = "active";
const DEPRECATED = "deprecated";
const UNIT_TEST_NAME = "tool-unit-test.py";

interface CategoryEntry {
  key: string;
  name: string;
  description: string;
}

interface LedgerRecord {
  action?: string;
  slug?: string;
  name?: string;
  description?: string;
  purpose?: string;
  category?: string;
  inputs?: string[];
  outputs?: string[];
  tags?: string[];
  author?: string;
  source_skill?: string;
  procedure_source?: string;
  procedure_text?: string;
  scripts?: string[];
  references?: string[];
  test_required?: boolean;
  status?: string;
  content_hash?: string;
  supersedes?: string;
  spec_path?: string;
  ts?: string;
  reason?: string;
  pass?: boolean;
  exit?: number;
  error?: string;
}

function _now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function _emit(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function _registryRoot(): string {
  const override = process.env.ARIS_ANALYSIS_TOOLS_DIR;
  if (override) return path.resolve(override);
  const home = process.env.HOME ?? os.homedir();
  if (home) return path.join(home, ".aris", "analysis_tools");
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(thisDir, "..", "..", "..");
  return path.join(repoRoot, ".aris", "analysis_tools");
}

function _ledgerPath(): string {
  return path.join(_registryRoot(), "registry.jsonl");
}

function _categoriesPath(): string {
  return path.join(_registryRoot(), "categories.json");
}

function _skillDir(slug: string): string {
  return path.join(_registryRoot(), "skills", slug);
}

function _skillMd(slug: string): string {
  return path.join(_skillDir(slug), "SKILL.md");
}

function _scriptsDir(slug: string): string {
  return path.join(_skillDir(slug), "scripts");
}

function _referencesDir(slug: string): string {
  return path.join(_skillDir(slug), "references");
}

function _unitTestPath(slug: string): string {
  return path.join(_scriptsDir(slug), UNIT_TEST_NAME);
}

function _validateSlug(slug: string): string {
  const safe = slug.replace(/[^A-Za-z0-9\-_.]/g, "");
  if (!safe || safe !== slug || slug === "." || slug === "..") {
    throw new Error(`invalid slug ${JSON.stringify(slug)} (use [A-Za-z0-9-_.]; no spaces/slashes)`);
  }
  return slug;
}

function _csv(val: string | undefined): string[] {
  if (!val) return [];
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── BM25 soft ranking ─────────────────────────────────────────────

const TOKEN_RE = /[a-z0-9]+/g;

function _tokenize(text: string): string[] {
  return Array.from((text ?? "").toLowerCase().matchAll(TOKEN_RE), (m) => m[0]);
}

function _toolL0Text(rec: LedgerRecord): string {
  const parts = [
    rec.purpose ?? "",
    rec.name ?? "",
    rec.description ?? "",
    (rec.tags ?? []).join(" "),
    (rec.inputs ?? []).join(" "),
  ];
  return parts.filter(Boolean).join(" ");
}

function _bm25Scores(
  docs: [string, string[]][],
  queryTokens: string[],
  k1 = 1.5,
  b = 0.75,
): Map<string, number> {
  const nDocs = docs.length;
  if (nDocs === 0 || queryTokens.length === 0) return new Map();
  const avgdl = docs.reduce((sum, [, toks]) => sum + toks.length, 0) / nDocs;

  const df = new Map<string, number>();
  for (const term of new Set(queryTokens)) {
    df.set(term, docs.filter(([, toks]) => toks.includes(term)).length);
  }

  const scores = new Map<string, number>();
  for (const [slug, toks] of docs) {
    if (toks.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of toks) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const dl = toks.length;
    const norm = avgdl > 0 ? 1 - b + b * (dl / avgdl) : 1.0;
    let s = 0;
    for (const term of queryTokens) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      const idf = Math.log((nDocs - n + 0.5) / (n + 0.5) + 1);
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      s += (idf * (f * (k1 + 1))) / (f + k1 * norm);
    }
    if (s > 0) scores.set(slug, s);
  }

  return scores;
}

// ── File locking (best-effort advisory) ──────────────────────────

function _withWriteLock<T>(fn: () => T): T {
  const root = _registryRoot();
  fs.mkdirSync(root, { recursive: true });
  // Node.js doesn't have a portable flock; rely on single-writer contract
  return fn();
}

// ── Atomic writes ────────────────────────────────────────────────

function _atomicWriteJson(filePath: string, obj: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.cat.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

function _atomicWriteText(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.sk.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

// ── Categories ───────────────────────────────────────────────────

function _ensureCategories(): CategoryEntry[] {
  const p = _categoriesPath();
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      return data.categories ?? [];
    } catch {
      // fall through to reseed
    }
  }
  const obj = { categories: [...DEFAULT_CATEGORIES] };
  _withWriteLock(() => _atomicWriteJson(p, obj));
  return obj.categories;
}

function _categoryKeys(): Set<string> {
  return new Set(_ensureCategories().map((c) => c.key));
}

// ── Ledger ───────────────────────────────────────────────────────

function _readLedger(): LedgerRecord[] {
  const p = _ledgerPath();
  if (!fs.existsSync(p)) return [];
  const out: LedgerRecord[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return out;
}

function _currentState(): Map<string, LedgerRecord> {
  const state = new Map<string, LedgerRecord>();
  for (const rec of _readLedger()) {
    const slug = rec.slug;
    if (!slug) continue;
    const prev = state.get(slug) ?? {};
    const merged: LedgerRecord = { ...prev };
    for (const [k, v] of Object.entries(rec)) {
      if (v != null) (merged as Record<string, unknown>)[k] = v;
    }
    state.set(slug, merged);
  }
  return state;
}

function _procedureText(procedure: string | undefined): [string, string] {
  if (procedure == null) return ["", "none"];
  if (fs.existsSync(procedure) && fs.statSync(procedure).isFile()) {
    return [fs.readFileSync(procedure, "utf-8"), `file:${procedure}`];
  }
  return [procedure, "inline"];
}

function _contentHash(procedureText: string, scriptNames: string[]): string {
  const h = crypto.createHash("sha256");
  h.update(procedureText, "utf-8");
  for (const n of [...scriptNames].sort()) {
    h.update(n, "utf-8");
  }
  return "sha256:" + h.digest("hex").slice(0, 16);
}

function _renderSkillMd(rec: LedgerRecord): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${rec.slug}`);
  lines.push(
    `description: "${(rec.purpose ?? "").replace(/"/g, "")} (analysis tool, category: ${rec.category ?? ""})"`,
  );
  lines.push(`category: ${rec.category ?? ""}`);
  if (rec.inputs?.length) lines.push("inputs: " + JSON.stringify(rec.inputs));
  if (rec.outputs?.length) lines.push("outputs: " + JSON.stringify(rec.outputs));
  if (rec.tags?.length) lines.push("tags: " + JSON.stringify(rec.tags));
  if (rec.author) lines.push(`author: ${rec.author}`);
  if (rec.source_skill) lines.push(`source-skill: ${rec.source_skill}`);
  if (rec.supersedes) lines.push(`supersedes: ${rec.supersedes}`);
  lines.push(`registered: ${rec.ts ?? _now()}`);
  lines.push(`content_hash: ${rec.content_hash ?? ""}`);
  lines.push(`status: ${rec.status ?? ACTIVE}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${rec.name ?? rec.slug}`);
  lines.push("");
  lines.push(`> ${rec.purpose ?? ""}`);
  lines.push("");
  if (rec.description) {
    lines.push(rec.description);
    lines.push("");
  }
  if (rec.inputs?.length) {
    lines.push("## Inputs");
    for (const i of rec.inputs) lines.push(`- ${i}`);
    lines.push("");
  }
  if (rec.outputs?.length) {
    lines.push("## Outputs");
    for (const o of rec.outputs) lines.push(`- ${o}`);
    lines.push("");
  }
  lines.push("## Procedure");
  const proc = rec.procedure_text ?? "";
  lines.push(proc.trim() ? proc : "_(no procedure recorded)_");
  lines.push("");
  if (rec.scripts?.length) {
    lines.push("## Scripts");
    lines.push("Copied into this tool's `scripts/` directory:");
    for (const s of rec.scripts) lines.push(`- \`${s}\``);
    lines.push("");
  }
  if (rec.references?.length) {
    lines.push("## References (test data)");
    lines.push("Copied into this tool's `references/` directory:");
    for (const r of rec.references) lines.push(`- \`${r}\``);
    lines.push("");
  }
  if (rec.test_required === false) {
    lines.push(
      "> ⚠️ Registered with `--skip-test`: no `tool-unit-test.py` / references test data enforced. Effect is unverified.",
    );
    lines.push("");
  }
  if (rec.supersedes) {
    lines.push(`This tool supersedes \`${rec.supersedes}\` (auto-deprecated on register).`);
    lines.push("");
  }
  return lines.join("\n");
}

function _appendLedger(rec: LedgerRecord): void {
  const p = _ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf-8");
}

// ── Helpers ──────────────────────────────────────────────────────

function _rmrf(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function _copyFile(src: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

// ── Subcommands ──────────────────────────────────────────────────

function cmdRegister(opts: {
  slug: string;
  name?: string;
  description?: string;
  purpose: string;
  category: string;
  inputs?: string;
  outputs?: string;
  procedure?: string;
  script?: string[];
  resource?: string[];
  skipTest?: boolean;
  tags?: string;
  author?: string;
  sourceSkill?: string;
  status?: string;
  updateOnExist?: boolean;
  supersedes?: string;
}): number {
  const slug = _validateSlug(opts.slug);
  const valid = _categoryKeys();
  if (!valid.has(opts.category)) {
    _emit({
      error: `unknown category ${JSON.stringify(opts.category)}`,
      valid_categories: [...valid].sort(),
      hint: "add one via `add-category --key ...` first",
    });
    return 2;
  }

  const state = _currentState();
  const exists = state.has(slug);
  if (exists && !opts.updateOnExist && !opts.supersedes) {
    const existing = state.get(slug)!;
    _emit({
      error: `slug ${JSON.stringify(slug)} already exists`,
      existing: {
        name: existing.name,
        category: existing.category,
        purpose: existing.purpose,
        status: existing.status,
      },
      hint: "use --update-on-exist to overwrite, or --supersedes <old-slug> to register a successor that auto-deprecates the old one",
    });
    return 2;
  }

  const [procText, procSource] = _procedureText(opts.procedure);
  const scriptNames: string[] = [];
  const referenceNames: string[] = [];

  return _withWriteLock(() => {
    const sdir = _scriptsDir(slug);
    const rdir = _referencesDir(slug);
    _rmrf(sdir);
    _rmrf(rdir);

    for (const src of opts.script ?? []) {
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        _emit({ error: `script not found: ${src}` });
        return 2;
      }
      _copyFile(src, sdir);
      scriptNames.push(path.basename(src));
    }
    for (const src of opts.resource ?? []) {
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        _emit({ error: `resource not found: ${src}` });
        return 2;
      }
      _copyFile(src, rdir);
      referenceNames.push(path.basename(src));
    }

    let testRequired = true;
    if (!opts.skipTest) {
      const missing: string[] = [];
      if (!scriptNames.includes(UNIT_TEST_NAME)) missing.push(`scripts/${UNIT_TEST_NAME}`);
      if (referenceNames.length === 0) missing.push("references/ (test data)");
      if (missing.length > 0) {
        _emit({
          error: `tool ${JSON.stringify(slug)} missing required test artifacts: ${JSON.stringify(missing)}`,
          hint: "pass --script <tool-unit-test.py> --resource <test-data-file>, or --skip-test to register anyway (recorded as test_required:false)",
        });
        return 2;
      }
    } else {
      testRequired = false;
    }

    const chash = _contentHash(procText, [...scriptNames, ...referenceNames]);
    const rec: LedgerRecord = {
      action: "register",
      slug,
      name: opts.name ?? slug,
      description: opts.description ?? "",
      purpose: opts.purpose,
      category: opts.category,
      inputs: _csv(opts.inputs),
      outputs: _csv(opts.outputs),
      tags: _csv(opts.tags),
      author: opts.author ?? "",
      source_skill: opts.sourceSkill ?? "",
      procedure_source: procSource,
      procedure_text: procText,
      scripts: scriptNames,
      references: referenceNames,
      test_required: testRequired,
      status: opts.status ?? ACTIVE,
      content_hash: chash,
      supersedes: opts.supersedes ?? "",
      spec_path: path.relative(_registryRoot(), _skillMd(slug)),
      ts: _now(),
    };
    _atomicWriteText(_skillMd(slug), _renderSkillMd(rec));
    _appendLedger(rec);

    let deprecatedInfo: Record<string, string> | undefined;
    if (opts.supersedes) {
      const old = opts.supersedes;
      if (_currentState().has(old)) {
        const dep: LedgerRecord = {
          action: "deprecate",
          slug: old,
          status: DEPRECATED,
          reason: `superseded by ${slug}`,
          ts: _now(),
        };
        _appendLedger(dep);
        deprecatedInfo = { superseded: old };
      } else {
        deprecatedInfo = {
          superseded_warning: `${old} not found; recorded as supersedes link only`,
        };
      }
    }

    _emit({
      action: "register",
      slug,
      status: rec.status,
      content_hash: chash,
      spec_path: _skillMd(slug),
      scripts: scriptNames,
      references: referenceNames,
      test_required: testRequired,
      updated_existing: exists,
      ...(deprecatedInfo ?? {}),
    });
    return 0;
  });
}

function cmdQuery(opts: {
  query?: string;
  category?: string;
  tag?: string;
  inputs?: string;
  status?: string;
  top?: number;
}): number {
  const state = _currentState();
  const candidates: [string, LedgerRecord][] = [];

  for (const [slug, rec] of [...state.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (opts.status && (rec.status ?? ACTIVE) !== opts.status) continue;
    if (opts.category && rec.category !== opts.category) continue;
    if (opts.tag && !(rec.tags ?? []).includes(opts.tag)) continue;
    if (opts.inputs) {
      const inputList = _csv(opts.inputs);
      if (!inputList.some((i) => (rec.inputs ?? []).includes(i))) continue;
    }
    candidates.push([slug, rec]);
  }

  const l0 = (slug: string, rec: LedgerRecord, score?: number): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      slug,
      name: rec.name ?? slug,
      description: rec.description ?? "",
      category: rec.category ?? "",
      purpose: rec.purpose ?? "",
      tags: rec.tags ?? [],
    };
    if (score != null) row.score = Math.round(score * 10000) / 10000;
    return row;
  };

  const top = opts.top ?? 5;

  if (opts.query) {
    const qTokens = _tokenize(opts.query);
    const docs: [string, string[]][] = candidates.map(([slug, rec]) => [
      slug,
      _tokenize(_toolL0Text(rec)),
    ]);
    const scores = _bm25Scores(docs, qTokens);
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top);
    const candMap = new Map(candidates);
    const matches = ranked.map(([slug, score]) => l0(slug, candMap.get(slug)!, score));
    _emit({ count: matches.length, top_k: top, query: opts.query, matches });
    return 0;
  }

  const matches = candidates.map(([slug, rec]) => l0(slug, rec));
  _emit({ count: matches.length, top_k: null, query: null, matches });
  return 0;
}

function cmdGet(opts: { slug: string; json?: boolean }): number {
  const slug = _validateSlug(opts.slug);
  const state = _currentState();
  if (!state.has(slug)) {
    _emit({ error: `no tool with slug ${JSON.stringify(slug)}` });
    return 1;
  }
  if (opts.json) {
    const rec = state.get(slug)!;
    const keys = [
      "slug",
      "name",
      "description",
      "purpose",
      "category",
      "inputs",
      "outputs",
      "tags",
      "author",
      "source_skill",
      "supersedes",
      "scripts",
      "status",
      "content_hash",
      "spec_path",
      "ts",
    ] as const;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = (rec as Record<string, unknown>)[k];
    _emit(out);
    return 0;
  }
  const p = _skillMd(slug);
  if (!fs.existsSync(p)) {
    _emit({
      error: `spec file missing for ${JSON.stringify(slug)} (ledger entry exists)`,
      spec_path: p,
    });
    return 1;
  }
  const text = fs.readFileSync(p, "utf-8");
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

function cmdLoad(opts: { slug: string; json?: boolean }): number {
  const slug = _validateSlug(opts.slug);
  const state = _currentState();
  if (!state.has(slug)) {
    _emit({ error: `no tool with slug ${JSON.stringify(slug)}` });
    return 1;
  }
  if (opts.json) {
    const rec = state.get(slug)!;
    const keys = [
      "slug",
      "name",
      "description",
      "purpose",
      "category",
      "inputs",
      "outputs",
      "tags",
      "author",
      "source_skill",
      "supersedes",
      "scripts",
      "references",
      "test_required",
      "status",
      "content_hash",
      "spec_path",
      "ts",
    ] as const;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = (rec as Record<string, unknown>)[k];
    _emit(out);
    return 0;
  }
  const p = _skillMd(slug);
  if (!fs.existsSync(p)) {
    _emit({
      error: `spec file missing for ${JSON.stringify(slug)} (ledger entry exists)`,
      spec_path: p,
    });
    return 1;
  }
  const text = fs.readFileSync(p, "utf-8");
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

interface ResourceEntry {
  kind: string;
  name: string;
  path: string;
}

function _listResources(slug: string): ResourceEntry[] {
  const out: ResourceEntry[] = [];
  for (const [kind, dir] of [
    ["script", _scriptsDir(slug)],
    ["reference", _referencesDir(slug)],
  ] as const) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isFile()) {
        out.push({ kind, name: f, path: path.relative(_skillDir(slug), full) });
      }
    }
  }
  return out;
}

function cmdResource(opts: { slug: string; list?: boolean; name?: string }): number {
  const slug = _validateSlug(opts.slug);
  if (!_currentState().has(slug)) {
    _emit({ error: `no tool with slug ${JSON.stringify(slug)}` });
    return 1;
  }
  const resources = _listResources(slug);
  if (opts.list) {
    _emit({ slug, count: resources.length, resources });
    return 0;
  }
  if (!opts.name) {
    _emit({
      error: "resource requires --name <file> or --list",
      available: resources.map((r) => r.name),
    });
    return 2;
  }
  const target = resources.find((r) => r.name === opts.name || r.path === opts.name);
  if (!target) {
    _emit({
      error: `resource ${JSON.stringify(opts.name)} not found for ${JSON.stringify(slug)}`,
      available: resources.map((r) => r.name),
    });
    return 1;
  }
  const p = path.join(_skillDir(slug), target.path);
  const text = fs.readFileSync(p, "utf-8");
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

function cmdTest(opts: { slug: string; verbose?: boolean }): number {
  const slug = _validateSlug(opts.slug);
  const state = _currentState();
  if (!state.has(slug)) {
    _emit({ error: `no tool with slug ${JSON.stringify(slug)}` });
    return 1;
  }
  const ut = _unitTestPath(slug);
  if (!fs.existsSync(ut)) {
    _emit({
      error: `no ${UNIT_TEST_NAME} for ${JSON.stringify(slug)} (tool was registered with --skip-test)`,
      path: ut,
    });
    return 2;
  }
  try {
    const result = (() => {
      try {
        const stdout = execFileSync(
          process.execPath.replace(/node$/, "python3").includes("python") ? "python3" : "python3",
          [`scripts/${UNIT_TEST_NAME}`],
          {
            cwd: _skillDir(slug),
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        return { exitCode: 0, stdout: stdout ?? "", stderr: "" };
      } catch (err: unknown) {
        if (err && typeof err === "object" && "status" in err) {
          const e = err as { status: number; stdout: string; stderr: string };
          return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
        throw err;
      }
    })();

    const passed = result.exitCode === 0;
    const rec: LedgerRecord = {
      action: "test",
      slug,
      pass: passed,
      exit: result.exitCode,
      ts: _now(),
    };
    _withWriteLock(() => _appendLedger(rec));
    _emit({
      ...rec,
      stdout: opts.verbose ? result.stdout.slice(-2000) : "",
      stderr: opts.verbose ? result.stderr.slice(-2000) : "",
    });
    return result.exitCode;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const rec: LedgerRecord = {
      action: "test",
      slug,
      pass: false,
      exit: -1,
      error: errMsg,
      ts: _now(),
    };
    _withWriteLock(() => _appendLedger(rec));
    _emit({ ...rec, stdout: "", stderr: errMsg });
    return 2;
  }
}

function cmdCategories(opts: { json?: boolean }): number {
  const cats = _ensureCategories();
  if (opts.json) {
    _emit({ count: cats.length, categories: cats });
    return 0;
  }
  console.log(`${"key".padEnd(22)} name`);
  console.log("-".repeat(60));
  for (const c of cats) {
    console.log(`${c.key.padEnd(22)} ${c.name ?? ""}`);
    if (c.description) console.log(`${"".padEnd(22)} ${c.description}`);
  }
  console.log(`\n${cats.length} categories. Filter query with --category <key>.`);
  return 0;
}

function cmdAddCategory(opts: { key: string; name?: string; description?: string }): number {
  const key = _validateSlug(opts.key);
  const cats = _ensureCategories();
  if (cats.some((c) => c.key === key)) {
    _emit({ error: `category ${JSON.stringify(key)} already exists` });
    return 2;
  }
  cats.push({ key, name: opts.name ?? key, description: opts.description ?? "" });
  _withWriteLock(() => _atomicWriteJson(_categoriesPath(), { categories: cats }));
  _emit({ action: "add-category", key, name: opts.name ?? key });
  return 0;
}

function cmdDeprecate(opts: { slug: string; reason?: string }): number {
  const slug = _validateSlug(opts.slug);
  const state = _currentState();
  if (!state.has(slug)) {
    _emit({ error: `no tool with slug ${JSON.stringify(slug)}` });
    return 1;
  }
  _withWriteLock(() => {
    _appendLedger({
      action: "deprecate",
      slug,
      status: DEPRECATED,
      reason: opts.reason ?? "",
      ts: _now(),
    });
  });
  _emit({ action: "deprecate", slug, status: DEPRECATED, reason: opts.reason ?? "" });
  return 0;
}

function cmdStats(): number {
  const state = _currentState();
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let untested = 0;
  for (const rec of state.values()) {
    const s = rec.status ?? ACTIVE;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    const c = rec.category ?? "(none)";
    byCategory[c] = (byCategory[c] ?? 0) + 1;
    if (rec.test_required === false) untested++;
  }
  const sortedByCategory: Record<string, number> = {};
  for (const k of Object.keys(byCategory).sort()) {
    sortedByCategory[k] = byCategory[k];
  }
  _emit({
    total: state.size,
    by_status: byStatus,
    by_category: sortedByCategory,
    untested,
    categories_defined: _ensureCategories().length,
  });
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────

const program = createCli(
  "analysis-tools",
  "Analysis-tool registry (record an analysis process as a reusable skill; query/get available analysis tools).",
);

program
  .command("register")
  .description("record an analysis process as a reusable skill")
  .requiredOption("--slug <slug>")
  .option("--name <name>", "human-readable name (default: slug)")
  .option("--description <text>", "longer description")
  .requiredOption("--purpose <text>", "one-line: what this tool analyzes")
  .requiredOption("--category <key>", "type-table key (see `categories`)")
  .option("--inputs <csv>", "comma-separated input artifacts")
  .option("--outputs <csv>", "comma-separated output artifacts")
  .option("--procedure <text>", "path to a file OR inline text of the analysis steps")
  .option(
    "--script <path>",
    "path to a script to copy in (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--resource <path>",
    "path to a reference / test-data file (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--skip-test", "register without enforcing tool-unit-test.py + references test data")
  .option("--tags <csv>", "comma-separated tags")
  .option("--author <name>", "who/what registered it")
  .option("--source-skill <name>", "originating skill name, if distilled from one")
  .option("--status <status>", "active or deprecated", ACTIVE)
  .option("--update-on-exist", "overwrite an existing tool with this slug")
  .option("--supersedes <slug>", "slug of an older tool this replaces (auto-deprecates it)")
  .action((opts: Record<string, string | string[] | boolean | undefined>) => {
    process.exitCode = cmdRegister(opts as Parameters<typeof cmdRegister>[0]);
  });

program
  .command("query")
  .description("find analysis tools: BM25-rank top-K by --query, or browse all (L0 metadata)")
  .option("--query <text>", "free-text query; BM25-ranks candidates")
  .option("--category <key>")
  .option("--tag <tag>")
  .option("--inputs <csv>", "comma-separated; match tools consuming any of these")
  .option("--status <status>", "filter by status (default: active)", ACTIVE)
  .option("--top <n>", "max candidates to return when --query is given", "5")
  .action((opts: Record<string, string | undefined>) => {
    process.exitCode = cmdQuery({ ...opts, top: parseInt(opts.top ?? "5", 10) });
  });

program
  .command("get")
  .description("print the full spec of one tool (fetch-on-demand)")
  .requiredOption("--slug <slug>")
  .option("--json", "output as JSON")
  .action((opts: Record<string, string | boolean | undefined>) => {
    process.exitCode = cmdGet(opts as Parameters<typeof cmdGet>[0]);
  });

program
  .command("load")
  .description("Level 1: load the full SKILL.md of one tool (on-demand core content)")
  .requiredOption("--slug <slug>")
  .option("--json", "output as JSON")
  .action((opts: Record<string, string | boolean | undefined>) => {
    process.exitCode = cmdLoad(opts as Parameters<typeof cmdLoad>[0]);
  });

program
  .command("resource")
  .description("Level 2: enumerate or print one script/reference file of a tool")
  .requiredOption("--slug <slug>")
  .option("--list", "enumerate scripts/ and references/")
  .option("--name <file>", "print the contents of one file (by name)")
  .action((opts: Record<string, string | boolean | undefined>) => {
    process.exitCode = cmdResource(opts as Parameters<typeof cmdResource>[0]);
  });

program
  .command("test")
  .description("run a tool's tool-unit-test.py and record the result")
  .requiredOption("--slug <slug>")
  .option("--verbose", "include captured stdout/stderr")
  .action((opts: Record<string, string | boolean | undefined>) => {
    process.exitCode = cmdTest(opts as Parameters<typeof cmdTest>[0]);
  });

program
  .command("categories")
  .description("list the tool type table")
  .option("--json", "output as JSON")
  .action((opts: Record<string, string | boolean | undefined>) => {
    process.exitCode = cmdCategories(opts as Parameters<typeof cmdCategories>[0]);
  });

program
  .command("add-category")
  .description("extend the type table with a new category")
  .requiredOption("--key <key>")
  .option("--name <name>")
  .option("--description <text>")
  .action((opts: Record<string, string | undefined>) => {
    process.exitCode = cmdAddCategory(opts as Parameters<typeof cmdAddCategory>[0]);
  });

program
  .command("deprecate")
  .description("mark a tool deprecated (append-only; never hard-deleted)")
  .requiredOption("--slug <slug>")
  .option("--reason <text>")
  .action((opts: Record<string, string | undefined>) => {
    process.exitCode = cmdDeprecate(opts as Parameters<typeof cmdDeprecate>[0]);
  });

program
  .command("stats")
  .description("registry counts by status / category")
  .action(() => {
    process.exitCode = cmdStats();
  });

runCli(program);
