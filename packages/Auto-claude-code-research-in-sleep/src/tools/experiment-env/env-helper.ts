#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../../lib/cli.js";
import { EnvBackend, EnvError } from "./env-backend.js";
import { validate, writeConfig, ValidationError } from "./parse-env.js";

const DEFAULT_CONFIG = ".aris/experiment-env.json";

function loadConfig(envConfig: string): Record<string, unknown> {
  if (!fs.existsSync(envConfig)) {
    process.stderr.write(
      `ERROR: env config not found at ${envConfig}\n` +
        `       Run \`env_helper parse --json <candidate> --source CLAUDE.md\` first.\n`,
    );
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(envConfig, "utf-8")) as Record<string, unknown>;
}

function checkStale(cfg: Record<string, unknown>, envConfig: string): void {
  const source = cfg.source_path as string | undefined;
  if (!source || !fs.existsSync(source)) return;
  try {
    const st = fs.statSync(source);
    const content = fs.readFileSync(source);
    const mtime = Math.floor(st.mtimeMs / 1000);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const stale = cfg.source_mtime !== mtime || cfg.source_hash !== digest;
    if (stale) {
      process.stderr.write(
        `WARN: ${source} changed since last parse (mtime/hash mismatch); ` +
          `re-run \`env_helper parse\` to refresh ${envConfig}\n`,
      );
    }
  } catch {
    // ignore read errors
  }
}

function backendFromConfig(envConfig: string, dryRun: boolean): EnvBackend {
  const cfg = loadConfig(envConfig);
  checkStale(cfg, envConfig);
  const envType = cfg.env_type as string | undefined;
  if (!envType) {
    process.stderr.write("ERROR: env_config has no env_type\n");
    process.exit(1);
  }
  const block = cfg[envType] as Record<string, unknown> | undefined;
  if (!block) {
    process.stderr.write(`ERROR: env_type='${envType}' but no '${envType}' block in config\n`);
    process.exit(1);
  }
  const stateDir = path.dirname(path.resolve(envConfig));
  return EnvBackend.create(envType, block, stateDir, dryRun);
}

function emit(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

function readJsonFileStdin(spec: string): Record<string, unknown> {
  if (spec === "-") {
    return JSON.parse(fs.readFileSync(0, "utf-8")) as Record<string, unknown>;
  }
  return JSON.parse(fs.readFileSync(spec, "utf-8")) as Record<string, unknown>;
}

function runMethod(fn: () => Record<string, unknown>, errCode: number): void {
  try {
    const result = fn();
    emit(result);
  } catch (e) {
    if (e instanceof EnvError) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      process.exit(e.code);
    }
    if (e instanceof Error && e.message.includes("missing")) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      process.exit(errCode);
    }
    throw e;
  }
}

const program = createCli("env-helper", "Unified experiment-environment helper (ARIS)");

program
  .command("parse")
  .description("validate candidate JSON + write config")
  .requiredOption("--json <path>", "candidate JSON path or '-' for stdin")
  .option("--source <path>", "CLAUDE.md/AGENTS.md path")
  .option("--env-type <type>", "override env_type in the candidate")
  .option("--out <path>", "output path", DEFAULT_CONFIG)
  .option("--stdout-only", "do not write file, just print validated JSON")
  .action(
    (opts: {
      json: string;
      source?: string;
      envType?: string;
      out: string;
      stdoutOnly?: boolean;
    }) => {
      try {
        const candidate = readJsonFileStdin(opts.json);
        const validated = validate(candidate, opts.source, opts.envType);
        if (!opts.stdoutOnly) {
          writeConfig(validated, opts.out);
        }
        emit(validated);
      } catch (e) {
        if (e instanceof ValidationError) {
          process.stderr.write(`ERROR: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    },
  );

program
  .command("info")
  .description("print current env config")
  .option("--env-config <path>", "env config path", DEFAULT_CONFIG)
  .action((opts: { envConfig: string }) => {
    const cfg = loadConfig(opts.envConfig);
    const envType = cfg.env_type as string | undefined;
    const block = envType ? (cfg[envType] as Record<string, unknown>) || {} : {};
    emit({
      env_type: envType,
      source: cfg.source,
      parsed_at: cfg.parsed_at,
      warnings: cfg.warnings || [],
      fields: block,
    });
  });

for (const { name, extra, errCode } of [
  { name: "provision", extra: [] as string[], errCode: 10 },
  { name: "preflight", extra: [] as string[], errCode: 11 },
  { name: "sync", extra: ["src"] as string[], errCode: 12 },
  { name: "deploy", extra: ["run-spec"] as string[], errCode: 13 },
  { name: "monitor", extra: ["handle"] as string[], errCode: 14 },
  { name: "collect", extra: [] as string[], errCode: 15 },
  { name: "destroy", extra: ["handle-optional"] as string[], errCode: 16 },
]) {
  const cmd = program
    .command(name)
    .description(`${name} the environment`)
    .option("--env-config <path>", "env config path", DEFAULT_CONFIG)
    .option("--dry-run", "print what would run, do not execute");

  if (extra.includes("src")) {
    cmd.requiredOption("--src <path>", "local source dir");
  }
  if (extra.includes("run-spec")) {
    cmd.requiredOption("--run-spec <path>", "path to run_spec JSON");
  }
  if (extra.includes("handle")) {
    cmd.requiredOption("--handle <path>", "path to handle JSON");
  }
  if (extra.includes("handle-optional")) {
    cmd.option("--handle <path>", "path to handle JSON");
  }

  cmd.action(
    (opts: {
      envConfig: string;
      dryRun?: boolean;
      src?: string;
      runSpec?: string;
      handle?: string;
    }) => {
      const b = backendFromConfig(opts.envConfig, !!opts.dryRun);
      switch (name) {
        case "provision":
          runMethod(() => b.provision(), errCode);
          break;
        case "preflight":
          runMethod(() => b.preflight(), errCode);
          break;
        case "sync":
          runMethod(() => b.sync(opts.src!), errCode);
          break;
        case "deploy": {
          const runSpec = JSON.parse(fs.readFileSync(opts.runSpec!, "utf-8")) as Record<
            string,
            unknown
          >;
          runMethod(() => b.deploy(runSpec), errCode);
          break;
        }
        case "monitor": {
          const handle = JSON.parse(fs.readFileSync(opts.handle!, "utf-8")) as Record<
            string,
            unknown
          >;
          runMethod(() => b.monitor(handle), errCode);
          break;
        }
        case "collect":
          runMethod(() => b.collectResults(), errCode);
          break;
        case "destroy":
          runMethod(() => b.destroy(), errCode);
          break;
      }
    },
  );
}

runCli(program);
