#!/usr/bin/env node
// Commit message check. The repo has used Conventional Commits since the
// beginning (fix/feat/chore/refactor/docs make up ~97% of all subjects), but
// nothing enforced it, so long-lived branches drifted into free-form subjects
// that carried a whole changelog on one line. Every rule below exists because
// that shape showed up in history; nothing here is style for its own sake.
import { readFileSync } from "node:fs";

const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

// git generates or rewrites these itself, so the author never gets to fix them.
const EXEMPT = /^(Merge |Revert "|fixup!|squash!|amend!)/;

const SUBJECT_LIMIT = 72;

const SUBJECT_RE = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9/._-]*\\))?!?: .+$`);

// A leading "1." / "1、" / "1)" means the author had several changes and put the
// list in the subject instead of splitting the commit or writing a body.
const NUMBERED_RE = /^\s*\d+\s*[.、)]/;

// East Asian wide and fullwidth code points occupy two terminal columns, so a
// byte or code-unit count would let a Chinese subject run twice as wide as the
// limit intends.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += isWide(ch.codePointAt(0)) ? 2 : 1;
  return width;
}

// git strips comment lines and everything past the scissors line before it
// stores the message, so the check has to look at the same text git will keep.
export function stripGitNoise(raw) {
  const kept = [];
  for (const line of raw.split("\n")) {
    if (/^\s*#\s*-{2,}\s*>8\s*-{2,}/.test(line)) break;
    if (line.startsWith("#")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function checkCommitMessage(raw) {
  const body = stripGitNoise(raw);
  const lines = body.split("\n");
  const subject = (lines[0] ?? "").trim();
  const errors = [];

  if (subject === "") return { ok: true, errors: [] };
  if (EXEMPT.test(subject)) return { ok: true, errors: [] };

  if (NUMBERED_RE.test(subject)) {
    errors.push(
      "主题行是编号清单。一次提交做了几件事就拆成几个提交；" +
        "确实同属一件事的，清单写进正文，主题行写它们共同的那一件事。",
    );
  } else if (!SUBJECT_RE.test(subject)) {
    errors.push(
      `主题行必须是 \`type(scope): 描述\`，type 取自 ${TYPES.join(" / ")}。` +
        "scope 可省略，描述用中文或英文都行。",
    );
  }

  const width = displayWidth(subject);
  if (width > SUBJECT_LIMIT) {
    errors.push(
      `主题行 ${width} 列，超过 ${SUBJECT_LIMIT} 列（中日韩字符按 2 列算）。` +
        "细节移到正文：空一行，然后想写多长写多长。",
    );
  }

  if (lines.length > 1 && lines[1].trim() !== "") {
    errors.push("主题行和正文之间必须空一行，否则 git 会把整段都当成主题行。");
  }

  return { ok: errors.length === 0, errors };
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("check-commit-msg.mjs")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: check-commit-msg.mjs <commit-msg-file>");
    process.exit(2);
  }
  const result = checkCommitMessage(readFileSync(file, "utf8"));
  if (!result.ok) {
    console.error("提交信息不符合规范：\n");
    for (const error of result.errors) console.error(`  - ${error}`);
    console.error("\n规范见 CONTRIBUTING.md 的 “Commit messages” 一节。");
    console.error("消息草稿保留在 .git/COMMIT_EDITMSG，改完重新 commit 即可。");
    process.exit(1);
  }
}
