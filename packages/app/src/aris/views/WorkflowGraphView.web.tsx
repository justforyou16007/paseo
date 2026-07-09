/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Pressable, ScrollView, Text, View } from "react-native";
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
      style={{ position: "absolute", left, top, width, height }}
    />
  );
});

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

  if (isLoading) {
    return (
      <View style={{ padding: 24, alignItems: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: "600" }}>Workflow Status</Text>
        <Text style={{ fontSize: 13, color: "#ef4444" }}>
          {error ?? "Failed to load workflow status."}
        </Text>
      </View>
    );
  }

  if (data && !data.ok) {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: "600" }}>Workflow Status</Text>
        <Text style={{ fontSize: 13, color: "#ef4444" }}>
          {data.error ?? "The host could not read the workflow status."}
        </Text>
      </View>
    );
  }

  const activeW = status?.activeW ?? null;

  return (
    <View style={{ gap: 8 }}>
      <View
        style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}
      >
        <Text style={{ fontSize: 16, fontWeight: "600" }}>Workflow Status (W1–W6)</Text>
        <Text style={{ fontSize: 12, color: "#64748b" }}>
          {activeW ? `Active: ${activeW}` : "No active stage"}
        </Text>
      </View>

      {status == null ? (
        <ChartKitEmpty message="No workflow run detected. Stages will populate as the pipeline progresses." />
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={{ paddingVertical: 8 }}
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
                onSelect={handleSelect}
                onHover={handleHover}
                onHoverEnd={handleHoverEnd}
              />
            );
          })}

          {hoveredId
            ? (() => {
                const stage = stages.find((item) => item.id === hoveredId);
                const pos = stage ? positions.get(stage.id) : null;
                if (!stage || !pos) {
                  return null;
                }
                const updated = latestUpdatedAt(stage);
                return (
                  <View
                    style={{
                      position: "absolute",
                      left: Math.max(4, pos.cx - 80),
                      top: Math.max(4, pos.cy - NODE_H / 2 - 86),
                      width: 160,
                      padding: 8,
                      borderRadius: 8,
                      backgroundColor: "#0f172a",
                      gap: 3,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#ffffff" }}>
                      {stage.id} · {stage.name || STAGE_NAMES[stage.id]}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#cbd5e1" }}>Status: {stage.status}</Text>
                    <Text style={{ fontSize: 11, color: "#cbd5e1" }}>
                      Cross-model acquittal: {stage.crossModelAcquittal ? "yes" : "no"}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#cbd5e1" }}>
                      Updated: {formatTime(updated)}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#94a3b8" }}>
                      {stage.artifacts.length} artifact{stage.artifacts.length === 1 ? "" : "s"} ·
                      click to view
                    </Text>
                  </View>
                );
              })()
            : null}
        </View>
      </ScrollView>
    </View>
  );
}
