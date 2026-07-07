import os from "node:os";
import path from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import pino from "pino";
import { ArisReviewWatcher } from "./aris-watcher.js";

function createLogger(): pino.Logger {
  return pino({ level: "silent" });
}

async function createTempWorkspace(): Promise<string> {
  return mkdir(path.join(os.tmpdir(), `aris-watcher-test-${Date.now()}`), {
    recursive: true,
  });
}

async function writeReviewState(root: string, content: unknown): Promise<void> {
  const filePath = path.join(root, "review-stage", "REVIEW_STATE.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(content), "utf-8");
}

describe("ArisReviewWatcher", () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits update when review state file changes", async () => {
    await writeReviewState(root, { stage: "pending", rounds: [] });

    const updates: Parameters<
      NonNullable<ConstructorParameters<typeof ArisReviewWatcher>[0]["onUpdate"]>
    >[] = [];
    const watcher = new ArisReviewWatcher({
      cwd: root,
      onUpdate: (update) => updates.push([update]),
      logger: createLogger(),
    });
    await watcher.start();

    await writeReviewState(root, { stage: "in_review", rounds: [{ round: 0, status: "active" }] });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    watcher.stop();

    expect(updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updates[updates.length - 1];
    expect(lastUpdate?.[0]).toMatchObject({
      cwd: root,
      reviewState: { stage: "in_review", rounds: [{ round: 0, status: "active" }] },
    });
  });

  test("does not emit after stop is called", async () => {
    await writeReviewState(root, { stage: "pending", rounds: [] });

    const updates: Parameters<
      NonNullable<ConstructorParameters<typeof ArisReviewWatcher>[0]["onUpdate"]>
    >[] = [];
    const watcher = new ArisReviewWatcher({
      cwd: root,
      onUpdate: (update) => updates.push([update]),
      logger: createLogger(),
    });
    await watcher.start();
    watcher.stop();

    const countBefore = updates.length;
    await writeReviewState(root, { stage: "accepted", rounds: [] });
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(updates.length).toBe(countBefore);
  });

  test("starts cleanly when review state file is missing", async () => {
    const watcher = new ArisReviewWatcher({
      cwd: root,
      onUpdate: () => {},
      logger: createLogger(),
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    watcher.stop();
  });
});
