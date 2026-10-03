#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCli, runCli } from "../lib/cli.js";
import { assertSearchAuditForContract } from "./search-policy.js";
import { A1Error } from "./workflow-spec.js";
import {
  assertOutermostSubmissionRun,
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
import {
  createTesterContainer,
  DEFAULT_TESTER_IMAGE,
  PUBLISHED_TESTER_IMAGE,
  pullTesterImage,
} from "./tester-image.js";

const program = createCli(
  "tester-agent",
  "Deploy the tester agent into its container and exchange contracts and submissions with it",
);

/**
 * Every failure prints one fixed reason. The research log must not learn the
 * container's stderr or anything the tester holds privately, so
 * the caught error is discarded rather than formatted.
 */
function reject(reason: string): void {
  console.error(JSON.stringify({ status: "failed", reason }));
  process.exitCode = 1;
}

/**
 * The manual this ARIS version expects in the base image. Templates ship next
 * to `dist`, both in the repository and under `.aris`.
 */
function expectedManualSha256(): string {
  const manual = path.resolve(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    "..",
    "templates",
    "tester-agent-bundle",
    "TESTER_AGENT.md",
  );
  return crypto.createHash("sha256").update(fs.readFileSync(manual)).digest("hex");
}

/**
 * Image and container failures are about the research machine's own docker,
 * so their code and message are printed; nothing in them comes from the tester.
 */
function rejectWithCause(fallback: string, error: unknown): void {
  if (error instanceof A1Error)
    console.error(JSON.stringify({ status: "failed", reason: error.code, detail: error.message }));
  else console.error(JSON.stringify({ status: "failed", reason: fallback }));
  process.exitCode = 1;
}

program
  .command("pull-image")
  .description(
    "Pull the published tester base image and give it the local name, once its manual is this version's",
  )
  .option("--source <ref>", "published image to pull", PUBLISHED_TESTER_IMAGE)
  .option("--image <tag>", "local name create-container uses", DEFAULT_TESTER_IMAGE)
  .option("--timeout <ms>", "per-step timeout in milliseconds", "1800000")
  .action(async (options: { source: string; image: string; timeout: string }) => {
    try {
      const result = await pullTesterImage({
        source: options.source,
        image: options.image,
        manual_sha256: expectedManualSha256(),
        timeout_ms: Number(options.timeout),
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      rejectWithCause("tester_image_pull_failed", error);
    }
  });

program
  .command("create-container")
  .description("Create the tester container from the base image, or start the existing one")
  .requiredOption("--name <container>", "tester container name")
  .option("--image <tag>", "the tester base image", DEFAULT_TESTER_IMAGE)
  .option("--home-volume <name>", "named volume for the account's home (default <name>-home)")
  .option("--timeout <ms>", "per-step timeout in milliseconds", "120000")
  .action(
    async (options: { name: string; image: string; homeVolume?: string; timeout: string }) => {
      try {
        const result = await createTesterContainer({
          image: options.image,
          container: options.name,
          home_volume: options.homeVolume ?? `${options.name}-home`,
          timeout_ms: Number(options.timeout),
        });
        console.log(JSON.stringify(result));
      } catch (error) {
        rejectWithCause("tester_container_failed", error);
      }
    },
  );

program
  .command("probe")
  .description(
    "Check the tester container, its Paseo daemon, its claude binary and its docker access",
  )
  .requiredOption("--container <name>", "name or id of the running tester container")
  .requiredOption("--user <user>", "account the container's Paseo daemon runs as")
  .option("--timeout <ms>", "per-step timeout in milliseconds", "60000")
  .action(async (options: { container: string; user: string; timeout: string }) => {
    try {
      const result = await probeTesterAgentHost({
        endpoint: {
          container: options.container,
          container_user: options.user,
          request_timeout_ms: Number(options.timeout),
        },
      });
      console.log(JSON.stringify(result));
      if (!result.container || !result.daemon || !result.claude || !result.docker)
        process.exitCode = 1;
    } catch {
      reject("tester_probe_failed");
    }
  });

program
  .command("deploy")
  .description("Provision the container layout and signing key, then create the tester agent")
  .requiredOption("--input <path>", "deployment request JSON")
  .requiredOption("--output <path>", "deployment record to write")
  .action(async (options: { input: string; output: string }) => {
    try {
      const request = readStateFile(options.input) as unknown as TesterDeploymentRequest;
      const deployment = await deployTesterAgent({
        request,
        manual_sha256: expectedManualSha256(),
      });
      const record = testerDeploymentRecord(request, deployment);
      writeStateJsonAtomic(options.output, record);
      console.log(
        JSON.stringify({
          agent_id: record.endpoint.agent_id,
          public_key_sha256: record.endpoint.public_key_sha256,
          deployment_path: options.output,
        }),
      );
    } catch (error) {
      // A stale or missing manual is fixed by rebuilding the image, so the
      // owner is told that; the container's own output is still not printed.
      reject(
        error instanceof A1Error && error.code === "TESTER_MANUAL_MISMATCH"
          ? error.code
          : "tester_deploy_failed",
      );
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

/**
 * Failures the operator can act on without learning anything about the tester.
 */
const LOCAL_SUBMIT_FAILURES = new Set(["TESTER_OUTER_RUN_REQUIRED", "RUN_CONTRACT_NOT_FOUND"]);

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
        // Checked here and not inside the transport: the run contract lives on
        // the research machine, and the rule is about which run may spend an
        // exposure, not about anything the tester can see.
        assertOutermostSubmissionRun(options.project, submission);
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
        // The audit refusals, the missing run contract and the wrong-layer
        // refusal are facts about this machine, so naming them tells the
        // operator what to fix. Everything else still collapses to one reason,
        // because the rest of the failure surface touches the tester.
        reject(
          error instanceof A1Error &&
            (error.code.startsWith("SEARCH_") || LOCAL_SUBMIT_FAILURES.has(error.code))
            ? error.code
            : "tester_submission_rejected",
        );
      }
    },
  );

runCli(program);
