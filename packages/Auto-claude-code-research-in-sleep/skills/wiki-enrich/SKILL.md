---
name: wiki-enrich
description: Fill TODO sections in existing research-wiki paper pages from one explicitly selected paper source.
argument-hint: "--source alphaxiv|deepxiv|arxiv"
allowed-tools: Bash(*), Read, Edit, Write, WebFetch
---

# Research Wiki Enrichment

## Contract

This skill enriches existing scaffolded pages. The caller must provide one
source with `--source alphaxiv`, `--source deepxiv`, or `--source arxiv`.
`--source auto` is not supported.

The selected source is used once per paper. A missing paper ID, missing source
helper, failed fetch, or failed page write fails that paper and the batch.
The skill does not try another source, reuse the page's old abstract, or skip a
paper after a fetch failure.

## Pre-flight

Require `research-wiki/` and the compiled Wiki helper. Do not create the Wiki
directory here:

```bash
[ -d research-wiki ] || {
  echo "ERROR: run /research-wiki init first." >&2
  exit 1
}

WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || {
  echo "ERROR: research-wiki.js is required." >&2
  exit 1
}
```

Read the target page and identify its `paper:<slug>` node and arXiv ID. A
paper without the identity required by the selected source is an error.

## Source commands

Run only the command matching `--source`:

```text
alphaxiv → WebFetch https://alphaxiv.org/overview/<arxiv_id>.md
deepxiv  → node "$DEEPXIV_FETCHER" paper-brief <arxiv_id>
arxiv    → node "$ARXIV_FETCHER" paper <arxiv_id>
```

The corresponding helper must be installed before the run. A response must
contain usable source text; an empty or failed response stops the batch.

## Fill pages

Fill only sections whose body is exactly `_TODO._` or
`_TODO: fill in after reading._`. Never modify YAML frontmatter, `##
Connections`, or `## Abstract (original)`.

Use the selected source text to fill thesis, problem, method, results,
assumptions, limitations, reusable ingredients, open questions, claims, and
project relevance. If the source does not state a fact, write
`_Not stated in source._`; do not infer it from another source or old page
content.

After each page, record provenance and update the page through the Wiki helper:

```bash
node "$WIKI_SCRIPT" log research-wiki/ \
  "wiki-enrich: enriched paper:<slug> from <selected-source>" || exit 1
```

Rebuild the query pack once after all pages succeed:

```bash
node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/ || exit 1
```

## Output

Report processed pages, selected source, filled sections, and the first
failure if the batch stops. An explicit later invocation may use another
source; this invocation never changes source automatically.
