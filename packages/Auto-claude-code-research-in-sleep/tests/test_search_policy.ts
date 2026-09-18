import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendSearchAuditEntry,
  assertSearchAuditForContract,
  decideNetworkCall,
  searchAuditPath,
  searchPolicyFromContract,
  searchPolicyPath,
  searchPolicySha256,
  verifySearchAudit,
  type SearchPolicy,
} from "../src/tools/search-policy.js";
import type { TesterSubmissionContract } from "../src/tools/tester-agent.js";

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? "";
}

function expectCode(expected: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    assert.equal(codeOf(error), expected, `expected ${expected}, got ${codeOf(error)}`);
    return;
  }
  assert.fail(`expected ${expected}, nothing was thrown`);
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-search-policy-"));

const contract: TesterSubmissionContract = {
  schema_version: 1,
  contract_id: "contract:1",
  project_id: "project:search",
  tester_id: "tester:search",
  tester_version: "tester:v1",
  case_manifest_sha256: "c".repeat(64),
  slots: [
    { slot_id: "slot_ref", role: "reference", required: true },
    { slot_id: "slot_cand", role: "candidate", required: true },
  ],
  submission_fields: [{ name: "runner", type: "string", required: true }],
  usage: "run each artifact with the declared runner",
  search_exclusions: {
    terms: ["humaneval", "mbpp+"],
    urls: ["https://github.com/openai/human-eval"],
    domains: ["huggingface.co/datasets/openai_humaneval"],
  },
};
const policy: SearchPolicy = searchPolicyFromContract(contract);

// --- 1. what counts as a network call, and what matches ---------------------

// Local work is neither judged nor recorded: the ledger is a record of network
// use, and burying it under every grep would make it unreadable.
for (const [tool, input] of [
  ["Bash", { command: "grep -rn humaneval src/" }],
  ["Read", { file_path: "/tmp/humaneval.json" }],
  ["mcp__paseo__list_agents", { limit: 5 }],
] as const)
  assert.equal(decideNetworkCall(policy, tool, input).decision, null, `${tool} should be ignored`);

const blocked = [
  ["WebSearch", { query: "HumanEval pass@1 results" }, "humaneval"],
  ["WebFetch", { url: "https://github.com/openai/human-eval", prompt: "what is this" }, "https://github.com/openai/human-eval"],
  ["Bash", { command: "curl -sL https://github.com/openai/human-eval/archive/main.zip" }, "https://github.com/openai/human-eval"],
  ["Bash", { command: "git clone https://example.invalid/mirrors/humaneval" }, "humaneval"],
  ["mcp__exa__web_search", { query: "mbpp+ leaderboard" }, "mbpp+"],
] as const;
for (const [tool, input, matched] of blocked) {
  const decision = decideNetworkCall(policy, tool, input);
  assert.equal(decision.decision, "blocked", `${tool} ${JSON.stringify(input)}`);
  assert.equal(decision.blocked, true);
  assert.equal(decision.matched, matched);
}

const allowed = [
  ["WebSearch", { query: "program synthesis evaluation protocols" }],
  ["WebFetch", { url: "https://arxiv.org/abs/2401.00001", prompt: "summarize" }],
  ["Bash", { command: "curl -sL https://example.invalid/paper.pdf" }],
] as const;
for (const [tool, input] of allowed) {
  const decision = decideNetworkCall(policy, tool, input);
  assert.equal(decision.decision, "allowed", `${tool} ${JSON.stringify(input)}`);
  assert.equal(decision.blocked, false);
}

// Terms are checked before urls and domains, so a dataset page whose path
// contains the benchmark name is refused on the name. The domain list is what
// catches the same source under a name the tester never wrote down.
assert.equal(
  decideNetworkCall(
    { ...policy, terms: [] },
    "WebFetch",
    { url: "https://huggingface.co/datasets/openai_humaneval/raw/main/test.jsonl", prompt: "" },
  ).matched,
  "huggingface.co/datasets/openai_humaneval",
);

// Reading the blocklist is the one local action that would defeat "the model is
// never shown the list", so it is flagged rather than left invisible. It is not
// blocked: refusing it would only teach that the file is worth reading.
const read = decideNetworkCall(policy, "Bash", { command: "cat .aris/search-policy.json" });
assert.equal(read.decision, "policy_read");
assert.equal(read.blocked, false);

// Deleting the policy must not buy a free network. Non-network calls still pass,
// so losing the policy does not brick the agent -- it takes it offline.
assert.equal(decideNetworkCall(null, "WebSearch", { query: "anything" }).decision, "policy_missing");
assert.equal(decideNetworkCall(null, "WebSearch", { query: "anything" }).blocked, true);
assert.equal(decideNetworkCall(null, "Bash", { command: "ls" }).decision, null);

// --- 2. the ledger chains, and an edit to written history shows up ----------

const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });
const digest = searchPolicySha256(policy);

expectCode("SEARCH_AUDIT_MISSING", () => verifySearchAudit(project));

appendSearchAuditEntry(project, {
  tool: "",
  target: "",
  decision: "genesis",
  matched: null,
  policy_sha256: digest,
});
appendSearchAuditEntry(project, {
  tool: "WebSearch",
  target: "program synthesis evaluation protocols",
  decision: "allowed",
  matched: null,
  policy_sha256: digest,
});
appendSearchAuditEntry(project, {
  tool: "WebSearch",
  target: "humaneval pass@1",
  decision: "blocked",
  matched: "humaneval",
  policy_sha256: digest,
});

const summary = verifySearchAudit(project);
assert.equal(summary.entries, 3);
assert.equal(summary.allowed, 1);
assert.equal(summary.blocked, 1);
assert.equal(summary.active_policy_sha256, digest);
assert.deepEqual(summary.by_decision, { genesis: 1, allowed: 1, blocked: 1 });

const auditPath = searchAuditPath(project);
const lines = fs.readFileSync(auditPath, "utf-8").trimEnd().split("\n");

// Rewriting a refusal into an allowance keeps the line well formed and breaks
// the chain from that line on. That is all the chain claims: an edit to history
// is detectable. A ledger forged whole, by something other than the guard, is
// not detectable here at all, and nothing in this package pretends otherwise.
const forged = JSON.parse(lines[2]) as Record<string, unknown>;
forged.decision = "allowed";
forged.matched = null;
fs.writeFileSync(auditPath, `${lines[0]}\n${lines[1]}\n${JSON.stringify(forged)}\n`);
expectCode("SEARCH_AUDIT_BROKEN", () => verifySearchAudit(project));

// Dropping a line renumbers nothing, so the gap is visible.
fs.writeFileSync(auditPath, `${lines[0]}\n${lines[2]}\n`);
expectCode("SEARCH_AUDIT_BROKEN", () => verifySearchAudit(project));

// A ledger that does not open with genesis means the guard was not what opened it.
fs.writeFileSync(auditPath, `${lines[1]}\n`);
expectCode("SEARCH_AUDIT_BROKEN", () => verifySearchAudit(project));

fs.writeFileSync(auditPath, `${lines.join("\n")}\n`);
assert.equal(verifySearchAudit(project).entries, 3);

// --- 3. the submit gate ----------------------------------------------------

assert.equal(assertSearchAuditForContract(project, contract).blocked, 1);

// A round audited against one contract's exclusions proves nothing about
// another contract's cases.
const otherContract: TesterSubmissionContract = {
  ...contract,
  search_exclusions: { terms: ["swe-bench"], urls: [], domains: [] },
};
expectCode("SEARCH_POLICY_MISMATCH", () => assertSearchAuditForContract(project, otherContract));

// --- 4. end to end: the CLI installs it, the hook enforces it ---------------

function runCli(args: string[]): { status: number; stdout: string } {
  const result = spawnSync(
    "npx",
    ["tsx", path.join(packageRoot, "src/tools/search-audit-cli.ts"), ...args],
    { cwd: packageRoot, encoding: "utf-8" },
  );
  return { status: result.status ?? 1, stdout: result.stdout };
}

function runGuard(projectDir: string, payload: unknown): number {
  const result = spawnSync(
    "npx",
    ["tsx", path.join(packageRoot, "src/templates/search-guard.ts"), "--project", projectDir],
    { cwd: packageRoot, encoding: "utf-8", input: JSON.stringify(payload) },
  );
  return result.status ?? 1;
}

const live = path.join(root, "live");
fs.mkdirSync(live, { recursive: true });
const contractPath = path.join(live, "contract.json");
fs.writeFileSync(contractPath, JSON.stringify(contract));

// The guard refuses to be installed before there is a policy to enforce, so the
// genesis entry can carry the policy digest the round actually ran under.
assert.equal(runCli(["install-guard", "--project", live]).status, 1);

const emitted = runCli(["emit-policy", "--contract", contractPath, "--project", live]);
assert.equal(emitted.status, 0);
assert.equal((JSON.parse(emitted.stdout) as { policy_sha256: string }).policy_sha256, digest);
// The output carries counts and a digest. It never carries the entries.
assert.equal(emitted.stdout.includes("humaneval"), false);
assert.equal(fs.existsSync(searchPolicyPath(live)), true);

assert.equal(runCli(["install-guard", "--project", live]).status, 0);
// Installing twice must not stack a second copy of the hook onto the matcher.
assert.equal(runCli(["install-guard", "--project", live]).status, 0);
const settings = JSON.parse(
  fs.readFileSync(path.join(live, ".claude", "settings.json"), "utf-8"),
) as { hooks: { PreToolUse: unknown[] } };
assert.equal(settings.hooks.PreToolUse.length, 1);

assert.equal(runGuard(live, { tool_name: "WebSearch", tool_input: { query: "HumanEval" } }), 2);
assert.equal(
  runGuard(live, { tool_name: "WebSearch", tool_input: { query: "curriculum design" } }),
  0,
);
assert.equal(runGuard(live, { tool_name: "Bash", tool_input: { command: "ls -la" } }), 0);

const liveSummary = verifySearchAudit(live);
assert.equal(liveSummary.blocked, 1);
assert.equal(liveSummary.allowed, 1);
// genesis + one blocked + one allowed; the `ls` was never network-shaped.
assert.equal(liveSummary.entries, 3);
assert.equal(runCli(["verify", "--project", live]).status, 0);

// With the policy gone the guard refuses every network call instead of waving
// them through, and says so in the ledger.
fs.rmSync(searchPolicyPath(live));
assert.equal(runGuard(live, { tool_name: "WebSearch", tool_input: { query: "anything" } }), 2);
assert.equal(verifySearchAudit(live).by_decision.policy_missing, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log("search policy: call decisions, ledger chain, submit gate and installed hook passed");
