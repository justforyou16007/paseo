import type pino from "pino";
import type {
  ArisEventsReadRequest,
  ArisReviewReadRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { readArisEvents, readArisReviewState } from "./aris-readers.js";
import { ArisReviewWatcher } from "./aris-watcher.js";

export interface ArisSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ArisSessionOptions {
  host: ArisSessionHost;
  logger: pino.Logger;
}

export class ArisSession {
  private readonly host: ArisSessionHost;
  private readonly logger: pino.Logger;
  private readonly watchers = new Map<string, ArisReviewWatcher>();

  constructor(options: ArisSessionOptions) {
    this.host = options.host;
    this.logger = options.logger;
  }

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

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
  }

  private async ensureWatcher(cwd: string, runId: string | undefined): Promise<void> {
    const key = runId ? `${cwd}:${runId}` : cwd;
    if (this.watchers.has(key)) {
      return;
    }

    const watcher = new ArisReviewWatcher({
      cwd,
      runId,
      onUpdate: (update) => {
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
      },
      logger: this.logger,
    });
    await watcher.start();
    this.watchers.set(key, watcher);
  }
}
