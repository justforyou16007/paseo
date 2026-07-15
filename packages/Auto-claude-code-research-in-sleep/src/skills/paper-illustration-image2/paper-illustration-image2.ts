#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createCli, runCli } from "../../lib/cli.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveWorkspace(rawWorkspace: string | undefined): string {
  const workspace = rawWorkspace ? path.resolve(rawWorkspace) : process.cwd();
  return path.resolve(workspace);
}

function outputDir(workspace: string): string {
  return path.resolve(workspace, "figures", "ai_generated");
}

function ensurePngFile(filePath: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`missing PNG file: ${filePath}`);
  }
  const header = Buffer.alloc(8);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`expected a PNG file: ${filePath}`);
  }
}

function writeJson(filePath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function emitJson(payload: Record<string, unknown>, jsonOut?: string): number {
  if (jsonOut) {
    writeJson(jsonOut, payload);
  }
  console.log(JSON.stringify(payload, null, 2));
  return payload.ok ? 0 : 1;
}

function runPreflight(workspace: string, jsonOut?: string): number {
  const figuresDir = outputDir(workspace);
  fs.mkdirSync(figuresDir, { recursive: true });

  let codexBin: string | null = null;
  try {
    codexBin =
      execFileSync("which", ["codex"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || null;
  } catch {
    // which failed — codex not found
  }

  const payload: Record<string, unknown> = {
    ok: false,
    workspace,
    outputDir: figuresDir,
    codexBin,
    checkedAt: utcNow(),
  };

  if (!codexBin) {
    payload.error = "codex CLI not found on PATH";
    return emitJson(payload, jsonOut);
  }

  try {
    const result = execFileSync(codexBin, ["debug", "app-server", "send-message-v2", "ping"], {
      cwd: workspace,
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    void result;
    payload.returncode = 0;
    payload.ok = true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const e = err as { status: number; stdout?: string; stderr?: string };
      payload.returncode = e.status;
      payload.ok = false;
      payload.error = ((e.stderr || e.stdout || "codex app-server ping failed") as string).trim();
    } else if (err && typeof err === "object" && "killed" in err) {
      payload.error = "codex app-server ping timed out";
    } else {
      payload.error = String(err);
    }
  }

  return emitJson(payload, jsonOut);
}

function buildLatexInclude(caption: string, label: string): string {
  return [
    "\\begin{figure*}[t]",
    "    \\centering",
    "    \\includegraphics[width=0.95\\textwidth]{figures/ai_generated/figure_final.png}",
    `    \\caption{${caption}}`,
    `    \\label{${label}}`,
    "\\end{figure*}",
    "",
  ].join("\n");
}

function runFinalize(
  workspace: string,
  opts: {
    bestImage: string;
    caption: string;
    label: string;
    score?: number;
    reviewSummary?: string;
    jsonOut?: string;
  },
): number {
  const figuresDir = outputDir(workspace);
  fs.mkdirSync(figuresDir, { recursive: true });

  const bestImage = path.resolve(opts.bestImage);
  ensurePngFile(bestImage);

  const finalImage = path.join(figuresDir, "figure_final.png");
  const latexInclude = path.join(figuresDir, "latex_include.tex");
  const reviewLog = path.join(figuresDir, "review_log.json");

  fs.copyFileSync(bestImage, finalImage);
  fs.writeFileSync(latexInclude, buildLatexInclude(opts.caption, opts.label), "utf-8");

  const reviewPayload: Record<string, unknown> = {
    ok: true,
    finalizedAt: utcNow(),
    workspace,
    bestImage,
    finalImage,
    score: opts.score ?? null,
    reviewSummary: opts.reviewSummary ?? null,
    caption: opts.caption,
    label: opts.label,
  };
  writeJson(reviewLog, reviewPayload);

  const payload: Record<string, unknown> = {
    ok: true,
    workspace,
    artifacts: {
      figureFinal: finalImage,
      latexInclude,
      reviewLog,
    },
    score: opts.score ?? null,
    reviewSummary: opts.reviewSummary ?? null,
    finalizedAt: reviewPayload.finalizedAt,
  };
  return emitJson(payload, opts.jsonOut);
}

function runVerify(workspace: string, jsonOut?: string): number {
  const figuresDir = outputDir(workspace);
  const finalImage = path.join(figuresDir, "figure_final.png");
  const latexInclude = path.join(figuresDir, "latex_include.tex");
  const reviewLog = path.join(figuresDir, "review_log.json");

  const errors: string[] = [];
  const artifacts: Record<string, { path: string; exists: boolean }> = {
    figureFinal: {
      path: finalImage,
      exists: fs.existsSync(finalImage) && fs.statSync(finalImage).isFile(),
    },
    latexInclude: {
      path: latexInclude,
      exists: fs.existsSync(latexInclude) && fs.statSync(latexInclude).isFile(),
    },
    reviewLog: {
      path: reviewLog,
      exists: fs.existsSync(reviewLog) && fs.statSync(reviewLog).isFile(),
    },
  };

  if (artifacts.figureFinal.exists) {
    try {
      ensurePngFile(finalImage);
    } catch (exc) {
      errors.push(String(exc));
    }
  } else {
    errors.push(`missing artifact: ${finalImage}`);
  }

  if (artifacts.latexInclude.exists) {
    const latexText = fs.readFileSync(latexInclude, "utf-8");
    if (!latexText.includes("figure_final.png")) {
      errors.push("latex_include.tex does not reference figures/ai_generated/figure_final.png");
    }
  } else {
    errors.push(`missing artifact: ${latexInclude}`);
  }

  if (artifacts.reviewLog.exists) {
    try {
      const reviewPayload = JSON.parse(fs.readFileSync(reviewLog, "utf-8"));
      if (String(reviewPayload.finalImage) !== finalImage) {
        errors.push("review_log.json does not point at figure_final.png");
      }
    } catch (exc) {
      errors.push(`review_log.json is not valid JSON: ${exc}`);
    }
  } else {
    errors.push(`missing artifact: ${reviewLog}`);
  }

  const payload: Record<string, unknown> = {
    ok: errors.length === 0,
    workspace,
    checkedAt: utcNow(),
    artifacts,
    errors,
  };
  return emitJson(payload, jsonOut);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = createCli(
  "paper-illustration-image2",
  "Integration helper for the paper-illustration-image2 workflow",
);

program
  .command("preflight")
  .description("Check that Codex image generation is available")
  .option("--workspace <path>", "Paper or project workspace root")
  .option("--json-out <path>", "Optional path to save the JSON result")
  .action((opts: { workspace?: string; jsonOut?: string }) => {
    const workspace = resolveWorkspace(opts.workspace);
    const jsonOut = opts.jsonOut ? path.resolve(opts.jsonOut) : undefined;
    process.exitCode = runPreflight(workspace, jsonOut);
  });

program
  .command("finalize")
  .description("Finalize the accepted figure artifacts")
  .option("--workspace <path>", "Paper or project workspace root")
  .requiredOption("--best-image <path>", "Accepted PNG to promote to figure_final.png")
  .option(
    "--caption <text>",
    "Caption text to place in latex_include.tex",
    "[Replace with a paper-ready caption].",
  )
  .option("--label <text>", "LaTeX figure label", "fig:replace-me")
  .option("--score <n>", "Final review score")
  .option("--review-summary <text>", "Short review summary for review_log.json")
  .option("--json-out <path>", "Optional path to save the JSON result")
  .action(
    (opts: {
      workspace?: string;
      bestImage: string;
      caption: string;
      label: string;
      score?: string;
      reviewSummary?: string;
      jsonOut?: string;
    }) => {
      const workspace = resolveWorkspace(opts.workspace);
      const jsonOut = opts.jsonOut ? path.resolve(opts.jsonOut) : undefined;
      process.exitCode = runFinalize(workspace, {
        bestImage: opts.bestImage,
        caption: opts.caption,
        label: opts.label,
        score: opts.score !== undefined ? parseFloat(opts.score) : undefined,
        reviewSummary: opts.reviewSummary,
        jsonOut,
      });
    },
  );

program
  .command("verify")
  .description("Verify that final artifacts were emitted correctly")
  .option("--workspace <path>", "Paper or project workspace root")
  .option("--json-out <path>", "Optional path to save the JSON result")
  .action((opts: { workspace?: string; jsonOut?: string }) => {
    const workspace = resolveWorkspace(opts.workspace);
    const jsonOut = opts.jsonOut ? path.resolve(opts.jsonOut) : undefined;
    process.exitCode = runVerify(workspace, jsonOut);
  });

runCli(program);
