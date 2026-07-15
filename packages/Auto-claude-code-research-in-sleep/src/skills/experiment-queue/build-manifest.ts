#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { createCli, runCli } from "../../lib/cli.js";

interface GridSpec {
  project?: string;
  cwd?: string;
  conda?: string;
  gpus?: number[];
  max_parallel?: number;
  oom_retry?: { delay?: number; max_attempts?: number };
  phases?: PhaseSpec[];
}

interface PhaseSpec {
  name: string;
  depends_on?: string[];
  grid?: Record<string, (string | number)[]>;
  template?: Record<string, string>;
}

interface Job {
  id: string;
  cmd: string;
  expected_output?: string;
}

interface Phase {
  name: string;
  depends_on: string[];
  jobs: Job[];
}

interface Manifest {
  project: string;
  cwd: string;
  conda: string;
  gpus: number[];
  max_parallel: number;
  oom_retry: { delay: number; max_attempts: number };
  phases: Phase[];
}

type Substitutable = string | Record<string, unknown> | unknown[] | unknown;

function substitute(
  template: Substitutable,
  values: Record<string, string | number>,
): Substitutable {
  if (typeof template === "string") {
    return template.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      return key in values ? String(values[key]) : `\${${key}}`;
    });
  }
  if (Array.isArray(template)) {
    return template.map((v) => substitute(v, values));
  }
  if (template !== null && typeof template === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      result[k] = substitute(v as Substitutable, values);
    }
    return result;
  }
  return template;
}

function* expandGrid(
  grid: Record<string, (string | number)[]>,
): Generator<Record<string, string | number>> {
  const keys = Object.keys(grid);
  if (keys.length === 0) return;
  const vals = keys.map((k) => grid[k]);

  function* product(
    arrays: (string | number)[][],
    depth: number,
    current: (string | number)[],
  ): Generator<(string | number)[]> {
    if (depth === arrays.length) {
      yield [...current];
      return;
    }
    for (const v of arrays[depth]) {
      current.push(v);
      yield* product(arrays, depth + 1, current);
      current.pop();
    }
  }

  for (const combo of product(vals, 0, [])) {
    const obj: Record<string, string | number> = {};
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i]] = combo[i];
    }
    yield obj;
  }
}

function build(config: GridSpec): Manifest {
  const out: Manifest = {
    project: config.project ?? "unknown",
    cwd: config.cwd ?? ".",
    conda: config.conda ?? "base",
    gpus: config.gpus ?? [0, 1, 2, 3, 4, 5, 6, 7],
    max_parallel: config.max_parallel ?? 8,
    oom_retry: config.oom_retry
      ? { delay: config.oom_retry.delay ?? 120, max_attempts: config.oom_retry.max_attempts ?? 3 }
      : { delay: 120, max_attempts: 3 },
    phases: [],
  };

  for (const phase of config.phases ?? []) {
    const phaseOut: Phase = {
      name: phase.name,
      depends_on: phase.depends_on ?? [],
      jobs: [],
    };

    const grid = phase.grid ?? {};
    const template = phase.template ?? {};

    if (Object.keys(grid).length === 0) {
      phaseOut.jobs.push({
        id: (template.id as string) ?? phase.name,
        cmd: template.cmd as string,
        expected_output: template.expected_output as string | undefined,
      });
    } else {
      for (const values of expandGrid(grid)) {
        const job: Job = {
          id: substitute(template.id as string, values) as string,
          cmd: substitute(template.cmd as string, values) as string,
        };
        if (template.expected_output != null) {
          job.expected_output = substitute(template.expected_output as string, values) as string;
        }
        phaseOut.jobs.push(job);
      }
    }

    out.phases.push(phaseOut);
  }

  return out;
}

function parseSimpleYaml(text: string): unknown {
  const lines = text.split("\n");
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> | unknown[] }[] = [
    { indent: -1, obj: root },
  ];
  let i = 0;

  function currentContainer(): Record<string, unknown> | unknown[] {
    return stack[stack.length - 1].obj;
  }

  function parseValue(val: string): unknown {
    const trimmed = val.trim();
    if (trimmed === "" || trimmed === "~" || trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^\[.*\]$/.test(trimmed)) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((s) => parseValue(s));
    }
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  while (i < lines.length) {
    const line = lines[i];
    i++;

    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    const indent = line.search(/\S/);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const stripped = line.trim();

    if (stripped.startsWith("- ")) {
      const itemContent = stripped.slice(2).trim();
      const container = currentContainer();
      if (!Array.isArray(container)) continue;

      if (itemContent.includes(":")) {
        const obj: Record<string, unknown> = {};
        const colonIdx = itemContent.indexOf(":");
        const key = itemContent.slice(0, colonIdx).trim();
        const val = itemContent.slice(colonIdx + 1).trim();
        if (val === "" || val === ">") {
          const nested: Record<string, unknown> = {};
          obj[key] = nested;
          container.push(obj);
          stack.push({ indent, obj: nested });

          if (val === ">") {
            let folded = "";
            while (i < lines.length) {
              const nextLine = lines[i];
              if (/^\s*$/.test(nextLine)) {
                i++;
                break;
              }
              const nextIndent = nextLine.search(/\S/);
              if (nextIndent <= indent) break;
              folded += (folded ? " " : "") + nextLine.trim();
              i++;
            }
            obj[key] = folded;
            stack.pop();
          }
        } else {
          obj[key] = parseValue(val);
          container.push(obj);
          stack.push({ indent, obj });
        }
      } else {
        container.push(parseValue(itemContent));
      }
      continue;
    }

    const colonIdx = stripped.indexOf(":");
    if (colonIdx === -1) continue;

    const key = stripped.slice(0, colonIdx).trim();
    const val = stripped.slice(colonIdx + 1).trim();
    const container = currentContainer();
    if (Array.isArray(container)) continue;

    if (val === "" || val === ">") {
      const peekIdx = i;
      if (peekIdx < lines.length) {
        const nextLine = lines[peekIdx];
        const nextStripped = nextLine.trim();
        if (nextStripped.startsWith("- ")) {
          const arr: unknown[] = [];
          container[key] = arr;
          stack.push({ indent, obj: arr });
          continue;
        }
      }

      if (val === ">") {
        let folded = "";
        while (i < lines.length) {
          const nextLine = lines[i];
          if (/^\s*$/.test(nextLine)) {
            i++;
            break;
          }
          const nextIndent = nextLine.search(/\S/);
          if (nextIndent <= indent) break;
          folded += (folded ? " " : "") + nextLine.trim();
          i++;
        }
        container[key] = folded;
      } else {
        const nested: Record<string, unknown> = {};
        container[key] = nested;
        stack.push({ indent, obj: nested });
      }
    } else {
      container[key] = parseValue(val);
    }
  }

  return root;
}

function main(): void {
  const program = createCli(
    "build-manifest",
    "Convert grid specs into queue_manager manifest.json",
  );

  program
    .requiredOption("--config <path>", "Grid-spec YAML or JSON file")
    .requiredOption("--output <path>", "Output manifest.json path")
    .action((opts: { config: string; output: string }) => {
      const configPath = path.resolve(opts.config);
      const raw = fs.readFileSync(configPath, "utf-8");

      let config: GridSpec;
      const ext = path.extname(configPath).toLowerCase();
      if (ext === ".yaml" || ext === ".yml") {
        config = parseSimpleYaml(raw) as GridSpec;
      } else {
        config = JSON.parse(raw) as GridSpec;
      }

      const manifest = build(config);
      fs.writeFileSync(opts.output, JSON.stringify(manifest, null, 2));

      const totalJobs = manifest.phases.reduce((sum, ph) => sum + ph.jobs.length, 0);
      console.log(`Built manifest with ${manifest.phases.length} phases, ${totalJobs} total jobs`);
      console.log(`Saved to ${opts.output}`);
    });

  runCli(program);
}

main();
