#!/usr/bin/env node
import { createCli, runCli } from "../lib/cli.js";
import { failA1 } from "./workflow-spec.js";

const program = createCli(
  "tester-isolation",
  "Deprecated local tester boundary; fixed tests use tester-agent-cli submit",
);
program.command("check").action(() => {
  failA1(
    "LOCAL_TESTER_EXECUTION_DISABLED",
    "independent-user tester execution was retired; use tester-agent-cli submit",
  );
});
runCli(program);
