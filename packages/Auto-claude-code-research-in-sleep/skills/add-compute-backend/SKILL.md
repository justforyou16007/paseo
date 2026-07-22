---
name: add-compute-backend
description: 'Scaffold a new compute backend for the ARIS experiment environment. Generates the backend class, factory registration, schema, CLAUDE.md template block, and test stubs. Use when user says "add backend", "new compute backend", "add slurm", "add k8s", "添加计算后端", or wants to integrate a new GPU/compute provider.'
argument-hint: "[backend-name] [— description: ...]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# Add Compute Backend

Scaffold a new experiment environment backend: **$ARGUMENTS**

## Overview

ARIS experiment skills (`/run-experiment`, `/experiment-bridge`, `/experiment-queue`, etc.) all dispatch through a unified `EnvBackend` interface with 7 lifecycle methods. This skill automates the 6-file scaffolding needed to add a new backend.

```
Phase 0  Pre-flight: resolve paths, check for name collisions
Phase 1  Collect backend identity (name, category, prerequisites)
Phase 2  Collect configuration schema (fields, types, defaults)
Phase 3  Collect deployment mechanism (submit, sync, monitor, collect)
Phase 4  Generate code (6 touch points)
Phase 5  Build & verify (typecheck, compile, smoke test)
Phase 6  Summary & next steps
```

**Touch points generated:**

| # | File | Action |
|---|------|--------|
| 1 | `src/tools/experiment-env/<name>-env.ts` | Create backend class |
| 2 | `src/tools/experiment-env/env-backend.ts` | Register in factory |
| 3 | `src/tools/experiment-env/parse-env.ts` | Add ENV_TYPE + schema |
| 4 | `templates/CLAUDE_MD_TEMPLATE.md` | Add config template block |
| 5 | `tests/experiment_env/test_backends.py` | Add factory + deploy test |
| 6 | `tests/experiment_env/test_parse_env.py` | Add schema validation test |

---

## Phase 0: Pre-flight

1. **Resolve ARIS root.** Use `git rev-parse --show-toplevel` or derive from `$CLAUDE_SKILL_DIR` (strip `/skills/add-compute-backend`). Set `$ARIS_ROOT`.

2. **Verify target files exist** (hard-fail if any missing):
   - `$ARIS_ROOT/src/tools/experiment-env/env-backend.ts`
   - `$ARIS_ROOT/src/tools/experiment-env/parse-env.ts`
   - `$ARIS_ROOT/templates/CLAUDE_MD_TEMPLATE.md`
   - `$ARIS_ROOT/tests/experiment_env/test_backends.py`
   - `$ARIS_ROOT/tests/experiment_env/test_parse_env.py`

3. **Parse `$ARGUMENTS`** for the backend name (first word, lowercase). If `$ARGUMENTS` is empty or unclear, ask via Phase 1. If `$ARGUMENTS` contains `— description:`, extract the description.

4. **Check name collision:**
   - Grep the `ENV_TYPES` array in `parse-env.ts` for the name.
   - Check if `src/tools/experiment-env/<name>-env.ts` already exists.
   - If collision: ask user whether to overwrite or pick a different name.

5. **Read existing code** to understand current patterns:
   - Read `env-backend.ts` — the abstract class, `create()` factory, and `_announce()` method.
   - Read `parse-env.ts` — `ENV_TYPES`, `ENV_SCHEMAS`, `FieldSpec` interface.
   - Read the reference backend that matches the user's category (Phase 1 determines which).

---

## Phase 1: Collect Backend Identity

Use `AskUserQuestion` — up to 4 questions in one batch.

### Batch 1 (4 questions):

**Q1** — header: "Name", question: "Short identifier for this backend? (lowercase, no spaces — used as env_type, e.g. slurm, k8s, runpod)"
- If parsed from `$ARGUMENTS`, offer it as the first option.
- Validation after answer: must match `/^[a-z][a-z0-9_]*$/`, must not collide with existing `ENV_TYPES`.

**Q2** — header: "Description", question: "One-line description of this backend? (e.g. 'Slurm HPC cluster job scheduler')"
- If parsed from `$ARGUMENTS`, offer it as the first option.

**Q3** — header: "Category", question: "What kind of compute backend is this?"
- options:
  - `"SSH-based"` — description: "Jobs run on a remote server via SSH (like remote/vast)"
  - `"CLI-based"` — description: "Jobs managed via a local CLI tool (like modal)"
  - `"Container-based"` — description: "Jobs run inside containers (like docker)"
  - `"API-based"` — description: "Jobs submitted via REST API"

**Q4** — header: "Prerequisites", question: "What CLI tools or packages must be installed? (e.g. sbatch, kubectl, runpodctl)"
- options:
  - `"None"` — description: "No special CLI tools needed"

### Derive naming from Q1 answer:

```
name         = answer (lowercase, underscores ok)         e.g. "slurm"
kebab_name   = name with _ replaced by -                  e.g. "slurm"
pascal_name  = PascalCase                                 e.g. "Slurm"
class_name   = pascal_name + "Env"                        e.g. "SlurmEnv"
file_name    = kebab_name + "-env.ts"                     e.g. "slurm-env.ts"
```

### Select reference backend based on category:

| Category | Reference file | Why |
|----------|---------------|-----|
| SSH-based | `remote-env.ts` | SSH connectivity, screen deployment, rsync sync |
| CLI-based | `modal-env.ts` | CLI command dispatch, launcher generation |
| Container-based | `docker-env.ts` | Container lifecycle, state tracking |
| API-based | `remote-env.ts` | Closest starting point; user will customize |

**After Phase 1:** Read the selected reference backend file completely. This is the template for code generation in Phase 4.

---

## Phase 2: Collect Configuration Schema

Use `AskUserQuestion` — up to 4 questions.

### Batch 1 (4 questions):

**Q1** — header: "Required", question: "What configuration fields are REQUIRED? One per line: `name: type` (types: string, number, boolean, list, dict). Example: `partition: string, cluster_name: string`"
- options:
  - Provide a category-appropriate example as the first option:
    - SSH-based: `"ssh_alias: string, code_dir: string"`
    - CLI-based: `"gpu_type: string"`
    - Container-based: `"image: string"`
    - API-based: `"api_key: string, endpoint: string"`

**Q2** — header: "Optional", question: "What OPTIONAL fields? One per line: `name: type = default`. Example: `num_nodes: number = 1, timeout: number = 3600`"
- options:
  - `"None beyond the basics"` — description: "No additional optional fields"

**Q3** — header: "WandB", question: "Does this backend support Weights & Biases experiment tracking?"
- options:
  - `"Yes"` — description: "Adds wandb, wandb_project, wandb_entity fields automatically"
  - `"No"` — description: "No WandB integration"

**Q4** — header: "Cleanup", question: "Does this backend support automatic resource cleanup after experiments?"
- options:
  - `"Yes"` — description: "Adds auto_destroy boolean field (like Vast.ai)"
  - `"No"` — description: "Persistent resource, no auto-cleanup"

### Parse field definitions into structured data:

For each field, extract:
- `field_name: string` — the config key
- `field_type: FieldType` — one of `string | number | boolean | list | dict | string_or_number`
- `required: boolean`
- `default_value: unknown` — null for required fields, parsed from `= <value>` for optional

If WandB = "Yes", append: `wandb: boolean = false`, `wandb_project: string = null`, `wandb_entity: string = null`.

If auto-cleanup = "Yes", append: `auto_destroy: boolean = false`.

---

## Phase 3: Collect Deployment Mechanism

Use `AskUserQuestion` — up to 4 questions. These answers drive the code skeleton generated in Phase 4.

### Batch 1 (4 questions):

**Q1** — header: "Submit", question: "How are jobs submitted to this backend?"
- options:
  - `"SSH + screen"` — description: "SSH into a machine and launch in a screen session"
  - `"CLI command"` — description: "Run a local CLI tool (e.g. sbatch, kubectl apply, runpodctl)"
  - `"REST API"` — description: "HTTP POST to submit a job"
  - `"Docker run"` — description: "docker run with GPU passthrough"

**Q2** — header: "Sync", question: "How is code transferred to the compute environment?"
- options:
  - `"rsync over SSH"` — description: "rsync files to remote host"
  - `"git push/pull"` — description: "Push code and pull on remote"
  - `"Shared filesystem"` — description: "No sync needed (NFS, shared mount)"
  - `"Container copy"` — description: "Bundled into container image or volume"

**Q3** — header: "Monitor", question: "How do you check if a job is still running?"
- options:
  - `"SSH process check"` — description: "Check screen/process status over SSH"
  - `"CLI status command"` — description: "Run a status command (e.g. squeue, kubectl get pods)"
  - `"API polling"` — description: "Poll a status endpoint"
  - `"Log file tail"` — description: "Tail a log file for completion markers"

**Q4** — header: "Results", question: "How are results collected after the job finishes?"
- options:
  - `"rsync from remote"` — description: "rsync results directory back"
  - `"CLI download"` — description: "Download via CLI (e.g. kubectl cp, modal volume get)"
  - `"Shared filesystem"` — description: "Results already on local filesystem"
  - `"API download"` — description: "Fetch results via API"

---

## Phase 4: Generate Code

Execute all 6 touch points in order. After each file write/edit, announce what was done.

### 4a. Generate backend class file

**Target:** `$ARIS_ROOT/src/tools/experiment-env/<file_name>`

Generate a TypeScript file that:

1. Imports `{ EnvBackend, EnvError, runShell, shellQuote }` from `"./env-backend.js"`.
2. If the backend needs state tracking (container-based, API-based), also import `fs` and `path`.
3. Exports `class <class_name> extends EnvBackend`.
4. Implements all 7 abstract methods. Each method:
   - Checks `this.dryRun` first — if true, returns `this._announce("<action>", "<command>")`.
   - Reads configuration from `this.config.<field_name>` with proper type casting.
   - Returns `Record<string, unknown>` with a `status` field.
   - Includes a `// TODO: implement <specific detail>` comment where the user needs to add real logic.
5. Adds private helper methods appropriate to the category:
   - SSH-based: `_ssh()` returning the SSH command prefix, `_condaPrefix()` if conda is a config field.
   - CLI-based: `_cli()` returning the CLI tool command prefix.
   - Container-based: `_statePath()` for state file path.

**Use the reference backend** read in Phase 1 as the structural template. Adapt the command strings based on Phase 3 answers:

| Phase 3 answer | Code pattern |
|----------------|-------------|
| SSH + screen | `screen -dmS <name> bash -c '...'` via SSH |
| CLI command | `runShell("<cli-tool> <subcommand> ...")` |
| REST API | `// TODO: implement HTTP POST to <endpoint>` |
| Docker run | `docker run -d --gpus <gpus> ...` |
| rsync over SSH | `rsync -avz <src> <alias>:<dst>` |
| git push/pull | `git push && ssh <host> 'cd <dir> && git pull'` |
| Shared filesystem | no-op, return `{ status: "synced", method: "shared" }` |

The generated file should be **functional enough to typecheck** but mark implementation-specific details with `// TODO`. The 7 methods must all have correct return shapes.

### 4b. Register in factory

**Target:** `$ARIS_ROOT/src/tools/experiment-env/env-backend.ts`

Two edits inside the `create()` static method:

1. **Add lazy import** — insert in alphabetical order among the existing `require()` lines:
   ```typescript
   // eslint-disable-next-line @typescript-eslint/no-require-imports
   const { <class_name> } = require("./<kebab_name>-env.js") as typeof import("./<kebab_name>-env.js");
   ```

2. **Add registry entry** — insert in alphabetical order in the `registry` object:
   ```typescript
   <name>: <class_name>,
   ```

### 4c. Add schema

**Target:** `$ARIS_ROOT/src/tools/experiment-env/parse-env.ts`

Two edits:

1. **Add to `ENV_TYPES`** — insert the name in alphabetical order:
   ```typescript
   export const ENV_TYPES = ["docker", "<name>", "local", "modal", "remote", "vast"] as const;
   ```
   (Adjust alphabetical position based on the actual name.)

2. **Add schema block to `ENV_SCHEMAS`** — insert a new entry with all fields from Phase 2:
   ```typescript
   <name>: {
     <field_name>: { type: "<type>", required: <bool>, defaultValue: <default> },
     // ... for each field
   },
   ```

### 4d. Add template block

**Target:** `$ARIS_ROOT/templates/CLAUDE_MD_TEMPLATE.md`

Insert a new HTML-commented block in the `## Experiment Environment` section, after the last existing backend block:

```markdown
<!-- <DisplayName> (<description>)
- gpu: <name>
- <required_field_1>: <placeholder>
- <required_field_2>: <placeholder>
- <optional_field_1>: <default_value>
-->
```

### 4e. Add tests

**Target 1:** `$ARIS_ROOT/tests/experiment_env/test_backends.py`

Append:
1. A new test class `class <PascalName>DeployTests(unittest.TestCase):` with:
   - `test_deploy_dry_run` — creates the backend with `dry_run=True`, calls `deploy()` with a minimal `runSpec`, asserts result contains `status: "dry_run"`.

**Target 2:** `$ARIS_ROOT/tests/experiment_env/test_parse_env.py`

Append:
1. A new test class `class <PascalName>SchemaTests(unittest.TestCase):` with:
   - `test_valid_config_with_defaults` — validates a minimal config passes and default values are filled.
   - `test_required_field_missing` — validates that omitting a required field raises `ValidationError`.

### 4f. (Optional) Update research-setup

**Target:** `$ARIS_ROOT/skills/research-setup/SKILL.md`

In Phase 4, Batch 1:
- Add a new option to the GPU type selection question:
  ```
  - `"<DisplayName>"` — description: "<description>"
  ```

After "**If Local:**" block, add:
  ```
  **If <DisplayName>:**
  Use AskUserQuestion with N questions:
  - Q1 header "<field>", question: "<user-friendly question>"
    options: ...
  ```

---

## Phase 5: Build & Verify

Run these checks in order. If typecheck or build fails, read the error, fix the generated files, and retry (up to 3 attempts).

1. **TypeScript typecheck:**
   ```bash
   cd "$ARIS_ROOT" && npx tsc --noEmit --project tsconfig.json 2>&1 | head -50
   ```

2. **TypeScript build:**
   ```bash
   cd "$ARIS_ROOT" && npm run build 2>&1 | tail -20
   ```

3. **Factory smoke test** (post-build):
   ```bash
   node -e "
     const {EnvBackend} = require('$ARIS_ROOT/dist/tools/experiment-env/env-backend.js');
     const b = EnvBackend.create('<name>', {<minimal_required_config>}, '.', true);
     console.log(JSON.stringify(b.provision()));
   "
   ```
   Expected output: `{"status":"dry_run","action":"provision","command":"..."}`.

4. **Format:**
   ```bash
   cd "$ARIS_ROOT" && npm run format:files -- src/tools/experiment-env/<file_name> src/tools/experiment-env/env-backend.ts src/tools/experiment-env/parse-env.ts
   ```

If any step fails, read the error output, fix the offending generated code, and re-run. Do not proceed past a failing typecheck.

---

## Phase 6: Summary

Print a structured summary:

```
Backend "<name>" scaffolded successfully.

Created:
  src/tools/experiment-env/<file_name>              (<N> lines)

Modified:
  src/tools/experiment-env/env-backend.ts            (factory registration)
  src/tools/experiment-env/parse-env.ts              (ENV_TYPES + schema)
  templates/CLAUDE_MD_TEMPLATE.md                    (config template block)
  tests/experiment_env/test_backends.py              (factory + deploy test)
  tests/experiment_env/test_parse_env.py             (schema validation test)
  skills/research-setup/SKILL.md                     (Phase 4 GPU options)  [if updated]

Verification:
  TypeScript typecheck:  PASS/FAIL
  TypeScript build:      PASS/FAIL
  Factory smoke test:    PASS/FAIL
  Format:                PASS/FAIL

Next steps:
  1. Fill in TODO comments in src/tools/experiment-env/<file_name>
  2. Test locally: node dist/tools/experiment-env/env-helper.js provision --dry-run
  3. Add to your project: uncomment the <name> block in CLAUDE.md ## Experiment Environment
  4. Run /run-experiment to verify end-to-end
```

---

## Constants

- **SCHEMA_VERSION** = 1 (from `parse-env.ts`, do not change)
- **SUPPORTED_FIELD_TYPES** = `string | number | boolean | list | dict | string_or_number`
- **MAX_RETRY_ON_TYPECHECK_FAIL** = 3

## Error Handling

- If ARIS root cannot be resolved: hard fail with "This skill must run inside the ARIS repository."
- If target files are missing: hard fail with the list of missing files.
- If name collides with existing backend: ask user to confirm overwrite or choose a new name.
- If typecheck fails after 3 retries: print the errors and stop. Do not leave broken code.
- If build fails: print the error and stop. The user can fix manually.
