#!/usr/bin/env node

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { createCli, runCli } from "../../lib/cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATES_DIR = path.resolve(__dirname, "../../../skills/render-html/scripts/templates");

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const PH_OPEN = "";
const PH_CLOSE = "";

function ph(idx: number): string {
  return `${PH_OPEN}${idx}${PH_CLOSE}`;
}

const RE_CODE_INLINE = /`([^`\n]+)`/g;
const RE_MATH_DISPLAY = /\$\$([^\n][\s\S]*?)\$\$/g;
const RE_MATH_INLINE = /(?<!\\)\$([^\$\n]+?)\$/g;
const RE_IMG = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
const RE_LINK = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
const RE_BOLD = /\*\*([^\*\n]+)\*\*/g;
const RE_ITALIC = /(?<!\*)\*([^\*\n]+)\*(?!\*)/g;
const RE_ITALIC_UNDERSCORE = /(?<!\w)_([^_\n]+)_(?!\w)/g;
const RE_STRIKE = /~~([^~\n]+)~~/g;
const RE_PAPER_REF = /(?<!\\)\[\[([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\|([^\]\n]+))?\]\]/g;

const INLINE_HTML_TAGS = [
  "br",
  "img",
  "a",
  "span",
  "sub",
  "sup",
  "code",
  "kbd",
  "b",
  "i",
  "u",
  "strong",
  "em",
];

const SAFE_URL_SCHEMES = ["http:", "https:", "mailto:", "ftp:", "tel:", "#", "/", "./", "../"];

function safeUrl(url: string): string {
  const s = url.trim().toLowerCase();
  if (
    s.startsWith("#") ||
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s === ""
  ) {
    return url;
  }
  if (SAFE_URL_SCHEMES.some((scheme) => s.startsWith(scheme))) {
    return url;
  }
  const firstSegment = s.split("/", 1)[0];
  if (!firstSegment.includes(":")) {
    return url;
  }
  return "#blocked-unsafe-url";
}

const RE_STRIP_TAG = new RegExp(
  "<\\s*(script|style|iframe|object|embed|form|input|button|link|meta|base)\\b[^>]*>.*?</\\s*\\1\\s*>",
  "gis",
);
const RE_STRIP_TAG_SELF = new RegExp(
  "<\\s*(script|style|iframe|object|embed|form|input|button|link|meta|base)\\b[^>]*/?>\\s*",
  "gi",
);
const RE_STRIP_EVENT_ATTR = new RegExp("\\s+on[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "gi");
const RE_STRIP_DANGEROUS_URL_ATTR = new RegExp(
  "(\\b(?:href|src|action|formaction|poster)\\s*=\\s*[\"']?)\\s*(?:javascript|vbscript|data)\\s*:",
  "gi",
);

function escapeHtml(s: string, quoteAttr = false): string {
  let out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (quoteAttr) {
    out = out.replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }
  return out;
}

function sanitizeHtml(s: string): string {
  s = s.replace(RE_STRIP_TAG, "");
  s = s.replace(RE_STRIP_TAG_SELF, "");
  s = s.replace(RE_STRIP_EVENT_ATTR, "");
  s = s.replace(RE_STRIP_DANGEROUS_URL_ATTR, "$1#blocked-unsafe-url:");
  return s;
}

function renderInline(text: string): string {
  const stash: string[] = [];

  function store(replacement: string): string {
    const idx = stash.length;
    stash.push(replacement);
    return ph(idx);
  }

  // 1a. Inline code
  text = text.replace(RE_CODE_INLINE, (_m, p1: string) => store(`<code>${escapeHtml(p1)}</code>`));

  // 1b. Display math
  text = text.replace(RE_MATH_DISPLAY, (_m, p1: string) => {
    const body = escapeHtml(p1);
    return store(`$$${body}$$`);
  });

  // 1c. Inline math
  text = text.replace(RE_MATH_INLINE, (_m, p1: string) => {
    const body = escapeHtml(p1);
    return store(`$${body}$`);
  });

  // 1d. Wikilink paper refs
  text = text.replace(RE_PAPER_REF, (_m, key: string, display: string | undefined) => {
    const disp = display !== undefined ? display : key.toUpperCase();
    return store(`<span data-ref="${escapeHtml(key, true)}">${escapeHtml(disp)}</span>`);
  });

  // 1e. Inline HTML spans
  const reTag = new RegExp(`<(/?)(?:${INLINE_HTML_TAGS.join("|")})(\\s[^<>]*)?>`, "gi");
  text = text.replace(reTag, (m) => store(sanitizeHtml(m)));

  // 2. HTML-escape remainder
  text = escapeHtml(text);

  // 3. Apply markdown emphasis & links
  text = text.replace(RE_IMG, (_m, alt: string, src: string, title?: string) => {
    const altAttr = escapeHtml(alt, true);
    const srcAttr = escapeHtml(safeUrl(src), true);
    const titleAttr = title ? ` title="${escapeHtml(title, true)}"` : "";
    return `<img src="${srcAttr}" alt="${altAttr}"${titleAttr} />`;
  });

  text = text.replace(RE_LINK, (_m, label: string, href: string, title?: string) => {
    const hrefAttr = escapeHtml(safeUrl(href), true);
    const titleAttr = title ? ` title="${escapeHtml(title, true)}"` : "";
    return `<a href="${hrefAttr}"${titleAttr}>${label}</a>`;
  });

  text = text.replace(RE_BOLD, "<strong>$1</strong>");
  text = text.replace(RE_ITALIC, "<em>$1</em>");
  text = text.replace(RE_ITALIC_UNDERSCORE, "<em>$1</em>");
  text = text.replace(RE_STRIKE, "<del>$1</del>");

  // 4. Restore placeholders
  const phRe = new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g");
  text = text.replace(phRe, (_m, idx: string) => stash[parseInt(idx, 10)]);

  return text;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_CODE_FENCE = /^```\s*(?:(?<lang>[A-Za-z0-9_+.#-]+)\s*)?(?:\{(?<flags>[^}\n]+)\}\s*)?$/;
const RE_TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const RE_ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RE_UNORDERED = /^(\s*)[-*+]\s+(.*)$/;
const RE_BLOCKQUOTE = /^>\s?(.*)$/;
const RE_HTML_BLOCK_OPEN =
  /^\s*<(details|div|figure|table|p|ul|ol|nav|section|aside|header|footer|main|article|blockquote)(\s|>|\/?>)/i;

const CALLOUT_PREFIX_MAP: Array<[RegExp, string, string]> = [
  [/^[⚠️⚠]️?\s*/, "callout-warn", "Warning"],
  [/^💡\s*/, "callout-info", "Tip"],
  [/^✅\s*/, "callout-good", "OK"],
  [/^✓\s*/, "callout-good", "OK"],
  [/^❌\s*/, "callout-bad", "Blocked"],
  [/^🔒\s*/, "callout-good", "Guarantee"],
  [/^📝\s*/, "callout-info", "Note"],
  [/^🚨\s*/, "callout-bad", "Critical"],
  [/^🛠\s*/, "callout-info", "Note"],
  [/^🆕\s*/, "callout-info", "New"],
  [/^⚙️⚡?\s*/, "callout-info", "Config"],
  [/^🔁\s*/, "callout-info", "Loop"],
  [/^🌱\s*/, "callout-info", "Note"],
  [/^📚\s*/, "callout-info", "Reference"],
  [/^🧬\s*/, "callout-info", "Meta"],
];

interface Block {
  type: string;
  level?: number;
  text?: string;
  lang?: string;
  content?: string;
  flags?: Set<string>;
  header?: string;
  divider?: string;
  rows?: string[];
  lines?: string[];
  ordered?: boolean;
  items?: string[];
}

function slugify(text: string): string {
  let s = text.replace(/[`*_~$]/g, "");
  s = s.trim().toLowerCase().replace(/\s+/g, "-");
  s = s.replace(/[^a-z0-9一-鿿\-]/g, "");
  s = s.replace(/^-+|-+$/g, "");
  return s || "section";
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];
    const stripped = line.trimEnd();

    if (!stripped.trim()) {
      i++;
      continue;
    }

    // Code fence
    let m = RE_CODE_FENCE.exec(stripped);
    if (m) {
      const lang = (m.groups?.lang ?? "").trim();
      const flagsRaw = (m.groups?.flags ?? "").trim();
      const flags = new Set<string>();
      if (flagsRaw) {
        for (const tok of flagsRaw.split(",")) {
          const t = tok.trim();
          if (t) flags.add(t);
        }
      }
      const body: string[] = [];
      i++;
      while (i < n && !RE_CODE_FENCE.test(lines[i].trimEnd())) {
        body.push(lines[i]);
        i++;
      }
      if (i < n) i++;
      blocks.push({ type: "code", lang, content: body.join("\n"), flags });
      RE_CODE_FENCE.lastIndex = 0;
      continue;
    }
    RE_CODE_FENCE.lastIndex = 0;

    // ATX heading
    m = RE_HEADING.exec(stripped);
    if (m) {
      blocks.push({ type: "heading", level: m[1].length, text: m[2].trim() });
      i++;
      continue;
    }

    // Horizontal rule
    if (RE_HR.test(stripped)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Table
    if (stripped.includes("|") && i + 1 < n && RE_TABLE_DIVIDER.test(lines[i + 1].trimEnd())) {
      const header = stripped;
      const divider = lines[i + 1].trimEnd();
      const rows: string[] = [];
      let j = i + 2;
      while (j < n && lines[j].includes("|") && lines[j].trim()) {
        rows.push(lines[j].trimEnd());
        j++;
      }
      blocks.push({ type: "table", header, divider, rows });
      i = j;
      continue;
    }

    // HTML block
    const htmlMatch = RE_HTML_BLOCK_OPEN.exec(line);
    if (htmlMatch) {
      const tag = htmlMatch[1].toLowerCase();
      const lineOpenRe = new RegExp(`^\\s*<${escapeRegExp(tag)}(?=[\\s/>])`, "i");
      const lineCloseRe = new RegExp(`^\\s*</${escapeRegExp(tag)}(?=[\\s>])`, "i");
      const body: string[] = [line];
      let depth = 1;
      const selfCloseRe = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*/\\s*>`, "i");
      const sameLineCloseRe = new RegExp(`</${escapeRegExp(tag)}(?=[\\s>])`, "i");
      if (selfCloseRe.test(line)) {
        depth = 0;
      } else if (sameLineCloseRe.test(line)) {
        depth = 0;
      }
      i++;
      while (i < n && depth > 0) {
        const cur = lines[i];
        body.push(cur);
        if (lineOpenRe.test(cur)) depth++;
        if (lineCloseRe.test(cur)) depth--;
        i++;
      }
      blocks.push({ type: "html", content: sanitizeHtml(body.join("\n")) });
      continue;
    }

    // Blockquote
    m = RE_BLOCKQUOTE.exec(stripped);
    if (m) {
      const quoteLines: string[] = [];
      while (i < n) {
        const bqMatch = RE_BLOCKQUOTE.exec(lines[i].trimEnd());
        if (!bqMatch) break;
        quoteLines.push(bqMatch[1]);
        i++;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // Ordered or unordered list
    const ordMatch = RE_ORDERED.exec(lines[i]);
    const unordMatch = RE_UNORDERED.exec(lines[i]);
    if (ordMatch || unordMatch) {
      const firstM = ordMatch || unordMatch;
      const baseIndent = firstM![1].length;
      const ordered = Boolean(ordMatch);
      const items: string[] = [];
      let current: string[] = [];

      while (i < n) {
        const curLine = lines[i];

        if (curLine.trim() === "") {
          if (i + 1 < n) {
            const nxt = lines[i + 1];
            const mONext = RE_ORDERED.exec(nxt);
            const mUNext = RE_UNORDERED.exec(nxt);
            if ((mONext || mUNext) && (mONext || mUNext)![1].length >= baseIndent) {
              current.push("");
              i++;
              continue;
            }
            if (nxt.startsWith(" ".repeat(baseIndent + 2)) || nxt.startsWith("\t")) {
              current.push("");
              i++;
              continue;
            }
          }
          break;
        }

        const mO = RE_ORDERED.exec(curLine);
        const mU = RE_UNORDERED.exec(curLine);
        if (mO || mU) {
          const markerIndent = (mO || mU)![1].length;
          if (markerIndent === baseIndent) {
            if (current.length > 0) {
              items.push(current.join("\n").trimEnd());
              current = [];
            }
            current.push(mO ? mO[3] : mU![2]);
            i++;
            continue;
          }
          if (markerIndent > baseIndent) {
            const strip = baseIndent + 2;
            const prefix = curLine.substring(0, strip);
            current.push(prefix.trim() === "" ? curLine.substring(strip) : curLine.trimStart());
            i++;
            continue;
          }
          break;
        }

        if (curLine.startsWith(" ".repeat(baseIndent + 2)) || curLine.startsWith("\t")) {
          const strip = baseIndent + 2;
          const prefix = curLine.substring(0, strip);
          current.push(prefix.trim() === "" ? curLine.substring(strip) : curLine.trimStart());
          i++;
          continue;
        }

        break;
      }
      if (current.length > 0) {
        items.push(current.join("\n").trimEnd());
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph
    const para: string[] = [stripped];
    i++;
    while (i < n) {
      const nxt = lines[i].trimEnd();
      if (!nxt.trim()) break;
      if (
        RE_HEADING.test(nxt) ||
        RE_CODE_FENCE.test(nxt) ||
        RE_HR.test(nxt) ||
        RE_BLOCKQUOTE.test(nxt) ||
        RE_ORDERED.test(nxt) ||
        RE_UNORDERED.test(nxt) ||
        RE_HTML_BLOCK_OPEN.test(lines[i]) ||
        (nxt.includes("|") && i + 1 < n && RE_TABLE_DIVIDER.test(lines[i + 1].trimEnd()))
      ) {
        break;
      }
      // Reset lastIndex for regexes with /g flag
      RE_CODE_FENCE.lastIndex = 0;
      para.push(nxt);
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderTable(header: string, divider: string, rows: string[]): string {
  function splitRow(s: string): string[] {
    s = s.trim();
    if (s.startsWith("|")) s = s.substring(1);
    if (s.endsWith("|")) s = s.substring(0, s.length - 1);
    return s.split("|").map((c) => c.trim());
  }

  const headerCells = splitRow(header);
  const align: string[] = [];
  for (const cell of splitRow(divider)) {
    const c = cell.trim();
    if (c.startsWith(":") && c.endsWith(":")) {
      align.push("center");
    } else if (c.endsWith(":")) {
      align.push("right");
    } else {
      align.push("left");
    }
  }

  function cellAttr(idx: number): string {
    if (idx < align.length && align[idx] !== "left") {
      return ` style="text-align:${align[idx]}"`;
    }
    return "";
  }

  const out: string[] = ["<table>", "<thead><tr>"];
  for (let idx = 0; idx < headerCells.length; idx++) {
    out.push(`<th${cellAttr(idx)}>${renderInline(headerCells[idx])}</th>`);
  }
  out.push("</tr></thead>");
  out.push("<tbody>");
  for (const row of rows) {
    out.push("<tr>");
    const cells = splitRow(row);
    for (let idx = 0; idx < cells.length; idx++) {
      out.push(`<td${cellAttr(idx)}>${renderInline(cells[idx])}</td>`);
    }
    out.push("</tr>");
  }
  out.push("</tbody></table>");
  return out.join("");
}

function renderBlockquote(quoteLines: string[]): string {
  if (quoteLines.length === 0) return "<blockquote></blockquote>";

  let cssClass: string | null = null;
  let title: string | null = null;
  const bodyLines = [...quoteLines];

  let firstNonemptyIdx = 0;
  while (firstNonemptyIdx < bodyLines.length && !bodyLines[firstNonemptyIdx].trim()) {
    firstNonemptyIdx++;
  }

  if (firstNonemptyIdx < bodyLines.length) {
    const line0 = bodyLines[firstNonemptyIdx].trimStart();
    for (const [pattern, klass, defaultTitle] of CALLOUT_PREFIX_MAP) {
      const m = pattern.exec(line0);
      if (m) {
        cssClass = klass;
        title = defaultTitle;
        let rest = line0.substring(m[0].length);
        const mTitle = /^\*\*([^*\n]+?)\*\*[:：\s\-—]+\s*/.exec(rest);
        if (mTitle) {
          title = mTitle[1];
          rest = rest.substring(mTitle[0].length);
        }
        bodyLines[firstNonemptyIdx] = rest;
        pattern.lastIndex = 0;
        break;
      }
      pattern.lastIndex = 0;
    }
  }

  const innerMd = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
  const innerBlocks = innerMd ? parseBlocks(innerMd.split("\n")) : [];
  const [innerHtml] = renderBlocksInternal(innerBlocks, false);

  if (cssClass) {
    const titleHtml = title ? `<div class="callout-title">${escapeHtml(title)}</div>` : "";
    return `<div class="callout ${cssClass}">${titleHtml}${innerHtml}</div>`;
  }
  return `<blockquote>${innerHtml}</blockquote>`;
}

function renderList(ordered: boolean, items: string[]): string {
  const tag = ordered ? "ol" : "ul";
  const out: string[] = [`<${tag}>`];
  for (const item of items) {
    const itemBlocks = parseBlocks(item.split("\n"));
    if (itemBlocks.length === 1 && itemBlocks[0].type === "paragraph") {
      out.push(`<li>${renderInline(itemBlocks[0].text!)}</li>`);
    } else {
      const [inner] = renderBlocksInternal(itemBlocks, false);
      out.push(`<li>${inner}</li>`);
    }
  }
  out.push(`</${tag}>`);
  return out.join("");
}

function renderCode(lang: string, content: string, flags?: Set<string>): string {
  const escaped = escapeHtml(content);
  let attr = "";
  if (flags) {
    if (flags.has("collapsed")) {
      attr = ' data-collapse="collapsed"';
    } else if (flags.has("open")) {
      attr = ' data-collapse="open"';
    }
  }
  if (lang) {
    return `<pre${attr}><code class="language-${escapeHtml(lang, true)}">${escaped}</code></pre>`;
  }
  const diagramChars = new Set("│─┌┐└┘├┤┬┴┼▲▼◀▶━┃┏┓┗┛╭╮╰╯═║╔╗╚╝╠╣╦╩╬║▶▼─");
  const sample = content.substring(0, 200);
  let diagramCount = 0;
  for (const c of sample) {
    if (diagramChars.has(c)) diagramCount++;
  }
  if (sample && diagramCount >= 4) {
    return `<pre${attr} class="diagram"><code>${escaped}</code></pre>`;
  }
  return `<pre${attr}><code>${escaped}</code></pre>`;
}

interface TocEntry {
  level: number;
  id: string;
  text: string;
}

function renderBlocksInternal(
  blocks: Block[],
  collectToc: boolean,
  usedIds?: Map<string, number>,
): [string, TocEntry[]] {
  if (!usedIds) usedIds = new Map();
  const out: string[] = [];
  const toc: TocEntry[] = [];

  for (const b of blocks) {
    if (b.type === "heading") {
      const level = b.level!;
      const text = b.text!;
      const inline = renderInline(text);
      const baseId = slugify(text);
      const count = usedIds.get(baseId) ?? 0;
      const uid = count > 0 ? `${baseId}-${count}` : baseId;
      usedIds.set(baseId, count + 1);
      out.push(`<h${level} id="${uid}">${inline}</h${level}>`);
      if (collectToc && level >= 2 && level <= 3) {
        toc.push({ level, id: uid, text });
      }
    } else if (b.type === "paragraph") {
      out.push(`<p>${renderInline(b.text!)}</p>`);
    } else if (b.type === "hr") {
      out.push("<hr />");
    } else if (b.type === "code") {
      out.push(renderCode(b.lang ?? "", b.content!, b.flags));
    } else if (b.type === "blockquote") {
      out.push(renderBlockquote(b.lines!));
    } else if (b.type === "list") {
      out.push(renderList(b.ordered!, b.items!));
    } else if (b.type === "table") {
      out.push(renderTable(b.header!, b.divider!, b.rows!));
    } else if (b.type === "html") {
      out.push(renderHtmlBlock(b.content!));
    } else {
      out.push(`<!-- unknown block: ${escapeHtml(b.type)} -->`);
    }
  }
  return [out.join("\n"), toc];
}

function renderHtmlBlock(content: string): string {
  const lines = content.split("\n");
  if (!lines.length || !lines[0].trimStart().toLowerCase().startsWith("<details")) {
    return content;
  }

  let openEnd = 1;
  const summaryCloseRe = /<\/summary\s*>/i;
  for (let j = 1; j < lines.length; j++) {
    if (summaryCloseRe.test(lines[j])) {
      openEnd = j + 1;
      break;
    }
    if (lines[j].trim() && !/^\s*<summary/i.test(lines[j])) {
      break;
    }
  }

  let closeStart = lines.length - 1;
  const closeRe = /^\s*<\/details\s*>/i;
  while (closeStart > 0 && !closeRe.test(lines[closeStart])) {
    closeStart--;
  }

  if (openEnd >= closeStart) return content;

  const openPart = lines.slice(0, openEnd).join("\n");
  const innerMd = lines
    .slice(openEnd, closeStart)
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const closePart = lines.slice(closeStart).join("\n");

  if (!innerMd.trim()) return content;

  const innerBlocks = parseBlocks(innerMd.split("\n"));
  const [innerHtml] = renderBlocksInternal(innerBlocks, false);
  return `${openPart}\n${innerHtml}\n${closePart}`;
}

function renderToc(toc: TocEntry[]): string {
  if (toc.length === 0) return "";

  const grouped: Array<[TocEntry, TocEntry[]]> = [];
  let currentParent: TocEntry | null = null;
  let currentChildren: TocEntry[] = [];

  for (const entry of toc) {
    if (entry.level === 2) {
      if (currentParent !== null) {
        grouped.push([currentParent, currentChildren]);
      }
      currentParent = entry;
      currentChildren = [];
    } else if (entry.level === 3) {
      if (currentParent === null) {
        grouped.push([entry, []]);
      } else {
        currentChildren.push(entry);
      }
    }
  }
  if (currentParent !== null) {
    grouped.push([currentParent, currentChildren]);
  }

  const out: string[] = ["<ol>"];
  for (const [parent, children] of grouped) {
    const pid = escapeHtml(parent.id, true);
    const ptext = escapeHtml(parent.text);
    out.push(`<li><a href="#${pid}">${ptext}</a>`);
    if (children.length > 0) {
      out.push("<ul>");
      for (const c of children) {
        const cid = escapeHtml(c.id, true);
        const ctext = escapeHtml(c.text);
        out.push(`<li><a href="#${cid}">${ctext}</a></li>`);
      }
      out.push("</ul>");
    }
    out.push("</li>");
  }
  out.push("</ol>");
  return out.join("\n");
}

function stripFrontmatter(md: string): string {
  let s = md.replace(/^﻿/, "");
  const lines = s.split("\n", 2);
  if (!lines.length || lines[0].trim() !== "---") return s;
  const fullRest = s.substring(s.indexOf("\n") + 1);
  const parts = fullRest.split("\n---\n", 2);
  if (parts.length === 2) return parts[1].replace(/^\n+/, "");
  const parts2 = fullRest.split("\n---", 2);
  if (parts2.length === 2 && (parts2[1] === "" || parts2[1].startsWith("\n"))) {
    return parts2[1].replace(/^\n+/, "");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Template loading + main
// ---------------------------------------------------------------------------

const CDN_BLOCK_FULL = `<!-- MathJax 3 -->
<script>
window.MathJax = {
  tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']], processEscapes: true },
  options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] }
};
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></script>

<!-- highlight.js -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-light.min.css">
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<script>document.addEventListener('DOMContentLoaded', () => hljs.highlightAll());</script>
`;

const CDN_BLOCK_OFFLINE =
  "<!-- offline mode: MathJax + highlight.js skipped; math and code blocks render as plain text -->";

function loadTemplate(name: string): string {
  const tmplPath = path.join(TEMPLATES_DIR, `${name}.html`);
  if (!fs.existsSync(tmplPath)) {
    const available = fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.replace(/\.html$/, ""));
    console.error(
      `error: template '${name}' not found at ${tmplPath}. Available: [${available.join(", ")}]`,
    );
    process.exit(1);
  }
  return fs.readFileSync(tmplPath, "utf-8");
}

function sha256Of(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function renderJsonAsPre(jsonPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, "utf-8");
  } catch {
    return `<div class="callout callout-bad"><div class="callout-title">JSON read error</div><p>Could not read ${escapeHtml(jsonPath)}</p></div>`;
  }
  let pretty: string;
  try {
    const obj = JSON.parse(raw);
    pretty = JSON.stringify(obj, null, 2);
  } catch (e) {
    return `<div class="callout callout-bad"><div class="callout-title">JSON parse error</div><p>${escapeHtml(String(e))}</p></div>`;
  }
  return (
    `<details><summary>Sidecar JSON: <code>${escapeHtml(jsonPath)}</code></summary>` +
    `<pre><code class="language-json">${escapeHtml(pretty)}</code></pre>` +
    `</details>`
  );
}

function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

function jsonForScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function repoRelative(inputPath: string): string {
  try {
    return path.relative(process.cwd(), inputPath);
  } catch {
    // fall through
  }
  try {
    const result = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path.dirname(inputPath),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const gitRoot = result.trim();
    try {
      return path.relative(gitRoot, inputPath);
    } catch {
      // fall through
    }
  } catch {
    // no git
  }
  return path.basename(inputPath);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = createCli("render-html", "Render an ARIS Markdown artifact to single-file HTML");

program
  .argument("<input>", "Path to input .md (or .json — wrapped in a <pre>)")
  .option("--template <name>", "Template name", "academic")
  .option("--out <path>", "Output HTML path (default: <input>.html)")
  .option("--title <title>", "Page title (default: first H1, or filename)")
  .option("--subtitle <text>", "Optional italic subtitle line", "")
  .option("--eyebrow <text>", "Optional uppercase eyebrow above H1", "")
  .option("--author <text>", "Optional author byline", "")
  .option("--lang <lang>", '<html lang="…"> attribute', "zh-CN")
  .option("--state <path>", "Optional sidecar state JSON to append as <details>")
  .option("--json <path>", "Optional sidecar JSON to append")
  .option("--offline", "Skip MathJax / highlight.js CDN blocks")
  .option("--no-toc", "Skip TOC sidebar")
  .option("--papers <path>", "Sidecar JSON file with paper registry for [[key]] popovers")
  .option("--blog-mode", "Enable blog/talk mode")
  .option("--collapse-code-min <n>", "Auto-collapse code blocks with >= N lines", "30")
  .action(
    (
      inputFile: string,
      opts: {
        template: string;
        out?: string;
        title?: string;
        subtitle: string;
        eyebrow: string;
        author: string;
        lang: string;
        state?: string;
        json?: string;
        offline?: boolean;
        toc: boolean;
        papers?: string;
        blogMode?: boolean;
        collapseCodeMin: string;
      },
    ) => {
      const inputPath = path.resolve(inputFile);
      if (!fs.existsSync(inputPath)) {
        console.error(`error: input not found: ${inputPath}`);
        process.exit(2);
      }

      const displaySourcePath = repoRelative(inputPath);
      const raw = fs.readFileSync(inputPath, "utf-8");
      const sourceHash = sha256Of(raw);

      const isJson = path.extname(inputPath).toLowerCase() === ".json";
      let mdSource: string;
      if (isJson) {
        let pretty: string;
        try {
          const obj = JSON.parse(raw);
          pretty = JSON.stringify(obj, null, 2);
        } catch {
          pretty = raw;
        }
        mdSource = `# ${path.basename(inputPath)}\n\n\`\`\`json\n${pretty}\n\`\`\`\n`;
      } else {
        mdSource = stripFrontmatter(raw);
      }

      const blocks = parseBlocks(mdSource.split("\n"));
      const noToc = !opts.toc;
      const [bodyHtmlBase, toc] = renderBlocksInternal(blocks, !noToc);

      // Title autodetection
      let title = opts.title;
      if (!title) {
        for (const b of blocks) {
          if (b.type === "heading" && b.level === 1) {
            title = b.text;
            break;
          }
        }
        if (!title) {
          title = path
            .basename(inputPath, path.extname(inputPath))
            .replace(/_/g, " ")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
        }
      }

      // Append sidecar JSON if requested
      const extraBlocks: string[] = [];
      for (const [label, pathStr] of [
        ["state", opts.state],
        ["json", opts.json],
      ] as const) {
        if (pathStr) {
          const p = path.resolve(pathStr);
          if (fs.existsSync(p)) {
            extraBlocks.push(
              `<h2 id="sidecar-${label}">Sidecar — <code>${escapeHtml(path.basename(p))}</code></h2>`,
            );
            extraBlocks.push(renderJsonAsPre(p));
          } else {
            extraBlocks.push(
              `<div class="callout callout-warn"><div class="callout-title">Sidecar missing</div>` +
                `<p><code>${escapeHtml(pathStr)}</code> not found.</p></div>`,
            );
          }
        }
      }

      let bodyHtml = bodyHtmlBase;
      if (extraBlocks.length > 0) {
        bodyHtml += "\n" + extraBlocks.join("\n");
      }

      if (!["academic", "dashboard"].includes(opts.template)) {
        console.error(`error: template must be 'academic' or 'dashboard', got '${opts.template}'`);
        process.exit(2);
      }
      const templateStr = loadTemplate(opts.template);

      const tocHtml = noToc ? "" : renderToc(toc);
      const tocLabel = noToc ? "" : "Contents";

      const eyebrowBlock = opts.eyebrow
        ? `<div class="eyebrow">${escapeHtml(opts.eyebrow)}</div>`
        : "";
      const subtitleBlock = opts.subtitle
        ? `<p class="subtitle">${escapeHtml(opts.subtitle)}</p>`
        : "";
      const bylineBlock = opts.author
        ? `<p class="byline">By <strong>${escapeHtml(opts.author)}</strong></p>`
        : "";

      const now = new Date();
      const generatedAt = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;

      // Paper registry sidecar
      let papersJson = "{}";
      if (opts.papers) {
        const p = path.resolve(opts.papers);
        if (fs.existsSync(p)) {
          try {
            const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
            papersJson = jsonForScript(obj);
          } catch (e) {
            console.error(`warning: --papers JSON parse error: ${e}`);
          }
        } else {
          console.error(`warning: --papers file not found: ${p}`);
        }
      }

      const vars: Record<string, string> = {
        LANG: escapeHtml(opts.lang, true),
        TITLE: escapeHtml(title),
        SUBTITLE_BLOCK: subtitleBlock,
        EYEBROW_BLOCK: eyebrowBlock,
        BYLINE_BLOCK: bylineBlock,
        SOURCE_PATH: escapeHtml(displaySourcePath),
        SOURCE_SHA256: sourceHash,
        SOURCE_SHA256_SHORT: sourceHash.substring(0, 12),
        GENERATED_AT: generatedAt,
        HEAD_CDN: opts.offline ? CDN_BLOCK_OFFLINE : CDN_BLOCK_FULL,
        TOC_HTML: tocHtml,
        TOC_LABEL: tocLabel,
        BODY_HTML: bodyHtml,
        EXTRA_META: "",
        PAPER_REGISTRY_JSON: papersJson,
        COLLAPSE_CODE_MIN: opts.collapseCodeMin,
        BODY_CLASS: opts.blogMode ? "aris-blog" : "",
      };

      const rendered = substitute(templateStr, vars);

      let outPath: string;
      if (opts.out) {
        outPath = path.resolve(opts.out);
      } else {
        const dir = path.dirname(inputPath);
        const base = path.basename(inputPath, path.extname(inputPath));
        outPath = path.join(dir, `${base}.html`);
      }

      if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
        console.error(
          `error: --out points to a directory: ${outPath}. Specify a file path ending in .html.`,
        );
        process.exit(2);
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, rendered, "utf-8");
      console.log(
        `wrote ${outPath} (${rendered.length.toLocaleString()} bytes, ${toc.length} TOC entries, source sha256 ${sourceHash.substring(0, 12)}...)`,
      );
    },
  );

runCli(program);
