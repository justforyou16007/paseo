import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { snapshotHarnessInput, validateHarnessDefinition, validatePairedHarnessRequest } from "../src/tools/tester-harness.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-harness-"));
try {
  const source = path.join(root, "model.bin");
  const target = path.join(root, "snapshot.bin");
  fs.writeFileSync(source, "model-v1");
  const hash = crypto.createHash("sha256").update("model-v1").digest("hex");
  snapshotHarnessInput({ path: source, sha256: hash }, target, 1024);
  fs.writeFileSync(source, "model-v2");
  assert.equal(fs.readFileSync(target, "utf8"), "model-v1");
  assert.equal(fs.statSync(target).mode & 0o777, 0o400);
  assert.throws(() => snapshotHarnessInput({ path: source, sha256: hash }, path.join(root, "mismatch"), 1024), /hash mismatch/);
  assert.throws(() => snapshotHarnessInput({ path: source, sha256: hash }, path.join(root, "large"), 2), /size limit/);
  const link = path.join(root, "model-link"); fs.symlinkSync(source, link);
  assert.throws(() => snapshotHarnessInput({ path: link, sha256: hash }, path.join(root, "symlink"), 1024));
  assert.throws(() => validateHarnessDefinition({ schema_version: 1, command: "arbitrary code" }), /unknown/i);
  assert.throws(() => validatePairedHarnessRequest({ schema_version: 1, model_override: "other" }), /unknown/i);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("tester harness: immutable real-file snapshot, size, hash and symlink checks passed");

const { buildTesterDefinition } = await import("../src/tools/tester-state.js");
const { harnessDefinitionSha256, mapPairedHarnessResult } = await import("../src/tools/tester-harness.js");
const hashA = "a".repeat(64), hashB = "b".repeat(64), hashC = "c".repeat(64);
const harness = validateHarnessDefinition({schema_version:1, harness_id:"harness:v1", interpreter:"/usr/bin/python3", interpreter_sha256:hashA, entrypoint:"/opt/aris/evaluate.py", entrypoint_sha256:hashB, dependencies:[], model_roots:["/models"], timeout_ms:1000, max_model_bytes:1024, max_result_bytes:4096});
const tester = buildTesterDefinition({schema_version:1, tester_id:"tester:fixed", version:"v1", immutable:true, case_manifest_id:"cases:v1", case_manifest_sha256:hashA, seed_manifest_sha256:hashB, harness_sha256:harnessDefinitionSha256(harness), research_feedback:"fuzzy_advice_only", max_exposures_per_task:1, comparison:"paired_matching_baseline_vs_finalist", gate:{primaries:[{name:"score",direction:"higher_better",improvement:{policy:"absolute",minimum_gain:0.1}}],paired_delta:"finalist_minus_matching_baseline",statistics:{method:"paired_student_t",confidence_level:0.95,min_repeats:3},case_aggregation:"mean_of_complete_case_set",repeat_aggregation:"lower_confidence_bound",tie_policy:"reject_finalist",missing_result_policy:"fail_closed",constraints:[],workflow_constraints:"must_also_pass"},scoring:[{kind:"deterministic_rules",definition_version:"rules:v1",judge_binding:null}]});
const request = validatePairedHarnessRequest({schema_version:1,promotion_trial_id:"trial:1",harness_sha256:tester.harness_sha256,tester_definition:tester,result_binding:{arm_a_artifact_id:"artifact:a",arm_b_artifact_id:"artifact:b",input_distribution_sha256:hashC,model_assignment_sha256:hashC,judge_binding_id:null,case_ids:["case:1","case:2"],repeat_ids:["repeat:1","repeat:2","repeat:3"]},case_manifest:{path:"/private/cases",sha256:hashA},seed_manifest:{path:"/private/seeds",sha256:hashB},arm_a:{path:"/models/a",sha256:hashA},arm_b:{path:"/models/b",sha256:hashB}});
function rawArm(name: "arm_a" | "arm_b", score: number) {
 return {arm:name,artifact_id:request.result_binding[`${name}_artifact_id`],artifact_sha256:request[name].sha256,tester_version:tester.version,tester_definition_sha256:tester.definition_sha256,harness_sha256:tester.harness_sha256,case_manifest_sha256:hashA,seed_manifest_sha256:hashB,input_distribution_sha256:hashC,model_assignment_sha256:hashC,judge_binding_id:null,case_ids:request.result_binding.case_ids,repeat_ids:request.result_binding.repeat_ids,complete:true,observations:request.result_binding.case_ids.flatMap(case_id=>request.result_binding.repeat_ids.map(repeat_id=>({case_id,repeat_id,metrics:{score},constraint_metrics:{}})))};
}
const envelope = {arm_a:rawArm("arm_a",10),arm_b:rawArm("arm_b",1)};
const mapped = mapPairedHarnessResult(envelope,request);
assert.equal(mapped.baseline.arm,"matching_baseline");
assert.equal(mapped.finalist.arm,"finalist");
assert.equal(mapped.baseline.metrics.score,10);
assert.equal(mapped.finalist.metrics.score,1);
assert.throws(()=>mapPairedHarnessResult({arm_a:envelope.arm_b,arm_b:envelope.arm_a},request));
assert.throws(()=>mapPairedHarnessResult({...envelope,arm_a:{...envelope.arm_a,metrics:{score:999}}},request));
assert.throws(()=>mapPairedHarnessResult({...envelope,arm_a:{...envelope.arm_a,observations:envelope.arm_a.observations.slice(1)}},request));
assert.throws(()=>mapPairedHarnessResult({...envelope,arm_a:{...envelope.arm_a,observations:[...envelope.arm_a.observations,envelope.arm_a.observations[0]]}},request));
assert.throws(()=>mapPairedHarnessResult({...envelope,arm_a:{...envelope.arm_a,observations:envelope.arm_a.observations.map(o=>({...o,metrics:{score:Infinity}}))}},request));
for (const field of ["artifact_sha256","harness_sha256","tester_definition_sha256","case_manifest_sha256","seed_manifest_sha256","input_distribution_sha256","model_assignment_sha256"])
 assert.throws(()=>mapPairedHarnessResult({...envelope,arm_a:{...envelope.arm_a,[field]:"d".repeat(64)}},request));
assert.throws(()=>mapPairedHarnessResult({...envelope,arm_a:{...envelope.arm_a,complete:false}},request));
console.log("tester harness: private observation grid, request binding and fixed role mapping passed");
