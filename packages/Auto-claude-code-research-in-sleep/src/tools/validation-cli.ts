#!/usr/bin/env node
/**
 * Validation machine helper. `serve` runs the service (Paseo starts it as the
 * `aris-validation` script); the other commands are what a validation agent and
 * the owner run against one project.
 */
import path from "node:path";

import { createCli, runCli } from "../lib/cli.js";
import { A1Error, failA1 } from "./validate.js";
import { readValidationConfig } from "./validation/config.js";
import { finalizeSubmission, runBenchmark } from "./validation/review.js";
import { startValidationService } from "./validation/server.js";
import {
  listSubmissions,
  readPublished,
  readSubmission,
  serviceSummary,
} from "./validation/store.js";

const program = createCli("validation", "Serve and review ARIS validation submissions");

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
function fail(error: unknown): void {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        reason: error instanceof A1Error ? error.code : "validation_command_failed",
        message: (error as Error).message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

program
  .command("serve")
  .description("Run the validation service (Paseo sets PASEO_PORT)")
  .requiredOption("--project <dir>", "validation project directory")
  .option("--port <port>", "port to listen on; defaults to PASEO_PORT")
  .action(async (options: { project: string; port?: string }) => {
    try {
      const port = Number(options.port ?? process.env.PASEO_PORT);
      if (!Number.isInteger(port) || port < 0)
        failA1("PORT_REQUIRED", "pass --port or run as the Paseo aris-validation service script");
      const service = await startValidationService(options.project, { port });
      console.log(`aris-validation listening on ${service.url}`);
      const stop = () => void service.close().then(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("status")
  .description("Service state and submissions, or one submission in full")
  .requiredOption("--project <dir>")
  .option("--submission <id>")
  .action((options: { project: string; submission?: string }) => {
    try {
      const root = path.resolve(options.project);
      const config = readValidationConfig(root);
      if (options.submission)
        print({
          record: readSubmission(root, options.submission),
          published: readPublished(root, options.submission),
        });
      else
        print({
          service: serviceSummary(root, config),
          submissions: listSubmissions(root).map((record) => ({
            ...record,
            published: readPublished(root, record.submission_id),
          })),
        });
    } catch (error) {
      fail(error);
    }
  });

for (const [name, mode, description] of [
  ["smoke", "smoke", "Run the frozen benchmark's smoke subset against the adapter"],
  ["evaluate", "full", "Run the full frozen benchmark; finalize scores the latest run"],
] as const)
  program
    .command(name)
    .description(description)
    .requiredOption("--project <dir>")
    .requiredOption("--submission <id>")
    .action(async (options: { project: string; submission: string }) => {
      try {
        print(await runBenchmark(options.project, options.submission, mode));
      } catch (error) {
        fail(error);
      }
    });

program
  .command("finalize")
  .description("Publish review.json and feedback.md after the leak check")
  .requiredOption("--project <dir>")
  .requiredOption("--submission <id>")
  .action((options: { project: string; submission: string }) => {
    try {
      print(finalizeSubmission(options.project, options.submission));
    } catch (error) {
      fail(error);
    }
  });

runCli(program);
