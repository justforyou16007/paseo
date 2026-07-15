import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import * as _canvas from "./canvas.js";
import { asciiSafe } from "./textutil.js";

export interface VerifyFinalArgs {
  pdf: string;
  canvas: [number, number] | null;
  fromHtml: string | null;
  dimTolIn: number;
  maxSizeMb: number;
  allowRotated: boolean;
}

export function cmdVerifyFinal(args: VerifyFinalArgs): number {
  const pdfPath = path.resolve(args.pdf);
  if (!fs.existsSync(pdfPath)) {
    process.stderr.write(`ERROR: PDF not found: ${asciiSafe(pdfPath)}\n`);
    return 2;
  }

  let expW: number;
  let expH: number;
  let src: string;

  if (args.canvas === null && args.fromHtml === null) {
    process.stderr.write(
      "ERROR: verify-final needs either `--canvas <W>x<H><unit>` " +
        "(e.g. '60x36in' or 'A0 portrait') or `--from-html " +
        "<poster.html>` so the expected size can't be wrong by " +
        "default.\n",
    );
    return 2;
  }
  if (args.canvas !== null && args.fromHtml !== null) {
    process.stderr.write(
      "ERROR: --canvas and --from-html are mutually exclusive; " + "pick one.\n",
    );
    return 2;
  }
  if (args.canvas !== null) {
    [expW, expH] = args.canvas;
    src = "--canvas";
  } else {
    const htmlPath = path.resolve(args.fromHtml!);
    if (!fs.existsSync(htmlPath)) {
      process.stderr.write(`ERROR: --from-html path not found: ${asciiSafe(htmlPath)}\n`);
      return 2;
    }
    const parsed = _canvas.readCanvasFromHtml(htmlPath);
    if (parsed === null) {
      process.stderr.write(
        `ERROR: no \`@page { size }\` found in ` +
          `${asciiSafe(htmlPath)}. Fall back to --canvas.\n`,
      );
      return 2;
    }
    [expW, expH] = parsed;
    src = `--from-html (${asciiSafe(path.basename(htmlPath))})`;
  }

  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  let out: string;
  try {
    out = execFileSync("pdfinfo", [pdfPath], {
      encoding: "utf-8",
      env,
    });
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        "ERROR: pdfinfo not installed. Install poppler:\n" +
          "  Linux:   apt install poppler-utils  " +
          "(or `dnf install poppler-utils`)\n" +
          "  macOS:   brew install poppler\n" +
          "  Windows: choco install poppler  (or download from " +
          "poppler-windows)\n",
      );
      return 2;
    }
    const stderr =
      e instanceof Error && "stderr" in e ? String((e as { stderr: unknown }).stderr) : String(e);
    process.stderr.write(`ERROR: pdfinfo failed: ${asciiSafe(stderr)}\n`);
    return 2;
  }

  const info: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const idx = line.indexOf(":");
    if (idx >= 0) {
      info[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    }
  }

  const pages = parseInt(info["Pages"] ?? "0", 10);
  const pageSize = info["Page size"] ?? "";
  const pageRot = parseInt(info["Page rot"] ?? "0", 10) || 0;
  const fileSizeB = fs.statSync(pdfPath).size;
  const fileSizeMb = fileSizeB / (1024 * 1024);

  console.log(`[verify-final] ${asciiSafe(pdfPath)}`);
  console.log(
    `  expected canvas = ${expW.toFixed(2)}in x ${expH.toFixed(2)}in  ` + `(from ${src})`,
  );
  console.log(`  pages           = ${pages}`);
  console.log(`  page size       = ${asciiSafe(pageSize)}`);
  console.log(`  page rot        = ${pageRot}`);
  console.log(`  file size       = ${fileSizeMb.toFixed(2)} MB`);

  const problems: string[] = [];

  if (pages !== 1) {
    problems.push(`page count = ${pages}, expected 1`);
  }

  const m = pageSize.match(/([\d.]+)\s*x\s*([\d.]+)\s*pts/);
  if (!m) {
    problems.push(`could not parse pdfinfo \`Page size\`: '${asciiSafe(pageSize)}'`);
  } else {
    const wIn = parseFloat(m[1]) / 72.0;
    const hIn = parseFloat(m[2]) / 72.0;
    console.log(`  -> ${wIn.toFixed(2)}in x ${hIn.toFixed(2)}in`);
    const tolVal = args.dimTolIn;
    const directOk = Math.abs(wIn - expW) <= tolVal && Math.abs(hIn - expH) <= tolVal;
    const swapOk = Math.abs(wIn - expH) <= tolVal && Math.abs(hIn - expW) <= tolVal;
    const allowSwap = args.allowRotated || pageRot === 90 || pageRot === 270;
    if (directOk) {
      // pass
    } else if (swapOk && allowSwap) {
      console.log(
        `  (swapped dimensions accepted -- page rot = ${pageRot}deg` +
          (args.allowRotated ? " + --allow-rotated" : "") +
          ")",
      );
    } else {
      problems.push(
        `dimensions ${wIn.toFixed(2)}x${hIn.toFixed(2)}in ` +
          `do not match canvas ${expW}x${expH}in ` +
          `(tol +/-${tolVal}in, page rot ${pageRot}deg)`,
      );
    }
  }

  if (fileSizeMb > args.maxSizeMb) {
    problems.push(`file ${fileSizeMb.toFixed(2)} MB > limit ${args.maxSizeMb} MB`);
  }

  for (const p of problems) {
    process.stderr.write(`  FAIL: ${p}\n`);
  }
  if (problems.length > 0) {
    return 1;
  }
  console.log("[verify-final] PASS");
  return 0;
}
