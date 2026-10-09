# Auto Research Loop

**Agent-driven research with independent benchmark validation.**

[中文](README.zh-CN.md) · [Quick start](#quick-start) · [Setup guide](SETUP_GUIDE.md) · [Architecture](ARIS_ARCHITECTURE_GUIDE.md)

Give Claude Code or Codex a task, a measurable target and a submission budget. Auto Research Loop (ARL) lets a worker agent develop a solution, submit it for independent evaluation and improve it using measured scores and reviewed feedback.

ARL is designed for benchmark-driven coding, model evaluation and experimental research. The worker chooses how to plan and implement the task. A separate validation machine owns the hidden benchmark and evaluates each submission against the same frozen criteria.

Use the official **Paseo** app and CLI to run and monitor agents on both machines. ARL installs its own skills and helpers into your projects as a standalone package.

## Features

| Capability | What you get |
| --- | --- |
| **Claude Code and Codex** | Provider-specific project installation, role instructions and MCP configuration. |
| **Independent validation** | Separate worker and validation projects on two machines. The worker interacts with validation through only `submit` and `query`. |
| **Frozen benchmarks** | Pinned benchmark code, data, evaluation settings and targets. Integrity checks reject changes to the frozen benchmark. |
| **Measured scores** | Scores derived from complete per-sample benchmark results, with checks for sample counts and aggregate consistency. |
| **Submission review** | A validation agent reviews each artifact for cheating or usability issues and runs the benchmark. Cheating and unusable submissions receive no eligible score. |
| **Reviewed feedback** | Checks for hidden sample identifiers and content hold feedback for revision before publication. |
| **Defined stopping conditions** | The task completes when a valid score reaches the target, or closes when the submission budget is exhausted. Further submissions are refused. |
| **Research records** | A project-local wiki for papers, ideas, claims, problems and submission history, accessible through the skill or Markdown files. |
| **Worker tools** | Project skills for research records, browser access and SSH experiment queues. |
| **Environment usage skills** | Setup turns your environment requirements into a verified project-specific skill for running and managing experiments. |
| **Standalone installation** | A checksum-verified archive with compiled helpers and runtime dependencies. Project-local updates preserve research data and unrelated provider configuration. |

Upload and infrastructure failures do not consume the submission budget. Reviewed submissions do, including those judged cheating or unusable.

## How it works

1. **Define the task.** Put the same `task.md` on both machines. Configure the validation benchmark, target and submission budget, then review and freeze the configuration.
2. **Build a solution.** The worker plans, codes and experiments in its own environment, without access to the validation machine's hidden data.
3. **Submit an artifact.** The worker calls `submit`, receives a temporary single-use upload URL and uploads a zip containing the solution and `USAGE.md`.
4. **Evaluate independently.** The service starts a validation agent through official Paseo. The agent reviews the artifact, runs the frozen benchmark and prepares feedback for publication.
5. **Improve or finish.** The worker calls `query` for status, score and published feedback. It continues until the task reaches `completed` or `closed`.

Keep the two projects on separate machines without a shared or synchronized directory. That separation keeps the hidden benchmark outside the worker's environment. See the [architecture guide](ARIS_ARCHITECTURE_GUIDE.md) for evaluation and feedback boundaries.

## Quick start

### Prerequisites

On each machine, install:

- **Node.js 22.12+**, **Bash**, **curl** and **tar**.
- **Claude Code or Codex**, authenticated for the provider you choose.
- The official **Paseo app and CLI**, with its daemon running.

The validation machine also needs your benchmark's dependencies. On Windows, run the installer in Git Bash with Node.js on `PATH`; see the [setup guide](SETUP_GUIDE.md) for Windows command paths and networking.

### Install into each project

Download the installer once on each machine:

```bash
curl -fsSL "https://raw.githubusercontent.com/justforyou16007/paseo/arl/distribution/install-arl.sh" -o /tmp/install-arl.sh
```

For **Claude Code**:

```bash
bash /tmp/install-arl.sh --provider claude --project /path/to/project
```

For **Codex**:

```bash
bash /tmp/install-arl.sh --provider codex --project /path/to/project
```

Choose one provider per project. The installer downloads and verifies the standalone archive; the target machine needs no source checkout, build step or `npm install`. Codex projects must be trusted to load their project MCP configuration.

### Configure the two roles

Add both projects to official Paseo and open an agent using the installed provider.

| Step | Claude Code | Codex |
| --- | --- | --- |
| Set up the validation project first | `/aris-setup validation` | Invoke `$aris-setup` with the `validation` role |
| Set up the worker project | `/aris-setup worker` | Invoke `$aris-setup` with the `worker` role |

On the validation machine, review the setup sheet, approve its configuration and start the generated `aris-validation` service. Transfer its worker connection URL and token privately to the worker machine. Configure the worker connection and, when an environment PRD is provided, setup generates and verifies its environment usage skill. Run `reload-skills` in your client to load the skills, reopen the worker session for its MCP configuration and ask it to work on `task.md`.

Follow the **[full setup guide](SETUP_GUIDE.md)** or **[中文部署指南](SETUP_GUIDE_CN.md)** for benchmark setup, networking, offline installation, updates and troubleshooting.

## Included skills

The standalone package ships six core skills:

| Skill | Purpose |
| --- | --- |
| [`aris-setup`](skills/aris-setup/SKILL.md) | Configure and confirm the role, then generate the requested environment usage skill. |
| [`validation-review`](skills/validation-review/SKILL.md) | Review a submission and produce benchmark-backed results. |
| [`research-wiki`](skills/research-wiki/SKILL.md) | Maintain and retrieve research records. |
| [`browser-act`](skills/browser-act/SKILL.md) | Access rendered pages and browser sessions through the external browser-act CLI. |
| [`experiment-queue`](skills/experiment-queue/SKILL.md) | Schedule batches on an SSH execution host using the environment usage skill. |
| [`experiment-env-configuration`](skills/experiment-env-configuration/SKILL.md) | Generate, verify or repair the environment usage skill within setup or during operation. |

Setup also produces `run-<project>-experiment` when you configure an environment. Browser runtimes and experiment host dependencies are installed separately when needed. Update or repair ARL by rerunning the installer for the same provider and project; see the [setup guide](SETUP_GUIDE.md#update-or-repair).

The `.aris/` project directory remains stable. Optional literature, GPU platform and notification integrations are available in the source repository; they are not included in the standalone archive.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Setup guide](SETUP_GUIDE.md) / [中文部署指南](SETUP_GUIDE_CN.md) | Deploying the two machines and operating your installation. |
| [Architecture](ARIS_ARCHITECTURE_GUIDE.md) | Understanding task state, benchmark integrity, scoring and validation boundaries. |
| [Agent guide](AGENT_GUIDE.md) | Choosing skills and finding project records. |
| [Contributing](CONTRIBUTING.md) | Developing ARL and running focused checks. |
| [Packaging](docs/arl-install.md) | Building the archive and understanding installation ownership. |

## License

[MIT](LICENSE). Original ARIS copyright and attribution are retained.
