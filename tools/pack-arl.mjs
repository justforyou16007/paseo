import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directoryOnly = process.argv[2] === "--directory";
const output = path.resolve(process.argv[directoryOnly ? 3 : 2] ?? path.join(root, "artifacts"));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arl-package-"));
const stage = path.join(temp, "arl");
const skills = ["aris-setup", "validation-review", "research-wiki", "browser-act", "experiment-queue", "experiment-env-configuration", "shared-references"];
const entries = ["tools/setup-cli", "tools/validation-cli", "tools/research-wiki", "tools/capture-filter", "tools/ensure-browser-act", "tools/experiment-env/env-helper", "tools/experiment-env/parse-env", "skills/experiment-queue/queue-manager", "skills/experiment-queue/build-manifest"];
const visited = new Set();

function copy(relative) {
  const target = path.join(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, relative), target, { recursive: true, dereference: true, filter: (file) => !file.split(path.sep).some((part) => ["__pycache__", "node_modules", ".git"].includes(part)) });
}
function runtime(relative) {
  if (visited.has(relative)) return;
  if (!relative.startsWith("dist/")) throw new Error(`Runtime escaped dist: ${relative}`);
  visited.add(relative);
  copy(relative);
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
    if (imported.fileName.startsWith(".")) runtime(path.posix.normalize(path.posix.join(path.posix.dirname(relative), imported.fileName)));
  }
}
try {
  for (const entry of entries) runtime(`dist/${entry}.js`);
  for (const skill of skills) copy(`skills/${skill}`);
  copy("templates");
  copy("LICENSE");
  copy("SETUP_GUIDE_CN.md");
  copy("SETUP_GUIDE.md");
  fs.copyFileSync(path.join(root, "SETUP_GUIDE.md"), path.join(stage, "README.md"));
  for (const name of ["install.sh", "install.mjs"]) fs.copyFileSync(path.join(root, "distribution", name), path.join(stage, name));
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "auto-research-loop", version, private: true, type: "module", engines: { node: ">=22.12.0" } }, null, 2) + "\n");
  const require = createRequire(path.join(root, "package.json"));
  const commander = path.dirname(require.resolve("commander"));
  fs.cpSync(commander, path.join(stage, "node_modules/commander"), { recursive: true, dereference: true });
  const files = [];
  function inventory(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) inventory(path.join(dir, entry.name), `${relative}/`);
      else files.push({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, entry.name))).digest("hex") });
    }
  }
  inventory(stage);
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ format: 1, version, files }, null, 2) + "\n");
  fs.mkdirSync(output, { recursive: true });
  if (directoryOnly) {
    const bundle = path.join(output, "arl");
    if (fs.existsSync(bundle)) throw new Error(`Bundle directory already exists: ${bundle}`);
    fs.cpSync(stage, bundle, { recursive: true });
    console.log(bundle);
  } else {
    const archive = path.join(output, `arl-${version}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", temp, "arl"]);
    const sum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    fs.writeFileSync(`${archive}.sha256`, `${sum}  ${path.basename(archive)}\n`);
    console.log(archive);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
