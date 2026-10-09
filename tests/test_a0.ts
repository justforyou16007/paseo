import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  arraySchema,
  canonicalJsonBytes,
  canonicalJsonSha256,
  canonicalJsonString,
  objectSchema,
} from "../src/tools/canonical-json.js";
import { computeWikiCommandId } from "../src/tools/wiki-command-id.js";
import {
  appendWikiEvent,
  commitWikiChange,
  initializeWikiSchema,
  readWikiEvents,
  wikiEventsPath,
  wikiEventHash,
  wikiSchemaPath,
  type WikiDelta,
  type WikiEvent,
} from "../src/tools/wiki-event-store.js";
import { projectWiki, readWikiModel } from "../src/tools/wiki-projector.js";
import {
  canonicalStatePath,
  readStateFile,
  stateLockPath,
  withStateFileLock,
  writeStateJsonAtomic,
} from "../src/tools/state-file.js";

const PACKAGE_ROOT = path.resolve(".");
const TEST_FILE = path.resolve("tests/test_a0.ts");
const RESEARCH_WIKI = path.resolve("src/tools/research-wiki.ts");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a0-test-"));
}

function cleanup(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runTsx(script: string, ...args: string[]): CommandResult {
  try {
    const stdout = execFileSync("npx", ["--no-install", "tsx", script, ...args], {
      cwd: PACKAGE_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const result = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnTestWorker(env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "tsx", TEST_FILE], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing worker environment variable ${name}`);
  return value;
}

async function runWorker(): Promise<void> {
  const kind = process.env.ARIS_A0_WORKER;
  if (kind === "state") {
    const statePath = requiredEnv("ARIS_A0_STATE_PATH");
    withStateFileLock(statePath, () => {
      const state = readStateFile<{ count: number }>(statePath);
      writeStateJsonAtomic(statePath, { count: state.count + 1 });
    });
    return;
  }
  if (kind === "event") {
    const wikiRoot = requiredEnv("ARIS_A0_WIKI_ROOT");
    const index = requiredEnv("ARIS_A0_INDEX");
    appendWikiEvent(wikiRoot, {
      producer_kind: "a0-concurrency-test",
      scope: "modules/a0",
      subject_id: `subject-${index}`,
      evidence_bundle_id: `bundle-${index}`,
      payload: {
        operations: [{ op: "append_log", message: `concurrent event ${index}` }],
      },
    });
    return;
  }
}

function projectionFiles(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.name.endsWith(".lock")) continue;
      if (relative === "schema.json" || relative === "events.jsonl") continue;
      if (entry.isDirectory()) walk(absolute);
      else result.set(relative, fs.readFileSync(absolute));
    }
  };
  walk(root);
  return result;
}

function deleteProjections(root: string): void {
  for (const entry of fs.readdirSync(root)) {
    if (entry === "schema.json" || entry === "events.jsonl") continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

test("canonical JSON follows schema, collection semantics, paths, NFC, and finite numbers", () => {
  const root = tmpDir();
  try {
    const schema = objectSchema({
      title: { type: "string" },
      tags: arraySchema({ type: "string" }, true),
      order: { type: "array", items: { type: "number" }, ordered: true },
      path: { type: "string", format: "workspace-relative-posix-path" },
    });
    const left = {
      order: [3, 1, 2],
      tags: ["z", "a", "m"],
      title: "研究",
      path: "notes\\paper.md",
    };
    const right = {
      path: "notes/paper.md",
      title: "研究",
      tags: ["m", "z", "a"],
      order: [3, 1, 2],
    };
    const leftBytes = canonicalJsonBytes(left, schema, { workspaceRoot: root });
    assert.deepEqual(leftBytes, canonicalJsonBytes(right, schema, { workspaceRoot: root }));
    assert.equal(canonicalJsonString(left, schema, { workspaceRoot: root }),
      '{"order":[3,1,2],"path":"notes/paper.md","tags":["a","m","z"],"title":"研究"}');
    assert.deepEqual(
      JSON.parse(canonicalJsonString(left, schema, { workspaceRoot: root })),
      { order: [3, 1, 2], path: "notes/paper.md", tags: ["a", "m", "z"], title: "研究" },
    );
    assert.equal(Buffer.isBuffer(leftBytes), true);
    assert.equal(canonicalJsonSha256(left, schema, { workspaceRoot: root }).length, 64);
    assert.equal(canonicalJsonString([-0, 1e-7, 1e21, 0.002]), "[0,1e-7,1e+21,0.002]");

    assert.throws(
      () => canonicalJsonString({ ...left, unknown: true }, schema, { workspaceRoot: root }),
      /unknown field/,
    );
    assert.throws(
      () => canonicalJsonString({ ...left, path: "/tmp/paper.md" }, schema, { workspaceRoot: root }),
      /not absolute/,
    );
    assert.throws(
      () => canonicalJsonString({ ...left, path: "../outside.md" }, schema, { workspaceRoot: root }),
      /escapes workspace_root/,
    );
    assert.throws(
      () => canonicalJsonString({ ...left, path: "C:\\outside.md" }, schema, { workspaceRoot: root }),
      /not absolute/,
    );
    assert.throws(
      () => canonicalJsonString({ ...left, title: "e\u0301" }, schema, { workspaceRoot: root }),
      /NFC/,
    );
    assert.throws(
      () => canonicalJsonString({ ...left, order: [Number.NaN] }, schema, { workspaceRoot: root }),
      /finite/,
    );
    assert.throws(
      () => canonicalJsonString({ ...left, order: [Number.POSITIVE_INFINITY] }, schema, { workspaceRoot: root }),
      /finite/,
    );
  } finally {
    cleanup(root);
  }
});

test("command IDs are system-derived and reject agent command_id input", () => {
  const payloadHash = canonicalJsonSha256({ operations: [{ op: "append_log", message: "x" }] });
  const identity = {
    producer_kind: "standalone-research-wiki",
    scope: "standalone",
    subject_id: "claim:x",
    evidence_bundle_id: "evidence:1",
    canonical_payload_sha256: payloadHash,
  };
  const first = computeWikiCommandId(identity);
  const retry = computeWikiCommandId({
    ...identity,
    attempt_id: "attempt-2",
    timestamp: "2099-01-01T00:00:00Z",
    pid: 99999,
    random: "different",
  });
  assert.equal(first, retry);
  for (const field of ["producer_kind", "scope", "subject_id", "evidence_bundle_id", "canonical_payload_sha256"] as const) {
    const changedValue =
      field === "canonical_payload_sha256"
        ? canonicalJsonSha256({ operations: [{ op: "append_log", message: "changed" }] })
        : `${identity[field]}-changed`;
    const changed = { ...identity, [field]: changedValue };
    assert.notEqual(computeWikiCommandId(changed), first, field);
  }
  assert.throws(
    () => computeWikiCommandId({ ...identity, command_id: "agent-chosen" }),
    /agent-supplied command_id/,
  );

  const wiki = tmpDir();
  try {
    initializeWikiSchema(wiki);
    const delta = {
      producer_kind: "test",
      scope: "modules/a0",
      subject_id: "subject",
      evidence_bundle_id: "bundle",
      payload: { operations: [], command_id: "agent-chosen" },
    } as unknown as WikiDelta;
    assert.throws(() => appendWikiEvent(wiki, delta), /command_id is agent-supplied/);
  } finally {
    cleanup(wiki);
  }
});

test("state-file lock serializes concurrent updates and canonicalizes the lock path", async () => {
  const root = tmpDir();
  try {
    const statePath = path.join(root, "nested", "state.json");
    writeStateJsonAtomic(statePath, { count: 0 });
    assert.equal(stateLockPath(statePath), stateLockPath(path.resolve(statePath)));
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        spawnTestWorker({ ARIS_A0_WORKER: "state", ARIS_A0_STATE_PATH: statePath }),
      ),
    );
    for (const result of results) {
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    }
    assert.equal(readStateFile<{ count: number }>(statePath).count, 16);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  } finally {
    cleanup(root);
  }
});

test("concurrent Wiki appends preserve every event and the complete hash chain", async () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    const delta: WikiDelta = {
      producer_kind: "test",
      scope: "modules/a0",
      subject_id: "same-subject",
      evidence_bundle_id: "same-bundle",
      payload: { operations: [{ op: "append_log", message: "same" }] },
    };
    const appended = appendWikiEvent(root, delta);
    assert.equal(appended.status, "appended");
    assert.equal(appendWikiEvent(root, delta).status, "skipped");
    assert.equal(
      appendWikiEvent(
        root,
        { ...delta, payload: { operations: [{ op: "append_log", message: "changed" }] } },
        { expectedCommandId: appended.status === "appended" ? appended.event.command_id : "" },
      ).status,
      "conflict",
    );

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        spawnTestWorker({
          ARIS_A0_WORKER: "event",
          ARIS_A0_WIKI_ROOT: root,
          ARIS_A0_INDEX: String(index),
        }),
      ),
    );
    for (const result of results) {
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    }

    const events = readWikiEvents(root);
    assert.equal(events.length, 13);
    let previous: string | null = null;
    for (const [index, event] of events.entries()) {
      assert.equal(event.seq, index + 1);
      assert.equal(event.previous_event_hash, previous);
      assert.equal(event.event_id, `event:sha256:${wikiEventHash(event)}`);
      previous = event.event_id.slice("event:sha256:".length);
    }
    assert.equal(fs.readFileSync(wikiEventsPath(root), "utf-8").endsWith("\n"), true);
    projectWiki(root);
    assert.match(fs.readFileSync(path.join(root, "log.md"), "utf-8"), /concurrent event/);
  } finally {
    cleanup(root);
  }
});

test("a valid hash without the final newline is discarded as an uncommitted tail", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    const makeDelta = (index: number): WikiDelta => ({
      producer_kind: "newline-boundary-test",
      scope: "standalone",
      subject_id: `subject-${index}`,
      evidence_bundle_id: `bundle-${index}`,
      payload: { operations: [{ op: "append_log", message: `line-${index}` }] },
    });
    appendWikiEvent(root, makeDelta(1));
    appendWikiEvent(root, makeDelta(2));
    const completeBytes = fs.readFileSync(wikiEventsPath(root));
    const secondLine = completeBytes.toString("utf-8").trimEnd().split("\n")[1]!;
    assert.match(secondLine, /event:sha256:/);
    const tornBytes = completeBytes.subarray(0, completeBytes.length - 1);
    fs.writeFileSync(wikiEventsPath(root), tornBytes);

    const events = readWikiEvents(root);
    assert.equal(events.length, 1);
    assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), completeBytes.subarray(0, completeBytes.indexOf(0x0a) + 1));
  } finally {
    cleanup(root);
  }
});

test("Wiki append loops through short writes and still commits one complete line", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    const originalWriteSync = fs.writeSync;
    fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
      const [fd, data, offset, length, position] = args;
      if (Buffer.isBuffer(data) && typeof offset === "number" && typeof length === "number" && length > 7) {
        return originalWriteSync(fd, data, offset, 7, position);
      }
      return originalWriteSync(...args);
    }) as typeof fs.writeSync;
    try {
      assert.equal(
        appendWikiEvent(root, {
          producer_kind: "short-write-test",
          scope: "standalone",
          subject_id: "short-write",
          evidence_bundle_id: "short-write",
          payload: { operations: [{ op: "append_log", message: "a deliberately long event line" }] },
        }).status,
        "appended",
      );
    } finally {
      fs.writeSync = originalWriteSync;
    }
    assert.equal(readWikiEvents(root).length, 1);
    assert.equal(fs.readFileSync(wikiEventsPath(root)).toString("utf-8").endsWith("\n"), true);
  } finally {
    cleanup(root);
  }
});

test("event persistence survives projector failure and projections rebuild byte-for-byte", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    let failOnce = true;
    assert.throws(
      () =>
        commitWikiChange(
          root,
          () => ({
            producer_kind: "test",
            scope: "modules/a0",
            subject_id: "recovery",
            evidence_bundle_id: "bundle-recovery",
            payload: { operations: [{ op: "append_log", message: "recover me" }] },
          }),
          () => {
            if (failOnce) {
              failOnce = false;
              throw new Error("simulated projector interruption");
            }
          },
        ),
      /simulated projector interruption/,
    );
    assert.equal(readWikiEvents(root).length, 1);

    projectWiki(root);
    const before = projectionFiles(root);
    assert.match(before.get("log.md")?.toString("utf-8") ?? "", /recover me/);
    deleteProjections(root);
    assert.equal(projectionFiles(root).size, 0);
    projectWiki(root);
    assert.deepEqual([...projectionFiles(root).entries()], [...before.entries()]);
  } finally {
    cleanup(root);
  }
});

test("only an incomplete tail is repaired; middle corruption fails closed", () => {
  const tailRoot = tmpDir();
  const middleRoot = tmpDir();
  try {
    initializeWikiSchema(tailRoot);
    const delta = (index: number): WikiDelta => ({
      producer_kind: "tail-test",
      scope: "modules/a0",
      subject_id: `subject-${index}`,
      evidence_bundle_id: `bundle-${index}`,
      payload: { operations: [{ op: "append_log", message: `line-${index}` }] },
    });
    appendWikiEvent(tailRoot, delta(1));
    fs.appendFileSync(wikiEventsPath(tailRoot), '{"schema_version":2');
    assert.equal(readWikiEvents(tailRoot).length, 1);
    assert.equal(fs.readFileSync(wikiEventsPath(tailRoot), "utf-8").endsWith("\n"), true);
    assert.equal(appendWikiEvent(tailRoot, delta(2)).status, "appended");
    assert.equal(readWikiEvents(tailRoot).length, 2);

    initializeWikiSchema(middleRoot);
    appendWikiEvent(middleRoot, delta(1));
    appendWikiEvent(middleRoot, delta(2));
    const lines = fs.readFileSync(wikiEventsPath(middleRoot), "utf-8").split("\n");
    lines[0] = "not-json";
    fs.writeFileSync(wikiEventsPath(middleRoot), lines.join("\n"), "utf-8");
    assert.throws(() => readWikiEvents(middleRoot), /WIKI_EVENT_LOG_CORRUPT/);
    assert.equal(fs.readFileSync(wikiEventsPath(middleRoot), "utf-8").startsWith("not-json"), true);
  } finally {
    cleanup(tailRoot);
    cleanup(middleRoot);
  }
});

test("old page-only Wiki returns WIKI_SCHEMA_UNSUPPORTED and new init writes schema v2", () => {
  const root = tmpDir();
  const oldWiki = path.join(root, "old-wiki");
  const wrongSchemaWiki = path.join(root, "wrong-schema");
  const newWiki = path.join(root, "new-wiki");
  try {
    fs.mkdirSync(path.join(oldWiki, "papers"), { recursive: true });
    fs.writeFileSync(path.join(oldWiki, "papers", "old.md"), "old page\n", "utf-8");
    const oldResult = runTsx(RESEARCH_WIKI, "stats", oldWiki);
    assert.notEqual(oldResult.exitCode, 0);
    assert.match(`${oldResult.stdout}\n${oldResult.stderr}`, /WIKI_SCHEMA_UNSUPPORTED/);

    fs.mkdirSync(wrongSchemaWiki, { recursive: true });
    fs.writeFileSync(
      path.join(wrongSchemaWiki, "schema.json"),
      `${JSON.stringify({ schema_version: 1 })}\n`,
      "utf-8",
    );
    const wrongSchemaResult = runTsx(RESEARCH_WIKI, "stats", wrongSchemaWiki);
    assert.notEqual(wrongSchemaResult.exitCode, 0);
    assert.match(`${wrongSchemaResult.stdout}\n${wrongSchemaResult.stderr}`, /WIKI_SCHEMA_UNSUPPORTED/);

    const init = runTsx(RESEARCH_WIKI, "init", newWiki);
    assert.equal(init.exitCode, 0, `${init.stdout}\n${init.stderr}`);
    const schema = JSON.parse(fs.readFileSync(wikiSchemaPath(newWiki), "utf-8")) as Record<string, unknown>;
    assert.equal(schema.schema_version, 2);
    assert.equal(schema.event_log, "events.jsonl");
    assert.equal(fs.existsSync(wikiEventsPath(newWiki)), true);
    const add = runTsx(
      RESEARCH_WIKI,
      "add_claim",
      newWiki,
      "--slug",
      "a0-claim",
      "--name",
      "A0 claim",
      "--description",
      "event sourced",
    );
    assert.equal(add.exitCode, 0, `${add.stdout}\n${add.stderr}`);
    assert.equal(readWikiEvents(newWiki).length, 1);
    assert.equal(fs.existsSync(path.join(newWiki, "claims", "a0-claim.md")), true);
  } finally {
    cleanup(root);
  }
});

test("schema v2 with a missing fact log is never reset by init, read, or commit", () => {
  const root = tmpDir();
  try {
    const init = runTsx(RESEARCH_WIKI, "init", root);
    assert.equal(init.exitCode, 0, `${init.stdout}\n${init.stderr}`);
    const add = runTsx(
      RESEARCH_WIKI,
      "add_claim",
      root,
      "--slug",
      "history",
      "--name",
      "History survives",
      "--evidence",
      "old evidence",
    );
    assert.equal(add.exitCode, 0, `${add.stdout}\n${add.stderr}`);

    const schemaBefore = fs.readFileSync(wikiSchemaPath(root));
    const projectionsBefore = [...projectionFiles(root).entries()];
    const entriesBefore = fs.readdirSync(root).sort();
    fs.unlinkSync(wikiEventsPath(root));

    const retryInit = runTsx(RESEARCH_WIKI, "init", root);
    assert.notEqual(retryInit.exitCode, 0);
    assert.match(`${retryInit.stdout}\n${retryInit.stderr}`, /WIKI_SCHEMA_UNSUPPORTED/);
    assert.equal(fs.existsSync(wikiEventsPath(root)), false);
    assert.deepEqual(fs.readFileSync(wikiSchemaPath(root)), schemaBefore);
    assert.deepEqual([...projectionFiles(root).entries()], projectionsBefore);
    assert.deepEqual(fs.readdirSync(root).sort(), entriesBefore.filter((name) => name !== "events.jsonl"));

    assert.throws(() => readWikiEvents(root), /WIKI_SCHEMA_UNSUPPORTED/);
    let buildCalled = false;
    assert.throws(
      () =>
        commitWikiChange(
          root,
          () => {
            buildCalled = true;
            return null;
          },
          () => undefined,
        ),
      /WIKI_SCHEMA_UNSUPPORTED/,
    );
    assert.equal(buildCalled, false);
    assert.equal(fs.existsSync(wikiEventsPath(root)), false);
    assert.deepEqual(fs.readFileSync(wikiSchemaPath(root)), schemaBefore);
    assert.deepEqual([...projectionFiles(root).entries()], projectionsBefore);
  } finally {
    cleanup(root);
  }
});

test("invalid Wiki payloads are rejected before the event log is touched", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    const base = {
      producer_kind: "validation-test",
      scope: "standalone",
      subject_id: "validation",
      evidence_bundle_id: "bundle",
    };
    const assertUnchanged = (payload: unknown, pattern: RegExp): void => {
      const before = fs.readFileSync(wikiEventsPath(root));
      assert.throws(
        () => appendWikiEvent(root, { ...base, payload } as WikiDelta),
        pattern,
      );
      assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), before);
    };

    assertUnchanged({ operations: [{ op: "not_a_real_operation" }] }, /invalid Wiki operation/);
    assertUnchanged(
      { operations: [{ op: "projection_marker", target: "index" }] },
      /invalid Wiki operation/,
    );
    assertUnchanged({ operations: [{ op: "append_log" }] }, /message must be a string/);
    assertUnchanged(
      { operations: [{ op: "append_log", message: "x", extra: true }] },
      /unknown field 'extra'/,
    );
    assertUnchanged({ operations: [], extra: true }, /unknown field 'extra'/);
    assertUnchanged({ operations: [{ op: "upsert_page", kind: "claim", id: "x" }] }, /data/);
    assertUnchanged(
      { operations: [{ op: "upsert_page", kind: "claim", id: "x", data: { command_id: "x" } }] },
      /command_id is agent-supplied/,
    );
    assertUnchanged(
      { operations: [{ op: "upsert_page", kind: "claim", id: "x", data: { name: "x", extra: true } }] },
      /unknown field 'extra'/,
    );
    assertUnchanged(
      {
        operations: [
          {
            op: "upsert_edge",
            edge: { from: "claim:x", to: "paper:y", type: "not-a-real-edge" },
          },
        ],
      },
      /invalid Wiki edge type/,
    );
    const beforeUnknownDelta = fs.readFileSync(wikiEventsPath(root));
    assert.throws(
      () =>
        appendWikiEvent(root, {
          ...base,
          payload: { operations: [] },
          extra: true,
        } as WikiDelta),
      /invalid Wiki delta: unknown field 'extra'/,
    );
    assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), beforeUnknownDelta);

    const incompleteTail = Buffer.from('{"schema_version":2', "utf-8");
    fs.writeFileSync(wikiEventsPath(root), incompleteTail);
    assertUnchanged({ operations: [{ op: "projection_marker", target: "index" }] }, /invalid Wiki operation/);
    assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), incompleteTail);
    assert.equal(readWikiEvents(root).length, 0);

    const valid = appendWikiEvent(root, {
      ...base,
      subject_id: "valid-envelope",
      evidence_bundle_id: "valid-envelope",
      payload: { operations: [] },
    });
    assert.equal(valid.status, "appended");
    const validBytes = fs.readFileSync(wikiEventsPath(root));
    const validLine = JSON.parse(validBytes.toString("utf-8").trim()) as Record<string, unknown>;
    for (const mutate of [
      (event: Record<string, unknown>) => {
        event.extra = true;
      },
      (event: Record<string, unknown>) => {
        (event.producer as Record<string, unknown>).extra = true;
      },
    ]) {
      const corrupted = { ...validLine, producer: { ...(validLine.producer as object) } };
      mutate(corrupted);
      const corruptedBytes = Buffer.from(`${JSON.stringify(corrupted)}\n`, "utf-8");
      fs.writeFileSync(wikiEventsPath(root), corruptedBytes);
      assert.throws(() => readWikiEvents(root), /WIKI_EVENT_LOG_CORRUPT/);
      assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), corruptedBytes);
      fs.writeFileSync(wikiEventsPath(root), validBytes);
    }
  } finally {
    cleanup(root);
  }
});

test("rebuild is pure, and complete corrupt final lines remain untouched", () => {
  const root = tmpDir();
  try {
    const init = runTsx(RESEARCH_WIKI, "init", root);
    assert.equal(init.exitCode, 0, `${init.stdout}\n${init.stderr}`);
    for (const args of [
      ["add_claim", root, "--slug", "rebuild-claim", "--name", "Rebuild claim"],
      ["add_experiment", root, "--slug", "rebuild-exp", "--title", "Rebuild experiment"],
    ]) {
      const result = runTsx(RESEARCH_WIKI, ...args);
      assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    }
    const eventsBefore = fs.readFileSync(wikiEventsPath(root));
    const projectionsBefore = [...projectionFiles(root).entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    deleteProjections(root);
    const rebuild = runTsx(RESEARCH_WIKI, "rebuild", root);
    assert.equal(rebuild.exitCode, 0, `${rebuild.stdout}\n${rebuild.stderr}`);
    assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), eventsBefore);
    const projectionsAfter = [...projectionFiles(root).entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    assert.deepEqual(projectionsAfter, projectionsBefore);

    for (const command of ["rebuild_index", "rebuild_query_pack"]) {
      const result = runTsx(RESEARCH_WIKI, command, root);
      assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(fs.readFileSync(wikiEventsPath(root)), eventsBefore);
    }
    const configChange = runTsx(RESEARCH_WIKI, "rebuild_query_pack", root, "--max-chars", "9000");
    assert.equal(configChange.exitCode, 0, `${configChange.stdout}\n${configChange.stderr}`);
    const afterConfig = readWikiEvents(root);
    assert.equal(afterConfig.length, 3);
    const configOperations = (afterConfig[2].payload as { operations: Array<{ op: string }> })
      .operations;
    assert.deepEqual(configOperations.map((operation) => operation.op), ["set_projection_config"]);
    assert.equal(configOperations.some((operation) => operation.op === "projection_marker"), false);
    const repeatedConfig = runTsx(RESEARCH_WIKI, "rebuild_query_pack", root, "--max-chars", "9000");
    assert.equal(repeatedConfig.exitCode, 0, `${repeatedConfig.stdout}\n${repeatedConfig.stderr}`);
    assert.equal(readWikiEvents(root).length, 3);
  } finally {
    cleanup(root);
  }

  const corruptions = ["payload", "payload-hash", "event-hash", "chain"] as const;
  for (const corruption of corruptions) {
    const corruptRoot = tmpDir();
    try {
      initializeWikiSchema(corruptRoot);
      const delta = (index: number): WikiDelta => ({
        producer_kind: "corrupt-final-line",
        scope: "standalone",
        subject_id: `subject-${index}`,
        evidence_bundle_id: `bundle-${index}`,
        payload: { operations: [{ op: "append_log", message: `line-${index}` }] },
      });
      appendWikiEvent(corruptRoot, delta(1));
      appendWikiEvent(corruptRoot, delta(2));
      const lines = fs.readFileSync(wikiEventsPath(corruptRoot), "utf-8").trimEnd().split("\n");
      const finalEvent = JSON.parse(lines[1]!) as Record<string, unknown>;
      if (corruption === "payload") {
        const payload = finalEvent.payload as { operations: Array<Record<string, unknown>> };
        payload.operations[0]!.message = "tampered";
      } else if (corruption === "payload-hash") {
        finalEvent.payload_sha256 = "0".repeat(64);
        finalEvent.event_id = `event:sha256:${wikiEventHash(finalEvent as unknown as WikiEvent)}`;
      } else if (corruption === "event-hash") {
        finalEvent.event_id = `event:sha256:${"0".repeat(64)}`;
      } else {
        finalEvent.previous_event_hash = "f".repeat(64);
        finalEvent.event_id = `event:sha256:${wikiEventHash(finalEvent as unknown as WikiEvent)}`;
      }
      lines[1] = JSON.stringify(finalEvent);
      fs.writeFileSync(wikiEventsPath(corruptRoot), `${lines.join("\n")}\n`, "utf-8");
      const corruptedBytes = fs.readFileSync(wikiEventsPath(corruptRoot));
      assert.throws(() => readWikiEvents(corruptRoot), /WIKI_EVENT_LOG_CORRUPT/);
      assert.deepEqual(fs.readFileSync(wikiEventsPath(corruptRoot)), corruptedBytes);
    } finally {
      cleanup(corruptRoot);
    }
  }
});

test("query-pack configuration records clears and repeated state transitions causally", () => {
  const projectRoot = tmpDir();
  const wikiRoot = path.join(projectRoot, "research-wiki");
  const briefPath = path.join(projectRoot, "task.md");
  try {
    const init = runTsx(RESEARCH_WIKI, "init", wikiRoot);
    assert.equal(init.exitCode, 0, `${init.stdout}\n${init.stderr}`);

    fs.writeFileSync(briefPath, "A", "utf-8");
    assert.equal(runTsx(RESEARCH_WIKI, "rebuild_query_pack", wikiRoot).exitCode, 0);
    fs.unlinkSync(briefPath);
    assert.equal(runTsx(RESEARCH_WIKI, "rebuild_query_pack", wikiRoot).exitCode, 0);
    assert.equal(readWikiModel(wikiRoot).project_direction, null);
    fs.writeFileSync(briefPath, "A", "utf-8");
    assert.equal(runTsx(RESEARCH_WIKI, "rebuild_query_pack", wikiRoot).exitCode, 0);

    for (const maxChars of ["9000", "8000", "9000"]) {
      const result = runTsx(RESEARCH_WIKI, "rebuild_query_pack", wikiRoot, "--max-chars", maxChars);
      assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    }
    const beforeRetry = readWikiEvents(wikiRoot);
    assert.equal(beforeRetry.length, 6);
    const retry = runTsx(RESEARCH_WIKI, "rebuild_query_pack", wikiRoot, "--max-chars", "9000");
    assert.equal(retry.exitCode, 0, `${retry.stdout}\n${retry.stderr}`);
    const afterRetry = readWikiEvents(wikiRoot);
    assert.equal(afterRetry.length, beforeRetry.length);
    assert.equal(new Set(afterRetry.map((event) => event.command_id)).size, afterRetry.length);

    const model = readWikiModel(wikiRoot);
    assert.equal(model.project_direction, "A");
    assert.equal(model.max_query_chars, 9000);
    assert.deepEqual(
      afterRetry.map((event) => (event.payload as { operations: Array<{ op: string }> }).operations[0]!.op),
      [
        "set_project_direction",
        "set_project_direction",
        "set_project_direction",
        "set_projection_config",
        "set_projection_config",
        "set_projection_config",
      ],
    );
    assert.notEqual(afterRetry[0]!.evidence_bundle_id, afterRetry[2]!.evidence_bundle_id);
    assert.notEqual(afterRetry[3]!.evidence_bundle_id, afterRetry[5]!.evidence_bundle_id);
  } finally {
    cleanup(projectRoot);
  }
});

test("identical problem updates are skipped and new evidence is appended once", () => {
  const root = tmpDir();
  try {
    const first = runTsx(
      RESEARCH_WIKI,
      "init",
      root,
    );
    assert.equal(first.exitCode, 0, `${first.stdout}\n${first.stderr}`);
    const add = runTsx(
      RESEARCH_WIKI,
      "add_problem",
      root,
      "--slug",
      "p",
      "--title",
      "Problem",
      "--evidence",
      "base",
    );
    assert.equal(add.exitCode, 0, `${add.stdout}\n${add.stderr}`);
    assert.match(add.stdout, /Problem added:/);
    const updateArgs = [
      "add_problem",
      root,
      "--slug",
      "p",
      "--title",
      "Problem",
      "--evidence",
      "delta",
      "--update-on-exist",
    ];
    const update = runTsx(RESEARCH_WIKI, ...updateArgs);
    assert.equal(update.exitCode, 0, `${update.stdout}\n${update.stderr}`);
    assert.match(update.stdout, /Problem updated:/);
    assert.equal(readWikiEvents(root).length, 2);
    const unrelated = runTsx(RESEARCH_WIKI, "log", root, "unrelated event");
    assert.equal(unrelated.exitCode, 0, `${unrelated.stdout}\n${unrelated.stderr}`);
    assert.equal(readWikiEvents(root).length, 3);
    const retry = runTsx(RESEARCH_WIKI, ...updateArgs);
    assert.equal(retry.exitCode, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(readWikiEvents(root).length, 3);
    assert.equal(/Problem (?:added|updated):/.test(retry.stdout), false);

    const different = runTsx(
      RESEARCH_WIKI,
      "add_problem",
      root,
      "--slug",
      "p",
      "--title",
      "Problem",
      "--evidence",
      "delta-2",
      "--update-on-exist",
    );
    assert.equal(different.exitCode, 0, `${different.stdout}\n${different.stderr}`);
    assert.equal(readWikiEvents(root).length, 4);
    const page = fs.readFileSync(path.join(root, "problems", "p.md"), "utf-8");
    const evidenceSection = page.split("## Evidence\n")[1]?.split("\n## What would solve it")[0];
    assert.equal(evidenceSection?.trim(), "base\n\ndelta\n\ndelta-2");
  } finally {
    cleanup(root);
  }
});

test("legacy scopes replay, unsafe scopes and loop-era payloads are rejected", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    const scopedDelta = (scope: string, subject: string): WikiDelta => ({
      producer_kind: "scope-test",
      scope,
      subject_id: subject,
      evidence_bundle_id: subject,
      payload: { operations: [{ op: "append_log", message: scope }] },
    });
    appendWikiEvent(root, scopedDelta("modules/a", "a"));
    for (const invalid of ["modules-a", "../escape", "modules/../escape", "modules/a/b", "test"]) {
      assert.throws(() => appendWikiEvent(root, scopedDelta(invalid, invalid)), /invalid Wiki scope/);
    }
    assert.throws(
      () =>
        appendWikiEvent(root, {
          ...scopedDelta("standalone", "unsafe-page"),
          payload: {
            operations: [
              { op: "upsert_page", kind: "claim", id: "../escape", data: { name: "escape" } },
            ],
          },
        }),
      /invalid Wiki page id/,
    );
    assert.throws(() =>
      appendWikiEvent(root, {
        ...scopedDelta("standalone", "context"),
        payload: { operations: [], context: {} },
      }),
    );
    assert.throws(() =>
      appendWikiEvent(root, {
        ...scopedDelta("standalone", "signal"),
        payload: { operations: [{ op: "retract_signal", id: "s1" }] },
      }),
    );
    projectWiki(root);
    assert.equal(fs.existsSync(path.join(root, "scopes")), false);
    assert.equal(fs.existsSync(path.join(root, "signals")), false);
  } finally {
    cleanup(root);
  }
});

test("event logs written by the research loop still replay", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    const payload = {
      operations: [
        { op: "retract_signal", id: "s1" },
        { op: "upsert_page", kind: "claim", id: "c1", data: { name: "kept" } },
      ],
      context: { iteration: 3 },
    };
    const payloadHash = canonicalJsonSha256(payload);
    const producer = { kind: "loop", scope: "runs/r1/modules/m", subject_id: "c1" };
    const event = {
      schema_version: 2,
      seq: 1,
      command_id: computeWikiCommandId({
        producer_kind: producer.kind,
        scope: producer.scope,
        subject_id: producer.subject_id,
        evidence_bundle_id: "legacy",
        canonical_payload_sha256: payloadHash,
      }),
      payload_sha256: payloadHash,
      previous_event_hash: null,
      committed_at: "2026-01-01T00:00:00Z",
      evidence_bundle_id: "legacy",
      producer,
      event_type: "knowledge_delta_committed",
      payload,
      event_id: "",
    } as unknown as WikiEvent;
    event.event_id = `event:sha256:${wikiEventHash(event)}`;
    fs.writeFileSync(wikiEventsPath(root), `${canonicalJsonString(event)}\n`);
    assert.equal(readWikiEvents(root).length, 1);
    projectWiki(root);
    assert.match(fs.readFileSync(path.join(root, "claims", "c1.md"), "utf-8"), /kept/);
  } finally {
    cleanup(root);
  }
});

test("projector identity ordering is locale-independent UTF-16 code-unit order", () => {
  const root = tmpDir();
  try {
    initializeWikiSchema(root);
    for (const id of ["a_0", "2", "a-b", "10"]) {
      appendWikiEvent(root, {
        producer_kind: "sort-test",
        scope: "standalone",
        subject_id: `claim:${id}`,
        evidence_bundle_id: `sort:${id}`,
        payload: {
          operations: [
            {
              op: "upsert_page",
              kind: "claim",
              id,
              data: { name: id, date: "2026-01-01" },
            },
          ],
        },
      });
    }
    projectWiki(root);
    const claimIds = fs
      .readFileSync(path.join(root, "index.md"), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("- `claim:"))
      .map((line) => line.slice("- `claim:".length).split("`", 1)[0]);
    assert.deepEqual(claimIds, ["10", "2", "a-b", "a_0"]);
  } finally {
    cleanup(root);
  }
});

test("state-file canonicalization resolves symlinked parents before a target exists", () => {
  const root = tmpDir();
  try {
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, alias, "dir");
    const realState = path.join(real, "nested", "state.json");
    const aliasState = path.join(alias, "nested", "state.json");
    assert.equal(canonicalStatePath(realState), canonicalStatePath(aliasState));
    assert.equal(stateLockPath(realState), stateLockPath(aliasState));
    writeStateJsonAtomic(realState, { count: 1 });
    assert.equal(canonicalStatePath(realState), canonicalStatePath(aliasState));
    assert.equal(stateLockPath(realState), stateLockPath(aliasState));
    assert.equal(readStateFile<{ count: number }>(aliasState).count, 1);
  } finally {
    cleanup(root);
  }
});

test("standalone first-write output, claim dates, and experiment IDs remain compatible", () => {
  const root = tmpDir();
  try {
    const init = runTsx(RESEARCH_WIKI, "init", root);
    assert.equal(init.exitCode, 0, `${init.stdout}\n${init.stderr}`);
    const absoluteClaim = runTsx(
      RESEARCH_WIKI,
      "add_claim",
      root,
      "--slug",
      path.join(root, "absolute-claim"),
      "--name",
      "Absolute claim",
    );
    assert.notEqual(absoluteClaim.exitCode, 0);
    assert.match(`${absoluteClaim.stdout}\n${absoluteClaim.stderr}`, /relative identifier/);
    const absoluteExperiment = runTsx(
      RESEARCH_WIKI,
      "add_experiment",
      root,
      "--slug",
      path.join(root, "absolute-experiment"),
      "--title",
      "Absolute experiment",
    );
    assert.notEqual(absoluteExperiment.exitCode, 0);
    assert.match(`${absoluteExperiment.stdout}\n${absoluteExperiment.stderr}`, /relative identifier/);
    assert.equal(readWikiEvents(root).length, 0);
    const emptySync = runTsx(RESEARCH_WIKI, "sync", root);
    assert.equal(emptySync.exitCode, 2);
    assert.match(`${emptySync.stdout}\n${emptySync.stderr}`, /sync: no arxiv ids supplied/);
    const missingFileSync = runTsx(
      RESEARCH_WIKI,
      "sync",
      root,
      "--from-file",
      path.join(root, "missing-ids.txt"),
    );
    assert.equal(missingFileSync.exitCode, 2);
    assert.match(`${missingFileSync.stdout}\n${missingFileSync.stderr}`, /--from-file not found/);
    const paper = runTsx(
      RESEARCH_WIKI,
      "ingest_paper",
      root,
      "--title",
      "A Paper",
      "--authors",
      "An Author",
      "--year",
      "2026",
    );
    assert.equal(paper.exitCode, 0, `${paper.stdout}\n${paper.stderr}`);
    const paperPage = fs.readFileSync(path.join(root, "papers", "author2026_paper.md"), "utf-8");
    assert.equal(
      paperPage.split("## Assumptions\n")[1]?.split("\n## Limitations / Failure Modes")[0]?.trim(),
      "_TODO._",
    );
    const claim = runTsx(
      RESEARCH_WIKI,
      "add_claim",
      root,
      "--slug",
      "visible-claim",
      "--name",
      "Visible claim",
      "--evidence",
      "claim evidence",
    );
    assert.equal(claim.exitCode, 0, `${claim.stdout}\n${claim.stderr}`);
    assert.match(claim.stdout, /Claim added:/);
    assert.equal(claim.stdout.includes("Claim updated:"), false);
    const claimPage = fs.readFileSync(path.join(root, "claims", "visible-claim.md"), "utf-8");
    assert.match(claimPage, /^date: \d{4}-\d{2}-\d{2}$/m);
    const skippedClaim = runTsx(
      RESEARCH_WIKI,
      "add_claim",
      root,
      "--slug",
      "visible-claim",
      "--name",
      "Visible claim",
    );
    assert.equal(skippedClaim.exitCode, 0, `${skippedClaim.stdout}\n${skippedClaim.stderr}`);
    assert.match(skippedClaim.stdout, /already exists/);
    assert.match(skippedClaim.stdout, /Claim skipped:/);
    assert.equal(/Claim (?:added|updated):/.test(skippedClaim.stdout), false);

    const experiment = runTsx(
      RESEARCH_WIKI,
      "add_experiment",
      root,
      "--slug",
      "exp-visible",
      "--title",
      "Visible experiment",
    );
    assert.equal(experiment.exitCode, 0, `${experiment.stdout}\n${experiment.stderr}`);
    assert.match(experiment.stdout, /Experiment added:/);
    const skippedExperiment = runTsx(
      RESEARCH_WIKI,
      "add_experiment",
      root,
      "--slug",
      "exp-visible",
      "--title",
      "Visible experiment",
    );
    assert.equal(skippedExperiment.exitCode, 0, `${skippedExperiment.stdout}\n${skippedExperiment.stderr}`);
    assert.match(skippedExperiment.stdout, /already exists/);
    assert.match(skippedExperiment.stdout, /Experiment skipped:/);
    assert.equal(/Experiment (?:added|updated):/.test(skippedExperiment.stdout), false);
    const beforeUpsertRetry = readWikiEvents(root).length;
    const upsertExperimentArgs = [
      "add_experiment",
      root,
      "--slug",
      "exp-upsert",
      "--title",
      "Upsert experiment",
      "--update-on-exist",
    ];
    const firstUpsert = runTsx(RESEARCH_WIKI, ...upsertExperimentArgs);
    assert.equal(firstUpsert.exitCode, 0, `${firstUpsert.stdout}\n${firstUpsert.stderr}`);
    const retryUpsert = runTsx(RESEARCH_WIKI, ...upsertExperimentArgs);
    assert.equal(retryUpsert.exitCode, 0, `${retryUpsert.stdout}\n${retryUpsert.stderr}`);
    assert.match(retryUpsert.stdout, /Experiment skipped:/);
    assert.equal(readWikiEvents(root).length, beforeUpsertRetry + 1);
    // Once the experiment supports a claim, the same id is reused as it is:
    // neither its page nor the claim edge is rewritten by a later update.
    const formed = runTsx(
      RESEARCH_WIKI,
      "add_edge",
      root,
      "--from",
      "exp:exp-upsert",
      "--to",
      "claim:visible-claim",
      "--type",
      "supports",
    );
    assert.equal(formed.exitCode, 0, `${formed.stdout}\n${formed.stderr}`);
    const beforeReuse = readWikiEvents(root).length;
    const reused = runTsx(
      RESEARCH_WIKI,
      "add_experiment",
      root,
      "--slug",
      "exp-upsert",
      "--title",
      "Rewritten experiment",
      "--update-on-exist",
    );
    assert.equal(reused.exitCode, 0, `${reused.stdout}\n${reused.stderr}`);
    assert.match(reused.stdout, /Experiment reused:/);
    assert.equal(/Experiment (?:added|updated|skipped):/.test(reused.stdout), false);
    assert.equal(readWikiEvents(root).length, beforeReuse);
    const reusedPage = fs.readFileSync(path.join(root, "experiments", "exp-upsert.md"), "utf-8");
    assert.match(reusedPage, /Upsert experiment/);
    assert.equal(reusedPage.includes("Rewritten experiment"), false);
    const index = fs.readFileSync(path.join(root, "index.md"), "utf-8");
    assert.match(index, /`exp:exp-visible`/);
    assert.equal(index.includes("`experiment:exp-visible`"), false);
  } finally {
    cleanup(root);
  }
});

const OVERLEAF_CLI = path.resolve("src/tools/overleaf-cli.ts");
const ENSURE_BROWSER_ACT = path.resolve("src/tools/ensure-browser-act.ts");

test("overleaf audit finds a leaked token without printing it", () => {
  const root = tmpDir();
  const token = `olp_${"A1b2C3d4".repeat(4)}`;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  try {
    fs.writeFileSync(path.join(root, "clean.tex"), "no secrets here\n");
    let result = runTsx(OVERLEAF_CLI, "audit", root);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).clean, true);

    git("init", "-q");
    fs.writeFileSync(path.join(root, "notes.md"), `line one\ntoken ${token}\n`);
    git("add", ".");
    git("commit", "-qm", `oops ${token}`);
    git("remote", "add", "origin", `https://git:${token}@git.overleaf.com/abc`);
    result = runTsx(OVERLEAF_CLI, "audit", root);
    assert.equal(result.exitCode, 1);
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    const report = JSON.parse(result.stdout) as { clean: boolean; leaks: { kind: string; where: string }[] };
    assert.equal(report.clean, false);
    assert.deepEqual(
      report.leaks.map((leak) => leak.kind).sort(),
      ["history", "remote_url", "working_tree"],
    );
    assert.ok(report.leaks.some((leak) => leak.where === "notes.md:2"));
    assert.ok(report.leaks.some((leak) => leak.where.includes("olp_<redacted>")));
  } finally {
    cleanup(root);
  }
});

test("overleaf mirror makes the target match and dry-run changes nothing", () => {
  const root = tmpDir();
  const from = path.join(root, "from");
  const to = path.join(root, "to");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  try {
    write(path.join(from, "main.tex"), "new");
    write(path.join(from, "sec", "intro.tex"), "intro");
    write(path.join(from, "main.aux"), "build output");
    write(path.join(to, "main.tex"), "old");
    write(path.join(to, "stale.tex"), "gone upstream");
    write(path.join(to, ".git", "config"), "keep");

    let result = runTsx(OVERLEAF_CLI, "mirror", from, to, "--dry-run");
    assert.equal(result.exitCode, 0, result.stderr);
    const plan = JSON.parse(result.stdout) as { dry_run: boolean; copy: string[]; remove: string[] };
    assert.equal(plan.dry_run, true);
    assert.deepEqual(plan.copy.sort(), ["main.tex", "sec/intro.tex"]);
    assert.deepEqual(plan.remove, ["stale.tex"]);
    assert.equal(fs.readFileSync(path.join(to, "main.tex"), "utf8"), "old");

    result = runTsx(OVERLEAF_CLI, "mirror", from, to);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(to, "main.tex"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(to, "sec", "intro.tex"), "utf8"), "intro");
    assert.ok(!fs.existsSync(path.join(to, "stale.tex")));
    assert.ok(!fs.existsSync(path.join(to, "main.aux")));
    assert.equal(fs.readFileSync(path.join(to, ".git", "config"), "utf8"), "keep");

    result = runTsx(OVERLEAF_CLI, "mirror", from, to, "--dry-run");
    assert.deepEqual(JSON.parse(result.stdout), { dry_run: true, copy: [], remove: [] });
  } finally {
    cleanup(root);
  }
});

test("overleaf setup refuses to run without a terminal", () => {
  const root = tmpDir();
  try {
    const result = runTsx(OVERLEAF_CLI, "setup", "0123456789abcdef01234567", path.join(root, "clone"));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /interactive terminal/);
    assert.ok(!fs.existsSync(path.join(root, "clone")));
  } finally {
    cleanup(root);
  }
});

test("ensure-browser-act reports one JSON status and rejects unknown flags", () => {
  const usage = runTsx(ENSURE_BROWSER_ACT, "--skill-only");
  assert.equal(usage.exitCode, 1);
  assert.match(usage.stderr, /usage: ensure-browser-act\.js \[--check\]/);

  const result = runTsx(ENSURE_BROWSER_ACT, "--check");
  const status = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(status.tool, "browser-act");
  assert.equal(status.installed_now, false);
  assert.ok(status.status === "ok" || status.status === "missing");
  assert.equal(result.exitCode, status.status === "ok" ? 0 : 1);
  assert.equal(status.hint === null, status.status === "ok");
});

async function main(): Promise<void> {
  if (process.env.ARIS_A0_WORKER) {
    await runWorker();
    return;
  }

  let passed = 0;
  let failed = 0;
  for (const current of tests) {
    try {
      await current.fn();
      console.log(`  PASS ${current.name}`);
      passed += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.log(`  FAIL ${current.name}: ${message}`);
      failed += 1;
      if (process.argv.includes("--bail")) break;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
