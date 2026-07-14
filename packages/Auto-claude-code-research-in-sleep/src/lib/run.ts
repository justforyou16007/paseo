import { execSync, execFileSync, type ExecSyncOptions } from "child_process";

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

export function exec(command: string, args: string[]): void {
  // Equivalent to Python's os.execv - replace current process
  const { spawnSync } = require("child_process");
  const result = spawnSync(command, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
