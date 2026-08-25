---
name: arxiv
description: Search, download, and summarize academic papers from arXiv. Use when the user asks for an arXiv search, paper download, or arXiv paper summary.
argument-hint: [query-or-arxiv-id]
allowed-tools: Bash(*), Read, Write
---

# arXiv Paper Search

Query or paper ID: `$ARGUMENTS`

## Contract

This skill has one implementation: `arxiv-fetch.js`. It does not run inline
Python, use WebSearch, or replace an arXiv failure with another source.

```bash
PROJECT_ROOT="$(_find_project_root)" || exit 1
cd "$PROJECT_ROOT" || exit 1
ARXIV_FETCHER=".aris/dist/tools/arxiv-fetch.js"
[ -f "$ARXIV_FETCHER" ] || ARXIV_FETCHER="dist/tools/arxiv-fetch.js"
[ -f "$ARXIV_FETCHER" ] || {
  echo "ERROR: arxiv-fetch.js is required. Run /aris-update or build ARIS." >&2
  exit 1
}
```

Use the shared project-root resolver from
[`shared-references/integration-contract.md`](../shared-references/integration-contract.md).

## Workflow

Parse the query or ID and these explicit options:

- `- max: N` — maximum search results, default `10`;
- `- dir: PATH` — PDF directory, default `papers/`;
- `- download` — download the selected paper;
- `- download: all` — download every returned paper.

For a query:

```bash
node "$ARXIV_FETCHER" search "QUERY" --max MAX_RESULTS
```

For a paper ID:

```bash
node "$ARXIV_FETCHER" paper "ARXIV_ID"
```

For a download:

```bash
node "$ARXIV_FETCHER" download "ARXIV_ID" --dir "$PAPER_DIR"
```

A command failure stops the skill and writes a failed result. Do not retry in
the skill or suggest another retrieval path as part of the same run.

## Research Wiki

If `research-wiki/` exists, Wiki ingest is part of this run. Resolve the
required helper using
[`shared-references/wiki-helper-resolution.md`](../shared-references/wiki-helper-resolution.md)
and ingest every returned arXiv ID:

```bash
node "$WIKI_SCRIPT" ingest_paper research-wiki/ --arxiv-id "$ARXIV_ID" || exit 1
```

Do not hand-write paper pages or silently leave an ingest for a later sync.

## Output

Show the arXiv ID, title, authors, abstract, dates, categories, PDF URL, and
download paths. Report the exact failed command when a phase fails.

## Rules

- Keep existing PDFs untouched and report them as already present.
- A downloaded PDF must be larger than 10 KB; otherwise the download phase fails.
- A missing optional field is reported as `null`; it is not replaced by data
  from another source.
