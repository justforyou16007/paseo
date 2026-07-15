#!/usr/bin/env node
/**
 * style_check — the style HARD gate for HTML academic posters.
 *
 * 12 style rules split across two gates:
 *   Source gate (rules 1,2,3,5,6,7,8,9,10,11) — pure static analysis.
 *   Render gate (rules 4,12) — needs computed style via Playwright.
 */
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../../lib/cli.js";
import { resolveCanvas } from "./posterly/canvas.js";
import {
  openPrintEmulatedPageAsync as openPrintEmulatedPage,
  settlePage,
  hardFailOnSettleProblems,
} from "./posterly/render.js";
import { asciiSafe } from "./posterly/textutil.js";

// ---------------------------------------------------------------------------
// Whitelists.
// ---------------------------------------------------------------------------

const SERIF_WHITELIST = new Set([
  "charter",
  "source serif pro",
  "georgia",
  "times new roman",
  "serif",
]);
const SANS_WHITELIST = new Set(["inter", "aptos", "helvetica neue", "arial", "sans-serif"]);
const MONO_WHITELIST = new Set(["menlo", "consolas", "monospace"]);

const FS_TOKEN_RE = /--fs-(\d+)\b/g;
const FS_VAR_REF_RE = /^var\(\s*--fs-\d+\s*\)$/;
const VARIANT_SUFFIX_RE = /\.[A-Za-z][\w-]*--[A-Za-z][\w-]*/;
const CALC_FS_RE = /calc\([^)]*var\(\s*--fs-\d+\s*\)[^)]*\)/;

// ---------------------------------------------------------------------------
// Color-literal detection.
// ---------------------------------------------------------------------------

const COLOR_LITERAL_RE = /(?:#[0-9a-fA-F]{3,8}\b)|(?:\brgba?\s*\([^)]*\))|(?:\bhsla?\s*\([^)]*\))/g;

const _FUNC_COLOR_RE = /\b(rgb|rgba|hsl|hsla)\s*\(([^)]*)\)/gi;

function parseAlpha(func: string, args: string): number | null {
  const parts = args
    .split(/[,/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const fl = func.toLowerCase();
  if (fl === "rgb" || fl === "hsl") return 1.0;
  if (fl === "rgba" || fl === "hsla") {
    if (parts.length < 4) return null;
    const a = parts[3];
    if (a.endsWith("%")) return parseFloat(a) / 100;
    return parseFloat(a);
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML parsing: collect <style> CSS and element attributes.
// ---------------------------------------------------------------------------

interface ElementRecord {
  tag: string;
  attrs: Record<string, string>;
  insideLogo: boolean;
  insidePaper: boolean;
  selfClosing: boolean;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function parseHtml(htmlText: string): { styleCss: string; elements: ElementRecord[] } {
  const styleParts: string[] = [];
  const elements: ElementRecord[] = [];
  const stack: { tag: string; opensLogo: boolean; opensPaper: boolean }[] = [];

  function insideLogo(): boolean {
    return stack.some((s) => s.opensLogo);
  }
  function insidePaper(): boolean {
    return stack.some((s) => s.opensPaper);
  }

  function parseAttrs(attrStr: string): Record<string, string> {
    const d: Record<string, string> = {};
    const re = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrStr)) !== null) {
      d[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    return d;
  }

  // Extract <style> content and tag structure
  const tagRe = /<\/([\w-]+)>|<([\w-]+)((?:\s+[^>]*?)?)(\/?)\s*>/g;
  let inStyle = false;
  let lastIdx = 0;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(htmlText)) !== null) {
    if (inStyle) {
      styleParts.push(htmlText.substring(lastIdx, tm.index));
    }
    lastIdx = tm.index + tm[0].length;

    if (tm[1]) {
      // Close tag
      const closeTag = tm[1].toLowerCase();
      if (closeTag === "style") inStyle = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === closeTag) {
          stack.splice(i);
          break;
        }
      }
    } else if (tm[2]) {
      const openTag = tm[2].toLowerCase();
      const attrStr = tm[3] || "";
      const selfClose = tm[4] === "/" || VOID_TAGS.has(openTag);
      const attrs = parseAttrs(attrStr);

      if (openTag === "style") inStyle = true;

      const opensLogo = (attrs["data-color-exempt"] || "").toLowerCase() === "logo";
      const opensPaper = (attrs["data-source"] || "").toLowerCase() === "paper";
      const il = insideLogo() || opensLogo;
      const ip = insidePaper() || opensPaper;

      elements.push({
        tag: openTag,
        attrs,
        insideLogo: il,
        insidePaper: ip,
        selfClosing: selfClose,
      });

      if (!selfClose && !VOID_TAGS.has(openTag)) {
        stack.push({ tag: openTag, opensLogo, opensPaper });
      }
    }
  }

  return { styleCss: styleParts.join("\n"), elements };
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*.*?\*\//gs, "");
}

// ---------------------------------------------------------------------------
// Token block location.
// ---------------------------------------------------------------------------

const _TOKEN_START_RE = /\/\*\s*=+\s*DESIGN TOKENS\s*=+\s*\*\//i;
const _TOKEN_END_RE = /\/\*\s*=+\s*END DESIGN TOKENS\s*=+\s*\*\//i;

function locateTokenBlock(css: string): [number, number] | null {
  const mStart = _TOKEN_START_RE.exec(css);
  if (!mStart) return null;
  const after = css.substring(mStart.index + mStart[0].length);
  const mEnd = _TOKEN_END_RE.exec(after);
  if (!mEnd) return null;
  const start = mStart.index + mStart[0].length;
  const end = start + mEnd.index;
  return [start, end];
}

// ---------------------------------------------------------------------------
// Radial gradient handling.
// ---------------------------------------------------------------------------

function* iterRadialGradients(css: string): Generator<{ pre: string; body: string; end: number }> {
  const low = css.toLowerCase();
  let i = 0;
  while (i < css.length) {
    const j = low.indexOf("radial-gradient(", i);
    if (j === -1) {
      yield { pre: css.substring(i), body: "", end: css.length };
      break;
    }
    const pre = css.substring(i, j);
    let k = j + "radial-gradient".length;
    let depth = 0;
    while (k < css.length) {
      if (css[k] === "(") depth++;
      else if (css[k] === ")") {
        depth--;
        if (depth === 0) {
          k++;
          break;
        }
      }
      k++;
    }
    yield { pre, body: css.substring(j, k), end: k };
    i = k;
  }
}

function blankAllowedRadialStops(css: string): string {
  const parts: string[] = [];
  for (const { pre, body } of iterRadialGradients(css)) {
    parts.push(pre);
    parts.push(" ".repeat(body.length));
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// CSS rule splitting.
// ---------------------------------------------------------------------------

function* iterCssRules(cssNoComments: string): Generator<{ selector: string; body: string }> {
  function* scan(block: string): Generator<{ selector: string; body: string }> {
    let i = 0;
    const n = block.length;
    while (i < n) {
      const brace = block.indexOf("{", i);
      if (brace === -1) break;
      const selector = block.substring(i, brace).trim();
      let depth = 1;
      let j = brace + 1;
      while (j < n && depth > 0) {
        if (block[j] === "{") depth++;
        else if (block[j] === "}") depth--;
        j++;
      }
      const body = block.substring(brace + 1, j - 1);
      if (selector.startsWith("@") && body.includes("{")) {
        yield* scan(body);
      } else {
        yield { selector, body };
      }
      i = j;
    }
  }
  yield* scan(cssNoComments);
}

// ---------------------------------------------------------------------------
// RuleResult.
// ---------------------------------------------------------------------------

interface RuleResultData {
  id: number;
  severity: string;
  status: string;
  detail: string;
}

class RuleResult {
  id: number;
  severity: string;
  title: string;
  status = "PASS";
  detail = "ok";

  constructor(rid: number, severity: string, title: string) {
    this.id = rid;
    this.severity = severity;
    this.title = title;
  }

  fail(detail: string): this {
    this.status = "FAIL";
    this.detail = detail;
    return this;
  }

  warn(detail: string): this {
    this.status = "WARN";
    this.detail = detail;
    return this;
  }

  skip(detail: string): this {
    this.status = "SKIPPED";
    this.detail = detail;
    return this;
  }

  toDict(): RuleResultData {
    return {
      id: this.id,
      severity: this.severity,
      status: this.status,
      detail: asciiSafe(this.detail),
    };
  }
}

// ---------------------------------------------------------------------------
// Source gate.
// ---------------------------------------------------------------------------

interface SourceGateResult {
  results: RuleResult[];
  elements: ElementRecord[];
  tokenBlockText: string | null;
}

function runSourceGate(htmlText: string, _htmlPath: string): SourceGateResult {
  const { styleCss: rawCss, elements } = parseHtml(htmlText);
  const tokenSpan = locateTokenBlock(rawCss);
  let tokenBlockText: string | null = null;
  if (tokenSpan !== null) {
    tokenBlockText = rawCss.substring(tokenSpan[0], tokenSpan[1]);
  }

  const results: RuleResult[] = [];

  // Rule 1: color literals only inside the token block
  const r1 = new RuleResult(1, "hard", "color literals only in token block");
  if (tokenSpan === null) {
    r1.fail(
      "design-token block not found: expected the comment pair " +
        "/* ===== DESIGN TOKENS ===== */ ... /* ===== END DESIGN TOKENS ===== */.",
    );
  } else {
    let cssScan =
      rawCss.substring(0, tokenSpan[0]) +
      " ".repeat(tokenSpan[1] - tokenSpan[0]) +
      rawCss.substring(tokenSpan[1]);
    cssScan = stripCssComments(cssScan);
    cssScan = blankAllowedRadialStops(cssScan);
    const offenders = new Set<string>();
    const litRe = new RegExp(COLOR_LITERAL_RE.source, "g");
    let lm: RegExpExecArray | null;
    while ((lm = litRe.exec(cssScan)) !== null) {
      offenders.add(lm[0]);
    }
    if (offenders.size > 0) {
      const arr = [...offenders].sort().slice(0, 8);
      r1.fail(
        "color literal(s) outside the token block: " +
          arr.join(", ") +
          (offenders.size > 8 ? " ..." : "") +
          ". Move them to a --token in the DESIGN TOKENS block.",
      );
    }
  }
  results.push(r1);

  // Rule 2: forbidden inline style= attributes
  const r2 = new RuleResult(2, "hard", "no inline style= (two documented exemptions)");
  const styleOffenders: string[] = [];
  for (const el of elements) {
    const style = el.attrs["style"];
    if (style === undefined || style.trim() === "") continue;
    if (el.insideLogo) continue;
    const isPaperImg =
      el.tag === "img" && (el.attrs["data-source"] || "").toLowerCase() === "paper";
    if (isPaperImg && /^\s*width\s*:\s*\d+(?:\.\d+)?%\s*;?\s*$/.test(style)) {
      continue;
    }
    styleOffenders.push(`<${el.tag} style="${style.trim()}">`);
  }
  if (styleOffenders.length > 0) {
    r2.fail(`${styleOffenders.length} inline style= attribute(s). First: ${styleOffenders[0]}`);
  }
  results.push(r2);

  // Rule 3: component CSS colors must be var(--)
  const r3 = new RuleResult(3, "hard", "component colors use var(--)");
  const cssNc = stripCssComments(rawCss);
  const colorPropOffenders: string[] = [];
  const colorPropRe =
    /(?<![\w-])(color|background|background-color|border|border-color|border-top-color|border-bottom-color|border-left-color|border-right-color|fill|stroke|box-shadow|outline|outline-color)\s*:\s*([^;{}]+)/gi;
  for (const { selector, body } of iterCssRules(cssNc)) {
    if (selector.toLowerCase().includes(":root")) continue;
    const bodyScan = blankAllowedRadialStops(body);
    const cpRe = new RegExp(colorPropRe.source, "gi");
    let cm: RegExpExecArray | null;
    while ((cm = cpRe.exec(bodyScan)) !== null) {
      const value = cm[2];
      const clRe = new RegExp(COLOR_LITERAL_RE.source, "g");
      if (clRe.test(value)) {
        colorPropOffenders.push(
          `${selector.trim().substring(0, 40)} { ${cm[1]}: ${value.trim().substring(0, 40)} }`,
        );
      }
    }
  }
  if (colorPropOffenders.length > 0) {
    r3.fail(
      `${colorPropOffenders.length} component color declaration(s) with a literal. ` +
        `First: ${colorPropOffenders[0]}`,
    );
  }
  results.push(r3);

  // Rule 5: no linear-gradient; radial only on .poster bg
  const r5 = new RuleResult(5, "hard", "no linear-gradient; radial only .poster bg");
  if (/\blinear-gradient\s*\(/i.test(cssNc)) {
    r5.fail("linear-gradient is forbidden (flat design). Replace with a solid var(--) fill.");
  } else {
    const radialProblems: string[] = [];
    for (const { selector, body } of iterCssRules(cssNc)) {
      if (!body.toLowerCase().includes("radial-gradient")) continue;
      if (!selector.toLowerCase().includes(".poster")) {
        radialProblems.push(
          `radial-gradient on '${selector.trim().substring(0, 50)}' (only .poster may use it)`,
        );
        continue;
      }
      for (const { body: gradText } of iterRadialGradients(body)) {
        if (!gradText) continue;
        const fcRe = new RegExp(_FUNC_COLOR_RE.source, "gi");
        let fm: RegExpExecArray | null;
        while ((fm = fcRe.exec(gradText)) !== null) {
          const a = parseAlpha(fm[1], fm[2]);
          if (a === null) continue;
          if (a > 0.06 + 1e-9) {
            radialProblems.push(
              `radial-gradient stop alpha=${a} > 0.06 on '${selector.trim().substring(0, 40)}'`,
            );
          }
        }
      }
    }
    if (radialProblems.length > 0) {
      r5.fail(radialProblems.slice(0, 4).join("; "));
    }
  }
  results.push(r5);

  // Rules 6+7: font pairing + whitelist
  const r6 = new RuleResult(6, "hard", "font pairing: serif body / sans heading");
  const r7 = new RuleResult(7, "hard", "font-family whitelist");

  function families(value: string): string[] {
    return value
      .split(",")
      .map((raw) =>
        raw
          .trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase(),
      )
      .filter(Boolean);
  }

  const scope = tokenBlockText !== null ? tokenBlockText : cssNc;
  let serifDef: string[] | null = null;
  let sansDef: string[] | null = null;
  let monoDef: string[] | null = null;

  let fm = /--font-serif\s*:\s*([^;{}]+)/i.exec(scope);
  if (fm) serifDef = families(fm[1]);
  fm = /--font-sans\s*:\s*([^;{}]+)/i.exec(scope);
  if (fm) sansDef = families(fm[1]);
  fm = /--font-mono\s*:\s*([^;{}]+)/i.exec(scope);
  if (fm) monoDef = families(fm[1]);

  const wlProblems: string[] = [];
  if (serifDef !== null) {
    const bad = serifDef.filter((f) => !SERIF_WHITELIST.has(f));
    if (bad.length > 0) wlProblems.push(`--font-serif has non-whitelisted: ${bad.join(", ")}`);
  }
  if (sansDef !== null) {
    const bad = sansDef.filter((f) => !SANS_WHITELIST.has(f));
    if (bad.length > 0) wlProblems.push(`--font-sans has non-whitelisted: ${bad.join(", ")}`);
  }
  if (monoDef !== null) {
    const bad = monoDef.filter((f) => !MONO_WHITELIST.has(f));
    if (bad.length > 0) wlProblems.push(`--font-mono has non-whitelisted: ${bad.join(", ")}`);
  }

  for (const { selector, body } of iterCssRules(cssNc)) {
    const ffRe = /font-family\s*:\s*([^;{}]+)/gi;
    let ffm: RegExpExecArray | null;
    while ((ffm = ffRe.exec(body)) !== null) {
      const val = ffm[1];
      if (val.includes("var(")) continue;
      const fams = families(val);
      const allowed = new Set([...SERIF_WHITELIST, ...SANS_WHITELIST, ...MONO_WHITELIST]);
      const bad = fams.filter((f) => !allowed.has(f));
      if (bad.length > 0) {
        wlProblems.push(
          `literal font stack on '${selector.trim().substring(0, 30)}' has non-whitelisted: ${bad.join(", ")}`,
        );
      }
    }
  }
  if (wlProblems.length > 0) {
    r7.fail(wlProblems.slice(0, 4).join("; "));
  }
  results.push(r7);

  const pairingProblems: string[] = [];
  if (serifDef !== null && (serifDef.length === 0 || serifDef[serifDef.length - 1] !== "serif")) {
    pairingProblems.push("--font-serif must end in the generic `serif` family");
  }
  if (sansDef !== null && (sansDef.length === 0 || sansDef[sansDef.length - 1] !== "sans-serif")) {
    pairingProblems.push("--font-sans must end in the generic `sans-serif` family");
  }
  if (serifDef === null && sansDef === null) {
    pairingProblems.push(
      "neither --font-serif nor --font-sans token is defined; cannot verify pairing",
    );
  }
  if (pairingProblems.length > 0) {
    r6.fail(pairingProblems.join("; "));
  }
  results.push(r6);

  // Rule 8: font-size must use --fs-* token
  const r8 = new RuleResult(8, "hard", "font-size via --fs-* token / variant calc");
  const fsProblems: string[] = [];
  for (const { selector, body } of iterCssRules(cssNc)) {
    const selHasVariant = VARIANT_SUFFIX_RE.test(selector);
    const fsRe = /font-size\s*:\s*([^;{}]+)/gi;
    let fsm: RegExpExecArray | null;
    while ((fsm = fsRe.exec(body)) !== null) {
      const value = fsm[1].trim();
      if (FS_VAR_REF_RE.test(value)) continue;
      const emMatch = /^(0?\.\d+|1(?:\.0+)?)\s*em$/.exec(value);
      if (emMatch && parseFloat(emMatch[1]) <= 1.0) continue;
      if (CALC_FS_RE.test(value)) {
        if (selHasVariant) continue;
        fsProblems.push(
          `calc() font-size with --fs token on non-variant selector '${selector.trim().substring(0, 40)}'`,
        );
        continue;
      }
      fsProblems.push(
        `off-scale font-size on '${selector.trim().substring(0, 40)}': '${value.substring(0, 40)}' (use var(--fs-N))`,
      );
    }
  }
  if (fsProblems.length > 0) {
    r8.fail(
      fsProblems.slice(0, 4).join("; ") +
        (fsProblems.length > 4 ? ` (+${fsProblems.length - 4} more)` : ""),
    );
  }
  results.push(r8);

  // Rule 9 (WARN): > 9 distinct --fs tokens
  const r9 = new RuleResult(9, "warn", "<= 9 font-size tokens");
  const definedFs = new Set<number>();
  const fsScope = tokenBlockText !== null ? tokenBlockText : cssNc;
  const fstRe = new RegExp(FS_TOKEN_RE.source, "g");
  let fstm: RegExpExecArray | null;
  while ((fstm = fstRe.exec(fsScope)) !== null) {
    definedFs.add(parseInt(fstm[1], 10));
  }
  if (definedFs.size > 9) {
    const sorted = [...definedFs].sort((a, b) => a - b);
    r9.warn(
      `${definedFs.size} --fs-* tokens defined (${sorted.map((n) => `--fs-${n}`).join(", ")}); ` +
        `the scale should stay <= 9.`,
    );
  } else {
    r9.detail = `${definedFs.size} --fs-* token(s) defined`;
  }
  results.push(r9);

  // Rule 10: data-attribute contracts
  const r10 = new RuleResult(10, "hard", "data-source/asset-id + logo-exempt marks");
  const contractProblems: string[] = [];
  for (const el of elements) {
    if (el.tag === "img" && (el.attrs["data-source"] || "").toLowerCase() === "paper") {
      if (!(el.attrs["data-asset-id"] || "").trim()) {
        const src = el.attrs["src"] || "?";
        contractProblems.push(
          `<img data-source="paper" src="${src.substring(0, 40)}"> is missing data-asset-id`,
        );
      }
    }
  }
  if (contractProblems.length > 0) {
    r10.fail(contractProblems.slice(0, 4).join("; "));
  }
  results.push(r10);

  // Rule 11: no hand-rolled decorative SVG
  const r11 = new RuleResult(11, "hard", "no decorative inline SVG");
  const svgProblems: string[] = [];
  for (const el of elements) {
    if (el.tag !== "svg") continue;
    const comp = (el.attrs["data-component"] || "").toLowerCase();
    if (el.insideLogo) continue;
    if (comp === "diagram" || comp === "qr") continue;
    svgProblems.push(
      'inline <svg> not inside data-color-exempt="logo" and not data-component="diagram"/"qr"',
    );
  }
  if (svgProblems.length > 0) {
    r11.fail(
      `${svgProblems.length} disallowed inline <svg>: ${svgProblems[0]}. ` +
        "Decorative SVG is banned.",
    );
  }
  results.push(r11);

  return { results, elements, tokenBlockText };
}

// ---------------------------------------------------------------------------
// Hue-cluster helpers (rule 4).
// ---------------------------------------------------------------------------

function hueOfRgb(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
    else if (max === gf) h = ((bf - rf) / d + 2) / 6;
    else h = ((rf - gf) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function circularMean(angles: number[]): number {
  const x = angles.reduce((sum, a) => sum + Math.cos((a * Math.PI) / 180), 0);
  const y = angles.reduce((sum, a) => sum + Math.sin((a * Math.PI) / 180), 0);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function clusterHues(hues: number[], radiusDeg = 18): number[] {
  if (hues.length === 0) return [];
  const ordered = [...hues].sort((a, b) => a - b);
  const clusters: number[][] = [[ordered[0]]];
  for (let i = 1; i < ordered.length; i++) {
    const seed = clusters[clusters.length - 1][0];
    if (hueDist(ordered[i], seed) <= radiusDeg) {
      clusters[clusters.length - 1].push(ordered[i]);
    } else {
      clusters.push([ordered[i]]);
    }
  }
  if (clusters.length > 1) {
    const last = clusters[clusters.length - 1];
    if (hueDist(last[last.length - 1], clusters[0][0]) <= radiusDeg) {
      clusters[0] = last.concat(clusters[0]);
      clusters.pop();
    }
  }
  return clusters.map(circularMean);
}

function parseRgbaStr(s: string): { r: number; g: number; b: number; a: number } | null {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)/i.exec(s || "");
  if (!m) return null;
  const r = Math.round(parseFloat(m[1]));
  const g = Math.round(parseFloat(m[2]));
  const b = Math.round(parseFloat(m[3]));
  let a = 1.0;
  if (m[4] !== undefined) {
    if (m[4].endsWith("%")) a = parseFloat(m[4]) / 100;
    else a = parseFloat(m[4]);
  }
  return { r, g, b, a };
}

function hueFromHex(hexStr: string | null | undefined): number | null {
  if (!hexStr || !hexStr.startsWith("#")) return null;
  let h = hexStr.substring(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return hueOfRgb(r, g, b)[0];
}

// ---------------------------------------------------------------------------
// Render gate.
// ---------------------------------------------------------------------------

const _RENDER_JS = `() => {
  const isExempt = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = n.tagName ? n.tagName.toLowerCase() : '';
      if (tag === 'img') return true;
      if (n.hasAttribute && n.hasAttribute('data-color-exempt')) return true;
      if (n.getAttribute && n.getAttribute('data-source') === 'paper') return true;
      const comp = n.getAttribute && n.getAttribute('data-component');
      if (comp === 'qr') return true;
      if (n.classList && n.classList.contains('qr-block')) return true;
      n = n.parentElement;
    }
    return false;
  };
  const poster = document.querySelector('[data-measure-role="poster"]')
               || document.querySelector('.poster') || document.body;
  const pr = poster.getBoundingClientRect();
  const posterArea = Math.max(1, pr.width * pr.height);
  const colors = [];
  let darkArea = 0;
  const all = Array.from(document.querySelectorAll('*'));
  for (const el of all) {
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const onscreen = r.width > 0 && r.height > 0;
    if (onscreen) {
      const bg = cs.backgroundColor;
      const m = /rgba?\\(([^)]+)\\)/i.exec(bg || '');
      if (m) {
        const p = m[1].split(/[ ,\\/]+/).filter(Boolean);
        if (p.length >= 3) {
          const rv = parseFloat(p[0]) / 255, gv = parseFloat(p[1]) / 255, bv = parseFloat(p[2]) / 255;
          const a = p.length >= 4 ? parseFloat(p[3]) : 1;
          if (a >= 0.5) {
            const L = (Math.max(rv, gv, bv) + Math.min(rv, gv, bv)) / 2;
            if (L < 0.18) {
              const w = Math.max(0, Math.min(r.right, pr.right) - Math.max(r.left, pr.left));
              const h = Math.max(0, Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top));
              darkArea += w * h;
            }
          }
        }
      }
    }
    if (isExempt(el)) continue;
    colors.push({prop: 'color', rgba: cs.color});
    colors.push({prop: 'background-color', rgba: cs.backgroundColor});
    colors.push({prop: 'border-top-color', rgba: cs.borderTopColor});
    colors.push({prop: 'border-right-color', rgba: cs.borderRightColor});
    colors.push({prop: 'border-bottom-color', rgba: cs.borderBottomColor});
    colors.push({prop: 'border-left-color', rgba: cs.borderLeftColor});
    colors.push({prop: 'fill', rgba: cs.fill});
    colors.push({prop: 'stroke', rgba: cs.stroke});
  }
  return {colors, posterArea, darkArea};
}`;

interface HueCenters {
  accent?: number;
  gold?: number;
}

function resolveHueCenters(tokensPath: string | null, tokenBlockText: string | null): HueCenters {
  const centers: HueCenters = {};

  if (tokensPath !== null) {
    try {
      const doc = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
      const hc = doc.hue_centers || {};
      for (const key of ["accent", "gold"] as const) {
        if (key in hc) {
          const v = parseFloat(hc[key]);
          if (!isNaN(v)) centers[key] = v % 360;
        }
      }
      for (const [key, sub] of [
        ["accent", "accent"],
        ["gold", "gold"],
      ] as const) {
        if (centers[key] !== undefined) continue;
        const base = (doc[sub] || {}).base;
        const h = hueFromHex(base);
        if (h !== null) centers[key] = h;
      }
    } catch {
      process.stderr.write(
        `WARNING: could not read --tokens ${asciiSafe(tokensPath)}; falling back to :root.\n`,
      );
    }
  }

  if (tokenBlockText) {
    for (const [key, varName] of [
      ["accent", "--accent"],
      ["gold", "--gold"],
    ] as const) {
      if (centers[key] !== undefined) continue;
      const re = new RegExp(
        varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*(#[0-9a-fA-F]{3,8})",
      );
      const m = re.exec(tokenBlockText);
      if (m) {
        const h = hueFromHex(m[1]);
        if (h !== null) centers[key] = h;
      }
    }
  }
  return centers;
}

async function runRenderGate(
  htmlPath: string,
  hueCentersMap: HueCenters,
  opts: {
    clusterRadiusDeg?: number;
    centerTolDeg?: number;
    nonneutralAlpha?: number;
    nonneutralSat?: number;
    darkAreaFrac?: number;
    mathjaxTimeoutMs?: number;
    settleMs?: number;
  } = {},
): Promise<{ results: RuleResult[]; envExit: number | null }> {
  const clusterRadiusDeg = opts.clusterRadiusDeg ?? 18;
  const centerTolDeg = opts.centerTolDeg ?? 22;
  const nonneutralAlpha = opts.nonneutralAlpha ?? 0.1;
  const nonneutralSat = opts.nonneutralSat ?? 0.18;
  const darkAreaFrac = opts.darkAreaFrac ?? 0.08;
  const mathjaxTimeoutMs = opts.mathjaxTimeoutMs ?? 15000;
  const settleMs = opts.settleMs ?? 500;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    pw = await import("playwright" as string);
  } catch {
    process.stderr.write(
      "ERROR: playwright is not available; render gate (rules 4,12) cannot run.\n",
    );
    return { results: [], envExit: 2 };
  }

  const resolved = resolveCanvas(htmlPath, null, "[style]");
  if (resolved === null) {
    process.stderr.write("ERROR: could not find @page { size } in HTML for the render gate.\n");
    return { results: [], envExit: 2 };
  }
  const { viewport } = resolved;

  const { browser, page } = await openPrintEmulatedPage(pw, viewport);
  let navTimedOut = false;
  try {
    await page.goto(`file://${htmlPath}`, {
      waitUntil: "networkidle",
      timeout: mathjaxTimeoutMs,
    });
  } catch {
    navTimedOut = true;
  }

  const settle = await settlePage(page, { mathjaxTimeoutMs, settleMs });
  const fail = hardFailOnSettleProblems(settle, mathjaxTimeoutMs);
  if (fail !== null) {
    await browser.close();
    process.stderr.write(`ERROR (render gate): ${fail}\n`);
    return { results: [], envExit: 2 };
  }
  if (navTimedOut) {
    await browser.close();
    process.stderr.write(
      `ERROR (render gate): page did not reach network-idle within ${mathjaxTimeoutMs} ms.\n`,
    );
    return { results: [], envExit: 2 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await page.evaluate(_RENDER_JS);
  await browser.close();

  const results: RuleResult[] = [];

  // Rule 4: non-neutral hue clustering
  const r4 = new RuleResult(4, "hard", "<=2 non-neutral hue clusters on palette");
  const hues: number[] = [];
  for (const c of data.colors) {
    const parsed = parseRgbaStr(c.rgba);
    if (!parsed) continue;
    if (parsed.a < nonneutralAlpha) continue;
    const [hue, sat, l] = hueOfRgb(parsed.r, parsed.g, parsed.b);
    const chroma = sat * (1 - Math.abs(2 * l - 1));
    if (chroma < nonneutralSat * 0.56) continue;
    hues.push(hue);
  }

  const centers = clusterHues(hues, clusterRadiusDeg);
  const targetHues: number[] = [];
  if (hueCentersMap.accent !== undefined) targetHues.push(hueCentersMap.accent);
  if (hueCentersMap.gold !== undefined) targetHues.push(hueCentersMap.gold);
  const problems: string[] = [];
  if (centers.length > 2) {
    problems.push(
      `${centers.length} non-neutral hue clusters ` +
        `(${centers.map((c) => `${c.toFixed(0)} deg`).join(", ")}); at most 2 allowed.`,
    );
  }
  if (targetHues.length > 0) {
    for (const c of centers) {
      const nearest = Math.min(...targetHues.map((t) => hueDist(c, t)));
      if (nearest > centerTolDeg) {
        problems.push(
          `hue cluster at ${c.toFixed(0)} deg is ${nearest.toFixed(0)} deg from ` +
            `the nearest palette center; tolerance is ${centerTolDeg} deg`,
        );
      }
    }
  } else {
    problems.push("no accent/gold hue centers available — cannot verify cluster proximity");
  }
  if (problems.length > 0) {
    r4.fail(problems.slice(0, 4).join("; "));
  } else {
    r4.detail = `${centers.length} hue cluster(s), all within ${centerTolDeg} deg of the palette`;
  }
  results.push(r4);

  // Rule 12 (WARN): large dark area
  const r12 = new RuleResult(12, "warn", "large dark area (kitsch warning)");
  const frac = data.posterArea > 0 ? data.darkArea / data.posterArea : 0;
  if (frac > darkAreaFrac) {
    r12.warn(
      `dark (L<0.18) backgrounds cover ${(frac * 100).toFixed(1)}% of the poster ` +
        `(> ${(darkAreaFrac * 100).toFixed(0)}% threshold). Lighten or shrink them.`,
    );
  } else {
    r12.detail = `dark area = ${(frac * 100).toFixed(1)}% of poster (<= 8%)`;
  }
  results.push(r12);

  return { results, envExit: null };
}

// ---------------------------------------------------------------------------
// Orchestration + CLI.
// ---------------------------------------------------------------------------

function overallStatus(results: RuleResult[]): string {
  if (results.some((r) => r.severity === "hard" && r.status === "FAIL")) return "FAIL";
  if (results.some((r) => r.status === "WARN")) return "WARN";
  return "PASS";
}

const program = createCli("style_check", "Style HARD gate for HTML academic posters: 12 rules.");

program
  .argument("<html>", "path to poster.html")
  .option("--tokens <path>", "tokens JSON for hue centers")
  .option("--json <path>", "write JSON report to this path")
  .option("--no-render", "skip the render gate (rules 4 and 12)")
  .action(async (html: string, opts: Record<string, string | boolean | undefined>) => {
    const htmlPath = path.resolve(html);
    if (!fs.existsSync(htmlPath)) {
      process.stderr.write(`ERROR: HTML not found: ${asciiSafe(htmlPath)}\n`);
      process.exit(2);
    }

    let htmlText: string;
    try {
      htmlText = fs.readFileSync(htmlPath, "utf-8");
    } catch (e) {
      process.stderr.write(`ERROR: cannot read HTML: ${asciiSafe(String(e))}\n`);
      process.exit(2);
    }

    const tokensPath = opts.tokens ? path.resolve(opts.tokens as string) : null;
    if (tokensPath !== null && !fs.existsSync(tokensPath)) {
      process.stderr.write(`ERROR: --tokens not found: ${asciiSafe(tokensPath)}\n`);
      process.exit(2);
    }

    const { results: sourceResults, tokenBlockText } = runSourceGate(htmlText, htmlPath);

    let renderResults: RuleResult[];
    if (opts.noRender || opts["no-render"]) {
      renderResults = [
        new RuleResult(4, "hard", "<=2 non-neutral hue clusters").skip(
          "render gate skipped (--no-render)",
        ),
        new RuleResult(12, "warn", "large dark area").skip("render gate skipped (--no-render)"),
      ];
      console.log("[style] NOTICE: --no-render set; rules 4 and 12 are SKIPPED.");
    } else {
      const hueCentersMap = resolveHueCenters(tokensPath, tokenBlockText);
      const { results: rr, envExit } = await runRenderGate(htmlPath, hueCentersMap);
      if (envExit !== null) process.exit(envExit);
      renderResults = rr;
    }

    const allResults = [...sourceResults, ...renderResults].sort((a, b) => a.id - b.id);
    const status = overallStatus(allResults);

    const report = {
      gate: "style",
      status,
      rules: allResults.map((r) => r.toDict()),
    };

    if (opts.json) {
      const jsonPath = path.resolve(opts.json as string);
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
      console.log(`[style] report -> ${asciiSafe(jsonPath)}`);
    }

    console.log(`[style] overall = ${status}`);
    for (const r of allResults) {
      console.log(
        `  rule ${String(r.id).padStart(2)} [${r.severity.padStart(4)}] ` +
          `${r.status.padEnd(7)} ${asciiSafe(r.detail)}`,
      );
    }

    process.exit(status === "FAIL" ? 1 : 0);
  });

runCli(program);
