/** Fallback for nodes and relations outside the known kinds. */
export const ARIS_NEUTRAL_NODE_COLOR = "#64748b"; // slate-500

/**
 * Knowledge-graph node colors per entity kind: paper is a muted
 * slate (background domain), idea is the active blue (the moving piece),
 * experiment is amber (in-flight), claim is green (verified).
 */
export const ARIS_KNOWLEDGE_GRAPH_NODE_COLORS = {
  paper: "#64748b", // slate-500 - background domain
  idea: "#3b82f6", // blue-500 - active
  experiment: "#f59e0b", // amber-500 - in-flight
  claim: "#22c55e", // green-500 - verified
  problem: "#a855f7", // purple-500 - what the run is trying to close
  gap: "#94a3b8", // slate-400 - secondary entity
} as const;

export function getArisNodeKindColor(group: string | undefined): string {
  if (
    group === "paper" ||
    group === "idea" ||
    group === "experiment" ||
    group === "claim" ||
    group === "problem" ||
    group === "gap"
  ) {
    return ARIS_KNOWLEDGE_GRAPH_NODE_COLORS[group];
  }
  return ARIS_NEUTRAL_NODE_COLOR;
}

/**
 * Knowledge-graph edge colors per typed relationship, matching the
 * research-wiki SKILL spec.
 * A relation missing here renders as a neutral line with no label pill and
 * never reaches the legend, so every type the wiki can write needs an entry.
 */
export const ARIS_KNOWLEDGE_GRAPH_EDGE_COLORS = {
  extends: "#6366f1", // indigo-500 - builds on prior
  contradicts: "#ef4444", // red-500 - disagrees
  addresses: "#a855f7", // purple-500 - problem targeting
  addresses_gap: "#a855f7", // purple-500 - gap targeting (legacy wikis)
  child_of: "#c084fc", // purple-400 - sub-problem of
  inspired_by: "#06b6d4", // cyan-500 - idea source
  tested_by: "#3b82f6", // blue-500 - tested in
  supports: "#22c55e", // green-500 - confirms
  invalidates: "#f97316", // orange-500 - disproves
  supersedes: "#f59e0b", // amber-500 - replaces
  uses: "#818cf8", // indigo-400 - relies on method
  depends_on: "#8b5cf6", // violet-500 - conditional on
  refutes: "#dc2626", // red-600 - contradicts claim
} as const;

type ArisKnowledgeGraphRelation = keyof typeof ARIS_KNOWLEDGE_GRAPH_EDGE_COLORS;

const ARIS_KNOWLEDGE_GRAPH_RELATIONS = Object.keys(
  ARIS_KNOWLEDGE_GRAPH_EDGE_COLORS,
) as ArisKnowledgeGraphRelation[];

export function isArisKnowledgeGraphRelation(value: unknown): value is ArisKnowledgeGraphRelation {
  return (
    typeof value === "string" &&
    (ARIS_KNOWLEDGE_GRAPH_RELATIONS as readonly string[]).includes(value)
  );
}

export function getArisEdgeRelationColor(relation: string | undefined): string {
  if (isArisKnowledgeGraphRelation(relation)) {
    return ARIS_KNOWLEDGE_GRAPH_EDGE_COLORS[relation];
  }
  return ARIS_NEUTRAL_NODE_COLOR;
}
