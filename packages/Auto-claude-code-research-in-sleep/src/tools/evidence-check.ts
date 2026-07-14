#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const _NUM_CORE = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;

const _BEFORE_OK = String.raw`\s=(\[{"`;
const _AFTER_OK = String.raw`\s)\]}";,.`;
const _NUM_TOKEN_RE = new RegExp(
  String.raw`(?<![^${_BEFORE_OK}])(${_NUM_CORE})(%?)(?=[${_AFTER_OK}]|$)(?![.,]\d)`,
  "g",
);
const _WS_GROUP_TAIL = /\d\s+$/;
const _WS_GROUP_LEAD = /^\s+\d{3}(?!\d)/;
const _GROUP_TAIL_TOK = /^\d{3}(?:\.\d+)?$/;
const _PURE_NUMBER_RE = new RegExp(`^${_NUM_CORE}$`);

function dec(s: string): string {
  return s.replace(/,/g, "").trim();
}

function pureNumber(s: string): { value: string; hasPercent: boolean } | null {
  const v = s.trim();
  const hasPercent = v.endsWith("%");
  const core = hasPercent ? v.slice(0, -1).trim() : v;
  if (!_PURE_NUMBER_RE.test(core)) return null;
  const d = dec(core);
  if (d === "" || isNaN(Number(d))) return null;
  return { value: d, hasPercent };
}

function decimalEqual(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (isNaN(na) || isNaN(nb)) return false;
  if (na === nb) return true;
  return a === b;
}

function valueInText(value: string, text: string): boolean {
  if (!value.trim()) return false;
  const pn = pureNumber(value);
  if (pn !== null) {
    const { value: dval, hasPercent: wantPct } = pn;
    _NUM_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _NUM_TOKEN_RE.exec(text)) !== null) {
      const tok = m[1];
      if (_GROUP_TAIL_TOK.test(tok) && _WS_GROUP_TAIL.test(text.slice(0, m.index))) {
        continue;
      }
      if (_WS_GROUP_LEAD.test(text.slice(m.index + m[0].length))) {
        continue;
      }
      const tnum = dec(tok);
      if (tnum === "" || isNaN(Number(tnum))) continue;
      if (decimalEqual(tnum, dval) && (m[2] === "%") === wantPct) {
        return true;
      }
    }
    return false;
  }
  const norm = text.replace(/\s+/g, " ");
  return norm.includes(value.trim());
}

function resolveSources(source: string, root: string): string[] {
  const p = path.join(root, source);
  try {
    if (fs.statSync(p).isFile()) return [p];
  } catch {
    // not a direct file, try glob
  }
  if (!source.includes("*") && !source.includes("?")) return [];
  try {
    const matches = (
      fs as unknown as { globSync: (pattern: string, opts: { cwd: string }) => string[] }
    ).globSync(source, { cwd: root });
    return matches
      .map((m: string) => path.join(root, m))
      .filter((f: string) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

interface ClaimResult {
  status: "verified" | "path_missing" | "value_not_found";
  value: string;
  source: string;
  detail: string;
}

export function checkClaim(value: string, source: string, root = "."): ClaimResult {
  const files = resolveSources(source, root);
  if (files.length === 0) {
    return {
      status: "path_missing",
      value,
      source,
      detail: `no file matches '${source}' under '${root}'`,
    };
  }
  let readAny = false;
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    readAny = true;
    if (valueInText(value, text)) {
      return {
        status: "verified",
        value,
        source: f,
        detail: `'${value}' found in ${f}`,
      };
    }
  }
  if (!readAny) {
    return {
      status: "path_missing",
      value,
      source,
      detail: `file(s) matching '${source}' exist but are unreadable`,
    };
  }
  return {
    status: "value_not_found",
    value,
    source,
    detail: `'${value}' not found in '${source}' (${files.length} file(s) checked) — send to the cross-model jury`,
  };
}

interface BatchResult {
  results: Array<Record<string, unknown>>;
  summary: Record<string, number>;
}

export function checkBatch(claims: Array<Record<string, unknown>>, root = "."): BatchResult {
  const results: Array<Record<string, unknown>> = [];
  for (const c of claims) {
    const value = c.value as string | null | undefined;
    const source = c.source as string | null | undefined;
    if (
      value === undefined ||
      value === null ||
      source === undefined ||
      source === null ||
      String(value).trim() === "" ||
      String(source).trim() === ""
    ) {
      results.push({
        ...c,
        status: "unparseable",
        detail: "claim has no usable (value, source) to pre-check",
      });
    } else {
      results.push({ ...c, ...checkClaim(String(value), String(source), root) });
    }
  }
  const counts: Record<string, number> = {};
  for (const r of results) {
    const s = r.status as string;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return { results, summary: counts };
}

const program = createCli("evidence-check", "ARIS deterministic evidence pre-check.");
program.argument("<root>", "project root the sources are relative to");
program.option("--value <value>", "the cited value (number/string)");
program.option("--source <source>", "the cited source file or glob (relative to root)");
program.option("--batch <file>", "JSON file with a list of {value, source, ...} claims");
program.action((root: string, opts: { value?: string; source?: string; batch?: string }) => {
  if (opts.batch) {
    const raw = fs.readFileSync(opts.batch, "utf-8");
    const claims = JSON.parse(raw) as Array<Record<string, unknown>>;
    const out = checkBatch(claims, root);
    console.log(JSON.stringify(out, null, 2));
    const bad = new Set(["path_missing", "value_not_found"]);
    const hasBad = out.results.some((r) => bad.has(r.status as string));
    process.exit(hasBad ? 1 : 0);
  }
  if (!opts.value || !opts.source) {
    console.error("error: provide --value and --source, or --batch");
    process.exit(1);
  }
  const res = checkClaim(opts.value, opts.source, root);
  console.log(JSON.stringify(res));
  process.exit(res.status === "verified" ? 0 : 1);
});

runCli(program);
