import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertIdentifier, assertRunId } from "../src/tools/workflow-spec.js";
import * as runContract from "../src/tools/run-contract.js";

for (const name of [
  "registerChildRun",
  "createRunContract",
  "writeRunContract",
  "acquireScopeLock",
  "releaseScopeLock",
]) {
  test(`run-contract does not export ${name}`, () => {
    assert.equal(Object.hasOwn(runContract, name), false);
  });
}

test("writeRun rejects a missing contract without creating files or scope leases", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "aris-doors-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aris-doors-target-"));
  try {
    const record = runContract.createRootRun({ project_root: source, run_id: "missing" });
    assert.throws(() => runContract.writeRun(target, record), { code: "RUN_CONTRACT_NOT_FOUND" });
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("updateRun rejects an unknown run with an explicit error and no files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-doors-update-"));
  try {
    const expectedMessage = `RUN_NOT_FOUND: no run.json at ${runContract.runJsonPath(root, "missing")}`;
    assert.throws(() => runContract.updateRun(root, "missing", { output_hashes: {} }), {
      code: "RUN_NOT_FOUND",
      message: expectedMessage,
    });
    console.log(
      JSON.stringify({
        operation: "updateRun missing",
        code: "RUN_NOT_FOUND",
        message: expectedMessage,
      }),
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeRun and updateRun cannot recreate a deleted canonical contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-doors-deleted-"));
  try {
    const record = runContract.createRootRun({ project_root: root, run_id: "deleted" });
    const contractPath = runContract.runJsonPath(root, record.run_id);
    const scopePath = path.join(root, ".aris", "run-scope-locks.json");
    const scopesBefore = fs.readFileSync(scopePath);
    fs.unlinkSync(contractPath);
    assert.throws(() => runContract.writeRun(root, record), { code: "RUN_CONTRACT_NOT_FOUND" });
    assert.throws(() => runContract.updateRun(root, record.run_id, { output_hashes: {} }), {
      code: "RUN_CONTRACT_NOT_FOUND",
    });
    assert.equal(fs.existsSync(contractPath), false);
    assert.deepEqual(fs.readFileSync(scopePath), scopesBefore);
    assert.deepEqual(fs.readdirSync(path.dirname(contractPath)), []);

    // readStoredRun accepts a legacy contract; writeRun must still require canonical run.json.
    const legacyPath = runContract.legacyRunStatePath(root, record.run_id);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(record));
    const legacyBefore = fs.readFileSync(legacyPath);
    assert.throws(() => runContract.updateRun(root, record.run_id, { output_hashes: {} }), {
      code: "RUN_CONTRACT_NOT_FOUND",
    });
    assert.equal(fs.existsSync(contractPath), false);
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBefore);
    assert.deepEqual(fs.readFileSync(scopePath), scopesBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const id of ["outer:invalid", "child@invalid", "-leading", "a".repeat(129)]) {
  test(`run creation rejects ${id} before writing state`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-run-id-"));
    try {
      assert.throws(() => runContract.createRootRun({ project_root: root, run_id: id }), {
        code: "INVALID_RUN_ID",
      });
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
test("run ids match review's character set without restricting task or candidate identifiers", () => {
  assert.equal(assertRunId("Run_1.test-2", "run_id"), "Run_1.test-2");
  assert.equal(assertRunId("a".repeat(128), "run_id").length, 128);
  assert.equal(assertIdentifier("task:fixed", "task_id"), "task:fixed");
  assert.equal(assertIdentifier("candidate:111@v1", "candidate_id"), "candidate:111@v1");
});
