import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { normalizeWorkspaceFileLocation, workspaceFileLocationsEqual } from "@/workspace/file-open";

type WorkspaceDraftTabSetup = NonNullable<Extract<WorkspaceTabTarget, { kind: "draft" }>["setup"]>;

export function normalizeWorkspaceTabTarget(
  value: WorkspaceTabTarget | null | undefined,
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "draft") {
    const draftId = trimNonEmpty(value.draftId);
    if (!draftId) {
      return null;
    }
    const setup = normalizeWorkspaceDraftTabSetup(value.setup);
    return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
  }
  if (value.kind === "agent") {
    const agentId = trimNonEmpty(value.agentId);
    return agentId ? { kind: "agent", agentId } : null;
  }
  if (value.kind === "terminal") {
    const terminalId = trimNonEmpty(value.terminalId);
    return terminalId ? { kind: "terminal", terminalId } : null;
  }
  if (value.kind === "browser") {
    const browserId = trimNonEmpty(value.browserId);
    return browserId ? { kind: "browser", browserId } : null;
  }
  if (value.kind === "file") {
    return normalizeFileTabTarget(value);
  }
  if (value.kind === "setup") {
    const workspaceId = trimNonEmpty(value.workspaceId);
    return workspaceId ? { kind: "setup", workspaceId } : null;
  }
  if (value.kind === "aris") {
    return normalizeArisTabTarget(value);
  }
  if (value.kind === "aris-artifact") {
    return normalizeArisArtifactTabTarget(value);
  }
  if (value.kind === "aris-wiki-entity") {
    return normalizeArisWikiEntityTabTarget(value);
  }
  return null;
}

function normalizeArisTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "aris" }>,
): Extract<WorkspaceTabTarget, { kind: "aris" }> {
  const runId =
    typeof value.runId === "string" && value.runId.trim().length > 0
      ? value.runId.trim()
      : undefined;
  const view = value.view === "graph" || value.view === "review" ? value.view : "cockpit";
  return { kind: "aris", runId, view };
}

const ARIS_ARTIFACT_STAGE_IDS = ["W1", "W1.5", "W2", "W3", "W4", "W5", "W6"] as const;

function isArisArtifactStageId(value: unknown): value is (typeof ARIS_ARTIFACT_STAGE_IDS)[number] {
  return (
    typeof value === "string" && (ARIS_ARTIFACT_STAGE_IDS as readonly string[]).includes(value)
  );
}

function normalizeArisArtifactTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "aris-artifact" }>,
): WorkspaceTabTarget | null {
  if (!isArisArtifactStageId(value.stageId)) {
    return null;
  }
  return { kind: "aris-artifact", stageId: value.stageId };
}

const ARIS_WIKI_ENTITY_TYPES = ["papers", "ideas", "experiments", "claims", "gap"] as const;

function isArisWikiEntityType(value: unknown): value is (typeof ARIS_WIKI_ENTITY_TYPES)[number] {
  return typeof value === "string" && (ARIS_WIKI_ENTITY_TYPES as readonly string[]).includes(value);
}

function normalizeArisWikiEntityTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "aris-wiki-entity" }>,
): WorkspaceTabTarget | null {
  if (!isArisWikiEntityType(value.entityType)) {
    return null;
  }
  const entityId = trimNonEmpty(value.entityId);
  if (!entityId) {
    return null;
  }
  return { kind: "aris-wiki-entity", entityType: value.entityType, entityId };
}

export function normalizeWorkspaceDraftTabSetup(
  value: unknown,
): WorkspaceDraftTabSetup | undefined {
  const record = isPlainRecord(value) ? value : null;
  if (!record) {
    return undefined;
  }
  const provider = trimNonEmpty(typeof record.provider === "string" ? record.provider : null);
  const cwd = trimNonEmpty(typeof record.cwd === "string" ? record.cwd : null);
  if (!provider || !cwd) {
    return undefined;
  }
  return {
    provider,
    cwd,
    modeId: trimOptionalString(typeof record.modeId === "string" ? record.modeId : null),
    model: trimOptionalString(typeof record.model === "string" ? record.model : null),
    thinkingOptionId: trimOptionalString(
      typeof record.thinkingOptionId === "string" ? record.thinkingOptionId : null,
    ),
    featureValues: isPlainRecord(record.featureValues) ? { ...record.featureValues } : {},
  };
}

export function workspaceTabTargetsEqual(
  left: WorkspaceTabTarget,
  right: WorkspaceTabTarget,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  // After the kind check above, `right` has the same kind as `left`. tsgo
  // doesn't narrow the second operand through correlation, so we cast.
  switch (left.kind) {
    case "draft":
      return workspaceDraftTabTargetsEqual(
        left,
        right as Extract<WorkspaceTabTarget, { kind: "draft" }>,
      );
    case "agent":
      return left.agentId === (right as Extract<WorkspaceTabTarget, { kind: "agent" }>).agentId;
    case "terminal":
      return (
        left.terminalId === (right as Extract<WorkspaceTabTarget, { kind: "terminal" }>).terminalId
      );
    case "browser":
      return (
        left.browserId === (right as Extract<WorkspaceTabTarget, { kind: "browser" }>).browserId
      );
    case "file":
      return workspaceFileLocationsEqual(
        left,
        right as Extract<WorkspaceTabTarget, { kind: "file" }>,
      );
    case "setup":
      return (
        left.workspaceId === (right as Extract<WorkspaceTabTarget, { kind: "setup" }>).workspaceId
      );
    case "aris": {
      const r = right as Extract<WorkspaceTabTarget, { kind: "aris" }>;
      return left.runId === r.runId && left.view === r.view;
    }
    case "aris-artifact":
      return (
        left.stageId === (right as Extract<WorkspaceTabTarget, { kind: "aris-artifact" }>).stageId
      );
    case "aris-wiki-entity": {
      const r = right as Extract<WorkspaceTabTarget, { kind: "aris-wiki-entity" }>;
      return left.entityType === r.entityType && left.entityId === r.entityId;
    }
    default:
      return false;
  }
}

function workspaceDraftTabTargetsEqual(
  left: Extract<WorkspaceTabTarget, { kind: "draft" }>,
  right: Extract<WorkspaceTabTarget, { kind: "draft" }>,
): boolean {
  return left.draftId === right.draftId && workspaceDraftTabSetupsEqual(left.setup, right.setup);
}

function workspaceDraftTabSetupsEqual(
  left: WorkspaceDraftTabSetup | undefined,
  right: WorkspaceDraftTabSetup | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.provider === right.provider &&
    left.cwd === right.cwd &&
    left.modeId === right.modeId &&
    left.model === right.model &&
    left.thinkingOptionId === right.thinkingOptionId &&
    recordsShallowEqual(left.featureValues, right.featureValues)
  );
}

function recordsShallowEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

export function buildDeterministicWorkspaceTabId(target: WorkspaceTabTarget): string {
  if (target.kind === "draft") {
    return target.draftId;
  }
  if (target.kind === "agent") {
    return `agent_${target.agentId}`;
  }
  if (target.kind === "terminal") {
    return `terminal_${target.terminalId}`;
  }
  if (target.kind === "browser") {
    return `browser_${target.browserId}`;
  }
  if (target.kind === "setup") {
    return `setup_${target.workspaceId}`;
  }
  if (target.kind === "aris") {
    const view = target.view ?? "cockpit";
    return target.runId ? `aris_${view}_${target.runId}` : `aris_${view}`;
  }
  if (target.kind === "aris-artifact") {
    return `aris-artifact_${target.stageId}`;
  }
  if (target.kind === "aris-wiki-entity") {
    return `aris-wiki-entity_${target.entityType}_${target.entityId}`;
  }
  return `file_${target.path}`;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFileTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "file" }>,
): WorkspaceTabTarget | null {
  const location = normalizeWorkspaceFileLocation(value);
  return location ? { kind: "file", ...location } : null;
}

function trimOptionalString(value: string | null | undefined): string | null {
  return value == null ? null : trimNonEmpty(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
