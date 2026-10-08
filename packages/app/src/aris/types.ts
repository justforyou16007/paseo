import type {
  ArisPaper,
  ArisIdea,
  ArisExperiment,
  ArisClaim,
  ArisProblem,
  ArisEdge,
} from "@getpaseo/protocol/messages";

export interface ArisWikiData {
  papers: ArisPaper[];
  ideas: ArisIdea[];
  experiments: ArisExperiment[];
  claims: ArisClaim[];
  problems: ArisProblem[];
  edges: ArisEdge[];
  findings: string | null;
}
