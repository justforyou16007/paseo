import { describe, expect, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";

describe("normalizeWorkspaceTabTarget", () => {
  test("normalizes an aris target without a runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris" })).toEqual({ kind: "aris" });
  });

  test("normalizes an aris target with a runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris", runId: "run-1" })).toEqual({
      kind: "aris",
      runId: "run-1",
    });
  });

  test("trims whitespace from aris runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris", runId: "  run-1  " })).toEqual({
      kind: "aris",
      runId: "run-1",
    });
  });

  test("drops an empty aris runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris", runId: "  " })).toEqual({ kind: "aris" });
  });
});

describe("workspaceTabTargetsEqual", () => {
  test("considers two aris targets without runId equal", () => {
    expect(workspaceTabTargetsEqual({ kind: "aris" }, { kind: "aris" })).toBe(true);
  });

  test("considers aris targets with the same runId equal", () => {
    expect(
      workspaceTabTargetsEqual({ kind: "aris", runId: "run-1" }, { kind: "aris", runId: "run-1" }),
    ).toBe(true);
  });

  test("considers aris targets with different runIds unequal", () => {
    expect(
      workspaceTabTargetsEqual({ kind: "aris", runId: "run-1" }, { kind: "aris", runId: "run-2" }),
    ).toBe(false);
  });

  test("considers aris target with and without runId unequal", () => {
    expect(workspaceTabTargetsEqual({ kind: "aris", runId: "run-1" }, { kind: "aris" })).toBe(
      false,
    );
  });
});

describe("buildDeterministicWorkspaceTabId", () => {
  test("returns a stable id for an aris overview tab", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "aris" })).toBe("aris_overview");
  });

  test("returns a stable id for an aris run tab", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "aris", runId: "run-1" })).toBe("aris_run-1");
  });
});
