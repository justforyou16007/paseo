import { IDENTIFIER_PATTERN } from "./workflow-spec.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";

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

/** The worker-visible scope contains only this run's opaque identifier. */
export function resolveRunWikiScope(
  projectRoot: string,
  runId: string,
  requested?: string,
): string {
  const run = requireRunContract(projectRoot, runId);
  const scope = `runs/${run.run_id}`;
  if (requested !== undefined && requested !== scope) throw new Error("WIKI_SCOPE_CONFLICT");
  return scope;
}

export function runWikiRoot(projectRoot: string, runId: string): string {
  return runOwnedPath(projectRoot, runId, "wiki");
}

/** Reject private tester structures before they reach public storage or query output. */
export function assertResearchVisible(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertResearchVisible);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(tester|tester_(?:cases?|answers?|outputs?|scores?|results?|private)(?:_.*)?|private_(?:artifact_(?:uri|path|ref)|uri|results?|path)|case_(?:answers?|outputs?|scores?)|per_case_.*|raw_tester_.*)$/i.test(
          key,
        )
      ) {
        throw new Error("TESTER_PRIVATE_DATA_FORBIDDEN");
      }
      assertResearchVisible(item);
    }
  } else if (
    typeof value === "string" &&
    /(?:tester-private:|private-artifact:|\/tester-private\/)/i.test(value)
  ) {
    throw new Error("TESTER_PRIVATE_DATA_FORBIDDEN");
  }
}

export function assertOuterWikiScope(scope: string, allowStandalone = false): void {
  validateWikiScope(scope);
  if (scope === "standalone" || allowStandalone)
    throw new Error("STANDALONE_OUTER_DECISION_FORBIDDEN");
}
