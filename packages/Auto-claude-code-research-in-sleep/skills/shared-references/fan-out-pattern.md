# Fan-Out Pattern

> **Compliance**: This file is governed by
> [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) Global
> Rule 1 (One Agent = One Skill) and Rule 4 (Paseo MCP Only, Strict).
> The single fan-out primitive is `mcp__paseo__create_agent` × N. The
> legacy 3-tier host-`Agent`-tool ladder is **removed**.

When a skill needs **breadth** — many candidate ideas, many sources, many
attack angles, many proof obligations, many draft sections — it may fan
the generation step out across same-family subagents. This document is
the canonical convention for doing that **without** weakening the
cross-model jury that the entire ARIS design rests on.

Rule of thumb: **Fan-out is 火力 (firepower); the jury is 裁判席 (the
bench). Subagents GENERATE candidates; they NEVER score them.** Fan-out
multiplies how much breadth you can cover per unit time. It does not, and
must not, change _who renders the verdict_. The verdict stays a single,
heterogeneous, cross-model step — identical whether you fanned out across
8 parallel workers or ran one shard at a time on a slow night.

## Core principle: decouple FAN-OUT from JURY

These are two different operations and they are governed by two different
rules:

|                           | FAN-OUT (breadth)                                      | JURY (verdict)                                         |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| What it does              | Generates N candidate items                            | Renders the STOP/ACCEPT decision                       |
| Who runs it               | Same-family subagents (Claude clones, or codex shards) | A **different** model family (`reviewer-routing.md`)   |
| Allowed to judge quality? | **No.** Generate only.                                 | **Yes.** That is its only job.                         |
| Failure if violated       | None (it's just more candidates)                       | Invariant breach: model judges its own family's output |
| Analogy                   | 火力 — fire more shots                                 | 裁判席 — the bench that rules                          |

The decoupling is the whole point. A subagent that both generates a
candidate _and_ decides whether it is good has collapsed the two
operations and re-introduced exactly the correlated blind spot that
heterogeneous review exists to remove. A Claude subagent generating an
idea, then a Claude orchestrator declaring that idea "novel" or
"publishable," is a Claude judging Claude — the invariant is dead, no
matter how many subagents were involved.

So the contract on every shard is narrow and absolute:

- ✅ A shard MAY: enumerate, draft, propose, retrieve, hypothesize,
  decompose, attack — i.e., emit candidate items.
- ❌ A shard MUST NOT: rank candidates against each other, declare one
  "best," assert novelty/soundness/publishability, decide the loop is
  done, or otherwise render the acceptance verdict.

Mechanical operations on the merged candidate set (deduplication,
clustering, schema validation, sorting by a declared field) are **not**
judgment and are explicitly allowed on the executor — see
§ Structured-output contract.

## The unified fan-out pattern: Paseo N-subagent

Fan-out is a **single, substrate-agnostic pattern** under the Global
Rules: spawn **N Paseo sub-agents** (one per shard) with
`mcp__paseo__create_agent`, each with `notifyOnFinish: true`. The
parent collects N push notifications, reads N receipt files, runs
mechanical dedup, then forwards the deduped set to the cross-model
jury. Per Global Rule 1, every shard is a separate agent executing
exactly one skill.

The dispatch substrate has **two** runtime properties (NOT tiers):

  - **Claude sub-agents** can run in parallel. The Paseo MCP allows
    concurrent `create_agent` calls; each child runs in its own
    context; the parent receives N `notifyOnFinish` events and reads
    N receipt files.
  - **Codex sub-agents** must run sequentially. Concurrent codex
    sub-agents hang on shared resources (see
    [`skills/kill-argument/SKILL.md`](../kill-argument/SKILL.md) line
    165-170). For codex-shard fan-out, the parent issues
    `create_agent` calls one at a time and waits for each receipt
    before issuing the next.

The legacy 3-tier ladder (ultracode / `Agent` tool / sequential) is
**removed**. Per Global Rule 4, the host `Agent` tool is forbidden in
ARIS workflows; per Global Rule 1, all fan-out shards are
Paseo-spawned sub-agents.

```
            ┌─────────────────────────────────────────┐
   N        │                                          │
Paseo  ──┐  │  merged union → mechanical dedup (SAFE)  │ ──► CROSS-MODEL JURY
shards ──┘  │     (executor-side, NOT judgment)        │      (identical step)
            └─────────────────────────────────────────┘
       (all Paseo)         (same)                          (same — invariant)
```

**The jury invariant is strictly orthogonal to whether subagents
exist.** A single sequential pass that runs each shard in a fresh
context (e.g. for codex serial fan-out) must produce a verdict from
the _same_ cross-model jury as a parallel Claude fan-out across
N workers. The dispatch substrate changes; the jury step does not.
Degrading the dispatch is free; degrading the verdict is a breach.

Known failure mode: a skill author "optimizes" by letting the
single sequential pass _also_ pick the winner, because there is no
parallel orchestrator to do it. That is self-acquittal smuggled in
through the substrate. Even sequential fan-out still ends at the
cross-model jury; the sequential pass only generates.

## Structured-output contract for shards

Every shard returns a **structured result set**, not prose, so the merge +
dedup + jury steps can operate mechanically. There are two envelope shapes,
chosen by what the shard does — but they share one invariant: `shard_id` + a
keyed list + a `dedup_key` per item.

**Generation fan-out** — the shard _produces_ new candidates (idea lenses,
attack axes, draft variants). Returns `candidates[]`:

```json
{
  "shard_id": "lens:scaling-regime",
  "candidates": [
    {
      "kind": "idea | attack | draft_section",
      "payload": "<the produced item — domain fields may be inlined instead>",
      "provenance": "<which lens/seed produced it>",
      "dedup_key": "<normalized string for mechanical clustering>"
    }
  ]
}
```

**Extraction fan-out** — the shard _reads_ a fixed input set and reports the
units it finds (papers in a verified set, obligations in a proof). Returns
`entries[]` with the same per-item keys, except `dedup_key` is the unit's
**pre-existing canonical id** (assigned upstream), not a freshly normalized
string:

```json
{
  "shard_id": "section:4.2",
  "entries": [
    {
      "kind": "source | proof_obligation",
      "payload": "<the extracted record — domain fields may be inlined>",
      "dedup_key": "<canonical id already assigned upstream: arXiv id / DOI / MC-17>"
    }
  ]
}
```

The `dedup_key` is what makes mechanical clustering possible without judgment:
for generation, normalize titles / claim-stems / obligation-statements to a
canonical string and cluster on string match / near-match; for extraction, the
canonical id already identifies the unit. No model decides "are these the
same?" by _taste_ — the key decides by _normalization rule_. Domain-specific
fields (an idea's hypothesis, a paper's method) may be inlined alongside these
keys rather than buried in an opaque `payload`.

### Dedup discipline

Deduplication runs on the merged union, **on the executor (Claude),
BEFORE the jury**, and is **SAFE** because it is mechanical, not
judgment:

- ✅ Cluster candidates by `dedup_key` (exact + near-match on a declared
  metric).
- ✅ Drop exact duplicates; collapse near-duplicates into one
  representative + a count.
- ✅ Sort/limit by a _declared field_ (e.g. keep top-K by retrieval
  score the source already returned).
- ❌ Drop a candidate because the executor _thinks_ it's weak — that is
  quality judgment and belongs to the jury.
- ❌ Re-rank candidates by the executor's own quality opinion before the
  jury sees them — that pre-filters the jury's input with same-family
  judgment.

Required ordering: **dedup BEFORE jury, on the merged union.** This is
not just hygiene — it is a cost-control invariant. The jury backend
(codex GPT-5.5 / Gemini / oracle-pro) is the rate-limited,
token-expensive resource. Sending it 40 candidates of which 25 are
near-duplicate is a waste of the scarce cross-model budget and invites
rate-limit failure mid-verdict. Mechanical dedup on the cheap
same-family side, first, keeps the expensive heterogeneous step lean.

```
fan-out (N shards) → merge union → mechanical dedup (Claude, SAFE) → CROSS-MODEL JURY
                                   └ cheap, judgment-free,            └ expensive, rate-limited,
                                     shrinks the jury's input set       sees a deduped set only
```

## When to fan out — and when NOT to

Fan out when the task is **breadth-bound**: its quality scales with how
much of the candidate space you cover, and coverage is the bottleneck.

| Fan out (breadth-bound)             | Do NOT fan out (value IS the single jury)              |
| ----------------------------------- | ------------------------------------------------------ |
| Idea generation across lenses       | `/novelty-check` — the verdict IS the product          |
| Literature retrieval across sources | `/research-review` — single heterogeneous critique     |
| Attack-angle enumeration            | `/experiment-audit` — one cross-model integrity ruling |
| Proof-obligation extraction         | `/peer-review` meta-review — one external verdict      |
| Draft-section first passes          | Any skill whose output _is_ the acceptance decision    |

Known failure mode (the one to refuse in review): fanning out a
**judgment** skill across Claude clones. `/novelty-check`,
`/research-review`, `/experiment-audit`, and the `/peer-review`
meta-review do not have a breadth bottleneck — their entire value is the
_single heterogeneous jury verdict_. Spawning eight Claude subagents to
each "assess novelty" and then aggregating their opinions does not give
you eight independent reviews; it gives you eight **correlated** Claude
opinions (same family, same blind spots) dressed up as a panel. Worse,
it dilutes the invariant: the aggregate now _looks_ like a review but
was never adjudicated by a different model family. If a skill's deliverable
is a verdict, you may fan out the _evidence-gathering_ that feeds the
verdict, but the verdict itself stays a single cross-model call.

One-liner to apply at review time: **fan out the search for candidates;
never fan out the bench.**

## Worked examples (real ARIS skills)

### `/kill-argument` — sequential codex sub-agent fan-out (substrate property, not a tier)

`/kill-argument` is the canonical proof that fan-out is a prompt pattern,
not a harness feature. It runs **two** fresh `mcp__paseo__create_agent`
codex sub-agents in series — Thread 1 writes the strongest 200-word
rejection memo; Thread 2 (independent, no `send_agent_prompt` to the
same agent) decomposes that memo into 3-7 atomic rejection points and
adjudicates each. The sequential ordering is mandated by the
**substrate property** that concurrent codex sub-agents hang (see
`skills/kill-argument/SKILL.md:165-170`); the parent issues the second
`create_agent` only after reading the first sub-agent's receipt file.
The "fan" is the decomposition into per-point obligations, run
sequentially with context reset between sub-agents. The jury here is
cross-model by construction — both sub-agents are GPT-5.5 adjudicating
a Claude-executor's paper, and **the skill code computes the final
verdict from per-point counts; the codex sub-agent is forbidden from
emitting the top-level verdict** (`Verdict is computed by the skill,
not by the adjudicator`). Generation (the attack, the per-point
classification) fans out; the ACCEPT/FAIL mapping is mechanical and
lives in the skill, not the model.

### `/idea-creator` — Paseo N-subagent lens fan-out → dedup → existing cross-model jury

`/idea-creator` fans out idea generation across analytic _lenses_
(structural gaps: method-in-A-not-B, contradictory findings, untested
assumptions, unexplored scaling regimes — Phase 1). The parent spawns
5 Paseo sub-agents (one per lens) via `mcp__paseo__create_agent` with
`notifyOnFinish: true`. Claude sub-agents run in parallel (the Paseo
MCP allows concurrent `create_agent` calls); the parent collects 5
push notifications, reads 5 receipt files, then runs **mechanical
dedup only** (cluster near-identical ideas; never drop one for being
"weak"). The **jury** is the already-existing Phase-4 cross-model
devil's-advocate pass: a fresh paseo codex sub-agent
(`provider: "codex/gpt-5.5"`) reads the deduped set cold and emits the
strongest reviewer objection per idea.

> ⚠️ **Known gap — idea-creator is an _aspirational_ example here, not yet a clean one.**
> Today `/idea-creator` Phase 3 (`skills/idea-creator/SKILL.md:159,175`)
> does same-family _quick novelty check + feasibility gating_ and
> **eliminates ideas** before the Phase-4 cross-model jury ever sees them.
> That is exactly the ❌ "executor pre-filters the jury's input with
> same-family quality judgment" this doc forbids above — a Type-B
> novelty/quality verdict made same-family (see
> [`acceptance-gate.md`](acceptance-gate.md)). The fan-out refactor must
> push all novelty/quality elimination INTO (or after) the Phase-4
> cross-model jury; Phase 3 keeps only mechanical dedup + _objective_
> feasibility (compute/time budget), and every non-duplicate idea reaches
> the jury. Fixing this is part of fanning the skill out, not a separate
> chore.

### `/research-lit` — per-source fan-out, deterministic gate as "jury"

`/research-lit` fans out retrieval across sources (arXiv, Semantic
Scholar, OpenAlex, Exa, DeepXiv, Zotero, web) under integration-contract
**Policy D2** (multi-source aggregate: invoke every resolved source,
warn-and-continue on per-source failure, proceed if ≥1 contributed).
Here the "jury" is **not** an LLM at all — it is the **deterministic**
`verify_papers.py` gate (Policy D1: 3-layer arXiv / CrossRef / S2
cross-check), which decides KEEP / `[UNVERIFIED]` by mechanical
cross-reference, not by taste. This is the **near-zero-risk** corner of
the design space: the candidate generators are same-family (or just API
fetchers), but the acceptance gate is a deterministic external verifier,
so there is no same-family-self-judgment risk to begin with. When the
"jury" is a deterministic check rather than a model verdict, the
cross-model-family rule is automatically satisfied (a process is not a
model family). Fan out freely.

## Shard safety invariants

Two invariants keep a fan-out from manufacturing or laundering errors:

- **Shards are read-only on shared artifacts.** A shard may read the repo/workspace and
  return its findings; it must NOT write shared state, mutate files the executor or other
  shards also touch, or rank/drop another shard's output. The _only_ write is the
  post-merge executor write, after dedup. This forecloses silent world-model divergence
  (parallel agents mutating a shared workspace and integrating into conflicts only
  discovered at composition time).
- **Don't inherit the upstream premise unchecked.** When a phase's jury reviews work built
  on a load-bearing upstream artifact (a prior phase's claim, a cited number, an earlier
  agent's conclusion), give the jury the _path to that upstream artifact_ and ask it to
  check the dependency, not just the local step. Otherwise one plausible-but-wrong upstream
  assertion is treated as ground truth and amplified down the chain — a cascading
  hallucination that compounds instead of self-correcting.

## Cross-references

- **`reviewer-routing.md`** — jury backend selection. The cross-model
  jury step routes through Codex MCP (`gpt-5.5`, `xhigh`) by default, or
  Oracle MCP (`gpt-5.5-pro`) under `— reviewer: oracle-pro`. Fan-out
  tier never changes the jury backend.
- **`reviewer-independence.md`** — the jury call receives **file paths
  only**, in a **fresh thread**, with no executor summary/interpretation.
  This applies to the post-fan-out jury exactly as to any other review:
  the deduped candidate set is handed over as artifacts the reviewer
  reads itself, not as the executor's pre-digested ranking.
- **`acceptance-gate.md`** — when self-judgment is allowed. Self-judging
  EXECUTION-completeness (exit code, files exist, N shards returned, PDF
  compiled) is SAFE same-model; self-judging QUALITY/CORRECTNESS (idea
  novel, proof valid, claim supported, review satisfied) MUST be
  cross-model. A fan-out loop may self-verify _that all N shards ran_; it
  may not self-verify _that the candidates are good_. The loop can DRIVE;
  it cannot ACQUIT.
- **`integration-contract.md`** — fan-out across sources/helpers uses the
  §2 resolver chain and the Policy D1/D2 failure policies; the jury step,
  when load-bearing, needs an artifact + verdict schema like any audit.

## Required components for a fan-out skill

A SKILL that fans out must specify all of:

1. **Paseo N-subagent dispatch.** State the parent dispatches N
   `mcp__paseo__create_agent` calls with `notifyOnFinish: true`; each
   sub-agent runs exactly one skill (per Global Rule 1). Identify which
   sub-agent type is used (Claude: parallel; codex: serial substrate
   property). Cite
   [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) in the
   skill body.
2. **Per-shard structured output.** Each shard returns a structured object
   keyed by `shard_id`, never prose. A _generation_ fan-out (e.g.
   idea-creator's lenses) returns `candidates[]`, each item carrying a
   `dedup_key`. An _extraction_ fan-out over a fixed input set (e.g.
   research-lit per-paper, proof-checker per-section) returns `entries[]`,
   each item carrying its canonical id as the `dedup_key`. Either shape:
   `shard_id` + a keyed list + a dedup/identity key per item.
3. **Mechanical dedup before the jury.** On the merged union, on the
   executor, judgment-free, declared metric — to control jury cost and
   rate-limit exposure.
4. **A single cross-model jury step** (per
   [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md) +
   [`reviewer-independence.md`](reviewer-independence.md)) — OR a
   deterministic verifier gate — that is **identical** regardless of
   whether fan-out is parallel (Claude) or sequential (codex).
5. **A breadth-bound justification.** State why this task benefits from
   breadth. If the deliverable IS a verdict, do not fan out the verdict;
   fan out only the evidence that feeds it.

## Allowed-tools hygiene — the Paseo grant policy

`mcp__paseo__create_agent` in a skill's `allowed-tools` frontmatter is
the capability gate for **Paseo N-subagent fan-out** (per Global Rule
4). It is **granted only to skills whose body actually fans out** —
i.e. whose prose instructs the parent to spawn N Paseo sub-agents via
`create_agent`. It is **not** boilerplate to be copied across skills.

The host `Agent` tool is **forbidden** in ARIS workflows per Global
Rule 4. A skill that previously granted `Agent` for the legacy Tier-2
form MUST be migrated to the Paseo primitive. As of this rewrite the
four fan-out skills (`idea-creator`, `research-lit`, `proof-checker`,
`analyse-tool`) all already have `mcp__paseo__create_agent` in their
`allowed-tools`; the legacy `Agent` grant becomes a no-op and is being
removed (see follow-up commit).

**Re-granting rule.** A skill that adds genuine fan-out introduces
`mcp__paseo__create_agent` to its `allowed-tools` **in the same change
that adds the fan-out prose**, and that prose must cite
[`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) so the
grant is self-justifying. Grant tracks usage; never the reverse.
**Also: any mainline skill that grants `Agent` is rejected.** The
forbidden list is enforced at the schema level — see
`tools/check_skills_inventory.py`.

**Enforcement.** `tools/check_skills_inventory.py` fails the drift
check if any mainline skill grants `Agent` (forbidden per Rule 4), or
grants `mcp__paseo__create_agent` without citing
`paseo-subagent-dispatch.md` in its body. This keeps vestigial grants
from creeping back and guarantees every real grant is traceable to
the convention it follows.
