#!/usr/bin/env node
/**
 * The single answer to "is the browser-act CLI usable in this project". Prints
 * one JSON object and exits 1 when it is not; with `--check` it never installs
 * or fetches anything. It never creates a browser, logs in or sets an API key:
 * browser-act's confirmation gate keeps those interactive. See
 * skills/shared-references/browser-act.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, run } from "../lib/run.js";
import { providerSkillsDir } from "./provider.js";

const PACKAGE = "browser-act-cli";
const PYTHON_VERSION = "3.12";
const SKILL_URL = "https://raw.githubusercontent.com/browser-act/skills/main/browser-act/SKILL.md";
const SKILL_DIR = path.join(providerSkillsDir(process.cwd()), "browser-act");

/** `uv tool install` puts its shim in uv's bin directory, which may not be on PATH yet. */
function locate(): string | null {
  const found = findExecutable("browser-act");
  if (found) return found;
  const name = process.platform === "win32" ? "browser-act.exe" : "browser-act";
  const uvBin = findExecutable("uv")
    ? run("uv", ["tool", "dir", "--bin"], { capture: true })
    : null;
  for (const dir of [
    path.join(os.homedir(), ".local", "bin"),
    ...(uvBin?.exitCode === 0 ? [uvBin.stdout.trim()] : []),
  ]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The stub is how a host discovers browser-act for interactive work; generated ops do not need it. */
async function ensureSkillStub(check: boolean): Promise<string | null> {
  const stub = path.join(SKILL_DIR, "SKILL.md");
  if (fs.existsSync(stub)) return stub;
  if (check || !fs.existsSync(path.dirname(SKILL_DIR))) return null;
  try {
    const response = await fetch(SKILL_URL);
    const text = response.ok ? await response.text() : "";
    if (!text.startsWith("---")) throw new Error(`unexpected response ${response.status}`);
    fs.mkdirSync(SKILL_DIR, { recursive: true });
    fs.writeFileSync(stub, text);
    return stub;
  } catch (error) {
    console.error(
      `WARN: could not fetch the browser-act skill stub from ${SKILL_URL} (${String(error)}). Agent-driven browser work needs it; generated ops do not.`,
    );
    return null;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "--check")) {
    console.error("usage: ensure-browser-act.js [--check]");
    return 1;
  }
  const check = args[0] === "--check";
  let hint: string | null = null;
  let installedNow = false;
  let binary = locate();

  if (!binary && !check) {
    if (!findExecutable("uv"))
      hint = `uv is not installed. Install it (https://docs.astral.sh/uv/) then re-run, or install browser-act manually: uv tool install ${PACKAGE} --python ${PYTHON_VERSION}`;
    else {
      console.error(`browser-act not found; installing ${PACKAGE} (python ${PYTHON_VERSION})`);
      const install = run("uv", ["tool", "install", PACKAGE, "--python", PYTHON_VERSION], {
        capture: true,
      });
      process.stderr.write(install.stderr);
      if (install.exitCode === 0) {
        installedNow = true;
        binary = locate();
        if (!binary)
          hint =
            "uv tool install succeeded but the browser-act shim is not on PATH. Add the output of `uv tool dir --bin` to PATH.";
      } else
        hint = `uv tool install ${PACKAGE} failed. Re-run it manually to see the resolver error.`;
    }
  }

  let version: string | null = null;
  if (binary) {
    const probe = run(binary, ["--version"], { capture: true });
    version = probe.exitCode === 0 ? probe.stdout.trim() || null : null;
    if (!version)
      hint = `browser-act resolved at ${binary} but \`--version\` failed. Reinstall: uv tool upgrade ${PACKAGE}`;
  }
  const usable = Boolean(binary && version);
  console.log(
    JSON.stringify({
      tool: "browser-act",
      status: usable ? (installedNow ? "installed" : "ok") : "missing",
      binary,
      version,
      in_path: findExecutable("browser-act") !== null,
      installed_now: installedNow,
      skill_stub: await ensureSkillStub(check),
      hint: usable
        ? null
        : (hint ??
          `browser-act is not installed. Run: uv tool install ${PACKAGE} --python ${PYTHON_VERSION}`),
    }),
  );
  return usable ? 0 : 1;
}

process.exitCode = await main();
