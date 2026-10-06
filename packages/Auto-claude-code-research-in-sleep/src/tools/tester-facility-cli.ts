#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createCli, runCli } from "../lib/cli.js";
import { readStateFile } from "./state-file.js";
import { advanceStandaloneTesterPhase } from "./standalone-tester.js";
import {
  auditedTesterMetric,
  testerMetricName,
  verifyTesterDeliverables,
} from "./tester-deliverables.js";
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
  readAuditedTesterResult,
} from "./tester-facility.js";

const program = createCli(
  "tester-facility",
  "Prepare benchmark facilities, run tests and audit results before Wiki publication",
);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
program
  .command("measure")
  .requiredOption("--project <path>")
  .requiredOption("--run <id>")
  .requiredOption("--iteration <number>")
  .requiredOption("--metric <name>")
  .requiredOption("--result <path>")
  .requiredOption("--audit <path>")
  .action(
    (o: {
      project: string;
      run: string;
      iteration: string;
      metric: string;
      result: string;
      audit: string;
    }) => {
      const { result } = readAuditedTesterResult(o.result, o.audit, {
        run_id: o.run,
        iteration: Number(o.iteration),
      });
      verifyTesterDeliverables(
        o.project,
        o.run,
        result.request.artifact,
        result.request.deliverables,
      );
      print({
        metric_name: testerMetricName(result.config, o.metric),
        metric_value: auditedTesterMetric(result, o.metric),
        experiment_id: result.request.experiment_id,
        test_result_path: path.resolve(o.result),
        test_audit_path: path.resolve(o.audit),
      });
    },
  );
program
  .command("stage")
  .requiredOption("--project <path>")
  .requiredOption("--run <id>")
  .requiredOption("--from <phase>")
  .requiredOption("--to <phase>")
  .option("--test-result <path>")
  .option("--test-audit <path>")
  .action(
    (o: {
      project: string;
      run: string;
      from: string;
      to: string;
      testResult?: string;
      testAudit?: string;
    }) =>
      print(
        advanceStandaloneTesterPhase({
          project_root: o.project,
          run_id: o.run,
          from_phase: o.from,
          to_phase: o.to,
          test_result_path: o.testResult,
          test_audit_path: o.testAudit,
        }),
      ),
  );
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
  .option("--project <path>")
  .action((o: { result: string; project?: string }) => {
    const result = checkTesterResult(o.result);
    if (o.project !== undefined)
      verifyTesterDeliverables(
        o.project,
        result.request.run_id,
        result.request.artifact,
        result.request.deliverables,
      );
    print(result);
  });
program
  .command("audit")
  .requiredOption("--result <path>")
  .requiredOption("--review <path>")
  .option("--project <path>")
  .action((o: { result: string; review: string; project?: string }) => {
    if (o.project !== undefined) {
      const result = checkTesterResult(o.result);
      verifyTesterDeliverables(
        o.project,
        result.request.run_id,
        result.request.artifact,
        result.request.deliverables,
      );
    }
    const audit = auditTesterResult(o.result, o.review);
    print(audit);
    if (audit.status !== "pass") process.exitCode = 1;
  });
runCli(program);
