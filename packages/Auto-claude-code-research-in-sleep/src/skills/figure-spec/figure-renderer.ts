#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createCli, runCli } from "../../lib/cli.js";

// ============================================================
// Constants & Defaults
// ============================================================

const ARROW_SIZE = 8;
const SELF_LOOP_RADIUS = 25;

const ALLOWED_SHAPES = new Set(["rect", "rounded", "circle", "diamond", "ellipse"]);
const ALLOWED_STYLES = new Set(["solid", "dashed", "dotted"]);
const ALLOWED_ANCHORS = new Set(["start", "middle", "end"]);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_STYLE = {
  font_family: "Arial, Helvetica, sans-serif",
  font_size: 14,
  bg_color: "#FFFFFF",
  palette: [
    "#2563EB",
    "#10B981",
    "#7C3AED",
    "#EA580C",
    "#C62828",
    "#0D47A1",
    "#1B5E20",
    "#4A148C",
    "#BF360C",
    "#37474F",
  ],
};

const DEFAULT_NODE = {
  width: 120,
  height: 50,
  shape: "rounded",
  text_color: "#333333",
  font_size: null as number | null,
};

const DEFAULT_EDGE = {
  style: "solid",
  color: "#555555",
  thickness: 2,
  curve: false,
};

// ============================================================
// Types
// ============================================================

interface FigureSpec {
  title?: string;
  canvas?: { width?: number; height?: number };
  style?: {
    font_family?: string;
    font_size?: number;
    bg_color?: string;
    palette?: string[];
  };
  nodes?: NodeSpec[];
  edges?: EdgeSpec[];
  groups?: GroupSpec[];
  labels?: LabelSpec[];
}

interface NodeSpec {
  id: string;
  label?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  shape?: string;
  fill?: string;
  stroke?: string;
  text_color?: string;
  font_size?: number;
  sublabel?: string;
}

interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  style?: string;
  color?: string;
  thickness?: number;
  curve?: boolean;
}

interface GroupSpec {
  id?: string;
  label?: string;
  node_ids?: string[];
  fill?: string;
  stroke?: string;
  padding?: number;
}

interface LabelSpec {
  text?: string;
  x?: number;
  y?: number;
  font_size?: number;
  color?: string;
  anchor?: string;
}

interface ResolvedNode {
  id: string;
  label: string;
  sublabel?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: string;
  fill: string;
  stroke: string;
  text_color: string;
  font_size: number | null;
}

// ============================================================
// Sanitization
// ============================================================

function sanitizeColor(val: unknown, fallback = "#555555"): string {
  if (typeof val === "string" && HEX_COLOR_RE.test(val)) return val;
  return fallback;
}

function sanitizeText(val: unknown): string {
  if (typeof val !== "string") return String(val);
  let s = val;
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  s = s.replace(/[\ud800-\udfff﷐-﷯￾￿]/g, "");
  return s;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x2e80) {
      width += fontSize * 1.0;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width;
}

// ============================================================
// Color Utilities
// ============================================================

function lightenColor(hexColor: string, factor = 0.85): string {
  const hex = hexColor.replace(/^#/, "");
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  r = Math.min(255, Math.floor(r + (255 - r) * factor));
  g = Math.min(255, Math.floor(g + (255 - g) * factor));
  b = Math.min(255, Math.floor(b + (255 - b) * factor));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ============================================================
// Geometry: Shape-Aware Edge Clipping
// ============================================================

function clipToShape(
  cx: number,
  cy: number,
  targetX: number,
  targetY: number,
  w: number,
  h: number,
  shape: string,
): [number, number] {
  const dx = targetX - cx;
  const dy = targetY - cy;
  if (dx === 0 && dy === 0) return [cx, cy - h / 2];

  if (shape === "circle") {
    const r = Math.max(w, h) / 2;
    const angle = Math.atan2(dy, dx);
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  }

  if (shape === "ellipse") {
    const a = w / 2;
    const b = h / 2;
    const angle = Math.atan2(dy, dx);
    return [cx + a * Math.cos(angle), cy + b * Math.sin(angle)];
  }

  if (shape === "diamond") {
    const a = w / 2;
    const b = h / 2;
    const angle = Math.atan2(dy, dx);
    const cosA = Math.abs(Math.cos(angle));
    const sinA = Math.abs(Math.sin(angle));
    if (cosA * b + sinA * a === 0) return [cx, cy];
    const scale = (a * b) / (cosA * b + sinA * a);
    return [cx + scale * Math.cos(angle), cy + scale * Math.sin(angle)];
  }

  // Rectangle clipping
  const a = w / 2;
  const b = h / 2;
  let scale: number;
  if (Math.abs(dx) * b > Math.abs(dy) * a) {
    scale = a / Math.abs(dx);
  } else {
    scale = b / Math.abs(dy);
  }
  return [cx + dx * scale, cy + dy * scale];
}

// ============================================================
// Validation
// ============================================================

function isNumber(val: unknown): val is number {
  return typeof val === "number" && typeof val !== "boolean";
}

function validateSpec(spec: unknown): string[] {
  const issues: string[] = [];

  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return [`CRITICAL: spec must be a JSON object, got ${typeof spec}`];
  }

  const s = spec as Record<string, unknown>;

  const canvas = s.canvas ?? {};
  if (typeof canvas !== "object" || canvas === null || Array.isArray(canvas)) {
    issues.push("CRITICAL: 'canvas' must be a dict");
  }
  if (typeof (s.style ?? {}) !== "object" || Array.isArray(s.style)) {
    issues.push("CRITICAL: 'style' must be a dict");
  }
  if (!Array.isArray(s.nodes ?? [])) {
    issues.push("CRITICAL: 'nodes' must be a list");
  }
  if (!Array.isArray(s.edges ?? [])) {
    issues.push("CRITICAL: 'edges' must be a list");
  }
  if (!Array.isArray(s.groups ?? [])) {
    issues.push("CRITICAL: 'groups' must be a list");
  }
  if (!Array.isArray(s.labels ?? [])) {
    issues.push("CRITICAL: 'labels' must be a list");
  }

  if (issues.some((i) => i.startsWith("CRITICAL: '"))) return issues;

  const canvasObj = (s.canvas ?? {}) as Record<string, unknown>;
  for (const dim of ["width", "height"] as const) {
    const val = canvasObj[dim];
    if (val !== undefined && val !== null) {
      if (typeof val === "boolean" || !isNumber(val)) {
        issues.push(`CRITICAL: canvas.${dim} must be a number`);
      } else if (val <= 0) {
        issues.push(`CRITICAL: canvas.${dim} must be positive`);
      }
    }
  }

  const st = (s.style ?? {}) as Record<string, unknown>;
  const fsVal = st.font_size;
  if (
    fsVal !== undefined &&
    fsVal !== null &&
    (typeof fsVal === "boolean" || !isNumber(fsVal) || fsVal <= 0)
  ) {
    issues.push("CRITICAL: style.font_size must be a positive number");
  }
  const pal = st.palette;
  if (pal !== undefined && pal !== null) {
    if (!Array.isArray(pal) || pal.length === 0) {
      issues.push("CRITICAL: style.palette must be a non-empty list of hex colors");
    } else {
      for (let pi = 0; pi < pal.length; pi++) {
        const pc = pal[pi];
        if (typeof pc !== "string" || !HEX_COLOR_RE.test(pc)) {
          issues.push(`CRITICAL: style.palette[${pi}] '${pc}' is not a valid hex color (#RRGGBB)`);
        }
      }
    }
  }

  const nodes = (s.nodes ?? []) as unknown[];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    issues.push("WARN: no nodes defined (labels/groups-only figure)");
  }

  const nodeIds = new Set<string>();
  const nodeArr = Array.isArray(nodes) ? nodes : [];
  for (let i = 0; i < nodeArr.length; i++) {
    const node = nodeArr[i];
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      issues.push(`CRITICAL: nodes[${i}] must be a dict, got ${typeof node}`);
      continue;
    }
    const n = node as Record<string, unknown>;
    const nid = n.id;
    if (!nid) {
      issues.push(`CRITICAL: node[${i}] missing 'id'`);
      continue;
    }
    if (nodeIds.has(nid as string)) {
      issues.push(`CRITICAL: duplicate node id '${nid}'`);
    }
    nodeIds.add(nid as string);
    if (!("label" in n)) {
      issues.push(`WARN: node '${nid}' missing 'label'`);
    }
    for (const coord of ["x", "y"] as const) {
      if (!(coord in n)) {
        issues.push(`CRITICAL: node '${nid}' missing '${coord}'`);
      } else if (typeof n[coord] === "boolean" || !isNumber(n[coord])) {
        issues.push(`CRITICAL: node '${nid}' ${coord} must be a number, got ${typeof n[coord]}`);
      }
    }
    for (const dim of ["width", "height"] as const) {
      const val = n[dim];
      if (val !== undefined && val !== null) {
        if (typeof val === "boolean" || !isNumber(val)) {
          issues.push(`CRITICAL: node '${nid}' ${dim} must be a number, got ${typeof val}`);
        } else if (val <= 0) {
          issues.push(`CRITICAL: node '${nid}' ${dim} must be positive (${val})`);
        }
      }
    }
    const shape = (n.shape as string) ?? "rounded";
    if (!ALLOWED_SHAPES.has(shape)) {
      issues.push(`WARN: node '${nid}' unknown shape '${shape}', will use 'rounded'`);
    }
  }

  const edges = (s.edges ?? []) as unknown[];
  if (Array.isArray(edges)) {
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
        issues.push(`CRITICAL: edges[${i}] must be a dict`);
        continue;
      }
      const e = edge as Record<string, unknown>;
      const src = e.from;
      const dst = e.to;
      if (!src || !dst) {
        issues.push(`CRITICAL: edge[${i}] missing 'from' or 'to'`);
      } else {
        if (!nodeIds.has(src as string)) {
          issues.push(`CRITICAL: edge[${i}] 'from' references unknown node '${src}'`);
        }
        if (!nodeIds.has(dst as string)) {
          issues.push(`CRITICAL: edge[${i}] 'to' references unknown node '${dst}'`);
        }
      }
      const style = (e.style as string) ?? "solid";
      if (!ALLOWED_STYLES.has(style)) {
        issues.push(`WARN: edge[${i}] unknown style '${style}', will use 'solid'`);
      }
    }

    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i] as Record<string, unknown>;
      if (typeof edge !== "object" || edge === null) continue;
      const val = edge.thickness;
      if (val !== undefined && val !== null && (typeof val === "boolean" || !isNumber(val))) {
        issues.push(`WARN: edge[${i}] thickness must be a number`);
      }
    }
  }

  const groups = (s.groups ?? []) as unknown[];
  if (Array.isArray(groups)) {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (typeof group !== "object" || group === null || Array.isArray(group)) {
        issues.push(`CRITICAL: groups[${i}] must be a dict`);
        continue;
      }
      const g = group as Record<string, unknown>;
      const nids = g.node_ids;
      if (nids !== undefined && !Array.isArray(nids)) {
        issues.push(`WARN: group[${i}] node_ids must be a list`);
        continue;
      }
      if (Array.isArray(nids)) {
        for (const nid of nids) {
          if (!nodeIds.has(nid as string)) {
            issues.push(`WARN: group[${i}] references unknown node '${nid}'`);
          }
        }
      }
      const padVal = g.padding;
      if (
        padVal !== undefined &&
        padVal !== null &&
        (typeof padVal === "boolean" || !isNumber(padVal))
      ) {
        issues.push(`WARN: group[${i}] padding must be a number`);
      }
    }
  }

  const labels = (s.labels ?? []) as unknown[];
  if (Array.isArray(labels)) {
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (typeof label !== "object" || label === null || Array.isArray(label)) {
        issues.push(`CRITICAL: labels[${i}] must be a dict`);
        continue;
      }
      const l = label as Record<string, unknown>;
      const anchor = l.anchor as string | undefined;
      if (anchor && !ALLOWED_ANCHORS.has(anchor)) {
        issues.push(`WARN: label[${i}] unknown anchor '${anchor}', will use 'middle'`);
      }
      for (const field of ["x", "y", "font_size"] as const) {
        const val = l[field];
        if (val !== undefined && val !== null && (typeof val === "boolean" || !isNumber(val))) {
          issues.push(`WARN: label[${i}] ${field} must be a number`);
        }
      }
    }
  }

  for (const node of nodeArr) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const n = node as Record<string, unknown>;
    const nid = n.id ?? "?";
    const nfs = n.font_size;
    if (
      nfs !== undefined &&
      nfs !== null &&
      (typeof nfs === "boolean" || !isNumber(nfs) || nfs <= 0)
    ) {
      issues.push(`WARN: node '${nid}' font_size must be a positive number`);
    }
  }

  // Overlap detection
  function effectiveBounds(n: Record<string, unknown>): [number, number] {
    const w = (n.width as number) ?? DEFAULT_NODE.width;
    const h = (n.height as number) ?? DEFAULT_NODE.height;
    if (n.shape === "circle") {
      const d = Math.max(w, h);
      return [d, d];
    }
    return [w, h];
  }

  for (let i = 0; i < nodeArr.length; i++) {
    const a = nodeArr[i];
    if (typeof a !== "object" || a === null || Array.isArray(a)) continue;
    const aObj = a as Record<string, unknown>;
    for (let j = i + 1; j < nodeArr.length; j++) {
      const b = nodeArr[j];
      if (typeof b !== "object" || b === null || Array.isArray(b)) continue;
      const bObj = b as Record<string, unknown>;
      const ax = (aObj.x as number) ?? 0;
      const ay = (aObj.y as number) ?? 0;
      const bx = (bObj.x as number) ?? 0;
      const by = (bObj.y as number) ?? 0;
      const [aw, ah] = effectiveBounds(aObj);
      const [bw, bh] = effectiveBounds(bObj);
      if (Math.abs(ax - bx) < (aw + bw) / 2 - 5 && Math.abs(ay - by) < (ah + bh) / 2 - 5) {
        issues.push(`WARN: nodes '${aObj.id}' and '${bObj.id}' may overlap`);
      }
    }
  }

  return issues;
}

// ============================================================
// SVG Builder Helpers
// ============================================================

function attrs(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(" ");
}

function svgElement(tag: string, attributes: Record<string, string>, text?: string): string {
  if (text !== undefined) {
    return `<${tag} ${attrs(attributes)}>${escapeXml(text)}</${tag}>`;
  }
  return `<${tag} ${attrs(attributes)} />`;
}

// ============================================================
// SVG Renderer
// ============================================================

function renderSvg(spec: FigureSpec): string {
  const canvas = spec.canvas ?? {};
  const width = canvas.width ?? 800;
  const height = canvas.height ?? 400;
  const style = { ...DEFAULT_STYLE, ...spec.style };
  const palette = style.palette;
  const baseFs = style.font_size;

  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${escapeXml(sanitizeText(style.font_family))}">`,
  );

  // Background
  lines.push(
    `  <rect width="${width}" height="${height}" fill="${escapeXml(sanitizeColor(style.bg_color ?? "#FFFFFF"))}" />`,
  );

  // Defs: arrow markers
  lines.push("  <defs>");

  const markerColors: Record<string, string> = { default: sanitizeColor(DEFAULT_EDGE.color) };
  for (let i = 0; i < palette.length; i++) {
    markerColors[`c${i}`] = sanitizeColor(palette[i]);
  }

  for (const [name, color] of Object.entries(markerColors)) {
    lines.push(
      `    <marker id="arrow-${escapeXml(name)}" markerWidth="${ARROW_SIZE + 2}" markerHeight="${ARROW_SIZE + 2}" refX="${ARROW_SIZE}" refY="${Math.floor(ARROW_SIZE / 2)}" orient="auto" markerUnits="strokeWidth">`,
    );
    lines.push(
      `      <polygon points="0 0, ${ARROW_SIZE} ${Math.floor(ARROW_SIZE / 2)}, 0 ${ARROW_SIZE}" fill="${escapeXml(color)}" />`,
    );
    lines.push("    </marker>");
  }
  lines.push("  </defs>");

  // Build node lookup with defaults applied
  const nodeMap = new Map<string, ResolvedNode>();
  const nodesList = spec.nodes ?? [];
  for (let i = 0; i < nodesList.length; i++) {
    const node = nodesList[i];
    const fill = sanitizeColor(node.fill || lightenColor(palette[i % palette.length]));
    const stroke = sanitizeColor(node.stroke || palette[i % palette.length]);
    const textColor = sanitizeColor(node.text_color ?? DEFAULT_NODE.text_color);
    const label = sanitizeText(node.label ?? "");
    let shape = node.shape ?? DEFAULT_NODE.shape;
    if (!ALLOWED_SHAPES.has(shape)) shape = "rounded";

    const resolved: ResolvedNode = {
      id: node.id,
      label,
      sublabel: node.sublabel ? sanitizeText(node.sublabel) : undefined,
      x: node.x,
      y: node.y,
      width: node.width ?? DEFAULT_NODE.width,
      height: node.height ?? DEFAULT_NODE.height,
      shape,
      fill,
      stroke,
      text_color: textColor,
      font_size: node.font_size ?? DEFAULT_NODE.font_size,
    };
    nodeMap.set(node.id, resolved);
  }

  // --- Render groups (background layer) ---
  for (const group of spec.groups ?? []) {
    const gnodes: ResolvedNode[] = [];
    for (const nid of group.node_ids ?? []) {
      const n = nodeMap.get(nid);
      if (n) gnodes.push(n);
    }
    if (gnodes.length === 0) continue;
    const pad = group.padding ?? 20;

    function nodeExtent(n: ResolvedNode): [number, number] {
      if (n.shape === "circle") {
        const d = Math.max(n.width, n.height);
        return [d, d];
      }
      return [n.width, n.height];
    }

    const minX = Math.min(...gnodes.map((n) => n.x - nodeExtent(n)[0] / 2)) - pad;
    const minY = Math.min(...gnodes.map((n) => n.y - nodeExtent(n)[1] / 2)) - pad;
    const maxX = Math.max(...gnodes.map((n) => n.x + nodeExtent(n)[0] / 2)) + pad;
    const maxY = Math.max(...gnodes.map((n) => n.y + nodeExtent(n)[1] / 2)) + pad;

    lines.push(
      `  ${svgElement("rect", {
        x: minX.toFixed(1),
        y: minY.toFixed(1),
        width: (maxX - minX).toFixed(1),
        height: (maxY - minY).toFixed(1),
        fill: sanitizeColor(group.fill ?? "#F5F5F5"),
        stroke: sanitizeColor(group.stroke ?? "#E0E0E0"),
        "stroke-width": "1",
        rx: "8",
      })}`,
    );

    if (group.label) {
      lines.push(
        `  ${svgElement(
          "text",
          {
            x: (minX + 8).toFixed(1),
            y: (minY + 16).toFixed(1),
            "font-size": String(baseFs - 2),
            fill: "#999999",
            "font-weight": "bold",
          },
          sanitizeText(group.label),
        )}`,
      );
    }
  }

  // --- Render edges ---
  for (const edge of spec.edges ?? []) {
    const e = { ...DEFAULT_EDGE, ...edge };
    const src = nodeMap.get(e.from);
    const dst = nodeMap.get(e.to);
    if (!src || !dst) continue;

    const color = sanitizeColor(e.color);
    const eStyle = ALLOWED_STYLES.has(e.style) ? e.style : "solid";

    let markerId = "arrow-default";
    for (let ci = 0; ci < palette.length; ci++) {
      if (color.toLowerCase() === palette[ci].toLowerCase()) {
        markerId = `arrow-c${ci}`;
        break;
      }
    }

    const dashMap: Record<string, string> = { solid: "", dashed: "8,4", dotted: "3,3" };
    const dash = dashMap[eStyle] ?? "";

    // Self-loop
    if (src.id === dst.id) {
      const cx = src.x;
      const cy = src.y;
      const r = SELF_LOOP_RADIUS;
      const srcShape = src.shape;
      const [topX, topYPt] = clipToShape(cx, cy, cx, cy - 100, src.width, src.height, srcShape);
      const pathD = `M ${topX - 10},${topYPt} C ${cx - r},${topYPt - r * 1.5} ${cx + r},${topYPt - r * 1.5} ${topX + 10},${topYPt}`;
      const pathAttrs: Record<string, string> = {
        d: pathD,
        stroke: color,
        "stroke-width": String(e.thickness),
        fill: "none",
        "marker-end": `url(#${markerId})`,
      };
      if (dash) pathAttrs["stroke-dasharray"] = dash;
      lines.push(`  ${svgElement("path", pathAttrs)}`);
    } else {
      const [sx, sy] = clipToShape(src.x, src.y, dst.x, dst.y, src.width, src.height, src.shape);
      const [dx, dy] = clipToShape(dst.x, dst.y, src.x, src.y, dst.width, dst.height, dst.shape);

      let pathD: string;
      if (e.curve) {
        const mx = (sx + dx) / 2;
        const my = (sy + dy) / 2;
        const length = Math.sqrt((dx - sx) ** 2 + (dy - sy) ** 2) || 1;
        const offset = 30;
        const nx = (-(dy - sy) / length) * offset;
        const ny = ((dx - sx) / length) * offset;
        pathD = `M ${sx.toFixed(1)},${sy.toFixed(1)} Q ${(mx + nx).toFixed(1)},${(my + ny).toFixed(1)} ${dx.toFixed(1)},${dy.toFixed(1)}`;
      } else {
        pathD = `M ${sx.toFixed(1)},${sy.toFixed(1)} L ${dx.toFixed(1)},${dy.toFixed(1)}`;
      }

      const pathAttrs: Record<string, string> = {
        d: pathD,
        stroke: color,
        "stroke-width": String(e.thickness),
        fill: "none",
        "marker-end": `url(#${markerId})`,
      };
      if (dash) pathAttrs["stroke-dasharray"] = dash;
      lines.push(`  ${svgElement("path", pathAttrs)}`);
    }

    // Edge label
    if (e.label) {
      const labelText = sanitizeText(e.label);
      let lx: number;
      let ly: number;

      if (src.id === dst.id) {
        lx = src.x;
        const [, topPt] = clipToShape(
          src.x,
          src.y,
          src.x,
          src.y - 100,
          src.width,
          src.height,
          src.shape,
        );
        ly = topPt - SELF_LOOP_RADIUS * 1.2;
      } else if (e.curve) {
        const [sx, sy] = clipToShape(src.x, src.y, dst.x, dst.y, src.width, src.height, src.shape);
        const [dx, dy] = clipToShape(dst.x, dst.y, src.x, src.y, dst.width, dst.height, dst.shape);
        const mxCtrl = (sx + dx) / 2;
        const myCtrl = (sy + dy) / 2;
        const length = Math.sqrt((dx - sx) ** 2 + (dy - sy) ** 2) || 1;
        const offset = 30;
        const nxCtrl = (-(dy - sy) / length) * offset;
        const nyCtrl = ((dx - sx) / length) * offset;
        const qx = mxCtrl + nxCtrl;
        const qy = myCtrl + nyCtrl;
        lx = 0.25 * sx + 0.5 * qx + 0.25 * dx;
        ly = 0.25 * sy + 0.5 * qy + 0.25 * dy - 8;
      } else {
        const [sx, sy] = clipToShape(src.x, src.y, dst.x, dst.y, src.width, src.height, src.shape);
        const [dx, dy] = clipToShape(dst.x, dst.y, src.x, src.y, dst.width, dst.height, dst.shape);
        lx = (sx + dx) / 2;
        ly = (sy + dy) / 2 - 8;
      }

      const tw = estimateTextWidth(labelText, baseFs - 3) + 8;
      lines.push(
        `  ${svgElement("rect", {
          x: (lx - tw / 2).toFixed(1),
          y: (ly - 10).toFixed(1),
          width: tw.toFixed(1),
          height: "16",
          fill: "#FFFFFF",
          rx: "3",
          opacity: "0.85",
        })}`,
      );
      lines.push(
        `  ${svgElement(
          "text",
          {
            x: lx.toFixed(1),
            y: (ly + 2).toFixed(1),
            "font-size": String(baseFs - 3),
            fill: "#777777",
            "text-anchor": "middle",
          },
          labelText,
        )}`,
      );
    }
  }

  // --- Render nodes ---
  for (const node of nodesList) {
    const n = nodeMap.get(node.id)!;
    const { x, y, width: w, height: h, shape, fill, stroke } = n;
    const left = x - w / 2;
    const top = y - h / 2;

    if (shape === "circle") {
      const r = Math.max(w, h) / 2;
      lines.push(
        `  ${svgElement("circle", {
          cx: x.toFixed(1),
          cy: y.toFixed(1),
          r: r.toFixed(1),
          fill,
          stroke,
          "stroke-width": "2",
        })}`,
      );
    } else if (shape === "ellipse") {
      lines.push(
        `  ${svgElement("ellipse", {
          cx: x.toFixed(1),
          cy: y.toFixed(1),
          rx: (w / 2).toFixed(1),
          ry: (h / 2).toFixed(1),
          fill,
          stroke,
          "stroke-width": "2",
        })}`,
      );
    } else if (shape === "diamond") {
      const points = `${x.toFixed(1)},${top.toFixed(1)} ${(x + w / 2).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${(top + h).toFixed(1)} ${(x - w / 2).toFixed(1)},${y.toFixed(1)}`;
      lines.push(
        `  ${svgElement("polygon", {
          points,
          fill,
          stroke,
          "stroke-width": "2",
        })}`,
      );
    } else {
      const rx = shape === "rounded" ? "8" : "0";
      lines.push(
        `  ${svgElement("rect", {
          x: left.toFixed(1),
          y: top.toFixed(1),
          width: w.toFixed(1),
          height: h.toFixed(1),
          fill,
          stroke,
          "stroke-width": "2",
          rx,
        })}`,
      );
    }

    // Main label (supports \n for multi-line)
    const fs = n.font_size ?? baseFs;
    const rawLabel = n.label.replace(/\\n/g, "\n");
    const labelLines = rawLabel.split("\n").filter((l) => l);
    const hasSub = Boolean(n.sublabel);
    const totalLines = labelLines.length + (hasSub ? 1 : 0);
    const lineHeight = fs + 2;
    const startY = y - ((totalLines - 1) * lineHeight) / 2 + fs * 0.35;

    for (let li = 0; li < labelLines.length; li++) {
      lines.push(
        `  ${svgElement(
          "text",
          {
            x: x.toFixed(1),
            y: (startY + li * lineHeight).toFixed(1),
            "font-size": String(fs),
            fill: n.text_color,
            "text-anchor": "middle",
            "font-weight": "bold",
          },
          labelLines[li],
        )}`,
      );
    }

    // Sublabel
    if (hasSub) {
      lines.push(
        `  ${svgElement(
          "text",
          {
            x: x.toFixed(1),
            y: (startY + labelLines.length * lineHeight).toFixed(1),
            "font-size": String(fs - 3),
            fill: "#888888",
            "text-anchor": "middle",
          },
          n.sublabel!,
        )}`,
      );
    }
  }

  // --- Free labels ---
  for (const label of spec.labels ?? []) {
    let anchor = label.anchor ?? "middle";
    if (!ALLOWED_ANCHORS.has(anchor)) anchor = "middle";
    lines.push(
      `  ${svgElement(
        "text",
        {
          x: (label.x ?? 0).toFixed(1),
          y: (label.y ?? 0).toFixed(1),
          "font-size": String(label.font_size ?? baseFs),
          fill: sanitizeColor(label.color ?? "#555555"),
          "text-anchor": anchor,
        },
        sanitizeText(label.text ?? ""),
      )}`,
    );
  }

  lines.push("</svg>");

  // Pretty print with indentation
  return lines.join("\n") + "\n";
}

// ============================================================
// PNG Preview
// ============================================================

function svgToPng(svgPath: string, pngPath: string): boolean {
  try {
    execFileSync("rsvg-convert", ["-o", pngPath, svgPath], {
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    // rsvg-convert not available or failed
  }

  console.log("Warning: could not convert SVG to PNG (install rsvg-convert)");
  return false;
}

// ============================================================
// Schema (for documentation)
// ============================================================

const SCHEMA_DOC = `FigureSpec JSON Schema:
{
  "title": "string — figure title (metadata only, not rendered)",
  "canvas": {"width": int, "height": int},
  "style": {
    "font_family": "CSS font string",
    "font_size": int (default 14),
    "bg_color": "#RRGGBB",
    "palette": ["#color1", "#color2", ...]
  },
  "nodes": [{
    "id": "string (required, unique)",
    "label": "string (required, supports \\\\n for multi-line)",
    "x": int (required, center x),
    "y": int (required, center y),
    "width": int (default 120),
    "height": int (default 50),
    "shape": "rounded | rect | circle | ellipse | diamond",
    "fill": "#RRGGBB (auto from palette)",
    "stroke": "#RRGGBB (auto from palette)",
    "text_color": "#RRGGBB (default #333333)",
    "font_size": int (override),
    "sublabel": "string (smaller text below label)"
  }],
  "edges": [{
    "from": "node_id (required)",
    "to": "node_id (required, same as from = self-loop)",
    "label": "string",
    "style": "solid | dashed | dotted",
    "color": "#RRGGBB (default #555555)",
    "thickness": int (default 2),
    "curve": bool (default false)
  }],
  "groups": [{
    "id": "string",
    "label": "string",
    "node_ids": ["id1", "id2"],
    "fill": "#RRGGBB",
    "stroke": "#RRGGBB",
    "padding": int (default 20)
  }],
  "labels": [{
    "text": "string",
    "x": int, "y": int,
    "font_size": int,
    "color": "#RRGGBB",
    "anchor": "start | middle | end"
  }]
}
`;

// ============================================================
// CLI
// ============================================================

const program = createCli("figure-renderer", "ARIS FigureSpec → SVG Renderer");

program
  .command("render")
  .description("Render FigureSpec JSON to SVG")
  .argument("<spec_file>", "FigureSpec JSON file")
  .option("-o, --output <path>", "Output SVG path")
  .option("--preview", "Also generate PNG preview")
  .action((specFile: string, opts: { output?: string; preview?: boolean }) => {
    const raw = fs.readFileSync(specFile, "utf-8");
    const spec: FigureSpec = JSON.parse(raw);

    const issues = validateSpec(spec);
    const critical = issues.filter((i) => i.startsWith("CRITICAL"));
    if (critical.length > 0) {
      console.log("❌ Cannot render — critical issues:");
      for (const i of critical) console.log(`  ${i}`);
      process.exit(1);
    }

    if (issues.length > 0) {
      console.log(`⚠️  ${issues.length} warnings:`);
      for (const i of issues) console.log(`  ${i}`);
    }

    const svgContent = renderSvg(spec);

    let output: string;
    if (opts.output) {
      output = opts.output;
    } else {
      const base = path.basename(specFile, path.extname(specFile));
      output = path.join(path.dirname(specFile), `${base}.svg`);
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, svgContent, "utf-8");
    console.log(`✅ SVG written: ${output}`);

    if (opts.preview) {
      const pngPath = output.replace(/\.svg$/, ".png");
      if (svgToPng(output, pngPath)) {
        console.log(`✅ PNG preview: ${pngPath}`);
      }
    }
  });

program
  .command("validate")
  .description("Validate FigureSpec JSON")
  .argument("<spec_file>", "FigureSpec JSON file")
  .action((specFile: string) => {
    const raw = fs.readFileSync(specFile, "utf-8");
    const spec = JSON.parse(raw);
    const issues = validateSpec(spec);
    const criticalCount = issues.filter((i) => i.startsWith("CRITICAL")).length;
    if (issues.length === 0) {
      console.log("✅ FigureSpec is valid");
    } else {
      for (const issue of issues) console.log(`  ${issue}`);
      console.log(`\n${issues.length} issues (${criticalCount} critical)`);
    }
    process.exit(criticalCount > 0 ? 1 : 0);
  });

program
  .command("schema")
  .description("Print FigureSpec schema documentation")
  .action(() => {
    console.log(SCHEMA_DOC);
  });

runCli(program);
