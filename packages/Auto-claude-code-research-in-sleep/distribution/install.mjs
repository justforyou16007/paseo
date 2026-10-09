import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    project: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log("bash install.sh --provider claude|codex --project PATH [--dry-run] [--force]");
  process.exit(0);
}
if (!values.project || !["claude", "codex"].includes(values.provider)) {
  throw new Error("Specify --provider claude|codex and --project PATH. See --help.");
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node.js 22.12+ required");

const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(values.project);
const provider = values.provider;
const skills = provider === "codex" ? ".agents/skills" : ".claude/skills";
const manifestFile = path.join(root, ".aris/install.json");
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function safeRelative(relative) {
  return (
    typeof relative === "string" &&
    relative !== "" &&
    !relative.includes("\\") &&
    !path.isAbsolute(relative) &&
    relative.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function destination(relative) {
  if (!safeRelative(relative)) throw new Error(`Unsafe install path: ${relative}`);
  const target = path.join(root, relative);
  let current = target;
  while (true) {
    if (
      fs.existsSync(current) ||
      (() => {
        try {
          return fs.lstatSync(current).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}
destination(".aris/install.json");
const previous = fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  : null;
if (previous && previous.provider !== provider) {
  throw new Error(`This project uses ${previous.provider}; keep the same provider when updating.`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (manifest.format !== 1 || !Array.isArray(manifest.files))
  throw new Error("Invalid ARL archive manifest");
const planned = [];
const hashes = {};
for (const entry of manifest.files) {
  if (!safeRelative(entry.path)) throw new Error("Invalid archive path");
  const bytes = fs.readFileSync(path.join(source, entry.path));
  if (digest(bytes) !== entry.sha256)
    throw new Error(`Archive integrity check failed: ${entry.path}`);
  const isSkill = entry.path.startsWith("skills/");
  if (
    !isSkill &&
    !/^(dist|templates|node_modules)\//.test(entry.path) &&
    entry.path !== "package.json"
  )
    continue;
  const relative = isSkill ? `${skills}/${entry.path.slice(7)}` : `.aris/${entry.path}`;
  const contents =
    provider === "codex" && entry.path.endsWith(".md")
      ? Buffer.from(bytes.toString("utf8").replaceAll(".claude/skills", ".agents/skills"))
      : bytes;
  const target = destination(relative);
  const nextHash = digest(contents);
  hashes[relative] = nextHash;
  if (fs.existsSync(target)) {
    const currentHash = digest(fs.readFileSync(target));
    if (currentHash === nextHash) continue;
    if (!values.force && currentHash !== previous?.files?.[relative]) {
      throw new Error(
        `Local file differs: ${relative}. Save your edits, then use --force to replace it.`,
      );
    }
  }
  planned.push({ target, contents, relative });
}
const removed = [];
for (const [relative, oldHash] of Object.entries(previous?.files ?? {})) {
  if (Object.hasOwn(hashes, relative)) continue;
  if (
    !relative.startsWith(`${skills}/`) &&
    !/^\.aris\/(dist|templates|node_modules)\//.test(relative)
  ) {
    throw new Error(`Invalid managed path: ${relative}`);
  }
  const target = destination(relative);
  if (!fs.existsSync(target)) continue;
  if (!values.force && digest(fs.readFileSync(target)) !== oldHash) {
    throw new Error(
      `Removed upstream but locally edited: ${relative}. Save it before using --force.`,
    );
  }
  removed.push(target);
}
if (!values["dry-run"]) {
  for (const { target, contents } of planned) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.arl-${process.pid}`;
    fs.writeFileSync(temp, contents);
    fs.renameSync(temp, target);
  }
  for (const target of removed) fs.unlinkSync(target);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const temp = `${manifestFile}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify({ format: 1, version: manifest.version, provider, files: hashes }, null, 2) +
      "\n",
  );
  fs.renameSync(temp, manifestFile);
}
console.log(
  JSON.stringify(
    {
      project: root,
      provider,
      version: manifest.version,
      dry_run: values["dry-run"],
      written: planned.map((entry) => entry.relative),
      removed,
    },
    null,
    2,
  ),
);
console.log(
  "Next: open this project in official Paseo with the selected provider and invoke aris-setup worker or aris-setup validation. Codex must trust the project to load .codex/config.toml. Reopen an existing session after updating.",
);
