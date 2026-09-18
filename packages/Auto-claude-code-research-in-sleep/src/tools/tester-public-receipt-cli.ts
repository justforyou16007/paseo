#!/usr/bin/env node
import { createCli, runCli } from "../lib/cli.js";
import {
  importVerifiedTesterConclusionFromFiles,
  readVerifiedTesterConclusion,
  readVerifiedTesterFeedback,
} from "./tester-public-receipt.js";

const program = createCli(
  "tester-public-receipt",
  "Verify public receipts returned by the remote tester",
);

program
  .command("verify-conclusion")
  .requiredOption("--receipt <path>", "Signed public tester conclusion")
  .requiredOption("--public-key <path>", "Root-owned tester public key")
  .action((options: { receipt: string; publicKey: string }) => {
    console.log(JSON.stringify(readVerifiedTesterConclusion(options.receipt, options.publicKey)));
  });

program
  .command("verify-feedback")
  .requiredOption("--receipt <path>", "Signed public tester feedback")
  .requiredOption("--public-key <path>", "Root-owned tester public key")
  .action((options: { receipt: string; publicKey: string }) => {
    console.log(JSON.stringify(readVerifiedTesterFeedback(options.receipt, options.publicKey)));
  });

program
  .command("import-conclusion")
  .requiredOption("--project <path>", "Research project containing the prebuilt tester run")
  .requiredOption("--tester-run-id <id>", "Prebuilt tester run")
  .requiredOption("--receipt <path>", "Signed public tester conclusion")
  .requiredOption("--public-key <path>", "Root-owned tester public key")
  .action(
    (options: { project: string; testerRunId: string; receipt: string; publicKey: string }) => {
      console.log(
        JSON.stringify(
          importVerifiedTesterConclusionFromFiles({
            project_root: options.project,
            tester_run_id: options.testerRunId,
            receipt_path: options.receipt,
            public_key_path: options.publicKey,
          }),
        ),
      );
    },
  );

runCli(program);
