# ARIS auto-install

Paseo copies [ARIS](../packages/Auto-claude-code-research-in-sleep) skills into
a project the first time it sees that project. There is no install script — the
daemon does it.

Implementation: `packages/server/src/server/aris/aris-auto-install.ts`.

## What gets written

Into the project directory:

| Path                         | Contents                                               |
| ---------------------------- | ------------------------------------------------------ |
| `.claude/skills/<skill>/`    | One directory per ARIS skill, plus `shared-references` |
| `.claude/agents/<agent>.md`  | ARIS subagent definitions                              |
| `.aris/tools/`               | Helper scripts (`research_wiki.py`, …)                 |
| `.aris/installed-skills.txt` | TSV manifest; skills read `repo_root` from it          |

Copies, not symlinks — the project owns its skills, so upgrading the daemon
never silently changes a running project's behavior.

## When it runs

Four call sites, all via `Session.backgroundInstallArisSkills()`:
`project.add`, `workspace.create`, `open_project`, and `create_agent` (only when
that request created the directory workspace). Worktree creation has its own
call in `worktree-session.ts`.

All of them are fire-and-forget: a failed or skipped install never blocks
workspace creation.

## One-shot semantics

A project with `.aris/installed-skills.txt` is skipped
(`skippedReason: "already_installed"`). To reinstall, delete both the manifest
and `.claude/skills/`, then re-add the project.

## Finding the ARIS checkout

Resolution order, first hit wins:

1. `$PASEO_ARIS_REPO`
2. `$ARIS_REPO` — the same variable the ARIS skills use to locate their helpers
3. `<paseo checkout>/packages/Auto-claude-code-research-in-sleep`
4. `$PASEO_HOME/aris`

**Only #3 works when the daemon runs from a source checkout.** A packaged
daemon — the Electron desktop app, Docker, or a global npm install — has no
monorepo above it and no ARIS bundled inside it, so #3 finds nothing. This is
the gotcha: a remote user hitting a packaged daemon gets projects with an empty
`.claude/skills/` while a developer running `npm run dev` from the checkout sees
it work, and the two look identical from the UI.

Fix a packaged daemon by pointing it at a checkout:

```bash
git clone <aris-repo> ~/.paseo/aris     # option 4, no env var needed
# or
export PASEO_ARIS_REPO=/path/to/aris    # option 1
```

The resolver warns once per process when nothing resolves, listing every
location it tried — grep `$PASEO_HOME/daemon.log` for `ARIS auto-install`. A
successful install logs `ARIS skills auto-installed` with the skill count.

The resolved path is cached but revalidated on each use, so moving or deleting
the checkout does not leave the daemon stuck on a stale path, and a daemon that
started before ARIS was on disk picks it up on the next project add.

## Skill visibility in a running session

The copy takes seconds, and add-project → open-agent happen back to back, so an
agent's session can scan `.claude/skills/` mid-copy and cache a partial list.
Once the install completes, `AgentManager.reloadSkillsForDirectory()` re-scans
every live agent at or under that directory via the Claude SDK's
`Query.reloadSkills()` — the programmatic equivalent of typing `/reload-skills`.

Providers opt in through the optional `AgentSession.reloadSkills?()`; today only
Claude implements it.

The app's slash-command menu caches for 60s
(`SESSION_COMMANDS_STALE_TIME`), so the `/` popup can lag behind. That is
cosmetic: typing a skill name resolves server-side against the reloaded list
regardless of what the menu shows.
