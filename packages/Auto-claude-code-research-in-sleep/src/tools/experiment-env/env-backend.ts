import { execSync } from "child_process";

export class EnvError extends Error {
  code: number;
  override message: string;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.message = message;
  }
}

export interface RunShellResult {
  stdout: string;
  returncode: number;
}

export function runShell(
  cmd: string,
  options: { check?: boolean; capture?: boolean } = {},
): RunShellResult {
  const { check = false, capture = true } = options;
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      stdio: capture ? ["pipe", "pipe", "pipe"] : undefined,
    });
    return { stdout: stdout ?? "", returncode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const e = err as { status: number; stdout: string; stderr: string };
      if (check) {
        throw new EnvError(1, `command failed: ${cmd}\n${e.stderr ?? ""}`);
      }
      return { stdout: e.stdout ?? "", returncode: e.status ?? 1 };
    }
    throw err;
  }
}

export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[a-zA-Z0-9_./:@=,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export abstract class EnvBackend {
  config: Record<string, unknown>;
  stateDir: string;
  dryRun: boolean;

  constructor(config: Record<string, unknown>, stateDir = ".", dryRun = false) {
    this.config = config;
    this.stateDir = stateDir;
    this.dryRun = dryRun;
  }

  static create(
    envType: string,
    config: Record<string, unknown>,
    stateDir = ".",
    dryRun = false,
  ): EnvBackend {
    // Lazy imports to avoid circular references at module load
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalEnv } = require("./local-env.js") as typeof import("./local-env.js");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DockerEnv } = require("./docker-env.js") as typeof import("./docker-env.js");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RemoteEnv } = require("./remote-env.js") as typeof import("./remote-env.js");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { VastEnv } = require("./vast-env.js") as typeof import("./vast-env.js");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ModalEnv } = require("./modal-env.js") as typeof import("./modal-env.js");

    const registry: Record<
      string,
      new (cfg: Record<string, unknown>, sd: string, dr: boolean) => EnvBackend
    > = {
      local: LocalEnv,
      docker: DockerEnv,
      remote: RemoteEnv,
      vast: VastEnv,
      modal: ModalEnv,
    };
    const Cls = registry[envType];
    if (!Cls) {
      throw new Error(
        `unknown env_type '${envType}'; expected one of ${Object.keys(registry).sort().join(", ")}`,
      );
    }
    return new Cls(config, stateDir, dryRun);
  }

  protected _announce(action: string, cmd: string): Record<string, unknown> {
    return { status: "dry_run", action, command: cmd };
  }

  abstract provision(): Record<string, unknown>;
  abstract preflight(): Record<string, unknown>;
  abstract sync(src: string): Record<string, unknown>;
  abstract deploy(runSpec: Record<string, unknown>): Record<string, unknown>;
  abstract monitor(handle: Record<string, unknown>): Record<string, unknown>;
  abstract collectResults(): Record<string, unknown>;
  abstract destroy(): Record<string, unknown>;
}
