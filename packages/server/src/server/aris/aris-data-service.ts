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

export interface ArisWorkflowArtifact {
  path: string;
  kind:
    | "markdown"
    | "pdf"
    | "latex"
    | "json"
    | "jsonl"
    | "yaml"
    | "log"
    | "html"
    | "pptx"
    | "directory";
  exists: boolean;
  sizeBytes?: number | null;
  updatedAt?: string | null;
  purpose: string;
}

export interface ArisWorkflowStage {
  id: "W1" | "W1.5" | "W2" | "W3" | "W4" | "W5" | "W6";
  name: string;
  status: "pending" | "running" | "done" | "accepted" | "skipped" | "failed";
  crossModelAcquittal: boolean;
  artifacts: ArisWorkflowArtifact[];
  derivedFrom: "run_state" | "directory" | "claude_md";
}

export interface ArisWorkflowStatus {
  activeW: "W1" | "W1.5" | "W2" | "W3" | "W4" | "W5" | "W6" | null;
  stages: ArisWorkflowStage[];
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
  readWorkflowStatus(workspaceId: string): Promise<ArisWorkflowStatus>;
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
    async readWorkflowStatus(workspaceId: string): Promise<ArisWorkflowStatus> {
      const cwd = await resolveWorkspaceCwd(workspaceRegistry, workspaceId);
      const rawRun = await readMostRecentRunState(workspaceRegistry, workspaceId);
      const claudeMdStage = await readClaudeMdActiveStage(cwd);

      const phaseStatusMap = new Map<string, ArisWorkflowStage["status"]>();
      if (rawRun) {
        for (const phase of rawRun.phases) {
          if (phase.phase && WORKFLOW_STAGE_ID_SET.has(phase.phase)) {
            phaseStatusMap.set(phase.phase, toWorkflowStageStatus(phase.status));
          }
        }
      }

      const stages: ArisWorkflowStage[] = [];
      for (const stageId of WORKFLOW_STAGE_IDS) {
        stages.push(await deriveWorkflowStage(cwd, stageId, phaseStatusMap));
      }

      let activeW: ArisWorkflowStatus["activeW"] = null;
      for (const stage of stages) {
        if (stage.status === "running") {
          activeW = stage.id;
        }
      }
      if (activeW === null) {
        activeW = claudeMdStage;
      }

      return { activeW, stages };
    },
  };
}

// ── Workflow status (W1–W6) derivation helpers ──

type WorkflowStageId = "W1" | "W1.5" | "W2" | "W3" | "W4" | "W5" | "W6";

const WORKFLOW_STAGE_IDS: readonly WorkflowStageId[] = ["W1", "W1.5", "W2", "W3", "W4", "W5", "W6"];

const WORKFLOW_STAGE_ID_SET = new Set<string>(WORKFLOW_STAGE_IDS);

const WORKFLOW_STAGE_NAMES: Record<WorkflowStageId, string> = {
  W1: "Idea discovery",
  "W1.5": "Experiment bridge",
  W2: "Auto review loop",
  W3: "Paper writing",
  W4: "Rebuttal",
  W5: "Resubmit pipeline",
  W6: "Paper talk",
};

interface WorkflowArtifactSpec {
  path: string;
  kind: ArisWorkflowArtifact["kind"];
  purpose: string;
}

const WORKFLOW_ARTIFACTS: Record<WorkflowStageId, WorkflowArtifactSpec[]> = {
  W1: [
    { path: "idea-stage/IDEA_REPORT.md", kind: "markdown", purpose: "Ranked ideas report" },
    { path: "idea-stage/IDEA_CANDIDATES.md", kind: "markdown", purpose: "Idea candidate list" },
    {
      path: "idea-stage/docs/research_contract.md",
      kind: "markdown",
      purpose: "Research contract",
    },
    { path: "idea-stage/IDEA_REPORT.html", kind: "html", purpose: "Rendered idea report" },
  ],
  "W1.5": [
    { path: "refine-logs/EXPERIMENT_PLAN.md", kind: "markdown", purpose: "Experiment plan" },
    { path: "refine-logs/EXPERIMENT_TRACKER.md", kind: "markdown", purpose: "Experiment tracker" },
    { path: "refine-logs/EXPERIMENT_LOG.md", kind: "markdown", purpose: "Experiment log" },
    { path: "refine-logs/EXPERIMENT_RESULTS.md", kind: "markdown", purpose: "Experiment results" },
    { path: "refine-logs/FINAL_PROPOSAL.md", kind: "markdown", purpose: "Final proposal" },
  ],
  W2: [
    { path: "review-stage/REVIEW_STATE.json", kind: "json", purpose: "Review state" },
    { path: "review-stage/AUTO_REVIEW.md", kind: "markdown", purpose: "Auto review report" },
    {
      path: "review-stage/CLAIMS_FROM_RESULTS.md",
      kind: "markdown",
      purpose: "Claims from results",
    },
  ],
  W3: [
    { path: "paper/main.pdf", kind: "pdf", purpose: "Compiled paper" },
    { path: "paper/main.tex", kind: "latex", purpose: "Paper source" },
    { path: "paper/references.bib", kind: "latex", purpose: "Bibliography" },
    { path: "paper/PROOF_AUDIT.json", kind: "json", purpose: "Proof audit" },
    { path: "paper/PAPER_CLAIM_AUDIT.json", kind: "json", purpose: "Paper claim audit" },
    { path: "paper/CITATION_AUDIT.json", kind: "json", purpose: "Citation audit" },
    { path: "paper/KILL_ARGUMENT.json", kind: "json", purpose: "Kill argument" },
  ],
  W4: [
    { path: "rebuttal/REBUTTAL_STATE.md", kind: "markdown", purpose: "Rebuttal state" },
    { path: "rebuttal/REBUTTAL_DRAFT_v1.md", kind: "markdown", purpose: "Rebuttal draft v1" },
    { path: "rebuttal/REBUTTAL_DRAFT_rich.md", kind: "markdown", purpose: "Rich rebuttal draft" },
    { path: "rebuttal/PASTE_READY.txt", kind: "log", purpose: "Paste-ready rebuttal" },
    { path: "rebuttal/ISSUE_BOARD.md", kind: "markdown", purpose: "Issue board" },
    { path: "rebuttal/STRATEGY_PLAN.md", kind: "markdown", purpose: "Strategy plan" },
  ],
  W5: [],
  W6: [
    { path: "slides/SLIDE_OUTLINE.md", kind: "markdown", purpose: "Slide outline" },
    { path: "slides/main.pdf", kind: "pdf", purpose: "Slide deck PDF" },
    { path: "slides/main.tex", kind: "latex", purpose: "Slide source" },
    { path: "slides/presentation.pptx", kind: "pptx", purpose: "Presentation" },
    { path: "slides/presentation_polished.pptx", kind: "pptx", purpose: "Polished presentation" },
    { path: "slides/speaker_notes.md", kind: "markdown", purpose: "Speaker notes" },
    { path: "slides/TALK_SCRIPT.md", kind: "markdown", purpose: "Talk script" },
  ],
};

async function resolveWorkspaceCwd(
  workspaceRegistry: WorkspaceRegistry,
  workspaceId: string,
): Promise<string> {
  const workspace = await workspaceRegistry.get(workspaceId);
  if (!workspace || workspace.archivedAt !== null) {
    throw new ArisWorkspaceNotFoundError();
  }
  return workspace.cwd;
}

function toWorkflowStageStatus(status: unknown): ArisWorkflowStage["status"] {
  switch (status) {
    case "pending":
    case "running":
    case "done":
    case "accepted":
    case "skipped":
    case "failed":
      return status;
    case "completed":
      return "done";
    default:
      return "pending";
  }
}

interface RawRunPhase {
  phase: string;
  status: string;
}

interface RawRunState {
  runId: string;
  updatedAt: string;
  phases: RawRunPhase[];
}

async function readMostRecentRunState(
  workspaceRegistry: WorkspaceRegistry,
  workspaceId: string,
): Promise<RawRunState | null> {
  const cwd = await resolveWorkspaceCwd(workspaceRegistry, workspaceId);
  const runsDir = await resolveScopedPath({ root: cwd, relativePath: ARIS_RUNS_DIR }).catch(
    () => null,
  );
  if (!runsDir) {
    return null;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(runsDir.resolvedPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const runFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".done.json"),
  );
  if (runFiles.length === 0) {
    return null;
  }

  const candidates: Array<RawRunState & { mtime: number }> = [];
  for (const entry of runFiles) {
    const filePath = await resolveScopedPath({
      root: cwd,
      relativePath: `${ARIS_RUNS_DIR}/${entry.name}`,
    }).catch(() => null);
    if (!filePath) {
      continue;
    }
    const stats = await safeStat(filePath.resolvedPath);
    if (!stats || !stats.isFile()) {
      continue;
    }
    try {
      const content = await fs.readFile(filePath.resolvedPath, "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const phasesRaw = Array.isArray(parsed.phases) ? parsed.phases : [];
      const phases: RawRunPhase[] = phasesRaw
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .map((p) => ({
          phase:
            (typeof p.phase === "string" && p.phase) ||
            (typeof p.phaseId === "string" && p.phaseId) ||
            "",
          status: typeof p.status === "string" ? p.status : "pending",
        }));
      const updatedAt =
        (typeof parsed.updatedAt === "string" && parsed.updatedAt) ||
        (typeof parsed.updated === "string" && parsed.updated) ||
        "";
      const runId =
        (typeof parsed.runId === "string" && parsed.runId) ||
        (typeof parsed.run_id === "string" && parsed.run_id) ||
        entry.name.slice(0, -".json".length);
      candidates.push({ runId, updatedAt, phases, mtime: stats.mtimeMs });
    } catch {
      // Skip malformed run state files.
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
    const av = Number.isNaN(at) ? a.mtime : at;
    const bv = Number.isNaN(bt) ? b.mtime : bt;
    return bv - av;
  });
  const top = candidates[0];
  return { runId: top.runId, updatedAt: top.updatedAt, phases: top.phases };
}

async function readClaudeMdActiveStage(cwd: string): Promise<WorkflowStageId | null> {
  const scoped = await resolveScopedPath({ root: cwd, relativePath: "CLAUDE.md" }).catch(
    () => null,
  );
  if (!scoped) {
    return null;
  }
  const content = await fs.readFile(scoped.resolvedPath, "utf-8").catch(() => null);
  if (!content) {
    return null;
  }
  const sectionMatch = /^##\s+Pipeline Status\s*$/im.exec(content);
  if (!sectionMatch) {
    return null;
  }
  const rest = content.slice(sectionMatch.index + sectionMatch[0].length);
  const nextHeading = /^##\s+/m.exec(rest);
  const section =
    nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
  const stageMatch = /^stage:\s*(.+?)\s*$/im.exec(section);
  if (!stageMatch) {
    return null;
  }
  const idMatch = /(W1\.5|W[1-6])/.exec(stageMatch[1]);
  if (idMatch && WORKFLOW_STAGE_ID_SET.has(idMatch[1])) {
    return idMatch[1] as WorkflowStageId;
  }
  return null;
}

async function enumerateArtifacts(
  cwd: string,
  specs: WorkflowArtifactSpec[],
): Promise<ArisWorkflowArtifact[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const scoped = await resolveScopedPath({ root: cwd, relativePath: spec.path }).catch(
        () => null,
      );
      const stats = scoped ? await safeStat(scoped.resolvedPath) : null;
      const exists = !!stats && stats.isFile();
      return {
        path: spec.path,
        kind: spec.kind,
        exists,
        sizeBytes: exists ? stats.size : null,
        updatedAt: exists ? stats.mtime.toISOString() : null,
        purpose: spec.purpose,
      };
    }),
  );
}

function artifactExists(artifacts: ArisWorkflowArtifact[], relPath: string): boolean {
  return artifacts.some((artifact) => artifact.path === relPath && artifact.exists);
}

async function checkStageDirectoryDone(
  cwd: string,
  stageId: WorkflowStageId,
  artifacts: ArisWorkflowArtifact[],
): Promise<boolean> {
  switch (stageId) {
    case "W1":
      return artifactExists(artifacts, "idea-stage/IDEA_REPORT.md");
    case "W1.5": {
      if (!artifactExists(artifacts, "refine-logs/EXPERIMENT_TRACKER.md")) {
        return false;
      }
      const scoped = await resolveScopedPath({
        root: cwd,
        relativePath: "refine-logs/EXPERIMENT_TRACKER.md",
      }).catch(() => null);
      if (!scoped) {
        return false;
      }
      const content = await fs.readFile(scoped.resolvedPath, "utf-8").catch(() => "");
      return /\b(DONE|RUNNING)\b/i.test(content);
    }
    case "W2":
      return (
        artifactExists(artifacts, "review-stage/REVIEW_STATE.json") ||
        artifactExists(artifacts, "review-stage/AUTO_REVIEW.md")
      );
    case "W3":
      return artifactExists(artifacts, "paper/main.pdf");
    case "W4":
      return (
        artifactExists(artifacts, "rebuttal/REBUTTAL_STATE.md") ||
        artifactExists(artifacts, "rebuttal/PASTE_READY.txt")
      );
    case "W6":
      return (
        artifactExists(artifacts, "slides/main.pdf") ||
        artifactExists(artifacts, "slides/presentation.pptx")
      );
    default:
      return false;
  }
}

async function findResubmitVenueDir(cwd: string): Promise<string | null> {
  const parent = path.dirname(cwd);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  const cwdBase = path.basename(cwd);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === cwdBase) {
      continue;
    }
    const siblingPath = path.join(parent, entry.name);
    const reportScoped = await resolveScopedPath({
      root: siblingPath,
      relativePath: "RESUBMIT_REPORT.json",
    }).catch(() => null);
    const stats = reportScoped ? await safeStat(reportScoped.resolvedPath) : null;
    if (stats && stats.isFile()) {
      return siblingPath;
    }
  }
  return null;
}

async function enumerateW5Artifacts(
  cwd: string,
): Promise<{ artifacts: ArisWorkflowArtifact[]; found: boolean }> {
  const venueDir = await findResubmitVenueDir(cwd);
  if (!venueDir) {
    return { artifacts: [], found: false };
  }
  const venueName = path.basename(venueDir);
  const relDir = `../${venueName}`;

  const fileSpecs: Array<{
    file: string;
    rel: string;
    kind: ArisWorkflowArtifact["kind"];
    purpose: string;
  }> = [
    {
      file: "RESUBMIT_REPORT.json",
      rel: `${relDir}/RESUBMIT_REPORT.json`,
      kind: "json",
      purpose: "Resubmit report",
    },
    {
      file: "DIFF_REPORT.md",
      rel: `${relDir}/DIFF_REPORT.md`,
      kind: "markdown",
      purpose: "Diff report",
    },
  ];

  const fileArtifacts = await Promise.all(
    fileSpecs.map(async (spec) => {
      const scoped = await resolveScopedPath({
        root: venueDir,
        relativePath: spec.file,
      }).catch(() => null);
      const stats = scoped ? await safeStat(scoped.resolvedPath) : null;
      const exists = !!stats && stats.isFile();
      return {
        path: spec.rel,
        kind: spec.kind,
        exists,
        sizeBytes: exists ? stats.size : null,
        updatedAt: exists ? stats.mtime.toISOString() : null,
        purpose: spec.purpose,
      };
    }),
  );

  const dirStats = await safeStat(venueDir);
  const dirExists = !!dirStats && dirStats.isDirectory();
  const dirArtifact: ArisWorkflowArtifact = {
    path: relDir,
    kind: "directory",
    exists: dirExists,
    sizeBytes: null,
    updatedAt: dirExists ? dirStats.mtime.toISOString() : null,
    purpose: "Resubmit venue directory",
  };

  return { artifacts: [dirArtifact, ...fileArtifacts], found: true };
}

async function deriveWorkflowStage(
  cwd: string,
  stageId: WorkflowStageId,
  phaseStatusMap: Map<string, ArisWorkflowStage["status"]>,
): Promise<ArisWorkflowStage> {
  const name = WORKFLOW_STAGE_NAMES[stageId];

  let artifacts: ArisWorkflowArtifact[];
  let directoryDone: boolean;
  if (stageId === "W5") {
    const w5 = await enumerateW5Artifacts(cwd);
    artifacts = w5.artifacts;
    directoryDone = w5.found;
  } else {
    artifacts = await enumerateArtifacts(cwd, WORKFLOW_ARTIFACTS[stageId]);
    directoryDone = await checkStageDirectoryDone(cwd, stageId, artifacts);
  }

  let status: ArisWorkflowStage["status"];
  let derivedFrom: ArisWorkflowStage["derivedFrom"];
  const mapped = phaseStatusMap.get(stageId);
  if (mapped !== undefined) {
    status = mapped;
    derivedFrom = "run_state";
  } else {
    status = directoryDone ? "done" : "pending";
    derivedFrom = "directory";
  }

  return {
    id: stageId,
    name,
    status,
    crossModelAcquittal: status === "accepted",
    artifacts,
    derivedFrom,
  };
}
