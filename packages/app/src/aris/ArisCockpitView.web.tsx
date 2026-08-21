/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { useCallback } from "react";
import { View } from "react-native";
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
import { ChartKitEmpty } from "./chart-kit";
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
      <View style={styles.screen}>
        <View style={styles.content}>
          <KnowledgeGraphView
            data={review ?? null}
            wikiGraph={wikiGraph}
            onOpenDetail={handleOpenDetail}
          />
        </View>
      </View>
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
      <View style={styles.content}>
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flex: 1,
    padding: theme.spacing[6],
  },
}));
