#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { assertSearchAuditForContract } from "./search-policy.js";
import { A1Error } from "./workflow-spec.js";
import {
  cleanupTesterDeployment,
  declareTesterSubmissionContract,
  deployTesterAgent,
  probeTesterAgentHost,
  readTesterAgentConfig,
  readTesterAgentEndpoint,
  readTesterDeploymentRecord,
  readTesterSubmissionContract,
  submitToTesterAgent,
  testerAgentConfigFromDeployment,
  testerDeploymentRecord,
  bindSubmissionToContract,
  writeTesterAgentResponse,
  type TesterDeploymentRequest,
} from "./tester-agent.js";
import { readStateFile, writeStateJsonAtomic } from "./state-file.js";

const program = createCli(
  "tester-agent",
  "Deploy the remote tester agent and exchange contracts and submissions with it",
);

/**
 * Every failure prints one fixed reason. The research log must not learn the
 * ssh target, the remote stderr, or anything the tester holds privately, so
 * the caught error is discarded rather than formatted.
 */
function reject(reason: string): void {
  console.error(JSON.stringify({ status: "failed", reason }));
  process.exitCode = 1;
}

program
  .command("probe")
  .description("Check ssh reachability, the remote daemon and the remote claude binary")
  .requiredOption("--target <ssh-target>", "host or user@host of the tester machine")
  .option("--ssh-port <port>", "ssh port when it is not 22")
  .requiredOption("--daemon-port <port>", "Paseo daemon port on the tester machine")
  .option("--timeout <ms>", "per-step timeout in milliseconds", "60000")
  .action(
    async (options: { target: string; sshPort?: string; daemonPort: string; timeout: string }) => {
      try {
        const result = await probeTesterAgentHost({
          endpoint: {
            ssh_target: options.target,
            ...(options.sshPort === undefined ? {} : { ssh_port: Number(options.sshPort) }),
            daemon_port: Number(options.daemonPort),
            request_timeout_ms: Number(options.timeout),
          },
        });
        console.log(JSON.stringify(result));
        if (!result.ssh || !result.daemon || !result.claude) process.exitCode = 1;
      } catch {
        reject("tester_probe_failed");
      }
    },
  );

program
  .command("deploy")
  .description("Provision the remote layout and signing key, then create the tester agent")
  .requiredOption("--input <path>", "deployment request JSON")
  .requiredOption("--output <path>", "deployment record to write")
  .action(async (options: { input: string; output: string }) => {
    try {
      const request = readStateFile(options.input) as unknown as TesterDeploymentRequest;
      const deployment = await deployTesterAgent({ request });
      const record = testerDeploymentRecord(request, deployment);
      writeStateJsonAtomic(options.output, record);
      console.log(
        JSON.stringify({
          agent_id: record.endpoint.agent_id,
          public_key_sha256: record.endpoint.public_key_sha256,
          deployment_path: options.output,
        }),
      );
    } catch {
      reject("tester_deploy_failed");
    }
  });

program
  .command("cleanup")
  .description("Remove the staging areas the deployment created, locally and remotely")
  .requiredOption("--deployment <path>", "deployment record written by deploy")
  .option("--local-bundle <path>", "local staging directory to remove as well")
  .action(async (options: { deployment: string; localBundle?: string }) => {
    try {
      const record = readTesterDeploymentRecord(options.deployment);
      const result = await cleanupTesterDeployment({
        target: record.endpoint,
        remote_staging_dir: record.layout.staging_dir,
        local_bundle_dir: options.localBundle ?? null,
        request_timeout_ms: record.endpoint.request_timeout_ms,
      });
      // Removed paths are recorded; their contents never were.
      console.log(JSON.stringify({ status: "removed", removed: result.removed }));
    } catch {
      reject("tester_cleanup_failed");
    }
  });

program
  .command("declare")
  .description("Ask the tester to set up a test for one project and declare what it needs back")
  .requiredOption("--deployment <path>", "deployment record or tester agent config")
  .requiredOption("--need-file <path>", "UTF-8 description of the domain test need")
  .requiredOption("--output <path>", "signed submission contract to write")
  .action(async (options: { deployment: string; needFile: string; output: string }) => {
    try {
      const declared = await declareTesterSubmissionContract({
        endpoint: readTesterAgentEndpoint(options.deployment),
        need: fs.readFileSync(options.needFile, "utf8").trim(),
      });
      writeStateJsonAtomic(options.output, declared.contract);
      console.log(
        JSON.stringify({
          contract_id: declared.contract.contract_id,
          contract_sha256: declared.contract_sha256,
          contract_path: options.output,
        }),
      );
    } catch {
      reject("tester_contract_declaration_rejected");
    }
  });

program
  .command("emit-config")
  .description("Freeze the declared contract into the config the research side consumes")
  .requiredOption("--deployment <path>", "deployment record written by deploy")
  .requiredOption("--contract <path>", "submission contract written by declare")
  .requiredOption("--output <path>", "tester agent config to write")
  .action((options: { deployment: string; contract: string; output: string }) => {
    try {
      const config = testerAgentConfigFromDeployment({
        record: readTesterDeploymentRecord(options.deployment),
        contract: readTesterSubmissionContract(options.contract),
      });
      writeStateJsonAtomic(options.output, config);
      console.log(JSON.stringify({ config_path: options.output, project_id: config.project_id }));
    } catch {
      reject("tester_config_rejected");
    }
  });

program
  .command("prepare-bundle")
  .description("Materialize the remote tester's operating manual into the local staging directory")
  .requiredOption("--output <dir>", "local bundle directory that deploy will push")
  .action((options: { output: string }) => {
    try {
      // deploy pushes exactly one directory, so the manual has to be placed into
      // that directory rather than pushed separately; cleanup keeps working
      // because there is still only one local staging path to remove.
      const source = path.resolve(
        path.dirname(path.dirname(fileURLToPath(import.meta.url))),
        "..",
        "templates",
        "tester-agent-bundle",
      );
      fs.mkdirSync(options.output, { recursive: true, mode: 0o700 });
      const copied: string[] = [];
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        fs.copyFileSync(path.join(source, entry.name), path.join(options.output, entry.name));
        copied.push(entry.name);
      }
      console.log(
        JSON.stringify({ status: "prepared", bundle_dir: options.output, files: copied }),
      );
    } catch {
      reject("tester_bundle_rejected");
    }
  });

program
  .command("submit")
  .description("Submit one artifact pair for testing and verify the signed receipt")
  .requiredOption("--config <path>", "tester agent config written by emit-config")
  .requiredOption("--contract <path>", "submission contract frozen in that config")
  .requiredOption("--input <path>", "scheduler-produced submission fields")
  .requiredOption("--output-dir <path>", "research-owned public receipt directory")
  .requiredOption("--project <dir>", "research project directory holding the search ledger")
  .action(
    async (options: {
      config: string;
      contract: string;
      input: string;
      outputDir: string;
      project: string;
    }) => {
      try {
        const config = readTesterAgentConfig(options.config);
        const contract = readTesterSubmissionContract(options.contract);
        // Checked before anything is sent: a round whose network use cannot be
        // reconstructed is a round whose result cannot be trusted, and the
        // cheapest moment to say so is before the tester spends its cases.
        const audit = assertSearchAuditForContract(options.project, contract);
        const submission = bindSubmissionToContract(contract, config, readStateFile(options.input));
        const response = await submitToTesterAgent({ config, contract, submission });
        const files = writeTesterAgentResponse(options.outputDir, response);
        console.log(
          JSON.stringify({
            status: response.status,
            error_analysis: response.error_analysis,
            // Refused calls do not void the round. They are printed because a
            // round that kept hitting the blocklist is worth a human look.
            search_calls: audit.allowed + audit.blocked,
            search_blocked: audit.blocked,
            ...files,
          }),
        );
        if (response.status === "failed") process.exitCode = 1;
      } catch (error) {
        // The audit refusals are facts about this machine, so naming them tells
        // the operator what to fix. Everything else still collapses to one
        // reason, because the rest of the failure surface touches the tester.
        reject(
          error instanceof A1Error && error.code.startsWith("SEARCH_")
            ? error.code
            : "tester_submission_rejected",
        );
      }
    },
  );

runCli(program);
