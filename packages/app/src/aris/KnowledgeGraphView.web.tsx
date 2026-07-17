/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { memo, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { View, Text, ScrollView } from "react-native";
import Svg, { Circle, Line, Polygon, Rect, G, Text as SvgText } from "react-native-svg";
import type { ArisKnowledgeGraph, ArisReviewState } from "@getpaseo/protocol/messages";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import {
  buildLayeredKnowledgeGraphLayout,
  type KnowledgeGraphEdgeInput,
  type KnowledgeGraphNodeInput,
} from "./knowledge-graph-layout";
import { ChartKitEmpty } from "./chart-kit";
import { ARIS_CATEGORICAL_PALETTE } from "./charts/color-palette";

export interface KnowledgeGraphViewProps {
  data: ArisReviewReadResult | null | undefined;
  /** Knowledge graph derived from research-wiki (papers/ideas/experiments/claims). Preferred over `data.knowledgeGraph` when non-empty. */
  wikiGraph?: ArisKnowledgeGraph | null;
  width?: number;
  height?: number;
}

const GRAPH_WIDTH = 700;
const GRAPH_HEIGHT = 360;
const DEFAULT_EDGE_STROKE = "#94a3b8";
const DEFAULT_EDGE_WIDTH = 1.5;
const FOCUS_FADE_OPACITY = 0.3;

type ArisKnowledgeGraphEdge = NonNullable<ArisKnowledgeGraph["edges"]>[number];

// ---------------------------------------------------------------------------
// Reusable canvas
//
// `KnowledgeGraphCanvas` is a presentational SVG renderer: it draws edges and
// nodes (with per-node fill/opacity/selection and per-edge stroke/width) and
// forwards clicks. All idea-evolution logic (status colors, BFS highlight,
// time-window dimming) lives in the parent, which computes the final opacity
// per node/edge and hands the canvas a flat list to render.
// ---------------------------------------------------------------------------

export type GraphNodeType = "idea" | "experiment" | "claim" | "paper" | "default";

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
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function nodeRadius(type: GraphNodeType): number {
  switch (type) {
    case "idea":
      return 20;
    case "experiment":
      return 18;
    case "claim":
      return 16;
    case "paper":
      return 13;
    default:
      return 18;
  }
}

function graphNodeTypeFromGroup(group: string | undefined): GraphNodeType {
  switch (group) {
    case "idea":
    case "experiment":
    case "claim":
    case "paper":
      return group;
    default:
      return "default";
  }
}

interface NodeViewProps {
  node: GraphCanvasNode;
  onSelect: ((id: string) => void) | undefined;
}

const GraphCanvasNodeView = memo(function GraphCanvasNodeView({ node, onSelect }: NodeViewProps) {
  const handlePress = useCallback(() => {
    onSelect?.(node.id);
  }, [node.id, onSelect]);

  const radius = nodeRadius(node.type);
  const label = truncateLabel(node.label, 8);
  const ringStroke = node.selected ? "#0f172a" : "#ffffff";
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
          rx={6}
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
    <G onPress={handlePress} opacity={node.opacity ?? 1}>
      {shape}
      <SvgText
        x={node.x}
        y={node.y + 3}
        fontSize={9}
        fill="#ffffff"
        textAnchor="middle"
        fontWeight="600"
      >
        {label}
      </SvgText>
    </G>
  );
});

export function KnowledgeGraphCanvas({
  nodes,
  edges,
  width,
  height,
  onSelectNode,
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
          <Line
            key={`${edge.source}->${edge.target}`}
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            stroke={edge.stroke ?? DEFAULT_EDGE_STROKE}
            strokeWidth={edge.strokeWidth ?? DEFAULT_EDGE_WIDTH}
            opacity={edge.opacity ?? 1}
          />
        );
      })}
      {nodes.map((node) => (
        <GraphCanvasNodeView key={node.id} node={node} onSelect={onSelectNode} />
      ))}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Review-state knowledge graph view (existing API, now with click-to-focus)
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
}: KnowledgeGraphViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const edges: KnowledgeGraphEdgeInput[] = useMemo(() => {
    // Prefer research-wiki graph (papers/ideas/experiments/claims/edges) when non-empty.
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

  const canvasNodes: GraphCanvasNode[] = useMemo(
    () =>
      layout.nodes.map((node, index) => {
        const inFocus = !focusSet || focusSet.has(node.id);
        return {
          id: node.id,
          label: node.label,
          type: graphNodeTypeFromGroup(node.group),
          x: node.x,
          y: node.y,
          fill: ARIS_CATEGORICAL_PALETTE[index % ARIS_CATEGORICAL_PALETTE.length] ?? "#3b82f6",
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
        opacity: !focusSet || (focusSet.has(edge.source) && focusSet.has(edge.target)) ? 1 : 0.2,
      })),
    [layout.edges, focusSet],
  );

  // Only show the empty state when we have no data sources at all.
  // Previously this bailed out as soon as `data` (review) was null, which
  // hid the wiki-derived graph whenever the review query was unloaded.
  const hasAnyData = data != null || (wikiGraph != null && (wikiGraph.nodes?.length ?? 0) > 0);
  if (!hasAnyData) {
    return <ChartKitEmpty message="No research graph data available." />;
  }

  if (layout.nodes.length === 0) {
    return <ChartKitEmpty message="Knowledge graph is empty for this review state." />;
  }

  return (
    <ScrollView horizontal contentContainerStyle={{ padding: 16 }}>
      <View style={{ gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: "600" }}>Research Knowledge Graph</Text>
        <KnowledgeGraphCanvas
          nodes={canvasNodes}
          edges={canvasEdges}
          width={width}
          height={height}
          onSelectNode={handleSelect}
        />
        <Text style={{ fontSize: 12, color: "#64748b" }}>
          {layout.nodes.length} nodes · {layout.edges.length} edges
          {selectedId ? " · click a node to focus its neighbors" : ""}
        </Text>
      </View>
    </ScrollView>
  );
}
