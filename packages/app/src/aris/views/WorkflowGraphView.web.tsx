/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Svg, { Circle, Defs, G, Line, Path, Pattern, Rect, Text as SvgText } from "react-native-svg";
import type {
  ArisWorkflowStage,
  ArisWorkflowStageId,
  ArisWorkflowStageStatus,
  ArisWorkflowStatus,
} from "@getpaseo/protocol/messages";
import {
  buildLayeredKnowledgeGraphLayout,
  type KnowledgeGraphEdgeInput,
  type KnowledgeGraphNodeInput,
} from "../knowledge-graph-layout";
import { getArisWorkflowStageColor } from "../charts/color-palette";
import { ChartKitEmpty } from "../chart-kit";
import { useArisWorkflowStatus } from "../use-aris-workflow-status";
import { usePaneContext } from "@/panels/pane-context";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const STAGE_ORDER: ArisWorkflowStageId[] = ["W1", "W1.5", "W2", "W3", "W4", "W5", "W6"];

const STAGE_NAMES: Record<ArisWorkflowStageId, string> = {
  W1: "Idea discovery",
  "W1.5": "Review bridge",
  W2: "Auto review loop",
  W3: "Experiment bridge",
  W4: "Experiments",
  W5: "Paper drafting",
  W6: "Manuscript",
};

type EdgeVariant = "main" | "experiment" | "loop";

interface WorkflowEdge {
  source: ArisWorkflowStageId;
  target: ArisWorkflowStageId;
  variant: EdgeVariant;
}

// Main chain W1->W1.5->W2->W3->W4->W5->W6, plus the W2->W1.5 review feedback
// loop. The W3->W4->W5 segment is styled lighter to mark the experiment phase.
const EDGES: WorkflowEdge[] = [
  { source: "W1", target: "W1.5", variant: "main" },
  { source: "W1.5", target: "W2", variant: "main" },
  { source: "W2", target: "W3", variant: "main" },
  { source: "W3", target: "W4", variant: "experiment" },
  { source: "W4", target: "W5", variant: "experiment" },
  { source: "W5", target: "W6", variant: "experiment" },
  { source: "W2", target: "W1.5", variant: "loop" },
];

const NODE_W = 132;
const NODE_H = 64;
const GAP = 36;
const PADDING = 24;
const STEP_X = NODE_W + GAP;
const SVG_WIDTH = STAGE_ORDER.length * NODE_W + (STAGE_ORDER.length - 1) * GAP + PADDING * 2;
const SVG_HEIGHT = 232;
const CENTER_Y = 128;

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function buildStages(status: ArisWorkflowStatus | null | undefined): ArisWorkflowStage[] {
  const byId = new Map((status?.stages ?? []).map((stage) => [stage.id, stage]));
  return STAGE_ORDER.map(
    (id): ArisWorkflowStage =>
      byId.get(id) ?? {
        id,
        name: STAGE_NAMES[id],
        status: "pending" as ArisWorkflowStageStatus,
        crossModelAcquittal: false,
        artifacts: [],
        derivedFrom: "directory",
      },
  );
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function latestUpdatedAt(stage: ArisWorkflowStage): string | null {
  const times = stage.artifacts
    .map((artifact) => artifact.updatedAt ?? null)
    .filter((value): value is string => Boolean(value));
  if (times.length === 0) {
    return null;
  }
  return times.reduce((max, value) => (value > max ? value : max));
}

function formatTime(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

interface NodePosition {
  cx: number;
  cy: number;
}

function useNodePositions(): Map<ArisWorkflowStageId, NodePosition> {
  return useMemo(() => {
    const positions = new Map<ArisWorkflowStageId, NodePosition>();
    STAGE_ORDER.forEach((id, index) => {
      positions.set(id, {
        cx: PADDING + NODE_W / 2 + index * STEP_X,
        cy: CENTER_Y,
      });
    });
    return positions;
  }, []);
}

// Transparent hit target aligned over an SVG node. Hoisted + memoized so the
// parent can pass stable select/hover callbacks instead of inline arrows.
interface WorkflowNodeHotspotProps {
  stageId: ArisWorkflowStageId;
  left: number;
  top: number;
  width: number;
  height: number;
  onSelect: (id: ArisWorkflowStageId) => void;
  onHover: (id: ArisWorkflowStageId) => void;
  onHoverEnd: () => void;
}

const WorkflowNodeHotspot = memo(function WorkflowNodeHotspot({
  stageId,
  left,
  top,
  width,
  height,
  onSelect,
  onHover,
  onHoverEnd,
}: WorkflowNodeHotspotProps) {
  const handlePress = useCallback(() => onSelect(stageId), [onSelect, stageId]);
  const handleHoverIn = useCallback(() => onHover(stageId), [onHover, stageId]);
  const handleHoverOut = useCallback(() => onHoverEnd(), [onHoverEnd]);
  return (
    <Pressable
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={{ position: "absolute", left, top, width, height, cursor: "pointer" }}
    />
  );
});

interface WorkflowPipelineCanvasProps {
  stages: ArisWorkflowStage[];
  positions: Map<ArisWorkflowStageId, NodePosition>;
  layout: ReturnType<typeof buildLayeredKnowledgeGraphLayout>;
  activeW: ArisWorkflowStageId | null;
  haloOpacity: Animated.AnimatedInterpolation<string | number>;
  onSelect: (id: ArisWorkflowStageId) => void;
  onHover: (id: ArisWorkflowStageId) => void;
  onHoverEnd: () => void;
  hoveredStage: ArisWorkflowStage | null;
  tooltipStyle: unknown;
}

function WorkflowPipelineCanvas({
  stages,
  positions,
  layout,
  activeW,
  haloOpacity,
  onSelect,
  onHover,
  onHoverEnd,
  hoveredStage,
  tooltipStyle,
}: WorkflowPipelineCanvasProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      contentContainerStyle={styles.scrollContent}
    >
      <View style={{ position: "relative", width: SVG_WIDTH, height: SVG_HEIGHT }}>
        <Svg width={SVG_WIDTH} height={SVG_HEIGHT}>
          <Defs>
            <Pattern
              id="aris-skipped-hatch"
              patternUnits="userSpaceOnUse"
              width={6}
              height={6}
              patternTransform="rotate(45)"
            >
              <Line x1={0} y1={0} x2={0} y2={6} stroke="#94a3b8" strokeWidth={2} />
            </Pattern>
          </Defs>

          {EDGES.filter((edge) => edge.variant !== "loop").map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) {
              return null;
            }
            const isExperiment = edge.variant === "experiment";
            return (
              <Line
                key={`${edge.source}->${edge.target}`}
                x1={source.cx + NODE_W / 2}
                y1={source.cy}
                x2={target.cx - NODE_W / 2}
                y2={target.cy}
                stroke={isExperiment ? "#cbd5e1" : "#94a3b8"}
                strokeWidth={isExperiment ? 1.5 : 2}
              />
            );
          })}

          {(() => {
            const w2 = positions.get("W2");
            const w15 = positions.get("W1.5");
            if (!w2 || !w15) {
              return null;
            }
            const y0 = CENTER_Y - NODE_H / 2;
            const arcY = CENTER_Y - 72;
            const d = `M ${w2.cx} ${y0} C ${w2.cx} ${arcY}, ${w15.cx} ${arcY}, ${w15.cx} ${y0}`;
            return (
              <G>
                <Path d={d} fill="none" stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 4" />
                <SvgText
                  x={(w2.cx + w15.cx) / 2}
                  y={arcY - 6}
                  fontSize={9}
                  fill="#b45309"
                  textAnchor="middle"
                >
                  review loop
                </SvgText>
              </G>
            );
          })()}

          {layout.nodes.map((node) => {
            const stage = stages.find((item) => item.id === node.id);
            if (!stage) {
              return null;
            }
            const pos = positions.get(stage.id);
            if (!pos) {
              return null;
            }
            const color = getArisWorkflowStageColor(stage.status);
            const isActive = activeW === stage.id;
            const isRunning = stage.status === "running";
            const isSkipped = stage.status === "skipped";
            const isAccepted = stage.status === "accepted";
            const x = pos.cx - NODE_W / 2;
            const y = pos.cy - NODE_H / 2;

            return (
              <G key={stage.id}>
                {isRunning ? (
                  <AnimatedRect
                    x={x - 5}
                    y={y - 5}
                    width={NODE_W + 10}
                    height={NODE_H + 10}
                    rx={16}
                    fill={color}
                    opacity={haloOpacity}
                  />
                ) : null}
                <Rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={12}
                  fill={isSkipped ? "#e2e8f0" : color}
                  stroke={isActive ? "#0f172a" : "#e2e8f0"}
                  strokeWidth={isActive ? 3 : 1.5}
                />
                {isSkipped ? (
                  <Rect
                    x={x}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={12}
                    fill="url(#aris-skipped-hatch)"
                  />
                ) : null}
                <SvgText
                  x={pos.cx}
                  y={pos.cy - 6}
                  fontSize={13}
                  fontWeight="700"
                  fill="#0f172a"
                  textAnchor="middle"
                >
                  {stage.id}
                </SvgText>
                <SvgText
                  x={pos.cx}
                  y={pos.cy + 13}
                  fontSize={10}
                  fill="#475569"
                  textAnchor="middle"
                >
                  {truncateLabel(stage.name || STAGE_NAMES[stage.id], 16)}
                </SvgText>
                {isAccepted ? (
                  <G>
                    <Circle
                      cx={x + NODE_W - 8}
                      cy={y + 8}
                      r={9}
                      fill="#22c55e"
                      stroke="#ffffff"
                      strokeWidth={1.5}
                    />
                    <SvgText
                      x={x + NODE_W - 8}
                      y={y + 11.5}
                      fontSize={11}
                      fontWeight="700"
                      fill="#ffffff"
                      textAnchor="middle"
                    >
                      ✓
                    </SvgText>
                  </G>
                ) : null}
              </G>
            );
          })}
        </Svg>

        {stages.map((stage) => {
          const pos = positions.get(stage.id);
          if (!pos) {
            return null;
          }
          return (
            <WorkflowNodeHotspot
              key={`hotspot-${stage.id}`}
              stageId={stage.id}
              left={pos.cx - NODE_W / 2}
              top={pos.cy - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              onSelect={onSelect}
              onHover={onHover}
              onHoverEnd={onHoverEnd}
            />
          );
        })}

        {hoveredStage && tooltipStyle ? (
          <View style={tooltipStyle}>
            <Text style={styles.tooltipTitle}>
              {hoveredStage.id} · {hoveredStage.name || STAGE_NAMES[hoveredStage.id]}
            </Text>
            <View style={styles.tooltipDivider} />
            <Text style={styles.tooltipRow}>Status: {hoveredStage.status}</Text>
            <Text style={styles.tooltipRow}>
              Cross-model acquittal: {hoveredStage.crossModelAcquittal ? "yes" : "no"}
            </Text>
            <Text style={styles.tooltipRow}>
              Updated: {formatTime(latestUpdatedAt(hoveredStage))}
            </Text>
            <Text style={styles.tooltipHint}>
              {hoveredStage.artifacts.length} artifact
              {hoveredStage.artifacts.length === 1 ? "" : "s"} · click to view
            </Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

export function WorkflowGraphView() {
  const { serverId, workspaceId, openTab } = usePaneContext();
  const { data, isLoading, isError, error } = useArisWorkflowStatus(serverId, workspaceId);
  const status = data?.status ?? null;
  const stages = useMemo(() => buildStages(status), [status]);
  const positions = useNodePositions();

  const [hoveredId, setHoveredId] = useState<ArisWorkflowStageId | null>(null);

  const handleSelect = useCallback(
    (id: ArisWorkflowStageId) => openTab({ kind: "aris-artifact", stageId: id }),
    [openTab],
  );
  const handleHover = useCallback((id: ArisWorkflowStageId) => setHoveredId(id), []);
  const handleHoverEnd = useCallback(() => setHoveredId(null), []);

  const hoveredStage = hoveredId ? (stages.find((item) => item.id === hoveredId) ?? null) : null;
  const hoveredPos = hoveredStage ? (positions.get(hoveredStage.id) ?? null) : null;
  const tooltipStyle = useMemo(() => {
    if (!hoveredPos) {
      return null;
    }
    return [
      styles.tooltip,
      {
        left: Math.max(4, hoveredPos.cx - 90),
        top: Math.max(4, hoveredPos.cy - NODE_H / 2 - 108),
      },
    ];
  }, [hoveredPos]);

  // The layered layout utility owns the topology/layering; node positions are
  // mapped to a horizontal pipeline below.
  const layout = useMemo(
    () =>
      buildLayeredKnowledgeGraphLayout({
        nodes: STAGE_ORDER.map((id) => ({ id, label: id }) satisfies KnowledgeGraphNodeInput),
        edges: EDGES.map((edge) => ({
          source: edge.source,
          target: edge.target,
        })) satisfies KnowledgeGraphEdgeInput[],
        width: SVG_WIDTH,
        height: SVG_HEIGHT,
      }),
    [],
  );

  const hasRunning = stages.some((stage) => stage.status === "running");
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!hasRunning) {
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 850, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [hasRunning, pulse]);
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.5] });

  const activeW = status?.activeW ?? null;
  const activeBadgeStyle = useMemo(
    () => [styles.activeBadge, activeW ? styles.activeBadgeOn : null],
    [activeW],
  );
  const activeBadgeTextStyle = useMemo(
    () => [styles.activeBadgeText, activeW ? styles.activeBadgeTextOn : null],
    [activeW],
  );

  let body: ReactNode;
  if (isLoading) {
    body = (
      <View style={styles.centerBox}>
        <ThemedLoadingSpinner uniProps={foregroundColorMapping} />
      </View>
    );
  } else if (isError) {
    body = (
      <View style={styles.messageBox}>
        <Text style={styles.errorText}>{error ?? "Failed to load workflow status."}</Text>
      </View>
    );
  } else if (data && !data.ok) {
    body = (
      <View style={styles.messageBox}>
        <Text style={styles.errorText}>
          {data.error ?? "The host could not read the workflow status."}
        </Text>
      </View>
    );
  } else if (status == null) {
    body = (
      <ChartKitEmpty message="No workflow run detected. Stages will populate as the pipeline progresses." />
    );
  } else {
    body = (
      <WorkflowPipelineCanvas
        stages={stages}
        positions={positions}
        layout={layout}
        activeW={activeW}
        haloOpacity={haloOpacity}
        onSelect={handleSelect}
        onHover={handleHover}
        onHoverEnd={handleHoverEnd}
        hoveredStage={hoveredStage}
        tooltipStyle={tooltipStyle}
      />
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Workflow Status (W1–W6)</Text>
        <View style={activeBadgeStyle}>
          <Text style={activeBadgeTextStyle}>
            {activeW ? `Active: ${activeW}` : "No active stage"}
          </Text>
        </View>
      </View>
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  activeBadge: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  activeBadgeOn: {
    backgroundColor: theme.colors.palette.blue[900],
  },
  activeBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  activeBadgeTextOn: {
    color: theme.colors.palette.blue[400],
  },
  centerBox: {
    padding: theme.spacing[6],
    alignItems: "center",
  },
  messageBox: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  scrollContent: {
    paddingVertical: theme.spacing[2],
  },
  tooltip: {
    position: "absolute",
    width: 180,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface3,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  tooltipTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  tooltipDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  tooltipRow: {
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.foregroundMuted,
  },
  tooltipHint: {
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
}));
