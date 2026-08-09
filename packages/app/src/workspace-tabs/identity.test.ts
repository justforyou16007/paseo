import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("working diff tab identity", () => {
  const target = {
    kind: "working_diff" as const,
    focusPath: "src/example.ts",
    focusRequestId: 1,
  };

  it("normalizes file focus navigation", () => {
    expect(
      normalizeWorkspaceTabTarget({
        ...target,
        focusPath: " src\\example.ts ",
      }),
    ).toEqual(target);
  });

  it("treats focus as navigation state rather than tab identity", () => {
    expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    expect(workspaceTabTargetsEqual(target, { ...target, focusPath: "src/other.ts" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { ...target, focusRequestId: 2 })).toBe(false);
    const workingDiffId = buildDeterministicWorkspaceTabId(target);
    const otherFocusId = buildDeterministicWorkspaceTabId({
      ...target,
      focusPath: "src/other.ts",
    });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: target.focusPath,
    });

    expect(workingDiffId).toBe("working_diff");
    expect(workingDiffId).toBe(otherFocusId);
    expect(workingDiffId).not.toBe(fileId);
  });
});

describe("commit diff tab identity", () => {
  it("keys a commit diff tab by its sha", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" })).toBe(
      "commit_diff_abc123",
    );
  });

  it("does not collide a commit diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "abc123",
    });
    expect(diffId).not.toBe(fileId);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "abc123" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "def456" },
      ),
    ).toBe(false);
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "abc123",
      }),
    ).toEqual({ kind: "commit_diff", sha: "abc123" });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "   ",
      }),
    ).toBeNull();
  });
});

describe("aris tab target", () => {
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
