# Reviewer Routing

## Default (NEVER changes without explicit user request)

All review calls use the **codex** reviewer (model `gpt-5.5`,
`reasoning_effort: xhigh`). The **default backend** is now a **paseo codex
sub-agent** (per [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md)) —
the cross-model reviewer is a real paseo agent, not an `mcp__codex__codex` MCP
tool call. `mcp__codex__codex` / `mcp__codex__codex-reply` remain as the
documented fallback when the paseo MCP server is unavailable.

This is the default for ALL skills. No parameter, no config, no effort level changes this.

### Paseo codex agent backend (default)

The codex reviewer is spawned by the Claude executor (a workflow agent or a
leaf verdict skill running inside one) as a paseo sub-agent:

- **Provider:** `codex/gpt-5.5` (cross-provider from the Claude executor —
  the cross-model invariant, `reviewer-independence.md`).
- **Mode:** `full-access` (default — autonomous repo read, network on, the
  `codex exec` analog) per `paseo-reviewer-dispatch.md`. `read-only` cannot
  write the verdict file; `auto-review` is Codex's _internal_ guardian, not
  our reviewer — do not confuse the names.
- **Thinking:** `settings.thinkingOptionId: "xhigh"` (verify the exact id for
  `gpt-5.5` via `mcp__paseo__list_models` / `inspect_provider`).
- **Continuity:** `create_agent` = fresh review (REVIEWER_BIAS_GUARD); `send_agent_prompt`
  to the same agent = continuation (reviewer memory, the `codex-reply` analog).
- **Cross-provider gotcha (load-bearing):** the spawn MUST pass explicit
  `settings.modeId` — cross-provider mode inheritance throws. This is the
  single most common reviewer-spawn bug. Full shape + the fresh-vs-continuation
  rule live in [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md).

The `codex exec` CLI (nightmare mode under `REVIEWER_DIFFICULTY=nightmare`)
maps to a paseo codex agent in `full-access` mode — autonomous repo read, same
semantics, now a real inspectable/archivable agent instead of a stateless
one-shot. The `nightmare` mode's "GPT reads repo directly" property is
preserved exactly; only the substrate changes.

When the paseo MCP server is unavailable, `— reviewer: codex` (or unset) falls
back to `mcp__codex__codex` / `codex-reply` — today's behavior, byte-for-byte.
The verdict, trace, and acceptance gate are identical on either path; only
the dispatch substrate changes.

## Optional: GPT-5.5 Pro via Oracle

When the user explicitly passes `— reviewer: oracle-pro`, route the review through Oracle MCP instead of Codex MCP.

### Routing Logic (add to any reviewer-invoking skill)

```
Parse $ARGUMENTS for `— reviewer:` directive.

If not specified OR `— reviewer: codex`:
    → Use mcp__codex__codex with reasoning_effort: xhigh
    → This is the DEFAULT. No change from current behavior.

If `— reviewer: oracle-pro`:
    → Check if mcp__oracle__consult tool is available
    → If available:
        Use mcp__oracle__consult with:
          model: "gpt-5.5-pro"
          prompt: [same prompt you would send to Codex]
          files: [file paths for reviewer to read directly]
        Note: Oracle may use API mode (fast, needs OPENAI_API_KEY)
              or browser mode (slow ~1-2 min, needs Chrome + ChatGPT login)
    → If NOT available:
        Print: "⚠️ Oracle MCP not installed. Falling back to Codex xhigh."
        Use mcp__codex__codex as normal.
```

### Invariants

- `— reviewer: oracle-pro` ONLY takes effect when explicitly passed
- Reviewer independence protocol still applies (pass file paths, not summaries)
- `effort` and `difficulty` are orthogonal — they don't change reviewer backend
- `beast` mode may RECOMMEND oracle-pro but never requires it
- Browser mode: acceptable for one-shot reviews; NOT recommended inside multi-round loops (too slow/brittle)

### Oracle MCP Call Format

```
mcp__oracle__consult:
  prompt: |
    [role + task + output schema]
    Read all listed files directly.
  model: "gpt-5.5-pro"
  files:
    - /absolute/path/to/file1
    - /absolute/path/to/file2
```

### Skills That Support `— reviewer: oracle-pro`

| Skill               | Use case for Pro                                    |
| ------------------- | --------------------------------------------------- |
| `/research-review`  | Deeper critique on paper drafts                     |
| `/auto-review-loop` | Final stress test (last round only in browser mode) |
| `/experiment-audit` | Line-by-line eval code audit                        |
| `/proof-checker`    | Deep mathematical reasoning                         |
| `/rebuttal`         | Stress test before submission                       |
| `/idea-creator`     | Idea evaluation depth                               |
| `/research-lit`     | Literature analysis depth                           |

### Installation

```bash
# Install Oracle CLI + MCP
npm install -g @steipete/oracle

# Add Oracle MCP to Claude Code
claude mcp add oracle -s user -- oracle-mcp

# Restart Claude Code session to load

# API mode (fast, recommended):
export OPENAI_API_KEY="your-key"

# Browser mode (no API key, slower):
# Just log in to ChatGPT in Chrome
```

### NOT installed = ZERO impact

If Oracle is not installed, `— reviewer: oracle-pro` gracefully falls back to Codex. No error, no breakage, just a warning.

### Upstream development & known issues

Oracle MCP is maintained at [`steipete/oracle`](https://github.com/steipete/oracle). When you invoke `— reviewer: oracle-pro` (and especially the `o3-deep-research` / `gpt-5.5-pro` paths), it's worth checking the **[open PRs](https://github.com/steipete/oracle/pulls)** for in-flight fixes that may affect your run — e.g., model routing changes, browser-mode auth fixes, rate-limit handling, or new model alias support. ARIS does not vendor Oracle MCP; you're running the published version from `npm install -g @steipete/oracle`. If a behavior surprises you, the upstream PR queue is the first place to check before opening an issue here.

## Optional: Gemini via Antigravity CLI (`— reviewer: agy`)

When the user explicitly passes `— reviewer: agy`, route the review through the **gemini-review MCP** with the Antigravity (`agy`) backend — a native cross-model reviewer for Antigravity users who don't run Codex MCP / Oracle. Added in [#267](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/267).

### Routing Logic (add to any reviewer-invoking skill)

```
Parse $ARGUMENTS for `— reviewer:` directive.

If `— reviewer: agy`:
    → Check if the gemini-review MCP tool is available (mcp__gemini_review__review).
    → If available (server configured with GEMINI_REVIEW_BACKEND=agy):
        Use mcp__gemini_review__review with:
          prompt: [same prompt you would send to Codex]
        For round 2+: mcp__gemini_review__review_reply with the saved threadId.
        For long paper/project reviews (avoid the ~120s MCP tool timeout):
          mcp__gemini_review__review_start + mcp__gemini_review__review_status (async).
    → If NOT available:
        Print: "⚠️ gemini-review (agy) MCP not configured. Falling back to Codex xhigh."
        Use mcp__codex__codex as normal.
```

### Invariants

- `— reviewer: agy` ONLY takes effect when explicitly passed.
- **Cross-model family holds by construction.** The `agy` backend is fail-closed on ARIS's invariant: it recovers the _actual_ Gemini-family model id from the current invocation's Antigravity transcript, **refuses** to return a verdict if the routed model is non-Gemini (no `"agy-cli"` placeholder), and binds the recovered transcript to _this_ call via a **user-event nonce** (a model echo can't spoof the binding). So when the executor is Claude, `— reviewer: agy` (Gemini) satisfies the cross-model gate.
- Reviewer independence still applies — pass prompt context only (the `tools` arg is accepted for compatibility but ignored).
- `effort` and `difficulty` are orthogonal — they don't change the reviewer backend.

### Install

```bash
# Install + authenticate the Antigravity CLI (`agy`), then add the MCP with the agy backend:
claude mcp add gemini-review --env GEMINI_REVIEW_BACKEND=agy -- python3 <path>/mcp-servers/gemini-review/server.py
# (codex mcp add gemini-review ... for Codex CLI). Without the env var the server defaults to the direct Gemini API.
```

### NOT installed = ZERO impact

If the gemini-review (agy) MCP isn't configured, `— reviewer: agy` gracefully falls back to Codex xhigh. No error, no breakage, just a warning.

## Optional: Manual Review (any model, zero API cost)

When the user explicitly passes `— reviewer: manual`, route the review through the manual-review MCP server. Instead of calling an API, it opens a browser page (or writes a file on headless Linux) where the user copies the prompt to any model and pastes the response back.

**Zero API cost. Works with any text-capable model.**

### Routing Logic

```
Parse $ARGUMENTS for `— reviewer:` directive.

If `— reviewer: manual`:
    → Check if mcp__manual_review__review tool is available
    → If available:
        Use mcp__manual_review__review with:
          prompt: [same prompt you would send to Codex]
          config: {"model_reasoning_effort": "xhigh"}
        For round 2+ in multi-round skills:
          Use mcp__manual_review__review_reply with:
            threadId: [saved from prior call]
            prompt: [follow-up prompt]
            config: {"model_reasoning_effort": "xhigh"}
    → If NOT available:
        Print: "⚠️ Manual Review MCP not installed. Install with: claude mcp add manual-review -s user -- python3 /path/to/mcp-servers/manual-review/server.py"
        STOP. Do NOT fall back to Codex (the target user likely has no Codex subscription).
```

### Invariants

- `— reviewer: manual` ONLY takes effect when explicitly passed
- **Cross-model family is mandatory, not optional.** "any model" above means any _non-executor-family_ model. When the executor is Claude (the normal case), the user MUST paste the prompt into a non-Claude model (ChatGPT / DeepSeek / Kimi / Gemini / a local model) — never any Claude product. Pasting into Claude makes Claude judge Claude, which silently voids the cross-model invariant and the verdict is worthless. The manual-review UI surfaces this as a banner; the routing contract requires it. A Type-B acceptance gate (`acceptance-gate.md`) is satisfied by `manual` only when the routed model is verifiably non-Claude.
- Prompt fidelity: the user sees the EXACT same prompt text that Codex would receive
- `config.model_reasoning_effort` is shown as a recommendation badge, not embedded in the prompt
- Thread continuity: `review_reply` shows previous exchanges so the user can maintain context in their chosen model
- Reviewer independence protocol still applies

### Thread continuity

For round 2+ in multi-round skills (`/auto-review-loop`, `/proof-checker` Phase 3):

- Use `mcp__manual_review__review_reply` with the saved `threadId`
- The browser page displays previous prompt/response exchanges
- The user should continue the conversation in the same model session for best results

### Installation

```bash
claude mcp add manual-review -s user -- python3 /path/to/mcp-servers/manual-review/server.py
```

### Modes

- **Browser mode** (default): opens a local web page on Windows/macOS/Linux desktop
- **File mode** (`MANUAL_REVIEW_MODE=file`): writes prompt to a per-thread subdirectory. Read `.aris/pending_review/pending_review.json` for the `prompt_file` and `response_file` paths — for headless/SSH environments

### Skills That Support `— reviewer: manual`

The following skills are wired for manual review (Claude Code only):

| Skill               | Manual support |
| ------------------- | -------------- |
| `/research-review`  | Yes            |
| `/auto-review-loop` | Yes            |
| `/experiment-audit` | Yes            |
| `/proof-checker`    | Yes            |
| `/rebuttal`         | Yes            |
| `/idea-creator`     | Yes            |

> `/research-lit` supports `oracle-pro` only; manual review is not wired because the skill has no reviewer call blocks.

> **Platform note**: Manual review requires MCP tools (available only in Claude Code). Mirrored skill packs under `skills/skills-codex/` and `skills/skills-codex-*-review/` do NOT include manual-review wiring — they target Codex CLI and other platforms that lack MCP support. Oracle-pro support in those mirrors is unaffected.

### Nightmare mode (Codex-only)

Manual review supports medium/hard MCP-style review. Codex-exec nightmare mode is Codex-only and must fail closed when reviewer is manual.

### NOT installed = explicit error (not silent fallback)

If manual-review MCP is not installed, `— reviewer: manual` prints install instructions and stops. It does NOT fall back to Codex — the target user likely has no Codex subscription, so a silent fallback would fail anyway.

### `codex exec` CLI is NOT an equivalent Codex backend

The mainline reviewer contract is now a **paseo codex sub-agent** (per
[`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md)), with
`mcp__codex__codex` + `mcp__codex__codex-reply` as the fallback when paseo MCP
is unavailable. Both the paseo agent and the MCP fallback rely on **thread
continuity** (e.g. `/idea-creator` Phase 4 runs its devil's-advocate triage as
a same-thread continuation — `send_agent_prompt` to the same agent, or
`codex-reply`), structured returns, and saved `threadId`/agent-id traces.
`codex exec --ephemeral` is a stateless one-shot — fine for a single
self-contained review, but NOT a drop-in replacement: hand-rewriting every
call to `codex exec` silently loses reply continuity and tends to mangle
SKILL.md instructions (observed in the wild as "the executor skips phases and
improvises" — issue #284). The `nightmare` difficulty's "GPT reads repo
directly" property is satisfied by a paseo codex agent in `full-access` mode,
NOT by a bare `codex exec` one-shot.

If Codex MCP is broken in your setup, prefer in order:

1. Use the paseo codex agent path (default) — `mcp__paseo__create_agent` with `provider:"codex/gpt-5.5"`, `modeId:"full-access"`, `thinkingOptionId:"xhigh"`.
2. Fix the MCP registration: `claude mcp add codex -s user -- codex mcp-server`, then `/mcp` in-session to (re)connect.
3. Codex-CLI-as-executor: use the native mirror pack [`skills/skills-codex/`](../skills-codex/) — designed to run inside Codex CLI without Claude-side MCP.
4. One-shot `codex exec` only for skills whose review is a single call with no follow-up reply.

### Future work

- `mcp__manual_review__generate_image`: manual alternative to `codex-image2` for paper illustrations
- Image review loop integration
