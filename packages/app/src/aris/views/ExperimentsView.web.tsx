import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useArisExperiments } from "../use-aris-experiments";
import { MetricCard } from "../charts/metric-card";
import { ThemedLineChart } from "../charts/line-chart-themed";
import type { ArisExperimentRun } from "../types";

export default function ExperimentsView() {
  const { serverId, workspaceId } = usePaneContext();
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const { data, isLoading, error } = useArisExperiments(serverId, cwd);

  const experiments = useMemo(() => data ?? [], [data]);

  const stats = useMemo(() => {
    const total = experiments.length;
    const completed = experiments.filter((run) => run.metadata.status === "completed").length;
    const failed = experiments.filter((run) => run.metadata.status === "failed").length;
    const running = experiments.filter((run) => run.metadata.status === "running").length;
    return { total, completed, failed, running };
  }, [experiments]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Loading experiments…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Failed to load experiments.</Text>
        <Text style={styles.muted}>{error.message}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Experiments</Text>

      <View style={styles.metricRow}>
        <MetricCard label="Total experiments" value={String(stats.total)} />
        <MetricCard label="Completed" value={String(stats.completed)} tone="positive" />
        <MetricCard label="Running" value={String(stats.running)} tone="warning" />
        <MetricCard label="Failed" value={String(stats.failed)} tone="negative" />
      </View>

      <View style={styles.listSection}>
        {experiments.length === 0 ? (
          <Text style={styles.muted}>No experiments found.</Text>
        ) : (
          experiments.map((run) => <ExperimentRunRow key={run.id} run={run} />)
        )}
      </View>
    </ScrollView>
  );
}

function ExperimentRunRow({ run }: { run: ArisExperimentRun }) {
  const metrics = run.metrics;

  const chartData = useMemo(() => {
    if (!metrics) return null;
    const seriesNames = Object.keys(metrics.series);
    return {
      timestamps: metrics.timestamps,
      series: seriesNames.map((name) => ({
        name,
        values: metrics.series[name] ?? [],
      })),
    };
  }, [metrics]);

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {run.metadata.title}
        </Text>
        <StatusBadge status={run.metadata.status} />
      </View>
      {run.metadata.content ? (
        <Text style={styles.rowBody} numberOfLines={3}>
          {run.metadata.content}
        </Text>
      ) : null}

      {chartData ? (
        <View style={styles.chartWrap}>
          <ThemedLineChart data={chartData} width={660} height={220} title="Metric evolution" />
        </View>
      ) : null}
    </View>
  );
}

function runStatusBadgeStyle(status: ArisExperimentRun["metadata"]["status"]) {
  switch (status) {
    case "completed":
      return styles.badgeSuccess;
    case "failed":
      return styles.badgeDanger;
    case "running":
      return styles.badgeWarning;
    default:
      return styles.badge;
  }
}

function StatusBadge({ status }: { status: ArisExperimentRun["metadata"]["status"] }) {
  const badgeStyle = runStatusBadgeStyle(status);

  return (
    <View style={badgeStyle}>
      <Text style={styles.badgeText}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[6],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontWeight: "600",
  },
  heading: {
    fontSize: theme.fontSize.xl,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  metricRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  listSection: {
    gap: theme.spacing[3],
  },
  row: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  rowBody: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  chartWrap: {
    marginTop: theme.spacing[2],
  },
  badge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  badgeSuccess: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.green[900],
    borderWidth: 1,
    borderColor: theme.colors.palette.green[600],
  },
  badgeDanger: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.red[900],
    borderWidth: 1,
    borderColor: theme.colors.palette.red[600],
  },
  badgeWarning: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.amber[700],
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[500],
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
}));
