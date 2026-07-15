import fs from "fs";
import { EnvBackend, EnvError, runShell, shellQuote } from "./env-backend.js";

const GPU_FREE_THRESHOLD_MIB = 500;

export class LocalEnv extends EnvBackend {
  private _device(): string {
    return (this.config.device as string) || LocalEnv._detectDevice();
  }

  private static _detectDevice(): string {
    if (process.platform === "darwin") return "mps";
    const { returncode } = runShell("command -v nvidia-smi >/dev/null 2>&1");
    return returncode === 0 ? "cuda" : "cpu";
  }

  private _condaPrefix(): string {
    const hook = this.config.conda_hook as string | undefined;
    if (hook) {
      return hook + " && conda activate " + shellQuote((this.config.conda_env as string) || "base");
    }
    const env = this.config.conda_env as string | undefined;
    if (env && env !== "base") {
      return `conda activate ${shellQuote(env)}`;
    }
    return "";
  }

  provision(): Record<string, unknown> {
    if (this.dryRun) return this._announce("provision", "(local: no-op)");
    const device = this._device();
    return { status: "ready", env_type: "local", device };
  }

  preflight(): Record<string, unknown> {
    const device = this._device();
    const checks: Record<string, unknown>[] = [];
    let gpuFree: number[] | null = null;

    if (device === "cuda") {
      const { stdout: out, returncode: rc } = runShell(
        "nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader",
      );
      if (rc !== 0) {
        checks.push({ name: "nvidia-smi", ok: false, detail: "nvidia-smi unavailable" });
      } else {
        const free: (number | null)[] = [];
        for (const line of out.trim().split("\n")) {
          const parts = line.split(",").map((p) => p.trim());
          if (parts.length < 3) continue;
          const idx = parseInt(parts[0], 10);
          const used = parseInt(parts[1], 10);
          if (isNaN(idx) || isNaN(used)) continue;
          free.push(used < GPU_FREE_THRESHOLD_MIB ? idx : null);
        }
        const freeIdx = free.filter((i): i is number => i !== null);
        gpuFree = freeIdx;
        checks.push({
          name: "cuda-gpu-free",
          ok: freeIdx.length > 0,
          detail: `free indices=${JSON.stringify(freeIdx)} (threshold <${GPU_FREE_THRESHOLD_MIB} MiB)`,
        });
      }
    } else if (device === "mps") {
      const { stdout: out, returncode: rc } = runShell(
        `python -c "import torch; print('MPS available:', torch.backends.mps.is_available())"`,
      );
      checks.push({
        name: "mps-available",
        ok: rc === 0 && out.includes("True"),
        detail: out.trim() || "torch import failed",
      });
    } else {
      checks.push({ name: "device", ok: true, detail: `device=${device} (no GPU preflight)` });
    }

    const conda = this._condaPrefix();
    if (conda) {
      checks.push({ name: "conda-resolved", ok: true, detail: conda });
    }
    const ok = checks.every((c) => c.ok);
    return {
      ok,
      checks,
      gpu_free_mib: gpuFree,
      conda_resolved: conda || null,
      device,
    };
  }

  sync(src: string): Record<string, unknown> {
    if (this.dryRun) return this._announce("sync", `(local no-op: ${src})`);
    return { status: "synced", method: "local_noop", remote_path: src };
  }

  deploy(runSpec: Record<string, unknown>): Record<string, unknown> {
    const script = runSpec.script as string;
    const args = ((runSpec.args as string[]) || []).map(shellQuote).join(" ");
    const logFile = (runSpec.log_file as string) || "experiment.log";
    const envVars = (runSpec.env_vars as Record<string, unknown>) || {};
    const prefix = this._condaPrefix();

    let runPart = `python ${shellQuote(script)} ${args}`.trimEnd();
    if (this._device() === "cuda" && "gpu_id" in runSpec) {
      runPart = `CUDA_VISIBLE_DEVICES=${parseInt(runSpec.gpu_id as string, 10)} ${runPart}`;
    }
    for (const [k, v] of Object.entries(envVars)) {
      runPart = `${k}=${shellQuote(String(v))} ${runPart}`;
    }
    runPart += ` 2>&1 | tee ${shellQuote(logFile)}`;

    const cmdParts: string[] = [];
    if (prefix) cmdParts.push(prefix);
    cmdParts.push(runPart);
    const cmd = cmdParts.join(" && ");

    if (this.dryRun) return this._announce("deploy", cmd);

    const full = `nohup bash -c ${shellQuote(cmd)} >/dev/null 2>&1 & echo $!`;
    const { stdout: out, returncode: rc } = runShell(full);
    if (rc !== 0 || !out.trim()) {
      throw new EnvError(13, `failed to launch local job: ${cmd}`);
    }
    const pidStr = out.trim().split("\n").pop()!;
    const pid = /^\d+$/.test(pidStr) ? parseInt(pidStr, 10) : pidStr;
    const handle = {
      type: "local_pid",
      pid,
      session_name: (runSpec.exp_name as string) || "local_exp",
      log_file: logFile,
    };
    return { status: "launched", handle, log_file: logFile, command: cmd };
  }

  monitor(handle: Record<string, unknown>): Record<string, unknown> {
    const pid = handle.pid;
    if (typeof pid !== "number") {
      return { status: "unknown", tail: "", exit_code: null };
    }
    if (this.dryRun) return this._announce("monitor", `kill -0 ${pid}`);

    const { returncode: rc } = runShell(`kill -0 ${pid} 2>/dev/null`);
    if (rc === 0) {
      return { status: "running", exit_code: null, tail: "" };
    }
    let tail = "";
    const log = handle.log_file as string | undefined;
    if (log && fs.existsSync(log)) {
      const { stdout: t } = runShell(`tail -n 20 ${shellQuote(log)}`);
      tail = t;
    }
    return { status: "done", exit_code: null, tail };
  }

  collectResults(): Record<string, unknown> {
    if (this.dryRun) return this._announce("collect", "(local no-op)");
    return { status: "collected", results: [], local_copy: "." };
  }

  destroy(): Record<string, unknown> {
    if (this.dryRun) return this._announce("destroy", "(local no-op)");
    return { status: "destroyed" };
  }
}
