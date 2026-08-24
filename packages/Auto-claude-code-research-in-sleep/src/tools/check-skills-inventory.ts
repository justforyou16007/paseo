#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");
const CATALOG = path.join(REPO_ROOT, "docs", "SKILLS_CATALOG.md");
const AGENT_GUIDE = path.join(REPO_ROOT, "AGENT_GUIDE.md");
const ARIS_INTRO = path.join(REPO_ROOT, "docs", "ARIS_INTRO.md");
const ARIS_INTRO_HTML = path.join(REPO_ROOT, "docs", "ARIS_INTRO.html");

function globSkillMd(root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillPath = path.join(root, entry.name, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        results.push(skillPath);
      } else {
        // Skill GROUPS (e.g. analyze-results-tools/) hold sub-skills one
        // level down; the group itself is not a skill.
        for (const sub of globSkillMd(path.join(root, entry.name))) {
          results.push(sub);
        }
      }
    }
  }
  return results.sort();
}

function skillNames(root: string): Set<string> {
  const names = new Set<string>();
  for (const p of globSkillMd(root)) {
    names.add(path.basename(path.dirname(p)));
  }
  return names;
}

function allowedTools(text: string): string[] {
  const match = text.match(/^allowed-tools:\s*(.+)$/m);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function frontmatterSplit(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  return match ? text.slice(match[0].length) : text;
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function catalogNames(): Set<string> {
  const text = read(CATALOG);
  const names = new Set<string>();
  const re = /\[`\/([^`]+)`\]\(\.\.\/skills\/[^)]+\/SKILL\.md\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    names.add(m[1]);
  }
  return names;
}

function require_(condition: boolean, message: string, failures: string[]): void {
  if (!condition) {
    failures.push(message);
  }
}

function requireCount(
  filePath: string,
  text: string,
  pattern: string,
  expectedCount: number,
  failures: string[],
): void {
  const re = new RegExp(pattern);
  const match = re.exec(text);
  const rel = path.relative(REPO_ROOT, filePath);
  if (match === null) {
    failures.push(`${rel} is missing live count pattern: ${pattern}`);
    return;
  }
  const actual = parseInt(match.groups!["count"], 10);
  if (actual !== expectedCount) {
    failures.push(`${rel} reports ${actual} skills; expected ${expectedCount}`);
  }
}

function checkInventory(): string[] {
  const failures: string[] = [];
  const main = skillNames(SKILLS_ROOT);
  const catalog = catalogNames();

  const missingCatalog = [...main].filter((n) => !catalog.has(n)).sort();
  const extraCatalog = [...catalog].filter((n) => !main.has(n)).sort();

  require_(
    missingCatalog.length === 0,
    `missing catalog entries: ${missingCatalog.join(", ")}`,
    failures,
  );
  require_(
    extraCatalog.length === 0,
    `catalog entries without mainline skills: ${extraCatalog.join(", ")}`,
    failures,
  );

  const catalogText = read(CATALOG);
  const agentGuide = read(AGENT_GUIDE);
  const arisIntro = read(ARIS_INTRO);
  const arisIntroHtml = read(ARIS_INTRO_HTML);

  const expectedCount = main.size;
  const countChecks: [string, string, string][] = [
    [CATALOG, catalogText, "\\*\\*(?<count>\\d+) skills\\*\\*"],
    [AGENT_GUIDE, agentGuide, "Full catalog.*?\\*\\*(?<count>\\d+) skills\\*\\*"],
    [
      ARIS_INTRO,
      arisIntro,
      "collection of \\*\\*(?<count>\\d+) composable Claude Code skills\\*\\*",
    ],
    [ARIS_INTRO, arisIntro, "## The (?<count>\\d+) Skills"],
    [ARIS_INTRO, arisIntro, "一组 (?<count>\\d+) 个可组合的 Claude Code skills"],
    [
      ARIS_INTRO_HTML,
      arisIntroHtml,
      "collection of <strong>(?<count>\\d+) composable Claude Code skills</strong>",
    ],
    [ARIS_INTRO_HTML, arisIntroHtml, 'id="the-(?<count>\\d+)-skills"'],
    [ARIS_INTRO_HTML, arisIntroHtml, "一组\\s+(?<count>\\d+)\\s+个可组合的 Claude Code skills"],
  ];
  for (const [fp, text, pattern] of countChecks) {
    requireCount(fp, text, pattern, expectedCount, failures);
  }

  for (const skillFile of globSkillMd(SKILLS_ROOT)) {
    const text = read(skillFile);
    const body = frontmatterSplit(text);
    const at = allowedTools(text);

    if (/(^|,)\s*Agent\s*(,|$)/.test(at.join(", "))) {
      const rel = path.relative(REPO_ROOT, skillFile);
      failures.push(
        `${rel} grants host \`Agent\` in allowed-tools — ` +
          `FORBIDDEN per Global Rule 4 (Paseo MCP Only, Strict) in ` +
          `shared-references/paseo-subagent-dispatch.md. Use ` +
          `\`mcp__paseo__create_agent\` instead.`,
      );
    }

    if (/(^|,)\s*Skill\s*(,|$)/.test(at.join(", "))) {
      const rel = path.relative(REPO_ROOT, skillFile);
      failures.push(
        `${rel} grants host \`Skill\` in allowed-tools — ` +
          `FORBIDDEN per Global Rule 4 (Paseo MCP Only, Strict) in ` +
          `shared-references/paseo-subagent-dispatch.md. Use ` +
          `\`mcp__paseo__create_agent\` to dispatch sub-skills instead.`,
      );
    }

    const hasPaseoCreate = at.includes("mcp__paseo__create_agent");
    const bodyCitesPaseo = body.includes("paseo-subagent-dispatch.md");
    if (hasPaseoCreate && !bodyCitesPaseo) {
      const rel = path.relative(REPO_ROOT, skillFile);
      failures.push(
        `${rel} grants \`mcp__paseo__create_agent\` in allowed-tools ` +
          `but its body does not cite paseo-subagent-dispatch.md — ` +
          `vestigial grant or undocumented fan-out (see ` +
          `shared-references/paseo-subagent-dispatch.md ` +
          `§"Global Agent Rules")`,
      );
    }
    if (bodyCitesPaseo && !hasPaseoCreate) {
      const rel = path.relative(REPO_ROOT, skillFile);
      failures.push(
        `${rel} cites paseo-subagent-dispatch.md in its body but ` +
          `does not grant \`mcp__paseo__create_agent\` in allowed-tools ` +
          `— body points at a capability the skill cannot call`,
      );
    }
  }

  const envConfig = read(path.join(SKILLS_ROOT, "experiment-env-configuration", "SKILL.md"));
  const runExp = read(path.join(SKILLS_ROOT, "run-experiment", "SKILL.md"));
  const expQueue = read(path.join(SKILLS_ROOT, "experiment-queue", "SKILL.md"));
  const extCadence = read(path.join(SKILLS_ROOT, "shared-references", "external-cadence.md"));
  const OPS = [
    "env-info",
    "query-resources",
    "sync-code",
    "build-env",
    "launch-job",
    "job-status",
    "job-logs",
    "collect-outputs",
    "stop-job",
    "release-resources",
  ];
  const opsSpecified = OPS.every((op) => new RegExp(`\\b${op}\\.sh\\b`).test(envConfig));
  const failureContract = /uniform op exit contract/i.test(envConfig);
  const noAnalysisInOps = /process-invariant only/i.test(envConfig);
  require_(
    opsSpecified,
    "experiment-env-configuration/SKILL.md must specify all ten ops (env-info…release-resources) (A2)",
    failures,
  );
  require_(
    failureContract,
    "experiment-env-configuration/SKILL.md must document the uniform op exit contract (failure-recovery entry point) (A2)",
    failures,
  );
  require_(
    noAnalysisInOps,
    "experiment-env-configuration/SKILL.md must state ops are process-invariant only (analysis belongs to /analyze-results) (A2)",
    failures,
  );
  const heartbeatWired =
    runExp.includes("mcp__paseo__create_heartbeat") &&
    runExp.includes("job-status.sh") &&
    expQueue.includes("mcp__paseo__create_heartbeat") &&
    expQueue.includes("job-status.sh");
  require_(
    heartbeatWired,
    "run-experiment and experiment-queue must both arm a monitoring heartbeat and poll via job-status.sh (A2)",
    failures,
  );
  const heartbeatBounded = /expiresIn/.test(extCadence) && /maxRuns/.test(extCadence);
  require_(
    heartbeatBounded,
    "external-cadence.md must document heartbeat bounds (expiresIn/maxRuns) (A2)",
    failures,
  );

  const extc = read(path.join(SKILLS_ROOT, "shared-references", "external-cadence.md"));
  const rp = read(path.join(SKILLS_ROOT, "research-pipeline", "SKILL.md"));
  const toolStall = fs.existsSync(path.join(REPO_ROOT, "src", "tools", "iteration-log.ts"));
  const docLadder =
    /forced structural pivot/i.test(extc) &&
    /stale_count`?\s*>=\s*2/.test(extc) &&
    /stale_count`?\s*>=\s*4/.test(extc);
  const wired =
    rp.includes("iteration-log.js") &&
    rp.includes("ITER_LOG") &&
    /"\$ITER_LOG"\s+note/.test(rp) &&
    rp.includes("pivot") &&
    rp.includes("structural") &&
    rp.includes("human");
  require_(toolStall, "src/tools/iteration-log.ts (stall→pivot, B) must exist", failures);
  require_(
    docLadder,
    "external-cadence.md must document the stall ladder with both thresholds (>=2 structural, >=4 human) (B)",
    failures,
  );
  require_(
    wired,
    "research-pipeline/SKILL.md must actually wire iteration-log.js (resolver + `$ITER_LOG note` + pivot handling) — not just mention it (B)",
    failures,
  );

  const rwiki = read(path.join(REPO_ROOT, "src", "tools", "research-wiki.ts"));
  const pchk = read(path.join(SKILLS_ROOT, "proof-checker", "SKILL.md"));
  const toolClaim = /\.command\("add_claim"\)/.test(rwiki) && /function\s+addClaim\b/.test(rwiki);
  const born = /node\s+"\$WIKI_SCRIPT"\s+add_claim\b/.test(pchk);
  require_(
    toolClaim,
    "src/tools/research-wiki.ts must implement the add_claim claim-layer writer + its CLI",
    failures,
  );
  require_(
    born,
    "proof-checker/SKILL.md must invoke `add_claim` as the claim birth point — not just mention it (else add_claim is an orphan writer)",
    failures,
  );

  const icreator = read(path.join(SKILLS_ROOT, "idea-creator", "SKILL.md"));
  const toolIdea =
    /\.command\("upsert_idea"\)/.test(rwiki) && /function\s+upsertIdea\b/.test(rwiki);
  const ideaWritten = /node\s+"\$WIKI_SCRIPT"\s+upsert_idea\b/.test(icreator);
  require_(
    toolIdea,
    "src/tools/research-wiki.ts must implement the upsert_idea idea-layer writer + its CLI",
    failures,
  );
  require_(
    ideaWritten,
    "idea-creator/SKILL.md must invoke `upsert_idea` to record ideas (Phase 7) — not just mention it (else ideas are written freehand and skipped on re-gen)",
    failures,
  );

  const r2c = read(path.join(SKILLS_ROOT, "result-to-claim", "SKILL.md"));
  const toolExp =
    /\.command\("add_experiment"\)/.test(rwiki) && /function\s+addExperiment\b/.test(rwiki);
  const expWritten = /node\s+"\$WIKI_SCRIPT"\s+add_experiment\b/.test(r2c);
  require_(
    toolExp,
    "src/tools/research-wiki.ts must implement the add_experiment experiment-layer writer + its CLI",
    failures,
  );
  require_(
    expWritten,
    "result-to-claim/SKILL.md must invoke `add_experiment` to create the experiment node (Step 5) — not just mention it (else exp pages are freehand and supports/invalidates edges dangle)",
    failures,
  );

  // Problem entities: the open-problem layer. Every problem is born through
  // add_problem at one of three writers — /research-setup (the run's root
  // problem), /result-to-claim (children derived from a partial/no verdict),
  // /kill-argument (children derived from an unanswered attack). Freehand
  // problem pages would not get the child_of edge or the query_pack listing,
  // so /idea-creator's next round would never see them.
  const setup = read(path.join(SKILLS_ROOT, "research-setup", "SKILL.md"));
  const killarg = read(path.join(SKILLS_ROOT, "kill-argument", "SKILL.md"));
  const toolProblem =
    /\.command\("add_problem"\)/.test(rwiki) && /function\s+addProblem\b/.test(rwiki);
  require_(
    toolProblem,
    "src/tools/research-wiki.ts must implement the add_problem problem-layer writer + its CLI",
    failures,
  );
  require_(
    /"\$WIKI_SCRIPT"\s+add_problem\b/.test(setup),
    "research-setup/SKILL.md must invoke `add_problem` to create the run's root problem (else idea discovery has no seed and child problems have no parent)",
    failures,
  );
  require_(
    /"\$WIKI_SCRIPT"\s+add_problem\b/.test(r2c),
    "result-to-claim/SKILL.md must invoke `add_problem` on partial/no verdicts (else a failed experiment leaves no search seed for the next iteration)",
    failures,
  );
  require_(
    /"\$WIKI_SCRIPT"\s+add_problem\b/.test(killarg),
    "kill-argument/SKILL.md must invoke `add_problem` for still_unresolved points (else an unanswered attack is lost)",
    failures,
  );
  require_(
    /--parent\s+"problem:root"/.test(r2c) && /--parent\s+"problem:root"/.test(killarg),
    "derived problems must attach to the root problem via `--parent problem:root` (else the child_of edge is missing and the problem tree is flat)",
    failures,
  );
  require_(
    !/\.command\("add_gap"\)/.test(rwiki) && !fs.existsSync(path.join(SKILLS_ROOT, "gap-planner")),
    "the free-text gap map is retired: no add_gap writer and no gap-planner skill (problems are entities, audited by whoever writes them)",
    failures,
  );

  // The loop is thin: one iteration = research-pipeline Stage 1-3 + the metric
  // gate. Every wiki write happens inside a pipeline skill, so a second writer
  // in the orchestrator would race the real birth point.
  const arl = read(path.join(SKILLS_ROOT, "auto-research-loop", "SKILL.md"));
  require_(
    !/"\$WIKI_SCRIPT"\s+(add_experiment|upsert_idea|add_claim|add_problem)\b/.test(arl),
    "auto-research-loop/SKILL.md must not write the research wiki — the pipeline skills it dispatches own every birth point",
    failures,
  );
  require_(
    /\/result-to-claim/.test(read(path.join(SKILLS_ROOT, "auto-review-loop", "SKILL.md"))),
    "auto-review-loop/SKILL.md must dispatch /result-to-claim on termination — it is the loop's only path from experiment results into the wiki",
    failures,
  );

  return failures;
}

function main(): number {
  const failures = checkInventory();
  if (failures.length > 0) {
    console.error("ARIS skill inventory drift detected:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    return 1;
  }
  console.log("ARIS skill inventory is consistent.");
  return 0;
}

const program = createCli(
  "check-skills-inventory",
  "Check ARIS skill inventory drift across mainline skills and docs.",
);
program.action(() => {
  process.exit(main());
});
runCli(program);
