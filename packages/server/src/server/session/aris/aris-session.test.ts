import { describe, expect, test, vi, beforeEach } from "vitest";
import pino from "pino";
import { ArisSession } from "./aris-session.js";
import * as arisReaders from "./aris-readers.js";
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
