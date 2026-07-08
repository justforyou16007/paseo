import { promises as fs, unwatchFile, watchFile } from "node:fs";
import type pino from "pino";
import { resolveScopedPath } from "../../file-explorer/service.js";
import { readArisReviewState } from "./aris-readers.js";
import type { ArisReviewState } from "@getpaseo/protocol/messages";

/**
 * Discriminated union of file-change updates emitted by {@link ArisStateWatcher}.
 *
 * Each variant corresponds to one of the watched ARIS project files:
 * - `review`          -> `review-stage/REVIEW_STATE.json` (content re-read)
 * - `run_state`       -> `.aris/runs/<runId>.json` (mtime change)
 * - `iteration_added` -> `.aris/runs/<runId>.iterations.jsonl` (newly appended lines)
 * - `paper`           -> `paper/main.pdf` (mtime change)
 * - `wiki`            -> `research-wiki/index.md` (mtime change)
 */
export type ArisStateUpdate =
  | { kind: "review"; cwd: string; runId?: string; reviewState: ArisReviewState | null }
  | { kind: "run_state"; cwd: string; runId?: string }
  | { kind: "iteration_added"; cwd: string; runId?: string; lines: string[] }
  | { kind: "paper"; cwd: string; runId?: string }
  | { kind: "wiki"; cwd: string; runId?: string };

export interface ArisStateWatcherOptions {
  cwd: string;
  runId?: string;
  onUpdate: (update: ArisStateUpdate) => void;
  logger: pino.Logger;
}

type WatchTarget = "review" | "run_state" | "iteration_log" | "paper" | "wiki";

interface WatchedFile {
  target: WatchTarget;
  path: string;
}

const DEBOUNCE_MS = 200;
const WATCH_INTERVAL_MS = 500;

const WATCH_TARGETS: readonly WatchTarget[] = [
  "review",
  "run_state",
  "iteration_log",
  "paper",
  "wiki",
];

/**
 * Watches multiple ARIS project files for a single `${cwd}:${runId}` scope and
 * emits typed {@link ArisStateUpdate} events on change. All files are polled via
 * `fs.watchFile` (500 ms interval) and coalesced through a single 200 ms debounce.
 *
 * Run-specific targets (`.aris/runs/<runId>.json` and `.iterations.jsonl`) are
 * only watched when `runId` is provided; the cwd-relative targets
 * (`REVIEW_STATE.json`, `paper/main.pdf`, `research-wiki/index.md`) are always
 * watched.
 */
export class ArisStateWatcher {
  private readonly cwd: string;
  private readonly runId: string | undefined;
  private readonly onUpdate: (update: ArisStateUpdate) => void;
  private readonly logger: pino.Logger;
  private readonly watchedFiles: WatchedFile[] = [];
  private readonly dirtyTargets = new Set<WatchTarget>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private active = true;
  private lastIterationOffset = 0;

  constructor(options: ArisStateWatcherOptions) {
    this.cwd = options.cwd;
    this.runId = options.runId;
    this.onUpdate = options.onUpdate;
    this.logger = options.logger.child({ module: "aris-state-watcher", cwd: options.cwd });
  }

  async start(): Promise<void> {
    if (!this.active) {
      return;
    }

    for (const target of WATCH_TARGETS) {
      const relativePath = this.relativePathForTarget(target);
      if (relativePath === null) {
        continue;
      }
      try {
        const resolved = await resolveScopedPath({ root: this.cwd, relativePath });
        this.watchedFiles.push({ target, path: resolved.resolvedPath });
      } catch (error) {
        this.logger.debug(
          { err: error, target },
          "Failed to resolve ARIS watch path; skipping target",
        );
      }
    }

    if (this.watchedFiles.length === 0) {
      this.logger.debug("No ARIS files available to watch");
      return;
    }

    await this.initIterationOffset();

    for (const watched of this.watchedFiles) {
      watchFile(watched.path, { interval: WATCH_INTERVAL_MS }, (current, previous) => {
        if (!this.active) {
          return;
        }
        if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
          return;
        }
        this.markDirty(watched.target);
      });
    }

    this.logger.debug(
      { targets: this.watchedFiles.map((w) => w.target) },
      "Started watching ARIS state",
    );
  }

  stop(): void {
    this.active = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.dirtyTargets.clear();
    for (const watched of this.watchedFiles) {
      unwatchFile(watched.path);
    }
    this.watchedFiles.length = 0;
    this.logger.debug("Stopped watching ARIS state");
  }

  private relativePathForTarget(target: WatchTarget): string | null {
    switch (target) {
      case "review":
        return "review-stage/REVIEW_STATE.json";
      case "paper":
        return "paper/main.pdf";
      case "wiki":
        return "research-wiki/index.md";
      case "run_state":
        return this.runId ? `.aris/runs/${this.runId}.json` : null;
      case "iteration_log":
        return this.runId ? `.aris/runs/${this.runId}.iterations.jsonl` : null;
    }
  }

  private async initIterationOffset(): Promise<void> {
    const iterationFile = this.watchedFiles.find((w) => w.target === "iteration_log");
    if (!iterationFile) {
      return;
    }
    try {
      const stats = await fs.stat(iterationFile.path);
      this.lastIterationOffset = stats.size;
    } catch (error) {
      if (!isMissingEntryError(error)) {
        this.logger.debug({ err: error }, "Failed to stat iteration log; starting at offset 0");
      }
      this.lastIterationOffset = 0;
    }
  }

  private markDirty(target: WatchTarget): void {
    this.dirtyTargets.add(target);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.processDirty();
    }, DEBOUNCE_MS);
  }

  private async processDirty(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.debounceTimer = null;
    const targets = [...this.dirtyTargets];
    this.dirtyTargets.clear();

    for (const target of targets) {
      try {
        await this.processTarget(target);
      } catch (error) {
        this.logger.warn({ err: error, target }, "Failed to process ARIS state change");
      }
    }
  }

  private async processTarget(target: WatchTarget): Promise<void> {
    switch (target) {
      case "review":
        await this.emitReviewUpdate();
        return;
      case "iteration_log":
        await this.emitIterationUpdate();
        return;
      case "run_state":
        this.onUpdate({ kind: "run_state", cwd: this.cwd, runId: this.runId });
        return;
      case "paper":
        this.onUpdate({ kind: "paper", cwd: this.cwd, runId: this.runId });
        return;
      case "wiki":
        this.onUpdate({ kind: "wiki", cwd: this.cwd, runId: this.runId });
        return;
    }
  }

  private async emitReviewUpdate(): Promise<void> {
    const result = await readArisReviewState({ cwd: this.cwd, runId: this.runId });
    this.onUpdate({
      kind: "review",
      cwd: this.cwd,
      runId: this.runId,
      reviewState: result.reviewState,
    });
  }

  private async emitIterationUpdate(): Promise<void> {
    const iterationFile = this.watchedFiles.find((w) => w.target === "iteration_log");
    if (!iterationFile) {
      return;
    }
    const lines = await this.readIterationDelta(iterationFile.path);
    if (lines.length === 0) {
      return;
    }
    this.onUpdate({
      kind: "iteration_added",
      cwd: this.cwd,
      runId: this.runId,
      lines,
    });
  }

  private async readIterationDelta(filePath: string): Promise<string[]> {
    let stats: import("node:fs").Stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      if (!isMissingEntryError(error)) {
        this.logger.debug({ err: error }, "Failed to stat iteration log for delta read");
      }
      return [];
    }

    const size = stats.size;
    if (size <= this.lastIterationOffset) {
      // File shrank or was replaced; reset the cursor without emitting stale lines.
      this.lastIterationOffset = size;
      return [];
    }

    const handle = await fs.open(filePath, "r");
    try {
      const length = size - this.lastIterationOffset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.lastIterationOffset);
      this.lastIterationOffset = size;
      return buffer
        .toString("utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } finally {
      await handle.close();
    }
  }
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * @deprecated Use ArisStateWatcher. Kept until 2027-01 for back-compat. COMPAT(arisCockpitGraph)
 */
export type ArisReviewWatcher = ArisStateWatcher;
