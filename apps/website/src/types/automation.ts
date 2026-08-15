export interface BrowserTab {
  index: number;
  title: string;
  url: string;
  favicon: string;
}

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

export interface ExecutionStreamEvent {
  type: "accepted" | "started" | "frame" | ExecutionLogType;
  runId?: string;
  sequence?: number;
  time?: string;
  message?: string;
  code?: string;
  step?: number;
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

export type ScheduleRecurrenceType = "hourly" | "daily" | "weekly" | "weekdays" | "weekends";
export type ScheduleStatus = "idle" | "running" | "error";
export type ScheduleRunStatus = "completed" | "failed" | "skipped" | "interrupted";

export interface TabScheduleInput {
  id?: string;
  targetUrl: string;
  targetTitle: string;
  scriptFilename: string;
  params: ScriptParamValues;
  recurrenceType: ScheduleRecurrenceType;
  intervalValue: number;
  runAt: string;
  enabled: boolean;
}

export interface TabSchedule extends TabScheduleInput {
  id: string;
  status: ScheduleStatus;
  nextBaseAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduleRunStatus | null;
  lastError: string | null;
  runningRunId: string | null;
  createdAt: string;
  updatedAt: string;
}
