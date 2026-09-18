import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleRootSetupInput,
  detectSetupStages,
  experimentSkillDir,
  inferSetupItems,
  testerAgentConfigPath,
  type SetupStageId,
  type SetupStatus,
} from "../src/tools/project-setup.js";
import { rootCharterPath } from "../src/tools/root-charter.js";
import { createRootRun } from "../src/tools/run-contract.js";
import {
  appendSearchAuditEntry,
  searchPolicyFromContract,
  searchPolicyPath,
  searchPolicySha256,
} from "../src/tools/search-policy.js";
import type { TesterSubmissionContract } from "../src/tools/tester-agent.js";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-project-setup-"));
const project = path.join(root, "curriculum-rl");
fs.mkdirSync(project, { recursive: true });

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? "";
}

function stage(status: SetupStatus, id: SetupStageId) {
  const found = status.stages.find((s) => s.id === id);
  assert.ok(found !== undefined, `no stage ${id}`);
  return found;
}

function statusOf(runId?: string): SetupStatus {
  return detectSetupStages({ project_root: project, run_id: runId ?? null });
}

function runCli(args: string[]) {
  return spawnSync(
    "npx",
    ["--no-install", "tsx", path.join(packageRoot, "src", "tools", "project-setup-cli.ts"), ...args],
    { cwd: packageRoot, encoding: "utf-8", timeout: 60_000 },
  );
}

// --- 1. an empty directory blocks on everything -----------------------------

const empty = statusOf();
assert.deepEqual(empty.blocking, [
  "project_basics",
  "metric_target",
  "experiment_env",
  "tester_agent",
  "search_guard",
  "root_charter",
]);
assert.equal(empty.project_name, "curriculum-rl", "the slug must match the loop's step 0b slug");
assert.equal(stage(empty, "project_basics").next, "/research-setup");
// A missing CLAUDE.md must be reported, not thrown: the whole point of `status`
// is to name every unconfigured stage in one pass.
assert.equal(stage(empty, "metric_target").ready, false);
assert.deepEqual(stage(empty, "metric_target").blocked_by, ["project_basics"]);

// --- 2. stages turn green one at a time -------------------------------------

fs.writeFileSync(
  path.join(project, "CLAUDE.md"),
  "# curriculum-rl\n\n## Metric Target\n\nprimary: 0.85 F1\ndirection: higher_better\ntolerance: 0.02\n",
);
fs.writeFileSync(
  path.join(project, "RESEARCH_BRIEF.md"),
  [
    "# Research Brief",
    "",
    "## Baseline Reproduction (first experiment)",
    "",
    "**Method**: supervised fine-tuning on the released split",
    "**Code / run location**: repo/baseline/train.py",
    "",
    "## Non-Goals",
    "",
    "nothing",
    "",
  ].join("\n"),
);
fs.mkdirSync(path.join(project, "research-wiki"), { recursive: true });
fs.writeFileSync(path.join(project, "research-wiki", "index.md"), "# wiki\n");

let now = statusOf();
assert.equal(stage(now, "project_basics").ready, true);
assert.equal(stage(now, "metric_target").ready, true);
assert.equal(stage(now, "metric_target").detail?.direction, "higher_better");

const skillDir = experimentSkillDir(project);
fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(skillDir, "env.json"),
  JSON.stringify({
    version: 2,
    status: "complete",
    backend_hint: "slurm",
    preparation: {
      files: { ssh_alias: "gpu-box", remote_path: "/scratch/curriculum-rl" },
    },
    resources: { type: "gpu", ids: ["0", "1", "2", "3"] },
  }),
);

now = statusOf();
assert.equal(stage(now, "experiment_env").ready, true);

// A `complete` env.json with no scripts/ is a configuration that cannot run
// anything, so it is not ready -- the same pair of conditions step 0b checks.
fs.rmSync(path.join(skillDir, "scripts"), { recursive: true });
assert.equal(stage(statusOf(), "experiment_env").ready, false);
fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });

const testerConfig = {
  schema_version: 1,
  mode: "tester_agent",
  tester_id: "tester:curriculum",
  project_id: "project:curriculum-rl",
  ssh_target: "tester@tester-host.invalid",
  daemon_port: 6790,
  agent_id: "agent:tester-1",
  remote_receipt_dir: "/home/tester/aris/receipts",
  public_key_path: path.join(project, ".aris", "tester-public-key.pem"),
  public_key_sha256: "a".repeat(64),
  submission_contract_sha256: "b".repeat(64),
  request_timeout_ms: 600_000,
};
fs.mkdirSync(path.join(project, ".aris"), { recursive: true });
fs.writeFileSync(testerAgentConfigPath(project), JSON.stringify(testerConfig));

now = statusOf();
assert.equal(stage(now, "tester_agent").ready, true);
// The search guard cannot be installed before there is a contract to compile.
assert.deepEqual(stage(now, "search_guard").blocked_by, ["tester_agent"]);

const contract: TesterSubmissionContract = {
  schema_version: 1,
  contract_id: "contract:1",
  project_id: "project:curriculum-rl",
  tester_id: "tester:curriculum",
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
const policy = searchPolicyFromContract(contract);
fs.writeFileSync(searchPolicyPath(project), JSON.stringify(policy, null, 2));

// A policy with no ledger means the guard was never installed. That is not the
// same as "this round made no network calls", so it stays red.
assert.equal(stage(statusOf(), "search_guard").ready, false);

appendSearchAuditEntry(project, {
  tool: "",
  target: "",
  decision: "genesis",
  matched: null,
  policy_sha256: searchPolicySha256(policy),
});
now = statusOf();
assert.equal(stage(now, "search_guard").ready, true);
assert.equal(stage(now, "search_guard").detail?.ledger_entries, 1);

// --- 3. the report never reproduces the blocklist ---------------------------

const printed = JSON.stringify(statusOf("run-root-1"));
for (const secret of ["humaneval", "mbpp+", "human-eval", "openai_humaneval"]) {
  assert.ok(!printed.toLowerCase().includes(secret), `status leaked '${secret}'`);
}

// --- 4. inference: source-carrying values, and honest gaps ------------------

const inference = inferSetupItems(project);

const thresholds = inference.inferred.thresholds;
assert.ok(thresholds !== undefined, "thresholds must be inferable from the metric target");
assert.deepEqual(thresholds.value, {
  primary: { name: "F1", direction: "higher_better", target: 0.85 },
  constraints: [],
});
assert.ok(thresholds.source.includes("CLAUDE.md"), "an inferred value must name its source");

const resource = inference.inferred.resource;
assert.ok(resource !== undefined);
const platform = (resource.value as { platforms: Record<string, unknown>[] }).platforms[0];
assert.equal(platform.platform_id, "platform:slurm");
assert.equal(platform.access_ref, "gpu-box");
assert.deepEqual(platform.accelerators, [{ count: 4 }]);
// env.json has no device model anywhere. Inventing one would be sealed into the
// frozen inventory and then misclassify every resource failure for the run.
assert.ok(
  !Object.hasOwn((platform.accelerators as Record<string, unknown>[])[0], "model"),
  "the accelerator model must not be invented",
);
const asked = new Set(inference.needs_owner.map((q) => `${q.item}.${q.field}`));
for (const field of [
  "resource.platforms[0].accelerators[0].model",
  "resource.platforms[0].quota",
  "resource.platforms[0].max_wall_clock_ms",
  "resource.platforms[0].network.allowed_endpoints",
  "exposure.exposure_limit",
  "limits.owner_limits",
]) {
  assert.ok(asked.has(field), `${field} must be asked, not guessed`);
}

const baseline = inference.inferred.baseline;
assert.ok(baseline !== undefined);
assert.deepEqual((baseline.value as { code_baseline: unknown }).code_baseline, {
  ref: "repo/baseline/train.py",
});

// tester and tester_agent both come off the emitted config, so neither is asked.
assert.equal(inference.inferred.tester_agent?.value !== undefined, true);
assert.equal((inference.inferred.tester?.value as { tester_id: string }).tester_id, "tester:curriculum");

// --- 5. assemble refuses an incomplete answer set ---------------------------

const header = {
  run_id: "run-root-1",
  task_id: "task:curriculum",
  workflow_id: "wf:curriculum",
  setup_revision: "rev-1",
  problem: "raise F1 on the held-out split",
  expected_output: { kind: "workflow" },
};

try {
  assembleRootSetupInput({ project_root: project, answers: header });
  assert.fail("assemble must refuse while exposure and limits are unanswered");
} catch (error) {
  assert.equal(codeOf(error), "SETUP_INCOMPLETE");
  assert.deepEqual((error as { missing: string[] }).missing, ["exposure", "limits"]);
}

// A missing header field is a different failure: there is nothing to assemble.
try {
  assembleRootSetupInput({ project_root: project, answers: { run_id: "run-root-1" } });
  assert.fail("assemble must refuse an answers file with no task id");
} catch (error) {
  assert.equal(codeOf(error), "INVALID_VALUE");
}

// --- 6. answers override, inferred values survive the parts not answered ----

const answers = {
  ...header,
  exposure_limit: 1,
  owner_limits: {
    revision: "limits-1",
    max_bundled_positions_per_graph: 2,
    max_nodes: 24,
    max_edges: 48,
    max_fan_out_per_node: 4,
    max_unrolled_cycles: 2,
    max_jobs_per_candidate: 8,
    max_compute_per_candidate: { amount: 40, unit: "gpu_hours" },
  },
  validation_thresholds: { constraints: [{ name: "latency_ms", direction: "lower_better", target: 800 }] },
};

const assembled = assembleRootSetupInput({ project_root: project, answers });
const input = assembled.input as unknown as Record<string, unknown>;
assert.deepEqual(assembled.from_answers.sort(), ["exposure", "limits", "thresholds"]);
assert.deepEqual(assembled.from_inference.sort(), ["baseline", "resource", "tester", "tester_agent"]);
// The answer supplied only `constraints`; the inferred primary must still be there.
assert.deepEqual(input.validation_thresholds, {
  primary: { name: "F1", direction: "higher_better", target: 0.85 },
  constraints: [{ name: "latency_ms", direction: "lower_better", target: 800 }],
});
assert.equal(input.project_root, project);
assert.equal((input.tester_agent_config as { tester_id: string }).tester_id, "tester:curriculum");

// --- 7. the CLI exits non-zero while anything is unconfigured ---------------

const blocked = runCli(["status", "--project", project, "--run-id", "run-root-1"]);
assert.equal(blocked.status, 1, blocked.stderr);
assert.deepEqual(
  (JSON.parse(blocked.stdout) as SetupStatus).blocking,
  ["root_charter"],
  "only the charter is left",
);

createRootRun({ project_root: project, run_id: "run-root-1" });
fs.writeFileSync(rootCharterPath(project, "run-root-1"), "{}\n");
const green = runCli(["status", "--project", project, "--run-id", "run-root-1"]);
assert.equal(green.status, 0, green.stderr);
assert.deepEqual((JSON.parse(green.stdout) as SetupStatus).blocking, []);

fs.rmSync(root, { recursive: true, force: true });
console.log("project setup: stage detection, sourced inference, owner gaps, assembly merge passed");
