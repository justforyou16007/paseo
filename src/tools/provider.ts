import fs from "node:fs";
import path from "node:path";
import { failA1, isRecord } from "./validate.js";

export type ArlProvider = "claude" | "codex";

export function installedProvider(root: string): ArlProvider {
  const file = path.join(root, ".aris", "install.json");
  if (!fs.existsSync(file)) return "claude";
  const installed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(installed) || (installed.provider !== "claude" && installed.provider !== "codex")) {
    failA1("INVALID_VALUE", "invalid ARL installation provider", file);
  }
  return installed.provider;
}

export function providerSkillsDir(root: string): string {
  const provider = installedProvider(root);
  return path.join(root, provider === "codex" ? ".agents" : ".claude", "skills");
}

/** Markers own only this server; unrelated TOML, including comments, stays byte-for-byte. */
export function writeCodexValidationMcp(root: string, url: string, token: string): string {
  const file = path.join(root, ".codex", "config.toml");
  const begin = "# ARL VALIDATION MCP BEGIN";
  const end = "# ARL VALIDATION MCP END";
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const start = current.indexOf(begin);
  const finish = current.indexOf(end);
  const hasMarkers = start >= 0 && finish > start;
  if ((start >= 0 || finish >= 0) && !hasMarkers) {
    failA1("INVALID_VALUE", "repair incomplete ARL MCP markers before setup", file);
  }
  const outside = hasMarkers
    ? current.slice(0, start) + current.slice(finish + end.length)
    : current;
  if (/^\s*\[\s*mcp_servers\s*\.\s*["']?aris-validation["']?\s*[.\]]/m.test(outside)) {
    failA1(
      "INVALID_VALUE",
      "move the existing aris-validation MCP entry out before applying ARL setup",
      file,
    );
  }
  const block = [
    begin,
    '[mcp_servers."aris-validation"]',
    `url = ${JSON.stringify(url)}`,
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`,
    end,
  ].join("\n");
  const next = hasMarkers
    ? current.slice(0, start) + block + current.slice(finish + end.length)
    : `${current}${current.endsWith("\n") || !current ? "" : "\n"}\n${block}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
