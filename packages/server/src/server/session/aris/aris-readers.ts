import { constants, promises as fs } from "fs";
import { resolveScopedPath, type ReadFileParams } from "../../file-explorer/service.js";
import type {
  ArisAuditFile,
  ArisEvent,
  ArisKnowledgeGraph,
  ArisKnowledgeGraphEdge,
  ArisPaperImprovementState,
  ArisPendingReview,
  ArisReviewState,
  ArisTraceMetadata,
} from "@getpaseo/protocol/messages";

const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

export interface ArisReviewReadResult {
  reviewState: ArisReviewState | null;
  autoReviewMarkdown: string | null;
  paperImprovement: ArisPaperImprovementState | null;
  audits: ArisAuditFile[];
  pendingReview: ArisPendingReview | null;
  traces: ArisTraceMetadata[];
  knowledgeGraph: ArisKnowledgeGraph | null;
}

export interface ReadArisReviewInput {
  cwd: string;
  runId?: string;
}

export async function readArisReviewState(
  input: ReadArisReviewInput,
): Promise<ArisReviewReadResult> {
  const { cwd } = input;
  const [
    reviewState,
    autoReviewMarkdown,
    paperImprovement,
    audits,
    pendingReview,
    traces,
    knowledgeGraph,
  ] = await Promise.all([
    readJsonFileSafe<ArisReviewState>({
      root: cwd,
      relativePath: "review-stage/REVIEW_STATE.json",
    }),
    readTextFileSafe({ root: cwd, relativePath: "review-stage/AUTO_REVIEW.md" }),
    readJsonFileSafe<ArisPaperImprovementState>({
      root: cwd,
      relativePath: "paper/PAPER_IMPROVEMENT_STATE.json",
    }),
    readAuditFiles({ root: cwd }),
    readJsonFileSafe<ArisPendingReview>({
      root: cwd,
      relativePath: ".aris/pending_review/pending_review.json",
    }),
    readTraceMetadata({ root: cwd }),
    readKnowledgeGraph({ root: cwd }),
  ]);

  return {
    reviewState,
    autoReviewMarkdown,
    paperImprovement,
    audits,
    pendingReview,
    traces,
    knowledgeGraph,
  };
}

export interface ReadArisEventsInput {
  cwd: string;
  limit?: number;
  runId?: string;
}

export async function readArisEvents(input: ReadArisEventsInput): Promise<ArisEvent[]> {
  const { cwd, limit = 1000, runId } = input;
  const events: ArisEvent[] = [];
  const filePath = await resolveScopedPath({
    root: cwd,
    relativePath: ".aris/meta/events.jsonl",
  });

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath.resolvedPath, READ_FILE_OPEN_FLAGS);
  } catch (error) {
    if (isMissingEntryError(error)) {
      return [];
    }
    throw error;
  }

  try {
    const content = await handle.readFile("utf-8");
    const lines = content.split("\n");
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const line = lines[idx];
      if (!line.trim()) {
        continue;
      }
      const parsed = parseJsonLine<ArisEvent>(line);
      if (!parsed) {
        continue;
      }
      if (runId && parsed.runId !== runId) {
        continue;
      }
      events.push(parsed);
      if (events.length >= limit) {
        break;
      }
    }
  } finally {
    await handle.close();
  }

  return events.toReversed();
}

async function readJsonFileSafe<T>(params: ReadFileParams): Promise<T | null> {
  try {
    const filePath = await resolveScopedPath(params);
    const handle = await fs.open(filePath.resolvedPath, READ_FILE_OPEN_FLAGS);
    try {
      const content = await handle.readFile("utf-8");
      const parsed = JSON.parse(content) as T;
      return parsed;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function readTextFileSafe(params: ReadFileParams): Promise<string | null> {
  try {
    const filePath = await resolveScopedPath(params);
    const handle = await fs.open(filePath.resolvedPath, READ_FILE_OPEN_FLAGS);
    try {
      return await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingEntryError(error)) {
      return null;
    }
    throw error;
  }
}

async function readJsonlFileSafe<T>(params: ReadFileParams): Promise<T[]> {
  const filePath = await resolveScopedPath(params);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath.resolvedPath, READ_FILE_OPEN_FLAGS);
  } catch (error) {
    if (isMissingEntryError(error)) {
      return [];
    }
    throw error;
  }

  try {
    const content = await handle.readFile("utf-8");
    const results: T[] = [];
    for (const line of content.split("\n")) {
      const parsed = parseJsonLine<T>(line);
      if (parsed) {
        results.push(parsed);
      }
    }
    return results;
  } finally {
    await handle.close();
  }
}

async function readKnowledgeGraph(input: { root: string }): Promise<ArisKnowledgeGraph | null> {
  const { root } = input;
  const edges = await readJsonlFileSafe<ArisKnowledgeGraphEdge>({
    root,
    relativePath: "research-wiki/graph/edges.jsonl",
  });
  if (edges.length === 0) {
    return null;
  }
  return { edges };
}

async function readAuditFiles(input: { root: string }): Promise<ArisAuditFile[]> {
  const { root } = input;
  const auditDir = await resolveScopedPath({ root, relativePath: "paper" });
  let entries: string[];
  try {
    entries = await fs.readdir(auditDir.resolvedPath);
  } catch (error) {
    if (isMissingEntryError(error)) {
      return [];
    }
    throw error;
  }

  const auditFiles = entries.filter((name) => name.endsWith("_AUDIT.json"));
  const results = await Promise.all(
    auditFiles.map(async (fileName) => {
      const raw = await readJsonFileSafe<Record<string, unknown>>({
        root,
        relativePath: `paper/${fileName}`,
      });
      if (!raw) {
        return null;
      }
      const section =
        typeof raw.section === "string" ? raw.section : fileName.replace("_AUDIT.json", "");
      const verdicts = Array.isArray(raw.verdicts)
        ? (raw.verdicts as ArisAuditFile["verdicts"])
        : undefined;
      const auditFile: ArisAuditFile = {
        fileName,
        section,
        verdicts,
        raw,
      };
      return auditFile;
    }),
  );
  return results.filter((item): item is ArisAuditFile => item !== null);
}

async function readTraceMetadata(input: { root: string }): Promise<ArisTraceMetadata[]> {
  const { root } = input;
  const tracesDir = await resolveScopedPath({ root, relativePath: ".aris/traces" });
  let skillDirs: string[];
  try {
    skillDirs = await fs.readdir(tracesDir.resolvedPath);
  } catch (error) {
    if (isMissingEntryError(error)) {
      return [];
    }
    throw error;
  }

  const traces: ArisTraceMetadata[] = [];
  for (const skill of skillDirs) {
    const skillPath = `.aris/traces/${skill}`;
    const resolvedSkill = await resolveScopedPath({ root, relativePath: skillPath });
    let runDirs: string[];
    try {
      const stats = await fs.stat(resolvedSkill.resolvedPath);
      if (!stats.isDirectory()) {
        continue;
      }
      runDirs = await fs.readdir(resolvedSkill.resolvedPath);
    } catch {
      continue;
    }

    for (const runDir of runDirs) {
      const match = runDir.match(/^((\d{4}-\d{2}-\d{2})_run(\d{2}))$/);
      if (!match) {
        continue;
      }
      const [, , date, runId] = match;
      const metadata = await readJsonFileSafe<{ status?: string }>({
        root,
        relativePath: `${skillPath}/${runDir}/metadata.json`,
      });
      traces.push({
        skill,
        date,
        runId,
        status: normalizeTraceStatus(metadata?.status),
      });
    }
  }
  return traces;
}

function normalizeTraceStatus(status: unknown): ArisTraceMetadata["status"] {
  if (
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
