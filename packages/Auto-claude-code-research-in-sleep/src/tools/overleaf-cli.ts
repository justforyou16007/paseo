#!/usr/bin/env node
/**
 * Overleaf Git bridge helper for /overleaf-sync.
 *
 * `setup` is for the owner's own terminal, never an agent: it reads the token
 * from a hidden prompt, hands it straight to the git credential helper and
 * clones without it, so no URL, argv, file or chat ever holds the token.
 * `audit` looks for leaked tokens and never prints one. `mirror` replaces
 * rsync, which Windows does not have.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCli, runCli } from "../lib/cli.js";

const TOKEN = /olp_[A-Za-z0-9]{20,}/;
const TOKEN_ALL = new RegExp(TOKEN.source, "g");
const HOST = "git.overleaf.com";
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** LaTeX build output and OS litter never travel between the two copies. */
const MIRROR_SKIP =
  /^(\.git|\.DS_Store|Thumbs\.db)$|\.(aux|log|bbl|blg|fls|fdb_latexmk|out|synctex\.gz|toc)$/;
const HOOK = `#!/bin/sh
# Installed by overleaf-cli setup: refuse to commit anything that looks like an Overleaf token.
if git diff --cached | grep -qE '${TOKEN.source}'; then
  echo "ERROR: Overleaf token pattern (olp_...) in staged changes. Remove it and revoke the token at https://www.overleaf.com/user/settings" >&2
  exit 1
fi
`;

const program = createCli("overleaf", "Set up, audit and mirror an Overleaf Git bridge clone");

function git(args: string[], options: { cwd?: string; input?: string } = {}): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** For lookups where a non-zero exit only means "nothing here". */
function gitQuiet(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function credentialHelper(): string {
  if (process.platform === "darwin") return "osxkeychain";
  if (process.platform === "win32") return "manager";
  // Linux has no keychain git knows about by default; the cache keeps the token in memory for a day.
  return "cache --timeout=86400";
}

/** Read one line without echoing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

program
  .command("setup")
  .description("One-time bridge setup; run it yourself in a terminal, never through an agent")
  .argument("<project>", "Overleaf project id or URL")
  .argument("[dir]", "clone directory", "paper-overleaf")
  .action(async (project: string, dir: string) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        "ERROR: setup needs an interactive terminal (PowerShell, Windows Terminal or a shell). Do not run it through an agent; the token must not enter the chat.",
      );
      process.exit(1);
    }
    const id = project.split("?")[0]!.replace(/\/+$/, "").split("/").pop()!;
    if (!/^[a-f0-9]{20,}$/.test(id)) {
      console.error(
        `ERROR: '${id}' does not look like an Overleaf project id (20+ hex characters).`,
      );
      process.exit(1);
    }
    if (fs.existsSync(dir)) {
      console.error(`ERROR: '${dir}' already exists. Remove it or choose another directory.`);
      process.exit(1);
    }
    console.log(`Setting up the Overleaf bridge for ${id} in ./${dir}/`);
    console.log("Create a token at https://www.overleaf.com/user/settings > Git Integration.\n");
    const token = await readHidden("Overleaf token (input hidden): ");
    if (!token) {
      console.error("ERROR: empty token");
      process.exit(1);
    }
    if (!/^olp_[A-Za-z0-9]+$/.test(token))
      console.warn("WARNING: the token does not start with 'olp_'; check it if the clone fails.");

    const helper = credentialHelper();
    const url = `https://${HOST}/${id}`;
    // The helper gets the token on stdin; the clone then authenticates through it.
    git(["-c", `credential.helper=${helper}`, "credential", "approve"], {
      input: `protocol=https\nhost=${HOST}\nusername=git\npassword=${token}\n\n`,
    });
    const clone = spawnSync("git", ["-c", `credential.helper=${helper}`, "clone", url, dir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (clone.status !== 0) {
      console.error(
        "ERROR: clone failed. Check the project id and the token, then run setup again.",
      );
      process.exit(1);
    }
    git(["config", "credential.helper", helper], { cwd: dir });
    if (!gitQuiet(["config", "user.email"], dir).trim())
      console.log(`NOTE: no git user.email. Run: git -C ${dir} config user.email <your email>`);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, HOOK, { mode: 0o755 });
    console.log(`\nSetup complete.
  Clone:       ./${dir}/
  Remote URL:  ${git(["remote", "get-url", "origin"], { cwd: dir }).trim()} (no token)
  Credential:  git credential helper "${helper}"
  Pre-commit:  blocks olp_... patterns
Agents can now pull and push in ${dir}/ without seeing the token. If pull or push fails with 401, the token expired: run setup again.`);
  });

interface Finding {
  kind: "working_tree" | "remote_url" | "history" | "credential_file";
  where: string;
}

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(full);
    } else if (entry.isFile()) yield full;
  }
}

function* gitRepos(dir: string): Generator<string> {
  if (fs.existsSync(path.join(dir, ".git"))) yield dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name))
      yield* gitRepos(path.join(dir, entry.name));
}

program
  .command("audit")
  .description("Look for leaked Overleaf tokens; exits 1 when one is found")
  .argument("[root]", "directory to scan", ".")
  .action((rootArg: string) => {
    const root = path.resolve(rootArg);
    const leaks: Finding[] = [];
    const warnings: Finding[] = [];
    for (const file of files(root)) {
      if (fs.statSync(file).size > MAX_SCAN_BYTES) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (TOKEN.test(line))
          leaks.push({ kind: "working_tree", where: `${path.relative(root, file)}:${index + 1}` });
      });
    }
    for (const repo of gitRepos(root)) {
      if (TOKEN.test(gitQuiet(["remote", "-v"], repo)))
        leaks.push({ kind: "remote_url", where: path.relative(root, repo) || "." });
    }
    if (fs.existsSync(path.join(root, ".git")))
      for (const commit of gitQuiet(
        ["log", "--all", "-E", `-G${TOKEN.source}`, "--format=%h %s"],
        root,
      )
        .split("\n")
        .filter(Boolean))
        leaks.push({ kind: "history", where: commit.replace(TOKEN_ALL, "olp_<redacted>") });
    const home = os.homedir();
    for (const file of [
      path.join(home, ".netrc"),
      path.join(home, "_netrc"),
      path.join(home, ".git-credentials"),
      path.join(root, ".env"),
      path.join(root, ".envrc"),
    ])
      if (fs.existsSync(file) && TOKEN.test(fs.readFileSync(file, "utf8")))
        warnings.push({ kind: "credential_file", where: file });

    console.log(
      JSON.stringify(
        {
          clean: leaks.length === 0,
          leaks,
          warnings,
          ...(leaks.length
            ? {
                next: [
                  "Revoke the token at https://www.overleaf.com/user/settings and create a new one.",
                  "Remove the leak: edit the file, `git remote set-url`, or rewrite history with git filter-repo.",
                  "Run `overleaf-cli.js setup` again with the new token.",
                ],
              }
            : {}),
        },
        null,
        2,
      ),
    );
    if (leaks.length) process.exitCode = 1;
  });

function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (MIRROR_SKIP.test(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(path.relative(root, full).split(path.sep).join("/"), full);
    }
  };
  walk(root);
  return out;
}

program
  .command("mirror")
  .description("Make <to> match <from>, skipping .git and LaTeX build output")
  .argument("<from>")
  .argument("<to>")
  .option("--dry-run", "only list what differs")
  .action((from: string, to: string, options: { dryRun?: boolean }) => {
    const source = tree(path.resolve(from));
    const target = tree(path.resolve(to));
    const copy = [...source.keys()].filter((rel) => {
      const existing = target.get(rel);
      return !existing || !fs.readFileSync(existing).equals(fs.readFileSync(source.get(rel)!));
    });
    const remove = [...target.keys()].filter((rel) => !source.has(rel));
    if (!options.dryRun) {
      for (const rel of copy) {
        const dest = path.join(path.resolve(to), rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source.get(rel)!, dest);
      }
      for (const rel of remove) fs.rmSync(target.get(rel)!);
    }
    console.log(JSON.stringify({ dry_run: Boolean(options.dryRun), copy, remove }, null, 2));
  });

runCli(program);
