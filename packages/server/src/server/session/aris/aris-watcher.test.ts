import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { ArisStateWatcher, type ArisStateUpdate } from "./aris-watcher.js";

function createLogger(): pino.Logger {
  return pino({ level: "silent" });
}

async function createTempWorkspace(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `aris-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFileAt(root: string, relPath: string, content: string): Promise<void> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

async function appendFileAt(root: string, relPath: string, content: string): Promise<void> {
  const filePath = path.join(root, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, content, "utf-8");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function hasUpdateKind(updates: ArisStateUpdate[], kind: ArisStateUpdate["kind"]): boolean {
  for (const update of updates) {
    if (update.kind === kind) {
      return true;
    }
  }
  return false;
}

describe("ArisStateWatcher", () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits a review update when REVIEW_STATE.json changes", async () => {
    await writeFileAt(
      root,
      "review-stage/REVIEW_STATE.json",
      JSON.stringify({ stage: "pending", rounds: [] }),
    );

    const updates: ArisStateUpdate[] = [];
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: (update) => updates.push(update),
      logger: createLogger(),
    });
    await watcher.start();

    await writeFileAt(
      root,
      "review-stage/REVIEW_STATE.json",
      JSON.stringify({ stage: "in_review", rounds: [{ round: 0, status: "active" }] }),
    );

    await waitFor(() => hasUpdateKind(updates, "review"));
    watcher.stop();

    const review = updates.find((u) => u.kind === "review");
    expect(review).toBeDefined();
    if (review?.kind === "review") {
      expect(review.cwd).toBe(root);
      expect(review.reviewState).toMatchObject({
        stage: "in_review",
        rounds: [{ round: 0, status: "active" }],
      });
    }
  });

  test("emits a run_state update when the run-state file changes", async () => {
    await writeFileAt(
      root,
      ".aris/runs/test.json",
      JSON.stringify({ runId: "test", status: "running" }),
    );

    const updates: ArisStateUpdate[] = [];
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: (update) => updates.push(update),
      logger: createLogger(),
    });
    await watcher.start();

    await writeFileAt(
      root,
      ".aris/runs/test.json",
      JSON.stringify({ runId: "test", status: "completed" }),
    );

    await waitFor(() => hasUpdateKind(updates, "run_state"));
    watcher.stop();

    const runState = updates.find((u) => u.kind === "run_state");
    expect(runState).toBeDefined();
    expect(runState).toMatchObject({ kind: "run_state", cwd: root, runId: "test" });
  });

  test("emits a paper update when paper/main.pdf changes", async () => {
    await writeFileAt(root, "paper/main.pdf", "%PDF-1.4 initial");

    const updates: ArisStateUpdate[] = [];
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: (update) => updates.push(update),
      logger: createLogger(),
    });
    await watcher.start();

    await writeFileAt(root, "paper/main.pdf", "%PDF-1.4 updated content");

    await waitFor(() => hasUpdateKind(updates, "paper"));
    watcher.stop();

    const paper = updates.find((u) => u.kind === "paper");
    expect(paper).toBeDefined();
    expect(paper).toMatchObject({ kind: "paper", cwd: root, runId: "test" });
  });

  test("emits a wiki update when research-wiki/index.md changes", async () => {
    await writeFileAt(root, "research-wiki/index.md", "# Wiki initial");

    const updates: ArisStateUpdate[] = [];
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: (update) => updates.push(update),
      logger: createLogger(),
    });
    await watcher.start();

    await writeFileAt(root, "research-wiki/index.md", "# Wiki updated");

    await waitFor(() => hasUpdateKind(updates, "wiki"));
    watcher.stop();

    const wiki = updates.find((u) => u.kind === "wiki");
    expect(wiki).toBeDefined();
    expect(wiki).toMatchObject({ kind: "wiki", cwd: root, runId: "test" });
  });

  test("emits iteration_added with newly appended lines", async () => {
    await writeFileAt(root, ".aris/runs/test.iterations.jsonl", '{"id":"iter-1"}\n');

    const updates: ArisStateUpdate[] = [];
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: (update) => updates.push(update),
      logger: createLogger(),
    });
    await watcher.start();

    await appendFileAt(root, ".aris/runs/test.iterations.jsonl", '{"id":"iter-2"}\n');

    await waitFor(() => hasUpdateKind(updates, "iteration_added"));
    watcher.stop();

    const iteration = updates.find((u) => u.kind === "iteration_added");
    expect(iteration).toBeDefined();
    if (iteration?.kind === "iteration_added") {
      expect(iteration.lines).toEqual(['{"id":"iter-2"}']);
    }
  });

  test("does not emit after stop is called", async () => {
    await writeFileAt(
      root,
      "review-stage/REVIEW_STATE.json",
      JSON.stringify({ stage: "pending", rounds: [] }),
    );

    const updates: ArisStateUpdate[] = [];
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: (update) => updates.push(update),
      logger: createLogger(),
    });
    await watcher.start();
    watcher.stop();

    const countBefore = updates.length;
    await writeFileAt(
      root,
      "review-stage/REVIEW_STATE.json",
      JSON.stringify({ stage: "accepted", rounds: [] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(updates.length).toBe(countBefore);
  });

  test("starts cleanly when watched files are missing", async () => {
    const watcher = new ArisStateWatcher({
      cwd: root,
      runId: "test",
      onUpdate: () => {},
      logger: createLogger(),
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    watcher.stop();
  });
});
