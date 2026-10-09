---
name: aris-update
description: 'Update a project from a standalone Auto Research Loop archive while preserving task, benchmark, wiki and local edits. Use when the user asks to update ARL or ARIS.'
---

# Update Auto Research Loop

Use a new extracted ARL archive. No Paseo source checkout or daemon installer is involved.

1. Read `.aris/install.json` for the installed provider.
2. Preview the update from the new archive:
   `bash /path/to/arl/install.sh --provider <claude|codex> --project "$PWD" --dry-run`.
3. Run the same command without `--dry-run` to apply an authorized update. The installer refuses changed managed files; preserve those edits before using `--force` if the owner requests replacement.
4. If setup has already been applied, run `node .aris/dist/tools/setup-cli.js apply --project .` to refresh the provider role block. An unchanged configuration retains its existing confirmation; changed configuration needs review and confirmation again.
5. Reopen the provider session to load updated skills and MCP config. Codex must trust the project.

The package owns only the files recorded in `.aris/install.json`. It does not overwrite the task, setup state, submissions, benchmark, wiki, or generated experiment skills. It installs no subagent definitions. Keep the archive outside the project runtime while installing or updating.
