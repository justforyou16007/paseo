import type express from "express";
import type { Logger } from "pino";
import { extractHttpBearerToken, isBearerTokenValidSync } from "../auth.js";
import type { ArisDataService } from "./aris-data-service.js";
import { ArisStateWatcher } from "../session/aris/aris-watcher.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

export interface ArisLiveRouteOptions {
  arisDataService: () => ArisDataService;
  workspaceRegistry: () => WorkspaceRegistry;
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

async function emitLatestDeltas(
  arisDataService: ArisDataService,
  res: express.Response,
  _logger: Logger,
  workspaceId: string,
  runId: string | undefined,
): Promise<void> {
  const latestRuns = await arisDataService.listRuns(workspaceId);
  const filteredRuns = runId ? latestRuns.filter((run) => run.runId === runId) : latestRuns;
  for (const run of filteredRuns) {
    const delta: ArisLiveDelta = {
      workspaceId,
      runId: run.runId,
      type: "run_updated",
      payload: run,
    };
    res.write(formatSseEvent("aris.delta", delta, `${Date.now()}-${run.runId}`));
  }
}

function buildInitialSnapshotId(): string {
  return `${Date.now()}-0`;
}

export function createArisLiveRouteHandler(options: ArisLiveRouteOptions): express.RequestHandler {
  const { logger, password } = options;

  return (req: express.Request, res: express.Response): void => {
    const arisDataService = options.arisDataService();
    const workspaceRegistry = options.workspaceRegistry();
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
        let stateWatcher: ArisStateWatcher | null = null;

        const handleRunChange = (): void => {
          emitLatestDeltas(arisDataService, res, logger, workspaceId, runId).catch((error) => {
            logger.debug({ err: error, workspaceId, runId }, "Failed to emit ARIS live delta");
          });
        };

        const handleIterationAdded = (lines: string[]): void => {
          const delta: ArisLiveDelta = {
            workspaceId,
            runId,
            type: "iteration_added",
            payload: { lines },
          };
          res.write(formatSseEvent("aris.delta", delta, `${Date.now()}-iter`));
        };

        // Existing run/iteration file watcher - keeps the original SSE semantics
        // (emits run_updated deltas) and covers the "watch all runs" case
        // (runId === undefined) that the per-run state watcher cannot.
        const cleanupPromise = arisDataService.watchRun(
          workspaceId,
          runId,
          handleRunChange,
          controller.signal,
        );

        // New event sources: the multi-file ArisStateWatcher surfaces changes to
        // paper/main.pdf, research-wiki/index.md and the run-state file as
        // run_updated deltas, and newly appended iteration-log lines as
        // iteration_added deltas. Review-state changes are pushed over the
        // WebSocket session (aris.review.update), not the SSE stream.
        try {
          const workspace = await workspaceRegistry.get(workspaceId);
          if (workspace && workspace.archivedAt === null) {
            stateWatcher = new ArisStateWatcher({
              cwd: workspace.cwd,
              runId,
              onUpdate: (update) => {
                switch (update.kind) {
                  case "review":
                    return;
                  case "run_state":
                  case "paper":
                  case "wiki":
                    handleRunChange();
                    return;
                  case "iteration_added":
                    handleIterationAdded(update.lines);
                    return;
                }
              },
              logger,
            });
            await stateWatcher.start();
          }
        } catch (error) {
          logger.debug({ err: error, workspaceId }, "Failed to start ARIS state watcher for SSE");
        }

        const performCleanup = (): void => {
          controller.abort();
          stateWatcher?.stop();
          cleanupPromise
            .then((cleanup) => cleanup())
            .catch((error) => {
              logger.debug({ err: error, workspaceId, runId }, "ARIS live cleanup failed");
            });
        };

        req.on("close", performCleanup);
        res.on("error", () => performCleanup());
      } catch (error) {
        logger.debug({ err: error, workspaceId, runId }, "Failed to set up ARIS live stream");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to start ARIS live stream" });
        }
      }
    })();
  };
}
