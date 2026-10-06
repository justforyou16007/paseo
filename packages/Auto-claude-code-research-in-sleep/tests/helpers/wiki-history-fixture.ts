import fs from "node:fs";
import {
  anyJsonSchema,
  canonicalJsonBytes,
  canonicalJsonSha256,
} from "../../src/tools/canonical-json.js";
import { computeWikiCommandId } from "../../src/tools/wiki-command-id.js";
import {
  readWikiEvents,
  wikiEventsPath,
  wikiEventHash,
  type WikiDelta,
  type WikiEvent,
} from "../../src/tools/wiki-event-store.js";
import { validateWikiPayload } from "../../src/tools/wiki-operations.js";
/** Simulate already committed history to test replay/export; never a publication API. */
export function appendHistoricalWikiFixture(root: string, delta: WikiDelta) {
  validateWikiPayload(delta.payload);
  const existing = readWikiEvents(root),
    payload_sha256 = canonicalJsonSha256(delta.payload, anyJsonSchema);
  const withoutId: Omit<WikiEvent, "event_id"> = {
    schema_version: 2,
    seq: existing.length + 1,
    command_id: computeWikiCommandId({ ...delta, canonical_payload_sha256: payload_sha256 }),
    payload_sha256,
    previous_event_hash: existing.at(-1)?.event_id.slice("event:sha256:".length) ?? null,
    committed_at: "2026-01-01T00:00:00Z",
    evidence_bundle_id: delta.evidence_bundle_id,
    producer: { kind: delta.producer_kind, scope: delta.scope, subject_id: delta.subject_id },
    event_type: "knowledge_delta_committed",
    payload: delta.payload,
  };
  const event = { ...withoutId, event_id: `event:sha256:${wikiEventHash(withoutId as WikiEvent)}` };
  fs.appendFileSync(
    wikiEventsPath(root),
    canonicalJsonBytes(event, anyJsonSchema).toString() + "\n",
  );
  return { status: "appended", event };
}
