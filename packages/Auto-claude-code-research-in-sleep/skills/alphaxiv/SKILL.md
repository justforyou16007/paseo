---
name: alphaxiv
description: Read one paper through a single explicit AlphaXiv representation. Use for a paper overview, abstract view, or LaTeX source view.
argument-hint: [arxiv-id-or-url]
allowed-tools: Read, WebFetch, Write, Bash(*)
---

# AlphaXiv Paper Reader

Paper: `$ARGUMENTS`

## Contract

This skill makes one AlphaXiv request at the depth chosen by the user. It
does not fall through from overview to abstract to LaTeX, and it does not use
DeepXiv or arXiv when AlphaXiv fails.

Parse:

- paper ID or AlphaXiv URL;
- `--depth overview|abs|latex`, default `overview`.

Build exactly one URL:

```text
overview → https://alphaxiv.org/overview/<arxiv_id>.md
abs      → https://alphaxiv.org/abs/<arxiv_id>.md
latex    → https://alphaxiv.org/latex/<arxiv_id>.tex
```

Fetch that URL once. A 404, empty response, redirect to the homepage, or
fetch error fails the skill. The selected depth is explicit; a failed request
does not change depth.

## Research Wiki

If `research-wiki/` exists, resolve the required Wiki helper and ingest the
paper with the available explicit metadata. A failed Wiki operation fails the
skill; do not leave it for an implicit backfill.

## Output

Show the selected depth, source URL, paper identity, retrieved content, and
any fields absent from that representation. Do not fill missing sections from
another AlphaXiv representation.
