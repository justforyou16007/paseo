import { describe, expect, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

describe("normalizeWorkspaceTabTarget", () => {
  test("normalizes an aris target without a runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris" })).toEqual({
      kind: "aris",
      view: "cockpit",
    });
  });

  test("normalizes an aris target with a runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris", runId: "run-1" })).toEqual({
      kind: "aris",
      runId: "run-1",
      view: "cockpit",
    });
  });

  test("trims whitespace from aris runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris", runId: "  run-1  " })).toEqual({
      kind: "aris",
      runId: "run-1",
      view: "cockpit",
    });
  });

  test("drops an empty aris runId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris", runId: "  " })).toEqual({
      kind: "aris",
      view: "cockpit",
    });
  });
});

describe("workspaceTabTargetsEqual", () => {
  test("considers two aris targets without runId equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris", view: "cockpit" },
        { kind: "aris", view: "cockpit" },
      ),
    ).toBe(true);
  });

  test("considers aris targets with the same runId equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris", runId: "run-1", view: "cockpit" },
        { kind: "aris", runId: "run-1", view: "cockpit" },
      ),
    ).toBe(true);
  });

  test("considers aris targets with different runIds unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris", runId: "run-1", view: "cockpit" },
        { kind: "aris", runId: "run-2", view: "cockpit" },
      ),
    ).toBe(false);
  });

  test("considers aris target with and without runId unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris", runId: "run-1", view: "cockpit" },
        { kind: "aris", view: "cockpit" },
      ),
    ).toBe(false);
  });
});

describe("buildDeterministicWorkspaceTabId", () => {
  test("returns a stable id for an aris overview tab", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "aris", view: "cockpit" })).toBe(
      "aris_cockpit",
    );
  });

  test("returns a stable id for an aris run tab", () => {
    expect(
      buildDeterministicWorkspaceTabId({ kind: "aris", runId: "run-1", view: "cockpit" }),
    ).toBe("aris_cockpit_run-1");
  });
});

describe("aris-artifact tab target", () => {
  test("normalize returns the target for a valid stageId", () => {
    expect(normalizeWorkspaceTabTarget({ kind: "aris-artifact", stageId: "W2" })).toEqual({
      kind: "aris-artifact",
      stageId: "W2",
    });
  });

  test("normalize returns null for an invalid stageId", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "aris-artifact",
        stageId: "W9",
      } as unknown as WorkspaceTabTarget),
    ).toBeNull();
    expect(
      normalizeWorkspaceTabTarget({
        kind: "aris-artifact",
        stageId: "",
      } as unknown as WorkspaceTabTarget),
    ).toBeNull();
    expect(normalizeWorkspaceTabTarget(null)).toBeNull();
  });

  test("workspaceTabTargetsEqual compares stageId", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris-artifact", stageId: "W2" },
        { kind: "aris-artifact", stageId: "W2" },
      ),
    ).toBe(true);
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris-artifact", stageId: "W2" },
        { kind: "aris-artifact", stageId: "W3" },
      ),
    ).toBe(false);
    expect(
      workspaceTabTargetsEqual(
        { kind: "aris-artifact", stageId: "W2" },
        { kind: "aris", view: "cockpit" },
      ),
    ).toBe(false);
  });

  test("buildDeterministicWorkspaceTabId returns aris-artifact_<stageId>", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "aris-artifact", stageId: "W2" })).toBe(
      "aris-artifact_W2",
    );
  });
});
