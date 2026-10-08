/** The validation machine's frozen terms: what is measured, how often, and by whom. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStateFile, writeStateFileAtomic } from "../state-file.js";
import {
  readTesterFacilityConfig,
  testerConfigPath,
  testerFacilityConfigSha256,
} from "../tester-facility.js";
import {
  assertNoUnknownFields,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "../validate.js";

export type MetricDirection = "higher_better" | "lower_better";

export interface ValidationLimits {
  /** Counted submissions; format failures and infrastructure failures do not count. */
  max_submissions: number;
  max_concurrent: number;
  max_upload_bytes: number;
  max_unpacked_bytes: number;
  max_files: number;
  upload_ttl_minutes: number;
  review_timeout_minutes: number;
  /** Rewrites a validation agent gets when its feedback trips the leak check. */
  feedback_attempts: number;
}

export interface ValidationAgentConfig {
  provider: string;
  model?: string;
  mode?: string;
  thinking?: string;
  /**
   * argv prefix that runs the Paseo CLI. On Windows `paseo` is a .cmd shim that
   * cannot be spawned without a shell, so name node and the CLI script instead.
   */
  paseo_command: string[];
}

export interface ValidationConfig {
  schema_version: 1;
  metric: { name: string; direction: MetricDirection; target: number };
  /** The benchmark frozen at setup; a different installed config stops the service. */
  tester_config_sha256: string;
  /** What a validation agent must write into a submission's adapter directory. */
  adapter_contract: string;
  limits: ValidationLimits;
  leak_check: { hidden_paths: string[]; min_match_chars: number };
  agent: ValidationAgentConfig;
  service: { host: string; public_url: string };
}

export const DEFAULT_LIMITS: ValidationLimits = {
  max_submissions: 20,
  max_concurrent: 1,
  max_upload_bytes: 2 * 1024 ** 3,
  max_unpacked_bytes: 8 * 1024 ** 3,
  max_files: 20_000,
  upload_ttl_minutes: 60,
  review_timeout_minutes: 24 * 60,
  feedback_attempts: 3,
};

export const validationDir = (root: string): string =>
  path.join(path.resolve(root), ".aris", "validation");
export const validationConfigPath = (root: string): string =>
  path.join(validationDir(root), "config.json");
export const validationTokenPath = (root: string): string =>
  path.join(validationDir(root), "token");

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_VALUE", "expected a list", location);
  return value.map((item, index) => requireString(item, `${location}[${index}]`));
}

export function validateValidationConfig(value: unknown): ValidationConfig {
  if (!isRecord(value) || value.schema_version !== 1)
    failA1("INVALID_VALIDATION_CONFIG", "run /aris-setup validation to create it");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "metric",
      "tester_config_sha256",
      "adapter_contract",
      "limits",
      "leak_check",
      "agent",
      "service",
    ],
    "validation",
  );
  for (const key of ["metric", "limits", "leak_check", "agent", "service"])
    if (!isRecord(value[key])) failA1("INVALID_VALIDATION_CONFIG", `${key} must be an object`);
  const metric = value.metric as Record<string, unknown>;
  assertNoUnknownFields(metric, ["name", "direction", "target"], "metric");
  if (metric.direction !== "higher_better" && metric.direction !== "lower_better")
    failA1("INVALID_VALUE", "choose higher_better or lower_better", "metric.direction");
  const rawLimits = value.limits as Record<string, unknown>;
  assertNoUnknownFields(rawLimits, Object.keys(DEFAULT_LIMITS), "limits");
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ValidationLimits)[])
    if (rawLimits[key] !== undefined)
      limits[key] = requireInteger(
        rawLimits[key],
        `limits.${key}`,
        key === "feedback_attempts" ? 0 : 1,
      );
  const leak = value.leak_check as Record<string, unknown>;
  assertNoUnknownFields(leak, ["hidden_paths", "min_match_chars"], "leak_check");
  const hidden = strings(leak.hidden_paths, "leak_check.hidden_paths");
  if (!hidden.length)
    failA1("INVALID_VALUE", "name the hidden benchmark files", "leak_check.hidden_paths");
  for (const item of hidden)
    if (!path.isAbsolute(item))
      failA1("INVALID_VALUE", "hidden paths must be absolute", "leak_check.hidden_paths");
  const agent = value.agent as Record<string, unknown>;
  assertNoUnknownFields(agent, ["provider", "model", "mode", "thinking", "paseo_command"], "agent");
  const command = strings(agent.paseo_command ?? ["paseo"], "agent.paseo_command");
  if (!command.length) failA1("INVALID_VALUE", "must not be empty", "agent.paseo_command");
  const optional = (key: string) =>
    agent[key] === undefined || agent[key] === null
      ? {}
      : { [key]: requireString(agent[key], `agent.${key}`) };
  const service = value.service as Record<string, unknown>;
  assertNoUnknownFields(service, ["host", "public_url"], "service");
  const publicUrl = requireString(service.public_url, "service.public_url");
  if (!/^https?:\/\/[^/]+/.test(publicUrl))
    failA1("INVALID_VALUE", "must be an http(s) URL", "service.public_url");
  if (!/^[0-9a-f]{64}$/.test(String(value.tester_config_sha256)))
    failA1("INVALID_VALUE", "must be a SHA-256 digest", "tester_config_sha256");
  return {
    schema_version: 1,
    metric: {
      name: requireString(metric.name, "metric.name"),
      direction: metric.direction,
      target: requireFiniteNumber(metric.target, "metric.target"),
    },
    tester_config_sha256: String(value.tester_config_sha256),
    adapter_contract: requireString(value.adapter_contract, "adapter_contract"),
    limits,
    leak_check: {
      hidden_paths: hidden,
      min_match_chars: requireInteger(leak.min_match_chars ?? 40, "leak_check.min_match_chars", 8),
    },
    agent: {
      provider: requireString(agent.provider, "agent.provider"),
      ...optional("model"),
      ...optional("mode"),
      ...optional("thinking"),
      paseo_command: command,
    },
    service: {
      host: service.host === undefined ? "127.0.0.1" : requireString(service.host, "service.host"),
      public_url: publicUrl.replace(/\/+$/, ""),
    },
  };
}

export function readValidationConfig(root: string): ValidationConfig {
  const file = validationConfigPath(root);
  if (!fs.existsSync(file))
    failA1("VALIDATION_NOT_CONFIGURED", "run /aris-setup validation on this machine");
  return validateValidationConfig(readStateFile(file));
}

/** The installed benchmark must still be the one frozen at setup. */
export function assertFrozenBenchmark(root: string, config: ValidationConfig): void {
  const actual = testerFacilityConfigSha256(readTesterFacilityConfig(testerConfigPath(root)));
  if (actual !== config.tester_config_sha256)
    failA1(
      "BENCHMARK_CHANGED",
      "the installed benchmark differs from the frozen one; validation is stopped",
    );
}

export function readValidationToken(root: string): string {
  const file = validationTokenPath(root);
  if (!fs.existsSync(file)) failA1("VALIDATION_NOT_CONFIGURED", "service token is missing");
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 32) failA1("VALIDATION_NOT_CONFIGURED", "service token is too short");
  return token;
}

/** Create the bearer token once; re-running setup keeps the worker's copy valid. */
export function ensureValidationToken(root: string): string {
  const file = validationTokenPath(root);
  if (fs.existsSync(file)) return readValidationToken(root);
  const token = crypto.randomBytes(32).toString("base64url");
  writeStateFileAtomic(file, `${token}\n`);
  return token;
}

export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const left = Buffer.from(expected),
    right = Buffer.from(presented);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function meetsTarget(config: ValidationConfig, value: number): boolean {
  return config.metric.direction === "higher_better"
    ? value >= config.metric.target
    : value <= config.metric.target;
}
