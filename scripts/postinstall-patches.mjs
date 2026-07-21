import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── 1. Apply patches ──────────────────────────────────────────────────
// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.

let patchExitCode = 0;

const patchedPackages = [
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
];

const installedPatchPrefixes = patchedPackages
  .filter(({ nodeModulesPath }) => existsSync(nodeModulesPath))
  .map(({ patchPrefix }) => patchPrefix);

if (existsSync("patches") && installedPatchPrefixes.length > 0) {
  const patchFilesToApply = readdirSync("patches").filter(
    (file) =>
      file.endsWith(".patch") &&
      installedPatchPrefixes.some((patchPrefix) => file.startsWith(patchPrefix)),
  );

  if (patchFilesToApply.length > 0) {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "patch-package.cmd" : "patch-package";
    const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}`);

    mkdirSync(tempPatchDir, { recursive: true });
    for (const patchFile of patchFilesToApply) {
      copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
    }

    let result;
    try {
      result = spawnSync(cmd, ["--patch-dir", tempPatchDir], {
        shell: isWindows,
        stdio: "inherit",
        windowsHide: true,
      });
    } finally {
      rmSync(tempPatchDir, { recursive: true, force: true });
    }

    patchExitCode = result.status ?? 1;
  }
}

// ── 2. Install research-setup as a global Claude Code skill ───────────
// Makes /research-setup available in any workspace so users can bootstrap
// ARIS in new projects without first installing ARIS skills locally.

const arisSkillSource = resolve(
  "packages/Auto-claude-code-research-in-sleep/skills/research-setup",
);
const globalSkillsDir = join(homedir(), ".claude", "skills");
const globalSkillLink = join(globalSkillsDir, "research-setup");

if (existsSync(arisSkillSource)) {
  mkdirSync(globalSkillsDir, { recursive: true });

  let needsLink = true;
  try {
    const stat = lstatSync(globalSkillLink);
    if (stat.isSymbolicLink()) {
      const currentTarget = readlinkSync(globalSkillLink);
      if (resolve(currentTarget) === resolve(arisSkillSource)) {
        needsLink = false;
      } else {
        rmSync(globalSkillLink);
      }
    } else {
      // Not a symlink — don't touch it
      needsLink = false;
    }
  } catch {
    // Doesn't exist — proceed to create
  }

  if (needsLink) {
    try {
      symlinkSync(arisSkillSource, globalSkillLink);
    } catch {
      // Non-fatal: skill won't be globally available but install continues
    }
  }
}

process.exit(patchExitCode);
