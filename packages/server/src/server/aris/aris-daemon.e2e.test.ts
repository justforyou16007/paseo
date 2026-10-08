import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "bcryptjs";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("delivers ARIS wiki replies on a password-protected daemon", async () => {
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
    const idea = "---\nid: idea:test\ntitle: Test idea\nstatus: seed\n---\n# Test idea\n";
    await mkdir(join(cwd, "research-wiki", "ideas"), { recursive: true });
    await writeFile(join(cwd, "research-wiki", "ideas", "test.md"), idea);

    await client.connect();
    await client.fetchAgents();
    const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    expect(created.error).toBeNull();
    assert(created.workspace);
    projectId = created.workspace.projectId;

    expect(await client.readArisWiki(cwd)).toMatchObject({ ok: true });
    expect(await client.readArisWikiEntity(cwd, "ideas", "idea:test")).toMatchObject({
      ok: true,
      content: idea,
    });
  } finally {
    try {
      if (projectId) await client.removeProject(projectId);
    } finally {
      await client.close();
      await daemon.close();
    }
  }
});
