import { existsSync, readFileSync } from "node:fs";
import { access, cp, lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const MANIFEST_VERSION = "1";
const MANIFEST_NAME = "installed-skills.txt";
const SAFE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUPPORT_NAMES = new Set(["shared-references"]);
const EXCLUDE_NAMES = new Set(["skills-codex.bak"]);
// Build artifacts that must not follow the skill bundle into a project.
const COPY_EXCLUDE_BASENAMES = new Set(["__pycache__", "node_modules", ".git"]);

interface ArisAutoInstallOptions {
  cwd: string;
  logger: Logger;
}

interface ArisAutoInstallResult {
  installed: boolean;
  skippedReason?: "already_installed" | "aris_source_not_found" | "error";
  skillCount?: number;
}

interface UpstreamEntry {
  kind: "skill" | "support" | "agent";
  name: string;
  sourceRel: string;
  targetRel: string;
}

let _cachedArisRepoPath: string | null | undefined;

function isMonorepoRoot(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return parsed.name === "paseo";
  } catch {
    return false;
  }
}

function resolveArisRepoPath(): string | null {
  if (_cachedArisRepoPath !== undefined) return _cachedArisRepoPath;

  const thisModuleDir = path.dirname(fileURLToPath(import.meta.url));
  let current = thisModuleDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath) && isMonorepoRoot(packageJsonPath)) {
      const candidate = path.join(current, "packages", "Auto-claude-code-research-in-sleep");
      _cachedArisRepoPath = existsSync(path.join(candidate, "skills")) ? candidate : null;
      return _cachedArisRepoPath;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  _cachedArisRepoPath = null;
  return null;
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await lstat(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Existence check that does not follow symlinks, so a dangling symlink still counts
// as occupied and is never silently overwritten.
async function pathExistsLstat(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function checkSafetyS9(cwd: string, logger: Logger): Promise<boolean> {
  const criticalPaths = [
    path.join(cwd, ".aris"),
    path.join(cwd, ".claude"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".claude", "agents"),
  ];
  for (const p of criticalPaths) {
    if (await isSymlink(p)) {
      logger.warn({ path: p }, "ARIS auto-install: critical directory is a symlink, skipping (S9)");
      return false;
    }
  }
  return true;
}

async function scanUpstreamSkills(arisRepo: string): Promise<UpstreamEntry[]> {
  const entries: UpstreamEntry[] = [];
  const skillsDir = path.join(arisRepo, "skills");

  let dirents;
  try {
    dirents = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const name = dirent.name;
    if (!SAFE_NAME_REGEX.test(name)) continue;
    if (EXCLUDE_NAMES.has(name)) continue;

    if (SUPPORT_NAMES.has(name)) {
      entries.push({
        kind: "support",
        name,
        sourceRel: `skills/${name}`,
        targetRel: `.claude/skills/${name}`,
      });
      continue;
    }

    const hasSkillMd = existsSync(path.join(skillsDir, name, "SKILL.md"));
    if (hasSkillMd) {
      entries.push({
        kind: "skill",
        name,
        sourceRel: `skills/${name}`,
        targetRel: `.claude/skills/${name}`,
      });
    }
  }

  return entries;
}

async function scanUpstreamAgents(arisRepo: string): Promise<UpstreamEntry[]> {
  const entries: UpstreamEntry[] = [];
  const agentsDir = path.join(arisRepo, "agents");

  let dirents;
  try {
    dirents = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    if (!dirent.name.endsWith(".md")) continue;
    const name = dirent.name;
    entries.push({
      kind: "agent",
      name: name.replace(/\.md$/, ""),
      sourceRel: `agents/${name}`,
      targetRel: `.claude/agents/${name}`,
    });
  }

  return entries;
}

async function copyEntrySafe(source: string, target: string, logger: Logger): Promise<boolean> {
  try {
    if (await pathExistsLstat(target)) {
      logger.warn({ target }, "ARIS auto-install: target already exists, skipping");
      return false;
    }
    await cp(source, target, {
      recursive: true,
      // Upstream may contain symlinks; materialize them so the project copy is standalone.
      dereference: true,
      force: false,
      errorOnExist: true,
      filter: (src) => !COPY_EXCLUDE_BASENAMES.has(path.basename(src)),
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, source, target }, "ARIS auto-install: failed to copy entry");
    return false;
  }
}

function buildManifest(arisRepo: string, cwd: string, entries: UpstreamEntry[]): string {
  const lines: string[] = [];
  lines.push(`version\t${MANIFEST_VERSION}`);
  lines.push(`repo_root\t${arisRepo}`);
  lines.push(`project_root\t${cwd}`);
  lines.push(`generated\t${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  lines.push("kind\tname\tsource_rel\ttarget_rel\tmode");
  for (const entry of entries) {
    lines.push(`${entry.kind}\t${entry.name}\t${entry.sourceRel}\t${entry.targetRel}\tcopy`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function ensureArisSkillsInstalled(
  options: ArisAutoInstallOptions,
): Promise<ArisAutoInstallResult> {
  const { cwd, logger } = options;

  try {
    const arisRepo = resolveArisRepoPath();
    if (!arisRepo) {
      logger.debug("ARIS auto-install: ARIS source not found, skipping");
      return { installed: false, skippedReason: "aris_source_not_found" };
    }

    const manifestPath = path.join(cwd, ".aris", MANIFEST_NAME);
    if (await pathExists(manifestPath)) {
      return { installed: false, skippedReason: "already_installed" };
    }

    if (!(await checkSafetyS9(cwd, logger))) {
      return { installed: false, skippedReason: "error" };
    }

    const [skills, agents] = await Promise.all([
      scanUpstreamSkills(arisRepo),
      scanUpstreamAgents(arisRepo),
    ]);
    const allEntries = [...skills, ...agents];

    if (allEntries.length === 0) {
      logger.warn("ARIS auto-install: no skills or agents found in ARIS source");
      return { installed: false, skippedReason: "error" };
    }

    await mkdir(path.join(cwd, ".claude", "skills"), { recursive: true });
    await mkdir(path.join(cwd, ".claude", "agents"), { recursive: true });
    await mkdir(path.join(cwd, ".aris"), { recursive: true });

    const installedEntries: UpstreamEntry[] = [];
    for (const entry of allEntries) {
      const source = path.join(arisRepo, entry.sourceRel);
      const target = path.join(cwd, entry.targetRel);
      const created = await copyEntrySafe(source, target, logger);
      if (created) {
        installedEntries.push(entry);
      }
    }

    const toolsTarget = path.join(cwd, ".aris", "tools");
    await copyEntrySafe(path.join(arisRepo, "tools"), toolsTarget, logger);

    const manifestContent = buildManifest(arisRepo, cwd, installedEntries);
    const manifestTmp = `${manifestPath}.tmp.${process.pid}`;
    await writeFile(manifestTmp, manifestContent, "utf-8");
    await rename(manifestTmp, manifestPath);

    const skillCount = installedEntries.filter((e) => e.kind === "skill").length;
    logger.info(
      { cwd, skillCount, totalEntries: installedEntries.length },
      "ARIS skills auto-installed",
    );
    return { installed: true, skillCount };
  } catch (error) {
    logger.warn({ err: error, cwd }, "ARIS auto-install failed");
    return { installed: false, skippedReason: "error" };
  }
}
