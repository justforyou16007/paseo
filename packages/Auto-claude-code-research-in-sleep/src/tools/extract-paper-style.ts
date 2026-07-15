#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { createCli, runCli } from "../lib/cli.js";

const TOOL_VERSION = "1";
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
const OVERLEAF_URL_RE = /^https?:\/\/([A-Za-z0-9-]+\.)*overleaf\.com(:\d+)?\/project(\/|$)/i;
const OVERLEAF_BARE_ID_RE = /^[A-Fa-f0-9]{24,}$/;

class MissingDep extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingDep";
  }
}

class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

function classifySource(src: string): string {
  if (OVERLEAF_URL_RE.test(src) || OVERLEAF_BARE_ID_RE.test(src)) return "overleaf";
  if (src.startsWith("arxiv:")) return "arxiv";
  if (ARXIV_ID_RE.test(src)) return "arxiv";
  if (src.startsWith("http://") || src.startsWith("https://")) return "http";

  const p = src.startsWith("~") ? path.join(os.homedir(), src.slice(1)) : path.resolve(src);
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return "local_dir";
    if (stat.isFile()) {
      if (path.extname(p).toLowerCase() === ".pdf") return "local_pdf";
      return "local_tex";
    }
  } catch {
    // path doesn't exist
  }
  return "unknown";
}

function whichSync(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function readLocalDir(dirPath: string): string {
  const p = path.resolve(dirPath);
  const texFiles: string[] = [];
  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (entry.isFile() && entry.name.endsWith(".tex")) {
        texFiles.push(full);
      }
    }
  }
  walkDir(p);
  texFiles.sort();

  if (texFiles.length === 0) {
    throw new SourceError(`No .tex files under ${p}`);
  }

  const parts: string[] = [];
  for (const f of texFiles) {
    try {
      parts.push(fs.readFileSync(f, "utf-8"));
    } catch {
      continue;
    }
  }
  return parts.join("\n\n% --- file boundary ---\n\n");
}

function readLocalTex(filePath: string): string {
  return fs.readFileSync(path.resolve(filePath), "utf-8");
}

function readLocalPdf(filePath: string): string {
  if (!whichSync("pdftotext")) {
    throw new MissingDep("pdftotext (poppler) is required to read PDFs");
  }
  const result = spawnSync("pdftotext", ["-layout", path.resolve(filePath), "-"], {
    timeout: 120_000,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new SourceError(`pdftotext failed: ${(result.stderr ?? "").slice(0, 200)}`);
  }
  return result.stdout ?? "";
}

async function readArxiv(arxivId: string): Promise<string> {
  const aid = arxivId.replace(/^arxiv:/, "");
  const url = `https://export.arxiv.org/abs/${aid}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": "aris-extract-paper-style/1" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new SourceError(`arXiv fetch failed: ${e}`);
  }
  if (!resp.ok) {
    throw new SourceError(`arXiv fetch returned HTTP ${resp.status}`);
  }
  return await resp.text();
}

async function readHttp(url: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": "aris-extract-paper-style/1" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new SourceError(`HTTP fetch failed: ${e}`);
  }
  if (!resp.ok) {
    throw new SourceError(`HTTP fetch returned HTTP ${resp.status}`);
  }
  const ctype = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
    if (!whichSync("pdftotext")) {
      throw new MissingDep("pdftotext (poppler) needed to parse downloaded PDF");
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const result = spawnSync("pdftotext", ["-layout", "-", "-"], {
      input: buf,
      timeout: 120_000,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      throw new SourceError("pdftotext failed on downloaded PDF");
    }
    return result.stdout ?? "";
  }
  return await resp.text();
}

// --- Style extraction regexes ---
const SECTION_RE = /\\section\*?\{([^}]*)}/g;
const SUBSECTION_RE = /\\subsection\*?\{([^}]*)}/g;
const THM_RE = /\\begin\{(theorem|lemma|proposition|corollary|definition|assumption|remark)}/gi;
const FIG_RE = /\\begin\{figure\*?}/g;
const TAB_RE = /\\begin\{table\*?}/g;
const CAPTION_RE = /\\caption\{([^{}]*(?:\{[^{}]*}[^{}]*)*)}/g;
const CITE_RE = /\\cite[a-zA-Z]*\*?\{([^}]+)}/g;
const DISPLAY_MATH_RE = /\\begin\{(equation|align|gather|multline)\*?}/g;
const INLINE_MATH_RE = /(?<!\\)\$[^$]+?(?<!\\)\$/g;

function stripTex(text: string): string {
  let t = text;
  t = t.replace(/\\begin\{[^}]+}[\s\S]*?\\end\{[^}]+}/g, " ");
  t = t.replace(/%.*$/gm, " ");
  t = t.replace(/\\[a-zA-Z]+\*?(\[[^\]]*])?(\{[^}]*})*/g, " ");
  t = t.replace(/[{}]/g, " ");
  t = t.replace(/\$[^$]*\$/g, " MATHEXPR ");
  t = t.replace(/\s+/g, " ");
  return t;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function sentenceStats(prose: string): Record<string, number> {
  const sentences = prose
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 4);
  if (sentences.length === 0) return { count: 0, mean_words: 0, median_words: 0, p90_words: 0 };
  const wordCounts = sentences.map((s) => s.split(/\s+/).length);
  const sorted = [...wordCounts].sort((a, b) => a - b);
  const p90Idx = Math.max(0, Math.floor(0.9 * sorted.length) - 1);
  return {
    count: sentences.length,
    mean_words: Math.round(mean(wordCounts) * 10) / 10,
    median_words: Math.floor(median(wordCounts)),
    p90_words: sorted[p90Idx]!,
  };
}

function allMatches(re: RegExp, text: string): string[] {
  const results: string[] = [];
  const cloned = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = cloned.exec(text)) !== null) {
    results.push(m[1] ?? m[0]);
  }
  return results;
}

function countMatches(re: RegExp, text: string): number {
  const cloned = new RegExp(re.source, re.flags);
  let count = 0;
  while (cloned.exec(text) !== null) count++;
  return count;
}

function profileFromTex(tex: string): string {
  const sections = allMatches(SECTION_RE, tex);
  const subsecs = allMatches(SUBSECTION_RE, tex);
  const thmKinds = allMatches(THM_RE, tex);
  const nFig = countMatches(FIG_RE, tex);
  const nTab = countMatches(TAB_RE, tex);
  const captions = allMatches(CAPTION_RE, tex);
  const citations = allMatches(CITE_RE, tex);
  const nDisplay = countMatches(DISPLAY_MATH_RE, tex);
  const nInline = countMatches(INLINE_MATH_RE, tex);

  const citeKeys: string[] = [];
  for (const c of citations) {
    for (const k of c.split(",")) {
      citeKeys.push(k.trim());
    }
  }

  const prose = stripTex(tex);
  const sstats = sentenceStats(prose);

  const sectionWordCounts: Array<[string, number]> = [];
  const sectionSplitRe = /\\section\*?\{([^}]*)}/;
  const parts = tex.split(sectionSplitRe);
  if (parts.length >= 3) {
    for (let i = 1; i < parts.length - 1; i += 2) {
      const name = parts[i]!;
      const body = parts[i + 1] ?? "";
      const wc = stripTex(body).split(/\s+/).length;
      sectionWordCounts.push([name, wc]);
    }
  }

  const captionLens = captions.map((c) => c.split(/\s+/).length);
  let captionSummary = "";
  if (captionLens.length > 0) {
    captionSummary =
      `- Captions: ${captionLens.length} captions, ` +
      `mean ${Math.round(mean(captionLens) * 10) / 10} words, ` +
      `median ${Math.floor(median(captionLens))} words`;
  }

  const thmCounter: Record<string, number> = {};
  for (const k of thmKinds) {
    const key = k.toLowerCase();
    thmCounter[key] = (thmCounter[key] ?? 0) + 1;
  }

  const md: string[] = ["# Style profile (skeleton-only)\n"];
  md.push("**Use as structural guidance for the writer agent. Do NOT copy prose.**\n");

  md.push("\n## Top-level section structure\n");
  if (sections.length > 0) {
    sections.forEach((s, i) => md.push(`${i + 1}. ${s}`));
  } else {
    md.push("- (no `\\section{...}` markers detected — treat as freeform prose)");
  }

  if (subsecs.length > 0) {
    const ratio = (subsecs.length / Math.max(1, sections.length)).toFixed(2);
    md.push(
      `\n- Subsection density: ${subsecs.length} subsections / ${Math.max(1, sections.length)} sections = ${ratio} per section`,
    );
  }

  md.push("\n## Approximate length per section (words after TeX strip)\n");
  if (sectionWordCounts.length > 0) {
    for (const [name, wc] of sectionWordCounts) {
      md.push(`- ${name}: ~${wc} words`);
    }
  } else {
    md.push("- (not measurable)");
  }

  md.push("\n## Theorem-environment density\n");
  const thmEntries = Object.entries(thmCounter).sort((a, b) => b[1] - a[1]);
  if (thmEntries.length > 0) {
    for (const [k, v] of thmEntries) {
      md.push(`- ${k}: ${v}`);
    }
    md.push(`- Total proof-style env: ${Object.values(thmCounter).reduce((a, b) => a + b, 0)}`);
  } else {
    md.push("- (no theorem-style environments)");
  }

  md.push("\n## Figures / tables\n");
  md.push(`- Figures: ${nFig}`);
  md.push(`- Tables: ${nTab}`);
  if (captionSummary) md.push(captionSummary);

  md.push("\n## Math density\n");
  md.push(`- Display equations (equation/align/gather/multline): ${nDisplay}`);
  md.push(`- Inline math \`$...$\`: ${nInline}`);
  if (nInline + nDisplay > 0) {
    const ratio = ((nDisplay / (nInline + nDisplay)) * 100).toFixed(1);
    md.push(`- Display-math share: ${ratio}%`);
  }

  md.push("\n## Citation usage\n");
  md.push(`- Total \`\\cite*{...}\` invocations: ${citations.length}`);
  md.push(`- Distinct cite keys: ${new Set(citeKeys).size}`);
  let bibHint = "unknown";
  if (/\\bibliographystyle\{(plainnat|abbrvnat|authoryear)/.test(tex)) {
    bibHint = "author-year (natbib-style)";
  } else if (/\\bibliographystyle\{(plain|unsrt|ieee|alpha)/.test(tex)) {
    bibHint = "numeric";
  }
  md.push(`- Bibliography style hint: ${bibHint}`);

  md.push("\n## Sentence cadence (after TeX strip)\n");
  md.push(`- Sentence count: ${sstats.count}`);
  md.push(`- Mean words/sentence: ${sstats.mean_words}`);
  md.push(`- Median words/sentence: ${sstats.median_words}`);
  md.push(`- p90 words/sentence: ${sstats.p90_words}`);

  md.push("\n## Notable structural cues\n");
  const cues: string[] = [];
  const allSecs = [...sections, ...subsecs];
  if (allSecs.some((s) => /contribution/i.test(s))) {
    cues.push('- Has explicit "Contributions" subsection');
  }
  if (sections.some((s) => /related work|prior work/i.test(s))) {
    cues.push('- Has dedicated "Related Work" section');
  }
  if (allSecs.some((s) => /limitation|broader impact/i.test(s))) {
    cues.push("- Has explicit Limitations / Broader Impact discussion");
  }
  if (tex.includes("\\paragraph{")) {
    const nPara = tex.split("\\paragraph{").length - 1;
    cues.push(
      `- Uses \`\\paragraph{...}\` headings (${nPara} occurrences) — implies short titled paragraphs`,
    );
  }
  if (cues.length > 0) {
    md.push(...cues);
  } else {
    md.push("- (no salient cues detected)");
  }

  md.push("\n## Reminder to the writer\n");
  md.push("- Match *structural* tendencies above (section count, theorem density, ");
  md.push("  caption length, sentence cadence, math display ratio).");
  md.push("- Do **not** copy prose, claims, examples, or terminology unique to the reference.");
  md.push(
    "- This profile is intentionally aggregate; if you need substance, use the user's own outline.\n",
  );

  return md.join("\n") + "\n";
}

function profileFromText(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 8 && s.length < 1000);
  const wordCounts = sentences.length > 0 ? sentences.map((s) => s.split(/\s+/).length) : [0];
  const headingMatches = text.match(/^([A-Z][A-Za-z ]{2,40})$/gm) ?? [];
  const headings = headingMatches
    .map((h) => h.trim())
    .filter((h) => {
      const wc = h.split(/\s+/).length;
      return wc >= 3 && wc <= 6;
    })
    .slice(0, 30);

  const md: string[] = ["# Style profile (skeleton-only, from non-TeX source)\n"];
  md.push("**Use as structural guidance for the writer agent. Do NOT copy prose.**\n");
  md.push("\n## Heuristic section-name candidates (best effort)\n");
  if (headings.length > 0) {
    for (const h of headings.slice(0, 20)) {
      md.push(`- ${h}`);
    }
  } else {
    md.push("- (no headings recovered)");
  }
  md.push("\n## Sentence cadence\n");
  if (wordCounts.length > 0) {
    md.push(`- Sentence count (heuristic): ${sentences.length}`);
    md.push(`- Mean words/sentence: ${Math.round(mean(wordCounts) * 10) / 10}`);
    md.push(`- Median words/sentence: ${Math.floor(median(wordCounts))}`);
  }
  md.push("\n## Caveat\n");
  md.push("- Source is not LaTeX, so theorem density, citation style, and figure");
  md.push("  density cannot be measured. Treat the section list as a hint only.\n");
  return md.join("\n") + "\n";
}

function buildProfile(srcKind: string, raw: string): string {
  if (srcKind === "local_dir" || srcKind === "local_tex") {
    return profileFromTex(raw);
  }
  return profileFromText(raw);
}

function cacheRoot(overrideOut?: string): string {
  if (overrideOut) return path.resolve(overrideOut);
  const envCache = process.env.ARIS_STYLE_REF_CACHE;
  if (envCache) return path.resolve(envCache);
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".cache");
  return path.join(base, "aris-style-refs");
}

async function mainAction(opts: { source: string; out?: string; force: boolean }): Promise<void> {
  const src = opts.source.trim();
  if (!src) {
    console.error("error: --source is required");
    process.exit(1);
  }

  const kind = classifySource(src);
  if (kind === "overleaf") {
    console.error(
      "Overleaf URLs / project IDs are rejected by design (private content).\n" +
        "Workflow: clone the project locally first via `/overleaf-sync setup <id>`,\n" +
        "then re-run with --source <local-clone-path>.",
    );
    process.exit(3);
  }
  if (kind === "unknown") {
    console.error(
      `error: could not classify source '${src}'. Pass a local path, arXiv id, or http(s) URL.`,
    );
    process.exit(3);
  }

  const digest = crypto.createHash("sha256").update(src, "utf-8").digest("hex").slice(0, 16);
  const root = cacheRoot(opts.out);
  const cacheDir = path.join(root, digest);
  const manifestPath = path.join(cacheDir, "source_manifest.json");
  const profilePath = path.join(cacheDir, "style_profile.md");

  if (fs.existsSync(manifestPath) && fs.existsSync(profilePath) && !opts.force) {
    console.error(`# cache hit: ${cacheDir}`);
    console.log(cacheDir);
    process.exit(0);
  }

  let raw: string;
  let resolved: string;
  try {
    if (kind === "local_dir") {
      raw = readLocalDir(src);
      resolved = path.resolve(src);
    } else if (kind === "local_tex") {
      raw = readLocalTex(src);
      resolved = path.resolve(src);
    } else if (kind === "local_pdf") {
      raw = readLocalPdf(src);
      resolved = path.resolve(src);
    } else if (kind === "arxiv") {
      raw = await readArxiv(src);
      resolved = src;
    } else if (kind === "http") {
      raw = await readHttp(src);
      resolved = src;
    } else {
      console.error(`error: unsupported source kind '${kind}'`);
      process.exit(3);
      return; // unreachable, but satisfies TS
    }
  } catch (e) {
    if (e instanceof MissingDep) {
      console.error(`warning: missing optional dependency: ${e.message}`);
      process.exit(2);
    }
    if (e instanceof SourceError) {
      console.error(`error: source could not be resolved: ${e.message}`);
      process.exit(3);
    }
    console.error(`error: unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
    return;
  }

  const profileMd = buildProfile(kind, raw);

  fs.mkdirSync(cacheDir, { recursive: true });
  const contentSha = crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
  const manifest = {
    source_input: src,
    source_type: kind,
    resolved_path: resolved,
    fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    content_sha256: contentSha,
    tool_version: TOOL_VERSION,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.writeFileSync(profilePath, profileMd, "utf-8");

  console.log(cacheDir);
}

const program = createCli(
  "extract-paper-style",
  "Extract a skeleton-only style profile from a reference paper for opt-in use by ARIS writer skills via --style-ref.",
);

program
  .requiredOption(
    "--source <source>",
    "Local path, arXiv ID, http(s) URL, or 'arxiv:<id>'. Overleaf URLs are rejected.",
  )
  .option(
    "--out <dir>",
    "Override cache root (default: $ARIS_STYLE_REF_CACHE or ~/.cache/aris-style-refs/)",
  )
  .option("--force", "Refetch and overwrite even if cache hit exists", false)
  .action(async (opts: { source: string; out?: string; force: boolean }) => {
    await mainAction(opts);
  });

runCli(program);
