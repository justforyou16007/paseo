import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "../lib/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(
  __dirname,
  "../../skills/paper-illustration-image2/scripts/paper_illustration_image2.py",
);

exec("python3", [target, ...process.argv.slice(2)]);
