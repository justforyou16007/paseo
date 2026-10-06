#!/usr/bin/env node
/**
 * Unified setup: review/refresh a modular draft, confirm its current digest,
 * then prepare execution inputs. No review command installs or seals anything.
 * status/infer/assemble remain available for readiness and root input assembly;
 * workflow-tools root-setup remains the only writer of sealed root records.
 */
import fs from "node:fs";
import path from "node:path";

import { createCli, runCli } from "../lib/cli.js";
import { assembleRootSetupInput, detectSetupStages, inferSetupItems } from "./project-setup.js";
import { SetupIncompleteError } from "./task-setup.js";
import { A1Error } from "./workflow-spec.js";
import {
  refreshSetupReview,
  confirmSetupReview,
  prepareSetupInputs,
  verifySetupInputs,
  SetupReviewIncompleteError,
} from "./setup-review.js";

const program = createCli(
  "project-setup",
  "Review, edit, confirm and prepare the complete ARIS project configuration",
);

function reject(fallback: string, error: unknown): void {
  const body: Record<string, unknown> = {
    status: "failed",
    reason: error instanceof A1Error ? error.code : fallback,
    message: (error as Error).message,
  };
  if (error instanceof SetupIncompleteError) body.missing_items = error.missing_items;
  if (error instanceof SetupReviewIncompleteError) {
    body.reason = "SETUP_CONFIGURATION_INCOMPLETE";
    body.issues = error.issues;
  }
  console.error(JSON.stringify(body, null, 2));
  process.exitCode = 1;
}

for (const command of ["review", "refresh"]) {
  program
    .command(command)
    .description(
      "Show the complete modular configuration, options, recommendations and all gaps; apply grouped edits without a questionnaire",
    )
    .requiredOption("--project <dir>", "research project directory")
    .option("--input <path>", "configuration patch or edited draft JSON")
    .action((options: { project: string; input?: string }) => {
      try {
        const patch = options.input
          ? (JSON.parse(fs.readFileSync(options.input, "utf8")) as unknown)
          : undefined;
        console.log(JSON.stringify(refreshSetupReview(options.project, patch), null, 2));
      } catch (error) {
        reject("project_setup_review_failed", error);
      }
    });
}
program
  .command("confirm")
  .description(
    "Record the owner's final confirmation of the complete reviewed configuration version",
  )
  .requiredOption("--project <dir>")
  .requiredOption("--digest <sha256>", "digest of the configuration the owner just approved")
  .action((options: { project: string; digest: string }) => {
    try {
      console.log(JSON.stringify(confirmSetupReview(options.project, options.digest), null, 2));
    } catch (error) {
      reject("project_setup_confirm_failed", error);
    }
  });
program
  .command("prepare")
  .description("Write execution inputs only for the current owner-confirmed configuration")
  .requiredOption("--project <dir>")
  .action((options: { project: string }) => {
    try {
      console.log(JSON.stringify(prepareSetupInputs(options.project), null, 2));
    } catch (error) {
      reject("project_setup_prepare_failed", error);
    }
  });

program
  .command("verify")
  .description("Check that worker inputs match the current confirmed configuration without writing")
  .requiredOption("--project <dir>")
  .requiredOption("--configuration <path>")
  .requiredOption("--environment <path>")
  .action((options: { project: string; configuration: string; environment: string }) => {
    try {
      console.log(
        JSON.stringify(
          verifySetupInputs(options.project, options.configuration, options.environment),
          null,
          2,
        ),
      );
    } catch (error) {
      reject("project_setup_verify_failed", error);
    }
  });
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
  .description("Existing configuration sources and owner fields to edit in the unified review")
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
