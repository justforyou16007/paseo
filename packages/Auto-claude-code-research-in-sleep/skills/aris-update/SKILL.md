---
name: aris-update
description: 'Incremental update of ARIS skills in the current project. Compares installed skills against the upstream ARIS repo, shows a diff, applies changes, and provides adaptation guidance based on project progress. Protects project-generated skills (run-<project>-experiment). Use when user says "更新ARIS", "update aris", "sync skills", "升级skills", or after pulling new changes in the ARIS repo.'
argument-hint: "[— force] [— dry-run] [— aris-repo: <path>]"
allowed-tools: Bash(*), Read, Write, AskUserQuestion
---

# ARIS Update

Update ARIS skills in the current project: **$ARGUMENTS**

## Purpose

ARIS skills are copied into projects at install time and never auto-updated.
When the ARIS repo is updated (new skills, modified skills, updated tools),
project copies become stale. This skill performs an incremental update:
compare installed vs upstream, apply changes, and advise on adaptation.

**What it protects:**
- `run-<project>-experiment` and other project-generated skills (not in manifest)
- Skills with local modifications (skipped by default, `— force` to override)
- `.aris/env-config/` data (never touched)

**What it updates:**
- ARIS-sourced skills in `.claude/skills/` (tracked in manifest)
- ARIS-sourced agents in `.claude/agents/`
- `.aris/tools/`, `.aris/dist/`, `.aris/templates/`, `.aris/node_modules/`
- `.aris/installed-skills.txt` manifest

## Parameters

- `— force` — skip confirmation, overwrite all including locally modified skills
- `— dry-run` — show diff and adaptation advice only, change nothing
- `— aris-repo: <path>` — override ARIS repo path (instead of manifest/env)

---

## Phase 0: Pre-flight — Locate ARIS Source

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 1
MANIFEST=".aris/installed-skills.txt"
```

1. Verify manifest exists:
   ```bash
   test -f "$MANIFEST" || {
     echo "ERROR: .aris/installed-skills.txt not found."
     echo "ARIS has not been installed in this project."
     echo "Add this project in Paseo to trigger initial install."
     exit 1
   }
   ```

2. Resolve ARIS repo (priority: argument > env vars > manifest):
   ```bash
   # Parse — aris-repo from arguments if provided
   ARIS_REPO=""
   # ... argument parsing ...

   if [ -z "$ARIS_REPO" ]; then
     # Try env vars (same resolution as aris-auto-install.ts)
     for VAR in PASEO_ARIS_REPO ARIS_REPO; do
       eval "VAL=\${$VAR:-}"
       if [ -n "$VAL" ] && [ -d "$VAL/skills" ]; then
         ARIS_REPO="$VAL"
         break
       fi
     done
   fi

   if [ -z "$ARIS_REPO" ]; then
     # Fall back to manifest's repo_root
     ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' "$MANIFEST")
   fi

   test -d "$ARIS_REPO/skills" || {
     echo "ERROR: ARIS repo not found at '$ARIS_REPO'"
     echo "Specify with: /aris-update — aris-repo: /path/to/aris"
     exit 1
   }
   ```

3. Read manifest metadata:
   ```bash
   MANIFEST_VERSION=$(awk -F'\t' '$1=="version"{print $2; exit}' "$MANIFEST")
   MANIFEST_GENERATED=$(awk -F'\t' '$1=="generated"{print $2; exit}' "$MANIFEST")
   OLD_REPO_ROOT=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' "$MANIFEST")
   ```

4. Parse flags (`— force`, `— dry-run`) from `$ARGUMENTS`.

---

## Phase 1: Scan Installed and Upstream

### 1a. Parse installed entries from manifest

```bash
# Read entries after the header (lines after "kind\tname\t...")
# Each line: kind\tname\tsource_rel\ttarget_rel\tmode
INSTALLED_ENTRIES=()
while IFS=$'\t' read -r kind name source_rel target_rel mode; do
  [ "$kind" = "kind" ] && continue  # skip header
  [ -z "$kind" ] && continue
  INSTALLED_ENTRIES+=("$kind|$name|$source_rel|$target_rel")
done < <(awk -F'\t' 'NR>4' "$MANIFEST")
```

### 1b. Scan upstream skills

Replicate `aris-auto-install.ts` scan logic:

```bash
UPSTREAM_ENTRIES=()
EXCLUDE_NAMES="skills-codex.bak"
SUPPORT_NAMES="shared-references"

# Scan skills/
for dir in "$ARIS_REPO"/skills/*/; do
  name=$(basename "$dir")
  [[ "$EXCLUDE_NAMES" == *"$name"* ]] && continue

  if [[ "$SUPPORT_NAMES" == *"$name"* ]]; then
    UPSTREAM_ENTRIES+=("support|$name|skills/$name|.claude/skills/$name")
  elif [ -f "$dir/SKILL.md" ]; then
    UPSTREAM_ENTRIES+=("skill|$name|skills/$name|.claude/skills/$name")
  fi
done

# Scan agents/
for f in "$ARIS_REPO"/agents/*.md; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .md)
  UPSTREAM_ENTRIES+=("agent|$name|agents/$(basename "$f")|.claude/agents/$(basename "$f")")
done
```

---

## Phase 2: Compute Diff

For each upstream entry, classify:

```bash
ADD_LIST=()      # upstream has it, manifest doesn't
UPDATE_LIST=()   # both have it, files differ
UNCHANGED_LIST=()# both have it, files identical
LOCAL_MOD_LIST=() # differs from upstream but has local modifications

for upstream in "${UPSTREAM_ENTRIES[@]}"; do
  IFS='|' read -r u_kind u_name u_source u_target <<< "$upstream"
  SOURCE_PATH="$ARIS_REPO/$u_source"
  TARGET_PATH="$ROOT/$u_target"

  # Check if in installed manifest
  FOUND_IN_MANIFEST=false
  for installed in "${INSTALLED_ENTRIES[@]}"; do
    IFS='|' read -r i_kind i_name i_source i_target <<< "$installed"
    if [ "$i_name" = "$u_name" ]; then
      FOUND_IN_MANIFEST=true
      break
    fi
  done

  if [ "$FOUND_IN_MANIFEST" = "false" ]; then
    # New skill — not in manifest
    ADD_LIST+=("$upstream")
    continue
  fi

  if [ ! -e "$TARGET_PATH" ]; then
    # Was in manifest but target deleted — treat as ADD
    ADD_LIST+=("$upstream")
    continue
  fi

  # Compare source and target
  DIFF_OUTPUT=$(diff -rq \
    --exclude=__pycache__ --exclude=node_modules --exclude=.git \
    "$SOURCE_PATH" "$TARGET_PATH" 2>/dev/null)

  if [ -z "$DIFF_OUTPUT" ]; then
    UNCHANGED_LIST+=("$upstream")
  else
    # Files differ — is it because upstream changed or local modification?
    # Heuristic: count lines only in target vs lines only in source
    # If target has unique additions not in source → likely local modification
    if [ "$u_kind" != "agent" ]; then
      DIFF_DETAIL=$(diff -r \
        --exclude=__pycache__ --exclude=node_modules --exclude=.git \
        "$SOURCE_PATH" "$TARGET_PATH" 2>/dev/null || true)
      # Lines starting with "> " are in target but not in source (local additions)
      LOCAL_ADDITIONS=$(echo "$DIFF_DETAIL" | grep -c "^> " || true)
      if [ "$LOCAL_ADDITIONS" -gt 5 ] && [ "$FORCE" != "true" ]; then
        LOCAL_MOD_LIST+=("$upstream|$LOCAL_ADDITIONS additions")
        continue
      fi
    fi
    UPDATE_LIST+=("$upstream")
  fi
done

# Check for removed entries (in manifest but not in upstream)
REMOVED_LIST=()
for installed in "${INSTALLED_ENTRIES[@]}"; do
  IFS='|' read -r i_kind i_name i_source i_target <<< "$installed"
  FOUND_IN_UPSTREAM=false
  for upstream in "${UPSTREAM_ENTRIES[@]}"; do
    IFS='|' read -r u_kind u_name u_source u_target <<< "$upstream"
    [ "$u_name" = "$i_name" ] && FOUND_IN_UPSTREAM=true && break
  done
  [ "$FOUND_IN_UPSTREAM" = "false" ] && REMOVED_LIST+=("$installed")
done
```

Also check support directories for changes:

```bash
TOOLS_CHANGED=false
DIST_CHANGED=false
TEMPLATES_CHANGED=false

[ -d "$ARIS_REPO/tools" ] && [ -d ".aris/tools" ] && \
  diff -rq "$ARIS_REPO/tools" ".aris/tools" >/dev/null 2>&1 || TOOLS_CHANGED=true
[ -d "$ARIS_REPO/dist" ] && [ -d ".aris/dist" ] && \
  diff -rq "$ARIS_REPO/dist" ".aris/dist" >/dev/null 2>&1 || DIST_CHANGED=true
[ -d "$ARIS_REPO/templates" ] && [ -d ".aris/templates" ] && \
  diff -rq "$ARIS_REPO/templates" ".aris/templates" >/dev/null 2>&1 || TEMPLATES_CHANGED=true
```

---

## Phase 3: Display Summary and Confirm

Print the diff summary:

```
ARIS Update Summary
Source: $ARIS_REPO
Installed: $MANIFEST_GENERATED

New skills (${#ADD_LIST[@]}):
  + <name> (<kind>)

Updated skills (${#UPDATE_LIST[@]}):
  ~ <name> (<changed files count>)

Locally modified — skipped (${#LOCAL_MOD_LIST[@]}):
  ! <name> (<N> local additions — use --force to overwrite)

Removed from upstream (${#REMOVED_LIST[@]}):
  - <name> (will NOT be auto-deleted)

Unchanged: ${#UNCHANGED_LIST[@]}

Support directories:
  tools/     $([ "$TOOLS_CHANGED" = "true" ] && echo "~ changed" || echo "✓ up to date")
  dist/      $([ "$DIST_CHANGED" = "true" ] && echo "~ changed" || echo "✓ up to date")
  templates/ $([ "$TEMPLATES_CHANGED" = "true" ] && echo "~ changed" || echo "✓ up to date")
```

If nothing to update (all lists empty and no dir changes), print "Already up
to date" and skip to Phase 6 (adaptation analysis still runs).

If `— dry-run`, skip to Phase 6.

If not `— force`, use `AskUserQuestion` to confirm:

```
AskUserQuestion:
  header: "Confirm"
  question: "Apply the changes listed above?"
  options:
    - "Yes, apply all"
    - "Cancel"
```

On "Cancel": stop. On "Yes": proceed.

---

## Phase 4: Execute Update

```bash
ADDED=0
UPDATED=0

# Copy filter (match aris-auto-install.ts COPY_EXCLUDE_BASENAMES)
copy_filtered() {
  local src="$1" dst="$2"
  cp -R "$src" "$dst"
  # Remove excluded dirs if copied
  find "$dst" -type d \( -name __pycache__ -o -name node_modules -o -name .git \) \
    -exec rm -rf {} + 2>/dev/null || true
}

# ADD: new entries
for entry in "${ADD_LIST[@]}"; do
  IFS='|' read -r kind name source_rel target_rel <<< "$entry"
  mkdir -p "$(dirname "$ROOT/$target_rel")"
  copy_filtered "$ARIS_REPO/$source_rel" "$ROOT/$target_rel"
  ADDED=$((ADDED + 1))
  echo "  + $name"
done

# UPDATE: replace existing
for entry in "${UPDATE_LIST[@]}"; do
  IFS='|' read -r kind name source_rel target_rel <<< "$entry"
  rm -rf "$ROOT/$target_rel"
  copy_filtered "$ARIS_REPO/$source_rel" "$ROOT/$target_rel"
  UPDATED=$((UPDATED + 1))
  echo "  ~ $name"
done

# Sync support directories (no local modification risk)
for dir in tools dist node_modules templates; do
  if [ -d "$ARIS_REPO/$dir" ]; then
    rm -rf ".aris/$dir"
    if [ "$dir" = "node_modules" ]; then
      # node_modules copied unfiltered (match auto-install behavior)
      cp -R "$ARIS_REPO/$dir" ".aris/$dir"
    else
      copy_filtered "$ARIS_REPO/$dir" ".aris/$dir"
    fi
  fi
done
```

---

## Phase 5: Rewrite Manifest

Build a new manifest in the same format as `aris-auto-install.ts`:

```bash
# Merge: all upstream entries + removed entries that still exist locally
ALL_ENTRIES=()
for entry in "${UPSTREAM_ENTRIES[@]}"; do
  IFS='|' read -r kind name source_rel target_rel <<< "$entry"
  ALL_ENTRIES+=("$kind\t$name\t$source_rel\t$target_rel\tcopy")
done

# Write atomically (same pattern as auto-install)
TMP_MANIFEST="$MANIFEST.tmp.$$"
{
  printf 'version\t1\n'
  printf 'repo_root\t%s\n' "$ARIS_REPO"
  printf 'project_root\t%s\n' "$ROOT"
  printf 'generated\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'kind\tname\tsource_rel\ttarget_rel\tmode\n'
  for entry_line in "${ALL_ENTRIES[@]}"; do
    printf '%b\n' "$entry_line"
  done
} > "$TMP_MANIFEST"
mv "$TMP_MANIFEST" "$MANIFEST"
```

---

## Phase 6: Adaptation Analysis

After updating (or after dry-run diff), analyze the project's current progress
and advise the user on how to adapt to the new skill versions.

### 6a. Read project progress

```bash
PROJECT_SLUG=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')

# Setup state
SETUP_COMPLETE=false
if [ -f .aris/setup-state.json ]; then
  SETUP_COMPLETE=$(jq -r '.completed // false' .aris/setup-state.json 2>/dev/null)
fi

# CLAUDE.md
CLAUDE_MD_EXISTS=$(test -f CLAUDE.md && echo true || echo false)

# Experiment environment
ENV_JSON=".claude/skills/run-${PROJECT_SLUG}-experiment/env.json"
ENV_STATUS="none"
if [ -f "$ENV_JSON" ]; then
  ENV_STATUS=$(jq -r '.status // "unknown"' "$ENV_JSON" 2>/dev/null)
fi

# Experiment tracker
TRACKER_STATUS="none"
if [ -f refine-logs/EXPERIMENT_TRACKER.md ]; then
  # Count non-header rows that don't say DONE
  ACTIVE_ROWS=$(grep -c '|.*|.*|.*RUNNING\|PENDING\|QUEUED' refine-logs/EXPERIMENT_TRACKER.md 2>/dev/null || echo 0)
  DONE_ROWS=$(grep -c '|.*|.*|.*DONE\|COMPLETED' refine-logs/EXPERIMENT_TRACKER.md 2>/dev/null || echo 0)
  if [ "$ACTIVE_ROWS" -gt 0 ]; then
    TRACKER_STATUS="active ($ACTIVE_ROWS running, $DONE_ROWS completed)"
  elif [ "$DONE_ROWS" -gt 0 ]; then
    TRACKER_STATUS="completed ($DONE_ROWS experiments)"
  else
    TRACKER_STATUS="initialized"
  fi
fi

# Wiki
WIKI_STATUS=$(test -d research-wiki && echo "initialized" || echo "none")
```

### 6b. Map updated skills to adaptation actions

For each skill in UPDATE_LIST (and ADD_LIST for new capabilities), determine
the impact on the current project:

```bash
print_adaptation() {
  echo ""
  echo "=== Adaptation Advice ==="
  echo ""
  echo "Project status:"
  echo "  Setup:       $([ "$SETUP_COMPLETE" = "true" ] && echo "complete" || echo "not started")"
  echo "  CLAUDE.md:   $([ "$CLAUDE_MD_EXISTS" = "true" ] && echo "exists" || echo "missing")"
  echo "  Environment: $ENV_STATUS"
  echo "  Experiments: $TRACKER_STATUS"
  echo "  Wiki:        $WIKI_STATUS"
  echo ""

  HAS_ADVICE=false

  for entry in "${UPDATE_LIST[@]}"; do
    IFS='|' read -r kind name source_rel target_rel <<< "$entry"
    case "$name" in
      experiment-env-configuration|experiment-env-audit)
        if [ "$ENV_STATUS" = "complete" ]; then
          HAS_ADVICE=true
          echo "  ⚠ $name updated — environment config may need re-validation."
          echo "    Run: /experiment-env-manager — mode: audit"
          echo ""
        fi
        ;;
      experiment-env-manager)
        if [ "$ENV_STATUS" = "complete" ]; then
          HAS_ADVICE=true
          echo "  ⚠ $name updated — environment manager changed."
          echo "    Run: /experiment-env-manager — mode: audit"
          echo ""
        fi
        ;;
      auto-research-loop)
        if [ "$TRACKER_STATUS" != "none" ]; then
          HAS_ADVICE=true
          echo "  ✓ $name updated — next iteration will use the new version automatically."
          echo ""
        fi
        ;;
      research-setup)
        if [ "$SETUP_COMPLETE" = "true" ]; then
          HAS_ADVICE=true
          echo "  ✓ $name updated — completed setup is not affected."
          echo "    New projects will use the updated setup wizard."
          echo ""
        fi
        ;;
      run-experiment|experiment-bridge|experiment-queue)
        if [ "$TRACKER_STATUS" != "none" ] && echo "$TRACKER_STATUS" | grep -q "active"; then
          HAS_ADVICE=true
          echo "  ℹ $name updated — currently running experiments are not affected."
          echo "    Next deployment will use the new version."
          echo ""
        fi
        ;;
      shared-references)
        HAS_ADVICE=true
        echo "  ⚠ $name updated — shared protocols changed."
        echo "    All skills will use updated protocols on next invocation."
        echo ""
        ;;
      research-wiki|wiki-enrich)
        if [ "$WIKI_STATUS" = "initialized" ]; then
          HAS_ADVICE=true
          echo "  ✓ $name updated — wiki operations will use new version on next call."
          echo ""
        fi
        ;;
      *)
        ;;
    esac
  done

  # Report new skills that might be useful
  for entry in "${ADD_LIST[@]}"; do
    IFS='|' read -r kind name source_rel target_rel <<< "$entry"
    if [ "$kind" = "skill" ]; then
      DESC=$(head -5 "$ROOT/$target_rel/SKILL.md" 2>/dev/null | grep "^description:" | sed "s/^description: '//;s/'$//" || echo "")
      HAS_ADVICE=true
      echo "  ℹ New skill: /$name"
      [ -n "$DESC" ] && echo "    $DESC"
      echo ""
    fi
  done

  if [ "$HAS_ADVICE" = "false" ]; then
    echo "  No specific adaptation needed. All updates take effect on next skill invocation."
    echo ""
  fi

  echo "To reload skills in the current session: reopen the project or run /reload-skills"
}
```

### 6c. Print final report

```
=== ARIS Update Complete ===

Added:   $ADDED skills/agents
Updated: $UPDATED skills/agents
Skipped: ${#LOCAL_MOD_LIST[@]} (locally modified)
Source:  $ARIS_REPO
Manifest updated: .aris/installed-skills.txt

<adaptation advice from 6b>
```

---

## Constants

- **EXCLUDE_NAMES** = `skills-codex.bak`
- **SUPPORT_NAMES** = `shared-references`
- **COPY_EXCLUDE_BASENAMES** = `__pycache__`, `node_modules`, `.git`
- **LOCAL_MOD_THRESHOLD** = 5 (lines of local additions before flagging as locally modified)

## Critical Rules

1. **Never touch project-generated skills.** Only update entries tracked in the
   manifest. `run-<project>-experiment` and other generated skills are not in
   the manifest and are never modified.
2. **Never delete skills.** Skills removed from upstream are reported but not
   deleted from the project. The user decides.
3. **Respect local modifications.** By default, skip skills where the target
   has local additions not in the upstream source. `— force` overrides this.
4. **Atomic manifest write.** Write to a temp file then `mv`, matching the
   auto-install pattern.
5. **Match auto-install copy behavior.** Use the same exclusion list
   (`__pycache__`, `node_modules`, `.git`). Copy `node_modules` unfiltered
   (same as `copyDirUnfiltered` in auto-install).
6. **Always run adaptation analysis.** Even on `— dry-run` or when nothing
   changed, show the project progress and any relevant advice.
