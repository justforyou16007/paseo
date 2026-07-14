#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "skills", "skills-codex");
const DEST_ROOT = path.join(REPO_ROOT, "skills", "skills-codex-claude-review");

const TARGET_SKILLS = [
  "research-review",
  "novelty-check",
  "research-refine",
  "auto-review-loop",
  "paper-plan",
  "paper-figure",
  "paper-write",
  "auto-paper-improvement-loop",
];

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const SPAWN_BLOCK_RE = /```(?:yaml|text)?\nspawn_agent:\n([\s\S]*?)```/g;
const SEND_BLOCK_RE = /```(?:yaml|text)?\nsend_input:\n([\s\S]*?)```/g;

const OVERRIDE_NOTE =
  "> Override for Codex users who want **Claude Code**, not a second Codex agent, " +
  "to act as the reviewer. Install this package **after** `skills/skills-codex/*`.";

const REVIEWER_LINE =
  "- **REVIEWER_MODEL = `claude-review`** — Claude reviewer invoked through the " +
  "local `claude-review` MCP bridge. Set `CLAUDE_REVIEW_MODEL` if you need a " +
  "specific Claude model override.";

const PREREQ_BLOCK = `## Prerequisites

- Install the base Codex-native skills first: copy \`skills/skills-codex/*\` into \`~/.codex/skills/\`.
- Then install this overlay package: copy \`skills/skills-codex-claude-review/*\` into \`~/.codex/skills/\` and allow it to overwrite the same skill names.
- Register the local reviewer bridge:
  \`\`\`bash
  codex mcp add claude-review -- python3 ~/.codex/mcp-servers/claude-review/server.py
  \`\`\`
- This gives Codex access to \`mcp__claude-review__review_start\`, \`mcp__claude-review__review_reply_start\`, and \`mcp__claude-review__review_status\`.`;

function extractField(frontmatter: string, field: string): string {
  const pattern = new RegExp(`^${escapeRegExp(field)}:\\s*(.+)$`, "m");
  const match = pattern.exec(frontmatter);
  if (!match) return "";
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFrontmatter(name: string, description: string): string {
  const safeDesc = description.replace(/"/g, '\\"');
  return `---\nname: "${name}"\ndescription: "${safeDesc}"\n---\n\n`;
}

function normalizeDescription(text: string): string {
  text = text || "Claude-review override for a Codex-native ARIS skill.";
  text = text.replace("GPT using a secondary Codex agent", "Claude via claude-review MCP");
  text = text.replace("using a secondary Codex agent", "using Claude Code via claude-review MCP");
  text = text.replace("via GPT-5.5 xhigh review", "via Claude review through claude-review MCP");
  return text;
}

function rewriteSpawnBlock(_match: string, inner: string): string {
  const lines = inner.split("\n");
  const out: string[] = ["```", "mcp__claude-review__review_start:"];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      out.push(line);
      continue;
    }
    if (stripped.startsWith("model:") || stripped.startsWith("reasoning_effort:")) {
      continue;
    }
    if (stripped.startsWith("message:")) {
      out.push(line.replace("message:", "prompt:"));
      continue;
    }
    out.push(line);
  }
  out.push("```");
  return out.join("\n");
}

function rewriteSendBlock(_match: string, inner: string): string {
  const lines = inner.split("\n");
  const out: string[] = ["```", "mcp__claude-review__review_reply_start:"];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      out.push(line);
      continue;
    }
    if (stripped.startsWith("model:") || stripped.startsWith("reasoning_effort:")) {
      continue;
    }
    if (stripped.startsWith("id:")) {
      out.push(line.replace("id:", "threadId:"));
      continue;
    }
    if (stripped.startsWith("message:")) {
      out.push(line.replace("message:", "prompt:"));
      continue;
    }
    out.push(line);
  }
  out.push("```");
  return out.join("\n");
}

function appendAsyncNotes(text: string): string {
  const note =
    "After this start call, immediately save the returned `jobId` and poll " +
    "`mcp__claude-review__review_status` with a bounded `waitSeconds` until " +
    "`done=true`. Treat the completed status payload's `response` as the " +
    "reviewer output, and save the completed `threadId` for any follow-up round.";

  const blockRe =
    /```(?:yaml|text)?\n(?:mcp__claude-review__review_start:|mcp__claude-review__review_reply_start:)[\s\S]*?```/g;

  return text.replace(blockRe, (block) => {
    if (block.includes(note)) return block;
    return `${block}\n\n${note}`;
  });
}

function transformBody(text: string): string {
  text = text.replaceAll("secondary Codex agent", "Claude reviewer via `claude-review` MCP");
  text = text.replaceAll(
    "via a Claude reviewer via `claude-review` MCP (xhigh reasoning)",
    "via `claude-review` MCP (high-rigor review)",
  );
  text = text.replaceAll(
    "secondary Codex agent (xhigh reasoning)",
    "Claude reviewer via `claude-review` MCP",
  );
  text = text.replaceAll("GPT-5.5 xhigh", "Claude review");
  text = text.replaceAll(
    "Send the full paper text to GPT-5.5 xhigh:",
    "Send the full paper text to Claude through `claude-review`:",
  );
  text = text.replaceAll(
    "Send the complete outline to GPT-5.5 xhigh for feedback:",
    "Send the complete outline to Claude for feedback:",
  );
  text = text.replaceAll(
    "Call REVIEWER_MODEL via `spawn_agent` (`spawn_agent`) with xhigh reasoning:",
    "Call REVIEWER_MODEL via `mcp__claude-review__review_start` with high-rigor review:",
  );
  text = text.replaceAll(
    "Send a detailed prompt with xhigh reasoning:",
    "Send a detailed prompt with high-rigor review:",
  );
  text = text.replaceAll(
    "Use `send_input` with the returned agent id to continue the conversation:",
    "Use `mcp__claude-review__review_reply_start` with the saved completed `threadId`, then poll `mcp__claude-review__review_status` with the returned `jobId` until `done=true` to continue the conversation:",
  );
  text = text.replaceAll(
    "If this is round 2+, use `send_input` with the saved agent id to maintain continuity.",
    "If this is round 2+, use `mcp__claude-review__review_reply_start` with the saved completed `threadId`, then poll `mcp__claude-review__review_status` with the returned `jobId` until `done=true` to maintain continuity.",
  );
  text = text.replaceAll(
    "Save the agent id for Round 2.",
    "Save the returned `jobId`, poll `mcp__claude-review__review_status` until `done=true`, then save the completed `threadId` for Round 2.",
  );
  text = text.replaceAll(
    "Save agent id from first call, use `send_input` for subsequent rounds",
    "Save the completed `threadId` from the first `mcp__claude-review__review_status` result, then use `mcp__claude-review__review_reply_start` plus `mcp__claude-review__review_status` for subsequent rounds",
  );
  text = text.replaceAll(
    "Document the agent id for potential future resumption",
    "Document the completed `threadId` for potential future resumption",
  );
  text = text.replaceAll(
    "Use `send_input` with the saved agent id:",
    "Use `mcp__claude-review__review_reply_start` with the saved completed `threadId`:",
  );
  text = text.replaceAll(
    "use `send_input` for Round 2 to maintain conversation context",
    "use `mcp__claude-review__review_reply_start` plus `mcp__claude-review__review_status` for Round 2 to maintain conversation context",
  );
  text = text.replaceAll(
    "Save the agent id for Round 2.",
    "Save the completed `threadId` for Round 2.",
  );
  text = text.replaceAll(
    "**CRITICAL: Save the `agent_id`** from this call for all later rounds.",
    "**CRITICAL: Save the returned `jobId`**, poll `mcp__claude-review__review_status` until `done=true`, then save the completed `threadId` from the status result for all later rounds.",
  );
  text = text.replaceAll(
    "- **ALWAYS use `reasoning_effort: xhigh`** for all Codex review calls.",
    "- **Always ask the Claude reviewer for strict, high-rigor feedback** in every review round.",
  );
  text = text.replaceAll(
    "- **Save `agent_id` from Phase 2** and use `send_input` for later rounds.",
    "- **Save the completed `threadId` from Phase 2** and use `mcp__claude-review__review_reply_start` plus `mcp__claude-review__review_status` for later rounds.",
  );
  text = text.replaceAll(
    "- **Use `send_input`** for Round 2 to maintain conversation context",
    "- **Use `mcp__claude-review__review_reply_start` plus `mcp__claude-review__review_status`** for Round 2 to maintain conversation context",
  );
  text = text.replaceAll("GPT-5.5 responses", "Claude reviewer responses");
  text = text.replaceAll("`agent_id`", "`thread_id`");
  text = text.replaceAll('"agent_id"', '"thread_id"');
  text = text.replaceAll(
    "ALWAYS use `reasoning_effort: xhigh` for reviews",
    "Always ask the Claude reviewer for strict, high-rigor feedback.",
  );
  text = text.replaceAll(
    "ALWAYS use `reasoning_effort: xhigh` for maximum reasoning depth",
    "Always ask the Claude reviewer for strict, high-rigor feedback.",
  );
  text = text.replaceAll("mcp__codex__codex", "mcp__claude-review__review_start");
  text = text.replaceAll("mcp__codex__codex-reply", "mcp__claude-review__review_reply_start");

  text = text.replace(/^-\s+\*{0,2}REVIEWER_MODEL.*$/gm, REVIEWER_LINE);

  text = text.replace(/## Prerequisites\n\n(?:- .*\n)+/, PREREQ_BLOCK + "\n\n");

  SPAWN_BLOCK_RE.lastIndex = 0;
  text = text.replace(SPAWN_BLOCK_RE, rewriteSpawnBlock);
  SEND_BLOCK_RE.lastIndex = 0;
  text = text.replace(SEND_BLOCK_RE, rewriteSendBlock);

  text = text.replaceAll(
    "```\nreasoning_effort: xhigh\n```",
    "```\nmcp__claude-review__review_start:\n  prompt: |\n    [Full novelty briefing + prior work list + specific novelty questions]\n```",
  );

  return appendAsyncNotes(text);
}

function generateOne(skillName: string): void {
  const skillPath = path.join(SRC_ROOT, skillName, "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error(`Missing frontmatter: ${skillPath}`);
  }

  const frontmatter = match[1];
  const body = content.slice(match[0].length).replace(/^\n+/, "");
  const name = extractField(frontmatter, "name") || skillName;
  const description = normalizeDescription(extractField(frontmatter, "description"));

  let output = buildFrontmatter(name, description);
  output += OVERRIDE_NOTE + "\n\n";
  output += transformBody(body).trimEnd() + "\n";

  const targetDir = path.join(DEST_ROOT, skillName);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "SKILL.md"), output, "utf-8");
}

function main(): void {
  fs.mkdirSync(DEST_ROOT, { recursive: true });
  for (const skillName of TARGET_SKILLS) {
    generateOne(skillName);
  }
}

const program = createCli(
  "generate-codex-claude-review-overrides",
  "Generate Claude-review overrides for the upstream Codex-native skills.",
);
program.action(() => {
  main();
});
runCli(program);
