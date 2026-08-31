<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ExecutionStreamModal from "../components/tabs/ExecutionStreamModal.vue";
import PinnedTabModal from "../components/tabs/PinnedTabModal.vue";
import PinnedTabsSection from "../components/tabs/PinnedTabsSection.vue";
import RecordingPanel from "../components/tabs/RecordingPanel.vue";
import RunParametersModal from "../components/tabs/RunParametersModal.vue";
import TabCardsGrid from "../components/tabs/TabCardsGrid.vue";
import TabsControls from "../components/tabs/TabsControls.vue";
import TabsStatePanel from "../components/tabs/TabsStatePanel.vue";
import TabsStats from "../components/tabs/TabsStats.vue";
import TraceHistoryModal from "../components/tabs/TraceHistoryModal.vue";
import type {
  ActiveManualStep,
  BackgroundExecutionSnapshot,
  BrowserTab,
  ExecutionLogEntry,
  ExecutionStreamEvent,
  ManualExecutionMode,
  PinnedTab,
  PinnedTabForm,
  PinnedTabStatus,
  ScriptItem,
  ScriptParamField,
  ScriptParamValues,
  TraceFrame,
  TraceRunDetail,
  TraceRunSummary,
} from "../types/automation";
import type { SavedRecordingScript } from "../composables/useRecording";
import { parseJSDocParams } from "../utils/scriptParams";

type TabsState = "loading" | "error" | "empty" | null;

const tabs = ref<BrowserTab[]>([]);
const scripts = ref<ScriptItem[]>([]);
const selectedScriptPerTab = ref<Record<number, string>>({});
const isLoading = ref(true);
const error = ref<string | null>(null);
const searchQuery = ref("");
const autoRefresh = ref(false);
let refreshInterval: number | null = null;
const switchingIndex = ref<number | null>(null);

// Historical Trace Logs Modal State
const showHistoryLogModal = ref(false);
const historyLogTargetTitle = ref<string>("");
const historicalTraces = ref<TraceRunSummary[]>([]);
const selectedRunId = ref<string>("");
const selectedRunDetail = ref<TraceRunDetail | null>(null);
const isLoadingHistoryLogs = ref(false);
const historyModalActiveTab = ref<"logs" | "frames">("logs");
const activeFrameIdx = ref<number>(0);

// Unique distinct frame snapshots (deduplicate identical consecutive frameUrls)
const uniqueFrames = computed<TraceFrame[]>(() => {
  if (!selectedRunDetail.value?.frames || selectedRunDetail.value.frames.length === 0) {
    return [];
  }
  const result: TraceFrame[] = [];
  const seenUrls = new Set<string>();

  for (const frame of selectedRunDetail.value.frames) {
    if (frame.frameUrl && !seenUrls.has(frame.frameUrl)) {
      seenUrls.add(frame.frameUrl);
      result.push(frame);
    }
  }
  return result;
});

// Replay player state for history log modal
const isPlayingHistoryReplay = ref(false);
const historyReplaySpeed = ref<number>(1);
let historyReplayTimer: number | null = null;

const togglePlayHistoryReplay = () => {
  if (isPlayingHistoryReplay.value) {
    stopHistoryReplay();
  } else {
    startHistoryReplay();
  }
};

const startHistoryReplay = () => {
  if (!uniqueFrames.value.length) return;
  isPlayingHistoryReplay.value = true;
  if (historyReplayTimer) clearInterval(historyReplayTimer);

  historyReplayTimer = window.setInterval(
    () => {
      if (!uniqueFrames.value.length) {
        stopHistoryReplay();
        return;
      }
      if (activeFrameIdx.value >= uniqueFrames.value.length - 1) {
        activeFrameIdx.value = 0;
      } else {
        activeFrameIdx.value++;
      }
    },
    Math.max(200, 1000 / historyReplaySpeed.value),
  );
};

const stopHistoryReplay = () => {
  isPlayingHistoryReplay.value = false;
  if (historyReplayTimer) {
    clearInterval(historyReplayTimer);
    historyReplayTimer = null;
  }
};

const handleFrameImgError = (event: Event) => {
  const img = event.target as HTMLImageElement;
  img.src =
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="%230f172a"><rect width="600" height="400" fill="%230f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="16">📸 当前步骤网页快照不可用</text></svg>';
};

const openHistoryLogModal = async (target?: {
  title?: string;
  url?: string;
  scriptFilename?: string;
}) => {
  showHistoryLogModal.value = true;
  historyLogTargetTitle.value = target?.title || target?.url || "全量历史执行记录";
  isLoadingHistoryLogs.value = true;
  historicalTraces.value = [];
  selectedRunId.value = "";
  selectedRunDetail.value = null;

  try {
    const params = new URLSearchParams();
    let scriptName = target?.scriptFilename;

    // Fallback: look up pinned tabs if scriptFilename was not directly provided
    if (!scriptName && target?.url) {
      try {
        const targetHost = new URL(target.url).hostname;
        const match = pinnedTabs.value.find(
          (pinned) => pinned.url === target.url || (pinned.url && pinned.url.includes(targetHost)),
        );
        if (match?.scriptFilename) {
          scriptName = match.scriptFilename;
        }
      } catch {
        // Ignore URL parse error
      }
    }

    if (scriptName) {
      params.append("filename", scriptName);
    }
    if (target?.url) {
      params.append("url", target.url);
    }

    const queryString = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`http://localhost:3001/api/traces${queryString}`);
    if (res.ok) {
      const data = await res.json();
      historicalTraces.value = data.traces || [];
      if (historicalTraces.value.length > 0) {
        await loadHistoryRunDetail(historicalTraces.value[0].runId);
      }
    }
  } catch (err) {
    console.error("Fetch history logs error:", err);
  } finally {
    isLoadingHistoryLogs.value = false;
  }
};

const loadHistoryRunDetail = async (runId: string) => {
  selectedRunId.value = runId;
  activeFrameIdx.value = 0;
  try {
    const res = await fetch(`http://localhost:3001/api/traces/${runId}`);
    if (res.ok) {
      const data = await res.json();
      selectedRunDetail.value = data;
    }
  } catch (err) {
    console.error("Load history run detail error:", err);
  }
};

// Execution Modal State
interface PersistedBackgroundExecution {
  runId: string;
  tab: BrowserTab;
  scriptName: string;
  pinnedId?: string;
}

const BACKGROUND_EXECUTION_STORAGE_KEY = "crawlcbg.tabs.background-execution";
const executingTab = ref<BrowserTab | null>(null);
const executingScript = ref<string>("");
const activeExecutionMode = ref<ManualExecutionMode>("visible");
const isExecuting = ref(false);
const isExecutionModalVisible = ref(false);
const activeExecutionId = ref<string | null>(null);
const isExecutionStreamAccepted = ref(false);
const isCancellingExecution = ref(false);
const executionLogs = ref<ExecutionLogEntry[]>([]);
const traceFrames = ref<TraceFrame[]>([]);
const currentFrameIndex = ref<number>(0);
const activeManualStep = ref<ActiveManualStep | null>(null);
const tracePrivacyLocked = ref(false);
const isFocusingManualStep = ref(false);
let eventSource: EventSource | null = null;
let cancellationConfirmationTimer: number | null = null;
let executionStatusPollTimer: number | null = null;
let executionStatusPollAbortController: AbortController | null = null;
let executionStatusPollGeneration = 0;
let lastExecutionSequence = 0;

const hasActiveExecution = computed(() => activeExecutionId.value !== null || isExecuting.value);
const recordingTarget = ref<BrowserTab | null>(null);
const activeRecordingId = ref<string | null>(null);
const isRecordingActive = ref(false);
const hasActiveBrowserActivity = computed(
  () => hasActiveExecution.value || isRecordingActive.value,
);

const openRecordingPanel = (tab: BrowserTab) => {
  if (hasActiveExecution.value) return;
  if (recordingTarget.value) {
    if (recordingTarget.value.index === tab.index) {
      document.querySelector(".recording-panel")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
    return;
  }
  recordingTarget.value = { ...tab };
};

const handleRecordingActivityChange = (active: boolean, recordingId: string | null) => {
  isRecordingActive.value = active;
  activeRecordingId.value = recordingId;
};

const closeRecordingPanel = () => {
  if (isRecordingActive.value) return;
  recordingTarget.value = null;
  activeRecordingId.value = null;
};

const handleRecordingSaved = async (result: SavedRecordingScript) => {
  const targetIndex = recordingTarget.value?.index;
  await fetchScripts();
  if (targetIndex !== undefined) selectedScriptPerTab.value[targetIndex] = result.filename;
};

const currentFrame = computed(() => {
  if (tracePrivacyLocked.value) return null;
  if (!traceFrames.value || traceFrames.value.length === 0) return null;
  const idx = Math.min(Math.max(0, currentFrameIndex.value), traceFrames.value.length - 1);
  return traceFrames.value[idx] || traceFrames.value[0] || null;
});

const switchToTab = async (index: number) => {
  switchingIndex.value = index;
  try {
    const res = await fetch("http://localhost:3001/api/tabs/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    if (!res.ok) {
      throw new Error(`Failed to activate tab: ${res.statusText}`);
    }
  } catch (err) {
    console.error("Activate tab error:", err);
  } finally {
    switchingIndex.value = null;
  }
};

const fetchScripts = async () => {
  try {
    const res = await fetch("http://localhost:3001/api/scripts");
    if (res.ok) {
      const data = await res.json();
      scripts.value = data.scripts || [];
      if (scripts.value.length > 0) {
        tabs.value.forEach((tab) => {
          if (!selectedScriptPerTab.value[tab.index]) {
            selectedScriptPerTab.value[tab.index] = scripts.value[0].filename;
          }
        });
      }
    }
  } catch (err) {
    console.error("Fetch scripts error:", err);
  }
};

const fetchTabs = async () => {
  isLoading.value = true;
  error.value = null;
  try {
    const response = await fetch("http://localhost:3001/api/tabs");
    if (!response.ok) {
      throw new Error(`无法连接到后台 API: ${response.statusText} (${response.status})`);
    }
    const data = await response.json();
    tabs.value = Array.isArray(data) ? data : data.tabs || [];
    await fetchScripts();
  } catch (err: any) {
    error.value = err.message || "获取标签页列表失败，请检查 3001 端口后台服务是否启动";
  } finally {
    isLoading.value = false;
  }
};

const showParamModal = ref(false);
const paramFields = ref<ScriptParamField[]>([]);
const formValues = ref<ScriptParamValues>({});
const pendingRunTarget = ref<{
  runId: string;
  tab: BrowserTab;
  scriptName: string;
  pinnedId?: string;
} | null>(null);
const executingPinnedId = ref<string | null>(null);

const reserveExecution = (tab: BrowserTab, scriptName: string, pinnedId?: string) => {
  if (hasActiveBrowserActivity.value) return null;

  const runId = `run_${Date.now()}_${crypto.randomUUID()}`;
  activeExecutionId.value = runId;
  executingTab.value = tab;
  executingScript.value = scriptName;
  executingPinnedId.value = pinnedId || null;
  activeExecutionMode.value = "visible";
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  isExecutionModalVisible.value = false;
  activeManualStep.value = null;
  tracePrivacyLocked.value = false;
  isFocusingManualStep.value = false;
  return runId;
};

const releasePendingExecution = (runId: string) => {
  if (activeExecutionId.value !== runId) return;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  activeExecutionId.value = null;
  executingTab.value = null;
  executingScript.value = "";
  executingPinnedId.value = null;
  isExecuting.value = false;
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  isExecutionModalVisible.value = false;
  activeManualStep.value = null;
  tracePrivacyLocked.value = false;
  isFocusingManualStep.value = false;
  pendingRunTarget.value = null;
  showParamModal.value = false;
};

const cancelRunParameters = () => {
  const runId = pendingRunTarget.value?.runId;
  if (runId) releasePendingExecution(runId);
  else showParamModal.value = false;
};

const confirmAndRunFromModal = async (
  values: ScriptParamValues,
  executionMode: ManualExecutionMode,
) => {
  const pendingTarget = pendingRunTarget.value;
  if (!pendingTarget) return;
  const { runId, tab, scriptName, pinnedId } = pendingTarget;
  pendingRunTarget.value = null;
  showParamModal.value = false;

  try {
    let executionTab = tab;
    if (executionMode === "visible" && pinnedId) {
      const ensureRes = await fetch("http://localhost:3001/api/tabs/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: tab.url }),
      });
      if (!ensureRes.ok) {
        const data = await ensureRes.json().catch(() => ({}));
        throw new Error(data.error || "无法匹配或创建目标 Chrome 页签");
      }

      const ensureData = await ensureRes.json();
      await fetchTabs();
      if (activeExecutionId.value !== runId) return;
      executionTab = tabs.value.find((item) => item.index === ensureData.tabIndex) || {
        ...tab,
        index: ensureData.tabIndex,
      };
      selectedScriptPerTab.value[executionTab.index] = scriptName;
    }

    await executeScriptWithParams(executionTab, scriptName, values, runId, executionMode, pinnedId);
  } catch (error) {
    releasePendingExecution(runId);
    alert(`启动运行失败: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const isTabRunning = (tabIndex: number) => {
  return hasActiveExecution.value && executingTab.value?.index === tabIndex;
};

const isPinnedRunning = (pinned: PinnedTab) => {
  return hasActiveExecution.value && executingPinnedId.value === pinned.id;
};

const handleRunOrOpenTab = (tab: BrowserTab) => {
  if (isRecordingActive.value) return;
  if (hasActiveExecution.value) {
    if (isTabRunning(tab.index) && isExecuting.value) {
      isExecutionModalVisible.value = true;
    }
    return;
  }
  void runScriptOnTab(tab);
};

const handleRunOrOpenPinned = (pinned: PinnedTab) => {
  if (isRecordingActive.value) return;
  if (hasActiveExecution.value) {
    if (isPinnedRunning(pinned) && isExecuting.value) {
      isExecutionModalVisible.value = true;
    }
    return;
  }
  void launchPinnedTab(pinned);
};

const prepareReservedExecution = async (
  tab: BrowserTab,
  scriptName: string,
  runId: string,
  pinnedId?: string,
) => {
  if (activeExecutionId.value !== runId) return;

  executingTab.value = tab;
  executingScript.value = scriptName;
  executingPinnedId.value = pinnedId || null;

  const matchedScript = scripts.value.find((script) => script.filename === scriptName);
  const parsed = matchedScript?.content ? parseJSDocParams(matchedScript.content) : [];

  paramFields.value = parsed;
  const initialValues: ScriptParamValues = {};
  for (const field of parsed) {
    initialValues[field.name] = field.default;
  }
  formValues.value = initialValues;
  pendingRunTarget.value = { runId, tab, scriptName, pinnedId };
  showParamModal.value = true;
};

const runScriptOnTab = async (tab: BrowserTab) => {
  const scriptName = selectedScriptPerTab.value[tab.index] || scripts.value[0]?.filename;
  if (!scriptName) {
    alert("暂无可用脚本，请先在【脚本管理】页面创建或生成脚本！");
    return;
  }

  const runId = reserveExecution(tab, scriptName);
  if (!runId) return;
  await prepareReservedExecution(tab, scriptName, runId);
};

const stopExecutionStatusPolling = () => {
  executionStatusPollGeneration += 1;
  executionStatusPollAbortController?.abort();
  executionStatusPollAbortController = null;
  if (executionStatusPollTimer !== null) {
    window.clearTimeout(executionStatusPollTimer);
    executionStatusPollTimer = null;
  }
};

const persistBackgroundExecution = (execution: PersistedBackgroundExecution) => {
  const existingRaw = localStorage.getItem(BACKGROUND_EXECUTION_STORAGE_KEY);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as Partial<PersistedBackgroundExecution>;
      if (existing.runId && existing.runId !== execution.runId) {
        throw new Error(`已有后台任务 ${existing.runId} 正在运行，请先等待完成或取消。`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("已有后台任务")) throw error;
      localStorage.removeItem(BACKGROUND_EXECUTION_STORAGE_KEY);
    }
  }
  localStorage.setItem(BACKGROUND_EXECUTION_STORAGE_KEY, JSON.stringify(execution));
};

const clearPersistedBackgroundExecution = (runId: string) => {
  try {
    const raw = localStorage.getItem(BACKGROUND_EXECUTION_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<PersistedBackgroundExecution>;
    if (stored.runId === runId) localStorage.removeItem(BACKGROUND_EXECUTION_STORAGE_KEY);
  } catch {
    localStorage.removeItem(BACKGROUND_EXECUTION_STORAGE_KEY);
  }
};

const finishExecution = (runId: string, source: EventSource | null = eventSource) => {
  if (activeExecutionId.value !== runId) {
    source?.close();
    return;
  }
  if (cancellationConfirmationTimer !== null) {
    window.clearTimeout(cancellationConfirmationTimer);
    cancellationConfirmationTimer = null;
  }
  stopExecutionStatusPolling();
  source?.close();
  if (eventSource === source) eventSource = null;
  clearPersistedBackgroundExecution(runId);
  isExecuting.value = false;
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  activeManualStep.value = null;
  isFocusingManualStep.value = false;
  activeExecutionId.value = null;
  executingPinnedId.value = null;
  pendingRunTarget.value = null;
};

const applyExecutionEvent = (
  data: ExecutionStreamEvent,
  runId: string,
  source: EventSource | null = eventSource,
) => {
  if (activeExecutionId.value !== runId) return;
  if (typeof data.sequence === "number") {
    if (data.sequence <= lastExecutionSequence) return;
    lastExecutionSequence = data.sequence;
  }

  if (data.type === "accepted" || data.type === "started") {
    isExecutionStreamAccepted.value = true;
  }
  if (data.type === "manual-step-privacy-locked") {
    tracePrivacyLocked.value = true;
    traceFrames.value = [];
    currentFrameIndex.value = 0;
  }
  if (
    data.type === "manual-step-required" &&
    typeof data.stepId === "string" &&
    typeof data.title === "string" &&
    typeof data.targetCount === "number" &&
    data.targetCount > 0
  ) {
    activeManualStep.value = {
      stepId: data.stepId,
      title: data.title,
      targetCount: data.targetCount,
    };
    tracePrivacyLocked.value = true;
    traceFrames.value = [];
    currentFrameIndex.value = 0;
    isFocusingManualStep.value = false;
    // A required event is actionable even if the user previously hid the execution modal.
    isExecutionModalVisible.value = true;
  }
  if (
    data.type === "manual-step-resolved" &&
    typeof data.stepId === "string" &&
    activeManualStep.value?.stepId === data.stepId
  ) {
    activeManualStep.value = null;
    isFocusingManualStep.value = false;
  }
  if (
    data.type === "log" ||
    data.type === "done" ||
    data.type === "error" ||
    data.type === "cancelled"
  ) {
    executionLogs.value.push({
      type: data.type,
      time: data.time || new Date().toLocaleTimeString(),
      message: data.message || "",
    });
  }
  if (
    !tracePrivacyLocked.value &&
    data.type === "frame" &&
    typeof data.step === "number" &&
    data.time &&
    data.message &&
    data.frameUrl
  ) {
    traceFrames.value.push({
      step: data.step,
      time: data.time,
      message: data.message,
      frameUrl: data.frameUrl,
    });
    currentFrameIndex.value = traceFrames.value.length - 1;
  }
  if (data.type === "done" || data.type === "error" || data.type === "cancelled") {
    finishExecution(runId, source);
  }
};

const isCurrentBackgroundPoll = (runId: string, generation: number) =>
  generation === executionStatusPollGeneration &&
  activeExecutionId.value === runId &&
  activeExecutionMode.value === "background";

const refreshBackgroundExecution = async (
  runId: string,
  generation = executionStatusPollGeneration,
  signal?: AbortSignal,
) => {
  if (!isCurrentBackgroundPoll(runId, generation)) return;
  try {
    const response = await fetch(
      `http://localhost:3001/api/scripts/executions/${encodeURIComponent(
        runId,
      )}?afterSequence=${lastExecutionSequence}`,
      { cache: "no-store", signal },
    );
    if (!isCurrentBackgroundPoll(runId, generation)) return;
    if (!response.ok) {
      if (response.status === 404) {
        executionLogs.value.push({
          type: "error",
          time: new Date().toLocaleTimeString(),
          message: "后台运行记录不存在或服务已重启，无法继续跟踪本次任务。",
        });
        finishExecution(runId, null);
      }
      return;
    }

    const payload = (await response.json()) as { execution: BackgroundExecutionSnapshot };
    if (!isCurrentBackgroundPoll(runId, generation)) return;
    const snapshot = payload.execution;
    for (const stored of snapshot.events) {
      if (!isCurrentBackgroundPoll(runId, generation)) return;
      applyExecutionEvent(stored.event, runId, null);
      if (!isCurrentBackgroundPoll(runId, generation)) return;
    }

    if (!isCurrentBackgroundPoll(runId, generation)) return;
    isExecutionStreamAccepted.value = true;
    isExecuting.value = snapshot.status === "starting" || snapshot.status === "running";
    if (!isExecuting.value) finishExecution(runId, null);
  } catch (error) {
    if (
      signal?.aborted ||
      !isCurrentBackgroundPoll(runId, generation) ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      return;
    }
    console.error("Refresh background execution error:", error);
  }
};

const startExecutionStatusPolling = (runId: string) => {
  stopExecutionStatusPolling();
  const generation = executionStatusPollGeneration;

  const poll = async () => {
    if (!isCurrentBackgroundPoll(runId, generation)) return;
    const controller = new AbortController();
    executionStatusPollAbortController = controller;
    try {
      await refreshBackgroundExecution(runId, generation, controller.signal);
    } finally {
      if (executionStatusPollAbortController === controller) {
        executionStatusPollAbortController = null;
      }
      if (isCurrentBackgroundPoll(runId, generation) && isExecuting.value) {
        executionStatusPollTimer = window.setTimeout(() => {
          executionStatusPollTimer = null;
          void poll();
        }, 1_000);
      }
    }
  };

  void poll();
};

const restoreBackgroundExecution = () => {
  let stored: PersistedBackgroundExecution | null = null;
  try {
    const raw = localStorage.getItem(BACKGROUND_EXECUTION_STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as PersistedBackgroundExecution;
  } catch {
    localStorage.removeItem(BACKGROUND_EXECUTION_STORAGE_KEY);
  }
  if (!stored?.runId || !stored.tab?.url || !stored.scriptName) return;

  activeExecutionId.value = stored.runId;
  activeExecutionMode.value = "background";
  executingTab.value = stored.tab;
  executingScript.value = stored.scriptName;
  executingPinnedId.value = stored.pinnedId || null;
  isExecuting.value = true;
  isExecutionStreamAccepted.value = false;
  isExecutionModalVisible.value = true;
  executionLogs.value = [];
  traceFrames.value = [];
  currentFrameIndex.value = 0;
  activeManualStep.value = null;
  tracePrivacyLocked.value = false;
  isFocusingManualStep.value = false;
  lastExecutionSequence = 0;

  startExecutionStatusPolling(stored.runId);
};

const executeScriptWithParams = async (
  tab: BrowserTab,
  scriptName: string,
  scriptParams: ScriptParamValues,
  runId: string,
  executionMode: ManualExecutionMode,
  pinnedId?: string,
) => {
  if (executionMode === "visible") await switchToTab(tab.index);
  if (activeExecutionId.value !== runId) return;

  const displayTab = tab;
  executingTab.value = displayTab;
  executingScript.value = scriptName;
  executingPinnedId.value = pinnedId || null;
  activeExecutionMode.value = executionMode;
  isExecuting.value = true;
  isExecutionModalVisible.value = true;
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  executionLogs.value = [];
  traceFrames.value = [];
  currentFrameIndex.value = 0;
  activeManualStep.value = null;
  tracePrivacyLocked.value = false;
  isFocusingManualStep.value = false;
  lastExecutionSequence = 0;
  stopExecutionStatusPolling();

  if (executionMode === "background") {
    persistBackgroundExecution({ runId, tab: displayTab, scriptName, pinnedId });
  }

  executionLogs.value.push({
    type: "log",
    time: new Date().toLocaleTimeString(),
    message:
      executionMode === "background"
        ? `🔌 正在为 “${tab.title || tab.url}” 创建独立最小化 Chrome 窗口并运行脚本 [${scriptName}]...`
        : `🔌 开始在 Tab #${tab.index + 1} ("${tab.title || tab.url}") 上运行脚本 [${scriptName}]...`,
  });

  const paramsParam =
    Object.keys(scriptParams).length > 0
      ? `&params=${encodeURIComponent(JSON.stringify(scriptParams))}`
      : "";
  const targetUrlParam = tab.url ? `&targetUrl=${encodeURIComponent(tab.url)}` : "";
  const url = `http://localhost:3001/api/scripts/execute/stream?filename=${encodeURIComponent(
    scriptName,
  )}&tabIndex=${tab.index}&runId=${encodeURIComponent(runId)}&executionMode=${executionMode}${targetUrlParam}${paramsParam}`;

  if (eventSource) eventSource.close();
  const source = new EventSource(url);
  eventSource = source;
  const isCurrentExecution = () => activeExecutionId.value === runId && eventSource === source;

  source.onopen = () => {
    if (!isCurrentExecution()) return;
    executionLogs.value.push({
      type: "log",
      time: new Date().toLocaleTimeString(),
      message: "✅ 已连接实时执行日志与画面流。",
    });
  };

  source.onmessage = (event) => {
    if (!isCurrentExecution()) return;
    try {
      applyExecutionEvent(JSON.parse(event.data) as ExecutionStreamEvent, runId, source);
    } catch (error) {
      console.error("Parse SSE data error:", error);
    }
  };

  source.onerror = () => {
    if (!isCurrentExecution() || !isExecuting.value) return;
    source.close();
    if (eventSource === source) eventSource = null;

    if (executionMode === "background") {
      executionLogs.value.push({
        type: "log",
        time: new Date().toLocaleTimeString(),
        message: "实时连接已断开，后台任务会继续运行，正在切换为状态轮询。",
      });
      startExecutionStatusPolling(runId);
      return;
    }

    executionLogs.value.push({
      type: "error",
      time: new Date().toLocaleTimeString(),
      message: isCancellingExecution.value
        ? "❌ 中止确认前实时连接已断开，无法确认服务端退出状态。"
        : "❌ 实时执行连接已断开，无法继续接收执行日志和画面帧。请确认 3001 后台服务在线。",
    });
    finishExecution(runId, source);
  };
};

const focusActiveManualStep = async () => {
  const runId = activeExecutionId.value;
  const step = activeManualStep.value;
  if (!runId || !step || isFocusingManualStep.value) return;

  isFocusingManualStep.value = true;
  try {
    const response = await fetch(
      `http://localhost:3001/api/scripts/execute/${encodeURIComponent(
        runId,
      )}/manual-step/${encodeURIComponent(step.stepId)}/focus`,
      { method: "POST", cache: "no-store" },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || `服务端返回 ${response.status}`);
    }
  } catch (error) {
    if (activeExecutionId.value === runId && activeManualStep.value?.stepId === step.stepId) {
      executionLogs.value.push({
        type: "error",
        time: new Date().toLocaleTimeString(),
        message: `无法聚焦人工操作页面：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } finally {
    if (activeManualStep.value?.stepId === step.stepId) isFocusingManualStep.value = false;
  }
};

const cancelExecution = async () => {
  const runId = activeExecutionId.value;
  if (
    !runId ||
    !isExecuting.value ||
    !isExecutionStreamAccepted.value ||
    isCancellingExecution.value
  ) {
    return;
  }

  isCancellingExecution.value = true;
  executionLogs.value.push({
    type: "log",
    time: new Date().toLocaleTimeString(),
    message: "🛑 正在中止本次运行...",
  });

  try {
    const response = await fetch(
      `http://localhost:3001/api/scripts/execute/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(`服务端返回 ${response.status}`);
    }
    if (!isExecuting.value || activeExecutionId.value !== runId) return;

    executionLogs.value.push({
      type: "log",
      time: new Date().toLocaleTimeString(),
      message: "⏳ 服务端已收到中止信号，正在等待脚本安全退出...",
    });
    cancellationConfirmationTimer = window.setTimeout(() => {
      if (isExecuting.value && activeExecutionId.value === runId) {
        isCancellingExecution.value = false;
        executionLogs.value.push({
          type: "error",
          time: new Date().toLocaleTimeString(),
          message: "❌ 中止确认超时：脚本尚未确认退出，请检查脚本是否包含不可中断的同步循环。",
        });
      }
      cancellationConfirmationTimer = null;
    }, 15_000);
  } catch (error) {
    if (!isExecuting.value || activeExecutionId.value !== runId) return;
    isCancellingExecution.value = false;
    executionLogs.value.push({
      type: "error",
      time: new Date().toLocaleTimeString(),
      message: `❌ 中止失败，任务仍在运行：${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

const closeExecutionModal = () => {
  isExecutionModalVisible.value = false;
};

// Filter tabs by search query
const filteredTabs = computed(() => {
  if (!searchQuery.value.trim()) return tabs.value;
  const query = searchQuery.value.toLowerCase();
  return tabs.value.filter(
    (tab) => tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query),
  );
});

// Compute unique domains count
const uniqueDomainsCount = computed(() => {
  const domains = new Set<string>();
  tabs.value.forEach((tab) => {
    try {
      if (tab.url) {
        domains.add(new URL(tab.url).hostname);
      }
    } catch {
      // ignore invalid URLs
    }
  });
  return domains.size;
});

const toggleAutoRefresh = () => {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    refreshInterval = window.setInterval(fetchTabs, 5000);
  } else if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
};

const getDomainName = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

// Custom Script Picker State
const openScriptPickerTab = ref<number | null>(null);

// Pinned Resident Tab Presets State
const pinnedTabs = ref<PinnedTab[]>([]);
const showPinnedModal = ref(false);
const pinnedForm = ref<PinnedTabForm>({
  id: "",
  title: "",
  url: "",
  scriptFilename: "",
});

const fetchPinnedTabs = async () => {
  try {
    const res = await fetch("http://localhost:3001/api/tabs/pinned");
    if (res.ok) {
      const data = await res.json();
      pinnedTabs.value = data.pinnedTabs || [];
    }
  } catch (err) {
    console.error("Fetch pinned tabs error:", err);
  }
};

const getPinnedTabStatus = (pinned: PinnedTab): PinnedTabStatus => {
  if (!tabs.value || tabs.value.length === 0) {
    return { type: "closed", text: "⚪ 未打开 (点击将自动创建页签并载入)", index: -1 };
  }

  const exactTab = tabs.value.find((tab) => tab.url === pinned.url);
  if (exactTab) {
    return {
      type: "exact",
      text: `🟢 已在 Chrome 打开 (Tab #${exactTab.index + 1} · URL 完全一致)`,
      index: exactTab.index,
    };
  }

  try {
    const targetDomain = new URL(pinned.url).hostname;
    const domainTab = tabs.value.find((tab) => tab.url && tab.url.includes(targetDomain));
    if (domainTab) {
      return {
        type: "domain",
        text: `🟡 域名已打开 (Tab #${domainTab.index + 1} · 点击将自动校准导航至预设 URL)`,
        index: domainTab.index,
      };
    }
  } catch {
    // ignore
  }

  return { type: "closed", text: "⚪ 未打开 (点击将自动创建页签并载入)", index: -1 };
};

const savePinnedTab = async () => {
  if (!pinnedForm.value.title.trim() || !pinnedForm.value.url.trim()) {
    alert("请填写预设标题和目标 URL！");
    return;
  }

  try {
    const res = await fetch("http://localhost:3001/api/tabs/pinned", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: pinnedForm.value.title.trim(),
        url: pinnedForm.value.url.trim(),
        scriptFilename: pinnedForm.value.scriptFilename || "",
      }),
    });

    if (res.ok) {
      await fetchPinnedTabs();
      showPinnedModal.value = false;
      pinnedForm.value = { id: "", title: "", url: "", scriptFilename: "" };
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "保存常驻预设失败");
    }
  } catch (err: any) {
    alert(`保存常驻预设失败: ${err.message}`);
  }
};

const pinLiveTab = (tab: BrowserTab) => {
  pinnedForm.value = {
    id: "",
    title: tab.title || getDomainName(tab.url),
    url: tab.url,
    scriptFilename: selectedScriptPerTab.value[tab.index] || scripts.value[0]?.filename || "",
  };
  showPinnedModal.value = true;
};

const deletePinnedTab = async (id: string) => {
  if (!confirm("确认要移除此常驻预设吗？")) return;
  try {
    const res = await fetch("http://localhost:3001/api/tabs/pinned/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      await fetchPinnedTabs();
    }
  } catch (err: any) {
    alert(`删除预设失败: ${err.message}`);
  }
};

const launchPinnedTab = async (pinned: PinnedTab) => {
  const scriptName = pinned.scriptFilename || scripts.value[0]?.filename;
  if (!scriptName) {
    alert("暂无可用脚本，请先在【脚本管理】页面创建脚本或为常驻配置关联脚本！");
    return;
  }

  const provisionalTab: BrowserTab = {
    index: -1,
    title: pinned.title,
    url: pinned.url,
    favicon: "",
  };
  const runId = reserveExecution(provisionalTab, scriptName, pinned.id);
  if (!runId) return;
  await prepareReservedExecution(provisionalTab, scriptName, runId, pinned.id);
};

const toggleScriptPicker = (tabIndex: number) => {
  if (openScriptPickerTab.value === tabIndex) {
    openScriptPickerTab.value = null;
  } else {
    openScriptPickerTab.value = tabIndex;
  }
};

const selectScriptForTab = (tabIndex: number, filename: string) => {
  selectedScriptPerTab.value[tabIndex] = filename;
  openScriptPickerTab.value = null;
};

const handleDocumentClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement;
  if (!target.closest(".custom-script-picker")) {
    openScriptPickerTab.value = null;
  }
};

const tabsState = computed<TabsState>(() => {
  if (isLoading.value && tabs.value.length === 0) return "loading";
  if (error.value) return "error";
  if (filteredTabs.value.length === 0) return "empty";
  return null;
});

const runningTabIndex = computed(() => {
  return hasActiveExecution.value ? (executingTab.value?.index ?? null) : null;
});

const pinnedTabStatuses = computed<Record<string, PinnedTabStatus>>(() => {
  const statuses: Record<string, PinnedTabStatus> = {};
  for (const pinned of pinnedTabs.value) {
    statuses[pinned.id] = getPinnedTabStatus(pinned);
  }
  return statuses;
});

const pinnedTabRunningStates = computed<Record<string, boolean>>(() => {
  const runningStates: Record<string, boolean> = {};
  for (const pinned of pinnedTabs.value) {
    runningStates[pinned.id] = isPinnedRunning(pinned);
  }
  return runningStates;
});

onMounted(() => {
  fetchTabs();
  fetchPinnedTabs();
  void restoreBackgroundExecution();
  document.addEventListener("click", handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener("click", handleDocumentClick);
  eventSource?.close();
  eventSource = null;
  stopExecutionStatusPolling();
  if (cancellationConfirmationTimer !== null) {
    window.clearTimeout(cancellationConfirmationTimer);
    cancellationConfirmationTimer = null;
  }
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div class="tabs-page">
    <TabsStats :tab-count="tabs.length" :unique-domain-count="uniqueDomainsCount" />

    <PinnedTabsSection
      v-if="pinnedTabs.length > 0"
      :pinned-tabs="pinnedTabs"
      :statuses="pinnedTabStatuses"
      :running-states="pinnedTabRunningStates"
      :has-active-execution="hasActiveBrowserActivity"
      @create-pinned="showPinnedModal = true"
      @toggle-run="handleRunOrOpenPinned"
      @open-history="openHistoryLogModal"
      @delete-pinned="deletePinnedTab"
    />

    <TabsControls
      :search-query="searchQuery"
      :auto-refresh="autoRefresh"
      :is-loading="isLoading"
      @update:search-query="searchQuery = $event"
      @create-pinned="showPinnedModal = true"
      @toggle-auto-refresh="toggleAutoRefresh"
      @refresh="fetchTabs"
    />

    <RecordingPanel
      v-if="recordingTarget"
      :tab="recordingTarget"
      :execution-active="hasActiveExecution"
      @active-change="handleRecordingActivityChange"
      @saved="handleRecordingSaved"
      @close="closeRecordingPanel"
    />

    <TabsStatePanel
      v-if="tabsState"
      :state="tabsState"
      :error="error"
      :search-query="searchQuery"
      @retry="fetchTabs"
    />

    <TabCardsGrid
      v-else
      :tabs="filteredTabs"
      :scripts="scripts"
      :selected-scripts="selectedScriptPerTab"
      :open-script-picker-tab="openScriptPickerTab"
      :switching-index="switchingIndex"
      :running-tab-index="runningTabIndex"
      :has-active-execution="hasActiveExecution"
      :recording-tab-index="recordingTarget?.index ?? null"
      :is-recording-active="isRecordingActive"
      @pin-tab="pinLiveTab"
      @open-recording="openRecordingPanel"
      @toggle-script-picker="toggleScriptPicker"
      @select-script="selectScriptForTab"
      @toggle-run="handleRunOrOpenTab"
      @open-history="openHistoryLogModal"
      @activate="switchToTab"
    />

    <RunParametersModal
      v-if="showParamModal"
      :fields="paramFields"
      :target-tab-index="pendingRunTarget?.tab.index ?? 0"
      :target-label="pendingRunTarget?.tab.title || pendingRunTarget?.tab.url || ''"
      :script-name="pendingRunTarget?.scriptName || ''"
      :form-values="formValues"
      @update:form-values="formValues = $event"
      @cancel="cancelRunParameters"
      @confirm="confirmAndRunFromModal"
    />

    <ExecutionStreamModal
      v-if="isExecutionModalVisible && executingTab"
      :tab="executingTab"
      :script-name="executingScript"
      :execution-mode="activeExecutionMode"
      :is-executing="isExecuting"
      :can-cancel="isExecutionStreamAccepted"
      :is-cancelling="isCancellingExecution"
      :logs="executionLogs"
      :current-frame="currentFrame"
      :active-manual-step="activeManualStep"
      :trace-privacy-locked="tracePrivacyLocked"
      :is-focusing-manual-step="isFocusingManualStep"
      @focus-manual-step="focusActiveManualStep"
      @stop="cancelExecution"
      @close="closeExecutionModal"
    />

    <PinnedTabModal
      v-if="showPinnedModal"
      :form="pinnedForm"
      :scripts="scripts"
      @update:form="pinnedForm = $event"
      @cancel="showPinnedModal = false"
      @save="savePinnedTab"
    />

    <TraceHistoryModal
      v-if="showHistoryLogModal"
      :target-title="historyLogTargetTitle"
      :runs="historicalTraces"
      :selected-run-id="selectedRunId"
      :selected-run="selectedRunDetail"
      :is-loading="isLoadingHistoryLogs"
      :active-tab="historyModalActiveTab"
      :frames="uniqueFrames"
      :active-frame-index="activeFrameIdx"
      :is-playing="isPlayingHistoryReplay"
      :replay-speed="historyReplaySpeed"
      @close="showHistoryLogModal = false"
      @load-run="loadHistoryRunDetail"
      @toggle-play="togglePlayHistoryReplay"
      @start-replay="startHistoryReplay"
      @update-active-tab="historyModalActiveTab = $event"
      @update-frame-index="activeFrameIdx = $event"
      @update-replay-speed="historyReplaySpeed = $event"
      @image-error="handleFrameImgError"
    />
  </div>
</template>

<style scoped>
.tabs-page {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
</style>
