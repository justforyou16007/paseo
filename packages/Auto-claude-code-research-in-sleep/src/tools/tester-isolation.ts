import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isRecord,
  assertNoUnknownFields,
  requireInteger,
  requireString,
  failA1,
} from "./workflow-spec.js";

export interface TesterIsolationConfig {
  schema_version: 1;
  research_user: string;
  research_uid: number;
  tester_user: string;
  tester_uid: number;
  private_root: string;
  execution_root: string;
}

export interface IsolationCheck {
  status: "ready";
  identity: "research" | "tester";
  uid: number;
}

export function validateTesterIsolationConfig(value: unknown): TesterIsolationConfig {
  if (!isRecord(value))
    failA1("TESTER_ISOLATION_REQUIRED", "isolation configuration must be an object");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "research_user",
      "research_uid",
      "tester_user",
      "tester_uid",
      "private_root",
      "execution_root",
    ],
    "isolation",
  );
  if (value.schema_version !== 1)
    failA1("TESTER_ISOLATION_REQUIRED", "unsupported isolation configuration");
  const researchUid = requireInteger(value.research_uid, "research_uid", 1);
  const testerUid = requireInteger(value.tester_uid, "tester_uid", 1);
  const researchUser = requireString(value.research_user, "research_user");
  const testerUser = requireString(value.tester_user, "tester_user");
  if (researchUid === testerUid || researchUser === testerUser)
    failA1("TESTER_IDENTITY_CONFLICT", "research and tester must use distinct non-root users");
  for (const name of [researchUser, testerUser]) {
    if (!/^[a-z_][a-z0-9_-]*$/.test(name))
      failA1("TESTER_ISOLATION_REQUIRED", "invalid system user name");
  }
  const privateRoot = requireString(value.private_root, "private_root");
  const executionRoot = requireString(value.execution_root, "execution_root");
  for (const directory of [privateRoot, executionRoot]) {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === "/")
      failA1(
        "TESTER_ISOLATION_REQUIRED",
        "isolation roots must be normalized absolute directories",
      );
  }
  if (
    privateRoot === executionRoot ||
    privateRoot.startsWith(`${executionRoot}/`) ||
    executionRoot.startsWith(`${privateRoot}/`)
  )
    failA1("TESTER_ISOLATION_REQUIRED", "private and research execution roots must be separate");
  return {
    schema_version: 1,
    research_user: researchUser,
    research_uid: researchUid,
    tester_user: testerUser,
    tester_uid: testerUid,
    private_root: privateRoot,
    execution_root: executionRoot,
  };
}

// Check every ancestor: a protected file under a replaceable directory is not protected.
export function assertProtectedPath(filePath: string, allowedOwners: readonly number[]): void {
  let current = path.resolve(filePath);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !allowedOwners.includes(stat.uid) || (stat.mode & 0o022) !== 0)
      failA1(
        "TESTER_PATH_UNPROTECTED",
        "tester path must have trusted ownership and no group/other write access",
      );
    if (current === path.dirname(current)) return;
    current = path.dirname(current);
  }
}

export function readTesterIsolationConfig(configPath: string): TesterIsolationConfig {
  assertProtectedPath(configPath, [0]);
  return validateTesterIsolationConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
}

function assertSystemIdentity(name: string, expectedUid: number): void {
  const actualUid = Number(execFileSync("/usr/bin/id", ["-u", name], { encoding: "utf8" }).trim());
  if (actualUid !== expectedUid)
    failA1("TESTER_IDENTITY_CONFLICT", "configured user does not match its system uid");
}

export function checkTesterIsolation(
  config: TesterIsolationConfig,
  identity: "research" | "tester",
): IsolationCheck {
  if (!localTesterExecutionAllowed())
    failA1(
      "LOCAL_TESTER_EXECUTION_DISABLED",
      "fixed tester execution is remote-only; local user isolation is retired",
    );
  const normalized = validateTesterIsolationConfig(config);
  if (process.platform !== "linux" || !process.getuid)
    failA1("TESTER_ISOLATION_UNAVAILABLE", "independent-user tester execution requires Linux");
  assertSystemIdentity(normalized.research_user, normalized.research_uid);
  assertSystemIdentity(normalized.tester_user, normalized.tester_uid);
  const uid = process.getuid();
  const expectedUid = identity === "research" ? normalized.research_uid : normalized.tester_uid;
  if (uid !== expectedUid)
    failA1("TESTER_IDENTITY_CONFLICT", "run this command under the configured system user");
  const groups = execFileSync("/usr/bin/id", ["-Gn"], { encoding: "utf8" }).trim().split(/\s+/);
  const privilegedGroups = new Set([
    "root",
    "sudo",
    "wheel",
    "docker",
    "lxd",
    "disk",
    "shadow",
    "adm",
  ]);
  if (groups.some((group) => privilegedGroups.has(group)))
    failA1("TESTER_PRIVILEGED_ACCOUNT", "execution account belongs to a privileged group");
  const processStatus = fs.readFileSync("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(processStatus) || !/^CapEff:\s+0+$/m.test(processStatus))
    failA1(
      "TESTER_PRIVILEGE_BOUNDARY_REQUIRED",
      "launch execution with no-new-privileges and no effective capabilities",
    );
  assertProtectedPath(normalized.private_root, [0, normalized.tester_uid]);
  const privateStat = fs.statSync(normalized.private_root);
  if (
    !privateStat.isDirectory() ||
    privateStat.uid !== normalized.tester_uid ||
    (privateStat.mode & 0o077) !== 0
  )
    failA1("TESTER_PATH_UNPROTECTED", "private root must be tester-owned with mode 0700");
  if (identity === "research") {
    let denied = false;
    try {
      fs.readdirSync(normalized.private_root);
    } catch (error: unknown) {
      denied = isRecord(error) && error.code === "EACCES";
    }
    if (!denied)
      failA1(
        "TESTER_PRIVATE_DATA_ACCESSIBLE",
        "research process can access tester private directory",
      );
  } else {
    fs.accessSync(
      normalized.private_root,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    );
  }
  return { status: "ready", identity, uid };
}

function localTesterExecutionAllowed(): boolean {
  return false;
}
