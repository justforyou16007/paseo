import { withUnistyles } from "react-native-unistyles";
import { LineChart, type LineChartProps } from "./line-chart";

export const ThemedLineChart = withUnistyles(LineChart, (theme) => ({
  colors: {
    grid: theme.colors.border,
    axis: theme.colors.foregroundMuted,
    text: theme.colors.foreground,
    surface: theme.colors.surface1,
  },
}));

export type { LineChartProps, LineChartData, LineChartSeries } from "./line-chart";
