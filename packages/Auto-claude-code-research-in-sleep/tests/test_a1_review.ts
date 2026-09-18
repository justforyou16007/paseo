import { createRootRun } from "../src/tools/run-contract.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createArtifactRegistry,
  crossCheckArtifactIdentity,
} from "../src/tools/artifact-registry.js";
import { workflowCycleWorkerDirectory } from "../src/tools/workflow-state.js";
import {
  createReviewAssignment,
  reviewAssignmentPath,
  reviewCommandIndexPath,
  submitReviewReceipt,
  type ReviewReceipt,
} from "../src/tools/review-submit.js";

/**
 * A child research run is accepted by its own auto-review-loop, so there is no
 * parent-side review of a child here any more. What this file covers is the one
 * review a parent still owns over a run's own evidence - the validation
 * comparison - and the two properties that make it worth having: the evidence a
 * reviewer ruled on cannot change afterwards, and a receipt that was written
 * once cannot be rewritten by a retry.
 */

const PACKAGE_ROOT = path.resolve(process.cwd());
const OUTER_RUN_ID = "outer-1";
const ITERATION = 1;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a1-review-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeText(filePath: string, value: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  return sha256(value);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

function makeOuterRun(root: string): void {
  createRootRun({
    project_root: root,
    run_id: OUTER_RUN_ID,
    input_snapshot_sha256: "c".repeat(64),
    code_baseline_sha256: "a".repeat(64),
    policy_revision: "policy:review-fixture",
  });
}

interface Evidence {
  workerId: string;
  receiptPath: string;
  outputPath: string;
  outputSha256: string;
}

/**
 * Write the worker slot a validation review reads its evidence out of. The
 * reviewer never takes the evidence from the caller: it resolves the producer's
 * slot, follows `primary_output` and hashes the file it finds, which is what
 * makes a later edit to that file detectable.
 */
function makeEvidence(root: string, workerId: string, outputName: string, value: unknown): Evidence {
  const workerRoot = path.join(
    workflowCycleWorkerDirectory(root, OUTER_RUN_ID, ITERATION),
    workerId,
  );
  const outputPath = path.join(workerRoot, "outputs", outputName);
  const outputSha256 = writeText(outputPath, `${JSON.stringify(value)}\n`);
  writeJson(path.join(workerRoot, "input-manifest.json"), {
    schema_version: 1,
    execution_id: workerId,
    run_id: OUTER_RUN_ID,
    worker: workerId,
    phase: "validation",
    iteration: ITERATION,
    inputs: { phase: "validation" },
    output_dir: path.relative(root, path.dirname(outputPath)),
  });
  const receiptPath = path.join(workerRoot, "receipt.json");
  writeJson(receiptPath, {
    run_id: OUTER_RUN_ID,
    worker: workerId,
    phase: "validation",
    iteration: ITERATION,
    status: "done",
    error: null,
    primary_output: outputName,
    primary_output_sha256: outputSha256,
    completed_at: "2026-09-07T00:00:00Z",
  });
  return { workerId, receiptPath, outputPath, outputSha256 };
}

function assignmentInput(
  root: string,
  reviewId: string,
  reviewer: string,
  producer: string,
  bundleId: string,
  generation = 1,
  evidencePath?: string,
): Parameters<typeof createReviewAssignment>[0] {
  return {
    actor: "review_scheduler",
    review_id: reviewId,
    project_root: root,
    outer_run_id: OUTER_RUN_ID,
    reviewed_run_id: OUTER_RUN_ID,
    reviewed_run_kind: "workflow",
    outer_iteration: ITERATION,
    wave_id: "wave-1",
    wave_kind: "module",
    review_stage: "validation",
    generation,
    subject: { validation_comparison_id: bundleId, candidate_ids: ["candidate:a"] },
    reviewer_worker_id: reviewer,
    evidence_producer_worker_id: producer,
    evidence_bundle_id: bundleId,
    ...(evidencePath === undefined ? {} : { evidence_path: evidencePath }),
  };
}

function reviewReceipt(
  evidenceSha256: string,
  reviewer: string,
  reviewId: string,
  bundleId: string,
  generation = 1,
): ReviewReceipt {
  return {
    schema_version: 1,
    review_id: reviewId,
    reviewed_run_id: OUTER_RUN_ID,
    reviewed_run_kind: "workflow",
    outer_iteration: ITERATION,
    wave_id: "wave-1",
    wave_kind: "module",
    review_stage: "validation",
    generation,
    subject: { validation_comparison_id: bundleId, candidate_ids: ["candidate:a"] },
    reviewer_worker_id: reviewer,
    evidence_bundle_id: bundleId,
    evidence_sha256: evidenceSha256,
    verdict: "approved",
    reason_codes: ["complete"],
    evidence_refs: ["opaque:evidence-1"],
    command_id: `review-submit:${reviewId}`,
  };
}

function submit(root: string, receipt: ReviewReceipt): ReturnType<typeof submitReviewReceipt> {
  return submitReviewReceipt({
    project_root: root,
    receipt,
    manifest_run_id: OUTER_RUN_ID,
    command_run_id: OUTER_RUN_ID,
  });
}

function testEvidenceIsFrozenAndOneReviewerPerGeneration(): void {
  const root = tempDir();
  try {
    makeOuterRun(root);
    const evidence = makeEvidence(root, "analyze-results", "evidence.json", { evidence: "stable" });

    // Only the scheduler hands out reviews, and it cannot hand one to the
    // worker that produced the evidence.
    expectCode(() => createReviewAssignment({ actor: "reviewer" } as never), "WRITE_SCOPE_FORBIDDEN");
    expectCode(
      () =>
        createReviewAssignment(
          assignmentInput(root, "review:self", "analyze-results", "analyze-results", "evidence:self"),
        ),
      "REVIEWER_NOT_INDEPENDENT",
    );

    const assignment = createReviewAssignment(
      assignmentInput(root, "review:b", "reviewer-1", "analyze-results", "evidence:b"),
    );
    assert.equal(assignment.evidence_sha256, evidence.outputSha256);
    const receipt = reviewReceipt(assignment.evidence_sha256, "reviewer-1", "review:b", "evidence:b");

    // A receipt cannot be submitted before the scheduler has opened the review.
    expectCode(
      () =>
        submit(
          root,
          reviewReceipt(evidence.outputSha256, "reviewer-1", "review:unopened", "evidence:unopened"),
        ),
      "REVIEW_ASSIGNMENT_NOT_FOUND",
    );

    // Editing the evidence after the assignment froze it is what the hash is
    // there to catch; the reviewer's verdict no longer describes the file.
    fs.appendFileSync(evidence.outputPath, "changed", "utf8");
    expectCode(() => submit(root, receipt), "EVIDENCE_HASH_MISMATCH");
    fs.writeFileSync(evidence.outputPath, `${JSON.stringify({ evidence: "stable" })}\n`, "utf8");
    assert.equal(submit(root, receipt).status, "appended");

    // One generation has one reviewer. Bringing in a second reviewer means
    // opening the next generation, not reassigning the current one.
    expectCode(
      () =>
        createReviewAssignment(
          assignmentInput(root, "review:c", "reviewer-2", "analyze-results", "evidence:c"),
        ),
      "SINGLE_REVIEWER_REQUIRED",
    );
    const generationTwo = createReviewAssignment(
      assignmentInput(root, "review:generation-2", "reviewer-2", "analyze-results", "evidence:c", 2),
    );
    assert.notEqual(generationTwo.assignment_id, assignment.assignment_id);

    expectCode(
      () => submit(root, { ...receipt, review_stage: "scorer_revision" } as ReviewReceipt),
      "REVIEW_TYPE_MISMATCH",
    );
    expectCode(
      () => submit(root, { ...receipt, dashboard_patch: {} } as unknown as ReviewReceipt),
      "UNKNOWN_FIELD",
    );
  } finally {
    cleanup(root);
  }
}

function testAssignmentIsFrozenAndSubmissionRecovers(): void {
  const root = tempDir();
  try {
    makeOuterRun(root);
    const evidence = makeEvidence(root, "analyze-results", "evidence.json", { evidence: "frozen" });
    const assignment = createReviewAssignment(
      assignmentInput(
        root,
        "review:recovery",
        "reviewer-1",
        "analyze-results",
        "evidence:recovery",
        1,
        path.relative(root, evidence.outputPath),
      ),
    );
    const receipt = reviewReceipt(
      assignment.evidence_sha256,
      "reviewer-1",
      "review:recovery",
      "evidence:recovery",
    );

    // The assignment on disk is the only assignment. Repointing its evidence
    // at a file outside the run is rejected rather than followed.
    const assignmentPath = reviewAssignmentPath(root, assignment);
    const originalAssignment = fs.readFileSync(assignmentPath, "utf8");
    writeJson(assignmentPath, { ...assignment, evidence_path: "outside/evidence.json" });
    expectCode(() => submit(root, receipt), "CORRUPT_REVIEW_ASSIGNMENT");
    fs.writeFileSync(assignmentPath, originalAssignment, "utf8");

    // The producer's own receipt has to agree with the file it points at.
    const originalExecutionReceipt = fs.readFileSync(evidence.receiptPath, "utf8");
    writeJson(evidence.receiptPath, {
      ...(JSON.parse(originalExecutionReceipt) as Record<string, unknown>),
      primary_output_sha256: "b".repeat(64),
    });
    expectCode(() => submit(root, receipt), "EVIDENCE_HASH_MISMATCH");
    fs.writeFileSync(evidence.receiptPath, originalExecutionReceipt, "utf8");

    const first = submit(root, receipt);
    assert.equal(first.status, "appended");

    // A second review id over the same frozen assignment is a different
    // review, and the assignment is not free to take it.
    expectCode(
      () =>
        submit(root, {
          ...receipt,
          review_id: "review:recovery-2",
          command_id: "review-submit:review:recovery-2",
        }),
      "IDENTITY_MISMATCH",
    );

    // Retries are idempotent from either side of the write: the receipt file
    // and the command index are each rebuilt from the other.
    fs.unlinkSync(first.receipt_path);
    assert.equal(submit(root, receipt).status, "skipped");
    assert.equal(fs.existsSync(first.receipt_path), true);

    fs.unlinkSync(reviewCommandIndexPath(root, receipt.command_id));
    assert.equal(submit(root, receipt).status, "skipped");
    assert.equal(fs.existsSync(reviewCommandIndexPath(root, receipt.command_id)), true);

    // An index naming a hash the receipt never had is a conflict, not
    // something to repair by overwriting the receipt.
    fs.unlinkSync(first.receipt_path);
    writeJson(reviewCommandIndexPath(root, receipt.command_id), {
      schema_version: 1,
      command_id: receipt.command_id,
      receipt_path: first.receipt_path,
      receipt_sha256: "c".repeat(64),
    });
    expectCode(() => submit(root, receipt), "REVIEW_RECEIPT_CONFLICT");
  } finally {
    cleanup(root);
  }
}

async function testArtifactRegistryConcurrency(): Promise<void> {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "outer-artifacts" });
    const registry = createArtifactRegistry(root, "outer-artifacts");
    const basePath = path.join(root, "artifacts", "base.bin");
    const baseHash = writeText(basePath, "base");
    registry.register({ schema_version: 1, artifact_id: "artifact:base", contract: "model@1", uri: "artifacts/base.bin", file_path: "artifacts/base.bin", sha256: baseHash, producer_module: "external", producer_version: "v1", input_artifact_ids: [], status: "sealed", generation: 0, source_type: "fixed_external" });
    expectCode(() => registry.register({ schema_version: 1, artifact_id: "artifact:bad", contract: "model@1", uri: "artifacts/bad.bin", file_path: "artifacts/bad.bin", sha256: "a".repeat(64), producer_module: "bad", producer_version: "v1", input_artifact_ids: ["artifact:missing"], status: "sealed", generation: 1, source_type: "fixed_external" }), "ARTIFACT_NOT_FOUND");
    const childSpecs = ["one", "two"].map((name) => {
      const filePath = path.join(root, "artifacts", `${name}.bin`);
      const fileHash = writeText(filePath, name);
      return { artifact_id: `artifact:${name}`, file_path: `artifacts/${name}.bin`, sha256: fileHash };
    });
    const children = childSpecs.map((spec) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { createArtifactRegistry } from './src/tools/artifact-registry.ts'; const v=JSON.parse(process.env.A1_CHILD_INPUT); createArtifactRegistry(v.root, 'outer-artifacts').register(v.reference);"], { cwd: PACKAGE_ROOT, env: { ...process.env, A1_CHILD_INPUT: JSON.stringify({ root, reference: { schema_version: 1, ...spec, contract: "model@1", uri: spec.file_path, producer_module: "module", producer_version: spec.artifact_id, input_artifact_ids: ["artifact:base"], status: "sealed", generation: 1, source_type: "fixed_external" } }) }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("close", (status) => status === 0 ? resolve() : reject(new Error(output)));
    }));
    await Promise.all(children);
    {
      assert.equal(registry.list().length, 3);
      assert.equal(registry.get("artifact:one").status, "sealed");
      const shortPath = path.join(root, "artifacts", "short.bin");
      const shortHash = writeText(shortPath, "short-write");
      const fsWithWriteSync = fs as unknown as {
        writeSync: (...args: any[]) => number;
      };
      const originalWriteSync = fsWithWriteSync.writeSync;
      let didShortWrite = false;
      fsWithWriteSync.writeSync = (...args: any[]) => {
        const [fd, data, offset, length, position] = args;
        if (
          !didShortWrite &&
          Buffer.isBuffer(data) &&
          data[offset] === "{".charCodeAt(0) &&
          typeof offset === "number" &&
          typeof length === "number" &&
          length > 1
        ) {
          didShortWrite = true;
          return originalWriteSync.call(
            fs,
            fd,
            data,
            offset,
            Math.max(1, Math.floor(length / 2)),
            position,
          );
        }
        return originalWriteSync.call(fs, ...args);
      };
      try {
        registry.register({
          schema_version: 1,
          artifact_id: "artifact:short-write",
          contract: "model@1",
          uri: "artifacts/short.bin",
          file_path: "artifacts/short.bin",
          sha256: shortHash,
          producer_module: "module",
          producer_version: "v-short",
          input_artifact_ids: [],
          status: "sealed",
          generation: 1,
          source_type: "fixed_external",
        });
      } finally {
        fsWithWriteSync.writeSync = originalWriteSync;
      }
      assert.equal(didShortWrite, true);
      assert.equal(registry.get("artifact:short-write").sha256, shortHash);
      fs.appendFileSync(registry.filePath, "{\"partial\":", "utf8");
      assert.equal(registry.list().length, 4);
      assert.equal(fs.readFileSync(registry.filePath, "utf8").endsWith("\n"), true);
      const finalPath = path.join(root, "artifacts", "final.bin");
      const finalHash = writeText(finalPath, "final");
      registry.register({ schema_version: 1, artifact_id: "artifact:final", contract: "model@1", uri: "artifacts/final.bin", file_path: "artifacts/final.bin", sha256: finalHash, producer_module: "module", producer_version: "v2", input_artifact_ids: ["artifact:one"], status: "sealed", generation: 2, source_type: "fixed_external" });
      assert.equal(registry.isDescendant("artifact:final", "artifact:base"), true);
      expectCode(() => registry.assertNoSelfEvaluation(["artifact:one"], ["artifact:final"]), "JUDGE_LAG_VIOLATION");
      expectCode(
        () =>
          registry.register({
            schema_version: 1,
            artifact_id: "artifact:unknown-field",
            contract: "model@1",
            uri: "artifacts/final.bin",
            file_path: "artifacts/final.bin",
            sha256: finalHash,
            producer_module: "module",
            producer_version: "v2",
            input_artifact_ids: [],
            status: "sealed",
            generation: 2,
            source_type: "fixed_external",
            unexpected: true,
          }),
        "UNKNOWN_FIELD",
      );
      expectCode(
        () =>
          registry.register({
            schema_version: 1,
            artifact_id: "artifact:path-escape",
            contract: "model@1",
            uri: "../outside.bin",
            file_path: "../outside.bin",
            sha256: finalHash,
            producer_module: "module",
            producer_version: "v2",
            input_artifact_ids: [],
            status: "sealed",
            generation: 2,
            source_type: "fixed_external",
          }),
        "PATH_ESCAPE",
      );
      fs.writeFileSync(basePath, "changed", "utf8");
      expectCode(() => registry.list(), "ARTIFACT_HASH_MISMATCH");
      expectCode(() => crossCheckArtifactIdentity({ artifact_id: "artifact:one", directory_artifact_id: "artifact:one", manifest_artifact_id: "artifact:two", command_artifact_id: "artifact:one" }), "IDENTITY_MISMATCH");
    }
  } finally {
    cleanup(root);
  }
}

function testArtifactRegistryTailRecovery(): void {
  const root = tempDir();
  try {
    createRootRun({ project_root: root, run_id: "artifact-tail-recovery" });
    const registry = createArtifactRegistry(root, "artifact-tail-recovery");
    const originalPath = path.join(root, "artifacts", "original.bin");
    const originalHash = writeText(originalPath, "original");
    const originalReference = {
      schema_version: 1,
      artifact_id: "artifact:tail",
      contract: "model@1",
      uri: "artifacts/original.bin",
      file_path: "artifacts/original.bin",
      sha256: originalHash,
      producer_module: "external",
      producer_version: "v1",
      input_artifact_ids: [],
      status: "sealed" as const,
      generation: 0,
      source_type: "fixed_external" as const,
    };
    const registered = registry.register(originalReference);
    const completeBytes = fs.readFileSync(registry.filePath);
    assert.equal(completeBytes.at(-1), 0x0a);

    fs.writeFileSync(registry.filePath, completeBytes.subarray(0, completeBytes.length - 1));
    const recovered = registry.register(originalReference);
    assert.equal(recovered.registered_at, registered.registered_at);
    assert.equal(registry.list().length, 1);
    assert.equal(fs.readFileSync(registry.filePath).at(-1), 0x0a);

    const replacementPath = path.join(root, "artifacts", "replacement.bin");
    const replacementHash = writeText(replacementPath, "replacement");
    const conflictingReference = {
      ...originalReference,
      uri: "artifacts/replacement.bin",
      file_path: "artifacts/replacement.bin",
      sha256: replacementHash,
    };
    const pendingBytes = fs.readFileSync(registry.filePath);
    fs.writeFileSync(registry.filePath, pendingBytes.subarray(0, pendingBytes.length - 1));
    expectCode(() => registry.register(conflictingReference), "ARTIFACT_CONFLICT");
    assert.equal(registry.get("artifact:tail").sha256, originalHash);
    assert.equal(fs.readFileSync(registry.filePath).at(-1), 0x0a);

    const beforeShortTail = fs.readFileSync(registry.filePath);
    fs.appendFileSync(registry.filePath, "{\"partial\":", "utf8");
    assert.equal(registry.list().length, 1);
    assert.deepEqual(fs.readFileSync(registry.filePath), beforeShortTail);
  } finally {
    cleanup(root);
  }
}

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
  {
    name: "review evidence is frozen and one generation has one reviewer",
    fn: testEvidenceIsFrozenAndOneReviewerPerGeneration,
  },
  {
    name: "review assignments stay scheduler-owned and receipt/index retries recover",
    fn: testAssignmentIsFrozenAndSubmissionRecovers,
  },
  {
    name: "artifact registry recovers complete tails without rebinding ids",
    fn: testArtifactRegistryTailRecovery,
  },
  {
    name: "artifact registry serializes complete snapshots and preserves lineage",
    fn: testArtifactRegistryConcurrency,
  },
];

for (const test of tests) {
  await test.fn();
  console.log(`ok - ${test.name}`);
}
console.log(`A1 review tests passed: ${tests.length}`);
