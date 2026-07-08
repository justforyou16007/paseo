import React, { useMemo } from "react";
import Svg, { Polyline, Circle } from "react-native-svg";

export interface LineChartPoint {
  x: number;
  y: number;
  label?: string;
}

export interface LineChartProps {
  data: LineChartPoint[];
  width: number;
  height: number;
  strokeColor?: string;
  strokeWidth?: number;
  showPoints?: boolean;
  pointRadius?: number;
}

export function LineChart({
  data,
  width,
  height,
  strokeColor = "#3b82f6",
  strokeWidth = 2,
  showPoints = false,
  pointRadius = 3,
}: LineChartProps) {
  const color = strokeColor;
  const padding = useMemo(() => ({ top: 8, right: 8, bottom: 8, left: 8 }), []);
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const points = useMemo(() => {
    if (data.length === 0) return [];
    const xs = data.map((p) => p.x);
    const ys = data.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const xRange = maxX - minX || 1;
    const yRange = maxY - minY || 1;
    return data.map((p) => ({
      px: padding.left + ((p.x - minX) / xRange) * chartWidth,
      py: padding.top + chartHeight - ((p.y - minY) / yRange) * chartHeight,
      label: p.label,
    }));
  }, [data, chartWidth, chartHeight, padding]);

  if (points.length < 2) {
    return null;
  }

  const polylinePoints = points.map((p) => `${p.px},${p.py}`).join(" ");

  return (
    <Svg width={width} height={height}>
      <Polyline
        points={polylinePoints}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showPoints &&
        points.map((p) => (
          <Circle key={`${p.px}-${p.py}`} cx={p.px} cy={p.py} r={pointRadius} fill={color} />
        ))}
    </Svg>
  );
}
