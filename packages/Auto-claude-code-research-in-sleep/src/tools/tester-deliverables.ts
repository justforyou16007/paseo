import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { TesterFacilityConfig, TesterTestResult } from "./tester-facility.js";
import { runOwnedPath } from "./run-contract.js";
import {
  assertNoUnknownFields,
  assertRelativePath,
  assertSha256,
  failA1,
  isRecord,
  requireFiniteNumber,
} from "./workflow-spec.js";

/** Paths are relative to the owning run, and are part of the audited request. */
export interface TesterDeliverables {
  output_hashes: Record<string, string>;
  execution_plan_ref?: string;
  interface_record_ref?: string;
}

export function validateTesterDeliverables(value: unknown): TesterDeliverables {
  if (!isRecord(value) || !isRecord(value.output_hashes))
    failA1("TESTER_DELIVERABLES_REQUIRED", "the tested candidate needs an output file manifest");
  assertNoUnknownFields(
    value,
    ["output_hashes", "execution_plan_ref", "interface_record_ref"],
    "deliverables",
  );
  const hashes: Record<string, string> = {};
  for (const [ref, digest] of Object.entries(value.output_hashes))
    hashes[assertRelativePath(ref, "deliverables.output_hashes")] = assertSha256(
      digest,
      `deliverables.${ref}`,
    );
  if (!Object.keys(hashes).length)
    failA1("TESTER_DELIVERABLES_REQUIRED", "the tested candidate needs at least one output file");
  const refs: Pick<TesterDeliverables, "execution_plan_ref" | "interface_record_ref"> = {};
  for (const key of ["execution_plan_ref", "interface_record_ref"] as const) {
    if (value[key] === undefined) continue;
    const ref = assertRelativePath(value[key], `deliverables.${key}`);
    if (hashes[ref] === undefined)
      failA1("TESTER_DELIVERABLES_REQUIRED", `${key} must name a hashed output file`);
    refs[key] = ref;
  }
  return { output_hashes: hashes, ...refs };
}

export function verifyTesterDeliverables(
  projectRoot: string,
  runId: string,
  artifact: { ref: string; sha256: string },
  value: unknown,
): TesterDeliverables {
  const deliverables = validateTesterDeliverables(value);
  const root = fs.realpathSync(runOwnedPath(projectRoot, runId));
  for (const [ref, digest] of Object.entries(deliverables.output_hashes)) {
    const file = runOwnedPath(projectRoot, runId, ref);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      failA1("TESTER_DELIVERABLE_CHANGED", `missing output file: ${ref}`);
    const real = fs.realpathSync(file),
      relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      failA1("TESTER_DELIVERABLE_CHANGED", `output file escapes its owning run: ${ref}`);
    if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== digest)
      failA1("TESTER_DELIVERABLE_CHANGED", `output file changed after testing: ${ref}`);
  }
  // A local model/code file must itself be delivered. Remote/model registry
  // references are represented by the hashed deployment files in the manifest.
  const artifactPath = path.resolve(projectRoot, artifact.ref);
  if (fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()) {
    const ref = path.relative(root, fs.realpathSync(artifactPath));
    if (deliverables.output_hashes[ref] !== artifact.sha256)
      failA1("TESTER_DELIVERABLE_CHANGED", "the tested artifact is not in the output manifest");
  }
  return deliverables;
}

export function testerMetricName(
  config: TesterFacilityConfig,
  name: string | null,
  direction?: "higher_better" | "lower_better",
): string {
  const metric =
    name === null
      ? config.metrics.length === 1
        ? config.metrics[0]
        : undefined
      : (config.metrics.find((m) => m.name === name) ??
        config.metrics.find((m) => `primary.${m.name}` === name));
  if (!metric || (direction !== undefined && direction !== metric.direction))
    failA1(
      "TESTER_METRIC_BINDING_MISMATCH",
      "the target must name a declared tester metric with the same direction",
    );
  return metric.name;
}

export function auditedTesterMetric(
  result: TesterTestResult,
  name: string | null,
  direction?: "higher_better" | "lower_better",
): number {
  return requireFiniteNumber(
    result.metrics[testerMetricName(result.config, name, direction)],
    "audited tester metric",
  );
}
