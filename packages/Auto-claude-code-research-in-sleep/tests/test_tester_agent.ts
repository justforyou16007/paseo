import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonBytes, canonicalJsonString } from "../src/tools/canonical-json.js";
import { buildTesterFeedback } from "../src/tools/tester-feedback.js";
import { createRootRun, createRun } from "../src/tools/run-contract.js";
import {
  assertOutermostSubmissionRun,
  bindSubmissionToContract,
  cleanupTesterDeployment,
  declareTesterSubmissionContract,
  deployTesterAgent,
  probeTesterAgentHost,
  readTesterAgentConfig,
  submitToTesterAgent,
  testerAgentSubmissionSha256,
  testerAgentConfigFromDeployment,
  validateTesterSubmissionContract,
  testerDeploymentLayout,
  testerSubmissionContractSha256,
  validateTesterDeploymentRecord,
  writeTesterAgentResponse,
  type TesterAgentCommand,
  type TesterAgentConfig,
  type TesterAgentResponse,
  type TesterAgentSubmission,
  type TesterAgentTransport,
  type TesterSubmissionContract,
} from "../src/tools/tester-agent.js";
import {
  validateTesterPublicConclusion,
  validateTesterPublicFeedback,
} from "../src/tools/tester-public-receipt.js";

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

async function expectCodeAsync(expected: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.equal(codeOf(error), expected, `expected ${expected}, got ${codeOf(error)}`);
    return;
  }
  assert.fail(`expected ${expected}, nothing was thrown`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-tester-agent-"));
const H = "a".repeat(64);

// The tester container's key. Only the public half exists on this side, exactly
// as it would after a deployment.
const testerKeys = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = testerKeys.publicKey.export({ type: "spki", format: "pem" }) as string;
const publicKeyPath = path.join(root, "tester.pub");
fs.writeFileSync(publicKeyPath, publicKeyPem);
const publicKeySha256 = crypto.createHash("sha256").update(publicKeyPem).digest("hex");

const endpoint = {
  tester_id: "tester:agent",
  project_id: "project:agent",
  container: "aris-tester",
  container_user: "paseo",
  agent_id: "agent-1",
  remote_receipt_dir: "/srv/aris-tester/receipts",
  public_key_path: publicKeyPath,
  public_key_sha256: publicKeySha256,
  request_timeout_ms: 60_000,
};

const contract: TesterSubmissionContract = {
  schema_version: 1,
  contract_id: "contract:1",
  project_id: endpoint.project_id,
  tester_id: endpoint.tester_id,
  tester_version: "tester:v1",
  case_manifest_sha256: "c".repeat(64),
  slots: [
    { slot_id: "slot_ref", role: "reference", required: true },
    { slot_id: "slot_cand", role: "candidate", required: true },
  ],
  submission_fields: [
    { name: "runner", type: "string", required: true },
    { name: "repeats", type: "integer", required: false },
  ],
  usage: "run each artifact with the declared runner",
  runtime: { kind: "docker", image_digest: "d".repeat(64) },
  search_exclusions: {
    terms: ["humaneval", "mbpp+"],
    urls: ["https://github.com/openai/human-eval"],
    domains: ["huggingface.co/datasets/openai_humaneval"],
  },
};
const contractSha256 = testerSubmissionContractSha256(contract);

function sign(prefix: string, value: unknown): string {
  return crypto
    .sign(
      null,
      Buffer.concat([Buffer.from(prefix), canonicalJsonBytes(value)]),
      testerKeys.privateKey,
    )
    .toString("base64");
}

const config: TesterAgentConfig = {
  schema_version: 1,
  mode: "tester_agent",
  ...endpoint,
  submission_contract_sha256: contractSha256,
};
const configPath = path.join(root, "tester-agent-config.json");
fs.writeFileSync(configPath, JSON.stringify(config));

// --- 1. the pinned public key is what makes the config trustworthy ----------

assert.deepEqual(readTesterAgentConfig(configPath), config);

const swappedKeyPath = path.join(root, "swapped.pub");
fs.writeFileSync(
  swappedKeyPath,
  crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string,
);
const swappedConfigPath = path.join(root, "swapped-config.json");
fs.writeFileSync(
  swappedConfigPath,
  JSON.stringify({ ...config, public_key_path: swappedKeyPath }),
);
expectCode("TESTER_AGENT_KEY_MISMATCH", () => readTesterAgentConfig(swappedConfigPath));

// --- 2. contract declaration is accepted only under the tester's own key ----

function transportFor(receipt: unknown, options: { controlCode?: number } = {}): {
  transport: TesterAgentTransport;
  commands: TesterAgentCommand[];
} {
  const commands: TesterAgentCommand[] = [];
  const transport: TesterAgentTransport = async (command) => {
    commands.push(command);
    if (command.kind === "control") return { code: options.controlCode ?? 0, stdout: "{}" };
    return { code: 0, stdout: typeof receipt === "string" ? receipt : JSON.stringify(receipt) };
  };
  return { transport, commands };
}

const signedContract = { contract, signature: sign("aris-tester-submission-contract-v1\n", contract) };
const declared = await declareTesterSubmissionContract({
  endpoint,
  need: "long-horizon stability under a shifting input distribution",
  transport: transportFor(signedContract).transport,
});
assert.deepEqual(declared.contract, contract);
assert.equal(declared.contract_sha256, contractSha256);

const foreignKeys = crypto.generateKeyPairSync("ed25519");
const forgedContract = {
  contract,
  signature: crypto
    .sign(
      null,
      Buffer.concat([
        Buffer.from("aris-tester-submission-contract-v1\n"),
        canonicalJsonBytes(contract),
      ]),
      foreignKeys.privateKey,
    )
    .toString("base64"),
};
await expectCodeAsync("TESTER_SIGNATURE_INVALID", () =>
  declareTesterSubmissionContract({
    endpoint,
    need: "same need",
    transport: transportFor(forgedContract).transport,
  }),
);

// A control command that fails is unreachable, and the failure text carries no
// container name, no container path and no container stderr.
await expectCodeAsync("TESTER_AGENT_UNREACHABLE", () =>
  declareTesterSubmissionContract({
    endpoint,
    need: "same need",
    transport: transportFor(signedContract, { controlCode: 1 }).transport,
  }),
);

// --- 3. a submission is checked against the declared shape, locally ---------

const submissionDraft = {
  submission_id: "submission:1",
  tester_run_id: "tester-run-1",
  outer_run_id: "outer-1",
  task_id: "task:1",
  task_setup_revision: "setup:1",
  promotion_trial_id: "trial:1",
  tester_definition_sha256: H,
  harness_sha256: H,
  input_snapshot_sha256: H,
  input_distribution_sha256: H,
  model_assignment_sha256: H,
  judge_binding_id: null,
  slots: {
    slot_ref: { artifact_id: "artifact:ref", artifact_sha256: H },
    slot_cand: { artifact_id: "artifact:cand", artifact_sha256: "b".repeat(64) },
  },
  fields: { runner: "harness.sh" },
};
const submission: TesterAgentSubmission = bindSubmissionToContract(
  contract,
  config,
  submissionDraft,
);
assert.equal(submission.contract_sha256, contractSha256);
assert.equal(submission.tester_version, contract.tester_version);

expectCode("TESTER_SUBMISSION_INVALID", () =>
  bindSubmissionToContract(contract, config, {
    ...submissionDraft,
    slots: { slot_ref: submissionDraft.slots.slot_ref },
  }),
);
expectCode("TESTER_SUBMISSION_INVALID", () =>
  bindSubmissionToContract(contract, config, {
    ...submissionDraft,
    fields: { ...submissionDraft.fields, undeclared: "x" },
  }),
);
expectCode("TESTER_SUBMISSION_INVALID", () =>
  bindSubmissionToContract(contract, config, {
    ...submissionDraft,
    slots: { ...submissionDraft.slots, slot_extra: { artifact_id: "a:x", artifact_sha256: H } },
  }),
);
// A field whose value does not match its declared type fails through the
// shared type helpers, so it surfaces their code rather than a tester-specific
// one. The CLI collapses both to the same refusal.
expectCode("INVALID_VALUE", () =>
  bindSubmissionToContract(contract, config, {
    ...submissionDraft,
    fields: { runner: "harness.sh", repeats: "three" },
  }),
);

// Re-declaring produces a different contract; the config freeze is what stops
// a run from being judged by a test nobody sealed.
const redeclared = { ...contract, contract_id: "contract:2" };
expectCode("TESTER_CONTRACT_MISMATCH", () =>
  bindSubmissionToContract(redeclared, config, submissionDraft),
);

// --- 4. what crosses the wire is digests and ids, never a model name --------

const wire = canonicalJsonString(submission);
for (const name of ["claude", "gpt", "opus", "codex", "sonnet", "baseline_model", "arm_a"])
  assert.equal(wire.toLowerCase().includes(name), false, `submission leaked '${name}'`);
assert.deepEqual(Object.keys(submission.slots).sort(), ["slot_cand", "slot_ref"]);

// --- 5. a verified response round trip, and a tampered one ------------------

const submissionSha256 = testerAgentSubmissionSha256(submission);

function receiptFor(overrides: {
  metrics?: Record<string, number>;
  status?: "passed" | "rejected";
}): Record<string, unknown> {
  const status = overrides.status ?? "passed";
  const conclusion = validateTesterPublicConclusion({
    schema_version: 1,
    tester_run_id: submission.tester_run_id,
    outer_run_id: submission.outer_run_id,
    task_id: submission.task_id,
    promotion_trial_id: submission.promotion_trial_id,
    outer_iteration: 1,
    generation: 0,
    wave_id: "wave:1",
    tester_definition_sha256: submission.tester_definition_sha256,
    harness_sha256: submission.harness_sha256,
    matching_baseline_artifact_sha256: submission.slots.slot_ref!.artifact_sha256,
    finalist_artifact_sha256: submission.slots.slot_cand!.artifact_sha256,
    input_snapshot_sha256: submission.input_snapshot_sha256,
    input_distribution_sha256: submission.input_distribution_sha256,
    model_assignment_sha256: submission.model_assignment_sha256,
    private_result_sha256: H,
    review_receipt_sha256: H,
    status,
  });
  const feedbackEnvelope = validateTesterPublicFeedback({
    schema_version: 1,
    tester_run_id: submission.tester_run_id,
    outer_run_id: submission.outer_run_id,
    task_id: submission.task_id,
    promotion_trial_id: submission.promotion_trial_id,
    outer_iteration: 1,
    generation: 0,
    wave_id: "wave:1",
    tester_definition_sha256: submission.tester_definition_sha256,
    harness_sha256: submission.harness_sha256,
    matching_baseline_artifact_sha256: submission.slots.slot_ref!.artifact_sha256,
    finalist_artifact_sha256: submission.slots.slot_cand!.artifact_sha256,
    input_snapshot_sha256: submission.input_snapshot_sha256,
    input_distribution_sha256: submission.input_distribution_sha256,
    tester_version: submission.tester_version,
    tester_conclusion_status: status,
    feedback: buildTesterFeedback({
      schema_version: 1,
      task_id: submission.task_id,
      task_setup_revision: submission.task_setup_revision,
      input_snapshot_sha256: submission.input_snapshot_sha256,
      promotion_trial_id: submission.promotion_trial_id,
      tester_version: submission.tester_version,
      conclusion: "improved",
      directions: ["long_horizon_stability"],
      advice: ["increase_long_horizon_consistency"],
      confidence: "high",
      metrics: overrides.metrics ?? { tester_score: 0.9 },
    }),
  });
  const unsigned = {
    schema_version: 1,
    mode: "tester_agent",
    project_id: config.project_id,
    submission_id: submission.submission_id,
    submission_sha256: submissionSha256,
    tester_run_id: submission.tester_run_id,
    promotion_trial_id: submission.promotion_trial_id,
    status,
    error_analysis: status === "passed" ? [] : ["candidate_not_improved"],
    signed_conclusion: {
      conclusion,
      signature: sign("aris-tester-public-conclusion-v1\n", conclusion),
    },
    signed_feedback: {
      feedback: feedbackEnvelope,
      signature: sign("aris-tester-public-feedback-v1\n", feedbackEnvelope),
    },
  };
  return { ...unsigned, response_signature: sign("aris-tester-agent-response-v1\n", unsigned) };
}

const receipt = receiptFor({});
const { transport, commands } = transportFor(receipt);
const response: TesterAgentResponse = await submitToTesterAgent({
  config,
  contract,
  submission,
  transport,
});
assert.equal(response.status, "passed");
assert.equal(response.submission_sha256, submissionSha256);

// Control plane drives the agent; data plane fetches one named receipt. Both
// are `docker exec` into the tester container as the daemon's account, and the
// Paseo CLI inside finds its own daemon, so no port is published to the host.
const inContainer = ["docker", "exec", "--user", "paseo", "aris-tester"];
assert.equal(commands[0]!.kind, "control");
assert.deepEqual(commands[0]!.argv.slice(0, 9), [
  ...inContainer,
  "paseo",
  "agent",
  "send",
  config.agent_id,
]);
assert.equal(commands[0]!.argv.includes("--host"), false);
assert.equal(commands[1]!.kind, "fetch");
// `docker exec` runs no shell, so the receipt path is passed as it is.
assert.deepEqual(commands[1]!.argv, [
  ...inContainer,
  "cat",
  "--",
  `${config.remote_receipt_dir}/response-${submissionSha256}.json`,
]);

// Raising a published metric does not survive, even when the forger repairs
// the envelope's own self-digest: `buildTesterFeedback` recomputes
// `feedback_event_id`, so the envelope validates, and the response signature
// still covers the old bytes. The research side cannot repair that -- it does
// not hold the key.
const raised = receiptFor({ metrics: { tester_score: 0.99 } });
await expectCodeAsync("TESTER_SIGNATURE_INVALID", () =>
  submitToTesterAgent({
    config,
    contract,
    submission,
    transport: transportFor({ ...receipt, signed_feedback: raised.signed_feedback }).transport,
  }),
);

// The envelope signature is checked on its own bytes too: a feedback envelope
// signed by some other key is refused even inside an outer response that the
// tester's key did sign.
const foreignSigned = receiptFor({});
const foreignFeedback = (foreignSigned.signed_feedback as { feedback: unknown }).feedback;
const foreignUnsigned = {
  ...(() => {
    const { response_signature: _unused, ...rest } = foreignSigned;
    return rest;
  })(),
  signed_feedback: {
    feedback: foreignFeedback,
    signature: crypto
      .sign(
        null,
        Buffer.concat([
          Buffer.from("aris-tester-public-feedback-v1\n"),
          canonicalJsonBytes(foreignFeedback),
        ]),
        foreignKeys.privateKey,
      )
      .toString("base64"),
  },
};
await expectCodeAsync("TESTER_SIGNATURE_INVALID", () =>
  submitToTesterAgent({
    config,
    contract,
    submission,
    transport: transportFor({
      ...foreignUnsigned,
      response_signature: sign("aris-tester-agent-response-v1\n", foreignUnsigned),
    }).transport,
  }),
);

// A receipt bound to a different submission is refused even when it verifies.
const otherSubmission = bindSubmissionToContract(contract, config, {
  ...submissionDraft,
  submission_id: "submission:2",
});
await expectCodeAsync("TESTER_AGENT_BINDING_MISMATCH", () =>
  submitToTesterAgent({
    config,
    contract,
    submission: otherSubmission,
    transport: transportFor(receipt).transport,
  }),
);

// --- 6. transport failures stay coarse -------------------------------------

await expectCodeAsync("TESTER_AGENT_RESPONSE_INVALID", () =>
  submitToTesterAgent({
    config,
    contract,
    submission,
    transport: async (command) =>
      command.kind === "control"
        ? { code: 0, stdout: "{}" }
        : { code: 0, stdout: "x".repeat(128 * 1024 + 1) },
  }),
);
await expectCodeAsync("TESTER_AGENT_RESPONSE_INVALID", () =>
  submitToTesterAgent({
    config,
    contract,
    submission,
    transport: transportFor("not json at all").transport,
  }),
);
await expectCodeAsync("TESTER_AGENT_UNREACHABLE", () =>
  submitToTesterAgent({
    config,
    contract,
    submission,
    transport: async (command) =>
      command.kind === "control" ? { code: 0, stdout: "{}" } : { code: 255, stdout: "" },
  }),
);

// --- 7. only a response verified in this process reaches disk --------------

const outputDir = path.join(root, "out");
const written = writeTesterAgentResponse(outputDir, response);
assert.equal(fs.existsSync(written.response_path), true);
assert.equal(fs.existsSync(written.conclusion_path!), true);
assert.equal(fs.existsSync(written.feedback_path!), true);

expectCode("TESTER_AGENT_RESPONSE_NOT_VERIFIED", () =>
  writeTesterAgentResponse(path.join(root, "out2"), { ...response }),
);
assert.equal(fs.existsSync(path.join(root, "out2")), false);

// --- 8. probe reports each layer separately --------------------------------

const probeCommands: TesterAgentCommand[] = [];
const probe = await probeTesterAgentHost({
  endpoint: { container: "aris-tester", container_user: "paseo", request_timeout_ms: 10_000 },
  transport: async (command) => {
    probeCommands.push(command);
    if (command.argv.includes("command -v claude")) return { code: 1, stdout: "" };
    return { code: 0, stdout: "[]" };
  },
});
assert.deepEqual(probe, { container: true, daemon: true, claude: false, docker: true });
// Every step runs inside the container, including the daemon check.
for (const command of probeCommands) assert.deepEqual(command.argv.slice(0, 5), inContainer);
assert.deepEqual(probeCommands.map((command) => command.kind), [
  "fetch",
  "control",
  "fetch",
  "fetch",
]);

// A tester container that cannot start containers of its own is not
// deployable: the tester's manual forbids running a submitted artifact in the
// container holding the key and the cases, so there would be nowhere left to
// run it.
const hostlessProbe = await probeTesterAgentHost({
  endpoint: { container: "aris-tester", container_user: "paseo", request_timeout_ms: 10_000 },
  transport: async (command) =>
    command.argv.at(-2) === "docker" && command.argv.at(-1) === "info"
      ? { code: 1, stdout: "" }
      : { code: 0, stdout: "[]" },
});
assert.deepEqual(hostlessProbe, { container: true, daemon: true, claude: true, docker: false });

const deadProbe = await probeTesterAgentHost({
  endpoint: { container: "aris-tester", container_user: "paseo", request_timeout_ms: 10_000 },
  transport: async () => ({ code: 255, stdout: "" }),
});
assert.deepEqual(deadProbe, { container: false, daemon: false, claude: false, docker: false });

// The container name and the account reach the docker command line, so a value
// docker would read as an option is refused before anything is spawned.
for (const target of [
  { container: "--privileged", container_user: "paseo" },
  { container: "aris-tester", container_user: "-u0" },
  { container: "aris tester", container_user: "paseo" },
])
  await expectCodeAsync("TESTER_AGENT_CONFIG_INVALID", () =>
    probeTesterAgentHost({
      endpoint: { ...target, request_timeout_ms: 10_000 },
      transport: async () => assert.fail("nothing may be spawned for an invalid target"),
    }),
  );

// --- 9. cleanup only removes a staging directory this layout produced ------

const layout = testerDeploymentLayout("/srv/aris-tester");
const localBundle = path.join(root, "bundle");
fs.mkdirSync(localBundle, { recursive: true });
const cleaned = await cleanupTesterDeployment({
  target: { container: "aris-tester", container_user: "paseo" },
  remote_staging_dir: layout.staging_dir,
  local_bundle_dir: localBundle,
  request_timeout_ms: 10_000,
  transport: async () => ({ code: 0, stdout: "" }),
});
assert.deepEqual(cleaned.removed, [`aris-tester:${layout.staging_dir}`, localBundle]);
assert.equal(fs.existsSync(localBundle), false);

// `/` never reaches the staging rule -- it is not a usable path to begin with.
for (const [refused, code] of [
  ["/", "INVALID_PATH"],
  ["/srv", "TESTER_CLEANUP_REFUSED"],
  ["/srv/aris-tester", "TESTER_CLEANUP_REFUSED"],
  ["/srv/aris-tester/work", "TESTER_CLEANUP_REFUSED"],
  ["/staging", "TESTER_CLEANUP_REFUSED"],
] as const)
  await expectCodeAsync(code, () =>
    cleanupTesterDeployment({
      target: { container: "aris-tester", container_user: "paseo" },
      remote_staging_dir: refused,
      local_bundle_dir: null,
      request_timeout_ms: 10_000,
      transport: async () => ({ code: 0, stdout: "" }),
    }),
  );

// --- 9b. deploy builds everything inside the container -------------------

// `docker cp` writes root-owned files, so the bundle goes to staging and one
// root command copies it into the work directory and hands both to the daemon's
// account. Everything else runs as that account, and the private key is never
// read: only the public half comes back out.
const deployCommands: TesterAgentCommand[] = [];
const deployedKeyPath = path.join(root, "deployed", "tester.pub");
const deployRequest = {
  tester_id: endpoint.tester_id,
  project_id: endpoint.project_id,
  container: "aris-tester",
  container_user: "paseo",
  remote_home: "/home/paseo/aris",
  local_bundle_dir: localBundle,
  public_key_path: deployedKeyPath,
  provider: "claude/claude-opus-5",
  request_timeout_ms: 10_000,
};
const deployLayout = testerDeploymentLayout(deployRequest.remote_home);
const deployed = await deployTesterAgent({
  request: deployRequest,
  transport: async (command) => {
    deployCommands.push(command);
    if (command.argv.includes("run")) return { code: 0, stdout: '{"agentId":"agent-7"}' };
    if (command.argv.at(-1) === deployLayout.public_key_path)
      return { code: 0, stdout: publicKeyPem };
    return { code: 0, stdout: "" };
  },
});
assert.equal(deployed.agent_id, "agent-7");
assert.equal(deployed.public_key_sha256, publicKeySha256);
assert.equal(fs.readFileSync(deployedKeyPath, "utf8"), publicKeyPem);
const [provision, copy, own, run, fetchKey, ...extra] = deployCommands;
assert.equal(extra.length, 0);
assert.deepEqual(provision!.argv.slice(0, 5), inContainer);
assert.deepEqual(copy!.argv, [
  "docker",
  "cp",
  `${localBundle}/.`,
  `aris-tester:${deployLayout.staging_dir}`,
]);
assert.deepEqual(own!.argv.slice(0, 5), ["docker", "exec", "--user", "root", "aris-tester"]);
assert.match(own!.argv.at(-1)!, /chown -R 'paseo'/);
assert.deepEqual(run!.argv.slice(0, 8), [...inContainer, "paseo", "agent", "run"]);
assert.equal(run!.argv[run!.argv.indexOf("--cwd") + 1], deployLayout.work_dir);
assert.deepEqual(fetchKey!.argv, [...inContainer, "cat", "--", deployLayout.public_key_path]);
// The private key path appears only inside the provisioning script that
// generates it; no command names it as an argument to read.
assert.equal(
  deployCommands.some((command) => command.argv.includes(deployLayout.private_key_path)),
  false,
);

// A bundle that could not be copied stops the deployment before an agent exists.
await expectCodeAsync("TESTER_DEPLOY_FAILED", () =>
  deployTesterAgent({
    request: deployRequest,
    transport: async (command) =>
      command.argv[1] === "cp" ? { code: 1, stdout: "" } : { code: 0, stdout: "" },
  }),
);

// --- 10. a deployment record cannot smuggle in a foreign layout ------------

const record = {
  schema_version: 1,
  kind: "tester_deployment",
  endpoint: { ...endpoint, remote_receipt_dir: layout.receipt_dir },
  layout,
};
assert.deepEqual(validateTesterDeploymentRecord(record).layout, layout);
expectCode("TESTER_DEPLOYMENT_INVALID", () =>
  validateTesterDeploymentRecord({
    ...record,
    layout: { ...layout, staging_dir: "/etc" },
  }),
);

// The config freezes the contract by digest, so the contract is passed whole
// and checked here: a contract declared for another project would pin a shape
// this endpoint never agreed to, and every submission after it would be
// refused on the far side instead of at setup time.
assert.equal(
  testerAgentConfigFromDeployment({ record, contract }).submission_contract_sha256,
  contractSha256,
);
for (const foreign of [
  { ...contract, project_id: "project:other" },
  { ...contract, tester_id: "tester:other" },
])
  expectCode("TESTER_CONTRACT_MISMATCH", () =>
    testerAgentConfigFromDeployment({ record, contract: foreign }),
  );

// --- 11. the exclusion list is adversarial in both directions ---------------

// The tester declares what it built on so the research side cannot look it up.
// But an exclusion list is also a weapon pointed the other way: a tester that
// listed "benchmark" or "reasoning" would shut down the research side's
// ordinary literature work, which is not the tester's call. Both failures are
// refused at the contract boundary, before anything is enforced.
const withExclusions = (exclusions: unknown): unknown => ({
  ...contract,
  search_exclusions: exclusions,
});
assert.deepEqual(
  validateTesterSubmissionContract(
    withExclusions({ terms: ["HumanEval"], urls: [], domains: [] }),
  ).search_exclusions,
  // Stored lowercased once, because matching is case-insensitive.
  { terms: ["humaneval"], urls: [], domains: [] },
);
for (const overbroad of [
  { terms: ["benchmark"], urls: [], domains: [] },
  { terms: ["reasoning"], urls: [], domains: [] },
  { terms: ["ab"], urls: [], domains: [] },
  // A whole general-purpose host blocks every unrelated source on it; the same
  // host with a path prefix names the tester's own source and is accepted.
  { terms: [], urls: [], domains: ["github.com"] },
])
  expectCode("TESTER_EXCLUSIONS_OVERBROAD", () =>
    validateTesterSubmissionContract(withExclusions(overbroad)),
  );
assert.deepEqual(
  validateTesterSubmissionContract(
    withExclusions({ terms: [], urls: [], domains: ["github.com/openai/human-eval"] }),
  ).search_exclusions.domains,
  ["github.com/openai/human-eval"],
);
for (const invalid of [
  { terms: ["humaneval", "humaneval"], urls: [], domains: [] },
  { terms: [], urls: ["ftp://example.invalid/set.zip"], domains: [] },
  { terms: [], urls: ["not a url"], domains: [] },
  { terms: [], urls: [], domains: ["not a domain"] },
  { terms: [], urls: [], domains: [] },
  { terms: Array.from({ length: 65 }, (_, index) => `case-family-${index}`), urls: [], domains: [] },
])
  expectCode("TESTER_EXCLUSIONS_INVALID", () =>
    validateTesterSubmissionContract(withExclusions(invalid)),
  );

// --- 12. the contract has to say the test ran in a container ---------------

// The tester runs code the research side wrote, on the machine holding its
// private key and its cases. A contract that does not name a container runtime
// is refused before a single artifact is sent, and "docker" is the only value
// there is, so there is nothing for a tester to negotiate.
const withRuntime = (runtime: unknown): unknown => {
  const { runtime: _declared, ...rest } = contract as unknown as Record<string, unknown>;
  return runtime === undefined ? rest : { ...rest, runtime };
};
assert.deepEqual(
  validateTesterSubmissionContract(withRuntime({ kind: "docker", image_digest: "d".repeat(64) }))
    .runtime,
  { kind: "docker", image_digest: "d".repeat(64) },
);
for (const refused of [
  undefined,
  { kind: "host", image_digest: "d".repeat(64) },
  { kind: "podman", image_digest: "d".repeat(64) },
  { image_digest: "d".repeat(64) },
])
  expectCode("TESTER_RUNTIME_REQUIRED", () =>
    validateTesterSubmissionContract(withRuntime(refused)),
  );
// The digest is the whole public fact about the environment, so a malformed one
// is as useless as a missing runtime.
expectCode("INVALID_HASH", () =>
  validateTesterSubmissionContract(withRuntime({ kind: "docker", image_digest: "sha256:abc" })),
);
// The image name would name the benchmark the exclusion list exists to hide, so
// there is no field to put it in.
expectCode("UNKNOWN_FIELD", () =>
  validateTesterSubmissionContract(
    withRuntime({ kind: "docker", image_digest: "d".repeat(64), image: "humaneval-eval:1" }),
  ),
);

// --- 13. only the outermost run may spend an exposure -----------------------

// Exposures are counted against one task-wide limit, so a run dispatched
// underneath another one that could submit would spend the whole task's budget
// answering a local question.
const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-tester-runs-"));
createRootRun({
  project_root: runsRoot,
  run_id: "outer-1",
  input_snapshot_sha256: H,
  code_baseline_sha256: "b".repeat(64),
  policy_revision: "policy:tester-agent",
});
assertOutermostSubmissionRun(runsRoot, submission);

createRun({
  project_root: runsRoot,
  run_id: "inner-1",
  parent_run_id: "outer-1",
  input_snapshot_sha256: H,
  code_baseline_sha256: "b".repeat(64),
  policy_revision: "policy:tester-agent",
});
expectCode("TESTER_OUTER_RUN_REQUIRED", () =>
  assertOutermostSubmissionRun(runsRoot, { ...submission, outer_run_id: "inner-1" }),
);
// A submission naming a run this project never opened is refused too: the layer
// is read from the run contract on disk, never from the submission.
expectCode("RUN_CONTRACT_NOT_FOUND", () =>
  assertOutermostSubmissionRun(runsRoot, { ...submission, outer_run_id: "outer-2" }),
);
fs.rmSync(runsRoot, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });
console.log("tester agent: contract declaration, submission binding, receipt verification and deployment guards passed");
