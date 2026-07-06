import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileAsync = promisify(execFile);

// Walk up from this file to find the monorepo root (works in both source/tsx
// and dist modes since the file depth relative to repo root differs between them).
const ARIS_INSTALL_SCRIPT = (() => {
  const ARIS_RELATIVE = [
    "packages",
    "Auto-claude-code-research-in-sleep",
    "tools",
    "install_aris.sh",
  ];
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== "/") {
    const candidate = resolve(dir, ...ARIS_RELATIVE);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  // Not bundled — fall through so installArisIfAvailable skips silently.
  return "";
})();

/**
 * Install ARIS skills in a target project directory.
 *
 * ARIS (Auto-claude-code-research-in-sleep) is a research automation harness
 * bundled with Paseo at packages/Auto-claude-code-research-in-sleep/. When
 * present, its skills are symlinked into the target project's .claude/skills/
 * directory so that agent slash-commands (e.g. /idea-discovery) are available.
 *
 * Silently skips if ARIS is not bundled with this Paseo installation.
 * Best-effort: never throws, logs warnings on failure.
 */
export async function installArisIfAvailable(
  targetDir: string,
  logger?: Pick<Logger, "info" | "warn">,
): Promise<void> {
  if (!existsSync(ARIS_INSTALL_SCRIPT)) {
    return; // ARIS not bundled — skip silently
  }

  logger?.info({ targetDir }, "Installing ARIS skills in project");

  try {
    const { stderr } = await execFileAsync(
      "bash",
      [ARIS_INSTALL_SCRIPT, targetDir, "--quiet", "--no-doc"],
      { cwd: targetDir, timeout: 60_000 },
    );
    if (stderr?.trim()) {
      logger?.warn({ targetDir, stderr: stderr.trim() }, "ARIS install stderr");
    }
  } catch (error) {
    logger?.warn({ err: error, targetDir }, "Failed to install ARIS in project");
  }
}
