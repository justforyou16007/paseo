import { createChildContract } from "./helpers/child-contract.js";
import { bridgeFixture } from "./helpers/recursive-fixture.js";
import { sealWikiWorkerManifest, wikiWorkerManifestPath } from "../src/tools/research-wiki.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBaselineScope } from "../src/tools/baseline-scope.js";
import { createResourceInventory } from "../src/tools/resource-inventory.js";
import { materializeBridgeChildren, planExperimentBridge } from "../src/tools/experiment-bridge.js";
import {
  canReuseRun,
  acquireRunScope,
  createRootRun,
  createRun,
  computeRunIdentity,
  ensureRun,
  legacyRunStatePath,
  openExistingRun,
  readRunScopeLeaseTokens,
  readRun,
  
  releaseRunScope,
  runJsonPath,
  updateRun,
  writeRun,
  type RunIdentityInput,
  type RunRecord,
} from "../src/tools/run-contract.js";
import {
  createWorkflowRuntimeState,
  readWorkflowRuntimeState,
  saveCycleWikiHead,
  writeCycleFile,
  writeWorkflowPhaseHistory,
  workflowRuntimePath,
  writeWorkflowRuntimeState,
} from "../src/tools/workflow-state.js";
import {
  workflowSummaryPath,
  writeWorkflowSummary,
} from "../src/tools/workflow-summary.js";
import { requireInteger, validateOwnerLimits } from "../src/tools/workflow-spec.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aris-a2-identity-"));
}

function material(plan: string): RunIdentityInput {
  return {
    charter_sha256: "charter:a2",
    input_snapshot_sha256: "snapshot:a2",
    execution_plan_sha256: plan,
    // A charter built from this run states the same code baseline, and a
    // charter only accepts a real digest there.
    code_baseline_sha256: "c0de".repeat(16),
    policy_revision: "policy:a2",
  };
}

function bridgeChild(root: string, parentRunId: string, positionId = "main"): RunRecord {
  return createChildContract(root, parentRunId, `run-${crypto.randomUUID()}`, positionId);
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  return "";
}

function scopeLocks(root: string): Array<Record<string, unknown>> {
  const filePath = path.join(root, ".aris", "run-scope-locks.json");
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Array<Record<string, unknown>>;
}

function waitForFile(filePath: string): void {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    // The child writes the marker after its lease is durable.
  }
  assert.equal(fs.existsSync(filePath), true);
}

function freshResult(
  code: string,
  root: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { cwd: process.cwd(), env: { ...process.env, ARIS_ROOT: root, ...extraEnv }, encoding: "utf8" },
  );
}

function freshRunStateCommand(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src/tools/run-state.ts"), ...args],
    { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" },
  );
}

function workflowCommand(root: string, runId: string, extra: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    "--import", "tsx", path.join(process.cwd(), "src/tools/workflow-cli.ts"),
    "status", "--execution-root", root, "--project", root, "--run", runId, ...extra,
  ], { encoding: "utf8" });
}

test("workflow CLI rejects a missing canonical contract instead of defaulting identity", () => {
  const root = tmpDir();
  try {
    const start = spawnSync(process.execPath, [
      "--import", "tsx", path.join(process.cwd(), "src/tools/workflow-cli.ts"),
      "start", "--execution-root", root, "--project", root, "--run", "missing",
      "--freeze", path.join(root, "freeze.json"),
      "--tester-agent-config", path.join(root, "tester-agent.json"),
    ], { encoding: "utf8" });
    for (const result of [workflowCommand(root, "missing"), start]) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /RUN_CONTRACT_NOT_FOUND: canonical run.json is required/);
      assert.equal(result.stdout, "");
    }
    assert.equal(fs.existsSync(runJsonPath(root, "missing")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow CLI reads a grandchild's parent, depth and scope from run.json without rewriting it", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root, run_id: "cli-root",   
      charter_sha256: "a".repeat(64), input_snapshot_sha256: "b".repeat(64),
      execution_plan_sha256: "c".repeat(64), code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:cli",
    });
    const parent = bridgeChild(root, "cli-root");
    const child = bridgeChild(root, parent.run_id);
    const runtime = createWorkflowRuntimeState({
      execution_root: root, project_root: root, outer_run_id: child.run_id,
      task_id: "task:cli", workflow_id: "workflow:cli",
    });
    writeWorkflowRuntimeState(root, runtime);
    const before = fs.readFileSync(runJsonPath(root, child.run_id));
    const result = workflowCommand(root, child.run_id);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout).runtime;
    assert.deepEqual({
      parent_run_id: actual.parent_run_id, depth: actual.depth, scope_path: actual.scope_path,
        
    }, {
      parent_run_id: parent.run_id, depth: 2, scope_path: child.scope_path,
        
    });
    assert.deepEqual(fs.readFileSync(runJsonPath(root, child.run_id)), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("both CLIs reject all six removed identity options before reading a contract", () => {
  const root = tmpDir();
  try {
    for (const flag of ["--parent-run-id", "--depth", "--scope-path", "--execution", "--max-depth", "--depth-budget"]) {
      for (const result of [
        workflowCommand(root, "missing", [flag, "3"]),
        freshRunStateCommand(["start", root, "missing", "--phases", "init", flag, "3"]),
      ]) {
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(`unknown option '${flag}'`), result.stderr);
        assert.equal(result.stdout, "");
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("depth-3 workflow and research children carry depth without carrying limits", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "workflow-0",
      
      
      
      charter_sha256: "a".repeat(64),
      input_snapshot_sha256: "c".repeat(64),
      execution_plan_sha256: "b".repeat(64),
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:a2",
    });
    let workflowParentRunId = "workflow-0";
    for (let index = 0; index <= 3; index += 1) {
      const child = index === 0 ? null : bridgeChild(root, workflowParentRunId);
      const runId = child?.run_id ?? "workflow-0";
      const runtime = createWorkflowRuntimeState({
        execution_root: root,
        project_root: root,
        outer_run_id: runId,
        ...(child === null ? {} : { parent_run_id: child.parent_run_id }),
        ...(index === 0 ? {   } : {}),
        task_id: "task:a2",
        workflow_id: "workflow:a2",
      });
      writeWorkflowRuntimeState(root, runtime);
      const recovered = readWorkflowRuntimeState(root, runId);
      assert.equal(recovered.run_id, runId);
      assert.equal(recovered.depth, index);
      assert.equal(recovered.max_depth, undefined);
      assert.equal(recovered.depth_budget, undefined);
      assert.equal(recovered.execution, undefined);
      assert.ok(fs.existsSync(runJsonPath(root, runId)));
      assert.ok(fs.existsSync(workflowRuntimePath(root, runId)));
      workflowParentRunId = runId;
    }

    let parentRunId = "workflow-0";
    for (let index = 0; index <= 2; index += 1) {
      // A research child is a contract plus the Wiki binding it is dispatched
      // against. The parent writes nothing else about it, so the only thing
      // that can carry depth downwards is the contract itself.
      const childRunId = bridgeChild(root, parentRunId, "module").run_id;
      const snapshotRef = path.relative(
        root,
        path.join(path.dirname(runJsonPath(root, childRunId)), "input-snapshot.json"),
      );
      const binding = sealWikiWorkerManifest({
        project_root: root,
        run_id: childRunId,
        worker: "idea-discovery",
        input_snapshot: {
          ref: snapshotRef,
          sha256: crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(root, snapshotRef)))
            .digest("hex"),
        },
      });
      assert.equal(binding.run_id, childRunId);
      assert.equal(binding.scope, `runs/${childRunId}`);
      assert.ok(fs.existsSync(wikiWorkerManifestPath(root, childRunId)));
      assert.equal(readRun(root, childRunId).depth, index + 1);
      assert.equal(readRun(root, childRunId).execution, undefined);
      assert.ok(readRun(root, parentRunId).child_run_ids.includes(childRunId));
      assert.equal(readRun(root, childRunId).max_depth, undefined);
      assert.equal(readRun(root, childRunId).depth_budget, undefined);
      if (index === 2) {
        // The binding is sealed once. Re-dispatching the same run into a
        // different scope is refused rather than silently re-pointed.
        assert.throws(
          () =>
            sealWikiWorkerManifest({
              project_root: root,
              run_id: childRunId,
              worker: "idea-discovery",
              scope: "runs/changed",
              input_snapshot: null,
            }),
          /WIKI_SCOPE_CONFLICT/,
        );
      }
      parentRunId = childRunId;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("phase-1 run boundaries open existing contracts and create roots only", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "existing-root",
      
      
      
      identity: material("existing-root"),
    });

    const opened = openExistingRun({
      project_root: root,
      run_id: "existing-root",
      parent_run_id: null,
      depth: 0,
      scope_path: "/",
      
      
      
    });
    assert.equal(opened.run_id, "existing-root");
    assert.equal(
      errorCode(() =>
        openExistingRun({
          project_root: root,
          run_id: "existing-root",
          parent_run_id: "unexpected-parent",
        }),
      ),
      "RUN_IDENTITY_CONFLICT",
    );

    const missingRoot = tmpDir();
    try {
      const missingPath = runJsonPath(missingRoot, "missing-open");
      assert.equal(
        errorCode(() =>
          openExistingRun({
            project_root: missingRoot,
            run_id: "missing-open",
            
            scope_path: "/missing-open",
            identity: material("missing-open"),
          }),
        ),
        "RUN_CONTRACT_NOT_FOUND",
      );
      assert.equal(fs.existsSync(missingPath), false);
    } finally {
      fs.rmSync(missingRoot, { recursive: true, force: true });
    }

    assert.equal(
      errorCode(() =>
        createRootRun({
          project_root: root,
          run_id: "illegal-child",
          
          identity: material("illegal-child"),
          parent_run_id: "existing-root",
        } as never),
      ),
      "UNKNOWN_FIELD",
    );
    assert.equal(fs.existsSync(runJsonPath(root, "illegal-child")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a run can acquire children after creation without a node type", () => { const root = tmpDir(); try { const parent = createRootRun({ project_root: root, run_id: "parent", ...material("first") }); assert.equal(Object.hasOwn(parent, "execution"), false); const before = parent.run_identity; const child = bridgeChild(root, parent.run_id); assert.equal(readRun(root, parent.run_id).child_run_ids[0], child.run_id); assert.notEqual(readRun(root, parent.run_id).run_identity, before); } finally { fs.rmSync(root, {recursive:true,force:true}); } });

test("a changed grandchild identity invalidates the ancestor cache", () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "ancestor",
      scope_path: "/tree",
      
      
      identity: material("ancestor-plan"),
    });
    createRun({
      project_root: root,
      run_id: "parent",
      parent_run_id: "ancestor",
      scope_path: "/tree/parent",
      
      identity: material("parent-plan"),
    });
    createRun({
      project_root: root,
      run_id: "grandchild",
      parent_run_id: "parent",
      scope_path: "/tree/parent/child",
      
      identity: material("child-plan-v1"),
    });

    const oldAncestorIdentity = readRun(root, "ancestor").run_identity;
    assert.equal(canReuseRun(root, "ancestor", oldAncestorIdentity), true);

    updateRun(root, "grandchild", { execution_plan_sha256: "child-plan-v2" });

    assert.notEqual(readRun(root, "ancestor").run_identity, oldAncestorIdentity);
    assert.equal(canReuseRun(root, "ancestor", oldAncestorIdentity), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing run id cannot silently accept different identity material", () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "same-run",
      scope_path: "/identity",
      
      identity: material("plan-v1"),
    });
    const sameRunPath = runJsonPath(root, "same-run");
    const sameRunBefore = fs.readFileSync(sameRunPath, "utf8");
    assert.equal(
      errorCode(() =>
        createRun({
          project_root: root,
          run_id: "same-run",
          scope_path: "/identity",
          
          identity: material("plan-v2"),
        }),
      ),
      "RUN_IDENTITY_CONFLICT",
    );
    assert.equal(fs.readFileSync(sameRunPath, "utf8"), sameRunBefore);
    assert.equal(
      errorCode(() =>
        ensureRun({
          project_root: root,
          run_id: "same-run",
          identity: material("plan-v3"),
        }),
      ),
      "RUN_IDENTITY_CONFLICT",
    );
    assert.equal(fs.readFileSync(sameRunPath, "utf8"), sameRunBefore);
    assert.equal(readRun(root, "same-run").identity_material.execution_plan_sha256, "plan-v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("identity omission, null, literal unset, and nested fields have distinct meanings", () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "missing-policy",
      scope_path: "/identity/missing",
      identity: {
        charter_sha256: "charter",
        input_snapshot_sha256: "snapshot",
        execution_plan_sha256: "plan",
        code_baseline_sha256: "code",
      },
    });
    const missingPolicyPath = runJsonPath(root, "missing-policy");
    const missingPolicyBefore = fs.readFileSync(missingPolicyPath, "utf8");
    assert.notEqual(
      readRun(root, "missing-policy").identity_material.policy_revision,
      "unset",
    );
    assert.equal(
      errorCode(() =>
        ensureRun({
          project_root: root,
          run_id: "missing-policy",
          identity: { policy_revision: null as unknown as string },
        }),
      ),
      "INVALID_RUN_IDENTITY",
    );
    assert.equal(fs.readFileSync(missingPolicyPath, "utf8"), missingPolicyBefore);
    assert.equal(
      errorCode(() =>
        ensureRun({
          project_root: root,
          run_id: "missing-policy",
          identity: { policy_revision: "unset" },
        }),
      ),
      "RUN_IDENTITY_CONFLICT",
    );
    assert.equal(fs.readFileSync(missingPolicyPath, "utf8"), missingPolicyBefore);

    createRun({
      project_root: root,
      run_id: "literal-unset",
      scope_path: "/identity/literal",
      identity: { ...material("unset-plan"), policy_revision: "unset" },
    });
    const literalUnsetPath = runJsonPath(root, "literal-unset");
    const literalUnsetBefore = fs.readFileSync(literalUnsetPath, "utf8");
    assert.equal(readRun(root, "literal-unset").identity_material.policy_revision, "unset");
    assert.equal(
      errorCode(() =>
        ensureRun({
          project_root: root,
          run_id: "literal-unset",
          identity: { policy_revision: "policy" },
        }),
      ),
      "RUN_IDENTITY_CONFLICT",
    );
    assert.equal(fs.readFileSync(literalUnsetPath, "utf8"), literalUnsetBefore);
    const nestedConflictBefore = fs.readFileSync(literalUnsetPath, "utf8");

    assert.equal(
      errorCode(() =>
        ensureRun({
          project_root: root,
          run_id: "literal-unset",
          charter_sha256: "top-level-change",
          identity: { charter_sha256: "charter:a2" },
        }),
      ),
      "RUN_IDENTITY_CONFLICT",
    );
    assert.equal(fs.readFileSync(literalUnsetPath, "utf8"), nestedConflictBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parent and scope remain immutable after removing structural limits", () => { const root=tmpDir();try{const parent=createRootRun({project_root:root,run_id:"parent",...material("parent")});const child=bridgeChild(root,parent.run_id);assert.equal(errorCode(()=>updateRun(root,child.run_id,{parent_run_id:null})),"RUN_IDENTITY_CONFLICT");assert.equal(errorCode(()=>updateRun(root,child.run_id,{scope_path:"/other"})),"RUN_IDENTITY_CONFLICT");assert.equal(errorCode(()=>updateRun(root,child.run_id,{depth:99})),"RUN_IDENTITY_CONFLICT");}finally{fs.rmSync(root,{recursive:true,force:true});} });

test("invalid observed depth fails before writing a contract", () => { const root=tmpDir();try{assert.equal(errorCode(()=>createRun({project_root:root,run_id:"invalid",depth:-1})),"INVALID_VALUE");assert.equal(fs.existsSync(runJsonPath(root,"invalid")),false);assert.deepEqual(scopeLocks(root),[]);}finally{fs.rmSync(root,{recursive:true,force:true});} });

test("observed depth rejects unsafe integers before creating a contract", () => { const root=tmpDir();try{for(const depth of [NaN,Infinity,-Infinity,0.5,Number.MAX_SAFE_INTEGER+1]){assert.equal(errorCode(()=>requireInteger(depth,"depth",0)),"INVALID_VALUE");assert.equal(errorCode(()=>createRun({project_root:root,run_id:"invalid",depth})),"INVALID_VALUE");assert.equal(fs.existsSync(runJsonPath(root,"invalid")),false);}}finally{fs.rmSync(root,{recursive:true,force:true});} });

test("owner limit parser accepts each configured ceiling and rejects the next integer", () => {
  const ceilings = {
    max_nodes: 100,
    max_edges: 800,
    max_fan_out_per_node: 4,
    max_unrolled_cycles: 3,
    max_jobs_per_candidate: 400,
  } as const;
  const base = {
    revision: "limits:test",
    ...ceilings,
    max_compute_per_candidate: { amount: 10, unit: "gpu_hours" },
  };
  for (const [field, ceiling] of Object.entries(ceilings) as Array<[
    keyof typeof ceilings,
    number,
  ]>) {
    const accepted = validateOwnerLimits({ ...base, [field]: ceiling });
    assert.equal(accepted[field], ceiling);
    assert.equal(
      errorCode(() => validateOwnerLimits({ ...base, [field]: ceiling + 1 })),
      "INVALID_VALUE",
    );
  }
});

test("writeRun rolls back post-persist failures and reports cleanup failures", () => {
  const root = tmpDir();
  try {
    const record = createRootRun({
      project_root: root,
      run_id: "post-persist-write",
      
      
      
      identity: material("post-persist"),
    });
    const filePath = runJsonPath(root, record.run_id);
    // Nonstandard whitespace makes a byte-for-byte restore distinguishable from reserialization.
    fs.writeFileSync(filePath, JSON.stringify(record) + "\n\n");
    const before = fs.readFileSync(filePath);
    const locksBefore = scopeLocks(root);
    const invalid = {
      ...record,
      run_contract_sha256: "",
      child_run_ids: ["missing-child-for-write"],
    };
    const originalRename = fs.renameSync;
    const persistedChildren: string[][] = [];
    fs.renameSync = ((source, target) => {
      originalRename(source, target);
      if (String(target) === filePath)
        persistedChildren.push(JSON.parse(fs.readFileSync(filePath, "utf8")).child_run_ids);
    }) as typeof fs.renameSync;
    try {
      assert.equal(errorCode(() => writeRun(root, invalid)), "RUN_NOT_FOUND");
    } finally {
      fs.renameSync = originalRename;
    }
    assert.deepEqual(persistedChildren, [["missing-child-for-write"], []]);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.deepEqual(scopeLocks(root), locksBefore);
    assert.deepEqual(readRun(root, record.run_id), record);

    let replacements = 0;
    fs.renameSync = ((source, target) => {
      if (String(target) === filePath) {
        replacements += 1;
        if (replacements === 2) throw new Error("forced run rollback failure");
      }
      return originalRename(source, target);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => writeRun(root, invalid), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "RUN_UPDATE_ROLLBACK_FAILED");
        assert.match(error.message, /missing-child-for-write/);
        assert.match(error.message, /forced run rollback failure/);
        return true;
      });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(replacements, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).child_run_ids, [
      "missing-child-for-write",
    ]);
    assert.deepEqual(scopeLocks(root), locksBefore);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("child identities participate in every run identity", () => { const empty=computeRunIdentity({...material("plan"),child_run_identities:[]}); const one=computeRunIdentity({...material("plan"),child_run_identities:["child"]}); assert.notEqual(empty,one); assert.equal(computeRunIdentity({...material("plan"),child_run_identities:["b","a"]}),computeRunIdentity({...material("plan"),child_run_identities:["a","b"]})); });

test("scope leases require their token and keep ownership until the last release", async () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "same",
      scope_path: "/same",
      identity: material("same"),
    });
    const seedToken = readRunScopeLeaseTokens({
      project_root: root,
      run_id: "same",
      scope_path: "/same",
    })[0]!;
    releaseRunScope({
      project_root: root,
      run_id: "same",
      scope_path: "/same",
      lease_token: seedToken,
    });
    createRun({
      project_root: root,
      run_id: "other",
      scope_path: "/same",
      identity: material("other"),
    });
    const otherSeedToken = readRunScopeLeaseTokens({
      project_root: root,
      run_id: "other",
      scope_path: "/same",
    })[0]!;
    releaseRunScope({
      project_root: root,
      run_id: "other",
      scope_path: "/same",
      lease_token: otherSeedToken,
    });
    const first = acquireRunScope({ project_root: root, run_id: "same", scope_path: "/same" });
    const second = acquireRunScope({ project_root: root, run_id: "same", scope_path: "/same" });
    const third = acquireRunScope({ project_root: root, run_id: "same", scope_path: "/same" });
    assert.deepEqual(readRunScopeLeaseTokens({
      project_root: root,
      run_id: "same",
      scope_path: "/same",
    }).length, 3);
    assert.equal(
      errorCode(() => first.releaseAll([first.lease_token], true)),
      "RUN_SCOPE_LEASE_REQUIRED",
    );
    assert.equal(scopeLocks(root)[0]?.lease_tokens
      ? (scopeLocks(root)[0]!.lease_tokens as string[]).length
      : 0, 3);
    assert.equal(
      errorCode(() =>
        acquireRunScope({ project_root: root, run_id: "same", scope_path: "/other" }),
      ),
      "RUN_SCOPE_ACTIVE",
    );
    assert.equal(
      errorCode(() =>
        acquireRunScope({
          project_root: root,
          run_id: "missing-parent-child",
          parent_run_id: "missing-parent",
          scope_path: "/missing-parent/child",
        }),
      ),
      "RUN_CONTRACT_NOT_FOUND",
    );
    assert.equal(
      errorCode(() =>
        acquireRunScope({
          project_root: root,
          run_id: "missing-parent-child-with-bypass",
          parent_run_id: "missing-parent",
          scope_path: "/missing-parent/child-with-bypass",
          allow_missing_parent: true,
        } as never),
      ),
      "RUN_CONTRACT_NOT_FOUND",
    );
    assert.equal(
      errorCode(() =>
        acquireRunScope({ project_root: root, run_id: "other", scope_path: "/same" }),
      ),
      "RUN_SCOPE_ACTIVE",
    );
    assert.equal(
      errorCode(() =>
        releaseRunScope({
          project_root: root,
          run_id: "same",
          scope_path: "/same",
          lease_token: "forged-token",
        }),
      ),
      "RUN_SCOPE_LEASE_REQUIRED",
    );
    assert.equal(
      errorCode(() =>
        releaseRunScope({
          project_root: root,
          run_id: "same",
          scope_path: "/other",
          lease_token: first.lease_token,
        }),
      ),
      "RUN_SCOPE_NOT_FOUND",
    );
    assert.equal(
      errorCode(() =>
        releaseRunScope({
          project_root: root,
          run_id: "same",
          scope_path: "/same",
          lease_token: first.lease_token,
          release_all: true,
        } as never),
      ),
      "RUN_SCOPE_RELEASE_ALL_FORBIDDEN",
    );
    assert.equal(
      (scopeLocks(root)[0]!.lease_tokens as string[]).length,
      3,
    );
    first.release();
    assert.equal((scopeLocks(root)[0]!.lease_tokens as string[]).length, 2);
    assert.equal(errorCode(() => first.release()), "RUN_SCOPE_LEASE_RELEASED");
    second.release();
    assert.equal((scopeLocks(root)[0]!.lease_tokens as string[]).length, 1);
    third.release();
    assert.deepEqual(scopeLocks(root), []);
    assert.equal(
      errorCode(() =>
        releaseRunScope({
          project_root: root,
          run_id: "same",
          scope_path: "/same",
          lease_token: third.lease_token,
        }),
      ),
      "RUN_SCOPE_NOT_FOUND",
    );

    const marker = path.join(root, "worker-lease.json");
    createRun({
      project_root: root,
      run_id: "worker",
      scope_path: "/cross",
      identity: material("worker"),
    });
    const workerSeed = readRunScopeLeaseTokens({
      project_root: root,
      run_id: "worker",
      scope_path: "/cross",
    })[0]!;
    releaseRunScope({
      project_root: root,
      run_id: "worker",
      scope_path: "/cross",
      lease_token: workerSeed,
    });
    const workerCode = `
      import fs from "node:fs";
      import { acquireRunScope } from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
      const lease = acquireRunScope({ project_root: process.env.ARIS_ROOT, run_id: "worker", scope_path: "/cross" });
      fs.writeFileSync(process.env.ARIS_MARKER, JSON.stringify({ token: lease.lease_token }));
      setInterval(() => {}, 100);
    `;
    const worker = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", workerCode],
      {
        cwd: process.cwd(),
        env: { ...process.env, ARIS_ROOT: root, ARIS_MARKER: marker },
        stdio: "ignore",
      },
    );
    waitForFile(marker);
    const workerToken = (JSON.parse(fs.readFileSync(marker, "utf8")) as { token: string }).token;
    assert.equal(
      errorCode(() =>
        releaseRunScope({
          project_root: root,
          run_id: "worker",
          scope_path: "/cross",
          lease_token: workerToken,
        }),
      ),
      "RUN_SCOPE_OWNER_MISMATCH",
    );
    worker.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (worker.exitCode !== null) resolve();
      else worker.once("exit", () => resolve());
    });
    createRun({
      project_root: root,
      run_id: "after-worker",
      scope_path: "/cross",
      identity: material("after-worker"),
    });
    const afterWorkerSeed = readRunScopeLeaseTokens({
      project_root: root,
      run_id: "after-worker",
      scope_path: "/cross",
    })[0]!;
    releaseRunScope({
      project_root: root,
      run_id: "after-worker",
      scope_path: "/cross",
      lease_token: afterWorkerSeed,
    });
    const afterWorker = acquireRunScope({
      project_root: root,
      run_id: "after-worker",
      scope_path: "/cross",
    });
    afterWorker.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("depth five is observable and does not prevent another generation", () => { const root=tmpDir(); try { let run=createRootRun({project_root:root,run_id:"root",...material("root")}); for(let depth=1;depth<=6;depth++){run=bridgeChild(root,run.run_id,"step");assert.equal(run.depth,depth);assert.equal(Object.hasOwn(run,"max_depth"),false);assert.equal(Object.hasOwn(run,"depth_budget"),false);} } finally {fs.rmSync(root,{recursive:true,force:true});} });

test("opening a run rejects identity and scope conflicts", () => { const root=tmpDir();try{const parent=createRootRun({project_root:root,run_id:"root",...material("one")});assert.equal(errorCode(()=>openExistingRun({project_root:root,run_id:parent.run_id,scope_path:"/other"})),"RUN_IDENTITY_CONFLICT");assert.equal(errorCode(()=>openExistingRun({project_root:root,run_id:parent.run_id,...material("two")})),"RUN_IDENTITY_CONFLICT");}finally{fs.rmSync(root,{recursive:true,force:true});} });

test("child scopes must be strict descendants, and omitted scopes derive from the parent", () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "scope-root",
      scope_path: "/scope-root",
      
      
      identity: material("scope-root"),
    });
    for (const scopePath of ["/scope-root", "/", "/outside"]) {
      assert.equal(
        errorCode(() =>
          createRun({
            project_root: root,
            run_id: `invalid-${scopePath.replaceAll("/", "") || "root"}`,
            parent_run_id: "scope-root",
            scope_path: scopePath,
            
            identity: material(`invalid-${scopePath}`),
          }),
        ),
        "RUN_SCOPE_ACTIVE",
      );
    }

    const child = createRun({
      project_root: root,
      run_id: "derived-child",
      parent_run_id: "scope-root",
      
      identity: material("derived-child"),
    });
    assert.equal(child.scope_path, "/scope-root/derived-child");
    assert.equal(readRun(root, child.run_id).scope_path, child.scope_path);

    assert.equal(
      errorCode(() =>
        createRun({
          project_root: root,
          run_id: "sibling-same-scope",
          parent_run_id: "scope-root",
          scope_path: child.scope_path,
          
          identity: material("sibling-same-scope"),
        }),
      ),
      "RUN_SCOPE_ACTIVE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-overlapping scopes run together and an overlapping request is rejected", () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "training",
      scope_path: "/training",
      identity: material("training"),
    });
    createRun({
      project_root: root,
      run_id: "evaluation",
      scope_path: "/evaluation",
      identity: material("evaluation"),
    });
    assert.equal(
      errorCode(() =>
        createRun({
          project_root: root,
          run_id: "training-second",
          scope_path: "/training",
          identity: material("training-second"),
        }),
      ),
      "RUN_SCOPE_ACTIVE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the reader normalizes an old outer_run_id file without writing it back", () => {
  const root = tmpDir();
  try {
    const identity = material("legacy-plan");
    const runIdentity = computeRunIdentity(identity);
    const filePath = runJsonPath(root, "legacy-child");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        schema_version: 1,
        run_id: "legacy-child",
        outer_run_id: "legacy-parent",
        depth: 1,
        scope_path: "/legacy/child",
        
        run_identity: runIdentity,
        output_hashes: {},
        identity_material: identity,
        child_run_ids: [],
      })}\n`,
    );

    const normalized = readRun(root, "legacy-child");
    assert.equal(normalized.parent_run_id, "legacy-parent");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    assert.equal(raw.outer_run_id, "legacy-parent");
    assert.equal(raw.parent_run_id, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy phase files are rejected explicitly, and conflicting parent fields are rejected", () => {
  const root = tmpDir();
  try {
    const phasePath = legacyRunStatePath(root, "legacy-phase");
    fs.mkdirSync(path.dirname(phasePath), { recursive: true });
    fs.writeFileSync(
      phasePath,
      `${JSON.stringify({
        run_id: "legacy-phase",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        phases: [],
      })}\n`,
    );
    const lockPath = path.join(root, ".aris", "run-scope-locks.json");
    const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const phaseBefore = fs.readFileSync(phasePath, "utf8");
    assert.equal(errorCode(() => readRun(root, "legacy-phase")), "RUN_CONTRACT_NOT_FOUND");
    assert.equal(errorCode(() => readRun(root, "never-created")), "RUN_NOT_FOUND");
    assert.equal(fs.readFileSync(phasePath, "utf8"), phaseBefore);
    assert.equal(fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null, lockBefore);

    const identity = material("conflicting-parent");
    const conflictPath = runJsonPath(root, "conflicting-parent");
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(
      conflictPath,
      `${JSON.stringify({
        schema_version: 1,
        run_id: "conflicting-parent",
        parent_run_id: "canonical-parent",
        outer_run_id: "legacy-parent",
        depth: 1,
        scope_path: "/conflict/child",
        
        run_identity: computeRunIdentity(identity),
        output_hashes: {},
        identity_material: identity,
        child_run_ids: [],
      })}\n`,
    );
    assert.equal(errorCode(() => readRun(root, "conflicting-parent")), "IDENTITY_MISMATCH");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startRun rejects malformed legacy phases before creating contract or scope lease", () => {
  const baseState = (runId: string) => ({
    run_id: runId,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    phases: [
      {
        phase: "init",
        status: "pending",
        artifact: null,
        verdict_id: null,
        reviewer: null,
        updated: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const cases = [
    {
      name: "json-damaged",
      makeContents: () => "{not-json}\n",
      code: "CORRUPT_RUN_STATE",
      detail: /corrupt JSON/,
    },
    {
      name: "run-id-mismatch",
      makeContents: (runId: string) => JSON.stringify({ ...baseState(runId), run_id: "different" }) + "\n",
      code: "IDENTITY_MISMATCH",
      detail: /run_id mismatch/,
    },
    {
      name: "top-level-unknown",
      makeContents: (runId: string) =>
        JSON.stringify({ ...baseState(runId), unexpected: true }) + "\n",
      code: "UNKNOWN_FIELD",
      detail: /unknown run-state top-level field 'unexpected'/,
    },
    {
      name: "phase-unknown",
      makeContents: (runId: string) =>
        JSON.stringify({
          ...baseState(runId),
          phases: [{ ...baseState(runId).phases[0], extra: "unexpected" }],
        }) + "\n",
      code: "UNKNOWN_FIELD",
      detail: /unknown run-state phase field 'extra'/,
    },
    {
      name: "bad-status",
      makeContents: (runId: string) =>
        JSON.stringify({
          ...baseState(runId),
          phases: [{ ...baseState(runId).phases[0], status: "not-a-status" }],
        }) + "\n",
      code: "CORRUPT_RUN_STATE",
      detail: /unknown status/,
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const root = tmpDir();
    try {
      const runId = `invalid-phase-${testCase.name}-${index}`;
      const phasePath = legacyRunStatePath(root, runId);
      fs.mkdirSync(path.dirname(phasePath), { recursive: true });
      const phaseBefore = testCase.makeContents(runId);
      fs.writeFileSync(phasePath, phaseBefore);

      const started = freshRunStateCommand(["start", root, runId, "--phases", "init"]);
      assert.equal(started.status, 1);
      assert.match(started.stderr, new RegExp(testCase.code));
      assert.match(started.stderr, testCase.detail);

      const snapshot = freshResult(
        `import fs from "node:fs";
import path from "node:path";
import { legacyRunStatePath, runJsonPath } from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
const root = process.env.ARIS_ROOT;
const runId = ${JSON.stringify(runId)};
const lockPath = path.join(root, ".aris", "run-scope-locks.json");
const records = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : [];
console.log(JSON.stringify({
  contract: fs.existsSync(runJsonPath(root, runId)),
  phase: fs.readFileSync(legacyRunStatePath(root, runId), "utf8"),
  lockBytes: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null,
  records: records.length,
  tokens: records.reduce((total, record) => total + (record.lease_tokens?.length ?? 0), 0),
}));`,
        root,
      );
      assert.equal(snapshot.status, 0);
      assert.deepEqual(JSON.parse(snapshot.stdout.trim()), {
        contract: false,
        phase: phaseBefore,
        lockBytes: null,
        records: 0,
        tokens: 0,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("startRun rejects a missing contract without changing valid legacy phases or scope leases", () => {
  const root = tmpDir();
  try {
    const runId = "valid-phase-bootstrap";
    const phasePath = legacyRunStatePath(root, runId);
    fs.mkdirSync(path.dirname(phasePath), { recursive: true });
    const phaseBefore = `${JSON.stringify({
      run_id: runId,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      phases: [
        {
          phase: "init",
          status: "pending",
          artifact: null,
          verdict_id: null,
          reviewer: null,
          updated: "2026-01-01T00:00:00Z",
        },
      ],
    })}\n`;
    fs.writeFileSync(phasePath, phaseBefore);

    const started = freshRunStateCommand(["start", root, runId, "--phases", "init"]);
    const records = scopeLocks(root);
    assert.deepEqual({
      status: started.status,
      code: started.stderr.match(/RUN_CONTRACT_NOT_FOUND/)?.[0] ?? null,
      contract: fs.existsSync(runJsonPath(root, runId)),
      phaseUnchanged: fs.readFileSync(phasePath, "utf8") === phaseBefore,
      records: records.length,
      tokens: records.reduce((total, record) =>
        total + ((record.lease_tokens as string[] | undefined)?.length ?? 0), 0),
    }, {
      status: 1,
      code: "RUN_CONTRACT_NOT_FOUND",
      contract: false,
      phaseUnchanged: true,
      records: 0,
      tokens: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const conflict of [false, true]) {
  test(conflict
    ? "run-state CLI rejects removed max-depth without writing phases or changing a B contract"
    : "startRun opens a B child contract and writes only phase state", () => {
    const root = tmpDir();
    try {
      createRootRun({
        project_root: root,
        run_id: "start-parent",
        
        
        
        charter_sha256: "a".repeat(64),
        input_snapshot_sha256: "c".repeat(64),
        execution_plan_sha256: "b".repeat(64),
        code_baseline_sha256: "a".repeat(64),
        policy_revision: "policy:a2",
      });
      const child = bridgeChild(root, "start-parent");
      const contractPath = runJsonPath(root, child.run_id);
      const contractBefore = fs.readFileSync(contractPath, "utf8");
      const lockPath = path.join(root, ".aris", "run-scope-locks.json");
      const locksBefore = fs.readFileSync(lockPath, "utf8");
      const phasePath = legacyRunStatePath(root, child.run_id);
      const started = freshRunStateCommand([
        "start", root, child.run_id, "--phases", "init",
        ...(conflict ? ["--max-depth", "99"] : []),
      ]);
      const phase = fs.existsSync(phasePath)
        ? JSON.parse(fs.readFileSync(phasePath, "utf8"))
        : null;
      assert.deepEqual({
        status: started.status,
        code: started.stderr.match(/unknown option '--max-depth'/)?.[0] ?? null,
        phase: phase === null ? null : {
          run_id: phase.run_id,
          phases: phase.phases,
        },
        contractUnchanged: fs.readFileSync(contractPath, "utf8") === contractBefore,
        scopeUnchanged: fs.readFileSync(lockPath, "utf8") === locksBefore,
      }, {
        status: conflict ? 1 : 0,
        code: conflict ? "unknown option '--max-depth'" : null,
        phase: conflict ? null : {
          run_id: child.run_id,
          phases: [{
            phase: "init", status: "pending", artifact: null,
            verdict_id: null, reviewer: null, updated: phase?.updated,
          }],
        },
        contractUnchanged: true,
        scopeUnchanged: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("public acquireRunScope rejects a missing contract before writing a token", () => {
  const root = tmpDir();
  try {
    const lockPath = path.join(root, ".aris", "run-scope-locks.json");
    const beforeBytes = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const beforeTokens = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    assert.equal(beforeTokens, 0);
    const result = freshResult(
      `import { acquireRunScope } from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
try { acquireRunScope({ project_root: process.env.ARIS_ROOT, run_id: "missing-contract", scope_path: "/missing-contract" }); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    const afterTokens = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    assert.equal(afterTokens, 0);
    const afterBytes = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    assert.equal(afterBytes, beforeBytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow, module, phase, and summary entry points reject a missing canonical run contract", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "reader-parent",
      
      
      
      charter_sha256: "a".repeat(64),
      input_snapshot_sha256: "c".repeat(64),
      execution_plan_sha256: "b".repeat(64),
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:a2",
    });
    const workflowRunId = bridgeChild(root, "reader-parent").run_id;
    const runtime = createWorkflowRuntimeState({
      execution_root: root,
      project_root: root,
      outer_run_id: workflowRunId,
      parent_run_id: "reader-parent",
      
      task_id: "reader-task",
      workflow_id: "reader-workflow",
    });
    writeWorkflowRuntimeState(root, runtime);
    writeWorkflowPhaseHistory(root, workflowRunId, runtime.phase_history);
    writeCycleFile(root, workflowRunId, 1, "gate-probe.json", { state: "before" });
    saveCycleWikiHead(root, workflowRunId, 1, null, "a".repeat(64));
    writeWorkflowSummary({ project_root: root, outer_run_id: workflowRunId });
    const moduleRunId = bridgeChild(root, "reader-parent", "module").run_id;
    const phaseRunId = bridgeChild(root, "reader-parent", "phase").run_id;
    const phaseContractBefore = fs.readFileSync(runJsonPath(root, phaseRunId), "utf8");
    // start initializes phase state only; B has already created its contract.
    const started = freshRunStateCommand(["start", root, phaseRunId, "--phases", "init"]);
    assert.equal(started.status, 0);
    assert.equal(fs.readFileSync(runJsonPath(root, phaseRunId), "utf8"), phaseContractBefore);

    const workflowPath = runJsonPath(root, workflowRunId);
    const modulePath = runJsonPath(root, moduleRunId);
    const phaseContractPath = runJsonPath(root, phaseRunId);
    const phasePath = legacyRunStatePath(root, phaseRunId);
    const workflowDirectory = path.dirname(workflowPath);
    const runtimePath = workflowRuntimePath(root, workflowRunId);
    const historyPath = path.join(workflowDirectory, "phase-history.json");
    const cyclePath = path.join(workflowDirectory, "cycles", "1", "gate-probe.json");
    const wikiPath = path.join(workflowDirectory, "cycles", "1", "wiki-head.json");
    const summaryPath = workflowSummaryPath(root, workflowRunId);
    const phaseBefore = fs.readFileSync(phasePath, "utf8");
    const historyBefore = fs.readFileSync(historyPath, "utf8");
    const cycleBefore = fs.readFileSync(cyclePath, "utf8");
    const wikiBefore = fs.readFileSync(wikiPath, "utf8");
    const summaryBefore = fs.readFileSync(summaryPath, "utf8");
    const scopeLockPath = path.join(root, ".aris", "run-scope-locks.json");
    const scopeLockBefore = fs.existsSync(scopeLockPath)
      ? fs.readFileSync(scopeLockPath, "utf8")
      : null;
    const scopeTokenCountBefore = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    const assertGateStorageUnchanged = (): void => {
      const scopeLockAfter = fs.existsSync(scopeLockPath)
        ? fs.readFileSync(scopeLockPath, "utf8")
        : null;
      const scopeTokenCountAfter = scopeLocks(root).reduce(
        (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
        0,
      );
      assert.equal(scopeTokenCountAfter, scopeTokenCountBefore);
      assert.equal(scopeLockAfter, scopeLockBefore);
    };
    for (const filePath of [workflowPath, modulePath, phaseContractPath]) fs.unlinkSync(filePath);

    const workflowRead = freshResult(
      `import { readWorkflowRuntimeState } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { readWorkflowRuntimeState(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(workflowRead.status, 0);
    assert.equal(workflowRead.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    // The only thing a parent reads out of a child is its result package, and
    // that reader is keyed on the contract before it looks at any file.
    const moduleRead = freshResult(
      `import { readResultPackage } from ${JSON.stringify(path.join(process.cwd(), "src/tools/result-package.ts"))};
try { readResultPackage(process.env.ARIS_ROOT, ${JSON.stringify(moduleRunId)}); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(moduleRead.status, 0);
    assert.equal(moduleRead.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const readContract = freshResult(
      `import { readRun } from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
try { readRun(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(readContract.status, 0);
    assert.equal(readContract.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const readHistory = freshResult(
      `import { readWorkflowPhaseHistory } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { readWorkflowPhaseHistory(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(readHistory.status, 0);
    assert.equal(readHistory.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const writeHistory = freshResult(
      `import { writeWorkflowPhaseHistory } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { writeWorkflowPhaseHistory(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}, ${JSON.stringify(runtime.phase_history)}); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(writeHistory.status, 0);
    assert.equal(writeHistory.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const readCycle = freshResult(
      `import { readCycleFile } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { readCycleFile(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}, 1, "gate-probe.json"); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(readCycle.status, 0);
    assert.equal(readCycle.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const writeCycle = freshResult(
      `import { writeCycleFile } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { writeCycleFile(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}, 1, "gate-probe.json", { state: "before" }); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(writeCycle.status, 0);
    assert.equal(writeCycle.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const writeWiki = freshResult(
      `import { saveCycleWikiHead } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { saveCycleWikiHead(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}, 1, null, "${"a".repeat(64)}"); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(writeWiki.status, 0);
    assert.equal(writeWiki.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const readSummary = freshResult(
      `import { readWorkflowSummary } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-summary.ts"))};
try { readWorkflowSummary({ project_root: process.env.ARIS_ROOT, outer_run_id: ${JSON.stringify(workflowRunId)} }); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(readSummary.status, 0);
    assert.equal(readSummary.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const writeSummary = freshResult(
      `import { writeWorkflowSummary } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-summary.ts"))};
try { writeWorkflowSummary({ project_root: process.env.ARIS_ROOT, outer_run_id: ${JSON.stringify(workflowRunId)} }); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(writeSummary.status, 0);
    assert.equal(writeSummary.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const createDashboard = freshResult(
      `import { createWorkflowDashboard } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { createWorkflowDashboard(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}, "${"a".repeat(64)}"); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(createDashboard.status, 0);
    assert.equal(createDashboard.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const updateDashboard = freshResult(
      `import { updateWorkflowDashboard } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { updateWorkflowDashboard(process.env.ARIS_ROOT, ${JSON.stringify(workflowRunId)}, {}); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(updateDashboard.status, 0);
    assert.equal(updateDashboard.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const acquireMissing = freshResult(
      `import { acquireRunScope } from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
try { acquireRunScope({ project_root: process.env.ARIS_ROOT, run_id: ${JSON.stringify(workflowRunId)}, scope_path: ${JSON.stringify(runtime.scope_path)} }); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(acquireMissing.status, 0);
    assert.equal(acquireMissing.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    fs.unlinkSync(runtimePath);
    const statusWithoutRuntime = freshResult(
      `import { readOuterRunStatus } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-runtime.ts"))};
try { readOuterRunStatus({ execution_root: process.env.ARIS_ROOT, project_root: process.env.ARIS_ROOT, outer_run_id: ${JSON.stringify(workflowRunId)} }); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(statusWithoutRuntime.status, 0);
    assert.equal(statusWithoutRuntime.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assertGateStorageUnchanged();

    const commands = [
      ["set", root, phaseRunId, "init", "running"],
      [
        "accept",
        root,
        phaseRunId,
        "init",
        "--verdict-id",
        "verdict",
        "--reviewer",
        "reviewer",
        "--force",
      ],
      ["resume", root, phaseRunId],
      ["status", root, phaseRunId],
    ];
    for (const args of commands) {
      const result = freshRunStateCommand(args);
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}${result.stderr}`, /RUN_CONTRACT_NOT_FOUND/);
      assertGateStorageUnchanged();
    }
    const listed = freshRunStateCommand(["list", root]);
    assert.equal(listed.status, 0);
    assert.ok(listed.stdout.includes(`${phaseRunId} [contract missing]`));
    assertGateStorageUnchanged();
    assert.equal(fs.existsSync(workflowPath), false);
    assert.equal(fs.existsSync(modulePath), false);
    assert.equal(fs.existsSync(phaseContractPath), false);
    assert.equal(fs.readFileSync(phasePath, "utf8"), phaseBefore);
    assert.equal(fs.readFileSync(historyPath, "utf8"), historyBefore);
    assert.equal(fs.readFileSync(cyclePath, "utf8"), cycleBefore);
    assert.equal(fs.readFileSync(wikiPath, "utf8"), wikiBefore);
    assert.equal(fs.readFileSync(summaryPath, "utf8"), summaryBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dispatched manifest contains its own identity without scheduler ancestry", () => {
  const root = tmpDir();
  try {
    const parent = createRootRun({ project_root: root, run_id: "parent", ...material("parent") });
    const child = bridgeChild(root, parent.run_id);
    const snapshotRef = path.relative(
      root,
      path.join(path.dirname(runJsonPath(root, child.run_id)), "input-snapshot.json"),
    );
    sealWikiWorkerManifest({
      project_root: root,
      run_id: child.run_id,
      worker: "idea-discovery",
      input_snapshot: {
        ref: snapshotRef,
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(root, snapshotRef)))
          .digest("hex"),
      },
    });
    const manifest = JSON.parse(
      fs.readFileSync(wikiWorkerManifestPath(root, child.run_id), "utf8"),
    ) as Record<string, unknown>;
    // Everything here names the scheduler that dispatched the child, or the
    // child's place in its schedule. A worker that could read any of it could
    // make its behaviour depend on who called it.
    for (const field of [
      "parent_run_id",
      "outer_run_id",
      "scope_path",
      "outer_iteration",
      "wave_id",
      "wave_kind",
      "generation",
      "depth",
      "module_id",
    ])
      assert.equal(Object.hasOwn(manifest, field), false, field);
    assert.equal(readRun(root, child.run_id).parent_run_id, parent.run_id);
    assert.equal(manifest.scope, `runs/${child.run_id}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dispatch requires a contract and leaves nothing behind without one", () => {
  const root = tmpDir();
  try {
    const runId = "missing-child-contract";
    const contractPath = runJsonPath(root, runId);
    const directory = path.dirname(contractPath);
    assert.throws(
      () =>
        sealWikiWorkerManifest({
          project_root: root,
          run_id: runId,
          worker: "idea-discovery",
          input_snapshot: null,
        }),
      { code: "RUN_CONTRACT_NOT_FOUND" },
    );
    // The scope a binding is sealed into is derived from the contract, so a
    // dispatch against a run that was never created cannot even name a
    // directory to write into.
    for (const filePath of [
      contractPath,
      // Spelled out rather than taken from wikiWorkerManifestPath, because
      // that helper refuses to name a path for a run with no contract at all.
      path.join(directory, "input-manifest.json"),
      path.join(directory, "parent.json"),
      path.join(directory, "dashboard.json"),
      path.join(directory, "wiki"),
      legacyRunStatePath(root, runId),
    ])
      assert.equal(fs.existsSync(filePath), false, filePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("third-party callers cannot obtain a raw run-owned path before contract creation", () => {
  const root = tmpDir();
  try {
    createRootRun({ project_root: root, run_id: "raw-path-guard" });
    const runtime = createWorkflowRuntimeState({
      execution_root: root,
      project_root: root,
      outer_run_id: "raw-path-guard",
      task_id: "task:raw-path-guard",
      workflow_id: "workflow:raw-path-guard",
    });
    writeWorkflowRuntimeState(root, runtime);
    const runtimePath = workflowRuntimePath(root, runtime.run_id);
    const runtimeBefore = fs.readFileSync(runtimePath, "utf8");
    const contractPath = runJsonPath(root, runtime.run_id);
    fs.unlinkSync(contractPath);

    const lockPath = path.join(root, ".aris", "run-scope-locks.json");
    const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const tokenCountBefore = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    const result = freshResult(
      `import fs from "node:fs";
import { runOwnedPathForBootstrap } from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
try {
  const rawPath = runOwnedPathForBootstrap(process.env.ARIS_ROOT, "raw-path-guard", "workflow-runtime.json");
  fs.writeFileSync(rawPath, "{\\"written_by\\":\\"third-party\\"}\\n");
  console.log("accepted");
} catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "RUN_BOOTSTRAP_TRANSACTION_REQUIRED");
    assert.equal(fs.existsSync(contractPath), false);
    assert.equal(fs.readFileSync(runtimePath, "utf8"), runtimeBefore);
    const tokenCountAfter = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    assert.equal(tokenCountAfter, tokenCountBefore);
    const lockAfter = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    assert.equal(lockAfter, lockBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("third-party callers cannot add a token to an existing run without its contract", () => {
  const root = tmpDir();
  try {
    createRun({
      project_root: root,
      run_id: "scope-bootstrap-guard",
      scope_path: "/scope-bootstrap-guard",
      identity: material("scope-bootstrap-guard"),
    });
    const contractPath = runJsonPath(root, "scope-bootstrap-guard");
    fs.unlinkSync(contractPath);
    const lockPath = path.join(root, ".aris", "run-scope-locks.json");
    const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const tokenCountBefore = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    assert.equal(tokenCountBefore, 1);
    const result = freshResult(
      `import * as runContract from ${JSON.stringify(path.join(process.cwd(), "src/tools/run-contract.ts"))};
const keys = Object.keys(runContract).sort();
console.log(JSON.stringify({
  keys,
  hasRawScopeBootstrap: keys.includes("acquireRunScopeForBootstrap"),
  hasRawTransactionBootstrap: keys.includes("beginRunBootstrapTransaction"),
}));`,
      root,
    );
    assert.equal(result.status, 0);
    const exports = JSON.parse(result.stdout.trim()) as {
      keys: string[];
      hasRawScopeBootstrap: boolean;
      hasRawTransactionBootstrap: boolean;
    };
    assert.equal(exports.hasRawScopeBootstrap, false);
    assert.equal(exports.hasRawTransactionBootstrap, false);
    assert.equal(fs.existsSync(contractPath), false);
    const tokenCountAfter = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    assert.equal(tokenCountAfter, tokenCountBefore);
    const lockAfter = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    assert.equal(lockAfter, lockBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary runtime writes do not recreate a deleted run contract", () => {
  const root = tmpDir();
  try {
    createRootRun({ project_root: root, run_id: "runtime-writer-guard" });
    const runtime = createWorkflowRuntimeState({
      execution_root: root,
      project_root: root,
      outer_run_id: "runtime-writer-guard",
      task_id: "task:runtime-writer-guard",
      workflow_id: "workflow:runtime-writer-guard",
    });
    writeWorkflowRuntimeState(root, runtime);
    const runtimePath = workflowRuntimePath(root, runtime.run_id);
    const runtimeBefore = fs.readFileSync(runtimePath, "utf8");
    const contractPath = runJsonPath(root, runtime.run_id);
    fs.unlinkSync(contractPath);
    const lockPath = path.join(root, ".aris", "run-scope-locks.json");
    const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const tokenCountBefore = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    const result = freshResult(
      `import { writeWorkflowRuntimeState } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try {
  writeWorkflowRuntimeState(process.env.ARIS_ROOT, ${JSON.stringify(runtime)});
  console.log("accepted");
} catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "RUN_CONTRACT_NOT_FOUND");
    assert.equal(fs.existsSync(contractPath), false);
    assert.equal(fs.readFileSync(runtimePath, "utf8"), runtimeBefore);
    const tokenCountAfter = scopeLocks(root).reduce(
      (total, lock) => total + ((lock.lease_tokens as string[] | undefined)?.length ?? 0),
      0,
    );
    assert.equal(tokenCountAfter, tokenCountBefore);
    const lockAfter = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    assert.equal(lockAfter, lockBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime null limits are an identity mismatch, not a wildcard", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "null-limit-runtime",
      
      
      
    });
    const runtime = createWorkflowRuntimeState({
      execution_root: root,
      project_root: root,
      outer_run_id: "null-limit-runtime",
      task_id: "null-limit-task",
      workflow_id: "null-limit-workflow",
      
      
      
    });
    writeWorkflowRuntimeState(root, runtime);
    const runtimePath = workflowRuntimePath(root, "null-limit-runtime");
    const before = fs.readFileSync(runtimePath, "utf8");
    const raw = JSON.parse(before) as Record<string, unknown>;
    raw.max_depth = null;
    fs.writeFileSync(runtimePath, `${JSON.stringify(raw)}\n`);
    const tampered = fs.readFileSync(runtimePath, "utf8");
    const result = freshResult(
      `import { readWorkflowRuntimeState } from ${JSON.stringify(path.join(process.cwd(), "src/tools/workflow-state.ts"))};
try { readWorkflowRuntimeState(process.env.ARIS_ROOT, "null-limit-runtime"); console.log("accepted"); }
catch (error) { console.log(error.code ?? "NO_CODE"); }`,
      root,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "UNKNOWN_FIELD");
    assert.notEqual(tampered, before);
    assert.equal(fs.readFileSync(runtimePath, "utf8"), tampered);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("output_hashes are checked before a run is reused", () => {
  const root = tmpDir();
  try {
    const run = createRun({
      project_root: root,
      run_id: "hashed",
      scope_path: "/hashed",
      identity: material("hashed"),
    });
    const output = path.join(root, ".aris", "runs", run.run_id, "result.txt");
    fs.writeFileSync(output, "sealed result\n");
    const hash = crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
    updateRun(root, run.run_id, { output_hashes: { "result.txt": hash } });
    assert.equal(canReuseRun(root, run.run_id), true);
    fs.appendFileSync(output, "tampered\n");
    assert.equal(canReuseRun(root, run.run_id), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow and child writers persist only the canonical parent field", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "workflow-root",
      
      
      
      charter_sha256: "a".repeat(64),
      input_snapshot_sha256: "c".repeat(64),
      execution_plan_sha256: "b".repeat(64),
      code_baseline_sha256: "a".repeat(64),
      policy_revision: "policy:a2",
    });
    const runtime = createWorkflowRuntimeState({
      execution_root: root,
      project_root: root,
      outer_run_id: "workflow-root",
      task_id: "task-a2",
      workflow_id: "workflow-a2",
      
      
      
    });
    writeWorkflowRuntimeState(root, runtime);
    const runtimeRaw = JSON.parse(
      fs.readFileSync(workflowRuntimePath(root, "workflow-root"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(runtimeRaw.parent_run_id, null);
    assert.equal(runtimeRaw.outer_run_id, undefined);
    assert.equal(readRun(root, "workflow-root").max_depth, undefined);
    assert.equal(readRun(root, "workflow-root").depth_budget, undefined);
    assert.equal(readRun(root, "workflow-root").execution, undefined);

    const child = bridgeChild(root, "workflow-root");
    const snapshotRef = path.relative(
      root,
      path.join(path.dirname(runJsonPath(root, child.run_id)), "input-snapshot.json"),
    );
    sealWikiWorkerManifest({
      project_root: root,
      run_id: child.run_id,
      worker: "idea-discovery",
      input_snapshot: {
        ref: snapshotRef,
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(root, snapshotRef)))
          .digest("hex"),
      },
    });
    const manifestRaw = JSON.parse(
      fs.readFileSync(wikiWorkerManifestPath(root, child.run_id), "utf8"),
    ) as Record<string, unknown>;
    // The child directory persists neither parent name; the contract is the only writer.
    assert.equal(fs.existsSync(path.join(path.dirname(runJsonPath(root, child.run_id)), "parent.json")), false);
    assert.equal(manifestRaw.parent_run_id, undefined);
    assert.equal(manifestRaw.outer_run_id, undefined);
    assert.equal(readRun(root, child.run_id).parent_run_id, "workflow-root");
    assert.deepEqual(readRun(root, "workflow-root").child_run_ids, [child.run_id]);
    assert.equal(readRun(root, child.run_id).scope_path, "/main");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow runtime writers persist no depth limit and no execution field", () => {
  const root = tmpDir();
  try {
    createRootRun({
      project_root: root,
      run_id: "budget-zero-runtime",
      
      
      
    });
    const runtime = createWorkflowRuntimeState({
      execution_root: root,
      project_root: root,
      outer_run_id: "budget-zero-runtime",
      task_id: "task:a2-budget",
      workflow_id: "workflow:a2-budget",
      
      
    });
    assert.equal(runtime.execution, undefined);
    writeWorkflowRuntimeState(root, runtime);
    const contract = readRun(root, "budget-zero-runtime");
    assert.equal(contract.max_depth, undefined);
    assert.equal(contract.depth_budget, undefined);
    assert.equal(contract.execution, undefined);
    const recovered = readWorkflowRuntimeState(root, "budget-zero-runtime");
    assert.equal(recovered.execution, undefined);
    assert.equal(recovered.max_depth, undefined);
    assert.equal(recovered.depth_budget, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
