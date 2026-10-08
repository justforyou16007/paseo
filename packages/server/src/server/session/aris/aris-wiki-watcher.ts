import { unwatchFile, watchFile } from "node:fs";
import type pino from "pino";
import { resolveScopedPath } from "../../file-explorer/service.js";

export interface ArisWikiWatcherOptions {
  cwd: string;
  onChange: () => void;
  logger: pino.Logger;
}

const DEBOUNCE_MS = 200;
const WATCH_INTERVAL_MS = 500;
// The wiki projector rewrites index.md on every change, so one file covers
// pages and edges alike.
const WIKI_INDEX = "research-wiki/index.md";

/**
 * Polls a workspace's research-wiki index and calls `onChange` (debounced)
 * when it changes. `fs.watchFile` polls a path that may not exist yet, so a
 * wiki created after the graph was opened is still picked up.
 */
export class ArisWikiWatcher {
  private readonly cwd: string;
  private readonly onChange: () => void;
  private readonly logger: pino.Logger;
  private watchedPath: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private active = true;

  constructor(options: ArisWikiWatcherOptions) {
    this.cwd = options.cwd;
    this.onChange = options.onChange;
    this.logger = options.logger.child({ module: "aris-wiki-watcher", cwd: options.cwd });
  }

  async start(): Promise<void> {
    if (!this.active || this.watchedPath) {
      return;
    }
    let watchedPath: string;
    try {
      watchedPath = (await resolveScopedPath({ root: this.cwd, relativePath: WIKI_INDEX }))
        .resolvedPath;
    } catch (error) {
      this.logger.debug({ err: error }, "Cannot resolve the wiki index; not watching");
      return;
    }
    if (!this.active) {
      return;
    }
    this.watchedPath = watchedPath;
    watchFile(watchedPath, { interval: WATCH_INTERVAL_MS }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.active) {
          this.onChange();
        }
      }, DEBOUNCE_MS);
    });
  }

  stop(): void {
    this.active = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watchedPath) {
      unwatchFile(this.watchedPath);
      this.watchedPath = null;
    }
  }
}
