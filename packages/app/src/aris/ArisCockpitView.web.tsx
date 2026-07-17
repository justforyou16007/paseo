/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { ScrollView, Text, View } from "react-native";
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
import { KnowledgeGraphView } from "./KnowledgeGraphView.web";
import { WorkflowGraphView } from "./views/WorkflowGraphView.web";
import { ChartKitEmpty } from "./chart-kit";

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
  return { nodes, edges };
}

export function ArisCockpitView({ review, wiki, activeView = "cockpit" }: ArisCockpitViewProps) {
  const wikiGraph = buildKnowledgeGraphFromWiki(wiki);

  if (activeView === "graph") {
    return <KnowledgeGraphView data={review ?? null} wikiGraph={wikiGraph} />;
  }
  if (activeView === "review") {
    return <ReviewView data={review} />;
  }

  return <ArisCockpitBody review={review} wikiGraph={wikiGraph} wiki={wiki} />;
}

function ArisCockpitBody({
  review,
  wikiGraph,
  wiki,
}: {
  review: ArisReviewReadResult | null | undefined;
  wikiGraph: ArisKnowledgeGraph;
  wiki: ArisWikiData | null | undefined;
}) {
  const hasWiki =
    (wiki?.papers?.length ?? 0) +
      (wiki?.ideas?.length ?? 0) +
      (wiki?.experiments?.length ?? 0) +
      (wiki?.claims?.length ?? 0) >
    0;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }}>
      <CockpitHeader wiki={wiki} hasWiki={hasWiki} />
      <WorkflowGraphView />
      <KnowledgeGraphSection review={review} wikiGraph={wikiGraph} hasWiki={hasWiki} />
    </ScrollView>
  );
}

function CockpitHeader({
  wiki,
  hasWiki,
}: {
  wiki: ArisWikiData | null | undefined;
  hasWiki: boolean;
}) {
  const papers = wiki?.papers?.length ?? 0;
  const ideas = wiki?.ideas?.length ?? 0;
  const experiments = wiki?.experiments?.length ?? 0;
  const claims = wiki?.claims?.length ?? 0;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>ARIS Cockpit</Text>
      <Text style={{ fontSize: 14, color: "#64748b" }}>
        W1–W6 workflow status and research knowledge graph.
      </Text>
      {hasWiki ? (
        <Text style={{ fontSize: 12, color: "#64748b" }}>
          research-wiki: {papers} papers · {ideas} ideas · {experiments} experiments · {claims}{" "}
          claims
        </Text>
      ) : null}
    </View>
  );
}

function KnowledgeGraphSection({
  review,
  wikiGraph,
  hasWiki,
}: {
  review: ArisReviewReadResult | null | undefined;
  wikiGraph: ArisKnowledgeGraph;
  hasWiki: boolean;
}) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>Knowledge Graph</Text>
      {hasWiki ? (
        <KnowledgeGraphView data={review ?? null} wikiGraph={wikiGraph} />
      ) : (
        <ChartKitEmpty message="Research-wiki is empty for this run. Run /idea-discovery, /research-lit, or /run-experiment to populate the knowledge graph." />
      )}
    </View>
  );
}
