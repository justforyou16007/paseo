#!/usr/bin/env node
import { createCli, runCli } from "../lib/cli.js";
import { exportResultPackage, planResultExport } from "./result-export.js";
import { assertIdentifier, requireString } from "./workflow-spec.js";

const program = createCli("result-export", "Review and publish a run result package");

function common(command: ReturnType<typeof program.command>) {
  return command
    .requiredOption("--project <path>", "research project root")
    .requiredOption("--run <id>", "run id")
    .option("--tester-definition <path>", "frozen tester definition for tester metrics");
}

interface Options {
  project: string;
  run: string;
  testerDefinition?: string;
  reviewId?: string;
}

function input(options: Options) {
  return {
    project_root: requireString(options.project, "project_root"),
    run_id: assertIdentifier(options.run, "run_id"),
    ...(options.testerDefinition === undefined
      ? {}
      : { tester_definition_path: options.testerDefinition }),
  };
}

common(program.command("plan")).action((options: Options) =>
  console.log(JSON.stringify(planResultExport(input(options)))),
);

common(program.command("publish"))
  .requiredOption("--review-id <id>", "approved result review id")
  .action((options: Options) =>
    console.log(
      JSON.stringify(
        exportResultPackage({
          ...input(options),
          review: { review_id: assertIdentifier(options.reviewId, "review_id") },
        }),
      ),
    ),
  );

runCli(program);
