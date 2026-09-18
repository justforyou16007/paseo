import { adoptCurrentRunScopeLease, createRootRun } from "../src/tools/run-contract.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertWorkflowConnectionsConnected,
  evaluateWorkflowConnection,
  nodeInterfaceRecordSha256,
  readNodeInterfaceRecord,
  saveNodeInterfaceRecord,
  saveWorkflowConnectionRecord,
  type WorkflowInterfaceRecord,
  validateWorkflowOutputContent,
} from "../src/tools/workflow-interface.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-workflow-interface-"));
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function record(
  nodeId: string,
  outputContains: string[],
  outputExample: unknown,
  inputRequires: string[],
  inputExample: unknown,
): WorkflowInterfaceRecord {
  return {
    schema_version: 1,
    node_id: nodeId,
    outputs: [
      {
        location: "different/output/label",
        contains: outputContains,
        example: outputExample,
        document: "这个输出说明它交付的实际内容和使用限制。",
      },
    ],
    input_requirements: [
      {
        location: "different/input/label",
        requires: inputRequires,
        example: inputExample,
        document: "下游需要这些内容才能使用上游产物。",
      },
    ],
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    const value = error as { code?: string };
    return value.code === code;
  });
}

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void): void {
  tests.push({ name, run });
}

test("content meaning connects despite different location labels", () => {
  const upstream = record(
    "sft",
    ["可继续训练的模型权重", "匹配 tokenizer", "训练来源和加载方式"],
    { artifact_kind: "model", load_entry: "artifacts/sft" },
    ["基础模型"],
    { artifact_kind: "model" },
  );
  const downstream = record(
    "rl",
    ["训练后的模型"],
    { artifact_kind: "model" },
    ["可加载的模型权重", "匹配的 tokenizer", "来源和版本信息"],
    { artifact_kind: "model", load_entry: "artifacts/input" },
  );
  const result = evaluateWorkflowConnection({
    upstream,
    downstream,
    upstream_output_location: "different/output/label",
    downstream_input_location: "different/input/label",
    input_snapshot: { base: "incumbent@1" },
  });
  assert.equal(result.status, "connected");
  assert.equal(result.from.location, "different/output/label");
  assert.equal(result.to.location, "different/input/label");
  assert.equal(result.requirement_matches[0]?.missing_concepts.length, 0);
});

test("missing tokenizer is insufficient even when model weights exist", () => {
  const result = evaluateWorkflowConnection({
    upstream: record("sft", ["模型权重"], { artifact_kind: "model" }, ["模型"], {}),
    downstream: record(
      "rl",
      ["训练结果"],
      {},
      ["可加载的模型权重", "匹配 tokenizer"],
      { artifact_kind: "model", load_entry: "model" },
    ),
  });
  assert.equal(result.status, "content_insufficient");
  assert.ok(result.requirement_matches[0]?.missing_concepts.includes("tokenizer"));
});

test("aggregate score cannot satisfy a trajectory requirement", () => {
  const result = evaluateWorkflowConnection({
    upstream: record("eval", ["聚合分数"], { metric: "mean" }, ["模型"], {}),
    downstream: record(
      "analysis",
      ["分析"],
      {},
      ["逐项轨迹和每个 case 的结果"],
      { observations: [] },
    ),
  });
  assert.equal(result.status, "content_insufficient");
  assert.ok(result.requirement_matches[0]?.missing_concepts.includes("trajectory"));
});

test("a path without a loading method is insufficient", () => {
  const result = evaluateWorkflowConnection({
    upstream: record("artifact", ["模型文件路径"], { path: "artifacts/model" }, ["模型"], {}),
    downstream: record(
      "runner",
      ["运行结果"],
      {},
      ["可加载的模型"],
      { load_entry: "artifacts/model" },
    ),
  });
  assert.equal(result.status, "content_insufficient");
  assert.ok(result.requirement_matches[0]?.missing_concepts.includes("load"));
});

test("vague descriptions are unclear rather than accepted", () => {
  const result = evaluateWorkflowConnection({
    upstream: record("a", ["结果"], { value: "x" }, ["输入"], {}),
    downstream: record("b", ["结果"], {}, ["所需内容"], {}),
  });
  assert.equal(result.status, "content_unclear");
});

test("interface and connection records are immutable and hash checked", () => {
  const root = tempRoot();
  try {
    const upstream = record(
      "sft",
      ["模型权重", "tokenizer", "加载方式"],
      { artifact_kind: "model", load_entry: "model" },
      ["基础模型"],
      {},
    );
    createRootRun({ project_root: root, run_id: "node-sft-1" });
    adoptCurrentRunScopeLease({ project_root: root, run_id: "node-sft-1", scope_path: "/" }).release();
    createRootRun({ project_root: root, run_id: "outer-1" });
    const saved = saveNodeInterfaceRecord(root, "node-sft-1", upstream);
    assert.equal(saved.interface_record_sha256, nodeInterfaceRecordSha256(upstream));
    assert.deepEqual(readNodeInterfaceRecord(root, "node-sft-1"), saved);
    assert.deepEqual(saveNodeInterfaceRecord(root, "node-sft-1", upstream), saved);
    expectCode(
      () =>
        saveNodeInterfaceRecord(root, "node-sft-1", {
          ...upstream,
          outputs: [{ ...upstream.outputs[0]!, contains: ["其他内容"] }],
        }),
      "IMMUTABLE_CONFLICT",
    );

    const downstream = record("rl", ["结果"], {}, ["模型权重"], {});
    const connection = evaluateWorkflowConnection({ upstream: saved, downstream });
    const stored = saveWorkflowConnectionRecord(root, "outer-1", connection);
    assert.deepEqual(saveWorkflowConnectionRecord(root, "outer-1", connection), stored);
    assert.deepEqual(assertWorkflowConnectionsConnected([connection]), [connection]);
    expectCode(
      () => assertWorkflowConnectionsConnected([{ ...connection, status: "content_unclear" }]),
      "CORRUPT_STATE",
    );
    const unclear = evaluateWorkflowConnection({
      upstream: record("vague", ["结果"], {}, ["输入"], {}),
      downstream: record("vague-next", ["结果"], {}, ["所需内容"], {}),
    });
    assert.equal(unclear.status, "content_unclear");
    const unclearStored = saveWorkflowConnectionRecord(root, "outer-1", unclear);
    assert.equal(unclearStored.status, "content_unclear");
  } finally {
    cleanup(root);
  }
});

test("documents are capped and filesystem roots are rejected", () => {
  const longText = "字".repeat(501);
  expectCode(
    () =>
      saveNodeInterfaceRecord(tempRoot(), "node-1", {
        ...record("node", ["模型"], {}, ["模型"], {}),
        outputs: [{ ...record("node", ["模型"], {}, ["模型"], {}).outputs[0]!, document: longText }],
      }),
    "INVALID_VALUE",
  );
  expectCode(
    () => saveNodeInterfaceRecord(path.parse(path.resolve(".")).root, "node-1", record("node", ["模型"], {}, ["模型"], {})),
    "INVALID_PROJECT_ROOT",
  );
});

test("actual output is checked against the initialized content promise", () => {
  const initialized = record(
    "sft",
    ["模型权重", "tokenizer", "加载方式", "训练来源"],
    { artifact_kind: "model", load_entry: "model" },
    ["基础模型"],
    {},
  );
  const complete = validateWorkflowOutputContent({
    interface_record: initialized,
    actual_output: {
      artifact_kind: "model",
      model_path: "artifacts/model",
      tokenizer: "artifacts/tokenizer",
      load_entry: "model",
      training: "训练来源",
      source: "run-1",
      version: "v1",
    },
    artifact_ref: "artifact:model-1",
  });
  assert.equal(complete.status, "content_present");
  const missing = validateWorkflowOutputContent({
    interface_record: initialized,
    actual_output: {
      artifact_kind: "model",
      model_path: "artifacts/model",
      load_entry: null,
      tokenizer: "",
    },
  });
  assert.equal(missing.status, "content_missing");
  assert.ok(missing.missing_concepts.includes("load"));
});

let passed = 0;
for (const testCase of tests) {
  testCase.run();
  passed += 1;
  console.log(`ok - ${testCase.name}`);
}
console.log(`${passed} workflow interface tests passed`);
