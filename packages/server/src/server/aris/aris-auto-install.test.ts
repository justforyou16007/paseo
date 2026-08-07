import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { ensureArisSkillsInstalled } from "./aris-auto-install.js";

const logger = pino({ level: "silent" });

async function createArisSource(root: string): Promise<void> {
  await mkdir(path.join(root, "skills", "demo-skill"), { recursive: true });
  await writeFile(path.join(root, "skills", "demo-skill", "SKILL.md"), "# demo\n", "utf-8");
  await mkdir(path.join(root, "agents"), { recursive: true });
  await writeFile(path.join(root, "agents", "demo-agent.md"), "# agent\n", "utf-8");
  await mkdir(path.join(root, "tools"), { recursive: true });
  await writeFile(path.join(root, "tools", "research_wiki.py"), "# helper\n", "utf-8");
  // Compiled tools — the primary dependency skills invoke at runtime
  await mkdir(path.join(root, "dist", "tools"), { recursive: true });
  await writeFile(
    path.join(root, "dist", "tools", "research-wiki.js"),
    "#!/usr/bin/env node\n",
    "utf-8",
  );
  await mkdir(path.join(root, "dist", "lib"), { recursive: true });
  await writeFile(
    path.join(root, "dist", "lib", "cli.js"),
    'import { Command } from "commander";\n',
    "utf-8",
  );
  // Runtime dependency for compiled tools
  await mkdir(path.join(root, "node_modules", "commander"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", "commander", "index.js"),
    "module.exports = {};\n",
    "utf-8",
  );
  // Templates for research-setup, meta-optimize, etc.
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(root, "templates", "RESEARCH_BRIEF_TEMPLATE.md"), "# Brief\n", "utf-8");
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
    // Without this the resolver falls back to walking up to the monorepo root,
    // which only exists when the daemon runs from a source checkout — the exact
    // gap that left packaged and remote daemons installing nothing.
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

  it("installs skills from the ARIS checkout named by PASEO_ARIS_REPO", async () => {
    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result).toEqual({ installed: true, skillCount: 1 });
    await expect(
      readFile(path.join(projectDir, ".claude", "skills", "demo-skill", "SKILL.md"), "utf-8"),
    ).resolves.toBe("# demo\n");
    await expect(
      readFile(path.join(projectDir, ".claude", "agents", "demo-agent.md"), "utf-8"),
    ).resolves.toBe("# agent\n");
    await expect(
      readFile(path.join(projectDir, ".aris", "tools", "research_wiki.py"), "utf-8"),
    ).resolves.toBe("# helper\n");
  });

  it("records the resolved checkout as repo_root so skills can find the helpers", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    const manifest = await readFile(
      path.join(projectDir, ".aris", "installed-skills.txt"),
      "utf-8",
    );
    expect(manifest).toContain(`repo_root\t${arisSource}`);
    expect(manifest).toContain("skill\tdemo-skill\tskills/demo-skill\t.claude/skills/demo-skill");
  });

  it("skips a project that already has a manifest", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    const second = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(second).toEqual({ installed: false, skippedReason: "already_installed" });
  });

  it("copies compiled dist/, node_modules/, and templates/ into .aris/", async () => {
    await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    await expect(
      readFile(path.join(projectDir, ".aris", "dist", "tools", "research-wiki.js"), "utf-8"),
    ).resolves.toBe("#!/usr/bin/env node\n");
    await expect(
      readFile(path.join(projectDir, ".aris", "dist", "lib", "cli.js"), "utf-8"),
    ).resolves.toContain("commander");
    await expect(
      readFile(path.join(projectDir, ".aris", "node_modules", "commander", "index.js"), "utf-8"),
    ).resolves.toContain("module.exports");
    await expect(
      readFile(path.join(projectDir, ".aris", "templates", "RESEARCH_BRIEF_TEMPLATE.md"), "utf-8"),
    ).resolves.toBe("# Brief\n");
  });

  it("succeeds even when dist/ and templates/ do not exist in source", async () => {
    await rm(path.join(arisSource, "dist"), { recursive: true });
    await rm(path.join(arisSource, "templates"), { recursive: true });
    await rm(path.join(arisSource, "node_modules"), { recursive: true });

    const result = await ensureArisSkillsInstalled({ cwd: projectDir, logger });

    expect(result).toEqual({ installed: true, skillCount: 1 });
    // dist/ should not exist in target
    await expect(access(path.join(projectDir, ".aris", "dist"))).rejects.toThrow();
  });
});
