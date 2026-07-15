#!/usr/bin/env node
/**
 * preprocess_figures — clean up extracted crops before they go on a poster.
 *
 * Autocrops near-white margins, reports natural size, warns on low-res,
 * and syncs FIGURE_MANIFEST.json.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createCli, runCli } from "../../lib/cli.js";
import { asciiSafe } from "./posterly/textutil.js";

const DEFAULT_WHITE_THRESHOLD = 248;

function sha256File(filePath: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

interface ManifestData {
  figures?: ManifestFigure[];
  [key: string]: unknown;
}

interface ManifestFigure {
  file?: string;
  natural_px?: number[];
  sha256?: string;
  [key: string]: unknown;
}

function loadManifest(manifestPath: string): ManifestData | null {
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`WARN: manifest not found, skipping sync: ${asciiSafe(manifestPath)}\n`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ManifestData;
  } catch (e) {
    process.stderr.write(`ERROR: manifest unreadable: ${asciiSafe(String(e))}\n`);
    process.exit(1);
    return null; // unreachable
  }
}

function syncManifestEntry(
  manifest: ManifestData,
  manifestPath: string,
  imgPath: string,
  naturalPx: [number, number],
  sha: string,
): boolean {
  const target = path.resolve(imgPath);
  let updated = false;
  for (const fig of manifest.figures || []) {
    const fpath = path.resolve(path.dirname(manifestPath), fig.file || "");
    if (fpath === target) {
      fig.natural_px = [naturalPx[0], naturalPx[1]];
      fig.sha256 = sha;
      updated = true;
    }
  }
  return updated;
}

async function autocropAndProcess(
  imgPath: string,
  doAutocrop: boolean,
  padPx: number,
  threshold: number,
): Promise<{ width: number; height: number; changed: boolean; beforeW: number; beforeH: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sharp: any;
  try {
    sharp = await import("sharp" as string);
  } catch {
    process.stderr.write(
      "ERROR: sharp not installed -- required for preprocess_figures. " +
        "Install with:\n  npm install sharp\n",
    );
    process.exit(2);
  }

  const img = sharp.default(imgPath);
  const meta = await img.metadata();
  const beforeW = meta.width || 0;
  const beforeH = meta.height || 0;
  let width = beforeW;
  let height = beforeH;
  let changed = false;

  if (doAutocrop && beforeW > 0 && beforeH > 0) {
    const { data, info } = await sharp.default(imgPath).raw().toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    let minX = info.width;
    let minY = info.height;
    let maxX = 0;
    let maxY = 0;
    const cutoff = 255 - threshold;

    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * channels;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const diff = Math.max(255 - r, 255 - g, 255 - b);
        if (diff > cutoff) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX >= minX && maxY >= minY) {
      const left = Math.max(0, minX - padPx);
      const top = Math.max(0, minY - padPx);
      const right = Math.min(info.width, maxX + 1 + padPx);
      const bottom = Math.min(info.height, maxY + 1 + padPx);

      if (left !== 0 || top !== 0 || right !== info.width || bottom !== info.height) {
        const cropped = await sharp
          .default(imgPath)
          .extract({
            left,
            top,
            width: right - left,
            height: bottom - top,
          })
          .toBuffer();
        fs.writeFileSync(imgPath, cropped);
        const newMeta = await sharp.default(imgPath).metadata();
        width = newMeta.width || 0;
        height = newMeta.height || 0;
        changed = true;
      }
    } else {
      process.stderr.write(
        `[preprocess] WARN: ${asciiSafe(path.basename(imgPath))} is all near-white; skipping autocrop.\n`,
      );
    }
  }

  return { width, height, changed, beforeW, beforeH };
}

const program = createCli(
  "preprocess_figures",
  "Autocrop near-white margins, report natural size, warn on low-res, and sync FIGURE_MANIFEST.json.",
);

program
  .argument("<images...>", "one or more image files to process in place")
  .option("--autocrop", "trim near-white border (default: report only)")
  .option("--pad <n>", "px of padding kept after autocrop", "6")
  .option("--threshold <n>", "near-white cutoff 0-255", String(DEFAULT_WHITE_THRESHOLD))
  .option("--min-px <w> <h>", "warn if natural size is below W x H px")
  .option("--manifest <path>", "FIGURE_MANIFEST.json to keep in sync")
  .action(
    async (images: string[], opts: Record<string, string | boolean | string[] | undefined>) => {
      const doAutocrop = !!opts.autocrop;
      const padPx = parseInt((opts.pad as string) || "6", 10);
      const threshold = parseInt((opts.threshold as string) || String(DEFAULT_WHITE_THRESHOLD), 10);

      let minPxW: number | null = null;
      let minPxH: number | null = null;
      if (opts.minPx) {
        const parts = Array.isArray(opts.minPx) ? opts.minPx : [opts.minPx];
        if (parts.length >= 2) {
          minPxW = parseInt(parts[0] as string, 10);
          minPxH = parseInt(parts[1] as string, 10);
        }
      }

      const manifestPath = opts.manifest ? path.resolve(opts.manifest as string) : null;
      const manifest = manifestPath ? loadManifest(manifestPath) : null;
      let manifestDirty = false;

      let anyWarn = false;
      let anyMissing = false;

      for (const imgArg of images) {
        const imgPath = path.resolve(imgArg);
        if (!fs.existsSync(imgPath)) {
          process.stderr.write(`ERROR: image not found: ${asciiSafe(imgPath)}\n`);
          anyMissing = true;
          continue;
        }

        try {
          const result = await autocropAndProcess(imgPath, doAutocrop, padPx, threshold);
          const cropNote = result.changed
            ? `  (autocropped from ${result.beforeW}x${result.beforeH})`
            : "";
          console.log(
            `[preprocess] ${asciiSafe(path.basename(imgPath))}: ` +
              `${result.width}x${result.height}px${cropNote}`,
          );

          if (minPxW !== null && minPxH !== null) {
            if (result.width < minPxW || result.height < minPxH) {
              process.stderr.write(
                `[preprocess] WARN: ${asciiSafe(path.basename(imgPath))} ` +
                  `${result.width}x${result.height}px is below ` +
                  `--min-px ${minPxW}x${minPxH}; may upscale poorly.\n`,
              );
              anyWarn = true;
            }
          }

          if (manifest !== null && manifestPath !== null) {
            const sha = sha256File(imgPath);
            if (
              syncManifestEntry(manifest, manifestPath, imgPath, [result.width, result.height], sha)
            ) {
              manifestDirty = true;
            } else {
              process.stderr.write(
                `[preprocess] note: no manifest entry references ` +
                  `${asciiSafe(path.basename(imgPath))}; not synced.\n`,
              );
            }
          }
        } catch (e) {
          process.stderr.write(
            `ERROR: cannot process ${asciiSafe(imgPath)}: ${asciiSafe(String(e))}\n`,
          );
          anyMissing = true;
        }
      }

      if (manifest !== null && manifestDirty && manifestPath !== null) {
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
        console.log(`[preprocess] manifest synced: ${asciiSafe(manifestPath)}`);
      }

      if (anyMissing) process.exit(2);
      if (anyWarn) process.exit(0);
      process.exit(0);
    },
  );

runCli(program);
