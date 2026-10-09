import path from "node:path";

export type JsonObject = Record<string, unknown>;

export class A1Error extends Error {
  readonly code: string;
  readonly location: string | null;

  constructor(code: string, message: string, location: string | null = null) {
    super(`${code}: ${message}`);
    this.name = "A1Error";
    this.code = code;
    this.location = location;
  }
}

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function isRecord(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function failA1(code: string, message: string, location: string | null = null): never {
  throw new A1Error(code, message, location);
}

export function assertNoUnknownFields(
  value: JsonObject,
  allowed: readonly string[],
  location: string,
): void {
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      failA1("UNKNOWN_FIELD", `unknown field '${key}'`, `${location}.${key}`);
    }
  }
}

function assertNfc(value: string, location: string): void {
  if (value.normalize("NFC") !== value) {
    failA1("INVALID_UNICODE", "string must already be Unicode NFC", location);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        failA1("INVALID_UNICODE", "string contains an unpaired surrogate", location);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failA1("INVALID_UNICODE", "string contains an unpaired surrogate", location);
    }
  }
}

/** Sort identity-bearing strings by UTF-8 bytes, independent of locale. */
export function compareIdentityStrings(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    failA1("INVALID_VALUE", "expected a non-empty string", location);
  }
  assertNfc(value, location);
  return value;
}

export function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") failA1("INVALID_VALUE", "expected a boolean", location);
  return value;
}

export function requireFiniteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failA1("INVALID_VALUE", "expected a finite number", location);
  }
  return value;
}

export function requireInteger(value: unknown, location: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failA1("INVALID_VALUE", `expected a safe integer >= ${minimum}`, location);
  }
  return value;
}

export function assertIdentifier(value: unknown, location: string): string {
  const identifier = requireString(value, location);
  if (identifier === "." || identifier === ".." || !IDENTIFIER_PATTERN.test(identifier)) {
    failA1("INVALID_ID", "must be a single safe identifier", location);
  }
  return identifier;
}

export function assertSha256(value: unknown, location: string): string {
  const digest = requireString(value, location);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    failA1("INVALID_HASH", "must be a lowercase SHA-256 digest", location);
  }
  return digest;
}

export function assertRelativePath(value: unknown, location: string): string {
  const candidate = requireString(value, location);
  if (candidate.includes("\0")) failA1("INVALID_PATH", "must not contain NUL", location);
  const slashValue = candidate.replaceAll("\\", "/");
  if (
    path.isAbsolute(candidate) ||
    slashValue.startsWith("/") ||
    /^[A-Za-z]:\//.test(slashValue) ||
    slashValue.split("/").some((part) => part === "..")
  ) {
    failA1("PATH_ESCAPE", "must be a relative path inside the declared workspace", location);
  }
  if (slashValue === "." || slashValue.endsWith("/")) {
    failA1("INVALID_PATH", "must name a file or scoped path", location);
  }
  const normalized = path.posix.normalize(slashValue);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    failA1("PATH_ESCAPE", "must be a relative path inside the declared workspace", location);
  }
  return normalized;
}
