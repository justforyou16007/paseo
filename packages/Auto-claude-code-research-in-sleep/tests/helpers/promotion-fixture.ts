import {
  adoptCurrentRunScopeLease,
  readRunScopeLeaseTokens,
  requireRunContract,
} from "../../src/tools/run-contract.js";
import path from "node:path";
import {
  makeFixture,
  startFixture,
  recover,
  completeModule,
  makeModule,
  evidence,
  validationInputs,
  sealFinalistProducer,
  type Fixture,
  type FixtureOptions,
} from "../test_workflow_runtime.js";
import {
  advanceOuterPhase,
  beginOuterCycle,
  recordValidationGateResult,
  registerOuterChild,
  reserveOuterBudget,
  settleOuterBudget,
  reconcileOuterChildren,
} from "../../src/tools/workflow-runtime.js";

/** Reach the real validation gate without creating a tester or reserving exposure. */
export function enterPromotion(fixture: Fixture, waveId = "wave:fixed"): void {
  startFixture(fixture);
  recover(fixture, "init");
  beginOuterCycle({
    ...fixture.identity,
    wave_id: waveId,
    wave_kind: "module",
    evidence_paths: [evidence(fixture.root, "cycle-begin")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "diagnosis",
    to_phase: "workset",
    evidence_paths: [evidence(fixture.root, "diagnosis")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "workset",
    to_phase: "wave",
    evidence_paths: [evidence(fixture.root, "workset")],
  });

  const moduleIds = ["module:a", "module:b", "module:c"];
  const moduleRunIds = moduleIds.map(
    (_, index) => `${fixture.identity.outer_run_id}-module-${index}`,
  );
  for (let index = 0; index < moduleIds.length; index += 1) {
    makeModule(
      fixture.root,
      moduleRunIds[index]!,
      moduleIds[index]!,
      fixture.identity.outer_run_id,
    );
    // The module a child was dispatched for is parent-side identity, so the
    // parent records it here rather than reading it back out of the child.
    registerOuterChild({
      ...fixture.identity,
      child_run_id: moduleRunIds[index]!,
      kind: "module",
      module_id: moduleIds[index]!,
    });
  }
  reserveOuterBudget({
    ...fixture.identity,
    reservation_id: "budget:module",
    category: "module",
    amount: 1,
    unit: "gpu_hours",
    child_run_id: moduleRunIds[0],
  });
  for (let index = 0; index < moduleIds.length; index += 1)
    completeModule(fixture.root, moduleRunIds[index]!, moduleIds[index]!);
  reconcileOuterChildren(fixture.identity);
  settleOuterBudget({
    ...fixture.identity,
    reservation_id: "budget:module",
    evidence_paths: [evidence(fixture.root, "module-budget")],
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "wave",
    to_phase: "validation",
    evidence_paths: [evidence(fixture.root, "wave")],
  });

  const validation = validationInputs();
  recordValidationGateResult({
    ...fixture.identity,
    evidence_paths: [evidence(fixture.root, "validation")],
    gate_input: {
      plan: validation.plan,
      results: validation.results,
      plan_id: "plan:fixed-3",
      primary_direction: "higher_better",
      improvement: { policy: "absolute", minimum_gain: 0.2 },
      binding: validation.binding,
      review: validation.review,
    },
  });
  advanceOuterPhase({
    ...fixture.identity,
    from_phase: "validation",
    to_phase: "promotion",
    evidence_paths: [evidence(fixture.root, "validation-complete")],
  });
}

export interface PromotionFixtureInput extends FixtureOptions {
  project_root: string;
  outer_run_id: string;
  wave_id: string;
}

const fixtures = new Map<string, Fixture>();

export function makePromotionFixture(input: PromotionFixtureInput): Fixture {
  const key = `${path.resolve(input.project_root)}\0${input.outer_run_id}`;
  const existing = fixtures.get(key);
  if (existing) return existing;
  // These fixtures retain historical runs, not concurrent live schedulers.
  // A previous test-created tester may have acquired a lease after root preparation.
  for (const previous of fixtures.values()) {
    if (previous.root !== input.project_root) continue;
    const root = requireRunContract(input.project_root, previous.identity.outer_run_id);
    for (const runId of [...root.child_run_ids, root.run_id]) {
      const contract = requireRunContract(input.project_root, runId);
      const scope = {
        project_root: input.project_root,
        run_id: runId,
        scope_path: contract.scope_path,
        parent_run_id: contract.parent_run_id,
      };
      try {
        const tokens = readRunScopeLeaseTokens(scope);
        for (const _token of tokens) adoptCurrentRunScopeLease(scope).release();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "RUN_SCOPE_NOT_FOUND"))
          throw error;
      }
    }
  }
  const fixture = makeFixture(
    input.project_root,
    path.join(input.project_root, "fixture-execution", input.outer_run_id),
    input.outer_run_id,
    input.tester?.max_exposures_per_task ?? 4,
    {
      ...input,
      workflow_id: input.workflow_id ?? `workflow:${input.task_id ?? "task:fixed"}`,
      producer_run_id: `${input.outer_run_id}-artifacts`,
      max_depth: input.max_depth ?? 2,
    },
  );
  enterPromotion(fixture, input.wave_id);
  sealFinalistProducer(fixture);
  fixtures.set(key, fixture);
  return fixture;
}
