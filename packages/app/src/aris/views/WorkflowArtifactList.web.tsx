/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  ArisWorkflowArtifact,
  ArisWorkflowArtifactKind,
  ArisWorkflowStage,
} from "@getpaseo/protocol/messages";
import { usePaneContext } from "@/panels/pane-context";

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

const KIND_LABEL: Record<ArisWorkflowArtifactKind, string> = {
  markdown: "Markdown",
  pdf: "PDF",
  latex: "LaTeX",
  json: "JSON",
  jsonl: "JSONL",
  yaml: "YAML",
  log: "Log",
  html: "HTML",
  pptx: "PPTX",
  directory: "Directory",
};

interface ArtifactRowProps {
  artifact: ArisWorkflowArtifact;
  onOpenInExplorer: (path: string) => void;
}

const ArtifactRow = memo(function ArtifactRow({ artifact, onOpenInExplorer }: ArtifactRowProps) {
  const handleOpenInExplorer = useCallback(
    () => onOpenInExplorer(artifact.path),
    [onOpenInExplorer, artifact],
  );

  const meta = [
    KIND_LABEL[artifact.kind],
    formatBytes(artifact.sizeBytes ?? null),
    formatTime(artifact.updatedAt ?? null),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View
      style={{
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#e2e8f0",
        backgroundColor: "#f8fafc",
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 14, color: artifact.exists ? "#22c55e" : "#ef4444" }}>
          {artifact.exists ? "✓" : "✗"}
        </Text>
        <Text style={{ fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>
          {basename(artifact.path)}
        </Text>
      </View>
      {artifact.purpose ? (
        <Text style={{ fontSize: 12, color: "#475569" }}>{artifact.purpose}</Text>
      ) : null}
      <Text style={{ fontSize: 11, color: "#94a3b8" }}>{meta}</Text>
      <View style={{ flexDirection: "row", gap: 12, marginTop: 2 }}>
        <Pressable onPress={handleOpenInExplorer}>
          <Text style={{ fontSize: 12, color: "#64748b" }}>Open in explorer</Text>
        </Pressable>
      </View>
    </View>
  );
});

interface WorkflowArtifactListProps {
  stage: ArisWorkflowStage;
}

export function WorkflowArtifactList({ stage }: WorkflowArtifactListProps) {
  const { openFileInWorkspace } = usePaneContext();

  const openInExplorer = useCallback(
    (path: string) => {
      openFileInWorkspace({ location: { path }, disposition: "side" });
    },
    [openFileInWorkspace],
  );

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 12,
          borderBottomWidth: 1,
          borderBottomColor: "#e2e8f0",
        }}
      >
        <View style={{ gap: 2, flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "700" }}>
            {stage.id} · {stage.name || "Stage"}
          </Text>
          <Text style={{ fontSize: 11, color: "#64748b" }}>
            {stage.status}
            {stage.crossModelAcquittal ? " · cross-model acquitted" : ""}
            {` · derived from ${stage.derivedFrom}`}
          </Text>
        </View>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
        {stage.artifacts.length === 0 ? (
          <Text style={{ fontSize: 13, color: "#94a3b8", padding: 8 }}>
            No artifacts registered for this stage.
          </Text>
        ) : (
          stage.artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.path}
              artifact={artifact}
              onOpenInExplorer={openInExplorer}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}
