import fs from "fs";
import path from "path";
import { createCli, runCli } from "../lib/cli.js";

const PIVOT_STRUCTURAL_AT = 2;
const ESCALATE_HUMAN_AT = 4;

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function logPath(root: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9\-_.]/g, "");
  if (!safe || safe !== runId || runId === "." || runId === "..") {
    throw new Error(`invalid run_id '${runId}' (use [A-Za-z0-9-_.])`);
  }
  return path.join(root, ".aris", "runs", `${runId}.iterations.jsonl`);
}

function lastStale(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  let last = 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const sc = parsed["stale_count"];
        if (typeof sc === "number") last = sc;
      } catch {
        continue;
      }
    }
  } catch {
    return 0;
  }
  return last;
}

export function pivotFor(staleCount: number): string {
  if (staleCount >= ESCALATE_HUMAN_AT) return "human";
  if (staleCount >= PIVOT_STRUCTURAL_AT) return "structural";
  return "none";
}

export function note(
  root: string,
  runId: string,
  phase: string,
  newFindings: number,
  direction?: string,
): { stale_count: number; pivot: string } {
  if (newFindings < 0) {
    throw new Error(`new_findings must be >= 0, got ${newFindings}`);
  }
  const filePath = logPath(root, runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const staleCount = newFindings > 0 ? 0 : lastStale(filePath) + 1;
  const pivot = pivotFor(staleCount);
  const rec: Record<string, unknown> = {
    ts: now(),
    phase,
    new_findings: newFindings,
    stale_count: staleCount,
    pivot,
  };
  if (direction != null) {
    rec["direction"] = direction;
  }
  fs.appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf-8");
  return { stale_count: staleCount, pivot };
}

export function show(root: string, runId: string): string {
  const filePath = logPath(root, runId);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

const program = createCli(
  "iteration-log",
  "overnight-loop stall detection → forced structural pivot",
);

program
  .command("note")
  .argument("<root>")
  .argument("<run_id>")
  .argument("<phase>")
  .argument("<new_findings>")
  .option("--direction <direction>")
  .action(
    (
      root: string,
      runId: string,
      phase: string,
      newFindingsStr: string,
      opts: { direction?: string },
    ) => {
      const result = note(root, runId, phase, parseInt(newFindingsStr, 10), opts.direction);
      console.log(JSON.stringify(result));
    },
  );

program
  .command("show")
  .argument("<root>")
  .argument("<run_id>")
  .action((root: string, runId: string) => {
    process.stdout.write(show(root, runId));
  });

runCli(program);
