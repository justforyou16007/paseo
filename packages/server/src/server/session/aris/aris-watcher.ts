import { watchFile, unwatchFile } from "node:fs";
import type pino from "pino";
import { resolveScopedPath } from "@server/server/file-explorer/service.js";
import { readArisReviewState } from "./aris-readers.js";
import type { ArisReviewState } from "@getpaseo/protocol/messages";

export interface ArisReviewUpdate {
  cwd: string;
  runId?: string;
  reviewState: ArisReviewState | null;
}

export interface ArisReviewWatcherOptions {
  cwd: string;
  runId?: string;
  onUpdate: (update: ArisReviewUpdate) => void;
  logger: pino.Logger;
}

const DEBOUNCE_MS = 200;
const WATCH_INTERVAL_MS = 500;

export class ArisReviewWatcher {
  private readonly cwd: string;
  private readonly runId: string | undefined;
  private readonly onUpdate: (update: ArisReviewUpdate) => void;
  private readonly logger: pino.Logger;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private active = true;
  private watchedFilePath: string | null = null;

  constructor(options: ArisReviewWatcherOptions) {
    this.cwd = options.cwd;
    this.runId = options.runId;
    this.onUpdate = options.onUpdate;
    this.logger = options.logger.child({ module: "aris-review-watcher", cwd: options.cwd });
  }

  async start(): Promise<void> {
    if (!this.active) {
      return;
    }

    try {
      const resolved = await resolveScopedPath({
        root: this.cwd,
        relativePath: "review-stage/REVIEW_STATE.json",
      });
      this.watchedFilePath = resolved.resolvedPath;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to resolve review state path for watching");
      return;
    }

    watchFile(this.watchedFilePath, { interval: WATCH_INTERVAL_MS }, (current, previous) => {
      if (!this.active) {
        return;
      }
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      this.handleChange();
    });

    this.logger.debug({ watchedFilePath: this.watchedFilePath }, "Started watching review state");
  }

  stop(): void {
    this.active = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watchedFilePath) {
      unwatchFile(this.watchedFilePath);
    }
    this.logger.debug("Stopped watching review state");
  }

  private handleChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.emitLatestReviewState();
    }, DEBOUNCE_MS);
  }

  private async emitLatestReviewState(): Promise<void> {
    if (!this.active) {
      return;
    }
    try {
      const result = await readArisReviewState({ cwd: this.cwd, runId: this.runId });
      this.onUpdate({
        cwd: this.cwd,
        runId: this.runId,
        reviewState: result.reviewState,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to emit latest ARIS review state");
    }
  }
}
