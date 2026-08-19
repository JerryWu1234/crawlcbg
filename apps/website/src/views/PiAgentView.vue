<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:3001").replace(/\/$/, "");

type ModelOption = { id: string; label: string; detail: string };
type SessionState = "ready" | "preparing" | "running" | "success" | "partial" | "error";
type LeftPanelMode = "config" | "history";
type StreamTerminal = "done" | "error" | "aborted" | null;

type DatabaseOption = {
  id: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
};

type TableOption = {
  name: string;
  rowCount: number;
  selected: boolean;
};

type SnapshotTable = {
  name: string;
  fileName?: string;
  rowCount: number;
  columnCount: number;
};

type SnapshotInfo = {
  totalRows: number;
  totalBytes: number;
  tables: SnapshotTable[];
};

type ContextEstimate = {
  estimatedTokens: number;
  contextWindow: number;
  reserveTokens: number;
  effectiveWindow: number;
};

type SessionInfo = {
  sessionId: string;
  runId: string;
  databaseId: string;
  databaseName: string;
  tableNames: string[];
  modelId: string;
  createdAt: string;
  lastActiveAt: string;
  title?: string;
  snapshot: SnapshotInfo;
  context: ContextEstimate;
};

type SessionStats = {
  messageCount: number;
  cachedTokens: number;
  uncachedTokens: number;
  totalTokens: number;
  costTotal: number;
  context: ContextEstimate;
  snapshot: SnapshotInfo;
};

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  duration?: number;
};

type EvidenceRecord = {
  id: string;
  table: string;
  row: number;
  fields: Record<string, unknown>;
  schema?: Array<{ name: string; type: string }>;
};

type ContextErrorDetails = Partial<ContextEstimate> & {
  phase?: "initial" | "follow_up";
  tableNames?: string[];
  totalRows?: number;
  totalBytes?: number;
};

type ActivityEvent = {
  label: string;
  status: "complete" | "running" | "error";
  detail: string;
};

type ApiPayload = Record<string, any>;

// The catalog comes from GET /api/pi-agent/models, so model naming stays a
// server-side concern. This placeholder only covers the pre-fetch render; an
// empty id tells the server to use its first configured entry.
const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { id: "", label: "默认", detail: "服务端配置的模型" },
];
const modelOptions = ref<ModelOption[]>([...FALLBACK_MODEL_OPTIONS]);
const defaultModelId = ref("");

const sessionState = ref<SessionState>("ready");
const leftPanelMode = ref<LeftPanelMode>("config");
const errorMessage = ref("");
const errorCode = ref("");
const contextErrorDetails = ref<ContextErrorDetails | null>(null);
const actionMessage = ref("");

const databases = ref<DatabaseOption[]>([]);
const selectedDatabase = ref("");
const tables = ref<TableOption[]>([]);
const tableSearch = ref("");
const databaseLoading = ref(false);
const tableLoading = ref(false);
const databaseError = ref("");

const prompt = ref("");
const selectedModelId = ref<string>(defaultModelId.value);

const activeSessionId = ref("");
const activeSessionInfo = ref<SessionInfo | null>(null);
const snapshotInfo = ref<SnapshotInfo | null>(null);
const sessionStats = ref<SessionStats | null>(null);

const historySessions = ref<SessionInfo[]>([]);
const selectedHistoryId = ref("");
const historySearch = ref("");
const historyLoading = ref(false);
const deletingSessionId = ref("");
const exportingSessionId = ref("");

const messages = ref<ConversationMessage[]>([]);
const followUp = ref("");
const streamingText = ref("");
const activityExpanded = ref(false);
const activityEvents = ref<ActivityEvent[]>([]);
const cancelRequested = ref(false);

const evidenceVisible = ref(false);
const evidenceLoading = ref(false);
const activeEvidenceId = ref("");
const activeEvidence = ref<EvidenceRecord | null>(null);
const evidenceError = ref("");

const selectedTables = computed(() => tables.value.filter((table) => table.selected));
const selectedRows = computed(() =>
  selectedTables.value.reduce((total, table) => total + table.rowCount, 0),
);
const filteredTables = computed(() => {
  const keyword = tableSearch.value.trim().toLowerCase();
  return keyword
    ? tables.value.filter((table) => table.name.toLowerCase().includes(keyword))
    : tables.value;
});
const filteredHistorySessions = computed(() => {
  const keyword = historySearch.value.trim().toLowerCase();
  if (!keyword) return historySessions.value;
  return historySessions.value.filter(
    (session) =>
      (session.title || "").toLowerCase().includes(keyword) ||
      session.databaseName.toLowerCase().includes(keyword) ||
      session.tableNames.join(" ").toLowerCase().includes(keyword),
  );
});
const hasSession = computed(() => Boolean(activeSessionId.value));
const controlsLocked = computed(() => hasSession.value);
const runInProgress = computed(
  () => sessionState.value === "preparing" || sessionState.value === "running",
);
const canStart = computed(
  () =>
    Boolean(selectedDatabase.value) &&
    selectedTables.value.length > 0 &&
    prompt.value.trim().length > 0 &&
    !databaseLoading.value &&
    !tableLoading.value,
);
const currentModel = computed<ModelOption>(
  () =>
    modelOptions.value.find((model) => model.id === selectedModelId.value) ||
    modelOptions.value[0] ||
    FALLBACK_MODEL_OPTIONS[0]!,
);
const currentContext = computed(
  () => sessionStats.value?.context || activeSessionInfo.value?.context || null,
);
const contextUsagePercent = computed(() => {
  const context = currentContext.value;
  if (!context || context.effectiveWindow <= 0) return 0;
  return Math.min(100, Math.round((context.estimatedTokens / context.effectiveWindow) * 100));
});
const estimatedSize = computed(() =>
  formatBytes(snapshotInfo.value?.totalBytes ?? selectedRows.value * 200),
);
const scopeDisplay = computed(() => {
  const session = activeSessionInfo.value;
  const snapshot = snapshotInfo.value;
  if (!session || !snapshot) return null;
  return {
    databaseName: session.databaseName,
    tableNames: snapshot.tables.map((table) => table.name).join(" + "),
    totalRows: snapshot.totalRows,
    totalBytes: snapshot.totalBytes,
  };
});
const statusMeta = computed(() => {
  const states: Record<SessionState, { label: string; tone: string; detail: string }> = {
    ready: { label: "等待配置", tone: "neutral", detail: "选择数据表并输入 Prompt" },
    preparing: { label: "准备快照", tone: "info", detail: "正在准备或恢复不可变快照" },
    running: {
      label: cancelRequested.value ? "正在取消" : "Agent 运行中",
      tone: "info",
      detail: cancelRequested.value ? "等待 Agent 安全停止" : "正在生成回答",
    },
    success: { label: "可以继续追问", tone: "success", detail: "本轮已完成" },
    partial: { label: "本轮未完成", tone: "warning", detail: errorMessage.value },
    error: { label: "运行失败", tone: "danger", detail: errorMessage.value },
  };
  return states[sessionState.value];
});

function isModelId(value: unknown): value is string {
  return typeof value === "string" && modelOptions.value.some((model) => model.id === value);
}

async function readJson(response: Response): Promise<ApiPayload> {
  try {
    return (await response.json()) as ApiPayload;
  } catch {
    return {};
  }
}

function payloadMessage(payload: ApiPayload, fallback: string): string {
  if (typeof payload.message === "string" && payload.message) return payload.message;
  if (typeof payload.error === "string" && payload.error) return payload.error;
  return fallback;
}

function setApiFailure(payload: ApiPayload, fallback: string, code: string): void {
  errorMessage.value = payloadMessage(payload, fallback);
  errorCode.value =
    typeof payload.error === "string" ? payload.error.toUpperCase() : code.toUpperCase();
  contextErrorDetails.value =
    payload.error === "context_overflow" && payload.details && typeof payload.details === "object"
      ? (payload.details as ContextErrorDetails)
      : null;
}

function clearFailure(): void {
  errorMessage.value = "";
  errorCode.value = "";
  contextErrorDetails.value = null;
  actionMessage.value = "";
}

/** Loads the server-side catalog; on failure the fallback list stays in place. */
async function fetchModelCatalog(): Promise<void> {
  try {
    const payload = await readJson(await fetch(`${API_BASE}/api/pi-agent/models`));
    const options = (Array.isArray(payload.models) ? (payload.models as ApiPayload[]) : [])
      .filter((model) => typeof model.alias === "string" && model.alias)
      .map((model) => ({
        id: model.alias as string,
        label: (model.label as string) || (model.alias as string),
        detail: (model.detail as string) || "",
      }));
    if (options.length === 0) return;
    modelOptions.value = options;
    defaultModelId.value = options[0]!.id;
    selectedModelId.value = defaultModelId.value;
  } catch {
    // Keep the fallback list.
  }
}

async function loadDatabases(refresh: boolean): Promise<void> {
  if (controlsLocked.value) return;
  databaseLoading.value = true;
  databaseError.value = "";
  try {
    const response = await fetch(`${API_BASE}/api/pi-agent/databases${refresh ? "/refresh" : ""}`, {
      method: refresh ? "POST" : "GET",
    });
    const payload = await readJson(response);
    if (!response.ok || !payload.success || !Array.isArray(payload.databases)) {
      throw new Error(payloadMessage(payload, "数据库列表加载失败"));
    }
    databases.value = payload.databases as DatabaseOption[];
    if (!databases.value.some((database) => database.id === selectedDatabase.value)) {
      selectedDatabase.value = databases.value[0]?.id || "";
    }
    await fetchTables();
  } catch (error) {
    databases.value = [];
    tables.value = [];
    selectedDatabase.value = "";
    databaseError.value = error instanceof Error ? error.message : "数据库列表加载失败";
  } finally {
    databaseLoading.value = false;
  }
}

async function fetchDatabases(): Promise<void> {
  await loadDatabases(false);
}

async function refreshDatabases(): Promise<void> {
  await loadDatabases(true);
}

async function fetchTables(): Promise<void> {
  if (!selectedDatabase.value || controlsLocked.value) {
    if (!selectedDatabase.value) tables.value = [];
    return;
  }
  tableLoading.value = true;
  databaseError.value = "";
  try {
    const response = await fetch(
      `${API_BASE}/api/pi-agent/databases/${encodeURIComponent(selectedDatabase.value)}/tables`,
    );
    const payload = await readJson(response);
    if (!response.ok || !payload.success || !Array.isArray(payload.tables)) {
      throw new Error(payloadMessage(payload, "数据表加载失败"));
    }
    tables.value = (payload.tables as Array<{ name: string; rowCount: number }>).map((table) => ({
      name: table.name,
      rowCount: table.rowCount,
      selected: false,
    }));
  } catch (error) {
    tables.value = [];
    databaseError.value = error instanceof Error ? error.message : "数据表加载失败";
  } finally {
    tableLoading.value = false;
  }
}

async function onDatabaseChange(): Promise<void> {
  await fetchTables();
}

async function fetchHistory(): Promise<void> {
  historyLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/pi-agent/sessions`);
    const payload = await readJson(response);
    if (!response.ok || !payload.success || !Array.isArray(payload.sessions)) {
      throw new Error(payloadMessage(payload, "历史会话加载失败"));
    }
    historySessions.value = payload.sessions as SessionInfo[];
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : "历史会话加载失败";
  } finally {
    historyLoading.value = false;
  }
}

async function openHistoryPanel(): Promise<void> {
  leftPanelMode.value = "history";
  await fetchHistory();
}

async function fetchSessionStats(sessionId = activeSessionId.value): Promise<void> {
  if (!sessionId) return;
  try {
    const response = await fetch(`${API_BASE}/api/pi-agent/sessions/${sessionId}/stats`);
    const payload = await readJson(response);
    if (response.ok && payload.success && payload.stats && activeSessionId.value === sessionId) {
      sessionStats.value = payload.stats as SessionStats;
    }
  } catch {
    // Statistics are supplementary; conversation recovery remains usable without them.
  }
}

function applySessionInfo(session: SessionInfo): void {
  activeSessionId.value = session.sessionId;
  activeSessionInfo.value = session;
  snapshotInfo.value = session.snapshot;
  selectedHistoryId.value = session.sessionId;
  selectedDatabase.value = session.databaseId;
  if (isModelId(session.modelId)) selectedModelId.value = session.modelId;
  tables.value = session.snapshot.tables.map((table) => ({
    name: table.name,
    rowCount: table.rowCount,
    selected: true,
  }));
}

function toggleTable(name: string): void {
  if (controlsLocked.value) return;
  const table = tables.value.find((candidate) => candidate.name === name);
  if (table) table.selected = !table.selected;
}

function applyHelloPreset(): void {
  if (!controlsLocked.value) prompt.value = "你好";
}

async function startSession(): Promise<void> {
  if (!canStart.value || controlsLocked.value) return;
  sessionState.value = "preparing";
  clearFailure();
  messages.value = [];
  streamingText.value = "";
  sessionStats.value = null;
  activityEvents.value = [{ label: "创建数据快照", status: "running", detail: "进行中" }];

  try {
    const response = await fetch(`${API_BASE}/api/pi-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        databaseId: selectedDatabase.value,
        tableNames: selectedTables.value.map((table) => table.name),
        prompt: prompt.value,
        modelId: selectedModelId.value,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok || !payload.success || !payload.session) {
      setApiFailure(payload, "创建会话失败", "session_create_failed");
      sessionState.value = "error";
      activityEvents.value[0] = {
        label: "创建数据快照",
        status: "error",
        detail: errorMessage.value,
      };
      return;
    }

    const session = payload.session as SessionInfo;
    applySessionInfo(session);
    activityEvents.value[0] = {
      label: "数据快照完成",
      status: "complete",
      detail: `${session.snapshot.totalRows} 行 · ${formatBytes(session.snapshot.totalBytes)}`,
    };
    await fetchSessionStats(session.sessionId);
    await sendMessage(prompt.value);
    await fetchHistory();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "网络错误";
    errorCode.value = "NETWORK_ERROR";
    sessionState.value = activeSessionId.value ? "partial" : "error";
  }
}

function streamPayloadData(event: { type: string; data?: unknown }): ApiPayload {
  return event.data && typeof event.data === "object" ? (event.data as ApiPayload) : {};
}

function handleStreamEvent(event: { type: string; data?: unknown }): StreamTerminal {
  const data = streamPayloadData(event);
  switch (event.type) {
    case "text_delta":
      if (typeof data.text === "string") streamingText.value += data.text;
      return null;
    case "tool_start":
      activityEvents.value.push({
        label: typeof data.toolName === "string" ? data.toolName : "工具调用",
        status: "running",
        detail: "执行中",
      });
      return null;
    case "tool_end": {
      const toolName = typeof data.toolName === "string" ? data.toolName : "工具调用";
      const toolEvent = [...activityEvents.value]
        .reverse()
        .find((candidate) => candidate.label === toolName && candidate.status === "running");
      if (toolEvent) {
        toolEvent.status = data.isError ? "error" : "complete";
        toolEvent.detail = data.isError ? "失败" : "完成";
      }
      return null;
    }
    case "error":
      setApiFailure(data, "Agent 返回错误", "agent_error");
      return "error";
    case "aborted":
      errorMessage.value = payloadMessage(data, "运行已由用户取消");
      errorCode.value = "ABORTED";
      return "aborted";
    case "done":
      return "done";
    default:
      return null;
  }
}

function parseSseChunk(chunk: string): { type: string; data?: unknown } | null {
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as { type: string; data?: unknown };
  } catch {
    return null;
  }
}

function completeGenerationActivity(terminal: StreamTerminal, duration: string): void {
  const generation = [...activityEvents.value]
    .reverse()
    .find((event) => event.label === "生成回答" && event.status === "running");
  if (!generation) return;
  generation.status = terminal === "done" ? "complete" : "error";
  generation.detail = terminal === "done" ? `${duration} 秒` : errorMessage.value || "未完成";
}

function commitStreamingMessage(duration: number): void {
  if (!streamingText.value) return;
  messages.value.push({
    role: "assistant",
    content: streamingText.value,
    timestamp: formatClock(Date.now()),
    duration,
  });
  streamingText.value = "";
}

async function sendMessage(message: string): Promise<void> {
  if (!activeSessionId.value || !message.trim() || sessionState.value === "running") return;
  sessionState.value = "running";
  cancelRequested.value = false;
  clearFailure();
  streamingText.value = "";
  messages.value.push({ role: "user", content: message, timestamp: formatClock(Date.now()) });
  activityEvents.value.push({ label: "生成回答", status: "running", detail: "进行中" });
  const startedAt = Date.now();
  let terminal: StreamTerminal = null;

  try {
    const response = await fetch(
      `${API_BASE}/api/pi-agent/sessions/${activeSessionId.value}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
    if (!response.ok || !response.body) {
      const payload = await readJson(response);
      setApiFailure(payload, "无法连接到 Agent", "stream_failed");
      terminal = "error";
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r\n", "\n");
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          const event = parseSseChunk(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          if (event) terminal = handleStreamEvent(event) || terminal;
          separator = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode().replaceAll("\r\n", "\n");
      if (buffer.trim()) {
        const event = parseSseChunk(buffer);
        if (event) terminal = handleStreamEvent(event) || terminal;
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "流式连接中断";
    errorCode.value = "STREAM_ERROR";
    terminal = "error";
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
  commitStreamingMessage(Number(duration));
  if (!terminal) {
    errorMessage.value = "流式响应在收到终态事件前结束";
    errorCode.value = "STREAM_INCOMPLETE";
    terminal = "error";
  }
  completeGenerationActivity(terminal, duration);

  if (terminal === "done") {
    sessionState.value = "success";
    evidenceVisible.value = false;
  } else {
    sessionState.value = "partial";
    if (terminal === "aborted" && !errorMessage.value) errorMessage.value = "运行已由用户取消";
  }
  cancelRequested.value = false;
  await Promise.all([fetchSessionStats(), fetchHistory()]);
}

async function cancelRun(): Promise<void> {
  if (!activeSessionId.value || sessionState.value !== "running" || cancelRequested.value) return;
  cancelRequested.value = true;
  errorMessage.value = "正在等待 Agent 安全停止";
  try {
    const response = await fetch(
      `${API_BASE}/api/pi-agent/sessions/${activeSessionId.value}/abort`,
      {
        method: "POST",
      },
    );
    if (!response.ok && response.status !== 409) {
      const payload = await readJson(response);
      errorMessage.value = payloadMessage(payload, "取消运行失败");
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "取消运行失败";
  }
}

function messageText(message: ApiPayload): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: string; text: string } =>
        Boolean(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function normalizeMessages(rawMessages: unknown[]): ConversationMessage[] {
  return rawMessages.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const message = raw as ApiPayload;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = messageText(message);
    if (message.role === "assistant" && !content.trim()) return [];
    return [
      {
        role: message.role,
        content,
        timestamp: formatClock(
          typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        ),
      } satisfies ConversationMessage,
    ];
  });
}

async function openHistorySession(session: SessionInfo): Promise<void> {
  if (runInProgress.value) return;
  clearFailure();
  leftPanelMode.value = "history";
  applySessionInfo(session);
  messages.value = [];
  streamingText.value = "";
  activityEvents.value = [];
  evidenceVisible.value = false;
  sessionStats.value = null;
  sessionState.value = "preparing";

  try {
    const [response] = await Promise.all([
      fetch(`${API_BASE}/api/pi-agent/sessions/${session.sessionId}/messages`),
      fetchSessionStats(session.sessionId),
    ]);
    const payload = await readJson(response);
    if (!response.ok || !payload.success || !Array.isArray(payload.messages)) {
      setApiFailure(payload, "会话恢复失败", "session_restore_failed");
      sessionState.value = "partial";
      return;
    }
    messages.value = normalizeMessages(payload.messages);
    sessionState.value = "success";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "会话恢复失败";
    errorCode.value = "SESSION_RESTORE_FAILED";
    sessionState.value = "partial";
  }
}

function resetSessionState(): void {
  sessionState.value = "ready";
  leftPanelMode.value = "config";
  activeSessionId.value = "";
  activeSessionInfo.value = null;
  selectedHistoryId.value = "";
  snapshotInfo.value = null;
  sessionStats.value = null;
  messages.value = [];
  streamingText.value = "";
  followUp.value = "";
  prompt.value = "";
  selectedModelId.value = defaultModelId.value;
  evidenceVisible.value = false;
  activityEvents.value = [];
  cancelRequested.value = false;
  clearFailure();
}

function newSession(): void {
  if (runInProgress.value) return;
  resetSessionState();
  tables.value = [];
  void fetchDatabases();
}

async function deleteHistorySession(sessionId: string): Promise<void> {
  if (
    !sessionId ||
    deletingSessionId.value ||
    (runInProgress.value && activeSessionId.value === sessionId)
  ) {
    return;
  }
  if (!window.confirm("删除该会话、PI 历史和对应 workspace？此操作无法撤销。")) return;
  deletingSessionId.value = sessionId;
  actionMessage.value = "";
  try {
    const response = await fetch(`${API_BASE}/api/pi-agent/sessions/${sessionId}`, {
      method: "DELETE",
    });
    const payload = await readJson(response);
    if (!response.ok || !payload.success) {
      throw new Error(payloadMessage(payload, "删除会话失败"));
    }
    if (activeSessionId.value === sessionId) {
      resetSessionState();
      tables.value = [];
      await fetchDatabases();
    }
    await fetchHistory();
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : "删除会话失败";
  } finally {
    deletingSessionId.value = "";
  }
}

async function downloadSession(sessionId: string): Promise<void> {
  if (!sessionId || exportingSessionId.value) return;
  exportingSessionId.value = sessionId;
  actionMessage.value = "";
  try {
    const response = await fetch(`${API_BASE}/api/pi-agent/sessions/${sessionId}/export`);
    if (!response.ok) {
      const payload = await readJson(response);
      throw new Error(payloadMessage(payload, "JSONL 导出失败"));
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const fileName =
      disposition.match(/filename="?([^";]+)"?/i)?.[1] || `pi-session-${sessionId}.jsonl`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    actionMessage.value = `已导出 ${fileName}`;
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : "JSONL 导出失败";
  } finally {
    exportingSessionId.value = "";
  }
}

async function sendFollowUp(): Promise<void> {
  if (!followUp.value.trim() || runInProgress.value) return;
  const message = followUp.value;
  followUp.value = "";
  await sendMessage(message);
}

async function retryRun(): Promise<void> {
  if (runInProgress.value) return;
  if (!activeSessionId.value) {
    await startSession();
    return;
  }
  const lastUserMessage = [...messages.value].reverse().find((message) => message.role === "user");
  if (lastUserMessage) await sendMessage(lastUserMessage.content);
}

function parseEvidenceReference(
  evidenceId: string,
): { tableName: string; rowIndex: number } | null {
  const hashIndex = evidenceId.lastIndexOf("#");
  if (hashIndex <= 0) return null;
  const tableName = evidenceId.slice(0, hashIndex);
  const rowText = evidenceId.slice(hashIndex + 1);
  if (!/^\d+$/.test(rowText)) return null;
  const rowIndex = Number(rowText);
  return Number.isSafeInteger(rowIndex) ? { tableName, rowIndex } : null;
}

function evidenceIsValid(evidenceId: string): boolean {
  const parsed = parseEvidenceReference(evidenceId);
  if (!parsed || !snapshotInfo.value) return false;
  const table = snapshotInfo.value.tables.find((candidate) => candidate.name === parsed.tableName);
  return Boolean(table && parsed.rowIndex >= 0 && parsed.rowIndex < table.rowCount);
}

async function fetchEvidence(evidenceId: string): Promise<void> {
  if (!activeSessionId.value) return;
  activeEvidenceId.value = evidenceId;
  activeEvidence.value = null;
  evidenceError.value = "";
  evidenceVisible.value = true;
  if (!evidenceIsValid(evidenceId)) {
    evidenceError.value = "该证据索引不属于当前快照";
    evidenceLoading.value = false;
    return;
  }
  evidenceLoading.value = true;
  try {
    const response = await fetch(
      `${API_BASE}/api/pi-agent/sessions/${activeSessionId.value}/evidence/${encodeURIComponent(evidenceId)}`,
    );
    const payload = await readJson(response);
    if (!response.ok || !payload.success || !payload.evidence) {
      throw new Error(payloadMessage(payload, "该证据索引不属于当前快照"));
    }
    activeEvidence.value = payload.evidence as EvidenceRecord;
  } catch (error) {
    evidenceError.value = error instanceof Error ? error.message : "证据加载失败";
  } finally {
    evidenceLoading.value = false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEvidencePlaceholders(text: string): { text: string; evidenceIds: string[] } {
  const evidenceIds: string[] = [];
  const reserve = (evidenceId: string) => {
    const index = evidenceIds.push(evidenceId) - 1;
    return `PIEVIDENCEPLACEHOLDER${index}TOKEN`;
  };
  let tokenized = text;
  const tableNames = [...(snapshotInfo.value?.tables || [])]
    .map((table) => table.name)
    .sort((left, right) => right.length - left.length);
  for (const tableName of tableNames) {
    const pattern = new RegExp(`\\[${escapeRegExp(tableName)}#(\\d+)\\]`, "g");
    tokenized = tokenized.replace(pattern, (_match, rowIndex: string) =>
      reserve(`${tableName}#${rowIndex}`),
    );
  }
  tokenized = tokenized.replace(/\[([^\]\r\n]+#\d+)\]/g, (_match, evidenceId: string) =>
    reserve(evidenceId),
  );
  return { text: tokenized, evidenceIds };
}

function renderMarkdown(text: string): string {
  if (!text) return "";
  const placeholders = extractEvidencePlaceholders(text);
  let html = escapeHtml(placeholders.text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/^(\d+)\.\s+(.+)$/gm, "<li>$2</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ol>$&</ol>");
  html = html
    .split(/\n\n+/)
    .map((paragraph) => {
      const trimmed = paragraph.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("<ol>") || trimmed.startsWith("<li>")) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
  html = html.replace(/PIEVIDENCEPLACEHOLDER(\d+)TOKEN/g, (_match, indexText: string) => {
    const evidenceId = placeholders.evidenceIds[Number(indexText)] || "";
    const valid = evidenceIsValid(evidenceId);
    const className = valid ? "evidence-chip" : "evidence-chip invalid-evidence-chip";
    const title = valid ? "查看快照原始行" : "无效证据：不属于当前快照";
    return `<button type="button" class="${className}" data-evidence="${escapeHtml(evidenceId)}" title="${title}">[${escapeHtml(evidenceId)}]</button>`;
  });
  return html;
}

function onConversationClick(event: Event): void {
  const target = event.target as HTMLElement;
  if (target.classList.contains("evidence-chip") && target.dataset.evidence) {
    void fetchEvidence(target.dataset.evidence);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: number | undefined): string {
  return Number(value || 0).toLocaleString("zh-CN");
}

function formatCost(value: number | undefined): string {
  return `$${Number(value || 0).toFixed(6)}`;
}

function formatDate(isoString: string): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  const difference = Date.now() - date.getTime();
  if (difference < 60_000) return "刚刚";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`;
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFieldValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

onMounted(async () => {
  await Promise.all([fetchModelCatalog(), fetchDatabases(), fetchHistory()]);
});
</script>

<template>
  <div class="pi-page">
    <div class="workbench">
      <aside class="side-panel">
        <nav class="panel-tabs" aria-label="PI Agent 左侧面板">
          <button
            type="button"
            :class="{ active: leftPanelMode === 'config' }"
            @click="leftPanelMode = 'config'"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            新建分析
          </button>
          <button
            type="button"
            :class="{ active: leftPanelMode === 'history' }"
            @click="openHistoryPanel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5M12 7v5l3 2" />
            </svg>
            历史会话
            <span>{{ historySessions.length }}</span>
          </button>
        </nav>

        <template v-if="leftPanelMode === 'config'">
          <header class="panel-heading">
            <div>
              <span class="eyebrow">分析配置</span>
              <h3>选择本次数据范围</h3>
            </div>
            <span v-if="controlsLocked" class="lock-badge">已锁定</span>
          </header>

          <div class="config-scroll">
            <section class="field-group">
              <div class="field-label-row">
                <label for="pi-database">数据库</label>
                <button
                  type="button"
                  class="text-action"
                  :disabled="controlsLocked || databaseLoading"
                  @click="refreshDatabases"
                >
                  {{ databaseLoading ? "刷新中" : "刷新数据库" }}
                </button>
              </div>
              <div class="select-shell">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <ellipse cx="12" cy="5" rx="8" ry="3" />
                  <path
                    d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7"
                  />
                </svg>
                <select
                  id="pi-database"
                  v-model="selectedDatabase"
                  :disabled="controlsLocked || databaseLoading || databases.length === 0"
                  @change="onDatabaseChange"
                >
                  <option v-if="databases.length === 0" value="">未发现数据库</option>
                  <option v-for="database in databases" :key="database.id" :value="database.id">
                    {{ database.name }}
                  </option>
                </select>
              </div>
              <span v-if="databaseError" class="field-error">{{ databaseError }}</span>
              <span v-else class="field-hint">
                {{
                  databases.find((database) => database.id === selectedDatabase)
                    ? `${formatBytes(databases.find((database) => database.id === selectedDatabase)!.sizeBytes)} · ${formatDate(databases.find((database) => database.id === selectedDatabase)!.modifiedAt)}`
                    : "仅显示服务端受控目录中的 SQLite 文件"
                }}
              </span>
            </section>

            <section class="field-group table-section">
              <div class="field-label-row">
                <label>数据表</label><span>{{ selectedTables.length }} 已选择</span>
              </div>
              <div class="search-shell">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-4-4" />
                </svg>
                <input
                  v-model="tableSearch"
                  type="search"
                  placeholder="搜索数据表"
                  :disabled="controlsLocked || tableLoading"
                />
              </div>
              <div class="table-list" :aria-busy="tableLoading">
                <button
                  v-for="table in filteredTables"
                  :key="table.name"
                  type="button"
                  class="table-option"
                  :class="{ selected: table.selected }"
                  :disabled="controlsLocked"
                  @click="toggleTable(table.name)"
                >
                  <span class="checkbox" :class="{ checked: table.selected }">
                    <svg v-if="table.selected" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>
                  </span>
                  <span
                    ><strong>{{ table.name }}</strong
                    ><small>{{ table.rowCount }} 行</small></span
                  >
                </button>
                <p v-if="tableLoading" class="list-empty">正在加载数据表…</p>
                <p v-else-if="filteredTables.length === 0" class="list-empty">
                  {{ tables.length ? "没有匹配的数据表" : "无可用数据表" }}
                </p>
              </div>
              <span class="field-hint">默认不选择；内部表不会出现在白名单中</span>
            </section>

            <section class="field-group">
              <label>分析模式</label>
              <div class="model-switch" role="group" aria-label="分析模式">
                <button
                  v-for="model in modelOptions"
                  :key="model.id"
                  type="button"
                  :class="{ active: selectedModelId === model.id }"
                  :disabled="controlsLocked"
                  @click="selectedModelId = model.id"
                >
                  <strong>{{ model.label }}</strong
                  ><small>{{ model.detail }}</small>
                </button>
              </div>
            </section>

            <section class="field-group">
              <div class="field-label-row">
                <label for="pi-prompt">Prompt</label>
                <button
                  type="button"
                  class="preset-button"
                  :disabled="controlsLocked"
                  @click="applyHelloPreset"
                >
                  预设：你好
                </button>
              </div>
              <textarea
                id="pi-prompt"
                v-model="prompt"
                rows="5"
                :disabled="controlsLocked"
                placeholder="输入你想针对所选表分析的问题"
              />
              <span class="field-hint">预设只填入精确文本“你好”，可自由修改</span>
            </section>

            <section class="snapshot-card" :class="{ locked: controlsLocked }">
              <strong>{{ controlsLocked ? "会话数据范围已固定" : "即将创建全量快照" }}</strong>
              <dl>
                <div>
                  <dt>数据表</dt>
                  <dd>{{ snapshotInfo?.tables.length ?? selectedTables.length }} 张</dd>
                </div>
                <div>
                  <dt>总行数</dt>
                  <dd>{{ snapshotInfo?.totalRows ?? selectedRows }} 行</dd>
                </div>
                <div>
                  <dt>内容大小</dt>
                  <dd>{{ estimatedSize }}</dd>
                </div>
              </dl>
            </section>
          </div>

          <footer class="panel-footer">
            <button
              type="button"
              class="primary-button"
              :disabled="!canStart || controlsLocked"
              @click="startSession"
            >
              <svg viewBox="0 0 24 24"><path d="m5 3 14 9-14 9V3Z" /></svg>
              开始分析
            </button>
            <span v-if="controlsLocked">更改范围或模型需要新建会话</span>
          </footer>
        </template>

        <template v-else>
          <header class="panel-heading">
            <div>
              <span class="eyebrow">会话历史</span>
              <h3>继续之前的分析</h3>
            </div>
            <span class="muted-count">{{ historySessions.length }} 个</span>
          </header>
          <div class="history-search search-shell">
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4" />
            </svg>
            <input v-model="historySearch" type="search" placeholder="搜索标题、数据库或表" />
          </div>
          <p v-if="actionMessage" class="action-message">{{ actionMessage }}</p>
          <div class="history-list" :aria-busy="historyLoading">
            <article
              v-for="session in filteredHistorySessions"
              :key="session.sessionId"
              class="history-item"
              :class="{ active: selectedHistoryId === session.sessionId }"
            >
              <button type="button" class="history-open" @click="openHistorySession(session)">
                <span class="history-title">
                  <strong>{{ session.title || session.tableNames.join(" + ") }}</strong>
                  <small>{{ formatDate(session.lastActiveAt) }}</small>
                </span>
                <span>{{ session.databaseName }} · {{ session.tableNames.join(", ") }}</span>
                <small
                  >{{ session.modelId === PRO_MODEL_ID ? "Pro" : "Flash" }} ·
                  {{ session.snapshot.totalRows }} 行 ·
                  {{ formatBytes(session.snapshot.totalBytes) }}</small
                >
              </button>
              <div class="history-actions">
                <button
                  type="button"
                  :disabled="exportingSessionId === session.sessionId"
                  @click="downloadSession(session.sessionId)"
                >
                  {{ exportingSessionId === session.sessionId ? "导出中" : "JSONL" }}
                </button>
                <button
                  type="button"
                  class="danger-text"
                  :disabled="deletingSessionId === session.sessionId"
                  @click="deleteHistorySession(session.sessionId)"
                >
                  {{ deletingSessionId === session.sessionId ? "删除中" : "删除" }}
                </button>
              </div>
            </article>
            <p v-if="historyLoading" class="list-empty">正在加载历史会话…</p>
            <p v-else-if="filteredHistorySessions.length === 0" class="list-empty">
              {{ historySessions.length ? "没有匹配的历史会话" : "暂无历史会话" }}
            </p>
          </div>
          <footer class="panel-footer">
            <button type="button" class="primary-button" @click="newSession">新建分析</button>
          </footer>
        </template>
      </aside>

      <main class="conversation-panel">
        <header class="conversation-header">
          <div class="session-heading">
            <div class="agent-mark">PI</div>
            <div>
              <span class="eyebrow">PI Agent 会话</span>
              <h3>{{ activeSessionInfo?.title || "数据分析" }}</h3>
            </div>
          </div>
          <div class="header-actions">
            <button type="button" class="secondary-button" @click="openHistoryPanel">历史</button>
            <button
              v-if="hasSession"
              type="button"
              class="secondary-button"
              :disabled="runInProgress || Boolean(exportingSessionId)"
              @click="downloadSession(activeSessionId)"
            >
              {{ exportingSessionId === activeSessionId ? "导出中" : "导出 JSONL" }}
            </button>
            <button
              v-if="hasSession && !runInProgress"
              type="button"
              class="secondary-button danger-button"
              @click="deleteHistorySession(activeSessionId)"
            >
              删除
            </button>
            <span class="status-pill" :class="statusMeta.tone"><i />{{ statusMeta.label }}</span>
            <button
              v-if="sessionState === 'running'"
              type="button"
              class="secondary-button danger-button"
              :disabled="cancelRequested"
              @click="cancelRun"
            >
              {{ cancelRequested ? "正在取消" : "取消运行" }}
            </button>
            <button
              v-else-if="hasSession"
              type="button"
              class="secondary-button"
              @click="newSession"
            >
              新建会话
            </button>
          </div>
        </header>

        <div v-if="scopeDisplay" class="scope-strip">
          <strong>固定快照</strong>
          <span>{{ scopeDisplay.databaseName }}</span
          ><i /> <span>{{ scopeDisplay.tableNames }}</span
          ><i />
          <span>{{ scopeDisplay.totalRows }} 行 · {{ formatBytes(scopeDisplay.totalBytes) }}</span>
          <span class="scope-model">{{ currentModel.label }}</span>
        </div>

        <div v-if="hasSession" class="stats-strip">
          <div>
            <span>消息</span><strong>{{ formatNumber(sessionStats?.messageCount) }}</strong>
          </div>
          <div>
            <span>累计 Token</span><strong>{{ formatNumber(sessionStats?.totalTokens) }}</strong>
          </div>
          <div>
            <span>缓存 / 非缓存</span
            ><strong
              >{{ formatNumber(sessionStats?.cachedTokens) }} /
              {{ formatNumber(sessionStats?.uncachedTokens) }}</strong
            >
          </div>
          <div>
            <span>累计成本</span><strong>{{ formatCost(sessionStats?.costTotal) }}</strong>
          </div>
          <div class="context-stat">
            <span>初始上下文</span>
            <strong
              >{{ formatNumber(currentContext?.estimatedTokens) }} /
              {{ formatNumber(currentContext?.effectiveWindow) }}</strong
            >
            <small
              >模型窗口 {{ formatNumber(currentContext?.contextWindow) }} · 预留
              {{ formatNumber(currentContext?.reserveTokens) }} · {{ contextUsagePercent }}%</small
            >
            <span class="context-bar"><i :style="{ width: `${contextUsagePercent}%` }" /></span>
          </div>
        </div>

        <section v-if="sessionState === 'ready'" class="empty-state">
          <div class="empty-mark">PI</div>
          <h3>从左侧配置一次分析</h3>
          <p>选择至少一张表、Flash 或 Pro 模式和 Prompt。启动后会话始终复用同一份不可变快照。</p>
        </section>

        <template v-else>
          <div v-if="sessionState === 'preparing'" class="run-banner info" role="status">
            <span class="spinner" />
            <div><strong>正在准备会话</strong><span>创建或恢复不可变快照与 PI 状态。</span></div>
          </div>
          <div v-if="sessionState === 'partial'" class="run-banner warning" role="status">
            <strong>{{ errorCode === "ABORTED" ? "运行已取消" : "本轮未完成" }}</strong>
            <span>{{ errorMessage || "Agent 未返回正常完成事件。" }}</span>
            <button type="button" @click="retryRun">重试上一条</button>
          </div>
          <div v-if="sessionState === 'error'" class="error-card" role="alert">
            <div>
              <strong>运行失败</strong><code>{{ errorCode }}</code>
            </div>
            <p>{{ errorMessage || "未知错误" }}</p>
            <dl v-if="contextErrorDetails" class="overflow-details">
              <div>
                <dt>所选表</dt>
                <dd>{{ contextErrorDetails.tableNames?.join(", ") || "—" }}</dd>
              </div>
              <div>
                <dt>全量行数</dt>
                <dd>{{ formatNumber(contextErrorDetails.totalRows) }}</dd>
              </div>
              <div>
                <dt>序列化大小</dt>
                <dd>{{ formatBytes(contextErrorDetails.totalBytes || 0) }}</dd>
              </div>
              <div>
                <dt>预估 Token</dt>
                <dd>{{ formatNumber(contextErrorDetails.estimatedTokens) }}</dd>
              </div>
              <div>
                <dt>模型窗口</dt>
                <dd>{{ formatNumber(contextErrorDetails.contextWindow) }}</dd>
              </div>
              <div>
                <dt>预留 / 有效窗口</dt>
                <dd>
                  {{ formatNumber(contextErrorDetails.reserveTokens) }} /
                  {{ formatNumber(contextErrorDetails.effectiveWindow) }}
                </dd>
              </div>
            </dl>
            <button type="button" class="secondary-button" @click="retryRun">重试</button>
          </div>

          <div
            v-if="sessionState !== 'error'"
            class="conversation-content"
            @click="onConversationClick"
          >
            <div class="messages-column">
              <article
                v-for="(message, index) in messages"
                :key="index"
                class="message"
                :class="message.role"
              >
                <div class="avatar">{{ message.role === "user" ? "你" : "PI" }}</div>
                <div class="message-body">
                  <header>
                    <strong>{{ message.role === "user" ? "你" : "PI Agent" }}</strong
                    ><span
                      >{{ message.timestamp
                      }}{{ message.duration ? ` · ${message.duration} 秒` : "" }}</span
                    >
                  </header>
                  <p v-if="message.role === 'user'">{{ message.content }}</p>
                  <div v-else class="answer-copy" v-html="renderMarkdown(message.content)" />
                </div>
              </article>

              <article v-if="streamingText" class="message assistant">
                <div class="avatar">PI</div>
                <div class="message-body">
                  <header><strong>PI Agent</strong><span>正在输入</span></header>
                  <div class="answer-copy" v-html="renderMarkdown(streamingText)" />
                </div>
              </article>
              <article v-else-if="sessionState === 'running'" class="message assistant">
                <div class="avatar">PI</div>
                <div class="typing-dots" aria-label="Agent 正在输入"><i /><i /><i /></div>
              </article>

              <button
                v-if="activityEvents.length"
                type="button"
                class="activity-toggle"
                @click="activityExpanded = !activityExpanded"
              >
                <span>运行过程 · {{ activityEvents.length }} 个事件</span
                ><span>{{ activityExpanded ? "收起" : "展开" }}</span>
              </button>
              <div v-if="activityExpanded" class="activity-list">
                <div v-for="(event, index) in activityEvents" :key="index">
                  <i :class="event.status" /><strong>{{ event.label }}</strong
                  ><span>{{ event.detail }}</span>
                </div>
              </div>
            </div>

            <aside v-if="evidenceVisible" class="evidence-panel">
              <header>
                <div>
                  <span class="eyebrow">证据原始行</span>
                  <h4>{{ activeEvidenceId }}</h4>
                </div>
                <button type="button" aria-label="关闭证据" @click="evidenceVisible = false">
                  ×
                </button>
              </header>
              <p v-if="evidenceLoading" class="evidence-state">正在读取不可变快照…</p>
              <div v-else-if="evidenceError" class="invalid-evidence">
                <strong>无效证据索引</strong>
                <p>{{ evidenceError }}</p>
                <span>该引用不会被视为当前回答的有效证据。</span>
              </div>
              <template v-else-if="activeEvidence">
                <div class="evidence-meta">
                  <span>来源表：{{ activeEvidence.table }}</span
                  ><span>快照行：{{ activeEvidence.row }}</span>
                </div>
                <dl class="evidence-fields">
                  <div v-for="(value, key) in activeEvidence.fields" :key="key">
                    <dt>{{ key }}</dt>
                    <dd>{{ formatFieldValue(value) }}</dd>
                  </div>
                </dl>
                <p class="evidence-note">索引只在当前不可变快照和连续会话中保持稳定。</p>
              </template>
            </aside>
          </div>

          <footer v-if="sessionState !== 'error'" class="composer">
            <div>
              <textarea
                v-model="followUp"
                rows="2"
                placeholder="继续追问这份数据……"
                :disabled="runInProgress"
                @keydown.meta.enter.prevent="sendFollowUp"
                @keydown.ctrl.enter.prevent="sendFollowUp"
              />
              <button
                type="button"
                :disabled="!followUp.trim() || runInProgress"
                @click="sendFollowUp"
              >
                <svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" /></svg>
              </button>
            </div>
            <span>同一会话复用 {{ snapshotInfo?.totalRows || 0 }} 行固定快照 · ⌘ Enter 发送</span>
          </footer>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.pi-page {
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
  --border: #e2e8f0;
  --muted: #64748b;
  --ink: #0f172a;
  width: 100%;
  min-width: 0;
}

button,
select,
textarea,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled,
select:disabled,
textarea:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.workbench {
  min-height: calc(100vh - 140px);
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 1rem;
}

.side-panel,
.conversation-panel {
  min-width: 0;
  min-height: 0;
  max-height: calc(100vh - 140px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 5%);
}

.side-panel,
.conversation-panel {
  display: flex;
  flex-direction: column;
}

.panel-tabs {
  min-height: 46px;
  padding: 0.35rem;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.3rem;
  border-bottom: 1px solid var(--border);
  background: #f8fafc;
}

.panel-tabs button {
  border: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  color: var(--muted);
  background: transparent;
  font-size: 0.7rem;
  font-weight: 700;
}

.panel-tabs button.active {
  color: #4338ca;
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 8%);
}

.panel-tabs button > span {
  min-width: 17px;
  height: 17px;
  padding: 0 0.2rem;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: #e2e8f0;
  font-size: 0.58rem;
}

.panel-heading,
.conversation-header {
  min-height: 70px;
  padding: 0 1rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.panel-heading h3,
.conversation-header h3 {
  margin: 0.15rem 0 0;
  color: var(--ink);
  font-size: 0.94rem;
}

.eyebrow {
  display: block;
  color: #94a3b8;
  font-size: 0.64rem;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.lock-badge,
.muted-count {
  padding: 0.28rem 0.5rem;
  border-radius: 999px;
  color: var(--muted);
  background: #f1f5f9;
  font-size: 0.65rem;
  font-weight: 700;
}

.config-scroll {
  flex: 1;
  min-height: 0;
  padding: 1rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.48rem;
}

.field-group label {
  color: #334155;
  font-size: 0.75rem;
  font-weight: 700;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.field-label-row > span,
.field-hint,
.panel-footer > span {
  color: #94a3b8;
  font-size: 0.64rem;
  line-height: 1.45;
}

.field-error {
  color: #b91c1c;
  font-size: 0.66rem;
}

.text-action,
.preset-button {
  padding: 0.25rem 0.5rem;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  color: #4338ca;
  background: var(--primary-soft);
  font-size: 0.64rem;
  font-weight: 700;
}

.select-shell,
.search-shell {
  position: relative;
  display: flex;
  align-items: center;
}

.select-shell > svg,
.search-shell > svg {
  position: absolute;
  left: 0.7rem;
  z-index: 1;
  color: #94a3b8;
  pointer-events: none;
}

.select-shell select,
.search-shell input,
.field-group textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  color: #1e293b;
  background: #fff;
  outline: none;
}

.select-shell select,
.search-shell input {
  height: 40px;
  padding: 0 0.7rem 0 2.25rem;
  font-size: 0.74rem;
}

.field-group textarea {
  min-height: 104px;
  padding: 0.7rem;
  resize: vertical;
  font-size: 0.75rem;
  line-height: 1.55;
}

.select-shell select:focus,
.search-shell input:focus,
.field-group textarea:focus,
.composer textarea:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 3px rgb(99 102 241 / 12%);
}

.table-list {
  max-height: 155px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
}

.table-option {
  width: 100%;
  padding: 0.55rem 0.65rem;
  border: 0;
  border-bottom: 1px solid #f1f5f9;
  background: #fff;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  text-align: left;
}

.table-option:last-of-type {
  border-bottom: 0;
}

.table-option:hover,
.table-option.selected {
  background: #f8faff;
}

.table-option > span:last-child {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.table-option strong {
  color: #334155;
  font-size: 0.72rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.table-option small {
  color: #94a3b8;
  font-size: 0.62rem;
}

.checkbox {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  border: 1.5px solid #cbd5e1;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: #fff;
}

.checkbox.checked {
  border-color: var(--primary);
  background: var(--primary);
}

.checkbox svg {
  width: 12px;
  height: 12px;
  stroke-width: 2.5;
}

.list-empty {
  margin: 0;
  padding: 1.6rem 0.7rem;
  color: #94a3b8;
  font-size: 0.68rem;
  text-align: center;
}

.model-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.45rem;
}

.model-switch button {
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--muted);
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  text-align: left;
}

.model-switch button.active {
  border-color: #818cf8;
  color: #3730a3;
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 1px #c7d2fe;
}

.model-switch strong {
  font-size: 0.72rem;
}

.model-switch small {
  font-size: 0.6rem;
}

.snapshot-card {
  padding: 0.72rem;
  border: 1px solid #c7d2fe;
  border-radius: 10px;
  color: #4338ca;
  background: #f8faff;
  font-size: 0.68rem;
}

.snapshot-card.locked {
  border-color: #a7f3d0;
  color: #047857;
  background: #f0fdf4;
}

.snapshot-card dl {
  margin: 0.65rem 0 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.45rem;
}

.snapshot-card dl div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.snapshot-card dt {
  color: #94a3b8;
  font-size: 0.58rem;
}

.snapshot-card dd {
  margin: 0;
  color: #334155;
  font-size: 0.7rem;
  font-weight: 700;
}

.panel-footer {
  padding: 0.78rem 0.9rem;
  border-top: 1px solid var(--border);
  text-align: center;
}

.primary-button,
.secondary-button {
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  font-weight: 700;
}

.primary-button {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--primary);
  color: #fff;
  background: var(--primary);
  font-size: 0.75rem;
}

.panel-footer > span {
  display: block;
  margin-top: 0.45rem;
}

.history-search {
  margin: 0.75rem;
}

.action-message {
  margin: 0 0.75rem 0.5rem;
  padding: 0.45rem 0.55rem;
  border-radius: 7px;
  color: #475569;
  background: #f1f5f9;
  font-size: 0.63rem;
}

.history-list {
  flex: 1;
  min-height: 0;
  padding: 0 0.45rem 0.45rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.history-item {
  border: 1px solid transparent;
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}

.history-item:hover,
.history-item.active {
  border-color: #c7d2fe;
  background: #f8faff;
}

.history-item.active {
  box-shadow: inset 3px 0 0 #6366f1;
}

.history-open {
  width: 100%;
  padding: 0.65rem 0.7rem 0.45rem;
  border: 0;
  color: var(--muted);
  background: transparent;
  display: flex;
  flex-direction: column;
  gap: 0.32rem;
  text-align: left;
  font-size: 0.61rem;
}

.history-title {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.history-title strong {
  min-width: 0;
  color: #1e293b;
  font-size: 0.72rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-title small {
  flex: 0 0 auto;
}

.history-actions {
  padding: 0 0.65rem 0.5rem;
  display: flex;
  gap: 0.4rem;
}

.history-actions button {
  padding: 0.2rem 0.4rem;
  border: 0;
  border-radius: 5px;
  color: #4338ca;
  background: #eef2ff;
  font-size: 0.58rem;
  font-weight: 700;
}

.history-actions .danger-text {
  color: #b91c1c;
  background: #fef2f2;
}

.conversation-header {
  flex: 0 0 auto;
}

.session-heading,
.header-actions {
  display: flex;
  align-items: center;
}

.session-heading {
  min-width: 0;
  gap: 0.65rem;
}

.session-heading h3 {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-mark,
.empty-mark {
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  font-weight: 800;
}

.agent-mark {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  font-size: 0.7rem;
}

.header-actions {
  gap: 0.45rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.secondary-button {
  min-height: 32px;
  padding: 0 0.58rem;
  border: 1px solid #cbd5e1;
  color: #475569;
  background: #fff;
  font-size: 0.66rem;
}

.danger-button {
  border-color: #fecaca;
  color: #b91c1c;
}

.status-pill {
  padding: 0.32rem 0.52rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--muted);
  background: #f8fafc;
  font-size: 0.64rem;
  font-weight: 700;
}

.status-pill i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill.info {
  color: #3730a3;
  border-color: #c7d2fe;
  background: #eef2ff;
}
.status-pill.success {
  color: #047857;
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.status-pill.warning {
  color: #a16207;
  border-color: #fde68a;
  background: #fffbeb;
}
.status-pill.danger {
  color: #b91c1c;
  border-color: #fecaca;
  background: #fef2f2;
}

.scope-strip {
  min-height: 40px;
  padding: 0 1rem;
  border-bottom: 1px solid var(--border);
  background: #f8fafc;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--muted);
  font-size: 0.64rem;
  white-space: nowrap;
  overflow-x: auto;
}

.scope-strip > strong,
.scope-model {
  padding: 0.2rem 0.42rem;
  border-radius: 999px;
  color: #047857;
  background: #dcfce7;
}

.scope-strip > i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #cbd5e1;
}

.scope-model {
  margin-left: auto;
  color: #4338ca;
  background: #e0e7ff;
  font-weight: 700;
}

.stats-strip {
  min-height: 58px;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  display: grid;
  grid-template-columns: repeat(4, minmax(82px, auto)) minmax(150px, 1fr);
  gap: 0.8rem;
  background: #fff;
}

.stats-strip > div {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.12rem;
}

.stats-strip span {
  color: #94a3b8;
  font-size: 0.57rem;
}

.stats-strip strong {
  color: #334155;
  font-size: 0.68rem;
}

.context-stat small {
  color: #94a3b8;
  font-size: 0.52rem;
  white-space: nowrap;
}

.context-bar {
  width: 100%;
  height: 3px;
  border-radius: 999px;
  overflow: hidden;
  background: #e2e8f0;
}

.context-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #6366f1;
}

.empty-state {
  flex: 1;
  padding: 3rem 1.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.empty-mark {
  width: 62px;
  height: 62px;
  border-radius: 18px;
  font-size: 1rem;
}

.empty-state h3 {
  margin: 0.9rem 0 0.35rem;
  color: var(--ink);
  font-size: 1rem;
}

.empty-state p {
  max-width: 480px;
  margin: 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.6;
}

.run-banner {
  margin: 0.65rem 0.9rem 0;
  padding: 0.6rem 0.75rem;
  border-radius: 9px;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.68rem;
}

.run-banner.info {
  border: 1px solid #c7d2fe;
  background: #f5f7ff;
}
.run-banner.warning {
  border: 1px solid #fde68a;
  background: #fffbeb;
}

.run-banner div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.run-banner span {
  color: var(--muted);
}

.run-banner button {
  margin-left: auto;
  border: 0;
  color: #92400e;
  background: transparent;
  font-size: 0.65rem;
  font-weight: 700;
}

.spinner {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  border: 2px solid #c7d2fe;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.error-card {
  margin: 1rem;
  padding: 1rem;
  border: 1px solid #fecaca;
  border-radius: 11px;
  color: #991b1b;
  background: #fffafa;
}

.error-card > div:first-child {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.error-card code {
  color: #b91c1c;
  font-size: 0.62rem;
}

.error-card p {
  color: var(--muted);
  font-size: 0.7rem;
}

.overflow-details {
  margin: 0.75rem 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}

.overflow-details div {
  padding: 0.45rem;
  border-radius: 7px;
  background: #fff;
}

.overflow-details dt {
  color: #94a3b8;
  font-size: 0.57rem;
}

.overflow-details dd {
  margin: 0.15rem 0 0;
  color: #334155;
  font-size: 0.65rem;
  overflow-wrap: anywhere;
}

.conversation-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  align-items: start;
}

.conversation-content:not(:has(.evidence-panel)) {
  grid-template-columns: minmax(0, 1fr);
}

.messages-column {
  min-width: 0;
  padding: 0.9rem 1rem 1.2rem;
}

.message {
  margin-bottom: 1rem;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 0.65rem;
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  font-size: 0.65rem;
  font-weight: 800;
}

.message.user .avatar {
  color: #334155;
  background: #e2e8f0;
}

.message-body {
  min-width: 0;
}

.message-body header {
  min-height: 27px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.message-body header strong {
  color: #1e293b;
  font-size: 0.7rem;
}

.message-body header span {
  color: #94a3b8;
  font-size: 0.59rem;
}

.message.user .message-body {
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 4px 10px 10px;
  background: #f8fafc;
}

.message.user .message-body header {
  min-height: auto;
}

.message p,
.answer-copy :deep(p),
.answer-copy :deep(li) {
  color: #475569;
  font-size: 0.73rem;
  line-height: 1.7;
}

.message p,
.answer-copy :deep(p) {
  margin: 0.18rem 0 0.55rem;
}

.answer-copy :deep(ol) {
  margin: 0.2rem 0 0.7rem;
  padding-left: 1.2rem;
}

.answer-copy :deep(.evidence-chip) {
  display: inline;
  padding: 0.1rem 0.28rem;
  border: 0;
  border-radius: 5px;
  color: #4338ca;
  background: #eef2ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.63rem;
  font-weight: 700;
}

.answer-copy :deep(.invalid-evidence-chip) {
  color: #b91c1c;
  background: #fee2e2;
  text-decoration: line-through;
}

.typing-dots {
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.typing-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #818cf8;
  animation: typing 1.2s infinite;
}

.typing-dots i:nth-child(2) {
  animation-delay: 0.18s;
}
.typing-dots i:nth-child(3) {
  animation-delay: 0.36s;
}

.activity-toggle {
  width: 100%;
  min-height: 36px;
  padding: 0 0.65rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--muted);
  background: #fff;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.65rem;
}

.activity-list {
  margin-top: 0.4rem;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: #f8fafc;
}

.activity-list > div {
  min-height: 25px;
  display: grid;
  grid-template-columns: 7px 1fr auto;
  align-items: center;
  gap: 0.45rem;
  color: #475569;
  font-size: 0.62rem;
}

.activity-list i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.activity-list i.complete {
  background: #10b981;
}
.activity-list i.running {
  background: #6366f1;
}
.activity-list i.error {
  background: #ef4444;
}
.activity-list span {
  color: #94a3b8;
}

.evidence-panel {
  align-self: stretch;
  min-height: 100%;
  border-left: 1px solid var(--border);
  background: #f8fafc;
}

.evidence-panel > header {
  min-height: 60px;
  padding: 0 0.8rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.evidence-panel h4 {
  margin: 0.15rem 0 0;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.69rem;
  overflow-wrap: anywhere;
}

.evidence-panel > header button {
  width: 27px;
  height: 27px;
  border: 0;
  border-radius: 7px;
  color: var(--muted);
  background: transparent;
  font-size: 1rem;
}

.evidence-state,
.invalid-evidence {
  margin: 0.8rem;
  padding: 0.75rem;
  border-radius: 8px;
  font-size: 0.66rem;
}

.evidence-state {
  color: var(--muted);
  background: #fff;
}

.invalid-evidence {
  border: 1px solid #fecaca;
  color: #991b1b;
  background: #fef2f2;
}

.invalid-evidence p,
.invalid-evidence span {
  color: var(--muted);
  line-height: 1.5;
}

.evidence-meta {
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  color: var(--muted);
  font-size: 0.62rem;
}

.evidence-fields {
  margin: 0;
  padding: 0.15rem 0.8rem;
}

.evidence-fields > div {
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--border);
}

.evidence-fields dt {
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.58rem;
}

.evidence-fields dd {
  margin: 0.22rem 0 0;
  color: #334155;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.66rem;
  line-height: 1.5;
}

.evidence-note {
  margin: 0.7rem 0.8rem;
  color: #94a3b8;
  font-size: 0.59rem;
  line-height: 1.45;
}

.composer {
  padding: 0.7rem 0.9rem 0.55rem;
  border-top: 1px solid var(--border);
  background: #fff;
}

.composer > div {
  position: relative;
}

.composer textarea {
  width: 100%;
  min-height: 54px;
  max-height: 120px;
  box-sizing: border-box;
  padding: 0.62rem 3rem 0.62rem 0.7rem;
  resize: none;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  color: #1e293b;
  background: #fff;
  outline: none;
  font-size: 0.72rem;
  line-height: 1.5;
}

.composer > div > button {
  position: absolute;
  right: 0.45rem;
  bottom: 0.48rem;
  width: 31px;
  height: 31px;
  border: 0;
  border-radius: 8px;
  color: #fff;
  background: var(--primary);
  display: grid;
  place-items: center;
}

.composer > span {
  display: block;
  margin-top: 0.3rem;
  color: #94a3b8;
  font-size: 0.59rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes typing {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  30% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@media (max-width: 1180px) {
  .workbench {
    grid-template-columns: 290px minmax(0, 1fr);
  }
  .stats-strip {
    grid-template-columns: repeat(3, 1fr);
  }
  .context-stat {
    grid-column: span 2;
  }
  .conversation-content {
    grid-template-columns: minmax(0, 1fr);
  }
  .evidence-panel {
    min-height: auto;
    border-top: 1px solid var(--border);
    border-left: 0;
  }
}

@media (max-width: 900px) {
  .workbench {
    min-width: 760px;
  }
  .conversation-header {
    align-items: flex-start;
    padding-block: 0.65rem;
  }
}
</style>
