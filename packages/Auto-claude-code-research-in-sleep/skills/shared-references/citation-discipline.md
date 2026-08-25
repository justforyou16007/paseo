# Citation Discipline

Use this reference when a paper identity or citation claim is ambiguous.
Citation uncertainty stops the current stage; it does not trigger another
source, a guessed BibTeX entry, or an `[UNVERIFIED]` substitute.

## Rules

- Never create a citation from memory.
- Keep one source contract for each skill. `/paper-write` uses its declared
  DBLP helper; it does not switch to another provider when DBLP fails.
- Literature discovery may collect candidates from its explicitly requested
  sources, but every candidate used as evidence must pass the required
  `verify-papers.js` helper.
- A missing, malformed, or failed verifier blocks the stage. Do not emit a
  degraded verification file to make the next stage continue.
- An `unverified` result is a blocking result for evidence use. Preserve it in
  the diagnostic receipt, but never present it as verified evidence.
- If metadata sources disagree, stop and ask for an explicit identifier or
  user decision. Do not merge records silently.

## Pre-Search Verification Protocol

`verify-papers.js` is the single verifier for candidate papers. Resolve it
through the canonical helper chain in
[`integration-contract.md`](integration-contract.md), then invoke it once with
the candidate file and the output file:

```bash
VERIFY_PAPERS=".aris/dist/tools/verify-papers.js"
[ -f "$VERIFY_PAPERS" ] || VERIFY_PAPERS="dist/tools/verify-papers.js"
[ -f "$VERIFY_PAPERS" ] || {
  echo "ERROR: verify-papers.js is required" >&2
  exit 1
}
node "$VERIFY_PAPERS" \
  --input candidate_papers.json \
  --output verified_papers.json
```

The caller must check the helper's exit status and the resulting verdict.
`PASS` is required before verified papers can enter an evidence-bearing
artifact. `WARN`, `BLOCKED`, `ERROR`, or any paper with `unverified` status
must stop the consuming stage.

The candidate input contains explicit identifiers where available:

```json
[
  {"id": "p1", "arxiv_id": "2307.03172", "doi": null, "title": "Paper"}
]
```

The verifier is responsible for its fixed checks and cache. The caller must
not add a second lookup, split a failed request, or manufacture a result.

## Ambiguous Citations

When a citation key, title, author list, year, venue, DOI, or arXiv ID cannot
be resolved unambiguously:

1. Keep the unresolved item in the diagnostic output.
2. Mark the stage as blocked.
3. Report the exact field that needs a decision.

Do not continue writing prose that relies on the unresolved item.
