import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const API_BASE = "https://export.arxiv.org/api/query";
const MIN_PDF_BYTES = 10_240;

function arxivUserAgent(): string {
  const contact = (process.env.ARIS_VERIFY_EMAIL ?? "").trim();
  const base =
    "arxiv-skill/1.0 (+https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)";
  return contact ? `${base} (mailto:${contact})` : base;
}

const NEW_STYLE_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
const OLD_STYLE_ID_RE = /^[A-Za-z.-]+\/\d{7}(v\d+)?$/;

function normalizeId(arxivId: string): string {
  let value = arxivId.trim();
  if (value.includes("/abs/")) {
    value = value.split("/abs/")[1]!;
  }
  if (value.startsWith("id:")) {
    value = value.slice(3);
  }
  const lastDotSegment = value.split(".").at(-1) ?? "";
  if (lastDotSegment.includes("v")) {
    value = value.slice(0, value.lastIndexOf("v"));
  }
  return value;
}

function looksLikeArxivId(value: string): boolean {
  value = value.trim();
  return NEW_STYLE_ID_RE.test(value) || OLD_STYLE_ID_RE.test(value);
}

function apiUrl(query: string, maxResults: number, start: number): string {
  query = query.trim();
  let params: Record<string, string | number>;
  if (query.startsWith("id:") || looksLikeArxivId(query)) {
    params = { id_list: normalizeId(query) };
  } else {
    params = {
      search_query: query,
      start,
      max_results: maxResults,
      sortBy: "relevance",
      sortOrder: "descending",
    };
  }
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
  return `${API_BASE}?${qs.toString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ArxivEntry {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  updated: string;
  categories: string[];
  pdf_url: string;
  abs_url: string;
}

function parseEntry(entryXml: string): ArxivEntry {
  const getText = (tag: string): string => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "m");
    const m = entryXml.match(re);
    return m ? m[1]!.trim().replace(/\n/g, " ") : "";
  };

  const rawId = getText("id");
  const arxivId = normalizeId(rawId);
  const title = getText("title");
  const abstract = getText("summary");
  const published = getText("published").slice(0, 10);
  const updated = getText("updated").slice(0, 10);

  const authors: string[] = [];
  const authorRe = /<author[^>]*>[\s\S]*?<name>([^<]*)<\/name>[\s\S]*?<\/author>/g;
  let m: RegExpExecArray | null;
  while ((m = authorRe.exec(entryXml)) !== null) {
    authors.push(m[1]!.trim());
  }

  const categories: string[] = [];
  const catRe = /<category[^>]*term="([^"]+)"/g;
  while ((m = catRe.exec(entryXml)) !== null) {
    categories.push(m[1]!);
  }

  return {
    id: arxivId,
    title,
    authors,
    abstract,
    published,
    updated,
    categories,
    pdf_url: `https://arxiv.org/pdf/${arxivId}.pdf`,
    abs_url: `https://arxiv.org/abs/${arxivId}`,
  };
}

async function fetchAtom(url: string): Promise<string> {
  await sleep(500);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": arxivUserAgent() },
        signal: AbortSignal.timeout(30_000),
      });

      if (resp.status === 429 && attempt < 3) {
        const delay = 5 * attempt;
        console.error(`  [429 rate-limited, retrying in ${delay}s...]`);
        await sleep(delay * 1000);
        continue;
      }

      if (!resp.ok) {
        throw new Error(`arXiv API fetch failed: HTTP ${resp.status}`);
      }

      const body = await resp.text();

      if (body.trim() === "Rate exceeded.") {
        if (attempt < 3) {
          const delay = 5 * attempt;
          console.error(`  [rate-limited (plain-text body), retrying in ${delay}s...]`);
          await sleep(delay * 1000);
          continue;
        }
        throw new Error("arXiv API rate-limited after 3 attempts");
      }

      return body;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("arXiv API")) throw err;
      if (attempt < 3) {
        const delay = 2 * attempt;
        console.error(`  [network error, retrying in ${delay}s...]`);
        await sleep(delay * 1000);
        continue;
      }
      throw new Error(`arXiv API fetch failed: ${err}`);
    }
  }

  throw new Error("arXiv API fetch failed: exhausted retries");
}

async function searchArxiv(query: string, maxResults = 10, start = 0): Promise<ArxivEntry[]> {
  const url = apiUrl(query, maxResults, start);
  const xml = await fetchAtom(url);

  const entries: ArxivEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    entries.push(parseEntry(m[1]!));
  }
  return entries;
}

interface DownloadResult {
  id: string;
  path: string;
  size_kb: number;
  skipped: boolean;
  message?: string;
}

async function download(arxivId: string, outputDir = "papers"): Promise<DownloadResult> {
  const cleanId = normalizeId(arxivId);
  const safeId = cleanId.replace("/", "_");

  fs.mkdirSync(outputDir, { recursive: true });
  const dest = path.join(outputDir, `${safeId}.pdf`);

  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest);
    return {
      id: cleanId,
      path: dest,
      size_kb: Math.floor(stat.size / 1024),
      skipped: true,
    };
  }

  const pdfUrl = `https://arxiv.org/pdf/${cleanId}.pdf`;

  let data: ArrayBuffer | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(pdfUrl, {
        headers: { "User-Agent": arxivUserAgent() },
        signal: AbortSignal.timeout(60_000),
      });

      if (resp.status === 429 && attempt < 3) {
        await sleep(5 * attempt * 1000);
        continue;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      data = await resp.arrayBuffer();
      break;
    } catch (err) {
      if (attempt < 3) {
        await sleep(2 * attempt * 1000);
        continue;
      }
      throw new Error(`Failed to download ${pdfUrl}: ${err}`);
    }
  }

  if (!data) {
    throw new Error(`Failed to download ${pdfUrl} after 3 attempts`);
  }

  if (data.byteLength < MIN_PDF_BYTES) {
    throw new Error(
      `Downloaded file is only ${data.byteLength} bytes - likely an error page, not a PDF`,
    );
  }

  fs.writeFileSync(dest, Buffer.from(data));
  return {
    id: cleanId,
    path: dest,
    size_kb: Math.floor(data.byteLength / 1024),
    skipped: false,
  };
}

function addSearchArgs(cmd: import("commander").Command): import("commander").Command {
  return cmd
    .argument("<query>", "Search query or arXiv ID (bare ID or id:ARXIV_ID)")
    .option("--max <n>", "Maximum number of results", "10")
    .option("--start <n>", "Start offset for pagination", "0");
}

const program = createCli("arxiv-fetch", "Search and download arXiv papers.");

for (const name of ["search", "get", "fetch"]) {
  const cmd = program.command(name).description("Search arXiv papers");
  addSearchArgs(cmd).action(async (query: string, opts: { max: string; start: string }) => {
    const results = await searchArxiv(query, parseInt(opts.max, 10), parseInt(opts.start, 10));
    console.log(JSON.stringify(results, null, 2));
  });
}

program
  .command("download")
  .description("Download a paper PDF by arXiv ID")
  .argument("<id>", "arXiv paper ID, e.g. 2301.07041 or cs/0601001")
  .option("--dir <dir>", "Output directory", "papers")
  .option("--delay <seconds>", "Seconds to sleep after download", "1")
  .action(async (id: string, opts: { dir: string; delay: string }) => {
    const result = await download(id, opts.dir);
    if (result.skipped) {
      console.log(JSON.stringify({ ...result, message: "already exists, skipped" }));
    } else {
      await sleep(parseFloat(opts.delay) * 1000);
      console.log(JSON.stringify(result));
    }
  });

runCli(program);
