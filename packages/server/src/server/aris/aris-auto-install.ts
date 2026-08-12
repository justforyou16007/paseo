import { existsSync, readFileSync, readdirSync } from "node:fs";
import { access, cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { resolvePaseoHome } from "../paseo-home.js";

const MANIFEST_VERSION = "2";
const MANIFEST_NAME = "installed-skills.txt";
const SAFE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUPPORT_NAMES = new Set(["shared-references"]);
const EXCLUDE_NAMES = new Set(["skills-codex.bak"]);
const COPY_EXCLUDE_BASENAMES = new Set(["__pycache__", "node_modules", ".git"]);

interface ArisAutoInstallOptions {
  cwd: string;
  logger: Logger;
}

interface ArisAutoInstallResult {
  installed: boolean;
  skippedReason?: "already_installed" | "aris_source_not_found" | "runtime_incomplete" | "error";
  repaired?: boolean;
  upgraded?: boolean;
  skillCount?: number;
  missingRuntime?: string[];
}

interface UpstreamEntry {
  kind: "skill" | "support" | "agent";
  name: string;
  sourceRel: string;
  targetRel: string;
}

let _cachedArisRepoPath: string | null | undefined;
let _warnedArisRepoNotFound = false;

const ARIS_REPO_ENV_VARS = ["PASEO_ARIS_REPO", "ARIS_REPO"] as const;

function isMonorepoRoot(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return parsed.name === "paseo";
  } catch {
    return false;
  }
}

function expandHomeDir(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function isArisRepo(candidate: string): boolean {
  return existsSync(path.join(candidate, "skills"));
}

function findMonorepoArisRepo(): string | null {
  let current = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath) && isMonorepoRoot(packageJsonPath)) {
      const candidate = path.join(current, "packages", "Auto-claude-code-research-in-sleep");
      return isArisRepo(candidate) ? candidate : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findArisRepoPath(logger: Logger): string | null {
  const tried: string[] = [];

  for (const envVar of ARIS_REPO_ENV_VARS) {
    const configured = process.env[envVar]?.trim();
    if (!configured) continue;
    const resolved = path.resolve(expandHomeDir(configured));
    if (isArisRepo(resolved)) return resolved;
    logger.warn(
      { envVar, path: resolved },
      "ARIS auto-install: configured ARIS path has no skills/ directory",
    );
    tried.push(`$${envVar}=${resolved}`);
  }

  const monorepoArisRepo = findMonorepoArisRepo();
  if (monorepoArisRepo) return monorepoArisRepo;
  tried.push("<paseo checkout>/packages/Auto-claude-code-research-in-sleep");

  const paseoHomeArisRepo = path.join(resolvePaseoHome(), "aris");
  if (isArisRepo(paseoHomeArisRepo)) return paseoHomeArisRepo;
  tried.push(paseoHomeArisRepo);

  if (!_warnedArisRepoNotFound) {
    _warnedArisRepoNotFound = true;
    logger.warn(
      { tried },
      "ARIS auto-install: no ARIS checkout found, skills will not be installed into projects. " +
        "Set $PASEO_ARIS_REPO to an ARIS checkout, or clone one into $PASEO_HOME/aris.",
    );
  }
  return null;
}

function resolveArisRepoPath(logger: Logger): string | null {
  if (_cachedArisRepoPath && isArisRepo(_cachedArisRepoPath)) return _cachedArisRepoPath;
  _cachedArisRepoPath = undefined;
  const found = findArisRepoPath(logger);
  if (found) _cachedArisRepoPath = found;
  return found;
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
    path.join(cwd, ".aris", "dist"),
    path.join(cwd, ".aris", "node_modules"),
    path.join(cwd, ".aris", "templates"),
    path.join(cwd, ".aris", "tools"),
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

async function copyDirUnfiltered(source: string, target: string, logger: Logger): Promise<boolean> {
  try {
    if (await pathExistsLstat(target)) {
      return false;
    }
    await cp(source, target, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, source, target }, "ARIS auto-install: failed to copy entry");
    return false;
  }
}

async function copyDirForce(
  source: string,
  target: string,
  logger: Logger,
  opts?: { filter?: (src: string) => boolean },
): Promise<boolean> {
  try {
    if (await pathExistsLstat(target)) {
      await rm(target, { recursive: true, force: true });
    }
    await cp(source, target, {
      recursive: true,
      dereference: true,
      force: true,
      filter: opts?.filter,
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, source, target }, "ARIS auto-install: failed to force-copy entry");
    return false;
  }
}

/** Recursively collect all files under dir, relative to base. */
function collectFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, base));
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results;
}

function collectDepInventory(arisRepo: string): string[] {
  const result: string[] = [];
  const pkgPath = path.join(arisRepo, "package.json");
  if (!existsSync(pkgPath)) return result;

  let deps: string[];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    deps = Object.keys(pkg.dependencies ?? {});
  } catch {
    return result;
  }

  for (const dep of deps) {
    const depDir = path.join(arisRepo, "node_modules", dep);
    result.push(path.join("node_modules", dep, "package.json"));
    if (!existsSync(depDir)) continue;

    for (const f of collectFiles(depDir, arisRepo)) {
      if (!result.includes(f)) result.push(f);
    }

    const depPkgPath = path.join(depDir, "package.json");
    if (!existsSync(depPkgPath)) continue;
    try {
      const depPkg = JSON.parse(readFileSync(depPkgPath, "utf-8"));
      const main = depPkg.main ?? "index.js";
      const mainPath = path.join("node_modules", dep, main);
      if (!result.includes(mainPath)) result.push(mainPath);
    } catch {}
  }

  return result;
}

/**
 * Build a complete runtime inventory from the source tree.
 * Cross-checks src/*.ts against dist/*.js to catch incomplete builds.
 */
export function buildSourceInventory(arisRepo: string): string[] {
  const inventory: string[] = [];

  const distDir = path.join(arisRepo, "dist");
  if (existsSync(distDir)) {
    for (const f of collectFiles(distDir, arisRepo)) {
      if (f.endsWith(".js") && !f.endsWith(".d.ts")) {
        inventory.push(f);
      }
    }
  }

  const srcDir = path.join(arisRepo, "src");
  if (existsSync(srcDir)) {
    for (const f of collectFiles(srcDir, arisRepo)) {
      if (f.endsWith(".ts") && !f.endsWith(".d.ts")) {
        const distEquiv = f.replace(/^src\//, "dist/").replace(/\.ts$/, ".js");
        if (!inventory.includes(distEquiv)) {
          inventory.push(distEquiv);
        }
      }
    }
  }

  const toolsDir = path.join(arisRepo, "tools");
  if (existsSync(toolsDir)) {
    for (const f of collectFiles(toolsDir, arisRepo)) {
      if (f.endsWith(".sh")) inventory.push(f);
    }
  }

  const templatesDir = path.join(arisRepo, "templates");
  if (existsSync(templatesDir)) {
    for (const f of collectFiles(templatesDir, arisRepo)) {
      inventory.push(f);
    }
  }

  inventory.push(...collectDepInventory(arisRepo));

  return inventory;
}

/** Check which inventory files are missing relative to a root. */
export function checkInventory(root: string, inventory: string[]): string[] {
  const missing: string[] = [];
  for (const file of inventory) {
    if (!existsSync(path.join(root, file))) {
      missing.push(file);
    }
  }
  return missing;
}

function buildManifest(
  arisRepo: string,
  cwd: string,
  entries: UpstreamEntry[],
  runtimeFiles: string[],
): string {
  const lines: string[] = [];
  lines.push(`version\t${MANIFEST_VERSION}`);
  lines.push(`repo_root\t${arisRepo}`);
  lines.push(`project_root\t${cwd}`);
  lines.push(`generated\t${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  lines.push("kind\tname\tsource_rel\ttarget_rel\tmode");
  for (const entry of entries) {
    lines.push(`${entry.kind}\t${entry.name}\t${entry.sourceRel}\t${entry.targetRel}\tcopy`);
  }
  for (const rf of runtimeFiles) {
    lines.push(`runtime_file\t${rf}`);
  }
  lines.push("");
  return lines.join("\n");
}

function parseManifestVersion(manifestPath: string): string | null {
  try {
    const content = readFileSync(manifestPath, "utf-8");
    for (const line of content.split("\n")) {
      const [key, value] = line.split("\t");
      if (key === "version") return value ?? null;
    }
  } catch {}
  return null;
}

function parseManifestField(manifestPath: string, field: string): string | null {
  try {
    const content = readFileSync(manifestPath, "utf-8");
    for (const line of content.split("\n")) {
      const [key, value] = line.split("\t");
      if (key === field) return value ?? null;
    }
  } catch {}
  return null;
}

function parseManifestRuntimeFiles(manifestPath: string): string[] {
  let content: string;
  try {
    content = readFileSync(manifestPath, "utf-8");
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const line of content.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] === "runtime_file" && parts[1]) {
      if (!isSafeRuntimeFile(parts[1])) {
        throw new Error(`unsafe runtime_file path '${parts[1]}'`);
      }
      files.push(parts[1]);
    }
  }
  return files;
}

function isSafeRuntimeFile(file: string): boolean {
  if (path.isAbsolute(file) || file.includes("\0")) return false;
  const parts = file.split(/[\\/]+/);
  const allowedRoots = new Set(["dist", "node_modules", "templates", "tools"]);
  return (
    allowedRoots.has(parts[0] ?? "") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function repairRuntime(
  arisRepo: string,
  cwd: string,
  missing: string[],
  logger: Logger,
): Promise<{ repaired: boolean; stillMissing: string[] }> {
  logger.info(
    { missingCount: missing.length, cwd },
    "ARIS auto-install: repairing recorded missing files",
  );

  for (const f of missing) {
    const source = path.join(arisRepo, f);
    const target = path.join(cwd, ".aris", f);
    if (!existsSync(source)) continue;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { dereference: true, force: true });
    } catch (error) {
      logger.warn({ err: error, file: f }, "ARIS auto-install: failed to restore file");
    }
  }

  const stillMissing = missing.filter((f) => !existsSync(path.join(cwd, ".aris", f)));
  return { repaired: stillMissing.length === 0, stillMissing };
}

async function handleExistingManifest(
  manifestPath: string,
  arisRepo: string,
  cwd: string,
  logger: Logger,
): Promise<ArisAutoInstallResult> {
  const version = parseManifestVersion(manifestPath);
  const projectRoot = parseManifestField(manifestPath, "project_root");

  if (projectRoot && projectRoot !== cwd) {
    logger.info(
      { expected: cwd, found: projectRoot },
      "ARIS auto-install: project_root mismatch, will repair",
    );
  }

  const targetRoot = path.join(cwd, ".aris");
  const recordedFiles = parseManifestRuntimeFiles(manifestPath);

  // v1 or early v2 without runtime_file rows: upgrade by recording current source inventory
  const needsUpgrade = version !== MANIFEST_VERSION || recordedFiles.length === 0;

  let inventoryToCheck: string[];
  if (recordedFiles.length > 0) {
    inventoryToCheck = recordedFiles;
  } else {
    inventoryToCheck = buildSourceInventory(arisRepo);
  }

  const targetMissing = checkInventory(targetRoot, inventoryToCheck);
  const needsRepair = targetMissing.length > 0;

  if (!needsUpgrade && !needsRepair && projectRoot === cwd) {
    return { installed: false, skippedReason: "already_installed" };
  }

  if (needsRepair) {
    const { repaired, stillMissing } = await repairRuntime(arisRepo, cwd, targetMissing, logger);
    if (!repaired) {
      logger.warn(
        { stillMissing, cwd },
        "ARIS auto-install: runtime incomplete after repair attempt.",
      );
      return {
        installed: false,
        skippedReason: "runtime_incomplete",
        missingRuntime: stillMissing,
      };
    }
  }

  if (needsUpgrade || projectRoot !== cwd) {
    const [skills, agents] = await Promise.all([
      scanUpstreamSkills(arisRepo),
      scanUpstreamAgents(arisRepo),
    ]);
    // When upgrading, record the current target's actual files as the inventory
    const currentInventory =
      recordedFiles.length > 0 ? recordedFiles : buildSourceInventory(arisRepo);
    const manifestContent = buildManifest(arisRepo, cwd, [...skills, ...agents], currentInventory);
    const manifestTmp = `${manifestPath}.tmp.${process.pid}`;
    await writeFile(manifestTmp, manifestContent, "utf-8");
    await rename(manifestTmp, manifestPath);
    logger.info({ cwd, fromVersion: version }, "ARIS auto-install: manifest upgraded to v2");
  }

  return {
    installed: false,
    skippedReason: "already_installed",
    repaired: needsRepair,
    upgraded: needsUpgrade,
  };
}

export async function ensureArisSkillsInstalled(
  options: ArisAutoInstallOptions,
): Promise<ArisAutoInstallResult> {
  const { cwd, logger } = options;

  try {
    const arisRepo = resolveArisRepoPath(logger);
    if (!arisRepo) {
      return { installed: false, skippedReason: "aris_source_not_found" };
    }

    if (!(await checkSafetyS9(cwd, logger))) {
      return { installed: false, skippedReason: "error" };
    }

    const manifestPath = path.join(cwd, ".aris", MANIFEST_NAME);
    if (await pathExists(manifestPath)) {
      return await handleExistingManifest(manifestPath, arisRepo, cwd, logger);
    }

    // Verify source checkout has complete runtime inventory before proceeding.
    const sourceInventory = buildSourceInventory(arisRepo);
    const sourceMissing = checkInventory(arisRepo, sourceInventory);
    if (sourceMissing.length > 0) {
      logger.warn(
        { sourceMissing: sourceMissing.slice(0, 10), total: sourceMissing.length, arisRepo },
        "ARIS auto-install: source checkout missing runtime files. " +
          "Run 'npm run build && npm install' in the ARIS checkout before installing.",
      );
      return {
        installed: false,
        skippedReason: "runtime_incomplete",
        missingRuntime: sourceMissing,
      };
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

    // Shell helpers
    const toolsSource = path.join(arisRepo, "tools");
    const toolsTarget = path.join(cwd, ".aris", "tools");
    await copyEntrySafe(toolsSource, toolsTarget, logger);

    // Compiled TypeScript tools
    const distSource = path.join(arisRepo, "dist");
    const distTarget = path.join(cwd, ".aris", "dist");
    const distCopied = await copyEntrySafe(distSource, distTarget, logger);
    if (!distCopied) {
      await copyDirForce(distSource, distTarget, logger, {
        filter: (src) => !COPY_EXCLUDE_BASENAMES.has(path.basename(src)),
      });
    }

    // Runtime dependencies
    const nodeModulesSource = path.join(arisRepo, "node_modules");
    const nmTarget = path.join(cwd, ".aris", "node_modules");
    const nmCopied = await copyDirUnfiltered(nodeModulesSource, nmTarget, logger);
    if (!nmCopied) {
      await copyDirForce(nodeModulesSource, nmTarget, logger);
    }

    // Templates
    const templatesSource = path.join(arisRepo, "templates");
    if (await pathExists(templatesSource)) {
      await copyEntrySafe(templatesSource, path.join(cwd, ".aris", "templates"), logger);
    }

    // Final inventory verification after all copies.
    const postInstallMissing = checkInventory(path.join(cwd, ".aris"), sourceInventory);
    if (postInstallMissing.length > 0) {
      logger.warn(
        { missingCount: postInstallMissing.length, sample: postInstallMissing.slice(0, 5), cwd },
        "ARIS auto-install: inventory verification failed after copy — not writing manifest.",
      );
      return {
        installed: false,
        skippedReason: "runtime_incomplete",
        missingRuntime: postInstallMissing,
      };
    }

    const manifestContent = buildManifest(arisRepo, cwd, installedEntries, sourceInventory);
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
