import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChildContract } from "./helpers/child-contract.js";
import { createRootRun, readRun } from "../src/tools/run-contract.js";
import { acquireLineageHold, lineageLockPath, releaseLineageHold } from "../src/tools/lineage-lock.js";
import { buildResultPackageForRun, saveResultPackage } from "../src/tools/result-package.js";
import { saveResultReview } from "../src/tools/result-review.js";

const ROOT = "lineage-root";
const CHILD_A = "lineage-child-a";
const CHILD_B = "lineage-child-b";
const GRANDCHILD = "lineage-grandchild";

function expectLocked(action: () => unknown): string {
  try {
    action();
  } catch (error: unknown) {
    assert.equal((error as { code?: string }).code, "LINEAGE_LOCKED");
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected LINEAGE_LOCKED");
}

/**
 * A root with two children at different positions and one grandchild under
 * the first child. Every run has a real contract, so the lock reads each
 * scope from run.json the way production does.
 */
function lineageFixture(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aris-lineage-lock-"));
  createRootRun({
    project_root: projectRoot,
    run_id: ROOT,
    input_snapshot_sha256: "c".repeat(64),
    code_baseline_sha256: "a".repeat(64),
    policy_revision: "policy:lineage",
  });
  createChildContract(projectRoot, ROOT, CHILD_A, "position-a");
  createChildContract(projectRoot, ROOT, CHILD_B, "position-b");
  createChildContract(projectRoot, CHILD_A, GRANDCHILD, "position-a-inner");
  return projectRoot;
}

function publishResult(projectRoot: string, runId: string): void {
  const contract = readRun(projectRoot, runId);
  const input = {
    run_id: runId,
    parent_run_id: contract.parent_run_id,
    scope_path: contract.scope_path,
    status: "succeeded" as const,
    input_snapshot_sha256: "c".repeat(64),
    output_hashes: { "artifact.bin": "d".repeat(64) },
  };
  const built = buildResultPackageForRun(projectRoot, runId, input);
  const reviewId = `review:${runId}`;
  saveResultReview(projectRoot, {
    schema_version: 1,
    review_id: reviewId,
    run_id: runId,
    reviewer_worker_id: "reviewer-lineage",
    package_sha256: built.package.package_sha256,
    verdict: "approved",
    evidence_refs: [],
    reason_codes: [],
  });
  saveResultPackage(projectRoot, runId, input, { review_id: reviewId });
}

test("a structure hold and an iteration hold exclude each other across the lineage, in both directions", () => {
  const projectRoot = lineageFixture();
  try {
    const child = readRun(projectRoot, CHILD_A);
    const grandchild = readRun(projectRoot, GRANDCHILD);

    // Descendant iterating: the ancestor cannot restructure, however deep the descendant is.
    acquireLineageHold(projectRoot, GRANDCHILD, "iteration");
    const message = expectLocked(() => acquireLineageHold(projectRoot, ROOT, "structure"));
    expectLocked(() => acquireLineageHold(projectRoot, CHILD_A, "structure"));
    // The refusal names nobody: not the holder, not its scope, not its depth.
    for (const secret of [GRANDCHILD, grandchild.scope_path, child.scope_path, "depth", String(grandchild.depth)])
      assert.equal(message.includes(secret), false, `LINEAGE_LOCKED message leaks ${secret}`);
    releaseLineageHold(projectRoot, GRANDCHILD, "iteration");

    // Ancestor restructuring: no descendant may begin iterating until it finishes.
    acquireLineageHold(projectRoot, ROOT, "structure");
    expectLocked(() => acquireLineageHold(projectRoot, CHILD_A, "iteration"));
    expectLocked(() => acquireLineageHold(projectRoot, GRANDCHILD, "iteration"));
    expectLocked(() => acquireLineageHold(projectRoot, CHILD_A, "structure"));
    // The restructuring run may still iterate itself: its own holds never collide.
    acquireLineageHold(projectRoot, ROOT, "iteration");
    // Re-acquiring what it already holds is a no-op, not a second hold.
    acquireLineageHold(projectRoot, ROOT, "structure");
    const holds = JSON.parse(fs.readFileSync(lineageLockPath(projectRoot), "utf8")).holds;
    assert.equal(holds.length, 2);
    releaseLineageHold(projectRoot, ROOT, "structure");
    acquireLineageHold(projectRoot, CHILD_A, "iteration");
    releaseLineageHold(projectRoot, CHILD_A, "iteration");
    releaseLineageHold(projectRoot, ROOT, "iteration");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("iterations never block each other, and unrelated branches never block at all", () => {
  const projectRoot = lineageFixture();
  try {
    // Parent and child iterating together is what a dispatch looks like.
    acquireLineageHold(projectRoot, ROOT, "iteration");
    acquireLineageHold(projectRoot, CHILD_A, "iteration");
    acquireLineageHold(projectRoot, GRANDCHILD, "iteration");
    // A sibling branch restructuring is nowhere near this one.
    acquireLineageHold(projectRoot, CHILD_B, "structure");
    releaseLineageHold(projectRoot, CHILD_B, "structure");
    // A child restructures its own children inside its parent's cycle: the
    // hold above it is an iteration, which blocks nothing below.
    releaseLineageHold(projectRoot, GRANDCHILD, "iteration");
    acquireLineageHold(projectRoot, CHILD_A, "structure");
    releaseLineageHold(projectRoot, CHILD_A, "structure");
    // Releasing what is not held is harmless, so a retried close is safe.
    releaseLineageHold(projectRoot, CHILD_B, "iteration");
    // The scope comes from the contract: an unknown run has no lineage to hold.
    assert.throws(
      () => acquireLineageHold(projectRoot, "lineage-nobody", "iteration"),
      (error: unknown) => (error as { code?: string }).code === "RUN_CONTRACT_NOT_FOUND",
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a hold whose run has published its result is not a hold any more", () => {
  const projectRoot = lineageFixture();
  try {
    acquireLineageHold(projectRoot, CHILD_A, "iteration");
    expectLocked(() => acquireLineageHold(projectRoot, ROOT, "structure"));
    // The child finished without releasing — a crashed process, say. Its
    // published result is the proof it is done, and the parent proceeds.
    publishResult(projectRoot, CHILD_A);
    acquireLineageHold(projectRoot, ROOT, "structure");
    const holds = JSON.parse(fs.readFileSync(lineageLockPath(projectRoot), "utf8")).holds;
    assert.deepEqual(holds.map((hold: { run_id: string }) => hold.run_id), [ROOT]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
