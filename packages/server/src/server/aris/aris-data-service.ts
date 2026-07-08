import { createReadStream, promises as fs, watch as fsWatch } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { Logger } from "pino";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { resolveScopedPath } from "../file-explorer/service.js";

const ARIS_RUNS_DIR = ".aris/runs";

const ArisRunPhaseFileSchema = z
  .object({
    phaseId: z.string().default(""),
    name: z.string().default(""),
    status: z
      .enum(["pending", "running", "completed", "failed", "done", "accepted", "skipped"])
      .default("pending"),
    iterationCount: z.number().int().nonnegative().default(0),
    bestScore: z.number().nullable().optional(),
  })
  .passthrough()
  .transform(
    (raw): ArisRunPhase => ({
      phaseId: raw.phaseId || (raw as Record<string, unknown>).phase?.toString() || "",
      name: raw.name || (raw as Record<string, unknown>).phase?.toString() || "",
      status: normalizePhaseStatus(raw.status),
      iterationCount: raw.iterationCount,
      bestScore: raw.bestScore ?? null,
    }),
  );

const ArisRunStateFileSchema = z
  .object({
    runId: z.string().optional(),
    status: z
      .enum(["pending", "running", "paused", "completed", "failed", "done", "accepted"])
      .default("pending"),
    goal: z.string().default(""),
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
    phases: z.array(ArisRunPhaseFileSchema).default([]),
  })
  .passthrough()
  .transform((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      runId: raw.runId ?? (typeof r.run_id === "string" ? r.run_id : ""),
      status: normalizeRunStatus(raw.status),
      goal: raw.goal,
      createdAt: raw.createdAt || (typeof r.created === "string" ? r.created : ""),
      updatedAt: raw.updatedAt || (typeof r.updated === "string" ? r.updated : ""),
      phases: raw.phases,
    };
  })
  .refine((v) => v.runId.length > 0, { message: "runId or run_id is required" });

const ArisIterationFileSchema = z
  .object({
    iterationId: z.string().default(""),
    runId: z.string().default(""),
    phaseId: z.string().default(""),
    index: z.number().int().nonnegative().default(0),
    score: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().default(""),
  })
  .passthrough()
  .transform((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      iterationId: raw.iterationId || (typeof r.id === "string" ? r.id : ""),
      runId: raw.runId || (typeof r.run_id === "string" ? r.run_id : ""),
      phaseId: raw.phaseId || (typeof r.phase === "string" ? r.phase : ""),
      index: raw.index,
      score: raw.score ?? null,
      metadata: raw.metadata,
      createdAt: raw.createdAt || (typeof r.timestamp === "string" ? r.timestamp : ""),
    };
  });

export interface ArisRunPhase {
  phaseId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  iterationCount: number;
  bestScore: number | null;
}

export interface ArisRun {
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  goal: string;
  createdAt: string;
  updatedAt: string;
  phases: ArisRunPhase[];
}

export interface ArisIteration {
  iterationId: string;
  runId: string;
  phaseId: string;
  index: number;
  score: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ArisIterationsPage {
  iterations: ArisIteration[];
  nextCursor: string | null;
}

export interface ArisDataServiceOptions {
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}

export interface ArisDataService {
  listRuns(workspaceId: string): Promise<ArisRun[]>;
  readRun(workspaceId: string, runId: string): Promise<ArisRun | null>;
  readIterations(
    workspaceId: string,
    runId: string,
    phaseId: string | null,
    options?: { limit?: number; cursor?: string },
  ): Promise<ArisIterationsPage>;
  watchRun(
    workspaceId: string,
    runId: string | undefined,
    onChange: () => void,
    signal?: AbortSignal,
  ): Promise<() => void>;
}

class ArisWorkspaceNotFoundError extends Error {
  constructor() {
    super("Workspace not found");
    this.name = "ArisWorkspaceNotFoundError";
  }
}

function normalizeRunId(runId: string): string {
  return path.basename(runId);
}

type NormalizedRunStatus = "pending" | "running" | "paused" | "completed" | "failed";

function normalizeRunStatus(status: unknown): NormalizedRunStatus {
  if (status === "done" || status === "accepted" || status === "skipped") {
    return "completed";
  }
  if (status === "pending" || status === "running" || status === "paused") {
    return status;
  }
  if (status === "failed") {
    return "failed";
  }
  return "pending";
}

type NormalizedPhaseStatus = "pending" | "running" | "completed" | "failed";

function normalizePhaseStatus(status: unknown): NormalizedPhaseStatus {
  if (status === "done" || status === "accepted" || status === "skipped") {
    return "completed";
  }
  if (status === "pending" || status === "running") {
    return status;
  }
  if (status === "failed") {
    return "failed";
  }
  return "pending";
}

function sanitizeRelativePath(...segments: string[]): string {
  const joined = path.join(...segments);
  const normalized = path.normalize(joined);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Access outside of workspace is not allowed");
  }
  return normalized;
}

async function resolveArisPath(
  workspaceRegistry: WorkspaceRegistry,
  workspaceId: string,
  ...relativeSegments: string[]
): Promise<string> {
  const workspace = await workspaceRegistry.get(workspaceId);
  if (!workspace || workspace.archivedAt !== null) {
    throw new ArisWorkspaceNotFoundError();
  }
  const relativePath = sanitizeRelativePath(ARIS_RUNS_DIR, ...relativeSegments);
  const scoped = await resolveScopedPath({ root: workspace.cwd, relativePath });
  return scoped.resolvedPath;
}

async function safeStat(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readRunStateFile(filePath: string): Promise<ArisRun | null> {
  const stats = await safeStat(filePath);
  if (!stats || !stats.isFile()) {
    return null;
  }
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    const run = ArisRunStateFileSchema.parse(parsed);
    return {
      runId: run.runId,
      status: run.status,
      goal: run.goal,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      phases: run.phases.map((phase) => ({
        phaseId: phase.phaseId,
        name: phase.name,
        status: phase.status,
        iterationCount: phase.iterationCount,
        bestScore: phase.bestScore ?? null,
      })),
    };
  } catch {
    return null;
  }
}

async function readPhaseDoneFiles(
  workspaceRegistry: WorkspaceRegistry,
  workspaceId: string,
  runId: string,
  phases: ArisRunPhase[],
): Promise<ArisRunPhase[]> {
  const runIdNormalized = normalizeRunId(runId);
  return Promise.all(
    phases.map(async (phase) => {
      try {
        const donePath = await resolveArisPath(
          workspaceRegistry,
          workspaceId,
          `${runIdNormalized}.${phase.phaseId}.done.json`,
        );
        const stats = await safeStat(donePath);
        if (stats && stats.isFile()) {
          return { ...phase, status: "completed" as const };
        }
      } catch {
        // ignore missing done files
      }
      return phase;
    }),
  );
}

function parseIterationLine(line: string): ArisIteration | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const iteration = ArisIterationFileSchema.parse(parsed);
    return {
      iterationId: iteration.iterationId,
      runId: iteration.runId,
      phaseId: iteration.phaseId,
      index: iteration.index,
      score: iteration.score ?? null,
      metadata: iteration.metadata,
      createdAt: iteration.createdAt,
    };
  } catch {
    return null;
  }
}

function cursorFromIndex(index: number): string {
  return String(index);
}

function indexFromCursor(cursor: string): number {
  const parsed = Number.parseInt(cursor, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export function createArisDataService(opts: ArisDataServiceOptions): ArisDataService {
  const { workspaceRegistry, logger } = opts;

  async function getRunFilePath(workspaceId: string, runId: string): Promise<string> {
    const runIdNormalized = normalizeRunId(runId);
    return resolveArisPath(workspaceRegistry, workspaceId, `${runIdNormalized}.json`);
  }

  async function listRunIds(workspaceId: string): Promise<string[]> {
    try {
      const runsDir = await resolveArisPath(workspaceRegistry, workspaceId);
      const entries = await fs.readdir(runsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length));
    } catch (error) {
      if (error instanceof ArisWorkspaceNotFoundError) {
        return [];
      }
      logger.debug({ err: error, workspaceId }, "Failed to list ARIS runs directory");
      return [];
    }
  }

  return {
    async listRuns(workspaceId: string): Promise<ArisRun[]> {
      const runIds = await listRunIds(workspaceId);
      const runs = await Promise.all(
        runIds.map(async (runId) => {
          const filePath = await getRunFilePath(workspaceId, runId);
          const run = await readRunStateFile(filePath);
          if (!run) {
            return null;
          }
          const phases = await readPhaseDoneFiles(
            workspaceRegistry,
            workspaceId,
            runId,
            run.phases,
          );
          return Object.assign({}, run, { phases });
        }),
      );
      return runs.filter((run): run is ArisRun => run !== null);
    },

    async readRun(workspaceId: string, runId: string): Promise<ArisRun | null> {
      const filePath = await getRunFilePath(workspaceId, runId);
      const run = await readRunStateFile(filePath);
      if (!run) {
        return null;
      }
      const phases = await readPhaseDoneFiles(workspaceRegistry, workspaceId, runId, run.phases);
      return { ...run, phases };
    },

    async readIterations(
      workspaceId: string,
      runId: string,
      phaseId: string | null,
      options?: { limit?: number; cursor?: string },
    ): Promise<ArisIterationsPage> {
      const runIdNormalized = normalizeRunId(runId);
      const filePath = await resolveArisPath(
        workspaceRegistry,
        workspaceId,
        `${runIdNormalized}.iterations.jsonl`,
      );
      const stats = await safeStat(filePath);
      if (!stats || !stats.isFile()) {
        return { iterations: [], nextCursor: null };
      }

      const limit = options?.limit ?? 200;
      const startIndex = indexFromCursor(options?.cursor ?? "0");

      const iterations: ArisIteration[] = [];
      let lineIndex = 0;

      const stream = createReadStream(filePath, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

      try {
        for await (const line of rl) {
          if (lineIndex < startIndex) {
            lineIndex += 1;
            continue;
          }
          const iteration = parseIterationLine(line);
          if (!iteration) {
            lineIndex += 1;
            continue;
          }
          if (phaseId !== null && iteration.phaseId !== phaseId) {
            lineIndex += 1;
            continue;
          }
          iterations.push(iteration);
          lineIndex += 1;
          if (iterations.length >= limit) {
            break;
          }
        }
      } finally {
        rl.close();
      }

      const nextCursor = iterations.length >= limit ? cursorFromIndex(lineIndex) : null;
      return { iterations, nextCursor };
    },

    async watchRun(
      workspaceId: string,
      runId: string | undefined,
      onChange: () => void,
      signal?: AbortSignal,
    ): Promise<() => void> {
      let watcher: import("node:fs").FSWatcher | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      try {
        const watchRoot = await resolveArisPath(workspaceRegistry, workspaceId);
        const watchTarget = runId
          ? path.join(watchRoot, `${normalizeRunId(runId)}.iterations.jsonl`)
          : watchRoot;

        const handleChange = (): void => {
          try {
            onChange();
          } catch (error) {
            logger.debug({ err: error, workspaceId, runId }, "ARIS watch onChange failed");
          }
        };

        try {
          watcher = fsWatch(watchTarget, { recursive: runId === undefined }, (eventType) => {
            if (eventType === "change" || eventType === "rename") {
              handleChange();
            }
          });
        } catch {
          // Fallback to polling if fs.watch fails (e.g. network drives)
          let lastMtime = 0;
          pollInterval = setInterval(async () => {
            try {
              const stats = await fs.stat(watchTarget);
              const mtime = stats.mtime.getTime();
              if (mtime > lastMtime) {
                lastMtime = mtime;
                handleChange();
              }
            } catch {
              // ignore stat errors during polling
            }
          }, 1000);
        }

        signal?.addEventListener("abort", () => {
          watcher?.close();
          if (pollInterval) {
            clearInterval(pollInterval);
          }
        });
      } catch (error) {
        logger.debug({ err: error, workspaceId, runId }, "Failed to set up ARIS file watcher");
      }

      return () => {
        watcher?.close();
        if (pollInterval) {
          clearInterval(pollInterval);
        }
      };
    },
  };
}
