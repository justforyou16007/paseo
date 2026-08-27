import type {
  ArisPaper,
  ArisIdea,
  ArisExperiment,
  ArisClaim,
  ArisProblem,
  ArisEdge,
  ArisMetricSeries,
  ArisExperimentRun,
  ArisWikiReadResponse,
  ArisExperimentsReadResponse,
} from "@getpaseo/protocol/messages";

export type {
  ArisPaper,
  ArisIdea,
  ArisExperiment,
  ArisClaim,
  ArisProblem,
  ArisEdge,
  ArisMetricSeries,
  ArisExperimentRun,
  ArisWikiReadResponse,
  ArisExperimentsReadResponse,
};

export interface ArisWikiData {
  papers: ArisPaper[];
  ideas: ArisIdea[];
  experiments: ArisExperiment[];
  claims: ArisClaim[];
  problems: ArisProblem[];
  edges: ArisEdge[];
  findings: string | null;
}
