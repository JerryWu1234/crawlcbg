import { computed, onScopeDispose, readonly, ref, shallowRef } from "vue";
import type {
  BrowserTab,
  RecordedAction,
  RecordedPage,
  RecordingSession,
  RecordingStreamEvent,
  ValidationResult,
} from "../types/automation";

const DEFAULT_API_BASE_URL = "http://localhost:3001";
const ACTION_TYPES = new Set([
  "click",
  "fill",
  "select",
  "setChecked",
  "press",
  "scroll",
  "closePage",
]);

export type RecordingOperation =
  | "idle"
  | "starting"
  | "stopping"
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

export type RecordingTarget = Pick<BrowserTab, "index" | "url">;

export interface GeneratedRecordingScript {
  filename: string;
  code: string;
}

export interface SavedRecordingScript {
  success: boolean;
  filename: string;
  message?: string;
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

  if (typeof value.selector === "string") action.selector = value.selector;
  if (
    typeof value.value === "string" ||
    typeof value.value === "boolean" ||
    typeof value.value === "number" ||
    (Array.isArray(value.value) && value.value.every((item) => typeof item === "string"))
  ) {
    action.value = value.value;
  }
  if (typeof value.opensPageId === "string") action.opensPageId = value.opensPageId;
  return action;
};

const recordingCandidate = (payload: unknown) => {
  if (!isRecord(payload)) return { value: payload, wrapped: false };
  if (isRecord(payload.recording)) return { value: payload.recording, wrapped: true };
  if (isRecord(payload.session)) return { value: payload.session, wrapped: true };
  return { value: payload, wrapped: false };
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

  return {
    id: candidate.value.id,
    status: candidate.value.status === "stopped" ? "stopped" : "recording",
    startUrl:
      typeof candidate.value.startUrl === "string" ? candidate.value.startUrl : fallbackStartUrl,
    pages,
    actions,
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
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
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
    if (!Number.isInteger(target.index) || target.index < 0 || !target.url.trim()) {
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
        body: JSON.stringify({ tabIndex: target.index, expectedUrl: target.url }),
        signal: controller.signal,
      });
      if (disposed || lifecycle !== token || operationAbortController !== controller) return null;

      const recording = normalizeRecording(payload, target.url, true);
      if (!recording) throw new Error("启动录制响应缺少 recording id。");
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
    if (!current || !action || !canUpdateActions.value || actionAbortControllers.has(actionId)) {
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

  const bestEffortStop = (recordingId: string) => {
    try {
      void fetcher(`${apiBaseUrl}/api/recordings/${encodeURIComponent(recordingId)}/stop`, {
        method: "POST",
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Teardown cannot recover from a synchronous custom fetcher failure.
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
    const stopAlreadyInFlight = operation.value === "stopping";
    if (stopAlreadyInFlight) operationAbortController = null;

    disposed = true;
    lifecycle += 1;
    disconnectStream();
    abortRequests();
    if (activeRecordingId && !stopAlreadyInFlight) bestEffortStop(activeRecordingId);
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
