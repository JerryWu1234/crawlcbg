import crypto from "node:crypto";
import type { Stagehand } from "@browserbasehq/stagehand";
import { ensureStagehand } from "../browser/stagehand-manager.js";
import type {
  BrowserActivityLease,
  ExecutionCoordinator,
} from "../execution/execution-coordinator.js";
import { compileRecordingToScript } from "./action-script-compiler.js";
import {
  startBrowserRecorder,
  type BrowserRecorderHandle,
  type BrowserRecorderOptions,
} from "./browser-recorder.js";
import type {
  RecordedAction,
  RecordedPage,
  RecordingSession,
  RecordingStreamEvent,
} from "./recording-types.js";

const MAX_RETAINED_RECORDINGS = 50;

type RecordingEventListener = (event: RecordingStreamEvent) => void;
type RecorderFactory = (options: BrowserRecorderOptions) => Promise<BrowserRecorderHandle>;

interface RecordingCoordinatorDependencies {
  executionCoordinator: ExecutionCoordinator;
  getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
  getStagehand?: () => Promise<Stagehand>;
  recorderFactory?: RecorderFactory;
  createId?: () => string;
}

interface RecordingRecord {
  session: RecordingSession;
  createdAt: number;
  recorder: BrowserRecorderHandle | null;
  lease: BrowserActivityLease;
  leaseReleased: boolean;
  listeners: Set<RecordingEventListener>;
  stopPromise: Promise<RecordingSession> | null;
}

export class RecordingCoordinatorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecordingCoordinatorError";
  }
}

export interface RecordingActionUpdateResult {
  action: RecordedAction;
  updatedActions: RecordedAction[];
}

export interface RecordingSubscription {
  recording: RecordingSession;
  unsubscribe: () => void;
}

const clonePage = (page: RecordedPage): RecordedPage => ({ ...page });
const cloneAction = (action: RecordedAction): RecordedAction => ({
  ...action,
  value: Array.isArray(action.value) ? [...action.value] : action.value,
});
const cloneSession = (session: RecordingSession): RecordingSession => ({
  ...session,
  pages: session.pages.map(clonePage),
  actions: session.actions.map(cloneAction),
});

export class RecordingCoordinator {
  private readonly records = new Map<string, RecordingRecord>();
  private readonly executionCoordinator: ExecutionCoordinator;
  private readonly getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
  private readonly getStagehand: () => Promise<Stagehand>;
  private readonly recorderFactory: RecorderFactory;
  private readonly createId: () => string;

  constructor({
    executionCoordinator,
    getUserVisiblePages,
    getStagehand = ensureStagehand,
    recorderFactory = startBrowserRecorder,
    createId = () => `recording_${Date.now()}_${crypto.randomUUID()}`,
  }: RecordingCoordinatorDependencies) {
    this.executionCoordinator = executionCoordinator;
    this.getUserVisiblePages = getUserVisiblePages;
    this.getStagehand = getStagehand;
    this.recorderFactory = recorderFactory;
    this.createId = createId;
  }

  async start(tabIndex: number, expectedUrl: string): Promise<RecordingSession> {
    const normalizedUrl = expectedUrl.trim();
    if (!Number.isInteger(tabIndex) || tabIndex < 0 || !normalizedUrl) {
      throw new RecordingCoordinatorError(
        "tabIndex 必须是非负整数，expectedUrl 不能为空。",
        "invalid_recording_target",
        400,
      );
    }

    const recordingId = this.createId();
    const activityResult = this.executionCoordinator.acquireBrowserActivity(
      "recording",
      recordingId,
    );
    if (!activityResult.acquired) {
      const { conflict } = activityResult;
      throw new RecordingCoordinatorError(
        conflict.kind === "recording"
          ? `录制 ${conflict.ownerId} 正在进行，请先停止当前录制。`
          : `脚本任务 ${conflict.ownerId} 正在执行，请等待执行结束或先中止任务。`,
        conflict.kind === "recording" ? "recording_busy" : "execution_busy",
        409,
      );
    }

    let record: RecordingRecord | null = null;
    try {
      let stagehand: Stagehand;
      try {
        stagehand = await this.getStagehand();
      } catch (error) {
        throw new RecordingCoordinatorError(
          "Stagehand 未连接到 Chrome 浏览器。",
          "stagehand_unavailable",
          503,
          { cause: error },
        );
      }

      const pages = await this.getUserVisiblePages(stagehand);
      const rootPage = pages[tabIndex];
      if (
        !rootPage ||
        (typeof rootPage.isClosed === "function" && rootPage.isClosed()) ||
        typeof rootPage.url !== "function" ||
        rootPage.url() !== normalizedUrl
      ) {
        throw new RecordingCoordinatorError(
          "目标标签页的序号或 URL 已变化，本轮未开始录制，请刷新页签列表后重试。",
          "target_not_found",
          409,
        );
      }

      const session: RecordingSession = {
        id: recordingId,
        status: "recording",
        startUrl: normalizedUrl,
        pages: [{ id: "page0", url: normalizedUrl }],
        actions: [],
      };
      record = {
        session,
        createdAt: Date.now(),
        recorder: null,
        lease: activityResult.lease,
        leaseReleased: false,
        listeners: new Set(),
        stopPromise: null,
      };
      this.records.set(recordingId, record);
      this.pruneStoppedRecords();

      try {
        if (typeof rootPage.sendCDP === "function") {
          await rootPage.sendCDP("Page.bringToFront");
        }
      } catch {
        // Focus is best-effort; recording still targets the fixed Page object.
      }

      record.recorder = await this.recorderFactory({
        rootPage,
        getPages: () => stagehand.context.pages(),
        onAction: (action) => this.addAction(recordingId, action),
        onActionUpdated: (action) => this.mergeRecorderActionUpdate(recordingId, action),
        onPageOpened: (page) => this.addPage(recordingId, page),
        onError: (error) => this.emit(recordingId, { type: "error", message: error.message }),
      });
      return cloneSession(record.session);
    } catch (error) {
      if (record) this.records.delete(recordingId);
      this.executionCoordinator.releaseBrowserActivity(activityResult.lease);
      if (error instanceof RecordingCoordinatorError) throw error;
      throw new RecordingCoordinatorError(
        `无法启动浏览器录制：${error instanceof Error ? error.message : String(error)}`,
        "recording_start_failed",
        500,
        { cause: error },
      );
    }
  }

  get(recordingId: string): RecordingSession {
    return cloneSession(this.requireRecord(recordingId).session);
  }

  subscribe(recordingId: string, listener: RecordingEventListener): RecordingSubscription {
    const record = this.requireRecord(recordingId);
    record.listeners.add(listener);
    let subscribed = true;
    return {
      recording: cloneSession(record.session),
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        record.listeners.delete(listener);
      },
    };
  }

  updateActionIncluded(
    recordingId: string,
    actionId: string,
    included: boolean,
  ): RecordingActionUpdateResult {
    const record = this.requireRecord(recordingId);
    const action = record.session.actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new RecordingCoordinatorError("录制动作不存在。", "action_not_found", 404);
    }
    if (included && this.isPageExcludedByParent(record, action.pageId)) {
      throw new RecordingCoordinatorError(
        "请先启用打开该页面的父点击步骤。",
        "parent_action_excluded",
        409,
      );
    }

    const updatedActions: RecordedAction[] = [];
    if (action.included !== included) {
      action.included = included;
      updatedActions.push(action);
    }
    if (!included && action.opensPageId) {
      updatedActions.push(...this.excludeDescendantActions(record, action.opensPageId));
    }

    for (const updatedAction of updatedActions) {
      this.emit(recordingId, { type: "action-updated", action: cloneAction(updatedAction) });
    }
    return {
      action: cloneAction(action),
      updatedActions: updatedActions.map(cloneAction),
    };
  }

  async stop(recordingId: string): Promise<RecordingSession> {
    const record = this.requireRecord(recordingId);
    if (record.session.status === "stopped") return cloneSession(record.session);
    if (record.stopPromise) return record.stopPromise;

    record.stopPromise = (async () => {
      let cleanupError: unknown = null;
      try {
        await record.recorder?.stop();
      } catch (error) {
        cleanupError = error;
      } finally {
        record.recorder = null;
        record.session.status = "stopped";
        this.releaseLease(record);
      }

      if (cleanupError) {
        this.emit(recordingId, {
          type: "error",
          message: `录制已停止，但页面监听器清理不完整：${
            cleanupError instanceof Error
              ? cleanupError.message
              : typeof cleanupError === "string"
                ? cleanupError
                : "未知清理错误"
          }`,
        });
      }
      const snapshot = cloneSession(record.session);
      this.emit(recordingId, { type: "stopped", recording: snapshot });
      if (cleanupError) {
        throw new RecordingCoordinatorError(
          "录制已停止，但未能完整清理页面监听器。",
          "recording_cleanup_failed",
          500,
          { cause: cleanupError },
        );
      }
      return snapshot;
    })();
    return record.stopPromise;
  }

  generate(recordingId: string): string {
    const recording = this.requireRecord(recordingId).session;
    if (recording.status !== "stopped") {
      throw new RecordingCoordinatorError(
        "请先停止录制，再生成脚本。",
        "recording_not_stopped",
        409,
      );
    }
    try {
      return compileRecordingToScript(cloneSession(recording));
    } catch (error) {
      throw new RecordingCoordinatorError(
        `无法生成录制脚本：${error instanceof Error ? error.message : String(error)}`,
        "recording_compile_failed",
        422,
        { cause: error },
      );
    }
  }

  async shutdown(): Promise<void> {
    const activeRecordingIds = [...this.records.values()]
      .filter((record) => record.session.status === "recording")
      .map((record) => record.session.id);
    await Promise.allSettled(activeRecordingIds.map((recordingId) => this.stop(recordingId)));
  }

  private requireRecord(recordingId: string): RecordingRecord {
    const record = this.records.get(recordingId);
    if (!record) {
      throw new RecordingCoordinatorError(
        "录制会话不存在或服务已重启。",
        "recording_not_found",
        404,
      );
    }
    return record;
  }

  private addPage(recordingId: string, page: RecordedPage): void {
    const record = this.records.get(recordingId);
    if (!record || record.session.status !== "recording") return;
    if (record.session.pages.some((candidate) => candidate.id === page.id)) return;
    const storedPage = clonePage(page);
    record.session.pages.push(storedPage);
    this.emit(recordingId, { type: "page-opened", page: clonePage(storedPage) });
  }

  private addAction(recordingId: string, action: RecordedAction): void {
    const record = this.records.get(recordingId);
    if (!record || record.session.status !== "recording") return;
    const existing = record.session.actions.find((candidate) => candidate.id === action.id);
    if (existing) {
      this.mergeRecorderActionUpdate(recordingId, action);
      return;
    }
    const storedAction = cloneAction(action);
    if (this.isPageExcludedByParent(record, storedAction.pageId)) {
      storedAction.included = false;
    }
    record.session.actions.push(storedAction);
    record.session.actions.sort((left, right) => left.order - right.order);
    this.emit(recordingId, { type: "action", action: cloneAction(storedAction) });
  }

  private mergeRecorderActionUpdate(recordingId: string, action: RecordedAction): void {
    const record = this.records.get(recordingId);
    if (!record || record.session.status !== "recording") return;
    const existing = record.session.actions.find((candidate) => candidate.id === action.id);
    if (!existing) {
      this.addAction(recordingId, action);
      return;
    }
    if (!action.opensPageId) return;
    existing.opensPageId = action.opensPageId;
    this.emit(recordingId, { type: "action-updated", action: cloneAction(existing) });
    if (!existing.included) {
      for (const childAction of this.excludeDescendantActions(record, action.opensPageId)) {
        this.emit(recordingId, { type: "action-updated", action: cloneAction(childAction) });
      }
    }
  }

  private isPageExcludedByParent(record: RecordingRecord, pageId: string): boolean {
    let page = record.session.pages.find((candidate) => candidate.id === pageId);
    while (page?.openerPageId) {
      const openingAction = record.session.actions.find(
        (candidate) => candidate.opensPageId === page?.id,
      );
      if (openingAction?.included === false) return true;
      page = record.session.pages.find((candidate) => candidate.id === page?.openerPageId);
    }
    return false;
  }

  private excludeDescendantActions(
    record: RecordingRecord,
    openedPageId: string,
  ): RecordedAction[] {
    const descendantPageIds = new Set<string>([openedPageId]);
    let discoveredDescendant = true;
    while (discoveredDescendant) {
      discoveredDescendant = false;
      for (const page of record.session.pages) {
        if (
          page.openerPageId &&
          descendantPageIds.has(page.openerPageId) &&
          !descendantPageIds.has(page.id)
        ) {
          descendantPageIds.add(page.id);
          discoveredDescendant = true;
        }
      }
    }

    const updatedActions: RecordedAction[] = [];
    for (const childAction of record.session.actions) {
      if (descendantPageIds.has(childAction.pageId) && childAction.included) {
        childAction.included = false;
        updatedActions.push(childAction);
      }
    }
    return updatedActions;
  }

  private emit(recordingId: string, event: RecordingStreamEvent): void {
    const record = this.records.get(recordingId);
    if (!record) return;
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch {
        record.listeners.delete(listener);
      }
    }
  }

  private releaseLease(record: RecordingRecord): void {
    if (record.leaseReleased) return;
    record.leaseReleased = true;
    this.executionCoordinator.releaseBrowserActivity(record.lease);
  }

  private pruneStoppedRecords(): void {
    if (this.records.size <= MAX_RETAINED_RECORDINGS) return;
    const stoppedRecords = [...this.records.values()]
      .filter((record) => record.session.status === "stopped")
      .sort((left, right) => left.createdAt - right.createdAt);
    while (this.records.size > MAX_RETAINED_RECORDINGS && stoppedRecords.length > 0) {
      const record = stoppedRecords.shift();
      if (record) this.records.delete(record.session.id);
    }
  }
}
