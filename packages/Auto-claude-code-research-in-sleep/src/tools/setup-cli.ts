#!/usr/bin/env node
/** `/aris-setup` helper: review/refresh the sheet, confirm one digest, apply it. */
import fs from "node:fs";

import { createCli, runCli } from "../lib/cli.js";
import { A1Error } from "./validate.js";
import {
  applySetup,
  confirmSetupReview,
  refreshSetupReview,
  SetupReviewIncompleteError,
} from "./setup.js";

const program = createCli("setup", "Review, confirm and apply the ARIS worker or validation setup");

function reject(fallback: string, error: unknown): void {
  const body: Record<string, unknown> = {
    status: "failed",
    reason: error instanceof A1Error ? error.code : fallback,
    message: (error as Error).message,
  };
  if (error instanceof SetupReviewIncompleteError) {
    body.reason = "SETUP_CONFIGURATION_INCOMPLETE";
    body.issues = error.issues;
  }
  console.error(JSON.stringify(body, null, 2));
  process.exitCode = 1;
}

program
  .command("review")
  .description("Write the configuration sheet with options, recommendations and every gap")
  .requiredOption("--project <dir>", "project directory")
  .option("--role <role>", "worker or validation")
  .option("--input <path>", "JSON patch to merge into the draft (objects merge, lists replace)")
  .action((options: { project: string; role?: string; input?: string }) => {
    try {
      let patch: Record<string, unknown> | undefined = options.input
        ? (JSON.parse(fs.readFileSync(options.input, "utf8")) as Record<string, unknown>)
        : undefined;
      if (options.role)
        patch = { ...patch, project: { ...(patch?.project as object), role: options.role } };
      console.log(JSON.stringify(refreshSetupReview(options.project, patch), null, 2));
    } catch (error) {
      reject("setup_review_failed", error);
    }
  });
program
  .command("confirm")
  .description("Record the owner's approval of the reviewed configuration version")
  .requiredOption("--project <dir>")
  .requiredOption("--digest <sha256>", "configuration_sha256 the owner approved")
  .action((options: { project: string; digest: string }) => {
    try {
      console.log(JSON.stringify(confirmSetupReview(options.project, options.digest), null, 2));
    } catch (error) {
      reject("setup_confirm_failed", error);
    }
  });
program
  .command("apply")
  .description("Apply the confirmed configuration to this project")
  .requiredOption("--project <dir>")
  .action(async (options: { project: string }) => {
    try {
      console.log(JSON.stringify(await applySetup(options.project), null, 2));
    } catch (error) {
      reject("setup_apply_failed", error);
    }
  });

runCli(program);
