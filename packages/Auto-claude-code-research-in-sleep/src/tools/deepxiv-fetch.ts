import { createCli, runCli } from "../lib/cli.js";
import { run } from "../lib/run.js";

const INSTALL_MESSAGE = "deepxiv CLI not found. Install it with: pip install deepxiv-sdk";

function ensureDeepxivInstalled(): { ok: boolean; binary: string | null; message: string } {
  try {
    const result = run("which", ["deepxiv"], { capture: true });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { ok: true, binary: result.stdout.trim(), message: "" };
    }
  } catch {
    // which not found or other error
  }
  return { ok: false, binary: null, message: INSTALL_MESSAGE };
}

function runDeepxivCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const install = ensureDeepxivInstalled();
  if (!install.ok) {
    throw new Error(install.message);
  }
  return run(install.binary!, args, { capture: true });
}

function raiseForFailed(result: { stdout: string; stderr: string; exitCode: number }): void {
  if (result.exitCode === 0) return;
  const message = (result.stderr || result.stdout || "deepxiv command failed").trim();
  throw new Error(message);
}

function runCliJson(args: string[]): unknown {
  const proc = runDeepxivCli(args);
  raiseForFailed(proc);
  try {
    return JSON.parse(proc.stdout);
  } catch {
    throw new Error("deepxiv returned invalid JSON output");
  }
}

function runCliText(args: string[]): string {
  const proc = runDeepxivCli(args);
  raiseForFailed(proc);
  return proc.stdout.trim();
}

interface SearchOpts {
  maxResults: string;
  mode: string;
  categories?: string;
  minCitations?: string;
  dateFrom?: string;
  dateTo?: string;
}

function dispatchJson(command: string, opts: Record<string, unknown>): unknown {
  if (command === "search") {
    const o = opts as unknown as SearchOpts & { query: string };
    const cliArgs = [
      "search",
      o.query,
      "--limit",
      o.maxResults,
      "--mode",
      o.mode,
      "--format",
      "json",
    ];
    if (o.categories) cliArgs.push("--categories", o.categories);
    if (o.minCitations != null) cliArgs.push("--min-citations", o.minCitations);
    if (o.dateFrom) cliArgs.push("--date-from", o.dateFrom);
    if (o.dateTo) cliArgs.push("--date-to", o.dateTo);
    return runCliJson(cliArgs);
  }

  if (command === "paper-brief") {
    return runCliJson(["paper", opts.arxivId as string, "--brief", "--format", "json"]);
  }

  if (command === "paper-head") {
    return runCliJson(["paper", opts.arxivId as string, "--head", "--format", "json"]);
  }

  if (command === "paper-section") {
    return runCliJson([
      "paper",
      opts.arxivId as string,
      "--section",
      opts.sectionName as string,
      "--format",
      "json",
    ]);
  }

  if (command === "trending") {
    return runCliJson([
      "trending",
      "--days",
      opts.days as string,
      "--limit",
      opts.maxResults as string,
      "--output",
      "json",
    ]);
  }

  if (command === "wsearch") {
    return runCliJson(["wsearch", opts.query as string, "--output", "json"]);
  }

  if (command === "sc") {
    return runCliJson(["sc", opts.semanticScholarId as string, "--output", "json"]);
  }

  if (command === "health") {
    const text = runCliText(["health"]);
    return { ok: true, output: text };
  }

  throw new Error(`Unsupported command: ${command}`);
}

const program = createCli("deepxiv-fetch", "ARIS wrapper around the installed deepxiv CLI.");

program
  .command("search")
  .description("Search papers through DeepXiv")
  .argument("<query>")
  .option("--max <n>", "Maximum results", "10")
  .option("--mode <mode>", "Search mode", "hybrid")
  .option("--categories <cats>")
  .option("--min-citations <n>")
  .option("--date-from <date>")
  .option("--date-to <date>")
  .action((query: string, opts) => {
    const payload = dispatchJson("search", {
      query,
      maxResults: opts.max,
      mode: opts.mode,
      categories: opts.categories,
      minCitations: opts.minCitations,
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
    });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("paper-brief")
  .description("Fetch brief paper metadata and TLDR")
  .argument("<arxiv_id>")
  .action((arxivId: string) => {
    const payload = dispatchJson("paper-brief", { arxivId });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("paper-head")
  .description("Fetch paper metadata and section overview")
  .argument("<arxiv_id>")
  .action((arxivId: string) => {
    const payload = dispatchJson("paper-head", { arxivId });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("paper-section")
  .description("Fetch one paper section")
  .argument("<arxiv_id>")
  .argument("<section_name>")
  .action((arxivId: string, sectionName: string) => {
    const payload = dispatchJson("paper-section", { arxivId, sectionName });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("trending")
  .description("Fetch trending papers")
  .option("--days <days>", "Time period", "7")
  .option("--max <n>", "Maximum results", "10")
  .action((opts) => {
    const payload = dispatchJson("trending", { days: opts.days, maxResults: opts.max });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("wsearch")
  .description("Search the web through DeepXiv")
  .argument("<query>")
  .action((query: string) => {
    const payload = dispatchJson("wsearch", { query });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("sc")
  .description("Fetch Semantic Scholar metadata by ID")
  .argument("<semantic_scholar_id>")
  .action((semanticScholarId: string) => {
    const payload = dispatchJson("sc", { semanticScholarId });
    console.log(JSON.stringify(payload, null, 2));
  });

program
  .command("health")
  .description("Run DeepXiv health check")
  .option("--json", "Return JSON wrapper")
  .action((opts) => {
    const payload = dispatchJson("health", {}) as { ok: boolean; output: string };
    if (!opts.json) {
      console.log(payload.output);
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
  });

runCli(program);
