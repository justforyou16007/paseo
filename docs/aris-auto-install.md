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
| `.aris/tools/`               | Shell-script helpers (`save_trace.sh`, …)              |
| `.aris/dist/`                | Compiled TypeScript tools and MCP servers              |
| `.aris/node_modules/`        | Runtime dependencies for compiled tools (`commander`)  |
| `.aris/templates/`           | Project scaffolding templates                          |
| `.aris/installed-skills.txt` | TSV manifest; `project_root` is the runtime anchor     |

Copies, not symlinks — the project owns its skills, so upgrading the daemon
never silently changes a running project's behavior.

## Runtime contract

Skills resolve helpers from the project's local `.aris/` snapshot. They never
read `repo_root` from the manifest or `$ARIS_REPO` at runtime. The resolution
chain (documented in `integration-contract.md §2`):

| Layer | Path                        | When                                   |
| ----- | --------------------------- | -------------------------------------- |
| 1     | `.aris/dist/tools/<helper>` | Installed project                      |
| 2     | `dist/tools/<helper>`       | Dev: running from inside the ARIS repo |

Shell helpers: `.aris/tools/<helper>` → `tools/<helper>`.

`repo_root` is written to the manifest by the installer so `/aris-update` can
locate the source checkout. The installer itself never reads `repo_root` back
from the manifest — it resolves the source checkout independently each time.

## When it runs

Four call sites, all via `Session.backgroundInstallArisSkills()`:
`project.add`, `workspace.create`, `open_project`, and `create_agent` (only when
that request created the directory workspace). Worktree creation has its own
call in `worktree-session.ts`.

All of them are fire-and-forget: a failed or skipped install never blocks
workspace creation.

## Fail-closed semantics

The installer requires `dist/` and `node_modules/` in the source checkout.
If either is missing, the install fails with `runtime_incomplete` and no
manifest is written — the project will retry on next add.

A bare `git clone` of the ARIS repo has neither `dist/` nor `node_modules/`.
Run `npm install && npm run build` in the checkout before the daemon can
install from it.

## Repair

The manifest records every runtime file installed (`runtime_file` rows). On
revisit, the installer checks only those recorded files. If any are missing,
it restores only the missing files from the source checkout — sibling files
the project may have modified are not overwritten.

New files added to the source checkout after installation do not appear in the
project's recorded inventory. Only `/aris-update` adopts new source files
and writes updated `runtime_file` rows.

If the source checkout also lacks the file being restored, the installer logs
a warning and returns `runtime_incomplete`.

## Skipping and re-install

A project with `.aris/installed-skills.txt` and a complete runtime is skipped
(`skippedReason: "already_installed"`). To reinstall, delete both the manifest
and `.claude/skills/`, then re-add the project.

## Finding the ARIS checkout

Resolution order, first hit wins:

1. `$PASEO_ARIS_REPO`
2. `$ARIS_REPO`
3. `<paseo checkout>/packages/Auto-claude-code-research-in-sleep`
4. `$PASEO_HOME/aris`

**Only #3 works when the daemon runs from a source checkout.** A packaged
daemon — the Electron desktop app, Docker, or a global npm install — has no
monorepo above it and no ARIS bundled inside it, so #3 finds nothing.

Fix a packaged daemon by pointing it at a built checkout:

```bash
git clone <aris-repo> ~/.paseo/aris
cd ~/.paseo/aris && npm install && npm run build   # required for runtime
# or
export PASEO_ARIS_REPO=/path/to/built-aris
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
