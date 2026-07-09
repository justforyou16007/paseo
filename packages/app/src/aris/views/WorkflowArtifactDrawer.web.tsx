/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Animated,
  Pressable,
  ScrollView,
  Text,
  View,
  type PointerEvent as RNPointerEvent,
} from "react-native";
import type {
  ArisWorkflowArtifact,
  ArisWorkflowArtifactKind,
  ArisWorkflowStage,
} from "@getpaseo/protocol/messages";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { usePaneContext } from "@/panels/pane-context";

export interface WorkflowArtifactDrawerProps {
  stage: ArisWorkflowStage | null;
  serverId: string;
  workspaceId: string;
  onClose: () => void;
}

const DRAWER_WIDTH = 440;
const MIN_DRAWER_WIDTH = 320;
const MAX_DRAWER_WIDTH_CAP = 960;
const DRAWER_WIDTH_STORAGE_KEY = "aris.workflow-drawer.width";

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

// ---------------------------------------------------------------------------
// Drawer width helpers: clamped to [MIN_DRAWER_WIDTH, min(MAX_DRAWER_WIDTH_CAP,
// viewport - 80)] and persisted across sessions via localStorage.
// ---------------------------------------------------------------------------

function computeMaxDrawerWidth(): number {
  if (typeof window === "undefined") {
    return MAX_DRAWER_WIDTH_CAP;
  }
  return Math.min(MAX_DRAWER_WIDTH_CAP, window.innerWidth - 80);
}

function readPersistedDrawerWidth(fallback: number, max: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY);
  if (raw == null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, MIN_DRAWER_WIDTH), max);
}

function persistDrawerWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage errors (e.g. disabled storage or quota).
  }
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

// ---------------------------------------------------------------------------
// Drawer shell
// ---------------------------------------------------------------------------

export function WorkflowArtifactDrawer({ stage, onClose }: WorkflowArtifactDrawerProps) {
  const { openFileInWorkspace } = usePaneContext();

  const openInExplorer = useCallback(
    (path: string) => {
      openFileInWorkspace({ location: { path }, disposition: "side" });
    },
    [openFileInWorkspace],
  );

  // Horizontally resizable width. Initialized from the persisted value
  // (clamped) or the default; bounds are recomputed on every drag so a
  // viewport change between sessions is respected.
  const [drawerWidth, setDrawerWidth] = useState<number>(() =>
    readPersistedDrawerWidth(DRAWER_WIDTH, computeMaxDrawerWidth()),
  );
  const [isHandleHovered, setIsHandleHovered] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(
    null,
  );
  const cursorBeforeDragRef = useRef<string | null>(null);

  const handlePointerEnter = useCallback(() => setIsHandleHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHandleHovered(false), []);

  const handleResizePointerDown = useCallback(
    (event: RNPointerEvent) => {
      const hitArea = event.currentTarget as unknown as HTMLElement | null;
      if (!hitArea) {
        return;
      }
      const pointerCaptureElement = hitArea;
      const pointerId = event.nativeEvent.pointerId;
      dragStateRef.current = {
        startX: event.nativeEvent.clientX,
        startWidth: drawerWidth,
        currentWidth: drawerWidth,
      };
      setIsResizing(true);
      cursorBeforeDragRef.current = document.body.style.cursor;
      document.body.style.cursor = "ew-resize";
      // Prevent the backdrop press-to-close and text selection while dragging.
      event.preventDefault();
      event.stopPropagation();
      pointerCaptureElement.setPointerCapture?.(pointerId);

      function handlePointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId || !dragStateRef.current) {
          return;
        }
        moveEvent.preventDefault();
        const delta = moveEvent.clientX - dragStateRef.current.startX;
        const next = Math.min(
          Math.max(dragStateRef.current.startWidth - delta, MIN_DRAWER_WIDTH),
          computeMaxDrawerWidth(),
        );
        dragStateRef.current.currentWidth = next;
        setDrawerWidth(next);
      }

      function cleanup() {
        const finalWidth = dragStateRef.current?.currentWidth;
        dragStateRef.current = null;
        setIsResizing(false);
        document.body.style.cursor = cursorBeforeDragRef.current ?? "";
        cursorBeforeDragRef.current = null;
        if (pointerCaptureElement.hasPointerCapture?.(pointerId)) {
          pointerCaptureElement.releasePointerCapture(pointerId);
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        if (finalWidth != null) {
          persistDrawerWidth(finalWidth);
        }
      }

      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) {
          return;
        }
        cleanup();
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [drawerWidth],
  );

  // Esc closes the drawer while it is open.
  useEffect(() => {
    if (!stage) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [stage, onClose]);

  // Slide-in from the right.
  const slide = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [slide]);
  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [0, drawerWidth] });

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
        style={{ position: "absolute", inset: 0, backgroundColor: "transparent" }}
      />
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: drawerWidth,
          maxWidth: "100%",
          overflow: "visible",
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
        {/* Left-edge resize handle (web only). The visible bar sits flush with
            the panel edge; a wider transparent hit area straddles the edge for
            easier grabbing and stops pointer-down from reaching the backdrop. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: isResizing || isHandleHovered ? 6 : 4,
            backgroundColor: isResizing || isHandleHovered ? "#2563eb" : "#e2e8f0",
            zIndex: 5,
          }}
        />
        <View
          role="separator"
          aria-orientation="vertical"
          onPointerDown={handleResizePointerDown}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          style={
            {
              position: "absolute",
              left: -5,
              top: 0,
              bottom: 0,
              width: 12,
              zIndex: 10,
              cursor: "ew-resize",
              touchAction: "none",
            } as object
          }
        />
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
      </Animated.View>
    </View>
  );

  return createPortal(content, getOverlayRoot());
}
