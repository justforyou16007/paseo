import fs from "fs";
import path from "path";
import { EnvBackend, EnvError, runShell, shellQuote } from "./env-backend.js";

const STATE_FILE = "docker-state.json";

export class DockerEnv extends EnvBackend {
  private _containerName(runSpec?: Record<string, unknown>): string {
    if (runSpec?.exp_name) return `aris-${runSpec.exp_name}`;
    return "aris-experiment";
  }

  private _statePath(): string {
    return path.join(this.stateDir, STATE_FILE);
  }

  private _saveState(state: Record<string, unknown>): void {
    const p = this._statePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
  }

  private _loadState(): Record<string, unknown> {
    const p = this._statePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    }
    return {};
  }

  provision(): Record<string, unknown> {
    if (this.dryRun) {
      const cmds = ["docker info"];
      if (this.config.dockerfile) {
        const buildCtx = (this.config.build_context as string) || ".";
        const buildArgs = Object.entries((this.config.build_args as Record<string, string>) || {})
          .map(([k, v]) => `--build-arg ${shellQuote(k)}=${shellQuote(v)}`)
          .join(" ");
        cmds.push(
          `docker build ${buildArgs} -t aris-custom -f ${shellQuote(this.config.dockerfile as string)} ${shellQuote(buildCtx)}`,
        );
      } else {
        cmds.push(`docker pull ${shellQuote((this.config.image as string) || "python:3.11")}`);
      }
      return this._announce("provision", cmds.join(" && "));
    }

    const { returncode: rc } = runShell("docker info");
    if (rc !== 0) {
      throw new EnvError(
        10,
        "Docker not running or not accessible; install Docker and ensure it's running",
      );
    }

    let image = (this.config.image as string) || "python:3.11";
    if (this.config.dockerfile) {
      const buildCtx = (this.config.build_context as string) || ".";
      const buildArgs = (this.config.build_args as Record<string, string>) || {};
      const buildArgsStr = Object.entries(buildArgs)
        .map(([k, v]) => `--build-arg ${shellQuote(k)}=${shellQuote(v)}`)
        .join(" ");
      image = "aris-custom";
      runShell(
        `docker build ${buildArgsStr} -t ${shellQuote(image)} -f ${shellQuote(this.config.dockerfile as string)} ${shellQuote(buildCtx)}`,
        { check: true },
      );
    } else {
      const { returncode: inspectRc } = runShell(
        `docker image inspect ${shellQuote(image)} >/dev/null 2>&1`,
      );
      if (inspectRc !== 0) {
        runShell(`docker pull ${shellQuote(image)}`, { check: true });
      }
    }

    return { status: "ready", env_type: "docker", image };
  }

  preflight(): Record<string, unknown> {
    const checks: Record<string, unknown>[] = [];
    let image = (this.config.image as string) || "python:3.11";
    if (this.config.dockerfile) image = "aris-custom";

    if (this.dryRun) {
      checks.push({
        name: "image-exists",
        ok: true,
        detail: `dry-run: image ${image} exists`,
      });
    } else {
      const { returncode: rc } = runShell(
        `docker image inspect ${shellQuote(image)} >/dev/null 2>&1`,
      );
      checks.push({
        name: "image-exists",
        ok: rc === 0,
        detail: rc === 0 ? `image ${image} exists` : `image ${image} not found`,
      });
    }

    const gpus = this.config.gpus as string | undefined;
    if (gpus) {
      if (this.dryRun) {
        checks.push({
          name: "gpu-available",
          ok: true,
          detail: `dry-run: gpus ${gpus} available`,
        });
      } else {
        const { returncode: rc } = runShell(
          `docker run --rm --gpus ${shellQuote(gpus)} ${shellQuote(image)} nvidia-smi`,
        );
        checks.push({
          name: "gpu-available",
          ok: rc === 0,
          detail:
            rc === 0
              ? "GPU passthrough works"
              : "GPU passthrough failed; check NVIDIA Docker runtime is installed",
        });
      }
    }

    return { ok: checks.every((c) => c.ok), checks, conda_resolved: null };
  }

  sync(src: string): Record<string, unknown> {
    if (this.dryRun) {
      return this._announce("sync", `(docker bind-mount no-op: ${src})`);
    }
    return {
      status: "synced",
      method: "bind_mount",
      remote_path: (this.config.work_dir as string) || "/workspace",
      local_src: src,
    };
  }

  deploy(runSpec: Record<string, unknown>): Record<string, unknown> {
    let image = (this.config.image as string) || "python:3.11";
    if (this.config.dockerfile) image = "aris-custom";

    const containerName = this._containerName(runSpec);
    const script = runSpec.script as string;
    const args = ((runSpec.args as string[]) || []).map(shellQuote).join(" ");
    const workDir = (this.config.work_dir as string) || "/workspace";
    const resultsDir = (this.config.results_dir as string) || "/results";

    const cmdParts = ["docker run -d", `--name ${shellQuote(containerName)}`];

    const gpus = this.config.gpus as string | undefined;
    if (gpus) cmdParts.push(`--gpus ${shellQuote(gpus)}`);

    const shmSize = (this.config.shm_size as string) || "16g";
    cmdParts.push(`--shm-size ${shellQuote(shmSize)}`);

    const runtime = this.config.runtime as string | undefined;
    if (runtime) cmdParts.push(`--runtime ${shellQuote(runtime)}`);

    const network = this.config.network as string | undefined;
    if (network) cmdParts.push(`--network ${shellQuote(network)}`);

    cmdParts.push(`-v ${shellQuote(path.resolve("."))}:${shellQuote(workDir)}`);
    fs.mkdirSync("./results", { recursive: true });
    cmdParts.push(`-v ${shellQuote(path.resolve("./results"))}:${shellQuote(resultsDir)}`);
    for (const vol of (this.config.volumes as string[]) || []) {
      cmdParts.push(`-v ${shellQuote(vol)}`);
    }

    const envVars: Record<string, unknown> = {
      ...((this.config.env_vars as Record<string, unknown>) || {}),
      ...((runSpec.env_vars as Record<string, unknown>) || {}),
    };
    for (const [k, v] of Object.entries(envVars)) {
      cmdParts.push(`-e ${shellQuote(k)}=${shellQuote(String(v))}`);
    }

    cmdParts.push(`-w ${shellQuote(workDir)}`);
    cmdParts.push(shellQuote(image));
    cmdParts.push(`python ${shellQuote(script)} ${args}`.trimEnd());

    const fullCmd = cmdParts.join(" ");

    if (this.dryRun) return this._announce("deploy", fullCmd);

    const { stdout: out } = runShell(fullCmd, { check: true });
    const containerId = out.trim();

    const handle = {
      type: "docker_container",
      container_id: containerId,
      container_name: containerName,
      image,
    };

    this._saveState({
      container_name: containerName,
      container_id: containerId,
    });

    return {
      status: "launched",
      handle,
      command: fullCmd,
      container_id: containerId,
      container_name: containerName,
    };
  }

  monitor(handle: Record<string, unknown>): Record<string, unknown> {
    const containerId = (handle.container_id as string) || (handle.container_name as string);
    if (!containerId) {
      return { status: "unknown", tail: "", exit_code: null };
    }

    if (this.dryRun) {
      return this._announce(
        "monitor",
        `docker inspect ${shellQuote(containerId)} && docker logs --tail 50 ${shellQuote(containerId)}`,
      );
    }

    const { stdout: statusOut, returncode: rc } = runShell(
      `docker inspect --format '{{.State.Status}}' ${shellQuote(containerId)}`,
    );
    if (rc !== 0) {
      return { status: "not_found", tail: "", exit_code: null };
    }

    const status = statusOut.trim();
    const running = ["running", "created", "restarting"].includes(status);

    const { stdout: logsOut } = runShell(`docker logs --tail 50 ${shellQuote(containerId)}`);

    return {
      status: running ? "running" : "done",
      exit_code: null,
      tail: logsOut.slice(-2000),
    };
  }

  collectResults(): Record<string, unknown> {
    if (this.dryRun) {
      return this._announce("collect", "(docker bind-mount no-op)");
    }
    return { status: "collected", results: [], local_copy: "./results/" };
  }

  destroy(): Record<string, unknown> {
    const autoRemove = this.config.auto_remove !== false;
    const state = this._loadState();
    const containerName = (state.container_name as string) || this._containerName();

    if (this.dryRun) {
      const cmds: string[] = [];
      if (autoRemove) {
        cmds.push(`docker stop ${shellQuote(containerName)}`);
        cmds.push(`docker rm ${shellQuote(containerName)}`);
      } else {
        cmds.push("(auto_remove=False: no destroy action)");
      }
      return this._announce("destroy", cmds.join(" && "));
    }

    let stopped = false;
    let removed = false;

    if (autoRemove) {
      runShell(`docker stop ${shellQuote(containerName)}`);
      stopped = true;
      runShell(`docker rm ${shellQuote(containerName)}`);
      removed = true;
    }

    return {
      status: "destroyed",
      container_stopped: stopped,
      container_removed: removed,
      auto_remove: autoRemove,
    };
  }
}
