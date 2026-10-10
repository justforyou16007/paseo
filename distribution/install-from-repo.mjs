import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const distribution = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(distribution, "..");
const args = process.argv.slice(2);
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node.js 22.12+ required");

// Let the installer handle its own arguments and help, without preparing a bundle.
if (args.includes("--help")) {
  const result = spawnSync(process.execPath, [path.join(distribution, "install.mjs"), ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const checkout = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
});
if (
  checkout.error ||
  checkout.status !== 0 ||
  fs.realpathSync(checkout.stdout.trim()) !== fs.realpathSync(root)
) {
  throw new Error("Run distribution/install-aris.sh from a local ARL Git checkout.");
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.name !== "auto-research-loop")
  throw new Error("This checkout is not the standalone ARL repository.");
for (const relative of [
  "node_modules/typescript/package.json",
  "node_modules/commander/package.json",
  "dist/tools/setup-cli.js",
  "dist/tools/validation-cli.js",
]) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(
      `Local runtime is incomplete (${relative}). Prepare this checkout with npm ci and npm run build, then rerun the installer. Installation does not download dependencies.`,
    );
  }
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arl-local-install-"));
let status = 1;
try {
  const staged = spawnSync(
    process.execPath,
    [path.join(root, "tools/pack-arl.mjs"), "--directory", temp],
    { encoding: "utf8" },
  );
  if (staged.error) throw staged.error;
  if (staged.status !== 0)
    throw new Error(`Could not assemble the local ARL runtime. ${staged.stderr}`);
  const result = spawnSync(process.execPath, [path.join(temp, "arl/install.mjs"), ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
process.exitCode = status;
