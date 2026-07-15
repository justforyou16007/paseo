import fs from "fs";
import path from "path";
import { EnvBackend, EnvError, runShell, shellQuote } from "./env-backend.js";

const VAST_STATE = "vast-instances.json";
const DEFAULT_IMAGE = "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel";

interface VastInstance {
  instance_id: string | number;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_url?: string;
  status?: string;
  experiment?: string | null;
  gpu_name?: string;
  num_gpus?: unknown;
  dph?: unknown;
  image?: string;
  estimated_hours?: unknown;
  estimated_cost?: unknown;
  [key: string]: unknown;
}

export class VastEnv extends EnvBackend {
  private _statePath(): string {
    return path.join(this.stateDir, VAST_STATE);
  }

  private _loadInstances(): VastInstance[] {
    const p = this._statePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as VastInstance[];
    }
    return [];
  }

  private _saveInstances(instances: VastInstance[]): void {
    const p = this._statePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(instances, null, 2) + "\n");
    fs.renameSync(tmp, p);
  }

  private _findInstance(instanceId: string | number): VastInstance | null {
    for (const inst of this._loadInstances()) {
      if (String(inst.instance_id) === String(instanceId)) return inst;
    }
    return null;
  }

  private _upsertInstance(record: VastInstance): void {
    const instances = this._loadInstances();
    let found = false;
    for (let i = 0; i < instances.length; i++) {
      if (String(instances[i].instance_id) === String(record.instance_id)) {
        instances[i] = record;
        found = true;
        break;
      }
    }
    if (!found) instances.push(record);
    this._saveInstances(instances);
  }

  static parseSshUrl(url: string): [string, number, string] {
    let rest = url;
    if (rest.startsWith("ssh://")) rest = rest.slice(6);
    let user = "root";
    if (rest.includes("@")) {
      const atIdx = rest.indexOf("@");
      user = rest.slice(0, atIdx);
      rest = rest.slice(atIdx + 1);
    }
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) return [rest, 22, user];
    const host = rest.slice(0, colonIdx);
    const portStr = rest.slice(colonIdx + 1);
    return [host, portStr ? parseInt(portStr, 10) : 22, user];
  }

  provision(): Record<string, unknown> {
    const cfg = this.config;
    const instanceId = cfg.instance_id;
    if (instanceId != null) {
      return this._provisionReuse(instanceId);
    }
    return this._provisionFresh();
  }

  private _provisionReuse(instanceId: unknown): Record<string, unknown> {
    const cmd = `vastai ssh-url ${shellQuote(String(instanceId))}`;
    if (this.dryRun) return this._announce("provision-reuse", cmd);

    const { stdout: out, returncode: rc } = runShell(cmd);
    if (rc !== 0 || !out.includes("ssh://")) {
      throw new EnvError(10, `vastai ssh-url failed for ${instanceId}: ${out}`);
    }
    const url = out.trim().split("\n").pop()!.trim();
    const [host, port, user] = VastEnv.parseSshUrl(url);

    const verify =
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ` +
      `-p ${port} ${user}@${host} "nvidia-smi && echo CONNECTION_OK"`;
    const { stdout: vout, returncode: vrc } = runShell(verify);
    if (vrc !== 0 || !vout.includes("CONNECTION_OK")) {
      throw new EnvError(10, `SSH verify failed for instance ${instanceId}: ${vout}`);
    }

    const existing: VastInstance =
      this._findInstance(instanceId as string | number) || ({} as VastInstance);
    Object.assign(existing, {
      instance_id: instanceId,
      ssh_host: host,
      ssh_port: port,
      ssh_user: user,
      ssh_url: url,
      status: "running",
    });
    this._upsertInstance(existing);

    return {
      status: "ready",
      env_type: "vast",
      instance_id: instanceId,
      ssh: { host, port, user },
    };
  }

  private _provisionFresh(): Record<string, unknown> {
    const cfg = this.config;
    const offerId = cfg.offer_id;
    const image = (cfg.image as string) || DEFAULT_IMAGE;
    const disk = (cfg.disk_gb as number) || 10;
    const onstart = "apt-get update && apt-get install -y git screen rsync";
    const create =
      `vastai create instance ${shellQuote(String(offerId))} ` +
      `--image ${shellQuote(image)} --disk ${disk} --ssh --direct ` +
      `--onstart-cmd ${shellQuote(onstart)}`;

    if (this.dryRun) return this._announce("provision-fresh", create);

    if (!offerId) {
      throw new EnvError(
        10,
        "fresh vast rental requires `offer_id` in config (the SKILL presents cost options first)",
      );
    }

    const { stdout: out, returncode: rc } = runShell(create);
    if (rc !== 0 || !out.includes("new_contract")) {
      throw new EnvError(10, `vastai create instance failed: ${out}`);
    }

    let instanceId: string | null = null;
    for (const tok of out.replace(/'/g, " ").replace(/,/g, " ").split(/\s+/)) {
      if (/^\d+$/.test(tok)) {
        instanceId = tok;
        break;
      }
    }
    if (!instanceId) {
      throw new EnvError(10, `could not parse instance id from: ${out}`);
    }

    // Poll until running (synchronous polling with sleep)
    let running = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const { stdout: s } = runShell("vastai show instances --raw");
      try {
        const insts = JSON.parse(s) as Array<Record<string, unknown>>;
        const st = insts.find((i) => String(i.id) === String(instanceId))?.actual_status;
        if (st === "running") {
          running = true;
          break;
        }
      } catch {
        // parse error, retry
      }
      // Synchronous sleep using Atomics.wait
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, 20000);
    }
    if (!running) {
      throw new EnvError(10, `instance ${instanceId} did not reach running`);
    }

    const { stdout: urlOut } = runShell(`vastai ssh-url ${instanceId}`);
    const [host, port, user] = VastEnv.parseSshUrl(urlOut.trim().split("\n").pop()!);

    const record: VastInstance = {
      instance_id: parseInt(instanceId, 10),
      gpu_name: cfg.gpu_name as string | undefined,
      num_gpus: cfg.num_gpus,
      dph: cfg.dph,
      ssh_url: urlOut.trim(),
      ssh_host: host,
      ssh_port: port,
      ssh_user: user,
      status: "running",
      image,
      experiment: null,
      estimated_hours: null,
      estimated_cost: null,
    };
    this._upsertInstance(record);

    return {
      status: "ready",
      env_type: "vast",
      instance_id: parseInt(instanceId, 10),
      ssh: { host, port, user },
    };
  }

  preflight(): Record<string, unknown> {
    const [host, port, user] = this._resolveSsh();
    const cmd =
      `ssh -o StrictHostKeyChecking=no -p ${port} ${user}@${host} ` +
      `'nvidia-smi --query-gpu=index,memory.used --format=csv,noheader'`;
    if (this.dryRun) return this._announce("preflight", cmd);

    const { stdout: out, returncode: rc } = runShell(cmd);
    const free: number[] = [];
    if (rc === 0) {
      for (const line of out.trim().split("\n")) {
        const parts = line.split(",").map((p) => p.trim());
        try {
          const idx = parseInt(parts[0], 10);
          const used = parseInt(parts[1], 10);
          if (!isNaN(idx) && !isNaN(used) && used < 500) free.push(idx);
        } catch {
          continue;
        }
      }
    }
    const checks: Record<string, unknown>[] = [
      {
        name: "vast-gpu-free",
        ok: free.length > 0,
        detail: `free indices=${JSON.stringify(free)}`,
      },
    ];

    const { stdout: torchOut } = runShell(
      `ssh -o StrictHostKeyChecking=no -p ${port} ${user}@${host} ` +
        `"cd /workspace/project && python -c 'import torch; print(torch.cuda.is_available())'"`,
    );
    checks.push({
      name: "vast-torch",
      ok: torchOut.includes("True"),
      detail: torchOut.trim() || "torch unavailable",
    });

    return {
      ok: checks.every((c) => c.ok),
      checks,
      gpu_free_mib: free,
      conda_resolved: null,
    };
  }

  private _resolveSsh(): [string, number, string] {
    if (this.config.ssh_host) {
      return [
        this.config.ssh_host as string,
        parseInt(String(this.config.ssh_port ?? 22), 10),
        (this.config.ssh_user as string) || "root",
      ];
    }
    const instanceId = this.config.instance_id;
    if (instanceId != null) {
      const inst = this._findInstance(instanceId as string | number);
      if (inst?.ssh_host) {
        return [inst.ssh_host, inst.ssh_port ?? 22, inst.ssh_user ?? "root"];
      }
    }
    if (instanceId == null) {
      throw new EnvError(11, "no vast instance_id to resolve SSH for");
    }
    const { stdout: out, returncode: rc } = runShell(`vastai ssh-url ${instanceId}`);
    if (rc !== 0 || !out.includes("ssh://")) {
      throw new EnvError(11, `cannot resolve ssh-url for ${instanceId}: ${out}`);
    }
    return VastEnv.parseSshUrl(out.trim().split("\n").pop()!);
  }

  sync(src: string): Record<string, unknown> {
    const [host, port, user] = this._resolveSsh();
    const dst = (this.config.code_dir as string) || "/workspace/project/";
    const cmd =
      `rsync -avz -e ${shellQuote("ssh -p " + port)} ` +
      `--include='*.py' --include='*.yaml' --include='*.yml' ` +
      `--include='*.json' --include='*.txt' --include='*.sh' ` +
      `--include='*/' --exclude='*.pt' --exclude='*.pth' ` +
      `--exclude='*.ckpt' --exclude='__pycache__' --exclude='.git' ` +
      `--exclude='data/' --exclude='wandb/' --exclude='outputs/' ` +
      `${shellQuote(src.replace(/\/+$/, "") + "/")} ` +
      `${user}@${host}:${shellQuote(dst.replace(/\/+$/, "") + "/")}`;

    if (this.dryRun) return this._announce("sync", cmd);

    const { stdout: out, returncode: rc } = runShell(cmd);
    if (rc !== 0) throw new EnvError(12, `vast rsync failed: ${out}`);

    const reqPath = path.join(src, "requirements.txt");
    if (fs.existsSync(reqPath)) {
      runShell(`scp -P ${port} ${shellQuote(reqPath)} ${user}@${host}:/workspace/`);
      runShell(
        `ssh -p ${port} ${user}@${host} ${shellQuote("pip install -q -r /workspace/requirements.txt")}`,
      );
    }

    return {
      status: "synced",
      method: "rsync",
      remote_path: `${user}@${host}:${dst}`,
    };
  }

  deploy(runSpec: Record<string, unknown>): Record<string, unknown> {
    const [host, port, user] = this._resolveSsh();
    const script = runSpec.script as string;
    const args = ((runSpec.args as string[]) || []).map(shellQuote).join(" ");
    const logFile = (runSpec.log_file as string) || "experiment.log";
    const expName = (runSpec.exp_name as string) || "aris_exp";
    const gpu = runSpec.gpu_id as number | undefined;
    const work = (this.config.code_dir as string) || "/workspace/project/";

    const innerParts = [`cd ${shellQuote(work.replace(/\/+$/, ""))}`];
    let runPart = `python ${shellQuote(script)} ${args}`.trimEnd();
    if (gpu != null) {
      runPart = `CUDA_VISIBLE_DEVICES=${parseInt(String(gpu), 10)} ${runPart}`;
    }
    runPart += ` 2>&1 | tee /workspace/${shellQuote(logFile)}`;
    innerParts.push(runPart);

    const inner = innerParts.join(" && ");
    const remote = `screen -dmS ${shellQuote(expName)} bash -c ${shellQuote(inner)}`;
    const full = `ssh -p ${port} ${user}@${host} ${shellQuote(remote)}`;

    if (this.dryRun) return this._announce("deploy", full);

    const { returncode: rc } = runShell(full);
    if (rc !== 0) throw new EnvError(13, `vast deploy failed: ${full}`);

    const instanceId = this.config.instance_id;
    if (instanceId != null) {
      const inst: VastInstance =
        this._findInstance(instanceId as string | number) ||
        ({ instance_id: instanceId } as VastInstance);
      inst.experiment = expName;
      this._upsertInstance(inst);
    }

    const handle = {
      type: "screen",
      host,
      port,
      user,
      session_name: expName,
      log_file: `/workspace/${logFile}`,
      instance_id: instanceId,
    };
    return {
      status: "launched",
      handle,
      log_file: `/workspace/${logFile}`,
      command: full,
    };
  }

  monitor(handle: Record<string, unknown>): Record<string, unknown> {
    const name = handle.session_name as string;
    const port = (handle.port as number) || 22;
    const user = (handle.user as string) || "root";
    const host = handle.host as string;
    const cmd = `ssh -p ${port} ${user}@${host} ${shellQuote("screen -ls")}`;

    if (this.dryRun) return this._announce("monitor", cmd);

    const { stdout: out } = runShell(cmd);
    const running = out.includes(name);
    let tail = "";
    if (!running && handle.log_file) {
      const { stdout: t } = runShell(
        `ssh -p ${port} ${user}@${host} ${shellQuote("tail -n 20 " + (handle.log_file as string))}`,
      );
      tail = t;
    }
    return { status: running ? "running" : "done", exit_code: null, tail };
  }

  collectResults(): Record<string, unknown> {
    const [host, port, user] = this._resolveSsh();
    const cmd =
      `rsync -avz -e ${shellQuote("ssh -p " + port)} ` +
      `${user}@${host}:/workspace/project/results/ ./results/`;

    if (this.dryRun) return this._announce("collect", cmd);

    const { stdout: out, returncode: rc } = runShell(cmd);
    if (rc !== 0) {
      throw new EnvError(15, `vast collect results failed: ${out}`);
    }
    runShell(`scp -P ${port} ${user}@${host}:/workspace/*.log ./logs/ 2>/dev/null`);
    return { status: "collected", results: [], local_copy: "./results/" };
  }

  destroy(): Record<string, unknown> {
    const instanceId = this.config.instance_id;
    const auto = this.config.auto_destroy !== false;
    if (!auto) {
      return {
        status: "skipped",
        note: "auto_destroy=false; instance retained",
      };
    }
    if (instanceId == null) {
      throw new EnvError(16, "cannot destroy: no instance_id");
    }
    if (this.dryRun) {
      return this._announce("destroy", `vastai destroy instance ${instanceId}`);
    }

    try {
      this.collectResults();
    } catch {
      // results may already be collected; proceed to destroy
    }

    const { stdout: out, returncode: rc } = runShell(
      `vastai destroy instance ${shellQuote(String(instanceId))}`,
    );
    if (rc !== 0) {
      throw new EnvError(16, `vastai destroy instance failed: ${out}`);
    }

    const inst: VastInstance =
      this._findInstance(instanceId as string | number) ||
      ({ instance_id: instanceId } as VastInstance);
    inst.status = "destroyed";
    this._upsertInstance(inst);
    return { status: "destroyed", instance_id: instanceId };
  }
}
