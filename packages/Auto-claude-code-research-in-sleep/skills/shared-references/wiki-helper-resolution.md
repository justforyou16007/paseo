# Research Wiki Helper

Every skill that writes to `research-wiki/` uses the same compiled helper.
The helper is required whenever Wiki integration is active.

## Resolution

Resolve the project root with the shared rules, then check these locations
in order:

```bash
WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || {
  echo "ERROR: research-wiki.js is not installed" >&2
  echo "       Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
```

The second location supports development inside the ARIS repository. It is
not an alternate implementation.

## Invocation rule

Use the resolved helper for every operation:

```bash
node "$WIKI_SCRIPT" ingest_paper research-wiki/ --arxiv-id "$id"
```

If resolution or invocation fails, stop the active phase and write its
failure receipt. Do not create Wiki directories by hand, omit the Wiki
side-effect, use manual metadata, or continue with a successful claim.

## Manual repair

Backfill is a separate, explicit operation:

```bash
node "$WIKI_SCRIPT" sync --arxiv-ids 2501.12345,1706.03762
```

It is never called automatically as a reaction to a failed ingest.

## See also

- `integration-contract.md`
- `output-versioning.md`
