# Wiki helper resolution chain

Canonical resolution chain for the research-wiki helper. Used by every
SKILL that touches the wiki -- never hard-code `node .aris/dist/tools/research-wiki.js`,
because that silently fails when `.aris/dist/tools/` is not on disk
(the normal state before `/aris-update` has run), exactly the failure mode that
left a real user's `research-wiki/` empty for a week.

## The chain

```bash
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1
WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
```

After the chain runs, exactly one of two outcomes:

- `[ -f "$WIKI_SCRIPT" ]` -- helper located, use as `node "$WIKI_SCRIPT" <subcommand>`
- `[ ! -f "$WIKI_SCRIPT" ]` -- helper missing; pick a variant below

## Variant A -- hard-fail (for `/research-wiki` itself)

The skill **is** the wiki tool. If the helper is missing, fail loudly.

```bash
[ -f "$WIKI_SCRIPT" ] || {
  echo "ERROR: research-wiki.js not found at .aris/dist/tools/ or dist/tools/." >&2
  echo "       Fix: run /aris-update to refresh the project runtime." >&2
  exit 1
}
```

## Variant B -- warn + skip (for caller skills)

Used by `/idea-creator`, `/result-to-claim`, `/research-lit`, `/arxiv`,
`/alphaxiv`, `/deepxiv`, `/exa-search`, `/semantic-scholar`. The
skill's primary output (idea ranking, claim verdict, paper summary)
must still be delivered to the user; only the wiki side-effect is
skipped.

```bash
[ -f "$WIKI_SCRIPT" ] || {
  echo "WARN: research-wiki.js not found at .aris/dist/tools/ or dist/tools/." >&2
  echo "      Primary output will still be produced; wiki update is skipped." >&2
  echo "      Fix: run /aris-update to refresh the project runtime." >&2
  WIKI_SCRIPT=""
}
```

After Variant B, every helper invocation must be guarded:

```bash
[ -n "$WIKI_SCRIPT" ] && node "$WIKI_SCRIPT" ingest_paper research-wiki/ --arxiv-id "$id"
```

## Why two locations and not one

Two locations correspond to two legitimate install / dev paths:

| Location                              | When applicable                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `.aris/dist/tools/research-wiki.js`   | Installed into the project when ARIS runs `/aris-update` (Paseo installs on add)    |
| `dist/tools/research-wiki.js`         | Running a SKILL from inside the ARIS repo itself                                    |

Order matters: the installed copy is preferred because it is what a
normal project has; the repo-local copy is second because it catches
dev runs inside the ARIS repo.

## What NOT to add

- Do not add a 3rd layer that reads `$ARIS_REPO`. Runtime must never
  read `ARIS_REPO`; only the installer and `/aris-update` may use it.
- Do not add a layer at `~/.local/share/aris/...` or `/usr/local/share/...`
  -- no installer precedent in ARIS today.

Project-root discovery (walking up to find `.aris/installed-skills.txt`)
is part of the canonical resolver in `integration-contract.md §2`.
The helper resolution itself stays flat — always `.aris/dist/tools/` then
`dist/tools/` from the discovered root.

If resolution fails, the fix is always: **run `/aris-update` to refresh
the project runtime.**

## See also

- [`integration-contract.md`](integration-contract.md) $2 -- canonical-helper invariant
- `skills/research-wiki/SKILL.md` -- the wiki tool itself; uses Variant A
- PR #193 -- the parallel fix for `experiment-queue` helpers (same pattern, different helper)
