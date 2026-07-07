import { randomUUID } from "node:crypto";
import type {
  ArisIterationsReadRequest,
  ArisIterationsReadResponse,
  ArisRunReadRequest,
  ArisRunReadResponse,
  ArisRunsListRequest,
  ArisRunsListResponse,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { ArisDataService } from "./aris-data-service.js";

export interface ArisSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export interface ArisSessionOptions {
  host: ArisSessionHost;
  arisDataService: ArisDataService;
  logger: Logger;
}

export class ArisSession {
  private readonly host: ArisSessionHost;
  private readonly arisDataService: ArisDataService;
  private readonly logger: Logger;

  constructor(options: ArisSessionOptions) {
    this.host = options.host;
    this.arisDataService = options.arisDataService;
    this.logger = options.logger.child({ module: "aris-session" });
  }

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
}
