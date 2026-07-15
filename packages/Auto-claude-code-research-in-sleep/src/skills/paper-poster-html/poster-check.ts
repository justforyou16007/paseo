#!/usr/bin/env node
/**
 * poster_check — unified CLI for HTML academic posters.
 *
 * Four subcommands:
 *   measure, preflight, polish, verify-final
 *
 * All logic lives in the posterly package. This script is a thin
 * commander dispatcher.
 */
import { createCli, runCli } from "../../lib/cli.js";
import {
  parseCanvasArg,
  cmdMeasure,
  cmdPreflight,
  cmdPolish,
  cmdVerifyFinal,
  DEFAULT_MAX_INTERCARD_GAP,
  DEFAULT_MIN_INTERCARD_GAP,
} from "./posterly/index.js";

const program = createCli(
  "poster_check",
  "Measure / preflight / polish / verify a poster HTML+PDF pair.",
);

// --- measure ---
program
  .command("measure")
  .description("alignment + gap gate (print-emulated, HARD gate)")
  .argument("<html>", "path to poster.html")
  .option("--max-spread <n>", "hard gate: max column-bottom spread in px", "5.0")
  .option("--min-gap <n>", "min gap to footer-strip/footer", "30.0")
  .option("--max-gap <n>", "max gap to footer-strip/footer", "50.0")
  .option("--canvas <spec>", "override canvas (e.g. '60x36in' or 'A0 portrait')")
  .option("--allow-empty-column", "don't fail when a column has no cards")
  .option("--allow-no-footer-gap", "don't fail when neither footer-strip nor footer exists")
  .option("--settle-ms <n>", "extra wait after MathJax + fonts.ready settle", "500")
  .option("--mathjax-timeout-ms <n>", "hard timeout for MathJax typeset", "15000")
  .option("--min-canvas-fill <n>", "poster must fill at least this fraction of viewport", "0.95")
  .option("--max-canvas-fill <n>", "poster must NOT exceed this fraction", "1.01")
  .option("--position-tol-px <n>", "poster edges must align within this many px", "2.0")
  .option("--max-clip-px <n>", "clipped content tolerance in px", "2.0")
  .option(
    "--max-intercard-gap <n>",
    "max whitespace between consecutive stacked cards",
    String(DEFAULT_MAX_INTERCARD_GAP),
  )
  .option(
    "--min-intercard-gap <n>",
    "min whitespace between consecutive stacked cards",
    String(DEFAULT_MIN_INTERCARD_GAP),
  )
  .option("--json-out <path>", "dump raw measurement to JSON")
  .action((html: string, opts: Record<string, string | boolean | undefined>) => {
    const canvas = opts.canvas ? parseCanvasArg(opts.canvas as string) : null;
    const args = {
      html,
      maxSpread: parseFloat((opts.maxSpread as string) || "5.0"),
      minGap: parseFloat((opts.minGap as string) || "30.0"),
      maxGap: parseFloat((opts.maxGap as string) || "50.0"),
      canvas,
      allowEmptyColumn: !!opts.allowEmptyColumn,
      allowNoFooterGap: !!opts.allowNoFooterGap,
      settleMs: parseInt((opts.settleMs as string) || "500", 10),
      mathjaxTimeoutMs: parseInt((opts.mathjaxTimeoutMs as string) || "15000", 10),
      minCanvasFill: parseFloat((opts.minCanvasFill as string) || "0.95"),
      maxCanvasFill: parseFloat((opts.maxCanvasFill as string) || "1.01"),
      positionTolPx: parseFloat((opts.positionTolPx as string) || "2.0"),
      maxClipPx: parseFloat((opts.maxClipPx as string) || "2.0"),
      maxIntercardGap: parseFloat(
        (opts.maxIntercardGap as string) || String(DEFAULT_MAX_INTERCARD_GAP),
      ),
      minIntercardGap: parseFloat(
        (opts.minIntercardGap as string) || String(DEFAULT_MIN_INTERCARD_GAP),
      ),
      jsonOut: (opts.jsonOut as string) || null,
    };
    cmdMeasure(args).then((code) => process.exit(code));
  });

// --- preflight ---
program
  .command("preflight")
  .description("static HTML lint (LaTeX residue, math, images, roles)")
  .argument("<html>", "path to poster.html")
  .action((html: string) => {
    process.exit(cmdPreflight({ html }));
  });

// --- polish ---
program
  .command("polish")
  .description("visual-polish warnings (figure size, orphans, space-between, flex/<br>)")
  .argument("<html>", "path to poster.html")
  .option("--canvas <spec>", "override canvas (default: parse @page from HTML)")
  .option("--settle-ms <n>", "extra wait after layout settles", "500")
  .option("--mathjax-timeout-ms <n>", "hard timeout for MathJax typeset", "15000")
  .option("--wide-min-ratio <n>", "wide figures (AR>1.3) must occupy >= this fraction", "0.65")
  .option(
    "--tall-max-ratio <n>",
    "tall figures (AR<0.8) above this fraction trigger recommend",
    "0.70",
  )
  .option("--square-min-ratio <n>", "square figures must occupy >= this fraction", "0.55")
  .option("--max-space-between-fill <n>", "warn if inter-card gap exceeds this fraction", "0.05")
  .option("--max-card-trailing <n>", "warn if card leaves more than this blank fraction", "0.10")
  .option("--strict", "exit non-zero when any warning is emitted")
  .action((html: string, opts: Record<string, string | boolean | undefined>) => {
    const canvas = opts.canvas ? parseCanvasArg(opts.canvas as string) : null;
    const args = {
      html,
      canvas,
      settleMs: parseInt((opts.settleMs as string) || "500", 10),
      mathjaxTimeoutMs: parseInt((opts.mathjaxTimeoutMs as string) || "15000", 10),
      wideMinRatio: parseFloat((opts.wideMinRatio as string) || "0.65"),
      tallMaxRatio: parseFloat((opts.tallMaxRatio as string) || "0.70"),
      squareMinRatio: parseFloat((opts.squareMinRatio as string) || "0.55"),
      maxSpaceBetweenFill: parseFloat((opts.maxSpaceBetweenFill as string) || "0.05"),
      maxCardTrailing: parseFloat((opts.maxCardTrailing as string) || "0.10"),
      strict: !!opts.strict,
    };
    cmdPolish(args).then((code) => process.exit(code));
  });

// --- verify-final ---
program
  .command("verify-final")
  .description("run pdfinfo + size/dimension/page checks on PDF")
  .argument("<pdf>", "path to poster.pdf")
  .option("--canvas <spec>", "expected canvas (e.g. '60x36in' or 'A0 portrait')")
  .option("--from-html <path>", "read expected canvas from @page in this HTML")
  .option("--dim-tol-in <n>", "dimension tolerance in inches", "0.05")
  .option("--max-size-mb <n>", "max file size in MB", "20.0")
  .option("--allow-rotated", "accept swapped W/H even without page rotation")
  .action((pdf: string, opts: Record<string, string | boolean | undefined>) => {
    const canvas = opts.canvas ? parseCanvasArg(opts.canvas as string) : null;
    const args = {
      pdf,
      canvas,
      fromHtml: (opts.fromHtml as string) || null,
      dimTolIn: parseFloat((opts.dimTolIn as string) || "0.05"),
      maxSizeMb: parseFloat((opts.maxSizeMb as string) || "20.0"),
      allowRotated: !!opts.allowRotated,
    };
    process.exit(cmdVerifyFinal(args));
  });

runCli(program);
