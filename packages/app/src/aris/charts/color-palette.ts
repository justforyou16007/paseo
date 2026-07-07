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
