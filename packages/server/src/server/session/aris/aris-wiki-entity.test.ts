import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { ArisSession } from "./aris-session.js";
import { createArisDataService } from "../../aris/aris-data-service.js";
import {
  createPersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

describe("ArisSession - aris.wiki.read with on-disk edge format and node_id frontmatter", () => {
  const workspaceId = "ws-wiki";
  let root: string;

  async function createTempWorkspace(): Promise<string> {
    const dir = path.join(
      os.tmpdir(),
      `aris-wiki-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeFileRel(cwd: string, rel: string, content: string): Promise<void> {
    const filePath = path.join(cwd, rel);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  function createRegistry(cwd: string): WorkspaceRegistry {
    const record = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "proj-1",
      cwd,
      kind: "directory",
      displayName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      get: async (id: string) => (id === workspaceId ? record : null),
    } as unknown as WorkspaceRegistry;
  }

  function createSession(cwd: string, emitted: SessionOutboundMessage[]): ArisSession {
    return new ArisSession({
      host: { emit: (msg) => emitted.push(msg) },
      arisDataService: createArisDataService({
        workspaceRegistry: createRegistry(cwd),
        logger: pino({ level: "silent" }),
      }),
      workspaceRegistry: { list: async () => [] } as unknown as WorkspaceRegistry,
      logger: pino({ level: "silent" }),
    });
  }

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
    const session = createSession(root, emitted);
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
    const session = createSession(root, emitted);
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
    const session = createSession(root, emitted);
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
    const session = createSession(root, emitted);
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
  const workspaceId = "ws-entity";
  let root: string;

  async function createTempWorkspace(): Promise<string> {
    const dir = path.join(
      os.tmpdir(),
      `aris-entity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeFileRel(cwd: string, rel: string, content: string): Promise<void> {
    const filePath = path.join(cwd, rel);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  function createRegistry(cwd: string): WorkspaceRegistry {
    const record = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "proj-1",
      cwd,
      kind: "directory",
      displayName: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return {
      get: async (id: string) => (id === workspaceId ? record : null),
    } as unknown as WorkspaceRegistry;
  }

  function createSession(cwd: string, emitted: SessionOutboundMessage[]): ArisSession {
    return new ArisSession({
      host: { emit: (msg) => emitted.push(msg) },
      arisDataService: createArisDataService({
        workspaceRegistry: createRegistry(cwd),
        logger: pino({ level: "silent" }),
      }),
      workspaceRegistry: { list: async () => [] } as unknown as WorkspaceRegistry,
      logger: pino({ level: "silent" }),
    });
  }

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
    const session = createSession(root, emitted);
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
    const session = createSession(root, emitted);
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
    const session = createSession(root, emitted);
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
    const session = createSession(root, emitted);
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
