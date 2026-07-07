export interface KnowledgeGraphNode {
  id: string;
  label: string;
  group?: string;
  x: number;
  y: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relation?: string;
  weight?: number;
}

export interface KnowledgeGraphLayout {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  width: number;
  height: number;
}

export interface KnowledgeGraphEdgeInput {
  source: string;
  target: string;
  relation?: string;
  weight?: number;
}

export function buildLayeredKnowledgeGraphLayout(input: {
  edges: KnowledgeGraphEdgeInput[];
  width: number;
  height: number;
}): KnowledgeGraphLayout {
  const { edges, width, height } = input;
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const layers = groupNodesIntoLayers(Array.from(nodeIds), edges);
  const nodes: KnowledgeGraphNode[] = [];
  const layerHeight = layers.length > 1 ? height / (layers.length - 1) : height / 2;

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    const layerWidth = layer.length > 1 ? width / (layer.length - 1) : width / 2;
    for (let nodeIndex = 0; nodeIndex < layer.length; nodeIndex += 1) {
      const id = layer[nodeIndex];
      const x = layer.length > 1 ? nodeIndex * layerWidth + 40 : width / 2;
      const y = layerIndex * layerHeight + 40;
      nodes.push({
        id,
        label: id,
        x: Math.min(Math.max(x, 40), width - 40),
        y: Math.min(Math.max(y, 40), height - 40),
      });
    }
  }

  return {
    nodes,
    edges,
    width,
    height,
  };
}

function groupNodesIntoLayers(nodeIds: string[], edges: KnowledgeGraphEdgeInput[]): string[][] {
  const remaining = new Set(nodeIds);
  const inEdges = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!inEdges.has(edge.target)) {
      inEdges.set(edge.target, new Set());
    }
    inEdges.get(edge.target)?.add(edge.source);
  }

  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const node of remaining) {
      const prerequisites = inEdges.get(node) ?? new Set();
      const hasUnprocessedPrerequisite = Array.from(prerequisites).some((p) => remaining.has(p));
      if (!hasUnprocessedPrerequisite) {
        layer.push(node);
      }
    }
    if (layer.length === 0) {
      layer.push(remaining.values().next().value as string);
    }
    for (const node of layer) {
      remaining.delete(node);
    }
    layers.push(layer);
  }
  return layers;
}
