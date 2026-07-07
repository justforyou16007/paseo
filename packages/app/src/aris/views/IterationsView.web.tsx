import React, { useMemo } from "react";
import { View, Text, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArisIteration } from "@getpaseo/protocol/messages";
import { LineChart } from "../charts/LineChart.web";
import { Sparkline } from "../charts/Sparkline.web";

export interface IterationsViewProps {
  iterations: ArisIteration[];
  runId: string;
  width: number;
}

function buildScorePoints(iterations: ArisIteration[]) {
  return iterations
    .filter((it) => it.score != null)
    .map((it, i) => ({
      x: i,
      y: it.score!,
      label: `#${it.index}`,
    }));
}

export function IterationsView({ iterations, runId, width }: IterationsViewProps) {
  const scorePoints = useMemo(() => buildScorePoints(iterations), [iterations]);
  const sparklineValues = useMemo(() => iterations.map((it) => it.score ?? 0), [iterations]);

  const hasScores = iterations.some((it) => it.score != null);

  return (
    <ScrollView style={styles.container}>
      {hasScores && scorePoints.length >= 2 && (
        <View style={styles.chartSection}>
          <Text style={styles.sectionTitle}>Score Progression</Text>
          <LineChart data={scorePoints} width={width - 24} height={180} showPoints />
        </View>
      )}

      {hasScores && sparklineValues.length >= 2 && (
        <View style={styles.chartSection}>
          <Text style={styles.sectionTitle}>Score Sparkline</Text>
          <Sparkline values={sparklineValues} width={width - 24} height={40} showDot />
        </View>
      )}

      <View style={styles.listSection}>
        <Text style={styles.sectionTitle}>Iterations ({iterations.length})</Text>
        {iterations.length === 0 ? (
          <Text style={styles.emptyText}>No iterations recorded</Text>
        ) : (
          iterations.map((it) => (
            <View key={it.iterationId} style={styles.iterationRow}>
              <Text style={styles.iterationIndex}>#{it.index}</Text>
              <Text style={styles.iterationPhase}>{it.phaseId.slice(0, 8)}</Text>
              {it.score != null && <Text style={styles.iterationScore}>Score: {it.score}</Text>}
              <Text style={styles.iterationDate}>
                {new Date(it.createdAt).toLocaleTimeString()}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  chartSection: {
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  listSection: {
    padding: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  iterationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface1,
  },
  iterationIndex: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    color: theme.colors.foreground,
    width: 40,
  },
  iterationPhase: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: "monospace",
    flex: 1,
  },
  iterationScore: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.blue[500],
  },
  iterationDate: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
