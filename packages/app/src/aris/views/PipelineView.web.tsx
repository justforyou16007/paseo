import React, { useMemo } from "react";
import { View, Text, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArisRunState } from "@getpaseo/protocol/messages";
import { PhaseTimeline } from "../charts/PhaseTimeline.web";
import type { ArisPipelinePhase } from "../aris-types";

export interface PipelineViewProps {
  run: ArisRunState;
  currentPhaseId?: string | null;
  width: number;
}

function buildPipelinePhases(run: ArisRunState): ArisPipelinePhase[] {
  return run.phases.map((p) => ({
    phaseId: p.phaseId,
    name: p.name || p.phaseId,
    status: p.status,
    iterationCount: p.iterationCount,
    bestScore: p.bestScore ?? null,
    duration: null,
  }));
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "paused":
      return "Paused";
    default:
      return "Pending";
  }
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
} as const;

function phaseDotStyle(status: string) {
  const color = STATUS_COLORS[status] ?? "#6b7280";
  return [styles.phaseDot, { backgroundColor: color }];
}

export function PipelineView({ run, currentPhaseId, width }: PipelineViewProps) {
  const phases = useMemo(() => buildPipelinePhases(run), [run]);

  const statusBg = useMemo(() => STATUS_COLORS[run.status] ?? "#6b7280", [run.status]);

  const statusBadgeStyle = useMemo(
    () => [styles.statusBadge, { backgroundColor: statusBg }],
    [statusBg],
  );

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{run.goal || `Run ${run.runId.slice(0, 8)}`}</Text>
        <View style={statusBadgeStyle}>
          <Text style={styles.statusText}>{statusLabel(run.status)}</Text>
        </View>
      </View>

      <PhaseTimeline phases={phases} width={width} currentPhaseId={currentPhaseId} />

      <View style={styles.phaseList}>
        {phases.map((phase) => {
          return (
            <View
              key={phase.phaseId}
              style={phase.phaseId === currentPhaseId ? styles.phaseCardActive : styles.phaseCard}
            >
              <View style={styles.phaseHeader}>
                <View style={phaseDotStyle(phase.status)} />
                <Text style={styles.phaseName}>{phase.name}</Text>
                <Text style={styles.phaseStatus}>{statusLabel(phase.status)}</Text>
              </View>
              <View style={styles.phaseMeta}>
                <Text style={styles.phaseMetaText}>
                  {phase.iterationCount} iteration{phase.iterationCount !== 1 ? "s" : ""}
                </Text>
                {phase.bestScore != null && (
                  <Text style={styles.phaseMetaText}>Best score: {phase.bestScore}</Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    color: "#ffffff",
    fontWeight: "500",
  },
  phaseList: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  phaseCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  phaseCardActive: {
    borderWidth: 1,
    borderColor: theme.colors.palette.blue[500],
  },
  phaseHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  phaseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  phaseName: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    color: theme.colors.foreground,
    flex: 1,
  },
  phaseStatus: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  phaseMeta: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  phaseMetaText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
