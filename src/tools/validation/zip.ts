/**
 * Unpack an untrusted deliverable zip. Only stored and deflated regular files
 * are accepted; every name is checked so nothing lands outside the target, on
 * Windows or elsewhere. Sizes are enforced while inflating because the sizes a
 * zip declares can lie.
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import zlib from "node:zlib";
import { failA1 } from "../validate.js";

export interface UnzipLimits {
  max_unpacked_bytes: number;
  max_files: number;
}
export interface UnzipResult {
  files: number;
  bytes: number;
  /** The directory holding USAGE.md: the target itself or its single top-level folder. */
  content_root: string;
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  directory: boolean;
}

const EOCD = 0x06054b50,
  ZIP64_LOCATOR = 0x07064b50,
  ZIP64_EOCD = 0x06064b50,
  CENTRAL = 0x02014b50,
  LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function invalid(message: string): never {
  failA1("INVALID_DELIVERABLE", message);
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  if (read !== length) invalid("the zip is truncated");
  return buffer;
}

function u64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("the zip declares an impossible size");
  return Number(value);
}

/** Normalised, safe relative path segments of one entry name. */
function safeSegments(raw: string): string[] {
  const name = raw.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) invalid(`absolute path in zip: ${raw}`);
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (!segments.length) invalid(`empty path in zip: ${JSON.stringify(raw)}`);
  for (const segment of segments) {
    if (segment === "..") invalid(`path escapes the deliverable: ${raw}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>:"|?*]/.test(segment) || /[. ]$/.test(segment))
      invalid(`file name not portable to Windows: ${raw}`);
    if (WINDOWS_RESERVED.test(segment)) invalid(`reserved Windows file name: ${raw}`);
  }
  return segments;
}

function readEntries(fd: number, fileSize: number, limits: UnzipLimits): Entry[] {
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  const tail = readAt(fd, fileSize - tailLength, tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1)
    if (tail.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  if (eocd < 0) invalid("not a zip file");
  let count = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === MAX_U32 || centralOffset === MAX_U32) {
    const locatorAt = fileSize - tailLength + eocd - 20;
    if (locatorAt < 0) invalid("the zip64 locator is missing");
    const locator = readAt(fd, locatorAt, 20);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) invalid("the zip64 locator is missing");
    const record = readAt(fd, u64(locator, 8), 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) invalid("the zip64 directory is missing");
    count = u64(record, 32);
    centralSize = u64(record, 40);
    centralOffset = u64(record, 48);
  }
  if (count > limits.max_files) invalid(`more than ${limits.max_files} entries`);
  if (centralOffset + centralSize > fileSize) invalid("the zip directory is out of range");
  const central = readAt(fd, centralOffset, centralSize);
  const entries: Entry[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL)
      invalid("the zip directory is corrupt");
    const madeBy = central.readUInt16LE(cursor + 4) >> 8;
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    let compressedSize = central.readUInt32LE(cursor + 20);
    let size = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const external = central.readUInt32LE(cursor + 38);
    let localOffset = central.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = central.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const extra = central.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    // Zip64 sizes appear in the extra field only for the values that overflowed, in this order.
    for (let at = 0; at + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(at),
        length = extra.readUInt16LE(at + 2);
      if (id === 0x0001) {
        let field = at + 4;
        if (size === MAX_U32) {
          size = u64(extra, field);
          field += 8;
        }
        if (compressedSize === MAX_U32) {
          compressedSize = u64(extra, field);
          field += 8;
        }
        if (localOffset === MAX_U32) localOffset = u64(extra, field);
      }
      at += 4 + length;
    }
    if (flags & 0x1) invalid(`encrypted entry: ${name}`);
    const directory = name.endsWith("/") || name.endsWith("\\");
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) invalid(`symbolic link in zip: ${name}`);
    if (!directory && method !== 0 && method !== 8)
      invalid(`unsupported compression in ${name}; use deflate`);
    entries.push({ name, method, compressedSize, size, localOffset, directory });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function limitBytes(limit: number, name: string, counter: { total: number }): Transform {
  let written = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      counter.total += chunk.length;
      if (written > limit) callback(new Error(`${name} is larger than the zip declares`));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(written === limit ? null : new Error(`${name} is shorter than the zip declares`));
    },
  });
}

/** Extract `zipPath` into the empty directory `target`. */
export async function unzipDeliverable(
  zipPath: string,
  target: string,
  limits: UnzipLimits,
): Promise<UnzipResult> {
  fs.mkdirSync(target, { recursive: true });
  if (fs.readdirSync(target).length) failA1("UNZIP_TARGET_NOT_EMPTY", target);
  const fd = fs.openSync(zipPath, "r");
  try {
    const entries = readEntries(fd, fs.fstatSync(fd).size, limits);
    const seen = new Set<string>();
    let declared = 0,
      files = 0;
    const planned = entries.map((entry) => {
      const segments = safeSegments(entry.name);
      // Windows and default macOS file systems are case-insensitive.
      const key = segments.join("/").toLowerCase();
      if (!entry.directory) {
        if (seen.has(key)) invalid(`duplicate path in zip: ${entry.name}`);
        seen.add(key);
        declared += entry.size;
        files += 1;
      }
      return { entry, segments };
    });
    if (declared > limits.max_unpacked_bytes)
      invalid(`unpacked size exceeds ${limits.max_unpacked_bytes} bytes`);
    for (const key of seen)
      for (let cut = key.indexOf("/"); cut >= 0; cut = key.indexOf("/", cut + 1))
        if (seen.has(key.slice(0, cut))) invalid(`a file and a folder share the path ${key}`);
    const counter = { total: 0 };
    for (const { entry, segments } of planned) {
      const destination = path.join(target, ...segments);
      if (entry.directory) {
        fs.mkdirSync(destination, { recursive: true });
        continue;
      }
      const local = readAt(fd, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== LOCAL) invalid(`corrupt entry: ${entry.name}`);
      const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const source = fs.createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1,
      });
      const stages: NodeJS.ReadWriteStream[] = [];
      if (entry.method === 8) stages.push(zlib.createInflateRaw());
      stages.push(limitBytes(entry.size, entry.name, counter));
      try {
        if (entry.compressedSize === 0 && entry.size === 0) fs.writeFileSync(destination, "");
        else
          await pipeline([source, ...stages, fs.createWriteStream(destination, { flags: "wx" })]);
      } catch (error) {
        invalid(`cannot extract ${entry.name}: ${(error as Error).message}`);
      }
      if (counter.total > limits.max_unpacked_bytes)
        invalid(`unpacked size exceeds ${limits.max_unpacked_bytes} bytes`);
    }
    const top = fs.readdirSync(target);
    let contentRoot = target;
    if (!fs.existsSync(path.join(target, "USAGE.md"))) {
      const only = top.length === 1 ? path.join(target, top[0]!) : null;
      if (only && fs.statSync(only).isDirectory() && fs.existsSync(path.join(only, "USAGE.md")))
        contentRoot = only;
      else invalid("USAGE.md must be at the zip root or in its single top-level folder");
    }
    return { files, bytes: counter.total, content_root: contentRoot };
  } finally {
    fs.closeSync(fd);
  }
}
