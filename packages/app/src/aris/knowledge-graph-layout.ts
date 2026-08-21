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

export interface KnowledgeGraphNodeInput {
  id: string;
  label: string;
  group?: string;
}

export interface KnowledgeGraphLayoutInput {
  edges: KnowledgeGraphEdgeInput[];
  width: number;
  height: number;
  /**
   * Explicit node definitions. When provided, every listed node is placed even
   * if it has no incident edge, and the supplied label/group win over ids
   * derived from edge endpoints. Omit to derive nodes purely from edges.
   */
  nodes?: KnowledgeGraphNodeInput[];
}

const PAD = 60;
const REPULSION = 60000;
const ATTRACTION = 0.004;
/**
 * Pull toward the group centroid. Keep this well below the repulsion an
 * average pair sees — cohesion grows with distance while repulsion decays, so
 * a strong pull collapses every group into one stack of overlapping nodes.
 */
const GROUP_PULL = 0.006;
const DAMPING = 0.82;
const ITERATIONS = 260;
/** Repulsion falloff is capped below this distance so touching pairs get a strong, finite push. */
const REPULSION_MIN_DIST = 130;
/** Hard centre-to-centre minimum. The largest rendered node has radius 40. */
const MIN_SEPARATION = 130;
/** Per-iteration displacement cap — keeps the strong repulsion from oscillating. */
const MAX_STEP = 40;

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

interface SimState {
  n: number;
  posX: number[];
  posY: number[];
  velX: number[];
  velY: number[];
  ids: string[];
  idIndex: Map<string, number>;
  groupById: Map<string, string>;
  width: number;
  height: number;
}

/**
 * Two nodes seeded at (nearly) the same spot have no direction to push along.
 * Derive one from the pair indices so separation stays deterministic.
 */
function fallbackDirection(i: number, j: number): [number, number] {
  const angle = ((i * 97 + j * 31) % 360) * (Math.PI / 180);
  return [Math.cos(angle), Math.sin(angle)];
}

function applyRepulsion(state: SimState, fx: Float64Array, fy: Float64Array): void {
  const { n, posX, posY } = state;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = posX[i] - posX[j];
      const dy = posY[i] - posY[j];
      const dist = Math.sqrt(dx * dx + dy * dy);
      let ux: number;
      let uy: number;
      if (dist < 1e-6) {
        [ux, uy] = fallbackDirection(i, j);
      } else {
        ux = dx / dist;
        uy = dy / dist;
      }
      const falloff = Math.max(dist, REPULSION_MIN_DIST);
      const force = REPULSION / (falloff * falloff);
      const fdx = ux * force;
      const fdy = uy * force;
      fx[i] += fdx;
      fy[i] += fdy;
      fx[j] -= fdx;
      fy[j] -= fdy;
    }
  }
}

/** Edges pull toward this length rather than toward zero, so a linked pair settles apart. */
const EDGE_REST_LENGTH = 180;

function applyEdgeAttraction(
  state: SimState,
  edges: KnowledgeGraphEdgeInput[],
  fx: Float64Array,
  fy: Float64Array,
): void {
  const { posX, posY, idIndex } = state;
  for (const edge of edges) {
    const si = idIndex.get(edge.source);
    const ti = idIndex.get(edge.target);
    if (si === undefined || ti === undefined) {
      continue;
    }
    const dx = posX[ti] - posX[si];
    const dy = posY[ti] - posY[si];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) {
      continue;
    }
    const force = ATTRACTION * (dist - EDGE_REST_LENGTH);
    const fdx = (dx / dist) * force;
    const fdy = (dy / dist) * force;
    fx[si] += fdx;
    fy[si] += fdy;
    fx[ti] -= fdx;
    fy[ti] -= fdy;
  }
}

function applyGroupCohesion(state: SimState, fx: Float64Array, fy: Float64Array): void {
  const { n, posX, posY, ids, groupById, width, height } = state;
  const groupCx = new Map<string, number>();
  const groupCy = new Map<string, number>();
  const groupCount = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const g = groupById.get(ids[i]) ?? "__none__";
    groupCx.set(g, (groupCx.get(g) ?? 0) + posX[i]);
    groupCy.set(g, (groupCy.get(g) ?? 0) + posY[i]);
    groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  }
  for (const g of groupCx.keys()) {
    const c = groupCount.get(g) ?? 1;
    groupCx.set(g, (groupCx.get(g) ?? 0) / c);
    groupCy.set(g, (groupCy.get(g) ?? 0) / c);
  }
  const cx = width / 2;
  const cy = height / 2;
  for (let i = 0; i < n; i++) {
    const g = groupById.get(ids[i]) ?? "__none__";
    fx[i] += ((groupCx.get(g) ?? cx) - posX[i]) * GROUP_PULL;
    fy[i] += ((groupCy.get(g) ?? cy) - posY[i]) * GROUP_PULL;
  }
}

function integrateForces(state: SimState, fx: Float64Array, fy: Float64Array): void {
  const { n, posX, posY, velX, velY, width, height } = state;
  for (let i = 0; i < n; i++) {
    velX[i] = (velX[i] + fx[i]) * DAMPING;
    velY[i] = (velY[i] + fy[i]) * DAMPING;
    const speed = Math.sqrt(velX[i] * velX[i] + velY[i] * velY[i]);
    if (speed > MAX_STEP) {
      velX[i] = (velX[i] / speed) * MAX_STEP;
      velY[i] = (velY[i] / speed) * MAX_STEP;
    }
    posX[i] = Math.max(PAD, Math.min(width - PAD, posX[i] + velX[i]));
    posY[i] = Math.max(PAD, Math.min(height - PAD, posY[i] + velY[i]));
  }
}

/**
 * Final pass: push apart any pair still closer than MIN_SEPARATION. Forces
 * alone leave overlaps when the bounds clamp crowds nodes onto an edge, and
 * overlapping circles are the one failure a viewer notices immediately.
 */
function separateOverlaps(state: SimState): void {
  const { n, posX, posY, width, height } = state;
  const passes = 80;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = posX[i] - posX[j];
        const dy = posY[i] - posY[j];
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= MIN_SEPARATION) {
          continue;
        }
        let ux: number;
        let uy: number;
        if (dist < 1e-6) {
          [ux, uy] = fallbackDirection(i, j);
        } else {
          ux = dx / dist;
          uy = dy / dist;
        }
        const shift = (MIN_SEPARATION - dist) / 2;
        posX[i] = Math.max(PAD, Math.min(width - PAD, posX[i] + ux * shift));
        posY[i] = Math.max(PAD, Math.min(height - PAD, posY[i] + uy * shift));
        posX[j] = Math.max(PAD, Math.min(width - PAD, posX[j] - ux * shift));
        posY[j] = Math.max(PAD, Math.min(height - PAD, posY[j] - uy * shift));
        moved = true;
      }
    }
    if (!moved) {
      return;
    }
  }
}

function initSimulation(
  ids: string[],
  groupById: Map<string, string>,
  width: number,
  height: number,
): SimState {
  const n = ids.length;
  const cx = width / 2;
  const cy = height / 2;

  const groups = new Set<string>();
  for (const id of ids) {
    groups.add(groupById.get(id) ?? "__none__");
  }
  const groupList = Array.from(groups);
  const groupAngle = new Map<string, number>();
  const sectorAngle = (2 * Math.PI) / Math.max(groupList.length, 1);
  for (let i = 0; i < groupList.length; i++) {
    groupAngle.set(groupList[i], i * sectorAngle - Math.PI / 2);
  }
  const groupRadius = Math.min(width, height) * 0.35;

  const combinedSeed = ids.reduce((acc, id) => acc + hashString(id), 0);
  const rand = seededRandom(combinedSeed);
  const posX: number[] = [];
  const posY: number[] = [];
  const velX: number[] = [];
  const velY: number[] = [];
  const idIndex = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    idIndex.set(ids[i], i);
    const g = groupById.get(ids[i]) ?? "__none__";
    const angle = groupAngle.get(g) ?? 0;
    const gx = cx + groupRadius * Math.cos(angle);
    const gy = cy + groupRadius * Math.sin(angle);
    posX.push(gx + (rand() - 0.5) * groupRadius * 0.8);
    posY.push(gy + (rand() - 0.5) * groupRadius * 0.8);
    velX.push(0);
    velY.push(0);
  }

  return { n, posX, posY, velX, velY, ids, idIndex, groupById, width, height };
}

export function buildLayeredKnowledgeGraphLayout(
  input: KnowledgeGraphLayoutInput,
): KnowledgeGraphLayout {
  const { edges, nodes: explicitNodes } = input;

  const labelById = new Map<string, string>();
  const groupById = new Map<string, string>();
  const nodeIds = new Set<string>();
  for (const node of explicitNodes ?? []) {
    nodeIds.add(node.id);
    labelById.set(node.id, node.label);
    if (node.group) {
      groupById.set(node.id, node.group);
    }
  }
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  const n = nodeIds.size;
  if (n === 0) {
    return { nodes: [], edges, width: input.width, height: input.height };
  }

  // Grow the canvas with node count so every node has room to sit at least
  // MIN_SEPARATION from its neighbours. These are floors — the caller's
  // requested size wins when it is larger.
  const width = Math.max(input.width, Math.round(260 * Math.sqrt(n)));
  const height = Math.max(input.height, Math.round(200 * Math.sqrt(n)));
  const ids = Array.from(nodeIds);

  const state = initSimulation(ids, groupById, width, height);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);
    applyRepulsion(state, fx, fy);
    applyEdgeAttraction(state, edges, fx, fy);
    applyGroupCohesion(state, fx, fy);
    integrateForces(state, fx, fy);
  }

  separateOverlaps(state);

  const nodes: KnowledgeGraphNode[] = ids.map((id, i) => ({
    id,
    label: labelById.get(id) ?? id,
    group: groupById.get(id),
    x: Math.round(state.posX[i]),
    y: Math.round(state.posY[i]),
  }));

  return { nodes, edges, width, height };
}
