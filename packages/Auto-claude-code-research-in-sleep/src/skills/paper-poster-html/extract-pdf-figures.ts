#!/usr/bin/env node
/**
 * extract_pdf_figures — pull real figures out of a paper PDF.
 *
 * Three subcommands: contact-sheet, auto, crop.
 * Uses CLI tools (mutool/pdftoppm) instead of PyMuPDF, and sharp instead
 * of PIL for image manipulation.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { createCli, runCli } from "../../lib/cli.js";
import { asciiSafe } from "./posterly/textutil.js";

const SCHEMA_VERSION = 1;
const CONTACT_DPI = 110;
const GRID_STEP_PT = 50;
const PT_PER_INCH = 72.0;

function sha256File(filePath: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function pdfPageCount(pdfPath: string): number {
  try {
    const output = execSync(`mutool info "${pdfPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const m = /Pages:\s*(\d+)/i.exec(output);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    try {
      const output = execSync(`pdfinfo "${pdfPath}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const m = /Pages:\s*(\d+)/i.exec(output);
      return m ? parseInt(m[1], 10) : 0;
    } catch {
      process.stderr.write("ERROR: neither mutool nor pdfinfo available for page count.\n");
      return 0;
    }
  }
}

function pdfPageSize(pdfPath: string, pageNum: number): [number, number] | null {
  try {
    const output = execSync(`mutool info -M "${pdfPath}" ${pageNum}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const m = /MediaBox:\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/i.exec(output);
    if (m) return [parseFloat(m[3]) - parseFloat(m[1]), parseFloat(m[4]) - parseFloat(m[2])];
  } catch {
    // fall through
  }
  try {
    const output = execSync(`pdfinfo -f ${pageNum} -l ${pageNum} "${pdfPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const m = /Page\s+\d+\s+size:\s*([\d.]+)\s*x\s*([\d.]+)/i.exec(output);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  } catch {
    // fall through
  }
  return null;
}

function renderPage(
  pdfPath: string,
  pageNum: number,
  dpi: number,
  outPath: string,
  bbox?: [number, number, number, number],
): boolean {
  const args: string[] = [];
  if (bbox) {
    const [x0, y0, x1, y1] = bbox;
    const scale = dpi / PT_PER_INCH;
    const pxX0 = Math.floor(x0 * scale);
    const pxY0 = Math.floor(y0 * scale);
    const pxX1 = Math.ceil(x1 * scale);
    const pxY1 = Math.ceil(y1 * scale);
    args.push(`-x ${pxX0}`, `-y ${pxY0}`, `-W ${pxX1 - pxX0}`, `-H ${pxY1 - pxY0}`);
  }

  try {
    execSync(
      `pdftoppm -f ${pageNum} -l ${pageNum} -r ${dpi} -png ${args.join(" ")} "${pdfPath}" "${outPath.replace(/\.png$/, "")}"`,
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stem = outPath.replace(/\.png$/, "");
    const candidates = [
      `${stem}-${String(pageNum).padStart(6, "0")}.png`,
      `${stem}-${String(pageNum).padStart(3, "0")}.png`,
      `${stem}-${pageNum}.png`,
      `${stem}.png`,
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        if (c !== outPath) fs.renameSync(c, outPath);
        return true;
      }
    }
    return fs.existsSync(outPath);
  } catch {
    try {
      const bboxArgs = bbox
        ? `-x ${bbox[0]} -y ${bbox[1]} -w ${bbox[2] - bbox[0]} -h ${bbox[3] - bbox[1]}`
        : "";
      execSync(`mutool draw -o "${outPath}" -r ${dpi} ${bboxArgs} "${pdfPath}" ${pageNum}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      return fs.existsSync(outPath);
    } catch {
      process.stderr.write("ERROR: neither pdftoppm nor mutool available for rendering.\n");
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// contact-sheet subcommand.
// ---------------------------------------------------------------------------

async function cmdContactSheet(args: { pdf: string; out: string; dpi: number }): Promise<number> {
  const pdfPath = path.resolve(args.pdf);
  if (!fs.existsSync(pdfPath)) {
    process.stderr.write(`ERROR: PDF not found: ${asciiSafe(pdfPath)}\n`);
    return 2;
  }

  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const pages = pdfPageCount(pdfPath);
  if (pages === 0) {
    process.stderr.write("ERROR: PDF has no pages or cannot be read.\n");
    return 1;
  }

  const written: string[] = [];
  for (let pno = 1; pno <= pages; pno++) {
    const outPath = path.join(outDir, `contact_sheet_p${String(pno).padStart(2, "0")}.png`);
    const ok = renderPage(pdfPath, pno, CONTACT_DPI, outPath);
    if (!ok) {
      process.stderr.write(`WARN: failed to render page ${pno}\n`);
      continue;
    }

    const pageSize = pdfPageSize(pdfPath, pno);
    const wPt = pageSize ? pageSize[0] : 0;
    const hPt = pageSize ? pageSize[1] : 0;

    // Overlay grid using sharp
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sharp: any;
    try {
      sharp = await import("sharp" as string);
    } catch {
      // No sharp available, skip grid overlay
      written.push(outPath);
      console.log(
        `[contact-sheet] page ${pno}: ${Math.round(wPt)}x${Math.round(hPt)}pt -> ${asciiSafe(outPath)}`,
      );
      continue;
    }

    try {
      const meta = await sharp.default(outPath).metadata();
      const imgW = meta.width || 0;
      const imgH = meta.height || 0;
      const scale = CONTACT_DPI / PT_PER_INCH;

      let svgOverlay = `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">`;
      const gridColor = "rgba(170,200,230,0.7)";
      const labelColor = "rgb(40,90,150)";

      for (let x = 0; x <= wPt + 0.1; x += GRID_STEP_PT) {
        const px = Math.round(x * scale);
        svgOverlay += `<line x1="${px}" y1="0" x2="${px}" y2="${imgH}" stroke="${gridColor}" stroke-width="1"/>`;
        svgOverlay += `<text x="${px + 2}" y="12" fill="${labelColor}" font-size="10">${Math.round(x)}</text>`;
      }
      for (let y = 0; y <= hPt + 0.1; y += GRID_STEP_PT) {
        const py = Math.round(y * scale);
        svgOverlay += `<line x1="0" y1="${py}" x2="${imgW}" y2="${py}" stroke="${gridColor}" stroke-width="1"/>`;
        svgOverlay += `<text x="2" y="${py + 12}" fill="${labelColor}" font-size="10">${Math.round(y)}</text>`;
      }
      svgOverlay += "</svg>";

      await sharp
        .default(outPath)
        .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
        .toFile(outPath + ".tmp.png");
      fs.renameSync(outPath + ".tmp.png", outPath);
    } catch {
      // Grid overlay failed, continue with raw render
    }

    written.push(outPath);
    console.log(
      `[contact-sheet] page ${pno}: ${Math.round(wPt)}x${Math.round(hPt)}pt -> ${asciiSafe(outPath)}`,
    );
  }

  if (written.length === 0) {
    process.stderr.write("ERROR: no pages rendered.\n");
    return 1;
  }
  console.log(
    `[contact-sheet] wrote ${written.length} sheet(s) to ${asciiSafe(outDir)} at ${CONTACT_DPI} dpi.`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// auto subcommand.
// ---------------------------------------------------------------------------

function cmdAuto(args: { pdf: string; out: string; minArea: number; minGap: number }): number {
  const pdfPath = path.resolve(args.pdf);
  if (!fs.existsSync(pdfPath)) {
    process.stderr.write(`ERROR: PDF not found: ${asciiSafe(pdfPath)}\n`);
    return 2;
  }

  process.stderr.write(
    "[auto] NOTE: The 'auto' subcommand relies on PyMuPDF's page inspection APIs " +
      "(get_drawings, get_images, get_text) which have no direct CLI equivalent. " +
      "Use the Python extract_pdf_figures.py auto for full candidate detection, " +
      "or use contact-sheet to visually identify figures and crop them by hand.\n",
  );

  console.log(`# candidate figure regions for ${asciiSafe(path.basename(pdfPath))}`);
  console.log("(auto-detection requires PyMuPDF; use contact-sheet + manual crop instead)");
  return 0;
}

// ---------------------------------------------------------------------------
// crop subcommand.
// ---------------------------------------------------------------------------

interface ManifestData {
  schema_version: number;
  source_pdf: { path: string; sha256: string };
  figures: ManifestFigure[];
}

interface ManifestFigure {
  asset_id: string;
  file: string;
  from_paper: boolean;
  page: number;
  bbox: number[];
  dpi: number;
  sha256: string;
  natural_px: number[];
  caption_hint?: string;
}

function manifestPathFor(outDir: string): string {
  return path.join(path.resolve(outDir), "..", "FIGURE_MANIFEST.json");
}

function loadOrCreateManifest(manifestPath: string, pdfPath: string, pdfSha: string): ManifestData {
  if (fs.existsSync(manifestPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      data.schema_version = data.schema_version || SCHEMA_VERSION;
      data.figures = data.figures || [];
      const src = data.source_pdf || {};
      if (src.sha256 !== pdfSha) {
        data.source_pdf = { path: pdfPath, sha256: pdfSha };
      }
      return data;
    } catch (e) {
      process.stderr.write(`ERROR: existing manifest unreadable: ${asciiSafe(String(e))}\n`);
      process.exit(1);
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    source_pdf: { path: pdfPath, sha256: pdfSha },
    figures: [],
  };
}

function upsertFigure(manifest: ManifestData, entry: ManifestFigure): void {
  const idx = manifest.figures.findIndex((f) => f.asset_id === entry.asset_id);
  if (idx >= 0) {
    manifest.figures[idx] = entry;
  } else {
    manifest.figures.push(entry);
  }
}

function parseBbox(s: string): [number, number, number, number] {
  const parts = s.split(",");
  if (parts.length !== 4) {
    throw new Error(`--bbox must be 'x0,y0,x1,y1' (4 numbers), got '${s}'`);
  }
  const nums = parts.map((p) => parseFloat(p.trim()));
  if (nums.some(isNaN)) {
    throw new Error(`--bbox values must be numbers, got '${s}'`);
  }
  if (nums[2] <= nums[0] || nums[3] <= nums[1]) {
    throw new Error(`--bbox must have x1>x0 and y1>y0, got '${s}'`);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

async function cmdCrop(args: {
  pdf: string;
  out: string;
  dpi: number;
  page: number;
  bbox: [number, number, number, number];
  name: string;
  captionHint: string | null;
}): Promise<number> {
  const pdfPath = path.resolve(args.pdf);
  if (!fs.existsSync(pdfPath)) {
    process.stderr.write(`ERROR: PDF not found: ${asciiSafe(pdfPath)}\n`);
    return 2;
  }

  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const pages = pdfPageCount(pdfPath);
  if (args.page < 1 || args.page > pages) {
    process.stderr.write(`ERROR: --page ${args.page} out of range (PDF has ${pages} page(s)).\n`);
    return 2;
  }

  let name = args.name;
  const pngPath = name.toLowerCase().endsWith(".png")
    ? path.join(outDir, name)
    : path.join(outDir, `${name}.png`);
  if (name.toLowerCase().endsWith(".png")) {
    name = name.substring(0, name.length - 4);
  }

  const ok = renderPage(pdfPath, args.page, args.dpi, pngPath, args.bbox);
  if (!ok) {
    process.stderr.write(`ERROR: failed to render crop.\n`);
    return 2;
  }

  let naturalPx: [number, number] = [0, 0];
  try {
    const sharp = await import("sharp");
    const meta = await sharp.default(pngPath).metadata();
    naturalPx = [meta.width || 0, meta.height || 0];
  } catch {
    // If sharp is unavailable, use zero dimensions
  }

  const cropSha = sha256File(pngPath);
  const pdfSha = sha256File(pdfPath);

  const mPath = path.resolve(manifestPathFor(args.out));
  const manifest = loadOrCreateManifest(mPath, pdfPath, pdfSha);

  const relFile = path.relative(path.dirname(mPath), pngPath);
  const entry: ManifestFigure = {
    asset_id: name,
    file: relFile,
    from_paper: true,
    page: args.page,
    bbox: [
      Math.round(args.bbox[0] * 10) / 10,
      Math.round(args.bbox[1] * 10) / 10,
      Math.round(args.bbox[2] * 10) / 10,
      Math.round(args.bbox[3] * 10) / 10,
    ],
    dpi: args.dpi,
    sha256: cropSha,
    natural_px: naturalPx,
    caption_hint: args.captionHint || "",
  };
  upsertFigure(manifest, entry);
  fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  const [x0, y0, x1, y1] = args.bbox;
  console.log(
    `[crop] page ${args.page} bbox=(${x0.toFixed(0)},${y0.toFixed(0)},` +
      `${x1.toFixed(0)},${y1.toFixed(0)})pt @ ${args.dpi}dpi -> ` +
      `${asciiSafe(pngPath)} (${naturalPx[0]}x${naturalPx[1]}px)`,
  );
  console.log(`[crop] manifest upserted: ${asciiSafe(mPath)} (asset_id=${name})`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const program = createCli(
  "extract_pdf_figures",
  "Extract real paper figures from a PDF (contact-sheet / auto / crop). " +
    "bbox units = PDF points.",
);

program.argument("<pdf>", "source paper PDF");
program.requiredOption(
  "--out <dir>",
  "output directory for PNGs (manifest written to parent as FIGURE_MANIFEST.json)",
);
program.option(
  "--dpi <n>",
  "crop render dpi (default 350; contact-sheet fixed at modest dpi)",
  "350",
);

program
  .command("contact-sheet")
  .description("render every page with a labelled PDF-point grid overlay")
  .action(async () => {
    const parent = program.opts() as { out: string; dpi: string };
    const pdf = program.args[0];
    const code = await cmdContactSheet({
      pdf,
      out: parent.out,
      dpi: parseInt(parent.dpi || "350", 10),
    });
    process.exit(code);
  });

program
  .command("auto")
  .description("detect + print candidate figure regions (writes nothing)")
  .option("--min-area <n>", "ignore candidates below this area in pt^2", "10000")
  .option("--min-gap <n>", "min vertical void between text blocks (pt)", "60")
  .action((opts: Record<string, string>) => {
    const parent = program.opts() as { out: string };
    const pdf = program.args[0];
    const code = cmdAuto({
      pdf,
      out: parent.out,
      minArea: parseFloat(opts.minArea || "10000"),
      minGap: parseFloat(opts.minGap || "60"),
    });
    process.exit(code);
  });

program
  .command("crop")
  .description("render page clipped to --bbox and upsert FIGURE_MANIFEST.json")
  .requiredOption("--page <n>", "1-based page number")
  .requiredOption("--bbox <x0,y0,x1,y1>", "crop bbox in PDF points")
  .requiredOption("--name <id>", "asset_id / output PNG stem")
  .option("--caption-hint <text>", "optional caption hint for manifest")
  .action(async (opts: Record<string, string>) => {
    const parent = program.opts() as { out: string; dpi: string };
    const pdf = program.args[0];
    let bbox: [number, number, number, number];
    try {
      bbox = parseBbox(opts.bbox);
    } catch (e) {
      process.stderr.write(`ERROR: ${String(e)}\n`);
      process.exit(2);
    }
    const code = await cmdCrop({
      pdf,
      out: parent.out,
      dpi: parseInt(parent.dpi || "350", 10),
      page: parseInt(opts.page, 10),
      bbox,
      name: opts.name,
      captionHint: opts.captionHint || null,
    });
    process.exit(code);
  });

runCli(program);
