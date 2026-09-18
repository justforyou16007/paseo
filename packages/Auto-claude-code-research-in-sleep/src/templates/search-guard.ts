#!/usr/bin/env node

/**
 * PreToolUse guard: refuse the network calls the tester declared off limits,
 * and record every network call either way.
 *
 * This file is only the stdin/stdout wrapper. Every decision is made by
 * `decideNetworkCall` in `src/tools/search-policy.ts`, which is a pure function
 * so it can be tested without a Claude session -- read that file for what this
 * gate does and does not stop.
 *
 * Reads the Claude Code hook JSON from stdin. Exit 0 = allow, exit 2 = block
 * and show stderr to the model.
 */

import path from "node:path";

import {
  appendSearchAuditEntry,
  decideNetworkCall,
  readSearchPolicy,
  searchPolicySha256,
  type SearchPolicy,
} from "../tools/search-policy.js";

function projectDir(): string {
  const flag = process.argv.indexOf("--project");
  if (flag !== -1 && process.argv[flag + 1] !== undefined)
    return path.resolve(process.argv[flag + 1]);
  return path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

function loadPolicy(directory: string): SearchPolicy | null {
  // A policy that exists but does not parse is treated as no policy: it blocks
  // rather than allows, so corrupting the file is not a way around the gate.
  try {
    return readSearchPolicy(directory);
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
  });
}

async function main(): Promise<number> {
  const raw = await readStdin();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.stderr.write("BLOCKED by search_guard: invalid hook JSON, refusing the call.\n");
    return 2;
  }
  const directory = projectDir();
  const policy = loadPolicy(directory);
  const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  const decision = decideNetworkCall(policy, toolName, data.tool_input);
  if (decision.decision === null) return 0;

  try {
    appendSearchAuditEntry(directory, {
      tool: toolName,
      target: decision.target,
      decision: decision.decision,
      matched: decision.matched,
      policy_sha256: policy === null ? null : searchPolicySha256(policy),
    });
  } catch (error) {
    // Fail closed. An unrecordable call is an unauditable call, and the point of
    // the gate is that the round's network use is reconstructable afterwards.
    process.stderr.write(
      `BLOCKED by search_guard: could not record this call in the audit ledger (${String(error)}).\n`,
    );
    return 2;
  }

  if (!decision.blocked) return 0;
  if (decision.decision === "policy_missing") {
    process.stderr.write(
      "BLOCKED by search_guard: no search policy is installed for this project, so every " +
        "network call is refused. Run search-audit-cli emit-policy against the signed tester " +
        "contract before doing any research.\n",
    );
    return 2;
  }
  // This is the only place a blocked term is ever shown, and only because the
  // model just typed it. Nothing else prints the list.
  process.stderr.write(
    `BLOCKED by search_guard: this call matches ${JSON.stringify(decision.matched)}, which the ` +
      "tester used to build the held-out cases. Looking it up would contaminate the evaluation. " +
      "Do not work around it -- research the problem from other sources.\n",
  );
  return 2;
}

main().then((code) => process.exit(code));
