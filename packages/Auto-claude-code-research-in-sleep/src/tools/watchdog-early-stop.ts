import * as fs from "node:fs";
import * as path from "node:path";

export interface EarlyStopConfig {
  enabled: boolean;
  max_training_time_hours?: number;
  check_interval_seconds: number;
  convergence?: {
    enabled: boolean;
    patience: number;
    min_delta: number;
  };
  divergence?: {
    enabled: boolean;
    threshold_multiplier: number;
  };
  entropy_collapse?: {
    enabled: boolean;
    threshold: number;
  };
}

export interface EarlyStopResult {
  should_stop: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ParsedMetrics {
  step?: number;
  epoch?: number;
  loss?: number;
  entropy?: number;
  timestamp?: number;
}

export function loadEarlyStopConfig(projectRoot: string): EarlyStopConfig | null {
  const configPath = path.join(projectRoot, ".aris", "experiment-env.json");

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const envConfig = JSON.parse(content);

    if (!envConfig.early_stop || !envConfig.early_stop.enabled) {
      return null;
    }

    return envConfig.early_stop as EarlyStopConfig;
  } catch {
    return null;
  }
}

export function parseTrainingLog(logPath: string, lastN: number): ParsedMetrics[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    const relevantLines = lines.slice(-lastN * 5);

    const metrics: ParsedMetrics[] = [];

    for (const line of relevantLines) {
      const metric: ParsedMetrics = {};

      const stepMatch = line.match(/\b(?:step|iteration|iter)[\s:=]+(\d+)/i);
      if (stepMatch) metric.step = Number.parseInt(stepMatch[1], 10);

      const epochMatch = line.match(/\b(?:epoch)[\s:=]+(\d+)/i);
      if (epochMatch) metric.epoch = Number.parseInt(epochMatch[1], 10);

      const lossMatch = line.match(/\b(?:loss|train_loss|training_loss)[\s:=]+([\d.]+)/i);
      if (lossMatch) metric.loss = Number.parseFloat(lossMatch[1]);

      const entropyMatch = line.match(/\b(?:entropy|policy_entropy)[\s:=]+([\d.]+)/i);
      if (entropyMatch) metric.entropy = Number.parseFloat(entropyMatch[1]);

      if (Object.keys(metric).length > 0) {
        metrics.push(metric);
      }
    }

    return metrics.slice(-lastN);
  } catch {
    return [];
  }
}

export function checkEarlyStopConditions(
  config: EarlyStopConfig,
  metrics: ParsedMetrics[],
  startTime: number,
): EarlyStopResult {
  const now = Date.now();

  if (config.max_training_time_hours) {
    const elapsedHours = (now - startTime) / (1000 * 3600);
    if (elapsedHours > config.max_training_time_hours) {
      return {
        should_stop: true,
        reason: `Max training time exceeded (${elapsedHours.toFixed(1)}h > ${config.max_training_time_hours}h)`,
        details: { elapsed_hours: elapsedHours, max_hours: config.max_training_time_hours },
      };
    }
  }

  if (metrics.length === 0) {
    return { should_stop: false };
  }

  const losses = metrics.map((m) => m.loss).filter((l) => l !== undefined) as number[];

  if (config.convergence?.enabled && losses.length > 0) {
    const patience = config.convergence.patience;
    const minDelta = config.convergence.min_delta;

    if (losses.length >= patience + 1) {
      const recentLosses = losses.slice(-patience);
      const baselineLoss = losses[losses.length - patience - 1];

      const hasImproved = recentLosses.some((loss) => baselineLoss - loss > minDelta);

      if (!hasImproved) {
        return {
          should_stop: true,
          reason: `Loss converged (no improvement > ${minDelta} for ${patience} checks)`,
          details: {
            recent_losses: recentLosses,
            baseline: baselineLoss,
            patience,
            min_delta: minDelta,
          },
        };
      }
    }
  }

  if (config.divergence?.enabled && losses.length >= 2) {
    const initialLoss = losses[0];
    const currentLoss = losses[losses.length - 1];
    const threshold = config.divergence.threshold_multiplier;

    if (currentLoss > initialLoss * threshold) {
      return {
        should_stop: true,
        reason: `Loss diverged (${currentLoss.toFixed(4)} > ${threshold}x initial ${initialLoss.toFixed(4)})`,
        details: {
          current_loss: currentLoss,
          initial_loss: initialLoss,
          threshold_multiplier: threshold,
        },
      };
    }
  }

  if (config.entropy_collapse?.enabled) {
    const entropies = metrics.map((m) => m.entropy).filter((e) => e !== undefined) as number[];

    if (entropies.length >= 3) {
      const recentEntropies = entropies.slice(-3);
      const threshold = config.entropy_collapse.threshold;

      if (recentEntropies.every((e) => e < threshold)) {
        return {
          should_stop: true,
          reason: `Entropy collapsed (< ${threshold} for 3 consecutive checks)`,
          details: {
            recent_entropies: recentEntropies,
            threshold,
          },
        };
      }
    }
  }

  return { should_stop: false };
}
