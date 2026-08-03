#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { createCli, runCli } from "../../lib/cli.js";
import { GpuSampleHistory } from "../../tools/gpu-sample-history.js";
import type { GpuSample } from "../../tools/gpu-sample-history.js";
import { EnvBackend } from "../../tools/experiment-env/env-backend.js";

const OOM_RE = /CUDA out of memory|torch\.OutOfMemoryError/;
const DEFAULT_GPU_FREE_THRESHOLD_MIB = 500;
const POLL_INTERVAL_SEC = 60;

interface OomRetryConfig {
  delay?: number;
  max_attempts?: number;
}

interface ManifestJob {
  id: string;
  cmd: string;
  expected_output?: string;
  batch_size?: {
    initial: number;
    min: number;
    max: number;
    target_mem_pct?: number;
    oom_reduction?: number;
  };
  gpu_scaling?: {
    min_gpus: number;
    max_gpus: number;
  };
}

interface ManifestPhase {
  name: string;
  depends_on?: string[];
  jobs: ManifestJob[];
}

interface Manifest {
  project?: string;
  cwd?: string;
  conda?: string;
  conda_hook?: string;
  gpus?: number[];
  max_parallel?: number;
  gpu_free_threshold_mib?: number;
  oom_retry?: OomRetryConfig;
  phases?: ManifestPhase[];
  _path?: string;
}

interface JobState {
  id: string;
  phase: string;
  cmd: string;
  expected_output?: string | null;
  status: string;
  gpu: number | null;
  gpu_list: number[] | null;
  current_batch_size: number | null;
  screen_name: string | null;
  pid: number | null;
  attempts: number;
  started: string | null;
  completed: string | null;
  error: string | null;
}

interface PhaseState {
  name: string;
  depends_on: string[];
  status: string;
}

interface QueueState {
  meta: { project: string; started: string; manifest_path?: string };
  phases: PhaseState[];
  jobs: JobState[];
}

interface AdaptiveOpts {
  gpuHistory: GpuSampleHistory;
  backend: EnvBackend | null;
  manifestJobMap: Map<string, ManifestJob>;
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function shellRun(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { stdout: stdout ?? "", exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const e = err as { status: number; stdout: string | null };
      return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
    }
    return { stdout: "", exitCode: 1 };
  }
}

function resolveCondaHook(manifestHook?: string): string {
  function wrap(pathOrCmd: string): string {
    if (pathOrCmd.startsWith("eval")) return pathOrCmd;
    return `eval "$(${pathOrCmd} shell.bash hook)"`;
  }

  if (manifestHook) return wrap(manifestHook);

  const envHook = process.env.ARIS_CONDA_HOOK;
  if (envHook) return wrap(envHook);

  const candidates = [
    path.join(os.homedir(), "anaconda3/bin/conda"),
    path.join(os.homedir(), "miniconda3/bin/conda"),
    path.join(os.homedir(), "miniforge3/bin/conda"),
    "/opt/anaconda3/bin/conda",
    "/opt/miniconda3/bin/conda",
    "/opt/miniforge3/bin/conda",
    "/usr/local/anaconda3/bin/conda",
    "/opt/homebrew/anaconda3/bin/conda",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return wrap(p);
  }

  const { stdout, exitCode } = shellRun("command -v conda 2>/dev/null");
  if (exitCode === 0 && stdout.trim()) return wrap(stdout.trim());

  return 'eval "$(conda shell.bash hook)"';
}

function gpuMemoryUsed(): number[] {
  const { stdout, exitCode } = shellRun(
    "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits",
  );
  if (exitCode !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((x) => x.trim())
    .map((x) => parseInt(x.trim(), 10));
}

function freeGpus(
  allowed: number[],
  thresholdMib: number = DEFAULT_GPU_FREE_THRESHOLD_MIB,
): number[] {
  const used = gpuMemoryUsed();
  return allowed.filter((i) => i < used.length && used[i] < thresholdMib);
}

function screenExists(name: string): boolean {
  const { stdout } = shellRun(`screen -ls | grep -F '.${name}\t'`);
  return stdout.includes(name);
}

function killScreen(name: string): void {
  shellRun(`screen -S ${name} -X quit`);
}

function detectOomInLog(logPath: string | null): boolean {
  if (!logPath || !fs.existsSync(logPath)) return false;
  try {
    const escaped = logPath.replace(/'/g, "'\\''");
    const { stdout } = shellRun(`tail -c 10000 '${escaped}'`);
    return OOM_RE.test(stdout);
  } catch {
    return false;
  }
}

function outputExists(pathPattern: string | null | undefined, cwd: string): boolean {
  if (!pathPattern) return false;
  const full = path.isAbsolute(pathPattern) ? pathPattern : path.join(cwd, pathPattern);
  const escaped = full.replace(/'/g, "'\\''");
  const { stdout } = shellRun(`ls '${escaped}' 2>/dev/null | wc -l`);
  try {
    return parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

function loadState(stateFile: string, manifest: Manifest): QueueState {
  if (fs.existsSync(stateFile)) {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8")) as QueueState;
  }
  return {
    meta: {
      project: manifest.project ?? "unknown",
      started: now(),
      manifest_path: manifest._path ?? "",
    },
    phases: (manifest.phases ?? []).map((p, i) => ({
      name: p.name ?? `phase_${i}`,
      depends_on: p.depends_on ?? [],
      status: "pending",
    })),
    jobs: [],
  };
}

function saveState(state: QueueState, stateFile: string): void {
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

function phaseReady(phaseName: string, state: QueueState): boolean {
  const phase = state.phases.find((p) => p.name === phaseName);
  if (!phase) return false;
  if (phase.depends_on.length === 0) return true;
  for (const dep of phase.depends_on) {
    const depPhase = state.phases.find((p) => p.name === dep);
    if (!depPhase || depPhase.status !== "completed") return false;
  }
  return true;
}

function phaseComplete(phaseName: string, state: QueueState): boolean {
  const phaseJobs = state.jobs.filter((j) => j.phase === phaseName);
  if (phaseJobs.length === 0) return false;
  return phaseJobs.every((j) => j.status === "completed" || j.status === "stuck");
}

function assignJobsToPhases(manifest: Manifest, state: QueueState): void {
  for (const phase of manifest.phases ?? []) {
    const phaseName = phase.name;
    for (const job of phase.jobs) {
      const existing = state.jobs.find((j) => j.id === job.id);
      if (!existing) {
        state.jobs.push({
          id: job.id,
          phase: phaseName,
          cmd: job.cmd,
          expected_output: job.expected_output ?? null,
          status: "pending",
          gpu: null,
          gpu_list: null,
          current_batch_size: null,
          screen_name: null,
          pid: null,
          attempts: 0,
          started: null,
          completed: null,
          error: null,
        });
      }
    }
  }
}

function launchJob(
  job: JobState,
  gpus: number[],
  condaEnv: string,
  cwd: string,
  logDir: string,
  condaHook: string,
  batchSize?: number | null,
): { screenName: string; pid: number | null } {
  const primaryGpu = gpus[0] ?? 0;
  const gpuList = gpus.join(",");
  const screenName = `EQ_${job.id}`;
  if (screenExists(screenName)) {
    killScreen(screenName);
    execSync("sleep 2");
  }

  const logFile = path.join(logDir, `${job.id}.log`);
  const cmdWithGpu = job.cmd.replace(/\$\{GPU\}/g, String(primaryGpu));
  const batchVal = batchSize ?? job.current_batch_size;
  const cmdFinal = cmdWithGpu
    .replace(/\$\{GPU_LIST\}/g, gpuList)
    .replace(/\$\{NUM_GPUS\}/g, String(gpus.length))
    .replace(/\$\{BATCH_SIZE\}/g, batchVal != null ? String(batchVal) : "");

  const escapedCwd = cwd.replace(/'/g, "'\\''");
  const escapedLogFile = logFile.replace(/'/g, "'\\''");
  const full =
    `cd '${escapedCwd}' && ` +
    `${condaHook} && ` +
    `conda activate ${condaEnv} && ` +
    `CUDA_VISIBLE_DEVICES=${gpuList} ${cmdFinal} 2>&1 | tee '${escapedLogFile}'`;

  const escapedFull = full.replace(/'/g, "'\\''");
  shellRun(`screen -dmS ${screenName} bash -c '${escapedFull}'`);
  execSync("sleep 2");

  const { stdout: pidOut } = shellRun(
    `ps -ef | grep 'CUDA_VISIBLE_DEVICES=${gpuList} ' | grep -v grep | grep python | awk '{print $2}' | head -1`,
  );
  const pidStr = pidOut.trim();
  const pid = /^\d+$/.test(pidStr) ? parseInt(pidStr, 10) : null;

  return { screenName, pid };
}

function jobStatusCheck(
  job: JobState,
  logDir: string,
  cwd: string,
): { status: string; error: string | null } {
  const logFile = path.join(logDir, `${job.id}.log`);

  if (job.expected_output && outputExists(job.expected_output, cwd)) {
    return { status: "completed", error: null };
  }

  if (detectOomInLog(logFile)) {
    return { status: "failed_oom", error: "CUDA OOM detected" };
  }

  if (job.screen_name && screenExists(job.screen_name)) {
    if (job.pid) {
      const { exitCode } = shellRun(`kill -0 ${job.pid} 2>/dev/null`);
      if (exitCode === 0) {
        return { status: "running", error: null };
      }
    } else {
      return { status: "running", error: null };
    }
  }

  if (!job.screen_name || !screenExists(job.screen_name)) {
    return { status: "failed_other", error: "Screen exited without expected output" };
  }

  return { status: "running", error: null };
}

function pendingJobsInActivePhases(state: QueueState, manifest: Manifest): JobState[] {
  const activePhases: string[] = [];
  for (const phase of manifest.phases ?? []) {
    const phaseName = phase.name;
    if (phaseReady(phaseName, state) && !phaseComplete(phaseName, state)) {
      activePhases.push(phaseName);
    }
  }
  return state.jobs.filter((j) => j.status === "pending" && activePhases.includes(j.phase));
}

function allocateGpusForJob(
  manifestJob: ManifestJob | undefined,
  available: number[],
): number[] | null {
  const scaling = manifestJob?.gpu_scaling;
  if (!scaling) {
    return available.length > 0 ? [available[0]] : null;
  }
  if (available.length < scaling.min_gpus) return null;
  const count = Math.min(available.length, scaling.max_gpus);
  return available.slice(0, count);
}

function selectBatchSize(
  job: JobState,
  bsCfg: ManifestJob["batch_size"],
  gpuHistory: GpuSampleHistory,
  gpus: number[],
): number | null {
  if (!bsCfg) return null;
  const current = job.current_batch_size ?? bsCfg.initial;
  const targetPct = bsCfg.target_mem_pct ?? 80;

  const stats = gpus
    .map((g) => gpuHistory.statsFor(g))
    .filter((s): s is NonNullable<typeof s> => s != null);
  if (stats.length === 0) return current;

  const avgFreeMemPct = stats.reduce((sum, s) => sum + (100 - s.avg_util_pct), 0) / stats.length;
  const headroom = avgFreeMemPct - (100 - targetPct);

  if (headroom > 15) {
    const increased = Math.min(Math.round(current * 1.2), bsCfg.max);
    return increased !== current ? increased : current;
  }
  return current;
}

function step(
  manifest: Manifest,
  state: QueueState,
  stateFile: string,
  logDir: string,
  adaptive?: AdaptiveOpts,
): void {
  const cwd = manifest.cwd ?? ".";
  const condaEnv = manifest.conda ?? "base";
  const condaHook = resolveCondaHook(manifest.conda_hook);
  const allowedGpus = manifest.gpus ?? [0, 1, 2, 3, 4, 5, 6, 7];
  const maxParallel = manifest.max_parallel ?? allowedGpus.length;
  const gpuFreeThreshold = manifest.gpu_free_threshold_mib ?? DEFAULT_GPU_FREE_THRESHOLD_MIB;
  const oomDelay = manifest.oom_retry?.delay ?? 120;
  const maxOomAttempts = manifest.oom_retry?.max_attempts ?? 3;

  // Sample GPU memory for adaptive batch size / node scaling
  if (adaptive?.backend) {
    const assignedGpus = [
      ...new Set(
        state.jobs
          .filter((j) => j.status === "running")
          .flatMap((j) => j.gpu_list ?? (j.gpu != null ? [j.gpu] : [])),
      ),
    ];
    if (assignedGpus.length > 0) {
      const result = adaptive.backend.sampleGpuMemory(assignedGpus);
      if (result.ok) {
        adaptive.gpuHistory.add(result.samples as GpuSample[]);
      }
    }
  }

  for (const job of state.jobs) {
    if (job.status !== "running") continue;
    const { status: newStatus, error: err } = jobStatusCheck(job, logDir, cwd);
    if (newStatus === "completed" || newStatus === "failed_oom" || newStatus === "failed_other") {
      job.status = newStatus;
      job.error = err;
      job.completed = now();
      if (job.screen_name) killScreen(job.screen_name);
    }
  }

  for (const job of state.jobs) {
    if (job.status !== "failed_oom") continue;
    if (job.attempts >= maxOomAttempts) {
      job.status = "stuck";
      continue;
    }
    if (job.completed) {
      const last = new Date(job.completed.replace(/Z$/, "")).getTime();
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed >= oomDelay) {
        // Reduce batch size on OOM retry if configured
        if (adaptive) {
          const manifestJob = adaptive.manifestJobMap.get(job.id);
          const bsCfg = manifestJob?.batch_size;
          if (bsCfg && job.current_batch_size != null) {
            const reduction = bsCfg.oom_reduction ?? 0.5;
            const reduced = Math.max(Math.floor(job.current_batch_size * reduction), bsCfg.min);
            job.current_batch_size = reduced;
          }
        }
        job.status = "pending";
      }
    }
  }

  const running = state.jobs.filter((j) => j.status === "running");
  const pending = pendingJobsInActivePhases(state, manifest);
  const taken = new Set(running.flatMap((j) => j.gpu_list ?? (j.gpu != null ? [j.gpu] : [])));
  const free = freeGpus(allowedGpus, gpuFreeThreshold).filter((g) => !taken.has(g));

  let launched = 0;
  const takenInCycle = new Set<number>();
  for (const job of pending) {
    if (running.length + launched >= maxParallel) break;
    const manifestJob = adaptive?.manifestJobMap.get(job.id);
    const available = free.filter((g) => !takenInCycle.has(g));
    const gpus = allocateGpusForJob(manifestJob, available);
    if (!gpus) continue;
    for (const g of gpus) takenInCycle.add(g);
    const batchSize = adaptive
      ? selectBatchSize(job, manifestJob?.batch_size, adaptive.gpuHistory, gpus)
      : null;
    const { screenName, pid } = launchJob(job, gpus, condaEnv, cwd, logDir, condaHook, batchSize);
    job.status = "running";
    job.gpu = gpus[0];
    job.gpu_list = gpus;
    if (batchSize != null) job.current_batch_size = batchSize;
    job.screen_name = screenName;
    job.pid = pid;
    job.attempts += 1;
    job.started = now();
    job.error = null;
    launched++;
  }

  for (const phase of state.phases) {
    if (phaseComplete(phase.name, state)) {
      phase.status = "completed";
    } else if (state.jobs.some((j) => j.phase === phase.name && j.status === "running")) {
      phase.status = "running";
    }
  }

  saveState(state, stateFile);
}

function allDone(state: QueueState): boolean {
  return state.jobs.every((j) => j.status === "completed" || j.status === "stuck");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function main(): void {
  const program = createCli("queue-manager", "ARIS experiment-queue scheduler");

  program
    .requiredOption("--manifest <path>", "Manifest JSON file")
    .requiredOption("--state <path>", "State file path")
    .option("--log <path>", "Human-readable log file")
    .option("--log-dir <dir>", "Per-job log directory (default: cwd)")
    .option("--poll <seconds>", "Poll interval in seconds", String(POLL_INTERVAL_SEC))
    .action(
      async (opts: {
        manifest: string;
        state: string;
        log?: string;
        logDir?: string;
        poll: string;
      }) => {
        const manifest: Manifest = JSON.parse(fs.readFileSync(opts.manifest, "utf-8"));
        manifest._path = opts.manifest;

        const logDir = opts.logDir ?? manifest.cwd ?? ".";
        fs.mkdirSync(logDir, { recursive: true });

        const state = loadState(opts.state, manifest);
        assignJobsToPhases(manifest, state);
        saveState(state, opts.state);

        const pollInterval = parseInt(opts.poll, 10) * 1000;

        const manifestJobMap = new Map<string, ManifestJob>();
        for (const phase of manifest.phases ?? []) {
          for (const job of phase.jobs) {
            manifestJobMap.set(job.id, job);
          }
        }
        const hasAdaptive = [...manifestJobMap.values()].some((j) => j.batch_size || j.gpu_scaling);
        let adaptive: AdaptiveOpts | undefined;
        if (hasAdaptive) {
          const envCfgPath = path.join(manifest.cwd ?? ".", ".aris", "experiment-env.json");
          let backend: EnvBackend | null = null;
          try {
            if (fs.existsSync(envCfgPath)) {
              const envCfg = JSON.parse(fs.readFileSync(envCfgPath, "utf-8")) as Record<
                string,
                unknown
              >;
              const envType = envCfg.env_type as string;
              const envConfig = (envCfg[envType] ?? {}) as Record<string, unknown>;
              if (envType) backend = EnvBackend.create(envType, envConfig);
            }
          } catch {
            // proceed without GPU sampling if env config unavailable
          }
          adaptive = { gpuHistory: new GpuSampleHistory(), backend, manifestJobMap };
        }

        console.log(`[${now()}] Queue manager started with ${state.jobs.length} jobs`);

        while (!allDone(state)) {
          try {
            step(manifest, state, opts.state, logDir, adaptive);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`[${now()}] Step error: ${msg}`);
          }
          await sleep(pollInterval);
        }

        console.log(`[${now()}] All jobs done`);
      },
    );

  runCli(program);
}

main();
