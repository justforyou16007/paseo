import fs from "fs";
import path from "path";
import { asciiSafe } from "./textutil.js";

const KNOWN_ROLES = new Set([
  "poster",
  "header",
  "banner",
  "body",
  "column",
  "card",
  "hero",
  "footer-strip",
  "footer",
]);

const ROLE_PARENTS: Record<string, string[]> = {
  header: ["poster"],
  banner: ["poster"],
  body: ["poster"],
  "footer-strip": ["poster", "body"],
  footer: ["poster", "body"],
  column: ["body", "poster"],
  hero: ["body", "poster"],
  card: ["column", "hero"],
};

const LATEX_PATTERNS: [RegExp, string][] = [
  [/\\ref\{/g, "\\ref{...} residue"],
  [/\\cite\{/g, "\\cite{...} residue"],
  [/\\textbf\{/g, "\\textbf{...} residue (use <b> or **bold**)"],
  [/\\textit\{/g, "\\textit{...} residue (use <i> or *italic*)"],
  [/\\emph\{/g, "\\emph{...} residue"],
  [/\\section\{/g, "\\section{...} residue"],
  [/\\label\{/g, "\\label{...} residue"],
  [/\\begin\{/g, "\\begin{...} residue (use HTML structures)"],
  [/\\end\{/g, "\\end{...} residue"],
  [/(?<![\\a-zA-Z])\\\s/g, "backslash-space '\\ ' (will render literally)"],
];

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "menuitem",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function newlinePreservingSub(pattern: RegExp, html: string): string {
  return html.replace(pattern, (match) => {
    let count = 0;
    for (const ch of match) {
      if (ch === "\n") count++;
    }
    return "\n".repeat(count);
  });
}

export function stripForLint(html: string): string {
  return newlinePreservingSub(
    /<!--.*?-->|<style[^>]*>.*?<\/style>|<script[^>]*>.*?<\/script>/gis,
    html,
  );
}

export function findMathSegments(
  text: string,
): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];

  // $$...$$
  const ddollar = /\$\$(.+?)\$\$/gs;
  let m: RegExpExecArray | null;
  while ((m = ddollar.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
  }
  // \[...\]
  const brack = /\\\[(.+?)\\\]/gs;
  while ((m = brack.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
  }

  const covered = out.map((o) => [o.start, o.end] as [number, number]);

  // $...$ single-line, not inside $$
  const dollar = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;
  while ((m = dollar.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (covered.some(([cs, ce]) => (cs <= s && s < ce) || (cs < e && e <= ce))) continue;
    out.push({ start: s, end: e, body: m[1] });
  }
  // \(...\) single-line
  const paren = /\\\(([^\n]+?)\\\)/g;
  while ((m = paren.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (covered.some(([cs, ce]) => (cs <= s && s < ce) || (cs < e && e <= ce))) continue;
    out.push({ start: s, end: e, body: m[1] });
  }

  return out;
}

function delimLabel(segment: string): string {
  if (segment.startsWith("$$") && segment.endsWith("$$")) return "$$...$$";
  if (segment.startsWith("$") && segment.endsWith("$")) return "$...$";
  if (segment.startsWith("\\[")) return "\\[...\\]";
  if (segment.startsWith("\\(")) return "\\(...\\)";
  return "math";
}

interface RoleRecord {
  role: string;
  parentRole: string | null;
  line: number;
  tag: string;
}

interface StrayClose {
  tag: string;
  line: number;
}

export function checkRoleNesting(html: string): { roles: RoleRecord[]; strayCloses: StrayClose[] } {
  const stack: Array<{ tag: string; role: string | null; line: number }> = [];
  const roles: RoleRecord[] = [];
  const strayCloses: StrayClose[] = [];

  let lineNum = 1;
  let pos = 0;

  function advanceLine(upTo: number): void {
    for (let i = pos; i < upTo && i < html.length; i++) {
      if (html[i] === "\n") lineNum++;
    }
    pos = upTo;
  }

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)(\s*\/\s*)?>/g;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(html)) !== null) {
    advanceLine(tm.index);
    const fullMatch = tm[0];
    const tagName = tm[1].toLowerCase();
    const attrsStr = tm[2];
    const selfClose = !!tm[3];
    const isClose = fullMatch.startsWith("</");

    if (isClose) {
      let found = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tagName) {
          stack.splice(i);
          found = true;
          break;
        }
      }
      if (!found) {
        strayCloses.push({ tag: tagName, line: lineNum });
      }
      continue;
    }

    let role: string | null = null;
    const roleMatch = attrsStr.match(/data-measure-role\s*=\s*["']([^"']+)["']/);
    if (roleMatch) {
      role = roleMatch[1].trim();
    }

    if (role !== null) {
      let parentRole: string | null = null;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].role !== null) {
          parentRole = stack[i].role;
          break;
        }
      }
      roles.push({ role, parentRole, line: lineNum, tag: tagName });
    }

    if (!selfClose && !VOID_TAGS.has(tagName)) {
      stack.push({ tag: tagName, role, line: lineNum });
    }
  }

  return { roles, strayCloses };
}

export interface PreflightArgs {
  html: string;
}

export function cmdPreflight(args: PreflightArgs): number {
  const htmlPath = path.resolve(args.html);
  if (!fs.existsSync(htmlPath)) {
    process.stderr.write(`ERROR: HTML not found: ${asciiSafe(htmlPath)}\n`);
    return 2;
  }
  const raw = fs.readFileSync(htmlPath, "utf-8");
  const body = stripForLint(raw);

  const problems: string[] = [];
  const warnings: string[] = [];

  // 0) Unclosed <style>/<script>/<!--
  const mOpen = body.match(/<!--|<style\b|<script\b/i);
  if (mOpen && mOpen.index !== undefined) {
    const ln = body.substring(0, mOpen.index).split("\n").length;
    problems.push(
      `L${ln}: unclosed '${asciiSafe(mOpen[0])}' block -- add ` +
        `the matching '-->', '</style>', or '</script>'. The browser ` +
        `would otherwise swallow the rest of the poster into it.`,
    );
  }

  // 1) LaTeX residue
  for (const [pat, desc] of LATEX_PATTERNS) {
    const re = new RegExp(pat.source, pat.flags);
    let lm: RegExpExecArray | null;
    while ((lm = re.exec(body)) !== null) {
      const ln = body.substring(0, lm.index).split("\n").length;
      problems.push(`L${ln}: ${desc} -> '${asciiSafe(lm[0])}'`);
    }
  }

  // 2) Raw '<' inside math segments
  for (const seg of findMathSegments(body)) {
    const bodyOffsetInBody = body.indexOf(seg.body, seg.start);
    const offset = bodyOffsetInBody === -1 ? seg.start : bodyOffsetInBody;
    const rawLt = /(?<!\\)<(?![=/!])/g;
    let lm: RegExpExecArray | null;
    while ((lm = rawLt.exec(seg.body)) !== null) {
      const absOffset = offset + lm.index;
      const ln = body.substring(0, absOffset).split("\n").length;
      const label = delimLabel(body.substring(seg.start, seg.end));
      problems.push(
        `L${ln}: raw '<' inside ${label} ` +
          `'${asciiSafe(seg.body.trim().substring(0, 60))}' -- use \\lt`,
      );
    }
  }

  // 3) Image src
  const srcRe = /src\s*=\s*["']([^"']+)["']/gi;
  let sm: RegExpExecArray | null;
  while ((sm = srcRe.exec(body)) !== null) {
    const src = sm[1];
    const srcL = src.toLowerCase();
    if (srcL.startsWith("data:")) continue;
    if (srcL.startsWith("http://") || srcL.startsWith("https://") || srcL.startsWith("//")) {
      const ln = body.substring(0, sm.index).split("\n").length;
      warnings.push(
        `L${ln}: remote image '${asciiSafe(src.substring(0, 60))}' -- inline or ` +
          `localize it; a print poster should not depend on a CDN at render time`,
      );
      continue;
    }
    let localPath: string;
    try {
      const urlPath = new URL(src, "file:///").pathname;
      localPath = decodeURIComponent(urlPath);
    } catch {
      localPath = src;
    }
    const candidate = path.resolve(path.dirname(htmlPath), localPath);
    if (!fs.existsSync(candidate)) {
      const ln = body.substring(0, sm.index).split("\n").length;
      problems.push(`L${ln}: missing local image '${asciiSafe(src)}'`);
    }
  }

  // 4) data-measure-role="poster" required
  if (!/data-measure-role\s*=\s*["']poster["']/.test(body)) {
    problems.push('missing required data-measure-role="poster" on root');
  }

  // 5) Unknown role values
  const roleRe = /data-measure-role\s*=\s*["']([^"']+)["']/g;
  let rm: RegExpExecArray | null;
  while ((rm = roleRe.exec(body)) !== null) {
    const role = rm[1].trim();
    if (!KNOWN_ROLES.has(role)) {
      const ln = body.substring(0, rm.index).split("\n").length;
      problems.push(
        `L${ln}: unknown data-measure-role='${asciiSafe(role)}' ` +
          `(allowed: ${[...KNOWN_ROLES].sort()})`,
      );
    }
  }

  // 6) Role nesting
  const { roles: roleRecords } = checkRoleNesting(raw);
  for (const rec of roleRecords) {
    const expected = ROLE_PARENTS[rec.role];
    if (!expected) continue;
    if (rec.parentRole !== null && expected.includes(rec.parentRole)) continue;
    if (rec.parentRole === null || !expected.includes(rec.parentRole)) {
      const shownParent = rec.parentRole !== null ? rec.parentRole : "(document root)";
      problems.push(
        `L${rec.line}: data-measure-role='${asciiSafe(rec.role)}' is nested ` +
          `inside ${asciiSafe(shownParent)}; expected parent role ` +
          `in ${expected.sort()}. A misplaced \`</div>\` is the usual ` +
          `cause -- it closes a grid container early so the role ` +
          `ends up outside its layout slot.`,
      );
    }
  }

  // 7) Soft sanity
  if (!/<title[^>]*>.+?<\/title>/s.test(raw)) {
    warnings.push("no <title> set");
  }
  if (!/<h1\b/.test(raw)) {
    warnings.push("no <h1> -- poster title block usually carries one");
  }

  console.log(`[preflight] ${asciiSafe(htmlPath)}`);
  console.log(`  problems: ${problems.length}   warnings: ${warnings.length}`);
  for (const w of warnings) {
    console.log(`  WARN: ${w}`);
  }
  for (const p of problems) {
    process.stderr.write(`  FAIL: ${p}\n`);
  }

  if (problems.length > 0) {
    return 1;
  }
  console.log("[preflight] PASS");
  return 0;
}

export function hasRequiredRolesInHtml(htmlPath: string): Record<string, number> {
  const raw = fs.readFileSync(htmlPath, "utf-8");
  const body = stripForLint(raw);
  const counts: Record<string, number> = {};
  for (const role of KNOWN_ROLES) {
    counts[role] = 0;
  }
  const re = /data-measure-role\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const role = m[1].trim();
    if (role in counts) {
      counts[role]++;
    }
  }
  return counts;
}
