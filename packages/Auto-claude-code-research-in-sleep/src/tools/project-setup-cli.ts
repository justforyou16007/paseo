#!/usr/bin/env node
/**
 * `/aris-setup`'s three reads. None of them writes a sealed artifact:
 *
 *   status    what the project still has to configure, and the command for each
 *   infer     what can be read off existing files, with its source, and what
 *             cannot be and therefore has to be asked
 *   assemble  the owner's confirmed answers, merged with the inferred values,
 *             written out as the input `workflow-tools-cli.js root-setup` takes
 *
 * `root-setup` stays the only writer of the setup record. Splitting it that way
 * keeps one gate instead of two implementations of the same validation.
 *
 * `status` exits non-zero while anything is unconfigured, so a shell step can
 * gate on it. It prints counts and digests for the search guard and never a
 * blocked term -- same rule as `search-audit-cli.js`.
 */
import fs from "node:fs";
import path from "node:path";

import { createCli, runCli } from "../lib/cli.js";
import { assembleRootSetupInput, detectSetupStages, inferSetupItems } from "./project-setup.js";
import { SetupIncompleteError } from "./task-setup.js";
import { A1Error } from "./workflow-spec.js";

const program = createCli(
  "project-setup",
  "Report what an ARIS project still has to configure, and turn the owner's answers into the root setup input",
);

function reject(fallback: string, error: unknown): void {
  const body: Record<string, unknown> = {
    status: "failed",
    reason: error instanceof A1Error ? error.code : fallback,
    message: (error as Error).message,
  };
  if (error instanceof SetupIncompleteError) body.missing_items = error.missing_items;
  console.error(JSON.stringify(body, null, 2));
  process.exitCode = 1;
}

program
  .command("status")
  .description("Report every setup stage; exit non-zero while any of them is unconfigured")
  .requiredOption("--project <dir>", "research project directory")
  .option("--run-id <id>", "run id whose root charter to look for")
  .action((options: { project: string; runId?: string }) => {
    try {
      const status = detectSetupStages({
        project_root: options.project,
        run_id: options.runId ?? null,
      });
      console.log(JSON.stringify(status, null, 2));
      // Non-zero is the point: /aris-setup requires the full set, so a partly
      // configured project is a failure a shell step can act on, not a note.
      if (status.blocking.length > 0) process.exitCode = 1;
    } catch (error) {
      reject("project_setup_status_failed", error);
    }
  });

program
  .command("infer")
  .description("What existing files already answer, with their source, and what has to be asked")
  .requiredOption("--project <dir>", "research project directory")
  .action((options: { project: string }) => {
    try {
      console.log(JSON.stringify(inferSetupItems(options.project), null, 2));
    } catch (error) {
      reject("project_setup_infer_failed", error);
    }
  });

program
  .command("assemble")
  .description("Merge confirmed answers with the inferred values into the root setup input")
  .requiredOption("--project <dir>", "research project directory")
  .requiredOption("--answers <path>", "owner-confirmed answers JSON")
  .requiredOption("--output <path>", "root setup input JSON to write")
  .action((options: { project: string; answers: string; output: string }) => {
    try {
      const answers = JSON.parse(fs.readFileSync(options.answers, "utf-8")) as unknown;
      const result = assembleRootSetupInput({ project_root: options.project, answers });
      fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
      fs.writeFileSync(options.output, `${JSON.stringify(result.input, null, 2)}\n`);
      console.log(
        JSON.stringify(
          {
            status: "ready",
            input_path: path.resolve(options.output),
            from_answers: result.from_answers,
            from_inference: result.from_inference,
            next: `workflow-tools-cli.js root-setup --project ${path.resolve(options.project)} --input ${path.resolve(options.output)}`,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      reject("project_setup_assemble_failed", error);
    }
  });

runCli(program);
