import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertProtectedPath, validateTesterIsolationConfig } from "../src/tools/tester-isolation.js";

const valid = { schema_version: 1, research_user: "aris-research", research_uid: 1201, tester_user: "aris-tester", tester_uid: 1202, private_root: "/var/lib/aris/private", execution_root: "/var/lib/aris/execution" };
assert.deepEqual(validateTesterIsolationConfig(valid), valid);
assert.throws(() => validateTesterIsolationConfig({ ...valid, tester_uid: 1201 }), /distinct/);
assert.throws(() => validateTesterIsolationConfig({ ...valid, research_uid: 0 }), { code: "INVALID_VALUE", location: "research_uid" });
assert.throws(() => validateTesterIsolationConfig({ ...valid, private_root: "/var/lib/aris/execution/private" }), /separate/);
assert.throws(() => validateTesterIsolationConfig({ ...valid, private_root: "/var/../private" }), /normalized/);
assert.throws(() => validateTesterIsolationConfig({ ...valid, tester_user: "--root" }), /user name/);
assert.throws(() => validateTesterIsolationConfig({ ...valid, bypass: true }), /unknown/i);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-isolation-"));
try {
  const target = path.join(root, "config.json");
  fs.writeFileSync(target, "{}", { mode: 0o666 });
  fs.chmodSync(target, 0o666);
  assert.throws(() => assertProtectedPath(target, [process.getuid!()]), /trusted ownership/);
  const link = path.join(root, "link.json");
  fs.symlinkSync(target, link);
  assert.throws(() => assertProtectedPath(link, [process.getuid!()]), /trusted ownership/);
  fs.chmodSync(target, 0o600);
  // A private file in /tmp is still beneath a writable ancestor.
  assert.throws(() => assertProtectedPath(target, [0, process.getuid!()]), /trusted ownership/);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("tester isolation: configuration and real filesystem rejection checks passed");
