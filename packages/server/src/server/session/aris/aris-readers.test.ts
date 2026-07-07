import os from "node:os";
import path from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readArisEvents, readArisReviewState } from "./aris-readers.js";

async function createTempWorkspace(): Promise<string> {
  const root = await mkdir(path.join(os.tmpdir(), `aris-readers-test-${Date.now()}`), {
    recursive: true,
  });
  return root;
}

async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

describe("readArisReviewState", () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns null/empty values when no ARIS files exist", async () => {
    const result = await readArisReviewState({ cwd: root });

    expect(result.reviewState).toBeNull();
    expect(result.autoReviewMarkdown).toBeNull();
    expect(result.paperImprovement).toBeNull();
    expect(result.audits).toEqual([]);
    expect(result.pendingReview).toBeNull();
    expect(result.traces).toEqual([]);
    expect(result.knowledgeGraph).toBeNull();
  });

  test("reads review state, markdown, paper improvement, audits, pending review, and knowledge graph", async () => {
    await writeWorkspaceFile(
      root,
      "review-stage/REVIEW_STATE.json",
      JSON.stringify({
        version: "1.0",
        stage: "in_review",
        currentRound: 1,
        rounds: [{ round: 0, status: "completed", verdict: "minor revisions" }],
        overallVerdict: "minor revisions",
      }),
    );
    await writeWorkspaceFile(root, "review-stage/AUTO_REVIEW.md", "# Auto Review\n\nLooks good.");
    await writeWorkspaceFile(
      root,
      "paper/PAPER_IMPROVEMENT_STATE.json",
      JSON.stringify({
        version: "1.0",
        sections: [{ id: "intro", title: "Introduction", status: "completed" }],
      }),
    );
    await writeWorkspaceFile(
      root,
      "paper/INTRO_AUDIT.json",
      JSON.stringify({
        section: "Introduction",
        verdicts: [{ section: "clarity", verdict: "pass" }],
      }),
    );
    await writeWorkspaceFile(
      root,
      ".aris/pending_review/pending_review.json",
      JSON.stringify({ items: [{ id: "1", title: "Fix citation", status: "pending" }] }),
    );
    await writeWorkspaceFile(
      root,
      "research-wiki/graph/edges.jsonl",
      JSON.stringify({ source: "A", target: "B", relation: "cites" }) +
        "\n" +
        JSON.stringify({ source: "B", target: "C", relation: "supports" }) +
        "\n",
    );

    const result = await readArisReviewState({ cwd: root });

    expect(result.reviewState).toEqual({
      version: "1.0",
      stage: "in_review",
      currentRound: 1,
      rounds: [{ round: 0, status: "completed", verdict: "minor revisions" }],
      overallVerdict: "minor revisions",
    });
    expect(result.autoReviewMarkdown).toBe("# Auto Review\n\nLooks good.");
    expect(result.paperImprovement).toEqual({
      version: "1.0",
      sections: [{ id: "intro", title: "Introduction", status: "completed" }],
    });
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]?.fileName).toBe("INTRO_AUDIT.json");
    expect(result.audits[0]?.section).toBe("Introduction");
    expect(result.pendingReview).toEqual({
      items: [{ id: "1", title: "Fix citation", status: "pending" }],
    });
    expect(result.knowledgeGraph).toEqual({
      edges: [
        { source: "A", target: "B", relation: "cites" },
        { source: "B", target: "C", relation: "supports" },
      ],
    });
  });

  test("reads trace metadata from .aris/traces", async () => {
    await writeWorkspaceFile(
      root,
      ".aris/traces/research/2026-07-07_run01/metadata.json",
      JSON.stringify({ status: "completed" }),
    );

    const result = await readArisReviewState({ cwd: root });

    expect(result.traces).toEqual([
      { skill: "research", date: "2026-07-07", runId: "01", status: "completed" },
    ]);
  });

  test("ignores malformed JSON files", async () => {
    await writeWorkspaceFile(root, "review-stage/REVIEW_STATE.json", "not json");
    const result = await readArisReviewState({ cwd: root });
    expect(result.reviewState).toBeNull();
  });
});

describe("readArisEvents", () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns empty array when events file is missing", async () => {
    const events = await readArisEvents({ cwd: root });
    expect(events).toEqual([]);
  });

  test("reads events in reverse chronological order and respects limit", async () => {
    await writeWorkspaceFile(
      root,
      ".aris/meta/events.jsonl",
      [
        JSON.stringify({ timestamp: "2026-07-07T10:00:00Z", type: "start", runId: "run01" }),
        JSON.stringify({ timestamp: "2026-07-07T10:01:00Z", type: "progress", runId: "run01" }),
        JSON.stringify({ timestamp: "2026-07-07T10:02:00Z", type: "complete", runId: "run02" }),
      ].join("\n") + "\n",
    );

    const events = await readArisEvents({ cwd: root, limit: 2 });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("progress");
    expect(events[1]?.type).toBe("complete");
  });

  test("filters events by runId", async () => {
    await writeWorkspaceFile(
      root,
      ".aris/meta/events.jsonl",
      [
        JSON.stringify({ timestamp: "2026-07-07T10:00:00Z", type: "start", runId: "run01" }),
        JSON.stringify({ timestamp: "2026-07-07T10:01:00Z", type: "progress", runId: "run02" }),
      ].join("\n") + "\n",
    );

    const events = await readArisEvents({ cwd: root, runId: "run02" });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("progress");
  });

  test("skips malformed JSON lines", async () => {
    await writeWorkspaceFile(
      root,
      ".aris/meta/events.jsonl",
      [
        JSON.stringify({ timestamp: "2026-07-07T10:00:00Z", type: "start" }),
        "not valid json",
        JSON.stringify({ timestamp: "2026-07-07T10:01:00Z", type: "complete" }),
      ].join("\n") + "\n",
    );

    const events = await readArisEvents({ cwd: root });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["start", "complete"]);
  });
});
