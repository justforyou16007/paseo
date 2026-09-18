import { runWikiRoot } from "./wiki-scope.js";
import { initializeWikiSchema } from "./wiki-event-store.js";
import fs from "node:fs";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { publishSignal } from "./research-wiki.js";
import {
  sanitizeTesterFeedback,
  testerFeedbackPath,
  type TesterFeedback,
} from "./tester-feedback.js";
import { readTesterRunState } from "./tester-state.js";
import { readPromotionCommitIntent } from "./workflow-promotion-commit.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  assertSha256,
  failA1,
  isRecord,
  requireString,
} from "./workflow-spec.js";
import type { WikiSignal } from "./wiki-operations.js";

export interface TesterFeedbackSignalTarget {
  module_id: string;
  module_version: string;
  contract_versions: readonly string[];
  scorer_revision?: string;
  scorer_target?: unknown;
  constraints?: readonly unknown[];
}

export interface PublishTesterFeedbackSignalInput {
  actor: "outer_committer" | "tester_worker" | "sanitizer" | "reviewer";
  project_root: string;
  wiki_root: string;
  execution_root: string;
  outer_run_id: string;
  outer_iteration: number;
  workflow_id: string;
  workflow_revision: string;
  tester_run_id: string;
  targets: readonly TesterFeedbackSignalTarget[];
}

export interface TesterFeedbackSignalResult {
  feedback_event_id: string;
  signals: Array<{
    module_id: string;
    signal_id: string;
    status: "appended" | "skipped";
    event_id: string | null;
  }>;
}

function feedbackForRun(projectRoot: string, testerRunId: string): TesterFeedback {
  const filePath = testerFeedbackPath(projectRoot, testerRunId);
  if (!fs.existsSync(filePath))
    failA1("TESTER_FEEDBACK_NOT_READY", `sanitized tester feedback is missing at ${filePath}`);
  return sanitizeTesterFeedback(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function assertTargetList(
  targets: readonly TesterFeedbackSignalTarget[],
): TesterFeedbackSignalTarget[] {
  if (!Array.isArray(targets) || targets.length === 0)
    failA1("TESTER_FEEDBACK_NOT_READY", "tester feedback needs at least one module target");
  const seen = new Set<string>();
  return targets.map((target, index) => {
    if (!isRecord(target)) failA1("INVALID_VALUE", `targets[${index}] must be an object`);
    assertNoUnknownFields(
      target,
      [
        "module_id",
        "module_version",
        "contract_versions",
        "scorer_revision",
        "scorer_target",
        "constraints",
      ],
      `targets[${index}]`,
    );
    const moduleId = assertIdentifier(target.module_id, `targets[${index}].module_id`);
    if (seen.has(moduleId)) failA1("DUPLICATE_ID", `module target '${moduleId}' appears twice`);
    seen.add(moduleId);
    const moduleVersion = assertIdentifier(
      target.module_version,
      `targets[${index}].module_version`,
    );
    const rawContractVersions: unknown = target.contract_versions;
    if (!Array.isArray(rawContractVersions))
      failA1("INVALID_VALUE", `targets[${index}].contract_versions must be an array`);
    const contractVersions = rawContractVersions.map((value: unknown, contractIndex: number) =>
      requireString(value, `targets[${index}].contract_versions[${contractIndex}]`),
    );
    if (new Set(contractVersions).size !== contractVersions.length)
      failA1("DUPLICATE_ID", `targets[${index}].contract_versions must be unique`);
    const scorerRevision =
      target.scorer_revision === undefined
        ? undefined
        : requireString(target.scorer_revision, `targets[${index}].scorer_revision`);
    if (target.constraints !== undefined && !Array.isArray(target.constraints))
      failA1("INVALID_VALUE", `targets[${index}].constraints must be an array`);
    return {
      ...target,
      module_id: moduleId,
      module_version: moduleVersion,
      contract_versions: [...contractVersions],
      ...(scorerRevision === undefined ? {} : { scorer_revision: scorerRevision }),
      ...(target.constraints === undefined ? {} : { constraints: [...target.constraints] }),
    };
  });
}

function feedbackKind(feedback: TesterFeedback): WikiSignal["kind"] {
  if (feedback.conclusion === "improved") return "observation";
  if (feedback.conclusion === "not_improved") return "failure";
  return "constraint";
}

export function buildTesterFeedbackSignal(
  input: PublishTesterFeedbackSignalInput,
  feedback: TesterFeedback,
): WikiSignal {
  const identity = canonicalJsonSha256(
    {
      feedback_event_id: feedback.feedback_event_id,
      workflow_id: input.workflow_id,
      workflow_revision: input.workflow_revision,
    },
    undefined,
    { schemaVersion: "tester-feedback-signal-v1" },
  );
  const signalId = `signal:tester-feedback:${identity}`;
  return {
    signal_id: signalId,
    kind: feedbackKind(feedback),
    source: "tester_feedback",
    // The outer owns this fact; children consume the parent snapshot.
    producer: {
      module_id: input.workflow_id,
      module_version: input.workflow_revision,
      run_id: input.outer_run_id,
    },
    applies_to: {
      workflow_id: input.workflow_id,
      workflow_revision: input.workflow_revision,
      input_snapshot_id: feedback.input_snapshot_sha256,
      contract_versions: [],
    },
    evidence_refs: [feedback.feedback_event_id],
    supersedes: [],
    status: "active",
    summary: `Fixed tester reported ${feedback.conclusion} with ${feedback.confidence} confidence.`,
    observation: `Coarse directions: ${feedback.directions.join(", ")}.`,
    recommendation: `Coarse advice: ${feedback.advice.join(", ")}.`,
  };
}

/**
 * Publish only the already-sanitized tester outcome. This boundary never
 * opens the private result; it requires the terminal promotion intent and
 * writes one deterministic signal in the outer run Wiki.
 */
export function publishTesterFeedbackSignals(
  input: PublishTesterFeedbackSignalInput,
): TesterFeedbackSignalResult {
  if (!isRecord(input)) failA1("INVALID_VALUE", "tester feedback signal input must be an object");
  assertNoUnknownFields(
    input,
    [
      "actor",
      "project_root",
      "wiki_root",
      "execution_root",
      "outer_run_id",
      "outer_iteration",
      "workflow_id",
      "workflow_revision",
      "tester_run_id",
      "targets",
    ],
    "tester_feedback_signal",
  );
  if (input.actor !== "outer_committer")
    failA1("WRITE_SCOPE_FORBIDDEN", "only the outer committer may publish tester feedback signals");
  const projectRoot = requireString(input.project_root, "project_root");
  requireString(input.wiki_root, "wiki_root");
  const executionRoot = requireString(input.execution_root, "execution_root");
  const outerRunId = assertIdentifier(input.outer_run_id, "outer_run_id");
  const workflowId = assertIdentifier(input.workflow_id, "workflow_id");
  const workflowRevision = assertIdentifier(input.workflow_revision, "workflow_revision");
  const testerRunId = assertIdentifier(input.tester_run_id, "tester_run_id");
  if (!Number.isInteger(input.outer_iteration) || input.outer_iteration < 1)
    failA1("INVALID_VALUE", "outer_iteration must be positive");
  assertTargetList(input.targets);
  const feedback = feedbackForRun(projectRoot, testerRunId);
  const tester = readTesterRunState(projectRoot, testerRunId);
  if (
    !tester.gate_consumed ||
    (tester.status !== "passed" && tester.status !== "rejected") ||
    tester.promotion_trial_id !== feedback.promotion_trial_id ||
    tester.input_snapshot_sha256 !== feedback.input_snapshot_sha256 ||
    tester.tester_version !== feedback.tester_version
  )
    failA1("TESTER_FEEDBACK_NOT_READY", "tester feedback is not bound to a terminal tester state");
  if (
    (tester.gate_status === "passed" && feedback.conclusion !== "improved") ||
    (tester.gate_status === "rejected" && feedback.conclusion === "improved")
  )
    failA1(
      "TESTER_FEEDBACK_NOT_READY",
      "tester feedback conclusion does not match the tester gate",
    );
  const intent = readPromotionCommitIntent({
    project_root: projectRoot,
    outer_run_id: outerRunId,
    outer_iteration: input.outer_iteration,
    execution_root: executionRoot,
  });
  if (
    (intent.status !== "committed" && intent.status !== "rejected") ||
    intent.workflow_id !== workflowId ||
    intent.promotion.tester_run_id !== testerRunId ||
    intent.feedback.feedback_event_id !== feedback.feedback_event_id
  )
    failA1(
      "TESTER_FEEDBACK_NOT_READY",
      "promotion commit is not a terminal source for this feedback",
    );
  const feedbackHash = assertSha256(
    canonicalJsonSha256(feedback, undefined, { schemaVersion: "tester-feedback-v1" }),
    "tester_feedback_sha256",
  );
  if (feedbackHash !== intent.feedback_sha256)
    failA1("TESTER_FEEDBACK_NOT_READY", "stored tester feedback differs from the commit intent");

  const signal = buildTesterFeedbackSignal(
    {
      ...input,
      outer_run_id: outerRunId,
      workflow_id: workflowId,
      workflow_revision: workflowRevision,
    },
    feedback,
  );
  const root = runWikiRoot(projectRoot, outerRunId);
  initializeWikiSchema(root);
  const result = publishSignal(root, signal, {
    projectRoot,
    runId: outerRunId,
    evidenceBundleId: feedback.feedback_event_id,
  });
  const event = "event" in result ? result.event : null;
  const signals = [
    {
      module_id: workflowId,
      signal_id: signal.signal_id,
      status: (result.status === "appended" ? "appended" : "skipped") as "appended" | "skipped",
      event_id: event?.event_id ?? null,
    },
  ];
  return { feedback_event_id: feedback.feedback_event_id, signals };
}
