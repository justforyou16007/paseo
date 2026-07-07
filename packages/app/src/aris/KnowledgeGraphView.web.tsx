/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import React, { useMemo } from "react";
import { View, Text, ScrollView } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import type { ArisKnowledgeGraph, ArisReviewState } from "@getpaseo/protocol/messages";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import {
  buildLayeredKnowledgeGraphLayout,
  type KnowledgeGraphEdgeInput,
} from "./knowledge-graph-layout";
import { ChartKitEmpty } from "./chart-kit";

export interface KnowledgeGraphViewProps {
  data: ArisReviewReadResult | null | undefined;
  width?: number;
  height?: number;
}

const GRAPH_WIDTH = 700;
const GRAPH_HEIGHT = 360;
const NODE_RADIUS = 22;
const NODE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4"];

type ArisKnowledgeGraphEdge = NonNullable<ArisKnowledgeGraph["edges"]>[number];

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
  return reviewState.rounds.flatMap((round, roundIndex) => {
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

export function KnowledgeGraphView({
  data,
  width = GRAPH_WIDTH,
  height = GRAPH_HEIGHT,
}: KnowledgeGraphViewProps) {
  const edges: KnowledgeGraphEdgeInput[] = useMemo(() => {
    const graphEdges = buildEdgesFromKnowledgeGraph(data?.knowledgeGraph);
    if (graphEdges.length > 0) {
      return graphEdges;
    }
    return buildEdgesFromReviewRounds(data?.reviewState);
  }, [data]);

  const layout = useMemo(() => {
    return buildLayeredKnowledgeGraphLayout({ edges, width, height });
  }, [edges, width, height]);

  if (!data) {
    return <ChartKitEmpty message="No research graph data available." />;
  }

  if (layout.nodes.length === 0) {
    return <ChartKitEmpty message="Knowledge graph is empty for this review state." />;
  }

  const nodePositions = new Map(layout.nodes.map((node) => [node.id, node]));

  return (
    <ScrollView horizontal contentContainerStyle={{ padding: 16 }}>
      <View style={{ gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: "600" }}>Research Knowledge Graph</Text>
        <Svg width={width} height={height}>
          {layout.edges.map((edge) => {
            const source = nodePositions.get(edge.source);
            const target = nodePositions.get(edge.target);
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
                stroke="#94a3b8"
                strokeWidth={1.5}
              />
            );
          })}
          {layout.nodes.map((node, index) => (
            <React.Fragment key={node.id}>
              <Circle
                cx={node.x}
                cy={node.y}
                r={NODE_RADIUS}
                fill={NODE_COLORS[index % NODE_COLORS.length]}
              />
              <SvgText
                x={node.x}
                y={node.y + 4}
                fontSize={10}
                fill="#ffffff"
                textAnchor="middle"
                fontWeight="600"
              >
                {node.label.length > 8 ? `${node.label.slice(0, 6)}…` : node.label}
              </SvgText>
            </React.Fragment>
          ))}
        </Svg>
        <Text style={{ fontSize: 12, color: "#64748b" }}>
          {layout.nodes.length} nodes · {layout.edges.length} edges
        </Text>
      </View>
    </ScrollView>
  );
}
