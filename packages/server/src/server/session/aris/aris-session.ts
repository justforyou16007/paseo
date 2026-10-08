import { constants, promises as fs } from "fs";
import path from "path";
import type pino from "pino";
import { load as yamlLoad } from "js-yaml";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  ArisEventsReadRequest,
  ArisExperimentsReadRequest,
  ArisIterationsReadRequest,
  ArisReviewReadRequest,
  ArisRunReadRequest,
  ArisRunsListRequest,
  ArisWikiEntityReadRequest,
  ArisWikiReadRequest,
  ArisWorkflowStatusReadRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { ArisWikiWatcher } from "./aris-wiki-watcher.js";
import { resolveScopedPath } from "../../file-explorer/service.js";

export interface ArisSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface ArisSessionOptions {
  host: ArisSessionHost;
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
  problems: Array<{
    id: string;
    title: string;
    content: string;
    status: "open" | "solved" | "refuted" | "deferred";
    severity: "high" | "medium" | "low";
    parent: string | null;
    tags: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    relation: string;
    strength: number | null;
  }>;
  findings: string | null;
}

const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

const REMOVED_REQUEST_ERROR = "ARIS pipeline views were removed from this host. Update the app.";

/**
 * ARIS session handler. Serves the research wiki behind the knowledge graph
 * and pushes `aris.wiki.update` when a workspace's wiki changes.
 */
export class ArisSession {
  private readonly host: ArisSessionHost;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly watchers = new Map<string, ArisWikiWatcher>();

  constructor(options: ArisSessionOptions) {
    this.host = options.host;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "aris-session" });
  }

  async handleWikiReadRequest(msg: ArisWikiReadRequest): Promise<void> {
    const { cwd: workspaceCwd, requestId } = msg;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emitWikiError(requestId, "cwd is required");
      return;
    }

    try {
      const wiki = await this.readWiki(cwd);
      await this.ensureWatcher(cwd);
      this.host.emit({
        type: "aris.wiki.read.response",
        payload: {
          requestId,
          ok: true,
          papers: wiki.papers,
          ideas: wiki.ideas,
          experiments: wiki.experiments,
          claims: wiki.claims,
          problems: wiki.problems,
          edges: wiki.edges,
          findings: wiki.findings,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, cwd, requestId }, "Failed to read ARIS wiki");
      this.emitWikiError(requestId, getErrorMessage(error));
    }
  }

  // Read a single research-wiki entity (paper / idea / experiment /
  // claim) for the click-to-detail panel. Resolves the workspace, then
  // reads `research-wiki/{entityType}/{entityId}.md` and returns the raw
  // content. The entityId is the on-disk `node_id` from frontmatter (e.g.
  // `idea:gbdt-cost-sensitive-threshold`); the file's basename matches the
  // slug after the colon, so we strip the type prefix before reading.
  async handleWikiEntityReadRequest(msg: ArisWikiEntityReadRequest): Promise<void> {
    const { cwd: workspaceCwd, requestId, entityType, entityId } = msg;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emitWikiEntityError(requestId, entityType, entityId, "cwd is required");
      return;
    }

    const normalizedEntityType = entityType.trim();
    const normalizedEntityId = entityId.trim();
    if (!normalizedEntityType) {
      this.emitWikiEntityError(requestId, entityType, entityId, "entityType is required");
      return;
    }
    if (!normalizedEntityId) {
      this.emitWikiEntityError(requestId, entityType, entityId, "entityId is required");
      return;
    }

    try {
      const root = await this.resolveWorkspaceRoot(cwd);
      const slug = normalizedEntityId.includes(":")
        ? normalizedEntityId.split(":").slice(1).join(":")
        : normalizedEntityId;
      const relativePath =
        normalizedEntityType === "gap"
          ? "research-wiki/gap_map.md"
          : `research-wiki/${normalizedEntityType}/${slug}.md`;
      const filePath = await resolveScopedPath({ root, relativePath });
      const content = await this.readTextFile(filePath.resolvedPath);
      this.host.emit({
        type: "aris.wiki.entity.read.response",
        payload: {
          requestId,
          ok: true,
          content,
          entityType: normalizedEntityType,
          entityId: normalizedEntityId,
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, cwd, requestId, entityType, entityId },
        "Failed to read ARIS wiki entity",
      );
      this.emitWikiEntityError(requestId, entityType, entityId, getErrorMessage(error));
    }
  }

  // COMPAT(aris-pipeline-removal): added in v0.10.0, remove after 2027-04-01.
  // Apps from before the removal still open the cockpit, review and workflow
  // views. Answer them with empty results so their requests do not time out.
  replyToRemovedRequest(
    msg:
      | ArisRunsListRequest
      | ArisRunReadRequest
      | ArisIterationsReadRequest
      | ArisExperimentsReadRequest
      | ArisReviewReadRequest
      | ArisEventsReadRequest
      | ArisWorkflowStatusReadRequest,
  ): void {
    const { requestId } = msg;
    const error = REMOVED_REQUEST_ERROR;
    switch (msg.type) {
      case "aris.runs.list.request":
        this.host.emit({ type: "aris.runs.list.response", payload: { requestId, runs: [] } });
        return;
      case "aris.run.read.request":
        this.host.emit({ type: "aris.run.read.response", payload: { requestId, run: null } });
        return;
      case "aris.iterations.read.request":
        this.host.emit({
          type: "aris.iterations.read.response",
          payload: { requestId, iterations: [], nextCursor: null },
        });
        return;
      case "aris.experiments.read":
        this.host.emit({
          type: "aris.experiments.read.response",
          payload: { requestId, ok: false, error },
        });
        return;
      case "aris.review.read":
        this.host.emit({
          type: "aris.review.read.response",
          payload: {
            requestId,
            cwd: msg.cwd,
            ok: false,
            reviewState: null,
            autoReviewMarkdown: null,
            paperImprovement: null,
            audits: [],
            pendingReview: null,
            traces: [],
            knowledgeGraph: null,
            error,
          },
        });
        return;
      case "aris.events.read":
        this.host.emit({
          type: "aris.events.read.response",
          payload: { requestId, cwd: msg.cwd, ok: false, events: [], error },
        });
        return;
      case "aris.workflow.status.read":
        this.host.emit({
          type: "aris.workflow.status.read.response",
          payload: { requestId, ok: false, status: null, error },
        });
        return;
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
  }

  // ── Error helpers ──

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

  private emitWikiEntityError(
    requestId: string,
    entityType: string,
    entityId: string,
    error: string,
  ): void {
    this.host.emit({
      type: "aris.wiki.entity.read.response",
      payload: {
        requestId,
        ok: false,
        entityType,
        entityId,
        error,
      },
    });
  }

  // ── File readers ──

  private async readWiki(cwd: string): Promise<WikiData> {
    const root = await this.resolveWorkspaceRoot(cwd);

    const [papers, ideas, experiments, claims, problems] = await Promise.all([
      this.readMarkdownDirectory(root, "research-wiki/papers"),
      this.readMarkdownDirectory(root, "research-wiki/ideas"),
      this.readMarkdownDirectory(root, "research-wiki/experiments"),
      this.readMarkdownDirectory(root, "research-wiki/claims"),
      this.readMarkdownDirectory(root, "research-wiki/problems"),
    ]);

    const edges = await this.readEdges(root);
    const findings = await this.readFindings(root);

    return {
      papers: papers.map((file) => this.toPaper(file)),
      ideas: ideas.map((file) => this.toIdea(file)),
      experiments: experiments.map((file) => this.toExperiment(file)),
      claims: claims.map((file) => this.toClaim(file)),
      problems: problems.map((file) => this.toProblem(file)),
      edges,
      findings,
    };
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
        // Prefer the on-disk `node_id` from YAML frontmatter (e.g.
        // `node_id: idea:gbdt-cost-sensitive-threshold`) so node ids match
        // edge endpoints in `graph/edges.jsonl`. Fall back to the file
        // basename only when the frontmatter omits `node_id`.
        const frontmatterId = toStringOrNull(partial.frontmatter.node_id);
        return Object.assign(partial, {
          id: frontmatterId ?? path.basename(name, ".md"),
        });
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
        // Accept BOTH the on-disk schema (`from` / `to` / `type` /
        // `evidence` / `added`) emitted by the research-wiki tool and the
        // wire-format keys (`source` / `target` / `relation` / `strength`).
        // Normalize into the wire shape so the renderer doesn't have to know
        // about either variant. `strength` falls back to `evidence` when
        // present so callers can encode relationship strength either way.
        const source = pickString(parsed.source) ?? pickString(parsed.from);
        const target = pickString(parsed.target) ?? pickString(parsed.to);
        const relation = pickString(parsed.relation) ?? pickString(parsed.type);
        if (!source || !target || !relation) {
          continue;
        }
        const strength = typeof parsed.strength === "number" ? parsed.strength : null;
        edges.push({
          source,
          target,
          relation,
          strength,
        });
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

  private toProblem(file: ParsedMarkdownFile): WikiData["problems"][number] {
    const { frontmatter, content } = file;
    return {
      id: file.id,
      title: toString(frontmatter.title) ?? file.id,
      content,
      status: toProblemStatus(frontmatter.status),
      severity: toProblemSeverity(frontmatter.severity),
      parent: toStringOrNull(frontmatter.parent),
      tags: toStringArray(frontmatter.tags),
    };
  }

  private async ensureWatcher(cwd: string): Promise<void> {
    if (this.watchers.has(cwd)) {
      return;
    }
    const watcher = new ArisWikiWatcher({
      cwd,
      onChange: () => {
        void this.emitWikiUpdate(cwd);
      },
      logger: this.logger,
    });
    this.watchers.set(cwd, watcher);
    await watcher.start();
  }

  private async emitWikiUpdate(cwd: string): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId(cwd);
    if (workspaceId === null) {
      this.logger.debug({ cwd }, "No workspace found for aris.wiki.update push");
      return;
    }
    this.host.emit({
      type: "aris.wiki.update",
      payload: { workspaceId },
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

function pickString(value: unknown): string | null {
  return toString(value) ?? null;
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

function toProblemStatus(value: unknown): WikiData["problems"][number]["status"] {
  if (value === "open" || value === "solved" || value === "refuted" || value === "deferred") {
    return value;
  }
  return "open";
}

function toProblemSeverity(value: unknown): WikiData["problems"][number]["severity"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}
