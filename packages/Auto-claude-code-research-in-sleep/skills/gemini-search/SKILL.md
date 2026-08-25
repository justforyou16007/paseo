---
name: gemini-search
description: Search literature with the configured Gemini MCP tool. Use for broad topic decomposition and paper discovery when Gemini is explicitly selected.
argument-hint: [search-query]
allowed-tools: Read, Write, mcp__gemini-cli__ask-gemini
---

# Gemini Literature Search

Query: `$ARGUMENTS`

## Contract

This skill uses only `mcp__gemini-cli__ask-gemini`. The Gemini CLI is not a
second transport. If the MCP tool is unavailable or fails, the skill fails and
the caller must choose another source explicitly in a new run.

## Workflow

1. Parse the query and optional year, venue, and result-count constraints.
2. Verify the MCP tool is available.
3. Ask Gemini to search from multiple angles, including aliases, neighboring
   tasks, benchmark variants, surveys, recent papers, and papers with code.
4. Require exact title, authors, year, venue, arXiv ID or DOI, code URL, and a
   one-sentence contribution for every returned paper.
5. Present the results with the original Gemini response and the normalized
   fields. Do not invent missing identifiers.

## Research Wiki

If `research-wiki/` exists, resolve the required Wiki helper and ingest papers
with explicit identifiers. A failed Wiki operation fails the skill.

## Rules

- Do not use Gemini-reported citation counts as authoritative metadata.
- A missing field remains `null`.
- Do not call `/arxiv`, Gemini CLI, WebSearch, or another model from this
  skill after the MCP request fails.
