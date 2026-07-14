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
}

function getPaths(baseDir: string): Paths {
  return {
    base: baseDir,
    pid: path.join(baseDir, "watchdog.pid"),
    tasks: path.join(baseDir, "tasks.json"),
    status: path.join(baseDir, "status"),
    alerts: path.join(baseDir, "alerts.log"),
  };
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

  fs.writeFileSync(paths.tasks, JSON.stringify(tasks, null, 2));
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
  fs.writeFileSync(paths.tasks, JSON.stringify(tasks, null, 2));
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
  fs.writeFileSync(statusPath, JSON.stringify(data));

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
      lines.push(`${name}(${typ}): ${status}${extra}`);
    } catch {
      continue;
    }
  }

  const summary = lines.length > 0 ? lines.join("\n") : "no tasks";
  fs.writeFileSync(path.join(statusDir, "summary.txt"), summary);
  return summary;
}

// ── Main loop ────────────────────────────────────────────────────

function runWatchdog(baseDir: string, interval: number): void {
  const paths = getPaths(baseDir);
  fs.mkdirSync(paths.base, { recursive: true });
  fs.mkdirSync(paths.status, { recursive: true });

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

  console.log(`watchdog started (pid=${process.pid}, base=${baseDir}, interval=${interval}s)`);

  const tick = (): void => {
    if (!fs.existsSync(paths.tasks)) return;

    let tasks: TaskDef[];
    try {
      tasks = JSON.parse(fs.readFileSync(paths.tasks, "utf-8"));
    } catch {
      return;
    }

    for (const task of tasks) {
      try {
        if (task.type === "download") checkDownload(task, paths.status, interval);
        else if (task.type === "training") checkTraining(task, paths.status);
        else if (task.type === "loop") checkLoop(task, paths.status);
      } catch (e: unknown) {
        writeStatus(path.join(paths.status, `${task.name}.json`), {
          status: "ERROR",
          task: task.name,
          type: task.type,
          msg: e instanceof Error ? e.message : String(e),
          ts: nowStr(),
        });
      }
    }

    writeSummary(paths.status);
  };

  tick();
  setInterval(tick, interval * 1000);
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
