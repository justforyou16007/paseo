import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "fs";
import path from "path";
import type pino from "pino";
import { load as yamlLoad } from "js-yaml";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  ArisEventsReadRequest,
  ArisExperimentsReadRequest,
  ArisIterationsReadRequest,
  ArisIterationsReadResponse,
  ArisReviewReadRequest,
  ArisRunReadRequest,
  ArisRunReadResponse,
  ArisRunsListRequest,
  ArisRunsListResponse,
  ArisWikiReadRequest,
  ArisWorkflowStatusReadRequest,
  ArisWorkflowStatusReadResponse,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { ArisDataService } from "../../aris/aris-data-service.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { readArisEvents, readArisReviewState } from "./aris-readers.js";
import { ArisStateWatcher, type ArisStateUpdate } from "./aris-watcher.js";
import { resolveScopedPath } from "../../file-explorer/service.js";

export interface ArisSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface ArisSessionOptions {
  host: ArisSessionHost;
  arisDataService: ArisDataService;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
}

interface ParsedMarkdownFile {
  id: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

interface WikiData {
  papers: Array<{
    id: string;
    title: string;
    content: string;
    authors: string[];
    year: number | null;
    url: string | null;
    tags: string[];
  }>;
  ideas: Array<{
    id: string;
    title: string;
    content: string;
    status: "seed" | "growing" | "validated" | "rejected";
    createdAt: string | null;
    relatedIdeaIds: string[];
    paperIds: string[];
  }>;
  experiments: Array<{
    id: string;
    title: string;
    content: string;
    ideaId: string | null;
    status: "planned" | "running" | "completed" | "failed";
    startedAt: string | null;
    completedAt: string | null;
    config: Record<string, unknown> | null;
  }>;
  claims: Array<{
    id: string;
    title: string;
    content: string;
    experimentId: string | null;
    ideaId: string | null;
    status: "proposed" | "confirmed" | "rejected";
    confidence: number | null;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relation: string;
    strength: number | null;
  }>;
  findings: string | null;
}

interface ExperimentRunData {
  id: string;
  metadata: WikiData["experiments"][number];
  env: Record<string, unknown> | null;
  logs: string | null;
  metrics: {
    timestamps: number[];
    series: Record<string, number[]>;
  } | null;
}

const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

/**
 * ARIS session handler — serves run state, iterations, wiki, experiments,
 * review state, and live events from a workspace's ARIS directories.
 *
 * Combines Wave 1/2 (run/iteration/wiki/experiment RPCs) with Wave 3
 * (review/events RPCs and file-based readers/watchers).
 */
export class ArisSession {
  private readonly host: ArisSessionHost;
  private readonly arisDataService: ArisDataService;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly watchers = new Map<string, ArisStateWatcher>();

  constructor(options: ArisSessionOptions) {
    this.host = options.host;
    this.arisDataService = options.arisDataService;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "aris-session" });
  }

  // ── Wave 1: run/iteration RPCs (via ArisDataService) ──

  async handleRunsListRequest(msg: ArisRunsListRequest): Promise<void> {
    try {
      const runs = await this.arisDataService.listRuns(msg.workspaceId);
      this.host.emit({
        type: "aris.runs.list.response",
        payload: {
          requestId: msg.requestId,
          runs,
        },
      } satisfies ArisRunsListResponse);
    } catch (error) {
      this.logger.warn({ err: error, requestId: msg.requestId }, "Failed to list ARIS runs");
      this.emitError(msg.requestId, "aris.runs.list.response", error);
    }
  }

  async handleRunReadRequest(msg: ArisRunReadRequest): Promise<void> {
    try {
      const run = await this.arisDataService.readRun(msg.workspaceId, msg.runId);
      this.host.emit({
        type: "aris.run.read.response",
        payload: {
          requestId: msg.requestId,
          run,
        },
      } satisfies ArisRunReadResponse);
    } catch (error) {
      this.logger.warn(
        { err: error, requestId: msg.requestId, runId: msg.runId },
        "Failed to read ARIS run",
      );
      this.emitError(msg.requestId, "aris.run.read.response", error);
    }
  }

  async handleIterationsReadRequest(msg: ArisIterationsReadRequest): Promise<void> {
    try {
      const { iterations, nextCursor } = await this.arisDataService.readIterations(
        msg.workspaceId,
        msg.runId,
        msg.phaseId ?? null,
        {
          limit: msg.limit,
          cursor: msg.cursor,
        },
      );
      this.host.emit({
        type: "aris.iterations.read.response",
        payload: {
          requestId: msg.requestId,
          iterations,
          nextCursor,
        },
      } satisfies ArisIterationsReadResponse);
    } catch (error) {
      this.logger.warn(
        { err: error, requestId: msg.requestId, runId: msg.runId },
        "Failed to read ARIS iterations",
      );
      this.emitError(msg.requestId, "aris.iterations.read.response", error);
    }
  }

  // ── Wave 2: wiki/experiment RPCs (direct file reads) ──

  async handleWikiReadRequest(msg: ArisWikiReadRequest): Promise<void> {
    const { cwd: workspaceCwd, requestId } = msg;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emitWikiError(requestId, "cwd is required");
      return;
    }

    try {
      const wiki = await this.readWiki(cwd);
      this.host.emit({
        type: "aris.wiki.read.response",
        payload: {
          requestId,
          ok: true,
          papers: wiki.papers,
          ideas: wiki.ideas,
          experiments: wiki.experiments,
          claims: wiki.claims,
          edges: wiki.edges,
          findings: wiki.findings,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, cwd, requestId }, "Failed to read ARIS wiki");
      this.emitWikiError(requestId, getErrorMessage(error));
    }
  }

  async handleExperimentsReadRequest(msg: ArisExperimentsReadRequest): Promise<void> {
    const { cwd: workspaceCwd, requestId, experimentId } = msg;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emitExperimentsError(requestId, "cwd is required");
      return;
    }

    try {
      const runs = await this.readExperiments(cwd, experimentId);
      this.host.emit({
        type: "aris.experiments.read.response",
        payload: {
          requestId,
          ok: true,
          experiments: runs,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, cwd, requestId }, "Failed to read ARIS experiments");
      this.emitExperimentsError(requestId, getErrorMessage(error));
    }
  }

  // ── Wave 3: review/events RPCs (aris-readers / watcher) ──

  async handleReviewReadRequest(msg: ArisReviewReadRequest): Promise<void> {
    const { cwd, requestId, runId } = msg;
    this.logger.debug({ cwd, requestId, runId }, "Handling aris.review.read request");

    try {
      const result = await readArisReviewState({ cwd, runId });
      await this.ensureWatcher(cwd, runId);
      this.host.emit({
        type: "aris.review.read.response",
        payload: {
          requestId,
          cwd,
          ok: true,
          reviewState: result.reviewState,
          autoReviewMarkdown: result.autoReviewMarkdown,
          paperImprovement: result.paperImprovement,
          audits: result.audits,
          pendingReview: result.pendingReview,
          traces: result.traces,
          knowledgeGraph: result.knowledgeGraph,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, cwd, requestId }, "Failed to read ARIS review state");
      this.host.emit({
        type: "aris.review.read.response",
        payload: {
          requestId,
          cwd,
          ok: false,
          reviewState: null,
          autoReviewMarkdown: null,
          paperImprovement: null,
          audits: [],
          pendingReview: null,
          traces: [],
          knowledgeGraph: null,
          error: message,
        },
      });
    }
  }

  async handleEventsReadRequest(msg: ArisEventsReadRequest): Promise<void> {
    const { cwd, requestId, limit, runId } = msg;
    this.logger.debug({ cwd, requestId, limit, runId }, "Handling aris.events.read request");

    try {
      const events = await readArisEvents({ cwd, limit, runId });
      this.host.emit({
        type: "aris.events.read.response",
        payload: {
          requestId,
          cwd,
          ok: true,
          events,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, cwd, requestId }, "Failed to read ARIS events");
      this.host.emit({
        type: "aris.events.read.response",
        payload: {
          requestId,
          cwd,
          ok: false,
          events: [],
          error: message,
        },
      });
    }
  }

  // ── Workflow status (W1–W6) RPC ──

  async handleWorkflowStatusReadRequest(msg: ArisWorkflowStatusReadRequest): Promise<void> {
    const { requestId, workspaceId } = msg;
    this.logger.debug({ requestId, workspaceId }, "Handling aris.workflow.status.read request");

    try {
      const status = await this.arisDataService.readWorkflowStatus(workspaceId);
      this.host.emit({
        type: "aris.workflow.status.read.response",
        payload: {
          requestId,
          ok: true,
          status,
          error: null,
        },
      } satisfies ArisWorkflowStatusReadResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { err: error, requestId, workspaceId },
        "Failed to read ARIS workflow status",
      );
      this.host.emit({
        type: "aris.workflow.status.read.response",
        payload: {
          requestId,
          ok: false,
          status: null,
          error: message,
        },
      } satisfies ArisWorkflowStatusReadResponse);
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
  }

  // ── Error helpers ──

  private emitError(
    requestId: string,
    type: "aris.runs.list.response" | "aris.run.read.response" | "aris.iterations.read.response",
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : "Failed to read ARIS data";
    switch (type) {
      case "aris.runs.list.response":
        this.host.emit({
          type,
          payload: { requestId, runs: [] },
        });
        break;
      case "aris.run.read.response":
        this.host.emit({
          type,
          payload: { requestId, run: null },
        });
        break;
      case "aris.iterations.read.response":
        this.host.emit({
          type,
          payload: { requestId, iterations: [], nextCursor: null },
        });
        break;
    }
    this.host.emit({
      type: "activity_log",
      payload: {
        id: randomUUID(),
        timestamp: new Date(),
        type: "error",
        content: `ARIS request failed: ${message}`,
      },
    });
  }

  private emitWikiError(requestId: string, error: string): void {
    this.host.emit({
      type: "aris.wiki.read.response",
      payload: {
        requestId,
        ok: false,
        error,
      },
    });
  }

  private emitExperimentsError(requestId: string, error: string): void {
    this.host.emit({
      type: "aris.experiments.read.response",
      payload: {
        requestId,
        ok: false,
        error,
      },
    });
  }

  // ── File readers ──

  private async readWiki(cwd: string): Promise<WikiData> {
    const root = await this.resolveWorkspaceRoot(cwd);

    const [papers, ideas, experiments, claims] = await Promise.all([
      this.readMarkdownDirectory(root, "research-wiki/papers"),
      this.readMarkdownDirectory(root, "research-wiki/ideas"),
      this.readMarkdownDirectory(root, "research-wiki/experiments"),
      this.readMarkdownDirectory(root, "research-wiki/claims"),
    ]);

    const edges = await this.readEdges(root);
    const findings = await this.readFindings(root);

    return {
      papers: papers.map((file) => this.toPaper(file)),
      ideas: ideas.map((file) => this.toIdea(file)),
      experiments: experiments.map((file) => this.toExperiment(file)),
      claims: claims.map((file) => this.toClaim(file)),
      edges,
      findings,
    };
  }

  private async readExperiments(cwd: string, experimentId?: string): Promise<ExperimentRunData[]> {
    const root = await this.resolveWorkspaceRoot(cwd);
    const wiki = await this.readWiki(cwd);

    let experiments = wiki.experiments;
    if (experimentId) {
      experiments = experiments.filter((experiment) => experiment.id === experimentId);
    }

    const env = await this.readExperimentEnv(root);

    const runs = await Promise.all(
      experiments.map(async (metadata) => {
        const { logs, metrics } = await this.readRefineLog(root, metadata.id);
        return {
          id: metadata.id,
          metadata,
          env,
          logs,
          metrics,
        };
      }),
    );

    return runs;
  }

  private async resolveWorkspaceRoot(cwd: string): Promise<string> {
    const resolved = await resolveScopedPath({ root: cwd, relativePath: "." });
    return resolved.resolvedPath;
  }

  private async readMarkdownDirectory(
    root: string,
    relativeDir: string,
  ): Promise<ParsedMarkdownFile[]> {
    const dirPath = await resolveScopedPath({ root, relativePath: relativeDir }).catch(() => null);
    if (!dirPath) {
      return [];
    }

    const entries = await fs.readdir(dirPath.resolvedPath).catch(() => [] as string[]);
    const mdNames = entries.filter((name) => name.endsWith(".md"));

    const parsed = await Promise.all(
      mdNames.map(async (name) => {
        const childPath = await resolveScopedPath({
          root,
          relativePath: `${relativeDir}/${name}`,
        }).catch(() => null);
        if (!childPath) {
          return null;
        }
        const content = await this.readTextFile(childPath.resolvedPath).catch(() => null);
        if (content === null) {
          return null;
        }
        const partial = parseMarkdownFile(content);
        return Object.assign(partial, { id: path.basename(name, ".md") });
      }),
    );

    return parsed
      .filter((file): file is ParsedMarkdownFile => file !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async readEdges(root: string): Promise<WikiData["edges"]> {
    const filePath = await resolveScopedPath({
      root,
      relativePath: "research-wiki/graph/edges.jsonl",
    }).catch(() => null);
    if (!filePath) {
      return [];
    }

    const content = await this.readTextFile(filePath.resolvedPath).catch(() => "");
    const edges: WikiData["edges"] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          typeof parsed.source === "string" &&
          typeof parsed.target === "string" &&
          typeof parsed.relation === "string"
        ) {
          edges.push({
            source: parsed.source,
            target: parsed.target,
            relation: parsed.relation,
            strength: typeof parsed.strength === "number" ? parsed.strength : null,
          });
        }
      } catch {
        // Skip malformed JSONL lines.
      }
    }
    return edges;
  }

  private async readFindings(root: string): Promise<string | null> {
    const filePath = await resolveScopedPath({ root, relativePath: "findings.md" }).catch(
      () => null,
    );
    if (!filePath) {
      return null;
    }
    return this.readTextFile(filePath.resolvedPath).catch(() => null);
  }

  private async readExperimentEnv(root: string): Promise<Record<string, unknown> | null> {
    const filePath = await resolveScopedPath({
      root,
      relativePath: ".aris/experiment-env.json",
    }).catch(() => null);
    if (!filePath) {
      return null;
    }
    const content = await this.readTextFile(filePath.resolvedPath).catch(() => null);
    if (!content) {
      return null;
    }
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async readRefineLog(
    root: string,
    experimentId: string,
  ): Promise<{ logs: string | null; metrics: ExperimentRunData["metrics"] }> {
    const filePath = await resolveScopedPath({
      root,
      relativePath: `refine-logs/EXPERIMENT_${experimentId}.md`,
    }).catch(() => null);
    if (!filePath) {
      return { logs: null, metrics: null };
    }

    const content = await this.readTextFile(filePath.resolvedPath).catch(() => null);
    if (!content) {
      return { logs: null, metrics: null };
    }

    const metrics = extractMetricsFromMarkdown(content);
    return { logs: content, metrics };
  }

  private async readTextFile(filePath: string): Promise<string> {
    const handle = await fs.open(filePath, READ_FILE_OPEN_FLAGS);
    try {
      const buffer = await handle.readFile();
      return buffer.toString("utf-8");
    } finally {
      await handle.close();
    }
  }

  private toPaper(file: ParsedMarkdownFile): WikiData["papers"][number] {
    const { frontmatter, content } = file;
    return {
      id: file.id,
      title: toString(frontmatter.title) ?? file.id,
      content,
      authors: toStringArray(frontmatter.authors),
      year: toNumberOrNull(frontmatter.year),
      url: toStringOrNull(frontmatter.url),
      tags: toStringArray(frontmatter.tags),
    };
  }

  private toIdea(file: ParsedMarkdownFile): WikiData["ideas"][number] {
    const { frontmatter, content } = file;
    return {
      id: file.id,
      title: toString(frontmatter.title) ?? file.id,
      content,
      status: toIdeaStatus(frontmatter.status),
      createdAt: toStringOrNull(frontmatter.createdAt),
      relatedIdeaIds: toStringArray(frontmatter.relatedIdeaIds),
      paperIds: toStringArray(frontmatter.paperIds),
    };
  }

  private toExperiment(file: ParsedMarkdownFile): WikiData["experiments"][number] {
    const { frontmatter, content } = file;
    return {
      id: file.id,
      title: toString(frontmatter.title) ?? file.id,
      content,
      ideaId: toStringOrNull(frontmatter.ideaId),
      status: toExperimentStatus(frontmatter.status),
      startedAt: toStringOrNull(frontmatter.startedAt),
      completedAt: toStringOrNull(frontmatter.completedAt),
      config: toRecordOrNull(frontmatter.config),
    };
  }

  private toClaim(file: ParsedMarkdownFile): WikiData["claims"][number] {
    const { frontmatter, content } = file;
    return {
      id: file.id,
      title: toString(frontmatter.title) ?? file.id,
      content,
      experimentId: toStringOrNull(frontmatter.experimentId),
      ideaId: toStringOrNull(frontmatter.ideaId),
      status: toClaimStatus(frontmatter.status),
      confidence: toNumberOrNull(frontmatter.confidence),
    };
  }

  private async ensureWatcher(cwd: string, runId: string | undefined): Promise<void> {
    const key = runId ? `${cwd}:${runId}` : cwd;
    if (this.watchers.has(key)) {
      return;
    }

    const watcher = new ArisStateWatcher({
      cwd,
      runId,
      onUpdate: (update) => {
        void this.handleWatcherUpdate(update);
      },
      logger: this.logger,
    });
    await watcher.start();
    this.watchers.set(key, watcher);
  }

  private async handleWatcherUpdate(update: ArisStateUpdate): Promise<void> {
    switch (update.kind) {
      case "review":
        this.host.emit({
          type: "aris.review.update",
          payload: {
            cwd: update.cwd,
            runId: update.runId,
            reviewState: update.reviewState ?? {
              version: "unknown",
              stage: "pending",
              rounds: [],
            },
          },
        });
        return;
      case "run_state":
      case "paper":
      case "wiki":
        await this.emitWorkflowUpdate(update.cwd);
        return;
      case "iteration_added":
        await this.emitIterationLogUpdate(update.cwd, update.runId, update.lines);
        return;
    }
  }

  private async emitWorkflowUpdate(cwd: string): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId(cwd);
    if (workspaceId === null) {
      this.logger.debug({ cwd }, "No workspace found for aris.workflow.update push");
      return;
    }
    try {
      const status = await this.arisDataService.readWorkflowStatus(workspaceId);
      this.host.emit({
        type: "aris.workflow.update",
        payload: { workspaceId, status },
      });
    } catch (error) {
      this.logger.warn({ err: error, cwd, workspaceId }, "Failed to emit aris.workflow.update");
    }
  }

  private async emitIterationLogUpdate(
    cwd: string,
    runId: string | undefined,
    lines: string[],
  ): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId(cwd);
    if (workspaceId === null) {
      this.logger.debug({ cwd }, "No workspace found for aris.iteration_log.update push");
      return;
    }
    this.host.emit({
      type: "aris.iteration_log.update",
      payload: { workspaceId, runId, lines },
    });
  }

  private async resolveWorkspaceId(cwd: string): Promise<string | null> {
    try {
      const workspaces = await this.workspaceRegistry.list();
      const target = path.resolve(cwd);
      const match = workspaces.find(
        (workspace) => workspace.archivedAt === null && path.resolve(workspace.cwd) === target,
      );
      return match?.workspaceId ?? null;
    } catch (error) {
      this.logger.warn({ err: error, cwd }, "Failed to resolve workspaceId from cwd");
      return null;
    }
  }
}

function parseMarkdownFile(content: string): Omit<ParsedMarkdownFile, "id"> {
  const frontmatterMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content);
  if (!frontmatterMatch) {
    return { content, frontmatter: {} };
  }

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = yamlLoad(frontmatterMatch[1]);
    frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    frontmatter = {};
  }

  const bodyStart = frontmatterMatch[0].length;
  return {
    content: content.slice(bodyStart).trimStart(),
    frontmatter,
  };
}

function toString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function toStringOrNull(value: unknown): string | null {
  return toString(value) ?? null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toIdeaStatus(value: unknown): WikiData["ideas"][number]["status"] {
  if (value === "seed" || value === "growing" || value === "validated" || value === "rejected") {
    return value;
  }
  return "seed";
}

function toExperimentStatus(value: unknown): WikiData["experiments"][number]["status"] {
  if (value === "planned" || value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  return "planned";
}

function toClaimStatus(value: unknown): WikiData["claims"][number]["status"] {
  if (value === "proposed" || value === "confirmed" || value === "rejected") {
    return value;
  }
  return "proposed";
}

function extractMetricsFromMarkdown(content: string): ExperimentRunData["metrics"] {
  const metricsMatch = /##\s*Metrics\s*\n+```json\s*\n([\s\S]*?)\n```/.exec(content);
  if (!metricsMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(metricsMatch[1]) as Record<string, unknown>;
    const timestamps = Array.isArray(parsed.timestamps)
      ? parsed.timestamps.filter((item): item is number => typeof item === "number")
      : [];
    const series: Record<string, number[]> = {};
    if (parsed.series && typeof parsed.series === "object" && !Array.isArray(parsed.series)) {
      for (const [key, value] of Object.entries(parsed.series)) {
        if (Array.isArray(value)) {
          series[key] = value.filter((item): item is number => typeof item === "number");
        }
      }
    }
    return { timestamps, series };
  } catch {
    return null;
  }
}
