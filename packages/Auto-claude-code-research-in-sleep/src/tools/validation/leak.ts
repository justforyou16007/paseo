/**
 * Check outbound feedback against the hidden benchmark before the worker sees it.
 * Text is compared after lowercasing and collapsing punctuation and whitespace,
 * so reformatting a copied passage does not hide it. The feedback is small and
 * the hidden data can be large, so feedback windows are indexed and the hidden
 * files are streamed past them.
 */
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface LeakMatch {
  file: string;
  excerpt: string;
}
export interface LeakReport {
  leaked: boolean;
  matches: LeakMatch[];
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const BASE = 257;
const MAX_MATCHES = 20;

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
}

function hashOf(text: string, start: number, length: number): number {
  let hash = 0;
  for (let index = start; index < start + length; index += 1)
    hash = (Math.imul(hash, BASE) + text.charCodeAt(index)) | 0;
  return hash;
}

function* hiddenFiles(entry: string): Generator<string> {
  const stat = fs.statSync(entry, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) yield entry;
  else if (stat.isDirectory())
    for (const child of fs.readdirSync(entry).sort()) yield* hiddenFiles(path.join(entry, child));
}

function looksBinary(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(8192);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/** Normalised text of a file in pieces; each piece repeats the previous piece's last `overlap` chars. */
function* normalizedChunks(file: string, overlap: number): Generator<string> {
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let carry = "";
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      const piece = normalizeText(read ? decoder.write(buffer.subarray(0, read)) : decoder.end());
      // A separator run split across two reads becomes one space, as it would in one read.
      const text =
        carry.endsWith(" ") && piece.startsWith(" ") ? carry + piece.slice(1) : carry + piece;
      if (text.length > carry.length) yield text;
      carry = text.slice(-overlap);
      if (!read) return;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `terms` are short identifiers (benchmark sample ids) that must not appear as
 * whole words even though they are shorter than a matching window.
 */
export function checkLeak(
  feedback: string,
  hiddenPaths: readonly string[],
  minMatchChars: number,
  terms: readonly string[] = [],
): LeakReport {
  const matches: LeakMatch[] = [];
  const normalized = normalizeText(feedback);
  const words = ` ${normalized} `;
  for (const term of new Set(terms)) {
    const needle = normalizeText(term).trim();
    if (needle.length >= 6 && words.includes(` ${needle} `))
      matches.push({ file: "(benchmark sample id)", excerpt: needle });
  }
  const length = minMatchChars;
  let power = 1;
  for (let index = 1; index < length; index += 1) power = Math.imul(power, BASE);
  const windows = new Map<number, number[]>();
  if (normalized.length >= length) {
    let hash = hashOf(normalized, 0, length);
    for (let start = 0; ; start += 1) {
      const list = windows.get(hash);
      if (list) list.push(start);
      else windows.set(hash, [start]);
      if (start + length >= normalized.length) break;
      hash =
        (Math.imul(hash - Math.imul(normalized.charCodeAt(start), power), BASE) +
          normalized.charCodeAt(start + length)) |
        0;
    }
  }
  if (windows.size) {
    const reported = new Set<string>();
    for (const root of hiddenPaths)
      for (const file of hiddenFiles(root)) {
        if (matches.length >= MAX_MATCHES || looksBinary(file)) continue;
        for (const text of normalizedChunks(file, length - 1)) {
          if (text.length < length) continue;
          let hash = hashOf(text, 0, length);
          // Windows inside an overlap already reported are skipped: one excerpt per overlap.
          let coveredUntil = 0;
          for (let start = 0; ; start += 1) {
            for (const at of start < coveredUntil ? [] : (windows.get(hash) ?? [])) {
              if (text.slice(start, start + length) !== normalized.slice(at, at + length)) continue;
              let end = length;
              while (
                start + end < text.length &&
                at + end < normalized.length &&
                text[start + end] === normalized[at + end]
              )
                end += 1;
              coveredUntil = Math.max(coveredUntil, start + end - length + 1);
              const excerpt = text.slice(start, start + end).trim();
              if (!reported.has(excerpt)) {
                reported.add(excerpt);
                matches.push({ file, excerpt });
              }
            }
            if (start + length >= text.length || matches.length >= MAX_MATCHES) break;
            hash =
              (Math.imul(hash - Math.imul(text.charCodeAt(start), power), BASE) +
                text.charCodeAt(start + length)) |
              0;
          }
        }
      }
  }
  return { leaked: matches.length > 0, matches };
}
