---
name: semantic-scholar
description: Search published venue papers through the Semantic Scholar API. Use for journal, conference, citation, and venue metadata searches.
argument-hint: query-or-paper-id
allowed-tools: Bash(*), Read, Write
---

# Semantic Scholar Search

Query or paper ID: `$ARGUMENTS`

## Contract

This skill has one implementation: `semantic-scholar-fetch.js`. It does not
run inline Python, call `/arxiv`, or fill missing fields from another source.

Resolve the project root with the shared resolver, then:

```bash
S2_FETCHER=".aris/dist/tools/semantic-scholar-fetch.js"
[ -f "$S2_FETCHER" ] || S2_FETCHER="dist/tools/semantic-scholar-fetch.js"
[ -f "$S2_FETCHER" ] || {
  echo "ERROR: semantic-scholar-fetch.js is required. Run /aris-update or build ARIS." >&2
  exit 1
}
```

## Workflow

Parse these explicit options:

- `- max: N`, default `10`;
- `- type: journal|conference|review|all`;
- `- min-citations: N`;
- `- year: RANGE`;
- `- fields: FIELDS`;
- `- sort: citations|date`.

Standard search:

```bash
node "$S2_FETCHER" search "QUERY" --max MAX_RESULTS \
  --fields-of-study "Computer Science,Engineering" \
  --publication-types JournalArticle,Conference || exit 1
```

Use `search-bulk` only when the user explicitly requests sorting or a large
result set. For a single paper, use:

```bash
node "$S2_FETCHER" paper "PAPER_ID" || exit 1
```

An API error, rate-limit response, or malformed result fails the phase. The
skill does not retry or switch source. Missing fields remain `null`.

## Research Wiki

If `research-wiki/` exists, resolve the required Wiki helper. For papers with
an arXiv ID, pass `--arxiv-id`; otherwise pass the paper's explicit title,
authors, year, venue, and DOI:

```bash
node "$WIKI_SCRIPT" ingest_paper research-wiki/ \
  --title "$TITLE" --authors "$AUTHORS" --year "$YEAR" \
  --venue "$VENUE" --external-id-doi "$DOI" || exit 1
```

Do not hand-write pages, use manual metadata inferred from another source, or
defer a failed ingest silently.

## Output

Show title, venue, publication type, year, citation count, DOI, abstract, TLDR
when present, and the exact source identity. If a requested field is absent,
show it as unavailable rather than substituting a value.
