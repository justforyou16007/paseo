import fs from "fs";
import { createCli, runCli } from "../lib/cli.js";

const TOOL =
  "(?:" +
  "codex[ -](?:mcp|cli|reviewer)|" +
  "oracle[ -](?:mcp|pro|reviewer)|" +
  "gemini[ -](?:mcp|cli|review|reviewer)|" +
  "manual[ -]review|" +
  "mcp server|reviewer mcp|the reviewer backend|" +
  "wandb" +
  ")";

const ENV_FAILURE: [RegExp, string][] = [
  [/\bcommand not found\b/i, "env_failure"],
  [/\bNo such file or directory\b/i, "env_failure"],
  [/\bNo module named\b/i, "env_failure"],
  [/\bModuleNotFoundError\b/, "env_failure"],
  [/\bImportError\b/, "env_failure"],
  [/\bPermission denied\b/i, "env_failure"],
  [/\bconnection (refused|timed out|reset)\b/i, "transient_error"],
  [/\b(rate limit|429|quota exceeded|503|502|temporarily unavailable)\b/i, "transient_error"],
  [/\bCUDA out of memory\b|\bOOM\b/i, "transient_error"],
];

const NEG_CLAIM: [RegExp, string][] = [
  [
    new RegExp(TOOL + String.raw`\s+(?:can'?t|cannot|is unable to|does(?:n'?t| not))\s+`, "i"),
    "negative_tool_claim",
  ],
  [
    new RegExp(
      TOOL + String.raw`\s+(?:is|are|was|were)\s+(?:broken|down|useless|unusable|buggy)\b`,
      "i",
    ),
    "negative_tool_claim",
  ],
  [
    new RegExp(TOOL + String.raw`\s+always\s+(?:fails|crashes|hangs|errors)\b`, "i"),
    "negative_tool_claim",
  ],
  [
    new RegExp(String.raw`\b(?:don'?t|do not|never)\s+use\s+(?:the\s+|a\s+)?` + TOOL, "i"),
    "negative_tool_claim",
  ],
];

const ALL = [...ENV_FAILURE, ...NEG_CLAIM];

export function screen(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const [rx, reason] of ALL) {
    if (!found.includes(reason) && rx.test(text)) {
      found.push(reason);
    }
  }
  return found;
}

export function reasonDetail(reason: string): string {
  const details: Record<string, string> = {
    env_failure:
      "looks like an environment-specific failure (missing binary/module/path " +
      "/permission) — transient state, not a durable fact. Store HOW TO FIX or " +
      "the missing config, never 'X failed'.",
    transient_error:
      "looks like a transient error (rate limit / OOM / network) that " +
      "self-resolves — do not capture it as a durable rule.",
    negative_tool_claim:
      "looks like a negative capability claim about ARIS's own tooling " +
      "('X can't / is broken'). These harden into self-cited refusals long " +
      "after the real problem is fixed. Store the fix / the workaround, not " +
      "'X can't do Y'.",
  };
  return details[reason] ?? reason;
}

const program = createCli("capture-filter", "ARIS anti-self-poisoning capture filter.");

program.argument("<path>", "file to screen, or - for stdin").action(async (filePath: string) => {
  let text: string;
  if (filePath === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    text = Buffer.concat(chunks).toString("utf-8");
  } else {
    text = fs.readFileSync(filePath, "utf-8");
  }
  const reasons = screen(text);
  if (reasons.length > 0) {
    console.error(`DO-NOT-CAPTURE: ${reasons.join(", ")}`);
    for (const r of reasons) {
      console.error(`  - ${r}: ${reasonDetail(r)}`);
    }
    process.exit(1);
  }
  console.log("ok to capture (mechanical screen clean)");
});

runCli(program);
