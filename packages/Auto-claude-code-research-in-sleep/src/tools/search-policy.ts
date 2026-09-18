/**
 * The search gate: what the tester declared it built its cases on, compiled into
 * a decision the research side's PreToolUse hook can make on every network call,
 * plus the hash-chained ledger of those decisions.
 *
 * The leak this closes is the open web, not the tester machine. A tester that
 * researched and adopted a public benchmark leaves that benchmark's repository
 * and paper sitting in public; a research process that simply searches for it
 * gets the cases without ever touching the tester. Keeping the private key and
 * the cases remote does nothing about that path.
 *
 * What this does NOT do, stated here because a gate that is believed to be
 * stronger than it is, is worse than no gate:
 *
 *  - This is keyword and domain matching, NOT a sandbox. A paraphrase, a
 *    synonym, or a typo goes straight through. It stops the cheap, likely
 *    contamination -- typing the benchmark's name into a search box -- and
 *    nothing more.
 *  - The benchmark is probably already in the model's weights. Blocking the
 *    search does not unlearn HumanEval.
 *  - The policy file lives on the research machine under the same uid as the
 *    research process. "The model is not shown the blocklist" rests on no
 *    prompt ever printing it, not on file permissions. The compensation is that
 *    a command naming the policy path is itself recorded as a flagged
 *    `policy_read` entry in the ledger.
 *  - The ledger shares that uid too. The hash chain makes EDITING written
 *    history detectable; forging a clean ledger from scratch is not detectable
 *    locally at all. The tester does not counter-sign it, so this is an open
 *    hole, deliberately accepted.
 */

import fs from "node:fs";
import path from "node:path";

import { canonicalJsonSha256 } from "./canonical-json.js";
import { acquireStateFileLock, releaseStateFileLock } from "./state-file.js";
import type { TesterSubmissionContract } from "./tester-agent.js";
import { testerSubmissionContractSha256 } from "./tester-agent.js";
import {
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

const GENESIS_PREV_SHA256 = "0".repeat(64);
const MAX_TARGET_LENGTH = 200;

export interface SearchPolicy {
  schema_version: 1;
  project_id: string;
  tester_id: string;
  contract_id: string;
  /** The contract this policy was compiled from, so drift is detectable. */
  contract_sha256: string;
  terms: string[];
  urls: string[];
  domains: string[];
}

export type SearchAuditDecision =
  | "genesis"
  | "allowed"
  | "blocked"
  | "policy_missing"
  | "policy_read"
  | "policy_rotated";

export interface SearchAuditEntry {
  seq: number;
  ts: string;
  tool: string;
  target: string;
  decision: SearchAuditDecision;
  matched: string | null;
  policy_sha256: string | null;
  prev_sha256: string;
  entry_sha256: string;
}

export interface NetworkCallDecision {
  /** `null` means the call is not network-shaped: nothing to decide, nothing to log. */
  decision: SearchAuditDecision | null;
  /** The blocklist entry that matched, for the ledger and the refusal message. */
  matched: string | null;
  /** What was compared, truncated, for the ledger. */
  target: string;
  /** Exit 2 in the hook wrapper. */
  blocked: boolean;
}

export function searchPolicyPath(projectDir: string): string {
  return path.join(projectDir, ".aris", "search-policy.json");
}

export function searchAuditPath(projectDir: string): string {
  return path.join(projectDir, ".aris", "search-audit.jsonl");
}

/**
 * The exclusions are already validated and normalized by the contract
 * validator, so this only rebinds them to the contract they came from. The
 * digest matters at submit time: a policy compiled from a different contract
 * than the one being submitted against means the gate was guarding the wrong
 * thing for part of the round.
 */
export function searchPolicyFromContract(contract: TesterSubmissionContract): SearchPolicy {
  return {
    schema_version: 1,
    project_id: contract.project_id,
    tester_id: contract.tester_id,
    contract_id: contract.contract_id,
    contract_sha256: testerSubmissionContractSha256(contract),
    terms: [...contract.search_exclusions.terms],
    urls: [...contract.search_exclusions.urls],
    domains: [...contract.search_exclusions.domains],
  };
}

export function searchPolicySha256(policy: SearchPolicy): string {
  return canonicalJsonSha256(policy, undefined, { schemaVersion: "search-policy-v1" });
}

export function validateSearchPolicy(value: unknown): SearchPolicy {
  if (!isRecord(value)) failA1("SEARCH_POLICY_INVALID", "search policy must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "project_id",
      "tester_id",
      "contract_id",
      "contract_sha256",
      "terms",
      "urls",
      "domains",
    ],
    "search_policy",
  );
  const list = (raw: unknown, location: string): string[] => {
    if (!Array.isArray(raw))
      failA1("SEARCH_POLICY_INVALID", `${location} must be a list`, location);
    return (raw as unknown[]).map((entry, index) =>
      requireString(entry, `${location}[${index}]`).toLowerCase(),
    );
  };
  return {
    schema_version: ((version: number): 1 => {
      if (version !== 1)
        failA1(
          "SEARCH_POLICY_INVALID",
          "unsupported policy version",
          "search_policy.schema_version",
        );
      return 1;
    })(requireInteger(value.schema_version, "search_policy.schema_version", 1)),
    project_id: requireString(value.project_id, "search_policy.project_id"),
    tester_id: requireString(value.tester_id, "search_policy.tester_id"),
    contract_id: requireString(value.contract_id, "search_policy.contract_id"),
    contract_sha256: assertSha256(value.contract_sha256, "search_policy.contract_sha256"),
    terms: list(value.terms, "search_policy.terms"),
    urls: list(value.urls, "search_policy.urls"),
    domains: list(value.domains, "search_policy.domains"),
  };
}

export function readSearchPolicy(projectDir: string): SearchPolicy | null {
  const policyPath = searchPolicyPath(projectDir);
  if (!fs.existsSync(policyPath)) return null;
  return validateSearchPolicy(JSON.parse(fs.readFileSync(policyPath, "utf-8")));
}

/**
 * Bash verbs that actually reach the network. A Bash command is only judged when
 * one of these appears, so ordinary local work -- grep, cat, a test run -- is
 * neither blocked nor logged. The ARIS paper fetchers are listed by script name
 * because they are run as `node .../arxiv-fetch.js`, which contains no verb.
 */
const NETWORK_VERBS = [
  "curl",
  "wget",
  "git clone",
  "git fetch",
  "git pull",
  "git ls-remote",
  "pip install",
  "pip3 install",
  "npm install",
  "npm i ",
  "npx ",
  "huggingface-cli",
  "hf download",
  "datasets.load_dataset",
  "load_dataset(",
  "arxiv-fetch",
  "deepxiv-fetch",
  "openalex-fetch",
  "semantic-scholar-fetch",
  "exa-search",
];

/**
 * MCP tools are matched by name because an MCP server can be anything. Only
 * names that read like retrieval are judged; blocking every `mcp__*` call when
 * the policy is missing would take the agent's own orchestration tools down
 * with it.
 */
const MCP_NETWORK_HINTS = [
  "search",
  "fetch",
  "web",
  "browse",
  "crawl",
  "http",
  "arxiv",
  "scholar",
  "paper",
  "google",
  "exa",
];

function truncate(value: string): string {
  return value.length <= MAX_TARGET_LENGTH ? value : `${value.slice(0, MAX_TARGET_LENGTH)}...`;
}

function stringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) stringValues(item, out);
}

interface CallShape {
  network: boolean;
  target: string;
  haystack: string;
}

function callShape(toolName: string, toolInput: unknown): CallShape {
  const input = isRecord(toolInput) ? toolInput : {};
  const text = (field: string): string =>
    typeof input[field] === "string" ? (input[field] as string) : "";
  if (toolName === "WebSearch") {
    const query = text("query");
    return { network: true, target: query, haystack: `${query} ${text("allowed_domains")}` };
  }
  if (toolName === "WebFetch") {
    const url = text("url");
    return { network: true, target: url, haystack: `${url} ${text("prompt")}` };
  }
  if (toolName === "Bash") {
    const command = text("command");
    const lowered = command.toLowerCase();
    return {
      network: NETWORK_VERBS.some((verb) => lowered.includes(verb)),
      target: command,
      haystack: command,
    };
  }
  if (toolName.startsWith("mcp__")) {
    const lowered = toolName.toLowerCase();
    const values: string[] = [];
    stringValues(input, values);
    const haystack = values.join(" ");
    return {
      network: MCP_NETWORK_HINTS.some((hint) => lowered.includes(hint)),
      target: haystack,
      haystack,
    };
  }
  return { network: false, target: "", haystack: "" };
}

/**
 * Substring matching on lowercased text. It over-matches (a blocked term inside
 * an unrelated word still blocks) and under-matches (any rewording escapes).
 * Over-matching is the safe direction here; under-matching is the hole named at
 * the top of this file.
 */
function firstMatch(policy: SearchPolicy, haystack: string): string | null {
  const lowered = haystack.toLowerCase();
  for (const list of [policy.terms, policy.urls, policy.domains])
    for (const entry of list) {
      if (entry.length === 0) continue;
      if (lowered.includes(entry)) return entry;
      // A stored url keeps the trailing slash `new URL` adds; a command line
      // usually does not.
      const trimmed = entry.replace(/\/+$/, "");
      if (trimmed !== entry && lowered.includes(trimmed)) return entry;
    }
  return null;
}

/**
 * The whole decision, as a pure function, so it can be tested without a build
 * and without a live Claude session. `search-guard.ts` is only a stdin/stdout
 * wrapper around this.
 *
 * A missing policy blocks every network call rather than allowing them: if
 * deleting `.aris/search-policy.json` bought a free network, the gate would be
 * one `rm` away from meaningless.
 */
export function decideNetworkCall(
  policy: SearchPolicy | null,
  toolName: string,
  toolInput: unknown,
): NetworkCallDecision {
  const shape = callShape(toolName, toolInput);
  // Reading the blocklist is not itself a network call, but it is the one local
  // action that would defeat the "the model never sees the list" property, so it
  // is recorded instead of being invisible.
  if (
    toolName === "Bash" &&
    shape.target.includes("search-policy.json") &&
    !shape.target.includes("search-audit")
  )
    return {
      decision: "policy_read",
      matched: null,
      target: truncate(shape.target),
      blocked: false,
    };
  if (!shape.network) return { decision: null, matched: null, target: "", blocked: false };
  const target = truncate(shape.target);
  if (policy === null) return { decision: "policy_missing", matched: null, target, blocked: true };
  const matched = firstMatch(policy, shape.haystack);
  if (matched !== null) return { decision: "blocked", matched, target, blocked: true };
  return { decision: "allowed", matched: null, target, blocked: false };
}

function entryDigest(entry: Omit<SearchAuditEntry, "entry_sha256">): string {
  return canonicalJsonSha256(entry, undefined, { schemaVersion: "search-audit-entry-v1" });
}

function readAuditLines(projectDir: string): string[] {
  const auditPath = searchAuditPath(projectDir);
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function parseEntry(line: string, index: number): SearchAuditEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return failA1("SEARCH_AUDIT_BROKEN", `ledger line ${index} is not JSON`);
  }
  if (!isRecord(value))
    return failA1("SEARCH_AUDIT_BROKEN", `ledger line ${index} is not an object`);
  return value as unknown as SearchAuditEntry;
}

/**
 * Appends one decision. The lock is held across read-last-line and write so two
 * concurrent tool calls cannot both chain off the same predecessor and produce
 * two entries with the same `seq`.
 */
export function appendSearchAuditEntry(
  projectDir: string,
  input: {
    tool: string;
    target: string;
    decision: SearchAuditDecision;
    matched: string | null;
    policy_sha256: string | null;
    ts?: string;
  },
): SearchAuditEntry {
  const auditPath = searchAuditPath(projectDir);
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const token = acquireStateFileLock(auditPath);
  try {
    const lines = readAuditLines(projectDir);
    const previous =
      lines.length === 0 ? null : parseEntry(lines[lines.length - 1], lines.length - 1);
    const body: Omit<SearchAuditEntry, "entry_sha256"> = {
      seq: previous === null ? 0 : previous.seq + 1,
      ts: input.ts ?? new Date().toISOString(),
      tool: input.tool,
      target: truncate(input.target),
      decision: input.decision,
      matched: input.matched,
      policy_sha256: input.policy_sha256,
      prev_sha256: previous === null ? GENESIS_PREV_SHA256 : previous.entry_sha256,
    };
    const entry: SearchAuditEntry = { ...body, entry_sha256: entryDigest(body) };
    fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  } finally {
    releaseStateFileLock(auditPath, token);
  }
}

export interface SearchAuditSummary {
  entries: number;
  blocked: number;
  allowed: number;
  by_tool: Record<string, number>;
  by_decision: Record<string, number>;
  /** The policy digest the most recent judged call ran under, `null` if none. */
  active_policy_sha256: string | null;
}

/**
 * Walks the chain. A break tells you the written history was edited after the
 * fact; it tells you nothing about a ledger that was written wholesale by
 * something other than the guard. See the note at the top of this file.
 */
export function verifySearchAudit(projectDir: string): SearchAuditSummary {
  const lines = readAuditLines(projectDir);
  if (lines.length === 0)
    failA1("SEARCH_AUDIT_MISSING", "no search ledger: the search guard was never installed");
  const summary: SearchAuditSummary = {
    entries: lines.length,
    blocked: 0,
    allowed: 0,
    by_tool: {},
    by_decision: {},
    active_policy_sha256: null,
  };
  let previousDigest = GENESIS_PREV_SHA256;
  for (const [index, line] of lines.entries()) {
    const entry = parseEntry(line, index);
    const { entry_sha256: claimed, ...body } = entry;
    if (entry.seq !== index)
      failA1("SEARCH_AUDIT_BROKEN", `ledger seq jumps at line ${index}`, `line[${index}].seq`);
    if (entry.prev_sha256 !== previousDigest)
      failA1("SEARCH_AUDIT_BROKEN", `ledger line ${index} does not chain`, `line[${index}]`);
    if (claimed !== entryDigest(body))
      failA1("SEARCH_AUDIT_BROKEN", `ledger line ${index} was edited`, `line[${index}]`);
    if (index === 0 && entry.decision !== "genesis")
      failA1("SEARCH_AUDIT_BROKEN", "ledger does not start with a genesis entry", "line[0]");
    previousDigest = claimed;
    if (entry.decision === "blocked") summary.blocked += 1;
    if (entry.decision === "allowed") summary.allowed += 1;
    if (entry.tool.length > 0) summary.by_tool[entry.tool] = (summary.by_tool[entry.tool] ?? 0) + 1;
    summary.by_decision[entry.decision] = (summary.by_decision[entry.decision] ?? 0) + 1;
    if (entry.policy_sha256 !== null) summary.active_policy_sha256 = entry.policy_sha256;
  }
  return summary;
}

/**
 * The submit-time gate. Three refusals, each naming a different failure:
 * the guard was never installed, the ledger was edited, or the gate spent the
 * round guarding a different contract than the one being submitted against.
 */
export function assertSearchAuditForContract(
  projectDir: string,
  contract: TesterSubmissionContract,
): SearchAuditSummary {
  const summary = verifySearchAudit(projectDir);
  const expected = searchPolicySha256(searchPolicyFromContract(contract));
  if (summary.active_policy_sha256 !== expected)
    failA1(
      "SEARCH_POLICY_MISMATCH",
      "the ledger's active policy is not the one this contract compiles to",
    );
  return summary;
}
