---
name: tester-setup
description: Stand up the tester as an agent in its own docker container, take the submission contract it declares, and hand the research side a config it can submit against.
allowed-tools: Read, Write, Bash(*)
---

# Tester Setup

Setup produces the seventh root setup item, `tester_agent_config`. Until it
exists, no formal outer run can start. Run the six steps in order; a failed
step is a setup failure, not something to route around.

## What the boundary actually rests on

The tester is a Claude agent in a docker container of its own, managed by the
Paseo daemon running inside that container. The research side reaches it only
through `docker exec` into that container. The Paseo CLI inside finds its own
daemon, so the daemon port does not have to be published to the host. Three
facts keep the tester's work private:

- The Ed25519 signing key is generated inside the container during deployment.
  Only the public half is copied out. Research can read the public key — it is
  public — and still cannot forge a receipt.
- The cases are written by the tester agent and never leave the container. What
  comes back is one signed envelope of ids, digests, enumerated values and the
  declared metric aggregates.
- Nothing the research side submits executes in the tester container. Each
  submission runs in a fresh container of its own, with the cases mounted
  read-only. The boundary is otherwise one-directional in the wrong place:
  research hands the tester code, and the tester would run it next to the key
  and the cases.

The first two hold only while the container's files are not visible from the
research side's filesystem. Keep the tester home inside the container or in a
named volume, never in a bind mount of a directory the research account can
read, and do not mount the research project into the tester container.

State the limit as well: the research process and the operator who runs this
setup share a uid that can run `docker`, so the research process can
technically `docker exec` into the tester container. This setup does not claim
to prevent that. It claims that the private key and the cases are not on the
research side's filesystem, and that the tester agent answers only two
requests.

## The container the tester lives in

Make it before step 1. Every tester container comes from one base image on the
docker host, `aris-tester-base:latest` unless `--image` names another.
`/aris-update` pulls it; ARIS never builds it. The image must:

- run the Paseo daemon, with the `claude` CLI and a docker client added;
- have the `paseo` account with uid 1000; `create-container` runs the whole
  container as that account;
- carry the tester's operating manual at `/opt/aris/TESTER_AGENT.md`, readable by
  `paseo`, byte for byte this ARIS version's
  `templates/tester-agent-bundle/TESTER_AGENT.md`.

`docker/tester-base/Dockerfile` builds one on Ubuntu 22.04 for x86_64, with the
manual copied from the same commit. `.github/workflows/aris-tester-image.yml`
publishes it as the public `ghcr.io/justforyou16007/aris-tester-base` on every
push to `paseo-aris` that changes the Dockerfile or the manual, tagged
`sha-<first 12 hex of the commit>`, `ubuntu22.04` and `latest`. Every
`/aris-update` runs `tester-agent-cli.js pull-image`, which pulls `latest`,
checks that its manual is this version's, and only then names it
`aris-tester-base:latest`; a mismatch leaves the local image as it was. An
ARIS checkout older than `latest` pulls the build that matches it by tag:

```text
tester-agent-cli.js pull-image --source ghcr.io/justforyou16007/aris-tester-base:sha-<commit>
```

An image built elsewhere has to put the manual in the same way, and you give
it the local name yourself or pass `--image`. Outside this repository, download
the manual from the matching commit:

```dockerfile
WORKDIR /opt/aris
ADD --chmod=644 https://raw.githubusercontent.com/<owner>/<repo>/<commit>/packages/Auto-claude-code-research-in-sleep/templates/tester-agent-bundle/TESTER_AGENT.md /opt/aris/TESTER_AGENT.md
```

Both modes matter. `ADD` saves a downloaded file as mode 600, so without
`--chmod=644` `paseo` cannot read it. But `--chmod` also applies to the parent
directories `ADD` creates, and a directory with mode 644 cannot be entered, so
`WORKDIR` creates `/opt/aris` first with mode 755; set `WORKDIR` back afterwards.
Nothing is ever copied into the tester container from outside; `deploy` only
checks that the manual is there and is this version's.

```text
tester-agent-cli.js create-container --name aris-tester
```

A base image that is not on the docker host stops `create-container` with
`TESTER_IMAGE_MISSING`; run `/aris-update` and run the command again.

`create-container` runs the image with the host's `/var/run/docker.sock` and a
named volume (`<name>-home`) mounted as `/home/paseo`, so the `claude` login
and the daemon's state survive a recreated container. A container of that name
made from the same image is started instead; one made from another image is
refused as `TESTER_CONTAINER_TAKEN`. The container runs as `paseo` from its
first process, and nothing in it runs as root. To reach the socket,
`create-container` reads the socket's group id in a throwaway container and
passes it as `--group-add`. Because the container already starts as `paseo`,
the Paseo entrypoint skips its switch from root to `paseo` (that switch would
reset the extra groups), so the daemon and every agent it starts keep the
group. Without it the tester agent gets "permission denied" on the socket.

Then log `claude` in once with `docker exec -it --user paseo aris-tester claude`.
These are the facts `probe` checks:

- `claude` is installed and the Paseo daemon inside answers.
- The container reaches a docker daemon through the mounted socket. Without it
  the tester has nowhere to run a submission, and `probe` reports
  `docker: false`.
- `paseo`, the account `create-container` prints as `container_user`, is the
  account the daemon runs as. Every command runs as that account, so the key
  and the receipts belong to the tester agent.

Both commands print their docker failure (code, step and the command) because
nothing in it comes from the tester; re-run the printed command by hand to see
docker's own output.

`tester-agent-cli.js` runs `docker` with whatever context the environment
selects. When the tester container lives on another docker host, point
`DOCKER_HOST` or the docker context there; nothing else changes.

## The six steps

| Step | Command | What a failure means |
| --- | --- | --- |
| 1. Probe | `tester-agent-cli.js probe --container … --user …` | The container is not running or cannot be entered as that account, its Paseo daemon does not answer, it has no `claude` binary, or it cannot reach a docker daemon. Fix the container; do not deploy. |
| 2. Deploy | `tester-agent-cli.js deploy --input <request> --output <deployment>` | `TESTER_MANUAL_MISMATCH`: the image has no manual, or another version's; run `/aris-update` to pull this version's image and recreate the container. `tester_deploy_failed`: the container layout, the key or the agent could not be created. Nothing downstream is valid. |
| 3. Declare | `tester-agent-cli.js declare --deployment <deployment> --need-file <need> --output <contract>` | The tester did not return a contract that verifies against its own key, or its runtime declaration or exclusion list was refused (see below). |
| 4. Emit policy | `search-audit-cli.js emit-policy --contract <contract> --project <path>` | The research side has no blocklist, so the guard would refuse every network call. |
| 5. Install guard | `search-audit-cli.js install-guard --project <path>` | The hook is not in `.claude/settings.json` and the ledger was never opened. `submit` refuses. |
| 6. Emit config and hand off | `tester-agent-cli.js emit-config …` then `workflow-tools-cli.js root-setup --project <path> --input <path>` with `tester_agent_config` | The contract digest could not be frozen, or the root setup rejects the config; it is not a formal run. |

The run this hands off to is an Auto Research Loop root, so the root setup
input carries `mode: "auto_research_loop"`, a positive `max_iterations`, and
optionally `max_repair_attempts` (default 3) and `max_depth` (default 2). It
carries no `model_usage_policy`: model choice is prose in CLAUDE.md's
`## Model Usage`, and `root-setup` refuses the field in loop mode. It carries no `budget`: the loop stops on its round
limit, and `root-setup` refuses a budget in loop mode. `/aris-setup` Phase 5
writes these into the answers file it assembles from.

Steps 4 and 5 run after the contract exists, because the blocklist is part of
the contract, and before any research starts, because a search that already
happened cannot be un-searched.

Deployment input names the site facts — `container`, `container_user` (the
daemon's account), `remote_home` (the tester's home inside the container),
`provider`, and `public_key_path` for the copied-out public key. There are no
defaults for any of them. The container paths all derive from one home. Deploy
checks the manual's sha256 first, so an image with the wrong manual gets no key
and no agent. Then, as the daemon's account, it creates the layout and the
signing key and starts the agent with the manual as its procedure. Nothing runs
as root and nothing is written into the container from the host.

## What the research side may do

Exactly two things, and both need the project id:

1. Ask the tester to set up a test — `declare`, with a domain need in prose. The
   need names a domain or a capability, not a benchmark: choosing the evaluation
   is the tester's job, and the research side proposing its own is what this
   whole arrangement exists to prevent. The tester researches the field itself —
   papers, repositories, dataset hosts — picks or designs the protocol, builds
   the cases in its own container, and answers with the shape of the artifacts it
   wants (one reference slot, one candidate slot), the fields it needs, how to
   run them, the digest of the case set, and the list of things the research side
   may no longer search for. It does not answer with cases.
2. Submit one produced pair for testing — `submit`. The submission is checked
   against the declared contract before anything is sent: a missing required
   slot, an undeclared field or a contract digest that does not match the frozen
   one is refused locally.

### Only the outermost run submits

`submit` reads the run named in the submission's `outer_run_id` out of the
project's own run contract and refuses `TESTER_OUTER_RUN_REQUIRED` unless that
run has no parent and sits at depth zero. A run whose `run.json` is not there at
all is `RUN_CONTRACT_NOT_FOUND`. Both are facts about the research machine, so
both are printed by name; every other submission failure still collapses to one
reason.

The reason is the exposure limit. Exposures are counted against one task-wide
`exposure_limit`, so a run dispatched underneath another one that could submit
would spend the whole task's remaining exposures answering a local question.
This limit is separate from the resource budget the loop no longer has: it
bounds how often the task tester is reached, not how long research runs. A
child, at any depth down to the frozen `max_depth`, is judged by the acceptance
its parent froze for it instead. A child whose experiment kept failing
publishes a `failed` result package to its parent, which collects it before
closing the round; it never goes to the tester. That is why
`experiment-bridge.ts` already refuses a child charter that names a tester
(`CHILD_TESTER_FORBIDDEN`). This is the same rule at the other end, where the
submission is actually sent — the bridge check can only see charters it was
handed, and a run that never went through the bridge would walk past it.

Re-declaring produces a new contract. If its digest differs from the one frozen
in the config, `submit` refuses until setup emits a new config. That is the
intended behaviour: a run does not silently change the test it is being judged
by.

## What comes back

The terminal status, a signed conclusion, a signed feedback envelope and the
fixed coarse `error_analysis` categories. A response that does not verify is
refused whole and never reaches disk — `writeTesterAgentResponse` refuses any
response that did not pass `verifyTesterAgentResponse` in this process.

The signed receipt reaches the Wiki only through `/result-to-claim`'s
`add_experiment --tester-feedback` call for the iteration it judged. Have it in
hand before that call. Once the iteration's experiment supports or invalidates a
claim, a repeated `add_experiment` reuses the page as it is, and a receipt the
page does not already carry is refused with `TESTER_RECEIPT_TOO_LATE`; the
export cannot rank that iteration by the tester.

Do not analyze the tester run. Case content, answers, prompts, per-case output,
per-case scores, private observations, fine-grained categories and private URIs
never return to research. The declared metric aggregates and the coarse feedback
are not experiment evidence and cannot be fed into analysis, evidence review or
a research claim.

## The container the test runs in

The tester runs code the research side wrote, and the container it lives in
holds the private key and the cases. So the contract has to say where it ran it:
`runtime` is `{"kind": "docker", "image_digest": "<64 hex>"}`, and `declare`
refuses `TESTER_RUNTIME_REQUIRED` for a missing runtime or any `kind` other than
`docker`. There is nothing to negotiate — a tester that wants to run a
submission in its own container has to say so, and saying so is refused.

The digest is the only public fact about that environment, and it is there for
the same reason `case_manifest_sha256` is: so that "the environment changed
between two submissions" is detectable. The image name and tag stay in the
tester container, because a readable tag names the benchmark the exclusion list
exists to hide.

What the tester is told to do with that image is in
`templates/tester-agent-bundle/TESTER_AGENT.md` step 4: cases mounted read-only
rather than baked in, no network unless the protocol needs one, memory and CPU
caps, an externally enforced timeout, and a fresh container per submission.
None of it is checked from this side. `probe` checks `docker info` inside the
tester container and refuses to call it ready without it; everything past that
is the tester's own discipline.

## The search gate

The tester just researched a public benchmark. Its repository and its paper are
still public, so the research side does not need to touch the tester container
to contaminate the evaluation — it only needs to search for the same benchmark.
The leak is the open web, not the tester container, and neither the private key
nor the cases inside it do anything about it.

So the signed contract carries `search_exclusions`: the benchmark and dataset
names, the exact URLs and the host-plus-path prefixes the tester actually drew
on. `emit-policy` compiles that into `<project>/.aris/search-policy.json` and
`install-guard` merges a PreToolUse hook into `<project>/.claude/settings.json`
that judges every network-shaped call: `WebSearch`, `WebFetch`, Bash commands
containing a network verb (`curl`, `wget`, `git clone`, `pip install`, the ARIS
paper fetchers), and MCP tools whose name reads like retrieval. Every judged call
is appended to the hash-chained ledger `<project>/.aris/search-audit.jsonl`.

**Never print the blocklist.** No skill, prompt, report or summary reproduces the
entries. `emit-policy` prints counts and a digest; `summary` prints decision
counts. The only place a term is ever shown is the refusal the guard writes when
the model has already typed it, and at that point the model has learned exactly
one entry it had already thought of on its own.

Being refused is not a failure of the round. Do not work around it: rewording the
query until it passes is the contamination the gate exists to stop, and the round
is still judged by the tester either way. Research the problem from other
sources.

`submit` checks the ledger before it sends anything, and refuses on three
distinct facts:

| Refusal | What it means |
| --- | --- |
| `SEARCH_AUDIT_MISSING` | There is no ledger, or it has no genesis entry: the guard was never installed. Run steps 4 and 5. |
| `SEARCH_AUDIT_BROKEN` | The chain or the sequence does not hold: written history was edited. |
| `SEARCH_POLICY_MISMATCH` | The ledger's active policy is not what this contract compiles to: the round was guarded against a different test. Re-run `emit-policy --rotate`, and treat the research done before the rotation as unaudited. |

### What this does not do

State all of it, every time, because a gate believed to be stronger than it is is
worse than no gate.

- It is keyword and domain matching, not a sandbox. A paraphrase, a synonym or a
  typo goes straight through.
- The benchmark is probably already in the model's weights. Blocking the search
  does not unlearn it.
- The policy file sits on the research machine under the same uid as the research
  process. "The model is not shown the list" rests on no prompt printing it, not
  on permissions. The compensation is that a command naming the policy path is
  recorded as a flagged `policy_read` entry.
- The ledger shares that uid too. The hash chain makes editing written history
  detectable; a ledger forged whole is not detectable locally, and the tester does
  not counter-sign it. This is an open hole, accepted deliberately.
- The blocklist is adversarial in both directions. A tester that listed
  `benchmark` or `reasoning` would shut down the research side's ordinary
  literature work, so the contract validator refuses general words
  (`TESTER_EXCLUSIONS_OVERBROAD`) and a general-purpose host without a path.

## Resolving the helper

Resolve `tester-agent-cli.js` and `search-audit-cli.js` only through the shared
integration contract
(`.aris/dist` for installed projects, `dist` for development). See
[integration contract](../shared-references/integration-contract.md). A missing
or failed helper is a setup failure, not a reason to hand-write a config.
