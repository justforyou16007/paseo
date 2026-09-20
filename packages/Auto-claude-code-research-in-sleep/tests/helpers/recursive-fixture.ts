import { createRunCharter, type RunCharterInput } from "../../src/tools/run-charter.js";
import { type ExperimentBridgeInput, type BridgePositionInput } from "../../src/tools/experiment-bridge.js";
import { type BaselineScope } from "../../src/tools/baseline-scope.js";
import { type ResourceInventory } from "../../src/tools/resource-inventory.js";

export function charterFixture(value: Partial<RunCharterInput> & Record<string, unknown>) {
  return createRunCharter({
    schema_version: 1, charter_id: "charter:fixture", run_id: "fixture-root",
    problem: "Compare the proposed method against the frozen local baseline",
    expected_output: "A reproducible artifact and local evidence",
    evidence_refs: [], constraints: {}, input_snapshot_refs: [], baseline_ref: "W_0",
    baseline_sha256: "a".repeat(64), resource_inventory_sha256: "b".repeat(64),
    resource_inventory_ref: "resources:fixture", optimizable_scope: [],
    budget: { amount: 100, unit: "gpu_hours" },
    measurement: { validator_ref: "validator:local", tester_ref: "tester:local" },
    policy_revision: "policy:fixture", code_baseline_sha256: "c".repeat(64),
    ...value,
  } as RunCharterInput);
}

export function bridgeFixture(value: Record<string, unknown>): ExperimentBridgeInput {
  const charter = value.charter as Record<string, unknown>;
  const base = value.baseline as BaselineScope;
  const resource = value.resource_inventory as ResourceInventory;
  const frozen = charterFixture({ ...charter, baseline_sha256: charter.baseline_sha256 ?? base.baseline_sha256, resource_inventory_sha256: charter.resource_inventory_sha256 ?? resource.inventory_sha256 });
  const { run_id: _id, charter_id: _charterId, budget: _budget, charter_sha256: _sha, measurement: _measurement, ...content } = frozen;
  const positions = (value.positions as BridgePositionInput[]).map(position => ({
    ...position,
    execution_plan: position.execution_plan ?? { method: `implement ${position.position_id}`, parameters: { seed: 1 } },
    charter: position.charter ?? { ...content, problem: `Improve ${position.position_id}`, measurement: { validator_ref: `validator:${position.position_id}` } },
    acceptance: position.acceptance ?? { metric: { name: "score", direction: "higher_better", threshold: 0.5 } },
  }));
  return {
    ...value,
    run: value.run ?? { run_id: frozen.run_id, depth: 0, scope_path: "/" },
    charter: frozen, positions,
    strategy_reason: value.strategy_reason ?? "Complete the declared local comparison before choosing the next experiment",
  } as ExperimentBridgeInput;
}
