import fs from "fs";
import path from "path";
import * as _canvas from "./canvas.js";
import * as _render from "./render.js";
import { asciiSafe } from "./textutil.js";

export const DEFAULT_MAX_INTERCARD_GAP = 50.0;
export const DEFAULT_MIN_INTERCARD_GAP = 12.0;

interface CardBox {
  y: number;
  bottom: number;
}

export function intercardGaps(cards: CardBox[]): number[] {
  if (cards.length < 2) return [];
  const sorted = [...cards].sort((a, b) => a.y - b.y);
  const rows: [number, number][] = [];
  for (const c of sorted) {
    if (rows.length > 0 && c.y < rows[rows.length - 1][1]) {
      rows[rows.length - 1][1] = Math.max(rows[rows.length - 1][1], c.bottom);
    } else {
      rows.push([c.y, c.bottom]);
    }
  }
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gaps.push(rows[i][0] - rows[i - 1][1]);
  }
  return gaps;
}

const MEASURE_JS = `
() => {
  const nodes = Array.from(document.querySelectorAll('[data-measure-role]'));
  return nodes.map(n => {
    const r = n.getBoundingClientRect();
    const cs = window.getComputedStyle(n);
    return {
      role: n.getAttribute('data-measure-role') || '',
      tag:  n.tagName.toLowerCase(),
      cls:  n.className || '',
      x: r.left, y: r.top, w: r.width, h: r.height,
      bottom: r.bottom, right: r.right,
      overflow_x: cs.overflowX, overflow_y: cs.overflowY,
      scroll_h: n.scrollHeight, client_h: n.clientHeight,
      scroll_w: n.scrollWidth,  client_w: n.clientWidth,
    };
  });
}
`;

interface MeasureElement {
  role: string;
  tag: string;
  cls: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bottom: number;
  right: number;
  overflow_x: string;
  overflow_y: string;
  scroll_h: number;
  client_h: number;
  scroll_w: number;
  client_w: number;
}

export function computeAdjustmentHints(
  bottoms: [string, number][],
  stripTop: number,
  opts: { minGap: number; maxGap: number; keepTolPx?: number },
): {
  targetGap: number;
  targetBottom: number;
  adjustments: [string, number, string][];
} {
  const keepTolPx = opts.keepTolPx ?? 5.0;
  const targetGap = (opts.minGap + opts.maxGap) / 2.0;
  const targetBottom = stripTop - targetGap;
  const adjustments: [string, number, string][] = [];
  for (const [name, b] of bottoms) {
    const delta = targetBottom - b;
    let hint: string;
    if (Math.abs(delta) <= keepTolPx) {
      hint = "keep";
    } else if (delta > 0) {
      hint = `grow ~${Math.round(delta)} px`;
    } else {
      hint = `trim ~${Math.round(-delta)} px`;
    }
    adjustments.push([name, b, hint]);
  }
  return { targetGap, targetBottom, adjustments };
}

export interface MeasureArgs {
  html: string;
  canvas: [number, number] | null;
  mathjaxTimeoutMs: number;
  settleMs: number;
  jsonOut: string | null;
  maxSpread: number;
  minGap: number;
  maxGap: number;
  minCanvasFill: number;
  maxCanvasFill: number;
  positionTolPx: number;
  maxClipPx: number;
  allowEmptyColumn: boolean;
  allowNoFooterGap: boolean;
  maxIntercardGap: number;
  minIntercardGap: number;
}

export async function cmdMeasure(args: MeasureArgs): Promise<number> {
  let pw: _render.PwPlaywright;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = await (Function('return import("playwright")')() as Promise<{
      default?: _render.PwPlaywright;
    }>);
    pw = mod.default ?? (mod as unknown as _render.PwPlaywright);
  } catch {
    process.stderr.write(
      "ERROR: playwright not installed. Run:\n" +
        "  npm install playwright\n" +
        "  npx playwright install chromium\n",
    );
    return 2;
  }

  const htmlPath = path.resolve(args.html);
  if (!fs.existsSync(htmlPath)) {
    process.stderr.write(`ERROR: HTML not found: ${asciiSafe(htmlPath)}\n`);
    return 2;
  }

  const resolved = _canvas.resolveCanvas(htmlPath, args.canvas, "[measure]");
  if (resolved === null) {
    process.stderr.write(
      "ERROR: could not find `@page { size: <W> <H> }` in HTML. " +
        "Add an @page rule (units: in/mm/cm/pt) or pass " +
        "`--canvas <W>x<H>in` / `--canvas 'A0 portrait'`. " +
        "Refusing to silently fall back.\n",
    );
    return 2;
  }
  const { viewport } = resolved;

  const { browser, page } = await _render.openPrintEmulatedPageAsync(pw, viewport);
  let navTimedOut = false;
  try {
    await page.goto(_canvas.htmlFileUrl(htmlPath), {
      waitUntil: "networkidle",
      timeout: args.mathjaxTimeoutMs,
    });
  } catch {
    navTimedOut = true;
  }

  const settle = await _render.settlePage(page, {
    mathjaxTimeoutMs: args.mathjaxTimeoutMs,
    settleMs: args.settleMs,
  });
  const fail = _render.hardFailOnSettleProblems(settle, args.mathjaxTimeoutMs);
  if (fail !== null) {
    await browser.close();
    process.stderr.write(`FAIL: ${fail}\n`);
    return 1;
  }
  if (navTimedOut) {
    await browser.close();
    process.stderr.write(
      `FAIL: page did not reach network-idle within ` +
        `${args.mathjaxTimeoutMs} ms; refusing to measure a ` +
        `partially loaded poster. A blocked/slow remote resource ` +
        `(CDN image, web font, MathJax) is the usual cause -- ` +
        `inline assets, or raise --mathjax-timeout-ms.\n`,
    );
    return 1;
  }

  const data = (await page.evaluate(MEASURE_JS)) as MeasureElement[];
  await browser.close();

  if (args.jsonOut) {
    fs.writeFileSync(args.jsonOut, JSON.stringify(data, null, 2), "utf-8");
    console.log(`[measure] raw data -> ${asciiSafe(args.jsonOut)}`);
  }

  // Canvas-fill gate
  const posterBox = data.find((el) => el.role === "poster");
  if (!posterBox) {
    process.stderr.write(
      'FAIL: no [data-measure-role="poster"] element found on ' +
        "the page. Add it to the root poster container -- measure " +
        "needs it to verify the canvas-fill, and preflight already " +
        "rejects pages without it.\n",
    );
    return 1;
  }
  const [vw, vh] = viewport;
  const fillW = posterBox.w / vw;
  const fillH = posterBox.h / vh;
  const lo = args.minCanvasFill;
  const hi = args.maxCanvasFill;
  if (!(lo <= fillW && fillW <= hi) || !(lo <= fillH && fillH <= hi)) {
    process.stderr.write(
      `FAIL: [data-measure-role="poster"] fills ` +
        `${Math.round(fillW * 100)}% x ${Math.round(fillH * 100)}% of the print ` +
        `viewport (target ${Math.round(lo * 100)}% - ${Math.round(hi * 100)}% in ` +
        `BOTH dimensions). Common cause when too small: missing ` +
        "`@media print { :root { --u: 1mm } }` so the poster " +
        "keeps the screen-mode unit scale in print. Common cause " +
        "when too large: hardcoded `width` exceeds `@page size`.\n",
    );
    return 1;
  }

  // Position check
  const tol = args.positionTolPx;
  const posProblems: string[] = [];
  if (Math.abs(posterBox.x) > tol) posProblems.push(`x=${posterBox.x.toFixed(1)} (expected ~= 0)`);
  if (Math.abs(posterBox.y) > tol) posProblems.push(`y=${posterBox.y.toFixed(1)} (expected ~= 0)`);
  if (Math.abs(posterBox.right - vw) > tol)
    posProblems.push(`right=${posterBox.right.toFixed(1)} (expected ~= ${vw})`);
  if (Math.abs(posterBox.bottom - vh) > tol)
    posProblems.push(`bottom=${posterBox.bottom.toFixed(1)} (expected ~= ${vh})`);
  if (posProblems.length > 0) {
    process.stderr.write(
      `FAIL: [data-measure-role="poster"] is not aligned to ` +
        `the page (tolerance +/-${tol.toFixed(1)} px):\n` +
        "  " +
        posProblems.join(", ") +
        ".\n" +
        "Fix: make `.poster` full-bleed in print --\n" +
        "  @media print {\n" +
        "    .poster   { width: 100%; height: 100%;\n" +
        "                margin: 0; padding: 0 }\n" +
        "    html,body { margin: 0; padding: 0 }\n" +
        "  }\n" +
        "Then drop any `transform: translate*` / " +
        "`position: absolute` offsets.\n" +
        "Also check: put `@media print` AFTER the screen " +
        "`.poster` rule.\n",
    );
    return 1;
  }

  // Content-clipping gate
  const clipOverflows = new Set(["hidden", "clip", "scroll", "auto"]);
  const clipProblems: string[] = [];
  for (const el of data) {
    if (el.role !== "card" && el.role !== "column" && el.role !== "hero") continue;
    const oy = (el.overflow_y || "").toLowerCase();
    const ox = (el.overflow_x || "").toLowerCase();
    const dy = (el.scroll_h || 0) - (el.client_h || 0);
    const dx = (el.scroll_w || 0) - (el.client_w || 0);
    const axes: string[] = [];
    if (clipOverflows.has(oy) && dy > args.maxClipPx) {
      axes.push(`${dy.toFixed(0)}px below the box (overflow-y: ${oy})`);
    }
    if (clipOverflows.has(ox) && dx > args.maxClipPx) {
      axes.push(`${dx.toFixed(0)}px past the right (overflow-x: ${ox})`);
    }
    if (axes.length > 0) {
      const cls = el.cls || "";
      const ident = `${el.role} <${el.tag}` + (cls ? ` class="${cls}"` : "") + ">";
      clipProblems.push(`${ident}: ${axes.join(", ")}`);
    }
  }
  if (clipProblems.length > 0) {
    process.stderr.write(
      "FAIL: content overflows its box and is CLIPPED by " +
        "overflow:hidden/clip/scroll/auto -- print drops it silently " +
        "while the box still looks aligned:\n" +
        clipProblems.map((p) => "  " + p).join("\n") +
        `\n(tolerance ${args.maxClipPx.toFixed(0)} px). Fix: remove the ` +
        "`overflow` rule so the content overflows VISIBLY -- measure " +
        "then reports a negative gap pointing at the real 'too much " +
        "content' problem -- then cut content, shrink fonts, or enlarge " +
        "the canvas. Do NOT use overflow:hidden to make a too-full " +
        "column 'pass': a flex item with overflow other than visible " +
        "has min-height auto -> 0, so flexbox shrinks it and clips the " +
        "overflow.\n",
    );
    return 1;
  }

  // Build columns/heros/footer-strips/footers
  const columns: Map<
    number,
    {
      box: MeasureElement;
      lastCardBottom: number | null;
      cards: MeasureElement[];
    }
  > = new Map();
  const heros: MeasureElement[] = [];
  const footerStrips: MeasureElement[] = [];
  const footers: MeasureElement[] = [];

  let colIndex = 0;
  for (const el of data) {
    if (el.role === "column") {
      columns.set(colIndex, { box: el, lastCardBottom: null, cards: [] });
      colIndex++;
    } else if (el.role === "hero") {
      heros.push(el);
    } else if (el.role === "footer-strip") {
      footerStrips.push(el);
    } else if (el.role === "footer") {
      footers.push(el);
    }
  }

  function xOverlaps(card: MeasureElement, box: MeasureElement): boolean {
    const cxMid = card.x + card.w / 2;
    return box.x <= cxMid && cxMid <= box.x + box.w;
  }

  for (const el of data) {
    if (el.role !== "card") continue;
    for (const [, col] of columns) {
      if (xOverlaps(el, col.box)) {
        col.cards.push(el);
        if (col.lastCardBottom === null || el.bottom > col.lastCardBottom) {
          col.lastCardBottom = el.bottom;
        }
        break;
      }
    }
  }

  const emptyCols: number[] = [];
  for (const [ci, col] of columns) {
    if (col.lastCardBottom === null) emptyCols.push(ci);
  }
  if (emptyCols.length > 0 && !args.allowEmptyColumn) {
    process.stderr.write(
      `ERROR: columns with no cards detected: ` +
        `${JSON.stringify(emptyCols.map((i) => "col" + i))}. ` +
        `Add cards or pass --allow-empty-column.\n`,
    );
    return 1;
  }

  // Intra-column whitespace gate
  const maxIcg = args.maxIntercardGap;
  const minIcg = args.minIntercardGap;
  const icgProblems: string[] = [];
  const icgTight: string[] = [];
  let icgWorst: [string, number] | null = null;
  let icgTightest: [string, number] | null = null;
  for (const [ci, col] of columns) {
    const gapsC = intercardGaps(col.cards);
    if (gapsC.length === 0) continue;
    const g = Math.max(...gapsC);
    const gLo = Math.min(...gapsC);
    if (icgWorst === null || g > icgWorst[1]) icgWorst = [`col${ci}`, g];
    if (icgTightest === null || gLo < icgTightest[1]) icgTightest = [`col${ci}`, gLo];
    if (g > maxIcg) icgProblems.push(`col${ci}: ${g.toFixed(1)} px between stacked cards`);
    if (gLo < minIcg) icgTight.push(`col${ci}: ${gLo.toFixed(1)} px between stacked cards`);
  }

  const bottoms: [string, number][] = [];
  for (const [ci, col] of columns) {
    const b = col.lastCardBottom ?? col.box.bottom;
    bottoms.push([`col${ci}`, b]);
  }
  for (let hi2 = 0; hi2 < heros.length; hi2++) {
    bottoms.push([heros.length > 1 ? `hero${hi2}` : "hero", heros[hi2].bottom]);
  }

  if (bottoms.length === 0) {
    process.stderr.write(
      "ERROR: no columns or hero found. " + 'Did you add data-measure-role="column"?\n',
    );
    return 2;
  }

  const bs = bottoms.map(([, b]) => b);
  const spread = Math.max(...bs) - Math.min(...bs);
  const maxBottom = Math.max(...bs);

  function pickNearest(strips: MeasureElement[], target: number): MeasureElement | null {
    if (strips.length === 0) return null;
    return strips.reduce((best, s) =>
      Math.abs(s.y - target) < Math.abs(best.y - target) ? s : best,
    );
  }

  let nextStrip: MeasureElement | null = null;
  let nextName: string | null = null;
  if (footerStrips.length > 0) {
    nextStrip = pickNearest(footerStrips, maxBottom);
    nextName = "footer-strip";
  } else if (footers.length > 0) {
    nextStrip = pickNearest(footers, maxBottom);
    nextName = "footer";
  }

  let gapRange: [number, number] | null = null;
  const gaps: [string, number][] = [];
  if (nextStrip !== null) {
    for (const [name, b] of bottoms) {
      gaps.push([name, nextStrip.y - b]);
    }
    const gapVals = gaps.map(([, g]) => g);
    gapRange = [Math.min(...gapVals), Math.max(...gapVals)];
  }

  console.log();
  console.log(
    `[measure] columns found: ${columns.size}` +
      (heros.length > 0 ? ` (+ ${heros.length} hero)` : ""),
  );
  for (const [name, b] of bottoms) {
    console.log(`  ${name.padEnd(6)}  last-card-bottom = ${b.toFixed(2).padStart(8)} px`);
  }
  console.log(`  spread = ${spread.toFixed(2)} px   (target < ${args.maxSpread} px)`);
  if (icgWorst !== null && icgTightest !== null) {
    console.log(
      `  intercard gap in [${icgTightest[1].toFixed(2)} (${icgTightest[0]}),` +
        ` ${icgWorst[1].toFixed(2)} (${icgWorst[0]})] px` +
        `   (target [${minIcg}, ${maxIcg}])`,
    );
  }
  if (nextStrip !== null && gapRange !== null) {
    console.log(
      `  gap -> ${nextName} in [${gapRange[0].toFixed(2)}, ${gapRange[1].toFixed(2)}] px` +
        `   (target [${args.minGap}, ${args.maxGap}])`,
    );
  } else {
    console.log("  gap -> (no footer-strip or footer below content)");
  }

  let ok = true;
  if (spread >= args.maxSpread) {
    process.stderr.write(`FAIL: spread ${spread.toFixed(2)} >= max ${args.maxSpread}\n`);
    ok = false;
  }
  if (icgProblems.length > 0) {
    process.stderr.write(
      `FAIL: intra-column whitespace void (max intercard gap ` +
        `${maxIcg.toFixed(0)} px):\n` +
        icgProblems.map((p) => "  " + p).join("\n") +
        "\nColumns must be filled by CONTENT, not stretched " +
        "whitespace. Do NOT use `justify-content: space-between` / " +
        "`space-around` (or oversized margins) to fake bottom " +
        "alignment -- it pins the last card to the bottom so spread " +
        "reads ~0 while a void sits mid-column. Fix: grow figures or " +
        "text, rebalance cards across columns, or use a fixed " +
        "row-gap, then re-measure.\n",
    );
    ok = false;
  }
  if (icgTight.length > 0) {
    process.stderr.write(
      `FAIL: stacked cards too tight (min intercard gap ` +
        `${minIcg.toFixed(0)} px):\n` +
        icgTight.map((p) => "  " + p).join("\n") +
        "\nA gap this small buries the card's drop shadow under " +
        "the next card, fusing the stack into one slab. Fix: restore " +
        "the column's design row-gap (shipped templates use 6u " +
        "~= 22.7 px) and absorb the height elsewhere (trim content " +
        "or shrink a figure); for a deliberately shadowless theme, " +
        "lower --min-intercard-gap.\n",
    );
    ok = false;
  }
  if (nextStrip !== null && gapRange !== null) {
    if (gapRange[0] < args.minGap) {
      process.stderr.write(`FAIL: min gap ${gapRange[0].toFixed(2)} < ${args.minGap}\n`);
      ok = false;
    }
    if (gapRange[1] > args.maxGap) {
      process.stderr.write(`FAIL: max gap ${gapRange[1].toFixed(2)} > ${args.maxGap}\n`);
      ok = false;
    }
  } else if (!args.allowNoFooterGap) {
    process.stderr.write(
      "FAIL: no footer-strip or footer found below content. " +
        "Pass --allow-no-footer-gap to skip this gate.\n",
    );
    ok = false;
  }

  if (ok) {
    console.log("[measure] PASS");
    return 0;
  }

  if (nextStrip !== null && bottoms.length > 0) {
    const { targetGap, targetBottom, adjustments } = computeAdjustmentHints(bottoms, nextStrip.y, {
      minGap: args.minGap,
      maxGap: args.maxGap,
      keepTolPx: args.maxSpread,
    });

    console.log();
    console.log("[measure] suggested adjustments:");
    console.log(
      `  target col bottom = ${targetBottom.toFixed(0)} px` +
        `  (footer-strip/footer top ${nextStrip.y.toFixed(0)} px` +
        `  - target gap ${targetGap.toFixed(0)} px)`,
    );
    for (const [name, b, hint] of adjustments) {
      console.log(`  ${name.padEnd(6)}  ${b.toFixed(2).padStart(8)} px -> ${hint}`);
    }
    console.log(
      "  Tip: a body paragraph adds/removes ~25 px per wrapped line," + " a callout ~60-90 px,",
    );
    console.log("       a small figure ~80-150 px. Prefer trimming the tallest" + " column first.");
  }

  process.stderr.write("[measure] FAIL -- alignment gate not met\n");
  return 1;
}
