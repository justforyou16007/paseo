#!/usr/bin/env node

/**
 * watchdog.ts — Server-side unified monitoring daemon for ARIS.
 *
 * One process per server, monitors all registered tasks (training / download / loop).
 * Outputs per-task status JSON + aggregated summary.txt for low-frequency polling.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createCli, runCli } from "../lib/cli.js";
import {
  loadEarlyStopConfig,
  parseTrainingLog,
  checkEarlyStopConditions,
  type EarlyStopResult,
} from "./watchdog-early-stop.js";

const DEFAULT_BASE = "/tmp/aris-watchdog";
const DEFAULT_INTERVAL = 60;
const SLOW_SPEED_THRESHOLD = 1 * 1024 * 1024; // 1 MB/s
const GPU_IDLE_THRESHOLD = 5; // percent

const LOOP_COMPLETED_STATUSES = new Set(["completed", "done", "finished"]);

interface Paths {
  base: string;
  pid: string;
  tasks: string;
  status: string;
  alerts: string;
  heartbeat: string;
}

interface TaskDef {
  name: string;
  type: "training" | "download" | "loop";
  session?: string;
  session_type?: string;
  gpus?: number[];
  target_path?: string;
  state_file?: string;
  stale_after_seconds?: number;
  registered_at?: string;
  registered_epoch?: number;
  early_stop_config_path?: string;
  log_file?: string;
  project_root?: string;
}

interface StatusData {
  status: string;
  task: string;
  type: string;
  msg?: string;
  ts: string;
  size?: number;
  speed_mbps?: number;
  gpu_util?: Record<string, number> | number[];
  age_s?: number;
  stale_after?: number;
  reason?: string;
  details?: Record<string, unknown>;
}

function getPaths(baseDir: string): Paths {
  return {
    base: baseDir,
    pid: path.join(baseDir, "watchdog.pid"),
    tasks: path.join(baseDir, "tasks.json"),
    status: path.join(baseDir, "status"),
    alerts: path.join(baseDir, "alerts.log"),
    heartbeat: path.join(baseDir, "watchdog.heartbeat"),
  };
}

// Write-via-temp-then-rename so a reader never sees a half-written file and a
// writer killed mid-write never leaves a truncated one behind. tasks.json is
// read by the daemon every tick; a truncated JSON there would silence the
// daemon permanently (tick's parse failure path).
function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function appendAlert(alertsPath: string, message: string): void {
  try {
    fs.mkdirSync(path.dirname(alertsPath), { recursive: true });
    fs.appendFileSync(alertsPath, `[${nowStr()}] watchdog: ${message}\n`);
  } catch {
    // The alert channel itself is broken (disk full, permissions); nothing
    // else we can do from here.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to another user.
    if (err && typeof err === "object" && (err as { code?: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function nowStr(): string {
  const d = new Date();
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "T");
}

// ── Task registration ────────────────────────────────────────────

function registerTask(baseDir: string, taskJson: string): void {
  const paths = getPaths(baseDir);
  fs.mkdirSync(paths.base, { recursive: true });
  fs.mkdirSync(paths.status, { recursive: true });

  const task: TaskDef = JSON.parse(taskJson);
  const missing: string[] = [];
  if (!task.name) missing.push("name");
  if (!task.type) missing.push("type");
  if (missing.length > 0) {
    process.stderr.write(`error: missing required fields: ${JSON.stringify(missing)}\n`);
    process.exit(1);
  }

  if (!["training", "download", "loop"].includes(task.type)) {
    process.stderr.write(
      `error: type must be 'training', 'download', or 'loop', got '${task.type}'\n`,
    );
    process.exit(1);
  }
  if ((task.type === "training" || task.type === "download") && !task.session) {
    process.stderr.write(`error: ${task.type} task requires 'session'\n`);
    process.exit(1);
  }
  if (task.type === "loop" && (!task.state_file || task.stale_after_seconds == null)) {
    process.stderr.write("error: loop task requires 'state_file' and 'stale_after_seconds'\n");
    process.exit(1);
  }

  if (task.type === "loop") {
    const sas = Number(task.stale_after_seconds);
    if (!Number.isInteger(sas) || sas <= 0) {
      process.stderr.write(
        "error: loop 'stale_after_seconds' must be a positive integer (seconds)\n",
      );
      process.exit(1);
    }
    task.state_file = path.resolve(task.state_file!);
  } else if (!task.session_type) {
    task.session_type = "screen";
  }

  let tasks: TaskDef[] = [];
  if (fs.existsSync(paths.tasks)) {
    try {
      tasks = JSON.parse(fs.readFileSync(paths.tasks, "utf-8"));
    } catch {
      tasks = [];
    }
  }

  tasks = tasks.filter((t) => t.name !== task.name);
  task.registered_at = nowStr();
  task.registered_epoch = Date.now() / 1000;
  tasks.push(task);

  writeFileAtomic(paths.tasks, JSON.stringify(tasks, null, 2));
  const detail =
    task.type === "loop" ? `stale_after=${task.stale_after_seconds}s` : task.session_type;
  console.log(`registered: ${task.name} (${task.type}, ${detail})`);
}

function unregisterTask(baseDir: string, name: string): void {
  const paths = getPaths(baseDir);
  if (!fs.existsSync(paths.tasks)) {
    console.log("no tasks file found");
    return;
  }
  let tasks: TaskDef[];
  try {
    tasks = JSON.parse(fs.readFileSync(paths.tasks, "utf-8"));
  } catch {
    return;
  }
  tasks = tasks.filter((t) => t.name !== name);
  writeFileAtomic(paths.tasks, JSON.stringify(tasks, null, 2));
  const statusFile = path.join(paths.status, `${name}.json`);
  if (fs.existsSync(statusFile)) {
    fs.unlinkSync(statusFile);
  }
  console.log(`unregistered: ${name}`);
}

// ── Session checks (tmux + screen) ──────────────────────────────

function sessionAlive(sessionName: string, sessionType = "screen"): boolean {
  try {
    if (sessionType === "tmux") {
      execFileSync("tmux", ["has-session", "-t", sessionName], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } else {
      const stdout = execFileSync("screen", ["-list"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return stdout.includes(sessionName);
    }
  } catch (err: unknown) {
    if (sessionType === "tmux") return false;
    if (err && typeof err === "object" && "stdout" in err) {
      return ((err as { stdout: string }).stdout ?? "").includes(sessionName);
    }
    return false;
  }
}

// ── GPU checks ───────────────────────────────────────────────────

function getGpuUtil(): number[] {
  try {
    const stdout = execFileSync(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return stdout
      .trim()
      .split("\n")
      .filter((x: string) => x.trim())
      .map((x: string) => parseInt(x.trim(), 10));
  } catch {
    return [];
  }
}

// ── File size checks ─────────────────────────────────────────────

function getPathSize(targetPath: string): number {
  try {
    const stdout = execFileSync("du", ["-sb", targetPath], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseInt(stdout.split(/\s+/)[0], 10) || 0;
  } catch {
    return 0;
  }
}

// ── Status output ────────────────────────────────────────────────

function writeStatus(statusPath: string, data: StatusData): StatusData {
  writeFileAtomic(statusPath, JSON.stringify(data));

  const status = data.status;
  if (["DEAD", "STALLED", "STALE", "MISSING", "IDLE", "ERROR"].includes(status)) {
    const alertFile = path.join(path.dirname(statusPath), "..", "alerts.log");
    const ts = data.ts ?? nowStr();
    const task = data.task ?? "?";
    const msg = data.msg ?? "";
    const alertLine = `[${ts}] ${task}: ${status} — ${msg}\n`;
    fs.appendFileSync(alertFile, alertLine);
  }

  return data;
}

// ── Task checking logic ─────────────────────────────────────────

function checkDownload(task: TaskDef, statusDir: string, interval: number): StatusData {
  const name = task.name;
  const session = task.session!;
  const sessionType = task.session_type ?? "screen";
  const target = task.target_path ?? "";
  const statusFile = path.join(statusDir, `${name}.json`);
  const now = nowStr();

  if (!sessionAlive(session, sessionType)) {
    return writeStatus(statusFile, {
      status: "DEAD",
      task: name,
      type: "download",
      msg: `${sessionType} session gone`,
      ts: now,
    });
  }

  if (!target) {
    return writeStatus(statusFile, {
      status: "OK",
      task: name,
      type: "download",
      msg: "alive, no target_path to check size",
      ts: now,
    });
  }

  const currentSize = getPathSize(target);

  let prevSize = 0;
  if (fs.existsSync(statusFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
      prevSize = prev.size ?? 0;
    } catch {
      // ignore
    }
  }

  if (currentSize === prevSize && currentSize > 0) {
    return writeStatus(statusFile, {
      status: "STALLED",
      task: name,
      type: "download",
      size: currentSize,
      msg: "no size growth",
      ts: now,
    });
  }

  const speed = (currentSize - prevSize) / Math.max(interval, 1);

  if (speed > 0 && speed < SLOW_SPEED_THRESHOLD) {
    return writeStatus(statusFile, {
      status: "SLOW",
      task: name,
      type: "download",
      size: currentSize,
      speed_mbps: Math.round((speed / 1024 / 1024) * 100) / 100,
      ts: now,
    });
  }

  return writeStatus(statusFile, {
    status: "OK",
    task: name,
    type: "download",
    size: currentSize,
    speed_mbps: Math.round((speed / 1024 / 1024) * 100) / 100,
    ts: now,
  });
}

function checkTraining(task: TaskDef, statusDir: string): StatusData {
  const name = task.name;
  const session = task.session!;
  const sessionType = task.session_type ?? "screen";
  const statusFile = path.join(statusDir, `${name}.json`);
  const now = nowStr();

  if (!sessionAlive(session, sessionType)) {
    return writeStatus(statusFile, {
      status: "DEAD",
      task: name,
      type: "training",
      msg: `${sessionType} session gone`,
      ts: now,
    });
  }

  const gpuUtils = getGpuUtil();
  const gpus = task.gpus ?? [];

  if (gpus.length > 0 && gpuUtils.length > 0) {
    const usedUtils = gpus.filter((i) => i < gpuUtils.length).map((i) => gpuUtils[i]);
    if (usedUtils.length > 0 && usedUtils.every((u) => u < GPU_IDLE_THRESHOLD)) {
      const gpuUtilMap: Record<string, number> = {};
      for (const i of gpus) {
        if (i < gpuUtils.length) gpuUtilMap[String(i)] = gpuUtils[i];
      }
      return writeStatus(statusFile, {
        status: "IDLE",
        task: name,
        type: "training",
        gpu_util: gpuUtilMap,
        msg: `GPUs idle (<${GPU_IDLE_THRESHOLD}%)`,
        ts: now,
      });
    }
  }

  return writeStatus(statusFile, {
    status: "OK",
    task: name,
    type: "training",
    gpu_util: gpuUtils,
    ts: now,
  });
}

// ── Loop-liveness check (detect-only) ───────────────────────────

function loopIsCompleted(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (typeof s.status === "string" && LOOP_COMPLETED_STATUSES.has(s.status.toLowerCase()))
    return true;
  const phases = s.phases;
  if (
    Array.isArray(phases) &&
    phases.length > 0 &&
    phases.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ((p as Record<string, unknown>).status === "accepted" ||
          (p as Record<string, unknown>).status === "skipped"),
    )
  ) {
    return true;
  }
  return false;
}

function checkLoop(task: TaskDef, statusDir: string): StatusData {
  const name = task.name;
  const stateFile = task.state_file ?? "";
  const staleAfter = Number(task.stale_after_seconds ?? 21600);
  const statusFile = path.join(statusDir, `${name}.json`);
  const now = nowStr();

  if (!fs.existsSync(stateFile)) {
    const grace = Date.now() / 1000 - (task.registered_epoch ?? 0);
    if (grace <= staleAfter) {
      return writeStatus(statusFile, {
        status: "PENDING",
        task: name,
        type: "loop",
        msg: "state file not present yet",
        ts: now,
      });
    }
    return writeStatus(statusFile, {
      status: "MISSING",
      task: name,
      type: "loop",
      msg: `state file absent ${Math.floor(grace)}s after register (path typo?)`,
      ts: now,
    });
  }

  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    if (loopIsCompleted(state)) {
      return writeStatus(statusFile, {
        status: "COMPLETED",
        task: name,
        type: "loop",
        msg: "loop reports completion",
        ts: now,
      });
    }
  } catch {
    // not a terminal state we can read → fall through to mtime liveness
  }

  // Early stop check
  if (task.project_root && task.early_stop_config_path) {
    const earlyStopResult = checkEarlyStop(task);
    if (earlyStopResult.should_stop) {
      return writeStatus(statusFile, {
        status: "EARLY_STOP",
        task: name,
        type: "loop",
        reason: earlyStopResult.reason,
        details: earlyStopResult.details,
        msg: `Early stop triggered: ${earlyStopResult.reason}`,
        ts: now,
      });
    }
  }

  const mtime = fs.statSync(stateFile).mtimeMs / 1000;
  const age = Math.floor(Date.now() / 1000 - mtime);

  if (age > staleAfter) {
    return writeStatus(statusFile, {
      status: "STALE",
      task: name,
      type: "loop",
      age_s: age,
      stale_after: staleAfter,
      msg: `no state write in ${age}s (> ${staleAfter}s)`,
      ts: now,
    });
  }

  return writeStatus(statusFile, {
    status: "OK",
    task: name,
    type: "loop",
    age_s: age,
    stale_after: staleAfter,
    ts: now,
  });
}

function checkEarlyStop(task: TaskDef): EarlyStopResult {
  const config = loadEarlyStopConfig(task.project_root!);
  if (!config || !config.enabled) {
    return { should_stop: false };
  }

  const logPath = task.log_file || inferLogPath(task.state_file);
  if (!logPath || !fs.existsSync(logPath)) {
    return { should_stop: false };
  }

  const metrics = parseTrainingLog(logPath, 100);
  const startTime = (task.registered_epoch ?? 0) * 1000;

  return checkEarlyStopConditions(config, metrics, startTime);
}

function inferLogPath(stateFile?: string): string | null {
  if (!stateFile) return null;

  const dir = path.dirname(stateFile);
  const candidates = [
    path.join(dir, "training.log"),
    path.join(dir, "train.log"),
    path.join(dir, "../logs/training.log"),
    path.join(dir, "../training.log"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ── Summary ──────────────────────────────────────────────────────

function writeSummary(statusDir: string): string {
  const lines: string[] = [];
  let files: string[];
  try {
    files = fs
      .readdirSync(statusDir)
      .filter((f: string) => f.endsWith(".json"))
      .sort();
  } catch {
    files = [];
  }

  for (const f of files) {
    try {
      const d: StatusData = JSON.parse(fs.readFileSync(path.join(statusDir, f), "utf-8"));
      const name = d.task ?? path.basename(f, ".json");
      const status = d.status ?? "?";
      const typ = d.type ?? "?";
      let extra = "";
      if (status === "SLOW") extra = ` speed=${d.speed_mbps ?? "?"}MB/s`;
      else if (status === "IDLE") extra = ` gpu=${JSON.stringify(d.gpu_util ?? "?")}`;
      else if (status === "DEAD") extra = ` ${d.msg ?? ""}`;
      else if (status === "STALE" || status === "MISSING") extra = ` ${d.msg ?? ""}`;
      else if (status === "PENDING") extra = " (awaiting first state write)";
      else if (status === "COMPLETED") extra = " ✓";
      else if (status === "EARLY_STOP") extra = ` ⏹️  ${(d as any).reason ?? ""}`;
      lines.push(`${name}(${typ}): ${status}${extra}`);
    } catch {
      continue;
    }
  }

  const summary = lines.length > 0 ? lines.join("\n") : "no tasks";
  try {
    writeFileAtomic(path.join(statusDir, "summary.txt"), summary);
  } catch {
    // Status dir vanished mid-tick; runWatchdog's tick guard recreates it.
  }
  return summary;
}

// ── Main loop ────────────────────────────────────────────────────

function runWatchdog(baseDir: string, interval: number): void {
  const paths = getPaths(baseDir);
  fs.mkdirSync(paths.base, { recursive: true });
  fs.mkdirSync(paths.status, { recursive: true });

  // Single instance: refuse to stomp a live daemon's pid file (a second
  // daemon would interleave status writes with the first).
  if (fs.existsSync(paths.pid)) {
    const prev = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
    if (Number.isInteger(prev) && prev !== process.pid && pidAlive(prev)) {
      console.error(`watchdog already running (pid=${prev}) at ${baseDir}; exiting`);
      process.exit(0);
    }
  }

  fs.writeFileSync(paths.pid, String(process.pid));

  const handleSignal = (): void => {
    try {
      fs.unlinkSync(paths.pid);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  // A crash must leave a trace: an uncaught error kills the daemon with no
  // supervisor to restart it, so log it to alerts.log before dying. Without
  // this a long-running watchdog disappears silently mid-experiment.
  process.on("uncaughtException", (err: Error) => {
    try {
      fs.mkdirSync(paths.base, { recursive: true });
      fs.appendFileSync(
        paths.alerts,
        `[${nowStr()}] watchdog: FATAL uncaught exception, daemon exiting — ${err.stack ?? err.message}\n`,
      );
    } catch {
      // even the alert channel is broken; nothing more we can do
    }
    handleSignal();
  });

  console.log(`watchdog started (pid=${process.pid}, base=${baseDir}, interval=${interval}s)`);

  let parseFailures = 0;

  const writeHeartbeat = (taskCount: number): void => {
    // The watchdog checks everyone's liveness but nothing checked its own.
    // An external poller reads this file's mtime to detect a dead or
    // wedged daemon (pid alone can't tell alive from zombie).
    try {
      writeFileAtomic(
        paths.heartbeat,
        JSON.stringify({ ts: nowStr(), epoch: Date.now() / 1000, tasks: taskCount }),
      );
    } catch {
      // ignore — tick guard recreates dirs next round
    }
  };

  const tick = (): void => {
    // Self-heal: /tmp cleanup or manual removal can delete the base dir
    // mid-run. Recreate every tick so a missing dir degrades to "no tasks"
    // instead of an ENOENT that kills the daemon.
    fs.mkdirSync(paths.base, { recursive: true });
    fs.mkdirSync(paths.status, { recursive: true });

    if (!fs.existsSync(paths.tasks)) {
      // tasks.json gone (tmp cleanup / reboot): recreating an empty file is
      // better than silently no-op'ing forever — summary.txt becomes
      // visible "no tasks" and alerts.log records the loss.
      appendAlert(
        paths.alerts,
        "tasks.json missing (tmp cleanup or manual removal); recreated empty — re-register tasks",
      );
      writeFileAtomic(paths.tasks, "[]");
    }

    let tasks: TaskDef[];
    try {
      tasks = JSON.parse(fs.readFileSync(paths.tasks, "utf-8"));
      parseFailures = 0;
    } catch {
      // Corrupt tasks.json (e.g. a register process killed mid-write).
      // Never silently skip: count and surface it, then retry next tick.
      parseFailures += 1;
      appendAlert(
        paths.alerts,
        `tasks.json unparseable (${parseFailures} consecutive ticks); daemon idle until it is fixed or re-registered`,
      );
      writeStatus(path.join(paths.status, "_watchdog.json"), {
        status: "DEGRADED",
        task: "watchdog",
        type: "watchdog",
        msg: `tasks.json unparseable for ${parseFailures} consecutive ticks`,
        ts: nowStr(),
      });
      writeHeartbeat(0);
      return;
    }

    for (const task of tasks) {
      try {
        if (task.type === "download") checkDownload(task, paths.status, interval);
        else if (task.type === "training") checkTraining(task, paths.status);
        else if (task.type === "loop") checkLoop(task, paths.status);
      } catch (e: unknown) {
        try {
          writeStatus(path.join(paths.status, `${task.name}.json`), {
            status: "ERROR",
            task: task.name,
            type: task.type,
            msg: e instanceof Error ? e.message : String(e),
            ts: nowStr(),
          });
        } catch {
          // the error-status write itself failed (dir gone / disk full);
          // don't let it escape the interval callback and kill the daemon
        }
      }
    }

    writeStatus(path.join(paths.status, "_watchdog.json"), {
      status: "OK",
      task: "watchdog",
      type: "watchdog",
      msg: `monitoring ${tasks.length} task(s)`,
      ts: nowStr(),
    });
    writeSummary(paths.status);
    writeHeartbeat(tasks.length);
  };

  // Wrap tick so no exception can escape into the setInterval callback and
  // crash the daemon (uncaught exceptions in timers kill the process).
  const safeTick = (): void => {
    try {
      tick();
    } catch (e: unknown) {
      appendAlert(paths.alerts, `tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  safeTick();
  setInterval(safeTick, interval * 1000);
}

// ── CLI ──────────────────────────────────────────────────────────

const program = createCli("watchdog", "ARIS Watchdog — server-side task monitoring daemon");

program
  .option("--base-dir <dir>", `Working directory (default: ${DEFAULT_BASE})`, DEFAULT_BASE)
  .option(
    "--interval <seconds>",
    `Check interval in seconds (default: ${DEFAULT_INTERVAL})`,
    String(DEFAULT_INTERVAL),
  )
  .option("--register <json>", "Register a task (JSON with name, type, session)")
  .option("--unregister <name>", "Unregister a task by name")
  .option("--status", "Print current summary and exit");

program.action(
  (opts: {
    baseDir: string;
    interval: string;
    register?: string;
    unregister?: string;
    status?: boolean;
  }) => {
    const baseDir = opts.baseDir;
    const interval = parseInt(opts.interval, 10);

    if (opts.register) {
      registerTask(baseDir, opts.register);
    } else if (opts.unregister) {
      unregisterTask(baseDir, opts.unregister);
    } else if (opts.status) {
      const summaryPath = path.join(getPaths(baseDir).status, "summary.txt");
      if (fs.existsSync(summaryPath)) {
        console.log(fs.readFileSync(summaryPath, "utf-8"));
      } else {
        console.log("no status");
      }
    } else {
      runWatchdog(baseDir, interval);
    }
  },
);

runCli(program);
