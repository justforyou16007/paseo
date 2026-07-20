#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const REPLACEMENTS_TEXT: [string, string][] = [
  ["mcp__codex__codex-reply", "mcp__llm-chat__chat"],
  ["mcp__codex__codex", "mcp__llm-chat__chat"],
  ["via GPT-5.5 xhigh review", "via llm-chat MCP review"],
  ["GPT-5.5 xhigh", "LLM reviewer"],
  ["secondary Codex agent", "LLM reviewer via llm-chat MCP"],
  ["Codex agent", "LLM reviewer"],
  ["a second Codex agent", "an LLM via llm-chat MCP"],
  ["reasoning_effort: xhigh", "# (reasoning effort not supported by llm-chat)"],
  ["reasoning_effort: high", "# (reasoning effort not supported by llm-chat)"],
];

const CONFIG_LINE_RE = /^(\s*)config:\s*\{[^}]*model_reasoning_effort[^}]*\}\s*$/gm;
const THREAD_ID_LINE_RE = /^(\s*)threadId:\s*\S+.*$/gm;
const APPROVAL_POLICY_LINE_RE = /^(\s*)approval-policy:\s*\S+.*$/gm;
const SANDBOX_LINE_RE = /^(\s*)sandbox:\s*\S+.*$/gm;
const BASE_INSTRUCTIONS_LINE_RE = /^(\s*)base-instructions:\s*["'].*$/gm;
const DEVELOPER_INSTRUCTIONS_LINE_RE = /^(\s*)developer-instructions:\s*["'].*$/gm;

function convertContent(text: string): string {
  for (const [old, replacement] of REPLACEMENTS_TEXT) {
    text = text.replaceAll(old, replacement);
  }

  text = text.replace(/(mcp__llm-chat__chat),\s*mcp__llm-chat__chat/g, "$1");

  for (const pattern of [
    CONFIG_LINE_RE,
    THREAD_ID_LINE_RE,
    APPROVAL_POLICY_LINE_RE,
    SANDBOX_LINE_RE,
    BASE_INSTRUCTIONS_LINE_RE,
    DEVELOPER_INSTRUCTIONS_LINE_RE,
  ]) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "");
  }

  const note =
    "\n> **llm-chat conversion**: This skill has been auto-converted from Codex to " +
    "use `mcp__llm-chat__chat`. Multi-turn conversations are handled as single-turn " +
    "calls with manual context inclusion.\n";

  if (!text.includes("llm-chat conversion")) {
    const firstFence = text.indexOf("---");
    if (firstFence !== -1) {
      const fmEnd = text.indexOf("---", firstFence + 3);
      if (fmEnd !== -1) {
        const nlPos = text.indexOf("\n", fmEnd + 3);
        if (nlPos !== -1) {
          text = text.slice(0, nlPos + 1) + note + text.slice(nlPos + 1);
        }
      }
    }
  }

  text = text.replace(/\n{3,}/g, "\n\n");

  return text;
}

function convertFile(src: string, dst: string): boolean {
  const content = fs.readFileSync(src, "utf-8");
  const converted = convertContent(content);

  if (converted === content) return false;

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, converted, "utf-8");
  return true;
}

function findSkills(sourceDir: string): string[] {
  const skills: string[] = [];
  const excludeDirs = new Set<string>();

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.name === "SKILL.md") {
        const rel = path.relative(sourceDir, fullPath);
        const parts = rel.split(path.sep);
        if (parts.some((p) => excludeDirs.has(p))) continue;

        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.includes("mcp__llm-chat__chat") && !content.includes("mcp__codex__codex")) {
          continue;
        }
        if (!content.includes("mcp__codex__codex")) continue;

        skills.push(fullPath);
      }
    }
  }

  walk(sourceDir);
  return skills.sort();
}

const program = createCli(
  "convert-skills-to-llm-chat",
  "Convert Codex-native skills to llm-chat MCP compatible versions.",
);

program
  .option("--source <dir>", "Source directory containing skill folders (default: repo skills/)")
  .option("--target <dir>", "Target directory for converted skills (default: source, in-place)")
  .option("--dry-run", "Preview changes without writing files")
  .action((opts: { source?: string; target?: string; dryRun?: boolean }) => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const sourceDir = opts.source ? path.resolve(opts.source) : path.join(repoRoot, "skills");
    const targetDir = opts.target ? path.resolve(opts.target) : sourceDir;

    if (!fs.existsSync(sourceDir)) {
      console.error(`Error: source directory not found: ${sourceDir}`);
      process.exit(1);
    }

    const skills = findSkills(sourceDir);
    if (skills.length === 0) {
      console.log("No Codex-based skills found to convert.");
      return;
    }

    console.log(`Found ${skills.length} skill(s) to convert:\n`);

    let converted = 0;
    for (const skillPath of skills) {
      const rel = path.relative(sourceDir, skillPath);
      const dst = path.join(targetDir, rel);

      if (opts.dryRun) {
        const content = fs.readFileSync(skillPath, "utf-8");
        const newContent = convertContent(content);
        const hasChanges = content !== newContent;
        const status = hasChanges ? "would convert" : "no changes";
        console.log(`  [DRY-RUN] ${rel} — ${status}`);
        if (hasChanges) converted++;
      } else {
        if (convertFile(skillPath, dst)) {
          console.log(`  Converted: ${rel}`);
          converted++;
        } else {
          console.log(`  No changes: ${rel}`);
        }
      }
    }

    console.log(`\nDone: ${converted}/${skills.length} skill(s) converted.`);
    if (opts.dryRun) {
      console.log("(dry-run mode — no files were written)");
    }
  });

runCli(program);
