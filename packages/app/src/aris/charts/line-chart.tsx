import { useMemo } from "react";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Polyline, Text as SvgText } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import { getArisSeriesColor } from "./color-palette";

export interface LineChartSeries {
  name: string;
  values: number[];
}

export interface LineChartData {
  timestamps: number[];
  series: LineChartSeries[];
}

export interface LineChartColors {
  grid: string;
  axis: string;
  text: string;
  surface: string;
}

export interface LineChartProps {
  data: LineChartData;
  width: number;
  height: number;
  title?: string;
  colors: LineChartColors;
  yAxisLabelCount?: number;
  formatY?: (value: number) => string;
  formatX?: (timestamp: number) => string;
}

const MARGIN = { top: 24, right: 16, bottom: 32, left: 48 };

function computeExtent(values: number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value)) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (min === max) {
    return { min: min - 1, max: max + 1 };
  }
  const padding = (max - min) * 0.1;
  return { min: min - padding, max: max + padding };
}

function formatNumberCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export function LineChart({
  data,
  width,
  height,
  title,
  colors,
  yAxisLabelCount = 4,
  formatY = formatNumberCompact,
  formatX = (timestamp) => new Date(timestamp).toLocaleDateString(),
}: LineChartProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const allValues = useMemo(() => data.series.flatMap((series) => series.values), [data.series]);
  const { min: yMin, max: yMax } = useMemo(() => computeExtent(allValues), [allValues]);
  const xCount = Math.max(1, data.timestamps.length - 1);

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let i = 0; i < yAxisLabelCount; i += 1) {
      const ratio = i / Math.max(1, yAxisLabelCount - 1);
      ticks.push(yMin + ratio * (yMax - yMin));
    }
    return ticks;
  }, [yMin, yMax, yAxisLabelCount]);

  const xTicks = useMemo(() => {
    if (data.timestamps.length === 0) return [];
    const ticks: number[] = [0, Math.floor(xCount / 2), xCount];
    return ticks.filter((index) => index >= 0 && index < data.timestamps.length);
  }, [data.timestamps.length, xCount]);

  const paths = useMemo(() => {
    const yScale = (value: number) => {
      const ratio = (value - yMin) / (yMax - yMin);
      return MARGIN.top + innerHeight - ratio * innerHeight;
    };
    const xScale = (index: number) => {
      return MARGIN.left + (index / xCount) * innerWidth;
    };

    return data.series.map((series) => {
      const points = series.values
        .map((value, index) => {
          const x = xScale(index);
          const y = yScale(value);
          return `${x},${y}`;
        })
        .join(" ");
      const pointsArray = series.values.map((value, index) => ({
        x: xScale(index),
        y: yScale(value),
        value,
      }));
      return { points, pointsArray };
    });
  }, [data.series, yMin, yMax, innerHeight, xCount, innerWidth]);

  const containerStyle = useMemo(
    () => RNStyleSheet.flatten([styles.container, { backgroundColor: colors.surface }]),
    [colors.surface],
  );
  const titleStyle = useMemo(
    () => RNStyleSheet.flatten([styles.title, { color: colors.text }]),
    [colors.text],
  );
  const legendTextStyle = useMemo(
    () => RNStyleSheet.flatten([styles.legendText, { color: colors.text }]),
    [colors.text],
  );

  if (width <= 0 || height <= 0) {
    return null;
  }

  return (
    <View style={containerStyle}>
      {title ? (
        <Text style={titleStyle} numberOfLines={1}>
          {title}
        </Text>
      ) : null}
      <Svg width={width} height={height}>
        <G>
          {/* Y grid + labels */}
          {yTicks.map((tick) => {
            const y = MARGIN.top + innerHeight - ((tick - yMin) / (yMax - yMin)) * innerHeight;
            return (
              <G key={`y-tick-${tick}`}>
                <Line
                  x1={MARGIN.left}
                  y1={y}
                  x2={MARGIN.left + innerWidth}
                  y2={y}
                  stroke={colors.grid}
                  strokeWidth={1}
                  strokeDasharray="4,4"
                />
                <SvgText
                  x={MARGIN.left - 8}
                  y={y + 4}
                  fill={colors.text}
                  fontSize={10}
                  textAnchor="end"
                >
                  {formatY(tick)}
                </SvgText>
              </G>
            );
          })}

          {/* X labels */}
          {xTicks.map((index) => {
            const x = MARGIN.left + (index / xCount) * innerWidth;
            return (
              <SvgText
                key={`x-${index}`}
                x={x}
                y={MARGIN.top + innerHeight + 16}
                fill={colors.text}
                fontSize={10}
                textAnchor="middle"
              >
                {formatX(data.timestamps[index] ?? 0)}
              </SvgText>
            );
          })}

          {/* Axes */}
          <Line
            x1={MARGIN.left}
            y1={MARGIN.top}
            x2={MARGIN.left}
            y2={MARGIN.top + innerHeight}
            stroke={colors.axis}
            strokeWidth={1}
          />
          <Line
            x1={MARGIN.left}
            y1={MARGIN.top + innerHeight}
            x2={MARGIN.left + innerWidth}
            y2={MARGIN.top + innerHeight}
            stroke={colors.axis}
            strokeWidth={1}
          />

          {/* Data series */}
          {paths.map((path, seriesIndex) => {
            const color = getArisSeriesColor(seriesIndex);
            const seriesName = data.series[seriesIndex]?.name ?? String(seriesIndex);
            return (
              <G key={seriesName}>
                <Polyline
                  points={path.points}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {path.pointsArray.map((point) => (
                  <Circle
                    key={`pt-${seriesIndex}-${point.x}-${point.value}`}
                    cx={point.x}
                    cy={point.y}
                    r={3}
                    fill={colors.surface}
                    stroke={color}
                    strokeWidth={2}
                  />
                ))}
              </G>
            );
          })}
        </G>
      </Svg>

      {/* Legend */}
      {data.series.length > 1 ? (
        <View style={styles.legend}>
          {data.series.map((series, index) => (
            <View key={series.name} style={styles.legendItem}>
              <LegendDot color={getArisSeriesColor(index)} />
              <Text style={legendTextStyle} numberOfLines={1}>
                {series.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function LegendDot({ color }: { color: string }) {
  const style = useMemo(
    () => RNStyleSheet.flatten([styles.legendDot, { backgroundColor: color }]),
    [color],
  );
  return <View style={style} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    marginBottom: theme.spacing[2],
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: theme.fontSize.xs,
  },
}));
