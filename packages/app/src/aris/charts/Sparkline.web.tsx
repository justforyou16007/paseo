import React, { useMemo } from "react";
import Svg, { Polyline, LinearGradient, Defs, Stop, Circle } from "react-native-svg";

export interface SparklineProps {
  values: number[];
  width: number;
  height: number;
  strokeColor?: string;
  strokeWidth?: number;
  fillColor?: string;
  showDot?: boolean;
}

export function Sparkline({
  values,
  width,
  height,
  strokeColor = "#3b82f6",
  strokeWidth = 1.5,
  fillColor,
  showDot = false,
}: SparklineProps) {
  const color = strokeColor;
  const fill = fillColor ?? color;
  const padding = 2;

  const { points, areaPoints, lastPoint } = useMemo(() => {
    if (values.length === 0) return { points: "", areaPoints: "", lastPoint: null };
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const stepX = (width - padding * 2) / Math.max(values.length - 1, 1);
    const pts = values.map((v, i) => ({
      x: padding + i * stepX,
      y: padding + (height - padding * 2) * ((max - v) / range),
    }));
    const pStr = pts.map((p) => `${p.x},${p.y}`).join(" ");
    const areaStr = [
      `${pts[0].x},${height - padding}`,
      ...pts.map((p) => `${p.x},${p.y}`),
      `${pts[pts.length - 1].x},${height - padding}`,
    ].join(" ");
    return { points: pStr, areaPoints: areaStr, lastPoint: pts[pts.length - 1] };
  }, [values, width, height]);

  if (values.length < 2) return null;

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="sparklineFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={fill} stopOpacity={0.3} />
          <Stop offset="1" stopColor={fill} stopOpacity={0.05} />
        </LinearGradient>
      </Defs>
      <Polyline points={areaPoints} fill="url(#sparklineFill)" />
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showDot && lastPoint && <Circle cx={lastPoint.x} cy={lastPoint.y} r={2.5} fill={color} />}
    </Svg>
  );
}
