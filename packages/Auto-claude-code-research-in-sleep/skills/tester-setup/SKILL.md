---
name: tester-setup
description: Stand up the tester as an agent on its own machine, take the submission contract it declares, and hand the research side a config it can submit against.
allowed-tools: Read, Write, Bash(*)
---

# Tester Setup

Setup produces the seventh root setup item, `tester_agent_config`. Until it
exists, no formal outer run can start. Run the eight steps in order; a failed
step is a setup failure, not something to route around.

## What the boundary actually rests on

The tester is a Claude agent on a different machine, managed by that machine's
Paseo daemon. The research side reaches it with
`paseo --host ssh://<target>?daemonPort=<port>`, which tunnels the remote
daemon port back to this machine. Two physical facts keep the tester's work
private:

- The Ed25519 signing key is generated on the tester machine during deployment.
  Only the public half is fetched back. Research can read the public key — it is
  public — and still cannot forge a receipt.
- The cases are written by the tester agent and never leave that machine. What
  comes back is one signed envelope of ids, digests, enumerated values and the
  declared metric aggregates.

State the limit as well: the research process and the operator who runs this
setup share a uid and can read the same `~/.ssh`, so the research process can
technically open an ssh connection to the tester machine. This setup does not
claim to prevent that. It claims that the private key and the cases are not on
the research machine, and that the remote agent answers only two requests.

## The eight steps

| Step | Command | What a failure means |
| --- | --- | --- |
| 1. Probe | `tester-agent-cli.js probe --target … --daemon-port …` | ssh, the remote daemon or the remote `claude` binary is unavailable. Fix the machine; do not deploy. |
| 2. Prepare bundle | `tester-agent-cli.js prepare-bundle --output <local-bundle-dir>` | The remote tester has no operating manual, so it would be inventing its own procedure. |
| 3. Deploy | `tester-agent-cli.js deploy --input <request> --output <deployment>` | The remote layout, the key or the agent could not be created. Nothing downstream is valid. |
| 4. Declare | `tester-agent-cli.js declare --deployment <deployment> --need-file <need> --output <contract>` | The tester did not return a contract that verifies against its own key, or its exclusion list was refused (see below). |
| 5. Emit policy | `search-audit-cli.js emit-policy --contract <contract> --project <path>` | The research side has no blocklist, so the guard would refuse every network call. |
| 6. Install guard | `search-audit-cli.js install-guard --project <path>` | The hook is not in `.claude/settings.json` and the ledger was never opened. `submit` refuses. |
| 7. Clean up | `tester-agent-cli.js cleanup --deployment <deployment> [--local-bundle <dir>]` | The staging areas survive. Re-run; cleanup is idempotent. |
| 8. Emit config and hand off | `tester-agent-cli.js emit-config …` then `workflow-tools-cli.js root-setup --project <path> --input <path>` with `tester_agent_config` | The contract digest could not be frozen, or the root setup rejects the config; it is not a formal run. |

Step 2 runs before deploy because `deploy` pushes exactly one directory, the
`local_bundle_dir` named in the deployment request. Steps 5 and 6 run after the
contract exists, because the blocklist is part of the contract, and before any
research starts, because a search that already happened cannot be un-searched.

Deployment input names the site facts — ssh target, daemon port, remote home,
provider, local bundle directory, and where to write the fetched public key.
There are no defaults for any of them. The remote paths all derive from one
remote home, which is why cleanup can only delete a staging directory this
deployment created.

## What the research side may do

Exactly two things, and both need the project id:

1. Ask the tester to set up a test — `declare`, with a domain need in prose. The
   need names a domain or a capability, not a benchmark: choosing the evaluation
   is the tester's job, and the research side proposing its own is what this
   whole arrangement exists to prevent. The tester researches the field itself —
   papers, repositories, dataset hosts — picks or designs the protocol, builds
   the cases on its own machine, and answers with the shape of the artifacts it
   wants (one reference slot, one candidate slot), the fields it needs, how to
   run them, the digest of the case set, and the list of things the research side
   may no longer search for. It does not answer with cases.
2. Submit one produced pair for testing — `submit`. The submission is checked
   against the declared contract before anything is sent: a missing required
   slot, an undeclared field or a contract digest that does not match the frozen
   one is refused locally.

Re-declaring produces a new contract. If its digest differs from the one frozen
in the config, `submit` refuses until setup emits a new config. That is the
intended behaviour: a run does not silently change the test it is being judged
by.

## What comes back

The terminal status, a signed conclusion, a signed feedback envelope and the
fixed coarse `error_analysis` categories. A response that does not verify is
refused whole and never reaches disk — `writeTesterAgentResponse` refuses any
response that did not pass `verifyTesterAgentResponse` in this process.

Do not analyze the tester run. Case content, answers, prompts, per-case output,
per-case scores, private observations, fine-grained categories and private URIs
never return to research. The declared metric aggregates and the coarse feedback
are not experiment evidence and cannot be fed into analysis, evidence review or
a research claim.

## The search gate

The tester just researched a public benchmark. Its repository and its paper are
still public, so the research side does not need to touch the tester machine to
contaminate the evaluation — it only needs to search for the same benchmark. The
leak is the open web, not the tester machine, and neither the remote private key
nor the remote cases do anything about it.

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
| `SEARCH_AUDIT_MISSING` | There is no ledger, or it has no genesis entry: the guard was never installed. Run steps 5 and 6. |
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
