/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActivityIndicator, Animated, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type {
  ArisWorkflowArtifact,
  ArisWorkflowArtifactKind,
  ArisWorkflowStage,
} from "@getpaseo/protocol/messages";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

export interface WorkflowArtifactDrawerProps {
  stage: ArisWorkflowStage | null;
  serverId: string;
  workspaceId: string;
  onClose: () => void;
}

const DRAWER_WIDTH = 440;
const TEXT_CAP = 200_000;
const JSONL_TAIL_LINES = 400;

type HostClient = ReturnType<typeof useHostRuntimeClient>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function decodeText(result: FileReadResult): string {
  return new TextDecoder().decode(result.bytes);
}

// ---------------------------------------------------------------------------
// Web-only iframe. react-native-webview has no web build in this project, so
// for html/pdf artifacts we render a plain <iframe> via the DOM. This file is
// .web.tsx, so direct DOM access is safe here.
// ---------------------------------------------------------------------------

function WebIframe({ src, srcDoc, title }: { src?: string; srcDoc?: string; title?: string }) {
  const containerRef = useRef<View>(null);
  useEffect(() => {
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    const iframe = document.createElement("iframe");
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.minHeight = "380px";
    iframe.title = title ?? "";
    if (srcDoc !== undefined) {
      // Full sandbox lockdown (sandbox=""): research HTML renders but cannot run scripts or access the parent origin.
      iframe.setAttribute("sandbox", "");
      iframe.srcdoc = srcDoc;
    } else if (src !== undefined) {
      iframe.src = src;
    }
    node.appendChild(iframe);
    return () => {
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
    };
  }, [src, srcDoc, title]);

  return <View ref={containerRef} style={{ flex: 1, minHeight: 380 }} />;
}

// ---------------------------------------------------------------------------
// File content fetch
// ---------------------------------------------------------------------------

function useArtifactContent(
  client: HostClient,
  cwd: string | null,
  artifact: ArisWorkflowArtifact | null,
) {
  return useQuery<FileReadResult | null>({
    queryKey: ["aris", "artifact", cwd ?? "", artifact?.path ?? ""],
    enabled: Boolean(client && cwd && artifact && artifact.exists),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client || !cwd || !artifact) {
        return null;
      }
      return client.readFile(cwd, artifact.path);
    },
  });
}

// ---------------------------------------------------------------------------
// Per-kind viewer
// ---------------------------------------------------------------------------

function Monospace({ text }: { text: string }) {
  return (
    <ScrollView style={{ flex: 1 }} horizontal={false}>
      <Text
        selectable
        style={{
          padding: 12,
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 16,
          color: "#1e293b",
        }}
      >
        {text}
      </Text>
    </ScrollView>
  );
}

function ArtifactViewer({
  artifact,
  client,
  cwd,
}: {
  artifact: ArisWorkflowArtifact;
  client: HostClient;
  cwd: string | null;
}) {
  const query = useArtifactContent(client, cwd, artifact);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const text = useMemo(() => {
    if (!query.data) {
      return "";
    }
    const raw = decodeText(query.data);
    return raw.length > TEXT_CAP ? `${raw.slice(0, TEXT_CAP)}\n\n…(truncated)` : raw;
  }, [query.data]);

  useEffect(() => {
    if (artifact.kind !== "pdf" || !query.data) {
      return;
    }
    const bytes = query.data.bytes;
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    setPdfUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPdfUrl(null);
    };
  }, [artifact.kind, query.data]);

  if (!artifact.exists) {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: "#ef4444" }}>File not found</Text>
        <Text style={{ fontSize: 12, color: "#64748b" }}>{artifact.path}</Text>
        <Text style={{ fontSize: 12, color: "#94a3b8" }}>
          The artifact has not been produced yet for this stage.
        </Text>
      </View>
    );
  }

  if (artifact.kind === "directory") {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600" }}>Directory</Text>
        <Text style={{ fontSize: 12, color: "#64748b" }}>{artifact.path}</Text>
        <Text style={{ fontSize: 12, color: "#94a3b8" }}>
          Open this directory in the file explorer to browse its contents.
        </Text>
      </View>
    );
  }

  if (artifact.kind === "pptx") {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600" }}>PPTX preview not supported</Text>
        <Text style={{ fontSize: 12, color: "#64748b" }}>
          PowerPoint slides cannot be rendered inline. Open the file in the file explorer to access
          it.
        </Text>
        <Text style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{artifact.path}</Text>
      </View>
    );
  }

  if (query.isLoading) {
    return (
      <View style={{ padding: 24, alignItems: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (query.isError || !query.data) {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: "#ef4444" }}>
          Could not read file
        </Text>
        <Text style={{ fontSize: 12, color: "#64748b" }}>{artifact.path}</Text>
        <Text style={{ fontSize: 12, color: "#ef4444" }}>
          {query.error instanceof Error ? query.error.message : "Unknown error"}
        </Text>
      </View>
    );
  }

  if (artifact.kind === "markdown") {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <MarkdownRenderer text={text} />
      </ScrollView>
    );
  }

  if (artifact.kind === "json") {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // fall back to raw text if it isn't valid JSON
    }
    return <Monospace text={pretty} />;
  }

  if (artifact.kind === "jsonl") {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const tail = lines.slice(-JSONL_TAIL_LINES);
    const header =
      lines.length > JSONL_TAIL_LINES
        ? `…showing last ${JSONL_TAIL_LINES} of ${lines.length} lines\n\n`
        : "";
    return <Monospace text={`${header}${tail.join("\n")}`} />;
  }

  if (artifact.kind === "html") {
    return <WebIframe srcDoc={text} title={basename(artifact.path)} />;
  }

  if (artifact.kind === "pdf") {
    return pdfUrl ? (
      <WebIframe src={pdfUrl} title={basename(artifact.path)} />
    ) : (
      <View style={{ padding: 24, alignItems: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  // yaml, log, latex, and any future text-like kind: raw monospace.
  return <Monospace text={text} />;
}

// ---------------------------------------------------------------------------
// Artifact list row
// ---------------------------------------------------------------------------

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
  onOpen: (artifact: ArisWorkflowArtifact) => void;
  onOpenInExplorer: (path: string) => void;
}

const ArtifactRow = memo(function ArtifactRow({
  artifact,
  onOpen,
  onOpenInExplorer,
}: ArtifactRowProps) {
  const handleOpen = useCallback(() => onOpen(artifact), [onOpen, artifact]);
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
        <Pressable onPress={handleOpen} disabled={!artifact.exists}>
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              color: artifact.exists ? "#2563eb" : "#cbd5e1",
            }}
          >
            View
          </Text>
        </Pressable>
        <Pressable onPress={handleOpenInExplorer}>
          <Text style={{ fontSize: 12, color: "#64748b" }}>Open in explorer</Text>
        </Pressable>
      </View>
    </View>
  );
});

// ---------------------------------------------------------------------------
// Drawer shell
// ---------------------------------------------------------------------------

export function WorkflowArtifactDrawer({
  stage,
  serverId,
  workspaceId,
  onClose,
}: WorkflowArtifactDrawerProps) {
  const client = useHostRuntimeClient(serverId);
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const { openFileInWorkspace } = usePaneContext();
  const [viewing, setViewing] = useState<ArisWorkflowArtifact | null>(null);

  const openInExplorer = useCallback(
    (path: string) => {
      openFileInWorkspace({ location: { path }, disposition: "side" });
    },
    [openFileInWorkspace],
  );
  const handleBack = useCallback(() => setViewing(null), []);
  const handleOpenArtifact = useCallback((artifact: ArisWorkflowArtifact) => {
    setViewing(artifact);
  }, []);
  const handleOpenViewingInExplorer = useCallback(() => {
    if (viewing) {
      openInExplorer(viewing.path);
    }
  }, [viewing, openInExplorer]);

  // Slide-in from the right.
  const slide = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [slide]);
  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [0, DRAWER_WIDTH] });

  if (!stage) {
    return null;
  }

  const content = (
    <View
      style={{
        position: "absolute",
        inset: 0,
        zIndex: OVERLAY_Z.modal,
        pointerEvents: "auto",
      }}
    >
      <Pressable
        onPress={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,0.4)" }}
      />
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          maxWidth: "100%",
          backgroundColor: "#ffffff",
          borderLeftWidth: 1,
          borderLeftColor: "#e2e8f0",
          shadowColor: "#000000",
          shadowOffset: { width: -2, height: 0 },
          shadowOpacity: 0.15,
          shadowRadius: 8,
          elevation: 8,
          transform: [{ translateX }],
        }}
      >
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
          <Pressable onPress={onClose} hitSlop={8} style={{ padding: 6, borderRadius: 6 }}>
            <Text style={{ fontSize: 18, color: "#64748b" }}>✕</Text>
          </Pressable>
        </View>

        {viewing ? (
          <View style={{ flex: 1 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                padding: 8,
                borderBottomWidth: 1,
                borderBottomColor: "#f1f5f9",
              }}
            >
              <Pressable onPress={handleBack} hitSlop={8}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: "#2563eb" }}>← Back</Text>
              </Pressable>
              <Text style={{ fontSize: 12, color: "#475569" }} numberOfLines={1}>
                {basename(viewing.path)}
              </Text>
              <Pressable onPress={handleOpenViewingInExplorer} style={{ marginLeft: "auto" }}>
                <Text style={{ fontSize: 12, color: "#64748b" }}>Open in explorer</Text>
              </Pressable>
            </View>
            <View style={{ flex: 1, minHeight: 0 }}>
              <ArtifactViewer artifact={viewing} client={client} cwd={cwd} />
            </View>
          </View>
        ) : (
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
                  onOpen={handleOpenArtifact}
                  onOpenInExplorer={openInExplorer}
                />
              ))
            )}
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );

  return createPortal(content, getOverlayRoot());
}
