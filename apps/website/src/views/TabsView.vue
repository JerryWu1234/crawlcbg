<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ExecutionStreamModal from "../components/tabs/ExecutionStreamModal.vue";
import PinnedTabModal from "../components/tabs/PinnedTabModal.vue";
import PinnedTabsSection from "../components/tabs/PinnedTabsSection.vue";
import RunParametersModal from "../components/tabs/RunParametersModal.vue";
import ScheduleEditorModal from "../components/tabs/ScheduleEditorModal.vue";
import TabCardsGrid from "../components/tabs/TabCardsGrid.vue";
import TabsControls from "../components/tabs/TabsControls.vue";
import TabsStatePanel from "../components/tabs/TabsStatePanel.vue";
import TabsStats from "../components/tabs/TabsStats.vue";
import TraceHistoryModal from "../components/tabs/TraceHistoryModal.vue";
import type {
  BrowserTab,
  ExecutionLogEntry,
  PinnedTab,
  PinnedTabForm,
  PinnedTabStatus,
  ScriptItem,
  ScriptParamField,
  ScriptParamValues,
  TabSchedule,
  TabScheduleInput,
  TraceFrame,
  TraceRunDetail,
  TraceRunSummary,
} from "../types/automation";
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

// Persisted tab schedules are polled independently from optional tab auto-refresh.
const schedules = ref<TabSchedule[]>([]);
const scheduleEditorTab = ref<BrowserTab | null>(null);
const isSavingSchedule = ref(false);
let scheduleRefreshInterval: number | null = null;
let latestScheduleRequestId = 0;

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
const executingTab = ref<BrowserTab | null>(null);
const executingScript = ref<string>("");
const isExecuting = ref(false);
const isExecutionModalVisible = ref(false);
const activeExecutionId = ref<string | null>(null);
const isExecutionStreamAccepted = ref(false);
const isCancellingExecution = ref(false);
const executionLogs = ref<ExecutionLogEntry[]>([]);
const traceFrames = ref<TraceFrame[]>([]);
const currentFrameIndex = ref<number>(0);
let eventSource: EventSource | null = null;
let cancellationConfirmationTimer: number | null = null;

const hasActiveExecution = computed(() => activeExecutionId.value !== null || isExecuting.value);

const currentFrame = computed(() => {
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

const fetchSchedules = async () => {
  const requestId = ++latestScheduleRequestId;
  try {
    const response = await fetch("http://localhost:3001/api/schedules");
    if (!response.ok) throw new Error(`获取循环计划失败 (${response.status})`);
    const data = await response.json();
    if (requestId === latestScheduleRequestId) {
      schedules.value = Array.isArray(data.schedules) ? data.schedules : [];
    }
  } catch (err) {
    if (requestId === latestScheduleRequestId) {
      console.error("Fetch schedules error:", err);
    }
  }
};

const schedulesByUrl = computed<Record<string, TabSchedule>>(() => {
  const result: Record<string, TabSchedule> = {};
  for (const schedule of schedules.value) result[schedule.targetUrl] = schedule;
  return result;
});

const activeSchedule = computed<TabSchedule | null>(() => {
  const targetUrl = scheduleEditorTab.value?.url;
  return targetUrl ? schedulesByUrl.value[targetUrl] || null : null;
});

const detachedSchedules = computed(() =>
  schedules.value.filter((schedule) => !tabs.value.some((tab) => tab.url === schedule.targetUrl)),
);

const openDetachedSchedule = (schedule: TabSchedule) => {
  scheduleEditorTab.value = {
    index: -1,
    title: schedule.targetTitle,
    url: schedule.targetUrl,
    favicon: "",
  };
};

const formatScheduleTime = (schedule: TabSchedule) => {
  if (!schedule.enabled) return "已暂停";
  if (schedule.status === "running") return "正在执行";
  if (!schedule.nextRunAt) return "等待计算";
  return `下次 ${new Date(schedule.nextRunAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

const openScheduleEditor = (tab: BrowserTab) => {
  scheduleEditorTab.value = tab;
};

const saveSchedule = async (input: TabScheduleInput) => {
  const existing = input.id
    ? schedules.value.find((schedule) => schedule.id === input.id)
    : schedulesByUrl.value[input.targetUrl];
  isSavingSchedule.value = true;
  try {
    const response = await fetch(
      existing
        ? `http://localhost:3001/api/schedules/${encodeURIComponent(existing.id)}`
        : "http://localhost:3001/api/schedules",
      {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "保存循环计划失败");

    if (scheduleEditorTab.value && scheduleEditorTab.value.index >= 0) {
      selectedScriptPerTab.value[scheduleEditorTab.value.index] = input.scriptFilename;
    }
    await fetchSchedules();
    scheduleEditorTab.value = null;
  } catch (err) {
    alert(err instanceof Error ? err.message : "保存循环计划失败");
  } finally {
    isSavingSchedule.value = false;
  }
};

const deleteSchedule = async (schedule: TabSchedule) => {
  if (!confirm("确认删除这个循环计划吗？")) return;
  isSavingSchedule.value = true;
  try {
    const response = await fetch(
      `http://localhost:3001/api/schedules/${encodeURIComponent(schedule.id)}`,
      { method: "DELETE" },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "删除循环计划失败");
    await fetchSchedules();
    scheduleEditorTab.value = null;
  } catch (err) {
    alert(err instanceof Error ? err.message : "删除循环计划失败");
  } finally {
    isSavingSchedule.value = false;
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
  if (hasActiveExecution.value) return null;

  const runId = `run_${Date.now()}_${crypto.randomUUID()}`;
  activeExecutionId.value = runId;
  executingTab.value = tab;
  executingScript.value = scriptName;
  executingPinnedId.value = pinnedId || null;
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  isExecutionModalVisible.value = false;
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
  pendingRunTarget.value = null;
  showParamModal.value = false;
};

const cancelRunParameters = () => {
  const runId = pendingRunTarget.value?.runId;
  if (runId) releasePendingExecution(runId);
  else showParamModal.value = false;
};

const confirmAndRunFromModal = async (values: ScriptParamValues) => {
  const pendingTarget = pendingRunTarget.value;
  if (!pendingTarget) return;
  const { runId, tab, scriptName, pinnedId } = pendingTarget;
  pendingRunTarget.value = null;
  showParamModal.value = false;
  await executeScriptWithParams(tab, scriptName, values, runId, pinnedId);
};

const isTabRunning = (tabIndex: number) => {
  return hasActiveExecution.value && executingTab.value?.index === tabIndex;
};

const isPinnedRunning = (pinned: PinnedTab) => {
  return hasActiveExecution.value && executingPinnedId.value === pinned.id;
};

const handleRunOrOpenTab = (tab: BrowserTab) => {
  if (schedulesByUrl.value[tab.url]?.status === "running") return;
  if (hasActiveExecution.value) {
    if (isTabRunning(tab.index) && isExecuting.value) {
      isExecutionModalVisible.value = true;
    }
    return;
  }
  void runScriptOnTab(tab);
};

const handleRunOrOpenPinned = (pinned: PinnedTab) => {
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

  if (parsed.length > 0) {
    paramFields.value = parsed;
    const initialValues: ScriptParamValues = {};
    for (const field of parsed) {
      initialValues[field.name] = field.default;
    }
    formValues.value = initialValues;
    pendingRunTarget.value = { runId, tab, scriptName, pinnedId };
    showParamModal.value = true;
    return;
  }

  await executeScriptWithParams(tab, scriptName, {}, runId, pinnedId);
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

const executeScriptWithParams = async (
  tab: BrowserTab,
  scriptName: string,
  scriptParams: ScriptParamValues,
  runId: string,
  pinnedId?: string,
) => {
  await switchToTab(tab.index);
  if (activeExecutionId.value !== runId) return;

  executingTab.value = tab;
  executingScript.value = scriptName;
  executingPinnedId.value = pinnedId || null;
  isExecuting.value = true;
  isExecutionModalVisible.value = true;
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  executionLogs.value = [];
  traceFrames.value = [];
  currentFrameIndex.value = 0;

  executionLogs.value.push({
    type: "log",
    time: new Date().toLocaleTimeString(),
    message: `🔌 开始在 Tab #${tab.index + 1} ("${tab.title || tab.url}") 上运行脚本 [${scriptName}]...`,
  });

  const paramsParam =
    Object.keys(scriptParams).length > 0
      ? `&params=${encodeURIComponent(JSON.stringify(scriptParams))}`
      : "";

  const targetUrlParam = tab.url ? `&targetUrl=${encodeURIComponent(tab.url)}` : "";
  const url = `http://localhost:3001/api/scripts/execute/stream?filename=${encodeURIComponent(
    scriptName,
  )}&tabIndex=${tab.index}&runId=${encodeURIComponent(runId)}${targetUrlParam}${paramsParam}`;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

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
      const data = JSON.parse(event.data);
      if (data.type === "accepted") {
        isExecutionStreamAccepted.value = true;
        return;
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
      if (data.type === "frame") {
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
    } catch (e) {
      console.error("Parse SSE data error:", e);
    }
  };

  source.onerror = () => {
    if (!isCurrentExecution() || !isExecuting.value) return;
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

const finishExecution = (runId: string, source: EventSource | null = eventSource) => {
  if (activeExecutionId.value !== runId) {
    source?.close();
    return;
  }
  if (cancellationConfirmationTimer !== null) {
    window.clearTimeout(cancellationConfirmationTimer);
    cancellationConfirmationTimer = null;
  }
  source?.close();
  if (eventSource === source) {
    eventSource = null;
  }
  isExecuting.value = false;
  isExecutionStreamAccepted.value = false;
  isCancellingExecution.value = false;
  activeExecutionId.value = null;
  executingPinnedId.value = null;
  pendingRunTarget.value = null;
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

  try {
    const ensureRes = await fetch("http://localhost:3001/api/tabs/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: pinned.url }),
    });

    if (!ensureRes.ok) {
      const data = await ensureRes.json().catch(() => ({}));
      throw new Error(data.error || "无法匹配或创建目标 Chrome 页签");
    }

    const ensureData = await ensureRes.json();
    const tabIndex = ensureData.tabIndex;

    await fetchTabs();
    if (activeExecutionId.value !== runId) return;

    const targetTab = tabs.value.find((tab) => tab.index === tabIndex) || {
      index: tabIndex,
      title: pinned.title,
      url: pinned.url,
      favicon: "",
    };

    selectedScriptPerTab.value[tabIndex] = scriptName;
    await prepareReservedExecution(targetTab, scriptName, runId, pinned.id);
  } catch (err: any) {
    releasePendingExecution(runId);
    alert(`常驻预设起航失败: ${err.message}`);
  }
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
  fetchSchedules();
  scheduleRefreshInterval = window.setInterval(fetchSchedules, 5000);
  document.addEventListener("click", handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener("click", handleDocumentClick);
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (scheduleRefreshInterval) {
    clearInterval(scheduleRefreshInterval);
    scheduleRefreshInterval = null;
  }
});
</script>

<template>
  <div class="tabs-page">
    <TabsStats :tab-count="tabs.length" :unique-domain-count="uniqueDomainsCount" />

    <section v-if="detachedSchedules.length" class="detached-schedules">
      <div class="detached-header">
        <div>
          <h3>🔁 持久循环计划</h3>
          <p>这些目标标签页当前未打开；到期后系统会按原 URL 自动新开并执行。</p>
        </div>
        <span>{{ detachedSchedules.length }} 个</span>
      </div>
      <div class="detached-list">
        <article
          v-for="schedule in detachedSchedules"
          :key="schedule.id"
          class="detached-item"
          :class="{ running: schedule.status === 'running', error: schedule.status === 'error' }"
        >
          <div class="detached-copy">
            <strong>{{ schedule.targetTitle || schedule.targetUrl }}</strong>
            <code :title="schedule.targetUrl">{{ schedule.targetUrl }}</code>
            <small>{{ schedule.scriptFilename }}</small>
          </div>
          <span class="detached-status" :title="schedule.lastError || ''">
            {{ formatScheduleTime(schedule) }}
          </span>
          <button @click="openDetachedSchedule(schedule)">查看配置</button>
        </article>
      </div>
    </section>

    <PinnedTabsSection
      v-if="pinnedTabs.length > 0"
      :pinned-tabs="pinnedTabs"
      :statuses="pinnedTabStatuses"
      :running-states="pinnedTabRunningStates"
      :has-active-execution="hasActiveExecution"
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
      :schedules-by-url="schedulesByUrl"
      :open-script-picker-tab="openScriptPickerTab"
      :switching-index="switchingIndex"
      :running-tab-index="runningTabIndex"
      :has-active-execution="hasActiveExecution"
      @pin-tab="pinLiveTab"
      @toggle-script-picker="toggleScriptPicker"
      @select-script="selectScriptForTab"
      @toggle-run="handleRunOrOpenTab"
      @open-history="openHistoryLogModal"
      @open-schedule="openScheduleEditor"
      @activate="switchToTab"
    />

    <ScheduleEditorModal
      v-if="scheduleEditorTab"
      :tab="scheduleEditorTab"
      :schedule="activeSchedule"
      :scripts="scripts"
      :default-script="selectedScriptPerTab[scheduleEditorTab.index] || scripts[0]?.filename || ''"
      :saving="isSavingSchedule"
      @cancel="scheduleEditorTab = null"
      @save="saveSchedule"
      @delete="deleteSchedule"
    />

    <RunParametersModal
      v-if="showParamModal"
      :fields="paramFields"
      :target-tab-index="pendingRunTarget?.tab.index ?? 0"
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
      :is-executing="isExecuting"
      :can-cancel="isExecutionStreamAccepted"
      :is-cancelling="isCancellingExecution"
      :logs="executionLogs"
      :current-frame="currentFrame"
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

.detached-schedules {
  padding: 1rem;
  border: 1px solid #c4b5fd;
  border-radius: 12px;
  background: linear-gradient(135deg, #faf5ff, #f5f3ff);
}

.detached-header,
.detached-item {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.detached-header {
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.detached-header h3 {
  margin: 0;
  color: #5b21b6;
  font-size: 0.95rem;
}

.detached-header p {
  margin: 0.2rem 0 0;
  color: #64748b;
  font-size: 0.75rem;
}

.detached-header > span {
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  color: #6d28d9;
  background: #ede9fe;
  font-size: 0.72rem;
  font-weight: 700;
}

.detached-list {
  display: grid;
  gap: 0.55rem;
}

.detached-item {
  padding: 0.7rem 0.8rem;
  border: 1px solid #ddd6fe;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.88);
}

.detached-item.running {
  border-color: #93c5fd;
  background: #eff6ff;
}

.detached-item.error {
  border-color: #fecaca;
}

.detached-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.detached-copy strong {
  color: #1e293b;
  font-size: 0.8rem;
}

.detached-copy code,
.detached-copy small {
  overflow: hidden;
  color: #64748b;
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detached-status {
  flex: 0 0 auto;
  color: #475569;
  font-size: 0.72rem;
  font-weight: 650;
}

.detached-item button {
  flex: 0 0 auto;
  padding: 0.4rem 0.65rem;
  border: 1px solid #a78bfa;
  border-radius: 7px;
  color: #6d28d9;
  background: #fff;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
}

@media (max-width: 720px) {
  .detached-item {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .detached-copy {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
