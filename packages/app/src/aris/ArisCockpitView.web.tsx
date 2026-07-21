/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ArisIteration,
  ArisRunState,
  ArisKnowledgeGraph,
  ArisKnowledgeGraphNode,
  ArisKnowledgeGraphEdge,
} from "@getpaseo/protocol/messages";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import type { ArisEventsReadResult } from "./use-aris-events-query";
import type { ArisWikiData } from "./types";
import { ReviewView } from "./ReviewView.web";
import { KnowledgeGraphView, type GraphNodeType } from "./KnowledgeGraphView.web";
import { WorkflowGraphView } from "./views/WorkflowGraphView.web";
import { ChartKitEmpty } from "./chart-kit";
import { ARIS_KNOWLEDGE_GRAPH_NODE_COLORS } from "./charts/color-palette";
import { usePaneContext } from "@/panels/pane-context";

import type { ArisWikiEntityType } from "./use-aris-wiki-entity";

const NODE_KIND_TO_ENTITY_DIR: Record<Exclude<GraphNodeType, "default">, ArisWikiEntityType> = {
  paper: "papers",
  idea: "ideas",
  experiment: "experiments",
  claim: "claims",
  gap: "gap",
};

export interface ArisCockpitViewProps {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
  runs: ArisRunState[];
  run: ArisRunState | null;
  iterations: ArisIteration[];
  /** Research-wiki data (papers, ideas, experiments, claims, edges) — feeds the Knowledge Graph. */
  wiki: ArisWikiData | null | undefined;
  activeView?: "cockpit" | "graph" | "review";
}

function buildKnowledgeGraphFromWiki(wiki: ArisWikiData | null | undefined): ArisKnowledgeGraph {
  if (!wiki) {
    return { nodes: [], edges: [] };
  }
  const nodes: ArisKnowledgeGraphNode[] = [];
  for (const paper of wiki.papers ?? []) {
    nodes.push({ id: paper.id, label: paper.title || paper.id, group: "paper" });
  }
  for (const idea of wiki.ideas ?? []) {
    nodes.push({ id: idea.id, label: idea.title || idea.id, group: "idea" });
  }
  for (const experiment of wiki.experiments ?? []) {
    nodes.push({
      id: experiment.id,
      label: experiment.title || experiment.id,
      group: "experiment",
    });
  }
  for (const claim of wiki.claims ?? []) {
    nodes.push({ id: claim.id, label: claim.title || claim.id, group: "claim" });
  }
  const edges: ArisKnowledgeGraphEdge[] = (wiki.edges ?? []).map((edge) => ({
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
  }));

  // Materialize gap nodes from edge endpoints (e.g. "gap:G1").
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    for (const endpoint of [edge.source, edge.target]) {
      if (endpoint.startsWith("gap:") && !nodeIds.has(endpoint)) {
        nodeIds.add(endpoint);
        const gapLabel = endpoint.replace("gap:", "Gap ");
        nodes.push({ id: endpoint, label: gapLabel, group: "gap" });
      }
    }
  }

  return { nodes, edges };
}

export function ArisCockpitView({ review, wiki, activeView = "cockpit" }: ArisCockpitViewProps) {
  const { openTab } = usePaneContext();
  const wikiGraph = buildKnowledgeGraphFromWiki(wiki);

  const handleOpenDetail = useCallback(
    (entityId: string, entityType: GraphNodeType) => {
      if (entityType === "default") {
        return;
      }
      if (entityType === "gap") {
        openTab({
          kind: "aris-wiki-entity",
          entityType: "gap",
          entityId: "gap_map",
        });
        return;
      }
      openTab({
        kind: "aris-wiki-entity",
        entityType: NODE_KIND_TO_ENTITY_DIR[entityType],
        entityId,
      });
    },
    [openTab],
  );

  if (activeView === "graph") {
    return (
      <KnowledgeGraphView
        data={review ?? null}
        wikiGraph={wikiGraph}
        onOpenDetail={handleOpenDetail}
      />
    );
  }
  if (activeView === "review") {
    return <ReviewView data={review} />;
  }

  return (
    <ArisCockpitBody
      review={review}
      wikiGraph={wikiGraph}
      wiki={wiki}
      onOpenDetail={handleOpenDetail}
    />
  );
}

function ArisCockpitBody({
  review,
  wikiGraph,
  wiki,
  onOpenDetail,
}: {
  review: ArisReviewReadResult | null | undefined;
  wikiGraph: ArisKnowledgeGraph;
  wiki: ArisWikiData | null | undefined;
  onOpenDetail: (entityId: string, entityType: GraphNodeType) => void;
}) {
  const hasWiki =
    (wiki?.papers?.length ?? 0) +
      (wiki?.ideas?.length ?? 0) +
      (wiki?.experiments?.length ?? 0) +
      (wiki?.claims?.length ?? 0) >
    0;
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <CockpitHeader wiki={wiki} hasWiki={hasWiki} />
        <WorkflowGraphView />
        <KnowledgeGraphSection
          review={review}
          wikiGraph={wikiGraph}
          hasWiki={hasWiki}
          onOpenDetail={onOpenDetail}
        />
      </ScrollView>
    </View>
  );
}

type WikiStatKind = "papers" | "ideas" | "experiments" | "claims";

const WIKI_STAT_KINDS: { key: WikiStatKind; label: string; color: string }[] = [
  { key: "papers", label: "papers", color: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.paper },
  { key: "ideas", label: "ideas", color: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.idea },
  { key: "experiments", label: "experiments", color: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.experiment },
  { key: "claims", label: "claims", color: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.claim },
];

function CockpitHeader({
  wiki,
  hasWiki,
}: {
  wiki: ArisWikiData | null | undefined;
  hasWiki: boolean;
}) {
  const counts = {
    papers: wiki?.papers?.length ?? 0,
    ideas: wiki?.ideas?.length ?? 0,
    experiments: wiki?.experiments?.length ?? 0,
    claims: wiki?.claims?.length ?? 0,
  };
  const total = counts.papers + counts.ideas + counts.experiments + counts.claims;
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Text style={styles.title}>ARIS Cockpit</Text>
        {hasWiki ? <Text style={styles.headerCount}>{total} entities</Text> : null}
      </View>
      {hasWiki ? (
        <View style={styles.statRow}>
          {WIKI_STAT_KINDS.map((kind) => (
            <StatMetric
              key={kind.key}
              label={kind.label}
              count={counts[kind.key]}
              color={kind.color}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function StatMetric({ label, count, color }: { label: string; count: number; color: string }) {
  const dotStyle = useMemo(() => [styles.statDot, { backgroundColor: color }], [color]);
  return (
    <View style={styles.statMetric}>
      <View style={styles.statMetricRow}>
        <View style={dotStyle} />
        <Text style={styles.statCount}>{count}</Text>
      </View>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function KnowledgeGraphSection({
  review,
  wikiGraph,
  hasWiki,
  onOpenDetail,
}: {
  review: ArisReviewReadResult | null | undefined;
  wikiGraph: ArisKnowledgeGraph;
  hasWiki: boolean;
  onOpenDetail: (entityId: string, entityType: GraphNodeType) => void;
}) {
  return (
    <View style={styles.section}>
      {hasWiki ? (
        <KnowledgeGraphView
          data={review ?? null}
          wikiGraph={wikiGraph}
          onOpenDetail={onOpenDetail}
        />
      ) : (
        <ChartKitEmpty message="Research-wiki is empty for this run. Run /idea-discovery, /research-lit, or /run-experiment to populate the knowledge graph." />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    padding: theme.spacing[6],
    gap: theme.spacing[8],
  },
  header: {
    gap: theme.spacing[3],
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  headerCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statRow: {
    flexDirection: "row",
    gap: theme.spacing[6],
  },
  statMetric: {
    gap: theme.spacing[0],
  },
  statMetricRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statCount: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  statLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginLeft: 14,
  },
  section: {
    gap: theme.spacing[3],
  },
}));
