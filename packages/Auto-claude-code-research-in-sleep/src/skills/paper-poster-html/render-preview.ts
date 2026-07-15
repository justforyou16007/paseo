#!/usr/bin/env node
/**
 * render_preview — render a poster HTML to print-ready PDF + thumbnail.
 *
 * Canvas-agnostic: reads @page { size: <W> <H> } from the HTML or accepts
 * --canvas override. Print-emulates Chromium so MathJax typesets against
 * the @media print layout.
 */
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../../lib/cli.js";
import { parseCanvasArg, resolveCanvas } from "./posterly/canvas.js";
import {
  openPrintEmulatedPageAsync as openPrintEmulatedPage,
  settlePage,
} from "./posterly/render.js";
import { asciiSafe } from "./posterly/textutil.js";

const program = createCli(
  "render_preview",
  "Render a poster HTML to print-ready PDF + scaled PNG thumbnail.",
);

program
  .argument("<html>", "poster HTML file")
  .option("--pdf <path>", "output PDF path (default: <stem>_preview.pdf)")
  .option("--png <path>", "output PNG thumbnail path (default: <stem>_preview.png)")
  .option("--thumb-scale <n>", "thumbnail scale factor", "0.35")
  .option(
    "--mathjax-timeout-ms <n>",
    "timeout for MathJax typesetting; render is the SOFT path",
    "15000",
  )
  .option("--canvas <spec>", "override canvas (e.g. '60x36in' / 'A0 portrait')")
  .action(async (html: string, opts: Record<string, string | boolean | undefined>) => {
    const htmlPath = path.resolve(html);
    if (!fs.existsSync(htmlPath)) {
      process.stderr.write(`ERROR: HTML not found: ${asciiSafe(htmlPath)}\n`);
      process.exit(2);
    }

    const stem = path.basename(htmlPath, path.extname(htmlPath));
    const pdfPath = opts.pdf
      ? path.resolve(opts.pdf as string)
      : path.join(path.dirname(htmlPath), `${stem}_preview.pdf`);
    const pngPath = opts.png
      ? path.resolve(opts.png as string)
      : path.join(path.dirname(htmlPath), `${stem}_preview.png`);

    const canvasArg = opts.canvas ? parseCanvasArg(opts.canvas as string) : null;
    const mathjaxTimeoutMs = parseInt((opts.mathjaxTimeoutMs as string) || "15000", 10);
    const thumbScale = parseFloat((opts.thumbScale as string) || "0.35");

    const resolved = resolveCanvas(htmlPath, canvasArg, "[render_preview]");
    if (resolved === null) {
      process.stderr.write(
        "ERROR: could not find `@page { size: <W> <H> }` in HTML. " +
          "Add an @page rule or pass `--canvas <W>x<H>in`.\n",
      );
      process.exit(2);
    }
    const { canvas, viewport } = resolved;
    const [wIn, hIn] = canvas;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pw: any;
    try {
      pw = await import("playwright" as string);
    } catch {
      process.stderr.write(
        "ERROR: playwright not installed. Run:\n" +
          "  npm install playwright\n" +
          "  npx playwright install chromium\n",
      );
      process.exit(2);
    }

    const { browser, page } = await openPrintEmulatedPage(pw, viewport);

    try {
      await page.goto(`file://${htmlPath}`, { timeout: mathjaxTimeoutMs });
    } catch {
      process.stderr.write(
        `[render_preview] WARN: page.goto did not reach load within ${mathjaxTimeoutMs} ms; ` +
          `continuing with whatever loaded.\n`,
      );
    }

    try {
      await page.waitForLoadState("networkidle", { timeout: mathjaxTimeoutMs });
    } catch {
      process.stderr.write(
        `[render_preview] WARN: network never went idle within ${mathjaxTimeoutMs} ms.\n`,
      );
    }

    const settle = await settlePage(page, {
      mathjaxTimeoutMs,
      settleMs: 1500,
    });

    if (settle.mathjaxStatus === "timeout") {
      process.stderr.write(
        `[render_preview] WARN: MathJax typeset timed out after ${mathjaxTimeoutMs} ms.\n`,
      );
    } else if (settle.mathjaxStatus === "error") {
      process.stderr.write(
        `[render_preview] WARN: MathJax error: ${asciiSafe(settle.mathjaxError || "")}\n`,
      );
    }
    if (settle.mathjaxIntended && settle.texWithoutMathjax) {
      process.stderr.write(
        "[render_preview] WARN: page intended to load MathJax but no " +
          "<mjx-container> rendered. PDF will show raw $...$ text.\n",
      );
    }

    await page.pdf({
      path: pdfPath,
      width: `${wIn}in`,
      height: `${hIn}in`,
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });

    const s = thumbScale;
    await page.evaluate(
      `(scale) => {
        const el =
          document.querySelector('[data-measure-role="poster"]') ||
          document.querySelector(".poster") ||
          document.body;
        el.style.transformOrigin = "top left";
        el.style.transform = "scale(" + scale + ")";
        document.body.style.width = (el.offsetWidth * scale) + "px";
        document.body.style.height = (el.offsetHeight * scale) + "px";
        document.body.style.overflow = "hidden";
        document.body.style.margin = "0";
      }`,
      s,
    );

    const thumbW = Math.round(wIn * 96 * s);
    const thumbH = Math.round(hIn * 96 * s);
    await page.setViewportSize({ width: thumbW, height: thumbH });
    await page.screenshot({
      path: pngPath,
      fullPage: false,
      clip: { x: 0, y: 0, width: thumbW, height: thumbH },
    });

    await browser.close();

    const pdfStat = fs.statSync(pdfPath);
    const pngStat = fs.statSync(pngPath);
    console.log(
      `[render_preview] PDF -> ${asciiSafe(pdfPath)}  (${(pdfStat.size / 1024).toFixed(1)} KB)`,
    );
    console.log(
      `[render_preview] PNG -> ${asciiSafe(pngPath)}  (${(pngStat.size / 1024).toFixed(1)} KB)`,
    );
    process.exit(0);
  });

runCli(program);
