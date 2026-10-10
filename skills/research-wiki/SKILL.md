---
name: research-wiki
description: 'Persistent research knowledge base that accumulates papers, ideas, experiments, claims, and their relationships across the entire research lifecycle. Inspired by Karpathy''s LLM Wiki pattern. Use when user says "知识库", "research wiki", "add paper", "wiki query", "查知识库", or wants to build/query a persistent field map.'
argument-hint: [subcommand: init|ingest|sync|query|update|lint|stats]
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, WebSearch, WebFetch
---

# Research Wiki: Persistent Research Knowledge Base

Subcommand: **$ARGUMENTS**

## Overview

The research wiki is a persistent, per-project knowledge base that accumulates what the worker learns about its task. Unlike one-off literature surveys that are used and forgotten, the wiki **compounds** — every paper read, idea tried, submission scored and problem found is there for the next session.

Inspired by [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): compile knowledge once, keep it current, don't re-derive on every query.

## Core Concepts

### Five Entity Types

| Entity         | Directory      | Node ID format | What it represents                                                                      |
| -------------- | -------------- | -------------- | --------------------------------------------------------------------------------------- |
| **Paper**      | `papers/`      | `paper:<slug>` | A published or preprint research paper                                                  |
| **Idea**       | `ideas/`       | `idea:<id>`    | A research idea (proposed, tested, or failed)                                           |
| **Experiment** | `experiments/` | `exp:<id>`     | A concrete experiment run with results                                                  |
| **Claim**      | `claims/`      | `claim:<id>`   | A theorem or headline with an explicit proof status                                     |
| **Problem**    | `problems/`    | `problem:<slug>` | An open problem between the current deliverable and the target                        |

### Typed Relationships (`graph/edges.jsonl`)

| Edge type       | From → To         | Meaning                       |
| --------------- | ----------------- | ----------------------------- |
| `extends`       | paper\|claim → paper | Builds on prior work       |
| `contradicts`   | paper → paper     | Disagrees with results/claims |
| `addresses`     | idea\|claim → problem | Targets an open problem   |
| `child_of`      | problem → problem | A sub-problem of a larger one |
| `inspired_by`   | idea → paper      | Idea sourced from this paper  |
| `tested_by`     | idea\|claim → exp | Tested in this experiment     |
| `supports`      | exp → claim\|idea | Experiment confirms claim     |
| `invalidates`   | exp → claim\|idea | Experiment disproves claim    |
| `supersedes`    | paper → paper     | Newer work replaces older     |
| `uses`          | claim → paper     | Claim relies on this method   |
| `depends_on`    | claim → claim     | Holds only if that claim holds |
| `refutes`       | claim → claim     | Contradicts that claim        |

The From → To column is enforced, not advisory: the helper rejects an edge
whose endpoint kinds don't match and names the edge type that does fit. So
`idea:x --inspired_by--> problem:y` fails with "for idea → problem use:
addresses".

Edges are stored in `graph/edges.jsonl` only. The `## Connections` section on each page is **auto-generated** from the graph — never hand-edit it.

### Capture hygiene (anti-self-poisoning)

Before persisting an **idea / claim / experiment** note, screen it for
operational noise that would harden into a self-cited falsehood (see
[`shared-references/capture-antipatterns.md`](../shared-references/capture-antipatterns.md)).
Run `node .aris/dist/tools/capture-filter.js -` on the note text; if it flags
**env-failure / transient-error / negative-tool-claim**, do NOT store it as a
durable node — rewrite it to the _fix / missing config / workaround_, or drop
it. (The wiki's "failed ideas → anti-repeat memory" is the GOOD inverse: a
class-level _research_ finding, not operational noise.)

## Wiki Directory Structure

```
research-wiki/
  index.md               # categorical index (auto-generated)
  log.md                 # append-only timeline
  query_pack.md          # compressed summary to read before planning (auto-generated, max 8000 chars)
  papers/
    <slug>.md            # one page per paper
  ideas/
    <idea_id>.md         # one page per idea
  experiments/
    <exp_id>.md          # one page per experiment
  claims/
    <claim_id>.md        # one page per testable claim
  problems/
    <slug>.md            # one page per open problem
  graph/
    edges.jsonl          # materialized current relationship graph
```

## Subcommands

Every operation goes through `node .aris/dist/tools/research-wiki.js` (see
[integration-contract.md](../shared-references/integration-contract.md)); below
it is `$WIKI_SCRIPT`. Never create or edit wiki files by hand. Literature
skills (`/arxiv`, `/deepxiv`, `/semantic-scholar`, `/openalex`, `/exa-search`)
call the same helper in their last step when `research-wiki/` exists.

### `/research-wiki init`

Initialize the wiki for the current project:

```bash
node "$WIKI_SCRIPT" init research-wiki/
```

The helper creates
`research-wiki/{papers,ideas,experiments,claims,problems,graph}/` plus
`index.md`, `log.md`, **`query_pack.md`**, and `graph/edges.jsonl`, then
appends `"Wiki initialized"` to `log.md`.

### `/research-wiki ingest "<paper title>" — arxiv: <id>`

Add a paper to the wiki with `node "$WIKI_SCRIPT" ingest_paper …`. The
helper does all of:

1. **Fetch metadata** — queries the arXiv Atom API when `--arxiv-id` is given
2. **Generate slug** — `<first_author_last_name><year>_<keyword>`
3. **Check dedup** — skip an existing page unless `--update-on-exist`
4. **Create page** — `papers/<slug>.md` with the schema below
5. **Rebuild `index.md`** and `query_pack.md`
6. **Append `log.md`**

`ingest_paper` does not infer relationships. Add each identified relationship
explicitly with `add_edge`:

```bash
# arXiv-known paper
node "$WIKI_SCRIPT" ingest_paper research-wiki/ \
    --arxiv-id 2501.12345 --thesis "One-line claim from abstract."

# Venue paper with no arXiv mirror
node "$WIKI_SCRIPT" ingest_paper research-wiki/ \
    --title "Attention Is All You Need" \
    --authors "Ashish Vaswani, Noam Shazeer, …" --year 2017 --venue "NeurIPS"

# Manual edge after ingest
node "$WIKI_SCRIPT" add_edge research-wiki/ \
    --from "paper:vaswani2017_attention_all_you" \
    --to "paper:chen2025_factorized_gap" \
    --type "extends" --evidence "Section 3.2: adapts the encoder block …"
```

### `/research-wiki sync — arxiv-ids <id1>,<id2>,...`

Batch backfill: ingest one or more arXiv IDs that were read earlier
without being ingested (e.g., because `research-wiki/` was set up after
the reading happened, or a hook didn't fire).

```bash
# Explicit list
node "$WIKI_SCRIPT" sync research-wiki/ \
    --arxiv-ids 2310.06770,1706.03762

# From a file (one id per line, # comments ok)
node "$WIKI_SCRIPT" sync research-wiki/ --from-file ids.txt
```

Dedup is handled per-id; already-ingested papers are skipped silently.
`sync` does not scan session traces — callers declare the ids
explicitly. It is never run automatically after a failed ingest.

**Paper page schema** (exactly what `ingest_paper` emits — do not
handwrite alternative fields; `lint` will flag drift):

```markdown
---
type: paper
node_id: paper:<slug>
title: "<full title>"
authors: ["First A. Author", "Second B. Author"]
year: 2025
venue: "arXiv"
external_ids:
  arxiv: "2501.12345"
  doi: null
  s2: null
tags: ["tag1", "tag2"]
added: 2026-04-07T10:12:00Z
---

# <full title>

## One-line thesis

[Single sentence capturing the paper's core contribution]

## Problem / Gap

## Method

## Key Results

## Assumptions

## Limitations / Failure Modes

## Reusable Ingredients

[Techniques, datasets, or insights that could be repurposed]

## Open Questions

## Claims

[Reference claim pages: claim:C1, claim:C2, etc.]

## Connections

[AUTO-GENERATED from graph/edges.jsonl — do not edit manually]

## Relevance to This Project

[Why this paper matters for our specific research direction]
```

_Additionally, when the paper was ingested via `--arxiv-id` and the arXiv
API returned an abstract, the helper appends an `## Abstract (original)`
section after `Relevance to This Project` containing the raw abstract
text as a blockquote. Manual ingests (no `--arxiv-id`) do not include
this section._

### `/research-wiki query`

Regenerate `query_pack.md`, a compressed summary to read before planning:

```bash
node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/ [--max-chars <n>]
```

`--max-chars` persists a new size limit. Every mutating command already
rebuilds the pack, so this is only needed after changing the limit.

**Fixed budget (max 8000 chars / ~2000 tokens):**

| Section           | Budget        | Content                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project direction | full sections | The `task.md` sections Goal / Inputs and outputs / Constraints / Delivery, in that order. No per-field char cap — the 8000-char assembly loop is the only safety net. Falls back to a flat 600-char slice if the task uses no known headings. |
| Open problems     | 1400 chars    | Up to 15 `problems/` pages whose `status` is still `open`, each as `[problem:<slug>] [severity] title`. An entity scan, so a long problem statement can never truncate the list.                                                                                                                                                             |
| Paper clusters    | 1600 chars    | 3-5 clusters by tag overlap, 2-3 sentences each                                                                                                                                                                                                                                                                                             |
| Failed ideas      | 1400 chars    | **Always included** — highest anti-repetition value                                                                                                                                                                                                                                                                                         |
| Top papers        | 1800 chars    | 8-12 pages ranked by: linked problems, linked ideas, centrality, relevance flag                                                                                                                                                                                                                                                                 |
| Active chains     | 900 chars     | limitation → opportunity relationship chains                                                                                                                                                                                                                                                                                                |
| Open unknowns     | 500 chars     | Unresolved questions across the wiki                                                                                                                                                                                                                                                                                                        |

**Pruning priority** (when over budget): low-ranked papers > cluster detail > chain detail. **Never prune** failed ideas or open problems first — those two sections are what stop the next round from repeating the last one.

**Key rule:** Read from short fields only (frontmatter, one-line thesis, gap summary, failure note). Do not summarize full page bodies every time.

### `/research-wiki update <node_id> — <field>: <value>`

There is no generic update command. Rerun the entity's own command with
`--update-on-exist`. `add_problem` keeps every field you leave out and appends
new `--evidence`. The other commands rewrite the whole page, so pass every
field again with the changed one; a field left out becomes empty. Read the
current page first:

```bash
node "$WIKI_SCRIPT" upsert_idea research-wiki/ --slug 001 --title "<title>" \
  --stage piloted --outcome negative --thesis "<...>" --risks "<...>" \
  --based-on <...> --target-problems <...> --update-on-exist
```

### `/research-wiki lint`

Health check the wiki:

1. **Orphan pages** — entities with zero edges
2. **Stale claims** — claims still `status: drafted` or `status: unproven` older than 14 days
3. **Contradictions** — claims with both `supports` and `invalidates` edges
4. **Missing connections** — papers sharing 2+ tags but no explicit relationship
5. **Dead ideas** — `stage: proposed` ideas that were never tested
6. **Sparse pages** — pages with 3+ empty sections

Output a `LINT_REPORT.md` with suggested fixes.

### `/research-wiki stats`

`node "$WIKI_SCRIPT" stats research-wiki/ [--json]`:

```
📚 Research Wiki Stats
Papers: 28 (12 core, 10 related, 6 peripheral)
Ideas: 7 (2 active, 3 failed, 1 partial, 1 succeeded)
Experiments: 12
Claims: 15 (8 verified, 4 unproven, 2 refuted, 1 sound-modulo-imports)
Edges: 64
Problems: 8 (3 open, 4 solved, 1 deferred)
Last updated: 2026-04-07T10:12:00Z
```

## What the worker records

The worker's `CLAUDE.md` role block says when to write; these are the commands.

### Ideas, before trying them

```bash
node "$WIKI_SCRIPT" upsert_idea research-wiki/ \
  --slug <stable-id> --title <title> --stage proposed --outcome pending \
  --thesis <...> --risks <...> --based-on <paper:slug,...> --target-problems <problem:slug,...>
```

One call writes the page, wires `inspired_by`/`addresses` edges and rebuilds
the index and query pack. `--based-on` takes paper ids only; problems go in
`--target-problems`. Leave `--based-on` out when no paper inspired the idea.
Default is skip-on-exist, so an idea already updated with its outcome is not
clobbered. `outcome` ∈ {unknown, pending, negative, mixed, positive}.

### Submissions, after `query` returns a result

Each scored submission becomes an experiment page. Copy the score from the
`query` result; never type a number you did not receive.

```bash
node "$WIKI_SCRIPT" add_experiment research-wiki/ --slug <name> \
  --submission <submission id> --idea idea:<id> \
  --verdict <yes|partial|no> --confidence <high|medium|low> \
  --metrics "<metric>=<score>" --reasoning "commit <hash>; <what changed and what the feedback said>"
```

Then update the idea's outcome with `upsert_idea --update-on-exist`, passing all its fields again. When
the feedback names a problem type, file it (below) so the next attempt sees it,
and add it to the agent's todo list for the next iteration.
A `cheating` or `unusable` verdict is a result too: record it with
`--verdict no` and the reason.

### Problems

`problem:root` is the gap between the current deliverable and the target.
Other problems are its sub-problems, attached by `--parent`:

```bash
node "$WIKI_SCRIPT" add_problem research-wiki/ --slug long-inputs-truncated \
  --title "long inputs are truncated" --parent "problem:root" \
  --status open --severity high --statement "..." --origin "feedback on s003" \
  --evidence "..." --what-would-solve "..."
```

`status` ∈ {`open`, `solved`, `refuted`, `deferred`}. Only `open` problems reach
the query pack. Close a problem with `--status solved --update-on-exist`, never
by deleting it.

### Claims

```bash
node "$WIKI_SCRIPT" add_claim research-wiki/ --slug thm-main-ub \
  --name "Main upper bound" --status unproven --statement "..." --update-on-exist
```

Claim `status` is the proof axis only: {`drafted`, `unproven`,
`sound-modulo-imports`, `verified`, `refuted`, `retracted`}. Empirical support
is carried by `supports`/`invalidates` edges from experiments, never written
into `status`.

## Key Rules

- **One source of truth for relationships**: `graph/edges.jsonl`. Page `Connections` sections are auto-generated views.
- **Canonical node IDs everywhere**: `paper:<slug>`, `idea:<id>`, `exp:<id>`, `claim:<id>`, `problem:<slug>`. Never use raw titles or inconsistent shorthands.
- **Failed ideas are the most valuable memory.** Never prune them from query_pack.
- **query_pack.md is hard-budgeted** at 8000 chars. Deterministic generation, not open-ended summarization.
- **Append to log.md for every mutation.** The log is the audit trail.
- **Scores come from validation.** Experiment metrics are the published `query` result for that submission; local measurements go in `--reasoning`, labelled as local.

## Acknowledgements

Inspired by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — "compile knowledge once, keep it current, don't re-derive on every query."
