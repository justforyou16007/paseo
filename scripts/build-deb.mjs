#!/usr/bin/env node
// Builds a .deb containing the Paseo daemon, the paseo CLI and the bundled
// browser web UI.
//
// Two things about this build are not obvious:
//
// 1. Nothing here builds the front end. `npm pack --workspace=@getpaseo/server`
//    runs that package's prepack, which runs build:daemon-web-ui and drops the
//    export into dist/server/web-ui — and `files` ships dist/server. So the
//    packed server tarball already carries the page the daemon serves.
//
// 2. The seven tarballs go into ONE `npm install -g` on purpose. The packages
//    depend on each other by exact version, and those versions are published,
//    so installing them one at a time would pull siblings from the registry
//    and silently package released code instead of this working tree. Given
//    together, npm satisfies the inter-package dependencies from the tarballs.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEBIAN_SRC = path.join(REPO_ROOT, "packaging", "debian");
const BUILD_ROOT = path.join(REPO_ROOT, "dist-deb");
const PACKS_DIR = path.join(BUILD_ROOT, "packs");

// Dependency order: each prepack does a clean build, and the server build reads
// the declarations the client and protocol builds emit.
const WORKSPACES = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];

const SERVER_ENTRY = "lib/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js";

function parseArgs(argv) {
  const args = { skipPack: false, maintainer: "Paseo packaging <root@localhost>" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-pack") args.skipPack = true;
    else if (arg === "--version") args.version = argv[++i];
    else if (arg === "--arch") args.arch = argv[++i];
    else if (arg === "--maintainer") args.maintainer = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function run(command, cmdArgs, options = {}) {
  execFileSync(command, cmdArgs, { stdio: "inherit", cwd: REPO_ROOT, ...options });
}

function capture(command, cmdArgs) {
  return execFileSync(command, cmdArgs, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function step(message) {
  console.log(`\n\x1b[1m==> ${message}\x1b[0m`);
}

function packWorkspaces() {
  rmSync(PACKS_DIR, { recursive: true, force: true });
  mkdirSync(PACKS_DIR, { recursive: true });
  for (const workspace of WORKSPACES) {
    step(`npm pack @getpaseo/${workspace}`);
    run("npm", ["pack", `--workspace=@getpaseo/${workspace}`, "--pack-destination", PACKS_DIR], {
      env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
    });
  }
}

function installIntoStage(stageDir) {
  const prefix = path.join(stageDir, "usr", "lib", "paseo");
  mkdirSync(prefix, { recursive: true });
  const tarballs = readdirSync(PACKS_DIR)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => path.join(PACKS_DIR, name));
  if (tarballs.length !== WORKSPACES.length) {
    throw new Error(
      `expected ${WORKSPACES.length} tarballs in ${PACKS_DIR}, found ${tarballs.length}`,
    );
  }

  step(`npm install -g --prefix ${path.relative(REPO_ROOT, prefix)}`);
  run("npm", ["install", "-g", "--prefix", prefix, ...tarballs], {
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
  });

  // A missing entrypoint here means npm laid the tree out somewhere else; the
  // systemd unit hardcodes this path, so fail now rather than at first boot.
  const entry = path.join(prefix, SERVER_ENTRY);
  if (!existsSync(entry)) throw new Error(`daemon entrypoint missing after install: ${entry}`);
  run("node", ["--check", entry]);

  const webUi = path.join(
    prefix,
    "lib/node_modules/@getpaseo/server/dist/server/web-ui/index.html",
  );
  if (!existsSync(webUi)) {
    throw new Error(
      `bundled web UI missing: ${webUi}\nThe server prepack should have produced it.`,
    );
  }
  return prefix;
}

function stageFiles(stageDir, prefix) {
  step("staging systemd units, env template and CLI symlink");

  const share = path.join(stageDir, "usr", "share", "paseo");
  mkdirSync(share, { recursive: true });
  cpSync(path.join(DEBIAN_SRC, "paseo.env.example"), path.join(share, "paseo.env.example"));

  const systemUnits = path.join(stageDir, "usr", "lib", "systemd", "system");
  const userUnits = path.join(stageDir, "usr", "lib", "systemd", "user");
  mkdirSync(systemUnits, { recursive: true });
  mkdirSync(userUnits, { recursive: true });
  cpSync(path.join(DEBIAN_SRC, "paseo.service"), path.join(systemUnits, "paseo.service"));
  cpSync(path.join(DEBIAN_SRC, "paseo-user.service"), path.join(userUnits, "paseo.service"));

  // Relative so the link stays correct inside the staging tree and after install.
  const binDir = path.join(stageDir, "usr", "bin");
  mkdirSync(binDir, { recursive: true });
  const cliLink = path.join(binDir, "paseo");
  rmSync(cliLink, { force: true });
  symlinkSync("../lib/paseo/bin/paseo", cliLink);
  if (!existsSync(path.join(prefix, "bin", "paseo"))) {
    throw new Error("npm did not create bin/paseo in the install prefix");
  }
}

function writeControl(stageDir, { version, arch, maintainer }) {
  const debianDir = path.join(stageDir, "DEBIAN");
  mkdirSync(debianDir, { recursive: true });

  const installedSize = capture("du", ["-sk", "--exclude=DEBIAN", stageDir]).split(/\s+/)[0];
  const control = readFileSync(path.join(DEBIAN_SRC, "control.in"), "utf8")
    .replaceAll("@VERSION@", version)
    .replaceAll("@ARCH@", arch)
    .replaceAll("@MAINTAINER@", maintainer)
    .replaceAll("@INSTALLED_SIZE@", installedSize);
  writeFileSync(path.join(debianDir, "control"), control);

  for (const script of ["postinst", "prerm", "postrm"]) {
    const target = path.join(debianDir, script);
    cpSync(path.join(DEBIAN_SRC, script), target);
    chmodSync(target, 0o755);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version =
    args.version ?? JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
  const arch = args.arch ?? capture("dpkg", ["--print-architecture"]);
  // Debian versions cannot contain '-' outside the revision field; 0.7.0-beta.1
  // becomes 0.7.0~beta.1, which also sorts before the final 0.7.0 release.
  const debVersion = version.replace(/-/g, "~");

  const stageDir = path.join(BUILD_ROOT, `paseo_${debVersion}_${arch}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  if (args.skipPack) {
    step("reusing existing tarballs (--skip-pack)");
  } else {
    packWorkspaces();
  }

  const prefix = installIntoStage(stageDir);
  stageFiles(stageDir, prefix);
  writeControl(stageDir, { version: debVersion, arch, maintainer: args.maintainer });

  const output = args.out ?? path.join(BUILD_ROOT, `paseo_${debVersion}_${arch}.deb`);
  step(`dpkg-deb --build ${path.relative(REPO_ROOT, output)}`);
  run("dpkg-deb", ["--build", "--root-owner-group", stageDir, output]);

  console.log(`\n\x1b[32mBuilt ${output}\x1b[0m`);
  run("dpkg-deb", ["--info", output]);
}

main();
