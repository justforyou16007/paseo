import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSourceInventory } from "./aris-auto-install.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let repoRoot = __dirname;
while (
  !existsSync(path.join(repoRoot, "packages", "Auto-claude-code-research-in-sleep", "skills"))
) {
  const parent = path.dirname(repoRoot);
  if (parent === repoRoot) throw new Error("Cannot find repo root");
  repoRoot = parent;
}

const ARIS_ROOT = path.join(repoRoot, "packages", "Auto-claude-code-research-in-sleep");
const SKILLS_DIR = path.join(ARIS_ROOT, "skills");

const ALLOWED_ARIS_REPO_FILES = new Set(["aris-update"]);
const DESCRIPTIVE_DOCS = new Set(["integration-contract.md", "wiki-helper-resolution.md"]);

const OLD_PYTHON_HELPERS = [
  "research_wiki.py",
  "iteration_log.py",
  "verify_papers.py",
  "threat_scan.py",
  "evidence_check.py",
  "capture_filter.py",
  "provenance.py",
];

const OPERATIONAL_ARIS_REPO_PATTERNS = [
  /\bARIS_REPO="\$\{ARIS_REPO:-\$\(awk/,
  /ARIS_REPO=\$\(awk\s+-F/,
  /\$ARIS_REPO\/dist\//,
  /\$ARIS_REPO\/tools\//,
  /\$ARIS_REPO\/skills\//,
  /\$ARIS_REPO\/templates\//,
  /\[ -n "\$\{ARIS_REPO:-\}" \] && [A-Z_]+="\$ARIS_REPO\//,
  /export ARIS_REPO/,
];

const OLD_PYTHON_PATTERNS = OLD_PYTHON_HELPERS.map(
  (h) => new RegExp(`python3.*${h.replace(".", "\\.")}`),
);

function getAllSkillFiles(): { rel: string; content: string }[] {
  const results: { rel: string; content: string }[] = [];

  function walk(dir: string, relBase: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.join(relBase, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".sh")) {
        results.push({ rel, content: readFileSync(full, "utf-8") });
      }
    }
  }

  walk(SKILLS_DIR, "");
  return results;
}

/**
 * Extract concrete .aris/dist/ and .aris/tools/ paths from skill files.
 * Excludes template placeholders like <helper>, <skill-name>, etc.
 */
function extractConcreteHelperPaths(
  files: { rel: string; content: string }[],
): { rel: string; helperPath: string; line: number }[] {
  const results: { rel: string; helperPath: string; line: number }[] = [];
  // Match .aris/dist/... or .aris/tools/... paths with concrete filenames
  const pathPattern = /\.aris\/(dist\/[^\s"'`$<>]+\.js|tools\/[^\s"'`$<>]+\.sh)/g;

  for (const { rel, content } of files) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let match;
      pathPattern.lastIndex = 0;
      while ((match = pathPattern.exec(line)) !== null) {
        const p = match[1]!;
        // Skip template placeholders
        if (/<[a-z-]+>/.test(p)) continue;
        // Skip .d.ts and .map
        if (p.endsWith(".d.ts") || p.endsWith(".map")) continue;
        results.push({ rel, helperPath: p, line: i + 1 });
      }
    }
  }

  // Deduplicate by helperPath
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.helperPath)) return false;
    seen.add(r.helperPath);
    return true;
  });
}

describe("ARIS runtime contract", () => {
  const allFiles = getAllSkillFiles();

  it("no runtime skill uses operational ARIS_REPO patterns", () => {
    const violations: string[] = [];

    for (const { rel, content } of allFiles) {
      const skillName = rel.split(path.sep)[0]!;
      if (ALLOWED_ARIS_REPO_FILES.has(skillName)) continue;
      const fileName = path.basename(rel);
      if (DESCRIPTIVE_DOCS.has(fileName)) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const pattern of OPERATIONAL_ARIS_REPO_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
          }
        }
      }
    }

    expect(violations, `Operational ARIS_REPO usage found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("no runtime skill reads repo_root from manifest", () => {
    const violations: string[] = [];
    const pattern = /awk.*repo_root.*installed-skills/;

    for (const { rel, content } of allFiles) {
      const skillName = rel.split(path.sep)[0]!;
      if (ALLOWED_ARIS_REPO_FILES.has(skillName)) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i]!)) {
          violations.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 100)}`);
        }
      }
    }

    expect(violations, `repo_root reads found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("no old Python helper names appear in skills", () => {
    const violations: string[] = [];

    for (const { rel, content } of allFiles) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const helper of OLD_PYTHON_HELPERS) {
          if (lines[i]!.includes(helper)) {
            violations.push(
              `${rel}:${i + 1}: old helper "${helper}" — ${lines[i]!.trim().slice(0, 80)}`,
            );
          }
        }
      }
    }

    expect(violations, `Old Python helpers found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("no python3 invocation of old helpers", () => {
    const violations: string[] = [];

    for (const { rel, content } of allFiles) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of OLD_PYTHON_PATTERNS) {
          if (pattern.test(lines[i]!)) {
            violations.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 100)}`);
          }
        }
      }
    }

    expect(violations, `python3 invocations of old helpers:\n${violations.join("\n")}`).toEqual([]);
  });

  it("every concrete .aris/dist/ and .aris/tools/ path in skills maps to a real source file", () => {
    const refs = extractConcreteHelperPaths(allFiles);
    const missing: string[] = [];

    for (const { rel, helperPath, line } of refs) {
      if (!existsSync(path.join(ARIS_ROOT, helperPath))) {
        missing.push(`${rel}:${line}: .aris/${helperPath} → source ${helperPath} NOT FOUND`);
      }
    }

    expect(
      missing,
      `Skill references paths that don't exist in ARIS source:\n${missing.join("\n")}`,
    ).toEqual([]);
    expect(refs.length).toBeGreaterThan(10);
  });

  it("buildSourceInventory produces complete inventory matching src→dist", () => {
    const inventory = buildSourceInventory(ARIS_ROOT);

    // Must include all dist/**/*.js files
    const distJs = inventory.filter((f) => f.startsWith("dist/") && f.endsWith(".js"));
    expect(distJs.length).toBeGreaterThanOrEqual(60);

    // Must include shell helpers
    const shellHelpers = inventory.filter((f) => f.startsWith("tools/") && f.endsWith(".sh"));
    expect(shellHelpers.length).toBeGreaterThanOrEqual(5);

    // Must include templates
    const templates = inventory.filter((f) => f.startsWith("templates/"));
    expect(templates.length).toBeGreaterThanOrEqual(15);

    // Must include node_modules dep files (all files, not just package.json)
    const depFiles = inventory.filter((f) => f.startsWith("node_modules/"));
    expect(depFiles.length).toBeGreaterThanOrEqual(2);

    // Every inventory item must exist in source
    for (const f of inventory) {
      expect(
        existsSync(path.join(ARIS_ROOT, f)),
        `Inventory item ${f} missing from ARIS source`,
      ).toBe(true);
    }
  });

  it("no helper resolver uses bare git||pwd without upward .aris walk", () => {
    const violations: string[] = [];
    // Pattern: cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" in a helper context
    const bareGitPwd = /cd "\$\(git rev-parse --show-toplevel 2>\/dev\/null \|\| pwd\)"/;

    for (const { rel, content } of allFiles) {
      const skillName = rel.split(path.sep)[0]!;
      if (ALLOWED_ARIS_REPO_FILES.has(skillName)) continue;

      // Only check files that have helper resolution (.aris/dist or .aris/tools)
      if (!content.includes(".aris/dist") && !content.includes(".aris/tools")) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (bareGitPwd.test(lines[i]!)) {
          violations.push(`${rel}:${i + 1}: bare git||pwd without upward walk`);
        }
      }
    }

    expect(
      violations,
      `Helper resolvers still using bare git||pwd:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("aris-update manifest parser uses kind filter, not NR-based line skip", () => {
    const updatePath = path.join(SKILLS_DIR, "aris-update", "SKILL.md");
    const content = readFileSync(updatePath, "utf-8");

    // Must NOT have NR>4 or NR>N pattern for manifest parsing
    expect(content).not.toMatch(/awk.*NR\s*>\s*\d+.*MANIFEST/);

    // Must filter by known kind values
    expect(content).toMatch(/case.*\$.*kind/);
    expect(content).toMatch(/skill\|support\|agent\)/);
  });

  it("aris-update manifest writer includes runtime_file rows", () => {
    const updatePath = path.join(SKILLS_DIR, "aris-update", "SKILL.md");
    const content = readFileSync(updatePath, "utf-8");

    expect(content).toContain("runtime_file");
    expect(content).toContain("RUNTIME_FILES");
  });
});
