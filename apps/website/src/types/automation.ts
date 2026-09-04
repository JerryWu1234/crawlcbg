export interface BrowserTab {
  index: number;
  targetId: string;
  title: string;
  url: string;
  favicon: string;
}

export type RecordingStatus = "recording" | "stopped";

export type ManualControlKind =
  | "text"
  | "secret"
  | "select"
  | "multiSelect"
  | "checkbox"
  | "radioGroup"
  | "date"
  | "custom";

export interface ManualStepTarget {
  selector: string;
  controlKind: ManualControlKind;
  displayName: string;
  required?: boolean;
}

export type RecordedActionType =
  | "click"
  | "fill"
  | "select"
  | "setChecked"
  | "press"
  | "scroll"
  | "closePage"
  | "manualStep";

export type InsertRecordedActionDraft =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string | string[] }
  | { type: "setChecked"; selector: string; value: boolean }
  | { type: "press"; value: string }
  | { type: "scroll"; value: number };

export interface RecordedPage {
  id: string;
  url: string;
  openerPageId?: string;
}

export interface RecordedAction {
  id: string;
  order: number;
  pageId: string;
  type: RecordedActionType;
  selector?: string;
  structuralSelector?: string;
  value?: string | boolean | string[] | number;
  included: boolean;
  opensPageId?: string;
  controlKind?: ManualControlKind;
  displayName?: string;
  required?: boolean;
  title?: string;
  targets?: ManualStepTarget[];
}

export interface PaginationLoopSelectorCandidate {
  candidateIndex: number;
  sourceOrdinal: number;
  listSelector: string;
  sourceItemSelector: string;
  itemSelectorTemplate: string;
}

export interface RecordedPaginationLoop {
  actionIds: string[];
  listEntryActionId: string;
  nextActionId: string;
  listSelector: string;
  sourceItemSelector: string;
  itemSelectorTemplate: string;
  maxPages: number;
}

export interface RecordingSession {
  id: string;
  status: RecordingStatus;
  startUrl: string;
  pages: RecordedPage[];
  actions: RecordedAction[];
  paginationLoop?: RecordedPaginationLoop;
}

export type RecordingStreamEvent =
  | { type: "started"; recording: RecordingSession }
  | { type: "page-opened"; page: RecordedPage }
  | { type: "action"; action: RecordedAction }
  | { type: "action-updated"; action: RecordedAction }
  | { type: "stopped"; recording: RecordingSession }
  | { type: "error"; message: string };

export interface ScriptItem {
  filename: string;
  content: string;
}

export type ExecutionLogType = "log" | "done" | "error" | "cancelled";
export type ManualExecutionMode = "visible" | "background";
export type BackgroundExecutionStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ExecutionLogEntry {
  type: ExecutionLogType;
  time: string;
  message: string;
}

export interface ActiveManualStep {
  stepId: string;
  title: string;
  targetCount: number;
}

export type ManualStepResolution = "completed" | "cancelled" | "failed";

export interface ExecutionStreamEvent {
  type:
    | "accepted"
    | "started"
    | "frame"
    | "manual-step-privacy-locked"
    | "manual-step-required"
    | "manual-step-resolved"
    | ExecutionLogType;
  runId?: string;
  sequence?: number;
  time?: string;
  message?: string;
  code?: string;
  step?: number;
  stepId?: string;
  title?: string;
  targetCount?: number;
  resolution?: ManualStepResolution;
  frameUrl?: string;
}

export interface BackgroundExecutionSnapshot {
  runId: string;
  mode: "background";
  status: BackgroundExecutionStatus;
  filename: string;
  targetUrl: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  events: Array<{ sequence: number; event: ExecutionStreamEvent }>;
}

export interface HistoryItem {
  id: string;
  timestamp: string;
  label: string;
  runId?: string;
  content: string;
}

export type ScriptParamType = "string" | "number" | "boolean" | "select";
export type ScriptParamValue = string | number | boolean;
export type ScriptParamValues = Record<string, ScriptParamValue>;

export interface ScriptParamField {
  name: string;
  type: ScriptParamType;
  default: ScriptParamValue;
  label: string;
  options?: Record<string, string>;
}

export interface TraceFrame {
  step: number;
  time: string;
  message: string;
  frameUrl: string;
}

export interface TraceLogEntry {
  time: string;
  message: string;
  type?: string;
}

export interface TraceRunSummary {
  runId: string;
  filename: string;
  timestamp: string;
  totalFrames: number;
  totalLogs?: number;
  logs?: TraceLogEntry[];
}

export interface TraceRunDetail extends TraceRunSummary {
  frames?: TraceFrame[];
}

export interface DbTableInfo {
  name: string;
  count: number;
}

export type DbRow = Record<string, any>;

export interface PinnedTab {
  id: string;
  title: string;
  url: string;
  scriptFilename?: string;
  created_at?: string;
}

export type PinnedTabForm = Required<Pick<PinnedTab, "id" | "title" | "url" | "scriptFilename">>;

export type PinnedTabStatusType = "closed" | "exact" | "domain";

export interface PinnedTabStatus {
  type: PinnedTabStatusType;
  text: string;
  index: number;
}

export interface ValidationError {
  line: number;
  character: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
  errors?: ValidationError[];
}
