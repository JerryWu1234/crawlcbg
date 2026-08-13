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
const executionLogs = ref<ExecutionLogEntry[]>([]);
const traceFrames = ref<TraceFrame[]>([]);
const currentFrameIndex = ref<number>(0);
let eventSource: EventSource | null = null;

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
  try {
    const response = await fetch("http://localhost:3001/api/schedules");
    if (!response.ok) throw new Error(`获取循环计划失败 (${response.status})`);
    const data = await response.json();
    schedules.value = Array.isArray(data.schedules) ? data.schedules : [];
  } catch (err) {
    console.error("Fetch schedules error:", err);
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

    if (scheduleEditorTab.value) {
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
  tab: BrowserTab;
  scriptName: string;
  pinnedId?: string;
} | null>(null);
const executingPinnedId = ref<string | null>(null);

const confirmAndRunFromModal = async (values: ScriptParamValues) => {
  if (!pendingRunTarget.value) return;
  const { tab, scriptName, pinnedId } = pendingRunTarget.value;
  showParamModal.value = false;
  await executeScriptWithParams(tab, scriptName, values, pinnedId);
};

const isTabRunning = (tabIndex: number) => {
  return isExecuting.value && executingTab.value?.index === tabIndex;
};

const isPinnedRunning = (pinned: PinnedTab) => {
  if (!isExecuting.value) return false;
  if (executingPinnedId.value && executingPinnedId.value === pinned.id) return true;

  if (pinned.url && executingTab.value?.url) {
    const cleanPinnedUrl = pinned.url.replace(/\/+$/, "").toLowerCase();
    const cleanExecUrl = executingTab.value.url.replace(/\/+$/, "").toLowerCase();
    if (
      cleanExecUrl === cleanPinnedUrl ||
      cleanExecUrl.includes(cleanPinnedUrl) ||
      cleanPinnedUrl.includes(cleanExecUrl)
    ) {
      return true;
    }
  }

  try {
    if (pinned.url && executingTab.value?.url) {
      const pinnedHost = new URL(pinned.url).hostname;
      const execHost = new URL(executingTab.value.url).hostname;
      if (pinnedHost && execHost && pinnedHost === execHost) {
        if (!pinned.scriptFilename || pinned.scriptFilename === executingScript.value) {
          return true;
        }
      }
    }
  } catch (e) {
    // ignore
  }

  return false;
};

const handleRunOrCancelTab = (tab: BrowserTab) => {
  if (schedulesByUrl.value[tab.url]?.status === "running") return;
  if (isTabRunning(tab.index)) {
    stopExecutionModal();
  } else {
    runScriptOnTab(tab);
  }
};

const handleRunOrCancelPinned = (pinned: PinnedTab) => {
  if (isPinnedRunning(pinned)) {
    stopExecutionModal();
  } else {
    launchPinnedTab(pinned);
  }
};

const runScriptOnTab = async (tab: BrowserTab, pinnedId?: string) => {
  const scriptName = selectedScriptPerTab.value[tab.index] || scripts.value[0]?.filename;
  if (!scriptName) {
    alert("暂无可用脚本，请先在【脚本管理】页面创建或生成脚本！");
    return;
  }

  const matchedScript = scripts.value.find((script) => script.filename === scriptName);
  const parsed = matchedScript?.content ? parseJSDocParams(matchedScript.content) : [];

  if (parsed.length > 0) {
    paramFields.value = parsed;
    const initialValues: ScriptParamValues = {};
    for (const field of parsed) {
      initialValues[field.name] = field.default;
    }
    formValues.value = initialValues;
    pendingRunTarget.value = { tab, scriptName, pinnedId };
    showParamModal.value = true;
    return;
  }

  await executeScriptWithParams(tab, scriptName, {}, pinnedId);
};

const executeScriptWithParams = async (
  tab: BrowserTab,
  scriptName: string,
  scriptParams: ScriptParamValues,
  pinnedId?: string,
) => {
  await switchToTab(tab.index);

  executingTab.value = tab;
  executingScript.value = scriptName;
  executingPinnedId.value = pinnedId || null;
  isExecuting.value = true;
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
  )}&tabIndex=${tab.index}${targetUrlParam}${paramsParam}`;

  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "log" || data.type === "done" || data.type === "error") {
        executionLogs.value.push(data);
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
      if (data.type === "done" || data.type === "error") {
        stopExecutionModal();
      }
    } catch (e) {
      console.error("Parse SSE data error:", e);
    }
  };

  eventSource.onerror = () => {
    stopExecutionModal();
  };
};

const stopExecutionModal = () => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  isExecuting.value = false;
  executingPinnedId.value = null;
};

const closeExecutionModal = () => {
  stopExecutionModal();
  executingTab.value = null;
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
  executingPinnedId.value = pinned.id;
  const scriptName = pinned.scriptFilename || scripts.value[0]?.filename;
  if (!scriptName) {
    alert("暂无可用脚本，请先在【脚本管理】页面创建脚本或为常驻配置关联脚本！");
    executingPinnedId.value = null;
    return;
  }

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

    const targetTab = tabs.value.find((tab) => tab.index === tabIndex) || {
      index: tabIndex,
      title: pinned.title,
      url: pinned.url,
      favicon: "",
    };

    selectedScriptPerTab.value[tabIndex] = scriptName;
    await runScriptOnTab(targetTab, pinned.id);
  } catch (err: any) {
    executingPinnedId.value = null;
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
  return isExecuting.value ? (executingTab.value?.index ?? null) : null;
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

    <PinnedTabsSection
      v-if="pinnedTabs.length > 0"
      :pinned-tabs="pinnedTabs"
      :statuses="pinnedTabStatuses"
      :running-states="pinnedTabRunningStates"
      @create-pinned="showPinnedModal = true"
      @toggle-run="handleRunOrCancelPinned"
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
      @pin-tab="pinLiveTab"
      @toggle-script-picker="toggleScriptPicker"
      @select-script="selectScriptForTab"
      @toggle-run="handleRunOrCancelTab"
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
      @cancel="showParamModal = false"
      @confirm="confirmAndRunFromModal"
    />

    <ExecutionStreamModal
      v-if="executingTab"
      :tab="executingTab"
      :script-name="executingScript"
      :is-executing="isExecuting"
      :logs="executionLogs"
      :current-frame="currentFrame"
      @stop="stopExecutionModal"
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
