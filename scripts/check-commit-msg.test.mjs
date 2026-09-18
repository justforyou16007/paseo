import assert from "node:assert/strict";
import { test } from "vitest";
import { checkCommitMessage, displayWidth, stripGitNoise } from "./check-commit-msg.mjs";

test("accepts the conventional shapes the repo already uses", () => {
  for (const subject of [
    "fix(aris): reuse /experiment-bridge in auto-research-loop",
    "feat: add auto-research-loop skill",
    "chore(app/e2e): drop the stale fixture",
    "refactor(server)!: rename the session registry",
    "docs(aris): 修复 setup 流程的描述",
  ]) {
    assert.deepEqual(checkCommitMessage(subject), { ok: true, errors: [] }, subject);
  }
});

test("git-authored subjects are exempt because the author cannot edit them", () => {
  for (const subject of [
    "Merge main into paseo-aris",
    'Revert "feat(app): add the thing"',
    "fixup! fix(app): the thing",
  ]) {
    assert.equal(checkCommitMessage(subject).ok, true, subject);
  }
});

test("rejects a subject with no type prefix", () => {
  // 4a6b16efa on paseo-aris.
  const result = checkCommitMessage("修复experiment-bridge等skills和状态表的字段对齐问题");
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /type\(scope\)/);
});

test("rejects a numbered list in the subject and says to split or use a body", () => {
  // fb52916d8 on paseo-aris: two changes on the subject line, empty body.
  const result = checkCommitMessage(
    "1. 修复恢复状态时agent不判断阶段是否失败的问题；2. 删除experiment[]和相关的assert",
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /编号清单/);
  // The type-prefix error is suppressed: the numbered list is the real defect,
  // and reporting both would suggest "1. …" becomes legal once prefixed.
  assert.equal(result.errors.filter((e) => /type\(scope\)/.test(e)).length, 0);
});

test("counts CJK as two columns so a Chinese subject cannot run double width", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("修复"), 4);
  assert.equal(displayWidth("fix: 修复"), 9);

  // 36 Chinese characters = 72 columns exactly, plus the "fix: " prefix.
  const tooWide = `fix: ${"修".repeat(36)}`;
  const result = checkCommitMessage(tooWide);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /77 列/);
});

test("a 72-column subject passes and a 73-column one does not", () => {
  assert.equal(checkCommitMessage(`fix: ${"a".repeat(67)}`).ok, true);
  assert.equal(checkCommitMessage(`fix: ${"a".repeat(68)}`).ok, false);
});

test("rejects a body glued to the subject", () => {
  const result = checkCommitMessage("fix(app): the thing\nand more detail here");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /空一行/);
});

test("accepts a proper subject/body pair", () => {
  assert.equal(checkCommitMessage("fix(app): the thing\n\nWhy it broke.\n").ok, true);
});

test("ignores comments and everything past the verbose-commit scissors line", () => {
  const raw = [
    "fix(app): the thing",
    "",
    "Body.",
    "# Please enter the commit message for your changes.",
    "# ------------------------ >8 ------------------------",
    "diff --git a/x b/x",
    "1. this diff line must not be read as a numbered subject",
  ].join("\n");
  assert.equal(stripGitNoise(raw).includes("diff --git"), false);
  assert.equal(checkCommitMessage(raw).ok, true);
});

test("an empty message is left to git, which aborts the commit itself", () => {
  assert.equal(checkCommitMessage("\n# comment only\n").ok, true);
});
