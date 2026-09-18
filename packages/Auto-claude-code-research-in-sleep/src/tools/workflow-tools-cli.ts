#!/usr/bin/env node
import { prepareRunExecution } from "./run-budget.js";
import { createCli, runCli } from "../lib/cli.js";
import { ensureRun } from "./run-contract.js";

import { readStateFile } from "./state-file.js";
import { createArtifactRegistry } from "./artifact-registry.js";
import {
  saveTaskSetup,
  setupRootRun,
  type CreateTaskSetupInput,
  type RootSetupInput,
} from "./task-setup.js";
import {
  resolveModelAssignment,
  saveModelAssignment,
  validateIncumbentSnapshot,
} from "./model-assignment.js";
import { createReviewAssignment, submitReviewReceipt } from "./review-submit.js";
import {
  startScorerRun,
  readScorerRunState,
  beginScorerParentExperiment,
  sealScorerParent,
  sealScorerCandidate,
  recordScorerReview,
  activateScorerRevision,
  rejectScorerRevision,
  recoverScorerRun,
} from "./scorer-state.js";
import {
  assertNoUnknownFields,
  assertIdentifier,
  isRecord,
  requireInteger,
  requireString,
  validateModelUsagePolicy,
  failA1,
} from "./workflow-spec.js";
import {
  createModuleWorkspace,
  inspectModuleWorkspace,
  sealModuleWorkspace,
  removeModuleWorkspace,
  restoreModuleWorkspace,
  type WorkspaceEvidence,
} from "./workflow-workspace.js";

import {
  composeWorkflowModules,
  readWorkflowComposition,
  removeWorkflowComposition,
} from "./workflow-composition.js";
import {
  finishStructureWave,
  prepareStructureWave,
  readStructureWave,
  recordStructureReview,
} from "./structure-wave.js";
import { registerScorerWaveForOuter } from "./scorer-wave-runtime.js";
import {
  publishTesterFeedbackSignals,
  type PublishTesterFeedbackSignalInput,
} from "./tester-feedback-signal.js";
import {
  evaluateWorkflowConnection,
  readNodeInterfaceRecord,
  readWorkflowConnectionRecord,
  saveNodeInterfaceRecord,
  saveWorkflowConnectionRecord,
  validateWorkflowOutputContent,
} from "./workflow-interface.js";

const program = createCli("workflow-tools", "Manifest-based workflow worker and review operations");

interface InputOption {
  input: string;
}
interface RunOption {
  project: string;
  run: string;
}
interface RunInputOption extends RunOption, InputOption {}

function document(inputPath: string): Record<string, unknown> {
  const input = readStateFile<unknown>(inputPath);
  if (!isRecord(input)) failA1("INVALID_VALUE", "command input must be a JSON object");
  return input;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

program
  .command("task-setup")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--input <path>", "Owner-confirmed setup JSON")
  .action((options: InputOption & { project: string }) => {
    const input = document(options.input);
    assertNoUnknownFields(
      input,
      [
        "task_id",
        "workflow_id",
        "setup_revision",
        "model_usage_policy",
        "tester_id",
        "tester_version",
      ],
      "task_setup",
    );
    const setup: CreateTaskSetupInput = {
      task_id: assertIdentifier(input.task_id, "task_id"),
      workflow_id: assertIdentifier(input.workflow_id, "workflow_id"),
      setup_revision: assertIdentifier(input.setup_revision, "setup_revision"),
      model_usage_policy: input.model_usage_policy,
      tester_id: assertIdentifier(input.tester_id, "tester_id"),
      tester_version: assertIdentifier(input.tester_version, "tester_version"),
    };
    print(saveTaskSetup(options.project, setup));
  });

program
  .command("root-setup")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--input <path>", "Complete human-confirmed root setup JSON")
  .action((options: InputOption & { project: string }) => {
    const input = document(options.input);
    print(setupRootRun({ ...input, project_root: options.project } as RootSetupInput));
  });

program
  .command("run-open")
  .description("Create or reuse a single-node run contract")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Standalone run identity")
  .action((options: RunOption) => {
    print(
      ensureRun({
        project_root: options.project,
        run_id: options.run,

        parent_run_id: null,
      }),
    );
  });

program
  .command("model-assignment")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run identity")
  .requiredOption("--input <path>", "Frozen assignment inputs")
  .action((options: RunInputOption) => {
    const input = document(options.input);
    assertNoUnknownFields(
      input,
      ["policy", "task_setup_revision", "outer_iteration", "incumbent", "registry_run_id"],
      "assignment",
    );
    const iteration = requireInteger(input.outer_iteration, "outer_iteration", 1);
    const assignment = resolveModelAssignment({
      policy: validateModelUsagePolicy(input.policy),
      task_setup_revision: requireString(input.task_setup_revision, "task_setup_revision"),
      outer_run_id: assertIdentifier(options.run, "outer_run_id"),
      outer_iteration: iteration,
      incumbent: validateIncumbentSnapshot(input.incumbent),
      registry: createArtifactRegistry(
        options.project,
        assertIdentifier(input.registry_run_id, "registry_run_id"),
      ),
    });
    print(saveModelAssignment(options.project, assignment));
  });

program
  .command("artifact-register")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Registry run")
  .requiredOption("--input <path>", "Sealed artifact reference")
  .action((options: RunInputOption) =>
    print(createArtifactRegistry(options.project, options.run).register(document(options.input))),
  );

// The underlying entrypoints validate manifests, disk evidence and identities before writes.
program
  .command("review-assign")
  .requiredOption("--input <path>", "Scheduler review assignment")
  .action((options: InputOption) =>
    print(
      createReviewAssignment(
        readStateFile<Parameters<typeof createReviewAssignment>[0]>(options.input),
      ),
    ),
  );
program
  .command("review-submit")
  .requiredOption("--input <path>", "Review submission envelope")
  .action((options: InputOption) =>
    print(
      submitReviewReceipt(readStateFile<Parameters<typeof submitReviewReceipt>[0]>(options.input)),
    ),
  );
program
  .command("scorer-create")
  .requiredOption("--input <path>", "Scorer run manifest")
  .action((options: InputOption) =>
    print(startScorerRun(readStateFile<Parameters<typeof startScorerRun>[0]>(options.input))),
  );

program
  .command("scorer-register")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run")
  .requiredOption("--input <path>", "Frozen scorer registration")
  .action((options: RunInputOption) => {
    const input = document(options.input);
    print(
      registerScorerWaveForOuter({
        execution_root: requireString(input.execution_root, "execution_root"),
        project_root: options.project,
        outer_run_id: options.run,
        outer_iteration: requireInteger(input.outer_iteration, "outer_iteration", 1),
        generation: requireInteger(input.generation, "generation", 1),
        start: input.start as Parameters<typeof registerScorerWaveForOuter>[0]["start"],
      }),
    );
  });

program
  .command("structure-prepare")
  .requiredOption("--input <path>", "single frozen structure proposal")
  .action((options: InputOption) =>
    print(
      prepareStructureWave(
        readStateFile<Parameters<typeof prepareStructureWave>[0]>(options.input),
      ),
    ),
  );
program
  .command("structure-status")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run")
  .requiredOption("--iteration <number>", "Outer iteration")
  .action((options: RunOption & { iteration: string }) =>
    print(readStructureWave(options.project, options.run, Number(options.iteration))),
  );
program
  .command("structure-review")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run")
  .requiredOption("--iteration <number>", "Outer iteration")
  .requiredOption("--input <path>", "stored structure review receipt")
  .action((options: RunInputOption & { iteration: string }) =>
    print(
      recordStructureReview({
        execution_root: options.project,
        project_root: options.project,
        outer_run_id: options.run,
        outer_iteration: Number(options.iteration),
        review: readStateFile(options.input),
      }),
    ),
  );
program
  .command("structure-finish")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run")
  .requiredOption("--iteration <number>", "Outer iteration")
  .requiredOption("--status <status>", "completed or failed")
  .action((options: RunOption & { iteration: string; status: string }) => {
    if (options.status !== "completed" && options.status !== "failed")
      failA1("INVALID_VALUE", "structure status must be completed or failed");
    print(
      finishStructureWave(options.project, options.run, Number(options.iteration), options.status),
    );
  });
program
  .command("workspace-create")
  .requiredOption("--input <path>", "Workspace specification")
  .action((options: InputOption) =>
    print(
      createModuleWorkspace(
        readStateFile<Parameters<typeof createModuleWorkspace>[0]>(options.input),
      ),
    ),
  );
for (const [name, action] of [
  ["workspace-check", inspectModuleWorkspace],
  ["workspace-seal", sealModuleWorkspace],
  ["workspace-restore", restoreModuleWorkspace],
] as const) {
  program
    .command(name)
    .requiredOption("--project <path>", "Project root")
    .requiredOption("--run <id>", "Module run")
    .action((options: RunOption) => print(action(options.project, options.run)));
}
program
  .command("workspace-remove")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Module run")
  .requiredOption("--input <path>", "Sealed cleanup evidence list")
  .action((options: RunInputOption) =>
    print(
      removeModuleWorkspace(
        options.project,
        options.run,
        readStateFile<WorkspaceEvidence[]>(options.input),
      ),
    ),
  );

const readActions = [
  ["scorer-status", readScorerRunState],
  ["scorer-parent-start", beginScorerParentExperiment],
  ["scorer-parent-seal", sealScorerParent],
  ["scorer-candidate-seal", sealScorerCandidate],
  ["scorer-reject", rejectScorerRevision],
  ["scorer-recover", recoverScorerRun],
] as const;
for (const [name, action] of readActions) {
  program
    .command(name)
    .requiredOption("--project <path>", "Project root")
    .requiredOption("--run <id>", "Run identity")
    .action((options: RunOption) => print(action(options.project, options.run)));
}

program
  .command("execution-prepare")
  .requiredOption("--input <path>", "Execution budget and worker manifest")
  .action((options: InputOption) =>
    print(
      prepareRunExecution(readStateFile<Parameters<typeof prepareRunExecution>[0]>(options.input)),
    ),
  );

for (const [name, action] of [
  ["scorer-review", recordScorerReview],
  ["scorer-activate", activateScorerRevision],
] as const) {
  program
    .command(name)
    .requiredOption("--project <path>", "Project root")
    .requiredOption("--run <id>", "Scorer run")
    .requiredOption("--input <path>", "Stored review receipt")
    .action((options: RunInputOption) =>
      print(action(options.project, options.run, document(options.input))),
    );
}
program
  .command("tester-feedback-signal")
  .requiredOption("--input <path>", "outer-committer tester feedback signal input")
  .action((options: InputOption) =>
    print(
      publishTesterFeedbackSignals(
        document(options.input) as unknown as PublishTesterFeedbackSignalInput,
      ),
    ),
  );

program
  .command("composition-create")
  .requiredOption("--input <path>", "Frozen composition input")
  .action((options: InputOption) => print(composeWorkflowModules(document(options.input))));

program
  .command("composition-status")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--id <id>", "Composition id")
  .action((options: { project: string; id: string }) =>
    print(readWorkflowComposition(options.project, options.id)),
  );

program
  .command("composition-remove")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--id <id>", "Composition id")
  .action((options: { project: string; id: string }) =>
    print(removeWorkflowComposition(options.project, options.id)),
  );

program
  .command("interface-save")
  .alias("node-interface-save")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Node run")
  .requiredOption("--input <path>", "Node interface record")
  .action((options: RunInputOption) =>
    print(saveNodeInterfaceRecord(options.project, options.run, document(options.input))),
  );

program
  .command("interface-status")
  .alias("node-interface-status")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Node run")
  .action((options: RunOption) => print(readNodeInterfaceRecord(options.project, options.run)));

program
  .command("connection-evaluate")
  .requiredOption("--input <path>", "Upstream/downstream interface connection input")
  .action((options: InputOption) =>
    print(
      evaluateWorkflowConnection(
        document(options.input) as unknown as Parameters<typeof evaluateWorkflowConnection>[0],
      ),
    ),
  );

program
  .command("output-content-check")
  .alias("interface-output-check")
  .requiredOption("--input <path>", "Interface record and actual output")
  .action((options: InputOption) =>
    print(
      validateWorkflowOutputContent(
        document(options.input) as unknown as Parameters<typeof validateWorkflowOutputContent>[0],
      ),
    ),
  );

program
  .command("connection-save")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run")
  .requiredOption("--input <path>", "Evaluated workflow connection record")
  .action((options: RunInputOption) =>
    print(saveWorkflowConnectionRecord(options.project, options.run, document(options.input))),
  );

program
  .command("connection-status")
  .requiredOption("--project <path>", "Project root")
  .requiredOption("--run <id>", "Outer run")
  .requiredOption("--id <id>", "Connection id")
  .action((options: RunOption & { id: string }) =>
    print(readWorkflowConnectionRecord(options.project, options.run, options.id)),
  );
runCli(program);
