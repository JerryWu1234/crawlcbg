<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import AiGeneratorModal from "../components/scripts/AiGeneratorModal.vue";
import DatabaseViewerModal from "../components/scripts/DatabaseViewerModal.vue";
import ExecutionOutputPanel from "../components/scripts/ExecutionOutputPanel.vue";
import HistoryTraceDrawer from "../components/scripts/HistoryTraceDrawer.vue";
import ScriptCodeEditor from "../components/scripts/ScriptCodeEditor.vue";
import ScriptFileSidebar from "../components/scripts/ScriptFileSidebar.vue";
import ScriptParametersBar from "../components/scripts/ScriptParametersBar.vue";
import ScriptWorkspaceToolbar from "../components/scripts/ScriptWorkspaceToolbar.vue";
import ValidationBanner from "../components/scripts/ValidationBanner.vue";
import type {
  BrowserTab,
  DbRow,
  DbTableInfo,
  ExecutionLogEntry,
  HistoryItem,
  ScriptItem,
  ScriptParamField,
  ScriptParamValues,
  TraceFrame,
  TraceRunSummary,
  ValidationResult,
} from "../types/automation";
import { parseJSDocParams } from "../utils/scriptParams";

const scripts = ref<ScriptItem[]>([]);
const activeFilename = ref<string>("");
const editorContent = ref<string>("");
const currentFilenameInput = ref<string>("");

const paramFields = ref<ScriptParamField[]>([]);
const formValues = ref<ScriptParamValues>({});

// Tabs
const openTabs = ref<BrowserTab[]>([]);
const selectedTabIndex = ref<number>(0);
const isTabDropdownOpen = ref(false);
const isRefreshingTabs = ref(false);

// Status
const isLoadingScripts = ref(false);
const isSaving = ref(false);
const isValidating = ref(false);
const isExecuting = ref(false);
const validationResult = ref<ValidationResult | null>(null);

// AI Generator State
const showAiModal = ref(false);
const aiPromptInput = ref("");
const isAiGenerating = ref(false);
const aiIncrementalModify = ref(true);

// History & Trace Drawer State
const showHistoryDrawer = ref(false);
const drawerActiveTab = ref<"versions" | "traces">("versions");
const historyList = ref<HistoryItem[]>([]);
const allTracesList = ref<TraceRunSummary[]>([]);
const expandedLogRunIds = ref<string[]>([]);
const isLoadingHistory = ref(false);
const isLoadingTraces = ref(false);
const previewHistoryContent = ref<string | null>(null);

const totalHistoryCount = computed(() => {
  return (
    (historyList.value ? historyList.value.length : 0) +
    (allTracesList.value ? allTracesList.value.length : 0)
  );
});

const toggleTraceLog = (runId: string) => {
  const idx = expandedLogRunIds.value.indexOf(runId);
  if (idx !== -1) {
    expandedLogRunIds.value.splice(idx, 1);
  } else {
    expandedLogRunIds.value.push(runId);
  }
};

const toggleHistoryPreview = (content: string) => {
  previewHistoryContent.value = previewHistoryContent.value === content ? null : content;
};

// Console & Visual Replay Player State
const activeConsoleTab = ref<"logs" | "replay">("logs");
const logs = ref<ExecutionLogEntry[]>([]);
const logsTerminalRef = ref<InstanceType<typeof ExecutionOutputPanel> | null>(null);
let eventSource: EventSource | null = null;

// Replay Player State
const currentRunId = ref<string | null>(null);
const traceFrames = ref<TraceFrame[]>([]);
const currentFrameIndex = ref<number>(0);
const isPlayingReplay = ref(false);
const replaySpeed = ref<number>(1);
let replayTimer: number | null = null;

// SQLite DB Viewer State
const showDbModal = ref(false);
const dbTables = ref<DbTableInfo[]>([]);
const selectedTable = ref<string>("");
const dbRows = ref<DbRow[]>([]);
const dbSearchInput = ref<string>("");
const isLoadingDb = ref(false);

// Fetch scripts list
const fetchScripts = async () => {
  isLoadingScripts.value = true;
  try {
    const res = await fetch("http://localhost:3001/api/scripts");
    if (res.ok) {
      const data = await res.json();
      scripts.value = data.scripts || [];
      if (scripts.value.length > 0 && !activeFilename.value) {
        selectScript(scripts.value[0]);
      }
    }
  } catch (err) {
    console.error("Fetch scripts error:", err);
  } finally {
    isLoadingScripts.value = false;
  }
};

// Fetch open tabs list
const fetchTabs = async () => {
  isRefreshingTabs.value = true;
  try {
    const res = await fetch("http://localhost:3001/api/tabs");
    if (res.ok) {
      const data = await res.json();
      openTabs.value = Array.isArray(data) ? data : data.tabs || [];
      if (openTabs.value.length > 0) {
        const exists = openTabs.value.some((t) => t.index === selectedTabIndex.value);
        if (!exists) {
          selectedTabIndex.value = openTabs.value[0].index;
        }
      }
    }
  } catch (err) {
    console.error("Fetch tabs error:", err);
  } finally {
    setTimeout(() => {
      isRefreshingTabs.value = false;
    }, 500);
  }
};

const selectTab = async (tab: BrowserTab) => {
  selectedTabIndex.value = tab.index;
  isTabDropdownOpen.value = false;
  try {
    await fetch("http://localhost:3001/api/tabs/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: tab.index }),
    });
  } catch (err) {
    console.error("Activate tab error:", err);
  }
};

const selectScript = (item: ScriptItem) => {
  activeFilename.value = item.filename;
  currentFilenameInput.value = item.filename;
  editorContent.value = item.content;
  validationResult.value = null;
  fetchHistory();
};

const createNewScript = () => {
  const newName = `script_${Date.now().toString().slice(-4)}.mjs`;
  const defaultTemplate = `export default async function run({ page, stagehand, log, db }) {
  log("🚀 开始运行自定义 Stagehand + SQLite 自动化脚本...");
  log(\`📍 目标页面: \${page.url()}\`);
  
  // 1. 创建数据表 (支持自动去重)
  db.exec(\`
    CREATE TABLE IF NOT EXISTS items (
      eid TEXT PRIMARY KEY,
      name TEXT,
      price TEXT,
      url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  \`);
  
  const title = await page.title();
  log(\`🏷️ 页面标题为: "\${title}"\`);
  log("✅ 脚本运行成功！");
}
`;
  activeFilename.value = newName;
  currentFilenameInput.value = newName;
  editorContent.value = defaultTemplate;
  validationResult.value = null;
  historyList.value = [];
};

const saveScript = async (customLabel?: string) => {
  if (!currentFilenameInput.value.trim()) return;
  isSaving.value = true;
  try {
    let filename = currentFilenameInput.value.trim();
    if (!filename.endsWith(".mjs") && !filename.endsWith(".js")) {
      filename += ".mjs";
    }

    const res = await fetch("http://localhost:3001/api/scripts/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        content: editorContent.value,
        label: customLabel || "手动保存",
      }),
    });

    if (res.ok) {
      await fetchScripts();
      activeFilename.value = filename;
      currentFilenameInput.value = filename;
      validationResult.value = { valid: true, message: "💾 脚本与快照已成功保存！" };
      fetchHistory();
    }
  } catch (err: any) {
    validationResult.value = { valid: false, message: `保存失败: ${err.message}` };
  } finally {
    isSaving.value = false;
  }
};

const deleteScript = async (filename: string) => {
  if (!confirm(`确认要删除脚本 '${filename}' 吗？`)) return;
  try {
    const res = await fetch("http://localhost:3001/api/scripts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });

    if (res.ok) {
      if (activeFilename.value === filename) {
        activeFilename.value = "";
        editorContent.value = "";
      }
      await fetchScripts();
    }
  } catch (err) {
    console.error("Delete script error:", err);
  }
};

const openDbViewerModal = async () => {
  showDbModal.value = true;
  await fetchDbTables();
};

const fetchDbTables = async () => {
  try {
    const res = await fetch("http://localhost:3001/api/db/tables");
    if (res.ok) {
      const data = await res.json();
      dbTables.value = data.tables || [];
      if (dbTables.value.length > 0 && !selectedTable.value) {
        selectedTable.value = dbTables.value[0].name;
      }
      if (selectedTable.value) {
        await fetchDbRows();
      }
    }
  } catch (err) {
    console.error("Fetch DB tables error:", err);
  }
};

const fetchDbRows = async () => {
  if (!selectedTable.value) return;
  isLoadingDb.value = true;
  try {
    const search = encodeURIComponent(dbSearchInput.value.trim());
    const res = await fetch(
      `http://localhost:3001/api/db/data?table=${selectedTable.value}&search=${search}`,
    );
    if (res.ok) {
      const data = await res.json();
      dbRows.value = data.rows || [];
    }
  } catch (err) {
    console.error("Fetch DB rows error:", err);
  } finally {
    isLoadingDb.value = false;
  }
};

const clearDbTable = async () => {
  if (!selectedTable.value) return;
  if (!confirm(`确认要清空表 '${selectedTable.value}' 中的所有数据吗？`)) return;
  try {
    const res = await fetch("http://localhost:3001/api/db/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: selectedTable.value }),
    });
    if (res.ok) {
      await fetchDbTables();
      await fetchDbRows();
    }
  } catch (err: any) {
    alert(`清空失败: ${err.message}`);
  }
};

const exportDbJson = () => {
  if (dbRows.value.length === 0) return;
  const jsonStr = JSON.stringify(dbRows.value, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${selectedTable.value}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const openDrawer = (tab: "versions" | "traces" = "versions") => {
  drawerActiveTab.value = tab;
  showHistoryDrawer.value = true;
  fetchHistory();
  fetchTraces();
};

// Batch Deletion Selection State
const selectedHistoryIds = ref<string[]>([]);
const selectedTraceRunIds = ref<string[]>([]);

const isAllHistorySelected = computed(() => {
  return (
    historyList.value.length > 0 && selectedHistoryIds.value.length === historyList.value.length
  );
});

const isAllTracesSelected = computed(() => {
  return (
    allTracesList.value.length > 0 &&
    selectedTraceRunIds.value.length === allTracesList.value.length
  );
});

const toggleSelectAllHistory = () => {
  if (isAllHistorySelected.value) {
    selectedHistoryIds.value = [];
  } else {
    selectedHistoryIds.value = historyList.value.map((item) => item.id);
  }
};

const toggleSelectAllTraces = () => {
  if (isAllTracesSelected.value) {
    selectedTraceRunIds.value = [];
  } else {
    selectedTraceRunIds.value = allTracesList.value.map((item) => item.runId);
  }
};

const batchDeleteHistory = async () => {
  if (selectedHistoryIds.value.length === 0) return;
  if (!confirm(`确认要批量删除选中的 ${selectedHistoryIds.value.length} 个代码版本快照吗？`))
    return;

  try {
    const res = await fetch("http://localhost:3001/api/scripts/history/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: activeFilename.value,
        historyIds: selectedHistoryIds.value,
      }),
    });
    if (res.ok) {
      selectedHistoryIds.value = [];
      fetchHistory();
    }
  } catch (err: any) {
    alert(`批量删除代码快照失败: ${err.message}`);
  }
};

const batchDeleteTraces = async () => {
  if (selectedTraceRunIds.value.length === 0) return;
  if (!confirm(`确认要批量删除选中的 ${selectedTraceRunIds.value.length} 个 Trace 运行轨迹吗？`))
    return;

  try {
    const res = await fetch("http://localhost:3001/api/traces/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runIds: selectedTraceRunIds.value,
      }),
    });
    if (res.ok) {
      selectedTraceRunIds.value = [];
      fetchTraces();
    }
  } catch (err: any) {
    alert(`批量删除 Trace 轨迹失败: ${err.message}`);
  }
};

// Version History Logic
const fetchHistory = async () => {
  if (!activeFilename.value) return;
  isLoadingHistory.value = true;
  try {
    const res = await fetch(
      `http://localhost:3001/api/scripts/history?filename=${encodeURIComponent(activeFilename.value)}`,
    );
    if (res.ok) {
      const data = await res.json();
      historyList.value = data.history || [];
      selectedHistoryIds.value = [];
    }
  } catch (err) {
    console.error("Fetch history error:", err);
  } finally {
    isLoadingHistory.value = false;
  }
};

const deleteHistoryVersion = async (historyId: string) => {
  if (!confirm(`确认要彻底删除该历史版本 #${historyId.slice(-4)} 吗？`)) return;
  try {
    const res = await fetch("http://localhost:3001/api/scripts/history/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: activeFilename.value,
        historyId,
      }),
    });
    if (res.ok) {
      fetchHistory();
    }
  } catch (err: any) {
    alert(`删除版本失败: ${err.message}`);
  }
};

const restoreHistoryVersion = async (historyId: string) => {
  if (!confirm(`确认要恢复到历史版本 #${historyId.slice(-4)} 吗？`)) return;
  try {
    const res = await fetch("http://localhost:3001/api/scripts/history/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: activeFilename.value,
        historyId,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      editorContent.value = data.content;
      validationResult.value = { valid: true, message: `↺ 已成功恢复到历史版本！` };
      fetchHistory();
      showHistoryDrawer.value = false;
      previewHistoryContent.value = null;
    }
  } catch (err: any) {
    alert(`恢复失败: ${err.message}`);
  }
};

// Trace Runs Logic
const fetchTraces = async () => {
  isLoadingTraces.value = true;
  try {
    const query = activeFilename.value
      ? `?filename=${encodeURIComponent(activeFilename.value)}`
      : "";
    const res = await fetch(`http://localhost:3001/api/traces${query}`);
    if (res.ok) {
      const data = await res.json();
      allTracesList.value = data.traces || [];
      selectedTraceRunIds.value = [];
    }
  } catch (err) {
    console.error("Fetch traces error:", err);
  } finally {
    isLoadingTraces.value = false;
  }
};

const deleteTraceRun = async (runId: string) => {
  if (!confirm(`确认要删除此 Trace 运行轨迹记录吗？`)) return;
  try {
    const res = await fetch("http://localhost:3001/api/traces/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    if (res.ok) {
      fetchTraces();
      if (currentRunId.value === runId) {
        traceFrames.value = [];
        currentRunId.value = null;
      }
    }
  } catch (err: any) {
    alert(`删除 Trace 记录失败: ${err.message}`);
  }
};

// Load Historical Trace Replay
const loadTraceReplay = async (runId: string) => {
  try {
    const res = await fetch(`http://localhost:3001/api/traces/${runId}`);
    if (res.ok) {
      const data = await res.json();
      currentRunId.value = runId;
      traceFrames.value = data.frames || [];
      currentFrameIndex.value = 0;
      activeConsoleTab.value = "replay";
      showHistoryDrawer.value = false;
    } else {
      alert("未找到该次运行的快照轨迹。");
    }
  } catch (err: any) {
    alert(`加载 Trace 轨迹失败: ${err.message}`);
  }
};

// 1-Click Syntax Validation
const validateSyntax = async () => {
  isValidating.value = true;
  validationResult.value = null;
  try {
    const res = await fetch("http://localhost:3001/api/scripts/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editorContent.value }),
    });

    if (res.ok) {
      validationResult.value = await res.json();
    }
  } catch (err: any) {
    validationResult.value = {
      valid: false,
      message: `校验请求失败: ${err.message}`,
    };
  } finally {
    isValidating.value = false;
  }
};

// 1-Click Execute with Real-Time SSE Log & Trace Frame Streaming
const runScript = async () => {
  await saveScript();

  if (isExecuting.value) {
    stopExecution();
    return;
  }

  isExecuting.value = true;
  logs.value = [];
  traceFrames.value = [];
  currentFrameIndex.value = 0;
  isPlayingReplay.value = false;

  logs.value.push({
    type: "log",
    time: new Date().toLocaleTimeString(),
    message: "🔌 正在建立 SSE 实时日志与画面 Trace 通道...",
  });

  const paramsJson = JSON.stringify(formValues.value || {});
  const url = `http://localhost:3001/api/scripts/execute/stream?filename=${encodeURIComponent(
    activeFilename.value,
  )}&tabIndex=${selectedTabIndex.value}&params=${encodeURIComponent(paramsJson)}`;

  eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "log" || data.type === "done" || data.type === "error") {
        logs.value.push(data);
      }
      if (data.type === "frame") {
        currentRunId.value = data.runId;
        traceFrames.value.push({
          step: data.step,
          time: data.time,
          message: data.message,
          frameUrl: data.frameUrl,
        });
        currentFrameIndex.value = traceFrames.value.length - 1;
      }
      if (data.type === "done" || data.type === "error") {
        stopExecution();
        fetchDbTables();
      }
      scrollToBottom();
    } catch (e) {
      console.error("SSE parse error:", e);
    }
  };

  eventSource.onerror = () => {
    logs.value.push({
      type: "error",
      time: new Date().toLocaleTimeString(),
      message: "⚠️ 与服务器的实时日志流断开连接。",
    });
    stopExecution();
  };
};

const stopExecution = () => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  isExecuting.value = false;
};

// Visual Replay Player Controls
const togglePlayReplay = () => {
  isPlayingReplay.value = !isPlayingReplay.value;
  if (isPlayingReplay.value) {
    startPlaybackTimer();
  } else {
    stopPlaybackTimer();
  }
};

const currentFrame = computed(() => {
  if (!traceFrames.value || traceFrames.value.length === 0) return null;
  const index = Math.min(Math.max(0, currentFrameIndex.value), traceFrames.value.length - 1);
  return traceFrames.value[index] || traceFrames.value[0] || null;
});

const currentSelectedTab = computed(() => {
  if (!openTabs.value || openTabs.value.length === 0) return null;
  return (
    openTabs.value.find((t) => t.index === selectedTabIndex.value) || openTabs.value[0] || null
  );
});

const dbColumns = computed(() => {
  if (
    !dbRows.value ||
    dbRows.value.length === 0 ||
    !dbRows.value[0] ||
    typeof dbRows.value[0] !== "object"
  ) {
    return [];
  }
  return Object.keys(dbRows.value[0]);
});

const totalDbRecordsCount = computed(() => {
  if (!dbTables.value || !Array.isArray(dbTables.value)) return 0;
  return dbTables.value.reduce((sum, t) => sum + (t?.count || 0), 0);
});

const startPlaybackTimer = () => {
  stopPlaybackTimer();
  const interval = Math.max(200, 1500 / replaySpeed.value);
  replayTimer = window.setInterval(() => {
    if (currentFrameIndex.value < traceFrames.value.length - 1) {
      currentFrameIndex.value++;
    } else {
      currentFrameIndex.value = 0; // loop
    }
  }, interval);
};

const stopPlaybackTimer = () => {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
};

const prevFrame = () => {
  if (currentFrameIndex.value > 0) {
    currentFrameIndex.value--;
  }
};

const nextFrame = () => {
  if (currentFrameIndex.value < traceFrames.value.length - 1) {
    currentFrameIndex.value++;
  }
};

const setSpeed = (speed: number) => {
  replaySpeed.value = speed;
  if (isPlayingReplay.value) {
    startPlaybackTimer();
  }
};

const clearLogs = () => {
  logs.value = [];
};

const copyLogs = () => {
  const text = logs.value.map((l) => `[${l.time}] ${l.message}`).join("\n");
  navigator.clipboard.writeText(text);
};

const scrollToBottom = () => {
  nextTick(() => {
    logsTerminalRef.value?.scrollToBottom();
  });
};

const updateParamsFromCode = () => {
  const parsed = parseJSDocParams(editorContent.value);
  paramFields.value = parsed;

  const newValues: ScriptParamValues = {};
  for (const field of parsed) {
    if (formValues.value[field.name] !== undefined) {
      newValues[field.name] = formValues.value[field.name];
    } else {
      newValues[field.name] = field.default;
    }
  }
  formValues.value = newValues;
};

watch(
  editorContent,
  () => {
    updateParamsFromCode();
  },
  { immediate: true },
);

// AI Generator Logic
const openAiGeneratorModal = () => {
  showAiModal.value = true;
};

const applyPresetTag = (promptText: string) => {
  aiPromptInput.value = promptText;
};

const generateScriptWithAi = async () => {
  if (!aiPromptInput.value.trim()) return;

  isAiGenerating.value = true;
  try {
    const res = await fetch("http://localhost:3001/api/scripts/generate-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: aiPromptInput.value.trim(),
        currentCode: aiIncrementalModify.value ? editorContent.value : "",
        tabTitle: currentSelectedTab.value?.title || "",
        tabUrl: currentSelectedTab.value?.url || "",
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `AI 接口发生错误 (${res.status})`);
    }

    const data = await res.json();
    let generatedCode = data.code || "";

    if (generatedCode.includes("```")) {
      generatedCode = generatedCode
        .replace(/```[a-z]*\n?/gi, "")
        .replace(/```$/g, "")
        .trim();
    }

    editorContent.value = generatedCode;
    showAiModal.value = false;
    aiPromptInput.value = "";

    await validateSyntax();
    await saveScript();

    alert("✨ AI 成功为你生成/修改了脚本，并自动测试语法与保存当前代码快照！");
  } catch (err: any) {
    alert(`AI 脚本生成失败: ${err.message}`);
  } finally {
    isAiGenerating.value = false;
  }
};

onMounted(() => {
  fetchScripts();
  fetchTabs();
  fetchDbTables();
});
</script>

<template>
  <div class="scripts-page">
    <ScriptFileSidebar
      :scripts="scripts"
      :active-filename="activeFilename"
      :is-loading-scripts="isLoadingScripts"
      @open-ai="openAiGeneratorModal"
      @create="createNewScript"
      @select="selectScript"
      @delete="deleteScript"
    />

    <main class="workspace">
      <ScriptWorkspaceToolbar
        :current-filename-input="currentFilenameInput"
        :current-selected-tab="currentSelectedTab"
        :open-tabs="openTabs"
        :selected-tab-index="selectedTabIndex"
        :is-tab-dropdown-open="isTabDropdownOpen"
        :is-refreshing-tabs="isRefreshingTabs"
        :total-db-records-count="totalDbRecordsCount"
        :total-history-count="totalHistoryCount"
        :is-validating="isValidating"
        :is-saving="isSaving"
        :is-executing="isExecuting"
        @update:current-filename-input="currentFilenameInput = $event"
        @update:is-tab-dropdown-open="isTabDropdownOpen = $event"
        @refresh-tabs="fetchTabs"
        @select-tab="selectTab"
        @open-db="openDbViewerModal"
        @open-ai="openAiGeneratorModal"
        @open-history="openDrawer('versions')"
        @validate="validateSyntax"
        @save="saveScript('手动保存')"
        @run="runScript"
      />

      <ValidationBanner v-if="validationResult" :result="validationResult" />

      <ScriptParametersBar
        v-if="paramFields.length > 0"
        :fields="paramFields"
        :values="formValues"
        @update:values="formValues = $event"
      />

      <ScriptCodeEditor :model-value="editorContent" @update:model-value="editorContent = $event" />

      <ExecutionOutputPanel
        ref="logsTerminalRef"
        :active-console-tab="activeConsoleTab"
        :logs="logs"
        :trace-frames="traceFrames"
        :current-frame="currentFrame"
        :current-frame-index="currentFrameIndex"
        :is-playing-replay="isPlayingReplay"
        :replay-speed="replaySpeed"
        @update:active-console-tab="activeConsoleTab = $event"
        @update:current-frame-index="currentFrameIndex = $event"
        @copy="copyLogs"
        @clear="clearLogs"
        @previous="prevFrame"
        @next="nextFrame"
        @toggle-play="togglePlayReplay"
        @set-speed="setSpeed"
      />
    </main>

    <DatabaseViewerModal
      :open="showDbModal"
      :db-tables="dbTables"
      :selected-table="selectedTable"
      :db-rows="dbRows"
      :db-columns="dbColumns"
      :db-search-input="dbSearchInput"
      :is-loading-db="isLoadingDb"
      @close="showDbModal = false"
      @update:selected-table="selectedTable = $event"
      @update:db-search-input="dbSearchInput = $event"
      @refresh="fetchDbRows"
      @export="exportDbJson"
      @clear="clearDbTable"
    />

    <AiGeneratorModal
      :open="showAiModal"
      :ai-prompt-input="aiPromptInput"
      :is-ai-generating="isAiGenerating"
      :ai-incremental-modify="aiIncrementalModify"
      :has-editor-content="Boolean(editorContent.trim())"
      @update:ai-prompt-input="aiPromptInput = $event"
      @update:ai-incremental-modify="aiIncrementalModify = $event"
      @preset="applyPresetTag"
      @cancel="showAiModal = false"
      @generate="generateScriptWithAi"
    />

    <HistoryTraceDrawer
      :open="showHistoryDrawer"
      :drawer-active-tab="drawerActiveTab"
      :history-list="historyList"
      :all-traces-list="allTracesList"
      :expanded-log-run-ids="expandedLogRunIds"
      :is-loading-history="isLoadingHistory"
      :is-loading-traces="isLoadingTraces"
      :preview-history-content="previewHistoryContent"
      :selected-history-ids="selectedHistoryIds"
      :selected-trace-run-ids="selectedTraceRunIds"
      :is-all-history-selected="isAllHistorySelected"
      :is-all-traces-selected="isAllTracesSelected"
      @close="showHistoryDrawer = false"
      @update:drawer-active-tab="drawerActiveTab = $event"
      @update:selected-history-ids="selectedHistoryIds = $event"
      @update:selected-trace-run-ids="selectedTraceRunIds = $event"
      @toggle-select-all-history="toggleSelectAllHistory"
      @toggle-select-all-traces="toggleSelectAllTraces"
      @batch-delete-history="batchDeleteHistory"
      @batch-delete-traces="batchDeleteTraces"
      @preview-history="toggleHistoryPreview"
      @restore-history="restoreHistoryVersion"
      @delete-history="deleteHistoryVersion"
      @toggle-trace-log="toggleTraceLog"
      @load-trace="loadTraceReplay"
      @delete-trace="deleteTraceRun"
    />
  </div>
</template>

<style scoped>
.scripts-page {
  display: flex;
  gap: 1.5rem;
  min-height: calc(100vh - 120px);
}

.workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}
</style>
