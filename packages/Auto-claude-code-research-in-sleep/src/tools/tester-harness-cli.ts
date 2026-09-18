#!/usr/bin/env node
import { createCli, runCli } from "../lib/cli.js";
import { failA1 } from "./workflow-spec.js";

const program = createCli(
  "tester-harness",
  "Deprecated local harness entrypoint; fixed tests run through tester-agent-cli submit",
);
program.command("run").action(() => {
  failA1(
    "LOCAL_TESTER_EXECUTION_DISABLED",
    "use tester-agent-cli submit; the local harness path is disabled",
  );
});
runCli(program);
