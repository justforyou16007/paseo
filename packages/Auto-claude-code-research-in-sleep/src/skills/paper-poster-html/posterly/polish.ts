import fs from "fs";
import path from "path";
import * as _canvas from "./canvas.js";
import * as _preflight from "./preflight.js";
import * as _render from "./render.js";
import { asciiSafe } from "./textutil.js";

const ORPHAN_GLYPHS = "↑↓↔×÷±§¶†‡*°%";

const POLISH_JS = `
() => {
  const figures = [];
  document.querySelectorAll('[data-measure-role="card"]')
    .forEach((card, ci) => {
      const cw = card.getBoundingClientRect().width;
      card.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        if (r.width < 50) return;
        figures.push({
          card_index: ci,
          role: 'card',
          src: img.getAttribute('src') || '',
          alt: img.getAttribute('alt') || '',
          fig_layout: img.getAttribute('data-fig-layout') || '',
          rendered_w: r.width,
          rendered_h: r.height,
          card_w: cw,
          natural_w: img.naturalWidth || 0,
          natural_h: img.naturalHeight || 0,
        });
      });
    });
  document.querySelectorAll('[data-measure-role="hero"]')
    .forEach(hero => {
      const hw = hero.getBoundingClientRect().width;
      hero.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        if (r.width < 50) return;
        figures.push({
          card_index: -1,
          role: 'hero',
          src: img.getAttribute('src') || '',
          alt: img.getAttribute('alt') || '',
          fig_layout: img.getAttribute('data-fig-layout') || '',
          rendered_w: r.width,
          rendered_h: r.height,
          card_w: hw,
          natural_w: img.naturalWidth || 0,
          natural_h: img.naturalHeight || 0,
        });
      });
    });

  const sel = '[class*="stat"], [class*="num"], .num, .takeaway-num,'
            + ' .headline-num';
  const seen = new Set();
  const orphans = [];
  document.querySelectorAll(sel).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    const txt = (el.innerText || '').replace(/\\s+$/, '');
    if (!txt || txt.length > 80) return;
    const cs = window.getComputedStyle(el);
    orphans.push({
      tag: el.tagName.toLowerCase(),
      cls: el.className || '',
      text: txt,
      ws: cs.whiteSpace || '',
    });
  });

  const cols = [];
  document.querySelectorAll('[data-measure-role="column"]')
    .forEach((col, ci) => {
      const cs = window.getComputedStyle(col);
      if (cs.justifyContent !== 'space-between') return;
      const colR = col.getBoundingClientRect();
      const children = Array.from(col.children).map(c => {
        const r = c.getBoundingClientRect();
        return {top: r.top, bottom: r.bottom, h: r.height};
      }).filter(c => c.h > 0);
      if (children.length < 2) return;
      const gapPx = parseFloat(cs.rowGap || cs.gap || '0') || 0;
      let maxExcess = 0;
      let pairIdx = -1;
      for (let i = 1; i < children.length; i++) {
        const actual = children[i].top - children[i - 1].bottom;
        const excess = actual - gapPx;
        if (excess > maxExcess) {
          maxExcess = excess;
          pairIdx = i;
        }
      }
      cols.push({
        column_index: ci,
        column_h: colR.height,
        stated_gap_px: gapPx,
        max_excess_px: maxExcess,
        pair_idx: pairIdx,
      });
    });

  const cards = [];
  document.querySelectorAll('[data-measure-role="card"]')
    .forEach((card, ci) => {
      const cs = window.getComputedStyle(card);
      const jc = cs.justifyContent || '';
      if (jc.indexOf('space') !== -1 || jc === 'center'
          || jc === 'end' || jc === 'flex-end') return;
      const cr = card.getBoundingClientRect();
      if (cr.height <= 0) return;
      const padB = parseFloat(cs.paddingBottom) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      const borderB = parseFloat(cs.borderBottomWidth) || 0;

      const inAbs = (node) => {
        let el = node.nodeType === 1 ? node : node.parentElement;
        while (el && el !== card) {
          const pos = window.getComputedStyle(el).position;
          if (pos === 'absolute' || pos === 'fixed') return true;
          el = el.parentElement;
        }
        return false;
      };

      let maxB = cr.top + padT;
      const bump = (r) => {
        if (r && r.height > 0 && r.bottom > maxB) maxB = r.bottom;
      };
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
        if (!tn.nodeValue || !tn.nodeValue.trim()) continue;
        if (inAbs(tn)) continue;
        const rng = document.createRange();
        rng.selectNodeContents(tn);
        const rects = rng.getClientRects();
        for (let i = 0; i < rects.length; i++) bump(rects[i]);
      }
      const REPLACED = /^(IMG|SVG|CANVAS|VIDEO|IFRAME|HR|OBJECT|EMBED)$/;
      card.querySelectorAll('*').forEach(el => {
        if (inAbs(el)) return;
        if (!REPLACED.test(el.tagName.toUpperCase()) && el.children.length) {
          return;
        }
        bump(el.getBoundingClientRect());
      });

      cards.push({
        card_index: ci,
        card_h: cr.height,
        trailing_px: (cr.bottom - padB - borderB) - maxB,
      });
    });

  const flexbr = [];
  const seenFlexBr = new Set();
  document.querySelectorAll('br').forEach(br => {
    const parent = br.parentElement;
    if (!parent || seenFlexBr.has(parent)) return;
    const cs = window.getComputedStyle(parent);
    if (cs.display === 'flex' || cs.display === 'inline-flex') {
      seenFlexBr.add(parent);
      flexbr.push({
        tag: parent.tagName.toLowerCase(),
        cls: parent.className || '',
        dir: cs.flexDirection || 'row',
      });
    }
  });

  return {figures, orphans, cols, cards, flexbr};
}
`;

interface FigureData {
  card_index: number;
  role: string;
  src: string;
  alt: string;
  fig_layout: string;
  rendered_w: number;
  rendered_h: number;
  card_w: number;
  natural_w: number;
  natural_h: number;
}

interface OrphanData {
  tag: string;
  cls: string;
  text: string;
  ws: string;
}

interface ColData {
  column_index: number;
  column_h: number;
  stated_gap_px: number;
  max_excess_px: number;
  pair_idx: number;
}

interface CardData {
  card_index: number;
  card_h: number;
  trailing_px: number;
}

interface FlexBrData {
  tag: string;
  cls: string;
  dir: string;
}

interface PolishJsResult {
  figures: FigureData[];
  orphans: OrphanData[];
  cols: ColData[];
  cards: CardData[];
  flexbr: FlexBrData[];
}

export interface PolishArgs {
  html: string;
  canvas: [number, number] | null;
  mathjaxTimeoutMs: number;
  settleMs: number;
  strict: boolean;
  wideMinRatio: number;
  tallMaxRatio: number;
  squareMinRatio: number;
  maxSpaceBetweenFill: number;
  maxCardTrailing: number;
}

export async function cmdPolish(args: PolishArgs): Promise<number> {
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

  const roleCounts = _preflight.hasRequiredRolesInHtml(htmlPath);
  const mustHave = ["poster", "card", "column"];
  const missing = mustHave.filter((r) => (roleCounts[r] ?? 0) === 0);
  if (missing.length > 0) {
    process.stderr.write(
      `ERROR: polish requires data-measure-role markup on the ` +
        `poster, columns, and cards. Missing or zero-count: ` +
        `${JSON.stringify(missing)}. Either add the roles or use a different tool.\n`,
    );
    return 2;
  }

  const resolved = _canvas.resolveCanvas(htmlPath, args.canvas, "[polish]");
  if (resolved === null) {
    process.stderr.write(
      "ERROR: could not find `@page { size: <W> <H> }` in HTML; " +
        "pass `--canvas <W>x<H>in` or `--canvas 'A0 portrait'`.\n",
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
        `${args.mathjaxTimeoutMs} ms; refusing to polish a ` +
        `partially loaded poster. A blocked/slow remote resource ` +
        `(CDN image, web font, MathJax) is the usual cause -- ` +
        `inline assets, or raise --mathjax-timeout-ms.\n`,
    );
    return 1;
  }

  const data = (await page.evaluate(POLISH_JS)) as PolishJsResult;
  await browser.close();

  const warns: string[] = [];

  // Gate A: figure sizing by AR
  for (const f of data.figures ?? []) {
    const rw = f.rendered_w;
    const cw = f.card_w;
    const nw = f.natural_w;
    const nh = f.natural_h;
    const role = f.role ?? "card";
    const srcL = f.src.toLowerCase();
    const srcPath = srcL.split("?")[0].split("#")[0];
    const isSvg =
      srcPath.endsWith(".svg") || srcPath.endsWith(".svgz") || srcL.startsWith("data:image/svg");
    if ((nw <= 0 || nh <= 0) && !isSvg) {
      warns.push(
        `FIG/BROKEN: '${asciiSafe(f.src)}' has zero natural ` +
          "size -- the image failed to load (missing file, 404, or " +
          "an unreachable remote URL); it will be blank in print.",
      );
      continue;
    }
    if (role === "hero") continue;
    if ((f.fig_layout || "").trim() === "beside-text") continue;
    if (cw <= 0 || rw <= 0 || nw <= 0 || nh <= 0) continue;
    const ar = nw / nh;
    const ratio = rw / cw;
    if (ar > 1.3 && ratio < args.wideMinRatio) {
      warns.push(
        `FIG/WIDE: '${asciiSafe(f.src)}' (AR=${ar.toFixed(2)}) at ` +
          `${Math.round(ratio * 100)}% of card width -- wide figures ` +
          `should sit >= ${Math.round(args.wideMinRatio * 100)}%. ` +
          `Enlarge, or drop the image-left/text-right wrapper.`,
      );
    } else if (ar < 0.8 && ratio > args.tallMaxRatio) {
      warns.push(
        `FIG/TALL: '${asciiSafe(f.src)}' (AR=${ar.toFixed(2)}) at ` +
          `${Math.round(ratio * 100)}% of card width -- tall figures ` +
          `usually pair better with text-right at 45-60%.`,
      );
    } else if (ar >= 0.8 && ar <= 1.3 && ratio < args.squareMinRatio) {
      warns.push(
        `FIG/SQUARE: '${asciiSafe(f.src)}' (AR=${ar.toFixed(2)}) at ` +
          `${Math.round(ratio * 100)}% of card width -- square figures ` +
          `sit better at ${Math.round(args.squareMinRatio * 100)}-75%.`,
      );
    }
  }

  // Gate B: typography orphans
  for (const n of data.orphans ?? []) {
    const txt = n.text;
    if (!txt) continue;
    const last = txt[txt.length - 1];
    if (!ORPHAN_GLYPHS.includes(last)) continue;
    if (!/\s/.test(txt.slice(0, -1))) continue;
    const ws = (n.ws || "").toLowerCase();
    if (ws.includes("nowrap") || ws.includes("pre")) continue;
    warns.push(
      `ORPHAN: <${asciiSafe(n.tag)} class='${asciiSafe(n.cls)}'> ` +
        `text '${asciiSafe(txt.substring(0, 48))}' ends with '${asciiSafe(last)}' ` +
        `and may wrap alone. Apply \`white-space: nowrap\` or use &nbsp; ` +
        `before the trailing glyph.`,
    );
  }

  // Gate C: space-between fill
  for (const c of data.cols ?? []) {
    const colH = c.column_h;
    const excess = c.max_excess_px;
    if (colH <= 0) continue;
    const fill = excess / colH;
    if (fill > args.maxSpaceBetweenFill) {
      warns.push(
        `SPACE-BETWEEN: column ${c.column_index} has a ` +
          `${excess.toFixed(0)} px inter-card gap ` +
          `(${(fill * 100).toFixed(1)}% of column height, stated gap ` +
          `${c.stated_gap_px.toFixed(0)} px). Balance via ` +
          `meaningful content, not justify-content. See ` +
          `Gate C in SKILL.md.`,
      );
    }
  }

  // Gate C (one card): trailing whitespace
  for (const c of data.cards ?? []) {
    const ch = c.card_h;
    const tr = c.trailing_px;
    if (ch <= 0 || tr <= 0) continue;
    const ratio = tr / ch;
    if (ratio > args.maxCardTrailing) {
      warns.push(
        `CARD/TRAILING: card ${c.card_index} fills only ` +
          `${Math.round(100 - ratio * 100)}% of its height -- ${tr.toFixed(0)} px ` +
          `(${Math.round(ratio * 100)}%) blank below the last line. A card ` +
          `stretched to align (flex:1) but padded with whitespace ` +
          `clears the bottom-edge gate yet reads as unfinished. Fill ` +
          `with real content, grow a figure, or shrink the canvas. ` +
          `See Gate C in SKILL.md.`,
      );
    }
  }

  // Gate D: <br> inside flex container
  for (const fb of data.flexbr ?? []) {
    const cls = fb.cls || "";
    const clsAttr = cls ? ` class="${asciiSafe(cls)}"` : "";
    warns.push(
      `LAYOUT/FLEX-BR: <${asciiSafe(fb.tag)}${clsAttr}> is ` +
        `display:flex (flex-direction:${fb.dir}) with a direct <br> ` +
        `child -- the <br> is blockified into a flex item and creates ` +
        `NO line break, so intended multi-line content collapses onto ` +
        `one row. Wrap each line in a <span> and use ` +
        `flex-direction:column, or make the wrapper a plain block.`,
    );
  }

  console.log(`[polish] ${asciiSafe(path.basename(htmlPath))}`);
  console.log(`  figures checked     : ${(data.figures ?? []).length}`);
  console.log(`  stat-like elements  : ${(data.orphans ?? []).length}`);
  console.log(`  space-between cols  : ${(data.cols ?? []).length}`);
  console.log(`  cards checked       : ${(data.cards ?? []).length}`);
  console.log(`  flex/<br> parents   : ${(data.flexbr ?? []).length}`);
  console.log(`  warnings            : ${warns.length}`);
  for (const w of warns) {
    console.log(`  WARN: ${w}`);
  }

  if (args.strict && warns.length > 0) {
    process.stderr.write("[polish] FAIL -- --strict and warnings present\n");
    return 1;
  }
  console.log(warns.length === 0 ? "[polish] PASS" : "[polish] OK (warnings only)");
  return 0;
}
