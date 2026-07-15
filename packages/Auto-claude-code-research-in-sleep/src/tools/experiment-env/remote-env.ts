import { EnvBackend, EnvError, runShell, shellQuote } from "./env-backend.js";

const GPU_FREE_THRESHOLD_MIB = 500;

export class RemoteEnv extends EnvBackend {
  private _ssh(): string {
    return `ssh ${shellQuote(this.config.ssh_alias as string)}`;
  }

  private _condaPrefix(): string {
    const hook = this.config.conda_hook as string | undefined;
    const env = (this.config.conda_env as string) || "base";
    if (hook) {
      return `${hook} && conda activate ${shellQuote(env)}`;
    }
    return `conda activate ${shellQuote(env)}`;
  }

  provision(): Record<string, unknown> {
    if (this.dryRun) return this._announce("provision", `${this._ssh()} true`);
    const { returncode: rc } = runShell(`${this._ssh()} true`);
    if (rc !== 0) {
      throw new EnvError(10, `SSH connectivity failed for '${this.config.ssh_alias}'`);
    }
    return {
      status: "ready",
      env_type: "remote",
      ssh: {
        alias: this.config.ssh_alias,
        host: this.config.ssh_host || null,
        port: (this.config.ssh_port as number) || 22,
        user: this.config.ssh_user || null,
      },
    };
  }

  preflight(): Record<string, unknown> {
    const cmd =
      `${this._ssh()} nvidia-smi --query-gpu=index,memory.used,` +
      "memory.total --format=csv,noheader";
    if (this.dryRun) return this._announce("preflight", cmd);

    const { stdout: out, returncode: rc } = runShell(cmd);
    const checks: Record<string, unknown>[] = [];
    const free: number[] = [];

    if (rc !== 0) {
      checks.push({
        name: "remote-nvidia-smi",
        ok: false,
        detail: "nvidia-smi unreachable on host",
      });
    } else {
      for (const line of out.trim().split("\n")) {
        const parts = line.split(",").map((p) => p.trim());
        if (parts.length < 2) continue;
        const idx = parseInt(parts[0], 10);
        const used = parseInt(parts[1], 10);
        if (isNaN(idx) || isNaN(used)) continue;
        if (used < GPU_FREE_THRESHOLD_MIB) free.push(idx);
      }
      checks.push({
        name: "remote-gpu-free",
        ok: free.length > 0,
        detail: `free indices=${JSON.stringify(free)}`,
      });
    }

    const conda = this._condaPrefix();
    checks.push({ name: "conda-resolved", ok: true, detail: conda });
    return {
      ok: checks.every((c) => c.ok),
      checks,
      gpu_free_mib: free,
      conda_resolved: conda,
    };
  }

  sync(src: string): Record<string, unknown> {
    const method = (this.config.code_sync as string) || "rsync";
    const dst = this.config.code_dir as string;
    const alias = this.config.ssh_alias as string;

    if (method === "git") {
      if (this.dryRun) {
        return this._announce("sync", `git push && ${this._ssh()} 'cd ${dst} && git pull'`);
      }
      const { stdout: out1, returncode: rc1 } = runShell(
        "git add -A && git commit -m 'sync: experiment deployment' && git push",
      );
      if (rc1 !== 0) throw new EnvError(12, `git push failed: ${out1}`);
      const { stdout: out2, returncode: rc2 } = runShell(
        `${this._ssh()} ${shellQuote("cd " + dst + " && git pull")}`,
      );
      if (rc2 !== 0) throw new EnvError(12, `remote git pull failed: ${out2}`);
      return { status: "synced", method: "git", remote_path: `${alias}:${dst}` };
    }

    const cmd =
      `rsync -avz --include='*.py' --exclude='*' ` +
      `${shellQuote(src.replace(/\/+$/, "") + "/")} ` +
      `${shellQuote(alias + ":" + dst.replace(/\/+$/, "") + "/")}`;
    if (this.dryRun) return this._announce("sync", cmd);
    const { stdout: out, returncode: rc } = runShell(cmd);
    if (rc !== 0) throw new EnvError(12, `rsync failed: ${out}`);
    return { status: "synced", method: "rsync", remote_path: `${alias}:${dst}` };
  }

  deploy(runSpec: Record<string, unknown>): Record<string, unknown> {
    const script = runSpec.script as string;
    const args = ((runSpec.args as string[]) || []).map(shellQuote).join(" ");
    const logFile = (runSpec.log_file as string) || "experiment.log";
    const expName = (runSpec.exp_name as string) || "aris_exp";
    const gpu = runSpec.gpu_id as number | undefined;
    const envVars = (runSpec.env_vars as Record<string, unknown>) || {};

    const innerParts: string[] = [];
    const cond = this._condaPrefix();
    if (cond) innerParts.push(cond);

    let runPart = `python ${shellQuote(script)} ${args}`.trimEnd();
    if (gpu != null) {
      runPart = `CUDA_VISIBLE_DEVICES=${parseInt(String(gpu), 10)} ${runPart}`;
    }
    for (const [k, v] of Object.entries(envVars)) {
      runPart = `${k}=${shellQuote(String(v))} ${runPart}`;
    }
    runPart += ` 2>&1 | tee ${shellQuote(logFile)}`;
    innerParts.push(runPart);

    const inner = innerParts.join(" && ");
    const remoteCmd = `screen -dmS ${shellQuote(expName)} bash -c ${shellQuote(inner)}`;
    const full = `${this._ssh()} ${shellQuote(remoteCmd)}`;

    if (this.dryRun) return this._announce("deploy", full);
    const { returncode: rc } = runShell(full);
    if (rc !== 0) throw new EnvError(13, `failed to launch screen session: ${full}`);

    const handle = {
      type: "screen",
      host: this.config.ssh_alias,
      session_name: expName,
      log_file: logFile,
    };
    return { status: "launched", handle, log_file: logFile, command: full };
  }

  monitor(handle: Record<string, unknown>): Record<string, unknown> {
    const name = handle.session_name as string;
    const cmd = `${this._ssh()} ${shellQuote("screen -ls")}`;
    if (this.dryRun) return this._announce("monitor", cmd);

    const { stdout: out } = runShell(cmd);
    const running = out.includes(name);
    let tail = "";
    if (!running) {
      const log = handle.log_file as string | undefined;
      if (log) {
        const { stdout: t } = runShell(`${this._ssh()} ${shellQuote("tail -n 20 " + log)}`);
        tail = t;
      }
    }
    return { status: running ? "running" : "done", exit_code: null, tail };
  }

  collectResults(): Record<string, unknown> {
    const alias = this.config.ssh_alias as string;
    const dst = this.config.code_dir as string;
    const resultsRemote = `${dst.replace(/\/+$/, "")}/results/`;
    const local = "./results/";
    const cmd = `rsync -avz ${shellQuote(alias + ":" + resultsRemote)} ${shellQuote(local)}`;
    if (this.dryRun) return this._announce("collect", cmd);
    const { stdout: out, returncode: rc } = runShell(cmd);
    if (rc !== 0) throw new EnvError(15, `rsync results failed: ${out}`);
    return { status: "collected", results: [], local_copy: local };
  }

  destroy(): Record<string, unknown> {
    if (this.dryRun) {
      return this._announce("destroy", "(remote: stop screen only)");
    }
    return {
      status: "destroyed",
      note: "remote host retained; stop screen via monitor/kill",
    };
  }
}
