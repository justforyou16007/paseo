import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useArisWiki } from "../use-aris-wiki";
import { MetricCard } from "../charts/metric-card";
import { ThemedLineChart } from "../charts/line-chart-themed";
import type { ArisIdea, ArisClaim } from "../types";

export default function IdeasView() {
  const { serverId, workspaceId } = usePaneContext();
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const { data, isLoading, error } = useArisWiki(serverId, cwd);

  const ideas = useMemo(() => data?.ideas ?? [], [data?.ideas]);
  const papers = useMemo(() => data?.papers ?? [], [data?.papers]);
  const claims = useMemo(() => data?.claims ?? [], [data?.claims]);

  const stats = useMemo(() => {
    const total = ideas.length;
    const validated = ideas.filter((idea) => idea.status === "validated").length;
    const rejected = ideas.filter((idea) => idea.status === "rejected").length;
    const growing = ideas.filter((idea) => idea.status === "growing").length;
    return { total, validated, rejected, growing };
  }, [ideas]);

  const evolutionData = useMemo(() => {
    const bucketed = bucketIdeasByMonth(ideas);
    return {
      timestamps: bucketed.map((bucket) => bucket.timestamp),
      series: [{ name: "Created", values: bucketed.map((bucket) => bucket.count) }],
    };
  }, [ideas]);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Loading research wiki…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>Failed to load research wiki.</Text>
        <Text style={styles.muted}>{error.message}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Ideas</Text>

      <View style={styles.metricRow}>
        <MetricCard label="Total ideas" value={String(stats.total)} />
        <MetricCard label="Validated" value={String(stats.validated)} tone="positive" />
        <MetricCard label="Growing" value={String(stats.growing)} tone="warning" />
        <MetricCard label="Rejected" value={String(stats.rejected)} tone="negative" />
      </View>

      {evolutionData.timestamps.length > 0 ? (
        <View style={styles.chartSection}>
          <Text style={styles.sectionTitle}>Idea evolution</Text>
          <ThemedLineChart
            data={evolutionData}
            width={700}
            height={240}
            title="Ideas created over time"
          />
        </View>
      ) : null}

      <View style={styles.listSection}>
        <Text style={styles.sectionTitle}>All ideas</Text>
        {ideas.length === 0 ? (
          <Text style={styles.muted}>No ideas found in research wiki.</Text>
        ) : (
          ideas.map((idea) => <IdeaRow key={idea.id} idea={idea} papers={papers} claims={claims} />)
        )}
      </View>
    </ScrollView>
  );
}

function IdeaRow({
  idea,
  papers,
  claims,
}: {
  idea: ArisIdea;
  papers: { id: string; title: string }[];
  claims: ArisClaim[];
}) {
  const relatedPapers = papers.filter((paper) => idea.paperIds.includes(paper.id));
  const relatedClaims = claims.filter((claim) => claim.ideaId === idea.id);

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {idea.title}
        </Text>
        <StatusBadge status={idea.status} />
      </View>
      {idea.content ? (
        <Text style={styles.rowBody} numberOfLines={3}>
          {idea.content}
        </Text>
      ) : null}
      <View style={styles.rowMeta}>
        {relatedPapers.length > 0 ? (
          <Text style={styles.meta}>{relatedPapers.length} paper(s)</Text>
        ) : null}
        {relatedClaims.length > 0 ? (
          <Text style={styles.meta}>{relatedClaims.length} claim(s)</Text>
        ) : null}
      </View>
    </View>
  );
}

function statusBadgeStyle(status: ArisIdea["status"]) {
  switch (status) {
    case "validated":
      return styles.badgeSuccess;
    case "rejected":
      return styles.badgeDanger;
    case "growing":
      return styles.badgeWarning;
    default:
      return styles.badge;
  }
}

function StatusBadge({ status }: { status: ArisIdea["status"] }) {
  const badgeStyle = statusBadgeStyle(status);

  return (
    <View style={badgeStyle}>
      <Text style={styles.badgeText}>{status}</Text>
    </View>
  );
}

function bucketIdeasByMonth(ideas: ArisIdea[]): Array<{ timestamp: number; count: number }> {
  const map = new Map<string, number>();
  for (const idea of ideas) {
    const date = idea.createdAt ? new Date(idea.createdAt) : null;
    if (!date || Number.isNaN(date.getTime())) {
      continue;
    }
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  const sorted = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([key, count]) => {
    const [year, month] = key.split("-").map(Number);
    return { timestamp: new Date(year, month - 1).getTime(), count };
  });
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
  chartSection: {
    gap: theme.spacing[3],
  },
  sectionTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
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
    gap: theme.spacing[2],
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
  rowMeta: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
