import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const FAMILY: [string, string[]][] = [
  ["anthropic", ["claude", "opus", "sonnet", "haiku"]],
  ["openai", ["gpt", "codex", "oracle", "chatgpt", "o1", "o3", "o4"]],
  ["google", ["gemini", "palm", "bard"]],
  ["deepseek", ["deepseek"]],
  ["minimax", ["minimax", "abab"]],
  ["moonshot", ["kimi", "moonshot"]],
  ["qwen", ["qwen", "tongyi"]],
  ["xai", ["grok"]],
  ["meta", ["llama"]],
  ["mistral", ["mistral", "mixtral"]],
];
const SHORT = new Set(["o1", "o3", "o4"]);

export function modelFamily(name: string): string {
  const n = (name ?? "").trim().toLowerCase();
  if (n.startsWith("deterministic:") || n === "deterministic") {
    return "deterministic";
  }
  const tokens = new Set(n.split(/[^a-z0-9.]+/).filter(Boolean));
  const matched = new Set<string>();
  for (const [fam, needles] of FAMILY) {
    if (needles.some((k) => (SHORT.has(k) ? tokens.has(k) : n.includes(k)))) {
      matched.add(fam);
    }
  }
  return matched.size === 1 ? [...matched][0]! : "unknown";
}

export function assertCrossFamily(authorModel: string, reviewerModel: string): void {
  const fr = modelFamily(reviewerModel);
  if (fr === "deterministic") return;
  const fa = modelFamily(authorModel);
  if (fa === "unknown" || fr === "unknown") {
    throw new Error(
      `unrecognized model family for author=${authorModel} (${fa}) / ` +
        `reviewer=${reviewerModel} (${fr}) — cannot assert the cross-model ` +
        `invariant; use a recognized reviewer or a 'deterministic:<verifier>'.`,
    );
  }
  if (fa === fr) {
    throw new Error(
      `author (${authorModel}=${fa}) and reviewer (${reviewerModel}=${fr}) are ` +
        `the SAME model family — self-acquittal is forbidden. The reviewer must ` +
        `be a different family (e.g. executor=Claude → reviewer=codex/gemini) ` +
        `or a deterministic verifier.`,
    );
  }
}

export function contentHash(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sidecar(target: string): string {
  const stat = fs.existsSync(target) && fs.statSync(target);
  if (stat && stat.isDirectory()) {
    return path.join(target, ".provenance.json");
  }
  const p = path.parse(target);
  return path.join(p.dir, p.base + ".provenance.json");
}

export function stamp(
  target: string,
  authorModel: string,
  reviewerModel: string,
  verdictId: string,
  createdBy = "aris-auto",
  ts?: string,
): Record<string, unknown> {
  if (!verdictId) {
    throw new Error(
      "provenance requires a non-empty verdict_id (the reviewer's " +
        "thread/trace id, or the verifier report path/sha).",
    );
  }
  assertCrossFamily(authorModel, reviewerModel);

  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
  const skillMd = path.join(target, "SKILL.md");
  const hashTarget = isDir && fs.existsSync(skillMd) ? skillMd : target;
  const hashTargetExists = fs.existsSync(hashTarget) && fs.statSync(hashTarget).isFile();

  const record: Record<string, unknown> = {
    created_by: createdBy,
    author_model: authorModel,
    author_family: modelFamily(authorModel),
    reviewer_model: reviewerModel,
    reviewer_family: modelFamily(reviewerModel),
    verdict_id: verdictId,
    content_hash: hashTargetExists ? contentHash(hashTarget) : null,
    stamped_at: ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  fs.writeFileSync(sidecar(target), JSON.stringify(record, null, 2), "utf-8");
  return record;
}

export function read(target: string): Record<string, unknown> | null {
  const sc = sidecar(target);
  if (!fs.existsSync(sc)) return null;
  return JSON.parse(fs.readFileSync(sc, "utf-8")) as Record<string, unknown>;
}

export function isAutoAuthored(target: string): boolean {
  const rec = read(target);
  return Boolean(rec && rec["created_by"] === "aris-auto");
}

const program = createCli("provenance", "ARIS provenance-as-authorization.");

program
  .command("stamp")
  .argument("<target>")
  .requiredOption("--author <author>")
  .requiredOption("--reviewer <reviewer>")
  .requiredOption("--verdict-id <verdictId>")
  .action((target: string, opts: { author: string; reviewer: string; verdictId: string }) => {
    const result = stamp(target, opts.author, opts.reviewer, opts.verdictId);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("read")
  .argument("<target>")
  .action((target: string) => {
    const rec = read(target);
    if (rec) {
      console.log(JSON.stringify(rec, null, 2));
    } else {
      console.log("no provenance record");
      process.exit(1);
    }
  });

program
  .command("is-auto")
  .argument("<target>")
  .action((target: string) => {
    const ok = isAutoAuthored(target);
    console.log(ok ? "aris-auto" : "not aris-auto (canonical/user — off-limits to auto-curation)");
    if (!ok) process.exit(1);
  });

program
  .command("check")
  .requiredOption("--author <author>")
  .requiredOption("--reviewer <reviewer>")
  .action((opts: { author: string; reviewer: string }) => {
    try {
      assertCrossFamily(opts.author, opts.reviewer);
      console.log(`OK: ${modelFamily(opts.author)} ≠ ${modelFamily(opts.reviewer)} (cross-family)`);
    } catch (e) {
      console.error(`REJECTED: ${(e as Error).message}`);
      process.exit(1);
    }
  });

runCli(program);
