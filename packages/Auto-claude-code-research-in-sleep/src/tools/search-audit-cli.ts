#!/usr/bin/env node
/**
 * The research side of the search gate: compile the tester's declared
 * exclusions into a policy, install the hook that enforces it, and read the
 * ledger back.
 *
 * Nothing here ever prints the blocklist. `emit-policy` prints counts and a
 * digest, `summary` prints decision counts. The one place a blocked term
 * appears is the refusal the guard writes when the model has already typed it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCli, runCli } from "../lib/cli.js";
import {
  appendSearchAuditEntry,
  readSearchPolicy,
  searchAuditPath,
  searchPolicyFromContract,
  searchPolicyPath,
  searchPolicySha256,
  verifySearchAudit,
} from "./search-policy.js";
import { readTesterSubmissionContract } from "./tester-agent.js";
import { A1Error } from "./workflow-spec.js";

const program = createCli(
  "search-audit",
  "Compile the tester's search exclusions into an enforced policy and audit the ledger",
);

function reject(fallback: string, error: unknown): void {
  // The codes are local facts (no ledger, broken chain, wrong policy). They say
  // what to fix without quoting anything the tester declared.
  console.error(
    JSON.stringify({
      status: "failed",
      reason: error instanceof A1Error ? error.code : fallback,
    }),
  );
  process.exitCode = 1;
}

/** The directory this CLI was loaded from: `dist` in a build, `src` under tsx. */
function distRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function hookSnippet(): Record<string, unknown> {
  const templatePath = path.resolve(
    distRoot(),
    "..",
    "templates",
    "claude-hooks",
    "search_guard.json",
  );
  const raw = fs.readFileSync(templatePath, "utf-8").replaceAll("${ARIS_DIST}", distRoot());
  const parsed = JSON.parse(raw) as { hooks: Record<string, unknown> };
  return parsed.hooks;
}

interface PreToolUseEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

program
  .command("emit-policy")
  .description("Compile a signed tester contract into the project's search policy")
  .requiredOption("--contract <path>", "submission contract written by tester-agent declare")
  .requiredOption("--project <dir>", "research project directory")
  .option("--rotate", "allow replacing a policy that is already installed")
  .action((options: { contract: string; project: string; rotate?: boolean }) => {
    try {
      const contract = readTesterSubmissionContract(options.contract);
      const policy = searchPolicyFromContract(contract);
      const digest = searchPolicySha256(policy);
      const policyPath = searchPolicyPath(options.project);
      const existing = readSearchPolicy(options.project);
      if (existing !== null && searchPolicySha256(existing) === digest) {
        console.log(JSON.stringify({ status: "unchanged", policy_sha256: digest }));
        return;
      }
      if (existing !== null) {
        if (options.rotate !== true)
          throw new A1Error(
            "SEARCH_POLICY_ROTATION_REQUIRED",
            "a different policy is installed; pass --rotate to replace it",
          );
        // A rotation is recorded in the ledger, so a round that ran under two
        // policies reads as two policies rather than as one.
        appendSearchAuditEntry(options.project, {
          tool: "",
          target: "",
          decision: "policy_rotated",
          matched: null,
          policy_sha256: digest,
        });
      }
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
      console.log(
        JSON.stringify({
          status: existing === null ? "installed" : "rotated",
          policy_path: policyPath,
          policy_sha256: digest,
          // Counts only. The entries themselves stay in the file.
          terms: policy.terms.length,
          urls: policy.urls.length,
          domains: policy.domains.length,
        }),
      );
    } catch (error) {
      reject("search_policy_rejected", error);
    }
  });

program
  .command("install-guard")
  .description("Merge the PreToolUse guard into the project's settings and open the ledger")
  .requiredOption("--project <dir>", "research project directory")
  .action((options: { project: string }) => {
    try {
      const policy = readSearchPolicy(options.project);
      if (policy === null)
        throw new A1Error(
          "SEARCH_POLICY_MISSING",
          "emit-policy must run before the guard is installed",
        );
      const snippet = hookSnippet();
      const settingsPath = path.join(options.project, ".claude", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const settings: Record<string, unknown> = fs.existsSync(settingsPath)
        ? (JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>)
        : {};
      if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
      const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
      const preToolUse = (hooks.PreToolUse ?? []) as PreToolUseEntry[];
      const incoming = (snippet.PreToolUse as PreToolUseEntry[])[0];
      const command = incoming.hooks?.[0]?.command;
      // Idempotent by command string: re-running install-guard must not stack a
      // second copy of the same hook onto the same matcher.
      const already = preToolUse.some((entry) =>
        (entry.hooks ?? []).some((hook) => hook.command === command),
      );
      if (!already) preToolUse.push(incoming);
      settings.hooks = { ...hooks, PreToolUse: preToolUse };
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

      // The genesis entry is what distinguishes "this round never made a network
      // call" from "the guard was never installed". Without it, submit refuses.
      const opened = !fs.existsSync(searchAuditPath(options.project));
      if (opened)
        appendSearchAuditEntry(options.project, {
          tool: "",
          target: "",
          decision: "genesis",
          matched: null,
          policy_sha256: searchPolicySha256(policy),
        });
      console.log(
        JSON.stringify({
          status: already && !opened ? "unchanged" : "installed",
          settings_path: settingsPath,
          audit_path: searchAuditPath(options.project),
        }),
      );
    } catch (error) {
      reject("search_guard_install_failed", error);
    }
  });

program
  .command("verify")
  .description("Walk the ledger's hash chain and sequence")
  .requiredOption("--project <dir>", "research project directory")
  .action((options: { project: string }) => {
    try {
      const summary = verifySearchAudit(options.project);
      console.log(
        JSON.stringify({
          status: "ok",
          entries: summary.entries,
          active_policy_sha256: summary.active_policy_sha256,
        }),
      );
    } catch (error) {
      reject("search_audit_rejected", error);
    }
  });

program
  .command("summary")
  .description("Print how much network the round used and how much of it was refused")
  .requiredOption("--project <dir>", "research project directory")
  .action((options: { project: string }) => {
    try {
      console.log(JSON.stringify(verifySearchAudit(options.project)));
    } catch (error) {
      reject("search_audit_rejected", error);
    }
  });

runCli(program);
