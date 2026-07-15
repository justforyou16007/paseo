import { execFileSync, spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import { McpStdio } from "../../lib/mcp-stdio.js";

// --- Configuration ---

const SERVER_NAME = process.env.GEMINI_REVIEW_SERVER_NAME || "gemini-review";
const GEMINI_BIN = process.env.GEMINI_BIN || "gemini";
const AGY_BIN = process.env.AGY_BIN || "agy";
const DEFAULT_MODEL = process.env.GEMINI_REVIEW_MODEL || "";
const DEFAULT_SYSTEM = process.env.GEMINI_REVIEW_SYSTEM || "";
const DEFAULT_BACKEND = process.env.GEMINI_REVIEW_BACKEND || "api";
const DEFAULT_TIMEOUT_SEC = parseInt(process.env.GEMINI_REVIEW_TIMEOUT_SEC || "600", 10);
const DEFAULT_API_MODEL = process.env.GEMINI_REVIEW_API_MODEL || "gemini-2.5-flash";
const DEFAULT_AGY_PRINT_TIMEOUT =
  process.env.GEMINI_REVIEW_AGY_PRINT_TIMEOUT || `${DEFAULT_TIMEOUT_SEC}s`;
const MAX_STATUS_WAIT_SECONDS = parseInt(
  process.env.GEMINI_REVIEW_MAX_STATUS_WAIT_SECONDS || "30",
  10,
);
const AGY_APP_DATA_DIR = resolvePath(
  process.env.GEMINI_REVIEW_AGY_APP_DATA_DIR ||
    path.join(os.homedir(), ".gemini", "antigravity-cli"),
);
const AGY_ARTIFACT_MAX_CHARS = parseInt(
  process.env.GEMINI_REVIEW_AGY_ARTIFACT_MAX_CHARS || "200000",
  10,
);
const WORKSPACE_ROOT = resolvePath(process.env.GEMINI_REVIEW_WORKSPACE_ROOT || process.cwd());
const STATE_DIR = resolvePath(
  process.env.GEMINI_REVIEW_STATE_DIR || path.join(os.homedir(), ".codex", "state", SERVER_NAME),
);
const DEBUG_LOG = resolvePath(
  process.env.GEMINI_REVIEW_DEBUG_LOG || path.join(STATE_DIR, "debug.log"),
);
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const THREADS_DIR = path.join(STATE_DIR, "threads");

const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);
const SHARED_TEMP_DIRS = new Set(["/tmp", "/var/tmp"]);
const SAFE_ID_MAX_LEN = 128;
const SAFE_ID_RE = /^[0-9A-Za-z_-]+$/;
const GEMINI_MODEL_RE =
  /^(?:gemini-[A-Za-z0-9][A-Za-z0-9_.:+-]*|models\/gemini-[A-Za-z0-9][A-Za-z0-9_.:+-]*|publishers\/google\/models\/gemini-[A-Za-z0-9][A-Za-z0-9_.:+-]*)$/i;
const GEMINI_LABEL_RE = /^Gemini\s+[0-9][A-Za-z0-9 ._-]*(?:\s+\([A-Za-z0-9 ._-]+\))?$/i;
const MODEL_KEY_RE = /[^a-z0-9]+/g;
const MODEL_KEY_NAMES = new Set([
  "model",
  "modelid",
  "modelname",
  "selectedmodel",
  "currentmodel",
  "reviewermodel",
]);
const PRIVATE_ENV_KEYS = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
const DEBUG_REDACT_KEYS = new Set([
  "prompt",
  "system",
  "content",
  "text",
  "history",
  "imagePaths",
  "image_paths",
]);
const MODEL_UNTRUSTED_CONTAINER_KEYS = new Set([
  "content",
  "contents",
  "history",
  "message",
  "messages",
  "parts",
  "prompt",
  "response",
  "result",
  "stderr",
  "stdout",
  "text",
  "transcript",
]);
const AGY_CONVERSATION_RE =
  /(?:^|\n)[IWEF]\d{4}\s+\S+\s+\d+\s+printmode\.go:\d+\] Print mode: conversation=([0-9A-Za-z_-]+), sending message$/gm;
const AGY_MODEL_LABEL_RE =
  /(?:^|\n)[IWEF]\d{4}\s+\S+\s+\d+\s+model_config_manager\.go:\d+\] Propagating selected model override to backend: label="([^"]+)"$/gm;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
};

// --- Utility functions ---

function resolvePath(p: string): string {
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(expanded);
}

function pathIsRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function guessMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || null;
}

// --- Security-hardened file/dir operations ---

function ensurePrivateDir(dirPath: string): void {
  const resolved = resolvePath(dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (SHARED_TEMP_DIRS.has(resolved) || resolved === path.dirname(resolved)) {
    return;
  }
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // ignore
  }
}

function appendPrivateText(filePath: string, text: string): void {
  let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND;
  if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    fs.writeSync(fd, text, null, "utf-8");
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // ignore
    }
  } finally {
    fs.closeSync(fd);
  }
}

function debugLog(message: string): void {
  try {
    const stateRoot = resolvePath(STATE_DIR);
    const debugPath = resolvePath(DEBUG_LOG);
    if (!pathIsRelativeTo(debugPath, stateRoot)) return;
    ensurePrivateDir(path.dirname(debugPath));
    appendPrivateText(debugPath, `${message}\n`);
  } catch {
    // ignore
  }
}

function redactForDebug(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (DEBUG_REDACT_KEYS.has(key)) {
        redacted[key] = "[redacted]";
      } else {
        redacted[key] = redactForDebug(item);
      }
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForDebug(item));
  }
  return value;
}

function resolvedFdPath(fd: number): string | null {
  for (const fdRoot of ["/proc/self/fd", "/dev/fd"]) {
    const fdLink = path.join(fdRoot, String(fd));
    try {
      if (fs.existsSync(fdLink)) {
        const target = fs.readlinkSync(fdLink);
        return resolvePath(target);
      }
    } catch {
      return null;
    }
  }
  return null;
}

function openConfinedReadFd(filePath: string, root: string): number | null {
  const resolvedRoot = resolvePath(root);
  const resolvedPath = resolvePath(filePath);
  if (!pathIsRelativeTo(resolvedPath, resolvedRoot)) return null;
  let flags = fs.constants.O_RDONLY;
  if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(resolvedPath, flags);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      fs.closeSync(fd);
      return null;
    }
    const fdPath = resolvedFdPath(fd);
    if (fdPath === null || !pathIsRelativeTo(fdPath, resolvedRoot)) {
      fs.closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    fs.closeSync(fd);
    return null;
  }
}

function readTextConfined(filePath: string, root: string): string | null {
  const result = readTextConfinedWithStat(filePath, root);
  return result !== null ? result.text : null;
}

function readTextConfinedWithStat(
  filePath: string,
  root: string,
): { text: string; stat: fs.Stats } | null {
  const fd = openConfinedReadFd(filePath, root);
  if (fd === null) return null;
  try {
    const fileStat = fs.fstatSync(fd);
    const buf = Buffer.alloc(fileStat.size);
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString("utf-8"), stat: fileStat };
  } finally {
    fs.closeSync(fd);
  }
}

function readBytesConfined(filePath: string, root: string): Buffer | null {
  const fd = openConfinedReadFd(filePath, root);
  if (fd === null) return null;
  try {
    const fileStat = fs.fstatSync(fd);
    const buf = Buffer.alloc(fileStat.size);
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// --- ID and model validation ---

function normalizeSafeId(
  rawValue: unknown,
  fieldName: string,
): { value: string | null; error: string | null } {
  const value = String(rawValue || "").trim();
  if (!value) return { value: null, error: `${fieldName} is required` };
  if (value.length > SAFE_ID_MAX_LEN) {
    return {
      value: null,
      error: `${fieldName} must be at most ${SAFE_ID_MAX_LEN} characters`,
    };
  }
  if (!SAFE_ID_RE.test(value)) {
    return {
      value: null,
      error: `${fieldName} must match ^[0-9A-Za-z_-]+$`,
    };
  }
  return { value, error: null };
}

function confinedStateFile(baseDir: string, identifier: string, fieldName: string): string {
  const { value: safeId, error } = normalizeSafeId(identifier, fieldName);
  if (error || safeId === null) {
    throw new Error(error || `invalid ${fieldName}`);
  }
  const base = resolvePath(baseDir);
  const filePath = resolvePath(path.join(base, `${safeId}.json`));
  if (!pathIsRelativeTo(filePath, base)) {
    throw new Error(`${fieldName} escapes the state directory`);
  }
  return filePath;
}

function normalizeModelName(
  rawValue: unknown,
  fieldName = "model",
): { value: string | null; error: string | null } {
  if (rawValue === null || rawValue === undefined) {
    return { value: null, error: null };
  }
  const value = String(rawValue).trim();
  if (!value) return { value: null, error: null };
  if (value.includes("\0")) {
    return { value: null, error: `${fieldName} must not contain NUL bytes` };
  }
  if (value.startsWith("-")) {
    return { value: null, error: `${fieldName} must not start with '-'` };
  }
  return { value, error: null };
}

function ensureNoNul(value: string, fieldName: string): string | null {
  if (value.includes("\0")) {
    return `${fieldName} must not contain NUL bytes`;
  }
  return null;
}

function selectModelName(...values: unknown[]): { value: string | null; error: string | null } {
  for (const v of values) {
    const { value: selected, error } = normalizeModelName(v);
    if (error) return { value: null, error };
    if (selected) return { value: selected, error: null };
  }
  return { value: null, error: null };
}

function isGeminiModelName(modelName: string | null): boolean {
  if (!modelName) return false;
  const normalized = modelName.trim();
  return GEMINI_MODEL_RE.test(normalized) || GEMINI_LABEL_RE.test(normalized);
}

function requireGeminiModel(modelName: string | null, backendName: string): string | null {
  if (!isGeminiModelName(modelName)) {
    const shown = modelName || "unknown";
    return `${backendName} reviewer model must be a Gemini family model, got: ${shown}`;
  }
  return null;
}

function geminiApiModelPath(modelName: string): string {
  if (modelName.startsWith("models/") || modelName.startsWith("publishers/")) {
    return modelName;
  }
  return `models/${modelName}`;
}

// --- State file operations ---

function writeJson(filePath: string, payload: Record<string, unknown>): void {
  ensurePrivateDir(path.dirname(filePath));
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // ignore
  }
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// --- Private env file loading ---

function readPrivateEnvLines(filePath: string): string[] | null {
  const target = resolvePath(filePath);
  let flags = fs.constants.O_RDONLY;
  if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
  try {
    const statBefore = fs.lstatSync(target);
    if (statBefore.isSymbolicLink() || !statBefore.isFile()) return null;
    if (statBefore.mode & 0o022) return null;
    const getuid = process.getuid;
    if (getuid && statBefore.uid !== getuid()) return null;
    const fd = fs.openSync(target, flags);
    try {
      const statAfter = fs.fstatSync(fd);
      if (!statAfter.isFile() || statAfter.mode & 0o022) return null;
      if (getuid && statAfter.uid !== getuid()) return null;
      if (statBefore.dev !== statAfter.dev || statBefore.ino !== statAfter.ino) {
        return null;
      }
      const buf = Buffer.alloc(statAfter.size);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf-8").split("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function loadPrivateEnvFile(envFile?: string | null): string[] {
  const target = envFile || path.join(os.homedir(), ".gemini", ".env");
  const lines = readPrivateEnvLines(target);
  if (lines === null) return [];

  const loaded: string[] = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    if (!line.includes("=")) continue;
    let [key, ...rest] = line.split("=");
    key = key.trim();
    let value = rest.join("=").trim();
    if (!PRIVATE_ENV_KEYS.has(key)) continue;
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env) || !process.env[key]) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

// --- Image path handling ---

function normalizeImagePaths(rawValue: unknown): { paths: string[]; error: string | null } {
  if (rawValue === null || rawValue === undefined) {
    return { paths: [], error: null };
  }
  if (typeof rawValue === "string") {
    const candidate = rawValue.trim();
    return { paths: candidate ? [candidate] : [], error: null };
  }
  if (!Array.isArray(rawValue)) {
    return {
      paths: [],
      error: "imagePaths must be a string or an array of strings",
    };
  }
  const imagePaths: string[] = [];
  for (const item of rawValue) {
    if (typeof item !== "string") {
      return { paths: [], error: "imagePaths entries must be strings" };
    }
    const candidate = item.trim();
    if (candidate) imagePaths.push(candidate);
  }
  return { paths: imagePaths, error: null };
}

function buildInlineImageParts(imagePaths: string[]): {
  parts: Record<string, unknown>[];
  error: string | null;
} {
  const parts: Record<string, unknown>[] = [];
  const workspaceRoot = resolvePath(WORKSPACE_ROOT);
  for (const rawPath of imagePaths) {
    let p = rawPath.startsWith("~") ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
    if (!path.isAbsolute(p)) {
      p = path.join(workspaceRoot, p);
    }
    const resolvedPath = resolvePath(p);
    if (!pathIsRelativeTo(resolvedPath, workspaceRoot)) {
      return {
        parts: [],
        error: `image file must stay under workspace root: ${rawPath}`,
      };
    }
    const mimeType = guessMimeType(path.basename(resolvedPath));
    if (!mimeType || !mimeType.startsWith("image/")) {
      return {
        parts: [],
        error: `unsupported image type for Gemini review: ${rawPath}`,
      };
    }
    const data = readBytesConfined(resolvedPath, workspaceRoot);
    if (data === null) {
      return {
        parts: [],
        error: `image file not found or not confined to workspace root: ${rawPath}`,
      };
    }
    const encoded = data.toString("base64");
    parts.push({ inlineData: { mimeType, data: encoded } });
  }
  return { parts, error: null };
}

// --- Binary finding ---

function whichBin(name: string): string | null {
  try {
    return (
      execFileSync("which", [name], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function findGeminiBin(): string | null {
  try {
    if (fs.statSync(GEMINI_BIN).isFile()) return GEMINI_BIN;
  } catch {
    // ignore
  }
  return whichBin(GEMINI_BIN);
}

function findAgyBin(): string | null {
  try {
    if (fs.statSync(AGY_BIN).isFile()) return AGY_BIN;
  } catch {
    // ignore
  }
  return whichBin(AGY_BIN);
}

// --- Backend resolution ---

function getApiKey(): string | null {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function resolveBackend(preferredBackend: string | null | undefined): string {
  const backend = preferredBackend || DEFAULT_BACKEND;
  if (!["auto", "api", "cli", "agy"].includes(backend)) {
    throw new Error(`unsupported Gemini backend: ${backend}`);
  }
  if (backend === "auto") {
    return getApiKey() ? "api" : "cli";
  }
  return backend;
}

// --- JSON parsing ---

function parseGeminiJson(rawStdout: string): {
  payload: Record<string, unknown> | null;
  error: string | null;
} {
  const lines = rawStdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { payload: null, error: "Gemini CLI returned empty output" };
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const payload = JSON.parse(lines[i]);
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        return { payload: payload as Record<string, unknown>, error: null };
      }
    } catch {
      continue;
    }
  }
  return { payload: null, error: "Gemini CLI did not return JSON output" };
}

function extractCliErrorMessage(rawStdout: string, rawStderr: string): string {
  for (const text of [rawStdout, rawStderr]) {
    const stripped = text.trim();
    if (!stripped) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(stripped);
    } catch {
      return stripped;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return stripped;
    }
    const obj = payload as Record<string, unknown>;
    const error = obj.error;
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
    const response = obj.response;
    if (typeof response === "string" && response.trim()) {
      return response.trim();
    }
    return stripped;
  }
  return "unknown error";
}

// --- AGY transcript operations ---

function agyOutputIsError(text: string): boolean {
  const stripped = text.trim();
  return (
    stripped === "Error: timed out waiting for response" ||
    stripped.startsWith("Error: timed out waiting for response")
  );
}

function extractAgyConversationIdsFromLog(logPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(logPath, "utf-8");
  } catch {
    return [];
  }
  const re = new RegExp(AGY_CONVERSATION_RE.source, AGY_CONVERSATION_RE.flags);
  const conversationIds: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const { value: conversationId, error } = normalizeSafeId(match[1], "conversationId");
    if (!error && conversationId && !conversationIds.includes(conversationId)) {
      conversationIds.push(conversationId);
    }
  }
  return conversationIds;
}

function agyConversationPosition(logText: string, conversationId: string): number | null {
  const re = new RegExp(AGY_CONVERSATION_RE.source, AGY_CONVERSATION_RE.flags);
  let position: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(logText)) !== null) {
    if (match[1] === conversationId) {
      position = match.index;
    }
  }
  return position;
}

function agyConversationRoot(conversationId: string): string | null {
  const { value: safeId, error } = normalizeSafeId(conversationId, "conversationId");
  if (error || safeId === null) return null;
  const brainRoot = resolvePath(path.join(AGY_APP_DATA_DIR, "brain"));
  const conversationRoot = resolvePath(path.join(brainRoot, safeId));
  if (!pathIsRelativeTo(conversationRoot, brainRoot)) return null;
  return conversationRoot;
}

function agyTranscriptPaths(conversationId: string): string[] {
  const convRoot = agyConversationRoot(conversationId);
  if (convRoot === null) return [];
  const logsDir = path.join(convRoot, ".system_generated", "logs");
  return [path.join(logsDir, "transcript_full.jsonl"), path.join(logsDir, "transcript.jsonl")];
}

function agyArtifactText(
  filePath: string,
  conversationRoot: string,
  artifactMinMtime: number | null,
): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (![".md", ".markdown", ".txt", ".json", ".yaml", ".yml"].includes(ext)) {
    return null;
  }
  const result = readTextConfinedWithStat(filePath, conversationRoot);
  if (result === null) return null;
  const { text: rawText, stat: fileStat } = result;
  if (artifactMinMtime !== null && fileStat.mtimeMs / 1000 < artifactMinMtime - 1.0) {
    return null;
  }
  const text = rawText.trim();
  if (!text) return null;
  if (text.length > AGY_ARTIFACT_MAX_CHARS) {
    return (
      text.slice(0, AGY_ARTIFACT_MAX_CHARS) +
      "\n\n[truncated by gemini-review agy artifact fallback]"
    );
  }
  return text;
}

function extractFileUriPaths(text: string): string[] {
  const paths: string[] = [];
  const re = /file:\/\/[^\s)>\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      const parsed = new URL(match[0]);
      if (parsed.protocol !== "file:" || !parsed.pathname) continue;
      paths.push(decodeURIComponent(parsed.pathname));
    } catch {
      continue;
    }
  }
  return paths;
}

function stripFileUriRefs(text: string): string {
  return text
    .replace(/file:\/\/[^\s)>\]]+/g, "")
    .replace(/^[\s.,:;()\[\]<>]+|[\s.,:;()\[\]<>]+$/g, "");
}

function collectModelCandidates(
  value: unknown,
  candidates: string[],
  underUntrustedText = false,
): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(MODEL_KEY_RE, "");
      const nextUnderUntrusted =
        underUntrustedText || MODEL_UNTRUSTED_CONTAINER_KEYS.has(normalizedKey);
      if (
        !underUntrustedText &&
        MODEL_KEY_NAMES.has(normalizedKey) &&
        typeof item === "string" &&
        item.trim()
      ) {
        candidates.push(item.trim());
      }
      collectModelCandidates(item, candidates, nextUnderUntrusted);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectModelCandidates(item, candidates, underUntrustedText);
    }
  }
}

function selectModelCandidate(candidates: string[]): {
  value: string | null;
  error: string | null;
} {
  const cleaned = candidates.map((c) => c.trim().replace(/^[",]+|[",]+$/g, "")).filter(Boolean);
  if (cleaned.length === 0) return { value: null, error: null };
  const normalized = new Set(cleaned.map((c) => c.toLowerCase()));
  if (normalized.size > 1) {
    return {
      value: null,
      error: `conflicting Antigravity model candidates: ${cleaned.join(", ")}`,
    };
  }
  return { value: cleaned[cleaned.length - 1], error: null };
}

function collectModelCandidatesFromAgyLog(text: string, candidates: string[]): void {
  const re = new RegExp(AGY_MODEL_LABEL_RE.source, AGY_MODEL_LABEL_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1].trim()) candidates.push(match[1].trim());
  }
}

function transcriptStepIsUserEvent(step: Record<string, unknown>): boolean {
  const source = String(step.source || "").toUpperCase();
  const role = String(step.role || "").toLowerCase();
  const stepType = String(step.type || "").toUpperCase();
  const author = String(step.author || "").toLowerCase();
  return (
    ["USER", "USER_EXPLICIT", "USER_IMPLICIT"].includes(source) ||
    role === "user" ||
    author === "user" ||
    ["USER_INPUT", "USER_MESSAGE"].includes(stepType)
  );
}

function transcriptStepContainsNonce(
  step: Record<string, unknown>,
  invocationNonce: string,
): boolean {
  const content = step.content;
  if (typeof content === "string") return content.includes(invocationNonce);
  if (Array.isArray(content)) {
    return content.some((item) => typeof item === "string" && item.includes(invocationNonce));
  }
  if (typeof content === "object" && content !== null) {
    return JSON.stringify(content).includes(invocationNonce);
  }
  return false;
}

function transcriptLinesAtOrAfterNonce(
  transcriptText: string,
  invocationNonce: string | null,
): string[] | null {
  if (!invocationNonce) return null;
  const lines = transcriptText.split("\n");
  for (let index = 0; index < lines.length; index++) {
    let step: Record<string, unknown>;
    try {
      step = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (
      typeof step === "object" &&
      step !== null &&
      transcriptStepIsUserEvent(step) &&
      transcriptStepContainsNonce(step, invocationNonce)
    ) {
      return lines.slice(index);
    }
  }
  return null;
}

function transcriptContainsNonce(transcriptText: string, invocationNonce: string): boolean {
  return transcriptLinesAtOrAfterNonce(transcriptText, invocationNonce) !== null;
}

function agyConversationHasNonce(conversationId: string, invocationNonce: string): boolean {
  const convRoot = agyConversationRoot(conversationId);
  if (convRoot === null) return false;
  for (const transcriptPath of agyTranscriptPaths(conversationId)) {
    const transcriptText = readTextConfined(transcriptPath, convRoot);
    if (transcriptText !== null && transcriptContainsNonce(transcriptText, invocationNonce)) {
      return true;
    }
  }
  return false;
}

function selectAgyConversationIdFromState(
  logPath: string,
  invocationNonce: string | null,
): { value: string | null; error: string | null } {
  if (!invocationNonce) {
    return {
      value: null,
      error: "invocation_nonce is required for Antigravity transcript recovery",
    };
  }
  const conversationIds = extractAgyConversationIdsFromLog(logPath);
  if (conversationIds.length === 0) {
    return {
      value: null,
      error: "could not locate Antigravity conversation id in this invocation's log",
    };
  }
  for (let i = conversationIds.length - 1; i >= 0; i--) {
    if (agyConversationHasNonce(conversationIds[i], invocationNonce)) {
      return { value: conversationIds[i], error: null };
    }
  }
  return {
    value: null,
    error: `Antigravity transcript is not bound to this invocation: ${conversationIds[conversationIds.length - 1]}`,
  };
}

function extractAgyModelFromState(
  logPath: string,
  conversationId: string,
  invocationNonce: string | null,
): { value: string | null; error: string | null } {
  if (!invocationNonce) {
    return {
      value: null,
      error: "invocation_nonce is required for Antigravity model provenance",
    };
  }
  const candidates: string[] = [];
  let logText: string;
  try {
    logText = fs.readFileSync(logPath, "utf-8");
  } catch {
    logText = "";
  }
  const conversationPosition = agyConversationPosition(logText, conversationId);
  if (conversationPosition !== null) {
    collectModelCandidatesFromAgyLog(logText.slice(0, conversationPosition), candidates);
  }
  const convRoot = agyConversationRoot(conversationId);
  if (convRoot !== null) {
    for (const transcriptPath of agyTranscriptPaths(conversationId)) {
      const transcriptText = readTextConfined(transcriptPath, convRoot);
      if (transcriptText === null) continue;
      const scopedLines = transcriptLinesAtOrAfterNonce(transcriptText, invocationNonce);
      if (scopedLines === null) continue;
      for (const line of scopedLines) {
        let step: unknown;
        try {
          step = JSON.parse(line);
        } catch {
          continue;
        }
        collectModelCandidates(step, candidates);
      }
    }
  }
  return selectModelCandidate(candidates);
}

function extractAgyResponseFromTranscript(
  conversationId: string,
  invocationNonce: string | null,
  artifactMinMtime: number | null,
): string | null {
  if (!invocationNonce) return null;
  const convRoot = agyConversationRoot(conversationId);
  if (convRoot === null) return null;
  for (const transcriptPath of agyTranscriptPaths(conversationId)) {
    const transcriptText = readTextConfined(transcriptPath, convRoot);
    if (transcriptText === null) continue;
    const scopedLines = transcriptLinesAtOrAfterNonce(transcriptText, invocationNonce);
    if (scopedLines === null) continue;
    let finalResponse: string | null = null;
    let artifactPaths: string[] = [];
    for (const line of scopedLines) {
      let step: Record<string, unknown>;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (step.source !== "MODEL") continue;
      const stepType = step.type;
      const content = step.content;
      if (stepType === "PLANNER_RESPONSE" && typeof content === "string" && content.trim()) {
        finalResponse = content.trim();
        artifactPaths = extractFileUriPaths(content);
      }
    }
    if (finalResponse) {
      if (stripFileUriRefs(finalResponse)) {
        return finalResponse;
      }
      for (let i = artifactPaths.length - 1; i >= 0; i--) {
        const artifact = agyArtifactText(artifactPaths[i], convRoot, artifactMinMtime);
        if (artifact) return artifact;
      }
      return null;
    }
  }
  return null;
}

function extractAgyResponseFromState(
  logPath: string,
  invocationNonce: string | null,
  artifactMinMtime: number | null,
): {
  response: string | null;
  error: string | null;
  conversationId: string | null;
} {
  if (!invocationNonce) {
    return {
      response: null,
      error: "invocation_nonce is required for Antigravity transcript recovery",
      conversationId: null,
    };
  }
  const { value: conversationId, error: conversationError } = selectAgyConversationIdFromState(
    logPath,
    invocationNonce,
  );
  if (conversationError || conversationId === null) {
    return {
      response: null,
      error: conversationError || "could not locate Antigravity conversation id",
      conversationId: null,
    };
  }
  const response = extractAgyResponseFromTranscript(
    conversationId,
    invocationNonce,
    artifactMinMtime,
  );
  if (response) {
    debugLog(`AGY_TRANSCRIPT_RECOVERED conversation=${conversationId}`);
    return { response, error: null, conversationId };
  }
  return {
    response: null,
    error: `Antigravity transcript has no final response yet: ${conversationId}`,
    conversationId: null,
  };
}

// --- API response parsing ---

function extractApiResponseText(payload: Record<string, unknown>): string {
  const candidates = payload.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const cObj = candidate as Record<string, unknown>;
      const content = cObj.content;
      if (typeof content !== "object" || content === null) continue;
      const cContent = content as Record<string, unknown>;
      const parts = cContent.parts;
      if (!Array.isArray(parts)) continue;
      const texts: string[] = [];
      for (const part of parts) {
        if (typeof part === "object" && part !== null) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") texts.push(text);
        }
      }
      if (texts.length > 0) return texts.join("\n").trim();
    }
  }
  const promptFeedback = payload.promptFeedback;
  if (typeof promptFeedback === "object" && promptFeedback !== null) {
    const blockReason = (promptFeedback as Record<string, unknown>).blockReason;
    if (typeof blockReason === "string" && blockReason) {
      throw new Error(`Gemini API response blocked: ${blockReason}`);
    }
  }
  throw new Error("Gemini API response does not contain candidate text");
}

// --- Job/thread state paths ---

function jobStatePath(jobId: string): string {
  return confinedStateFile(JOBS_DIR, jobId, "jobId");
}

function threadStatePath(threadId: string): string {
  return confinedStateFile(THREADS_DIR, threadId, "threadId");
}

// --- Process management ---

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runProcessTree(
  cmd: string[],
  timeoutSec: number,
): {
  result: ProcessResult | null;
  error: string | null;
  durationMs: number;
} {
  const started = Date.now();
  const spawnResult = spawnSync(cmd[0], cmd.slice(1), {
    timeout: timeoutSec * 1000,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    input: "",
    killSignal: "SIGKILL",
  });
  const durationMs = Date.now() - started;

  if (spawnResult.signal) {
    return {
      result: null,
      error: `timed out after ${timeoutSec} seconds`,
      durationMs,
    };
  }
  if (spawnResult.error) {
    return {
      result: null,
      error: `failed to launch: ${spawnResult.error.message}`,
      durationMs,
    };
  }
  return {
    result: {
      stdout: spawnResult.stdout || "",
      stderr: spawnResult.stderr || "",
      exitCode: spawnResult.status ?? 1,
    },
    error: null,
    durationMs,
  };
}

// --- Job serialization ---

function serializeJob(job: Record<string, unknown>): Record<string, unknown> {
  const result = (job.result as Record<string, unknown>) || {};
  const payload: Record<string, unknown> = {
    jobId: job.jobId,
    status: job.status,
    done: TERMINAL_JOB_STATES.has(job.status as string),
    threadId: result.threadId ?? null,
    response: result.response ?? null,
    model: result.model ?? null,
    backend: result.backend ?? null,
    duration_ms: result.duration_ms ?? null,
    stop_reason: result.stop_reason ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    updatedAt: job.updatedAt ?? null,
    resumeHint: "Call review_status with this jobId until done=true.",
  };
  for (const optionalKey of ["model_provenance", "requested_model", "warning"]) {
    if (optionalKey in result) {
      payload[optionalKey] = result[optionalKey];
    }
  }
  return payload;
}

// --- Thread history ---

interface HistoryEntry {
  role: string;
  text: string;
}

function loadThreadHistory(threadId: string): HistoryEntry[] {
  const filePath = threadStatePath(threadId);
  if (!fs.existsSync(filePath)) return [];
  const payload = readJson(filePath);
  const history = payload.history;
  if (!Array.isArray(history)) return [];
  const result: HistoryEntry[] = [];
  for (const item of history) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const role = String(obj.role || "").trim();
    const text = String(obj.text || "").trim();
    if ((role === "user" || role === "model") && text) {
      result.push({ role, text });
    }
  }
  return result;
}

function saveThreadHistory(
  threadId: string,
  history: HistoryEntry[],
  model: string,
  backend: string,
): void {
  const now = utcNow();
  const filePath = threadStatePath(threadId);
  let createdAt = now;
  if (fs.existsSync(filePath)) {
    const existing = readJson(filePath);
    createdAt = String(existing.createdAt || now);
  }
  writeJson(filePath, {
    threadId,
    createdAt,
    updatedAt: now,
    model,
    backend,
    history,
  });
}

// --- CLI prompt building ---

function buildCliPrompt(
  prompt: string,
  history: HistoryEntry[],
  system: string | null | undefined,
): string {
  const selectedSystem = (system || DEFAULT_SYSTEM).trim();
  if (history.length === 0 && !selectedSystem) return prompt;
  const sections: string[] = [];
  if (selectedSystem) {
    sections.push("## System Instructions", selectedSystem, "");
  }
  if (history.length > 0) {
    sections.push("## Previous Review Conversation");
    for (const item of history) {
      const role = item.role === "user" ? "User" : "Reviewer";
      sections.push(`### ${role}`, item.text, "");
    }
  }
  sections.push("## New User Prompt", prompt);
  return sections.join("\n").trim();
}

// --- CLI backend ---

type BackendResult = {
  result: Record<string, unknown> | null;
  error: string | null;
};

function runGeminiCliReview(
  prompt: string,
  history: HistoryEntry[],
  model: string | null | undefined,
  system: string | null | undefined,
  imagePaths: string[],
): BackendResult {
  if (imagePaths.length > 0) {
    return {
      result: null,
      error: "Gemini CLI backend in this bridge does not support imagePaths; use backend=api",
    };
  }
  const binPath = findGeminiBin();
  if (!binPath) {
    return { result: null, error: `Gemini CLI not found: ${GEMINI_BIN}` };
  }
  const effectivePrompt = buildCliPrompt(prompt, history, system);
  const nulError = ensureNoNul(effectivePrompt, "prompt");
  if (nulError) return { result: null, error: nulError };
  const cmd = [binPath, "-p", effectivePrompt, "--output-format", "json"];
  const { value: selectedModel, error: modelError } = selectModelName(model, DEFAULT_MODEL);
  if (modelError) return { result: null, error: modelError };
  if (selectedModel) {
    const familyError = requireGeminiModel(selectedModel, "Gemini CLI");
    if (familyError) return { result: null, error: familyError };
    cmd.push("-m", selectedModel);
  }

  debugLog(`RUN gemini-cli model=${selectedModel || "default"} output_format=json`);
  let processResult: {
    result: ProcessResult | null;
    error: string | null;
    durationMs: number;
  };
  try {
    processResult = runProcessTree(cmd, DEFAULT_TIMEOUT_SEC);
  } catch (exc) {
    return {
      result: null,
      error: `failed to launch Gemini CLI: ${exc}`,
    };
  }
  if (processResult.error) {
    return {
      result: null,
      error: `Gemini review ${processResult.error}`,
    };
  }
  if (processResult.result === null) {
    return {
      result: null,
      error: "Gemini review failed without process details",
    };
  }
  const { payload, error: parseError } = parseGeminiJson(processResult.result.stdout);
  if (parseError) {
    const stderr = processResult.result.stderr.trim();
    const message = !stderr ? parseError : `${parseError}. stderr: ${stderr}`;
    return { result: null, error: message };
  }
  if (payload === null) {
    return { result: null, error: "Failed to parse Gemini CLI output" };
  }
  if (processResult.result.exitCode !== 0) {
    return {
      result: null,
      error: `Gemini review failed: ${extractCliErrorMessage(processResult.result.stdout, processResult.result.stderr)}`,
    };
  }
  const responseText = String(payload.response || "").trim();
  if (!responseText) {
    return {
      result: null,
      error: "Gemini CLI JSON payload does not contain a non-empty response field",
    };
  }
  const reportedModel = String(payload.model || selectedModel || "gemini-cli");
  const modelFamilyError = requireGeminiModel(reportedModel, "Gemini CLI");
  if (modelFamilyError) return { result: null, error: modelFamilyError };

  return {
    result: {
      response: responseText,
      model: reportedModel,
      duration_ms: processResult.durationMs,
      stop_reason: payload.stop_reason ?? null,
      backend: "cli",
    },
    error: null,
  };
}

// --- AGY backend ---

function runAgyCliReview(
  prompt: string,
  history: HistoryEntry[],
  model: string | null | undefined,
  system: string | null | undefined,
  imagePaths: string[],
): BackendResult {
  if (imagePaths.length > 0) {
    return {
      result: null,
      error: "Antigravity CLI backend in this bridge does not support imagePaths; use backend=api",
    };
  }
  const binPath = findAgyBin();
  if (!binPath) {
    return { result: null, error: `Antigravity CLI not found: ${AGY_BIN}` };
  }
  const { value: requestedModel, error: modelError } = selectModelName(model);
  if (modelError) return { result: null, error: modelError };

  const invocationNonce = crypto.randomUUID().replace(/-/g, "");
  let effectivePrompt = buildCliPrompt(prompt, history, system);
  effectivePrompt = `${effectivePrompt}\n\n## Invocation Binding\ngemini-review nonce: ${invocationNonce}`;

  const nulError =
    ensureNoNul(effectivePrompt, "prompt") ||
    ensureNoNul(DEFAULT_AGY_PRINT_TIMEOUT, "GEMINI_REVIEW_AGY_PRINT_TIMEOUT");
  if (nulError) return { result: null, error: nulError };

  const agyLogDir = path.join(STATE_DIR, "agy-logs");
  try {
    ensurePrivateDir(agyLogDir);
  } catch (exc) {
    return {
      result: null,
      error: `failed to create private Antigravity log directory: ${exc}`,
    };
  }

  const tempDir = fs.mkdtempSync(path.join(agyLogDir, "agy-"));
  try {
    try {
      fs.chmodSync(tempDir, 0o700);
    } catch {
      // ignore
    }
    const agyLogPath = path.join(tempDir, "agy.log");
    const cmd = [
      binPath,
      "--log-file",
      agyLogPath,
      "--print",
      effectivePrompt,
      "--print-timeout",
      DEFAULT_AGY_PRINT_TIMEOUT,
    ];

    debugLog(`RUN agy-cli timeout=${DEFAULT_AGY_PRINT_TIMEOUT} log=${agyLogPath}`);
    let processResult: {
      result: ProcessResult | null;
      error: string | null;
      durationMs: number;
    };
    const invocationStartedAt = Date.now() / 1000;
    try {
      processResult = runProcessTree(cmd, DEFAULT_TIMEOUT_SEC + 15);
    } catch (exc) {
      return {
        result: null,
        error: `failed to launch Antigravity CLI: ${exc}`,
      };
    }
    if (processResult.error) {
      return {
        result: null,
        error: `Antigravity review ${processResult.error}`,
      };
    }
    if (processResult.result === null) {
      return {
        result: null,
        error: "Antigravity review failed without process details",
      };
    }

    let responseText = processResult.result.stdout.trim();
    let recoveredConversationId: string | null = null;

    if (processResult.result.exitCode !== 0) {
      const message = processResult.result.stderr.trim() || responseText || "unknown error";
      return {
        result: null,
        error: `Antigravity review failed: ${message}`,
      };
    }

    if (responseText && agyOutputIsError(responseText)) {
      const recovered = extractAgyResponseFromState(
        agyLogPath,
        invocationNonce,
        invocationStartedAt,
      );
      if (recovered.response) {
        responseText = recovered.response;
        recoveredConversationId = recovered.conversationId;
      } else if (responseText) {
        const suffix = recovered.error ? `; ${recovered.error}` : "";
        return {
          result: null,
          error: `Antigravity CLI did not print a final response: ${responseText}${suffix}`,
        };
      }
    }

    if (!responseText) {
      const stderr = processResult.result.stderr.trim();
      const recovered = extractAgyResponseFromState(
        agyLogPath,
        invocationNonce,
        invocationStartedAt,
      );
      if (recovered.response) {
        responseText = recovered.response;
        recoveredConversationId = recovered.conversationId;
      } else {
        let message = !stderr
          ? "Antigravity CLI returned empty output"
          : `Antigravity CLI returned empty output. stderr: ${stderr}`;
        if (recovered.error) {
          message = `${message}; ${recovered.error}`;
        }
        return { result: null, error: message };
      }
    }

    let conversationId = recoveredConversationId;
    if (!conversationId) {
      const { value: convId, error: convError } = selectAgyConversationIdFromState(
        agyLogPath,
        invocationNonce,
      );
      if (convError || !convId) {
        return {
          result: null,
          error: convError || "could not bind Antigravity transcript to this invocation",
        };
      }
      conversationId = convId;
    }

    const { value: agyModel, error: agyModelError } = extractAgyModelFromState(
      agyLogPath,
      conversationId,
      invocationNonce,
    );
    if (agyModelError) return { result: null, error: agyModelError };
    const modelFamilyError = requireGeminiModel(agyModel, "Antigravity CLI");
    if (modelFamilyError) {
      return {
        result: null,
        error: `${modelFamilyError}. The agy backend must expose the actual reviewer model in this invocation's log/transcript so ARIS can audit the cross-model invariant.`,
      };
    }

    const resultPayload: Record<string, unknown> = {
      response: responseText,
      model: agyModel,
      model_provenance: "agy-log-or-transcript",
      duration_ms: processResult.durationMs,
      stop_reason: null,
      backend: "agy",
    };
    if (requestedModel) {
      resultPayload.requested_model = requestedModel;
      resultPayload.warning =
        "Antigravity CLI does not support per-call model selection in this bridge; " +
        "requested_model is recorded for provenance only. " +
        `Actual model was recovered as ${JSON.stringify(agyModel)}.`;
    }
    return { result: resultPayload, error: null };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// --- API backend ---

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      },
      timeout: timeoutMs,
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    req.write(body);
    req.end();
  });
}

async function runGeminiApiReview(
  prompt: string,
  history: HistoryEntry[],
  model: string | null | undefined,
  system: string | null | undefined,
  imagePaths: string[],
): Promise<BackendResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      result: null,
      error: "Gemini API backend requires GEMINI_API_KEY or GOOGLE_API_KEY",
    };
  }
  const { value: selectedModel, error: modelError } = selectModelName(
    model,
    DEFAULT_MODEL,
    DEFAULT_API_MODEL,
  );
  if (modelError) return { result: null, error: modelError };
  const familyError = requireGeminiModel(selectedModel, "Gemini API");
  if (familyError) return { result: null, error: familyError };

  const requestPayload: Record<string, unknown> = {
    contents: [] as Record<string, unknown>[],
    generationConfig: { temperature: 0.2 },
  };
  const selectedSystem = (system || DEFAULT_SYSTEM).trim();
  if (selectedSystem) {
    requestPayload.systemInstruction = {
      parts: [{ text: selectedSystem }],
    };
  }
  const contents = requestPayload.contents as Record<string, unknown>[];
  for (const item of history) {
    contents.push({
      role: item.role,
      parts: [{ text: item.text }],
    });
  }
  const userParts: Record<string, unknown>[] = [{ text: prompt }];
  const { parts: inlineParts, error: imageError } = buildInlineImageParts(imagePaths);
  if (imageError) return { result: null, error: imageError };
  userParts.push(...inlineParts);
  contents.push({ role: "user", parts: userParts });

  const modelPath = geminiApiModelPath(selectedModel!);
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;

  debugLog(`RUN gemini-api ${selectedModel}`);
  let responseBody: string;
  let statusCode: number;
  let durationMs: number;
  try {
    const started = Date.now();
    const httpResult = await httpsPost(
      url,
      JSON.stringify(requestPayload),
      {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      DEFAULT_TIMEOUT_SEC * 1000,
    );
    durationMs = Date.now() - started;
    responseBody = httpResult.body;
    statusCode = httpResult.statusCode;
  } catch (exc) {
    return {
      result: null,
      error: `Gemini API request failed: ${exc instanceof Error ? exc.message : exc}`,
    };
  }

  if (statusCode !== 200) {
    let message = responseBody.trim();
    try {
      const errorPayload = JSON.parse(responseBody);
      if (typeof errorPayload === "object" && errorPayload !== null) {
        const error = (errorPayload as Record<string, unknown>).error;
        if (typeof error === "object" && error !== null) {
          const apiMessage = (error as Record<string, unknown>).message;
          if (typeof apiMessage === "string" && apiMessage.trim()) {
            message = apiMessage.trim();
          }
        }
      }
    } catch {
      // use raw message
    }
    return {
      result: null,
      error: `Gemini API failed with HTTP ${statusCode}: ${message || "unknown error"}`,
    };
  }

  let apiPayload: unknown;
  try {
    apiPayload = JSON.parse(responseBody);
  } catch {
    return {
      result: null,
      error: "Gemini API response is not valid JSON",
    };
  }
  if (typeof apiPayload !== "object" || apiPayload === null || Array.isArray(apiPayload)) {
    return {
      result: null,
      error: "Gemini API response JSON must be an object",
    };
  }

  let responseText: string;
  try {
    responseText = extractApiResponseText(apiPayload as Record<string, unknown>);
  } catch (exc) {
    return {
      result: null,
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }

  return {
    result: {
      response: responseText,
      model: selectedModel,
      duration_ms: durationMs,
      stop_reason: null,
      backend: "api",
    },
    error: null,
  };
}

// --- Unified review dispatch ---

async function runGeminiReview(
  prompt: string,
  opts: {
    sessionId?: string | null;
    model?: string | null;
    system?: string | null;
    tools?: string | null;
    backend?: string | null;
    imagePaths?: unknown;
  } = {},
): Promise<BackendResult> {
  void opts.tools;

  loadPrivateEnvFile();

  const { paths: normalizedImagePaths, error: imageError } = normalizeImagePaths(opts.imagePaths);
  if (imageError) return { result: null, error: imageError };

  let threadId: string;
  if (opts.sessionId) {
    const { value: safeId, error: threadError } = normalizeSafeId(opts.sessionId, "threadId");
    if (threadError || safeId === null) {
      return { result: null, error: threadError || "invalid threadId" };
    }
    threadId = safeId;
  } else {
    threadId = crypto.randomUUID().replace(/-/g, "");
  }

  const history = opts.sessionId ? loadThreadHistory(threadId) : [];

  let selectedBackend: string;
  try {
    selectedBackend = resolveBackend(opts.backend);
  } catch (exc) {
    return {
      result: null,
      error: exc instanceof Error ? exc.message : String(exc),
    };
  }

  let backendResult: BackendResult;
  if (selectedBackend === "api") {
    backendResult = await runGeminiApiReview(
      prompt,
      history,
      opts.model,
      opts.system,
      normalizedImagePaths,
    );
  } else if (selectedBackend === "agy") {
    backendResult = runAgyCliReview(prompt, history, opts.model, opts.system, normalizedImagePaths);
  } else {
    backendResult = runGeminiCliReview(
      prompt,
      history,
      opts.model,
      opts.system,
      normalizedImagePaths,
    );
  }

  if (backendResult.error) return backendResult;
  if (backendResult.result === null) {
    return { result: null, error: "Failed to parse reviewer output" };
  }

  const updatedHistory = [...history];
  updatedHistory.push({ role: "user", text: prompt });
  updatedHistory.push({
    role: "model",
    text: String(backendResult.result.response),
  });
  saveThreadHistory(
    threadId,
    updatedHistory,
    String(backendResult.result.model),
    String(backendResult.result.backend),
  );
  backendResult.result.threadId = threadId;
  return backendResult;
}

// --- Async job management ---

function startAsyncReview(
  prompt: string,
  opts: {
    sessionId?: string | null;
    model?: string | null;
    system?: string | null;
    tools?: string | null;
    backend?: string | null;
    imagePaths?: unknown;
  } = {},
): { result: Record<string, unknown> | null; error: string | null } {
  const { paths: normalizedImagePaths, error: imageError } = normalizeImagePaths(opts.imagePaths);
  if (imageError) return { result: null, error: imageError };

  if (opts.sessionId) {
    const { value: safeSessionId, error: threadError } = normalizeSafeId(
      opts.sessionId,
      "threadId",
    );
    if (threadError || safeSessionId === null) {
      return { result: null, error: threadError || "invalid threadId" };
    }
    opts.sessionId = safeSessionId;
  }

  const { error: modelError } = normalizeModelName(opts.model);
  if (modelError) return { result: null, error: modelError };

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
      backend: opts.backend || null,
      imagePaths: normalizedImagePaths,
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
  const { value: safeJobId, error: jobError } = normalizeSafeId(jobId, "jobId");
  if (jobError || safeJobId === null) {
    return { result: null, error: jobError || "invalid jobId" };
  }
  if (waitSeconds < 0 || waitSeconds > MAX_STATUS_WAIT_SECONDS) {
    return {
      result: null,
      error: `waitSeconds must be between 0 and ${MAX_STATUS_WAIT_SECONDS}`,
    };
  }
  const jobPath = jobStatePath(safeJobId);
  if (!fs.existsSync(jobPath)) {
    return { result: null, error: `Unknown jobId: ${safeJobId}` };
  }

  const deadline = Date.now() + waitSeconds * 1000;
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

async function runAsyncJob(jobId: string): Promise<number> {
  const { value: safeJobId, error: jobError } = normalizeSafeId(jobId, "jobId");
  if (jobError || safeJobId === null) {
    debugLog(`JOB_INVALID job_id=${JSON.stringify(jobId)} error=${jobError}`);
    return 1;
  }
  const safeId = safeJobId;
  const jobPath = jobStatePath(safeId);
  if (!fs.existsSync(jobPath)) {
    debugLog(`JOB_MISSING job_id=${safeId}`);
    return 1;
  }

  let job = readJson(jobPath);
  job.status = "running";
  job.startedAt = utcNow();
  job.updatedAt = job.startedAt;
  job.workerPid = process.pid;
  writeJson(jobPath, job);
  debugLog(`JOB_RUNNING job_id=${safeId} worker_pid=${process.pid}`);

  const request = (job.request as Record<string, unknown>) || {};
  let payload: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const reviewResult = await runGeminiReview(String(request.prompt || ""), {
      sessionId: request.threadId as string | null,
      model: request.model as string | null,
      system: request.system as string | null,
      tools: request.tools as string | null,
      backend: request.backend as string | null,
      imagePaths: request.imagePaths,
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
    debugLog(`JOB_FAILED job_id=${safeId} error=${error}`);
    writeJson(jobPath, job);
    return 1;
  }

  job.status = "completed";
  job.error = null;
  job.result = payload;
  debugLog(`JOB_COMPLETED job_id=${safeId} thread_id=${(payload || {}).threadId}`);
  writeJson(jobPath, job);
  return 0;
}

// --- Entry point ---

if (process.argv[2] === "--run-job" && process.argv[3]) {
  runAsyncJob(process.argv[3]).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
} else {
  const commonProperties = {
    prompt: { type: "string", description: "Reviewer prompt" },
    system: { type: "string", description: "Optional system prompt" },
    model: {
      type: "string",
      description: "Optional Gemini model override",
    },
    backend: {
      type: "string",
      description: "Optional Gemini backend override: auto, api, cli, or agy",
    },
    tools: {
      type: "string",
      description: "Accepted for compatibility but ignored by Gemini review",
    },
    imagePaths: {
      type: "array",
      items: { type: "string" },
      description: "Optional local image paths for Gemini API multimodal review",
    },
    image_paths: {
      type: "array",
      items: { type: "string" },
      description: "Alias of imagePaths",
    },
  };

  const replyProperties = {
    threadId: {
      type: "string",
      description: "Gemini thread id from a previous review call",
    },
    thread_id: {
      type: "string",
      description: "Alias of threadId",
    },
    ...commonProperties,
  };

  const TOOLS = [
    {
      name: "review",
      description: "Run a fresh Gemini review and return JSON containing threadId and response.",
      inputSchema: {
        type: "object",
        properties: commonProperties,
        required: ["prompt"],
      },
    },
    {
      name: "review_reply",
      description: "Continue a previous Gemini review session using threadId.",
      inputSchema: {
        type: "object",
        properties: replyProperties,
        required: ["prompt", "threadId"],
      },
    },
    {
      name: "review_start",
      description: "Start a background Gemini review job and return a resumable jobId immediately.",
      inputSchema: {
        type: "object",
        properties: commonProperties,
        required: ["prompt"],
      },
    },
    {
      name: "review_reply_start",
      description:
        "Start a background follow-up review job in an existing Gemini thread and return a resumable jobId immediately.",
      inputSchema: {
        type: "object",
        properties: replyProperties,
        required: ["prompt", "threadId"],
      },
    },
    {
      name: "review_status",
      description:
        "Check whether a background review job has finished and fetch the final result when available.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "Background review job id",
          },
          job_id: {
            type: "string",
            description: "Alias of jobId",
          },
          waitSeconds: {
            type: "integer",
            minimum: 0,
            maximum: MAX_STATUS_WAIT_SECONDS,
            description: "Optional bounded wait before returning status",
          },
        },
        required: ["jobId"],
      },
    },
  ];

  const server = new McpStdio(SERVER_NAME, "1.0.0");

  server.onRequest("tools/list", () => ({ tools: TOOLS }));

  server.onRequest("tools/call", async (params) => {
    const name = (params.name as string) || "";
    const args = (params.arguments as Record<string, unknown>) || {};

    if (name === "review") {
      const { result: payload, error } = await runGeminiReview(String(args.prompt || ""), {
        model: args.model as string | null,
        system: args.system as string | null,
        tools: args.tools as string | null,
        backend: args.backend as string | null,
        imagePaths: args.imagePaths || args.image_paths,
      });
      return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
    }

    if (name === "review_reply") {
      const threadId = (args.threadId || args.thread_id) as string | undefined;
      if (!threadId) {
        return McpStdio.toolError("threadId or thread_id is required");
      }
      const { result: payload, error } = await runGeminiReview(String(args.prompt || ""), {
        sessionId: String(threadId),
        model: args.model as string | null,
        system: args.system as string | null,
        tools: args.tools as string | null,
        backend: args.backend as string | null,
        imagePaths: args.imagePaths || args.image_paths,
      });
      return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
    }

    if (name === "review_start") {
      const { result: payload, error } = startAsyncReview(String(args.prompt || ""), {
        model: args.model as string | null,
        system: args.system as string | null,
        tools: args.tools as string | null,
        backend: args.backend as string | null,
        imagePaths: args.imagePaths || args.image_paths,
      });
      return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
    }

    if (name === "review_reply_start") {
      const threadId = (args.threadId || args.thread_id) as string | undefined;
      if (!threadId) {
        return McpStdio.toolError("threadId or thread_id is required");
      }
      const { result: payload, error } = startAsyncReview(String(args.prompt || ""), {
        sessionId: String(threadId),
        model: args.model as string | null,
        system: args.system as string | null,
        tools: args.tools as string | null,
        backend: args.backend as string | null,
        imagePaths: args.imagePaths || args.image_paths,
      });
      return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
    }

    if (name === "review_status") {
      const jobId = (args.jobId || args.job_id) as string | undefined;
      if (!jobId) {
        return McpStdio.toolError("jobId or job_id is required");
      }
      const rawWait = args.waitSeconds;
      let waitSeconds: number;
      try {
        waitSeconds = typeof rawWait === "number" ? rawWait : parseInt(String(rawWait || "0"), 10);
        if (isNaN(waitSeconds)) throw new Error();
      } catch {
        return McpStdio.toolError("waitSeconds must be an integer");
      }
      const { result: payload, error } = getReviewStatus(String(jobId), waitSeconds);
      return error ? McpStdio.toolError(error) : McpStdio.toolSuccess(payload!);
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  debugLog(`=== ${SERVER_NAME} starting ===`);
  server.run();
}
