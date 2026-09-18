import { createChildContract } from "./helpers/child-contract.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import { validateCoverageMap } from "../src/tools/scorer-coverage.js";
import {
  materializeScorerRevision,
  saveImmutableScorerDelta,
  saveImmutableScorerRevision,
  validateScorerDelta,
  validateScorerRevision,
  type ScorerRevision,
} from "../src/tools/scorer-definition.js";
import { createRootRun, runJsonPath } from "../src/tools/run-contract.js";
import {
  freezeScorerComparisonInput,
  materializeSharedProbe,
  runScorerComparison,
  runStandaloneScorerComparison,
  validateEvaluationItem,
  type RunScorerComparisonInput,
} from "../src/tools/scorer-experiment.js";
import {
  createReviewAssignment,
  readStoredReviewReceipt,
  reviewCommandIndexPath,
  submitReviewReceipt,
  type ScorerReviewReceipt,
} from "../src/tools/review-submit.js";
import {
  activateScorerRevision,
  assertWaveKindExclusive,
  beginOrdinaryWave,
  recordScorerReview,
  recoverScorerRun,
  readScorerRunState,
  saveScorerWaveRegistration,
  scorerRunStatePath,
  scorerRunDashboardPath,
  startScorerRun,
  transitionScorerState,
} from "../src/tools/scorer-state.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

type TestFunction = () => void;

const tests: Array<{ name: string; fn: TestFunction }> = [];

function test(name: string, fn: TestFunction): void {
  tests.push({ name, fn });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a1-scorer-test-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

function coverageMap(
  id: string,
  parentId: string | null,
  cells: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    coverage_map_id: id,
    parent_coverage_map_id: parentId,
    dimensions: [
      {
        dimension_id: "difficulty",
        source: "scorer_discovered",
        ordered_values: ["basic", "stress", "extreme"],
      },
      {
        dimension_id: "surface",
        source: "task_defined",
        values: ["cli", "web"],
      },
    ],
    coverage_cells: cells,
    delta_summary: {
      added_cells: ["reviewer-must-not-control-this"],
      deepened_relations: ["reviewer-must-not-control-this-either"],
      superseded_items: ["reviewer-must-not-control-this-too"],
      retired_invalid_items: ["reviewer-must-not-control-this-one-more-time"],
    },
  };
}

function cell(
  id: string,
  difficulty: string,
  surface: string,
  benchmarkId: string,
): Record<string, unknown> {
  return {
    coverage_cell_id: id,
    coordinates: { difficulty, surface },
    benchmark_item_refs: [benchmarkId],
    evidence_refs: ["evidence:" + id],
  };
}

function revisionFromParts(input: {
  revision: string;
  parent_revision: string | null;
  coverage_map: unknown;
  benchmark_items: Array<Record<string, unknown>>;
  scoring_rules?: Array<Record<string, unknown>>;
}): ScorerRevision {
  const coverage = validateCoverageMap(input.coverage_map);
  const benchmarkItems = input.benchmark_items;
  const scoringRules = input.scoring_rules ?? [
    {
      rule_id: "rule:quality",
      kind: "deterministic_rule",
      content_hash: HASH_B,
      active: true,
      deleted_in_revision: null,
    },
  ];
  const withoutHashes = {
    schema_version: 1,
    scorer_id: "scorer:validation",
    parent_revision: input.parent_revision,
    benchmark_items: benchmarkItems,
    scoring_rules: scoringRules,
    coverage_map: coverage,
  };
  const coverageMapSha256 = canonicalJsonSha256(coverage, undefined, {
    schemaVersion: "coverage-map-v1",
  });
  const definitionSha256 = canonicalJsonSha256(withoutHashes, undefined, {
    schemaVersion: "scorer-revision-v1",
  });
  return validateScorerRevision({
    ...withoutHashes,
    revision: input.revision,
    coverage_map_sha256: coverageMapSha256,
    definition_sha256: definitionSha256,
  });
}

function parentRevision(): ScorerRevision {
  return revisionFromParts({
    revision: "scorer:parent",
    parent_revision: null,
    coverage_map: coverageMap("coverage:parent", null, [
      cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
    ]),
    benchmark_items: [
      {
        benchmark_id: "benchmark:family@1",
        content_hash: HASH_A,
        status: "active",
        generator_id: null,
        supersedes: null,
        evidence_refs: ["evidence:cell:basic-cli"],
      },
    ],
  });
}

function scorerDelta(parent: ScorerRevision, operations: Array<Record<string, unknown>>): unknown {
  return validateScorerDelta({
    schema_version: 1,
    delta_id: "delta:a1-scorer",
    scorer_id: parent.scorer_id,
    parent_revision: parent.revision,
    delta_kind: "benchmark",
    operations,
    producer_scorer_run_id: "scorer-run-a1",
    evidence_refs: [
      "evidence:cell:stress-cli",
      "evidence:cell:basic-web",
      "evidence:retire",
      "evidence:missing",
      "evidence:new",
    ],
  });
}

interface StrictScorerFixture {
  root: string;
  parent: ScorerRevision;
  candidate: ScorerRevision;
  delta: ReturnType<typeof scorerDelta>;
  input: RunScorerComparisonInput;
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function strictScorerFixture(root: string): StrictScorerFixture {
  const parent = parentRevision();
  const delta = scorerDelta(parent, [
    {
      op: "add_benchmark_item",
      benchmark_id: "benchmark:new@1",
      content_hash: HASH_C,
      evidence_refs: ["evidence:new"],
    },
  ]);
  const candidate = materializeScorerRevision(
    parent,
    delta,
    coverageMap("coverage:new", parent.coverage_map.coverage_map_id, [
      cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
      cell("cell:new", "stress", "cli", "benchmark:new@1"),
    ]),
  );
  saveImmutableScorerDelta(root, delta);
  saveImmutableScorerRevision(root, parent);
  saveImmutableScorerRevision(root, candidate);

  const workflowId = "workflow:a1";
  const scorerId = parent.scorer_id;
  const scorerRunId = "scorer-run-a1";
  const outerRunId = "outer-a1";
  const waveId = "wave:scorer";
  createRootRun({
    project_root: root,
    run_id: outerRunId,
    
    
    
    charter_sha256: HASH_A,
    input_snapshot_sha256: HASH_B,
    execution_plan_sha256: HASH_C,
    code_baseline_sha256: HASH_A,
    policy_revision: "policy:a1-scorer",
  });
  writeJson(root, ".aris/workflows/workflow:a1/definition.json", {
    schema_version: 1,
    workflow_id: workflowId,
    validation_policy: { scorer_id: scorerId },
    scorers: [{ id: scorerId }],
    scorer_wave_policy: {
      exclusive: true,
      max_candidates: 1,
      experiment_parallelism: 1,
      execution_order: "baseline_then_candidate",
      blocks_other_wave_kinds: true,
    },
  });
  writeJson(root, ".aris/workflows/workflow:a1/active-scorer.json", {
    schema_version: 1,
    workflow_id: workflowId,
    scorer_id: scorerId,
    revision: parent.revision,
    scorer_run_id: "active-scorer-parent",
  });
  writeJson(root, ".aris/runs/outer-a1/cycles/1/scorer-wave.json", {
    schema_version: 1,
    wave_kind: "scorer",
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    outer_run_id: outerRunId,
    outer_iteration: 1,
    wave_id: waveId,
    parent_revision: parent.revision,
    candidate_revision: candidate.revision,
    delta_id: delta.delta_id,
  });
  createChildContract(root, outerRunId, scorerRunId, "scorer");
  startScorerRun({
    project_root: root,
    workflow_id: workflowId,
    scorer_run_id: scorerRunId,
    scorer_id: scorerId,
    outer_run_id: outerRunId,
    outer_iteration: 1,
    wave_id: waveId,
    generation: 1,
    parent_revision: parent.revision,
    candidate_revision: candidate.revision,
    delta_id: delta.delta_id,
  });
  transitionScorerState(root, scorerRunId, "materialized");
  const materialize = (caseId: string, revision: string) => ({
    item_id: caseId,
    input: { value: caseId },
    contract: "eval@1",
    source: revision,
  });
  const freeze = {
    seed_manifest: { frozen: true, seed: 17 },
    representative_artifact_id: "artifact:representative@1",
    representative_artifact_sha256: HASH_A,
    input_snapshot_sha256: HASH_B,
    model_assignment_sha256: HASH_C,
    judge_binding_id: "judge:a1",
  };
  freezeScorerComparisonInput({
    project_root: root,
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    parent,
    candidate,
    freeze,
    materialize,
  });
  const input: RunScorerComparisonInput = {
    project_root: root,
    workflow_id: workflowId,
    scorer_id: scorerId,
    scorer_run_id: scorerRunId,
    lock_path: path.join(root, "caller-chosen.lock"),
    parent,
    candidate,
    freeze,
    materialize,
    evaluate_parent: (request) => ({
      item_id: request.evaluation_item.item_id,
      score: 1,
      labels: [],
      output_sha256: HASH_A,
    }),
    evaluate_candidate: (request) => ({
      item_id: request.evaluation_item.item_id,
      score: 2,
      labels: [],
      output_sha256: HASH_B,
    }),
  };
  return { root, parent, candidate, delta, input };
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function submitScorerReview(
  fixture: StrictScorerFixture,
  sharedProbeManifestSha256: string,
): ScorerReviewReceipt {
  const producer = "evidence-worker:a1";
  const reviewer = "reviewer:a1";
  const reviewId = "review:a1";
  const evidenceBundleId = "evidence-bundle:a1";
  const workerRoot = path.join(
    fixture.root,
    ".aris",
    "runs",
    fixture.input.scorer_run_id,
    "workers",
    producer,
  );
  const outputRoot = path.join(workerRoot, "outputs");
  const evidencePath = path.join(outputRoot, "review-evidence.json");
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(evidencePath, "frozen scorer evidence\n", "utf8");
  const evidenceHash = sha256File(evidencePath);
  writeJson(
    fixture.root,
    path.relative(fixture.root, path.join(workerRoot, "input-manifest.json")),
    {
      schema_version: 1,
      run_id: fixture.input.scorer_run_id,
      worker: producer,
      output_dir: path.relative(fixture.root, outputRoot),
    },
  );
  const executionReceiptPath = path.join(workerRoot, "receipt.json");
  writeJson(fixture.root, path.relative(fixture.root, executionReceiptPath), {
    schema_version: 1,
    run_id: fixture.input.scorer_run_id,
    worker: producer,
    status: "done",
    primary_output: "review-evidence.json",
    primary_output_sha256: evidenceHash,
  });
  const subject = {
    parent_revision: fixture.parent.revision,
    candidate_revision: fixture.candidate.revision,
    delta_id: fixture.delta.delta_id,
    coverage_map_sha256: fixture.candidate.coverage_map_sha256,
    shared_probe_manifest_sha256: sharedProbeManifestSha256,
  };
  createReviewAssignment({
    actor: "review_scheduler",
    project_root: fixture.root,
    review_id: reviewId,
    outer_run_id: "outer-a1",
    reviewed_run_id: fixture.input.scorer_run_id,
    reviewed_run_kind: "scorer",
    outer_iteration: 1,
    wave_id: "wave:scorer",
    wave_kind: "scorer",
    review_stage: "scorer_revision",
    generation: 1,
    subject,
    reviewer_worker_id: reviewer,
    evidence_producer_worker_id: producer,
    evidence_bundle_id: evidenceBundleId,
    evidence_path: path.relative(fixture.root, evidencePath),
  });
  const receipt: ScorerReviewReceipt = {
    schema_version: 1,
    review_id: reviewId,
    reviewed_run_id: fixture.input.scorer_run_id,
    reviewed_run_kind: "scorer",
    outer_iteration: 1,
    wave_id: "wave:scorer",
    wave_kind: "scorer",
    review_stage: "scorer_revision",
    generation: 1,
    subject,
    reviewer_worker_id: reviewer,
    evidence_bundle_id: evidenceBundleId,
    evidence_sha256: evidenceHash,
    verdict: "approved",
    reason_codes: ["scorer_reviewed"],
    evidence_refs: ["evidence:scorer-review"],
    command_id: "review-submit:" + reviewId,
    breadth_verdict: "approved",
    breadth_reason_codes: ["breadth:covered"],
    breadth_evidence_refs: ["evidence:scorer-review"],
    depth_verdict: "approved",
    depth_reason_codes: ["depth:covered"],
    depth_evidence_refs: ["evidence:scorer-review"],
  };
  submitReviewReceipt({
    project_root: fixture.root,
    receipt,
    manifest_run_id: fixture.input.scorer_run_id,
    command_run_id: fixture.input.scorer_run_id,
  });
  return receipt;
}

test("delta 只能追加/替代/有证据退休，物化不改父版本且可重放", () => {
  const parent = parentRevision();
  const parentBefore = structuredClone(parent);
  const delta = scorerDelta(parent, [
    {
      op: "add_benchmark_item",
      benchmark_id: "benchmark:deep@1",
      content_hash: HASH_C,
      evidence_refs: ["evidence:cell:stress-cli"],
    },
    {
      op: "add_benchmark_item",
      benchmark_id: "benchmark:wide@1",
      content_hash: HASH_D,
      evidence_refs: ["evidence:cell:basic-web"],
    },
  ]);
  const candidateMap = coverageMap("coverage:candidate", parent.coverage_map.coverage_map_id, [
    cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
    cell("cell:stress-cli", "stress", "cli", "benchmark:deep@1"),
    cell("cell:basic-web", "basic", "web", "benchmark:wide@1"),
  ]);
  const candidate = materializeScorerRevision(parent, delta, candidateMap);
  const replay = materializeScorerRevision(parent, delta, candidateMap);

  assert.deepEqual(parent, parentBefore);
  assert.deepEqual(candidate, replay);
  assert.equal(candidate.benchmark_items.length, parent.benchmark_items.length + 2);
  assert.deepEqual(candidate.coverage_map.delta_summary.added_cells, [
    "cell:basic-web",
    "cell:stress-cli",
  ]);
  assert.deepEqual(candidate.coverage_map.delta_summary.deepened_relations, [
    "coverage-relation:cell:basic-cli->cell:stress-cli",
  ]);
  assert.deepEqual(candidate.coverage_map.delta_summary.retired_invalid_items, []);

  const guessedSupersede = materializeScorerRevision(
    parent,
    scorerDelta(parent, [
      {
        op: "add_benchmark_item",
        benchmark_id: "benchmark:family@2",
        content_hash: HASH_C,
        evidence_refs: ["evidence:cell:stress-cli"],
      },
    ]),
    coverageMap("coverage:guessed", parent.coverage_map.coverage_map_id, [
      cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
      cell("cell:stress-cli", "stress", "cli", "benchmark:family@2"),
    ]),
  );
  assert.deepEqual(guessedSupersede.coverage_map.delta_summary.superseded_items, []);
  assert.deepEqual(guessedSupersede.coverage_map.delta_summary.retired_invalid_items, []);

  const supersedeDelta = validateScorerDelta({
    schema_version: 1,
    delta_id: "delta:supersede",
    scorer_id: parent.scorer_id,
    parent_revision: parent.revision,
    delta_kind: "benchmark",
    operations: [
      {
        op: "supersede_benchmark",
        old_id: "benchmark:family@1",
        new_id: "benchmark:family@2",
        content_hash: HASH_D,
        evidence_refs: ["evidence:supersede"],
      },
    ],
    producer_scorer_run_id: "scorer-run-supersede",
    evidence_refs: ["evidence:supersede"],
  });
  const supersededCandidate = materializeScorerRevision(
    parent,
    supersedeDelta,
    coverageMap("coverage:superseded", parent.coverage_map.coverage_map_id, [
      cell("cell:superseded", "stress", "cli", "benchmark:family@2"),
    ]),
  );
  assert.deepEqual(supersededCandidate.coverage_map.delta_summary.superseded_items, [
    "benchmark:family@1",
  ]);
  assert.equal(
    supersededCandidate.benchmark_items.find((item) => item.benchmark_id === "benchmark:family@1")
      ?.status,
    "superseded",
  );
  assert.deepEqual(
    supersededCandidate.benchmark_items.find((item) => item.benchmark_id === "benchmark:family@1")
      ?.evidence_refs,
    ["evidence:cell:basic-cli", "evidence:supersede"],
  );

  const retiredParent = parentRevision();
  const retireDelta = validateScorerDelta({
    schema_version: 1,
    delta_id: "delta:retire",
    scorer_id: retiredParent.scorer_id,
    parent_revision: retiredParent.revision,
    delta_kind: "benchmark",
    operations: [
      {
        op: "retire_benchmark",
        benchmark_id: "benchmark:family@1",
        reason_evidence_refs: ["evidence:retire"],
      },
    ],
    producer_scorer_run_id: "scorer-run-retire",
    evidence_refs: ["evidence:retire"],
  });
  const retiredCandidate = materializeScorerRevision(
    retiredParent,
    retireDelta,
    coverageMap("coverage:retired", retiredParent.coverage_map.coverage_map_id, []),
  );
  assert.deepEqual(retiredCandidate.coverage_map.delta_summary.retired_invalid_items, [
    "benchmark:family@1",
  ]);
  assert.equal(
    retiredCandidate.benchmark_items.find((item) => item.benchmark_id === "benchmark:family@1")
      ?.status,
    "retired",
  );

  expectCode(
    () =>
      validateScorerDelta({
        schema_version: 1,
        delta_id: "delta:empty-rule-reason",
        scorer_id: parent.scorer_id,
        parent_revision: parent.revision,
        delta_kind: "scoring",
        operations: [
          {
            op: "delete_rule",
            rule_id: "rule:quality",
            reason_evidence_refs: [],
          },
        ],
        producer_scorer_run_id: "scorer-run-rules",
        evidence_refs: ["evidence:retire"],
      }),
    "INVALID_SCORER_DELTA",
  );
  const scoringDelta = validateScorerDelta({
    schema_version: 1,
    delta_id: "delta:rule-replacement",
    scorer_id: parent.scorer_id,
    parent_revision: parent.revision,
    delta_kind: "scoring",
    operations: [
      {
        op: "add_rule",
        rule_id: "rule:quality-v2",
        kind: "deterministic_rule",
        content_hash: HASH_C,
        supersedes_rule_id: "rule:quality",
      },
      {
        op: "delete_rule",
        rule_id: "rule:quality",
        reason_evidence_refs: ["evidence:retire"],
        replacement_rule_id: "rule:quality-v2",
      },
    ],
    producer_scorer_run_id: "scorer-run-rules",
    evidence_refs: ["evidence:retire"],
  });
  const scoringCandidate = materializeScorerRevision(
    parent,
    scoringDelta,
    coverageMap("coverage:rule-replacement", parent.coverage_map.coverage_map_id, [
      cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
    ]),
  );
  assert.deepEqual(
    scoringCandidate.scoring_rules.find((rule) => rule.rule_id === "rule:quality"),
    {
      rule_id: "rule:quality",
      kind: "deterministic_rule",
      content_hash: HASH_B,
      active: false,
      deleted_in_revision: scoringDelta.delta_id,
    },
  );
  assert.deepEqual(
    scoringCandidate.scoring_rules.find((rule) => rule.rule_id === "rule:quality-v2"),
    {
      rule_id: "rule:quality-v2",
      kind: "deterministic_rule",
      content_hash: HASH_C,
      active: true,
      deleted_in_revision: null,
      supersedes_rule_id: "rule:quality",
    },
  );
  expectCode(
    () =>
      materializeScorerRevision(
        parent,
        scorerDelta(parent, [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:missing",
            content_hash: HASH_C,
            evidence_refs: ["evidence:missing"],
          },
        ]),
        coverageMap("coverage:bad-ref", parent.coverage_map.coverage_map_id, [
          cell("cell:bad", "stress", "cli", "benchmark:not-in-revision"),
        ]),
      ),
    "COVERAGE_CELL_REMOVED",
  );
  expectCode(
    () =>
      materializeScorerRevision(
        parent,
        scorerDelta(parent, [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:unknown-ref",
            content_hash: HASH_C,
            evidence_refs: ["evidence:missing"],
          },
        ]),
        coverageMap("coverage:unknown-item", parent.coverage_map.coverage_map_id, [
          cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
          cell("cell:unknown", "stress", "cli", "benchmark:does-not-exist"),
        ]),
      ),
    "SCORER_ITEM_NOT_FOUND",
  );
  expectCode(
    () =>
      materializeScorerRevision(
        parent,
        scorerDelta(parent, [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:unreferenced",
            content_hash: HASH_C,
            evidence_refs: ["evidence:new"],
          },
        ]),
        coverageMap("coverage:unreferenced", parent.coverage_map.coverage_map_id, [
          cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
        ]),
      ),
    "SCORER_ITEM_UNREFERENCED",
  );
});

test("coverage 只接受合法坐标和真实 active benchmark，ordered_values 可以独立声明", () => {
  const map = validateCoverageMap(coverageMap("coverage:ordered-only", null, []));
  assert.deepEqual(
    map.dimensions.find((dimension) => dimension.dimension_id === "difficulty"),
    {
      dimension_id: "difficulty",
      source: "scorer_discovered",
      values: ["basic", "extreme", "stress"],
      ordered_values: ["basic", "stress", "extreme"],
    },
  );
  expectCode(
    () =>
      validateCoverageMap(
        coverageMap("coverage:bad-coordinate", null, [cell("cell:bad", "unknown", "cli", "bench")]),
      ),
    "INVALID_COVERAGE_MAP",
  );
  expectCode(
    () =>
      materializeScorerRevision(
        parentRevision(),
        scorerDelta(parentRevision(), [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:unused",
            content_hash: HASH_C,
            evidence_refs: ["evidence:cell:stress-cli"],
          },
        ]),
        coverageMap("coverage:unknown-item", "coverage:parent", [
          cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
          cell("cell:unknown", "stress", "cli", "benchmark:does-not-exist"),
        ]),
      ),
    "SCORER_ITEM_NOT_FOUND",
  );
  const parent = parentRevision();
  const changedEvidence = coverageMap(
    "coverage:changed-evidence",
    parent.coverage_map.coverage_map_id,
    [
      {
        ...cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
        evidence_refs: ["evidence:replacement"],
      },
    ],
  );
  expectCode(
    () =>
      materializeScorerRevision(
        parent,
        scorerDelta(parent, [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:unused-evidence",
            content_hash: HASH_C,
            evidence_refs: ["evidence:new"],
          },
        ]),
        changedEvidence,
      ),
    "COVERAGE_CELL_MUTATION",
  );
  const removedDimension = coverageMap(
    "coverage:removed-dimension",
    parent.coverage_map.coverage_map_id,
    [cell("cell:basic-cli", "basic", "cli", "benchmark:family@1")],
  );
  (removedDimension.dimensions as Array<Record<string, unknown>>).splice(1, 1);
  const removedCell = (removedDimension.coverage_cells as Array<Record<string, unknown>>)[0]!;
  const removedCoordinates = removedCell.coordinates as Record<string, unknown>;
  delete removedCoordinates.surface;
  expectCode(
    () =>
      materializeScorerRevision(
        parent,
        scorerDelta(parent, [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:dimension-check",
            content_hash: HASH_C,
            evidence_refs: ["evidence:new"],
          },
        ]),
        removedDimension,
      ),
    "COVERAGE_DIMENSION_REMOVED",
  );
  const removedValue = coverageMap("coverage:removed-value", parent.coverage_map.coverage_map_id, [
    cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
  ]);
  const removedValueDimension = (removedValue.dimensions as Array<Record<string, unknown>>)[0]!;
  (removedValueDimension.ordered_values as string[]).splice(1, 1);
  expectCode(
    () =>
      materializeScorerRevision(
        parent,
        scorerDelta(parent, [
          {
            op: "add_benchmark_item",
            benchmark_id: "benchmark:value-check",
            content_hash: HASH_C,
            evidence_refs: ["evidence:new"],
          },
        ]),
        removedValue,
      ),
    "COVERAGE_VALUE_REMOVED",
  );

  const additiveDimension = coverageMap(
    "coverage:additive-dimension",
    parent.coverage_map.coverage_map_id,
    [
      {
        ...cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
        coordinates: { difficulty: "basic", surface: "cli", runtime: "local" },
      },
      {
        ...cell("cell:new-runtime", "stress", "cli", "benchmark:dimension-check"),
        coordinates: { difficulty: "stress", surface: "cli", runtime: "local" },
      },
    ],
  );
  (additiveDimension.dimensions as Array<Record<string, unknown>>).push({
    dimension_id: "runtime",
    source: "scorer_discovered",
    values: ["local"],
    ordered_values: [],
  });
  const additiveRevision = materializeScorerRevision(
    parent,
    scorerDelta(parent, [
      {
        op: "add_benchmark_item",
        benchmark_id: "benchmark:dimension-check",
        content_hash: HASH_C,
        evidence_refs: ["evidence:new"],
      },
    ]),
    additiveDimension,
  );
  assert.equal(additiveRevision.coverage_map.dimensions.length, 3);
  assert.deepEqual(additiveRevision.coverage_map.coverage_cells[0]?.benchmark_item_refs, [
    "benchmark:family@1",
  ]);
});

test("shared probe 哈希完整 evaluation item 和冻结 seed，并记录真实来源", () => {
  const parent = parentRevision();
  const delta = scorerDelta(parent, [
    {
      op: "add_benchmark_item",
      benchmark_id: "benchmark:new@1",
      content_hash: HASH_C,
      evidence_refs: ["evidence:new"],
    },
  ]);
  const candidate = materializeScorerRevision(
    parent,
    delta,
    coverageMap("coverage:new", parent.coverage_map.coverage_map_id, [
      cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
      cell("cell:new", "stress", "cli", "benchmark:new@1"),
    ]),
  );
  const calls: Array<{ caseId: string; revision: string }> = [];
  const materialize = (caseId: string, revision: string) => {
    calls.push({ caseId, revision });
    return {
      item_id: caseId,
      input: { query: caseId === "benchmark:family@1" ? "A" : "new" },
      contract: "eval@1",
      source: revision,
    };
  };
  const seed = { seed: 17, frozen: true };
  const first = materializeSharedProbe(parent, candidate, seed, materialize);
  assert.deepEqual(calls, [
    { caseId: "benchmark:family@1", revision: parent.revision },
    { caseId: "benchmark:new@1", revision: candidate.revision },
  ]);
  assert.deepEqual(first.case_source_revisions, {
    "benchmark:family@1": parent.revision,
    "benchmark:new@1": candidate.revision,
  });
  assert.deepEqual(first.source_revisions["benchmark:family@1"], [
    parent.revision,
    candidate.revision,
  ]);

  const changed = materializeSharedProbe(parent, candidate, seed, (caseId, revision) => ({
    item_id: caseId,
    input: { query: caseId === "benchmark:family@1" ? "B" : "new" },
    contract: "eval@1",
    source: revision,
  }));
  assert.notEqual(first.manifest_sha256, changed.manifest_sha256);
  assert.notEqual(
    first.item_hashes["benchmark:family@1"],
    changed.item_hashes["benchmark:family@1"],
  );

  expectCode(
    () =>
      materializeSharedProbe(parent, candidate, seed, (caseId, revision) => {
        if (caseId === "benchmark:new@1")
          throw new Error("cannot materialize frozen workflow case");
        return {
          item_id: caseId,
          input: { query: caseId },
          contract: "eval@1",
          source: revision,
        };
      }),
    "SCORER_CANDIDATE_INVALID",
  );
  expectCode(
    () =>
      validateEvaluationItem({
        item_id: "case:bad",
        input: { dashboard: {} },
        contract: "eval@1",
        source: "scorer:parent",
      }),
    "EVALUATION_SCOPE_VIOLATION",
  );
});

test("comparison 只使用预冻结输入，父结果落盘后崩溃可从断点继续且不重跑父版本", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const sharedManifestPath = path.join(
      root,
      ".aris",
      "runs",
      fixture.input.scorer_run_id,
      "case-manifests",
      "shared-probe.json",
    );
    const frozenSharedManifest = fs.readFileSync(sharedManifestPath);
    fs.rmSync(sharedManifestPath);
    let lateMaterializerCalled = false;
    expectCode(
      () =>
        runScorerComparison({
          ...fixture.input,
          materialize: (caseId, revision) => {
            lateMaterializerCalled = true;
            return {
              item_id: caseId,
              input: { late: true },
              contract: "eval@1",
              source: revision,
            };
          },
        }),
      "SCORER_INPUTS_NOT_FROZEN",
    );
    assert.equal(lateMaterializerCalled, false);
    fs.writeFileSync(sharedManifestPath, frozenSharedManifest);
    const order: string[] = [];
    let candidateAttempt = 0;
    const firstAttempt: RunScorerComparisonInput = {
      ...fixture.input,
      evaluate_parent: (request) => {
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.isFrozen(request.evaluation_item), true);
        assert.equal(Object.isFrozen(request.scorer_revision), true);
        assert.equal(Object.isFrozen(request.scorer_revision.benchmark_items), true);
        assert.equal(request.scorer_revision.revision, fixture.parent.revision);
        assert.equal(request.judge_binding_id, "judge:a1");
        order.push("parent:" + request.evaluation_item.item_id);
        return {
          item_id: request.evaluation_item.item_id,
          score: 1,
          labels: [],
          output_sha256: HASH_A,
        };
      },
      evaluate_candidate: (request) => {
        candidateAttempt += 1;
        assert.equal(Object.isFrozen(request.scorer_revision), true);
        assert.equal(request.scorer_revision.revision, fixture.candidate.revision);
        order.push("candidate:" + request.evaluation_item.item_id);
        if (candidateAttempt === 1) throw new Error("simulated crash");
        return {
          item_id: request.evaluation_item.item_id,
          score: 2,
          labels: [],
          output_sha256: HASH_B,
        };
      },
    };
    assert.throws(() => runScorerComparison(firstAttempt), /simulated crash/);
    const parentResultPath = path.join(
      root,
      ".aris",
      "runs",
      "scorer-run-a1",
      "parent-results.json",
    );
    assert.equal(fs.existsSync(parentResultPath), true);
    const parentCallsAfterCrash = order.filter((entry) => entry.startsWith("parent:")).length;
    const savedParentResults = fs.readFileSync(parentResultPath);
    fs.rmSync(parentResultPath);
    let sealedParentWasRecomputed = false;
    expectCode(
      () =>
        runScorerComparison({
          ...firstAttempt,
          evaluate_parent: () => {
            sealedParentWasRecomputed = true;
            return {
              item_id: "benchmark:family@1",
              score: 1,
              labels: [],
              output_sha256: HASH_A,
            };
          },
        }),
      "SCORER_RESULTS_INCOMPLETE",
    );
    assert.equal(sealedParentWasRecomputed, false);
    fs.writeFileSync(parentResultPath, savedParentResults, "utf8");
    const result = runScorerComparison({
      ...firstAttempt,
      evaluate_candidate: (request) => {
        order.push("candidate-retry:" + request.evaluation_item.item_id);
        return {
          item_id: request.evaluation_item.item_id,
          score: 2,
          labels: [],
          output_sha256: HASH_B,
        };
      },
    });
    assert.equal(
      order.filter((entry) => entry.startsWith("parent:")).length,
      parentCallsAfterCrash,
    );
    assert.equal(
      order.findIndex((entry) => entry.startsWith("parent:")) <
        order.findIndex((entry) => entry.startsWith("candidate:")),
      true,
    );
    assert.deepEqual(result.execution_order, ["parent", "candidate"]);
    assert.equal(
      fs.existsSync(path.join(root, ".aris", "runs", "scorer-run-a1", "comparison.json")),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(root, ".aris", "runs", "scorer-run-a1", "case-manifests", "parent.json"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(root, ".aris", "runs", "scorer-run-a1", "case-manifests", "candidate.json"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(root, ".aris", "runs", "scorer-run-a1", "case-manifests", "shared-probe.json"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(root, ".aris", "runs", "scorer-run-a1", "caller-chosen.lock")),
      false,
    );
    assert.equal(fs.existsSync(path.join(root, ".aris", "testers")), false);

    const frozenItemsPath = path.join(
      root,
      ".aris",
      "runs",
      "scorer-run-a1",
      "shared-probe-inputs.json",
    );
    const originalFrozenItems = fs.readFileSync(frozenItemsPath, "utf8");
    const tamperedFrozenItems = JSON.parse(originalFrozenItems) as {
      items: Array<{ input: unknown }>;
    };
    tamperedFrozenItems.items[0]!.input = { value: "tampered-after-freeze" };
    fs.writeFileSync(frozenItemsPath, JSON.stringify(tamperedFrozenItems, null, 2) + "\n", "utf8");
    expectCode(() => runScorerComparison(firstAttempt), "SCORER_INPUT_CONFLICT");
    fs.writeFileSync(frozenItemsPath, originalFrozenItems, "utf8");
  } finally {
    cleanup(root);
  }
});

test("comparison 身份、省略字段、晚到旧实验和缺 wave 定义都不能绕过冻结计划", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const scorerMarkerPath = path.join(
      root,
      ".aris",
      "scorers",
      fixture.parent.scorer_id,
      "active-run.json",
    );
    const scorerMarker = fs.readFileSync(scorerMarkerPath);
    fs.rmSync(scorerMarkerPath);
    expectCode(() => runScorerComparison(fixture.input), "SCORER_WAVE_NOT_FOUND");
    fs.writeFileSync(scorerMarkerPath, scorerMarker, "utf8");
    const deltaPath = path.join(
      root,
      ".aris",
      "scorers",
      fixture.parent.scorer_id,
      "deltas",
      fixture.delta.delta_id + ".json",
    );
    const originalDelta = fs.readFileSync(deltaPath, "utf8");
    const foreignDelta = JSON.parse(originalDelta) as Record<string, unknown>;
    foreignDelta.producer_scorer_run_id = "scorer-run-foreign";
    fs.writeFileSync(deltaPath, JSON.stringify(foreignDelta, null, 2) + "\n", "utf8");
    expectCode(() => recoverScorerRun(root, fixture.input.scorer_run_id), "IDENTITY_MISMATCH");
    fs.writeFileSync(deltaPath, originalDelta, "utf8");
    const successful = runScorerComparison(fixture.input);
    assert.equal(successful.parent_revision, fixture.parent.revision);
    expectCode(
      () => runScorerComparison({ ...fixture.input, candidate: fixture.parent }),
      "SCORER_PARENT_MISMATCH",
    );
    const changedFreezeValues = [
      { seed_manifest: { frozen: true, seed: 18 } },
      { judge_binding_id: "judge:other" },
      { model_assignment_sha256: HASH_D },
      { input_snapshot_sha256: HASH_D },
      { representative_artifact_id: "artifact:other@1" },
      { representative_artifact_sha256: HASH_D },
    ];
    for (const change of changedFreezeValues) {
      expectCode(
        () =>
          runScorerComparison({ ...fixture.input, freeze: { ...fixture.input.freeze, ...change } }),
        "SCORER_INPUT_CONFLICT",
      );
    }
    for (const field of ["project_root", "workflow_id", "scorer_id", "scorer_run_id"]) {
      const omittedIdentity: Record<string, unknown> = { ...fixture.input };
      delete omittedIdentity[field];
      expectCode(
        () => Reflect.apply(runScorerComparison, undefined, [omittedIdentity]),
        "IDENTITY_MISMATCH",
      );
    }
    const registrationPath = path.join(
      root,
      ".aris",
      "runs",
      "outer-a1",
      "cycles",
      "1",
      "scorer-wave.json",
    );
    fs.rmSync(registrationPath);
    expectCode(() => recoverScorerRun(root, fixture.input.scorer_run_id), "SCORER_WAVE_NOT_FOUND");
    expectCode(() => runScorerComparison(fixture.input), "SCORER_WAVE_NOT_FOUND");

    const missingWaveRoot = tempDir();
    try {
      createRootRun({
        project_root: missingWaveRoot,
        run_id: "outer-a1",
        
        
        
        charter_sha256: HASH_A,
        input_snapshot_sha256: HASH_B,
        execution_plan_sha256: HASH_C,
        code_baseline_sha256: HASH_A,
        policy_revision: "policy:a1-scorer",
      });
      createChildContract(missingWaveRoot, "outer-a1", "scorer-run-a1", "scorer");
      const parent = parentRevision();
      const delta = scorerDelta(parent, [
        {
          op: "add_benchmark_item",
          benchmark_id: "benchmark:new@1",
          content_hash: HASH_C,
          evidence_refs: ["evidence:new"],
        },
      ]);
      const candidate = materializeScorerRevision(
        parent,
        delta,
        coverageMap("coverage:new", parent.coverage_map.coverage_map_id, [
          cell("cell:basic-cli", "basic", "cli", "benchmark:family@1"),
          cell("cell:new", "stress", "cli", "benchmark:new@1"),
        ]),
      );
      saveImmutableScorerDelta(missingWaveRoot, delta);
      saveImmutableScorerRevision(missingWaveRoot, parent);
      saveImmutableScorerRevision(missingWaveRoot, candidate);
      writeJson(missingWaveRoot, ".aris/workflows/workflow:a1/definition.json", {
        schema_version: 1,
        workflow_id: "workflow:a1",
        validation_policy: { scorer_id: parent.scorer_id },
        scorers: [{ id: parent.scorer_id }],
        scorer_wave_policy: {
          exclusive: true,
          max_candidates: 1,
          experiment_parallelism: 1,
          execution_order: "baseline_then_candidate",
          blocks_other_wave_kinds: true,
        },
      });
      writeJson(missingWaveRoot, ".aris/workflows/workflow:a1/active-scorer.json", {
        schema_version: 1,
        workflow_id: "workflow:a1",
        scorer_id: parent.scorer_id,
        revision: parent.revision,
      });
      expectCode(
        () =>
          startScorerRun({
            project_root: missingWaveRoot,
            workflow_id: "workflow:a1",
            scorer_run_id: "scorer-run-a1",
            scorer_id: parent.scorer_id,
            outer_run_id: "outer-a1",
            outer_iteration: 1,
            wave_id: "wave:scorer",
            generation: 1,
            parent_revision: parent.revision,
            candidate_revision: candidate.revision,
            delta_id: delta.delta_id,
          }),
        "SCORER_WAVE_NOT_FOUND",
      );
    } finally {
      cleanup(missingWaveRoot);
    }
  } finally {
    cleanup(root);
  }
});

test("scorer review 只接受完整存盘回执，激活使用父版本 CAS 且幂等重试会修复标记", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const comparison = runScorerComparison(fixture.input);
    const receipt = submitScorerReview(fixture, comparison.shared_probe_manifest.manifest_sha256);
    const activeWavePath = path.join(root, ".aris", "active-wave.json");
    const originalActiveWave = fs.readFileSync(activeWavePath, "utf8");
    expectCode(() => assertWaveKindExclusive(root, "scorer"), "IDENTITY_MISMATCH");
    fs.rmSync(activeWavePath);
    expectCode(
      () => recordScorerReview(root, fixture.input.scorer_run_id, receipt),
      "SCORER_WAVE_NOT_FOUND",
    );
    fs.writeFileSync(activeWavePath, originalActiveWave, "utf8");
    const evidencePath = path.join(
      root,
      ".aris",
      "runs",
      fixture.input.scorer_run_id,
      "workers",
      "evidence-worker:a1",
      "outputs",
      "review-evidence.json",
    );
    const originalEvidence = fs.readFileSync(evidencePath);
    fs.writeFileSync(evidencePath, "tampered evidence\n", "utf8");
    expectCode(
      () => recordScorerReview(root, fixture.input.scorer_run_id, receipt),
      "EVIDENCE_HASH_MISMATCH",
    );
    fs.writeFileSync(evidencePath, originalEvidence);

    const commandPath = reviewCommandIndexPath(root, receipt.command_id);
    const originalIndex = fs.readFileSync(commandPath, "utf8");
    const tamperedIndex = JSON.parse(originalIndex) as Record<string, unknown>;
    tamperedIndex.receipt_sha256 = HASH_C;
    fs.writeFileSync(commandPath, JSON.stringify(tamperedIndex, null, 2) + "\n", "utf8");
    expectCode(() => readStoredReviewReceipt(root, receipt), "REVIEW_RECEIPT_CONFLICT");
    fs.writeFileSync(commandPath, originalIndex, "utf8");

    const comparisonPath = path.join(
      root,
      ".aris",
      "runs",
      fixture.input.scorer_run_id,
      "comparison.json",
    );
    const originalComparison = fs.readFileSync(comparisonPath);
    fs.rmSync(comparisonPath);
    expectCode(
      () => recordScorerReview(root, fixture.input.scorer_run_id, receipt),
      "SCORER_RESULTS_INCOMPLETE",
    );
    fs.writeFileSync(comparisonPath, originalComparison, "utf8");

    const reviewed = recordScorerReview(root, fixture.input.scorer_run_id, receipt);
    assert.equal(reviewed.status, "reviewed");
    const sharedInputsPath = path.join(
      root,
      ".aris",
      "runs",
      fixture.input.scorer_run_id,
      "shared-probe-inputs.json",
    );
    const frozenSharedInputs = fs.readFileSync(sharedInputsPath);
    fs.rmSync(sharedInputsPath);
    expectCode(
      () => activateScorerRevision(root, fixture.input.scorer_run_id, receipt),
      "SCORER_INPUTS_NOT_FROZEN",
    );
    fs.writeFileSync(sharedInputsPath, frozenSharedInputs);
    const activePath = path.join(root, ".aris", "workflows", "workflow:a1", "active-scorer.json");
    const originalActive = fs.readFileSync(activePath, "utf8");
    writeJson(root, ".aris/workflows/workflow:a1/active-scorer.json", {
      schema_version: 1,
      workflow_id: "workflow:a1",
      scorer_id: fixture.parent.scorer_id,
      revision: "scorer:late-newer",
      scorer_run_id: "scorer-run-late-newer",
    });
    expectCode(
      () => activateScorerRevision(root, fixture.input.scorer_run_id, receipt),
      "SCORER_ACTIVE_CONFLICT",
    );
    assert.equal(
      (JSON.parse(fs.readFileSync(activePath, "utf8")) as { revision: string }).revision,
      "scorer:late-newer",
    );
    fs.writeFileSync(activePath, originalActive, "utf8");

    const activated = activateScorerRevision(root, fixture.input.scorer_run_id, receipt);
    assert.equal(activated.status, "activated");
    const activatedWave = fs.readFileSync(activeWavePath, "utf8");
    writeJson(root, ".aris/active-wave.json", {
      schema_version: 1,
      wave_kind: "scorer",
      workflow_id: "workflow:a1",
      scorer_id: fixture.parent.scorer_id,
      scorer_run_id: "scorer-run-late",
      run_id: "scorer-run-late",
      status: "activated",
    });
    expectCode(
      () => activateScorerRevision(root, fixture.input.scorer_run_id, receipt),
      "SCORER_WAVE_EXCLUSIVE",
    );
    fs.writeFileSync(activeWavePath, activatedWave, "utf8");
    fs.rmSync(scorerRunDashboardPath(root, fixture.input.scorer_run_id));
    fs.rmSync(path.join(root, ".aris", "active-wave.json"));
    fs.rmSync(path.join(root, ".aris", "scorers", fixture.parent.scorer_id, "active-run.json"));
    const retried = activateScorerRevision(root, fixture.input.scorer_run_id, receipt);
    assert.equal(retried.status, "activated");
    assert.equal(fs.existsSync(scorerRunDashboardPath(root, fixture.input.scorer_run_id)), true);
    assert.equal(fs.existsSync(path.join(root, ".aris", "active-wave.json")), true);
    assert.equal(
      (JSON.parse(fs.readFileSync(activePath, "utf8")) as { revision: string }).revision,
      fixture.candidate.revision,
    );
  } finally {
    cleanup(root);
  }
});

test("standalone wrapper 与 workflow scorer 状态隔离，不能替代核心入口", () => {
  const root = tempDir();
  const fixtureRoot = tempDir();
  try {
    const fixture = strictScorerFixture(fixtureRoot);
    const comparison = runStandaloneScorerComparison({
      parent: fixture.parent,
      candidate: fixture.candidate,
      freeze: fixture.input.freeze,
      lock_path: path.join(root, "standalone.lock"),
      materialize: fixture.input.materialize,
      evaluate_parent: fixture.input.evaluate_parent,
      evaluate_candidate: fixture.input.evaluate_candidate,
    });
    assert.equal(comparison.execution_order[0], "parent");
    assert.equal(fs.existsSync(path.join(root, ".aris", "workflows")), false);
  } finally {
    cleanup(root);
    cleanup(fixtureRoot);
  }
});

test("状态带 workflow_id，每次转换同步 dashboard，终态清理 marker 并允许普通 wave", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const registration = {
      project_root: root,
      workflow_id: "workflow:a1",
      scorer_id: fixture.parent.scorer_id,
      scorer_run_id: fixture.input.scorer_run_id,
      outer_run_id: "outer-a1",
      outer_iteration: 1,
      wave_id: "wave:scorer",
      parent_revision: fixture.parent.revision,
      candidate_revision: fixture.candidate.revision,
      delta_id: fixture.delta.delta_id,
    };
    assert.deepEqual(saveScorerWaveRegistration(registration), registration);
    expectCode(
      () => saveScorerWaveRegistration({ ...registration, candidate_revision: "scorer:other" }),
      "IMMUTABLE_CONFLICT",
    );
    const started = readScorerRunState(root, fixture.input.scorer_run_id);
    expectCode(
      () => transitionScorerState(root, started.scorer_run_id, "activated"),
      "SCORER_ACTIVATION_REQUIRED",
    );
    assert.equal(started.workflow_id, "workflow:a1");
    assert.equal(
      (
        JSON.parse(
          fs.readFileSync(scorerRunDashboardPath(root, started.scorer_run_id), "utf8"),
        ) as {
          workflow_id: string;
        }
      ).workflow_id,
      "workflow:a1",
    );
    const activeWavePath = path.join(root, ".aris", "active-wave.json");
    const originalActiveWave = fs.readFileSync(activeWavePath, "utf8");
    fs.rmSync(activeWavePath);
    expectCode(() => beginOrdinaryWave(root, "module", "outer-blocked"), "SCORER_WAVE_EXCLUSIVE");
    fs.writeFileSync(activeWavePath, originalActiveWave, "utf8");
    const statePath = scorerRunStatePath(root, started.scorer_run_id);
    const originalState = fs.readFileSync(statePath, "utf8");
    fs.rmSync(statePath);
    expectCode(
      () => beginOrdinaryWave(root, "module", "outer-orphan-marker"),
      "SCORER_WAVE_NOT_FOUND",
    );
    fs.writeFileSync(statePath, originalState, "utf8");
    transitionScorerState(root, started.scorer_run_id, "failed");
    const state = JSON.parse(
      fs.readFileSync(scorerRunStatePath(root, started.scorer_run_id), "utf8"),
    ) as { status: string; workflow_id: string };
    const dashboard = JSON.parse(
      fs.readFileSync(scorerRunDashboardPath(root, started.scorer_run_id), "utf8"),
    ) as { status: string; scorer_run_id: string; workflow_id: string };
    assert.equal(state.status, "failed");
    assert.equal(state.workflow_id, "workflow:a1");
    assert.equal(dashboard.status, "failed");
    assert.equal(dashboard.scorer_run_id, started.scorer_run_id);
    assert.equal(dashboard.workflow_id, "workflow:a1");
    beginOrdinaryWave(root, "module", "outer-after-failure");
  } finally {
    cleanup(root);
  }
});

test("scorer state lives inside its contract directory and ignores the old flat file", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const id = fixture.input.scorer_run_id;
    const statePath = scorerRunStatePath(root, id);
    assert.equal(statePath, path.join(root, ".aris", "runs", id, "scorer-state.json"));
    assert.equal(fs.existsSync(path.join(root, ".aris", "runs", id + ".json")), false);
    const state = readScorerRunState(root, id);
    writeJson(root, `.aris/runs/${id}.json`, { stale: true });
    assert.deepEqual(readScorerRunState(root, id), state);
    fs.unlinkSync(statePath);
    expectCode(() => readScorerRunState(root, id), "SCORER_RUN_NOT_FOUND");
  } finally { cleanup(root); }
});

test("scorer start/read/transition/experiment reject missing contracts without recreating them", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const id = fixture.input.scorer_run_id;
    const state = readScorerRunState(root, id);
    const startInput = { project_root: root, ...state };
    const statePath = scorerRunStatePath(root, id);
    const before = fs.readFileSync(statePath, "utf8");
    fs.unlinkSync(runJsonPath(root, id));
    for (const action of [
      () => startScorerRun(startInput),
      () => readScorerRunState(root, id),
      () => transitionScorerState(root, id, "rejected"),
      () => transitionScorerState(root, id, "activated"),
      () => scorerRunDashboardPath(root, id),
      () => runScorerComparison(fixture.input),
      () => submitScorerReview(fixture, HASH_D),
    ]) expectCode(action, "RUN_CONTRACT_NOT_FOUND");
    assert.equal(fs.existsSync(runJsonPath(root, id)), false);
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
    for (const invalid of ["bad:id", "bad@id", "bad id", "_leading", "x".repeat(129)]) {
      expectCode(() => readScorerRunState(root, invalid), "INVALID_RUN_ID");
      expectCode(() => startScorerRun({ ...startInput, scorer_run_id: invalid }), "INVALID_RUN_ID");
      expectCode(() => transitionScorerState(root, invalid, "rejected"), "INVALID_RUN_ID");
    }
  } finally { cleanup(root); }
});

test("durable scorer scan checks contracts and matches state ids to the owning directory", () => {
  const root = tempDir();
  try {
    const fixture = strictScorerFixture(root);
    const id = fixture.input.scorer_run_id;
    fs.unlinkSync(path.join(root, ".aris", "active-wave.json"));
    fs.mkdirSync(path.join(root, ".aris", "runs", "unrelated"));
    expectCode(() => assertWaveKindExclusive(root, "module"), "SCORER_WAVE_EXCLUSIVE");
    const statePath = scorerRunStatePath(root, id);
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, JSON.stringify({ ...raw, run_id: "different", scorer_run_id: "different" }));
    expectCode(() => assertWaveKindExclusive(root, "module"), "IDENTITY_MISMATCH");
    fs.writeFileSync(statePath, JSON.stringify(raw));
    fs.unlinkSync(runJsonPath(root, id));
    expectCode(() => assertWaveKindExclusive(root, "module"), "RUN_CONTRACT_NOT_FOUND");
    fs.renameSync(path.dirname(statePath), path.join(root, ".aris", "runs", "bad:id"));
    expectCode(() => assertWaveKindExclusive(root, "module"), "INVALID_RUN_ID");
  } finally { cleanup(root); }
});

let passed = 0;
for (const current of tests) {
  try {
    current.fn();
    passed += 1;
    console.log("ok - " + current.name);
  } catch (error: unknown) {
    console.error("not ok - " + current.name);
    throw error;
  }
}
console.log("A1 scorer tests passed: " + passed);
