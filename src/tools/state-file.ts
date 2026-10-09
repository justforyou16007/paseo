import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * All state writers use this module so a relative path and its absolute form
 * cannot accidentally create two different lock files.
 */
export const LOCK_MAX_AGE_MS = 120_000;
export const LOCK_RETRY_MS = 50;
export const LOCK_TIMEOUT_MS = 10_000;

type Validator<T> = (value: unknown, filePath: string) => T;

export function canonicalStatePath(filePath: string): string {
  const absolutePath = path.resolve(filePath);

  // Resolve the target itself when it exists. For a new target, resolve the
  // deepest existing parent instead, so a symlinked directory and its real
  // directory share one lock path before the state file is created.
  if (fs.existsSync(absolutePath)) return fs.realpathSync.native(absolutePath);

  const missingParts: string[] = [path.basename(absolutePath)];
  let existingParent = path.dirname(absolutePath);
  while (!fs.existsSync(existingParent)) {
    const nextParent = path.dirname(existingParent);
    if (nextParent === existingParent) break;
    missingParts.unshift(path.basename(existingParent));
    existingParent = nextParent;
  }
  const realParent = fs.realpathSync.native(existingParent);
  return path.join(realParent, ...missingParts);
}

export function stateLockPath(filePath: string): string {
  return `${canonicalStatePath(filePath)}.lock`;
}

function makeLockToken(): string {
  return `${process.pid}:${Date.now()}:${crypto.randomBytes(12).toString("hex")}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but is owned by another user. Treat it
    // as live; breaking that lock would be less safe than waiting for timeout.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function canBreakLock(lockFile: string): boolean {
  let content = "";
  try {
    content = fs.readFileSync(lockFile, "utf-8").trim();
  } catch {
    return false;
  }

  const parts = content.split(":");
  const pid = Number.parseInt(parts[0] ?? "", 10);
  if (Number.isInteger(pid) && pid > 0) {
    // A live PID owns the lock even when the file is old. Age alone is not a
    // safe reason to interrupt a long state update.
    return !isPidAlive(pid);
  }

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(lockFile).mtimeMs;
  } catch {
    return false;
  }
  return mtimeMs > 0 && Date.now() - mtimeMs > LOCK_MAX_AGE_MS;
}

export function acquireStateFileLock(filePath: string): string {
  const normalizedPath = canonicalStatePath(filePath);
  const lockFile = stateLockPath(normalizedPath);
  fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const token = makeLockToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const fd = fs.openSync(
        lockFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        fs.writeSync(fd, `${token}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      if (canBreakLock(lockFile)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Another waiter or the owner won the race. Retry through openSync.
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`state-file lock timeout after ${LOCK_TIMEOUT_MS}ms on ${normalizedPath}`);
      }
      sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }
}

export function releaseStateFileLock(filePath: string, token: string): void {
  const lockFile = stateLockPath(filePath);
  try {
    if (fs.readFileSync(lockFile, "utf-8").trim() === token) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // The lock can already have been removed after an owner crash or a race.
  }
}

export function withStateFileLock<T>(filePath: string, action: () => T): T {
  const token = acquireStateFileLock(filePath);
  try {
    return action();
  } finally {
    releaseStateFileLock(filePath, token);
  }
}

export function readStateFile<T>(filePath: string, validate?: Validator<T>): T {
  const normalizedPath = canonicalStatePath(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(normalizedPath, "utf-8");
  } catch (error: unknown) {
    throw new Error(`cannot read state file at ${normalizedPath}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt JSON in state file at ${normalizedPath}`);
  }
  return validate ? validate(parsed, normalizedPath) : (parsed as T);
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some filesystems do not allow opening directories. The file itself was
    // fsynced; directory fsync is an extra durability step when supported.
  }
}

export function writeStateFileAtomic(filePath: string, contents: string): void {
  const normalizedPath = canonicalStatePath(filePath);
  fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const temporary = `${normalizedPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(fd, contents, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, normalizedPath);
    fsyncDirectory(path.dirname(normalizedPath));
  } catch (error: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original error.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename may already have completed.
    }
    throw error;
  }
}

export function writeStateJsonAtomic(filePath: string, value: unknown): void {
  writeStateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
