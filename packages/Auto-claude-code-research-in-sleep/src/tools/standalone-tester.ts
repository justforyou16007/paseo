import fs from "node:fs";
import path from "node:path";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { requireRunContract, runOwnedPath } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertTesterSetupReady,
  checkTesterResult,
  evidenceFile,
  readAuditedTesterResult,
  readTesterFacilityConfig,
  testerConfigPath,
  testerFacilityConfigSha256,
} from "./tester-facility.js";
import {
  auditedTesterMetric,
  testerMetricName,
  verifyTesterDeliverables,
} from "./tester-deliverables.js";
import { failA1, isRecord, requireString } from "./workflow-spec.js";

type Dashboard = Record<string, unknown>;

function target(dashboard: Dashboard) {
  const metric = dashboard.metric;
  if (
    !isRecord(metric) ||
    (metric.name !== null && typeof metric.name !== "string") ||
    !Number.isFinite(metric.target) ||
    !Number.isFinite(metric.tolerance) ||
    Number(metric.tolerance) < 0 ||
    Number(metric.tolerance) >= 1 ||
    (metric.direction !== "higher_better" && metric.direction !== "lower_better")
  )
    failA1("INVALID_VALUE", "standalone target is invalid");
  return {
    name: metric.name as string | null,
    target: metric.target as number,
    tolerance: metric.tolerance as number,
    direction: metric.direction as "higher_better" | "lower_better",
  };
}

export function assertStandaloneTesterAssessment(
  projectRoot: string,
  runId: string,
  dashboard: Dashboard,
) {
  const assessment = dashboard.tester_assessment;
  if (
    !isRecord(assessment) ||
    assessment.iteration !== dashboard.iteration ||
    typeof assessment.result_path !== "string" ||
    typeof assessment.audit_path !== "string"
  )
    failA1("TESTER_AUDIT_REQUIRED", "standalone review needs a completed test and passing audit");
  if (
    evidenceFile(assessment.result_path).sha256 !== assessment.result_sha256 ||
    evidenceFile(assessment.audit_path).sha256 !== assessment.audit_sha256
  )
    failA1("IMMUTABLE_CONFLICT", "recorded standalone tester evidence changed");
  const { result } = readAuditedTesterResult(assessment.result_path, assessment.audit_path, {
    run_id: runId,
    iteration: Number(dashboard.iteration),
  });
  if (
    result.config_sha256 !== dashboard.tester_facility_sha256 ||
    canonicalJsonSha256(target(dashboard)) !== canonicalJsonSha256(dashboard.tester_target)
  )
    failA1(
      "TESTER_RESULT_BINDING_MISMATCH",
      "standalone facility or target differs from its frozen binding",
    );
  verifyTesterDeliverables(
    projectRoot,
    runId,
    result.request.artifact,
    result.request.deliverables,
  );
  const metric = target(dashboard);
  return {
    result_path: assessment.result_path,
    audit_path: assessment.audit_path,
    metric_value: auditedTesterMetric(result, metric.name, metric.direction),
  };
}

export function advanceStandaloneTesterPhase(input: {
  project_root: string;
  run_id: string;
  from_phase: string;
  to_phase: string;
  test_result_path?: string;
  test_audit_path?: string;
}): Dashboard {
  const root = path.resolve(input.project_root),
    run = input.run_id;
  const contract = requireRunContract(root, run);
  if (
    contract.parent_run_id !== null ||
    fs.existsSync(runOwnedPath(root, run, "workflow-runtime.json"))
  )
    failA1("INVALID_VALUE", "standalone tester stages require a standalone root run");
  const file = runOwnedPath(root, run, "dashboard.json");
  return withStateFileLock(file, () => {
    const dashboard = readStateFile<Dashboard>(file);
    if (
      dashboard.run_id !== run ||
      dashboard.status !== "running" ||
      !Number.isInteger(dashboard.iteration)
    )
      failA1("IDENTITY_MISMATCH", "standalone dashboard is not an active run");
    const allowed: Record<string, string> = {
      "experiment-bridge": "tester-test",
      "auto-review-loop": "tester-test",
      "tester-test": "tester-audit",
      "tester-audit": "auto-review-loop",
    };
    const replay = dashboard.current_phase === input.to_phase;
    if (
      allowed[input.from_phase] !== input.to_phase ||
      (!replay && dashboard.current_phase !== input.from_phase)
    )
      failA1(
        "OUTER_PHASE_ORDER",
        "standalone tester stages must run test then audit before review",
      );
    const config = readTesterFacilityConfig(testerConfigPath(root));
    assertTesterSetupReady(testerConfigPath(root));
    const digest = testerFacilityConfigSha256(config),
      metric = target(dashboard);
    metric.name = testerMetricName(config, metric.name, metric.direction);
    if (
      dashboard.tester_facility_sha256 !== undefined &&
      dashboard.tester_facility_sha256 !== digest
    )
      failA1("TESTER_CONFIG_CHANGED", "standalone facilities changed during the run");
    if (
      dashboard.tester_target !== undefined &&
      canonicalJsonSha256(metric) !== canonicalJsonSha256(dashboard.tester_target)
    )
      failA1("TESTER_METRIC_BINDING_MISMATCH", "standalone target changed during the run");
    (dashboard.metric as Record<string, unknown>).name = metric.name;
    dashboard.tester_target = metric;
    dashboard.tester_facility_sha256 = digest;
    if (input.to_phase === "tester-test") {
      const bridge = dashboard.last_bridge_receipt;
      if (!isRecord(bridge) || typeof bridge.receipt_ref !== "string")
        failA1("BRIDGE_SUCCESS_REQUIRED", "merge the completed bridge before testing");
      const receiptPath = runOwnedPath(root, run, bridge.receipt_ref),
        receipt = readStateFile<Dashboard>(receiptPath);
      if (
        evidenceFile(receiptPath).sha256 !== bridge.receipt_sha256 ||
        receipt.run_id !== run ||
        receipt.iteration !== dashboard.iteration ||
        receipt.status !== "done"
      )
        failA1(
          "BRIDGE_SUCCESS_REQUIRED",
          "standalone bridge receipt changed or belongs to another iteration",
        );
      if (!replay) dashboard.tester_assessment = null;
    } else if (input.to_phase === "tester-audit") {
      const resultPath = path.resolve(requireString(input.test_result_path, "test_result_path")),
        result = checkTesterResult(resultPath);
      if (
        result.request.run_id !== run ||
        result.request.iteration !== dashboard.iteration ||
        result.config_sha256 !== digest
      )
        failA1(
          "TESTER_RESULT_BINDING_MISMATCH",
          "standalone result differs from its run, iteration or facility",
        );
      verifyTesterDeliverables(root, run, result.request.artifact, result.request.deliverables);
      const hash = evidenceFile(resultPath).sha256;
      if (
        replay &&
        (!isRecord(dashboard.tester_assessment) ||
          dashboard.tester_assessment.result_sha256 !== hash)
      )
        failA1("IMMUTABLE_CONFLICT", "recorded standalone result changed");
      dashboard.tester_assessment = {
        iteration: dashboard.iteration,
        result_path: resultPath,
        result_sha256: hash,
        audit_path: null,
        audit_sha256: null,
      };
    } else {
      const assessment = dashboard.tester_assessment;
      if (
        !isRecord(assessment) ||
        typeof assessment.result_path !== "string" ||
        evidenceFile(assessment.result_path).sha256 !== assessment.result_sha256
      )
        failA1("TESTER_AUDIT_REQUIRED", "record the complete standalone result before auditing");
      const auditPath = path.resolve(requireString(input.test_audit_path, "test_audit_path")),
        hash = evidenceFile(auditPath).sha256;
      if (replay && assessment.audit_sha256 !== hash)
        failA1("IMMUTABLE_CONFLICT", "recorded standalone audit changed");
      dashboard.tester_assessment = { ...assessment, audit_path: auditPath, audit_sha256: hash };
      assertStandaloneTesterAssessment(root, run, dashboard);
    }
    if (replay) return readStateFile<Dashboard>(file);
    dashboard.current_phase = input.to_phase;
    dashboard.updated_at = new Date().toISOString();
    writeStateJsonAtomic(file, dashboard);
    return dashboard;
  });
}
