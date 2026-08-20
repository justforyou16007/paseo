#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { extractFlowAudit } from "../skill-flow-audit/extract.js";
import { renderFlowAuditHtml } from "../skill-flow-audit/render.js";

interface Options {
  root?: string;
  output?: string;
}

const program = new Command()
  .name("skill-flow-audit")
  .description(
    "Generate a self-contained HTML program execution flowchart for ARIS skills and helpers.",
  )
  .version("0.1.0");

program
  .option("--root <dir>", "ARIS source root", process.cwd())
  .option("--output <file>", "HTML output path, relative to root", "docs/aris-skill-flow.html")
  .action((options: Options) => {
    const root = path.resolve(options.root ?? process.cwd());
    const outputArgument = options.output ?? "docs/aris-skill-flow.html";
    const output = path.isAbsolute(outputArgument)
      ? outputArgument
      : path.resolve(root, outputArgument);
    const audit = extractFlowAudit(root);
    const html = renderFlowAuditHtml(audit);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, html, "utf8");

    const relativeOutput = path.relative(root, output) || path.basename(output);
    process.stdout.write(
      [
        `Wrote ${relativeOutput}`,
        `${audit.coverage.skillFiles} skills, ${audit.coverage.scriptFiles} scripts, ${audit.coverage.toolFiles} tools`,
        `${audit.stats.entries} entry flows, ${audit.stats.calls} calls, ${audit.stats.artifacts} artifact links`,
        `${audit.stats.reviewWarnings} items need review; ${audit.stats.infoWarnings} outputs may be final deliverables`,
      ].join("\n") + "\n",
    );
  });

program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
