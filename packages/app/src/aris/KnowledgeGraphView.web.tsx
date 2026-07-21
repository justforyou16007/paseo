/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Svg, { Circle, Line, Polygon, Rect, G, Text as SvgText } from "react-native-svg";
import type { ArisKnowledgeGraph, ArisReviewState } from "@getpaseo/protocol/messages";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import {
  buildLayeredKnowledgeGraphLayout,
  type KnowledgeGraphEdgeInput,
  type KnowledgeGraphNodeInput,
} from "./knowledge-graph-layout";
import { ChartKitEmpty } from "./chart-kit";
import {
  ARIS_KNOWLEDGE_GRAPH_NODE_COLORS,
  ARIS_KNOWLEDGE_GRAPH_EDGE_COLORS,
  isArisKnowledgeGraphRelation,
  getArisNodeKindColor,
  getArisEdgeRelationColor,
  ARIS_NEUTRAL_NODE_COLOR,
} from "./charts/color-palette";

export interface KnowledgeGraphViewProps {
  data: ArisReviewReadResult | null | undefined;
  wikiGraph?: ArisKnowledgeGraph | null;
  width?: number;
  height?: number;
  onOpenDetail?: (entityId: string, entityType: GraphNodeType) => void;
}

const GRAPH_WIDTH = 700;
const GRAPH_HEIGHT = 400;
const CANVAS_VIEW_HEIGHT = 460;
const DEFAULT_EDGE_STROKE = "#94a3b8";
const DEFAULT_EDGE_WIDTH = 1.5;
const FOCUS_FADE_OPACITY = 0.3;
const NODE_LONG_PRESS_MS = 400;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.08;

const INK = {
  ringDefault: "rgba(255,255,255,0.8)",
  ringSelected: "#0f172a",
  labelOnColor: "#ffffff",
} as const;

type ArisKnowledgeGraphEdge = NonNullable<ArisKnowledgeGraph["edges"]>[number];

export type GraphNodeType = "idea" | "experiment" | "claim" | "paper" | "gap" | "default";

export interface GraphCanvasNode {
  id: string;
  label: string;
  type: GraphNodeType;
  x: number;
  y: number;
  fill: string;
  opacity?: number;
  selected?: boolean;
}

export interface GraphCanvasEdge {
  source: string;
  target: string;
  relation?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export interface KnowledgeGraphCanvasProps {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  width: number;
  height: number;
  onSelectNode?: (id: string) => void;
  onOpenNode?: (id: string) => void;
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function nodeRadius(type: GraphNodeType): number {
  switch (type) {
    case "idea":
      return 40;
    case "experiment":
      return 38;
    case "claim":
      return 34;
    case "paper":
      return 30;
    case "gap":
      return 24;
    default:
      return 34;
  }
}

function graphNodeTypeFromGroup(group: string | undefined): GraphNodeType {
  switch (group) {
    case "idea":
    case "experiment":
    case "claim":
    case "paper":
    case "gap":
      return group;
    default:
      return "default";
  }
}

// ---------------------------------------------------------------------------
// Node view (with press/long-press interaction)
// ---------------------------------------------------------------------------

interface NodeViewProps {
  node: GraphCanvasNode;
  zoom: number;
  onSelect: ((id: string) => void) | undefined;
  onOpen: ((id: string) => void) | undefined;
  onDrag: ((id: string, x: number, y: number) => void) | undefined;
}

const DRAG_THRESHOLD = 5;

const GraphCanvasNodeView = memo(function GraphCanvasNodeView({
  node,
  zoom,
  onSelect,
  onOpen,
  onDrag,
}: NodeViewProps) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const isDragging = useRef(false);
  const isPointerDown = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, nodeX: 0, nodeY: 0 });

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePressIn = useCallback(
    (e: unknown) => {
      const evt = e as { stopPropagation?: () => void; clientX: number; clientY: number };
      evt.stopPropagation?.();
      isPointerDown.current = true;
      isDragging.current = false;
      dragStart.current = { x: evt.clientX, y: evt.clientY, nodeX: node.x, nodeY: node.y };
      clearLongPressTimer();
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        if (!isDragging.current) {
          onSelect?.(node.id);
        }
      }, NODE_LONG_PRESS_MS);
    },
    [clearLongPressTimer, node.id, node.x, node.y, onSelect],
  );

  const handlePointerMove = useCallback(
    (e: unknown) => {
      if (!isPointerDown.current) {
        return;
      }
      const evt = e as { clientX: number; clientY: number };
      const dx = evt.clientX - dragStart.current.x;
      const dy = evt.clientY - dragStart.current.y;
      if (!isDragging.current && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        isDragging.current = true;
        clearLongPressTimer();
      }
      if (isDragging.current) {
        const z = zoom || 1;
        onDrag?.(node.id, dragStart.current.nodeX + dx / z, dragStart.current.nodeY + dy / z);
      }
    },
    [clearLongPressTimer, node.id, zoom, onDrag],
  );

  const handlePressOut = useCallback(() => {
    isPointerDown.current = false;
    if (isDragging.current) {
      isDragging.current = false;
      return;
    }
    if (longPressTimerRef.current === null) {
      return;
    }
    clearLongPressTimer();
    onOpen?.(node.id);
  }, [clearLongPressTimer, node.id, onOpen]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => {
    setIsHovered(false);
    if (isDragging.current) {
      isDragging.current = false;
      isPointerDown.current = false;
    }
  }, []);

  const radius = nodeRadius(node.type);
  const maxChars = node.type === "gap" ? 8 : Math.max(8, Math.floor(radius / 3));
  const label = truncateLabel(node.label, maxChars);
  const glowing = node.selected || isHovered;
  const ringStroke = node.selected ? INK.ringSelected : INK.ringDefault;
  const ringWidth = node.selected ? 3 : 1.5;

  let shape: ReactNode;
  switch (node.type) {
    case "experiment":
      shape = (
        <Rect
          x={node.x - radius}
          y={node.y - radius}
          width={radius * 2}
          height={radius * 2}
          rx={7}
          fill={node.fill}
          stroke={ringStroke}
          strokeWidth={ringWidth}
        />
      );
      break;
    case "claim": {
      const points = [
        `${node.x},${node.y - radius}`,
        `${node.x + radius},${node.y}`,
        `${node.x},${node.y + radius}`,
        `${node.x - radius},${node.y}`,
      ].join(" ");
      shape = (
        <Polygon points={points} fill={node.fill} stroke={ringStroke} strokeWidth={ringWidth} />
      );
      break;
    }
    case "gap":
      shape = (
        <Circle
          cx={node.x}
          cy={node.y}
          r={radius}
          fill="none"
          stroke={node.fill}
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      );
      break;
    default:
      shape = (
        <Circle
          cx={node.x}
          cy={node.y}
          r={radius}
          fill={node.fill}
          stroke={ringStroke}
          strokeWidth={ringWidth}
        />
      );
  }

  return (
    <G
      {...({
        onPointerDown: handlePressIn,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePressOut,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave,
        style: { cursor: isDragging.current ? "grabbing" : "pointer" },
      } as Record<string, unknown>)}
      opacity={node.opacity ?? 1}
    >
      {glowing ? (
        <Circle cx={node.x} cy={node.y} r={radius + 5} fill={node.fill} opacity={0.2} />
      ) : null}
      {shape}
      <SvgText
        x={node.x}
        y={node.y + 4}
        fontSize={node.type === "gap" ? 10 : 11}
        fill={node.type === "gap" ? node.fill : INK.labelOnColor}
        textAnchor="middle"
        fontWeight="600"
      >
        {label}
      </SvgText>
    </G>
  );
});

// ---------------------------------------------------------------------------
// Group labels (large faint text behind each cluster)
// ---------------------------------------------------------------------------

interface GroupCentroid {
  group: string;
  cx: number;
  cy: number;
  label: string;
}

const GROUP_LABEL_MAP: Record<string, string> = {
  paper: "Papers",
  idea: "Ideas",
  experiment: "Experiments",
  claim: "Claims",
  gap: "Gaps",
};

function computeGroupCentroids(nodes: GraphCanvasNode[]): GroupCentroid[] {
  const sums = new Map<string, { sx: number; sy: number; n: number }>();
  for (const node of nodes) {
    const g = node.type === "default" ? "__none__" : node.type;
    const entry = sums.get(g) ?? { sx: 0, sy: 0, n: 0 };
    entry.sx += node.x;
    entry.sy += node.y;
    entry.n += 1;
    sums.set(g, entry);
  }
  const result: GroupCentroid[] = [];
  for (const [group, { sx, sy, n }] of sums) {
    if (group === "__none__" || n < 1) {
      continue;
    }
    result.push({
      group,
      cx: sx / n,
      cy: sy / n,
      label: GROUP_LABEL_MAP[group] ?? group,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pannable/zoomable canvas
// ---------------------------------------------------------------------------

function PannableCanvas({
  nodes,
  edges,
  onSelectNode,
  onOpenNode,
}: {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  onSelectNode?: (id: string) => void;
  onOpenNode?: (id: string) => void;
}) {
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [dragPositions, setDragPositions] = useState<Map<string, { x: number; y: number }>>(
    () => new Map(),
  );
  const isPanning = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  // Merge layout positions with any drag overrides.
  const displayNodes = useMemo(() => {
    if (dragPositions.size === 0) {
      return nodes;
    }
    return nodes.map((node) => {
      const override = dragPositions.get(node.id);
      if (!override) {
        return node;
      }
      return { ...node, x: override.x, y: override.y };
    });
  }, [nodes, dragPositions]);

  const positions = useMemo(
    () => new Map(displayNodes.map((node) => [node.id, node])),
    [displayNodes],
  );
  const groupCentroids = useMemo(() => computeGroupCentroids(displayNodes), [displayNodes]);

  const handleDragNode = useCallback((id: string, x: number, y: number) => {
    setDragPositions((prev) => {
      const next = new Map(prev);
      next.set(id, { x: Math.round(x), y: Math.round(y) });
      return next;
    });
  }, []);

  const handlePointerDown = useCallback((e: unknown) => {
    const evt = e as {
      clientX: number;
      clientY: number;
      currentTarget?: { setPointerCapture?: (id: number) => void };
      pointerId?: number;
    };
    isPanning.current = true;
    lastPointer.current = { x: evt.clientX, y: evt.clientY };
    if (evt.currentTarget?.setPointerCapture && typeof evt.pointerId === "number") {
      evt.currentTarget.setPointerCapture(evt.pointerId);
    }
  }, []);

  const handlePointerMove = useCallback((e: unknown) => {
    if (!isPanning.current) {
      return;
    }
    const evt = e as { clientX: number; clientY: number };
    const dx = evt.clientX - lastPointer.current.x;
    const dy = evt.clientY - lastPointer.current.y;
    lastPointer.current = { x: evt.clientX, y: evt.clientY };
    setPanX((prev) => prev + dx);
    setPanY((prev) => prev + dy);
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleWheel = useCallback((e: unknown) => {
    const evt = e as { deltaY: number; preventDefault?: () => void };
    evt.preventDefault?.();
    const direction = evt.deltaY < 0 ? 1 : -1;
    setZoom((prev) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + direction * ZOOM_STEP)));
  }, []);

  const handleReset = useCallback(() => {
    setPanX(0);
    setPanY(0);
    setZoom(1);
    setDragPositions(new Map());
  }, []);

  const transform = `translate(${panX}, ${panY}) scale(${zoom})`;

  return (
    <View style={styles.canvasContainer}>
      <View
        style={styles.canvasViewport}
        {...({ onWheel: handleWheel } as Record<string, unknown>)}
      >
        <Svg
          width="100%"
          height={CANVAS_VIEW_HEIGHT}
          {...({
            onPointerDown: handlePointerDown,
            onPointerMove: handlePointerMove,
            onPointerUp: handlePointerUp,
            style: { cursor: isPanning.current ? "grabbing" : "grab" },
          } as Record<string, unknown>)}
        >
          <G transform={transform}>
            {/* Group region labels */}
            {groupCentroids.map((gc) => (
              <SvgText
                key={`group-${gc.group}`}
                x={gc.cx}
                y={gc.cy + 4}
                fontSize={18}
                fontWeight="700"
                fill={getArisNodeKindColor(gc.group)}
                textAnchor="middle"
                opacity={0.12}
              >
                {gc.label.toUpperCase()}
              </SvgText>
            ))}

            {/* Edges */}
            {edges.map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) {
                return null;
              }
              const midX = (source.x + target.x) / 2;
              const midY = (source.y + target.y) / 2;
              const relationLabel = edge.relation ?? "";
              const pillWidth = Math.max(52, relationLabel.length * 6.2 + 18);
              return (
                <G key={`${edge.source}->${edge.target}`}>
                  <Line
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    stroke={edge.stroke ?? DEFAULT_EDGE_STROKE}
                    strokeWidth={edge.strokeWidth ?? DEFAULT_EDGE_WIDTH}
                    opacity={edge.opacity ?? 1}
                  />
                  {edge.relation && isArisKnowledgeGraphRelation(edge.relation) ? (
                    <G>
                      <Rect
                        x={midX - pillWidth / 2}
                        y={midY - 9}
                        width={pillWidth}
                        height={18}
                        rx={9}
                        fill={edge.stroke ?? DEFAULT_EDGE_STROKE}
                        opacity={(edge.opacity ?? 1) * 0.18}
                      />
                      <SvgText
                        x={midX}
                        y={midY + 3.5}
                        fontSize={9}
                        fill={edge.stroke ?? DEFAULT_EDGE_STROKE}
                        textAnchor="middle"
                        fontWeight="600"
                      >
                        {edge.relation}
                      </SvgText>
                    </G>
                  ) : null}
                </G>
              );
            })}

            {/* Nodes */}
            {displayNodes.map((node) => (
              <GraphCanvasNodeView
                key={node.id}
                node={node}
                zoom={zoom}
                onSelect={onSelectNode}
                onOpen={onOpenNode}
                onDrag={handleDragNode}
              />
            ))}
          </G>
        </Svg>
      </View>
      <View style={styles.canvasToolbar}>
        <Pressable onPress={handleReset} style={styles.resetButton}>
          <Text style={styles.resetButtonText}>Reset view</Text>
        </Pressable>
        <Text style={styles.zoomLabel}>{Math.round(zoom * 100)}%</Text>
      </View>
    </View>
  );
}

// Exported for use by IdeaEvolutionView which renders a standalone canvas.
export function KnowledgeGraphCanvas({
  nodes,
  edges,
  width,
  height,
  onSelectNode,
  onOpenNode,
}: KnowledgeGraphCanvasProps) {
  const positions = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  return (
    <Svg width={width} height={height}>
      {edges.map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) {
          return null;
        }
        return (
          <G key={`e-${edge.source}->${edge.target}`}>
            <Line
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={edge.stroke ?? DEFAULT_EDGE_STROKE}
              strokeWidth={edge.strokeWidth ?? DEFAULT_EDGE_WIDTH}
              opacity={edge.opacity ?? 1}
            />
          </G>
        );
      })}
      {nodes.map((node) => (
        <GraphCanvasNodeView
          key={node.id}
          node={node}
          zoom={1}
          onSelect={onSelectNode}
          onOpen={onOpenNode}
          onDrag={undefined}
        />
      ))}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Main KnowledgeGraphView
// ---------------------------------------------------------------------------

function buildEdgesFromKnowledgeGraph(
  graph: ArisKnowledgeGraph | null | undefined,
): KnowledgeGraphEdgeInput[] {
  if (!graph?.edges || graph.edges.length === 0) {
    return [];
  }
  return graph.edges.map((edge: ArisKnowledgeGraphEdge) => ({
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    weight: edge.weight,
  }));
}

function buildEdgesFromReviewRounds(
  reviewState: ArisReviewState | null | undefined,
): KnowledgeGraphEdgeInput[] {
  if (!reviewState?.rounds) {
    return [];
  }
  return reviewState.rounds.flatMap((_, roundIndex) => {
    if (roundIndex === 0) {
      return [];
    }
    return {
      source: `Round ${roundIndex}`,
      target: `Round ${roundIndex + 1}`,
      relation: "next",
    };
  });
}

function buildExplicitNodes(
  graph: ArisKnowledgeGraph | null | undefined,
): KnowledgeGraphNodeInput[] | undefined {
  const nodes = graph?.nodes;
  if (!nodes || nodes.length === 0) {
    return undefined;
  }
  return nodes.map((node) => ({ id: node.id, label: node.label, group: node.group }));
}

export function KnowledgeGraphView({
  data,
  wikiGraph,
  width = GRAPH_WIDTH,
  height = GRAPH_HEIGHT,
  onOpenDetail,
}: KnowledgeGraphViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const edges: KnowledgeGraphEdgeInput[] = useMemo(() => {
    const wikiEdges = buildEdgesFromKnowledgeGraph(wikiGraph ?? null);
    if (wikiEdges.length > 0) {
      return wikiEdges;
    }
    const graphEdges = buildEdgesFromKnowledgeGraph(data?.knowledgeGraph);
    if (graphEdges.length > 0) {
      return graphEdges;
    }
    return buildEdgesFromReviewRounds(data?.reviewState);
  }, [data, wikiGraph]);

  const explicitNodes = useMemo(
    () => buildExplicitNodes(wikiGraph ?? data?.knowledgeGraph),
    [data, wikiGraph],
  );

  const layout = useMemo(
    () => buildLayeredKnowledgeGraphLayout({ edges, width, height, nodes: explicitNodes }),
    [edges, width, height, explicitNodes],
  );

  const focusSet = useMemo(() => {
    if (!selectedId) {
      return null;
    }
    const set = new Set<string>([selectedId]);
    for (const edge of edges) {
      if (edge.source === selectedId) {
        set.add(edge.target);
      }
      if (edge.target === selectedId) {
        set.add(edge.source);
      }
    }
    return set;
  }, [selectedId, edges]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const handleOpen = useCallback(
    (id: string) => {
      setSelectedId(null);
      const node = layout.nodes.find((item) => item.id === id);
      if (!node) {
        return;
      }
      const nodeType = graphNodeTypeFromGroup(node.group);
      onOpenDetail?.(id, nodeType);
    },
    [layout.nodes, onOpenDetail],
  );

  const canvasNodes: GraphCanvasNode[] = useMemo(
    () =>
      layout.nodes.map((node) => {
        const inFocus = !focusSet || focusSet.has(node.id);
        return {
          id: node.id,
          label: node.label,
          type: graphNodeTypeFromGroup(node.group),
          x: node.x,
          y: node.y,
          fill: getArisNodeKindColor(node.group),
          opacity: inFocus ? 1 : FOCUS_FADE_OPACITY,
          selected: node.id === selectedId,
        };
      }),
    [layout.nodes, focusSet, selectedId],
  );

  const canvasEdges: GraphCanvasEdge[] = useMemo(
    () =>
      layout.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        stroke: getArisEdgeRelationColor(edge.relation),
        strokeWidth: 2,
        opacity: !focusSet || (focusSet.has(edge.source) && focusSet.has(edge.target)) ? 1 : 0.2,
      })),
    [layout.edges, focusSet],
  );

  const visibleNodeKinds = useMemo(() => {
    const kinds = new Set<keyof typeof ARIS_KNOWLEDGE_GRAPH_NODE_COLORS>();
    for (const node of layout.nodes) {
      if (
        node.group === "paper" ||
        node.group === "idea" ||
        node.group === "experiment" ||
        node.group === "claim" ||
        node.group === "gap"
      ) {
        kinds.add(node.group);
      }
    }
    return kinds;
  }, [layout.nodes]);

  const visibleRelations = useMemo(() => {
    const relations = new Set<string>();
    for (const edge of layout.edges) {
      if (edge.relation && isArisKnowledgeGraphRelation(edge.relation)) {
        relations.add(edge.relation);
      }
    }
    return relations;
  }, [layout.edges]);

  const hasAnyData = data != null || (wikiGraph != null && (wikiGraph.nodes?.length ?? 0) > 0);
  if (!hasAnyData) {
    return <ChartKitEmpty message="No research graph data available." />;
  }

  if (layout.nodes.length === 0) {
    return <ChartKitEmpty message="Knowledge graph is empty for this review state." />;
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardContent}>
        <Text style={styles.heading}>Research Knowledge Graph</Text>
        <PannableCanvas
          nodes={canvasNodes}
          edges={canvasEdges}
          onSelectNode={handleSelect}
          onOpenNode={onOpenDetail ? handleOpen : undefined}
        />
        <View style={styles.legendRow}>
          <NodeLegend visibleKinds={visibleNodeKinds} />
          <EdgeLegend visibleRelations={visibleRelations} />
        </View>
        <Text style={styles.summary}>
          {layout.nodes.length} nodes, {layout.edges.length} edges
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Legends
// ---------------------------------------------------------------------------

const NODE_KIND_LABELS: Record<keyof typeof ARIS_KNOWLEDGE_GRAPH_NODE_COLORS, string> = {
  paper: "Paper",
  idea: "Idea",
  experiment: "Experiment",
  claim: "Claim",
  gap: "Gap",
};

const NODE_KIND_SHAPES: Record<
  keyof typeof ARIS_KNOWLEDGE_GRAPH_NODE_COLORS,
  "circle" | "rect" | "diamond" | "dashed-circle"
> = {
  paper: "circle",
  idea: "circle",
  experiment: "rect",
  claim: "diamond",
  gap: "dashed-circle",
};

function NodeLegend({
  visibleKinds,
}: {
  visibleKinds: Set<keyof typeof ARIS_KNOWLEDGE_GRAPH_NODE_COLORS>;
}) {
  if (visibleKinds.size === 0) {
    return null;
  }
  return (
    <View style={styles.legendGroup}>
      {Array.from(visibleKinds).map((kind) => (
        <View key={kind} style={styles.legendItem}>
          <NodeLegendSwatch kind={kind} />
          <Text style={styles.legendLabel}>{NODE_KIND_LABELS[kind]}</Text>
        </View>
      ))}
    </View>
  );
}

function NodeLegendSwatch({ kind }: { kind: keyof typeof ARIS_KNOWLEDGE_GRAPH_NODE_COLORS }) {
  const color = ARIS_KNOWLEDGE_GRAPH_NODE_COLORS[kind];
  return (
    <Svg width={16} height={16}>
      {renderLegendShape(NODE_KIND_SHAPES[kind], color, 8)}
    </Svg>
  );
}

function renderLegendShape(
  shape: "circle" | "rect" | "diamond" | "dashed-circle",
  color: string,
  center: number,
): ReactNode {
  switch (shape) {
    case "rect":
      return (
        <Rect
          x={center - 6}
          y={center - 6}
          width={12}
          height={12}
          rx={3}
          fill={color}
          stroke={INK.ringDefault}
          strokeWidth={1.5}
        />
      );
    case "diamond": {
      const points = [
        `${center},${center - 6}`,
        `${center + 6},${center}`,
        `${center},${center + 6}`,
        `${center - 6},${center}`,
      ].join(" ");
      return <Polygon points={points} fill={color} stroke={INK.ringDefault} strokeWidth={1.5} />;
    }
    case "dashed-circle":
      return (
        <Circle
          cx={center}
          cy={center}
          r={5.5}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="3 2"
        />
      );
    default:
      return (
        <Circle
          cx={center}
          cy={center}
          r={5.5}
          fill={color}
          stroke={INK.ringDefault}
          strokeWidth={1.5}
        />
      );
  }
}

function EdgeLegendChip({ relation, color }: { relation: string; color: string }) {
  const lineStyle = useMemo(() => [styles.legendLine, { backgroundColor: color }], [color]);
  return (
    <View style={styles.legendItem}>
      <View style={lineStyle} />
      <Text style={styles.legendLabel}>{relation}</Text>
    </View>
  );
}

function EdgeLegend({ visibleRelations }: { visibleRelations: Set<string> }) {
  if (visibleRelations.size === 0) {
    return null;
  }
  return (
    <View style={styles.legendGroup}>
      {Array.from(visibleRelations).map((relation) => {
        const color = isArisKnowledgeGraphRelation(relation)
          ? ARIS_KNOWLEDGE_GRAPH_EDGE_COLORS[relation]
          : ARIS_NEUTRAL_NODE_COLOR;
        return <EdgeLegendChip key={relation} relation={relation} color={color} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    overflow: "hidden",
  },
  cardContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  heading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  canvasContainer: {
    gap: theme.spacing[1],
  },
  canvasViewport: {
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  canvasToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  resetButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.base,
  },
  resetButtonText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  zoomLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
  },
  legendGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  legendLine: {
    width: 12,
    height: 2,
    borderRadius: theme.borderRadius.full,
  },
  legendLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  summary: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
