import type { ArisRunState, ArisIteration } from "@getpaseo/protocol/messages";

export interface ArisViewRun extends ArisRunState {
  iterations?: ArisIteration[];
}

export interface ArisPhaseTimelineItem {
  phaseId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  iterationCount: number;
  bestScore: number | null;
  startTime: string;
  endTime: string | null;
}

export interface ArisScorePoint {
  index: number;
  score: number | null;
  phaseId: string;
  iterationId: string;
  createdAt: string;
}

export interface ArisPipelinePhase {
  phaseId: string;
  name: string;
  status: ArisPhaseTimelineItem["status"];
  iterationCount: number;
  bestScore: number | null;
  duration: number | null;
}

export type ArisViewMode = "pipeline" | "iterations" | "detail";
