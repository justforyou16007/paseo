import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  assertIdentifier,
  assertSha256,
  assertNoUnknownFields,
  isRecord,
  requireInteger,
  requireString,
  failA1,
} from "./workflow-spec.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertProtectedPath,
  checkTesterIsolation,
  readTesterIsolationConfig,
} from "./tester-isolation.js";

import {
  validateTesterDefinition,
  normalizeTesterArmResult,
  assertTesterArmsComparable,
  type TesterDefinition,
  type TesterArmResult,
} from "./tester-state.js";

export interface HarnessDefinition {
  schema_version: 1;
  harness_id: string;
  interpreter: string;
  interpreter_sha256: string;
  entrypoint: string;
  entrypoint_sha256: string;
  dependencies: HarnessModel[];
  model_roots: string[];
  timeout_ms: number;
  max_model_bytes: number;
  max_result_bytes: number;
}

export interface HarnessModel {
  path: string;
  sha256: string;
}

export interface PairedHarnessRequest {
  schema_version: 1;
  promotion_trial_id: string;
  harness_sha256: string;
  tester_definition: TesterDefinition;
  result_binding: HarnessResultBinding;
  case_manifest: HarnessModel;
  seed_manifest: HarnessModel;
  arm_a: HarnessModel;
  arm_b: HarnessModel;
}

export interface HarnessResultBinding {
  arm_a_artifact_id: string;
  arm_b_artifact_id: string;
  input_distribution_sha256: string;
  model_assignment_sha256: string;
  judge_binding_id: string | null;
  case_ids: string[];
  repeat_ids: string[];
}

export function harnessDefinitionSha256(value: HarnessDefinition): string {
  return canonicalJsonSha256(validateHarnessDefinition(value), undefined, {
    schemaVersion: "tester-harness-v1",
  });
}

function resultBinding(value: unknown): HarnessResultBinding {
  if (!isRecord(value)) failA1("INVALID_HARNESS", "result binding is required");
  assertNoUnknownFields(
    value,
    [
      "arm_a_artifact_id",
      "arm_b_artifact_id",
      "input_distribution_sha256",
      "model_assignment_sha256",
      "judge_binding_id",
      "case_ids",
      "repeat_ids",
    ],
    "result_binding",
  );
  const ids = (items: unknown, name: string): string[] => {
    if (!Array.isArray(items) || items.length === 0)
      failA1("INVALID_HARNESS", `${name} must be nonempty`);
    const values = items.map((item) => assertIdentifier(item, name));
    if (new Set(values).size !== values.length)
      failA1("INVALID_HARNESS", `${name} contains duplicates`);
    return values.sort();
  };
  return {
    arm_a_artifact_id: assertIdentifier(value.arm_a_artifact_id, "arm_a_artifact_id"),
    arm_b_artifact_id: assertIdentifier(value.arm_b_artifact_id, "arm_b_artifact_id"),
    input_distribution_sha256: assertSha256(
      value.input_distribution_sha256,
      "input_distribution_sha256",
    ),
    model_assignment_sha256: assertSha256(value.model_assignment_sha256, "model_assignment_sha256"),
    judge_binding_id:
      value.judge_binding_id === null
        ? null
        : assertIdentifier(value.judge_binding_id, "judge_binding_id"),
    case_ids: ids(value.case_ids, "case_ids"),
    repeat_ids: ids(value.repeat_ids, "repeat_ids"),
  };
}

// Call only inside the tester boundary: the returned observations are private.
// Roles are fixed by the request, never inferred from either arm's score.
export function mapPairedHarnessResult(
  value: unknown,
  input: PairedHarnessRequest,
): {
  baseline: TesterArmResult;
  finalist: TesterArmResult;
} {
  const request = validatePairedHarnessRequest(input);
  if (!isRecord(value)) failA1("INVALID_HARNESS_RESULT", "paired envelope must be an object");
  assertNoUnknownFields(value, ["arm_a", "arm_b"], "paired_envelope");
  const map = (name: "arm_a" | "arm_b", role: TesterArmResult["arm"]): TesterArmResult => {
    const raw = value[name];
    if (!isRecord(raw) || raw.arm !== name)
      failA1("INVALID_HARNESS_RESULT", "anonymous arm identity does not match envelope position");
    const arm = normalizeTesterArmResult({ ...raw, arm: role }, name, request.tester_definition);
    const binding = request.result_binding;
    if (
      !arm.complete ||
      arm.artifact_id !== binding[`${name}_artifact_id`] ||
      arm.artifact_sha256 !== request[name].sha256 ||
      arm.tester_version !== request.tester_definition.version ||
      arm.case_manifest_sha256 !== request.case_manifest.sha256 ||
      arm.seed_manifest_sha256 !== request.seed_manifest.sha256 ||
      arm.input_distribution_sha256 !== binding.input_distribution_sha256 ||
      arm.model_assignment_sha256 !== binding.model_assignment_sha256 ||
      arm.judge_binding_id !== binding.judge_binding_id ||
      JSON.stringify([...arm.case_ids].sort()) !== JSON.stringify(binding.case_ids) ||
      JSON.stringify([...arm.repeat_ids].sort()) !== JSON.stringify(binding.repeat_ids)
    )
      failA1("HARNESS_RESULT_BINDING_MISMATCH", "arm differs from the frozen request");
    return arm;
  };
  const baseline = map("arm_a", "matching_baseline");
  const finalist = map("arm_b", "finalist");
  assertTesterArmsComparable(baseline, finalist);
  return { baseline, finalist };
}

export interface HarnessReceipt {
  schema_version: 1;
  promotion_trial_id: string;
  status: "sealed" | "failed";
  request_sha256: string;
  harness_sha256: string;
  result_sha256: string | null;
  reason: "complete" | "harness_failed" | "invalid_result";
}

export function validateHarnessDefinition(value: unknown): HarnessDefinition {
  if (!isRecord(value)) failA1("INVALID_HARNESS", "harness definition must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "harness_id",
      "interpreter",
      "interpreter_sha256",
      "entrypoint",
      "entrypoint_sha256",
      "dependencies",
      "model_roots",
      "timeout_ms",
      "max_model_bytes",
      "max_result_bytes",
    ],
    "harness",
  );
  if (
    value.schema_version !== 1 ||
    !Array.isArray(value.model_roots) ||
    value.model_roots.length === 0
  )
    failA1("INVALID_HARNESS", "harness requires a version and explicit model roots");
  const interpreter = absolutePath(value.interpreter);
  const entrypoint = absolutePath(value.entrypoint);
  if (!Array.isArray(value.dependencies))
    failA1("INVALID_HARNESS", "harness dependencies must be explicitly enumerated");
  return {
    schema_version: 1,
    harness_id: assertIdentifier(value.harness_id, "harness_id"),
    interpreter,
    interpreter_sha256: assertSha256(value.interpreter_sha256, "interpreter_sha256"),
    entrypoint,
    entrypoint_sha256: assertSha256(value.entrypoint_sha256, "entrypoint_sha256"),
    dependencies: value.dependencies.map(model),
    model_roots: value.model_roots.map(absolutePath),
    timeout_ms: requireInteger(value.timeout_ms, "timeout_ms", 1),
    max_model_bytes: requireInteger(value.max_model_bytes, "max_model_bytes", 1),
    max_result_bytes: requireInteger(value.max_result_bytes, "max_result_bytes", 1),
  };
}

function absolutePath(value: unknown): string {
  const result = requireString(value, "path");
  if (!path.isAbsolute(result) || path.normalize(result) !== result || result.includes("\0"))
    failA1("INVALID_PATH", "harness paths must be normalized absolute paths");
  return result;
}

function model(value: unknown): HarnessModel {
  if (!isRecord(value)) failA1("INVALID_HARNESS", "harness input reference must be an object");
  assertNoUnknownFields(value, ["path", "sha256"], "harness_input");
  return {
    path: absolutePath(value.path),
    sha256: assertSha256(value.sha256, "harness_input.sha256"),
  };
}

export function validatePairedHarnessRequest(value: unknown): PairedHarnessRequest {
  if (!isRecord(value)) failA1("INVALID_HARNESS", "paired request must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "promotion_trial_id",
      "harness_sha256",
      "tester_definition",
      "result_binding",
      "case_manifest",
      "seed_manifest",
      "arm_a",
      "arm_b",
    ],
    "paired_request",
  );
  if (value.schema_version !== 1) failA1("INVALID_HARNESS", "unsupported paired request");
  const testerDefinition = validateTesterDefinition(value.tester_definition);
  if (testerDefinition.harness_sha256 !== value.harness_sha256)
    failA1("HARNESS_MISMATCH", "tester definition and request must bind the same harness");
  const cases = model(value.case_manifest);
  const seeds = model(value.seed_manifest);
  if (
    cases.sha256 !== testerDefinition.case_manifest_sha256 ||
    seeds.sha256 !== testerDefinition.seed_manifest_sha256
  )
    failA1("HARNESS_MISMATCH", "request manifests differ from the tester definition");
  return {
    schema_version: 1,
    tester_definition: testerDefinition,
    result_binding: resultBinding(value.result_binding),
    promotion_trial_id: assertIdentifier(value.promotion_trial_id, "promotion_trial_id"),
    harness_sha256: assertSha256(value.harness_sha256, "harness_sha256"),
    case_manifest: model(value.case_manifest),
    seed_manifest: model(value.seed_manifest),
    arm_a: model(value.arm_a),
    arm_b: model(value.arm_b),
  };
}

function inside(file: string, directory: string): boolean {
  return file.startsWith(`${directory}/`);
}

// Hash while copying from the same open descriptor so a model change cannot alter the test mid-run.
export function snapshotHarnessInput(
  reference: HarnessModel,
  target: string,
  maxBytes: number,
): void {
  const sourceFd = fs.openSync(reference.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let targetFd: number | undefined;
  try {
    const stat = fs.fstatSync(sourceFd);
    if (!stat.isFile() || stat.size > maxBytes)
      failA1(
        "INVALID_HARNESS_INPUT",
        "harness input must be a regular file within the frozen size limit",
      );
    targetFd = fs.openSync(target, "wx", 0o400);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes)
        failA1("INVALID_HARNESS_INPUT", "harness input grew beyond its frozen limit");
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      fs.writeFileSync(targetFd, chunk);
    }
    fs.fsyncSync(targetFd);
    if (hash.digest("hex") !== reference.sha256)
      failA1("HARNESS_INPUT_CHANGED", "harness input hash mismatch");
  } finally {
    fs.closeSync(sourceFd);
    if (targetFd !== undefined) fs.closeSync(targetFd);
  }
}

function verifyExecutable(file: string, expectedHash: string): void {
  assertProtectedPath(file, [0]);
  if (
    !fs.statSync(file).isFile() ||
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expectedHash
  )
    failA1("HARNESS_CHANGED", "administrator-installed harness code changed");
}

export function executePairedHarness(input: {
  isolation_config: string;
  harness_config: string;
  request_path: string;
}): HarnessReceipt {
  // Local execution is retained only as an audited historical implementation.
  // Production testers are remote jobs; allowing this path would recreate the
  // same-user access route that the remote contract is meant to remove.
  if (!localTesterExecutionAllowed())
    failA1(
      "LOCAL_TESTER_EXECUTION_DISABLED",
      "fixed tester execution must be submitted to the remote tester agent",
    );
  const isolation = readTesterIsolationConfig(input.isolation_config);
  checkTesterIsolation(isolation, "tester");
  const definition = validateHarnessDefinition(readStateFile(input.harness_config));
  const requestPath = fs.realpathSync(input.request_path);
  if (!inside(requestPath, isolation.private_root))
    failA1(
      "TESTER_PRIVATE_PATH_REQUIRED",
      "paired requests must be delivered to the private tester store",
    );
  assertProtectedPath(requestPath, [0, isolation.tester_uid]);
  const request = validatePairedHarnessRequest(readStateFile(requestPath));
  const harnessHash = harnessDefinitionSha256(definition);
  if (harnessHash !== request.harness_sha256)
    failA1("HARNESS_CHANGED", "request does not bind the frozen harness");
  verifyExecutable(definition.interpreter, definition.interpreter_sha256);
  verifyExecutable(definition.entrypoint, definition.entrypoint_sha256);
  for (const dependency of definition.dependencies)
    verifyExecutable(dependency.path, dependency.sha256);
  for (const root of definition.model_roots) {
    if (
      root === "/" ||
      root === isolation.private_root ||
      inside(isolation.private_root, root) ||
      inside(root, isolation.private_root)
    )
      failA1("TESTER_PRIVATE_PATH_REQUIRED", "model roots cannot contain private tester files");
  }
  for (const reference of [request.arm_a, request.arm_b]) {
    const resolved = fs.realpathSync(reference.path);
    if (!definition.model_roots.some((root) => inside(resolved, root)))
      failA1("HARNESS_MODEL_SCOPE", "model is outside the administrator-approved model roots");
  }
  for (const reference of [request.case_manifest, request.seed_manifest]) {
    if (!inside(fs.realpathSync(reference.path), isolation.private_root))
      failA1("TESTER_PRIVATE_PATH_REQUIRED", "test cases and seeds must remain private");
    assertProtectedPath(reference.path, [0, isolation.tester_uid]);
  }
  const trialRoot = path.join(isolation.private_root, "trials", request.promotion_trial_id);
  const receiptPath = path.join(trialRoot, "receipt.json");
  const requestHash = canonicalJsonSha256(request, undefined, {
    schemaVersion: "paired-harness-request-v1",
  });
  return withStateFileLock(receiptPath, () => {
    if (fs.existsSync(receiptPath)) {
      const previous = readStateFile<HarnessReceipt>(receiptPath);
      if (previous.request_sha256 !== requestHash || previous.harness_sha256 !== harnessHash)
        failA1("IMMUTABLE_CONFLICT", "promotion trial cannot change model or harness inputs");
      return previous;
    }
    const startedPath = path.join(trialRoot, "started.json");
    if (fs.existsSync(startedPath))
      failA1(
        "HARNESS_RECOVERY_REQUIRED",
        "trial was already started; reconcile its private process and output before retrying",
      );
    fs.mkdirSync(trialRoot, { recursive: true, mode: 0o700 });
    writeStateJsonAtomic(startedPath, {
      request_sha256: requestHash,
      harness_sha256: harnessHash,
      owner_pid: process.pid,
    });
    for (const [name, reference] of [
      ["arm-a", request.arm_a],
      ["arm-b", request.arm_b],
      ["cases", request.case_manifest],
      ["seeds", request.seed_manifest],
    ] as const) {
      snapshotHarnessInput(reference, path.join(trialRoot, name), definition.max_model_bytes);
    }
    const sealedRequestPath = path.join(trialRoot, "request.json");
    writeStateJsonAtomic(sealedRequestPath, request);
    const resultPath = path.join(trialRoot, "result.json");
    const errorPath = path.join(trialRoot, "stderr.log");
    const resultFd = fs.openSync(resultPath, "wx", 0o600);
    const errorFd = fs.openSync(errorPath, "wx", 0o600);
    let exitStatus: number | null;
    try {
      const processResult = spawnSync(
        definition.interpreter,
        [
          definition.entrypoint,
          "--request",
          sealedRequestPath,
          "--arm-a",
          path.join(trialRoot, "arm-a"),
          "--arm-b",
          path.join(trialRoot, "arm-b"),
          "--cases",
          path.join(trialRoot, "cases"),
          "--seeds",
          path.join(trialRoot, "seeds"),
        ],
        {
          cwd: trialRoot,
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            PYTHONNOUSERSITE: "1",
            PYTHONDONTWRITEBYTECODE: "1",
          },
          stdio: ["ignore", resultFd, errorFd],
          timeout: definition.timeout_ms,
          killSignal: "SIGKILL",
        },
      );
      exitStatus = processResult.status;
      fs.fsyncSync(resultFd);
      fs.fsyncSync(errorFd);
    } finally {
      fs.closeSync(resultFd);
      fs.closeSync(errorFd);
    }
    let reason: HarnessReceipt["reason"] = exitStatus === 0 ? "complete" : "harness_failed";
    let resultHash: string | null = null;
    if (exitStatus === 0) {
      if (fs.statSync(resultPath).size > definition.max_result_bytes) reason = "invalid_result";
      else {
        try {
          mapPairedHarnessResult(readStateFile<unknown>(resultPath), request);
          resultHash = crypto
            .createHash("sha256")
            .update(fs.readFileSync(resultPath))
            .digest("hex");
        } catch {
          reason = "invalid_result";
        }
      }
    }
    const receipt: HarnessReceipt = {
      schema_version: 1,
      promotion_trial_id: request.promotion_trial_id,
      status: reason === "complete" ? "sealed" : "failed",
      request_sha256: requestHash,
      harness_sha256: harnessHash,
      result_sha256: resultHash,
      reason,
    };
    writeStateJsonAtomic(receiptPath, receipt);
    return receipt;
  });
}

// Kept as a named predicate so TypeScript still checks the historical code
// below while the production decision remains unconditionally remote-only.
function localTesterExecutionAllowed(): boolean {
  return false;
}
