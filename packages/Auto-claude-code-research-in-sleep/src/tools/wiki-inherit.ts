import fs from "node:fs";
import {
  appendWikiEvents,
  initializeWikiSchema,
  readWikiEvents,
  wikiSchemaPath,
  type WikiDelta,
  type WikiEvent,
} from "./wiki-event-store.js";
import { runWikiRoot } from "./wiki-scope.js";

/**
 * An event's scope names the run that produced it. Carrying history into a
 * successor therefore has to rewrite that name: `assertSignalEventScope`
 * requires every event about one signal to carry a single scope, so a verbatim
 * copy would make the successor's own later write about an inherited signal
 * look like a scope conflict. Sub-scopes below the run (a scorer, for example)
 * keep their own segments.
 */
function rescope(scope: string, fromRunId: string, toRunId: string): string {
  const parts = scope.split("/");
  if (parts[0] !== "runs" || parts[1] !== fromRunId)
    throw new Error(`WIKI_SCOPE_CONFLICT: '${scope}' is not owned by the predecessor run`);
  return ["runs", toRunId, ...parts.slice(2)].join("/");
}

function inheritedDelta(event: WikiEvent, fromRunId: string, toRunId: string): WikiDelta {
  return {
    producer_kind: event.producer.kind,
    scope: rescope(event.producer.scope, fromRunId, toRunId),
    subject_id: event.producer.subject_id,
    evidence_bundle_id: event.evidence_bundle_id,
    payload: event.payload,
    event_type: event.event_type,
  };
}

/**
 * Seed a new run's Wiki with its predecessor's.
 *
 * A predecessor exists only when a parent re-dispatches the *same* task in a
 * later generation. The task did not change, so what the earlier run learned is
 * still about this task, and making the successor re-derive it would buy the
 * same knowledge twice out of the same parent budget. A changed task is a
 * different question and starts from an empty Wiki, which is why this is never
 * called for one.
 *
 * History is re-committed, not copied: the append path recomputes sequence
 * numbers, command ids and the hash chain, so the successor's log is a valid
 * log in its own right rather than a splice of another run's chain.
 *
 * Idempotent. Re-running it appends nothing, because a re-committed event
 * derives the same command id and the store skips a command it already holds.
 */
export function inheritRunWiki(projectRoot: string, fromRunId: string, toRunId: string): number {
  if (fromRunId === toRunId) throw new Error("WIKI_INHERIT_SELF: a run cannot inherit from itself");
  const sourceRoot = runWikiRoot(projectRoot, fromRunId);
  // A predecessor that never wrote anything has nothing to hand over. Its Wiki
  // is created lazily at first write, so an absent schema is the ordinary case.
  if (!fs.existsSync(wikiSchemaPath(sourceRoot))) return 0;
  const source = readWikiEvents(sourceRoot);
  if (source.length === 0) return 0;

  const targetRoot = runWikiRoot(projectRoot, toRunId);
  initializeWikiSchema(targetRoot);
  const results = appendWikiEvents(targetRoot, (existing) => {
    const deltas = source.map((event) => inheritedDelta(event, fromRunId, toRunId));
    // Inherited history has to sit at the front: the successor's own findings
    // are stated against it. So whatever the successor already holds must be a
    // prefix of what is being handed over — that is the re-entry case, where
    // the store then skips every command it already has. Anything else means
    // the successor wrote first, and there is no way to graft a past underneath
    // it without reordering facts.
    for (const [index, event] of existing.entries()) {
      const delta = deltas[index];
      if (
        delta === undefined ||
        event.producer.kind !== delta.producer_kind ||
        event.producer.scope !== delta.scope ||
        event.producer.subject_id !== delta.subject_id ||
        event.evidence_bundle_id !== delta.evidence_bundle_id ||
        event.payload_sha256 !== source[index]!.payload_sha256
      )
        throw new Error("WIKI_INHERIT_CONFLICT: successor Wiki already holds its own history");
    }
    return deltas;
  });
  for (const result of results) {
    if (result.status === "conflict")
      throw new Error(`WIKI_INHERIT_CONFLICT: ${result.command_id} is already used differently`);
  }
  return results.filter((result) => result.status === "appended").length;
}
