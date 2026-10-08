import { execFileSync, type ExecSyncOptions } from "child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  input?: string;
  capture?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  const opts: ExecSyncOptions = {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    timeout: options.timeout,
    input: options.input,
    encoding: "utf-8",
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : undefined,
  };

  try {
    const stdout = execFileSync(command, args, opts) as string;
    return { stdout: stdout ?? "", stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
    }
    throw err;
  }
}

/**
 * A command on PATH, as a path Node can start. On Windows only `.exe` counts:
 * Node cannot start a `.cmd` shim without a shell, and Git Bash's `which`
 * answers with `/c/...` paths Node does not understand.
 */
export function findExecutable(name: string): string | null {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
