import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { ArisSession } from "./aris-session.js";
import {
  createPersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

async function createTempWorkspace(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `aris-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFileRel(cwd: string, rel: string, content: string): Promise<void> {
  const filePath = path.join(cwd, rel);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

function createSession(
  emitted: SessionOutboundMessage[],
  workspaceRegistry: WorkspaceRegistry = { list: async () => [] } as unknown as WorkspaceRegistry,
): ArisSession {
  return new ArisSession({
    host: { emit: (msg) => emitted.push(msg) },
    workspaceRegistry,
    logger: pino({ level: "silent" }),
  });
}

describe("ArisSession - aris.wiki.read with on-disk edge format and node_id frontmatter", () => {
  let root: string;

  function wikiResponse(emitted: SessionOutboundMessage[]) {
    const msg = emitted.find((m) => m.type === "aris.wiki.read.response");
    if (!msg || msg.type !== "aris.wiki.read.response") {
      throw new Error("no aris.wiki.read.response emitted");
    }
    return msg.payload;
  }

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("parses edges.jsonl written in the on-disk format (from/to/type)", async () => {
    await writeFileRel(
      root,
      "research-wiki/graph/edges.jsonl",
      JSON.stringify({
        from: "idea:gbdt-cost-sensitive-threshold",
        to: "exp:exp-sba-2026-07-17-5block",
        type: "tested_by",
        evidence: "exp tests idea",
        added: "2026-07-17T07:05:46Z",
      }) + "\n",
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiReadRequest({
      type: "aris.wiki.read",
      cwd: root,
      requestId: "wiki-1",
    });

    const payload = wikiResponse(emitted);
    if (payload.ok !== true) {
      throw new Error(payload.error);
    }
    expect(payload.edges).toEqual([
      {
        source: "idea:gbdt-cost-sensitive-threshold",
        target: "exp:exp-sba-2026-07-17-5block",
        relation: "tested_by",
        strength: null,
      },
    ]);
  });

  test("also accepts wire-format edges (source/target/relation)", async () => {
    await writeFileRel(
      root,
      "research-wiki/graph/edges.jsonl",
      JSON.stringify({ source: "A", target: "B", relation: "extends" }) +
        "\n" +
        JSON.stringify({ source: "B", target: "C", relation: "supports" }) +
        "\n",
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiReadRequest({
      type: "aris.wiki.read",
      cwd: root,
      requestId: "wiki-2",
    });

    const payload = wikiResponse(emitted);
    if (payload.ok !== true) {
      throw new Error(payload.error);
    }
    expect(payload.edges).toEqual([
      { source: "A", target: "B", relation: "extends", strength: null },
      { source: "B", target: "C", relation: "supports", strength: null },
    ]);
  });

  test("prefers node_id from frontmatter over the file basename for the wiki id", async () => {
    await writeFileRel(
      root,
      "research-wiki/ideas/gbdt-cost-sensitive-threshold.md",
      [
        "---",
        "type: idea",
        "node_id: idea:gbdt-cost-sensitive-threshold",
        'title: "GBDT + cost-sensitive threshold"',
        "---",
        "",
        "Body content",
        "",
      ].join("\n"),
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiReadRequest({
      type: "aris.wiki.read",
      cwd: root,
      requestId: "wiki-3",
    });

    const payload = wikiResponse(emitted);
    if (payload.ok !== true) {
      throw new Error(payload.error);
    }
    expect(payload.ideas).toHaveLength(1);
    expect(payload.ideas[0]?.id).toBe("idea:gbdt-cost-sensitive-threshold");
    expect(payload.ideas[0]?.title).toBe("GBDT + cost-sensitive threshold");
  });

  test("falls back to file basename when frontmatter has no node_id", async () => {
    await writeFileRel(
      root,
      "research-wiki/ideas/no-frontmatter-id.md",
      ["---", 'title: "No node_id here"', "---", "", "Body", ""].join("\n"),
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiReadRequest({
      type: "aris.wiki.read",
      cwd: root,
      requestId: "wiki-4",
    });

    const payload = wikiResponse(emitted);
    if (payload.ok !== true) {
      throw new Error(payload.error);
    }
    expect(payload.ideas).toHaveLength(1);
    expect(payload.ideas[0]?.id).toBe("no-frontmatter-id");
  });
});

describe("ArisSession - aris.wiki.entity.read", () => {
  let root: string;

  function entityResponse(emitted: SessionOutboundMessage[]) {
    const msg = emitted.find((m) => m.type === "aris.wiki.entity.read.response");
    if (!msg || msg.type !== "aris.wiki.entity.read.response") {
      throw new Error("no aris.wiki.entity.read.response emitted");
    }
    return msg.payload;
  }

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns the raw content of research-wiki/{entityType}/{slug}.md", async () => {
    const body = [
      "---",
      "type: idea",
      "node_id: idea:foo",
      'title: "Foo"',
      "---",
      "",
      "# Foo",
      "",
      "Body of the idea",
    ].join("\n");
    await writeFileRel(root, "research-wiki/ideas/foo.md", body);

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiEntityReadRequest({
      type: "aris.wiki.entity.read",
      cwd: root,
      requestId: "ent-1",
      entityType: "ideas",
      entityId: "idea:foo",
    });

    const payload = entityResponse(emitted);
    expect(payload.ok).toBe(true);
    if (payload.ok !== true) {
      throw new Error(payload.error);
    }
    expect(payload.entityType).toBe("ideas");
    expect(payload.entityId).toBe("idea:foo");
    expect(payload.content).toBe(body);
  });

  test("returns ok=false with error when the entity file is missing", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiEntityReadRequest({
      type: "aris.wiki.entity.read",
      cwd: root,
      requestId: "ent-2",
      entityType: "ideas",
      entityId: "idea:missing",
    });

    const payload = entityResponse(emitted);
    expect(payload.ok).toBe(false);
    if (payload.ok === false) {
      expect(payload.entityType).toBe("ideas");
      expect(payload.entityId).toBe("idea:missing");
      expect(typeof payload.error).toBe("string");
      expect(payload.error.length).toBeGreaterThan(0);
    }
  });

  test("rejects when cwd is empty", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiEntityReadRequest({
      type: "aris.wiki.entity.read",
      cwd: "   ",
      requestId: "ent-3",
      entityType: "ideas",
      entityId: "idea:foo",
    });

    const payload = entityResponse(emitted);
    expect(payload.ok).toBe(false);
    if (payload.ok === false) {
      expect(payload.error).toBe("cwd is required");
    }
  });

  test("rejects when entityId is empty", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    await session.handleWikiEntityReadRequest({
      type: "aris.wiki.entity.read",
      cwd: root,
      requestId: "ent-4",
      entityType: "ideas",
      entityId: "   ",
    });

    const payload = entityResponse(emitted);
    expect(payload.ok).toBe(false);
    if (payload.ok === false) {
      expect(payload.error).toBe("entityId is required");
    }
  });
});

describe("ArisSession - wiki update push", () => {
  const workspaceId = "ws-push";
  let root: string;
  let session: ArisSession | null = null;

  function registryFor(cwd: string): WorkspaceRegistry {
    const record = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "proj-1",
      cwd,
      kind: "directory",
      displayName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { list: async () => [record] } as unknown as WorkspaceRegistry;
  }

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    session?.stop();
    session = null;
    await rm(root, { recursive: true, force: true });
  });

  test("pushes aris.wiki.update when the wiki index changes after a read", async () => {
    await writeFileRel(root, "research-wiki/index.md", "# Index\n");
    const emitted: SessionOutboundMessage[] = [];
    session = createSession(emitted, registryFor(root));
    await session.handleWikiReadRequest({ type: "aris.wiki.read", cwd: root, requestId: "w" });

    await writeFileRel(root, "research-wiki/index.md", "# Index\n\n- idea:new\n");

    await vi.waitFor(
      () => {
        expect(emitted).toContainEqual({ type: "aris.wiki.update", payload: { workspaceId } });
      },
      { timeout: 5000, interval: 100 },
    );
  });

  test("stops pushing after stop()", async () => {
    await writeFileRel(root, "research-wiki/index.md", "# Index\n");
    const emitted: SessionOutboundMessage[] = [];
    session = createSession(emitted, registryFor(root));
    await session.handleWikiReadRequest({ type: "aris.wiki.read", cwd: root, requestId: "w" });
    session.stop();

    await writeFileRel(root, "research-wiki/index.md", "# Index\n\n- idea:new\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(emitted.some((msg) => msg.type === "aris.wiki.update")).toBe(false);
  });
});

describe("ArisSession - removed pipeline requests", () => {
  test("answers every removed request with an empty reply instead of timing out", () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(emitted);
    const cwd = "/tmp/research";

    session.replyToRemovedRequest({
      type: "aris.runs.list.request",
      workspaceId: "w",
      requestId: "1",
    });
    session.replyToRemovedRequest({
      type: "aris.run.read.request",
      workspaceId: "w",
      runId: "r",
      requestId: "2",
    });
    session.replyToRemovedRequest({
      type: "aris.iterations.read.request",
      workspaceId: "w",
      runId: "r",
      requestId: "3",
    });
    session.replyToRemovedRequest({ type: "aris.experiments.read", cwd, requestId: "4" });
    session.replyToRemovedRequest({ type: "aris.review.read", cwd, requestId: "5" });
    session.replyToRemovedRequest({ type: "aris.events.read", cwd, requestId: "6" });
    session.replyToRemovedRequest({
      type: "aris.workflow.status.read",
      workspaceId: "w",
      requestId: "7",
    });

    expect(
      emitted.map((msg) => [msg.type, (msg.payload as { requestId: string }).requestId]),
    ).toEqual([
      ["aris.runs.list.response", "1"],
      ["aris.run.read.response", "2"],
      ["aris.iterations.read.response", "3"],
      ["aris.experiments.read.response", "4"],
      ["aris.review.read.response", "5"],
      ["aris.events.read.response", "6"],
      ["aris.workflow.status.read.response", "7"],
    ]);
    expect(emitted[0]?.payload).toEqual({ requestId: "1", runs: [] });
    expect(emitted[4]?.payload).toMatchObject({ requestId: "5", cwd, ok: false, audits: [] });
    for (const msg of emitted.slice(3)) {
      expect(msg.payload).toMatchObject({ ok: false, error: expect.stringContaining("removed") });
    }
  });
});
