# ARIS Agent Guide

For agents reading this package cold. This file routes you to the right skill; the skill's `SKILL.md` is the specification and wins over anything here.

## What ARIS is

ARIS runs one task as a contest between two machines:

- The **worker** machine has one Claude Code agent with `task.md`, its own environment and its own research wiki. It builds a deliverable and submits it.
- The **validation** machine runs the `aris-validation` service. It owns a frozen benchmark the worker never sees, starts one validation agent per submission, and publishes a verdict, a score and desensitized feedback.

The two sides share nothing but the service's two MCP tools, `submit` and `query`. Each machine runs Paseo, so the owner watches both sides' agents in the Paseo app. Everything else (planning, coding, training, debugging, delegating to subagents) is the agent's own work; ARIS adds no workflow for it.

Your role is in `CLAUDE.md` between the `ARIS ROLE` markers. If there is none, the project is not set up: run `/aris-setup worker` or `/aris-setup validation`.

## Skills

| Skill | Role | Use it to |
| --- | --- | --- |
| `/aris-setup` | both | Configure this machine as worker or validation through one editable review sheet |
| `/aris-update` | both | Refresh the installed skills and `.aris/` runtime from the ARIS checkout |
| `/validation-review` | validation | Review one submission (the service starts an agent with it) |
| `/research-wiki` | both | Record papers, ideas, submissions, claims and problems; the knowledge graph in Paseo reads it |
| `/experiment-env-configuration` | both | Turn an environment PRD into generated run scripts with a repair loop |
| `/experiment-queue` | both | Queue many experiment jobs on GPUs |
| `/vast-gpu`, `/serverless-modal`, `/qzcli` | both | Rent or submit to GPU platforms |
| `/arxiv`, `/deepxiv`, `/exa-search`, `/openalex`, `/semantic-scholar` | both | Literature search; results go to the wiki |
| `/feishu-notify` | both | Push events to Feishu when `~/.claude/feishu.json` exists |
| `/overleaf-sync` | both | Pull and push an Overleaf project through its Git bridge |

## Helpers

Skills call compiled helpers with `node .aris/dist/tools/<helper>.js` from the project root. Which skill uses which helper, and what to do when one fails, is in [integration-contract.md](skills/shared-references/integration-contract.md). Never write a helper's output by hand.

## Where things live

| Path | Owner | Contents |
| --- | --- | --- |
| `task.md` | owner | The task, identical on both machines |
| `.aris/setup-*.json`, `.aris/setup-review.md` | `setup-cli.js` | Draft, review sheet and confirmed configuration |
| `.aris/tester-config.json` | `setup-cli.js` | Frozen benchmark (validation) |
| `.aris/validation/` | `validation-cli.js` | Frozen terms, service token, submissions and published results (validation) |
| `.mcp.json` | `setup-cli.js` | `aris-validation` server URL and token (worker; keep it out of git) |
| `paseo.json` | `setup-cli.js` | `aris-validation` service script (validation) |
| `research-wiki/` | `research-wiki.js` | Wiki pages, edges and the generated index |

Architecture and design rationale: [ARIS_ARCHITECTURE_GUIDE.md](ARIS_ARCHITECTURE_GUIDE.md). Installing both machines: [SETUP_GUIDE.md](SETUP_GUIDE.md).
