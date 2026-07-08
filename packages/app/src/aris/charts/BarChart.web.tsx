import React, { useMemo } from "react";
import Svg, { Rect, Text as SvgText, G } from "react-native-svg";

export interface BarChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface BarChartProps {
  data: BarChartDatum[];
  width: number;
  height: number;
  barSpacing?: number;
  maxBarWidth?: number;
  defaultColor?: string;
}

export function BarChart({
  data,
  width,
  height,
  barSpacing = 8,
  maxBarWidth = 40,
  defaultColor = "#3b82f6",
}: BarChartProps) {
  const padding = { top: 12, right: 12, bottom: 24, left: 12 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxValue = useMemo(() => Math.max(...data.map((d) => d.value), 1), [data]);
  const barWidthVal = useMemo(
    () => Math.min(maxBarWidth, (chartWidth - barSpacing * (data.length - 1)) / data.length),
    [chartWidth, barSpacing, data.length, maxBarWidth],
  );
  const totalBarsWidth = data.length * barWidthVal + (data.length - 1) * barSpacing;
  const offsetX = padding.left + (chartWidth - totalBarsWidth) / 2;

  return (
    <Svg width={width} height={height}>
      {data.map((d, i) => {
        const barHeight = (d.value / maxValue) * chartHeight;
        const x = offsetX + i * (barWidthVal + barSpacing);
        const y = padding.top + chartHeight - barHeight;
        const fill = d.color ?? defaultColor;
        return (
          <G key={d.label ?? i}>
            <Rect x={x} y={y} width={barWidthVal} height={barHeight} rx={4} ry={4} fill={fill} />
            <SvgText
              x={x + barWidthVal / 2}
              y={height - 4}
              fontSize={10}
              fill="#9ca3af"
              textAnchor="middle"
            >
              {d.label}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}
