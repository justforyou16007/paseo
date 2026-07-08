import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import { ArisSession } from "./aris-session.js";
import * as arisReaders from "./aris-readers.js";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createArisDataService } from "../../aris/aris-data-service.js";
import {
  createPersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

function createLogger(): pino.Logger {
  return pino({ level: "silent" });
}

describe("ArisSession", () => {
  let emitted: SessionOutboundMessage[];
  let session: ArisSession;

  beforeEach(() => {
    emitted = [];
    session = new ArisSession({
      host: {
        emit: (msg) => emitted.push(msg),
      },
      arisDataService: createArisDataService({
        workspaceRegistry: { list: async () => [] } as unknown as WorkspaceRegistry,
        logger: createLogger(),
      }),
      workspaceRegistry: { list: async () => [] } as unknown as WorkspaceRegistry,
      logger: createLogger(),
    });
  });

  test("emits successful aris.review.read.response", async () => {
    vi.spyOn(arisReaders, "readArisReviewState").mockResolvedValue({
      reviewState: { stage: "in_review", rounds: [] },
      autoReviewMarkdown: "# Review",
      paperImprovement: null,
      audits: [],
      pendingReview: null,
      traces: [],
      knowledgeGraph: null,
    });

    await session.handleReviewReadRequest({
      type: "aris.review.read",
      cwd: "/workspace",
      requestId: "req-1",
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "aris.review.read.response",
      payload: {
        requestId: "req-1",
        cwd: "/workspace",
        ok: true,
        reviewState: { stage: "in_review", rounds: [] },
        autoReviewMarkdown: "# Review",
        error: null,
      },
    });
  });

  test("emits error aris.review.read.response on failure", async () => {
    vi.spyOn(arisReaders, "readArisReviewState").mockRejectedValue(new Error("disk full"));

    await session.handleReviewReadRequest({
      type: "aris.review.read",
      cwd: "/workspace",
      requestId: "req-2",
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "aris.review.read.response",
      payload: {
        requestId: "req-2",
        cwd: "/workspace",
        ok: false,
        error: "disk full",
      },
    });
  });

  test("emits successful aris.events.read.response", async () => {
    vi.spyOn(arisReaders, "readArisEvents").mockResolvedValue([
      { timestamp: "2026-07-07T10:00:00Z", type: "start" },
    ]);

    await session.handleEventsReadRequest({
      type: "aris.events.read",
      cwd: "/workspace",
      requestId: "req-3",
      limit: 50,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "aris.events.read.response",
      payload: {
        requestId: "req-3",
        cwd: "/workspace",
        ok: true,
        events: [{ timestamp: "2026-07-07T10:00:00Z", type: "start" }],
        error: null,
      },
    });
  });

  test("stops watchers without error when no watchers were started", () => {
    expect(() => session.stop()).not.toThrow();
  });
});

describe("ArisSession - aris.workflow.status.read", () => {
  const workspaceId = "ws-workflow";
  let root: string;

  async function createTempWorkspace(): Promise<string> {
    const dir = path.join(
      os.tmpdir(),
      `aris-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  function workflowResponse(emitted: SessionOutboundMessage[]) {
    const msg = emitted.find((m) => m.type === "aris.workflow.status.read.response");
    if (!msg || msg.type !== "aris.workflow.status.read.response") {
      throw new Error("no workflow status response emitted");
    }
    return msg.payload;
  }

  beforeEach(async () => {
    root = await createTempWorkspace();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("empty workspace: all stages pending, directory-derived, activeW null", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r1",
      workspaceId,
    });

    const payload = workflowResponse(emitted);
    expect(payload.ok).toBe(true);
    expect(payload.error).toBeNull();
    expect(payload.status?.activeW).toBeNull();
    expect(payload.status?.stages).toHaveLength(7);
    for (const stage of payload.status?.stages ?? []) {
      expect(stage.status).toBe("pending");
      expect(stage.derivedFrom).toBe("directory");
      expect(stage.crossModelAcquittal).toBe(false);
    }
    const w1 = payload.status?.stages.find((s) => s.id === "W1");
    expect(w1?.artifacts.find((a) => a.path === "idea-stage/IDEA_REPORT.md")?.exists).toBe(false);
  });

  test("derives stage status from run state phases", async () => {
    await writeFileRel(
      root,
      ".aris/runs/run-1.json",
      JSON.stringify({
        runId: "run-1",
        status: "running",
        updatedAt: "2026-07-08T10:00:00Z",
        phases: [
          { phase: "W1", status: "done" },
          { phase: "W2", status: "running" },
          { phase: "W3", status: "accepted" },
        ],
      }),
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r2",
      workspaceId,
    });

    const payload = workflowResponse(emitted);
    const stages = payload.status?.stages ?? [];
    const w1 = stages.find((s) => s.id === "W1");
    const w2 = stages.find((s) => s.id === "W2");
    const w3 = stages.find((s) => s.id === "W3");
    expect(w1?.status).toBe("done");
    expect(w1?.derivedFrom).toBe("run_state");
    expect(w2?.status).toBe("running");
    expect(w2?.derivedFrom).toBe("run_state");
    expect(w3?.status).toBe("accepted");
    expect(w3?.crossModelAcquittal).toBe(true);
    expect(payload.status?.activeW).toBe("W2");
  });

  test("falls back to directory existence when no run state", async () => {
    await writeFileRel(root, "idea-stage/IDEA_REPORT.md", "# Ideas");
    await writeFileRel(root, "paper/main.pdf", "%PDF-1.4");

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r3",
      workspaceId,
    });

    const stages = workflowResponse(emitted).status?.stages ?? [];
    expect(stages.find((s) => s.id === "W1")?.status).toBe("done");
    expect(stages.find((s) => s.id === "W1")?.derivedFrom).toBe("directory");
    expect(stages.find((s) => s.id === "W3")?.status).toBe("done");
    expect(stages.find((s) => s.id === "W3")?.derivedFrom).toBe("directory");
    expect(stages.find((s) => s.id === "W2")?.status).toBe("pending");
  });

  test("W1.5 directory fallback requires EXPERIMENT_TRACKER with DONE/RUNNING", async () => {
    await writeFileRel(
      root,
      "refine-logs/EXPERIMENT_TRACKER.md",
      "# Tracker\n| run | status |\n| r1 | DONE |\n",
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r4",
      workspaceId,
    });

    const stages = workflowResponse(emitted).status?.stages ?? [];
    expect(stages.find((s) => s.id === "W1.5")?.status).toBe("done");
    expect(stages.find((s) => s.id === "W1.5")?.derivedFrom).toBe("directory");
  });

  test("W1.5 stays pending when tracker has no DONE/RUNNING run", async () => {
    await writeFileRel(
      root,
      "refine-logs/EXPERIMENT_TRACKER.md",
      "# Tracker\n| run | status |\n| r1 | PLANNED |\n",
    );

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r4b",
      workspaceId,
    });

    const stages = workflowResponse(emitted).status?.stages ?? [];
    expect(stages.find((s) => s.id === "W1.5")?.status).toBe("pending");
  });

  test("CLAUDE.md Pipeline Status provides activeW hint", async () => {
    await writeFileRel(
      root,
      "CLAUDE.md",
      "# Project\n\n## Pipeline Status\n\nstage: W3\n\n## Other\n",
    );
    await writeFileRel(root, "paper/main.pdf", "%PDF-1.4");

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r5",
      workspaceId,
    });

    const payload = workflowResponse(emitted);
    expect(payload.status?.activeW).toBe("W3");
  });

  test("artifacts enumerate size and updatedAt when present", async () => {
    await writeFileRel(root, "paper/main.pdf", "%PDF-1.4 body content");

    const emitted: SessionOutboundMessage[] = [];
    const session = createSession(root, emitted);
    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r6",
      workspaceId,
    });

    const stages = workflowResponse(emitted).status?.stages ?? [];
    const artifact = stages
      .find((s) => s.id === "W3")
      ?.artifacts.find((a) => a.path === "paper/main.pdf");
    expect(artifact?.exists).toBe(true);
    expect(artifact?.kind).toBe("pdf");
    expect(typeof artifact?.sizeBytes).toBe("number");
    expect(artifact?.sizeBytes).toBeGreaterThan(0);
    expect(artifact?.updatedAt).toBeTruthy();
  });

  test("W5 detects sibling resubmit venue directory", async () => {
    const parent = path.join(
      os.tmpdir(),
      `aris-w5-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const cwd = path.join(parent, "main");
    const venue = path.join(parent, "main-v2");
    await mkdir(cwd, { recursive: true });
    await mkdir(venue, { recursive: true });
    await writeFile(path.join(venue, "RESUBMIT_REPORT.json"), "{}", "utf-8");
    await writeFile(path.join(venue, "DIFF_REPORT.md"), "# Diff", "utf-8");

    try {
      const emitted: SessionOutboundMessage[] = [];
      const session = createSession(cwd, emitted);
      await session.handleWorkflowStatusReadRequest({
        type: "aris.workflow.status.read",
        requestId: "r7",
        workspaceId,
      });

      const stages = workflowResponse(emitted).status?.stages ?? [];
      const w5 = stages.find((s) => s.id === "W5");
      expect(w5?.status).toBe("done");
      expect(w5?.derivedFrom).toBe("directory");
      expect(w5?.artifacts.find((a) => a.kind === "directory")?.exists).toBe(true);
      const report = w5?.artifacts.find((a) => a.path.endsWith("RESUBMIT_REPORT.json"));
      expect(report?.exists).toBe(true);
      expect(report?.kind).toBe("json");
      const diff = w5?.artifacts.find((a) => a.path.endsWith("DIFF_REPORT.md"));
      expect(diff?.exists).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("error response when workspace not found", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = new ArisSession({
      host: { emit: (msg) => emitted.push(msg) },
      arisDataService: createArisDataService({
        workspaceRegistry: { get: async () => null } as unknown as WorkspaceRegistry,
        logger: pino({ level: "silent" }),
      }),
      workspaceRegistry: { list: async () => [] } as unknown as WorkspaceRegistry,
      logger: pino({ level: "silent" }),
    });

    await session.handleWorkflowStatusReadRequest({
      type: "aris.workflow.status.read",
      requestId: "r8",
      workspaceId: "missing",
    });

    const payload = workflowResponse(emitted);
    expect(payload.ok).toBe(false);
    expect(payload.status).toBeNull();
    expect(payload.error).toBeTruthy();
  });
});
