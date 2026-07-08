import { describe, expect, test } from "vitest";
import { buildLayeredKnowledgeGraphLayout } from "./knowledge-graph-layout";

describe("buildLayeredKnowledgeGraphLayout", () => {
  test("positions nodes from edges in layered layout", () => {
    const layout = buildLayeredKnowledgeGraphLayout({
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ],
      width: 400,
      height: 300,
    });

    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    const nodeIds = new Set(layout.nodes.map((n) => n.id));
    expect(nodeIds).toEqual(new Set(["A", "B", "C"]));
  });

  test("returns empty layout for empty edges", () => {
    const layout = buildLayeredKnowledgeGraphLayout({
      edges: [],
      width: 400,
      height: 300,
    });

    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
  });

  test("keeps node coordinates within bounds", () => {
    const layout = buildLayeredKnowledgeGraphLayout({
      edges: [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "C", target: "D" },
      ],
      width: 800,
      height: 400,
    });

    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(40);
      expect(node.x).toBeLessThanOrEqual(760);
      expect(node.y).toBeGreaterThanOrEqual(40);
      expect(node.y).toBeLessThanOrEqual(360);
    }
  });

  test("uses explicit node labels and groups when provided", () => {
    const layout = buildLayeredKnowledgeGraphLayout({
      edges: [{ source: "i1", target: "i2", relation: "extends" }],
      width: 400,
      height: 300,
      nodes: [
        { id: "i1", label: "Idea A", group: "idea" },
        { id: "i2", label: "Idea B", group: "idea" },
      ],
    });

    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(byId.get("i1")?.label).toBe("Idea A");
    expect(byId.get("i1")?.group).toBe("idea");
    expect(byId.get("i2")?.label).toBe("Idea B");
  });

  test("places isolated explicit nodes that have no incident edges", () => {
    const layout = buildLayeredKnowledgeGraphLayout({
      edges: [{ source: "i1", target: "i2" }],
      width: 400,
      height: 300,
      nodes: [
        { id: "i1", label: "Idea A" },
        { id: "i2", label: "Idea B" },
        { id: "iso", label: "Lone paper" },
      ],
    });

    const ids = new Set(layout.nodes.map((n) => n.id));
    expect(ids.has("iso")).toBe(true);
    expect(layout.nodes).toHaveLength(3);
  });
});
