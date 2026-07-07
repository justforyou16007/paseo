import { useMemo, useState, useCallback } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { LineChart } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelIconProps, PanelRegistration } from "@/panels/panel-registry";
import { useArisRunsQuery } from "@/hooks/use-aris-query";
import type { ArisRunState } from "@getpaseo/protocol/messages";

function ArisPanelIcon({ size, color }: PanelIconProps) {
  return <LineChart size={size} color={color} />;
}

function useArisPanelDescriptor(): PanelDescriptor {
  return {
    label: "ARIS",
    subtitle: "Run metrics",
    titleState: "ready",
    icon: ArisPanelIcon,
    statusBucket: null,
  };
}

function formatRunDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "#3b82f6";
    case "completed":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "paused":
      return "#f59e0b";
    default:
      return "#6b7280";
  }
}

function ArisRunRow({
  run,
  isSelected,
  onSelect,
}: {
  run: ArisRunState;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      onPress={onSelect}
      style={({ hovered, pressed }) => [
        styles.runRow,
        (isSelected || hovered || pressed) && styles.runRowActive,
      ]}
    >
      <View style={[styles.statusDot, { backgroundColor: statusColor(run.status) }]} />
      <View style={styles.runInfo}>
        <Text numberOfLines={1} style={styles.runGoal}>
          {run.goal || `Run ${run.runId.slice(0, 8)}`}
        </Text>
        <Text style={styles.runMeta}>
          {run.phases.length} phases · {formatRunDate(run.createdAt)}
        </Text>
      </View>
    </Pressable>
  );
}

function ArisPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const { runs, isLoading, isError } = useArisRunsQuery({ serverId, workspaceId });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const handleSelectRun = useCallback((runId: string) => {
    setSelectedRunId((prev) => (prev === runId ? null : runId));
  }, []);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Loading ARIS runs...</Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Failed to load ARIS data</Text>
      </View>
    );
  }

  if (runs.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No ARIS runs found for this workspace</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {selectedRun ? (
        <View style={styles.detailPane}>
          <Pressable onPress={() => setSelectedRunId(null)} style={styles.backButton}>
            <Text style={styles.backText}>← Back to runs</Text>
          </Pressable>
          <Text style={styles.detailTitle}>
            {selectedRun.goal || `Run ${selectedRun.runId.slice(0, 8)}`}
          </Text>
          <Text style={styles.detailStatus}>Status: {selectedRun.status}</Text>
          <Text style={styles.detailDate}>Created: {formatRunDate(selectedRun.createdAt)}</Text>
          {selectedRun.phases.length > 0 && (
            <View style={styles.phasesSection}>
              <Text style={styles.sectionTitle}>Phases</Text>
              {selectedRun.phases.map((phase) => (
                <View key={phase.phaseId} style={styles.phaseRow}>
                  <View style={[styles.phaseDot, { backgroundColor: statusColor(phase.status) }]} />
                  <View style={styles.phaseInfo}>
                    <Text style={styles.phaseName}>{phase.name || phase.phaseId}</Text>
                    <Text style={styles.phaseMeta}>
                      {phase.iterationCount} iterations
                      {phase.bestScore != null ? ` · Best: ${phase.bestScore}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : (
        <FlatList
          data={runs}
          keyExtractor={(item) => item.runId}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <ArisRunRow
              run={item}
              isSelected={item.runId === selectedRunId}
              onSelect={() => handleSelectRun(item.runId)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  listContent: {
    padding: theme.spacing[2],
  },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[1],
  },
  runRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: theme.spacing[2],
  },
  runInfo: {
    flex: 1,
  },
  runGoal: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: "500",
  },
  runMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  detailPane: {
    flex: 1,
    padding: theme.spacing[3],
  },
  backButton: {
    marginBottom: theme.spacing[3],
  },
  backText: {
    color: theme.colors.palette.blue[500],
    fontSize: theme.fontSize.sm,
  },
  detailTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  detailStatus: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[1],
  },
  detailDate: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[3],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  phasesSection: {
    marginTop: theme.spacing[2],
  },
  phaseRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
  },
  phaseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: theme.spacing[2],
  },
  phaseInfo: {
    flex: 1,
  },
  phaseName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  phaseMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));

export const arisPanelRegistration: PanelRegistration<"aris"> = {
  kind: "aris",
  component: ArisPanel,
  useDescriptor: useArisPanelDescriptor,
};
