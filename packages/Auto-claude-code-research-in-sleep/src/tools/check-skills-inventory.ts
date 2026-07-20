#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "skills");
const CATALOG = path.join(REPO_ROOT, "docs", "SKILLS_CATALOG.md");
const README = path.join(REPO_ROOT, "README.md");
const README_CN = path.join(REPO_ROOT, "README_CN.md");
const AGENT_GUIDE = path.join(REPO_ROOT, "AGENT_GUIDE.md");
const ARIS_INTRO = path.join(REPO_ROOT, "docs", "ARIS_INTRO.md");
const ARIS_INTRO_HTML = path.join(REPO_ROOT, "docs", "ARIS_INTRO.html");

const REQUIRED_README_ANCHORS = [
  "contents",
  "more-than-just-a-prompt",
  "whats-new",
  "quick-start",
  "features",
  "score-progression",
  "community-showcase",
  "awesome-community-skills",
  "workflows",
  "skills-catalog",
  "setup",
  "customization",
  "alternative-model-combinations",
  "community",
  "citation",
  "star-history",
  "acknowledgements",
  "license",
  "prerequisites",
  "install-skills",
  "gpu-server-setup",
  "alt-a-glm--gpt",
  "-optional-gpt-54-pro-via-oracle",
  "-research-wiki--persistent-research-memory",
];

function globSkillMd(root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillPath = path.join(root, entry.name, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        results.push(skillPath);
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

function readmeAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const re = /<a id="([^"]+)"><\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    anchors.add(m[1]);
  }
  return anchors;
}

function numberedH2Count(text: string): number {
  const matches = text.match(/^## \d+\.\s/gm);
  return matches ? matches.length : 0;
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
  const readme = read(README);
  const readmeCn = read(README_CN);
  const agentGuide = read(AGENT_GUIDE);
  const arisIntro = read(ARIS_INTRO);
  const arisIntroHtml = read(ARIS_INTRO_HTML);

  const expectedCount = main.size;
  const countChecks: [string, string, string][] = [
    [CATALOG, catalogText, "\\*\\*(?<count>\\d+) skills\\*\\*"],
    [README, readme, "📊\\s+\\*\\*(?<count>\\d+) composable skills\\*\\*"],
    [README, readme, "ARIS ships \\*\\*(?<count>\\d+)\\+ skills\\*\\*"],
    [README_CN, readmeCn, "📊\\s+\\*\\*(?<count>\\d+) 个可组合 skill\\*\\*"],
    [README_CN, readmeCn, "ARIS 现有 \\*\\*(?<count>\\d+)\\+ 个 skill\\*\\*"],
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
    [ARIS_INTRO_HTML, arisIntroHtml, "一组 (?<count>\\d+) 个可组合的 Claude Code skills"],
  ];
  for (const [fp, text, pattern] of countChecks) {
    requireCount(fp, text, pattern, expectedCount, failures);
  }

  const enAnchors = readmeAnchors(readme);
  const cnAnchors = readmeAnchors(readmeCn);
  for (const required of REQUIRED_README_ANCHORS) {
    if (!enAnchors.has(required)) {
      failures.push(`README.md missing required anchor: <a id="${required}"></a>`);
    }
    if (!cnAnchors.has(required)) {
      failures.push(`README_CN.md missing required anchor: <a id="${required}"></a>`);
    }
  }

  const enH2 = numberedH2Count(readme);
  const cnH2 = numberedH2Count(readmeCn);
  require_(
    enH2 === 16,
    `README.md has ${enH2} numbered H2 sections; expected 16 (Phase A)`,
    failures,
  );
  require_(
    cnH2 === 16,
    `README_CN.md has ${cnH2} numbered H2 sections; expected 16 (Phase A)`,
    failures,
  );

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

  const watchdogTs = read(path.join(REPO_ROOT, "src", "tools", "watchdog.ts"));
  const extCadence = read(path.join(SKILLS_ROOT, "shared-references", "external-cadence.md"));
  const toolLoop =
    /function checkLoop\b/.test(watchdogTs) &&
    /"loop"/.test(watchdogTs) &&
    /--register/.test(watchdogTs);
  const docLoop = /"type"\s*:\s*"loop"/.test(extCadence);
  require_(
    toolLoop,
    "src/tools/watchdog.ts must implement loop-liveness checkLoop + --register accepting the 'loop' task type (A2)",
    failures,
  );
  require_(
    docLoop,
    "external-cadence.md must document registering a watchdog 'loop' task — its trigger (A2)",
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
