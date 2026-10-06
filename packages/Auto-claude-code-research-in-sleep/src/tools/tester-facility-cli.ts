#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createCli, runCli } from "../lib/cli.js";
import { readStateFile } from "./state-file.js";
import {
  setupTesterFacility,
  testerConfigPath,
  prepareTesterJob,
  executeTesterJob,
  readTesterJob,
  testerJobDirectory,
  checkTesterResult,
  auditTesterResult,
  removeLegacyTesterGuard,
} from "./tester-facility.js";

const program = createCli(
  "tester-facility",
  "Prepare benchmark facilities, run tests and audit results before Wiki publication",
);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
program
  .command("setup")
  .requiredOption("--project <path>")
  .requiredOption("--input <path>")
  .action(async (o: { project: string; input: string }) =>
    print(await setupTesterFacility(o.project, readStateFile(o.input))),
  );
program
  .command("migrate")
  .requiredOption("--project <path>")
  .action((o: { project: string }) => {
    removeLegacyTesterGuard(o.project);
    print({ status: "done", next: "/aris-setup" });
  });
function launch(root: string, id: string): void {
  const log = fs.openSync(path.join(testerJobDirectory(root, id), "worker.log"), "a");
  try {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "worker",
        "--project",
        path.resolve(root),
        "--test-id",
        id,
      ],
      { detached: true, stdio: ["ignore", log, log] },
    );
    child.on("error", (e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
program
  .command("test")
  .requiredOption("--project <path>")
  .requiredOption("--input <path>")
  .option("--config <path>")
  .option("--wait", "wait for the test instead of starting a persistent worker", false)
  .action(async (o: { project: string; input: string; config?: string; wait: boolean }) => {
    const job = prepareTesterJob(
      o.project,
      o.config ?? testerConfigPath(o.project),
      readStateFile(o.input),
    );
    const current = readTesterJob(o.project, job.request.test_id);
    if (current.status === "completed" || current.status === "running") {
      print(current);
      return;
    }
    if (o.wait) print(await executeTesterJob(o.project, job.request.test_id));
    else {
      launch(o.project, job.request.test_id);
      print({
        ...current,
        status: "pending",
        result_path: path.join(
          testerJobDirectory(o.project, job.request.test_id),
          "test-result.json",
        ),
      });
    }
  });
program
  .command("resume")
  .requiredOption("--project <path>")
  .requiredOption("--test-id <id>")
  .option("--wait", "wait for retry", false)
  .action(async (o: { project: string; testId: string; wait: boolean }) => {
    const job = readTesterJob(o.project, o.testId);
    if (job.status === "running" || job.status === "completed") {
      print(job);
      return;
    }
    if (o.wait) print(await executeTesterJob(o.project, o.testId));
    else {
      launch(o.project, o.testId);
      print({
        ...job,
        status: "pending",
        result_path: path.join(testerJobDirectory(o.project, o.testId), "test-result.json"),
      });
    }
  });
program
  .command("status")
  .requiredOption("--project <path>")
  .requiredOption("--test-id <id>")
  .action((o: { project: string; testId: string }) => print(readTesterJob(o.project, o.testId)));
program
  .command("worker", { hidden: true })
  .requiredOption("--project <path>")
  .requiredOption("--test-id <id>")
  .action(async (o: { project: string; testId: string }) => {
    readTesterJob(o.project, o.testId);
    print(await executeTesterJob(o.project, o.testId));
  });
program
  .command("precheck")
  .requiredOption("--result <path>")
  .action((o: { result: string }) => print(checkTesterResult(o.result)));
program
  .command("audit")
  .requiredOption("--result <path>")
  .requiredOption("--review <path>")
  .action((o: { result: string; review: string }) => {
    const audit = auditTesterResult(o.result, o.review);
    print(audit);
    if (audit.status !== "pass") process.exitCode = 1;
  });
runCli(program);
