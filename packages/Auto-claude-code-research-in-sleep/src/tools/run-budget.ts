import fs from "node:fs";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { runOwnedPath } from "./run-contract.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  assertIdentifier,
  assertNoUnknownFields,
  compareIdentityStrings,
  failA1,
  isRecord,
  requireFiniteNumber,
  requireInteger,
  requireString,
} from "./workflow-spec.js";
function requirePlanFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  location: string,
): void {
  for (const field of fields)
    if (!Object.hasOwn(value, field)) failA1("BUDGET_REQUIRED", `missing ${field}`, location);
}
export interface BridgeBudget {
  amount: number;
  unit: string;
}

export interface BudgetAllocation {
  allocation_id: string;
  execution_id: string;
  amount: number;
  cost_actual: number | null;
  refunded: number;
  status: "reserved" | "settled";
}

export interface BudgetLedger {
  schema_version: 1;
  limit: number;
  available: number;
  consumed: number;
  refunded: number;
  unit: string;
  allocations: BudgetAllocation[];
}

export function normalizeBudget(value: unknown, location: string): BridgeBudget {
  if (typeof value === "number") {
    const amount = requireFiniteNumber(value, `${location}.amount`);
    if (amount < 0) failA1("INVALID_VALUE", "budget amount must be non-negative", location);
    return { amount, unit: "budget_units" };
  }
  if (!isRecord(value))
    failA1("BUDGET_REQUIRED", "budget must be a number or { amount, unit }", location);
  assertNoUnknownFields(value, ["amount", "unit"], location);
  const amount = requireFiniteNumber(value.amount, `${location}.amount`);
  if (amount < 0) failA1("INVALID_VALUE", "budget amount must be non-negative", location);
  return { amount, unit: requireString(value.unit, `${location}.unit`) };
}

export function optionalBudget(value: unknown, location: string): BridgeBudget | null {
  if (value === undefined || value === null) return null;
  return normalizeBudget(value, location);
}

export function normalizeBudgetForUnit(
  value: unknown,
  unit: string,
  location: string,
): BridgeBudget {
  if (typeof value === "number") {
    const amount = requireFiniteNumber(value, `${location}.amount`);
    if (amount < 0) failA1("INVALID_VALUE", "budget amount must be non-negative", location);
    return { amount, unit };
  }
  return normalizeBudget(value, location);
}

function buildBudgetLedger(value: BridgeBudget): BudgetLedger {
  return {
    schema_version: 1,
    limit: value.amount,
    available: value.amount,
    consumed: 0,
    refunded: 0,
    unit: value.unit,
    allocations: [],
  };
}

export function allocationId(executionId: string): string {
  return assertIdentifier(`budget:${executionId}`, "allocation_id");
}

export function createBudgetLedger(value: BridgeBudget | number): BudgetLedger {
  return buildBudgetLedger(normalizeBudget(value, "budget"));
}

export function splitChildBudget(
  ledger: BudgetLedger,
  executionIdValue: string,
  amountValue: BridgeBudget | number,
): BudgetLedger {
  const executionId = assertIdentifier(executionIdValue, "execution_id");
  const amount = normalizeBudgetForUnit(amountValue, ledger.unit, "child_budget");
  if (amount.unit !== ledger.unit)
    failA1("COMPUTE_UNIT_MISMATCH", "child budget uses a different unit", "child_budget.unit");
  const existing = ledger.allocations.find((entry) => entry.execution_id === executionId);
  if (existing !== undefined) {
    if (existing.amount !== amount.amount)
      failA1("BUDGET_STATE_ORDER", "an execution cannot change its reservation");
    return ledger;
  }
  if (amount.amount <= 0 || amount.amount > ledger.available)
    failA1(
      "BUDGET_EXHAUSTED",
      "child budget exceeds the parent's available balance",
      "child_budget.amount",
    );
  const entry: BudgetAllocation = {
    allocation_id: allocationId(executionId),
    execution_id: executionId,
    amount: amount.amount,
    cost_actual: null,
    refunded: 0,
    status: "reserved",
  };
  return {
    ...ledger,
    available: ledger.available - amount.amount,
    allocations: [...ledger.allocations, entry].sort((left, right) =>
      compareIdentityStrings(left.execution_id, right.execution_id),
    ),
  };
}

export function refundChildBudget(
  ledger: BudgetLedger,
  executionIdValue: string,
  costActualValue: BridgeBudget | number,
): BudgetLedger {
  const executionId = assertIdentifier(executionIdValue, "execution_id");
  const index = ledger.allocations.findIndex((entry) => entry.execution_id === executionId);
  if (index < 0) failA1("BUDGET_NOT_FOUND", `no budget allocation for child '${executionId}'`);
  const current = ledger.allocations[index]!;
  const costActual = normalizeBudgetForUnit(costActualValue, ledger.unit, "cost_actual");
  if (costActual.unit !== ledger.unit)
    failA1("COMPUTE_UNIT_MISMATCH", "actual cost uses a different budget unit", "cost_actual.unit");
  if (current.status === "settled") {
    if (current.cost_actual !== costActual.amount)
      failA1("BUDGET_STATE_ORDER", "a settled child cannot be settled with a different cost");
    return ledger;
  }
  if (costActual.amount > current.amount)
    failA1("BUDGET_EXCEEDED", "child actual cost exceeds its split budget", "cost_actual.amount");
  const refund = current.amount - costActual.amount;
  const nextAllocation: BudgetAllocation = {
    ...current,
    cost_actual: costActual.amount,
    refunded: refund,
    status: "settled",
  };
  const allocations = [...ledger.allocations];
  allocations[index] = nextAllocation;
  return {
    ...ledger,
    available: ledger.available + refund,
    consumed: ledger.consumed + costActual.amount,
    refunded: ledger.refunded + refund,
    allocations,
  };
}

export const settleChildBudget = refundChildBudget;
export const refundBudget = refundChildBudget;
export const splitBudget = splitChildBudget;

export function validateBudgetLedger(value: unknown, location: string): BudgetLedger {
  if (!isRecord(value))
    failA1("INVALID_EXPANSION", "plan budget ledger must be an object", location);
  assertNoUnknownFields(
    value,
    ["schema_version", "limit", "available", "consumed", "refunded", "unit", "allocations"],
    location,
  );
  requirePlanFields(
    value,
    ["schema_version", "limit", "available", "consumed", "refunded", "unit", "allocations"],
    location,
  );
  if (value.schema_version !== 1)
    failA1("INVALID_EXPANSION", "plan budget ledger schema_version must be 1", location);
  for (const field of ["limit", "available", "consumed", "refunded"] as const) {
    const amount = requireFiniteNumber(value[field], `${location}.${field}`);
    if (amount < 0)
      failA1(
        "INVALID_EXPANSION",
        "budget ledger amounts must be non-negative",
        `${location}.${field}`,
      );
  }
  const unit = requireString(value.unit, `${location}.unit`);
  if (!Array.isArray(value.allocations))
    failA1("INVALID_EXPANSION", "budget ledger allocations must be an array", location);
  const allocations = value.allocations.map((allocation, index) => {
    const allocationLocation = `${location}.allocations[${index}]`;
    if (!isRecord(allocation))
      failA1("INVALID_EXPANSION", "budget allocation must be an object", allocationLocation);
    assertNoUnknownFields(
      allocation,
      ["allocation_id", "execution_id", "amount", "cost_actual", "refunded", "status"],
      allocationLocation,
    );
    requirePlanFields(
      allocation,
      ["allocation_id", "execution_id", "amount", "cost_actual", "refunded", "status"],
      allocationLocation,
    );
    const amount = requireFiniteNumber(allocation.amount, `${allocationLocation}.amount`);
    const refunded = requireFiniteNumber(allocation.refunded, `${allocationLocation}.refunded`);
    if (amount <= 0 || refunded < 0)
      failA1(
        "INVALID_EXPANSION",
        "budget allocation amounts must be non-negative",
        allocationLocation,
      );
    const costActual =
      allocation.cost_actual === null
        ? null
        : requireFiniteNumber(allocation.cost_actual, `${allocationLocation}.cost_actual`);
    if (costActual !== null && costActual < 0)
      failA1(
        "INVALID_EXPANSION",
        "allocation cost_actual must be non-negative",
        allocationLocation,
      );
    if (allocation.status !== "reserved" && allocation.status !== "settled")
      failA1("INVALID_EXPANSION", "budget allocation status is invalid", allocationLocation);
    if (allocation.status === "reserved" && costActual !== null)
      failA1(
        "INVALID_EXPANSION",
        "reserved allocation cannot have cost_actual",
        allocationLocation,
      );
    if (allocation.status === "settled" && costActual === null)
      failA1("INVALID_EXPANSION", "settled allocation needs cost_actual", allocationLocation);
    return {
      allocation_id: assertIdentifier(
        allocation.allocation_id,
        `${allocationLocation}.allocation_id`,
      ),
      execution_id: assertIdentifier(allocation.execution_id, `${allocationLocation}.execution_id`),
      amount,
      cost_actual: costActual,
      refunded,
      status: allocation.status,
    } satisfies BudgetAllocation;
  });
  if (
    new Set(allocations.map((allocation) => allocation.allocation_id)).size !== allocations.length
  )
    failA1("DUPLICATE_ID", "budget allocation ids must be unique", `${location}.allocations`);
  if (new Set(allocations.map((allocation) => allocation.execution_id)).size !== allocations.length)
    failA1("DUPLICATE_ID", "budget child ids must be unique", `${location}.allocations`);
  const near = (left: number, right: number) =>
    Math.abs(left - right) <= Number.EPSILON * 32 * Math.max(1, Math.abs(left), Math.abs(right));
  let reserved = 0,
    consumed = 0,
    refundedTotal = 0;
  for (const entry of allocations) {
    if (entry.allocation_id !== allocationId(entry.execution_id))
      failA1("BUDGET_STATE_ORDER", "allocation key changed", location);
    if (entry.status === "reserved") {
      if (entry.refunded !== 0)
        failA1("BUDGET_STATE_ORDER", "reserved funds cannot be refunded", location);
      reserved += entry.amount;
    } else {
      if (
        entry.cost_actual! > entry.amount ||
        !near(entry.refunded, entry.amount - entry.cost_actual!)
      )
        failA1("BUDGET_STATE_ORDER", "settlement does not balance", location);
      consumed += entry.cost_actual!;
      refundedTotal += entry.refunded;
    }
  }
  if (
    !near(value.limit as number, (value.available as number) + consumed + reserved) ||
    !near(value.consumed as number, consumed) ||
    !near(value.refunded as number, refundedTotal)
  )
    failA1("BUDGET_STATE_ORDER", "account balance differs from its allocations", location);
  return {
    schema_version: 1,
    limit: value.limit as number,
    available: value.available as number,
    consumed: value.consumed as number,
    refunded: value.refunded as number,
    unit,
    allocations,
  };
}

export interface BudgetEvent {
  previous_sha256: string | null;
  ledger: BudgetLedger;
  sha256: string;
}
interface BudgetAccount {
  schema_version: 1;
  events: BudgetEvent[];
}

function loadAccount(filePath: string, initial?: BridgeBudget): BudgetAccount {
  if (!fs.existsSync(filePath)) {
    if (initial === undefined)
      failA1("BUDGET_REQUIRED", "run budget has not been initialized", filePath);
    return { schema_version: 1, events: [] };
  }
  const account = readStateFile<BudgetAccount>(filePath);
  if (account.schema_version !== 1 || !Array.isArray(account.events) || account.events.length === 0)
    failA1("BUDGET_STATE_ORDER", "invalid budget history", filePath);
  let previous: string | null = null;
  for (const event of account.events) {
    validateBudgetLedger(event.ledger, filePath);
    if (
      event.previous_sha256 !== previous ||
      event.sha256 !== canonicalJsonSha256({ previous_sha256: previous, ledger: event.ledger })
    )
      failA1("BUDGET_STATE_ORDER", "budget history hash chain changed", filePath);
    if (
      initial !== undefined &&
      (event.ledger.limit !== initial.amount || event.ledger.unit !== initial.unit)
    )
      failA1("BUDGET_STATE_ORDER", "run budget differs from frozen charter", filePath);
    previous = event.sha256;
  }
  return account;
}

/** Lock, validate, and append one accounting transition without a verifier. */
export function withRunBudget<T>(
  projectRoot: string,
  runId: string,
  initial: BridgeBudget | undefined,
  action: (ledger: BudgetLedger) => { ledger: BudgetLedger; result: T },
): T {
  const filePath = runOwnedPath(projectRoot, runId, "budget.json");
  return withStateFileLock(filePath, () => {
    const account = loadAccount(filePath, initial);
    const prior = account.events.at(-1);
    const ledger = prior?.ledger ?? createBudgetLedger(initial!);
    const next = action(structuredClone(ledger));
    validateBudgetLedger(next.ledger, filePath);
    if (next.ledger.limit !== ledger.limit || next.ledger.unit !== ledger.unit)
      failA1("BUDGET_STATE_ORDER", "account limit and unit are immutable");
    if (prior === undefined || canonicalJsonSha256(ledger) !== canonicalJsonSha256(next.ledger)) {
      const event = { previous_sha256: prior?.sha256 ?? null, ledger: next.ledger };
      account.events.push({ ...event, sha256: canonicalJsonSha256(event) });
      writeStateJsonAtomic(filePath, account);
    }
    return next.result;
  });
}
export function readRunBudget(projectRoot: string, runId: string): BudgetLedger {
  const filePath = runOwnedPath(projectRoot, runId, "budget.json");
  return loadAccount(filePath).events.at(-1)!.ledger;
}
export function initializeRunBudget(
  projectRoot: string,
  runId: string,
  budget: BridgeBudget | number,
): BudgetLedger {
  return withRunBudget(projectRoot, runId, normalizeBudget(budget, "budget"), (ledger) => ({
    ledger,
    result: ledger,
  }));
}
export function executionReservation(
  ledger: BudgetLedger,
  amount?: BridgeBudget | number,
  remaining = 1,
): BridgeBudget {
  return amount === undefined
    ? {
        amount: ledger.available / requireInteger(remaining, "remaining_executions", 1),
        unit: ledger.unit,
      }
    : normalizeBudgetForUnit(amount, ledger.unit, "reservation");
}
export function isExecutionBudgetExhausted(
  ledger: BudgetLedger,
  amount?: BridgeBudget | number,
  remaining = 1,
): boolean {
  const requested = executionReservation(ledger, amount, remaining);
  if (requested.unit !== ledger.unit)
    failA1("COMPUTE_UNIT_MISMATCH", "execution budget unit changed");
  return requested.amount <= 0 || requested.amount > ledger.available;
}
export interface RunExecutionBudgetInput {
  project_root: string;
  run_id: string;
  execution_id: string;
  budget?: BridgeBudget | number;
  remaining_executions?: number;
  resource_status?: "succeeded" | "failed" | "not_executable" | "infra_unavailable";
}
export function reserveRunExecution(input: RunExecutionBudgetInput): BudgetLedger {
  return withRunBudget(input.project_root, input.run_id, undefined, (ledger) => {
    if (input.resource_status === "not_executable" || input.resource_status === "infra_unavailable")
      return { ledger, result: ledger };
    const prior = ledger.allocations.find((entry) => entry.execution_id === input.execution_id);
    const amount =
      input.budget ??
      (prior === undefined
        ? executionReservation(ledger, undefined, input.remaining_executions)
        : prior.amount);
    const next = splitChildBudget(ledger, input.execution_id, amount);
    return { ledger: next, result: next };
  });
}
export function settleRunExecution(
  projectRoot: string,
  runId: string,
  executionId: string,
  costActual?: BridgeBudget | number,
): BudgetLedger {
  return withRunBudget(projectRoot, runId, undefined, (ledger) => {
    const next =
      costActual === undefined ? ledger : refundChildBudget(ledger, executionId, costActual);
    return { ledger: next, result: next };
  });
}

export function runBudgetExhausted(
  projectRoot: string,
  runId: string,
  requested?: BridgeBudget | number,
  remaining = 1,
): boolean {
  return isExecutionBudgetExhausted(readRunBudget(projectRoot, runId), requested, remaining);
}

/** Register only executions whose resources were reserved before dispatch. */
export function settleExecutionReceipt(
  projectRoot: string,
  runId: string,
  manifest: Record<string, unknown>,
  summary: unknown,
): void {
  const facts = isRecord(summary) ? summary : {};
  if (facts.resource_status === "not_executable" || facts.resource_status === "infra_unavailable")
    return;
  const executionId = requireString(manifest.execution_id, "manifest.execution_id");
  const ledger = readRunBudget(projectRoot, runId);
  if (!ledger.allocations.some((entry) => entry.execution_id === executionId))
    failA1("BUDGET_NOT_FOUND", "execution must reserve resources before dispatch");
  const cost =
    facts.cost_actual === undefined
      ? undefined
      : normalizeBudgetForUnit(facts.cost_actual, ledger.unit, "cost_actual");
  settleRunExecution(projectRoot, runId, executionId, cost);
}

export interface PrepareExecutionInput extends RunExecutionBudgetInput {
  manifest: Record<string, unknown>;
  /**
   * Relative directory inside the run that owns the `workers` tree, such as
   * `cycles/1`. The outer workflow keeps each cycle's dispatches under that
   * cycle so its evidence stays with the cycle it belongs to; a run without
   * cycles omits this and dispatches directly below the run directory.
   */
  scope?: string;
}
/** Dispatch gate shared by local trials and repair attempts. */
export function prepareRunExecution(input: PrepareExecutionInput): {
  manifest_path: string;
  output_dir: string;
  ledger: BudgetLedger;
} {
  const executionId = assertIdentifier(input.execution_id, "execution_id");
  const scope = input.scope === undefined ? [] : [input.scope];
  const manifestPath = runOwnedPath(
    input.project_root,
    input.run_id,
    ...scope,
    "workers",
    executionId,
    "input-manifest.json",
  );
  const outputDir = runOwnedPath(
    input.project_root,
    input.run_id,
    ...scope,
    "workers",
    executionId,
    "outputs",
  );
  for (const field of [
    "parent_run_id",
    "outer_run_id",
    "scope_path",
    "outer_iteration",
    "wave_id",
    "wave_kind",
    "generation",
  ]) {
    if (Object.hasOwn(input.manifest, field))
      failA1("UNKNOWN_FIELD", `worker manifest cannot expose ${field}`);
  }
  const manifest = {
    ...input.manifest,
    run_id: input.run_id,
    execution_id: executionId,
    output_dir: outputDir,
  };
  return withStateFileLock(manifestPath, () => {
    if (
      fs.existsSync(manifestPath) &&
      canonicalJsonSha256(readStateFile(manifestPath)) !== canonicalJsonSha256(manifest)
    )
      failA1("IMMUTABLE_CONFLICT", "execution manifest changed");
    const ledger = reserveRunExecution(input);
    fs.mkdirSync(outputDir, { recursive: true });
    writeStateJsonAtomic(manifestPath, manifest);
    return { manifest_path: manifestPath, output_dir: outputDir, ledger };
  });
}
