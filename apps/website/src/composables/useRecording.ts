import { computed, onScopeDispose, readonly, ref, shallowRef } from "vue";
import { API_BASE_URL } from "../config/api";
import type {
  BrowserTab,
  InsertRecordedActionDraft,
  ManualControlKind,
  ManualStepTarget,
  PaginationLoopSelectorCandidate,
  RecordedAction,
  RecordedPage,
  RecordedPaginationLoop,
  RecordingSession,
  RecordingStreamEvent,
  ValidationResult,
} from "../types/automation";

const ACTION_TYPES = new Set([
  "click",
  "fill",
  "select",
  "setChecked",
  "press",
  "scroll",
  "closePage",
  "manualStep",
]);
const MANUAL_CONTROL_KINDS = new Set<ManualControlKind>([
  "text",
  "secret",
  "select",
  "multiSelect",
  "checkbox",
  "radioGroup",
  "date",
  "custom",
]);

export type RecordingOperation =
  | "idle"
  | "starting"
  | "stopping"
  | "mutating-actions"
  | "configuring-loop"
  | "generating"
  | "validating"
  | "saving";

export type RecordingPhase =
  | RecordingOperation
  | "recording"
  | "stopped"
  | "generated"
  | "invalid"
  | "validated"
  | "saved";

export type RecordingTarget = Pick<BrowserTab, "index" | "targetId" | "url">;

export interface GeneratedRecordingScript {
  filename: string;
  code: string;
}

export interface SavedRecordingScript {
  success: boolean;
  filename: string;
  message?: string;
}

export interface PaginationLoopSelection {
  actionIds: string[];
  listEntryActionId: string;
  nextActionId: string;
}

export interface PaginationLoopPreview extends PaginationLoopSelection {
  candidates: PaginationLoopSelectorCandidate[];
}

export interface CreatePaginationLoopInput extends PaginationLoopSelection {
  candidateIndex: number;
  maxPages: number;
}

export type ManualStepConversionMode = "controls" | "custom";

export interface ManualStepConversionRequest {
  actionIds: string[];
  mode?: ManualStepConversionMode;
  title?: string;
}

export interface UseRecordingOptions {
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbortError = (error: unknown) =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : isRecord(error) && error.name === "AbortError";

const errorText = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
};

const payloadMessage = (payload: unknown) => {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return null;

  for (const key of ["message", "error"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (Array.isArray(payload.errors)) {
    const messages = payload.errors
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!isRecord(entry) || typeof entry.message !== "string") return null;
        const position =
          typeof entry.line === "number"
            ? `第 ${entry.line} 行${typeof entry.character === "number" ? `:${entry.character}` : ""}`
            : null;
        return position ? `${position} ${entry.message}` : entry.message;
      })
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) return messages.join("；");
  }

  return null;
};

const normalizePage = (value: unknown): RecordedPage | null => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.url !== "string") {
    return null;
  }

  const page: RecordedPage = { id: value.id, url: value.url };
  if (typeof value.openerPageId === "string") page.openerPageId = value.openerPageId;
  return page;
};

const normalizeManualTarget = (value: unknown): ManualStepTarget | null => {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, "value") ||
    typeof value.selector !== "string" ||
    !value.selector ||
    typeof value.controlKind !== "string" ||
    !MANUAL_CONTROL_KINDS.has(value.controlKind as ManualControlKind) ||
    typeof value.displayName !== "string" ||
    !value.displayName.trim() ||
    (value.required !== undefined && typeof value.required !== "boolean")
  ) {
    return null;
  }
  return {
    selector: value.selector,
    controlKind: value.controlKind as ManualControlKind,
    displayName: value.displayName.trim(),
    ...(value.required !== undefined ? { required: value.required as boolean } : {}),
  };
};

const normalizeAction = (value: unknown): RecordedAction | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.order !== "number" ||
    typeof value.pageId !== "string" ||
    typeof value.type !== "string" ||
    !ACTION_TYPES.has(value.type) ||
    typeof value.included !== "boolean"
  ) {
    return null;
  }

  const action = {
    id: value.id,
    order: value.order,
    pageId: value.pageId,
    type: value.type,
    included: value.included,
  } as RecordedAction;

  if (value.type === "manualStep") {
    if (
      Object.hasOwn(value, "value") ||
      Object.hasOwn(value, "selector") ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      !Array.isArray(value.targets)
    ) {
      return null;
    }
    const targets = value.targets.map(normalizeManualTarget);
    if (targets.length === 0 || targets.some((target) => target === null)) return null;
    action.title = value.title.trim();
    action.targets = targets as ManualStepTarget[];
    return action;
  }

  if (typeof value.selector === "string") action.selector = value.selector;
  if (typeof value.structuralSelector === "string") {
    action.structuralSelector = value.structuralSelector;
  }
  if (
    typeof value.value === "string" ||
    typeof value.value === "boolean" ||
    typeof value.value === "number" ||
    (Array.isArray(value.value) && value.value.every((item) => typeof item === "string"))
  ) {
    action.value = value.value;
  }
  if (typeof value.opensPageId === "string") action.opensPageId = value.opensPageId;
  if (
    typeof value.controlKind === "string" &&
    MANUAL_CONTROL_KINDS.has(value.controlKind as ManualControlKind)
  ) {
    action.controlKind = value.controlKind as ManualControlKind;
  }
  if (typeof value.displayName === "string" && value.displayName.trim()) {
    action.displayName = value.displayName.trim();
  }
  if (typeof value.required === "boolean") action.required = value.required;
  return action;
};

const normalizePaginationLoopCandidate = (
  value: unknown,
): PaginationLoopSelectorCandidate | null => {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.candidateIndex) ||
    !Number.isInteger(value.sourceOrdinal) ||
    (value.sourceOrdinal as number) < 1 ||
    typeof value.listSelector !== "string" ||
    !value.listSelector ||
    typeof value.sourceItemSelector !== "string" ||
    !value.sourceItemSelector ||
    typeof value.itemSelectorTemplate !== "string" ||
    !value.itemSelectorTemplate
  ) {
    return null;
  }
  return {
    candidateIndex: value.candidateIndex as number,
    sourceOrdinal: value.sourceOrdinal as number,
    listSelector: value.listSelector,
    sourceItemSelector: value.sourceItemSelector,
    itemSelectorTemplate: value.itemSelectorTemplate,
  };
};

const normalizePaginationLoop = (value: unknown): RecordedPaginationLoop | null => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.actionIds) ||
    !value.actionIds.every((actionId) => typeof actionId === "string") ||
    typeof value.listEntryActionId !== "string" ||
    typeof value.nextActionId !== "string" ||
    typeof value.listSelector !== "string" ||
    typeof value.sourceItemSelector !== "string" ||
    typeof value.itemSelectorTemplate !== "string" ||
    !Number.isInteger(value.maxPages) ||
    (value.maxPages as number) < 1
  ) {
    return null;
  }
  return {
    actionIds: [...value.actionIds] as string[],
    listEntryActionId: value.listEntryActionId,
    nextActionId: value.nextActionId,
    listSelector: value.listSelector,
    sourceItemSelector: value.sourceItemSelector,
    itemSelectorTemplate: value.itemSelectorTemplate,
    maxPages: value.maxPages as number,
  };
};

const recordingCandidate = (payload: unknown) => {
  if (!isRecord(payload)) return { value: payload, wrapped: false };
  if (isRecord(payload.recording)) return { value: payload.recording, wrapped: true };
  if (isRecord(payload.session)) return { value: payload.session, wrapped: true };
  return { value: payload, wrapped: false };
};

const recordingIdFromPayload = (payload: unknown): string | null => {
  const candidate = recordingCandidate(payload).value;
  return isRecord(candidate) && typeof candidate.id === "string" && candidate.id
    ? candidate.id
    : null;
};

const normalizeRecording = (
  payload: unknown,
  fallbackStartUrl = "",
  allowIdOnly = false,
): RecordingSession | null => {
  const candidate = recordingCandidate(payload);
  if (!isRecord(candidate.value) || typeof candidate.value.id !== "string") return null;

  const hasRecordingShape =
    candidate.value.status === "recording" ||
    candidate.value.status === "stopped" ||
    typeof candidate.value.startUrl === "string" ||
    Array.isArray(candidate.value.pages) ||
    Array.isArray(candidate.value.actions);
  if (!hasRecordingShape && !candidate.wrapped && !allowIdOnly) return null;

  const pages = Array.isArray(candidate.value.pages)
    ? candidate.value.pages.map(normalizePage).filter((page): page is RecordedPage => page !== null)
    : [];
  const actions = Array.isArray(candidate.value.actions)
    ? candidate.value.actions
        .map(normalizeAction)
        .filter((action): action is RecordedAction => action !== null)
    : [];
  const paginationLoop = normalizePaginationLoop(candidate.value.paginationLoop);

  return {
    id: candidate.value.id,
    status: candidate.value.status === "stopped" ? "stopped" : "recording",
    startUrl:
      typeof candidate.value.startUrl === "string" ? candidate.value.startUrl : fallbackStartUrl,
    pages,
    actions,
    ...(paginationLoop ? { paginationLoop } : {}),
  };
};

const normalizePaginationLoopPreview = (payload: unknown): PaginationLoopPreview | null => {
  const value = isRecord(payload) && isRecord(payload.preview) ? payload.preview : payload;
  if (
    !isRecord(value) ||
    !Array.isArray(value.actionIds) ||
    !value.actionIds.every((actionId) => typeof actionId === "string") ||
    typeof value.listEntryActionId !== "string" ||
    typeof value.nextActionId !== "string" ||
    !Array.isArray(value.candidates)
  ) {
    return null;
  }
  const candidates = value.candidates.map(normalizePaginationLoopCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  return {
    actionIds: [...value.actionIds] as string[],
    listEntryActionId: value.listEntryActionId,
    nextActionId: value.nextActionId,
    candidates: candidates as PaginationLoopSelectorCandidate[],
  };
};

const normalizeGeneratedScript = (payload: unknown): GeneratedRecordingScript | null => {
  if (
    !isRecord(payload) ||
    typeof payload.filename !== "string" ||
    typeof payload.code !== "string"
  ) {
    return null;
  }
  return { filename: payload.filename, code: payload.code };
};

const normalizeValidationResult = (payload: unknown): ValidationResult | null => {
  if (!isRecord(payload) || typeof payload.valid !== "boolean") return null;

  const result: ValidationResult = { valid: payload.valid };
  if (typeof payload.message === "string") result.message = payload.message;
  if (Array.isArray(payload.errors)) {
    result.errors = payload.errors
      .filter(
        (entry): entry is JsonRecord =>
          isRecord(entry) &&
          typeof entry.line === "number" &&
          typeof entry.character === "number" &&
          typeof entry.message === "string",
      )
      .map((entry) => ({
        line: entry.line as number,
        character: entry.character as number,
        message: entry.message as string,
      }));
  }
  return result;
};

const normalizeSavedScript = (
  payload: unknown,
  fallbackFilename: string,
): SavedRecordingScript | null => {
  if (!isRecord(payload)) return null;
  const filename =
    typeof payload.filename === "string" && payload.filename.trim()
      ? payload.filename
      : fallbackFilename;
  if (payload.success !== true || !filename) return null;

  const result: SavedRecordingScript = { success: true, filename };
  if (typeof payload.message === "string") result.message = payload.message;
  return result;
};

const normalizeFilename = (filename: string) => {
  const trimmed = filename.trim();
  if (!trimmed) throw new Error("请输入脚本文件名。");
  if (trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
    throw new Error("脚本文件名不能包含路径。");
  }
  return /\.(?:mjs|js)$/i.test(trimmed) ? trimmed : `${trimmed}.mjs`;
};

export function useRecording(options: UseRecordingOptions = {}) {
  const apiBaseUrl = (options.apiBaseUrl ?? API_BASE_URL).replace(/\/+$/, "");
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const eventSourceFactory = options.eventSourceFactory ?? ((url: string) => new EventSource(url));

  const session = shallowRef<RecordingSession | null>(null);
  const operation = ref<RecordingOperation>("idle");
  const errorMessage = ref<string | null>(null);
  const streamConnected = ref(false);
  const streamWarning = ref<string | null>(null);
  const generatedScript = shallowRef<GeneratedRecordingScript | null>(null);
  const validationResult = shallowRef<ValidationResult | null>(null);
  const savedScript = shallowRef<SavedRecordingScript | null>(null);
  const pendingActionIdSet = ref<Set<string>>(new Set());

  let lifecycle = 0;
  let disposed = false;
  let eventSource: EventSource | null = null;
  let operationAbortController: AbortController | null = null;
  const actionAbortControllers = new Map<string, AbortController>();

  const pages = computed<RecordedPage[]>(() => session.value?.pages ?? []);
  const actions = computed<RecordedAction[]>(() =>
    [...(session.value?.actions ?? [])].sort(
      (left: RecordedAction, right: RecordedAction) => left.order - right.order,
    ),
  );
  const pendingActionIds = computed(() => [...pendingActionIdSet.value]);
  const hasPendingActionUpdates = computed(() => pendingActionIdSet.value.size > 0);
  const phase = computed<RecordingPhase>(() => {
    if (operation.value !== "idle") return operation.value;
    if (savedScript.value) return "saved";
    if (validationResult.value?.valid === false) return "invalid";
    if (validationResult.value?.valid === true) return "validated";
    if (generatedScript.value) return "generated";
    if (session.value?.status === "stopped") return "stopped";
    if (session.value?.status === "recording") return "recording";
    return "idle";
  });
  const isActive = computed(
    () =>
      operation.value === "starting" ||
      operation.value === "stopping" ||
      session.value?.status === "recording",
  );
  const canStart = computed(
    () => !disposed && operation.value === "idle" && session.value === null,
  );
  const canStop = computed(
    () =>
      operation.value === "idle" &&
      session.value?.status === "recording" &&
      !hasPendingActionUpdates.value,
  );
  const canUpdateActions = computed(
    () =>
      operation.value === "idle" &&
      !hasPendingActionUpdates.value &&
      (session.value?.status === "recording" || session.value?.status === "stopped"),
  );
  const canMutateActions = computed(
    () =>
      operation.value === "idle" &&
      session.value?.status === "stopped" &&
      !session.value.paginationLoop &&
      !hasPendingActionUpdates.value,
  );
  const canConfigurePaginationLoop = computed(
    () =>
      operation.value === "idle" &&
      session.value?.status === "stopped" &&
      !hasPendingActionUpdates.value,
  );
  const canCreateManualStep = computed(
    () =>
      operation.value === "idle" &&
      !hasPendingActionUpdates.value &&
      session.value?.status === "stopped",
  );
  const canGenerate = computed(
    () =>
      operation.value === "idle" &&
      session.value?.status === "stopped" &&
      !hasPendingActionUpdates.value,
  );
  const canValidateAndSave = computed(
    () =>
      operation.value === "idle" &&
      session.value?.status === "stopped" &&
      generatedScript.value !== null,
  );

  const clearGeneratedArtifacts = () => {
    generatedScript.value = null;
    validationResult.value = null;
    savedScript.value = null;
  };

  const clearError = () => {
    errorMessage.value = null;
  };

  const disconnectStream = () => {
    eventSource?.close();
    eventSource = null;
    streamConnected.value = false;
    streamWarning.value = null;
  };

  const abortRequests = () => {
    operationAbortController?.abort();
    operationAbortController = null;
    for (const controller of actionAbortControllers.values()) controller.abort();
    actionAbortControllers.clear();
    pendingActionIdSet.value = new Set();
  };

  const requestJson = async (path: string, init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${apiBaseUrl}${path}`, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error(`无法连接服务端：${errorText(error, "网络请求失败")}`);
    }

    let responseText = "";
    try {
      responseText = await response.text();
    } catch (error) {
      if (!response.ok) {
        throw new Error(`请求失败（HTTP ${response.status}）。`);
      }
      throw new Error(`无法读取服务端响应：${errorText(error, "响应读取失败")}`);
    }

    let payload: unknown;
    if (responseText.trim()) {
      try {
        payload = JSON.parse(responseText) as unknown;
      } catch {
        if (!response.ok) {
          throw new Error(responseText.trim() || `请求失败（HTTP ${response.status}）。`);
        }
        throw new Error("服务端返回了无法解析的响应。");
      }
    }

    if (!response.ok) {
      const message = payloadMessage(payload);
      throw new Error(
        message ??
          `请求失败（HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}）。`,
      );
    }

    return payload;
  };

  const replaceSession = (recording: RecordingSession) => {
    if (session.value && session.value.id !== recording.id) return false;

    const uniquePages = new Map<string, RecordedPage>();
    for (const page of recording.pages as RecordedPage[]) uniquePages.set(page.id, page);
    const uniqueActions = new Map<string, RecordedAction>();
    for (const action of recording.actions as RecordedAction[]) {
      uniqueActions.set(action.id, action);
    }
    session.value = {
      ...recording,
      pages: [...uniquePages.values()],
      actions: [...uniqueActions.values()].sort(
        (left: RecordedAction, right: RecordedAction) => left.order - right.order,
      ),
    };
    return true;
  };

  const upsertPage = (page: RecordedPage) => {
    const current = session.value;
    if (!current) return;
    const index = current.pages.findIndex((candidate: RecordedPage) => candidate.id === page.id);
    const nextPages = [...current.pages];
    if (index === -1) nextPages.push(page);
    else nextPages[index] = page;
    session.value = { ...current, pages: nextPages };
  };

  const upsertAction = (action: RecordedAction) => {
    const current = session.value;
    if (!current) return;
    const index = current.actions.findIndex(
      (candidate: RecordedAction) => candidate.id === action.id,
    );
    const nextActions = [...current.actions] as RecordedAction[];
    const changed = index === -1 || JSON.stringify(nextActions[index]) !== JSON.stringify(action);
    if (index === -1) nextActions.push(action);
    else nextActions[index] = action;
    session.value = {
      ...current,
      actions: nextActions.sort(
        (left: RecordedAction, right: RecordedAction) => left.order - right.order,
      ),
    };
    if (changed && generatedScript.value) clearGeneratedArtifacts();
  };

  const handleStreamEvent = (event: RecordingStreamEvent, source: EventSource, token: number) => {
    if (disposed || lifecycle !== token || eventSource !== source) return;

    switch (event.type) {
      case "started": {
        const recording = normalizeRecording(event.recording);
        if (!recording) throw new Error("started 事件缺少有效的 recording。");
        replaceSession(recording);
        break;
      }
      case "page-opened": {
        const page = normalizePage(event.page);
        if (!page) throw new Error("page-opened 事件缺少有效的 page。");
        upsertPage(page);
        break;
      }
      case "action":
      case "action-updated": {
        const action = normalizeAction(event.action);
        if (!action) throw new Error(`${event.type} 事件缺少有效的 action。`);
        upsertAction(action);
        break;
      }
      case "stopped": {
        const recording = normalizeRecording(event.recording);
        if (!recording) throw new Error("stopped 事件缺少有效的 recording。");
        replaceSession({ ...recording, status: "stopped" });
        break;
      }
      case "error":
        errorMessage.value = event.message || "录制服务报告了未知错误。";
        break;
    }
  };

  const connectStream = (recordingId: string, token: number) => {
    disconnectStream();
    let source: EventSource;
    try {
      source = eventSourceFactory(
        `${apiBaseUrl}/api/recordings/${encodeURIComponent(recordingId)}/stream`,
      );
    } catch (error) {
      streamWarning.value = `无法建立实时连接：${errorText(error, "EventSource 初始化失败")}`;
      return;
    }

    eventSource = source;
    streamConnected.value = source.readyState === EventSource.OPEN;

    source.onopen = () => {
      if (disposed || lifecycle !== token || eventSource !== source) return;
      streamConnected.value = true;
      streamWarning.value = null;
    };

    source.onmessage = (message: MessageEvent<string>) => {
      if (disposed || lifecycle !== token || eventSource !== source) return;
      try {
        const payload = JSON.parse(message.data) as unknown;
        if (!isRecord(payload) || typeof payload.type !== "string") {
          throw new Error("事件不是有效的录制消息。");
        }
        handleStreamEvent(payload as unknown as RecordingStreamEvent, source, token);
      } catch (error) {
        errorMessage.value = `无法处理录制事件：${errorText(error, "事件格式错误")}`;
      }
    };

    source.onerror = () => {
      if (disposed || lifecycle !== token || eventSource !== source) return;
      streamConnected.value = false;
      if (session.value?.status === "recording") {
        streamWarning.value = "实时连接暂时中断，浏览器正在尝试重新连接。";
      } else {
        disconnectStream();
      }
    };
  };

  const finishOperation = (controller: AbortController) => {
    if (operationAbortController !== controller) return;
    operationAbortController = null;
    operation.value = "idle";
  };

  const startRecording = async (target: RecordingTarget) => {
    if (!canStart.value) return session.value;
    if (
      !Number.isInteger(target.index) ||
      target.index < 0 ||
      !target.targetId.trim() ||
      !target.url.trim()
    ) {
      errorMessage.value = "录制目标页签无效。";
      return null;
    }

    const token = ++lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "starting";
    errorMessage.value = null;
    streamWarning.value = null;
    clearGeneratedArtifacts();

    try {
      const payload = await requestJson("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabIndex: target.index,
          targetId: target.targetId,
          expectedUrl: target.url,
        }),
        keepalive: true,
        signal: controller.signal,
      });
      const returnedRecordingId = recordingIdFromPayload(payload);
      const recording = normalizeRecording(payload, target.url, true);
      if (!recording) {
        if (returnedRecordingId) await bestEffortStop(returnedRecordingId);
        throw new Error("启动录制响应缺少 recording id。");
      }

      if (disposed || lifecycle !== token || operationAbortController !== controller) {
        await bestEffortStop(recording.id);
        return null;
      }

      replaceSession(recording);
      connectStream(recording.id, token);
      return recording;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "启动录制失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const setActionIncluded = async (actionId: string, included: boolean) => {
    const current = session.value;
    const action = current?.actions.find((candidate: RecordedAction) => candidate.id === actionId);
    if (
      !current ||
      !action ||
      !canUpdateActions.value ||
      current.paginationLoop?.actionIds.includes(actionId) ||
      actionAbortControllers.has(actionId)
    ) {
      return false;
    }
    if (action.included === included) return true;

    const token = lifecycle;
    const recordingId = current.id;
    const controller = new AbortController();
    actionAbortControllers.set(actionId, controller);
    pendingActionIdSet.value = new Set([...pendingActionIdSet.value, actionId]);
    errorMessage.value = null;

    try {
      // A popup-opening click is still one atomic server mutation. Cascaded child updates
      // arrive as action-updated SSE events; the client never sends follow-up PATCH calls.
      await requestJson(
        `/api/recordings/${encodeURIComponent(recordingId)}/actions/${encodeURIComponent(actionId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ included }),
          signal: controller.signal,
        },
      );
      if (
        disposed ||
        lifecycle !== token ||
        session.value?.id !== recordingId ||
        actionAbortControllers.get(actionId) !== controller
      ) {
        return false;
      }

      // HTTP only confirms the requested include value. The latest action fields and
      // server-side popup cascade remain SSE-authoritative, so an older response cannot
      // overwrite a newer action-updated event.
      const latestAction = session.value.actions.find(
        (candidate: RecordedAction) => candidate.id === actionId,
      );
      if (latestAction) upsertAction({ ...latestAction, included });
      clearGeneratedArtifacts();
      return true;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "更新录制动作失败。");
      }
      return false;
    } finally {
      if (actionAbortControllers.get(actionId) === controller) {
        actionAbortControllers.delete(actionId);
        const nextPending = new Set(pendingActionIdSet.value);
        nextPending.delete(actionId);
        pendingActionIdSet.value = nextPending;
      }
    }
  };

  const insertAction = async (afterActionId: string | null, action: InsertRecordedActionDraft) => {
    const current = session.value;
    if (
      !current ||
      !canMutateActions.value ||
      (afterActionId !== null &&
        !current.actions.some((candidate) => candidate.id === afterActionId))
    ) {
      return null;
    }

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "mutating-actions";
    errorMessage.value = null;

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(current.id)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ afterActionId, action }),
          signal: controller.signal,
        },
      );
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;
      if (!isRecord(payload)) throw new Error("新增动作接口返回了无效结果。");

      const recording = normalizeRecording(payload);
      const insertedAction = normalizeAction(payload.action);
      const recordedAction = recording?.actions.find(
        (candidate) => candidate.id === insertedAction?.id,
      );
      if (
        !recording ||
        recording.status !== "stopped" ||
        !insertedAction ||
        !recordedAction ||
        JSON.stringify(recordedAction) !== JSON.stringify(insertedAction)
      ) {
        throw new Error("新增动作接口缺少一致的录制快照。");
      }
      if (!replaceSession(recording)) return null;
      clearGeneratedArtifacts();
      return insertedAction;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "新增录制动作失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const deleteAction = async (actionId: string) => {
    const current = session.value;
    if (
      !current ||
      !canMutateActions.value ||
      !current.actions.some((action) => action.id === actionId)
    ) {
      return null;
    }

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "mutating-actions";
    errorMessage.value = null;

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(current.id)}/actions/${encodeURIComponent(actionId)}`,
        { method: "DELETE", signal: controller.signal },
      );
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;
      if (!isRecord(payload)) throw new Error("删除动作接口返回了无效结果。");

      const recording = normalizeRecording(payload);
      const removedActionIds = Array.isArray(payload.removedActionIds)
        ? payload.removedActionIds.filter((value): value is string => typeof value === "string")
        : [];
      if (
        !recording ||
        recording.status !== "stopped" ||
        removedActionIds.length !== 1 ||
        removedActionIds[0] !== actionId ||
        recording.actions.some((action) => action.id === actionId)
      ) {
        throw new Error("删除动作接口缺少一致的录制快照。");
      }
      if (!replaceSession(recording)) return null;
      clearGeneratedArtifacts();
      return recording;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "删除录制动作失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const previewPaginationLoop = async (input: PaginationLoopSelection) => {
    const current = session.value;
    if (!current || current.paginationLoop || !canConfigurePaginationLoop.value) return null;

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "configuring-loop";
    errorMessage.value = null;

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(current.id)}/pagination-loop/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const preview = normalizePaginationLoopPreview(payload);
      if (!preview) throw new Error("循环预览接口返回了无效结果。");
      return preview;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "无法预览分页循环。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const createPaginationLoop = async (input: CreatePaginationLoopInput) => {
    const current = session.value;
    if (!current || current.paginationLoop || !canConfigurePaginationLoop.value) return null;

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "configuring-loop";
    errorMessage.value = null;

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(current.id)}/pagination-loop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const recording = normalizeRecording(payload);
      if (!recording) throw new Error("创建循环接口未返回有效录制会话。");
      if (!replaceSession(recording)) return null;
      clearGeneratedArtifacts();
      return recording;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "无法创建分页循环。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const dissolvePaginationLoop = async () => {
    const current = session.value;
    if (!current?.paginationLoop || !canConfigurePaginationLoop.value) return null;

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "configuring-loop";
    errorMessage.value = null;

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(current.id)}/pagination-loop`,
        {
          method: "DELETE",
          signal: controller.signal,
        },
      );
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const recording = normalizeRecording(payload);
      if (!recording) throw new Error("解散循环接口未返回有效录制会话。");
      if (!replaceSession(recording)) return null;
      clearGeneratedArtifacts();
      return recording;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "无法解散分页循环。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const createManualStep = async ({
    actionIds,
    mode = "controls",
    title,
  }: ManualStepConversionRequest) => {
    const current = session.value;
    const uniqueActionIds = [...new Set(actionIds)];
    const loopActionIds = new Set(current?.paginationLoop?.actionIds ?? []);
    if (
      !current ||
      current.status !== "stopped" ||
      !canCreateManualStep.value ||
      uniqueActionIds.length === 0 ||
      uniqueActionIds.length !== actionIds.length ||
      uniqueActionIds.some(
        (actionId) =>
          loopActionIds.has(actionId) ||
          !current.actions.some((action) => action.id === actionId) ||
          actionAbortControllers.has(actionId),
      )
    ) {
      return null;
    }

    const token = lifecycle;
    const recordingId = current.id;
    const controller = new AbortController();
    for (const actionId of uniqueActionIds) actionAbortControllers.set(actionId, controller);
    pendingActionIdSet.value = new Set([...pendingActionIdSet.value, ...uniqueActionIds]);
    errorMessage.value = null;

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(recordingId)}/manual-steps`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionIds: uniqueActionIds,
            mode,
            ...(title?.trim() ? { title: title.trim() } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (
        disposed ||
        lifecycle !== token ||
        session.value?.id !== recordingId ||
        uniqueActionIds.some((actionId) => actionAbortControllers.get(actionId) !== controller)
      ) {
        return null;
      }
      if (!isRecord(payload)) throw new Error("人工步骤转换接口返回了无效结果。");

      const primaryAction = normalizeAction(payload.action);
      const normalizedUpdatedActions = Array.isArray(payload.updatedActions)
        ? payload.updatedActions.map(normalizeAction)
        : null;
      const removedActionIds =
        Array.isArray(payload.removedActionIds) &&
        payload.removedActionIds.every((actionId) => typeof actionId === "string")
          ? ([...payload.removedActionIds] as string[])
          : null;
      if (
        !primaryAction ||
        primaryAction.type !== "manualStep" ||
        !uniqueActionIds.includes(primaryAction.id) ||
        !normalizedUpdatedActions ||
        normalizedUpdatedActions.length === 0 ||
        normalizedUpdatedActions.some((action) => action === null) ||
        removedActionIds === null
      ) {
        throw new Error("人工步骤转换接口缺少原子更新结果。");
      }

      const updatedActions = normalizedUpdatedActions as RecordedAction[];
      const updatedActionIds = new Set(updatedActions.map((action) => action.id));
      const removedIds = new Set(removedActionIds);
      const expectedRemovedIds = uniqueActionIds.filter(
        (actionId) => actionId !== primaryAction.id,
      );
      if (
        updatedActionIds.size !== updatedActions.length ||
        removedIds.size !== removedActionIds.length ||
        removedIds.size !== expectedRemovedIds.length ||
        expectedRemovedIds.some((actionId) => !removedIds.has(actionId)) ||
        updatedActions.some(
          (action) => !uniqueActionIds.includes(action.id) || removedIds.has(action.id),
        )
      ) {
        throw new Error("人工步骤转换接口返回了不一致的动作更新范围。");
      }

      // A stopped recording has no live SSE reconciliation. Apply replacements and removals from
      // the one authoritative HTTP result so consumed actions (and their values) leave the UI.
      const replacements = new Map(updatedActions.map((action) => [action.id, action]));
      replacements.set(primaryAction.id, primaryAction);
      const latestSession = session.value;
      if (!latestSession || latestSession.id !== recordingId) return null;
      const nextActions = latestSession.actions
        .filter((action) => !removedIds.has(action.id))
        .map((action) => replacements.get(action.id) ?? action);
      for (const replacement of replacements.values()) {
        if (!nextActions.some((action) => action.id === replacement.id)) {
          nextActions.push(replacement);
        }
      }
      session.value = {
        ...latestSession,
        actions: nextActions.sort((left, right) => left.order - right.order),
      };
      clearGeneratedArtifacts();
      return primaryAction;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "转换人工操作步骤失败。");
      }
      return null;
    } finally {
      const nextPending = new Set(pendingActionIdSet.value);
      for (const actionId of uniqueActionIds) {
        if (actionAbortControllers.get(actionId) === controller) {
          actionAbortControllers.delete(actionId);
          nextPending.delete(actionId);
        }
      }
      pendingActionIdSet.value = nextPending;
    }
  };

  const stopRecording = async () => {
    const current = session.value;
    if (!current || !canStop.value) return null;

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "stopping";
    errorMessage.value = null;

    try {
      await requestJson(`/api/recordings/${encodeURIComponent(current.id)}/stop`, {
        method: "POST",
        keepalive: true,
        signal: controller.signal,
      });
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      // A stop response has no frozen snapshot envelope and may race the final SSE event.
      // Preserve the newest in-memory pages/actions and use HTTP only to confirm completion.
      if (session.value?.id === current.id) {
        session.value = { ...session.value, status: "stopped" };
      }
      return session.value;
    } catch (error) {
      if (session.value?.id === current.id && session.value.status === "stopped") {
        return session.value;
      }
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "停止录制失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const generateScript = async (filename: string) => {
    const current = session.value;
    if (!current || !canGenerate.value) return null;

    let safeFilename: string;
    try {
      safeFilename = normalizeFilename(filename);
    } catch (error) {
      errorMessage.value = errorText(error, "脚本文件名无效。");
      return null;
    }

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "generating";
    errorMessage.value = null;
    clearGeneratedArtifacts();

    try {
      const payload = await requestJson(
        `/api/recordings/${encodeURIComponent(current.id)}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: safeFilename }),
          signal: controller.signal,
        },
      );
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const generated = normalizeGeneratedScript(payload);
      if (!generated) throw new Error("生成接口未返回有效的 filename 和 code。");
      generatedScript.value = generated;
      return generated;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "生成脚本失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const validateGeneratedScript = async () => {
    const generated = generatedScript.value;
    if (!generated || !canValidateAndSave.value) return null;

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "validating";
    errorMessage.value = null;
    validationResult.value = null;
    savedScript.value = null;

    try {
      const payload = await requestJson("/api/scripts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: generated.code }),
        signal: controller.signal,
      });
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const result = normalizeValidationResult(payload);
      if (!result) throw new Error("校验接口返回了无效结果。");
      validationResult.value = result;
      return result;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "校验脚本失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const saveGeneratedScript = async (label: string) => {
    const generated = generatedScript.value;
    if (!generated || validationResult.value?.valid !== true || operation.value !== "idle") {
      return null;
    }

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "saving";
    errorMessage.value = null;
    savedScript.value = null;
    const saveLabel = label.trim() || `浏览器录制：${generated.filename}`;

    try {
      const payload = await requestJson("/api/scripts/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: generated.filename,
          content: generated.code,
          label: saveLabel,
        }),
        signal: controller.signal,
      });
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const result = normalizeSavedScript(payload, generated.filename);
      if (!result) throw new Error("保存接口未确认脚本已写入。");
      savedScript.value = result;
      return result;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "保存脚本失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const validateAndSave = async (label: string) => {
    const generated = generatedScript.value;
    if (!generated || !canValidateAndSave.value) return null;

    const token = lifecycle;
    const controller = new AbortController();
    operationAbortController = controller;
    operation.value = "validating";
    errorMessage.value = null;
    validationResult.value = null;
    savedScript.value = null;

    try {
      const validationPayload = await requestJson("/api/scripts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: generated.code }),
        signal: controller.signal,
      });
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const validation = normalizeValidationResult(validationPayload);
      if (!validation) throw new Error("校验接口返回了无效结果。");
      validationResult.value = validation;
      if (!validation.valid) return null;

      operation.value = "saving";
      const saveLabel = label.trim() || `浏览器录制：${generated.filename}`;
      const savePayload = await requestJson("/api/scripts/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: generated.filename,
          content: generated.code,
          label: saveLabel,
        }),
        signal: controller.signal,
      });
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const saved = normalizeSavedScript(savePayload, generated.filename);
      if (!saved) throw new Error("保存接口未确认脚本已写入。");
      savedScript.value = saved;
      return saved;
    } catch (error) {
      if (!isAbortError(error) && !disposed && lifecycle === token) {
        errorMessage.value = errorText(error, "校验并保存脚本失败。");
      }
      return null;
    } finally {
      finishOperation(controller);
    }
  };

  const isActionPending = (actionId: string) => pendingActionIdSet.value.has(actionId);

  const bestEffortStop = async (recordingId: string): Promise<boolean> => {
    try {
      const response = await fetcher(
        `${apiBaseUrl}/api/recordings/${encodeURIComponent(recordingId)}/stop`,
        {
          method: "POST",
          keepalive: true,
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  };

  const reset = () => {
    lifecycle += 1;
    disconnectStream();
    abortRequests();
    session.value = null;
    operation.value = "idle";
    errorMessage.value = null;
    clearGeneratedArtifacts();
  };

  onScopeDispose(() => {
    const activeRecordingId = session.value?.status === "recording" ? session.value.id : null;
    const committedOperationInFlight =
      operation.value === "starting" || operation.value === "stopping";
    if (committedOperationInFlight) operationAbortController = null;

    disposed = true;
    lifecycle += 1;
    disconnectStream();
    abortRequests();
    if (activeRecordingId && operation.value !== "stopping") {
      void bestEffortStop(activeRecordingId);
    }
  });

  return {
    session: readonly(session),
    pages,
    actions,
    phase,
    operation: readonly(operation),
    isActive,
    canStart,
    canStop,
    canUpdateActions,
    canMutateActions,
    canConfigurePaginationLoop,
    canCreateManualStep,
    canGenerate,
    canValidateAndSave,
    errorMessage: readonly(errorMessage),
    streamConnected: readonly(streamConnected),
    streamWarning: readonly(streamWarning),
    generatedScript: readonly(generatedScript),
    validationResult: readonly(validationResult),
    savedScript: readonly(savedScript),
    pendingActionIds,
    hasPendingActionUpdates,
    startRecording,
    setActionIncluded,
    insertAction,
    deleteAction,
    previewPaginationLoop,
    createPaginationLoop,
    dissolvePaginationLoop,
    createManualStep,
    stopRecording,
    generateScript,
    validateGeneratedScript,
    saveGeneratedScript,
    validateAndSave,
    isActionPending,
    disconnect: disconnectStream,
    clearError,
    reset,
  };
}
