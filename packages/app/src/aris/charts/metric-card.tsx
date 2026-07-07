import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface MetricCardProps {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "default" | "positive" | "negative" | "warning";
}

function valueStyleForTone(tone: NonNullable<MetricCardProps["tone"]>) {
  switch (tone) {
    case "positive":
      return styles.valuePositive;
    case "negative":
      return styles.valueNegative;
    case "warning":
      return styles.valueWarning;
    default:
      return styles.value;
  }
}

export function MetricCard({ label, value, subtitle, tone = "default" }: MetricCardProps) {
  const valueStyle = valueStyleForTone(tone);

  return (
    <View style={styles.card}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Text style={valueStyle} numberOfLines={1}>
        {value}
      </Text>
      {subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[1],
    minWidth: 140,
  },
  label: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  value: {
    fontSize: theme.fontSize.xl,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  valuePositive: {
    fontSize: theme.fontSize.xl,
    fontWeight: "700",
    color: theme.colors.statusSuccess,
  },
  valueNegative: {
    fontSize: theme.fontSize.xl,
    fontWeight: "700",
    color: theme.colors.statusDanger,
  },
  valueWarning: {
    fontSize: theme.fontSize.xl,
    fontWeight: "700",
    color: theme.colors.statusWarning,
  },
  subtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
