---
name: aris-update
description: 'Incremental update of the ARIS skills and runtime installed in the current project from an ARIS source checkout. Shows the diff, protects local edits, rewrites the install manifest. Use when user says "更新ARIS", "update aris", "sync skills", "升级skills".'
argument-hint: "[— force] [— dry-run] [— aris-repo: <path>]"
allowed-tools: Bash(*), Read, Write, AskUserQuestion
---

# ARIS Update

Update ARIS in the current project: **$ARGUMENTS**

Paseo copies ARIS into a project once and never updates the copy, so a running project does not change under the owner's feet. This skill brings the copy up to date on request. The installer is `packages/server/src/server/aris/aris-auto-install.ts`; this update must leave the project exactly as a fresh install from the same checkout would, except where the owner keeps a local edit.

- `— force`: overwrite locally modified skills without asking.
- `— dry-run`: show the diff and change nothing.
- `— aris-repo: <path>`: the source checkout. Otherwise `$PASEO_ARIS_REPO`, then `$ARIS_REPO`. The manifest's `repo_root` is not a fallback; with no source, stop and ask for one.

## 1. Check the source

Run from the project root. `.aris/installed-skills.txt` must exist; without it ARIS was never installed here (adding the project in Paseo installs it).

The source must be built: every `src/**/*.ts` has its `dist/**/*.js`, and every `dependencies` entry of its `package.json` is in `node_modules/`. Otherwise stop and tell the owner to run `npm install && npm run build` in the checkout.

## 2. Diff

Entries, as the installer defines them:

| Kind      | Source                                         | Target                        |
| --------- | ---------------------------------------------- | ----------------------------- |
| `skill`   | `skills/<name>/` with a `SKILL.md`             | `.claude/skills/<name>/`      |
| `support` | `skills/shared-references/`                    | `.claude/skills/shared-references/` |
| `agent`   | `agents/<name>.md`                             | `.claude/agents/<name>.md`    |
| runtime   | `dist/`, `tools/`, `templates/`, `node_modules/` | `.aris/<dir>/`              |

Skip `skills-codex.bak`. Compare with `diff -rq`, ignoring `__pycache__`, `node_modules` and `.git` inside skills. Classify every entry:

- **new**: in the source, not in the manifest or missing on disk;
- **changed**: both sides exist and differ;
- **locally modified**: changed, and the project copy has more than 5 lines the source lacks (`diff -r` lines starting with `> `);
- **removed upstream**: in the manifest, not in the source;
- **unchanged**.

Project-generated skills such as `run-<project>-experiment` are not in the manifest and are never touched. `.aris/env-config/`, `.aris/validation/` and the setup state files are project data and are never touched.

## 3. Confirm

Print the lists, then whether each runtime directory changed. On `— dry-run` stop here. Without `— force`, ask the owner once whether to apply; locally modified skills stay skipped unless they say otherwise.

## 4. Apply

- Copy new and changed entries over their targets (remove the target first), using the same exclusions.
- Replace `.aris/dist`, `.aris/tools`, `.aris/templates` and `.aris/node_modules` from the source; `node_modules` is copied unfiltered.
- Do not delete skills removed upstream; report them and let the owner decide.

## 5. Rewrite the manifest

Write it to a temporary file and `mv` it over `.aris/installed-skills.txt`. Format (tab-separated):

```
version	2
repo_root	<source checkout>
project_root	<project root>
generated	<UTC ISO time>
kind	name	source_rel	target_rel	mode
<kind>	<name>	<source_rel>	<target_rel>	copy        one row per source entry
runtime_file	<dist|tools|templates|node_modules>/<path>   one row per file now under .aris/
```

The installer repairs a project from the `runtime_file` rows, so they must list every file just copied and nothing else.

## 6. After the update

- If the project's experiment bundle declares `browser.required: true` in `.claude/skills/run-*-experiment/env.json`, run `node .aris/dist/tools/ensure-browser-act.js`. It also refreshes the `.claude/skills/browser-act/` stub, which is not an ARIS entry.
- If `templates/ROLE_WORKER.md` or `templates/ROLE_VALIDATION.md` changed and setup was applied here, rerun `node .aris/dist/tools/setup-cli.js apply --project .` so `CLAUDE.md` gets the new role block. Apply with an unchanged configuration needs no new confirmation.
- Tell the owner to reopen the Claude Code session so it loads the new skills.

Report what was added, updated, skipped and removed upstream.
