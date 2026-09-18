import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalJsonBytes, canonicalJsonSha256, canonicalJsonString } from "./canonical-json.js";
import {
  validateTesterPublicConclusion,
  validateTesterPublicFeedback,
  verifyTesterConclusion,
  verifyTesterFeedback,
  type SignedTesterConclusion,
  type SignedTesterFeedback,
} from "./tester-public-receipt.js";
import { readStateFile, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireBoolean,
  requireInteger,
  requireString,
} from "./workflow-spec.js";

/**
 * The tester is a Claude agent on another machine, managed by that machine's
 * Paseo daemon. The research process reaches it through `paseo --host
 * ssh://...`, which tunnels the daemon port back to this machine.
 *
 * Nothing here protects the tester by file ownership. Two physical facts do
 * that instead: the signing key is generated on the remote machine during
 * deployment and only its public half is fetched back, and the cases the
 * tester writes never leave that machine. The research process may read the
 * public key freely -- it is public -- but it cannot sign a receipt with it.
 */
export interface TesterAgentConfig {
  schema_version: 1;
  mode: "tester_agent";
  tester_id: string;
  /** The handle the research process must name to reach its own test. */
  project_id: string;
  /** `user@host` or `host`; also the ssh argument used to fetch receipts. */
  ssh_target: string;
  ssh_port?: number;
  daemon_port: number;
  /** The tester-role agent on the remote daemon. */
  agent_id: string;
  remote_receipt_dir: string;
  public_key_path: string;
  /** Pinned at deployment so a later swap of the key file is refused. */
  public_key_sha256: string;
  submission_contract_sha256: string;
  request_timeout_ms: number;
}

/**
 * A slot is one artifact the tester asked for. The role is explicit because a
 * directional verdict needs a referent: a tester that does not know which
 * artifact it is being asked to beat cannot say "improved" and mean anything.
 * What the tester never learns is which model produced either artifact -- it
 * sees content digests, and the local `tester-arm-map.json` keeps the rest.
 */
export type TesterSlotRole = "reference" | "candidate";

export interface TesterSubmissionSlot {
  slot_id: string;
  role: TesterSlotRole;
  required: boolean;
}

export type TesterSubmissionFieldType = "string" | "sha256" | "integer";

export interface TesterSubmissionField {
  name: string;
  type: TesterSubmissionFieldType;
  required: boolean;
}

/**
 * What the tester found while researching this domain and then actually used to
 * build its cases. The research side never reads this as prose: it is compiled
 * into the guard that refuses those searches, so a benchmark the tester built
 * on cannot be looked up and copied from its public repository or paper.
 *
 * The leak this closes is not the tester machine -- it is the open web. Keeping
 * the private key and the cases on the tester machine does nothing about a
 * research process that simply searches for the same benchmark.
 */
export interface TesterSearchExclusions {
  /** Benchmark, dataset and protocol names, lowercased. */
  terms: string[];
  /** Exact http(s) URLs the tester drew from. */
  urls: string[];
  /** Hostnames, optionally with a path prefix, that host those sources. */
  domains: string[];
}

/**
 * What the tester declares back when asked to set up a test. The research
 * process supplies a domain need; the tester answers with the shape of the
 * artifacts it wants and how to run them. It does not disclose the cases.
 */
export interface TesterSubmissionContract {
  schema_version: 1;
  contract_id: string;
  project_id: string;
  tester_id: string;
  tester_version: string;
  case_manifest_sha256: string;
  slots: TesterSubmissionSlot[];
  submission_fields: TesterSubmissionField[];
  /** Free text, capped. It reaches the setup record and never the wiki. */
  usage: string;
  /** Signed with the contract, so the research side cannot shorten it. */
  search_exclusions: TesterSearchExclusions;
}

export interface SignedTesterSubmissionContract {
  contract: TesterSubmissionContract;
  signature: string;
}

export interface TesterSubmissionArtifact {
  artifact_id: string;
  artifact_sha256: string;
}

export interface TesterAgentSubmission {
  schema_version: 1;
  mode: "tester_agent";
  submission_id: string;
  project_id: string;
  contract_id: string;
  contract_sha256: string;
  tester_run_id: string;
  outer_run_id: string;
  task_id: string;
  task_setup_revision: string;
  promotion_trial_id: string;
  tester_id: string;
  tester_version: string;
  tester_definition_sha256: string;
  harness_sha256: string;
  input_snapshot_sha256: string;
  input_distribution_sha256: string;
  model_assignment_sha256: string;
  judge_binding_id: string | null;
  /** Keyed by the slot ids the contract declared. */
  slots: Record<string, TesterSubmissionArtifact>;
  /** Keyed by the field names the contract declared. */
  fields: Record<string, string | number>;
}

export type TesterAgentErrorCode =
  | "model_service_unavailable"
  | "harness_execution_failed"
  | "constraint_violation"
  | "insufficient_confidence"
  | "candidate_not_improved"
  | "tester_agent_rejected";

export interface TesterAgentResponse {
  schema_version: 1;
  mode: "tester_agent";
  project_id: string;
  submission_id: string;
  submission_sha256: string;
  tester_run_id: string;
  promotion_trial_id: string;
  status: "passed" | "rejected" | "failed";
  /** Fixed coarse categories only; no case, score, prompt, answer, or URI. */
  error_analysis: TesterAgentErrorCode[];
  response_signature?: string;
  signed_conclusion?: SignedTesterConclusion;
  signed_feedback?: SignedTesterFeedback;
}

const TESTER_AGENT_ERRORS = new Set<TesterAgentErrorCode>([
  "model_service_unavailable",
  "harness_execution_failed",
  "constraint_violation",
  "insufficient_confidence",
  "candidate_not_improved",
  "tester_agent_rejected",
]);

const MAX_USAGE_LENGTH = 2000;
const MAX_SLOTS = 8;
const MAX_FIELDS = 16;
const MAX_RECEIPT_BYTES = 128 * 1024;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

function normalizedAbsolutePath(value: unknown, location: string): string {
  const result = requireString(value, location);
  if (!path.isAbsolute(result) || path.normalize(result) !== result || result === "/")
    failA1("INVALID_PATH", "tester agent paths must be normalized absolute paths", location);
  return result;
}

/**
 * An ssh target reaches the command line, so it is validated rather than
 * escaped: one optional `user@`, one host, and nothing that could be read as
 * an ssh option. `assertIdentifier` already refuses a leading hyphen and
 * whitespace; the only extra rule is that `@` appears at most once.
 */
function sshTarget(value: unknown, location: string): string {
  const target = assertIdentifier(value, location);
  const parts = target.split("@");
  if (parts.length > 2 || parts.some((part) => part === "" || part.includes(":")))
    failA1("TESTER_AGENT_CONFIG_INVALID", "ssh target must be host or user@host", location);
  return target;
}

function port(value: unknown, location: string): number {
  const result = requireInteger(value, location, 1);
  if (result > 65535) failA1("TESTER_AGENT_CONFIG_INVALID", "port is out of range", location);
  return result;
}

/** Everything needed to reach the tester machine, config or not. */
export interface TesterAgentTarget {
  ssh_target: string;
  ssh_port?: number;
  daemon_port: number;
}

/**
 * The `--host` target for the Paseo CLI. It is derived rather than stored so
 * the ssh target and the daemon port have exactly one place to be wrong.
 */
export function testerAgentDaemonHost(target: TesterAgentTarget): string {
  const authority =
    target.ssh_port === undefined ? target.ssh_target : `${target.ssh_target}:${target.ssh_port}`;
  return `ssh://${authority}?daemonPort=${target.daemon_port}`;
}

/**
 * Everything needed to talk to a deployed tester, minus the frozen contract
 * hash. Declaring a contract has to work before that hash exists, so the
 * reachability fields are a type of their own.
 */
export type TesterAgentEndpoint = Omit<
  TesterAgentConfig,
  "schema_version" | "mode" | "submission_contract_sha256"
>;

function validateTesterAgentEndpoint(value: Record<string, unknown>): TesterAgentEndpoint {
  const timeout = requireInteger(
    value.request_timeout_ms,
    "tester_agent_config.request_timeout_ms",
    1000,
  );
  if (timeout > 3_600_000)
    failA1("TESTER_AGENT_CONFIG_INVALID", "tester agent timeout is too large");
  return {
    tester_id: assertIdentifier(value.tester_id, "tester_agent_config.tester_id"),
    project_id: assertIdentifier(value.project_id, "tester_agent_config.project_id"),
    ssh_target: sshTarget(value.ssh_target, "tester_agent_config.ssh_target"),
    ...(value.ssh_port === undefined
      ? {}
      : { ssh_port: port(value.ssh_port, "tester_agent_config.ssh_port") }),
    daemon_port: port(value.daemon_port, "tester_agent_config.daemon_port"),
    agent_id: assertIdentifier(value.agent_id, "tester_agent_config.agent_id"),
    remote_receipt_dir: normalizedAbsolutePath(
      value.remote_receipt_dir,
      "tester_agent_config.remote_receipt_dir",
    ),
    public_key_path: normalizedAbsolutePath(
      value.public_key_path,
      "tester_agent_config.public_key_path",
    ),
    public_key_sha256: assertSha256(
      value.public_key_sha256,
      "tester_agent_config.public_key_sha256",
    ),
    request_timeout_ms: timeout,
  };
}

export function validateTesterAgentConfig(value: unknown): TesterAgentConfig {
  if (!isRecord(value))
    failA1("TESTER_AGENT_CONFIG_REQUIRED", "tester agent config must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "mode",
      "tester_id",
      "project_id",
      "ssh_target",
      "ssh_port",
      "daemon_port",
      "agent_id",
      "remote_receipt_dir",
      "public_key_path",
      "public_key_sha256",
      "submission_contract_sha256",
      "request_timeout_ms",
    ],
    "tester_agent_config",
  );
  if (value.schema_version !== 1 || value.mode !== "tester_agent")
    failA1("TESTER_AGENT_CONFIG_REQUIRED", "only tester_agent configs are supported");
  return {
    schema_version: 1,
    mode: "tester_agent",
    ...validateTesterAgentEndpoint(value),
    submission_contract_sha256: assertSha256(
      value.submission_contract_sha256,
      "tester_agent_config.submission_contract_sha256",
    ),
  };
}

export function testerAgentConfigSha256(config: TesterAgentConfig): string {
  return canonicalJsonSha256(validateTesterAgentConfig(config), undefined, {
    schemaVersion: "tester-agent-config-v1",
  });
}

/**
 * Load the public key the deployment pinned. Ownership is not checked: a
 * public key is not a secret, so the thing worth refusing is a *different*
 * key, which the digest catches and a uid check would not.
 */
export function readTesterAgentPublicKey(endpoint: TesterAgentEndpoint): crypto.KeyObject {
  const normalized = validateTesterAgentEndpoint({ ...endpoint });
  let contents: Buffer;
  try {
    contents = fs.readFileSync(normalized.public_key_path);
  } catch {
    failA1("TESTER_AGENT_KEY_MISSING", "tester agent public key is not readable");
  }
  if (crypto.createHash("sha256").update(contents).digest("hex") !== normalized.public_key_sha256)
    failA1("TESTER_AGENT_KEY_MISMATCH", "tester agent public key differs from the pinned digest");
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(contents);
  } catch {
    failA1("TESTER_AGENT_KEY_MISSING", "tester agent public key is not a public key");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
    failA1("TESTER_AGENT_KEY_MISMATCH", "tester agent public key must be ed25519");
  return key;
}

export function readTesterAgentConfig(configPath: string): TesterAgentConfig {
  const config = validateTesterAgentConfig(readStateFile(configPath));
  readTesterAgentPublicKey(config);
  return config;
}

function submissionSlot(value: unknown, location: string): TesterSubmissionSlot {
  if (!isRecord(value))
    failA1("TESTER_CONTRACT_INVALID", "submission slot must be an object", location);
  assertNoUnknownFields(value, ["slot_id", "role", "required"], location);
  if (value.role !== "reference" && value.role !== "candidate")
    failA1("TESTER_CONTRACT_INVALID", "slot role is invalid", `${location}.role`);
  return {
    slot_id: assertIdentifier(value.slot_id, `${location}.slot_id`),
    role: value.role,
    required: requireBoolean(value.required, `${location}.required`),
  };
}

function submissionField(value: unknown, location: string): TesterSubmissionField {
  if (!isRecord(value))
    failA1("TESTER_CONTRACT_INVALID", "submission field must be an object", location);
  assertNoUnknownFields(value, ["name", "type", "required"], location);
  if (value.type !== "string" && value.type !== "sha256" && value.type !== "integer")
    failA1("TESTER_CONTRACT_INVALID", "submission field type is invalid", `${location}.type`);
  return {
    name: assertIdentifier(value.name, `${location}.name`),
    type: value.type,
    required: requireBoolean(value.required, `${location}.required`),
  };
}

/**
 * Terms so general that excluding them would not protect a case set -- it would
 * shut down the research side's ordinary literature work. The tester declares
 * what it used; it does not get to decide that the research side may no longer
 * read about its own field, so these are refused at the contract boundary.
 */
const GENERIC_EXCLUSION_TERMS = new Set([
  "accuracy",
  "agent",
  "agents",
  "ai",
  "arxiv",
  "baseline",
  "benchmark",
  "benchmarks",
  "code",
  "data",
  "dataset",
  "datasets",
  "eval",
  "evaluation",
  "github",
  "huggingface",
  "inference",
  "llm",
  "llms",
  "metric",
  "metrics",
  "ml",
  "model",
  "models",
  "nlp",
  "paper",
  "papers",
  "performance",
  "prompt",
  "prompts",
  "research",
  "reasoning",
  "score",
  "scores",
  "task",
  "tasks",
  "test",
  "testing",
  "tests",
  "training",
]);

/**
 * Hosts that carry far more than one benchmark. Excluding one of them whole
 * blocks every unrelated source on it, so an entry naming one of these is only
 * accepted with a path prefix that narrows it to the tester's own source.
 */
const GENERAL_PURPOSE_HOSTS = new Set([
  "arxiv.org",
  "github.com",
  "gitlab.com",
  "google.com",
  "huggingface.co",
  "kaggle.com",
  "medium.com",
  "openreview.net",
  "paperswithcode.com",
  "reddit.com",
  "scholar.google.com",
  "stackoverflow.com",
  "wikipedia.org",
  "x.com",
]);

const MAX_EXCLUSION_TERMS = 64;
const MAX_EXCLUSION_URLS = 64;
const MAX_EXCLUSION_DOMAINS = 32;
const MIN_EXCLUSION_TERM_LENGTH = 3;
const MAX_EXCLUSION_ENTRY_LENGTH = 200;
const DOMAIN_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?:\/[\w.~%!$&'()*+,;=:@/-]*)?$/;

function exclusionList(
  value: unknown,
  location: string,
  max: number,
  normalize: (entry: string, entryLocation: string) => string,
): string[] {
  if (!Array.isArray(value) || value.length > max)
    failA1(
      "TESTER_EXCLUSIONS_INVALID",
      `${location} must be a list of at most ${max} entries`,
      location,
    );
  const entries = (value as unknown[]).map((entry, index) => {
    const raw = requireString(entry, `${location}[${index}]`);
    if (raw.length > MAX_EXCLUSION_ENTRY_LENGTH)
      failA1("TESTER_EXCLUSIONS_INVALID", "exclusion entry is too long", `${location}[${index}]`);
    return normalize(raw.trim(), `${location}[${index}]`);
  });
  if (new Set(entries).size !== entries.length)
    failA1("TESTER_EXCLUSIONS_INVALID", `${location} contains a duplicate entry`, location);
  return entries;
}

/**
 * The exclusions are matched case-insensitively against query text, so they are
 * stored lowercased once here rather than lowercased at every comparison.
 */
function searchExclusions(value: unknown): TesterSearchExclusions {
  if (!isRecord(value))
    failA1("TESTER_EXCLUSIONS_INVALID", "search exclusions must be an object", "search_exclusions");
  assertNoUnknownFields(value, ["terms", "urls", "domains"], "search_exclusions");
  const terms = exclusionList(
    value.terms,
    "search_exclusions.terms",
    MAX_EXCLUSION_TERMS,
    (entry, location) => {
      const term = entry.toLowerCase();
      if (term.length < MIN_EXCLUSION_TERM_LENGTH)
        failA1(
          "TESTER_EXCLUSIONS_OVERBROAD",
          "exclusion term is too short to be specific",
          location,
        );
      if (GENERIC_EXCLUSION_TERMS.has(term))
        failA1(
          "TESTER_EXCLUSIONS_OVERBROAD",
          "exclusion term is a general research word",
          location,
        );
      return term;
    },
  );
  const urls = exclusionList(
    value.urls,
    "search_exclusions.urls",
    MAX_EXCLUSION_URLS,
    (entry, location) => {
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        return failA1("TESTER_EXCLUSIONS_INVALID", "exclusion url does not parse", location);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        failA1("TESTER_EXCLUSIONS_INVALID", "exclusion url must be http or https", location);
      return parsed.toString().toLowerCase();
    },
  );
  const domains = exclusionList(
    value.domains,
    "search_exclusions.domains",
    MAX_EXCLUSION_DOMAINS,
    (entry, location) => {
      const domain = entry.toLowerCase().replace(/\/+$/, "");
      if (!DOMAIN_PATTERN.test(domain))
        failA1(
          "TESTER_EXCLUSIONS_INVALID",
          "exclusion domain is not a host or host/path",
          location,
        );
      if (!domain.includes("/") && GENERAL_PURPOSE_HOSTS.has(domain))
        failA1(
          "TESTER_EXCLUSIONS_OVERBROAD",
          "a general-purpose host may only be excluded with a path prefix",
          location,
        );
      return domain;
    },
  );
  if (terms.length + urls.length + domains.length === 0)
    failA1("TESTER_EXCLUSIONS_INVALID", "search exclusions must name at least one source");
  return { terms, urls, domains };
}

export function validateTesterSubmissionContract(value: unknown): TesterSubmissionContract {
  if (!isRecord(value)) failA1("TESTER_CONTRACT_INVALID", "submission contract must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "contract_id",
      "project_id",
      "tester_id",
      "tester_version",
      "case_manifest_sha256",
      "slots",
      "submission_fields",
      "usage",
      "search_exclusions",
    ],
    "tester_submission_contract",
  );
  if (value.schema_version !== 1)
    failA1("TESTER_CONTRACT_INVALID", "only version 1 submission contracts are supported");
  if (!Array.isArray(value.slots) || value.slots.length === 0 || value.slots.length > MAX_SLOTS)
    failA1("TESTER_CONTRACT_INVALID", "submission contract must declare 1..8 slots");
  if (!Array.isArray(value.submission_fields) || value.submission_fields.length > MAX_FIELDS)
    failA1("TESTER_CONTRACT_INVALID", "submission contract declares too many fields");
  const slots = value.slots.map((slot, index) =>
    submissionSlot(slot, `tester_submission_contract.slots[${index}]`),
  );
  const fields = value.submission_fields.map((field, index) =>
    submissionField(field, `tester_submission_contract.submission_fields[${index}]`),
  );
  if (new Set(slots.map((slot) => slot.slot_id)).size !== slots.length)
    failA1("TESTER_CONTRACT_INVALID", "slot ids must be unique");
  if (new Set(fields.map((field) => field.name)).size !== fields.length)
    failA1("TESTER_CONTRACT_INVALID", "submission field names must be unique");
  // The promotion decision is a paired comparison, so the contract has to name
  // exactly one thing to beat and exactly one candidate that must beat it.
  if (
    slots.filter((slot) => slot.role === "reference").length !== 1 ||
    slots.filter((slot) => slot.role === "candidate").length !== 1
  )
    failA1(
      "TESTER_CONTRACT_INVALID",
      "submission contract needs exactly one reference slot and one candidate slot",
    );
  const usage = requireString(value.usage, "tester_submission_contract.usage");
  if (usage.length > MAX_USAGE_LENGTH)
    failA1("TESTER_CONTRACT_INVALID", "submission contract usage text is too long");
  return {
    schema_version: 1,
    contract_id: assertIdentifier(value.contract_id, "tester_submission_contract.contract_id"),
    project_id: assertIdentifier(value.project_id, "tester_submission_contract.project_id"),
    tester_id: assertIdentifier(value.tester_id, "tester_submission_contract.tester_id"),
    tester_version: assertIdentifier(
      value.tester_version,
      "tester_submission_contract.tester_version",
    ),
    case_manifest_sha256: assertSha256(
      value.case_manifest_sha256,
      "tester_submission_contract.case_manifest_sha256",
    ),
    slots,
    submission_fields: fields,
    usage,
    search_exclusions: searchExclusions(value.search_exclusions),
  };
}

export function testerSubmissionContractSha256(contract: TesterSubmissionContract): string {
  return canonicalJsonSha256(validateTesterSubmissionContract(contract), undefined, {
    schemaVersion: "tester-submission-contract-v1",
  });
}

function contractSignedBytes(contract: TesterSubmissionContract): Buffer {
  return Buffer.concat([
    Buffer.from("aris-tester-submission-contract-v1\n"),
    canonicalJsonBytes(contract),
  ]);
}

export function verifyTesterSubmissionContract(
  value: unknown,
  publicKey: crypto.KeyObject,
): TesterSubmissionContract {
  if (!isRecord(value))
    failA1("TESTER_CONTRACT_INVALID", "signed submission contract must be an object");
  assertNoUnknownFields(value, ["contract", "signature"], "signed_submission_contract");
  const contract = validateTesterSubmissionContract(value.contract);
  const signature = value.signature;
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature))
    failA1("TESTER_SIGNATURE_INVALID", "submission contract signature is invalid");
  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !crypto.verify(null, contractSignedBytes(contract), publicKey, Buffer.from(signature, "base64"))
  )
    failA1("TESTER_SIGNATURE_INVALID", "submission contract signature does not verify");
  return contract;
}

function submissionArtifact(value: unknown, location: string): TesterSubmissionArtifact {
  if (!isRecord(value))
    failA1("TESTER_SUBMISSION_INVALID", "submission slot value must be an object", location);
  assertNoUnknownFields(value, ["artifact_id", "artifact_sha256"], location);
  return {
    artifact_id: assertIdentifier(value.artifact_id, `${location}.artifact_id`),
    artifact_sha256: assertSha256(value.artifact_sha256, `${location}.artifact_sha256`),
  };
}

const SUBMISSION_FIELDS = [
  "schema_version",
  "mode",
  "submission_id",
  "project_id",
  "contract_id",
  "contract_sha256",
  "tester_run_id",
  "outer_run_id",
  "task_id",
  "task_setup_revision",
  "promotion_trial_id",
  "tester_id",
  "tester_version",
  "tester_definition_sha256",
  "harness_sha256",
  "input_snapshot_sha256",
  "input_distribution_sha256",
  "model_assignment_sha256",
  "judge_binding_id",
  "slots",
  "fields",
] as const;

export function validateTesterAgentSubmission(value: unknown): TesterAgentSubmission {
  if (!isRecord(value))
    failA1("TESTER_SUBMISSION_INVALID", "tester agent submission must be an object");
  assertNoUnknownFields(value, SUBMISSION_FIELDS, "tester_agent_submission");
  if (value.schema_version !== 1 || value.mode !== "tester_agent")
    failA1("TESTER_SUBMISSION_INVALID", "only tester_agent submissions are supported");
  if (!isRecord(value.slots) || !isRecord(value.fields))
    failA1("TESTER_SUBMISSION_INVALID", "submission slots and fields must be objects");
  const slotEntries = Object.entries(value.slots);
  const fieldEntries = Object.entries(value.fields);
  if (slotEntries.length === 0 || slotEntries.length > MAX_SLOTS)
    failA1("TESTER_SUBMISSION_INVALID", "submission declares an unusable number of slots");
  if (fieldEntries.length > MAX_FIELDS)
    failA1("TESTER_SUBMISSION_INVALID", "submission declares too many fields");
  const slots: Record<string, TesterSubmissionArtifact> = {};
  for (const [slotId, artifact] of slotEntries)
    slots[assertIdentifier(slotId, "tester_agent_submission.slots")] = submissionArtifact(
      artifact,
      `tester_agent_submission.slots.${slotId}`,
    );
  const fields: Record<string, string | number> = {};
  for (const [name, fieldValue] of fieldEntries) {
    const location = `tester_agent_submission.fields.${name}`;
    assertIdentifier(name, "tester_agent_submission.fields");
    if (typeof fieldValue === "number") fields[name] = requireInteger(fieldValue, location);
    else fields[name] = requireString(fieldValue, location);
  }
  return {
    schema_version: 1,
    mode: "tester_agent",
    submission_id: assertIdentifier(value.submission_id, "tester_agent_submission.submission_id"),
    project_id: assertIdentifier(value.project_id, "tester_agent_submission.project_id"),
    contract_id: assertIdentifier(value.contract_id, "tester_agent_submission.contract_id"),
    contract_sha256: assertSha256(value.contract_sha256, "tester_agent_submission.contract_sha256"),
    tester_run_id: assertIdentifier(value.tester_run_id, "tester_agent_submission.tester_run_id"),
    outer_run_id: assertIdentifier(value.outer_run_id, "tester_agent_submission.outer_run_id"),
    task_id: assertIdentifier(value.task_id, "tester_agent_submission.task_id"),
    task_setup_revision: assertIdentifier(
      value.task_setup_revision,
      "tester_agent_submission.task_setup_revision",
    ),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      "tester_agent_submission.promotion_trial_id",
    ),
    tester_id: assertIdentifier(value.tester_id, "tester_agent_submission.tester_id"),
    tester_version: assertIdentifier(
      value.tester_version,
      "tester_agent_submission.tester_version",
    ),
    tester_definition_sha256: assertSha256(
      value.tester_definition_sha256,
      "tester_agent_submission.tester_definition_sha256",
    ),
    harness_sha256: assertSha256(value.harness_sha256, "tester_agent_submission.harness_sha256"),
    input_snapshot_sha256: assertSha256(
      value.input_snapshot_sha256,
      "tester_agent_submission.input_snapshot_sha256",
    ),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      "tester_agent_submission.input_distribution_sha256",
    ),
    model_assignment_sha256: assertSha256(
      value.model_assignment_sha256,
      "tester_agent_submission.model_assignment_sha256",
    ),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, "tester_agent_submission.judge_binding_id"),
    slots,
    fields,
  };
}

/**
 * Check a submission against the shape the tester declared. This is the whole
 * of the format contract: the tester said what it wants, and a submission that
 * does not match is refused here instead of on the far side of an ssh hop.
 */
export function bindSubmissionToContract(
  contract: TesterSubmissionContract,
  config: TesterAgentConfig,
  value: unknown,
): TesterAgentSubmission {
  const normalizedContract = validateTesterSubmissionContract(contract);
  const normalizedConfig = validateTesterAgentConfig(config);
  if (
    testerSubmissionContractSha256(normalizedContract) !==
    normalizedConfig.submission_contract_sha256
  )
    failA1("TESTER_CONTRACT_MISMATCH", "contract differs from the one frozen in the config");
  if (normalizedContract.project_id !== normalizedConfig.project_id)
    failA1("TESTER_CONTRACT_MISMATCH", "contract names another project");
  if (!isRecord(value)) failA1("TESTER_SUBMISSION_INVALID", "submission input must be an object");
  const submission = validateTesterAgentSubmission({
    ...value,
    schema_version: 1,
    mode: "tester_agent",
    project_id: normalizedConfig.project_id,
    contract_id: normalizedContract.contract_id,
    contract_sha256: testerSubmissionContractSha256(normalizedContract),
    tester_id: normalizedContract.tester_id,
    tester_version: normalizedContract.tester_version,
  });
  const declaredSlots = new Map(normalizedContract.slots.map((slot) => [slot.slot_id, slot]));
  for (const slotId of Object.keys(submission.slots))
    if (!declaredSlots.has(slotId))
      failA1("TESTER_SUBMISSION_INVALID", `submission carries an undeclared slot '${slotId}'`);
  for (const slot of normalizedContract.slots)
    if (slot.required && submission.slots[slot.slot_id] === undefined)
      failA1("TESTER_SUBMISSION_INVALID", `submission is missing required slot '${slot.slot_id}'`);
  const declaredFields = new Map(
    normalizedContract.submission_fields.map((field) => [field.name, field]),
  );
  for (const [name, fieldValue] of Object.entries(submission.fields)) {
    const declared = declaredFields.get(name);
    if (declared === undefined)
      failA1("TESTER_SUBMISSION_INVALID", `submission carries an undeclared field '${name}'`);
    const location = `tester_agent_submission.fields.${name}`;
    if (declared.type === "integer") requireInteger(fieldValue, location);
    else if (declared.type === "sha256") assertSha256(fieldValue, location);
    else requireString(fieldValue, location);
  }
  for (const field of normalizedContract.submission_fields)
    if (field.required && submission.fields[field.name] === undefined)
      failA1("TESTER_SUBMISSION_INVALID", `submission is missing required field '${field.name}'`);
  return submission;
}

export function testerAgentSubmissionSha256(submission: TesterAgentSubmission): string {
  return canonicalJsonSha256(validateTesterAgentSubmission(submission), undefined, {
    schemaVersion: "tester-agent-submission-v1",
  });
}

/** The artifact digest sitting in the slot the contract gave this role. */
export function submissionArtifactForRole(
  contract: TesterSubmissionContract,
  submission: TesterAgentSubmission,
  role: TesterSlotRole,
): TesterSubmissionArtifact {
  const slot = validateTesterSubmissionContract(contract).slots.find((item) => item.role === role);
  if (slot === undefined)
    failA1("TESTER_CONTRACT_INVALID", `submission contract has no ${role} slot`);
  const artifact = submission.slots[slot.slot_id];
  if (artifact === undefined)
    failA1("TESTER_SUBMISSION_INVALID", `submission has no artifact for the ${role} slot`);
  return artifact;
}

function errorAnalysis(value: unknown): TesterAgentErrorCode[] {
  if (!Array.isArray(value) || value.length > 6)
    failA1("TESTER_AGENT_RESPONSE_INVALID", "error_analysis must be a short array");
  const result = value.map((item, index) => {
    const code = requireString(
      item,
      `tester_agent_response.error_analysis[${index}]`,
    ) as TesterAgentErrorCode;
    if (!TESTER_AGENT_ERRORS.has(code))
      failA1("TESTER_AGENT_RESPONSE_INVALID", "error_analysis contains an unknown category");
    return code;
  });
  if (new Set(result).size !== result.length)
    failA1("TESTER_AGENT_RESPONSE_INVALID", "error_analysis categories must be unique");
  return result;
}

export function validateTesterAgentResponse(value: unknown): TesterAgentResponse {
  if (!isRecord(value))
    failA1("TESTER_AGENT_RESPONSE_INVALID", "tester agent response must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "mode",
      "project_id",
      "submission_id",
      "submission_sha256",
      "tester_run_id",
      "promotion_trial_id",
      "status",
      "error_analysis",
      "response_signature",
      "signed_conclusion",
      "signed_feedback",
    ],
    "tester_agent_response",
  );
  if (value.schema_version !== 1 || value.mode !== "tester_agent")
    failA1("TESTER_AGENT_RESPONSE_INVALID", "only tester_agent responses are supported");
  const status = value.status;
  if (status !== "passed" && status !== "rejected" && status !== "failed")
    failA1("TESTER_AGENT_RESPONSE_INVALID", "tester agent status is invalid");
  const errors = errorAnalysis(value.error_analysis);
  const conclusion = value.signed_conclusion;
  const feedback = value.signed_feedback;
  if (status === "failed") {
    if (
      errors.length === 0 ||
      conclusion !== undefined ||
      feedback !== undefined ||
      value.response_signature !== undefined
    )
      failA1("TESTER_AGENT_RESPONSE_INVALID", "failed tester runs expose only error categories");
  } else if (!isRecord(conclusion) || !isRecord(feedback)) {
    failA1("TESTER_AGENT_RESPONSE_INVALID", "terminal tester results require signed receipts");
  } else if (status === "passed" && errors.length > 0) {
    failA1("TESTER_AGENT_RESPONSE_INVALID", "a passed tester run cannot carry an error category");
  } else if (status === "rejected" && errors.length === 0) {
    failA1("TESTER_AGENT_RESPONSE_INVALID", "a rejected tester run must carry coarse analysis");
  }
  if (status !== "failed") {
    if (!isRecord(conclusion) || !isRecord(feedback))
      failA1("TESTER_AGENT_RESPONSE_INVALID", "terminal response needs public receipts");
    assertNoUnknownFields(conclusion, ["conclusion", "signature"], "signed_conclusion");
    assertNoUnknownFields(feedback, ["feedback", "signature"], "signed_feedback");
    validateTesterPublicConclusion(conclusion.conclusion);
    validateTesterPublicFeedback(feedback.feedback);
    for (const signature of [value.response_signature, conclusion.signature, feedback.signature])
      if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature))
        failA1("TESTER_SIGNATURE_INVALID", "tester receipt signature is invalid");
  }
  return {
    schema_version: 1,
    mode: "tester_agent",
    project_id: assertIdentifier(value.project_id, "tester_agent_response.project_id"),
    submission_id: assertIdentifier(value.submission_id, "tester_agent_response.submission_id"),
    submission_sha256: assertSha256(
      value.submission_sha256,
      "tester_agent_response.submission_sha256",
    ),
    tester_run_id: assertIdentifier(value.tester_run_id, "tester_agent_response.tester_run_id"),
    promotion_trial_id: assertIdentifier(
      value.promotion_trial_id,
      "tester_agent_response.promotion_trial_id",
    ),
    status,
    error_analysis: errors,
    ...(status === "failed"
      ? {}
      : { response_signature: requireString(value.response_signature, "response_signature") }),
    ...(conclusion === undefined
      ? {}
      : { signed_conclusion: conclusion as unknown as SignedTesterConclusion }),
    ...(feedback === undefined
      ? {}
      : { signed_feedback: feedback as unknown as SignedTesterFeedback }),
  };
}

function assertSubmissionBinding(
  response: TesterAgentResponse,
  submission: TesterAgentSubmission,
): void {
  if (
    response.submission_id !== submission.submission_id ||
    response.project_id !== submission.project_id ||
    response.tester_run_id !== submission.tester_run_id ||
    response.promotion_trial_id !== submission.promotion_trial_id
  )
    failA1("TESTER_AGENT_BINDING_MISMATCH", "tester response names another submission");
}

function assertConclusionBinding(
  conclusion: ReturnType<typeof verifyTesterConclusion>,
  submission: TesterAgentSubmission,
  reference: TesterSubmissionArtifact,
  candidate: TesterSubmissionArtifact,
): void {
  if (
    conclusion.tester_run_id !== submission.tester_run_id ||
    conclusion.outer_run_id !== submission.outer_run_id ||
    conclusion.task_id !== submission.task_id ||
    conclusion.promotion_trial_id !== submission.promotion_trial_id ||
    conclusion.tester_definition_sha256 !== submission.tester_definition_sha256 ||
    conclusion.harness_sha256 !== submission.harness_sha256 ||
    conclusion.matching_baseline_artifact_sha256 !== reference.artifact_sha256 ||
    conclusion.finalist_artifact_sha256 !== candidate.artifact_sha256 ||
    conclusion.input_snapshot_sha256 !== submission.input_snapshot_sha256 ||
    conclusion.input_distribution_sha256 !== submission.input_distribution_sha256 ||
    conclusion.model_assignment_sha256 !== submission.model_assignment_sha256
  )
    failA1("TESTER_AGENT_BINDING_MISMATCH", "tester conclusion does not match the submission");
}

function assertFeedbackBinding(
  feedback: ReturnType<typeof verifyTesterFeedback>,
  submission: TesterAgentSubmission,
  reference: TesterSubmissionArtifact,
  candidate: TesterSubmissionArtifact,
): void {
  if (
    feedback.tester_run_id !== submission.tester_run_id ||
    feedback.outer_run_id !== submission.outer_run_id ||
    feedback.task_id !== submission.task_id ||
    feedback.promotion_trial_id !== submission.promotion_trial_id ||
    feedback.tester_definition_sha256 !== submission.tester_definition_sha256 ||
    feedback.harness_sha256 !== submission.harness_sha256 ||
    feedback.matching_baseline_artifact_sha256 !== reference.artifact_sha256 ||
    feedback.finalist_artifact_sha256 !== candidate.artifact_sha256 ||
    feedback.input_snapshot_sha256 !== submission.input_snapshot_sha256 ||
    feedback.input_distribution_sha256 !== submission.input_distribution_sha256 ||
    feedback.feedback.task_setup_revision !== submission.task_setup_revision ||
    feedback.tester_version !== submission.tester_version
  )
    failA1("TESTER_AGENT_BINDING_MISMATCH", "tester feedback does not match the submission");
}

const verifiedResponses = new WeakMap<TesterAgentResponse, string>();

export function verifyTesterAgentResponse(input: {
  value: unknown;
  contract: TesterSubmissionContract;
  submission: TesterAgentSubmission;
  config: TesterAgentConfig;
  public_key: crypto.KeyObject;
}): TesterAgentResponse {
  const contract = validateTesterSubmissionContract(input.contract);
  const submission = validateTesterAgentSubmission(input.submission);
  const config = validateTesterAgentConfig(input.config);
  const response = validateTesterAgentResponse(input.value);
  if (submission.contract_sha256 !== config.submission_contract_sha256)
    failA1("TESTER_CONTRACT_MISMATCH", "submission names a contract the config did not freeze");
  if (response.project_id !== config.project_id || submission.project_id !== config.project_id)
    failA1("TESTER_AGENT_BINDING_MISMATCH", "tester project identity differs from frozen config");
  if (response.submission_sha256 !== testerAgentSubmissionSha256(submission))
    failA1("TESTER_AGENT_BINDING_MISMATCH", "tester response submission hash is incorrect");
  assertSubmissionBinding(response, submission);
  if (response.status === "failed") {
    verifiedResponses.set(response, canonicalJsonString(response));
    return response;
  }
  const { response_signature: responseSignature, ...signedResponse } = response;
  if (
    input.public_key.type !== "public" ||
    input.public_key.asymmetricKeyType !== "ed25519" ||
    !responseSignature ||
    !crypto.verify(
      null,
      Buffer.concat([
        Buffer.from("aris-tester-agent-response-v1\n"),
        canonicalJsonBytes(signedResponse),
      ]),
      input.public_key,
      Buffer.from(responseSignature, "base64"),
    )
  )
    failA1("TESTER_SIGNATURE_INVALID", "tester response submission binding signature is invalid");
  if (response.signed_conclusion === undefined || response.signed_feedback === undefined)
    failA1("TESTER_AGENT_RESPONSE_INVALID", "terminal tester response is missing a signed receipt");
  const reference = submissionArtifactForRole(contract, submission, "reference");
  const candidate = submissionArtifactForRole(contract, submission, "candidate");
  const conclusion = verifyTesterConclusion(response.signed_conclusion, input.public_key);
  const feedback = verifyTesterFeedback(response.signed_feedback, input.public_key);
  assertConclusionBinding(conclusion, submission, reference, candidate);
  assertFeedbackBinding(feedback, submission, reference, candidate);
  if (
    conclusion.outer_iteration !== feedback.outer_iteration ||
    conclusion.generation !== feedback.generation ||
    conclusion.wave_id !== feedback.wave_id ||
    conclusion.status !== response.status ||
    feedback.tester_conclusion_status !== response.status
  )
    failA1("TESTER_AGENT_BINDING_MISMATCH", "tester receipts disagree with response status");
  verifiedResponses.set(response, canonicalJsonString(response));
  return response;
}

export interface TesterAgentCommand {
  /** `control` drives the remote agent; `fetch` reads one receipt back. */
  kind: "control" | "fetch";
  argv: readonly string[];
  timeout_ms: number;
}

export interface TesterAgentCommandResult {
  code: number;
  stdout: string;
}

export type TesterAgentTransport = (
  command: TesterAgentCommand,
) => Promise<TesterAgentCommandResult>;

/**
 * Spawn without a shell, so the argv array is the whole of the command. The
 * remote side of `ssh host cat -- <path>` does run a shell, which is why the
 * receipt path is quoted below.
 */
async function defaultTransport(command: TesterAgentCommand): Promise<TesterAgentCommandResult> {
  const [file, ...args] = command.argv;
  if (file === undefined) failA1("TESTER_AGENT_UNREACHABLE", "empty tester agent command");
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, command.timeout_ms);
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      // Stop reading long before a runaway remote can fill this process.
      if (stdout.length <= MAX_RECEIPT_BYTES) stdout += chunk.toString("utf8");
    });
    child.on("error", () => settle(-1));
    child.on("close", (code) => settle(code ?? -1));
  });
}

/** Quote one argument for the remote shell that `ssh` starts. */
function remoteQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sshArgv(target: TesterAgentTarget, remoteCommand: readonly string[]): string[] {
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.ssh_port === undefined ? [] : ["-p", String(target.ssh_port)]),
    target.ssh_target,
    "--",
    ...remoteCommand,
  ];
}

function paseoSendArgv(config: TesterAgentTarget & { agent_id: string }, prompt: string): string[] {
  return [
    "paseo",
    "agent",
    "send",
    config.agent_id,
    "--host",
    testerAgentDaemonHost(config),
    "--prompt",
    prompt,
    "--json",
  ];
}

function parseReceipt(stdout: string): unknown {
  if (Buffer.byteLength(stdout, "utf8") > MAX_RECEIPT_BYTES)
    failA1("TESTER_AGENT_RESPONSE_INVALID", "tester receipt is too large");
  try {
    return JSON.parse(stdout);
  } catch {
    failA1("TESTER_AGENT_RESPONSE_INVALID", "tester receipt is not JSON");
  }
}

async function runTesterAgentExchange(input: {
  endpoint: TesterAgentEndpoint;
  transport: TesterAgentTransport;
  prompt: string;
  receipt_name: string;
}): Promise<unknown> {
  const { endpoint: config, transport } = input;
  const control = await transport({
    kind: "control",
    argv: paseoSendArgv(config, input.prompt),
    timeout_ms: config.request_timeout_ms,
  });
  if (control.code !== 0)
    failA1("TESTER_AGENT_UNREACHABLE", "the tester agent did not accept the request");
  const receiptPath = path.posix.join(config.remote_receipt_dir, input.receipt_name);
  const fetched = await transport({
    kind: "fetch",
    argv: sshArgv(config, ["cat", "--", remoteQuote(receiptPath)]),
    timeout_ms: config.request_timeout_ms,
  });
  if (fetched.code !== 0)
    failA1("TESTER_AGENT_UNREACHABLE", "the tester receipt could not be fetched");
  return parseReceipt(fetched.stdout);
}

/**
 * ARL-visible action one: ask the tester to set up a test for this project and
 * declare what it needs back. The research side sends a domain need; it does
 * not describe cases, and the tester does not return any.
 */
export async function declareTesterSubmissionContract(input: {
  endpoint: TesterAgentEndpoint;
  need: string;
  transport?: TesterAgentTransport;
}): Promise<{ contract: TesterSubmissionContract; contract_sha256: string }> {
  const config = validateTesterAgentEndpoint({ ...input.endpoint });
  const need = requireString(input.need, "tester_agent_need");
  if (need.length > MAX_USAGE_LENGTH)
    failA1("TESTER_AGENT_NEED_INVALID", "the domain test need is too long");
  const publicKey = readTesterAgentPublicKey(config);
  const value = await runTesterAgentExchange({
    endpoint: config,
    transport: input.transport ?? defaultTransport,
    prompt: canonicalJsonString({
      action: "declare_submission_contract",
      project_id: config.project_id,
      tester_id: config.tester_id,
      need,
    }),
    receipt_name: `contract-${config.project_id}.json`,
  });
  const contract = verifyTesterSubmissionContract(value, publicKey);
  if (contract.project_id !== config.project_id || contract.tester_id !== config.tester_id)
    failA1("TESTER_CONTRACT_MISMATCH", "declared contract names another project or tester");
  return { contract, contract_sha256: testerSubmissionContractSha256(contract) };
}

/**
 * ARL-visible action two: submit one produced artifact pair for testing. The
 * submission has already been checked against the tester's declared shape, so
 * the far side receives nothing it did not ask for.
 */
export async function submitToTesterAgent(input: {
  config: TesterAgentConfig;
  contract: TesterSubmissionContract;
  submission: TesterAgentSubmission;
  transport?: TesterAgentTransport;
}): Promise<TesterAgentResponse> {
  const config = validateTesterAgentConfig(input.config);
  const contract = validateTesterSubmissionContract(input.contract);
  const submission = validateTesterAgentSubmission(input.submission);
  if (submission.contract_sha256 !== testerSubmissionContractSha256(contract))
    failA1("TESTER_CONTRACT_MISMATCH", "submission does not name the supplied contract");
  if (submission.contract_sha256 !== config.submission_contract_sha256)
    failA1("TESTER_CONTRACT_MISMATCH", "submission names a contract the config did not freeze");
  const publicKey = readTesterAgentPublicKey(config);
  const submissionSha256 = testerAgentSubmissionSha256(submission);
  const value = await runTesterAgentExchange({
    endpoint: config,
    transport: input.transport ?? defaultTransport,
    prompt: canonicalJsonString({
      action: "run_submission",
      project_id: config.project_id,
      submission_sha256: submissionSha256,
      submission,
    }),
    receipt_name: `response-${submissionSha256}.json`,
  });
  return verifyTesterAgentResponse({
    value,
    contract,
    submission,
    config,
    public_key: publicKey,
  });
}

export function writeTesterAgentResponse(
  outputDirectory: string,
  response: TesterAgentResponse,
): {
  response_path: string;
  conclusion_path: string | null;
  feedback_path: string | null;
} {
  // Keep this boundary safe even when a caller bypasses submitToTesterAgent
  // and hands the writer a value assembled from an untrusted receipt.
  const normalizedResponse = validateTesterAgentResponse(response);
  if (verifiedResponses.get(response) !== canonicalJsonString(response))
    failA1("TESTER_AGENT_RESPONSE_NOT_VERIFIED", "verify the tester response before publishing it");
  const directory = normalizedAbsolutePath(outputDirectory, "tester_agent_output_directory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const responsePath = path.join(directory, "tester-agent-response.json");
  const conclusionPath = normalizedResponse.signed_conclusion
    ? path.join(directory, "tester-conclusion.json")
    : null;
  const feedbackPath = normalizedResponse.signed_feedback
    ? path.join(directory, "tester-feedback.json")
    : null;
  const {
    signed_conclusion: _conclusion,
    signed_feedback: _feedback,
    ...metadata
  } = normalizedResponse;
  writeStateJsonAtomic(responsePath, {
    ...metadata,
    conclusion_path: conclusionPath,
    feedback_path: feedbackPath,
  });
  if (conclusionPath !== null)
    writeStateJsonAtomic(conclusionPath, normalizedResponse.signed_conclusion);
  if (feedbackPath !== null) writeStateJsonAtomic(feedbackPath, normalizedResponse.signed_feedback);
  return {
    response_path: responsePath,
    conclusion_path: conclusionPath,
    feedback_path: feedbackPath,
  };
}

export function readTesterSubmissionContract(contractPath: string): TesterSubmissionContract {
  return validateTesterSubmissionContract(readStateFile(contractPath));
}

export function readTesterAgentSubmission(submissionPath: string): TesterAgentSubmission {
  return validateTesterAgentSubmission(readStateFile(submissionPath));
}

/**
 * Availability probe, in the order that makes a failure legible: can ssh reach
 * the box at all, is a Paseo daemon answering there, and does that box have
 * the claude binary the tester agent needs.
 */
export async function probeTesterAgentHost(input: {
  endpoint: TesterAgentTarget & { request_timeout_ms: number };
  transport?: TesterAgentTransport;
}): Promise<{ ssh: boolean; daemon: boolean; claude: boolean }> {
  const config = {
    ssh_target: sshTarget(input.endpoint.ssh_target, "tester_probe.ssh_target"),
    ...(input.endpoint.ssh_port === undefined
      ? {}
      : { ssh_port: port(input.endpoint.ssh_port, "tester_probe.ssh_port") }),
    daemon_port: port(input.endpoint.daemon_port, "tester_probe.daemon_port"),
    request_timeout_ms: requireInteger(
      input.endpoint.request_timeout_ms,
      "tester_probe.request_timeout_ms",
      1000,
    ),
  };
  const transport = input.transport ?? defaultTransport;
  const timeout = config.request_timeout_ms;
  const ssh = await transport({
    kind: "fetch",
    argv: sshArgv(config, ["true"]),
    timeout_ms: timeout,
  });
  if (ssh.code !== 0) return { ssh: false, daemon: false, claude: false };
  const daemon = await transport({
    kind: "control",
    argv: ["paseo", "agent", "ls", "--host", testerAgentDaemonHost(config), "--json"],
    timeout_ms: timeout,
  });
  const claude = await transport({
    kind: "fetch",
    argv: sshArgv(config, ["command", "-v", "claude"]),
    timeout_ms: timeout,
  });
  return { ssh: true, daemon: daemon.code === 0, claude: claude.code === 0 };
}

/**
 * What one deployment needs from the operator. There is no default: a machine,
 * an account, a directory and a provider are all site facts.
 */
export interface TesterDeploymentRequest {
  tester_id: string;
  project_id: string;
  ssh_target: string;
  ssh_port?: number;
  daemon_port: number;
  /** Remote directory the tester account owns; every remote path derives from it. */
  remote_home: string;
  /** Local directory copied into the remote staging area, then removed. */
  local_bundle_dir: string;
  /** Where the fetched public key is written on this machine. */
  public_key_path: string;
  /** Paseo provider for the tester agent, e.g. `claude/claude-opus-5`. */
  provider: string;
  request_timeout_ms: number;
}

export interface TesterDeploymentLayout {
  staging_dir: string;
  work_dir: string;
  key_dir: string;
  private_key_path: string;
  public_key_path: string;
  receipt_dir: string;
}

export interface TesterDeploymentResult {
  agent_id: string;
  layout: TesterDeploymentLayout;
  public_key_path: string;
  public_key_sha256: string;
}

export function testerDeploymentLayout(remoteHome: string): TesterDeploymentLayout {
  const home = normalizedAbsolutePath(remoteHome, "tester_deployment.remote_home");
  const keyDir = path.posix.join(home, "keys");
  return {
    staging_dir: path.posix.join(home, "staging"),
    work_dir: path.posix.join(home, "work"),
    key_dir: keyDir,
    private_key_path: path.posix.join(keyDir, "tester.key"),
    public_key_path: path.posix.join(keyDir, "tester.pub"),
    receipt_dir: path.posix.join(home, "receipts"),
  };
}

function validateDeploymentRequest(value: TesterDeploymentRequest): TesterDeploymentRequest {
  const timeout = requireInteger(
    value.request_timeout_ms,
    "tester_deployment.request_timeout_ms",
    1000,
  );
  return {
    tester_id: assertIdentifier(value.tester_id, "tester_deployment.tester_id"),
    project_id: assertIdentifier(value.project_id, "tester_deployment.project_id"),
    ssh_target: sshTarget(value.ssh_target, "tester_deployment.ssh_target"),
    ...(value.ssh_port === undefined
      ? {}
      : { ssh_port: port(value.ssh_port, "tester_deployment.ssh_port") }),
    daemon_port: port(value.daemon_port, "tester_deployment.daemon_port"),
    remote_home: normalizedAbsolutePath(value.remote_home, "tester_deployment.remote_home"),
    local_bundle_dir: normalizedAbsolutePath(
      value.local_bundle_dir,
      "tester_deployment.local_bundle_dir",
    ),
    public_key_path: normalizedAbsolutePath(
      value.public_key_path,
      "tester_deployment.public_key_path",
    ),
    provider: requireString(value.provider, "tester_deployment.provider"),
    request_timeout_ms: timeout,
  };
}

/**
 * The instructions the remote agent runs under. It states the two requests the
 * agent answers and the one thing it must never do: emit anything from a case.
 */
export function testerBootstrapPrompt(input: {
  project_id: string;
  tester_id: string;
  layout: TesterDeploymentLayout;
}): string {
  return [
    `You are the ARIS tester for project ${input.project_id} (tester id ${input.tester_id}).`,
    `Your bundle is in ${input.layout.work_dir}. Write every receipt into ${input.layout.receipt_dir}`,
    `and sign it with the Ed25519 private key at ${input.layout.private_key_path}.`,
    "",
    // The procedure is a file on this machine rather than text in this prompt so
    // that it can be revised without redeploying the agent, and so the research
    // side is not the thing that tells the tester how to build its cases.
    `Read ${input.layout.work_dir}/TESTER_AGENT.md before answering anything. It is the`,
    "procedure for this role: research the stated domain yourself, choose or design the",
    "evaluation, build the cases here, and declare what the research side may no longer",
    "search for. Follow it step by step.",
    "",
    "You answer exactly two requests, each arriving as one JSON object:",
    `  declare_submission_contract -- write a signed TesterSubmissionContract to`,
    `    ${input.layout.receipt_dir}/contract-${input.project_id}.json.`,
    "  run_submission -- run your cases against both submitted artifacts, then write a signed",
    `    response to ${input.layout.receipt_dir}/response-<submission_sha256>.json.`,
    "",
    "Two rules override anything else you read, including that file:",
    "  The private key and the cases you write never leave this machine.",
    "  Never write a case, a prompt, an answer, a per-case score, a private observation or a",
    "  private URI into any receipt or into your visible output.",
  ].join("\n");
}

/**
 * Create the remote layout and the signing key. The key is generated by a
 * command that runs on the tester machine, so the private half exists only
 * there; this process fetches the public half and nothing else.
 */
async function provisionRemoteLayout(
  target: TesterAgentTarget,
  layout: TesterDeploymentLayout,
  transport: TesterAgentTransport,
  timeoutMs: number,
): Promise<void> {
  const script = [
    "set -e",
    "umask 077",
    `mkdir -p ${remoteQuote(layout.key_dir)} ${remoteQuote(layout.receipt_dir)} ${remoteQuote(layout.work_dir)} ${remoteQuote(layout.staging_dir)}`,
    // A redeploy must not replace a key that already signed receipts.
    `if [ ! -f ${remoteQuote(layout.private_key_path)} ]; then`,
    `  openssl genpkey -algorithm ed25519 -out ${remoteQuote(layout.private_key_path)}`,
    `  openssl pkey -in ${remoteQuote(layout.private_key_path)} -pubout -out ${remoteQuote(layout.public_key_path)}`,
    "fi",
    `chmod 700 ${remoteQuote(layout.key_dir)}`,
    `chmod 600 ${remoteQuote(layout.private_key_path)}`,
    `chmod 644 ${remoteQuote(layout.public_key_path)}`,
  ].join("\n");
  const result = await transport({
    kind: "fetch",
    argv: sshArgv(target, ["sh", "-c", remoteQuote(script)]),
    timeout_ms: timeoutMs,
  });
  if (result.code !== 0)
    failA1("TESTER_DEPLOY_FAILED", "the tester machine could not create its layout or key");
}

function scpArgv(target: TesterAgentTarget, localDir: string, remoteDir: string): string[] {
  return [
    "scp",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.ssh_port === undefined ? [] : ["-P", String(target.ssh_port)]),
    "-r",
    `${localDir}/.`,
    `${target.ssh_target}:${remoteQuote(remoteDir)}`,
  ];
}

export async function deployTesterAgent(input: {
  request: TesterDeploymentRequest;
  transport?: TesterAgentTransport;
}): Promise<TesterDeploymentResult> {
  const request = validateDeploymentRequest(input.request);
  const transport = input.transport ?? defaultTransport;
  const target: TesterAgentTarget = {
    ssh_target: request.ssh_target,
    ...(request.ssh_port === undefined ? {} : { ssh_port: request.ssh_port }),
    daemon_port: request.daemon_port,
  };
  const layout = testerDeploymentLayout(request.remote_home);
  await provisionRemoteLayout(target, layout, transport, request.request_timeout_ms);

  const copied = await transport({
    kind: "fetch",
    argv: scpArgv(target, request.local_bundle_dir, layout.work_dir),
    timeout_ms: request.request_timeout_ms,
  });
  if (copied.code !== 0)
    failA1("TESTER_DEPLOY_FAILED", "the tester bundle could not be copied to the tester machine");

  const created = await transport({
    kind: "control",
    argv: [
      "paseo",
      "agent",
      "run",
      testerBootstrapPrompt({
        project_id: request.project_id,
        tester_id: request.tester_id,
        layout,
      }),
      "--host",
      testerAgentDaemonHost(target),
      "--provider",
      request.provider,
      "--cwd",
      layout.work_dir,
      "--title",
      `aris tester ${request.project_id}`,
      "--label",
      `aris_project=${request.project_id}`,
      "--label",
      `aris_tester=${request.tester_id}`,
      "--background",
      "--json",
    ],
    timeout_ms: request.request_timeout_ms,
  });
  if (created.code !== 0)
    failA1("TESTER_DEPLOY_FAILED", "the tester agent could not be created on the remote daemon");
  const createdValue = parseReceipt(created.stdout);
  if (!isRecord(createdValue) || typeof createdValue.agentId !== "string")
    failA1("TESTER_DEPLOY_FAILED", "the remote daemon did not report a new agent id");
  const agentId = assertIdentifier(createdValue.agentId, "tester_deployment.agent_id");

  const fetched = await transport({
    kind: "fetch",
    argv: sshArgv(target, ["cat", "--", remoteQuote(layout.public_key_path)]),
    timeout_ms: request.request_timeout_ms,
  });
  if (fetched.code !== 0 || fetched.stdout.trim() === "")
    failA1("TESTER_DEPLOY_FAILED", "the tester public key could not be fetched");
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(fetched.stdout);
  } catch {
    failA1("TESTER_DEPLOY_FAILED", "the fetched tester key is not a public key");
  }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    failA1("TESTER_DEPLOY_FAILED", "the tester key must be ed25519");
  fs.mkdirSync(path.dirname(request.public_key_path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(request.public_key_path, fetched.stdout, { mode: 0o644 });
  return {
    agent_id: agentId,
    layout,
    public_key_path: request.public_key_path,
    public_key_sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(request.public_key_path))
      .digest("hex"),
  };
}

/**
 * Remove the staging areas once the agent is running. Only the paths this
 * module created are accepted, and a remote path shallow enough to be
 * dangerous is refused outright.
 */
export async function cleanupTesterDeployment(input: {
  target: TesterAgentTarget;
  remote_staging_dir: string;
  local_bundle_dir: string | null;
  request_timeout_ms: number;
  transport?: TesterAgentTransport;
}): Promise<{ removed: string[] }> {
  const target: TesterAgentTarget = {
    ssh_target: sshTarget(input.target.ssh_target, "tester_cleanup.ssh_target"),
    ...(input.target.ssh_port === undefined
      ? {}
      : { ssh_port: port(input.target.ssh_port, "tester_cleanup.ssh_port") }),
    daemon_port: port(input.target.daemon_port, "tester_cleanup.daemon_port"),
  };
  const staging = normalizedAbsolutePath(
    input.remote_staging_dir,
    "tester_cleanup.remote_staging_dir",
  );
  if (staging.split("/").filter((part) => part !== "").length < 2 || !staging.endsWith("/staging"))
    failA1("TESTER_CLEANUP_REFUSED", "refusing to remove a path this deployment did not create");
  const removed: string[] = [];
  const result = await (input.transport ?? defaultTransport)({
    kind: "fetch",
    argv: sshArgv(target, ["rm", "-rf", "--", remoteQuote(staging)]),
    timeout_ms: requireInteger(input.request_timeout_ms, "tester_cleanup.request_timeout_ms", 1000),
  });
  if (result.code !== 0) failA1("TESTER_CLEANUP_FAILED", "the remote staging area was not removed");
  removed.push(`${target.ssh_target}:${staging}`);
  if (input.local_bundle_dir !== null) {
    const local = normalizedAbsolutePath(input.local_bundle_dir, "tester_cleanup.local_bundle_dir");
    fs.rmSync(local, { recursive: true, force: true });
    removed.push(local);
  }
  return { removed };
}

/**
 * What a finished deployment leaves on disk: how to reach the tester, and the
 * remote paths that cleanup and later redeployments need. It is deliberately
 * not a `TesterAgentConfig` yet -- no contract has been declared at this point.
 */
export interface TesterDeploymentRecord {
  schema_version: 1;
  kind: "tester_deployment";
  endpoint: TesterAgentEndpoint;
  layout: TesterDeploymentLayout;
}

export function testerDeploymentRecord(
  request: TesterDeploymentRequest,
  deployment: TesterDeploymentResult,
): TesterDeploymentRecord {
  const normalized = validateDeploymentRequest(request);
  return {
    schema_version: 1,
    kind: "tester_deployment",
    endpoint: validateTesterAgentEndpoint({
      tester_id: normalized.tester_id,
      project_id: normalized.project_id,
      ssh_target: normalized.ssh_target,
      ...(normalized.ssh_port === undefined ? {} : { ssh_port: normalized.ssh_port }),
      daemon_port: normalized.daemon_port,
      agent_id: deployment.agent_id,
      remote_receipt_dir: deployment.layout.receipt_dir,
      public_key_path: deployment.public_key_path,
      public_key_sha256: deployment.public_key_sha256,
      request_timeout_ms: normalized.request_timeout_ms,
    }),
    layout: deployment.layout,
  };
}

export function validateTesterDeploymentRecord(value: unknown): TesterDeploymentRecord {
  if (!isRecord(value)) failA1("TESTER_DEPLOYMENT_INVALID", "deployment record must be an object");
  assertNoUnknownFields(
    value,
    ["schema_version", "kind", "endpoint", "layout"],
    "tester_deployment",
  );
  if (value.schema_version !== 1 || value.kind !== "tester_deployment")
    failA1("TESTER_DEPLOYMENT_INVALID", "only version 1 deployment records are supported");
  if (!isRecord(value.endpoint) || !isRecord(value.layout))
    failA1("TESTER_DEPLOYMENT_INVALID", "deployment record needs an endpoint and a layout");
  // Every remote path derives from one home directory, so the stored layout is
  // recomputed from it and rejected if it disagrees. A record cannot smuggle in
  // a staging path that cleanup would then delete.
  const receiptDir = normalizedAbsolutePath(
    value.layout.receipt_dir,
    "tester_deployment.layout.receipt_dir",
  );
  const layout = testerDeploymentLayout(path.posix.dirname(receiptDir));
  if (canonicalJsonString(layout) !== canonicalJsonString(value.layout))
    failA1("TESTER_DEPLOYMENT_INVALID", "deployment layout is not derived from one remote home");
  return {
    schema_version: 1,
    kind: "tester_deployment",
    endpoint: validateTesterAgentEndpoint(value.endpoint),
    layout,
  };
}

export function readTesterDeploymentRecord(recordPath: string): TesterDeploymentRecord {
  return validateTesterDeploymentRecord(readStateFile(recordPath));
}

/**
 * Accept either artifact that can address the tester: the deployment record
 * written before a contract exists, or the config written after one does.
 */
export function readTesterAgentEndpoint(sourcePath: string): TesterAgentEndpoint {
  const stored = readStateFile(sourcePath);
  if (!isRecord(stored))
    failA1("TESTER_AGENT_CONFIG_REQUIRED", "tester endpoint must be an object");
  if (stored.kind === "tester_deployment") {
    const record = validateTesterDeploymentRecord(stored);
    readTesterAgentPublicKey(record.endpoint);
    return record.endpoint;
  }
  const config = validateTesterAgentConfig(stored);
  readTesterAgentPublicKey(config);
  return config;
}

/** Assemble the config the research side consumes, once a contract exists. */
export function testerAgentConfigFromDeployment(input: {
  record: TesterDeploymentRecord;
  contract: TesterSubmissionContract;
}): TesterAgentConfig {
  const record = validateTesterDeploymentRecord(input.record);
  const contract = validateTesterSubmissionContract(input.contract);
  // The contract is passed whole rather than as a digest so the two cannot be
  // freezing different things: a contract declared against another project or
  // another tester would pin a shape this endpoint never agreed to, and every
  // later submission would be refused by the far side instead of here.
  if (
    contract.project_id !== record.endpoint.project_id ||
    contract.tester_id !== record.endpoint.tester_id
  )
    failA1(
      "TESTER_CONTRACT_MISMATCH",
      "contract names another project or tester than the deployment",
    );
  return validateTesterAgentConfig({
    schema_version: 1,
    mode: "tester_agent",
    ...record.endpoint,
    submission_contract_sha256: testerSubmissionContractSha256(contract),
  });
}
