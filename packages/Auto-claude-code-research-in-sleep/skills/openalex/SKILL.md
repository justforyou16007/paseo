---
name: openalex
description: Search OpenAlex for open citation-graph and institution metadata. Use when the user explicitly requests OpenAlex.
argument-hint: [search-query]
allowed-tools: Bash(*), Read, Write
---

# OpenAlex Search

Query: `$ARGUMENTS`

## Contract

This skill has one implementation: `openalex-fetch.js`. It does not call
another literature source when OpenAlex fails.

```bash
OPENALEX_FETCHER=".aris/dist/tools/openalex-fetch.js"
[ -f "$OPENALEX_FETCHER" ] || OPENALEX_FETCHER="dist/tools/openalex-fetch.js"
[ -f "$OPENALEX_FETCHER" ] || {
  echo "ERROR: openalex-fetch.js is required." >&2
  exit 1
}
```

## Workflow

Parse the query and explicit `--max`, `--year`, `--type`, and `--sort` values.
Run:

```bash
node "$OPENALEX_FETCHER" search "QUERY" --max MAX_RESULTS \
  --year "2022-" --type article --sort relevance || exit 1
```

An API, helper, or output error fails the skill. Show DOI, arXiv ID, title,
authors, venue, institutions, funding, citation data, and OpenAlex ID exactly
as returned. Missing metadata remains `null`.

## Research Wiki

If `research-wiki/` exists, resolve the required Wiki helper. Ingest only when
the result contains the explicit metadata required by `research-wiki`; a
failed ingest fails the skill.

## Output

Record the query, filters, result count, and source IDs. Do not replace
OpenAlex results with Semantic Scholar, arXiv, or WebSearch results.
