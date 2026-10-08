import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ArisKnowledgeGraph,
  ArisKnowledgeGraphNode,
  ArisKnowledgeGraphEdge,
} from "@getpaseo/protocol/messages";
import type { ArisWikiData } from "./types";
import { KnowledgeGraphView, type GraphNodeType } from "./KnowledgeGraphView.web";
import { ChartKitEmpty } from "./chart-kit";
import { usePaneContext } from "@/panels/pane-context";
import type { ArisWikiEntityType } from "./use-aris-wiki-entity";

const NODE_KIND_TO_ENTITY_DIR: Record<Exclude<GraphNodeType, "default">, ArisWikiEntityType> = {
  paper: "papers",
  idea: "ideas",
  experiment: "experiments",
  claim: "claims",
  problem: "problems",
  gap: "gap",
};

export interface ArisGraphViewProps {
  wiki: ArisWikiData;
}

/**
 * One node per wiki entity. Every kind is shaped the same way — an id and a
 * title that falls back to the id — so they share one loop instead of five
 * near-identical ones.
 */
function pushEntityNodes(
  nodes: ArisKnowledgeGraphNode[],
  entities: { id: string; title: string }[] | undefined,
  group: string,
): void {
  for (const entity of entities ?? []) {
    nodes.push({ id: entity.id, label: entity.title || entity.id, group });
  }
}

function buildKnowledgeGraphFromWiki(wiki: ArisWikiData): Required<ArisKnowledgeGraph> {
  const nodes: ArisKnowledgeGraphNode[] = [];
  pushEntityNodes(nodes, wiki.papers, "paper");
  pushEntityNodes(nodes, wiki.ideas, "idea");
  pushEntityNodes(nodes, wiki.experiments, "experiment");
  pushEntityNodes(nodes, wiki.claims, "claim");
  pushEntityNodes(nodes, wiki.problems, "problem");
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

/** The research wiki as a knowledge graph; clicking a node opens its page. */
export function ArisGraphView({ wiki }: ArisGraphViewProps) {
  const { openTab } = usePaneContext();
  const wikiGraph = useMemo(() => buildKnowledgeGraphFromWiki(wiki), [wiki]);

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

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        {wikiGraph.nodes.length > 0 ? (
          <KnowledgeGraphView wikiGraph={wikiGraph} onOpenDetail={handleOpenDetail} />
        ) : (
          <ChartKitEmpty message="The research wiki is empty. Agents add papers, ideas, experiments and claims with node .aris/dist/tools/research-wiki.js." />
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
