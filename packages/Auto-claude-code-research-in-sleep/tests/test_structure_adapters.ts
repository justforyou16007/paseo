import assert from "node:assert/strict";
import {
  buildFanInAction,
  buildFanOutAction,
  buildMultiTeacherMoPDDelta,
} from "../src/tools/structure-adapters.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

const fanOut = buildFanOutAction({
  module_id: "sft",
  output_port: "out",
  contract: "model@1",
  branches: [
    { module_id: "teacher-b", input_port: "in" },
    { module_id: "teacher-a", input_port: "in" },
  ],
  remove_edges: ["sft.out->eval.in"],
});
assert.deepEqual(fanOut.branches, [
  { to: "teacher-a.in", contract: "model@1" },
  { to: "teacher-b.in", contract: "model@1" },
]);

const fanIn = buildFanInAction({
  module_id: "mopd",
  input_port: "in",
  contract: "model@1",
  sources: [
    { module_id: "teacher-b", output_port: "out" },
    { module_id: "teacher-a", output_port: "out" },
  ],
  remove_edges: ["teacher-a.out->eval.in", "teacher-b.out->eval.in"],
});
assert.deepEqual(fanIn.sources, [
  { from: "teacher-a.out", contract: "model@1" },
  { from: "teacher-b.out", contract: "model@1" },
]);

const delta = buildMultiTeacherMoPDDelta({
  teacher_source: { module_id: "sft", output_port: "out", contract: "model@1" },
  teachers: [
    { module_id: "teacher-b", input_port: "in", output_port: "out" },
    { module_id: "teacher-a", input_port: "in", output_port: "out" },
  ],
  mopd: { module_id: "mopd", input_port: "in" },
  fan_out_remove_edges: ["sft.out->eval.in"],
  fan_in_remove_edges: ["teacher-a.out->eval.in", "teacher-b.out->eval.in"],
});
assert.equal(delta.length, 2);
assert.equal(delta[0]?.op, "fan_out");
assert.equal(delta[1]?.op, "fan_in");
assert.deepEqual((delta[0] as { branches: unknown[] }).branches, fanOut.branches);
assert.deepEqual((delta[1] as { sources: unknown[] }).sources, fanIn.sources);

expectCode(
  () =>
    buildMultiTeacherMoPDDelta({
      teacher_source: { module_id: "sft", output_port: "out", contract: "model@1" },
      teachers: [{ module_id: "teacher-a", input_port: "in", output_port: "out" }],
      mopd: { module_id: "mopd", input_port: "in" },
      fan_out_remove_edges: ["sft.out->eval.in"],
      fan_in_remove_edges: ["teacher-a.out->eval.in"],
    }),
  "INVALID_STRUCTURE_DELTA",
);

console.log("test_structure_adapters: ok");
