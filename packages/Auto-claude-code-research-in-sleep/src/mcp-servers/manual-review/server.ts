import { exec as execCb } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { McpStdio } from "../../lib/mcp-stdio.js";

// --- Configuration ---

const SERVER_NAME = process.env.MANUAL_REVIEW_SERVER_NAME || "manual-review";
const DEFAULT_TIMEOUT_SEC = parseInt(process.env.MANUAL_REVIEW_TIMEOUT_SEC || "86400", 10);
const MODE = process.env.MANUAL_REVIEW_MODE || "browser";
const AUTO_OPEN = ["1", "true", "yes"].includes(
  (process.env.MANUAL_REVIEW_AUTO_OPEN || "true").toLowerCase(),
);
const PENDING_DIR = process.env.MANUAL_REVIEW_PENDING_DIR || ".aris/pending_review";
const DEBUG_LOG_RAW = (process.env.MANUAL_REVIEW_DEBUG_LOG || "").trim();
const DEBUG_LOG = DEBUG_LOG_RAW || null;
const DEFAULT_PORT = parseInt(process.env.MANUAL_REVIEW_PORT || "17900", 10);
const MAX_PORT_ATTEMPTS = 10;
const FILE_STABLE_INTERVAL_SEC = 3;
const FILE_POLL_INTERVAL_SEC = 2;

// --- Thread storage ---

const _threads = new Map<string, { role: string; content: string }[]>();

// --- UI HTML ---

let _uiHtml: string | null = null;

// --- Utilities ---

function debugLog(message: string): void {
  if (!DEBUG_LOG) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${utcNow()}] ${message}\n`, "utf-8");
  } catch {
    // ignore
  }
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function loadUiHtml(): string {
  if (_uiHtml === null) {
    const uiPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "..",
      "mcp-servers",
      "manual-review",
      "ui.html",
    );
    _uiHtml = fs.readFileSync(uiPath, "utf-8");
  }
  return _uiHtml;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open ${JSON.stringify(url)}`;
  } else if (platform === "win32") {
    cmd = `start "" ${JSON.stringify(url)}`;
  } else {
    cmd = `xdg-open ${JSON.stringify(url)}`;
  }
  execCb(cmd, () => {
    // ignore errors
  });
}

// --- Thread management ---

function createThread(): string {
  const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  _threads.set(threadId, []);
  return threadId;
}

function appendExchange(threadId: string, role: string, content: string): void {
  if (!_threads.has(threadId)) {
    _threads.set(threadId, []);
  }
  _threads.get(threadId)!.push({ role, content });
}

function getHistory(threadId: string): { role: string; content: string }[] {
  return _threads.get(threadId) || [];
}

// --- Pending state file ---

function pendingDirFor(threadId: string): string {
  return path.join(PENDING_DIR, threadId);
}

function writePendingState(url: string | null, threadId: string, promptFile: string | null): void {
  const pdir = pendingDirFor(threadId);
  const state = {
    status: "waiting",
    url,
    prompt_file: promptFile,
    response_file: promptFile ? path.join(pdir, "response.md") : null,
    thread_id: threadId,
    created_at: utcNow(),
  };
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "pending_review.json"), JSON.stringify(state, null, 2), "utf-8");
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PENDING_DIR, "pending_review.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

function clearPendingState(threadId?: string | null): void {
  if (threadId) {
    const pdir = pendingDirFor(threadId);
    try {
      fs.rmSync(pdir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    fs.unlinkSync(path.join(PENDING_DIR, "pending_review.json"));
  } catch {
    // ignore
  }
}

// --- Browser mode: HTTP server ---

interface ReviewSession {
  prompt: string;
  config: Record<string, unknown>;
  threadId: string;
  history: { role: string; content: string }[];
  response: string | null;
  resolve: ((value: string | null) => void) | null;
}

let _currentSession: ReviewSession | null = null;
let _activeServer: http.Server | null = null;
let _authToken: string | null = null;

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function checkToken(url: URL, headers: http.IncomingHttpHeaders): boolean {
  const tokenParam = url.searchParams.get("token");
  if (tokenParam && tokenParam === _authToken) return true;
  const headerToken = headers["x-review-token"];
  if (typeof headerToken === "string" && headerToken === _authToken) {
    return true;
  }
  return false;
}

function checkOrigin(headers: http.IncomingHttpHeaders, serverPort: number): boolean {
  const origin = headers.origin;
  if (typeof origin === "string" && origin) {
    const expected = `http://127.0.0.1:${serverPort}`;
    if (origin !== expected) return false;
  }
  const secFetchSite = headers["sec-fetch-site"];
  if (
    typeof secFetchSite === "string" &&
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return false;
  }
  return true;
}

const FILE_MODE_WARNING = `# ARIS Manual Review - Cross-Model Warning

If this workflow is running from Claude Code, do NOT paste this prompt into any Claude product (claude.ai, Claude API, Claude App). Using the same model family as executor defeats the purpose of ARIS cross-model review.

如果此流程由 Claude Code 执行，请勿将此提示词粘贴到任何 Claude 产品。请使用 ChatGPT、DeepSeek、Kimi、Gemini、Qwen、本地模型或其他非 Claude 模型。

---

`;

async function waitForBrowserResponse(
  prompt: string,
  config: Record<string, unknown>,
  threadId: string,
  history: { role: string; content: string }[],
  abortSignal: AbortSignal,
): Promise<{ response: string | null; error: string | null }> {
  if (_activeServer !== null) {
    try {
      _activeServer.close();
    } catch {
      // ignore
    }
    _activeServer = null;
  }

  const session: ReviewSession = {
    prompt,
    config,
    threadId,
    history,
    response: null,
    resolve: null,
  };
  _currentSession = session;
  _authToken = generateToken();

  const responsePromise = new Promise<string | null>((resolve) => {
    session.resolve = resolve;
  });

  let server: http.Server | null = null;
  let boundPort = DEFAULT_PORT;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = DEFAULT_PORT + attempt;
    try {
      server = await tryListen(port, session);
      boundPort = port;
      break;
    } catch {
      continue;
    }
  }

  if (server === null) {
    _currentSession = null;
    return {
      response: null,
      error: `Could not bind to any port in range ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}`,
    };
  }

  _activeServer = server;
  const url = `http://127.0.0.1:${boundPort}?token=${_authToken}`;
  writePendingState(url, threadId, null);
  debugLog(`HTTP server started on ${url}`);

  if (AUTO_OPEN) {
    try {
      openBrowser(url);
    } catch {
      // ignore
    }
  }

  let response: string | null = null;
  let error: string | null = null;

  try {
    const deadline = Date.now() + DEFAULT_TIMEOUT_SEC * 1000;
    while (Date.now() < deadline) {
      if (abortSignal.aborted) {
        error = "Manual review request was cancelled";
        break;
      }
      const remaining = Math.min(1000, deadline - Date.now());
      if (remaining <= 0) break;
      const raceResult = await Promise.race([
        responsePromise.then((r) => ({ type: "response" as const, value: r })),
        sleep(remaining).then(() => ({ type: "timeout" as const, value: null })),
      ]);
      if (raceResult.type === "response") {
        response = raceResult.value;
        break;
      }
    }
    if (error === null && response === null) {
      if (abortSignal.aborted) {
        error = "Manual review request was cancelled";
      } else {
        error = `Timed out after ${DEFAULT_TIMEOUT_SEC}s waiting for manual review response`;
      }
    }
  } finally {
    try {
      server.close();
    } catch {
      // ignore
    }
    if (_activeServer === server) _activeServer = null;
    if (_currentSession === session) _currentSession = null;
    clearPendingState(threadId);
  }

  return { response, error };
}

function tryListen(port: number, session: ReviewSession): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleHttpRequest(req, res, session, port);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  session: ReviewSession,
  serverPort: number,
): void {
  const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${serverPort}`);
  const pathname = parsedUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(403);
    res.end("CORS not allowed");
    return;
  }

  if (req.method === "GET") {
    if (pathname === "/") {
      if (!checkToken(parsedUrl, req.headers)) {
        res.writeHead(403);
        res.end("Invalid or missing token");
        return;
      }
      if (!checkOrigin(req.headers, serverPort)) {
        res.writeHead(403);
        res.end("Cross-origin request blocked");
        return;
      }
      let html: string;
      try {
        html = loadUiHtml();
      } catch {
        res.writeHead(500);
        res.end("Failed to load UI");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (pathname === "/api/context") {
      if (!checkToken(parsedUrl, req.headers)) {
        res.writeHead(403);
        res.end("Invalid or missing token");
        return;
      }
      if (!checkOrigin(req.headers, serverPort)) {
        res.writeHead(403);
        res.end("Cross-origin request blocked");
        return;
      }
      const ctx = {
        prompt: session.prompt,
        config: session.config,
        threadId: session.threadId,
        history: session.history,
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(ctx));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (req.method === "POST") {
    if (pathname === "/api/submit") {
      if (!checkToken(parsedUrl, req.headers)) {
        res.writeHead(403);
        res.end("Invalid or missing token");
        return;
      }
      if (!checkOrigin(req.headers, serverPort)) {
        res.writeHead(403);
        res.end("Cross-origin request blocked");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
          return;
        }
        const responseText = String(data.response || "").trim();
        if (!responseText) {
          res.writeHead(400);
          res.end("Empty response");
          return;
        }
        if (session.resolve) {
          session.resolve(responseText);
          session.resolve = null;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
}

// --- File mode ---

async function waitForFileResponse(
  prompt: string,
  config: Record<string, unknown>,
  threadId: string,
  history: { role: string; content: string }[],
  abortSignal: AbortSignal,
): Promise<{ response: string | null; error: string | null }> {
  const pdir = pendingDirFor(threadId);
  fs.mkdirSync(pdir, { recursive: true });
  const promptPath = path.join(pdir, "prompt.md");
  const responsePath = path.join(pdir, "response.md");

  try {
    fs.unlinkSync(responsePath);
  } catch {
    // ignore
  }

  let header = FILE_MODE_WARNING;
  header += `<!-- thread: ${threadId} | config: ${JSON.stringify(config)} -->\n\n`;
  if (history.length > 0) {
    header += "## Previous Exchanges\n\n";
    for (let i = 0; i < history.length; i++) {
      const ex = history[i];
      const label = ex.role === "user" ? "Prompt" : "Response";
      header += `### ${label} (Round ${Math.floor(i / 2) + 1})\n\n`;
      header += ex.content.slice(0, 500) + (ex.content.length > 500 ? "..." : "") + "\n\n";
    }
    header += "---\n\n## Current Prompt\n\n";
  }
  fs.writeFileSync(promptPath, header + prompt, "utf-8");

  writePendingState(null, threadId, promptPath);
  debugLog(`File mode: prompt written to ${promptPath}, waiting for ${responsePath}`);

  const deadline = Date.now() + DEFAULT_TIMEOUT_SEC * 1000;
  let prevContent: string | null = null;
  let response: string | null = null;
  let error: string | null = null;

  try {
    while (Date.now() < deadline) {
      if (abortSignal.aborted) {
        error = "Manual review request was cancelled";
        break;
      }
      await sleep(FILE_POLL_INTERVAL_SEC * 1000);
      if (abortSignal.aborted) {
        error = "Manual review request was cancelled";
        break;
      }
      if (!fs.existsSync(responsePath)) {
        prevContent = null;
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(responsePath, "utf-8").trim();
      } catch {
        prevContent = null;
        continue;
      }
      if (!content) {
        prevContent = null;
        continue;
      }
      if (content === prevContent) {
        response = content;
        break;
      }
      prevContent = content;
      await sleep(FILE_STABLE_INTERVAL_SEC * 1000);
      if (abortSignal.aborted) {
        error = "Manual review request was cancelled";
        break;
      }
      let content2: string;
      try {
        content2 = fs.readFileSync(responsePath, "utf-8").trim();
      } catch {
        prevContent = null;
        continue;
      }
      if (content2 === content && content2) {
        response = content2;
        break;
      }
      prevContent = content2;
    }
    if (error === null && response === null && !abortSignal.aborted) {
      error = `Timed out after ${DEFAULT_TIMEOUT_SEC}s waiting for ${responsePath}`;
    }
  } finally {
    clearPendingState(threadId);
  }

  return { response, error };
}

// --- Unified dispatch ---

async function doReview(
  prompt: string,
  config: Record<string, unknown>,
  threadId: string,
  history: { role: string; content: string }[],
  abortSignal: AbortSignal,
): Promise<{ response: string | null; error: string | null }> {
  if (MODE === "file") {
    return waitForFileResponse(prompt, config, threadId, history, abortSignal);
  }
  return waitForBrowserResponse(prompt, config, threadId, history, abortSignal);
}

// --- MCP tool handlers ---

async function handleReview(
  args: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<unknown> {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return McpStdio.toolError("prompt is required");
  let config = args.config as Record<string, unknown> | undefined;
  if (typeof config !== "object" || config === null) config = {};

  const threadId = createThread();
  appendExchange(threadId, "user", prompt);

  const { response, error } = await doReview(prompt, config, threadId, [], abortSignal);
  if (error) return McpStdio.toolError(error);

  appendExchange(threadId, "assistant", response!);
  return McpStdio.toolSuccess({ threadId, content: response });
}

async function handleReviewReply(
  args: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<unknown> {
  const threadId = String(args.threadId || "").trim();
  if (!threadId) return McpStdio.toolError("threadId is required");
  if (!_threads.has(threadId)) {
    return McpStdio.toolError(`Unknown threadId: ${threadId}`);
  }

  const prompt = String(args.prompt || "").trim();
  if (!prompt) return McpStdio.toolError("prompt is required");
  let config = args.config as Record<string, unknown> | undefined;
  if (typeof config !== "object" || config === null) config = {};

  const history = getHistory(threadId);
  appendExchange(threadId, "user", prompt);

  const { response, error } = await doReview(prompt, config, threadId, history, abortSignal);
  if (error) return McpStdio.toolError(error);

  appendExchange(threadId, "assistant", response!);
  return McpStdio.toolSuccess({ threadId, content: response });
}

// --- Active call tracking for cancellation ---

let _activeAbortController: AbortController | null = null;

// --- MCP server ---

const TOOLS = [
  {
    name: "review",
    description:
      "Start a new manual review session. Opens a browser page where the user copies the prompt to any AI model and pastes the response back.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The full review prompt to show the user",
        },
        config: {
          type: "object",
          description: "Config hints (e.g. model_reasoning_effort)",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "review_reply",
    description:
      "Continue a review conversation in an existing thread. Shows previous exchanges for context.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Thread ID from a previous review call",
        },
        prompt: {
          type: "string",
          description: "Follow-up prompt",
        },
        config: {
          type: "object",
          description: "Config hints",
        },
      },
      required: ["threadId", "prompt"],
    },
  },
];

const server = new McpStdio(SERVER_NAME, "0.1.0");

server.onRequest("tools/list", () => ({ tools: TOOLS }));

server.onRequest("tools/call", async (params) => {
  const name = (params.name as string) || "";
  const args = (params.arguments as Record<string, unknown>) || {};

  if (name === "review" || name === "review_reply") {
    if (_activeAbortController !== null) {
      return McpStdio.toolError(
        "Another manual review is already in progress. " +
          "Finish it in the browser/file response path, " +
          "or cancel the previous tool call before starting a new one.",
      );
    }

    const abortController = new AbortController();
    _activeAbortController = abortController;

    try {
      if (name === "review") {
        return await handleReview(args, abortController.signal);
      }
      return await handleReviewReply(args, abortController.signal);
    } finally {
      if (_activeAbortController === abortController) {
        _activeAbortController = null;
      }
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

debugLog(`Server starting: mode=${MODE}, timeout=${DEFAULT_TIMEOUT_SEC}s`);
server.run();
