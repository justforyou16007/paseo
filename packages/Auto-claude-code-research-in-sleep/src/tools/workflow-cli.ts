#!/usr/bin/env node
import type { Command } from "commander";
import { createCli, runCli } from "../lib/cli.js";
import { createArtifactRegistry } from "./artifact-registry.js";
import { prepareBridgeInput } from "./bridge-input.js";
import { collectOrchestrationRound, requireCompleteRound } from "./orchestration-round.js";
import { readStateFile } from "./state-file.js";
import {
  commitPromotion,
  recoverPromotionCommit,
  type RecoverPromotionCommitInput,
} from "./workflow-promotion-commit.js";
import {
  assertIdentifier,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireInteger,
  requireString,
  type JsonObject,
} from "./workflow-spec.js";
import { requireRunContract } from "./run-contract.js";
import type { FreezeOuterRunInput } from "./workflow-state.js";
import type { StopPolicy } from "./workflow-stop-gate.js";
import {
  advanceOuterPhase,
  beginOuterCycle,
  compileOuterCandidate,
  completeOuterCycle,
  finishOuterRun,
  markOuterChildTerminal,
  readOuterRunStatus,
  recordPromotionGateResult,
  recordOuterBridgeFailure,
  recordOuterBridgeRepair,
  recordOuterBridgeSuccess,
  recordValidationGateResult,
  recordWorkflowStopDecision,
  registerOuterChild,
  releaseOuterBudget,
  reserveOuterBudget,
  resumeOuterRun,
  runAutoResearchBridge,
  settleOuterBudget,
  startOuterRun,
  type AutoResearchBridgeInput,
  type CompileOuterCandidateInput,
  type CompleteOuterCycleInput,
  type FinishOuterRunInput,
  type PhaseAdvanceInput,
  type RecordPromotionGateInput,
  type RecordOuterBridgeFailureInput,
  type RecordOuterBridgeRepairInput,
  type RecordOuterBridgeSuccessInput,
  type RecordStopDecisionInput,
  type RecordValidationGateInput,
  type RegisterOuterChildInput,
  type ReserveOuterBudgetInput,
  type CloseOuterBudgetInput,
  type ResumeOuterRunInput,
  type StartOuterRunInput,
} from "./workflow-runtime.js";
import type { OuterChildKind, OuterPhase } from "./workflow-state.js";
import { writeWorkflowSummary } from "./workflow-summary.js";

const program = createCli("workflow", "Outer research run lifecycle commands");

interface IdentityOptions {
  executionRoot: string;
  project: string;
  run: string;
}

interface EvidenceOptions {
  evidence?: string[];
}

interface InputOptions {
  input: string;
}

interface BridgeInputOptions {
  ideaDiscoveryManifest: string;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

function document(filePath: string): JsonObject {
  const value = readStateFile<unknown>(filePath);
  if (!isRecord(value)) failA1("INVALID_VALUE", "command input must be a JSON object", filePath);
  return value;
}

function identity(options: IdentityOptions): {
  execution_root: string;
  project_root: string;
  outer_run_id: string;
  parent_run_id: string | null;
  depth: number;
  scope_path: string;
} {
  const projectRoot = requireString(options.project, "project_root");
  const runId = assertIdentifier(options.run, "outer_run_id");
  const run = requireRunContract(projectRoot, runId);
  return {
    execution_root: requireString(options.executionRoot, "execution_root"),
    project_root: projectRoot,
    outer_run_id: runId,
    parent_run_id: run.parent_run_id,
    depth: run.depth,
    scope_path: run.scope_path,
  };
}

function evidence(options: EvidenceOptions): string[] {
  if (!options.evidence || options.evidence.length === 0)
    failA1("OUTER_EVIDENCE_REQUIRED", "the command needs at least one --evidence file");
  return options.evidence.map((value, index) => requireString(value, `evidence[${index}]`));
}

function phase(value: string): OuterPhase {
  const phases: readonly OuterPhase[] = [
    "init",
    "diagnosis",
    "workset",
    "bridge-repair",
    "wave",
    "validation",
    "promotion",
    "summary",
  ];
  if (!phases.includes(value as OuterPhase))
    failA1("INVALID_VALUE", `unknown outer phase '${value}'`);
  return value as OuterPhase;
}

function childKind(value: string): OuterChildKind {
  if (value !== "module" && value !== "scorer" && value !== "tester")
    failA1("INVALID_VALUE", `unknown outer child kind '${value}'`);
  return value;
}

function payload<T extends object>(input: string, base: object): T & JsonObject {
  const value = document(input);
  for (const key of [
    "execution_root",
    "project_root",
    "outer_run_id",
    "parent_run_id",
    "depth",
    "scope_path",
  ])
    if (Object.hasOwn(value, key))
      failA1("IDENTITY_MISMATCH", `${input} must not override command identity`, `${input}.${key}`);
  return { ...value, ...base } as T & JsonObject;
}

function freezeInput(filePath: string): FreezeOuterRunInput {
  return document(filePath) as unknown as FreezeOuterRunInput;
}

function testerAgentOption(command: Command): Command {
  return command.requiredOption(
    "--tester-agent-config <path>",
    "root-owned remote tester job configuration",
  );
}

const runOptions = (command: Command): Command =>
  command
    .requiredOption("--execution-root <path>", "stable ARIS execution ownership root")
    .requiredOption("--project <path>", "research project root")
    .requiredOption("--run <id>", "run id");

const start = testerAgentOption(
  runOptions(program.command("start")).requiredOption("--freeze <path>", "frozen outer-run input"),
);
start.action((options: IdentityOptions & { freeze: string; testerAgentConfig: string }) => {
  const base = identity(options);
  const input: StartOuterRunInput = {
    ...base,
    freeze_input: freezeInput(options.freeze),
    tester_agent_config_path: requireString(options.testerAgentConfig, "tester_agent_config_path"),
  };
  print(startOuterRun(input));
});

runOptions(
  program
    .command("bridge-input")
    .requiredOption(
      "--idea-discovery-manifest <path>",
      "the exact upstream idea-discovery input-manifest.json path",
    ),
).action((options: IdentityOptions & BridgeInputOptions) => {
  print(
    prepareBridgeInput({
      execution_root: options.executionRoot,
      project_root: options.project,
      outer_run_id: options.run,
      idea_discovery_manifest_path: options.ideaDiscoveryManifest,
    }),
  );
});

runOptions(
  program
    .command("bridge-expand")
    .requiredOption("--input <path>", "idea, charter, baseline, resource, and position input")
    .requiredOption("--evidence <paths...>", "evidence produced before expansion"),
).action((options: IdentityOptions & InputOptions & EvidenceOptions) => {
  const input: AutoResearchBridgeInput = {
    ...identity(options),
    bridge: document(options.input) as unknown as AutoResearchBridgeInput["bridge"],
    evidence_paths: evidence(options),
  };
  print(runAutoResearchBridge(input));
});

// Collecting reads the children back; it owns no execution root, so it asks
// for nothing it does not use. `--require-complete` is the form the parent
// uses before it assembles: it refuses while any position is still open.
program
  .command("bridge-collect")
  .requiredOption("--project <path>", "research project root")
  .requiredOption("--run <id>", "parent run id")
  .option("--generation <n>", "decomposition generation, defaults to the newest")
  .option("--require-complete", "fail unless every position has a terminal child")
  .action(
    (options: { project: string; run: string; generation?: string; requireComplete?: boolean }) => {
      const projectRoot = requireString(options.project, "project_root");
      const runId = assertIdentifier(options.run, "run_id");
      if (options.requireComplete === true) {
        if (options.generation !== undefined)
          failA1(
            "INVALID_VALUE",
            "a completeness check is always about the newest generation",
            "generation",
          );
        print(requireCompleteRound(projectRoot, runId));
        return;
      }
      print(
        collectOrchestrationRound({
          project_root: projectRoot,
          parent_run_id: runId,
          ...(options.generation === undefined
            ? {}
            : { generation: requireInteger(Number(options.generation), "generation", 1) }),
        }),
      );
    },
  );

const resume = testerAgentOption(
  runOptions(program.command("resume")).option(
    "--freeze <path>",
    "frozen outer-run input, only needed if setup was interrupted before runtime creation",
  ),
);
resume.action((options: IdentityOptions & { freeze?: string; testerAgentConfig: string }) => {
  const base = identity(options);
  const input: ResumeOuterRunInput = {
    ...base,
    tester_agent_config_path: requireString(options.testerAgentConfig, "tester_agent_config_path"),
    ...(options.freeze === undefined ? {} : { freeze_input: freezeInput(options.freeze) }),
  };
  print(resumeOuterRun(input));
});

runOptions(program.command("status")).action((options: IdentityOptions) =>
  print(readOuterRunStatus(identity(options))),
);

runOptions(program.command("summary")).action((options: IdentityOptions) =>
  print(
    writeWorkflowSummary({
      project_root: requireString(options.project, "project_root"),
      outer_run_id: assertIdentifier(options.run, "outer_run_id"),
    }),
  ),
);

runOptions(
  program
    .command("cycle-begin")
    .requiredOption("--wave-id <id>", "frozen wave id")
    .requiredOption("--wave-kind <kind>", "module, structure, or scorer")
    .requiredOption("--evidence <paths...>", "diagnosis evidence files"),
).action((options: IdentityOptions & EvidenceOptions & { waveId: string; waveKind: string }) =>
  print(
    beginOuterCycle({
      ...identity(options),
      wave_id: assertIdentifier(options.waveId, "wave_id"),
      wave_kind: options.waveKind as "module" | "structure" | "scorer",
      evidence_paths: evidence(options),
    }),
  ),
);

runOptions(
  program
    .command("phase")
    .requiredOption("--from <phase>", "durable current phase")
    .requiredOption("--to <phase>", "next phase")
    .requiredOption("--evidence <paths...>", "phase evidence files")
    .option("--connection-id <ids...>", "frozen connection records required before a node wave"),
).action(
  (
    options: IdentityOptions &
      EvidenceOptions & {
        from: string;
        to: string;
        connectionId?: string[];
      },
  ) => {
    const input: PhaseAdvanceInput = {
      ...identity(options),
      from_phase: phase(options.from),
      to_phase: phase(options.to),
      evidence_paths: evidence(options),
      ...(options.connectionId === undefined ? {} : { connection_ids: options.connectionId }),
    };
    print(advanceOuterPhase(input));
  },
);

runOptions(
  program
    .command("bridge-failure")
    .requiredOption("--receipt <path>", "failed outer experiment-bridge receipt")
    .option("--manifest <path>", "outer experiment-bridge input manifest")
    .requiredOption("--evidence <paths...>", "bridge failure evidence"),
).action(
  (
    options: IdentityOptions &
      EvidenceOptions & {
        receipt: string;
        manifest?: string;
      },
  ) => {
    const input: RecordOuterBridgeFailureInput = {
      ...identity(options),
      receipt_path: requireString(options.receipt, "receipt_path"),
      ...(options.manifest === undefined
        ? {}
        : { manifest_path: requireString(options.manifest, "manifest_path") }),

      evidence_paths: evidence(options),
    };
    print(recordOuterBridgeFailure(input));
  },
);

runOptions(
  program
    .command("bridge-repair")
    .requiredOption("--receipt <path>", "outer auto-review-loop repair receipt")
    .option("--manifest <path>", "outer bridge repair input manifest")
    .requiredOption("--evidence <paths...>", "bridge repair evidence"),
).action((options: IdentityOptions & EvidenceOptions & { receipt: string; manifest?: string }) => {
  const input: RecordOuterBridgeRepairInput = {
    ...identity(options),
    repair_receipt_path: requireString(options.receipt, "repair_receipt_path"),
    ...(options.manifest === undefined
      ? {}
      : { repair_manifest_path: requireString(options.manifest, "repair_manifest_path") }),
    evidence_paths: evidence(options),
  };
  print(recordOuterBridgeRepair(input));
});

runOptions(
  program
    .command("bridge-success")
    .requiredOption("--receipt <path>", "successful outer experiment-bridge receipt")
    .option("--manifest <path>", "outer experiment-bridge input manifest")
    .requiredOption("--evidence <paths...>", "bridge success evidence"),
).action((options: IdentityOptions & EvidenceOptions & { receipt: string; manifest?: string }) => {
  const input: RecordOuterBridgeSuccessInput = {
    ...identity(options),
    receipt_path: requireString(options.receipt, "receipt_path"),
    ...(options.manifest === undefined
      ? {}
      : { manifest_path: requireString(options.manifest, "manifest_path") }),
    evidence_paths: evidence(options),
  };
  print(recordOuterBridgeSuccess(input));
});

runOptions(
  program
    .command("child-register")
    .requiredOption("--child-run-id <id>", "existing module/scorer/tester run")
    .requiredOption("--kind <kind>", "module, scorer, or tester")
    .option("--module-id <id>", "module this child works on; required for --kind module"),
).action((options: IdentityOptions & { childRunId: string; kind: string; moduleId?: string }) => {
  const input: RegisterOuterChildInput = {
    ...identity(options),
    child_run_id: assertIdentifier(options.childRunId, "child_run_id"),
    kind: childKind(options.kind),
    ...(options.moduleId === undefined ? {} : { module_id: options.moduleId }),
  };
  print(registerOuterChild(input));
});

runOptions(
  program.command("child-complete").requiredOption("--child-run-id <id>", "child run"),
).action((options: IdentityOptions & { childRunId: string }) =>
  print(
    // Completion is observed from the child state file; the command has no status option.
    markOuterChildTerminal({
      ...identity(options),
      child_run_id: assertIdentifier(options.childRunId, "child_run_id"),
    }),
  ),
);

runOptions(
  program
    .command("cycle-complete")
    .requiredOption("--evidence <paths...>", "cycle completion evidence"),
).action((options: IdentityOptions & EvidenceOptions) => {
  const input: CompleteOuterCycleInput = {
    ...identity(options),
    evidence_paths: evidence(options),
  };
  print(completeOuterCycle(input));
});

runOptions(
  program
    .command("budget-reserve")
    .requiredOption("--reservation-id <id>", "budget reservation id")
    .requiredOption("--category <category>", "outer budget category")
    .requiredOption("--amount <number>", "positive amount")
    .requiredOption("--unit <unit>", "budget unit")
    .option("--child-run-id <id>", "child that owns the reservation"),
).action(
  (
    options: IdentityOptions & {
      reservationId: string;
      category: string;
      amount: string;
      unit: string;
      childRunId?: string;
    },
  ) => {
    const categories = ["outer", "module", "validation", "scorer", "promotion", "review"] as const;
    if (!categories.includes(options.category as (typeof categories)[number]))
      failA1("INVALID_VALUE", `unknown budget category '${options.category}'`);
    const input: ReserveOuterBudgetInput = {
      ...identity(options),
      reservation_id: assertIdentifier(options.reservationId, "reservation_id"),
      category: options.category as ReserveOuterBudgetInput["category"],
      amount: requireFiniteNumber(Number(options.amount), "amount"),
      unit: requireString(options.unit, "unit"),
      child_run_id:
        options.childRunId === undefined
          ? null
          : assertIdentifier(options.childRunId, "child_run_id"),
    };
    print(reserveOuterBudget(input));
  },
);

function budgetCloseCommand(name: string, close: (input: CloseOuterBudgetInput) => unknown): void {
  runOptions(
    program
      .command(name)
      .requiredOption("--reservation-id <id>", "budget reservation id")
      .requiredOption("--evidence <paths...>", "budget settlement evidence"),
  ).action((options: IdentityOptions & EvidenceOptions & { reservationId: string }) =>
    print(
      close({
        ...identity(options),
        reservation_id: assertIdentifier(options.reservationId, "reservation_id"),
        evidence_paths: evidence(options),
      }),
    ),
  );
}
budgetCloseCommand("budget-settle", settleOuterBudget);
budgetCloseCommand("budget-release", releaseOuterBudget);

runOptions(
  program.command("validation-record").requiredOption("--input <path>", "validation gate inputs"),
).action((options: IdentityOptions & InputOptions) =>
  print(
    recordValidationGateResult(
      payload(options.input, identity(options)) as RecordValidationGateInput,
    ),
  ),
);

runOptions(
  program
    .command("promotion-record")
    .requiredOption("--tester-run-id <id>", "tester run")
    .requiredOption("--evidence <paths...>", "promotion evidence"),
).action((options: IdentityOptions & EvidenceOptions & { testerRunId: string }) => {
  const input: RecordPromotionGateInput = {
    ...identity(options),
    tester_run_id: assertIdentifier(options.testerRunId, "tester_run_id"),
    evidence_paths: evidence(options),
  };
  print(recordPromotionGateResult(input));
});

runOptions(
  program
    .command("promotion-commit")
    .requiredOption("--registry-run-id <id>", "artifact registry run containing sealed outputs")
    .requiredOption("--tester-receipt <path>", "signed public tester conclusion")
    .requiredOption("--public-key <path>", "root-owned tester conclusion public key")
    .requiredOption("--feedback-receipt <path>", "signed public tester feedback")
    .requiredOption("--feedback-public-key <path>", "root-owned tester feedback public key")
    .requiredOption("--evidence <paths...>", "promotion commit evidence"),
).action(
  (
    options: IdentityOptions &
      EvidenceOptions & {
        registryRunId: string;
        testerReceipt: string;
        publicKey: string;
        feedbackReceipt: string;
        feedbackPublicKey: string;
      },
  ) => {
    const base = identity(options);
    print(
      commitPromotion({
        ...base,
        registry: createArtifactRegistry(
          base.project_root,
          assertIdentifier(options.registryRunId, "registry_run_id"),
        ),
        tester_public_receipt: {
          receipt_path: requireString(options.testerReceipt, "tester_receipt"),
          public_key_path: requireString(options.publicKey, "public_key"),
        },
        tester_feedback_receipt: {
          receipt_path: requireString(options.feedbackReceipt, "feedback_receipt"),
          public_key_path: requireString(options.feedbackPublicKey, "feedback_public_key"),
        },
        evidence_paths: evidence(options),
      }),
    );
  },
);

runOptions(
  program
    .command("promotion-recover")
    .requiredOption("--registry-run-id <id>", "artifact registry run containing sealed outputs")
    .requiredOption("--tester-receipt <path>", "signed public tester conclusion")
    .requiredOption("--public-key <path>", "root-owned tester conclusion public key")
    .requiredOption("--feedback-receipt <path>", "signed public tester feedback")
    .requiredOption("--feedback-public-key <path>", "root-owned tester feedback public key")
    .option("--evidence <paths...>", "original promotion commit evidence"),
).action(
  (
    options: IdentityOptions &
      EvidenceOptions & {
        registryRunId: string;
        testerReceipt: string;
        publicKey: string;
        feedbackReceipt: string;
        feedbackPublicKey: string;
      },
  ) => {
    const base = identity(options);
    const input: RecoverPromotionCommitInput = {
      ...base,
      registry: createArtifactRegistry(
        base.project_root,
        assertIdentifier(options.registryRunId, "registry_run_id"),
      ),
      tester_public_receipt: {
        receipt_path: requireString(options.testerReceipt, "tester_receipt"),
        public_key_path: requireString(options.publicKey, "public_key"),
      },
      tester_feedback_receipt: {
        receipt_path: requireString(options.feedbackReceipt, "feedback_receipt"),
        public_key_path: requireString(options.feedbackPublicKey, "feedback_public_key"),
      },
      ...(options.evidence === undefined ? {} : { evidence_paths: evidence(options) }),
    };
    print(recoverPromotionCommit(input));
  },
);

runOptions(
  program.command("stop-gate").requiredOption("--policy <path>", "explicit stop policy"),
).action((options: IdentityOptions & { policy: string }) => {
  const input: RecordStopDecisionInput = {
    ...identity(options),
    policy: document(options.policy) as unknown as StopPolicy,
  };
  print(recordWorkflowStopDecision(input));
});

runOptions(
  program
    .command("finish")
    .requiredOption("--outcome <outcome>", "completed, failed, or stopped")
    .requiredOption("--evidence <paths...>", "final run evidence"),
).action((options: IdentityOptions & EvidenceOptions & { outcome: string }) => {
  if (
    options.outcome !== "completed" &&
    options.outcome !== "failed" &&
    options.outcome !== "stopped"
  )
    failA1("INVALID_VALUE", `unknown outer outcome '${options.outcome}'`);
  const input: FinishOuterRunInput = {
    ...identity(options),
    outcome: options.outcome,
    evidence_paths: evidence(options),
  };
  print(finishOuterRun(input));
});

runOptions(
  program.command("compile").requiredOption("--input <path>", "candidate and spec input"),
).action((options: IdentityOptions & InputOptions) =>
  print(
    compileOuterCandidate(payload(options.input, identity(options)) as CompileOuterCandidateInput),
  ),
);

runCli(program);
