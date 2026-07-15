import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { asciiSafe } from "./textutil.js";

const UNIT_TO_IN: Record<string, number> = {
  in: 1.0,
  mm: 1.0 / 25.4,
  cm: 1.0 / 2.54,
  pt: 1.0 / 72.0,
};

const NAMED_SIZES_MM: Record<string, [number, number]> = {
  A0: [841.0, 1189.0],
  A1: [594.0, 841.0],
  A2: [420.0, 594.0],
  A3: [297.0, 420.0],
  A4: [210.0, 297.0],
};

function extractStyleCss(htmlText: string): string {
  const blocks: string[] = [];
  const re = /<style[^>]*>(.*?)<\/style>/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(htmlText)) !== null) {
    blocks.push(m[1]);
  }
  let css = blocks.join("\n");
  css = css.replace(/\/\*.*?\*\//gs, "");
  return css;
}

export function readCanvasFromHtml(htmlPath: string): [number, number] | null {
  const txt = fs.readFileSync(htmlPath, "utf-8");
  const css = extractStyleCss(txt);

  const pattern =
    /@page(?:\s+[A-Za-z_-][\w:-]*)?\s*\{[^}]*?size\s*:\s*([^;{}]+?)\s*(?:!\s*important\s*)?[;}]/gi;

  let lastParsed: [number, number] | null = null;
  let pm: RegExpExecArray | null;
  while ((pm = pattern.exec(css)) !== null) {
    const raw = pm[1].trim();
    const mNum = raw.match(
      /^((?:\d+(?:\.\d*)?|\.\d+))\s*(in|mm|cm|pt)\s+((?:\d+(?:\.\d*)?|\.\d+))\s*(in|mm|cm|pt)$/i,
    );
    if (mNum) {
      const w = parseFloat(mNum[1]) * UNIT_TO_IN[mNum[2].toLowerCase()];
      const h = parseFloat(mNum[3]) * UNIT_TO_IN[mNum[4].toLowerCase()];
      lastParsed = [w, h];
      continue;
    }
    try {
      lastParsed = parseCanvasArg(raw);
    } catch {
      continue;
    }
  }
  return lastParsed;
}

export function parseCanvasArg(s: string): [number, number] {
  s = s.trim();
  const m = s.match(
    /^((?:\d+(?:\.\d*)?|\.\d+))\s*[x×]\s*((?:\d+(?:\.\d*)?|\.\d+))\s*(in|mm|cm|pt)$/i,
  );
  if (m) {
    const unit = m[3].toLowerCase();
    const w = parseFloat(m[1]) * UNIT_TO_IN[unit];
    const h = parseFloat(m[2]) * UNIT_TO_IN[unit];
    return [w, h];
  }

  const parts = s.split(/\s+/);
  if (parts.length >= 1 && parts.length <= 2) {
    let nameToken: string | null = null;
    let orientToken: string | null = null;
    let valid = true;
    for (const part of parts) {
      const up = part.toUpperCase();
      const lo = part.toLowerCase();
      if (up in NAMED_SIZES_MM && nameToken === null) {
        nameToken = up;
      } else if ((lo === "portrait" || lo === "landscape") && orientToken === null) {
        orientToken = lo;
      } else {
        valid = false;
        break;
      }
    }
    if (valid && nameToken !== null) {
      const orient = orientToken ?? "portrait";
      let [wMm, hMm] = NAMED_SIZES_MM[nameToken];
      if (orient === "landscape") {
        [wMm, hMm] = [hMm, wMm];
      }
      return [wMm / 25.4, hMm / 25.4];
    }
  }

  throw new Error(
    `--canvas expects '<W>x<H><unit>' (e.g. '60x36in') or ` +
      `'<NamedSize> [portrait|landscape]' (e.g. 'A0 portrait'); ` +
      `got '${asciiSafe(s)}'. Named sizes: ` +
      `${Object.keys(NAMED_SIZES_MM).sort().join(", ")}.`,
  );
}

export function viewportFor(canvasIn: [number, number]): [number, number] {
  const [wIn, hIn] = canvasIn;
  return [Math.round(wIn * 96), Math.round(hIn * 96)];
}

export function resolveCanvas(
  htmlPath: string,
  canvasOverride: [number, number] | null,
  label: string,
): { canvas: [number, number]; viewport: [number, number] } | null {
  let canvas: [number, number];
  if (canvasOverride !== null) {
    canvas = canvasOverride;
    console.log(
      `${label} canvas (--canvas override) = ${canvas[0].toFixed(2)}in x ${canvas[1].toFixed(2)}in`,
    );
  } else {
    const parsed = readCanvasFromHtml(htmlPath);
    if (parsed === null) {
      return null;
    }
    canvas = parsed;
    console.log(`${label} canvas = ${canvas[0].toFixed(2)}in x ${canvas[1].toFixed(2)}in`);
  }
  const viewport = viewportFor(canvas);
  console.log(`${label} viewport = ${viewport[0]} x ${viewport[1]} px`);
  return { canvas, viewport };
}

export function htmlFileUrl(htmlPath: string): string {
  return pathToFileURL(path.resolve(htmlPath)).href;
}
