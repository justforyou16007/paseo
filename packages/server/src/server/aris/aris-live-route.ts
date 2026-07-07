import type express from "express";
import type { Logger } from "pino";
import { extractHttpBearerToken, isBearerTokenValidSync } from "../auth.js";
import type { ArisDataService } from "./aris-data-service.js";

export interface ArisLiveRouteOptions {
  arisDataService: () => ArisDataService;
  logger: Logger;
  password?: string;
}

interface ArisLiveDelta {
  workspaceId: string;
  runId?: string;
  type: "run_updated" | "iteration_added" | "phase_completed";
  payload: unknown;
}

function formatSseEvent(event: string, data: unknown, id?: string): string {
  let output = `event: ${event}\n`;
  if (id !== undefined) {
    output += `id: ${id}\n`;
  }
  const lines = JSON.stringify(data).split("\n");
  for (const line of lines) {
    output += `data: ${line}\n`;
  }
  output += "\n";
  return output;
}

function buildInitialSnapshotId(): string {
  return `${Date.now()}-0`;
}

export function createArisLiveRouteHandler(options: ArisLiveRouteOptions): express.RequestHandler {
  const { logger, password } = options;

  return (req: express.Request, res: express.Response): void => {
    const arisDataService = options.arisDataService();
    const workspaceId = req.params.workspaceId;
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    const lastEventId =
      typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined;

    const token =
      extractHttpBearerToken(req.header("authorization")) ??
      (typeof req.query.token === "string" ? req.query.token : null);
    if (!isBearerTokenValidSync({ password, token })) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    void (async () => {
      try {
        const runs = await arisDataService.listRuns(workspaceId);
        if (runs.length === 0 && lastEventId === undefined) {
          // Workspace may exist with no runs; still open stream so future runs can stream.
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.status(200);
        res.flushHeaders?.();

        const initialSnapshotId = lastEventId ?? buildInitialSnapshotId();
        res.write(
          formatSseEvent(
            "aris.snapshot",
            {
              workspaceId,
              runId,
              runs: runId ? runs.filter((run) => run.runId === runId) : runs,
            },
            initialSnapshotId,
          ),
        );

        const controller = new AbortController();
        const cleanupPromise = arisDataService.watchRun(
          workspaceId,
          runId,
          () => {
            void (async () => {
              try {
                const latestRuns = await arisDataService.listRuns(workspaceId);
                const filteredRuns = runId
                  ? latestRuns.filter((run) => run.runId === runId)
                  : latestRuns;
                for (const run of filteredRuns) {
                  const delta: ArisLiveDelta = {
                    workspaceId,
                    runId: run.runId,
                    type: "run_updated",
                    payload: run,
                  };
                  res.write(formatSseEvent("aris.delta", delta, `${Date.now()}-${run.runId}`));
                }
              } catch (error) {
                logger.debug({ err: error, workspaceId, runId }, "Failed to emit ARIS live delta");
              }
            })();
          },
          controller.signal,
        );

        req.on("close", () => {
          controller.abort();
          cleanupPromise
            .then((cleanup) => cleanup())
            .catch((error) => {
              logger.debug({ err: error, workspaceId, runId }, "ARIS live cleanup failed");
            });
        });

        res.on("error", (error) => {
          logger.debug({ err: error, workspaceId, runId }, "ARIS live response error");
          controller.abort();
          cleanupPromise
            .then((cleanup) => cleanup())
            .catch((cleanupError) => {
              logger.debug(
                { err: cleanupError, workspaceId, runId },
                "ARIS live cleanup after response error failed",
              );
            });
        });
      } catch (error) {
        logger.debug({ err: error, workspaceId, runId }, "Failed to set up ARIS live stream");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to start ARIS live stream" });
        }
      }
    })();
  };
}
