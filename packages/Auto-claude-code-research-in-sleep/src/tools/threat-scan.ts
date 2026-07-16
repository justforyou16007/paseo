#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createCli, runCli } from "../lib/cli.js";

type Scope = "all" | "context" | "strict";

interface PatternEntry {
  pattern: string;
  id: string;
  scope: Scope;
}

const PATTERNS: PatternEntry[] = [
  // Classic prompt injection (everywhere)
  {
    pattern: String.raw`ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+(?:\w+\s+)*instructions`,
    id: "prompt_injection",
    scope: "all",
  },
  { pattern: String.raw`system\s+prompt\s+override`, id: "sys_prompt_override", scope: "all" },
  {
    pattern: String.raw`disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)`,
    id: "disregard_rules",
    scope: "all",
  },
  {
    pattern: String.raw`act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)`,
    id: "bypass_restrictions",
    scope: "all",
  },
  {
    pattern: String.raw`<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->`,
    id: "html_comment_injection",
    scope: "all",
  },
  {
    pattern: String.raw`<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none`,
    id: "hidden_div",
    scope: "all",
  },
  {
    pattern: String.raw`translate\s+[^\n]{0,80}\s+into\s+[^\n]{0,40}\s+and\s+(execute|run|eval)\b`,
    id: "translate_execute",
    scope: "all",
  },
  {
    pattern: String.raw`do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user`,
    id: "deception_hide",
    scope: "all",
  },

  // Role-play / identity hijack (context)
  {
    pattern: String.raw`you\s+are\s+(?:\w+\s+)*now\s+(?:a|an|the)\s+`,
    id: "role_hijack",
    scope: "context",
  },
  {
    pattern: String.raw`pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+`,
    id: "role_pretend",
    scope: "context",
  },
  {
    pattern: String.raw`output\s+(?:\w+\s+)*(system|initial)\s+prompt`,
    id: "leak_system_prompt",
    scope: "context",
  },
  {
    pattern: String.raw`(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)`,
    id: "remove_filters",
    scope: "context",
  },
  {
    pattern: String.raw`you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to`,
    id: "fake_update",
    scope: "context",
  },
  { pattern: String.raw`\bname\s+yourself\s+\w+`, id: "identity_override", scope: "context" },

  // C2 / promptware (context)
  {
    pattern: String.raw`register\s+(?:yourself\s+)?as\s+a\s+node\s+(?:with|to)\s+(?:the\s+)?(?:c2|controller|server|botnet)\b`,
    id: "c2_node_registration",
    scope: "context",
  },
  {
    pattern: String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`,
    id: "c2_heartbeat",
    scope: "context",
  },
  {
    pattern: String.raw`pull\s+(?:down\s+)?(?:new\s+)?tasking(?:s)?\b`,
    id: "c2_task_pull",
    scope: "context",
  },
  {
    pattern: String.raw`connect\s+to\s+the\s+network\b`,
    id: "c2_network_connect",
    scope: "context",
  },
  {
    pattern: String.raw`you\s+must\s+(?:\w+\s+){0,3}(beacon|exfiltrate|phone\s+home)\b`,
    id: "forced_action",
    scope: "context",
  },
  {
    pattern: String.raw`only\s+use\s+one[\s\-]?liners?\b`,
    id: "anti_forensic_oneliner",
    scope: "context",
  },
  {
    pattern: String.raw`never\s+(?:\w+\s+)*(?:create|write)\s+(?:\w+\s+)*(?:script|file)\s+(?:\w+\s+)*disk`,
    id: "anti_forensic_disk",
    scope: "context",
  },
  {
    pattern: String.raw`unset\s+\w*(?:CLAUDE|CODEX|GEMINI|AGENT|OPENAI|ANTHROPIC)\w*`,
    id: "env_var_unset_agent",
    scope: "context",
  },
  {
    pattern: String.raw`\b(?:praxis|cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`,
    id: "known_c2_framework",
    scope: "context",
  },
  {
    pattern: String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`,
    id: "c2_explicit",
    scope: "context",
  },
  { pattern: String.raw`\bcommand\s+and\s+control\b`, id: "c2_explicit_long", scope: "context" },

  // Exfiltration (everywhere / strict)
  {
    pattern: String.raw`curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`,
    id: "exfil_curl",
    scope: "all",
  },
  {
    pattern: String.raw`wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`,
    id: "exfil_wget",
    scope: "all",
  },
  {
    pattern: String.raw`cat\s+[^\n>]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`,
    id: "read_secrets",
    scope: "all",
  },
  {
    pattern: String.raw`(?:exfiltrate|smuggle|leak)\s+[^\n]{0,60}\s+(?:to|at)\s+https?://`,
    id: "exfil_to_url",
    scope: "strict",
  },
  {
    pattern: String.raw`(include|output|print|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`,
    id: "context_exfil",
    scope: "strict",
  },

  // Persistence / backdoor / config-mod (strict)
  { pattern: String.raw`authorized_keys`, id: "ssh_backdoor", scope: "strict" },
  { pattern: String.raw`\$HOME/\.ssh|~/\.ssh`, id: "ssh_access", scope: "strict" },
  {
    pattern: String.raw`(?:update|modify|edit|append\s+to|overwrite)\s+[^\n]{0,40}(?:AGENTS\.md|CLAUDE\.md|(?<![A-Za-z_])MEMORY\.md|\.cursorrules|\.clinerules)`,
    id: "agent_config_mod",
    scope: "strict",
  },
  {
    pattern: String.raw`(update|modify|edit|write|change|append|add\s+to)\s+.*\.aris/(installed-skills\.txt|skill-source\.txt)`,
    id: "aris_config_mod",
    scope: "strict",
  },

  // Hardcoded secrets (strict)
  {
    pattern: String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`,
    id: "hardcoded_secret",
    scope: "strict",
  },
];

export const INVISIBLE_CHARS = new Set([
  "​",
  "‌",
  "‍",
  "⁠",
  "⁢",
  "⁣",
  "⁤",
  "﻿",
  "‪",
  "‫",
  "‬",
  "‭",
  "‮",
  "⁦",
  "⁧",
  "⁨",
  "⁩",
]);

interface CompiledEntry {
  re: RegExp;
  id: string;
}

const compiled: Record<string, CompiledEntry[]> = { all: [], context: [], strict: [] };

for (const { pattern, id, scope } of PATTERNS) {
  const entry: CompiledEntry = { re: new RegExp(pattern, "i"), id };
  if (scope === "all") {
    compiled.all.push(entry);
    compiled.context.push(entry);
    compiled.strict.push(entry);
  } else if (scope === "context") {
    compiled.context.push(entry);
    compiled.strict.push(entry);
  } else if (scope === "strict") {
    compiled.strict.push(entry);
  }
}

export function scanForThreats(content: string, scope: Scope = "context"): string[] {
  if (!content) return [];
  const findings: string[] = [];
  const contentChars = new Set(content);
  for (const ch of contentChars) {
    if (INVISIBLE_CHARS.has(ch)) {
      findings.push(
        `invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
  const patterns = compiled[scope];
  if (!patterns) {
    throw new Error(`scan_for_threats: unknown scope '${scope}'`);
  }
  for (const { re, id } of patterns) {
    if (re.test(content)) {
      findings.push(id);
    }
  }
  return findings;
}

export function firstThreatMessage(content: string, scope: Scope = "strict"): string | null {
  const findings = scanForThreats(content, scope);
  if (findings.length === 0) return null;
  const pid = findings[0];
  if (pid.startsWith("invisible_unicode_")) {
    return `Blocked: invisible unicode character ${pid.replace("invisible_unicode_", "")} (possible injection).`;
  }
  return (
    `Blocked: content matches threat pattern '${pid}'. This content is ` +
    `re-injected into agent context and must not carry an injection or ` +
    `exfiltration payload.`
  );
}

export function quarantine(
  content: string,
  scope: Scope = "strict",
  label = "entry",
): { text: string; findings: string[] } {
  const findings = scanForThreats(content, scope);
  if (findings.length === 0) return { text: content, findings: [] };
  const placeholder =
    `[BLOCKED: ${label} matched threat pattern(s): ${findings.join(", ")} ` +
    `— raw text preserved on disk; review and remove. Not injected into context.]`;
  return { text: placeholder, findings };
}

const program = createCli("threat-scan", "ARIS injection / exfiltration scanner.");
program.argument("<path>", "file to scan, or - for stdin");
program.option("--scope <scope>", "scan scope: all, context, strict", "strict");
program.option("--quarantine", "print the quarantined text instead of the findings");
program.action(async (filePath: string, opts: { scope: string; quarantine?: boolean }) => {
  const scope = opts.scope as Scope;
  if (!["all", "context", "strict"].includes(scope)) {
    console.error(`error: scope must be one of: all, context, strict`);
    process.exit(1);
  }
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
  if (opts.quarantine) {
    const result = quarantine(text, scope, filePath);
    const out = result.text;
    process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    process.exit(result.findings.length > 0 ? 1 : 0);
  }
  const findings = scanForThreats(text, scope);
  if (findings.length > 0) {
    console.error(`THREAT (${scope}): ${findings.join(", ")}`);
    process.exit(1);
  }
  console.log(`clean (${scope})`);
  process.exit(0);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(program);
}
