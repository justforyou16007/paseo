export type NodeKind = "skill" | "script" | "tool";
export type SkillClassification = "entry" | "subtask" | "standalone";
export type AuthorityRole = "coordination" | "judgment" | "execution" | "mixed" | "unclear";
export type CallRelation = "call" | "reference" | "prohibited" | "import";
export type Confidence = "explicit" | "inferred";
export type ControlKind = "loop" | "retry" | "pause";
export type RouteKind = "branch" | "failure" | "recovery" | "retry" | "pause";
export type ArtifactDirection = "input" | "output" | "unknown";
export type WarningKind =
  | "inferred-call"
  | "missing-call-target"
  | "artifact-source"
  | "artifact-consumer"
  | "call-cycle"
  | "unclear-role";
export type WarningSeverity = "review" | "info";

export interface SourceLine {
  line: number;
  text: string;
}

export interface SourceReference {
  file: string;
  line: number;
  context: SourceLine[];
}

export interface ControlMarker {
  kind: ControlKind;
  summary: string;
  source: SourceReference;
}

export interface RouteOccurrence {
  condition: string;
  conditional: boolean;
  summary: string;
  source: SourceReference;
}

export interface FlowRoute {
  kind: RouteKind;
  destination: string;
  targetStepId: string | null;
  condition: string;
  conditional: boolean;
  summary: string;
  source: SourceReference;
  occurrences: RouteOccurrence[];
}

export interface AuthorityEvidence {
  role: AuthorityRole;
  summary: string;
  source: SourceReference;
}

export interface FlowStep {
  id: string;
  title: string;
  order: number;
  summary: string;
  source: SourceReference;
  authority: AuthorityRole;
  authorityEvidence: AuthorityEvidence[];
  controls: ControlMarker[];
  routes: FlowRoute[];
}

export interface SkillNode {
  id: string;
  kind: "skill";
  name: string;
  description: string;
  argumentHint: string | null;
  file: string;
  classification: SkillClassification;
  authority: AuthorityRole;
  steps: FlowStep[];
  inbound: number;
  outbound: number;
}

export interface InvocationParameter {
  name: string;
  syntax: string;
  valueHint: string | null;
  description: string;
  required: boolean;
  source: SourceReference;
}

export interface CodeNode {
  id: string;
  kind: "script" | "tool";
  name: string;
  file: string;
  description: string;
  descriptionConfidence: Confidence;
  descriptionSource: SourceReference | null;
  parameters: InvocationParameter[];
  ownerSkill: string | null;
  authority: "execution";
  inbound: number;
  outbound: number;
}

export interface CallEdge {
  id: string;
  from: string;
  to: string;
  stepId: string | null;
  relation: CallRelation;
  confidence: Confidence;
  summary: string;
  source: SourceReference;
}

export interface ArtifactUse {
  id: string;
  owner: string;
  stepId: string | null;
  direction: ArtifactDirection;
  rawPath: string;
  confidence: Confidence;
  source: SourceReference;
}

export interface ArtifactFlow {
  key: string;
  displayName: string;
  producers: ArtifactUse[];
  consumers: ArtifactUse[];
  unknownUses: ArtifactUse[];
}

export interface AuditWarning {
  id: string;
  kind: WarningKind;
  severity: WarningSeverity;
  summary: string;
  source: SourceReference | null;
}

export interface AuditCoverage {
  skillFiles: number;
  scriptFiles: number;
  toolFiles: number;
  excludedDirectories: string[];
}

export interface AuditStats {
  entries: number;
  subtasks: number;
  standalone: number;
  calls: number;
  inferredCalls: number;
  artifacts: number;
  warnings: number;
  reviewWarnings: number;
  infoWarnings: number;
}

export interface FlowAudit {
  schemaVersion: 2;
  rootName: string;
  coverage: AuditCoverage;
  stats: AuditStats;
  skills: SkillNode[];
  code: CodeNode[];
  calls: CallEdge[];
  artifacts: ArtifactFlow[];
  warnings: AuditWarning[];
}
