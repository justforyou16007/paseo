import { View, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChartBar } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedChartBar = withUnistyles(ChartBar);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function ChartKitEmpty({ message }: { message: string }) {
  return (
    <View style={styles.emptyBox}>
      <View style={styles.emptyIconWrap}>
        <ThemedChartBar size={18} strokeWidth={1.75} uniProps={foregroundMutedColorMapping} />
      </View>
      <Text style={styles.emptyMessage}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyBox: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[6],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  emptyIconWrap: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 360,
  },
}));
