import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySetup,
  confirmSetupReview,
  refreshSetupReview,
  SetupReviewIncompleteError,
} from "../src/tools/setup.js";
import { readValidationConfig, validationTokenPath } from "../src/tools/validation/config.js";
import { createSubmission, updateSubmission, withSubmissionsLock } from "../src/tools/validation/store.js";
import { facilityConfig } from "./helpers/tester-facility-fixture.js";

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const issueFields = (root: string) => refreshSetupReview(root).issues.map((issue) => issue.field);
async function project(name: string, action: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aris-setup-${name}-`));
  try {
    await action(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Worker: the role decides the modules; task.md is part of what the owner approves.
await project("worker", async (root) => {
  let review = refreshSetupReview(root);
  assert.equal(review.role, null);
  assert.deepEqual(
    review.modules.map((module) => module.id),
    ["project"],
  );
  review = refreshSetupReview(root, { project: { role: "worker" } });
  assert.deepEqual(
    review.modules.map((module) => module.id),
    ["project", "environment", "connection"],
  );
  assert.ok(issueFields(root).includes("task.md"));
  assert.ok(issueFields(root).includes("connection.url"));

  fs.writeFileSync(path.join(root, "task.md"), "# Task\nAnswer the questions.\n");
  review = refreshSetupReview(root, {
    connection: { url: "http://validation.example:7000/mcp", token: "t".repeat(43) },
  });
  assert.deepEqual(review.issues, []);
  assert.equal(review.ready_to_confirm, true);
  await assert.rejects(applySetup(root), /SETUP_CONFIGURATION_CONFIRMATION_REQUIRED|confirm/);

  // Editing task.md after review invalidates the reviewed digest.
  const reviewed = review.configuration_sha256;
  fs.appendFileSync(path.join(root, "task.md"), "Use English.\n");
  assert.throws(() => confirmSetupReview(root, reviewed), /refresh and confirm/);
  review = refreshSetupReview(root);
  assert.notEqual(review.configuration_sha256, reviewed);
  confirmSetupReview(root, review.configuration_sha256);
  assert.equal(refreshSetupReview(root).confirmed, true);

  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "x" } } }),
  );
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Owner notes\n");
  const applied = await applySetup(root);
  assert.equal(applied.role, "worker");
  const mcp = read(path.join(root, ".mcp.json"));
  assert.deepEqual(mcp.mcpServers.other, { command: "x" });
  assert.deepEqual(mcp.mcpServers["aris-validation"], {
    type: "http",
    url: "http://validation.example:7000/mcp",
    headers: { Authorization: `Bearer ${"t".repeat(43)}` },
  });
  // The role block is added once and replaced in place on re-apply.
  await applySetup(root);
  const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.startsWith("# Owner notes\n"));
  assert.equal(claude.split("<!-- ARIS ROLE BEGIN -->").length, 2);
  assert.match(claude, /ARIS role: worker/);
});

// Validation: the benchmark is installed, the terms frozen, and the service registered.
await project("validation", async (root) => {
  fs.writeFileSync(path.join(root, "task.md"), "# Task\nAnswer the questions.\n");
  const benchmark = facilityConfig(root);
  let review = refreshSetupReview(root, {
    project: { role: "validation" },
    validation: { benchmark, metric: { name: "missing" } },
  });
  assert.ok(review.issues.some((issue) => issue.field === "validation"));
  review = refreshSetupReview(root, {
    validation: {
      metric: { name: "score", target: 1 },
      leak_check: { hidden_paths: [path.join(root, "bench", "labels.json")] },
      agent: { provider: "claude" },
      service: { host: "0.0.0.0", port: 70_000, public_url: "https://validation.example/" },
    },
  });
  assert.deepEqual(
    review.issues.map((issue) => issue.field),
    ["validation.service.port"],
  );
  review = refreshSetupReview(root, { validation: { service: { port: 8765 } } });
  assert.deepEqual(review.issues, []);
  assert.throws(
    () => confirmSetupReview(root, "0".repeat(64)),
    /refresh and confirm/,
  );
  confirmSetupReview(root, review.configuration_sha256);
  const applied = await applySetup(root);
  assert.equal(applied.role, "validation");
  if (applied.role !== "validation") throw new Error("unreachable");
  assert.equal(applied.worker_connection.url, "https://validation.example/mcp");
  assert.equal(
    applied.worker_connection.token,
    fs.readFileSync(validationTokenPath(root), "utf8").trim(),
  );
  const config = readValidationConfig(root);
  assert.deepEqual(config.metric, { name: "score", direction: "higher_better", target: 1 });
  assert.equal(config.limits.max_submissions, 20);
  assert.ok(fs.existsSync(path.join(root, ".aris", "tester-config.json")));
  // The fixed port lives only in the Paseo service entry; the frozen config keeps the bind host.
  assert.deepEqual(read(path.join(root, "paseo.json")).scripts["aris-validation"], {
    type: "service",
    command: "node .aris/dist/tools/validation-cli.js serve --project .",
    port: 8765,
  });
  assert.deepEqual(config.service, { host: "0.0.0.0", public_url: "https://validation.example" });
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /ARIS role: validation/);

  // Re-applying keeps the token the worker already holds.
  const again = await applySetup(root);
  if (again.role !== "validation") throw new Error("unreachable");
  assert.equal(again.worker_connection.token, applied.worker_connection.token);

  // Missing hidden data is reported.
  review = refreshSetupReview(root, {
    validation: { leak_check: { hidden_paths: [path.join(root, "nowhere")] } },
  });
  assert.ok(review.issues.some((issue) => issue.field === "validation.leak_check.hidden_paths"));
  review = refreshSetupReview(root, {
    validation: { leak_check: { hidden_paths: [path.join(root, "bench", "labels.json")] } },
  });
  assert.deepEqual(review.issues, []);

  // Once a submission counts, the benchmark and metric are frozen; limits may still change.
  const { record } = createSubmission(root, config, undefined);
  withSubmissionsLock(root, () => updateSubmission(root, record.submission_id, { status: "queued" }));
  review = refreshSetupReview(root, { validation: { metric: { target: 0.5 } } });
  assert.ok(review.issues.some((issue) => issue.message.includes("frozen")));
  review = refreshSetupReview(root, {
    validation: { metric: { target: 1 }, limits: { max_submissions: 30 } },
  });
  assert.deepEqual(review.issues, []);
  try {
    confirmSetupReview(root, refreshSetupReview(root, { project: { name: "" } }).configuration_sha256);
    assert.fail("an incomplete sheet must not confirm");
  } catch (error) {
    assert.ok(error instanceof SetupReviewIncompleteError);
  }
});

console.log("test_setup: ok");
