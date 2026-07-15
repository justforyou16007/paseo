import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createCli, runCli } from "../../lib/cli.js";

export const SCHEMA_VERSION = 1;
export const DEFAULT_OUT = ".aris/experiment-env.json";

export const ENV_TYPES = ["local", "remote", "vast", "modal", "docker"] as const;
export type EnvType = (typeof ENV_TYPES)[number];

type FieldType = "string" | "number" | "boolean" | "list" | "dict" | "string_or_number";

interface FieldSpec {
  type: FieldType;
  required: boolean;
  defaultValue: unknown;
}

const ENV_SCHEMAS: Record<string, Record<string, FieldSpec>> = {
  remote: {
    ssh_alias: { type: "string", required: true, defaultValue: null },
    ssh_host: { type: "string", required: false, defaultValue: null },
    ssh_port: { type: "number", required: false, defaultValue: 22 },
    ssh_user: { type: "string", required: false, defaultValue: null },
    gpu_desc: { type: "string", required: false, defaultValue: null },
    conda_env: { type: "string", required: false, defaultValue: "base" },
    conda_hook: { type: "string", required: false, defaultValue: null },
    code_dir: { type: "string", required: true, defaultValue: null },
    code_sync: { type: "string", required: false, defaultValue: "rsync" },
    wandb: { type: "boolean", required: false, defaultValue: false },
    wandb_project: { type: "string", required: false, defaultValue: null },
    wandb_entity: { type: "string", required: false, defaultValue: null },
  },
  vast: {
    auto_destroy: { type: "boolean", required: false, defaultValue: null },
    max_budget: { type: "string_or_number", required: false, defaultValue: null },
    image: {
      type: "string",
      required: false,
      defaultValue: "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel",
    },
    work_dir: { type: "string", required: false, defaultValue: "/workspace/" },
    code_dir: { type: "string", required: false, defaultValue: "/workspace/project/" },
    instance_id: { type: "string_or_number", required: false, defaultValue: null },
    ssh_host: { type: "string", required: false, defaultValue: null },
    ssh_port: { type: "number", required: false, defaultValue: 22 },
    ssh_user: { type: "string", required: false, defaultValue: "root" },
    wandb: { type: "boolean", required: false, defaultValue: false },
    wandb_project: { type: "string", required: false, defaultValue: null },
    wandb_entity: { type: "string", required: false, defaultValue: null },
  },
  modal: {
    modal_gpu: { type: "string", required: false, defaultValue: "auto" },
    modal_timeout: { type: "number", required: false, defaultValue: 21600 },
    modal_volume: { type: "string", required: false, defaultValue: null },
    modal_app_file: { type: "string", required: false, defaultValue: null },
    modal_secrets: { type: "list", required: false, defaultValue: [] },
  },
  docker: {
    image: { type: "string", required: false, defaultValue: "python:3.11" },
    dockerfile: { type: "string", required: false, defaultValue: null },
    build_context: { type: "string", required: false, defaultValue: null },
    gpus: { type: "string", required: false, defaultValue: null },
    shm_size: { type: "string", required: false, defaultValue: "16g" },
    runtime: { type: "string", required: false, defaultValue: null },
    work_dir: { type: "string", required: false, defaultValue: "/workspace" },
    results_dir: { type: "string", required: false, defaultValue: "/results" },
    network: { type: "string", required: false, defaultValue: null },
    env_vars: { type: "dict", required: false, defaultValue: {} },
    volumes: { type: "list", required: false, defaultValue: [] },
    build_args: { type: "dict", required: false, defaultValue: {} },
    auto_remove: { type: "boolean", required: false, defaultValue: true },
  },
  local: {
    conda_env: { type: "string", required: false, defaultValue: "base" },
    conda_hook: { type: "string", required: false, defaultValue: null },
    device: { type: "string", required: false, defaultValue: null },
  },
};

const ALIASES: Record<string, string> = {
  vast_instance: "instance_id",
  modal_app: "modal_app_file",
};

export class ValidationError extends Error {
  override message: string;
  constructor(message: string) {
    super(message);
    this.message = message;
  }
}

function checkType(value: unknown, expected: FieldType): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "list":
      return Array.isArray(value);
    case "dict":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "string_or_number":
      return typeof value === "string" || typeof value === "number";
  }
}

function coerceStrList(value: unknown, warnings: string[], field: string): unknown[] {
  if (typeof value === "string") {
    warnings.push(`${field} given as str, coerced to list['${value}'] (agent should emit a list)`);
    return [value];
  }
  return value as unknown[];
}

function applyAutoDestroyDefault(vastCfg: Record<string, unknown>, warnings: string[]): void {
  if ("auto_destroy" in vastCfg) return;
  const hasInstance = vastCfg.instance_id != null;
  vastCfg.auto_destroy = !hasInstance;
  warnings.push(
    `auto_destroy defaulted to ${vastCfg.auto_destroy} (${hasInstance ? "reuse" : "fresh-rental"} mode)`,
  );
}

export function validate(
  candidate: unknown,
  sourcePath?: string | null,
  envTypeOverride?: string | null,
): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new ValidationError("candidate config must be a JSON object");
  }
  const cand = candidate as Record<string, unknown>;
  const warnings: string[] = [];
  const envType = envTypeOverride || (cand.env_type as string | undefined);

  const present: Record<string, Record<string, unknown>> = {};
  for (const t of ENV_TYPES) {
    if (t in cand) {
      present[t] = cand[t] as Record<string, unknown>;
    }
  }

  if (Object.keys(present).length === 0) {
    throw new ValidationError(
      `no environment block found in candidate (expected one of ${JSON.stringify([...ENV_TYPES])})`,
    );
  }

  if (!envType) {
    throw new ValidationError(
      "env_type not set; the agent must set env_type to the active environment (script does not pick among multiple)",
    );
  }
  if (!(ENV_TYPES as readonly string[]).includes(envType)) {
    throw new ValidationError(
      `env_type '${envType}' invalid; expected one of ${JSON.stringify([...ENV_TYPES])}`,
    );
  }
  if (!(envType in present)) {
    throw new ValidationError(`env_type is '${envType}' but no '${envType}' block was provided`);
  }

  const canonicalEnvs: Record<string, Record<string, unknown>> = {};
  for (const [etype, block] of Object.entries(present)) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      throw new ValidationError(`${etype} block must be a JSON object`);
    }
    const spec = ENV_SCHEMAS[etype];
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(block)) {
      if (k in ALIASES) {
        warnings.push(
          `'${k}' is deprecated; use '${ALIASES[k]}' (agent should translate; not auto-converted)`,
        );
        continue;
      }
      if (!(k in spec)) {
        warnings.push(`unknown field ${etype}.${k} (ignored)`);
        continue;
      }
      const expectedType = spec[k].type;
      let val = v;
      if (k === "modal_secrets" && etype === "modal") {
        val = coerceStrList(val, warnings, k);
      }
      if (!checkType(val, expectedType)) {
        throw new ValidationError(`${etype}.${k} must be ${expectedType}, got ${typeof val}`);
      }
      out[k] = val;
    }

    for (const [k, fieldSpec] of Object.entries(spec)) {
      if (!(k in out)) {
        if (fieldSpec.defaultValue !== null) {
          out[k] =
            typeof fieldSpec.defaultValue === "object" && fieldSpec.defaultValue !== null
              ? JSON.parse(JSON.stringify(fieldSpec.defaultValue))
              : fieldSpec.defaultValue;
        } else if (fieldSpec.required) {
          throw new ValidationError(`missing required field ${etype}.${k}`);
        }
      }
    }

    if (etype === "remote" && out.wandb && !out.wandb_project) {
      throw new ValidationError("remote.wandb_project is required when remote.wandb is true");
    }

    if (etype === "vast") {
      applyAutoDestroyDefault(out, warnings);
    }

    canonicalEnvs[etype] = out;
  }

  const result: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    env_type: envType,
    warnings,
    ...canonicalEnvs,
  };

  if (sourcePath) {
    const sp = path.resolve(sourcePath);
    result.source = path.basename(sourcePath);
    result.source_path = fs.existsSync(sourcePath) ? sp : sourcePath;
    try {
      const st = fs.statSync(sourcePath);
      result.source_mtime = Math.floor(st.mtimeMs / 1000);
      const content = fs.readFileSync(sourcePath);
      result.source_hash = crypto.createHash("sha256").update(content).digest("hex");
    } catch {
      // path may be valid but unreadable in sandbox
    }
  }
  result.parsed_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return result;
}

export function writeConfig(
  validated: Record<string, unknown>,
  outPath: string = DEFAULT_OUT,
): string {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n");
  fs.renameSync(tmp, outPath);
  return outPath;
}

function readCandidate(jsonArg: string): Record<string, unknown> {
  let raw: string;
  if (jsonArg === "-") {
    raw = fs.readFileSync(0, "utf-8");
  } else {
    raw = fs.readFileSync(jsonArg, "utf-8");
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new ValidationError(`candidate JSON is invalid: ${e}`);
  }
}

const program = createCli("parse-env", "Validate + write the experiment-env config");

program
  .requiredOption("--json <path>", "candidate JSON path, or '-' for stdin")
  .option("--source <path>", "CLAUDE.md/AGENTS.md path (records provenance + hash)")
  .option("--env-type <type>", "override env_type in the candidate")
  .option("--out <path>", `output path (default: ${DEFAULT_OUT})`, DEFAULT_OUT)
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
        const candidate = readCandidate(opts.json);
        const validated = validate(candidate, opts.source, opts.envType);
        if (!opts.stdoutOnly) {
          writeConfig(validated, opts.out);
        }
        console.log(JSON.stringify(validated, null, 2));
      } catch (e) {
        if (e instanceof ValidationError) {
          process.stderr.write(`ERROR: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    },
  );

runCli(program);
