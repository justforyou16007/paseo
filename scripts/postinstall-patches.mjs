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
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";

// ── 1. Apply patches ──────────────────────────────────────────────────
// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Packages that npm does not hoist to the
// workspace root live in their workspace's own node_modules, and patch-package resolves
// the patch's node_modules/... paths relative to its working directory.
let patchExitCode = 0;

const patchedPackages = [
  {
    nodeModulesPath: "node_modules/react-native-markdown-display",
    patchPrefix: "react-native-markdown-display+",
  },
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
  {
    nodeModulesPath: "packages/server/node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: "packages/server",
  },
];

const installedPackages = patchedPackages.filter(({ nodeModulesPath }) =>
  existsSync(nodeModulesPath),
);

if (existsSync("patches") && installedPackages.length > 0) {
  const patchFiles = readdirSync("patches").filter((file) => file.endsWith(".patch"));

  // Group patch files by the directory patch-package must run from.
  const patchFilesByCwd = new Map();
  for (const { patchPrefix, cwd = "." } of installedPackages) {
    const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
    if (files.length === 0) {
      continue;
    }
    const group = patchFilesByCwd.get(cwd) ?? [];
    group.push(...files);
    patchFilesByCwd.set(cwd, group);
  }

  if (patchFilesByCwd.size > 0) {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "patch-package.cmd" : "patch-package";

    let groupIndex = 0;
    for (const [cwd, files] of patchFilesByCwd) {
      groupIndex += 1;
      const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${groupIndex}`);

      mkdirSync(tempPatchDir, { recursive: true });
      for (const patchFile of files) {
        copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
      }

      let result;
      try {
        result = spawnSync(cmd, ["--patch-dir", relative(cwd, tempPatchDir)], {
          cwd,
          shell: isWindows,
          stdio: "inherit",
          windowsHide: true,
        });
      } finally {
        rmSync(tempPatchDir, { recursive: true, force: true });
      }

      if (result.error) {
        console.error("postinstall-patches: patch-package failed to spawn:", result.error.message);
      }
      if (result.status !== 0) {
        // Stop applying further patches but keep going so the ARIS skill link step below
        // still runs; surface the failure code at the final exit.
        patchExitCode = result.status ?? 1;
        break;
      }
    }
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
      // Not a symlink - don't touch it
      needsLink = false;
    }
  } catch {
    // Doesn't exist - proceed to create
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
