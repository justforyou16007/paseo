import crypto from "node:crypto";
import path from "node:path";

export type CanonicalSchema =
  | {
      type: "object";
      properties: Record<string, CanonicalSchema>;
      required?: readonly string[];
      additionalProperties?: false;
    }
  | {
      type: "array";
      items: CanonicalSchema;
      /** A collection has set semantics and is sorted by canonical bytes. */
      collection?: boolean;
      ordered?: boolean;
    }
  | { type: "string"; format?: "workspace-relative-posix-path" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "any" };

export interface CanonicalJsonOptions {
  workspaceRoot?: string;
  schemaVersion?: string;
}

export const anyJsonSchema: CanonicalSchema = { type: "any" };

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNfc(value: string, location: string): void {
  if (value.normalize("NFC") !== value) {
    throw new Error(`canonical JSON ${location} is not Unicode NFC`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error(`canonical JSON ${location} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`canonical JSON ${location} contains an unpaired surrogate`);
    }
  }
}

function normalizeWorkspacePath(
  value: string,
  options: CanonicalJsonOptions,
  location: string,
): string {
  const workspaceRoot = options.workspaceRoot;
  if (!workspaceRoot) {
    throw new Error(`canonical JSON ${location} needs workspaceRoot for path normalization`);
  }
  assertNfc(value, location);
  if (value.includes("\0")) throw new Error(`canonical JSON ${location} contains NUL`);

  const slashValue = value.replaceAll("\\", "/");
  const looksAbsolute =
    slashValue.startsWith("/") || /^\\\\/.test(value) || /^[A-Za-z]:\//.test(slashValue);
  if (looksAbsolute) {
    throw new Error(`canonical JSON ${location} must be workspace-relative, not absolute`);
  }
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, slashValue);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`canonical JSON ${location} escapes workspace_root`);
  }
  return relative ? relative.split(path.sep).join("/") : ".";
}

function normalizeAny(value: unknown, options: CanonicalJsonOptions, location: string): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    assertNfc(value, location);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON ${location} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeAny(item, options, `${location}[${index}]`));
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      assertNfc(key, `${location}.${key}`);
      result[key] = normalizeAny(value[key], options, `${location}.${key}`);
    }
    return result;
  }
  throw new Error(`canonical JSON ${location} contains an unsupported value`);
}

function normalizeValue(
  value: unknown,
  schema: CanonicalSchema,
  options: CanonicalJsonOptions,
  location: string,
): unknown {
  if (schema.type === "any") return normalizeAny(value, options, location);

  if (schema.type === "null") {
    if (value !== null) throw new Error(`canonical JSON ${location} must be null`);
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`canonical JSON ${location} must be a string`);
    if (schema.format === "workspace-relative-posix-path") {
      return normalizeWorkspacePath(value, options, location);
    }
    assertNfc(value, location);
    return value;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`canonical JSON ${location} must be a finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`canonical JSON ${location} must be boolean`);
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`canonical JSON ${location} must be an array`);
    const normalized = value.map((item, index) =>
      normalizeValue(item, schema.items, options, `${location}[${index}]`),
    );
    if (schema.collection || schema.ordered === false) {
      return normalized
        .map((item, index) => ({ item, index, bytes: serializeCanonical(item) }))
        .sort((left, right) => {
          const compared = Buffer.compare(left.bytes, right.bytes);
          return compared !== 0 ? compared : left.index - right.index;
        })
        .map(({ item }) => item);
    }
    return normalized;
  }

  if (!isObject(value)) throw new Error(`canonical JSON ${location} must be an object`);
  const keys = Object.keys(value);
  const known = new Set(Object.keys(schema.properties));
  for (const key of keys) {
    if (!known.has(key)) throw new Error(`canonical JSON ${location} has unknown field '${key}'`);
  }
  const required = schema.required ?? Object.keys(schema.properties);
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new Error(`canonical JSON ${location} is missing '${key}'`);
  }
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    normalized[key] = normalizeValue(
      value[key],
      schema.properties[key]!,
      options,
      `${location}.${key}`,
    );
  }
  return normalized;
}

function quoteString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      default:
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += value[index] ?? "";
    }
  }
  return `${out}"`;
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("canonical JSON number must be finite");
  if (Object.is(value, -0)) return "0";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("canonical JSON number could not be serialized");
  return serialized;
}

function serializeCanonical(value: unknown): Buffer {
  if (value === null) return Buffer.from("null", "utf-8");
  if (typeof value === "string") return Buffer.from(quoteString(value), "utf-8");
  if (typeof value === "number") return Buffer.from(serializeNumber(value), "utf-8");
  if (typeof value === "boolean") return Buffer.from(value ? "true" : "false", "utf-8");
  if (Array.isArray(value)) {
    const children = value.map((item) => serializeCanonical(item).toString("utf-8"));
    return Buffer.from(`[${children.join(",")}]`, "utf-8");
  }
  if (isObject(value)) {
    const children = Object.keys(value)
      .sort()
      .map((key) => `${quoteString(key)}:${serializeCanonical(value[key]).toString("utf-8")}`);
    return Buffer.from(`{${children.join(",")}}`, "utf-8");
  }
  throw new Error("canonical JSON contains an unsupported value");
}

export function canonicalJsonBytes(
  value: unknown,
  schema: CanonicalSchema = anyJsonSchema,
  options: CanonicalJsonOptions = {},
): Buffer {
  return serializeCanonical(normalizeValue(value, schema, options, "$"));
}

export function canonicalJsonString(
  value: unknown,
  schema: CanonicalSchema = anyJsonSchema,
  options: CanonicalJsonOptions = {},
): string {
  return canonicalJsonBytes(value, schema, options).toString("utf-8");
}

export function canonicalJsonSha256(
  value: unknown,
  schema: CanonicalSchema = anyJsonSchema,
  options: CanonicalJsonOptions = {},
): string {
  const bytes = canonicalJsonBytes(value, schema, options);
  const prefix = options.schemaVersion === undefined ? "" : `${options.schemaVersion}\n`;
  return crypto.createHash("sha256").update(prefix, "utf-8").update(bytes).digest("hex");
}

export function objectSchema(
  properties: Record<string, CanonicalSchema>,
  required: readonly string[] = Object.keys(properties),
): CanonicalSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function arraySchema(items: CanonicalSchema, collection = false): CanonicalSchema {
  return { type: "array", items, collection, ordered: !collection };
}

// Short aliases keep call sites readable and make the shared primitive easy to
// use from future candidate/workflow identity code.
export const canonicalize = canonicalJsonBytes;
export const canonicalHash = canonicalJsonSha256;
