export type TransitionKind = "normal" | "alternate" | "failure" | "recovery";
export type FieldRequirement = "required" | "optional" | "conditional";
export type DataCategory = "request" | "state" | "artifact" | "event" | "side-effect";

export interface SourceRef {
  id: string;
  path: string;
  symbol: string;
  claim: string;
}

export interface DataField {
  path: string;
  type: string;
  requirement: FieldRequirement;
  example: string;
  purpose: string;
}

export interface DataDetail {
  id: string;
  title: string;
  category: DataCategory;
  producer: string;
  consumer: string;
  transformation: string;
  lifecycle: string;
  purpose: string;
  fields: DataField[];
  sourceIds: string[];
}

export interface FlowStage {
  id: string;
  eyebrow: string;
  title: string;
  state: string;
  progress: number;
  participants: string[];
  before: string;
  after: string;
  explanation: string;
  outputs: string[];
  sourceIds: string[];
}

export interface FlowTransition {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: TransitionKind;
  timing: string;
  window: readonly [number, number];
  explanation: string;
  payloadExample: string;
  dataDetailId: string;
  sourceIds: string[];
}

export interface FlowDefinition {
  id: string;
  number: string;
  title: string;
  summary: string;
  outcome: string;
  accent: string;
  primaryStageIds: string[];
  primaryTransitionIds: string[];
  stages: FlowStage[];
  transitions: FlowTransition[];
}

export interface ArchitectureParticipant {
  id: string;
  label: string;
  detail: string;
  boundary: "browser" | "node" | "external" | "storage";
  sourceIds: string[];
}

export interface ArchitectureConnection {
  id: string;
  from: string;
  to: string;
  label: string;
  protocol: string;
}

export interface FlowModel {
  title: string;
  version: string;
  classification: string;
  generatedFrom: string;
  sources: SourceRef[];
  participants: ArchitectureParticipant[];
  connections: ArchitectureConnection[];
  dataDetails: DataDetail[];
  flows: FlowDefinition[];
}
