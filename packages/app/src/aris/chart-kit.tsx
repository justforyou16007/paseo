/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import React from "react";
import { View, Text } from "react-native";
import Svg, { Rect, Path, G, Text as SvgText } from "react-native-svg";

export interface ChartKitBarProps {
  data: { label: string; value: number; color?: string }[];
  width: number;
  height: number;
}

export function ChartKitBar({ data, width, height }: ChartKitBarProps) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = data.length > 0 ? width / data.length - 8 : 0;
  return (
    <Svg width={width} height={height}>
      {data.map((item, index) => {
        const barHeight = (item.value / max) * (height - 24);
        const x = index * (barWidth + 8) + 4;
        const y = height - barHeight - 16;
        return (
          <G key={item.label}>
            <Rect
              x={x}
              y={y}
              width={Math.max(barWidth, 4)}
              height={barHeight}
              fill={item.color ?? "#3b82f6"}
              rx={4}
            />
            <SvgText
              x={x + barWidth / 2}
              y={height - 2}
              fontSize={10}
              fill="#64748b"
              textAnchor="middle"
            >
              {item.label}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

export interface ChartKitPieProps {
  slices: { label: string; value: number; color: string }[];
  size: number;
}

export function ChartKitPie({ slices, size }: ChartKitPieProps) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const radius = size / 2 - 8;
  const center = size / 2;
  let startAngle = 0;

  return (
    <Svg width={size} height={size}>
      {slices.map((slice) => {
        const angle = (slice.value / total) * 2 * Math.PI;
        const endAngle = startAngle + angle;
        const x1 = center + radius * Math.cos(startAngle);
        const y1 = center + radius * Math.sin(startAngle);
        const x2 = center + radius * Math.cos(endAngle);
        const y2 = center + radius * Math.sin(endAngle);
        const largeArc = angle > Math.PI ? 1 : 0;
        const path = `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
        startAngle = endAngle;
        return <Path key={slice.label} d={path} fill={slice.color} stroke="#fff" strokeWidth={1} />;
      })}
    </Svg>
  );
}

export interface ChartKitLegendProps {
  items: { label: string; color: string }[];
}

export function ChartKitLegend({ items }: ChartKitLegendProps) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: item.color,
            }}
          />
          <Text style={{ fontSize: 12, color: "#64748b" }}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function ChartKitEmpty({ message }: { message: string }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ fontSize: 14, color: "#94a3b8", textAlign: "center" }}>{message}</Text>
    </View>
  );
}
