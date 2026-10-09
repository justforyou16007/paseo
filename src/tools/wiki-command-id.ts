import { canonicalJsonSha256, objectSchema, type CanonicalSchema } from "./canonical-json.js";

export interface WikiCommandIdentity {
  producer_kind: string;
  scope: string;
  subject_id: string;
  evidence_bundle_id: string;
  canonical_payload_sha256: string;
  // These fields are accepted only as operational metadata. They are never
  // copied into the identity, so a retry cannot acquire a new command name.
  attempt_id?: unknown;
  timestamp?: unknown;
  time?: unknown;
  pid?: unknown;
  random?: unknown;
  nonce?: unknown;
  command_id?: unknown;
}

const COMMAND_ID_SCHEMA: CanonicalSchema = objectSchema({
  producer_kind: { type: "string" },
  scope: { type: "string" },
  subject_id: { type: "string" },
  evidence_bundle_id: { type: "string" },
  canonical_payload_sha256: { type: "string" },
});

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`wiki command identity field '${field}' must be a non-empty string`);
  }
  return value;
}

export function computeWikiCommandId(identity: WikiCommandIdentity): string {
  if (Object.hasOwn(identity, "command_id")) {
    throw new Error("agent-supplied command_id is forbidden; the system computes it");
  }

  const canonicalIdentity = {
    producer_kind: requireNonEmpty(identity.producer_kind, "producer_kind"),
    scope: requireNonEmpty(identity.scope, "scope"),
    subject_id: requireNonEmpty(identity.subject_id, "subject_id"),
    evidence_bundle_id: requireNonEmpty(identity.evidence_bundle_id, "evidence_bundle_id"),
    canonical_payload_sha256: requireNonEmpty(
      identity.canonical_payload_sha256,
      "canonical_payload_sha256",
    ),
  };
  if (!/^[0-9a-f]{64}$/.test(canonicalIdentity.canonical_payload_sha256)) {
    throw new Error("canonical_payload_sha256 must be a lowercase SHA-256 hex digest");
  }

  const digest = canonicalJsonSha256(canonicalIdentity, COMMAND_ID_SCHEMA, {
    schemaVersion: "wiki-command-id-v2",
  });
  return `command:sha256:${digest}`;
}

export const wikiCommandId = computeWikiCommandId;
