---
name: overleaf-sync
description: 'Two-way sync between a local paper directory and an Overleaf project, so agents edit the local copy while collaborators edit in the Overleaf web UI. Use when user says "同步 overleaf", "overleaf sync", "推送到 overleaf", "connect overleaf", "Overleaf 桥接", "pull overleaf", "push overleaf", or wants to bridge a paper directory with an Overleaf project.'
argument-hint: [setup <project-id> | pull | push | status]
allowed-tools: Bash(*), Read, Grep, Glob, Edit, Write
---

# Overleaf Sync

Bridge a local `paper/` directory with an Overleaf project through the Overleaf Git bridge (a Premium feature). Collaborators keep editing in the web UI; agents read and edit the local copy and push back.

The agent **never sees the authentication token**. The owner does the one-time setup in their own terminal, and the token goes straight into the operating system's git credential store (Windows Credential Manager, macOS Keychain, or git's in-memory cache on Linux), never into chat, a file, a command line or a URL.

The helper is `node .aris/dist/tools/overleaf-cli.js` (see [integration-contract.md](../shared-references/integration-contract.md)). It works the same on Windows, macOS and Linux.

## Layout

```
paper/            ◄── mirror ──►   paper-overleaf/   ◄── git pull/push ──►   Overleaf web
(agents edit)                      (git bridge clone)                         (collaborators)
```

`paper-overleaf/` is a git clone of the Overleaf project, a sibling of `paper/`, never inside it. `overleaf-cli.js mirror` keeps the two in step; it skips `.git`, OS litter and LaTeX build output, and with `--dry-run` only lists what differs.

At any moment one side is authoritative. Switch direction explicitly with `pull` or `push`, and run `status` first to catch divergence.

## `setup <project-id>`: one time, by the owner

Tell the owner:

```
Run this in your own terminal (PowerShell, Windows Terminal or a shell), not through me:

    node .aris/dist/tools/overleaf-cli.js setup <project-id-or-url>

If its helper is missing, build the ARL source and install this optional integration first. Tell me "setup done" when it finishes.
```

Setup refuses to run without an interactive terminal, reads the token from a hidden prompt, stores it with the credential helper, clones with a token-free URL and installs a `pre-commit` hook in `paper-overleaf/.git/hooks/` that rejects any staged `olp_...` token.

After "setup done", verify without touching the token:

```bash
git -C paper-overleaf remote -v                        # URL has no token
git -C paper-overleaf config --get credential.helper
git -C paper-overleaf fetch                            # succeeds without a prompt
node .aris/dist/tools/overleaf-cli.js audit .          # "clean": true
```

If the Overleaf project is empty, continue with `push` to fill it from `paper/`.

## `pull`: before each editing session

```bash
git -C paper-overleaf pull --ff-only
git -C paper-overleaf diff --stat HEAD@{1}..HEAD
git -C paper-overleaf diff HEAD@{1}..HEAD -- sec/
```

Do not copy the whole clone over `paper/`. Decide per hunk:

| Hunk                                | Action                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Clean editorial change              | Apply to `paper/`                                          |
| Changed number or claim             | Apply, then check it against the validation results       |
| New or changed `\cite{...}`         | Apply, then check the reference exists and says what's cited |
| Half-finished sentence, typo        | Show the owner; do not apply                               |
| New section or restructure          | Stop and ask the owner                                     |

Apply approved hunks with the Edit tool, or copy whole approved files.

## `push`: after local editing

```bash
git -C paper-overleaf pull --ff-only                                    # 1. surface remote drift first
node .aris/dist/tools/overleaf-cli.js mirror paper paper-overleaf       # 2. make the clone match paper/
git -C paper-overleaf status --short                                    # 3. review
git -C paper-overleaf diff --stat
git -C paper-overleaf add -A                                            # 4. commit and push
git -C paper-overleaf commit -m "<what changed and why>"
git -C paper-overleaf push
```

If step 1 pulled anything, stop: those edits are not in `paper/` yet, and the mirror would delete them. Run `pull` first.

Push writes to a shared project. Show the owner `git diff --stat` and a representative prose hunk, and wait for confirmation unless they said `auto: true` up front.

Commit messages say what changed and where it came from, for example `sec/3: rewrite method after submission s004 feedback` or `sec/5: update numbers from the s006 validation result`.

## `status`

```bash
git -C paper-overleaf fetch
git -C paper-overleaf log --oneline HEAD..@{u}                          # Overleaf ahead
git -C paper-overleaf log --oneline @{u}..HEAD                          # unpushed local commits
node .aris/dist/tools/overleaf-cli.js mirror paper paper-overleaf --dry-run   # paper/ vs clone
```

| Overleaf ahead | `paper/` differs from the clone | Meaning                | Action                           |
| :------------: | :-----------------------------: | ---------------------- | -------------------------------- |
|       No       |               No                | Clean                  | Nothing                          |
|      Yes       |               No                | New Overleaf edits     | `pull`                           |
|       No       |               Yes               | Unsynced local edits   | `push`                           |
|      Yes       |               Yes               | Diverged               | Stop and show the owner          |

## Conflicts

If `git pull --ff-only` fails, never run a merging `git pull`, `git reset --hard` or `git push --force`. Show the owner `git log @{u} ^HEAD` (Overleaf commits) and `git log HEAD ^@{u}` (local commits) and ask which side to take per file, or have them merge in Overleaf and pull again.

## Token rules

The guards that do not depend on the agent behaving:

- `setup` needs an interactive terminal and reads the token hidden.
- The token goes only to the credential helper; the remote URL never holds it.
- The `pre-commit` hook rejects staged `olp_[A-Za-z0-9]{20,}`.
- `audit` scans the working tree, remote URLs, git history and common credential files, and prints locations only.

The agent's rules:

- Never ask for a token. If the owner pastes one into chat, tell them to revoke it at https://www.overleaf.com/user/settings and run `setup` again.
- Never write a token to a file, environment variable, command line or URL.
- On `401 Unauthorized`, the stored token expired: ask the owner to run `setup` again in their terminal.

## Editing on both sides

While the owner edits in Overleaf, agents only read `paper/` until `pull` runs. While an agent edits `paper/`, the owner pauses Overleaf editing until `push` runs. When unsure, run `status`.

## Output

- `paper-overleaf/` at the project root: a token-free git clone of the Overleaf project.
- After each `pull` or `push`, one line to the owner: commits pulled or pushed, files changed, and the Overleaf project URL.

Overleaf Git bridge docs: https://www.overleaf.com/learn/how-to/Using_Git_and_GitHub
