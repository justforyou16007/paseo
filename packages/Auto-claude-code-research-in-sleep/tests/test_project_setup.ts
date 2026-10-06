import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {detectSetupStages,inferSetupItems} from "../src/tools/project-setup.js";
import {installedFacilityFixture} from "./helpers/tester-facility-fixture.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"aris-project-setup-"));
try {
 const empty=detectSetupStages({project_root:root});assert.deepEqual(empty.blocking,["project_basics","metric_target","experiment_env","tester_facility","root_charter"]);
 assert.ok(empty.stages.find(s=>s.id==="tester_facility")?.next.includes("/tester-setup"));
 const config=installedFacilityFixture(root);let status=detectSetupStages({project_root:root});assert.equal(status.stages.find(s=>s.id==="tester_facility")?.ready,true);
 const inferred=inferSetupItems(root);assert.deepEqual(inferred.inferred.tester_facility?.value,config);assert.equal((inferred.inferred.tester?.value as any).tester_id,config.tester_id);assert.ok(inferred.needs_owner.every(q=>String(q.item)!=="exposure"));
 fs.appendFileSync(path.join(root,"runner-fixture.txt"),"drift");status=detectSetupStages({project_root:root});assert.equal(status.stages.find(s=>s.id==="tester_facility")?.ready,false);
 installedFacilityFixture(root);fs.writeFileSync(path.join(root,"CLAUDE.md"),"## Metric Target\nprimary: 0.85 F1\ndirection: higher_better\ntolerance: 0.02\n");
 const thresholds=inferSetupItems(root).inferred.thresholds;assert.deepEqual(thresholds?.value,{primary:{name:"F1",direction:"higher_better",target:.85},constraints:[]});assert.ok(thresholds?.source.includes("CLAUDE.md"));
 const cli=path.resolve(import.meta.dirname,"../src/tools/project-setup-cli.ts");const c=spawnSync(process.execPath,[...process.execArgv,cli,"status","--project",root],{encoding:"utf8"});assert.equal(c.status,1);assert.equal(JSON.parse(c.stdout).stages.length,5);
 console.log("project setup: five stages, facilities, readiness drift, inference and CLI passed");
} finally {fs.rmSync(root,{recursive:true,force:true});}
