import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "bcryptjs";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("delivers ARIS replies and authenticates live streams on a password-protected daemon", async () => {
  const password = "aris test password";
  const daemon = await createTestPaseoDaemon({ auth: { password: await hash(password, 4) } });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "aris-daemon-test",
    clientType: "cli",
    appVersion: "0.10.0-beta.1",
    password,
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
    reconnect: { enabled: false },
  });
  let projectId: string | undefined;
  try {
    const cwd = join(daemon.staticDir, "research");
    await mkdir(join(cwd, ".aris", "runs"), { recursive: true });
    const run = {
      runId: "run-1",
      status: "running",
      goal: "Verify ARIS integration",
      createdAt: "2026-07-07T00:00:00Z",
      updatedAt: "2026-07-07T00:00:00Z",
      phases: [],
    };
    await writeFile(join(cwd, ".aris", "runs", "run-1.json"), JSON.stringify(run));
    const idea = "---\nid: idea:test\ntitle: Test idea\nstatus: seed\n---\n# Test idea\n";
    await mkdir(join(cwd, "research-wiki", "ideas"), { recursive: true });
    await writeFile(join(cwd, "research-wiki", "ideas", "test.md"), idea);

    await client.connect();
    await client.fetchAgents();
    const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    expect(created.error).toBeNull();
    assert(created.workspace);
    const workspaceId = created.workspace.id;
    projectId = created.workspace.projectId;

    expect((await client.listArisRuns(workspaceId)).runs).toEqual([run]);
    expect((await client.readArisRun(workspaceId, "run-1")).run).toEqual(run);
    expect(await client.readArisIterations(workspaceId, "run-1")).toMatchObject({
      iterations: [],
      nextCursor: null,
    });
    expect(await client.readArisWiki(cwd)).toMatchObject({ ok: true });
    expect(await client.readArisWikiEntity(cwd, "ideas", "idea:test")).toMatchObject({
      ok: true,
      content: idea,
    });
    expect(await client.readArisExperiments(cwd)).toMatchObject({ ok: true });
    expect(await client.readArisReview({ cwd })).toMatchObject({ ok: true, error: null });
    expect(await client.readArisEvents({ cwd })).toMatchObject({
      ok: true,
      events: [],
      error: null,
    });
    expect(await client.readArisWorkflowStatus(workspaceId)).toMatchObject({
      ok: true,
      error: null,
    });

    const url = `http://127.0.0.1:${daemon.port}/api/aris/workspaces/missing/live`;
    const missing = await fetch(url);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    const wrong = await fetch(`${url}?token=wrong-password`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Unauthorized" });
    const correct = await fetch(`${url}?token=${encodeURIComponent(password)}`);
    assert(correct.body);
    const reader = correct.body.getReader();
    try {
      expect(correct.status).toBe(200);
      expect(correct.headers.get("content-type")).toBe("text/event-stream");
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n\n")) {
        const chunk = await reader.read();
        assert(!chunk.done);
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toContain("event: aris.snapshot\n");
      expect(text).toContain('data: {"workspaceId":"missing","runs":[]}\n');
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  } finally {
    try {
      if (projectId) await client.removeProject(projectId);
    } finally {
      await client.close();
      await daemon.close();
    }
  }
});
