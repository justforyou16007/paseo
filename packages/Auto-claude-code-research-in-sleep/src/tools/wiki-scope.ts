import { IDENTIFIER_PATTERN } from "./validate.js";

// New events are always written with scope "standalone". The other shapes are
// accepted so event logs written by the removed research loop still replay.

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPED_ROOTS = new Set(["modules", "workflows", "scorers"]);

export function scopePathSegments(scope: string): string[] {
  if (scope === "standalone") return ["standalone"];
  const parts = scope.split("/");
  const safe = parts.every(
    (part) =>
      (parts[0] === "runs" ? IDENTIFIER_PATTERN : SCOPE_ID).test(part) &&
      part !== "." &&
      part !== "..",
  );
  if (
    !safe ||
    !(
      (parts[0] === "runs" && parts.length >= 2) ||
      (parts.length === 2 && SCOPED_ROOTS.has(parts[0]!))
    )
  ) {
    throw new Error(`invalid Wiki scope '${scope}'`);
  }
  return parts;
}

export function validateWikiScope(scope: unknown): asserts scope is string {
  if (typeof scope !== "string") throw new Error("Wiki scope must be a string");
  scopePathSegments(scope);
}
