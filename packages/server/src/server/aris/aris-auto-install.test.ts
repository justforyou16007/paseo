import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { ensureArisSkillsInstalled } from "./aris-auto-install.js";

const logger = pino({ level: "silent" });

/**
 * Build a realistic ARIS source checkout with all sentinel files that the
 * installer verifies. The JS helpers are real executable scripts that import
 * commander so they exercise the full runtime chain.
 */
async function createArisSource(root: string): Promise<void> {
  // Skills
  await mkdir(path.join(root, "skills", "demo-skill"), { recursive: true });
  await writeFile(path.join(root, "skills", "demo-skill", "SKILL.md"), "# demo\n", "utf-8");
  await mkdir(path.join(root, "skills", "shared-references"), { recursive: true });
  await writeFile(
    path.join(root, "skills", "shared-references", "integration-contract.md"),
    "# contract\n",
    "utf-8",
  );
  // Agents
  await mkdir(path.join(root, "agents"), { recursive: true });
  await writeFile(path.join(root, "agents", "demo-agent.md"), "# agent\n", "utf-8");
  // Shell helpers (sentinels)
  await mkdir(path.join(root, "tools"), { recursive: true });
  await writeFile(
    path.join(root, "tools", "save_trace.sh"),
    '#!/bin/bash\necho "trace:$1"\n',
    "utf-8",
  );
  await writeFile(
    path.join(root, "tools", "verify_paper_audits.sh"),
    '#!/bin/bash\necho "audit:$1"\n',
    "utf-8",
  );
  // dist/tools — real executable JS helpers that import commander
  // Use Node's standard require resolution which walks up to find node_modules
  await mkdir(path.join(root, "dist", "tools"), { recursive: true });
  const helperScript = `#!/usr/bin/env node
// Walk up from __dirname to find node_modules/commander
let dir = __dirname;
while (dir !== require("path").dirname(dir)) {
  try { require(require("path").join(dir, "node_modules", "commander")); break; }
  catch { dir = require("path").dirname(dir); }
}
const { Command } = require(require("path").join(dir, "node_modules", "commander"));
const cmd = new Command();
cmd.name("test-helper").argument("[action]").action((a) => {
  process.stdout.write(JSON.stringify({ ok: true, action: a || "default", pid: process.pid }));
});
cmd.parse();
`;
  for (const name of [
    "research-wiki.js",
    "run-state.js",
    "evidence-check.js",
    "iteration-log.js",
    "verify-papers.js",
    "provenance.js",
  ]) {
    await writeFile(path.join(root, "dist", "tools", name), helperScript, "utf-8");
  }
  // dist/lib
  await mkdir(path.join(root, "dist", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "dist", "lib", "cli.js"),
    'const { Command } = require("commander");\nmodule.exports = { Command };\n',
    "utf-8",
  );
  // dist/skills — owner-skill sentinel
  await mkdir(path.join(root, "dist", "skills", "figure-spec"), { recursive: true });
  await writeFile(
    path.join(root, "dist", "skills", "figure-spec", "figure-renderer.js"),
    helperScript,
    "utf-8",
  );
  // node_modules/commander — real dependency
  await mkdir(path.join(root, "node_modules", "commander"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", "commander", "index.js"),
    `class Command {
  constructor() { this._name = ""; this._args = []; this._action = null; }
  name(n) { this._name = n; return this; }
  argument(a) { this._args.push(a); return this; }
  action(fn) { this._action = fn; return this; }
  parse(argv) { const a = (argv || process.argv).slice(2); if (this._action) this._action(a[0]); }
}
module.exports = { Command };
`,
    "utf-8",
  );
  await writeFile(
    path.join(root, "node_modules", "commander", "package.json"),
    '{"name":"commander","main":"index.js"}',
    "utf-8",
  );
  // Templates
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(root, "templates", "RESEARCH_BRIEF_TEMPLATE.md"), "# Brief\n", "utf-8");
  // package.json with dependencies (inventory checks node_modules/<dep>/package.json)
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-aris", dependencies: { commander: "^15.0.0" } }),
    "utf-8",
  );
  // src/ mirrors dist/ so inventory cross-check catches missing .js
  for (const tsPath of [
    "src/tools/research-wiki.ts",
    "src/tools/run-state.ts",
    "src/tools/evidence-check.ts",
    "src/tools/iteration-log.ts",
    "src/tools/verify-papers.ts",
    "src/tools/provenance.ts",
    "src/tools/arxiv-fetch.ts",
    "src/tools/semantic-scholar-fetch.ts",
    "src/lib/cli.ts",
    "src/skills/figure-spec/figure-renderer.ts",
  ]) {
    await mkdir(path.dirname(path.join(root, tsPath)), { recursive: true });
    await writeFile(path.join(root, tsPath), "export {};\n", "utf-8");
  }
  // Additional dist/tools that src expects (match src → dist)
  for (const name of ["arxiv-fetch.js", "semantic-scholar-fetch.js"]) {
    await writeFile(path.join(root, "dist", "tools", name), helperScript, "utf-8");
  }
  await writeFile(
    path.join(root, "dist", "lib", "cli.js"),
    'const { Command } = require("commander");\nmodule.exports = { Command };\n',
    "utf-8",
  );
}

describe("ensureArisSkillsInstalled", () => {
  let tempRoot: string;
  let arisSource: string;
  let projectDir: string;
  let previousOverride: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "aris-install-"));
    arisSource = path.join(tempRoot, "aris");
    projectDir = path.join(tempRoot, "project");
    await createArisSource(arisSource);
    await mkdir(projectDir, { recursive: true });
    previousOverride = process.env.PASEO_ARIS_REPO;
    process.env.PASEO_ARIS_REPO = arisSource;
  });

  afterEach(async () => {
    if (previousOverride === undefined) {
      delete process.env.PASEO_ARIS_REPO;
    } else {
      process.env.PASEO_ARIS_REPO = previousOverride;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("installs skills, agents, shell helpers, and compiled JS tools", async () => {
    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result).toMatchObject({ installed: true, skillCount: 1 });
    // skill
    await expect(
      readFile(path.join(projectDir, ".claude", "skills", "demo-skill", "SKILL.md"), "utf-8"),
    ).resolves.toBe("# demo\n");
    // support
    await expect(
      readFile(
        path.join(projectDir, ".claude", "skills", "shared-references", "integration-contract.md"),
        "utf-8",
      ),
    ).resolves.toBe("# contract\n");
    // agent
    await expect(
      readFile(path.join(projectDir, ".claude", "agents", "demo-agent.md"), "utf-8"),
    ).resolves.toBe("# agent\n");
    // shell helper
    await expect(
      readFile(path.join(projectDir, ".aris", "tools", "save_trace.sh"), "utf-8"),
    ).resolves.toContain("trace");
  });

  it("installed JS helpers execute and import commander from project-local node_modules", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    const helperPath = path.join(projectDir, ".aris", "dist", "tools", "research-wiki.js");
    const result = execFileSync(process.execPath, [helperPath, "ingest"], { encoding: "utf-8" });
    const parsed = JSON.parse(result);
    expect(parsed).toMatchObject({ ok: true, action: "ingest" });

    // figure-renderer (dist/skills/) also executes
    const rendererPath = path.join(
      projectDir,
      ".aris",
      "dist",
      "skills",
      "figure-spec",
      "figure-renderer.js",
    );
    const r2 = execFileSync(process.execPath, [rendererPath, "render"], { encoding: "utf-8" });
    expect(JSON.parse(r2)).toMatchObject({ ok: true, action: "render" });
  });

  it("helpers work after source checkout is deleted and ARIS_REPO points to bad path", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    // Delete source, set ARIS_REPO to garbage
    await rm(arisSource, { recursive: true, force: true });
    process.env.ARIS_REPO = "/nonexistent/path";

    // Project-local helpers still execute — no dependency on source
    const helperPath = path.join(projectDir, ".aris", "dist", "tools", "run-state.js");
    const result = execFileSync(process.execPath, [helperPath, "check"], { encoding: "utf-8" });
    expect(JSON.parse(result)).toMatchObject({ ok: true, action: "check" });

    delete process.env.ARIS_REPO;
  });

  it("shell resolver discovers project root from non-git deep subdir and executes helper", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    await rm(arisSource, { recursive: true, force: true });

    const deepDir = path.join(projectDir, "experiments", "run1", "sub", "deep");
    await mkdir(deepDir, { recursive: true });

    // Run the unified resolver shell logic from deepDir — it must walk up to find
    // .aris/installed-skills.txt and then resolve + execute the helper.
    const resolverScript = `
d=$(pwd)
while [ "$d" != "/" ]; do
  [ -f "$d/.aris/installed-skills.txt" ] && break
  d=$(dirname "$d")
done
HELPER="$d/.aris/dist/tools/evidence-check.js"
[ -f "$HELPER" ] || { echo "RESOLVE_FAIL"; exit 1; }
node "$HELPER" resolved-from-deep
`;
    const result = execFileSync("/bin/bash", ["-c", resolverScript], {
      cwd: deepDir,
      encoding: "utf-8",
    });
    expect(JSON.parse(result)).toMatchObject({ ok: true, action: "resolved-from-deep" });
  });

  it("manifest records project_root, repo_root, runtime_file rows, and version 2", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    const manifest = await readFile(
      path.join(projectDir, ".aris", "installed-skills.txt"),
      "utf-8",
    );
    expect(manifest).toContain(`version\t2`);
    expect(manifest).toContain(`repo_root\t${arisSource}`);
    expect(manifest).toContain(`project_root\t${projectDir}`);
    expect(manifest).toContain("skill\tdemo-skill");
    expect(manifest).toContain("support\tshared-references");
    // runtime_file rows record exact inventory
    expect(manifest).toContain("runtime_file\tdist/tools/research-wiki.js");
    expect(manifest).toContain("runtime_file\ttools/save_trace.sh");
    expect(manifest).toContain("runtime_file\ttemplates/RESEARCH_BRIEF_TEMPLATE.md");
    expect(manifest).toContain("runtime_file\tnode_modules/commander/index.js");
  });

  it("skips a project with complete manifest + all sentinels present", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    const second = await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    expect(second).toEqual({ installed: false, skippedReason: "already_installed" });
  });

  it("rejects runtime_file paths that escape the project runtime", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    const manifestPath = path.join(projectDir, ".aris", "installed-skills.txt");
    const manifest = await readFile(manifestPath, "utf-8");
    await writeFile(manifestPath, `${manifest}runtime_file\t../outside.txt\n`, "utf-8");

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result).toEqual({ installed: false, skippedReason: "error" });
    await expect(access(path.join(projectDir, "outside.txt"))).rejects.toThrow();
  });

  // --- Sentinel-based fail-closed behavior ---

  it("FAILS when source dist/tools/research-wiki.js is missing", async () => {
    await rm(path.join(arisSource, "dist", "tools", "research-wiki.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("dist/tools/research-wiki.js");
    await expect(access(path.join(projectDir, ".aris", "installed-skills.txt"))).rejects.toThrow();
  });

  it("FAILS when source dist/tools/run-state.js is missing but src/tools/run-state.ts exists", async () => {
    // src→dist cross-check: source has .ts but dist .js is missing = incomplete build
    await rm(path.join(arisSource, "dist", "tools", "run-state.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("dist/tools/run-state.js");
  });

  it("FAILS when source dist/tools/semantic-scholar-fetch.js is missing but src exists", async () => {
    await rm(path.join(arisSource, "dist", "tools", "semantic-scholar-fetch.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("dist/tools/semantic-scholar-fetch.js");
  });

  it("FAILS when post-copy target is missing templates (copy failure)", async () => {
    // Simulate copy failure: make templates dir read-only so copy fails
    // Instead, test via the repair path: install, delete template, verify repair catches it
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    await rm(path.join(projectDir, ".aris", "templates", "RESEARCH_BRIEF_TEMPLATE.md"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.repaired).toBe(true);
    await expect(
      readFile(path.join(projectDir, ".aris", "templates", "RESEARCH_BRIEF_TEMPLATE.md"), "utf-8"),
    ).resolves.toBe("# Brief\n");
  });

  it("FAILS when source dist/ is an empty directory", async () => {
    await rm(path.join(arisSource, "dist"), { recursive: true });
    await mkdir(path.join(arisSource, "dist"), { recursive: true });

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
  });

  // --- Non-original-sentinel helper failures ---

  it("FAILS when source dist/tools/arxiv-fetch.js (non-sentinel) is missing", async () => {
    await rm(path.join(arisSource, "dist", "tools", "arxiv-fetch.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("dist/tools/arxiv-fetch.js");
  });

  it("FAILS when source dist/skills/figure-spec/figure-renderer.js (owner helper) is missing", async () => {
    await rm(path.join(arisSource, "dist", "skills", "figure-spec", "figure-renderer.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("dist/skills/figure-spec/figure-renderer.js");
  });

  it("repairs target when non-sentinel dist/tools/arxiv-fetch.js is deleted", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    await rm(path.join(projectDir, ".aris", "dist", "tools", "arxiv-fetch.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.repaired).toBe(true);
    await expect(
      access(path.join(projectDir, ".aris", "dist", "tools", "arxiv-fetch.js")),
    ).resolves.toBeUndefined();
  });

  // --- Repair and upgrade ---

  it("repairs when target dist/tools/research-wiki.js is deleted", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    await rm(path.join(projectDir, ".aris", "dist", "tools", "research-wiki.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.skippedReason).toBe("already_installed");
    expect(result.repaired).toBe(true);
    // Repaired helper must be executable
    const helperPath = path.join(projectDir, ".aris", "dist", "tools", "research-wiki.js");
    const output = execFileSync(process.execPath, [helperPath, "repaired"], {
      encoding: "utf-8",
    });
    expect(JSON.parse(output)).toMatchObject({ ok: true, action: "repaired" });
  });

  it("repairs missing tools/ and templates/ on revisit", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    await rm(path.join(projectDir, ".aris", "tools"), { recursive: true });
    await rm(path.join(projectDir, ".aris", "templates"), { recursive: true });

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.repaired).toBe(true);
    await expect(
      readFile(path.join(projectDir, ".aris", "tools", "save_trace.sh"), "utf-8"),
    ).resolves.toContain("trace");
    await expect(
      readFile(path.join(projectDir, ".aris", "templates", "RESEARCH_BRIEF_TEMPLATE.md"), "utf-8"),
    ).resolves.toBe("# Brief\n");
  });

  it("upgrades v1 manifest to v2 on revisit", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    // Downgrade manifest to v1 format
    const manifestPath = path.join(projectDir, ".aris", "installed-skills.txt");
    const v1Content = [
      "version\t1",
      `repo_root\t${arisSource}`,
      `project_root\t${projectDir}`,
      `generated\t2024-01-01T00:00:00Z`,
      "kind\tname\tsource_rel\ttarget_rel\tmode",
      "skill\tdemo-skill\tskills/demo-skill\t.claude/skills/demo-skill\tcopy",
      "",
    ].join("\n");
    await writeFile(manifestPath, v1Content, "utf-8");

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.skippedReason).toBe("already_installed");
    expect(result.upgraded).toBe(true);
    const manifest = await readFile(manifestPath, "utf-8");
    expect(manifest).toContain("version\t2");
    expect(manifest).toContain("runtime_file\t");
  });

  it("returns runtime_incomplete when repair fails (source also broken)", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    // Break both target and source
    await rm(path.join(projectDir, ".aris", "dist", "tools", "research-wiki.js"));
    await rm(path.join(arisSource, "dist", "tools", "research-wiki.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("dist/tools/research-wiki.js");
  });

  // --- Snapshot ownership: source changes must not affect existing projects ---

  it("source adding new-helper.js does NOT affect installed project", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    // Source adds a new file after installation
    await writeFile(
      path.join(arisSource, "dist", "tools", "new-helper.js"),
      "#!/usr/bin/env node\n",
      "utf-8",
    );
    await writeFile(
      path.join(arisSource, "src", "tools", "new-helper.ts"),
      "export {};\n",
      "utf-8",
    );

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    // Must skip — the project's recorded inventory has no new-helper.js
    expect(result.skippedReason).toBe("already_installed");
    expect(result.repaired).toBeFalsy();
    // new-helper.js must NOT appear in target
    await expect(
      access(path.join(projectDir, ".aris", "dist", "tools", "new-helper.js")),
    ).rejects.toThrow();
  });

  it("repair restores only the deleted file without overwriting modified siblings", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    // Modify a sibling: project customizes run-state.js
    const modifiedContent = '#!/usr/bin/env node\nconsole.log("project-modified");\n';
    await writeFile(
      path.join(projectDir, ".aris", "dist", "tools", "run-state.js"),
      modifiedContent,
      "utf-8",
    );
    // Delete a different helper
    await rm(path.join(projectDir, ".aris", "dist", "tools", "evidence-check.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.repaired).toBe(true);
    // evidence-check.js restored
    await expect(
      access(path.join(projectDir, ".aris", "dist", "tools", "evidence-check.js")),
    ).resolves.toBeUndefined();
    // run-state.js modification preserved
    await expect(
      readFile(path.join(projectDir, ".aris", "dist", "tools", "run-state.js"), "utf-8"),
    ).resolves.toBe(modifiedContent);
  });

  // --- Dependency inventory completeness ---

  it("FAILS when source node_modules/commander/index.js is missing", async () => {
    await rm(path.join(arisSource, "node_modules", "commander", "index.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.installed).toBe(false);
    expect(result.skippedReason).toBe("runtime_incomplete");
    expect(result.missingRuntime).toContain("node_modules/commander/index.js");
  });

  it("repairs target when node_modules/commander/index.js is deleted", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });
    await rm(path.join(projectDir, ".aris", "node_modules", "commander", "index.js"));

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result.repaired).toBe(true);
    await expect(
      access(path.join(projectDir, ".aris", "node_modules", "commander", "index.js")),
    ).resolves.toBeUndefined();
  });
});
