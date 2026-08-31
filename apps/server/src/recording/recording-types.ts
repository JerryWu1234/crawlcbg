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

export type AutomatedRecordedActionType =
  | "click"
  | "fill"
  | "select"
  | "setChecked"
  | "press"
  | "scroll"
  | "closePage";

export type RecordedActionType = AutomatedRecordedActionType | "manualStep";

export interface RecordedPage {
  id: string;
  url: string;
  openerPageId?: string;
}

interface RecordedActionBase {
  id: string;
  order: number;
  pageId: string;
  included: boolean;
}

export interface AutomatedRecordedAction extends RecordedActionBase {
  type: AutomatedRecordedActionType;
  selector?: string;
  value?: string | boolean | string[] | number;
  opensPageId?: string;
  controlKind?: ManualControlKind;
  displayName?: string;
  required?: boolean;
  title?: never;
  targets?: never;
}

export interface ManualStepAction extends RecordedActionBase {
  type: "manualStep";
  title: string;
  targets: ManualStepTarget[];
  selector?: never;
  value?: never;
  opensPageId?: never;
  controlKind?: never;
  displayName?: never;
  required?: never;
}

export type RecordedAction = AutomatedRecordedAction | ManualStepAction;

export interface RecordingSession {
  id: string;
  status: RecordingStatus;
  startUrl: string;
  pages: RecordedPage[];
  actions: RecordedAction[];
}

export type RecordingStreamEvent =
  | { type: "started"; recording: RecordingSession }
  | { type: "page-opened"; page: RecordedPage }
  | { type: "action"; action: RecordedAction }
  | { type: "action-updated"; action: RecordedAction }
  | { type: "stopped"; recording: RecordingSession }
  | { type: "error"; message: string };
