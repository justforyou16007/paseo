---
name: deepxiv
description: Search and progressively read papers through DeepXiv. Use for paper briefs, section maps, section reads, trending papers, and DeepXiv web search.
argument-hint: [query-or-paper-id]
allowed-tools: Bash(*), Read, Write
---

# DeepXiv Progressive Reading

Query or paper ID: `$ARGUMENTS`

## Contract

This skill has one implementation: `deepxiv-fetch.js`. The helper is the only
caller of the DeepXiv SDK and CLI. The skill never runs raw CLI commands as a
second path and never substitutes arXiv, Semantic Scholar, or AlphaXiv.

Resolve the project root with the shared resolver, then require both the
compiled helper and the DeepXiv CLI:

```bash
DEEPXIV_FETCHER=".aris/dist/tools/deepxiv-fetch.js"
[ -f "$DEEPXIV_FETCHER" ] || DEEPXIV_FETCHER="dist/tools/deepxiv-fetch.js"
[ -f "$DEEPXIV_FETCHER" ] || {
  echo "ERROR: deepxiv-fetch.js is required. Run /aris-update or build ARIS." >&2
  exit 1
}
command -v deepxiv >/dev/null 2>&1 || {
  echo "ERROR: install the DeepXiv CLI before running this skill." >&2
  exit 1
}
```

## Workflow

Parse one operation from `$ARGUMENTS`:

- query: `search QUERY --max N`;
- paper ID: `paper-brief`, `paper-head`, or `paper-section ID SECTION`;
- `trending` with an explicit `--days` and `--max`;
- `web QUERY`;
- `sc ID`.

Run the matching helper subcommand exactly once. For example:

```bash
node "$DEEPXIV_FETCHER" search "QUERY" --max 10 || exit 1
node "$DEEPXIV_FETCHER" paper-brief "ARXIV_ID" || exit 1
node "$DEEPXIV_FETCHER" paper-head "ARXIV_ID" || exit 1
node "$DEEPXIV_FETCHER" paper-section "ARXIV_ID" "SECTION" || exit 1
```

An error or empty required response fails the requested operation. Do not
deepen with another command after a failed fetch.

## Research Wiki

If `research-wiki/` exists, resolve the required Wiki helper and ingest the
papers returned by this invocation. A failed ingest fails the skill.

```bash
node "$WIKI_SCRIPT" ingest_paper research-wiki/ --arxiv-id "$ARXIV_ID" || exit 1
```

## Output

Show the operation, source, paper identity, retrieved text, and section name.
Do not claim a paper was read when the requested DeepXiv operation failed.
