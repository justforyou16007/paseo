import React, { useMemo } from "react";
import Svg, { Circle, Line, G } from "react-native-svg";
import type { ArisPipelinePhase } from "../aris-types";

export interface PhaseTimelineProps {
  phases: ArisPipelinePhase[];
  width: number;
  currentPhaseId?: string | null;
}

const STATUS_COLORS = {
  pending: "#6b7280",
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
} as const;

function PhaseTimelineSvg({ phases, width, currentPhaseId }: PhaseTimelineProps) {
  const svgHeight = 80;

  const layout = useMemo(() => {
    if (phases.length === 0) return { nodes: [] };
    const padding = 40;
    const spacing = (width - padding * 2) / Math.max(phases.length - 1, 1);
    return {
      nodes: phases.map((p, idx) => ({
        x: padding + idx * spacing,
        phase: p,
        isCurrent: p.phaseId === currentPhaseId,
      })),
    };
  }, [phases, width, currentPhaseId]);

  const lineEndX = layout.nodes.length > 0 ? layout.nodes[layout.nodes.length - 1].x : 0;

  return (
    <Svg width={width} height={svgHeight}>
      <Line
        x1={40}
        y1={svgHeight / 2}
        x2={lineEndX}
        y2={svgHeight / 2}
        stroke="#374151"
        strokeWidth={2}
      />
      {layout.nodes.map((node) => (
        <G key={node.phase.phaseId}>
          <Circle
            cx={node.x}
            cy={svgHeight / 2}
            r={node.isCurrent ? 7 : 5}
            fill={STATUS_COLORS[node.phase.status]}
            stroke="#1f2937"
            strokeWidth={2}
          />
        </G>
      ))}
    </Svg>
  );
}

export function PhaseTimeline(props: PhaseTimelineProps) {
  return <PhaseTimelineSvg {...props} />;
}
