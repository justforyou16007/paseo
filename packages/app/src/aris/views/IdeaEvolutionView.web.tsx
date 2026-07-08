/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type GestureResponderEvent } from "react-native";
import { usePaneContext } from "@/panels/pane-context";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useArisWiki } from "../use-aris-wiki";
import { MetricCard } from "../charts/metric-card";
import { ChartKitEmpty } from "../chart-kit";
import {
  ARIS_CLAIM_STATUS_COLORS,
  ARIS_EXPERIMENT_STATUS_COLORS,
  ARIS_IDEA_STATUS_COLORS,
  ARIS_NEUTRAL_NODE_COLOR,
  getArisClaimStatusColor,
  getArisEdgeStrokeWidth,
  getArisExperimentStatusColor,
  getArisIdeaStatusColor,
} from "../charts/color-palette";
import {
  buildLayeredKnowledgeGraphLayout,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
} from "../knowledge-graph-layout";
import {
  KnowledgeGraphCanvas,
  type GraphCanvasEdge,
  type GraphCanvasNode,
  type GraphNodeType,
} from "../KnowledgeGraphView.web";
import type { ArisClaim, ArisExperiment, ArisIdea, ArisPaper, ArisWikiData } from "../types";

/**
 * Idea Evolution view (Worktree 4).
 *
 * Enhances the ARIS knowledge graph to focus on how ideas evolve:
 *  1. Node fill by status: idea (`ArisIdea.status`), experiment
 *     (`ArisExperiment.status`), claim (`ArisClaim.status`).
 *  2. BFS evolution path: from a selected idea, walk evolution edges
 *     (extends | inspired_by | tested_by | supports | invalidates | supersedes)
 *     and highlight the whole chain.
 *  3. Time-window slider: fade nodes whose timestamp falls outside [from, to].
 *  4. Subgraph focus: clicking any node highlights it + 1-hop neighbors.
 *
 * Everything is derived client-side from `ArisWikiData`; no new RPCs or
 * protocol fields are involved.
 */

const GRAPH_WIDTH = 760;
const GRAPH_HEIGHT = 420;
const DEFAULT_EDGE_STROKE = "#94a3b8";
const OUT_OF_WINDOW_OPACITY = 0.12;
const FOCUS_FADE_OPACITY = 0.3;
const SLIDER_HEIGHT = 32;
const THUMB_RADIUS = 8;

const EVOLUTION_RELATIONS = new Set([
  "extends",
  "inspired_by",
  "tested_by",
  "supports",
  "invalidates",
  "supersedes",
]);

interface EvolveNode {
  id: string;
  rawId: string;
  type: GraphNodeType;
  label: string;
  fill: string;
  timestamp: number | null;
  status: string;
  content: string;
  summary: string;
}

interface EvolveEdge {
  source: string;
  target: string;
  relation: string;
}

interface TimeRange {
  from: number;
  to: number;
}

const EMPTY_GRAPH: { nodes: EvolveNode[]; edges: EvolveEdge[] } = { nodes: [], edges: [] };

const IDEA_LEGEND = Object.entries(ARIS_IDEA_STATUS_COLORS);
const EXPERIMENT_LEGEND = Object.entries(ARIS_EXPERIMENT_STATUS_COLORS);
const CLAIM_LEGEND = Object.entries(ARIS_CLAIM_STATUS_COLORS);

function parseTimestamp(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function firstTimestamp(...isos: Array<string | null | undefined>): number | null {
  for (const iso of isos) {
    const parsed = parseTimestamp(iso);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildIdeaSummary(idea: ArisIdea, data: ArisWikiData): string {
  const experiments = data.experiments.filter((exp) => exp.ideaId === idea.id).length;
  const claims = data.claims.filter((claim) => claim.ideaId === idea.id).length;
  const parts: string[] = [];
  if (experiments > 0) {
    parts.push(`${experiments} experiment(s)`);
  }
  if (claims > 0) {
    parts.push(`${claims} claim(s)`);
  }
  if (idea.paperIds.length > 0) {
    parts.push(`${idea.paperIds.length} paper(s)`);
  }
  return parts.join(" · ");
}

function buildIdeaNode(idea: ArisIdea, data: ArisWikiData): EvolveNode {
  return {
    id: `idea:${idea.id}`,
    rawId: idea.id,
    type: "idea",
    label: idea.title || idea.id,
    fill: getArisIdeaStatusColor(idea.status),
    timestamp: parseTimestamp(idea.createdAt),
    status: idea.status,
    content: idea.content,
    summary: buildIdeaSummary(idea, data),
  };
}

function buildExperimentNode(exp: ArisExperiment): EvolveNode {
  return {
    id: `exp:${exp.id}`,
    rawId: exp.id,
    type: "experiment",
    label: exp.title || exp.id,
    fill: getArisExperimentStatusColor(exp.status),
    timestamp: parseTimestamp(exp.startedAt) ?? parseTimestamp(exp.completedAt),
    status: exp.status,
    content: exp.content,
    summary: "",
  };
}

function buildClaimNode(claim: ArisClaim, data: ArisWikiData): EvolveNode {
  const linkedExperiment = data.experiments.find((exp) => exp.id === claim.experimentId);
  const linkedIdea = data.ideas.find((idea) => idea.id === claim.ideaId);
  return {
    id: `claim:${claim.id}`,
    rawId: claim.id,
    type: "claim",
    label: claim.title || claim.id,
    fill: getArisClaimStatusColor(claim.status),
    timestamp: firstTimestamp(
      linkedExperiment?.startedAt,
      linkedExperiment?.completedAt,
      linkedIdea?.createdAt,
    ),
    status: claim.status,
    content: claim.content,
    summary: claim.confidence != null ? `confidence ${claim.confidence}` : "",
  };
}

function buildPaperNode(paper: ArisPaper): EvolveNode {
  return {
    id: `paper:${paper.id}`,
    rawId: paper.id,
    type: "paper",
    label: paper.title || paper.id,
    fill: ARIS_NEUTRAL_NODE_COLOR,
    timestamp: paper.year != null ? new Date(paper.year, 0, 1).getTime() : null,
    status: "",
    content: paper.content,
    summary: paper.authors.length > 0 ? paper.authors.join(", ") : "",
  };
}

function addEdge(
  edgeMap: Map<string, EvolveEdge>,
  nodeByRaw: Map<string, EvolveNode>,
  sourceRaw: string,
  targetRaw: string,
  relation: string,
) {
  const source = nodeByRaw.get(sourceRaw);
  const target = nodeByRaw.get(targetRaw);
  if (!source || !target || source.id === target.id) {
    return;
  }
  const key = pairKey(source.id, target.id);
  if (edgeMap.has(key)) {
    return;
  }
  edgeMap.set(key, { source: source.id, target: target.id, relation });
}

function addDerivedEdges(
  data: ArisWikiData,
  add: (sourceRaw: string, targetRaw: string, relation: string) => void,
) {
  for (const exp of data.experiments) {
    if (exp.ideaId) {
      add(exp.ideaId, exp.id, "tested_by");
    }
  }
  for (const claim of data.claims) {
    if (claim.experimentId) {
      add(claim.experimentId, claim.id, "supports");
    }
    if (claim.ideaId) {
      add(claim.ideaId, claim.id, "supports");
    }
  }
  for (const idea of data.ideas) {
    for (const relatedId of idea.relatedIdeaIds) {
      add(idea.id, relatedId, "related");
    }
    for (const paperId of idea.paperIds) {
      add(idea.id, paperId, "cites");
    }
  }
}

function buildEvolutionGraph(data: ArisWikiData): { nodes: EvolveNode[]; edges: EvolveEdge[] } {
  const nodes: EvolveNode[] = [];
  const nodeByRaw = new Map<string, EvolveNode>();
  const register = (node: EvolveNode) => {
    nodes.push(node);
    nodeByRaw.set(node.rawId, node);
  };
  for (const idea of data.ideas) {
    register(buildIdeaNode(idea, data));
  }
  for (const exp of data.experiments) {
    register(buildExperimentNode(exp));
  }
  for (const claim of data.claims) {
    register(buildClaimNode(claim, data));
  }
  for (const paper of data.papers) {
    register(buildPaperNode(paper));
  }

  const edgeMap = new Map<string, EvolveEdge>();
  const add = (sourceRaw: string, targetRaw: string, relation: string) => {
    addEdge(edgeMap, nodeByRaw, sourceRaw, targetRaw, relation);
  };
  for (const edge of data.edges) {
    add(edge.source, edge.target, edge.relation);
  }
  addDerivedEdges(data, add);

  return { nodes, edges: Array.from(edgeMap.values()) };
}

function computeRange(nodes: EvolveNode[]): TimeRange | null {
  let min = Infinity;
  for (const node of nodes) {
    if (node.timestamp !== null && node.timestamp < min) {
      min = node.timestamp;
    }
  }
  if (min === Infinity) {
    return null;
  }
  return { from: min, to: Date.now() };
}

function computeActiveIds(nodes: EvolveNode[], window: TimeRange | null): Set<string> {
  const active = new Set<string>();
  for (const node of nodes) {
    const inWindow =
      window === null ||
      node.timestamp === null ||
      (node.timestamp >= window.from && node.timestamp <= window.to);
    if (inWindow) {
      active.add(node.id);
    }
  }
  return active;
}

function evolutionReachable(
  startId: string,
  edges: EvolveEdge[],
  activeIds: Set<string>,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!EVOLUTION_RELATIONS.has(edge.relation.toLowerCase())) {
      continue;
    }
    if (!activeIds.has(edge.source) || !activeIds.has(edge.target)) {
      continue;
    }
    pushAdjacency(adjacency, edge.source, edge.target);
    pushAdjacency(adjacency, edge.target, edge.source);
  }

  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

function pushAdjacency(adjacency: Map<string, string[]>, from: string, to: string) {
  const list = adjacency.get(from);
  if (list) {
    list.push(to);
  } else {
    adjacency.set(from, [to]);
  }
}

function oneHopNeighbors(
  startId: string,
  edges: EvolveEdge[],
  activeIds: Set<string>,
): Set<string> {
  const neighbors = new Set<string>([startId]);
  for (const edge of edges) {
    if (edge.source === startId && activeIds.has(edge.target)) {
      neighbors.add(edge.target);
    }
    if (edge.target === startId && activeIds.has(edge.source)) {
      neighbors.add(edge.source);
    }
  }
  return neighbors;
}

function nodeOpacity(inWindow: boolean, inHighlight: boolean, selected: boolean): number {
  if (selected) {
    return 1;
  }
  if (!inWindow) {
    return OUT_OF_WINDOW_OPACITY;
  }
  return inHighlight ? 1 : FOCUS_FADE_OPACITY;
}

function edgeOpacity(bothActive: boolean, bothHighlight: boolean): number {
  if (!bothActive) {
    return 0.1;
  }
  return bothHighlight ? 1 : 0.2;
}

function experimentStatusFor(source?: EvolveNode, target?: EvolveNode): string | undefined {
  if (source?.type === "experiment") {
    return source.status;
  }
  if (target?.type === "experiment") {
    return target.status;
  }
  return undefined;
}

function buildCanvasNodes(
  layoutNodes: KnowledgeGraphNode[],
  nodeById: Map<string, EvolveNode>,
  activeIds: Set<string>,
  highlightSet: Set<string> | null,
  selectedId: string | null,
): GraphCanvasNode[] {
  return layoutNodes.map((node) => {
    const evolve = nodeById.get(node.id);
    const inWindow = activeIds.has(node.id);
    const inHighlight = !highlightSet || highlightSet.has(node.id);
    return {
      id: node.id,
      label: node.label,
      type: evolve?.type ?? "default",
      x: node.x,
      y: node.y,
      fill: evolve?.fill ?? ARIS_NEUTRAL_NODE_COLOR,
      opacity: nodeOpacity(inWindow, inHighlight, node.id === selectedId),
      selected: node.id === selectedId,
    };
  });
}

function buildCanvasEdges(
  layoutEdges: KnowledgeGraphEdge[],
  nodeById: Map<string, EvolveNode>,
  activeIds: Set<string>,
  highlightSet: Set<string> | null,
  evolutionMode: boolean,
): GraphCanvasEdge[] {
  return layoutEdges.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const baseWidth = getArisEdgeStrokeWidth(experimentStatusFor(source, target));
    const bothActive = activeIds.has(edge.source) && activeIds.has(edge.target);
    const bothHighlight =
      !highlightSet || (highlightSet.has(edge.source) && highlightSet.has(edge.target));
    const isEvolutionEdge = EVOLUTION_RELATIONS.has((edge.relation ?? "").toLowerCase());
    const onEvolutionPath = evolutionMode && bothHighlight && isEvolutionEdge;
    return {
      source: edge.source,
      target: edge.target,
      stroke: onEvolutionPath ? "#3b82f6" : DEFAULT_EDGE_STROKE,
      strokeWidth: onEvolutionPath ? Math.max(baseWidth, 3) : baseWidth,
      opacity: edgeOpacity(bothActive, bothHighlight),
    };
  });
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRange(window: TimeRange | null): string {
  if (!window) {
    return "all time";
  }
  return `${formatDate(window.from)} -> ${formatDate(window.to)}`;
}

function focusHint(selected: EvolveNode | null, evolutionMode: boolean): string {
  if (!selected) {
    return "Click a node to focus its neighbors. Select an idea to trace its evolution.";
  }
  if (evolutionMode) {
    return "Showing the full evolution chain from the selected idea.";
  }
  return "1-hop focus. Select an idea and trace its evolution path.";
}

function shouldClaimResponder(): boolean {
  return true;
}

interface TimeWindowSliderProps {
  min: number;
  max: number;
  from: number;
  to: number;
  width: number;
  disabled?: boolean;
  onChange: (from: number, to: number) => void;
}

function TimeWindowSlider({
  min,
  max,
  from,
  to,
  width,
  disabled,
  onChange,
}: TimeWindowSliderProps) {
  const draggingRef = useRef<"from" | "to" | null>(null);
  const fromRef = useRef(from);
  const toRef = useRef(to);
  fromRef.current = from;
  toRef.current = to;

  const range = max - min;

  const xToValue = useCallback(
    (x: number) => {
      if (range <= 0) {
        return min;
      }
      const ratio = Math.max(0, Math.min(1, x / width));
      return Math.round(min + ratio * range);
    },
    [min, range, width],
  );

  const applyDrag = useCallback(
    (x: number) => {
      const thumb = draggingRef.current;
      if (!thumb) {
        return;
      }
      const value = xToValue(x);
      const gap = Math.max(range * 0.02, 1);
      if (thumb === "from") {
        onChange(Math.min(value, toRef.current - gap), toRef.current);
      } else {
        onChange(fromRef.current, Math.max(value, fromRef.current + gap));
      }
    },
    [xToValue, range, onChange],
  );

  const handleGrant = useCallback(
    (event: GestureResponderEvent) => {
      if (range <= 0) {
        return;
      }
      const x = event.nativeEvent.locationX;
      const fromX = ((fromRef.current - min) / range) * width;
      const toX = ((toRef.current - min) / range) * width;
      draggingRef.current = Math.abs(x - fromX) <= Math.abs(x - toX) ? "from" : "to";
      applyDrag(x);
    },
    [range, min, width, applyDrag],
  );

  const handleMove = useCallback(
    (event: GestureResponderEvent) => {
      applyDrag(event.nativeEvent.locationX);
    },
    [applyDrag],
  );

  const handleRelease = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const fromX = range > 0 ? ((from - min) / range) * width : 0;
  const toX = range > 0 ? ((to - min) / range) * width : width;
  const thumbSize = THUMB_RADIUS * 2;

  if (disabled) {
    return (
      <View style={{ width, height: SLIDER_HEIGHT, justifyContent: "center" }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: "#e2e8f0" }} />
        <Text style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
          No timestamps to filter.
        </Text>
      </View>
    );
  }

  return (
    <View
      onStartShouldSetResponder={shouldClaimResponder}
      onResponderGrant={handleGrant}
      onResponderMove={handleMove}
      onResponderRelease={handleRelease}
      onResponderTerminate={handleRelease}
      style={{ width, height: SLIDER_HEIGHT, justifyContent: "center" }}
    >
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: 6,
          borderRadius: 3,
          backgroundColor: "#e2e8f0",
        }}
      />
      <View
        style={{
          position: "absolute",
          left: fromX,
          width: Math.max(toX - fromX, 0),
          height: 6,
          borderRadius: 3,
          backgroundColor: "#3b82f6",
        }}
      />
      <View
        style={{
          position: "absolute",
          left: fromX - THUMB_RADIUS,
          width: thumbSize,
          height: thumbSize,
          borderRadius: THUMB_RADIUS,
          backgroundColor: "#3b82f6",
          borderWidth: 2,
          borderColor: "#ffffff",
        }}
      />
      <View
        style={{
          position: "absolute",
          left: toX - THUMB_RADIUS,
          width: thumbSize,
          height: thumbSize,
          borderRadius: THUMB_RADIUS,
          backgroundColor: "#3b82f6",
          borderWidth: 2,
          borderColor: "#ffffff",
        }}
      />
    </View>
  );
}

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ fontSize: 11, color: "#475569" }}>{label}</Text>
    </View>
  );
}

function LegendRow({
  title,
  entries,
}: {
  title: string;
  entries: ReadonlyArray<[string, string]>;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Text style={{ fontSize: 11, color: "#64748b", minWidth: 92 }}>{title}</Text>
      {entries.map(([label, color]) => (
        <Swatch key={`${title}-${label}`} label={label} color={color} />
      ))}
    </View>
  );
}

function EvolutionLegend() {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, color: "#64748b" }}>
        Shapes: circle = idea, square = experiment, diamond = claim, small circle = paper
      </Text>
      <LegendRow title="Idea status" entries={IDEA_LEGEND} />
      <LegendRow title="Experiment" entries={EXPERIMENT_LEGEND} />
      <LegendRow title="Claim status" entries={CLAIM_LEGEND} />
    </View>
  );
}

function SelectedNodeDetail({ node, onClear }: { node: EvolveNode | null; onClear: () => void }) {
  if (!node) {
    return null;
  }
  return (
    <View
      style={{
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#e2e8f0",
        backgroundColor: "#f8fafc",
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: "#0f172a", flex: 1 }}>
          {node.label}
        </Text>
        <Pressable onPress={onClear}>
          <Text style={{ fontSize: 12, color: "#3b82f6" }}>Clear</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
            backgroundColor: node.fill,
          }}
        >
          <Text style={{ fontSize: 10, color: "#ffffff", fontWeight: "600" }}>{node.type}</Text>
        </View>
        {node.status ? <Text style={{ fontSize: 11, color: "#64748b" }}>{node.status}</Text> : null}
      </View>
      {node.content ? (
        <Text style={{ fontSize: 12, color: "#475569" }} numberOfLines={4}>
          {node.content}
        </Text>
      ) : null}
      {node.summary ? <Text style={{ fontSize: 11, color: "#94a3b8" }}>{node.summary}</Text> : null}
    </View>
  );
}

function GraphHeader({ data, edgeCount }: { data: ArisWikiData; edgeCount: number }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 20, fontWeight: "700", color: "#0f172a" }}>Idea Evolution</Text>
      <Text style={{ fontSize: 12, color: "#64748b" }}>
        Trace how ideas extend, get tested, and resolve into claims over time.
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <MetricCard label="Ideas" value={String(data.ideas.length)} />
        <MetricCard label="Experiments" value={String(data.experiments.length)} />
        <MetricCard label="Claims" value={String(data.claims.length)} />
        <MetricCard label="Papers" value={String(data.papers.length)} />
        <MetricCard label="Edges" value={String(edgeCount)} />
      </View>
    </View>
  );
}

interface GraphControlsProps {
  tsRange: TimeRange | null;
  effectiveWindow: TimeRange | null;
  isEvolutionEligible: boolean;
  evolutionMode: boolean;
  hasSelection: boolean;
  selectedNode: EvolveNode | null;
  onWindowChange: (from: number, to: number) => void;
  onToggleEvolution: () => void;
  onClear: () => void;
}

function GraphControls({
  tsRange,
  effectiveWindow,
  isEvolutionEligible,
  evolutionMode,
  hasSelection,
  selectedNode,
  onWindowChange,
  onToggleEvolution,
  onClear,
}: GraphControlsProps) {
  const min = tsRange?.from ?? 0;
  const max = tsRange?.to ?? 1;
  const from = effectiveWindow?.from ?? 0;
  const to = effectiveWindow?.to ?? 1;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: "#334155" }}>Time window</Text>
        <Text style={{ fontSize: 11, color: "#64748b" }}>{formatRange(effectiveWindow)}</Text>
      </View>
      <TimeWindowSlider
        min={min}
        max={max}
        from={from}
        to={to}
        width={GRAPH_WIDTH}
        disabled={tsRange === null}
        onChange={onWindowChange}
      />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        {isEvolutionEligible ? (
          <Pressable
            onPress={onToggleEvolution}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: "#3b82f6",
              backgroundColor: evolutionMode ? "#3b82f6" : "#ffffff",
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: "600",
                color: evolutionMode ? "#ffffff" : "#3b82f6",
              }}
            >
              {evolutionMode ? "Evolution path on" : "Trace evolution path"}
            </Text>
          </Pressable>
        ) : null}
        {hasSelection ? (
          <Pressable
            onPress={onClear}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: "#cbd5e1",
              backgroundColor: "#ffffff",
            }}
          >
            <Text style={{ fontSize: 12, color: "#64748b" }}>Clear selection</Text>
          </Pressable>
        ) : null}
        <Text style={{ fontSize: 11, color: "#94a3b8", flex: 1 }}>
          {focusHint(selectedNode, evolutionMode)}
        </Text>
      </View>
    </View>
  );
}

export function IdeaEvolutionView() {
  const { serverId, workspaceId } = usePaneContext();
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const { data, isLoading, error } = useArisWiki(serverId, cwd);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evolutionMode, setEvolutionMode] = useState(false);
  const [windowOverride, setWindowOverride] = useState<TimeRange | null>(null);

  const graph = useMemo(() => (data ? buildEvolutionGraph(data) : EMPTY_GRAPH), [data]);
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const tsRange = useMemo(() => computeRange(graph.nodes), [graph.nodes]);

  useEffect(() => {
    setWindowOverride(null);
  }, [graph.nodes]);

  const effectiveWindow = windowOverride ?? tsRange;
  const activeIds = useMemo(
    () => computeActiveIds(graph.nodes, effectiveWindow),
    [graph.nodes, effectiveWindow],
  );
  const layout = useMemo(
    () =>
      buildLayeredKnowledgeGraphLayout({
        edges: graph.edges,
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
        nodes: graph.nodes.map((node) => ({ id: node.id, label: node.label, group: node.type })),
      }),
    [graph.edges, graph.nodes],
  );

  const selectedNode = selectedId ? (nodeById.get(selectedId) ?? null) : null;
  const isEvolutionEligible = selectedNode?.type === "idea";
  const effectiveEvolutionMode = evolutionMode && Boolean(isEvolutionEligible);

  const highlightSet = useMemo(() => {
    if (!selectedId) {
      return null;
    }
    if (effectiveEvolutionMode) {
      return evolutionReachable(selectedId, graph.edges, activeIds);
    }
    return oneHopNeighbors(selectedId, graph.edges, activeIds);
  }, [selectedId, effectiveEvolutionMode, graph.edges, activeIds]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);
  const handleClear = useCallback(() => {
    setSelectedId(null);
    setEvolutionMode(false);
  }, []);
  const handleToggleEvolution = useCallback(() => {
    setEvolutionMode((prev) => !prev);
  }, []);
  const handleWindowChange = useCallback((from: number, to: number) => {
    setWindowOverride({ from, to });
  }, []);

  const canvasNodes = useMemo(
    () => buildCanvasNodes(layout.nodes, nodeById, activeIds, highlightSet, selectedId),
    [layout.nodes, nodeById, activeIds, highlightSet, selectedId],
  );
  const canvasEdges = useMemo(
    () => buildCanvasEdges(layout.edges, nodeById, activeIds, highlightSet, effectiveEvolutionMode),
    [layout.edges, nodeById, activeIds, highlightSet, effectiveEvolutionMode],
  );

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ fontSize: 14, color: "#94a3b8" }}>Loading research wiki…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 4 }}
      >
        <Text style={{ fontSize: 14, fontWeight: "600", color: "#ef4444" }}>
          Failed to load research wiki.
        </Text>
        <Text style={{ fontSize: 12, color: "#94a3b8" }}>{error.message}</Text>
      </View>
    );
  }

  if (!data) {
    return <ChartKitEmpty message="No research wiki data available." />;
  }

  if (graph.nodes.length === 0) {
    return <ChartKitEmpty message="The research wiki has no ideas, experiments, or claims yet." />;
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <GraphHeader data={data} edgeCount={graph.edges.length} />
      <EvolutionLegend />
      <GraphControls
        tsRange={tsRange}
        effectiveWindow={effectiveWindow}
        isEvolutionEligible={Boolean(isEvolutionEligible)}
        evolutionMode={effectiveEvolutionMode}
        hasSelection={selectedId !== null}
        selectedNode={selectedNode}
        onWindowChange={handleWindowChange}
        onToggleEvolution={handleToggleEvolution}
        onClear={handleClear}
      />
      <KnowledgeGraphCanvas
        nodes={canvasNodes}
        edges={canvasEdges}
        width={GRAPH_WIDTH}
        height={GRAPH_HEIGHT}
        onSelectNode={handleSelect}
      />
      <SelectedNodeDetail node={selectedNode} onClear={handleClear} />
      <Text style={{ fontSize: 12, color: "#64748b" }}>
        {graph.nodes.length} nodes · {graph.edges.length} edges
      </Text>
    </ScrollView>
  );
}

export default IdeaEvolutionView;
