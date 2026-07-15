import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "../../lib/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, "../../../skills/render-html/scripts/render_html.py");

exec("python3", [target, ...process.argv.slice(2)]);
