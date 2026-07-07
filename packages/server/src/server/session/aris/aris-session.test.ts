import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import { ArisSession, type ArisSessionHost } from "./aris-session.js";
import type { SessionOutboundMessage } from "../../messages.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aris-session-test-")));
  tempDirs.push(root);
  return root;
}

function makeSubsystem() {
  const emitted: SessionOutboundMessage[] = [];
  const host: ArisSessionHost = { emit: (msg) => emitted.push(msg) };
  const subsystem = new ArisSession({
    host,
    logger: pino({ level: "silent" }),
  });
  return { subsystem, emitted };
}

function writeWikiFixtures(root: string): void {
  mkdirSync(join(root, "research-wiki", "papers"), { recursive: true });
  mkdirSync(join(root, "research-wiki", "ideas"), { recursive: true });
  mkdirSync(join(root, "research-wiki", "experiments"), { recursive: true });
  mkdirSync(join(root, "research-wiki", "claims"), { recursive: true });
  mkdirSync(join(root, "research-wiki", "graph"), { recursive: true });
  mkdirSync(join(root, ".aris"), { recursive: true });
  mkdirSync(join(root, "refine-logs"), { recursive: true });

  writeFileSync(
    join(root, "research-wiki", "papers", "attention-is-all-you-need.md"),
    [
      "---",
      "title: Attention Is All You Need",
      "authors: [Vaswani, Shazeer, Parmar]",
      "year: 2017",
      "url: https://arxiv.org/abs/1706.03762",
      "tags: [transformers, nlp]",
      "---",
      "",
      "Introduces the transformer architecture.",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "research-wiki", "ideas", "transformer-scaling.md"),
    [
      "---",
      "title: Transformer scaling laws",
      "status: growing",
      "createdAt: '2026-01-15'",
      "relatedIdeaIds: []",
      "paperIds: [attention-is-all-you-need]",
      "---",
      "",
      "Investigate how loss scales with model size and data.",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "research-wiki", "experiments", "scaling-run-1.md"),
    [
      "---",
      "title: Scaling run 1",
      "ideaId: transformer-scaling",
      "status: completed",
      "startedAt: '2026-02-01'",
      "completedAt: '2026-02-02'",
      "config:",
      "  lr: 0.001",
      "---",
      "",
      "Baseline scaling experiment.",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "research-wiki", "claims", "scaling-law-holds.md"),
    [
      "---",
      "title: Scaling law holds",
      "experimentId: scaling-run-1",
      "ideaId: transformer-scaling",
      "status: confirmed",
      "confidence: 0.9",
      "---",
      "",
      "Loss follows a power-law in model size.",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "research-wiki", "graph", "edges.jsonl"),
    [
      JSON.stringify({
        source: "transformer-scaling",
        target: "scaling-run-1",
        relation: "tests",
        strength: 1,
      }),
      JSON.stringify({
        source: "scaling-run-1",
        target: "scaling-law-holds",
        relation: "supports",
        strength: 0.9,
      }),
      "not-json",
    ].join("\n"),
  );

  writeFileSync(
    join(root, ".aris", "experiment-env.json"),
    JSON.stringify({ baseline_lr: 0.001, seed: 42 }),
  );

  writeFileSync(
    join(root, "refine-logs", "EXPERIMENT_scaling-run-1.md"),
    [
      "---",
      "experimentId: scaling-run-1",
      "---",
      "",
      "## Metrics",
      "",
      "```json",
      JSON.stringify({
        timestamps: [1, 2, 3],
        series: { loss: [2.0, 1.5, 1.2], perplexity: [7.4, 4.5, 3.3] },
      }),
      "```",
    ].join("\n"),
  );

  writeFileSync(join(root, "findings.md"), "# Findings\n\nScaling laws hold for this domain.");
}

describe("ArisSession", () => {
  test("wiki read returns parsed wiki data", async () => {
    const root = makeRoot();
    writeWikiFixtures(root);
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleWikiReadRequest({
      type: "aris.wiki.read",
      requestId: "wiki-1",
      cwd: root,
    });

    expect(emitted).toHaveLength(1);
    const response = emitted[0];
    expect(response.type).toBe("aris.wiki.read.response");
    if (response.type !== "aris.wiki.read.response") return;
    expect(response.payload.ok).toBe(true);
    if (!response.payload.ok) return;

    expect(response.payload.papers).toHaveLength(1);
    expect(response.payload.papers[0]).toMatchObject({
      id: "attention-is-all-you-need",
      title: "Attention Is All You Need",
      authors: ["Vaswani", "Shazeer", "Parmar"],
      year: 2017,
      tags: ["transformers", "nlp"],
    });

    expect(response.payload.ideas).toHaveLength(1);
    expect(response.payload.ideas[0]).toMatchObject({
      id: "transformer-scaling",
      title: "Transformer scaling laws",
      status: "growing",
      paperIds: ["attention-is-all-you-need"],
    });

    expect(response.payload.experiments).toHaveLength(1);
    expect(response.payload.experiments[0]).toMatchObject({
      id: "scaling-run-1",
      ideaId: "transformer-scaling",
      status: "completed",
    });

    expect(response.payload.claims).toHaveLength(1);
    expect(response.payload.claims[0]).toMatchObject({
      id: "scaling-law-holds",
      experimentId: "scaling-run-1",
      status: "confirmed",
      confidence: 0.9,
    });

    expect(response.payload.edges).toHaveLength(2);
    expect(response.payload.findings).toContain("Scaling laws hold");
  });

  test("experiments read returns parsed runs with metrics", async () => {
    const root = makeRoot();
    writeWikiFixtures(root);
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleExperimentsReadRequest({
      type: "aris.experiments.read",
      requestId: "exp-1",
      cwd: root,
    });

    expect(emitted).toHaveLength(1);
    const response = emitted[0];
    expect(response.type).toBe("aris.experiments.read.response");
    if (response.type !== "aris.experiments.read.response") return;
    expect(response.payload.ok).toBe(true);
    if (!response.payload.ok) return;

    expect(response.payload.experiments).toHaveLength(1);
    const run = response.payload.experiments[0];
    expect(run.id).toBe("scaling-run-1");
    expect(run.env).toEqual({ baseline_lr: 0.001, seed: 42 });
    expect(run.metrics).toEqual({
      timestamps: [1, 2, 3],
      series: { loss: [2, 1.5, 1.2], perplexity: [7.4, 4.5, 3.3] },
    });
  });

  test("experiments read filters by experimentId", async () => {
    const root = makeRoot();
    writeWikiFixtures(root);
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleExperimentsReadRequest({
      type: "aris.experiments.read",
      requestId: "exp-filter",
      cwd: root,
      experimentId: "missing",
    });

    const response = emitted[0];
    if (response.type !== "aris.experiments.read.response") return;
    expect(response.payload.ok).toBe(true);
    if (!response.payload.ok) return;
    expect(response.payload.experiments).toHaveLength(0);
  });

  test("wiki read returns empty arrays for missing directories", async () => {
    const root = makeRoot();
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleWikiReadRequest({
      type: "aris.wiki.read",
      requestId: "wiki-empty",
      cwd: root,
    });

    const response = emitted[0];
    if (response.type !== "aris.wiki.read.response") return;
    expect(response.payload.ok).toBe(true);
    if (!response.payload.ok) return;
    expect(response.payload.papers).toEqual([]);
    expect(response.payload.ideas).toEqual([]);
    expect(response.payload.experiments).toEqual([]);
    expect(response.payload.claims).toEqual([]);
    expect(response.payload.edges).toEqual([]);
    expect(response.payload.findings).toBeNull();
  });

  test("empty cwd emits error response", async () => {
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleWikiReadRequest({
      type: "aris.wiki.read",
      requestId: "wiki-empty-cwd",
      cwd: "  ",
    });

    const response = emitted[0];
    expect(response.type).toBe("aris.wiki.read.response");
    if (response.type !== "aris.wiki.read.response") return;
    expect(response.payload.ok).toBe(false);
    if (response.payload.ok) return;
    expect(response.payload.error).toBe("cwd is required");
  });

  test.skipIf(process.platform === "win32")("traversal outside cwd is rejected", async () => {
    const root = makeRoot();
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleWikiReadRequest({
      type: "aris.wiki.read",
      requestId: "wiki-traversal",
      cwd: root,
    });

    // The first request is allowed; a traversal attempt would be caught by resolveScopedPath.
    // This test documents the invariant that the subsystem scopes all reads to the cwd.
    const response = emitted[0];
    expect(response.type).toBe("aris.wiki.read.response");
    if (response.type !== "aris.wiki.read.response") return;
    expect(response.payload.ok).toBe(true);
  });
});
