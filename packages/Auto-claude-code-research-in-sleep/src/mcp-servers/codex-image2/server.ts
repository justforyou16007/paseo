import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { McpStdio } from "../../lib/mcp-stdio.js";

const SERVER_NAME = process.env.CODEX_IMAGE2_SERVER_NAME || "codex-image2";
const CODEX_BIN = process.env.CODEX_IMAGE2_CODEX_BIN || "codex";
const DEFAULT_TIMEOUT_SEC = parseInt(process.env.CODEX_IMAGE2_TIMEOUT_SEC || "600", 10);
const DEFAULT_JOB_EXPIRY_GRACE_SEC = parseInt(
  process.env.CODEX_IMAGE2_JOB_EXPIRY_GRACE_SEC || "60",
  10,
);
const MAX_STATUS_WAIT_SEC = parseInt(process.env.CODEX_IMAGE2_MAX_STATUS_WAIT_SEC || "30", 10);
const DEFAULT_MODEL = process.env.CODEX_IMAGE2_MODEL || "";
const DEBUG_LOG_RAW = (process.env.CODEX_IMAGE2_DEBUG_LOG || "").trim();
const DEBUG_LOG = DEBUG_LOG_RAW || null;
const SAVE_RUN_LOGS = ["1", "true", "yes", "on"].includes(
  (process.env.CODEX_IMAGE2_SAVE_RUN_LOGS || "").trim().toLowerCase(),
);
const STATE_DIR =
  process.env.CODEX_IMAGE2_STATE_DIR || path.join(os.homedir(), ".claude", "state", SERVER_NAME);
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const RUNS_DIR = path.join(STATE_DIR, "runs");

const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function debugLog(message: string): void {
  if (!DEBUG_LOG) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${message}\n`, "utf-8");
  } catch {
    // ignore
  }
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseUtcTimestamp(rawValue: unknown): Date | null {
  if (typeof rawValue !== "string" || !rawValue) return null;
  try {
    const d = new Date(rawValue);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function utcAfterSeconds(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeJson(filePath: string, payload: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function jobStatePath(jobId: string): string {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findCodexBin(): string | null {
  if (fs.existsSync(CODEX_BIN)) return CODEX_BIN;
  try {
    const result = execFileSync("which", [CODEX_BIN], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function normalizeStringList(rawValue: unknown): { values: string[]; error: string | null } {
  if (rawValue === null || rawValue === undefined) {
    return { values: [], error: null };
  }
  if (typeof rawValue === "string") {
    const candidate = rawValue.trim();
    return { values: candidate ? [candidate] : [], error: null };
  }
  if (!Array.isArray(rawValue)) {
    return {
      values: [],
      error: "referenceImagePaths must be a string or an array of strings",
    };
  }
  const values: string[] = [];
  for (const item of rawValue) {
    if (typeof item !== "string") {
      return { values: [], error: "referenceImagePaths entries must be strings" };
    }
    const candidate = item.trim();
    if (candidate) values.push(candidate);
  }
  return { values, error: null };
}

function resolveCwd(rawCwd: string | null | undefined): { cwd: string; error: string | null } {
  let cwd: string;
  if (rawCwd) {
    cwd = rawCwd.startsWith("~") ? path.join(os.homedir(), rawCwd.slice(1)) : rawCwd;
  } else {
    cwd = process.cwd();
  }
  try {
    cwd = fs.realpathSync(cwd);
  } catch (exc) {
    return { cwd, error: `failed to resolve cwd ${JSON.stringify(rawCwd)}: ${exc}` };
  }
  try {
    const st = fs.statSync(cwd);
    if (!st.isDirectory()) {
      return { cwd, error: `working directory is not a directory: ${cwd}` };
    }
  } catch {
    return { cwd, error: `working directory does not exist: ${cwd}` };
  }
  return { cwd, error: null };
}

function resolveOutputPath(
  rawOutputPath: string | null | undefined,
  cwd: string,
  jobId: string,
): string {
  if (rawOutputPath) {
    let p = rawOutputPath.startsWith("~")
      ? path.join(os.homedir(), rawOutputPath.slice(1))
      : rawOutputPath;
    if (!path.isAbsolute(p)) {
      p = path.join(cwd, p);
    }
    return path.resolve(p);
  }
  return path.resolve(path.join(cwd, "figures", "ai_generated", `codex-image2-${jobId}.png`));
}

function allowedOutputRoot(cwd: string): string {
  return path.resolve(path.join(cwd, "figures", "ai_generated"));
}

function validateOutputPath(outputPath: string, cwd: string): string | null {
  const root = allowedOutputRoot(cwd);
  const rel = path.relative(root, outputPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return `outputPath must stay under ${root}`;
  }
  if (outputPath === root) {
    return `outputPath must be a file under ${root}, not the directory itself`;
  }
  return null;
}

function parseTimeoutSeconds(rawValue: unknown): { timeout: number | null; error: string | null } {
  if (rawValue === null || rawValue === undefined) {
    return { timeout: DEFAULT_TIMEOUT_SEC, error: null };
  }
  const timeout = typeof rawValue === "number" ? rawValue : parseInt(String(rawValue), 10);
  if (isNaN(timeout)) {
    return { timeout: null, error: "timeoutSeconds must be an integer" };
  }
  if (timeout <= 0) {
    return { timeout: null, error: "timeoutSeconds must be positive" };
  }
  return { timeout, error: null };
}

function isPngBytes(buf: Buffer): boolean {
  return (
    buf.length >= PNG_SIGNATURE.length &&
    buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function maybeRunLogPath(runId: string): string | null {
  if (!SAVE_RUN_LOGS) return null;
  return path.join(RUNS_DIR, `${runId}.log`);
}

function scrubJobRequest(job: Record<string, unknown>): void {
  const request = job.request;
  if (typeof request !== "object" || request === null) return;
  const req = request as Record<string, unknown>;
  job.request = {
    cwd: req.cwd,
    outputPath: req.outputPath,
    timeoutSec: req.timeoutSec,
  };
}

function failJob(
  jobPath: string,
  job: Record<string, unknown>,
  message: string,
): Record<string, unknown> {
  const finishedAt = utcNow();
  job.status = "failed";
  job.error = message;
  job.completedAt = finishedAt;
  job.updatedAt = finishedAt;
  job.result = null;
  scrubJobRequest(job);
  writeJson(jobPath, job);
  return job;
}

function buildBridgePrompt(
  prompt: string,
  system: string | null | undefined,
  referenceImagePaths: string[],
): string {
  const sections: string[] = [
    "You are operating behind a Codex native image-generation MCP bridge.",
    "Use native image generation through the Codex app-server.",
    "Do not use shell commands, Python, SVG, HTML, Canvas, or manual bitmap encoding.",
    "Do not fabricate success. If native image generation is unavailable, reply exactly NATIVE_IMAGE_UNAVAILABLE.",
    "Generate exactly one publication-quality raster image unless the user explicitly requests multiple variants.",
    "",
  ];
  const selectedSystem = (system || "").trim();
  if (selectedSystem) {
    sections.push("## System Instructions", selectedSystem, "");
  }
  if (referenceImagePaths.length > 0) {
    sections.push("## Reference Images");
    sections.push(
      "These local image files are available. If image viewing tools are available in this Codex session, inspect them before generating.",
    );
    for (const p of referenceImagePaths) {
      sections.push(`- ${p}`);
    }
    sections.push("");
  }
  sections.push("## User Request", prompt.trim());
  return sections.join("\n").trim();
}

interface DebugJsonMessage {
  [key: string]: unknown;
}

function parseDebugJsonMessages(rawStdout: string): DebugJsonMessage[] {
  const messages: DebugJsonMessage[] = [];
  let buffer: string[] = [];
  let collecting = false;

  for (const rawLine of rawStdout.split("\n")) {
    if (!collecting) {
      if (rawLine.startsWith("< {")) {
        collecting = true;
        buffer = [rawLine.slice(2)];
      }
      continue;
    }
    if (!rawLine.startsWith("< ")) {
      collecting = false;
      buffer = [];
      continue;
    }
    buffer.push(rawLine.slice(2));
    const candidate = buffer.join("\n");
    try {
      const payload = JSON.parse(candidate);
      messages.push(payload as DebugJsonMessage);
      collecting = false;
      buffer = [];
    } catch {
      // incomplete JSON, keep collecting
    }
  }
  return messages;
}

interface RunSummary {
  threadId: string | null;
  agentMessages: string[];
  imageItems: Record<string, unknown>[];
  commandItems: Record<string, unknown>[];
}

function extractRunSummary(messages: DebugJsonMessage[]): RunSummary {
  let threadId: string | null = null;
  const agentMessages: string[] = [];
  const imageItems: Record<string, unknown>[] = [];
  const commandItems: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const params = message.params;
    if (typeof params === "object" && params !== null) {
      const p = params as Record<string, unknown>;
      const candidateThreadId = p.threadId;
      if (typeof candidateThreadId === "string" && candidateThreadId) {
        threadId = candidateThreadId;
      }
      const item = p.item;
      if (typeof item === "object" && item !== null) {
        const it = item as Record<string, unknown>;
        const itemType = it.type;
        if (itemType === "agentMessage") {
          const text = it.text;
          if (typeof text === "string") {
            agentMessages.push(text);
          }
        } else if (itemType === "imageGeneration") {
          imageItems.push(it);
        } else if (itemType === "commandExecution") {
          commandItems.push(it);
        }
      }
    }
    const result = message.result;
    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      const thread = r.thread;
      if (typeof thread === "object" && thread !== null) {
        const t = thread as Record<string, unknown>;
        const candidateThreadId = t.id;
        if (typeof candidateThreadId === "string" && candidateThreadId) {
          threadId = candidateThreadId;
        }
      }
    }
  }

  return { threadId, agentMessages, imageItems, commandItems };
}

interface MaterializeResult {
  outputPath: string | null;
  sourceSavedPath: string | null;
  revisedPrompt: string | null;
  error: string | null;
}

function materializeGeneratedImage(
  imageItem: Record<string, unknown>,
  outputPath: string,
): MaterializeResult {
  const savedPathValue = imageItem.savedPath;
  const revisedPrompt = imageItem.revisedPrompt;
  const revisedPromptText = typeof revisedPrompt === "string" ? revisedPrompt : null;

  if (typeof savedPathValue === "string" && savedPathValue) {
    const sourcePath = savedPathValue.startsWith("~")
      ? path.join(os.homedir(), savedPathValue.slice(1))
      : savedPathValue;
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
      const sourceBytes = fs.readFileSync(sourcePath);
      if (!isPngBytes(sourceBytes)) {
        return {
          outputPath: null,
          sourceSavedPath: null,
          revisedPrompt: null,
          error: "imageGeneration savedPath did not contain a PNG image",
        };
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(sourcePath, outputPath);
      return {
        outputPath,
        sourceSavedPath: sourcePath,
        revisedPrompt: revisedPromptText,
        error: null,
      };
    }
  }

  const rawResult = imageItem.result;
  if (typeof rawResult === "string" && rawResult.trim()) {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(rawResult, "base64");
    } catch (exc) {
      return {
        outputPath: null,
        sourceSavedPath: null,
        revisedPrompt: null,
        error: `imageGeneration result was not valid base64: ${exc}`,
      };
    }
    if (!isPngBytes(decoded)) {
      return {
        outputPath: null,
        sourceSavedPath: null,
        revisedPrompt: null,
        error: "imageGeneration result did not decode to a PNG image",
      };
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, decoded);
    return {
      outputPath,
      sourceSavedPath: null,
      revisedPrompt: revisedPromptText,
      error: null,
    };
  }

  return {
    outputPath: null,
    sourceSavedPath: null,
    revisedPrompt: null,
    error: "imageGeneration item did not contain a savedPath or decodable result",
  };
}

interface ImageResult {
  threadId: string | null;
  response: string;
  model: string | null;
  duration_ms: number;
  nativeToolConfirmed: boolean;
  imageCount: number;
  outputPath: string;
  sourceSavedPath: string | null;
  revisedPrompt: string | null;
  runLogPath: string | null;
}

function runCodexImage(
  prompt: string,
  opts: {
    cwd: string;
    outputPath: string;
    system?: string | null;
    model?: string | null;
    referenceImagePaths?: string[];
    timeoutSec?: number | null;
    runLogPath?: string | null;
  },
): { result: ImageResult | null; error: string | null } {
  const binPath = findCodexBin();
  if (!binPath) {
    return { result: null, error: `Codex CLI not found: ${CODEX_BIN}` };
  }

  const resolvedOutputPath = path.resolve(opts.outputPath);
  const outputPathError = validateOutputPath(resolvedOutputPath, opts.cwd);
  if (outputPathError) {
    return { result: null, error: outputPathError };
  }

  const normalizedRefs = opts.referenceImagePaths || [];
  const promptText = buildBridgePrompt(prompt, opts.system, normalizedRefs);
  const cmd = [binPath];
  const selectedModel = opts.model || DEFAULT_MODEL;
  if (selectedModel) {
    cmd.push("-c", `model="${selectedModel}"`);
  }
  cmd.push("debug", "app-server", "send-message-v2", promptText);

  const effectiveTimeout = opts.timeoutSec || DEFAULT_TIMEOUT_SEC;
  debugLog(`RUN ${cmd.join(" ")} cwd=${opts.cwd}`);

  let stdout: string;
  let stderr: string;
  let durationMs: number;
  try {
    const started = Date.now();
    const result = execFileSync(cmd[0], cmd.slice(1), {
      encoding: "utf-8",
      timeout: effectiveTimeout * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      input: "",
    });
    durationMs = Date.now() - started;
    stdout = result;
    stderr = "";
  } catch (err: unknown) {
    if (err && typeof err === "object" && "killed" in err && (err as { killed: boolean }).killed) {
      return {
        result: null,
        error: `Codex image generation timed out after ${effectiveTimeout} seconds`,
      };
    }
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = execErr.stdout || "";
    stderr = execErr.stderr || "";
    durationMs = 0;
  }

  if (opts.runLogPath) {
    fs.mkdirSync(path.dirname(opts.runLogPath), { recursive: true });
    const logContent = stdout + (stderr ? "\n[stderr]\n" + stderr : "");
    fs.writeFileSync(opts.runLogPath, logContent, "utf-8");
  }

  const messages = parseDebugJsonMessages(stdout);
  const summary = extractRunSummary(messages);

  if (summary.commandItems.length > 0) {
    return {
      result: null,
      error:
        "Codex attempted shell-based image creation instead of native image generation. " +
        "This bridge only accepts native imageGeneration events.",
    };
  }

  if (summary.imageItems.length === 0) {
    let finalMessage = "";
    for (let i = summary.agentMessages.length - 1; i >= 0; i--) {
      const candidate = summary.agentMessages[i];
      if (candidate && candidate.trim()) {
        finalMessage = candidate.trim();
        break;
      }
    }
    const stderrText = stderr.trim();
    if (finalMessage === "NATIVE_IMAGE_UNAVAILABLE") {
      return {
        result: null,
        error:
          "Codex app-server reported that native image generation is unavailable in this session.",
      };
    }
    if (finalMessage) {
      return {
        result: null,
        error: `Codex did not emit an imageGeneration item. Final message: ${finalMessage}`,
      };
    }
    if (stderrText) {
      return {
        result: null,
        error: `Codex did not emit an imageGeneration item. stderr: ${stderrText}`,
      };
    }
    return {
      result: null,
      error: "Codex did not emit an imageGeneration item.",
    };
  }

  const imageItem = summary.imageItems[summary.imageItems.length - 1];
  const materialized = materializeGeneratedImage(imageItem, resolvedOutputPath);
  if (materialized.error) {
    return { result: null, error: materialized.error };
  }
  if (!materialized.outputPath) {
    return {
      result: null,
      error: "Codex image bridge failed to materialize the generated image",
    };
  }

  let responseText = "";
  for (let i = summary.agentMessages.length - 1; i >= 0; i--) {
    const candidate = summary.agentMessages[i];
    if (candidate !== null && candidate !== undefined) {
      responseText = candidate;
      break;
    }
  }

  return {
    result: {
      threadId: summary.threadId,
      response: responseText,
      model: selectedModel || null,
      duration_ms: durationMs,
      nativeToolConfirmed: true,
      imageCount: summary.imageItems.length,
      outputPath: materialized.outputPath,
      sourceSavedPath: materialized.sourceSavedPath,
      revisedPrompt: materialized.revisedPrompt,
      runLogPath: opts.runLogPath || null,
    },
    error: null,
  };
}

function serializeJob(job: Record<string, unknown>): Record<string, unknown> {
  const result = (job.result as Record<string, unknown>) || {};
  return {
    jobId: job.jobId,
    status: job.status,
    done: TERMINAL_JOB_STATES.has(job.status as string),
    threadId: result.threadId ?? null,
    response: result.response ?? null,
    model: result.model ?? null,
    duration_ms: result.duration_ms ?? null,
    nativeToolConfirmed: result.nativeToolConfirmed ?? null,
    imageCount: result.imageCount ?? null,
    outputPath: result.outputPath ?? null,
    sourceSavedPath: result.sourceSavedPath ?? null,
    revisedPrompt: result.revisedPrompt ?? null,
    runLogPath: result.runLogPath ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    updatedAt: job.updatedAt ?? null,
    expiresAt: job.expiresAt ?? null,
    resumeHint: "Call generate_status with this jobId until done=true.",
  };
}

function startAsyncGenerate(
  prompt: string,
  opts: {
    cwd?: string | null;
    outputPath?: string | null;
    system?: string | null;
    model?: string | null;
    referenceImagePaths?: unknown;
    timeoutSeconds?: unknown;
  },
): { result: Record<string, unknown> | null; error: string | null } {
  const { cwd: resolvedCwd, error: cwdError } = resolveCwd(opts.cwd as string | null);
  if (cwdError) return { result: null, error: cwdError };

  const { values: refs, error: refsError } = normalizeStringList(opts.referenceImagePaths);
  if (refsError) return { result: null, error: refsError };

  const { timeout: timeoutSec, error: timeoutError } = parseTimeoutSeconds(opts.timeoutSeconds);
  if (timeoutError) return { result: null, error: timeoutError };

  const jobId = crypto.randomUUID().replace(/-/g, "");
  const resolvedOutputPath = resolveOutputPath(
    opts.outputPath as string | null,
    resolvedCwd,
    jobId,
  );
  const outputPathError = validateOutputPath(resolvedOutputPath, resolvedCwd);
  if (outputPathError) return { result: null, error: outputPathError };

  const createdAt = utcNow();
  const job: Record<string, unknown> = {
    jobId,
    status: "queued",
    createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: createdAt,
    expiresAt: utcAfterSeconds((timeoutSec || DEFAULT_TIMEOUT_SEC) + DEFAULT_JOB_EXPIRY_GRACE_SEC),
    error: null,
    result: null,
    workerPid: null,
    request: {
      prompt,
      cwd: resolvedCwd,
      outputPath: resolvedOutputPath,
      system: opts.system || null,
      model: opts.model || null,
      referenceImagePaths: refs,
      timeoutSec: timeoutSec,
    },
  };

  const jobPath = jobStatePath(jobId);
  writeJson(jobPath, job);

  try {
    const worker = spawn(
      process.execPath,
      [path.resolve(new URL(import.meta.url).pathname), "--run-job", jobId],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    worker.unref();
    job.workerPid = worker.pid ?? null;
    job.updatedAt = utcNow();
    writeJson(jobPath, job);
    debugLog(`JOB_START job_id=${jobId} worker_pid=${worker.pid}`);
    return { result: serializeJob(job), error: null };
  } catch (err) {
    job.status = "failed";
    job.completedAt = utcNow();
    job.updatedAt = job.completedAt;
    job.error = `Failed to launch background image worker: ${err}`;
    writeJson(jobPath, job);
    return { result: null, error: job.error as string };
  }
}

function getGenerateStatus(
  jobId: string,
  waitSeconds = 0,
): { result: Record<string, unknown> | null; error: string | null } {
  const jobPath = jobStatePath(jobId);
  if (!fs.existsSync(jobPath)) {
    return { result: null, error: `Unknown jobId: ${jobId}` };
  }

  const deadline = Date.now() + Math.max(waitSeconds, 0) * 1000;
  for (;;) {
    let job = readJson(jobPath);
    if (job.status === "queued" || job.status === "running") {
      const expiresAt = parseUtcTimestamp(job.expiresAt);
      if (expiresAt !== null && Date.now() > expiresAt.getTime()) {
        job = failJob(
          jobPath,
          job,
          "Background image worker exceeded its deadline before writing a final result",
        );
      } else if (!isPidAlive(job.workerPid as number | null)) {
        job = failJob(jobPath, job, "Background image worker exited before writing a final result");
      }
    }
    if (TERMINAL_JOB_STATES.has(job.status as string)) {
      return { result: serializeJob(job), error: null };
    }
    if (Date.now() >= deadline) {
      return { result: serializeJob(job), error: null };
    }
    const sleepMs = Math.min(500, Math.max(deadline - Date.now(), 0));
    if (sleepMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
}

function runAsyncJob(jobId: string): number {
  const jobPath = jobStatePath(jobId);
  if (!fs.existsSync(jobPath)) {
    debugLog(`JOB_MISSING job_id=${jobId}`);
    return 1;
  }

  let job = readJson(jobPath);
  job.status = "running";
  job.startedAt = utcNow();
  job.updatedAt = job.startedAt;
  job.workerPid = process.pid;
  writeJson(jobPath, job);
  debugLog(`JOB_RUNNING job_id=${jobId} worker_pid=${process.pid}`);

  const request = (job.request as Record<string, unknown>) || {};
  const runLogPath = maybeRunLogPath(jobId);
  let payload: ImageResult | null = null;
  let error: string | null = null;
  try {
    const imageResult = runCodexImage(String(request.prompt || ""), {
      cwd: String(request.cwd || ""),
      outputPath: String(request.outputPath || ""),
      system: request.system as string | null,
      model: request.model as string | null,
      referenceImagePaths: (request.referenceImagePaths as string[]) || [],
      timeoutSec: request.timeoutSec as number | null,
      runLogPath,
    });
    payload = imageResult.result;
    error = imageResult.error;
  } catch (err) {
    error = `Background image generation crashed: ${err}`;
    debugLog(error);
  }

  const finishedAt = utcNow();
  job = readJson(jobPath);
  job.updatedAt = finishedAt;
  job.completedAt = finishedAt;
  if (error) {
    failJob(jobPath, job, error);
    debugLog(`JOB_FAILED job_id=${jobId} error=${error}`);
    return 1;
  }

  job.status = "completed";
  job.error = null;
  job.result = payload;
  scrubJobRequest(job);
  writeJson(jobPath, job);
  debugLog(`JOB_COMPLETED job_id=${jobId} output=${(payload as ImageResult | null)?.outputPath}`);
  return 0;
}

// --run-job mode: background worker
if (process.argv[2] === "--run-job" && process.argv[3]) {
  process.exit(runAsyncJob(process.argv[3]));
}

const TOOLS = [
  {
    name: "generate_start",
    description: "Start a background native image generation job through the Codex app-server.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Image generation prompt",
        },
        cwd: {
          type: "string",
          description: "Optional working directory",
        },
        outputPath: {
          type: "string",
          description: "Optional output file path; defaults to figures/ai_generated",
        },
        system: {
          type: "string",
          description: "Optional extra bridge instructions",
        },
        model: {
          type: "string",
          description: "Optional Codex text model override",
        },
        referenceImagePaths: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description:
            "Optional local reference image paths that Codex may inspect before generating",
        },
        timeoutSeconds: {
          type: "integer",
          description: "Optional positive timeout for the underlying Codex image call",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_status",
    description:
      "Check whether a background image generation job has finished and fetch the output path when available.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Background image job id",
        },
        job_id: {
          type: "string",
          description: "Alias of jobId",
        },
        waitSeconds: {
          type: "integer",
          description:
            "Optional bounded wait before returning status; capped to keep the MCP server responsive",
        },
      },
      required: ["jobId"],
    },
  },
];

const server = new McpStdio(SERVER_NAME, "0.1.0");

server.onRequest("tools/list", () => ({ tools: TOOLS }));

server.onRequest("tools/call", (params) => {
  const name = (params.name as string) || "";
  const args = (params.arguments as Record<string, unknown>) || {};

  if (name === "generate_start") {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return McpStdio.toolError("prompt is required");
    const { result: payload, error } = startAsyncGenerate(prompt, {
      cwd: args.cwd as string | null,
      outputPath: args.outputPath as string | null,
      system: args.system as string | null,
      model: args.model as string | null,
      referenceImagePaths: args.referenceImagePaths,
      timeoutSeconds: args.timeoutSeconds,
    });
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  if (name === "generate_status") {
    const jobId = (args.jobId || args.job_id) as string | undefined;
    if (!jobId) return McpStdio.toolError("jobId or job_id is required");
    let waitSeconds: number;
    const rawWait = args.waitSeconds;
    try {
      waitSeconds = typeof rawWait === "number" ? rawWait : parseInt(String(rawWait || "0"), 10);
      if (isNaN(waitSeconds)) throw new Error();
    } catch {
      return McpStdio.toolError("waitSeconds must be an integer");
    }
    waitSeconds = Math.min(Math.max(waitSeconds, 0), MAX_STATUS_WAIT_SEC);
    const { result: payload, error } = getGenerateStatus(String(jobId), waitSeconds);
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  throw new Error(`Unknown tool: ${name}`);
});

debugLog(`=== ${SERVER_NAME} starting ===`);
server.run();
