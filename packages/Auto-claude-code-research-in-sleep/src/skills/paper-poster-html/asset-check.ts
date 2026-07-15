#!/usr/bin/env node
/**
 * asset_check — the "real-figure provenance" gate.
 *
 * A poster passes this gate only when its paper figures are genuinely
 * sourced from the paper and rendered large/sharp enough to read.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createCli, runCli } from "../../lib/cli.js";
import { readCanvasFromHtml, viewportFor } from "./posterly/canvas.js";
import { asciiSafe } from "./posterly/textutil.js";

const _REQUIRED_FIG_FIELDS: readonly string[] = [
  "asset_id",
  "file",
  "from_paper",
  "page",
  "bbox",
  "dpi",
  "sha256",
  "natural_px",
];

const _RES_HARD_FACTOR = 1.5;
const _RES_WARN_FACTOR = 2.0;

// ---------------------------------------------------------------------------
// HTML parsing: collect <img> elements.
// ---------------------------------------------------------------------------

interface ImgAttrs {
  [key: string]: string;
}

function collectImgs(html: string): ImgAttrs[] {
  const imgs: ImgAttrs[] = [];
  const tagRe = /<img\b([^>]*)\/?>|<img\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  let lineCount = 1;
  let lastIndex = 0;

  while ((tagMatch = tagRe.exec(html)) !== null) {
    for (let i = lastIndex; i < tagMatch.index; i++) {
      if (html[i] === "\n") lineCount++;
    }
    lastIndex = tagMatch.index;

    const attrStr = tagMatch[1] || tagMatch[2] || "";
    const d: ImgAttrs = {};
    const attrRe = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrStr)) !== null) {
      const key = attrMatch[1].toLowerCase();
      const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
      d[key] = val;
    }
    // Also capture valueless boolean attributes
    const boolRe = /\b([a-zA-Z][\w-]*)(?=\s|\/?>)/g;
    let boolMatch: RegExpExecArray | null;
    while ((boolMatch = boolRe.exec(attrStr)) !== null) {
      const key = boolMatch[1].toLowerCase();
      if (!(key in d)) d[key] = "";
    }
    d["_line"] = String(lineCount);
    imgs.push(d);
  }
  return imgs;
}

function paperImgs(imgs: ImgAttrs[]): ImgAttrs[] {
  return imgs.filter((d) => (d["data-source"] || "").trim().toLowerCase() === "paper");
}

// ---------------------------------------------------------------------------
// Manifest loading + schema validation.
// ---------------------------------------------------------------------------

interface ManifestData {
  figures?: ManifestFigure[];
  [key: string]: unknown;
}

interface ManifestFigure {
  asset_id?: string;
  file?: string;
  from_paper?: boolean;
  page?: number;
  bbox?: number[];
  dpi?: number;
  sha256?: string;
  natural_px?: number[];
  [key: string]: unknown;
}

function loadManifest(manifestPath: string): ManifestData {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${asciiSafe(manifestPath)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    throw new Error(`manifest is not valid JSON: ${asciiSafe(String(e))}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("manifest top-level must be a JSON object");
  }
  return data as ManifestData;
}

function indexFigures(manifest: ManifestData): Map<string, ManifestFigure> {
  const out = new Map<string, ManifestFigure>();
  const figs = manifest.figures;
  if (!Array.isArray(figs)) return out;
  for (const f of figs) {
    if (typeof f === "object" && f !== null && typeof f.asset_id === "string") {
      out.set(f.asset_id, f);
    }
  }
  return out;
}

function missingFields(fig: ManifestFigure): string[] {
  return _REQUIRED_FIG_FIELDS.filter((k) => !(k in fig));
}

function sha256Of(filePath: string): string {
  const h = crypto.createHash("sha256");
  const buf = fs.readFileSync(filePath);
  h.update(buf);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Check accumulation.
// ---------------------------------------------------------------------------

interface CheckRow {
  id: string;
  severity: string;
  status: string;
  detail: string;
}

class Checks {
  rows: CheckRow[] = [];

  add(cid: string, severity: string, status: string, detail: string): void {
    this.rows.push({
      id: cid,
      severity,
      status,
      detail: asciiSafe(detail),
    });
  }

  overall(): string {
    if (this.rows.some((r) => r.severity === "hard" && r.status === "FAIL")) {
      return "FAIL";
    }
    if (this.rows.some((r) => r.status === "WARN")) {
      return "WARN";
    }
    return "PASS";
  }
}

// ---------------------------------------------------------------------------
// Static provenance + manifest checks.
// ---------------------------------------------------------------------------

function checkProvenance(
  checks: Checks,
  pImgs: ImgAttrs[],
  figIndex: Map<string, ManifestFigure>,
  manifestDir: string,
  minPaperFigs: number,
): [ImgAttrs, ManifestFigure][] {
  const n = pImgs.length;
  if (n >= minPaperFigs) {
    checks.add(
      "paper_fig_count",
      "hard",
      "PASS",
      `${n} img[data-source=paper] (>= ${minPaperFigs} required)`,
    );
  } else {
    checks.add(
      "paper_fig_count",
      "hard",
      "FAIL",
      `only ${n} img[data-source=paper]; need >= ${minPaperFigs}. ` +
        `Pull at least ${minPaperFigs} real figures from the paper.`,
    );
  }

  const validated: [ImgAttrs, ManifestFigure][] = [];
  for (const img of pImgs) {
    const line = img["_line"] || "?";
    const assetId = (img["data-asset-id"] || "").trim();
    const tag = `L${line} src=${asciiSafe(img["src"] || "?")}`;

    if (!assetId) {
      checks.add(
        "asset_id_present",
        "hard",
        "FAIL",
        `${tag}: data-source=paper without data-asset-id; cannot trace to the manifest.`,
      );
      continue;
    }

    const entry = figIndex.get(assetId);
    if (!entry) {
      checks.add(
        "asset_id_resolves",
        "hard",
        "FAIL",
        `${tag}: data-asset-id='${asciiSafe(assetId)}' not found in manifest figures[].`,
      );
      continue;
    }

    if (entry.from_paper !== true) {
      checks.add(
        "from_paper",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: from_paper is '${asciiSafe(String(entry.from_paper))}', must be true.`,
      );
      continue;
    }

    const missing = missingFields(entry);
    if (missing.length > 0) {
      checks.add(
        "manifest_fields",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: missing required field(s) ${JSON.stringify(missing)}.`,
      );
      continue;
    }

    const rel = String(entry.file || "");
    const fpath = path.resolve(manifestDir, rel);
    if (!fs.existsSync(fpath)) {
      checks.add(
        "asset_file_exists",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: file ${asciiSafe(rel)} does not exist at ${asciiSafe(fpath)}.`,
      );
      continue;
    }

    const want = String(entry.sha256 || "")
      .trim()
      .toLowerCase();
    const got = sha256Of(fpath).toLowerCase();
    if (want !== got) {
      checks.add(
        "asset_sha256",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: sha256 mismatch (manifest ${want.substring(0, 12)}..., file ${got.substring(0, 12)}...). ` +
          `The on-disk file is not the manifested figure.`,
      );
      continue;
    }

    checks.add(
      "asset_provenance",
      "hard",
      "PASS",
      `asset ${asciiSafe(assetId)}: resolves, from_paper, fields complete, file exists, sha256 matches.`,
    );
    validated.push([img, entry]);
  }

  return validated;
}

// ---------------------------------------------------------------------------
// CSS width hint extraction (for --no-render estimate).
// ---------------------------------------------------------------------------

function widthFractionHint(img: ImgAttrs): number | null {
  const style = img["style"] || "";
  const m1 = /width\s*:\s*([\d.]+)\s*%/i.exec(style);
  if (m1) {
    const v = parseFloat(m1[1]);
    if (!isNaN(v)) return Math.max(0, Math.min(1, v / 100));
  }
  const cls = img["class"] || "";
  const m2 = /\bw-(\d{2,3})\b/.exec(cls);
  if (m2) {
    const v = parseFloat(m2[1]);
    if (!isNaN(v)) return Math.max(0, Math.min(1, v / 100));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendered-geometry path (Playwright). Lazy import inside.
// ---------------------------------------------------------------------------

interface BoxInfo {
  w: number;
  h: number;
  area: number;
}

async function measureRendered(
  htmlPath: string,
  viewport: [number, number],
  assetIds: string[],
  mathjaxTimeoutMs: number,
): Promise<Record<string, BoxInfo> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    pw = await import("playwright" as string);
  } catch {
    process.stderr.write(
      "[asset_check] NOTICE: playwright not available; cannot measure rendered " +
        "figure areas. Falling back to natural_px + CSS-width ESTIMATE.\n",
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _render: any;
  try {
    _render = await import("./posterly/render.js");
  } catch {
    return null;
  }

  const [w, h] = viewport;
  const result: Record<string, BoxInfo> = {};
  const p = await pw.chromium.launch();
  const ctx = await p.newContext();
  const page = await ctx.newPage();

  const { browser: _br, page: emPage } = await _render
    .openPrintEmulatedPage({ chromium: { launch: () => Promise.resolve(p) } }, [w, h])
    .catch(() => ({ browser: p, page }));

  const activePage = emPage || page;
  const fileUrl = `file://${htmlPath}`;
  try {
    await activePage.goto(fileUrl, { timeout: mathjaxTimeoutMs });
  } catch {
    process.stderr.write(
      `[asset_check] WARN: page.goto did not reach load within ${mathjaxTimeoutMs} ms.\n`,
    );
  }

  try {
    if (_render.settlePage) {
      await _render.settlePage(activePage, {
        mathjaxTimeoutMs,
        settleMs: 300,
      });
    }
  } catch {
    // settle is best-effort
  }

  const boxes = await activePage.evaluate(
    `(ids) => {
      const out = {};
      const poster =
        document.querySelector('[data-measure-role="poster"]') ||
        document.querySelector(".poster") ||
        document.body;
      const body =
        document.querySelector('[data-measure-role="body"]') || poster;
      const rp = poster.getBoundingClientRect();
      const rb = body.getBoundingClientRect();
      out["__poster__"] = { w: rp.width, h: rp.height, area: rp.width * rp.height };
      out["__body__"] = { w: rb.width, h: rb.height, area: rb.width * rb.height };
      for (const id of ids) {
        const el = document.querySelector(
          'img[data-source="paper"][data-asset-id="' + id.replace(/"/g, '\\\\"') + '"]'
        );
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out[id] = { w: r.width, h: r.height, area: r.width * r.height };
      }
      return out;
    }`,
    assetIds,
  );

  await p.close();

  for (const [k, v] of Object.entries(boxes)) {
    const vObj = v as { w: number; h: number; area: number };
    result[k] = { w: vObj.w, h: vObj.h, area: vObj.area };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Area + resolution checks.
// ---------------------------------------------------------------------------

function checkResolution(
  checks: Checks,
  entry: ManifestFigure,
  renderedW: number,
  renderedH: number,
  estimated: boolean,
): void {
  const assetId = String(entry.asset_id);
  const nat = entry.natural_px;
  if (!Array.isArray(nat) || nat.length < 2) {
    checks.add(
      "fig_resolution",
      "warn",
      estimated ? "ESTIMATED" : "WARN",
      `asset ${asciiSafe(assetId)}: natural_px missing/invalid; cannot check resolution.`,
    );
    return;
  }
  const natW = nat[0];
  const natH = nat[1];
  const rx = renderedW > 0 ? natW / renderedW : Infinity;
  const ry = renderedH > 0 ? natH / renderedH : Infinity;
  const ratio = Math.min(rx, ry);
  const src = estimated ? "estimated rendered" : "rendered";

  if (ratio >= _RES_WARN_FACTOR) {
    checks.add(
      "fig_resolution",
      estimated ? "warn" : "hard",
      estimated ? "ESTIMATED" : "PASS",
      `asset ${asciiSafe(assetId)}: natural ${natW}x${natH} = ${ratio.toFixed(2)}x ${src} ` +
        `(${renderedW.toFixed(0)}x${renderedH.toFixed(0)}); >= ${_RES_WARN_FACTOR}x target.`,
    );
  } else if (ratio >= _RES_HARD_FACTOR) {
    checks.add(
      "fig_resolution",
      "warn",
      estimated ? "ESTIMATED" : "WARN",
      `asset ${asciiSafe(assetId)}: natural ${natW}x${natH} = ${ratio.toFixed(2)}x ${src} ` +
        `(${renderedW.toFixed(0)}x${renderedH.toFixed(0)}); >= ${_RES_HARD_FACTOR}x floor ` +
        `but below ${_RES_WARN_FACTOR}x target -- consider a higher-DPI crop.`,
    );
  } else {
    if (estimated) {
      checks.add(
        "fig_resolution",
        "warn",
        "ESTIMATED",
        `asset ${asciiSafe(assetId)}: natural ${natW}x${natH} = ${ratio.toFixed(2)}x ${src} ` +
          `(${renderedW.toFixed(0)}x${renderedH.toFixed(0)}); below ${_RES_HARD_FACTOR}x floor ` +
          `(ESTIMATED -- re-render to enforce).`,
      );
    } else {
      checks.add(
        "fig_resolution",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: natural ${natW}x${natH} = ${ratio.toFixed(2)}x ${src} ` +
          `(${renderedW.toFixed(0)}x${renderedH.toFixed(0)}); below ${_RES_HARD_FACTOR}x floor ` +
          `-- prints blurry. Re-crop at higher DPI (target ${_RES_WARN_FACTOR}x).`,
      );
    }
  }
}

function checkAreasRendered(
  checks: Checks,
  validated: [ImgAttrs, ManifestFigure][],
  boxes: Record<string, BoxInfo>,
  minFigArea: number,
  minTotalArea: number,
  waiveTotalArea: boolean,
  warnFigArea = 0.1,
  maxFigArea = 0.13,
  warnTotalArea = 0.24,
  maxTotalArea = 0.28,
): void {
  const posterArea = boxes["__poster__"]?.area || 0;
  const bodyArea = boxes["__body__"]?.area || posterArea;

  let totalFigArea = 0;
  for (const [_img, entry] of validated) {
    const assetId = String(entry.asset_id);
    const box = boxes[assetId];
    if (!box) {
      checks.add(
        "fig_area",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: not found / zero-size in the rendered poster (hidden or detached?).`,
      );
      continue;
    }
    const area = box.area;
    totalFigArea += area;
    const frac = posterArea > 0 ? area / posterArea : 0;
    if (frac >= minFigArea) {
      checks.add(
        "fig_area",
        "hard",
        "PASS",
        `asset ${asciiSafe(assetId)}: ${(frac * 100).toFixed(2)}% of poster (>= ${(minFigArea * 100).toFixed(2)}%).`,
      );
    } else {
      checks.add(
        "fig_area",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: only ${(frac * 100).toFixed(2)}% of poster ` +
          `(need >= ${(minFigArea * 100).toFixed(2)}%). Widen the figure.`,
      );
    }

    const bodyFrac = bodyArea > 0 ? area / bodyArea : 0;
    if (bodyFrac > maxFigArea) {
      checks.add(
        "fig_area_max",
        "hard",
        "FAIL",
        `asset ${asciiSafe(assetId)}: ${(bodyFrac * 100).toFixed(2)}% of body ` +
          `(> ${(maxFigArea * 100).toFixed(0)}% hard max). A figure this dominant crowds out content.`,
      );
    } else if (bodyFrac > warnFigArea) {
      checks.add(
        "fig_area_max",
        "warn",
        "WARN",
        `asset ${asciiSafe(assetId)}: ${(bodyFrac * 100).toFixed(2)}% of body ` +
          `(> ${(warnFigArea * 100).toFixed(0)}%); target per-figure band is 4-8%.`,
      );
    }
    checkResolution(checks, entry, box.w, box.h, false);
  }

  const totalFrac = bodyArea > 0 ? totalFigArea / bodyArea : 0;
  if (waiveTotalArea) {
    checks.add(
      "total_fig_area",
      "hard",
      "NOTICE",
      `total paper-image area = ${(totalFrac * 100).toFixed(2)}% of body; ` +
        `WAIVED via --waive-total-area (pure-theory poster).`,
    );
  } else if (totalFrac >= minTotalArea) {
    checks.add(
      "total_fig_area",
      "hard",
      "PASS",
      `total paper-image area = ${(totalFrac * 100).toFixed(2)}% of body ` +
        `(>= ${(minTotalArea * 100).toFixed(2)}%).`,
    );
  } else {
    checks.add(
      "total_fig_area",
      "hard",
      "FAIL",
      `total paper-image area = ${(totalFrac * 100).toFixed(2)}% of body ` +
        `(need >= ${(minTotalArea * 100).toFixed(2)}%). Add/enlarge real figures.`,
    );
  }

  if (totalFrac > maxTotalArea) {
    checks.add(
      "total_fig_area_max",
      "hard",
      "FAIL",
      `total paper-image area = ${(totalFrac * 100).toFixed(2)}% of body ` +
        `(> ${(maxTotalArea * 100).toFixed(0)}% hard max). Figures are crowding out content.`,
    );
  } else if (totalFrac > warnTotalArea) {
    checks.add(
      "total_fig_area_max",
      "warn",
      "WARN",
      `total paper-image area = ${(totalFrac * 100).toFixed(2)}% of body ` +
        `(> ${(warnTotalArea * 100).toFixed(0)}%); target band is 14-22%.`,
    );
  }
}

function checkAreasEstimated(
  checks: Checks,
  validated: [ImgAttrs, ManifestFigure][],
  canvasIn: [number, number],
  minFigArea: number,
  minTotalArea: number,
  waiveTotalArea: boolean,
): void {
  checks.add(
    "render_mode",
    "warn",
    "NOTICE",
    "no rendering available (--no-render or playwright missing); " +
      "area + resolution checks are ESTIMATED and not enforced as hard gates.",
  );

  const [posterWPx, posterHPx] = viewportFor(canvasIn);
  const posterArea = posterWPx * posterHPx;
  const assumedColFrac = 1 / 3;

  let totalEstArea = 0;
  let anyBelow = false;
  for (const [img, entry] of validated) {
    const assetId = String(entry.asset_id);
    const nat = entry.natural_px;
    if (!Array.isArray(nat) || nat.length < 2) {
      checks.add(
        "fig_area",
        "warn",
        "ESTIMATED",
        `asset ${asciiSafe(assetId)}: natural_px missing/invalid; cannot estimate area.`,
      );
      continue;
    }
    const natW = nat[0];
    const natH = nat[1];
    const aspect = natW > 0 ? natH / natW : 1;
    let wfrac = widthFractionHint(img);
    if (wfrac === null) wfrac = 0.95;
    const rendW = posterWPx * assumedColFrac * wfrac;
    const rendH = rendW * aspect;
    const estArea = rendW * rendH;
    totalEstArea += estArea;
    const frac = posterArea > 0 ? estArea / posterArea : 0;
    const below = frac < minFigArea;
    anyBelow = anyBelow || below;
    checks.add(
      "fig_area",
      "warn",
      "ESTIMATED",
      `asset ${asciiSafe(assetId)}: ~${(frac * 100).toFixed(2)}% of poster ` +
        `(threshold ${(minFigArea * 100).toFixed(2)}%, ${below ? "BELOW" : "ok"}).`,
    );
    checkResolution(checks, entry, rendW, rendH, true);
  }

  const totalFrac = posterArea > 0 ? totalEstArea / posterArea : 0;
  if (waiveTotalArea) {
    checks.add(
      "total_fig_area",
      "warn",
      "NOTICE",
      `total paper-image area ~${(totalFrac * 100).toFixed(2)}% of poster (ESTIMATED); WAIVED.`,
    );
  } else {
    const belowTotal = totalFrac < minTotalArea;
    anyBelow = anyBelow || belowTotal;
    checks.add(
      "total_fig_area",
      "warn",
      "ESTIMATED",
      `total paper-image area ~${(totalFrac * 100).toFixed(2)}% of poster ` +
        `(threshold ${(minTotalArea * 100).toFixed(2)}%, ${belowTotal ? "BELOW" : "ok"}).`,
    );
  }

  if (anyBelow) {
    checks.add(
      "area_estimate_notice",
      "warn",
      "NOTICE",
      "one or more ESTIMATED areas are below threshold; this is NOT a hard failure. " +
        "Re-run WITHOUT --no-render to enforce the real area gate.",
    );
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

interface AssetCheckArgs {
  html: string;
  manifest: string;
  json: string | null;
  minPaperFigs: number;
  minFigArea: number;
  minTotalArea: number;
  warnFigArea: number;
  maxFigArea: number;
  warnTotalArea: number;
  maxTotalArea: number;
  hero: boolean;
  waiveTotalArea: boolean;
  noRender: boolean;
  mathjaxTimeoutMs: number;
}

async function run(args: AssetCheckArgs): Promise<number> {
  const htmlPath = path.resolve(args.html);
  if (!fs.existsSync(htmlPath)) {
    process.stderr.write(`ERROR: HTML not found: ${asciiSafe(htmlPath)}\n`);
    return 2;
  }

  const manifestPath = path.resolve(args.manifest);
  let manifest: ManifestData;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    process.stderr.write(`ERROR: ${asciiSafe(String(e))}\n`);
    return 2;
  }

  const manifestDir = path.dirname(manifestPath);
  const figIndex = indexFigures(manifest);

  const htmlText = fs.readFileSync(htmlPath, { encoding: "utf-8" });
  const allImgs = collectImgs(htmlText);
  const pImgs = paperImgs(allImgs);

  const checks = new Checks();

  const validated = checkProvenance(checks, pImgs, figIndex, manifestDir, args.minPaperFigs);

  const canvasIn = readCanvasFromHtml(htmlPath);
  if (canvasIn === null) {
    checks.add(
      "canvas",
      "hard",
      "FAIL",
      "could not parse @page { size } from the poster HTML; cannot " +
        "determine poster area for figure-area checks.",
    );
  } else {
    let boxes: Record<string, BoxInfo> | null = null;
    if (!args.noRender) {
      const assetIds = validated.map(([, e]) => String(e.asset_id));
      const viewport = viewportFor(canvasIn);
      boxes = await measureRendered(htmlPath, viewport, assetIds, args.mathjaxTimeoutMs);
    }
    if (boxes !== null) {
      const warnFig = args.hero ? 0.4 : args.warnFigArea;
      const maxFig = args.hero ? 0.42 : args.maxFigArea;
      const maxTotal = args.hero ? 0.5 : args.maxTotalArea;
      checkAreasRendered(
        checks,
        validated,
        boxes,
        args.minFigArea,
        args.minTotalArea,
        args.waiveTotalArea,
        warnFig,
        maxFig,
        args.warnTotalArea,
        maxTotal,
      );
    } else {
      checkAreasEstimated(
        checks,
        validated,
        canvasIn,
        args.minFigArea,
        args.minTotalArea,
        args.waiveTotalArea,
      );
    }
  }

  const status = checks.overall();
  const report = { gate: "asset", status, checks: checks.rows };

  console.log(`[asset_check] gate=asset status=${status} (${checks.rows.length} checks)`);
  for (const r of checks.rows) {
    console.log(`  [${r.status.padEnd(9)}] ${r.severity.padEnd(4)} ${r.id}: ${r.detail}`);
  }

  if (args.json) {
    const outPath = path.resolve(args.json);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    console.log(`[asset_check] report -> ${asciiSafe(outPath)}`);
  }

  return status === "FAIL" ? 1 : 0;
}

const program = createCli(
  "asset_check",
  "Real-figure provenance + area + resolution gate for HTML academic posters.",
);

program
  .argument("<html>", "path to poster.html")
  .requiredOption("--manifest <path>", "path to FIGURE_MANIFEST.json")
  .option("--json <path>", "write JSON report to this file")
  .option("--min-paper-figs <n>", "min img[data-source=paper] count", "2")
  .option("--min-fig-area <n>", "min rendered area per figure", "0.015")
  .option("--min-total-area <n>", "min total paper-image area", "0.12")
  .option("--warn-fig-area <n>", "WARN when single figure exceeds this fraction", "0.10")
  .option("--max-fig-area <n>", "HARD max per-figure area", "0.13")
  .option("--warn-total-area <n>", "WARN total paper-image area threshold", "0.24")
  .option("--max-total-area <n>", "HARD max total paper-image area", "0.28")
  .option("--hero", "hero-template mode: relax per-figure maxes")
  .option("--waive-total-area", "waive the total-area rule for pure-theory posters")
  .option("--no-render", "skip Playwright; estimate areas from natural_px + CSS width hints")
  .option("--mathjax-timeout-ms <n>", "render path: MathJax settle timeout", "15000")
  .action(async (html: string, opts: Record<string, string | boolean | undefined>) => {
    const args: AssetCheckArgs = {
      html,
      manifest: opts.manifest as string,
      json: (opts.json as string) || null,
      minPaperFigs: parseInt((opts.minPaperFigs as string) || "2", 10),
      minFigArea: parseFloat((opts.minFigArea as string) || "0.015"),
      minTotalArea: parseFloat((opts.minTotalArea as string) || "0.12"),
      warnFigArea: parseFloat((opts.warnFigArea as string) || "0.10"),
      maxFigArea: parseFloat((opts.maxFigArea as string) || "0.13"),
      warnTotalArea: parseFloat((opts.warnTotalArea as string) || "0.24"),
      maxTotalArea: parseFloat((opts.maxTotalArea as string) || "0.28"),
      hero: !!opts.hero,
      waiveTotalArea: !!opts.waiveTotalArea,
      noRender: !!opts.noRender,
      mathjaxTimeoutMs: parseInt((opts.mathjaxTimeoutMs as string) || "15000", 10),
    };
    const code = await run(args);
    process.exit(code);
  });

runCli(program);
