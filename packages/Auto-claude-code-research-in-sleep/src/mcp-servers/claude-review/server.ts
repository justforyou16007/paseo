import { execFileSync, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { McpStdio } from "../../lib/mcp-stdio.js";

const SERVER_NAME = process.env.CLAUDE_REVIEW_SERVER_NAME || "claude-review";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_MODEL = process.env.CLAUDE_REVIEW_MODEL || "";
const DEFAULT_SYSTEM = process.env.CLAUDE_REVIEW_SYSTEM || "";
const DEFAULT_TOOLS = process.env.CLAUDE_REVIEW_TOOLS || "";
const DEFAULT_TIMEOUT_SEC = parseInt(process.env.CLAUDE_REVIEW_TIMEOUT_SEC || "600", 10);
const defaultDebugDir = os.tmpdir();
const DEBUG_LOG =
  process.env.CLAUDE_REVIEW_DEBUG_LOG || path.join(defaultDebugDir, `${SERVER_NAME}-mcp-debug.log`);
const STATE_DIR =
  process.env.CLAUDE_REVIEW_STATE_DIR || path.join(os.homedir(), ".codex", "state", SERVER_NAME);
const JOBS_DIR = path.join(STATE_DIR, "jobs");

const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);

function debugLog(message: string): void {
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

function findClaudeBin(): string | null {
  if (fs.existsSync(CLAUDE_BIN)) return CLAUDE_BIN;
  try {
    const result = execFileSync("which", [CLAUDE_BIN], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function parseClaudeJson(rawStdout: string): {
  payload: Record<string, unknown> | null;
  error: string | null;
} {
  const stripped = rawStdout.trim();
  if (!stripped) return { payload: null, error: "Claude CLI returned empty output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = null;
  }

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { payload: parsed as Record<string, unknown>, error: null };
  }
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      const item = parsed[i];
      if (
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "result"
      ) {
        return { payload: item as Record<string, unknown>, error: null };
      }
    }
    return {
      payload: null,
      error: "Claude CLI returned a JSON array without a 'result' event",
    };
  }

  let sawArrayWithoutResult = false;
  const lines = stripped.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i].trim();
    if (!candidate) continue;
    let linePayload: unknown;
    try {
      linePayload = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof linePayload === "object" && linePayload !== null && !Array.isArray(linePayload)) {
      if (sawArrayWithoutResult && (linePayload as Record<string, unknown>).type !== "result") {
        continue;
      }
      return { payload: linePayload as Record<string, unknown>, error: null };
    }
    if (Array.isArray(linePayload)) {
      for (let j = linePayload.length - 1; j >= 0; j--) {
        const item = linePayload[j];
        if (
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "result"
        ) {
          return { payload: item as Record<string, unknown>, error: null };
        }
      }
      sawArrayWithoutResult = true;
    }
  }

  if (sawArrayWithoutResult) {
    return {
      payload: null,
      error: "Claude CLI returned a JSON array without a 'result' event",
    };
  }
  return { payload: null, error: "Claude CLI did not return JSON output" };
}

interface ReviewResult {
  threadId: string | null;
  response: string;
  model: string;
  duration_ms: number | null;
  stop_reason: string | null;
}

function buildCommand(
  prompt: string,
  opts: {
    sessionId?: string | null;
    model?: string | null;
    system?: string | null;
    tools?: string | null;
  } = {},
): string[] {
  const binPath = findClaudeBin();
  if (!binPath) throw new Error(`Claude CLI not found: ${CLAUDE_BIN}`);

  const cmd = [binPath, "-p", prompt, "--output-format", "json", "--permission-mode", "plan"];

  if (opts.sessionId) cmd.push("--resume", opts.sessionId);

  const selectedModel = opts.model || DEFAULT_MODEL;
  if (selectedModel) cmd.push("--model", selectedModel);

  const selectedSystem = opts.system || DEFAULT_SYSTEM;
  if (selectedSystem) cmd.push("--system-prompt", selectedSystem);

  const selectedTools = opts.tools === undefined ? DEFAULT_TOOLS : (opts.tools ?? "");
  cmd.push("--tools", selectedTools);

  return cmd;
}

function runClaudeReview(
  prompt: string,
  opts: {
    sessionId?: string | null;
    model?: string | null;
    system?: string | null;
    tools?: string | null;
  } = {},
): { result: ReviewResult | null; error: string | null } {
  let cmd: string[];
  try {
    cmd = buildCommand(prompt, opts);
  } catch (err) {
    return { result: null, error: err instanceof Error ? err.message : String(err) };
  }

  debugLog(`RUN ${cmd.join(" ")}`);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    const result = execFileSync(cmd[0], cmd.slice(1), {
      encoding: "utf-8",
      timeout: DEFAULT_TIMEOUT_SEC * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      input: "",
    });
    stdout = result;
    stderr = "";
    exitCode = 0;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "killed" in err && (err as { killed: boolean }).killed) {
      return {
        result: null,
        error: `Claude review timed out after ${DEFAULT_TIMEOUT_SEC} seconds`,
      };
    }
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = execErr.stdout || "";
    stderr = execErr.stderr || "";
    exitCode = execErr.status || 1;
  }

  const { payload, error: parseError } = parseClaudeJson(stdout);
  if (parseError) {
    const stderrTrimmed = stderr.trim();
    const message = !stderrTrimmed ? parseError : `${parseError}. stderr: ${stderrTrimmed}`;
    return { result: null, error: message };
  }

  if (!payload) return { result: null, error: "Failed to parse Claude CLI output" };

  if (exitCode !== 0 || payload.is_error) {
    const errorsList = payload.errors;
    let errorsText = "";
    if (Array.isArray(errorsList) && errorsList.length > 0) {
      errorsText = errorsList.map(String).join("; ");
    } else if (typeof errorsList === "string") {
      errorsText = errorsList;
    }
    const message = String(
      payload.result || payload.error || errorsText || stderr.trim() || "Claude review failed",
    );
    return { result: null, error: message };
  }

  const threadId = (payload.session_id as string) || null;
  const responseText = String(payload.result || "").trim();
  const modelName = String(payload.model || "") || opts.model || DEFAULT_MODEL;

  return {
    result: {
      threadId,
      response: responseText,
      model: modelName,
      duration_ms: (payload.duration_ms as number) || null,
      stop_reason: (payload.stop_reason as string) || null,
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
    stop_reason: result.stop_reason ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    updatedAt: job.updatedAt ?? null,
    resumeHint: "Call review_status with this jobId until done=true.",
  };
}

function startAsyncReview(
  prompt: string,
  opts: {
    sessionId?: string | null;
    model?: string | null;
    system?: string | null;
    tools?: string | null;
  } = {},
): { result: Record<string, unknown> | null; error: string | null } {
  const jobId = crypto.randomUUID().replace(/-/g, "");
  const createdAt = utcNow();
  const job: Record<string, unknown> = {
    jobId,
    status: "queued",
    createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: createdAt,
    error: null,
    result: null,
    workerPid: null,
    request: {
      prompt,
      threadId: opts.sessionId || null,
      model: opts.model || null,
      system: opts.system || null,
      tools: opts.tools ?? null,
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
    job.error = `Failed to launch background review worker: ${err}`;
    writeJson(jobPath, job);
    return { result: null, error: job.error as string };
  }
}

function getReviewStatus(
  jobId: string,
  waitSeconds = 0,
): { result: Record<string, unknown> | null; error: string | null } {
  const jobPath = jobStatePath(jobId);
  if (!fs.existsSync(jobPath)) {
    return { result: null, error: `Unknown jobId: ${jobId}` };
  }

  const deadline = Date.now() + Math.max(waitSeconds, 0) * 1000;
  for (;;) {
    const job = readJson(jobPath);
    if (
      (job.status === "queued" || job.status === "running") &&
      !isPidAlive(job.workerPid as number | null)
    ) {
      job.status = "failed";
      job.error = "Background review worker exited before writing a final result";
      job.completedAt = utcNow();
      job.updatedAt = job.completedAt;
      writeJson(jobPath, job);
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
  let payload: ReviewResult | null = null;
  let error: string | null = null;
  try {
    const reviewResult = runClaudeReview(String(request.prompt || ""), {
      sessionId: request.threadId as string | null,
      model: request.model as string | null,
      system: request.system as string | null,
      tools: request.tools as string | null,
    });
    payload = reviewResult.result;
    error = reviewResult.error;
  } catch (err) {
    error = `Background review crashed: ${err}`;
    debugLog(error);
  }

  const finishedAt = utcNow();
  job = readJson(jobPath);
  job.updatedAt = finishedAt;
  job.completedAt = finishedAt;
  if (error) {
    job.status = "failed";
    job.error = error;
    job.result = null;
    debugLog(`JOB_FAILED job_id=${jobId} error=${error}`);
    writeJson(jobPath, job);
    return 1;
  }

  job.status = "completed";
  job.error = null;
  job.result = payload;
  debugLog(`JOB_COMPLETED job_id=${jobId} thread_id=${payload?.threadId}`);
  writeJson(jobPath, job);
  return 0;
}

// --run-job mode: background worker
if (process.argv[2] === "--run-job" && process.argv[3]) {
  process.exit(runAsyncJob(process.argv[3]));
}

const TOOLS = [
  {
    name: "review",
    description: "Run a fresh Claude Code review and return JSON containing threadId and response.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Reviewer prompt" },
        system: { type: "string", description: "Optional system prompt" },
        model: { type: "string", description: "Optional Claude model override" },
        tools: {
          type: "string",
          description: "Optional Claude tools override, empty string disables tools",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "review_reply",
    description: "Continue a previous Claude Code review session using threadId/session_id.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Claude session id from a previous review call",
        },
        thread_id: { type: "string", description: "Alias of threadId" },
        prompt: { type: "string", description: "Follow-up reviewer prompt" },
        system: { type: "string", description: "Optional system prompt override" },
        model: { type: "string", description: "Optional Claude model override" },
        tools: {
          type: "string",
          description: "Optional Claude tools override, empty string disables tools",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "review_start",
    description:
      "Start a background Claude Code review job and return a resumable jobId immediately.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Reviewer prompt" },
        system: { type: "string", description: "Optional system prompt" },
        model: { type: "string", description: "Optional Claude model override" },
        tools: {
          type: "string",
          description: "Optional Claude tools override, empty string disables tools",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "review_reply_start",
    description:
      "Start a background follow-up review job in an existing Claude thread and return a resumable jobId immediately.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Claude session id from a previous review call",
        },
        thread_id: { type: "string", description: "Alias of threadId" },
        prompt: { type: "string", description: "Follow-up reviewer prompt" },
        system: { type: "string", description: "Optional system prompt override" },
        model: { type: "string", description: "Optional Claude model override" },
        tools: {
          type: "string",
          description: "Optional Claude tools override, empty string disables tools",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "review_status",
    description:
      "Check whether a background review job has finished and fetch the final result when available.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Background review job id" },
        job_id: { type: "string", description: "Alias of jobId" },
        waitSeconds: {
          type: "integer",
          description: "Optional bounded wait before returning status",
        },
      },
      required: ["jobId"],
    },
  },
];

const server = new McpStdio(SERVER_NAME, "1.0.0");

server.onRequest("tools/list", () => ({ tools: TOOLS }));

server.onRequest("tools/call", (params) => {
  const name = (params.name as string) || "";
  const args = (params.arguments as Record<string, unknown>) || {};

  if (name === "review") {
    const { result: payload, error } = runClaudeReview(String(args.prompt || ""), {
      model: args.model as string | null,
      system: args.system as string | null,
      tools: args.tools as string | null,
    });
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  if (name === "review_reply") {
    const threadId = (args.threadId || args.thread_id) as string | undefined;
    if (!threadId) return McpStdio.toolError("threadId or thread_id is required");
    const { result: payload, error } = runClaudeReview(String(args.prompt || ""), {
      sessionId: String(threadId),
      model: args.model as string | null,
      system: args.system as string | null,
      tools: args.tools as string | null,
    });
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  if (name === "review_start") {
    const { result: payload, error } = startAsyncReview(String(args.prompt || ""), {
      model: args.model as string | null,
      system: args.system as string | null,
      tools: args.tools as string | null,
    });
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  if (name === "review_reply_start") {
    const threadId = (args.threadId || args.thread_id) as string | undefined;
    if (!threadId) return McpStdio.toolError("threadId or thread_id is required");
    const { result: payload, error } = startAsyncReview(String(args.prompt || ""), {
      sessionId: String(threadId),
      model: args.model as string | null,
      system: args.system as string | null,
      tools: args.tools as string | null,
    });
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  if (name === "review_status") {
    const jobId = (args.jobId || args.job_id) as string | undefined;
    if (!jobId) return McpStdio.toolError("jobId or job_id is required");
    const rawWait = args.waitSeconds;
    let waitSeconds: number;
    try {
      waitSeconds = typeof rawWait === "number" ? rawWait : parseInt(String(rawWait || "0"), 10);
      if (isNaN(waitSeconds)) throw new Error();
    } catch {
      return McpStdio.toolError("waitSeconds must be an integer");
    }
    const { result: payload, error } = getReviewStatus(String(jobId), Math.max(waitSeconds, 0));
    return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
  }

  throw new Error(`Unknown tool: ${name}`);
});

debugLog(`=== ${SERVER_NAME} starting ===`);
server.run();
