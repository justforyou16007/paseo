import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const installer = fs.readFileSync(new URL("./postinstall-patches.mjs", import.meta.url), "utf8");
const linkInstaller = installer.slice(
  installer.indexOf("const arisSkillSource ="),
  installer.lastIndexOf("process.exit(patchExitCode)"),
);

function fixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-entry-install-"));
  const skills = path.join(root, "user", ".claude", "skills");
  const source = path.join(root, "repo", "packages/Auto-claude-code-research-in-sleep/skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(path.join(source, "aris-setup"), { recursive: true });
  const install = () =>
    vm.runInNewContext(linkInstaller, {
      ...fs,
      join: path.join,
      resolve: (...parts) => path.resolve(root, "repo", ...parts),
      homedir: () => path.join(root, "user"),
      process,
    });
  try {
    action({ root, skills, source, install });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("installs only the canonical setup entry and removes owned broken retired links", () => {
  fixture(({ skills, source, install }) => {
    for (const name of ["research-setup", "tester-setup"])
      fs.symlinkSync(path.join(source, name), path.join(skills, name));
    install();
    assert.equal(fs.readlinkSync(path.join(skills, "aris-setup")), path.join(source, "aris-setup"));
    for (const name of ["research-setup", "tester-setup"])
      assert.throws(() => fs.lstatSync(path.join(skills, name)), { code: "ENOENT" });
    install();
    assert.equal(fs.readlinkSync(path.join(skills, "aris-setup")), path.join(source, "aris-setup"));
  });
});

test("preserves user-owned directories and external retired-name links", () => {
  fixture(({ root, skills, install }) => {
    const custom = path.join(skills, "research-setup");
    fs.mkdirSync(custom);
    fs.writeFileSync(path.join(custom, "notes.txt"), "user-owned");
    const external = path.join(root, "external");
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(skills, "tester-setup"));
    install();
    assert.equal(fs.readFileSync(path.join(custom, "notes.txt"), "utf8"), "user-owned");
    assert.equal(fs.readlinkSync(path.join(skills, "tester-setup")), external);
  });
});

test("retains a correct relative canonical link and removes owned aliases to it", () => {
  fixture(({ skills, source, install }) => {
    const relative = path.relative(skills, path.join(source, "aris-setup"));
    fs.symlinkSync(relative, path.join(skills, "aris-setup"));
    fs.symlinkSync(relative, path.join(skills, "research-setup"));
    install();
    assert.equal(fs.readlinkSync(path.join(skills, "aris-setup")), relative);
    assert.throws(() => fs.lstatSync(path.join(skills, "research-setup")), { code: "ENOENT" });
  });
});
