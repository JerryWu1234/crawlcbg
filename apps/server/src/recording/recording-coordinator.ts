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
import { inferPaginationLoopSelectorCandidates } from "./pagination-loop.js";
import type {
  ManualControlKind,
  ManualStepTarget,
  PaginationLoopSelectorCandidate,
  RecordedAction,
  RecordedPage,
  RecordedPaginationLoop,
  RecordingSession,
  RecordingStreamEvent,
} from "./recording-types.js";

const MAX_RETAINED_RECORDINGS = 50;
const MAX_PAGINATION_LOOP_PAGES = 1_000;
const MAX_MANUAL_STEP_ACTIONS = 50;
const MAX_MANUAL_STEP_TARGETS = 50;
const MAX_MANUAL_STEP_TITLE_LENGTH = 120;

export type ManualStepConversionMode = "controls" | "custom";

export interface ManualStepConversionInput {
  actionIds: string[];
  mode?: ManualStepConversionMode;
  title?: string;
}

type RecordingEventListener = (event: RecordingStreamEvent) => void;
type RecorderFactory = (options: BrowserRecorderOptions) => Promise<BrowserRecorderHandle>;

export interface PaginationLoopSelectionInput {
  actionIds: string[];
  listEntryActionId: string;
  nextActionId: string;
}

export interface CreatePaginationLoopInput extends PaginationLoopSelectionInput {
  candidateIndex: number;
  maxPages: number;
}

export interface PaginationLoopPreview extends PaginationLoopSelectionInput {
  candidates: PaginationLoopSelectorCandidate[];
}

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

interface ValidatedPaginationLoopSelection {
  actionIds: string[];
  listEntryAction: RecordedAction;
  nextAction: RecordedAction;
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
  removedActionIds?: string[];
}

export interface RecordingSubscription {
  recording: RecordingSession;
  unsubscribe: () => void;
}

const clonePage = (page: RecordedPage): RecordedPage => ({ ...page });
const cloneTarget = (target: ManualStepTarget): ManualStepTarget => ({ ...target });
const cloneAction = (action: RecordedAction): RecordedAction =>
  action.type === "manualStep"
    ? { ...action, targets: action.targets.map(cloneTarget) }
    : {
        ...action,
        value: Array.isArray(action.value) ? [...action.value] : action.value,
      };
const clonePaginationLoop = (loop: RecordedPaginationLoop): RecordedPaginationLoop => ({
  ...loop,
  actionIds: [...loop.actionIds],
});
const cloneSession = (session: RecordingSession): RecordingSession => ({
  ...session,
  pages: session.pages.map(clonePage),
  actions: session.actions.map(cloneAction),
  ...(session.paginationLoop
    ? { paginationLoop: clonePaginationLoop(session.paginationLoop) }
    : {}),
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
    if (record.session.paginationLoop?.actionIds.includes(actionId)) {
      throw new RecordingCoordinatorError(
        "循环内的步骤不能单独启用或停用，请先解散分页循环。",
        "pagination_loop_action_locked",
        409,
      );
    }
    if (
      !included &&
      action.opensPageId &&
      this.paginationLoopUsesDescendantPage(record, action.opensPageId)
    ) {
      throw new RecordingCoordinatorError(
        "该步骤打开的页面包含分页循环，请先解散循环。",
        "pagination_loop_action_locked",
        409,
      );
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

  previewPaginationLoop(
    recordingId: string,
    input: PaginationLoopSelectionInput,
  ): PaginationLoopPreview {
    const record = this.requireRecord(recordingId);
    this.requireStoppedRecording(record);
    if (record.session.paginationLoop) {
      throw new RecordingCoordinatorError(
        "该录制已配置分页循环，请先解散现有循环。",
        "pagination_loop_exists",
        409,
      );
    }

    const selection = this.validatePaginationLoopSelection(record, input);
    const selector =
      selection.listEntryAction.structuralSelector ?? selection.listEntryAction.selector ?? "";
    const candidates = inferPaginationLoopSelectorCandidates(selector);
    if (candidates.length === 0) {
      throw new RecordingCoordinatorError(
        "列表入口步骤没有可用于循环的 :nth-of-type() 结构选择器。",
        "pagination_loop_selector_not_found",
        422,
      );
    }

    return {
      actionIds: [...selection.actionIds],
      listEntryActionId: selection.listEntryAction.id,
      nextActionId: selection.nextAction.id,
      candidates,
    };
  }

  createPaginationLoop(recordingId: string, input: CreatePaginationLoopInput): RecordingSession {
    if (
      !Number.isInteger(input?.maxPages) ||
      input.maxPages < 1 ||
      input.maxPages > MAX_PAGINATION_LOOP_PAGES
    ) {
      throw new RecordingCoordinatorError(
        `maxPages 必须是 1 到 ${MAX_PAGINATION_LOOP_PAGES} 之间的整数。`,
        "invalid_pagination_loop_max_pages",
        400,
      );
    }
    if (!Number.isInteger(input?.candidateIndex) || input.candidateIndex < 0) {
      throw new RecordingCoordinatorError(
        "candidateIndex 必须是非负整数。",
        "invalid_pagination_loop_candidate",
        400,
      );
    }

    const preview = this.previewPaginationLoop(recordingId, input);
    const candidate = preview.candidates.find(
      (item) => item.candidateIndex === input.candidateIndex,
    );
    if (!candidate) {
      throw new RecordingCoordinatorError(
        "所选列表结构候选不存在，请重新预览。",
        "pagination_loop_candidate_not_found",
        422,
      );
    }

    const record = this.requireRecord(recordingId);
    record.session.paginationLoop = {
      actionIds: [...preview.actionIds],
      listEntryActionId: preview.listEntryActionId,
      nextActionId: preview.nextActionId,
      listSelector: candidate.listSelector,
      sourceItemSelector: candidate.sourceItemSelector,
      itemSelectorTemplate: candidate.itemSelectorTemplate,
      maxPages: input.maxPages,
    };
    return cloneSession(record.session);
  }

  dissolvePaginationLoop(recordingId: string): RecordingSession {
    const record = this.requireRecord(recordingId);
    this.requireStoppedRecording(record);
    if (!record.session.paginationLoop) {
      throw new RecordingCoordinatorError(
        "该录制没有可解散的分页循环。",
        "pagination_loop_not_found",
        404,
      );
    }
    delete record.session.paginationLoop;
    return cloneSession(record.session);
  }

  createManualStep(
    recordingId: string,
    input: ManualStepConversionInput,
  ): RecordingActionUpdateResult {
    const record = this.requireRecord(recordingId);
    if (record.session.status !== "stopped") {
      throw new RecordingCoordinatorError(
        "请先停止录制，再转换人工操作步骤。",
        "recording_not_stopped",
        409,
      );
    }
    if (
      !input ||
      !Array.isArray(input.actionIds) ||
      input.actionIds.length === 0 ||
      input.actionIds.length > MAX_MANUAL_STEP_ACTIONS ||
      input.actionIds.some((actionId) => typeof actionId !== "string" || !actionId)
    ) {
      throw new RecordingCoordinatorError(
        `actionIds 必须包含 1-${MAX_MANUAL_STEP_ACTIONS} 个有效动作 ID。`,
        "invalid_manual_step_actions",
        400,
      );
    }
    const selectedIds = new Set(input.actionIds);
    if (selectedIds.size !== input.actionIds.length) {
      throw new RecordingCoordinatorError(
        "人工操作步骤不能包含重复动作。",
        "duplicate_manual_step_action",
        400,
      );
    }

    const mode = input.mode ?? "controls";
    if (mode !== "controls" && mode !== "custom") {
      throw new RecordingCoordinatorError(
        "人工操作转换模式必须是 controls 或 custom。",
        "invalid_manual_step_mode",
        400,
      );
    }
    if (input.title !== undefined && typeof input.title !== "string") {
      throw new RecordingCoordinatorError(
        "人工操作标题必须是字符串。",
        "invalid_manual_step_title",
        400,
      );
    }

    const orderedEntries = record.session.actions
      .map((action, inputIndex) => ({ action, inputIndex }))
      .sort(
        (left, right) =>
          left.action.order - right.action.order || left.inputIndex - right.inputIndex,
      );
    const selectedEntries = orderedEntries.filter(({ action }) => selectedIds.has(action.id));
    if (selectedEntries.length !== selectedIds.size) {
      throw new RecordingCoordinatorError("一个或多个录制动作不存在。", "action_not_found", 404);
    }
    if (record.session.paginationLoop?.actionIds.some((actionId) => selectedIds.has(actionId))) {
      throw new RecordingCoordinatorError(
        "分页循环内的步骤不能转换为人工操作，请先解散循环。",
        "pagination_loop_action_locked",
        409,
      );
    }
    const firstPosition = orderedEntries.indexOf(selectedEntries[0]);
    const isContiguous = selectedEntries.every(
      (entry, index) => orderedEntries[firstPosition + index] === entry,
    );
    if (!isContiguous) {
      throw new RecordingCoordinatorError(
        "人工操作步骤只能由连续动作组成。",
        "manual_step_actions_not_contiguous",
        409,
      );
    }

    const selectedActions = selectedEntries.map(({ action }) => action);
    const pageId = selectedActions[0].pageId;
    if (selectedActions.some((action) => action.pageId !== pageId)) {
      throw new RecordingCoordinatorError(
        "人工操作步骤不能跨越多个页面。",
        "manual_step_cross_page",
        409,
      );
    }
    if (selectedActions.some((action) => !action.included)) {
      throw new RecordingCoordinatorError(
        "请先启用要转换的全部动作。",
        "manual_step_action_excluded",
        409,
      );
    }
    if (selectedActions.some((action) => Boolean(action.opensPageId))) {
      throw new RecordingCoordinatorError(
        "打开新页面的动作不能转换为人工操作步骤。",
        "manual_step_opens_page",
        409,
      );
    }

    let targets: ManualStepTarget[];
    if (mode === "custom") {
      if (
        selectedActions.some(
          (action) => action.type === "manualStep" || typeof action.selector !== "string",
        )
      ) {
        throw new RecordingCoordinatorError(
          "自定义下拉范围内的每个动作都必须有 selector。",
          "manual_step_selector_required",
          409,
        );
      }
      const firstAction = selectedActions[0];
      if (firstAction.type === "manualStep" || typeof firstAction.selector !== "string") {
        throw new RecordingCoordinatorError(
          "自定义下拉触发动作缺少 selector。",
          "manual_step_selector_required",
          409,
        );
      }
      targets = [
        {
          selector: firstAction.selector,
          controlKind: "custom",
          displayName: firstAction.displayName || "自定义下拉框",
          ...(firstAction.required !== undefined ? { required: firstAction.required } : {}),
        },
      ];
    } else {
      targets = [];
      for (const action of selectedActions) {
        if (action.type === "manualStep") {
          targets.push(...action.targets.map(cloneTarget));
          continue;
        }
        if (
          !["fill", "select", "setChecked"].includes(action.type) ||
          typeof action.selector !== "string"
        ) {
          throw new RecordingCoordinatorError(
            "controls 模式仅支持输入、原生选择、勾选和已有人工步骤。",
            "manual_step_action_not_convertible",
            409,
          );
        }
        const inferredKind: ManualControlKind =
          action.controlKind ??
          (action.type === "select"
            ? Array.isArray(action.value)
              ? "multiSelect"
              : "select"
            : action.type === "setChecked"
              ? "checkbox"
              : "text");
        const fallbackName: Record<ManualControlKind, string> = {
          text: "文本输入",
          secret: "敏感信息",
          select: "下拉选择",
          multiSelect: "多项选择",
          checkbox: "复选框",
          radioGroup: "单选项",
          date: "日期",
          custom: "自定义控件",
        };
        targets.push({
          selector: action.selector,
          controlKind: inferredKind,
          displayName: action.displayName || fallbackName[inferredKind],
          ...(action.required !== undefined ? { required: action.required } : {}),
        });
      }
    }

    const deduplicatedTargets = targets.filter(
      (target, index, allTargets) =>
        allTargets.findIndex(
          (candidate) =>
            candidate.selector === target.selector && candidate.controlKind === target.controlKind,
        ) === index,
    );
    if (deduplicatedTargets.length === 0) {
      throw new RecordingCoordinatorError(
        "人工操作步骤至少需要一个目标控件。",
        "manual_step_target_required",
        409,
      );
    }
    if (deduplicatedTargets.length > MAX_MANUAL_STEP_TARGETS) {
      throw new RecordingCoordinatorError(
        `人工操作步骤最多支持 ${MAX_MANUAL_STEP_TARGETS} 个目标控件。`,
        "too_many_manual_step_targets",
        409,
      );
    }

    const firstAction = selectedActions[0];
    const defaultTitle =
      mode === "custom"
        ? "请选择下拉选项"
        : firstAction.type === "manualStep"
          ? firstAction.title
          : deduplicatedTargets.length > 1
            ? "请完成以下人工操作"
            : "请完成人工操作";
    const title = input.title?.trim() || defaultTitle;
    if (
      !title ||
      title.length > MAX_MANUAL_STEP_TITLE_LENGTH ||
      Array.from(title).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      throw new RecordingCoordinatorError(
        `人工操作标题必须为 1-${MAX_MANUAL_STEP_TITLE_LENGTH} 个可显示字符。`,
        "invalid_manual_step_title",
        400,
      );
    }

    const firstEntry = selectedEntries[0];
    const manualAction: RecordedAction = {
      id: firstAction.id,
      order: firstAction.order,
      pageId: firstAction.pageId,
      type: "manualStep",
      title,
      targets: deduplicatedTargets,
      included: true,
    };
    record.session.actions[firstEntry.inputIndex] = manualAction;

    // A conversion is one-way: consumed source actions are removed instead of retaining values
    // that could be serialized or accidentally re-enabled after the manual checkpoint.
    const removedActionIds = selectedEntries.slice(1).map(({ action }) => action.id);
    if (removedActionIds.length > 0) {
      const removedIds = new Set(removedActionIds);
      record.session.actions = record.session.actions.filter(
        (action) => !removedIds.has(action.id),
      );
    }
    this.emit(recordingId, { type: "action-updated", action: cloneAction(manualAction) });
    return {
      action: cloneAction(manualAction),
      updatedActions: [cloneAction(manualAction)],
      removedActionIds,
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

  private requireStoppedRecording(record: RecordingRecord): void {
    if (record.session.status !== "stopped") {
      throw new RecordingCoordinatorError(
        "请先停止录制，再配置分页循环。",
        "recording_not_stopped",
        409,
      );
    }
  }

  private validatePaginationLoopSelection(
    record: RecordingRecord,
    input: PaginationLoopSelectionInput,
  ): ValidatedPaginationLoopSelection {
    const invalid = (message: string): never => {
      throw new RecordingCoordinatorError(message, "invalid_pagination_loop_range", 422);
    };

    if (
      !input ||
      !Array.isArray(input.actionIds) ||
      !input.actionIds.every((actionId) => typeof actionId === "string" && actionId.length > 0) ||
      typeof input.listEntryActionId !== "string" ||
      typeof input.nextActionId !== "string"
    ) {
      return invalid("分页循环范围、列表入口步骤和下一页步骤格式无效。");
    }
    if (input.actionIds.length < 2) {
      return invalid("分页循环至少需要一个循环步骤和最后一个下一页步骤。");
    }

    const selectedIds = new Set(input.actionIds);
    if (selectedIds.size !== input.actionIds.length) {
      return invalid("分页循环范围不能包含重复步骤。");
    }

    const orderedActions = record.session.actions
      .map((action, inputIndex) => ({ action, inputIndex }))
      .sort(
        (left, right) =>
          left.action.order - right.action.order || left.inputIndex - right.inputIndex,
      )
      .map(({ action }) => action);
    const selectedIndexes = input.actionIds.map((actionId) =>
      orderedActions.findIndex((action) => action.id === actionId),
    );
    if (selectedIndexes.some((index) => index < 0)) {
      return invalid("分页循环范围包含不存在的步骤。");
    }

    const firstIndex = Math.min(...selectedIndexes);
    const lastIndex = Math.max(...selectedIndexes);
    const rangeActions = orderedActions.slice(firstIndex, lastIndex + 1);
    if (rangeActions.some((action) => action.type === "manualStep")) {
      throw new RecordingCoordinatorError(
        "分页循环范围不能包含人工操作步骤。",
        "pagination_loop_manual_step_not_supported",
        409,
      );
    }
    if (
      rangeActions.length !== input.actionIds.length ||
      rangeActions.some((action) => !selectedIds.has(action.id))
    ) {
      return invalid("分页循环必须选择一段连续步骤。");
    }
    if (rangeActions.some((action) => action.included === false)) {
      return invalid("分页循环范围内的步骤必须全部启用。");
    }
    if (new Set(rangeActions.map((action) => action.pageId)).size !== 1) {
      return invalid("分页循环暂不支持跨页面步骤。");
    }
    if (rangeActions.some((action) => action.type === "closePage" || action.opensPageId)) {
      return invalid("分页循环暂不支持打开或关闭额外页面。");
    }

    const nextAction = rangeActions.at(-1);
    if (
      !nextAction ||
      nextAction.id !== input.nextActionId ||
      nextAction.type !== "click" ||
      typeof nextAction.selector !== "string" ||
      !nextAction.selector
    ) {
      return invalid("所选范围的最后一步必须是有选择器的下一页点击。");
    }

    const bodyActions = rangeActions.slice(0, -1);
    const hasAnchorNavigation = bodyActions.some((action) => {
      const lastSegment = action.structuralSelector
        ?.split(/\s*>\s*/)
        .at(-1)
        ?.trim();
      return Boolean(lastSegment && /^a(?:$|[.#:]|\[)/i.test(lastSegment));
    });
    if (hasAnchorNavigation) {
      throw new RecordingCoordinatorError(
        "分页循环体不能包含原生链接导航。",
        "pagination_loop_navigation_not_supported",
        422,
      );
    }

    const listEntryAction = bodyActions.find((action) => action.id === input.listEntryActionId);
    if (
      !listEntryAction ||
      listEntryAction.type !== "click" ||
      typeof listEntryAction.selector !== "string" ||
      !listEntryAction.selector
    ) {
      return invalid("列表入口必须是循环体内有选择器的点击步骤。");
    }

    return {
      actionIds: rangeActions.map((action) => action.id),
      listEntryAction,
      nextAction,
    };
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

  private paginationLoopUsesDescendantPage(record: RecordingRecord, openedPageId: string): boolean {
    const loop = record.session.paginationLoop;
    if (!loop) return false;
    const loopActionIds = new Set(loop.actionIds);
    const descendantPageIds = this.descendantPageIds(record, openedPageId);
    return record.session.actions.some(
      (action) => loopActionIds.has(action.id) && descendantPageIds.has(action.pageId),
    );
  }

  private descendantPageIds(record: RecordingRecord, openedPageId: string): Set<string> {
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
    return descendantPageIds;
  }

  private excludeDescendantActions(
    record: RecordingRecord,
    openedPageId: string,
  ): RecordedAction[] {
    const descendantPageIds = this.descendantPageIds(record, openedPageId);

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
