import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
});
