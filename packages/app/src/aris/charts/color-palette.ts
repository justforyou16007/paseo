/**
 * Fixed categorical palette for ARIS charts. Colors are assigned in order so a
 * filter that removes a series never repaints the survivors. These hues are
 * chosen to be distinguishable in common CVD modes; a design-system audit may
 * replace them later.
 */
export const ARIS_CATEGORICAL_PALETTE = [
  "#3b82f6", // blue-500
  "#22c55e", // green-500
  "#f59e0b", // amber-500
  "#a855f7", // purple-500
  "#ef4444", // red-500
  "#06b6d4", // cyan-500
] as const;

export function getArisSeriesColor(index: number): string {
  return ARIS_CATEGORICAL_PALETTE[index % ARIS_CATEGORICAL_PALETTE.length] ?? "#3b82f6";
}

/**
 * Idea lifecycle status colors. Maps the `ArisIdea.status` enum to a hue that
 * reads as "maturity": seed (proposed) is muted gray, growing is active blue,
 * validated is green, rejected is a dark slate so it recedes without vanishing.
 */
export const ARIS_IDEA_STATUS_COLORS: Record<string, string> = {
  seed: "#94a3b8", // slate-400 - proposed
  growing: "#3b82f6", // blue-500 - active
  validated: "#22c55e", // green-500 - piloted
  rejected: "#475569", // slate-600 - archived
};

/**
 * Experiment status colors. Planned is gray, running is amber (in-flight),
 * completed is green (verdict yes), failed is red (verdict no).
 */
export const ARIS_EXPERIMENT_STATUS_COLORS: Record<string, string> = {
  planned: "#94a3b8", // gray
  running: "#f59e0b", // amber
  completed: "#22c55e", // green - verdict yes
  failed: "#ef4444", // red - verdict no
};

/**
 * Claim status colors. Proposed is gray (drafted), confirmed is green
 * (verified), rejected is red (refuted).
 */
export const ARIS_CLAIM_STATUS_COLORS: Record<string, string> = {
  proposed: "#94a3b8", // gray - drafted
  confirmed: "#22c55e", // green - verified
  rejected: "#ef4444", // red - refuted
};

/** Neutral color for nodes without a meaningful status (e.g. papers). */
export const ARIS_NEUTRAL_NODE_COLOR = "#64748b"; // slate-500

export function getArisIdeaStatusColor(status: string): string {
  return ARIS_IDEA_STATUS_COLORS[status] ?? ARIS_NEUTRAL_NODE_COLOR;
}

export function getArisExperimentStatusColor(status: string): string {
  return ARIS_EXPERIMENT_STATUS_COLORS[status] ?? ARIS_NEUTRAL_NODE_COLOR;
}

export function getArisClaimStatusColor(status: string): string {
  return ARIS_CLAIM_STATUS_COLORS[status] ?? ARIS_NEUTRAL_NODE_COLOR;
}

/**
 * Edge stroke width derived from a connected experiment's status. Completed
 * experiments (verdict yes) draw thick links; failed (verdict no) draw thin
 * ones so the eye follows the strongest evidence.
 */
export function getArisEdgeStrokeWidth(experimentStatus: string | undefined): number {
  switch (experimentStatus) {
    case "completed":
      return 3; // thick - verdict yes
    case "running":
      return 2; // medium - partial / in-flight
    case "failed":
      return 1; // thin - verdict no
    default:
      return 1.5; // default
  }
}
