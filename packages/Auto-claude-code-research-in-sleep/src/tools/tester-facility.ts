import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  validateTesterDeliverables,
  verifyTesterDeliverables,
  type TesterDeliverables,
} from "./tester-deliverables.js";
import {
  acquireStateFileLock,
  releaseStateFileLock,
  readStateFile,
  withStateFileLock,
  writeStateJsonAtomic,
} from "./state-file.js";
import {
  assertIdentifier,
  assertSha256,
  assertNoUnknownFields,
  isRecord,
  requireInteger,
  requireString,
  failA1,
} from "./workflow-spec.js";

export interface TesterCommand {
  argv: string[];
  timeout_ms: number;
}
export interface TesterFacilityConfig {
  schema_version: 1;
  mode: "tester_facility";
  tester_id: string;
  project_id: string;
  version: string;
  benchmark: { name: string; source: string; revision: string };
  dataset: { name: string; revision: string; split: string; expected_samples: number };
  metrics: Array<{
    name: string;
    direction: "higher_better" | "lower_better";
    aggregation: "mean" | "sum" | "external";
  }>;
  execution: { kind: "local" | "ssh"; cwd: string; host?: string; env: Record<string, string> };
  setup: TesterCommand[];
  healthcheck: TesterCommand;
  smoke: TesterCommand;
  test: TesterCommand;
  evidence_files: string[];
}
export interface TesterEvidence {
  path: string;
  sha256: string;
}
export interface TesterSetupReceipt {
  schema_version: 1;
  config_sha256: string;
  status: "ready";
  evidence: TesterEvidence[];
  completed_at: string;
}
export interface TesterTestRequest {
  schema_version: 1;
  test_id: string;
  run_id: string;
  iteration: number;
  experiment_id: string;
  artifact: { ref: string; sha256: string };
  deliverables?: TesterDeliverables;
  mode: "full" | "smoke";
}
export interface TesterTestResult {
  schema_version: 1;
  test_id: string;
  request: TesterTestRequest;
  request_sha256: string;
  config: TesterFacilityConfig;
  config_sha256: string;
  status: "completed";
  metrics: Record<string, number>;
  sample_count: number;
  failed_samples: number;
  evidence: TesterEvidence[];
  completed_at: string;
}
export interface TesterAuditReview {
  schema_version: 1;
  result_sha256: string;
  reviewer_id: string;
  status: "pass" | "warn" | "fail";
  checks: { protocol: boolean; scoring: boolean; coverage: boolean; comparability: boolean };
  findings: string[];
}
export interface TesterAuditReceipt extends TesterAuditReview {
  test_id: string;
  config_sha256: string;
  evidence: TesterEvidence[];
  completed_at: string;
}
export interface TesterJob {
  schema_version: 1;
  request: TesterTestRequest;
  request_sha256: string;
  config: TesterFacilityConfig;
  config_sha256: string;
  config_path: string;
  status: "pending" | "running" | "completed" | "failed";
  pid: number | null;
  attempt: number;
  error: string | null;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_TESTER_FACILITY", `${label} must be an array`);
  return value.map((v, i) => requireString(v, `${label}[${i}]`));
}
function command(value: unknown, label: string): TesterCommand {
  if (!isRecord(value)) failA1("INVALID_TESTER_FACILITY", `${label} must be a command`);
  if (!Array.isArray(value.argv) || value.argv.some((v) => typeof v !== "string"))
    failA1("INVALID_TESTER_FACILITY", `${label}.argv must contain strings`);
  assertNoUnknownFields(value, ["argv", "timeout_ms"], label);
  const argv = value.argv as string[];
  if (!argv.length || !argv[0])
    failA1("INVALID_TESTER_FACILITY", `${label}.argv must not be empty`);
  return { argv, timeout_ms: requireInteger(value.timeout_ms, `${label}.timeout_ms`, 1) };
}
export function validateTesterFacilityConfig(value: unknown): TesterFacilityConfig {
  if (!isRecord(value) || value.schema_version !== 1 || value.mode !== "tester_facility")
    failA1(
      "TESTER_SETUP_MIGRATION_REQUIRED",
      "run /aris-setup to create a tester facility configuration",
    );
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "mode",
      "tester_id",
      "project_id",
      "version",
      "benchmark",
      "dataset",
      "metrics",
      "execution",
      "setup",
      "healthcheck",
      "smoke",
      "test",
      "evidence_files",
    ],
    "tester_facility",
  );
  for (const key of ["benchmark", "dataset", "execution"])
    if (!isRecord(value[key])) failA1("INVALID_TESTER_FACILITY", `${key} must be an object`);
  const b = value.benchmark as Record<string, unknown>,
    d = value.dataset as Record<string, unknown>,
    e = value.execution as Record<string, unknown>;
  assertNoUnknownFields(b, ["name", "source", "revision"], "benchmark");
  assertNoUnknownFields(d, ["name", "revision", "split", "expected_samples"], "dataset");
  assertNoUnknownFields(e, ["kind", "cwd", "host", "env"], "execution");
  if (e.kind !== "local" && e.kind !== "ssh")
    failA1("INVALID_TESTER_FACILITY", "execution.kind must be local or ssh");
  const cwd = requireString(e.cwd, "execution.cwd");
  if (!path.isAbsolute(cwd)) failA1("INVALID_TESTER_FACILITY", "execution.cwd must be absolute");
  const env: Record<string, string> = {};
  if (!isRecord(e.env)) failA1("INVALID_TESTER_FACILITY", "execution.env must be an object");
  for (const [key, item] of Object.entries(e.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      failA1("INVALID_TESTER_FACILITY", "invalid environment key");
    if (typeof item !== "string")
      failA1("INVALID_TESTER_FACILITY", "environment values must be strings");
    env[key] = item;
  }
  if (!Array.isArray(value.metrics) || !value.metrics.length || !Array.isArray(value.setup))
    failA1("INVALID_TESTER_FACILITY", "metrics and setup must be declared");
  const metrics = value.metrics.map((m) => {
    if (
      !isRecord(m) ||
      !["higher_better", "lower_better"].includes(String(m.direction)) ||
      !["mean", "sum", "external"].includes(String(m.aggregation))
    )
      failA1("INVALID_TESTER_FACILITY", "invalid metric definition");
    assertNoUnknownFields(m, ["name", "direction", "aggregation"], "metric");
    return {
      name: assertIdentifier(m.name, "metric.name"),
      direction: m.direction,
      aggregation: m.aggregation,
    } as TesterFacilityConfig["metrics"][number];
  });
  if (new Set(metrics.map((m) => m.name)).size !== metrics.length)
    failA1("INVALID_TESTER_FACILITY", "duplicate metrics");
  const evidenceFiles = strings(value.evidence_files, "evidence_files");
  if (!evidenceFiles.length)
    failA1(
      "INVALID_TESTER_FACILITY",
      "pin the runner, configuration and data manifest in evidence_files",
    );
  const host = e.kind === "ssh" ? requireString(e.host, "execution.host") : undefined;
  if (host !== undefined && (!/^[A-Za-z0-9_.@-]+$/.test(host) || host.startsWith("-")))
    failA1("INVALID_TESTER_FACILITY", "invalid SSH host");
  return {
    schema_version: 1,
    mode: "tester_facility",
    tester_id: assertIdentifier(value.tester_id, "tester_id"),
    project_id: assertIdentifier(value.project_id, "project_id"),
    version: assertIdentifier(value.version, "version"),
    benchmark: {
      name: requireString(b.name, "benchmark.name"),
      source: requireString(b.source, "benchmark.source"),
      revision: requireString(b.revision, "benchmark.revision"),
    },
    dataset: {
      name: requireString(d.name, "dataset.name"),
      revision: requireString(d.revision, "dataset.revision"),
      split: requireString(d.split, "dataset.split"),
      expected_samples: requireInteger(d.expected_samples, "dataset.expected_samples", 1),
    },
    metrics,
    execution: { kind: e.kind, cwd, ...(host ? { host } : {}), env },
    setup: value.setup.map((v, i) => command(v, `setup[${i}]`)),
    healthcheck: command(value.healthcheck, "healthcheck"),
    smoke: command(value.smoke, "smoke"),
    test: command(value.test, "test"),
    evidence_files: evidenceFiles,
  };
}
export function testerFacilityConfigSha256(value: TesterFacilityConfig): string {
  return canonicalJsonSha256(validateTesterFacilityConfig(value));
}
export const testerConfigPath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "tester-config.json");
export function readTesterFacilityConfig(file: string): TesterFacilityConfig {
  return validateTesterFacilityConfig(readStateFile(file));
}
export function evidenceFile(file: string): TesterEvidence {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
    failA1("TESTER_EVIDENCE_MISSING", resolved);
  return {
    path: resolved,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex"),
  };
}
function verifyEvidence(evidence: TesterEvidence[]): void {
  if (!Array.isArray(evidence) || !evidence.length)
    failA1("TESTER_EVIDENCE_MISSING", "no evidence recorded");
  for (const item of evidence)
    if (evidenceFile(item.path).sha256 !== assertSha256(item.sha256, "evidence.sha256"))
      failA1("TESTER_EVIDENCE_CHANGED", item.path);
}
function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
async function execute(
  config: TesterFacilityConfig,
  cmd: TesterCommand,
  env: Record<string, string>,
  logPath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "a");
  const remote = config.execution.kind === "ssh";
  const vars = { ...config.execution.env, ...env };
  const argv = remote
    ? [
        "-o",
        "BatchMode=yes",
        "--",
        config.execution.host!,
        `cd ${quote(config.execution.cwd)} && exec env ${Object.entries(vars)
          .map(([k, v]) => quote(`${k}=${v}`))
          .join(" ")} ${cmd.argv.map(quote).join(" ")}`,
      ]
    : cmd.argv.slice(1);
  const executable = remote ? "ssh" : cmd.argv[0]!;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, argv, {
        cwd: remote ? undefined : config.execution.cwd,
        env: { ...process.env, ...vars },
        stdio: ["ignore", log, log],
        detached: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {}
      }, cmd.timeout_ms);
      const killTimer = setTimeout(() => {
        if (timedOut) {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }
      }, cmd.timeout_ms + 5000);
      child.on("error", (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        code === 0 && !timedOut
          ? resolve()
          : reject(
              new Error(`${executable}: ${timedOut ? "timeout" : `exit ${code}`} (see ${logPath})`),
            );
      });
    });
  } finally {
    fs.closeSync(log);
  }
}
async function fetchRemote(
  config: TesterFacilityConfig,
  remotePath: string,
  localPath: string,
): Promise<void> {
  if (config.execution.kind === "local") return;
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const fd = fs.openSync(localPath, "w");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ssh",
        ["-o", "BatchMode=yes", "--", config.execution.host!, `cat -- ${quote(remotePath)}`],
        { stdio: ["ignore", fd, "pipe"] },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
      child.stderr?.resume();
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`could not fetch ${remotePath}`));
      });
    });
  } finally {
    fs.closeSync(fd);
  }
}
export function assertTesterSetupReady(configPath: string): TesterSetupReceipt {
  const config = readTesterFacilityConfig(configPath);
  if (!fs.existsSync(`${configPath}.setup.json`))
    failA1("TESTER_SETUP_REQUIRED", "run /aris-setup to initialize tester facilities");
  const receipt = readStateFile<TesterSetupReceipt>(`${configPath}.setup.json`);
  if (
    receipt.schema_version !== 1 ||
    receipt.status !== "ready" ||
    receipt.config_sha256 !== testerFacilityConfigSha256(config) ||
    !Array.isArray(receipt.evidence) ||
    receipt.evidence.length !== config.evidence_files.length
  )
    failA1("TESTER_SETUP_REQUIRED", "run /aris-setup before testing");
  verifyEvidence(receipt.evidence);
  return receipt;
}
export async function setupTesterFacility(
  root: string,
  value: unknown,
): Promise<TesterFacilityConfig> {
  const lockPath = `${testerConfigPath(root)}.setup`,
    token = acquireStateFileLock(lockPath);
  try {
    return await setupTesterFacilityUnlocked(root, value);
  } finally {
    releaseStateFileLock(lockPath, token);
  }
}
async function setupTesterFacilityUnlocked(
  root: string,
  value: unknown,
): Promise<TesterFacilityConfig> {
  const config = validateTesterFacilityConfig(value),
    file = testerConfigPath(root),
    log = `${file}.setup.log`;
  if (config.execution.kind === "local") fs.mkdirSync(config.execution.cwd, { recursive: true });
  // A same-version setup is reusable only while all installed evidence still matches.
  if (fs.existsSync(file) && fs.existsSync(`${file}.setup.json`)) {
    try {
      if (
        testerFacilityConfigSha256(readTesterFacilityConfig(file)) ===
        testerFacilityConfigSha256(config)
      ) {
        assertTesterSetupReady(file);
        removeLegacyTesterGuard(root);
        return config;
      }
    } catch {}
  }
  fs.rmSync(`${file}.setup.json`, { force: true });
  for (const cmd of config.setup) await execute(config, cmd, {}, log);
  await execute(config, config.healthcheck, {}, log);
  await execute(config, config.smoke, { ARIS_TEST_MODE: "smoke" }, log);
  const evidence: TesterEvidence[] = [];
  for (const [i, source] of config.evidence_files.entries()) {
    const remote = path.resolve(config.execution.cwd, source);
    const local =
      config.execution.kind === "local"
        ? remote
        : path.join(path.dirname(file), "tester-setup-evidence", `${i}-${path.basename(source)}`);
    await fetchRemote(config, remote, local);
    evidence.push(evidenceFile(local));
  }
  writeStateJsonAtomic(file, config);
  writeStateJsonAtomic(`${file}.setup.json`, {
    schema_version: 1,
    config_sha256: testerFacilityConfigSha256(config),
    status: "ready",
    evidence,
    completed_at: new Date().toISOString(),
  } satisfies TesterSetupReceipt);
  removeLegacyTesterGuard(root);
  return config;
}
export function removeLegacyTesterGuard(root: string): void {
  const settingsPath = path.join(root, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = readStateFile<Record<string, unknown>>(settingsPath);
    if (isRecord(settings.hooks) && Array.isArray(settings.hooks.PreToolUse)) {
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !Array.isArray(entry.hooks)) return [entry];
        const hooks = entry.hooks.filter(
          (h: unknown) =>
            !isRecord(h) ||
            typeof h.command !== "string" ||
            !/(?:^|[\s/\"'])search-guard\.(?:js|ts)(?:[\s\"']|$)/.test(h.command),
        );
        return hooks.length ? [{ ...entry, hooks }] : [];
      });
      writeStateJsonAtomic(settingsPath, settings);
    }
  }
  for (const file of ["search-policy.json", "search-audit.jsonl", "search-guard.js"])
    fs.rmSync(path.join(root, ".aris", file), { force: true });
}
export function validateTesterTestRequest(value: unknown): TesterTestRequest {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !isRecord(value.artifact) ||
    !["full", "smoke"].includes(String(value.mode))
  )
    failA1("INVALID_TESTER_REQUEST", "invalid test request");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "test_id",
      "run_id",
      "iteration",
      "experiment_id",
      "artifact",
      "deliverables",
      "mode",
    ],
    "request",
  );
  assertNoUnknownFields(value.artifact, ["ref", "sha256"], "artifact");
  return {
    schema_version: 1,
    test_id: assertIdentifier(value.test_id, "test_id"),
    run_id: assertIdentifier(value.run_id, "run_id"),
    iteration: requireInteger(value.iteration, "iteration", 1),
    experiment_id: assertIdentifier(value.experiment_id, "experiment_id"),
    artifact: {
      ref: requireString(value.artifact.ref, "artifact.ref"),
      sha256: assertSha256(value.artifact.sha256, "artifact.sha256"),
    },
    ...(value.deliverables === undefined
      ? {}
      : { deliverables: validateTesterDeliverables(value.deliverables) }),
    mode: value.mode as "full" | "smoke",
  };
}
export function testerJobDirectory(root: string, id: string): string {
  // Identifiers used as filesystem components must also forbid slashes and traversal.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    failA1("INVALID_TESTER_REQUEST", "test_id must be a filename-safe identifier");
  return path.join(path.resolve(root), ".aris", "tester", "tests", id);
}
export function prepareTesterJob(root: string, configPath: string, value: unknown): TesterJob {
  const config = readTesterFacilityConfig(configPath);
  assertTesterSetupReady(configPath);
  const request = validateTesterTestRequest(value),
    dir = testerJobDirectory(root, request.test_id),
    file = path.join(dir, "job.json");
  if (request.deliverables !== undefined)
    verifyTesterDeliverables(root, request.run_id, request.artifact, request.deliverables);
  return withStateFileLock(file, () => {
    if (fs.existsSync(file)) {
      const job = readStateFile<TesterJob>(file);
      if (
        job.request_sha256 !== canonicalJsonSha256(request) ||
        job.config_sha256 !== testerFacilityConfigSha256(config)
      )
        failA1("TESTER_JOB_CONFLICT", "test_id already binds another request or configuration");
      return job;
    }
    const job: TesterJob = {
      schema_version: 1,
      request,
      request_sha256: canonicalJsonSha256(request),
      config,
      config_sha256: testerFacilityConfigSha256(config),
      config_path: path.resolve(configPath),
      status: "pending",
      pid: null,
      attempt: 0,
      error: null,
    };
    writeStateJsonAtomic(file, job);
    return job;
  });
}
export function readTesterJob(root: string, id: string): TesterJob {
  const file = path.join(testerJobDirectory(root, id), "job.json");
  return withStateFileLock(file, () => {
    const job = readStateFile<TesterJob>(file);
    if (job.status === "running" && job.pid !== null) {
      try {
        process.kill(job.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") {
          job.status = "failed";
          job.error = "worker interrupted; resume this test to retry";
          job.pid = null;
          writeStateJsonAtomic(file, job);
        }
      }
    }
    return job;
  });
}
export async function executeTesterJob(root: string, id: string): Promise<TesterTestResult> {
  const dir = testerJobDirectory(root, id),
    file = path.join(dir, "job.json");
  const job = withStateFileLock(file, () => {
    const j = readTesterJobUnlocked(file);
    if (j.status === "completed") return j;
    if (j.status === "running")
      failA1("TESTER_JOB_RUNNING", "query the running job instead of starting another worker");
    assertTesterSetupReady(j.config_path);
    if (testerFacilityConfigSha256(readTesterFacilityConfig(j.config_path)) !== j.config_sha256)
      failA1("TESTER_CONFIG_CHANGED", "setup changed; create a new test");
    j.status = "running";
    j.pid = process.pid;
    j.attempt++;
    j.error = null;
    writeStateJsonAtomic(file, j);
    return j;
  });
  if (job.status === "completed")
    return readStateFile<TesterTestResult>(path.join(dir, "test-result.json"));
  try {
    const setup = assertTesterSetupReady(job.config_path);
    const verifyInstalled = async () => {
      for (const [i, source] of job.config.evidence_files.entries()) {
        const remote = path.resolve(job.config.execution.cwd, source);
        const local =
          job.config.execution.kind === "local"
            ? remote
            : path.join(dir, "installed-evidence", `${i}-${path.basename(source)}`);
        await fetchRemote(job.config, remote, local);
        if (evidenceFile(local).sha256 !== setup.evidence[i]!.sha256)
          failA1("TESTER_CONFIG_CHANGED", `installed benchmark evidence changed: ${source}`);
      }
    };
    await verifyInstalled();
    if (job.request.deliverables !== undefined)
      verifyTesterDeliverables(
        root,
        job.request.run_id,
        job.request.artifact,
        job.request.deliverables,
      );
    if (
      job.config.execution.kind === "local" &&
      fs.existsSync(job.request.artifact.ref) &&
      fs.statSync(job.request.artifact.ref).isFile() &&
      evidenceFile(job.request.artifact.ref).sha256 !== job.request.artifact.sha256
    )
      failA1("TESTER_ARTIFACT_CHANGED", "tested artifact differs from the request");
    const remoteDir =
      job.config.execution.kind === "local"
        ? dir
        : path.join(job.config.execution.cwd, ".aris-tester-tests", id);
    const output = path.join(remoteDir, "benchmark-output.json");
    const localOutput = path.join(dir, "benchmark-output.json");
    fs.rmSync(localOutput, { force: true });
    if (job.config.execution.kind === "ssh")
      await execute(
        job.config,
        { argv: ["mkdir", "-p", remoteDir], timeout_ms: 60000 },
        {},
        path.join(dir, "test.log"),
      );
    if (job.config.execution.kind === "ssh")
      await execute(
        job.config,
        { argv: ["rm", "-f", output], timeout_ms: 60000 },
        {},
        path.join(dir, "test.log"),
      );
    const env = {
      ARIS_TEST_MODE: job.request.mode,
      ARIS_TEST_ID: id,
      ARIS_RUN_ID: job.request.run_id,
      ARIS_EXPERIMENT_ID: job.request.experiment_id,
      ARIS_ITERATION: String(job.request.iteration),
      ARIS_PROJECT_ID: job.config.project_id,
      ARIS_TEST_OUTPUT: output,
      ARIS_TEST_DIR: remoteDir,
      ARIS_ARTIFACT_REF: job.request.artifact.ref,
      ARIS_ARTIFACT_SHA256: job.request.artifact.sha256,
    };
    await execute(job.config, job.config.healthcheck, env, path.join(dir, "test.log"));
    await execute(
      job.config,
      job.request.mode === "full" ? job.config.test : job.config.smoke,
      env,
      path.join(dir, "test.log"),
    );
    await fetchRemote(job.config, output, localOutput);
    await verifyInstalled();
    const raw = readStateFile<Record<string, unknown>>(localOutput);
    if (raw.artifact_sha256 !== job.request.artifact.sha256)
      failA1("TESTER_RESULT_BINDING_MISMATCH", "runner must identify the tested artifact digest");
    if (!isRecord(raw.metrics) || !Array.isArray(raw.samples) || !Array.isArray(raw.evidence_files))
      failA1("INVALID_TESTER_RESULT", "runner must provide metrics, samples and evidence_files");
    const names = job.config.metrics.map((m) => m.name).sort();
    if (Object.keys(raw.metrics).sort().join() !== names.join())
      failA1("INVALID_TESTER_RESULT", "metric set differs from setup");
    for (const val of Object.values(raw.metrics))
      if (typeof val !== "number" || !Number.isFinite(val))
        failA1("INVALID_TESTER_RESULT", "metrics must be finite");
    const seen = new Set<string>();
    let failed = 0;
    for (const sample of raw.samples) {
      if (
        !isRecord(sample) ||
        typeof sample.id !== "string" ||
        !sample.id ||
        seen.has(sample.id) ||
        !["ok", "failed"].includes(String(sample.status))
      )
        failA1("INVALID_TESTER_RESULT", "samples must have unique ids and explicit status");
      seen.add(sample.id);
      if (sample.status === "failed") failed++;
    }
    const evidence = [
      evidenceFile(localOutput),
      evidenceFile(path.join(dir, "test.log")),
      ...assertTesterSetupReady(job.config_path).evidence,
    ];
    for (const [i, source] of strings(raw.evidence_files, "runner.evidence_files").entries()) {
      const remote = path.resolve(remoteDir, source),
        local =
          job.config.execution.kind === "local"
            ? remote
            : path.join(dir, "evidence", `${i}-${path.basename(source)}`);
      await fetchRemote(job.config, remote, local);
      evidence.push(evidenceFile(local));
    }
    if (job.request.deliverables !== undefined)
      verifyTesterDeliverables(
        root,
        job.request.run_id,
        job.request.artifact,
        job.request.deliverables,
      );
    const result: TesterTestResult = {
      schema_version: 1,
      test_id: id,
      request: job.request,
      request_sha256: job.request_sha256,
      config: job.config,
      config_sha256: job.config_sha256,
      status: "completed",
      metrics: raw.metrics as Record<string, number>,
      sample_count: raw.samples.length,
      failed_samples: failed,
      evidence,
      completed_at: new Date().toISOString(),
    };
    writeStateJsonAtomic(path.join(dir, "test-result.json"), result);
    job.status = "completed";
    job.pid = null;
    writeStateJsonAtomic(file, job);
    return result;
  } catch (e) {
    job.status = "failed";
    job.pid = null;
    job.error = String(e);
    writeStateJsonAtomic(file, job);
    throw e;
  }
}
function readTesterJobUnlocked(file: string): TesterJob {
  return readStateFile<TesterJob>(file);
}
export function checkTesterResult(resultPath: string): TesterTestResult {
  const result = readStateFile<TesterTestResult>(resultPath);
  const request = validateTesterTestRequest(result.request),
    config = validateTesterFacilityConfig(result.config);
  if (result.status !== "completed" || request.mode !== "full")
    failA1(
      "TESTER_FULL_RESULT_REQUIRED",
      "only completed full benchmark results can be audited for publication",
    );
  if (
    result.test_id !== request.test_id ||
    result.request_sha256 !== canonicalJsonSha256(request) ||
    result.config_sha256 !== testerFacilityConfigSha256(config)
  )
    failA1("TESTER_RESULT_BINDING_MISMATCH", "result does not match its request and setup");
  verifyEvidence(result.evidence);
  const raw = readStateFile<Record<string, unknown>>(result.evidence[0]!.path);
  if (raw.artifact_sha256 !== request.artifact.sha256)
    failA1("TESTER_RESULT_BINDING_MISMATCH", "raw results identify a different artifact");
  if (
    !isRecord(raw.metrics) ||
    !Array.isArray(raw.samples) ||
    raw.samples.length !== config.dataset.expected_samples ||
    result.sample_count !== raw.samples.length ||
    result.failed_samples !== 0
  )
    failA1(
      "TESTER_COVERAGE_INCOMPLETE",
      "full expected sample coverage with no unresolved failures is required",
    );
  if (
    canonicalJsonSha256(raw.metrics) !== canonicalJsonSha256(result.metrics) ||
    Object.keys(result.metrics).sort().join() !==
      config.metrics
        .map((m) => m.name)
        .sort()
        .join()
  )
    failA1("TESTER_METRIC_MISMATCH", "metrics differ from raw evidence or setup");
  const ids = new Set<string>();
  for (const sample of raw.samples) {
    if (
      !isRecord(sample) ||
      typeof sample.id !== "string" ||
      !sample.id ||
      ids.has(sample.id) ||
      sample.status !== "ok"
    )
      failA1("TESTER_COVERAGE_INCOMPLETE", "invalid, duplicated or failed sample");
    ids.add(sample.id);
  }
  for (const metric of config.metrics) {
    const value = result.metrics[metric.name];
    if (typeof value !== "number" || !Number.isFinite(value))
      failA1("TESTER_METRIC_MISMATCH", "non-finite metric");
    if (metric.aggregation === "external") continue; // The independent reviewer checks benchmark-specific aggregators.
    const scores = raw.samples.map((s: unknown) => {
      if (
        !isRecord(s) ||
        !isRecord(s.metrics) ||
        typeof s.metrics[metric.name] !== "number" ||
        !Number.isFinite(s.metrics[metric.name])
      )
        failA1("TESTER_SCORE_MISSING", metric.name);
      return s.metrics[metric.name] as number;
    });
    const sum = scores.reduce((a, b) => a + b, 0),
      expected = metric.aggregation === "mean" ? sum / scores.length : sum;
    if (Math.abs(expected - value) > 1e-9 * Math.max(1, Math.abs(expected)))
      failA1("TESTER_AGGREGATION_MISMATCH", metric.name);
  }
  return result;
}
export function auditTesterResult(resultPath: string, reviewPath: string): TesterAuditReceipt {
  const result = checkTesterResult(resultPath),
    review = readStateFile<TesterAuditReview>(reviewPath);
  if (
    review.schema_version !== 1 ||
    review.result_sha256 !== evidenceFile(resultPath).sha256 ||
    !["pass", "warn", "fail"].includes(review.status) ||
    !isRecord(review.checks)
  )
    failA1("TESTER_AUDIT_BINDING_MISMATCH", "review must identify the current result");
  requireString(review.reviewer_id, "reviewer_id");
  strings(review.findings, "findings");
  for (const key of ["protocol", "scoring", "coverage", "comparability"] as const)
    if (
      typeof review.checks[key] !== "boolean" ||
      (review.status === "pass" && !review.checks[key])
    )
      failA1("TESTER_AUDIT_INVALID", `unresolved ${key} check`);
  const content = {
    ...review,
    test_id: result.test_id,
    config_sha256: result.config_sha256,
    evidence: [evidenceFile(reviewPath)],
  };
  const auditPath = path.join(path.dirname(resultPath), "test-audit.json");
  return withStateFileLock(auditPath, () => {
    if (fs.existsSync(auditPath)) {
      const existing = readStateFile<TesterAuditReceipt>(auditPath);
      const { completed_at, ...recorded } = existing;
      if (canonicalJsonSha256(recorded) === canonicalJsonSha256(content)) {
        requireString(completed_at, "audit.completed_at");
        return existing;
      }
    }
    const audit: TesterAuditReceipt = { ...content, completed_at: new Date().toISOString() };
    writeStateJsonAtomic(auditPath, audit);
    return audit;
  });
}
export function readAuditedTesterResult(
  resultPath: string,
  auditPath: string,
  binding?: { run_id?: string; iteration?: number; experiment_id?: string; project_root?: string },
): { result: TesterTestResult; audit: TesterAuditReceipt } {
  const result = checkTesterResult(resultPath),
    audit = readStateFile<TesterAuditReceipt>(auditPath);
  if (
    audit.schema_version !== 1 ||
    audit.status !== "pass" ||
    audit.test_id !== result.test_id ||
    audit.config_sha256 !== result.config_sha256 ||
    audit.result_sha256 !== evidenceFile(resultPath).sha256
  )
    failA1(
      "TESTER_AUDIT_REQUIRED",
      "current passing tester audit is required before publishing metrics",
    );
  verifyEvidence(audit.evidence);
  const review = readStateFile<TesterAuditReview>(audit.evidence[0]!.path);
  if (
    review.status !== audit.status ||
    review.result_sha256 !== audit.result_sha256 ||
    review.reviewer_id !== audit.reviewer_id ||
    canonicalJsonSha256(review.checks) !== canonicalJsonSha256(audit.checks) ||
    canonicalJsonSha256(review.findings) !== canonicalJsonSha256(audit.findings)
  )
    failA1("TESTER_AUDIT_BINDING_MISMATCH", "audit differs from its review evidence");
  for (const key of ["protocol", "scoring", "coverage", "comparability"] as const)
    if (audit.checks[key] !== true) failA1("TESTER_AUDIT_REQUIRED", key);
  for (const key of ["run_id", "iteration", "experiment_id"] as const)
    if (binding?.[key] !== undefined && binding[key] !== result.request[key])
      failA1("TESTER_RESULT_BINDING_MISMATCH", key);
  if (binding?.project_root !== undefined && result.request.deliverables !== undefined)
    verifyTesterDeliverables(
      binding.project_root,
      result.request.run_id,
      result.request.artifact,
      result.request.deliverables,
    );
  return { result, audit };
}
