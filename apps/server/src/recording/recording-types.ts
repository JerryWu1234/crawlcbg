export type RecordingStatus = "recording" | "stopped";

export type RecordedActionType =
  | "click"
  | "fill"
  | "select"
  | "setChecked"
  | "press"
  | "scroll"
  | "closePage";

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
