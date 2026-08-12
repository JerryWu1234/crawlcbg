<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick, shallowRef } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";
import { autocompletion, type CompletionContext, type Completion } from "@codemirror/autocomplete";

interface ScriptItem {
  filename: string;
  content: string;
}

interface TabItem {
  index: number;
  title: string;
  url: string;
  favicon: string;
}

interface LogEntry {
  type: "log" | "done" | "error";
  time: string;
  message: string;
}

interface HistoryItem {
  id: string;
  timestamp: string;
  label: string;
  runId?: string;
  content: string;
}

interface TraceFrame {
  step: number;
  time: string;
  message: string;
  frameUrl: string;
}

interface DbTableInfo {
  name: string;
  count: number;
}

const scripts = ref<ScriptItem[]>([]);
const activeFilename = ref<string>("");
const editorContent = ref<string>("");
const currentFilenameInput = ref<string>("");

interface ParamField {
  name: string;
  type: "string" | "number" | "boolean" | "select";
  default: any;
  label: string;
  options?: Record<string, string>;
}

const paramFields = ref<ParamField[]>([]);
const formValues = ref<Record<string, any>>({});

// Tabs
const openTabs = ref<TabItem[]>([]);
const selectedTabIndex = ref<number>(0);
const isTabDropdownOpen = ref(false);
const isRefreshingTabs = ref(false);

// Status
const isLoadingScripts = ref(false);
const isSaving = ref(false);
const isValidating = ref(false);
const isExecuting = ref(false);
const validationResult = ref<{
  valid: boolean;
  message?: string;
  errors?: Array<{ line: number; character: number; message: string }>;
} | null>(null);

// AI Generator State
const showAiModal = ref(false);
const aiPromptInput = ref("");
const isAiGenerating = ref(false);
const aiIncrementalModify = ref(true);
const aiSuccessToast = ref<string | null>(null);

interface TraceLogItem {
  time: string;
  message: string;
  type?: string;
}

interface TraceRunItem {
  runId: string;
  filename: string;
  timestamp: string;
  totalFrames: number;
  totalLogs?: number;
  logs?: TraceLogItem[];
}

// History & Trace Drawer State
const showHistoryDrawer = ref(false);
const drawerActiveTab = ref<"versions" | "traces">("versions");
const historyList = ref<HistoryItem[]>([]);
const allTracesList = ref<TraceRunItem[]>([]);
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

// Console & Visual Replay Player State
const activeConsoleTab = ref<"logs" | "replay">("logs");
const logs = ref<LogEntry[]>([]);
const logsTerminalRef = ref<HTMLDivElement | null>(null);
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
const dbRows = ref<any[]>([]);
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

const selectTab = async (tab: TabItem) => {
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
  aiSuccessToast.value = null;
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
  aiSuccessToast.value = null;
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
  if (!activeFilename.value) {
    await saveScript();
  } else {
    await saveScript();
  }

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
    if (logsTerminalRef.value) {
      logsTerminalRef.value.scrollTop = logsTerminalRef.value.scrollHeight;
    }
  });
};

// CodeMirror editor setup
const cmEditorRef = ref<HTMLDivElement | null>(null);
const cmViewRef = shallowRef<EditorView | null>(null);
let cmSyncFromExternal = false;

// JavaScript global completions source
const jsGlobals: Completion[] = [
  // Browser globals
  { label: "document", type: "variable", detail: "Document", boost: 2 },
  { label: "window", type: "variable", detail: "Window" },
  { label: "console", type: "variable", detail: "Console" },
  { label: "navigator", type: "variable", detail: "Navigator" },
  { label: "location", type: "variable", detail: "Location" },
  { label: "localStorage", type: "variable", detail: "Storage" },
  { label: "sessionStorage", type: "variable", detail: "Storage" },
  { label: "history", type: "variable", detail: "History" },
  // Fetch / Timer
  { label: "fetch", type: "function", detail: "(url, options?) => Promise<Response>" },
  { label: "setTimeout", type: "function", detail: "(fn, ms) => number" },
  { label: "setInterval", type: "function", detail: "(fn, ms) => number" },
  { label: "clearTimeout", type: "function", detail: "(id) => void" },
  { label: "clearInterval", type: "function", detail: "(id) => void" },
  { label: "requestAnimationFrame", type: "function", detail: "(cb) => number" },
  { label: "AbortController", type: "class" },
  { label: "URL", type: "class" },
  { label: "URLSearchParams", type: "class" },
  { label: "Headers", type: "class" },
  { label: "Request", type: "class" },
  { label: "Response", type: "class" },
  { label: "FormData", type: "class" },
  { label: "Blob", type: "class" },
  // Console methods
  { label: "console.log", type: "function", detail: "(...args) => void" },
  { label: "console.error", type: "function", detail: "(...args) => void" },
  { label: "console.warn", type: "function", detail: "(...args) => void" },
  { label: "console.info", type: "function", detail: "(...args) => void" },
  { label: "console.table", type: "function", detail: "(data) => void" },
  { label: "console.dir", type: "function", detail: "(obj) => void" },
  { label: "console.time", type: "function", detail: "(label) => void" },
  { label: "console.timeEnd", type: "function", detail: "(label) => void" },
  // JSON
  { label: "JSON.parse", type: "function", detail: "(text) => any" },
  { label: "JSON.stringify", type: "function", detail: "(value, replacer?, space?) => string" },
  // Math
  { label: "Math.random", type: "function", detail: "() => number" },
  { label: "Math.floor", type: "function", detail: "(x) => number" },
  { label: "Math.ceil", type: "function", detail: "(x) => number" },
  { label: "Math.round", type: "function", detail: "(x) => number" },
  { label: "Math.max", type: "function", detail: "(...values) => number" },
  { label: "Math.min", type: "function", detail: "(...values) => number" },
  { label: "Math.abs", type: "function", detail: "(x) => number" },
  // Object / Array
  { label: "Object.keys", type: "function", detail: "(obj) => string[]" },
  { label: "Object.values", type: "function", detail: "(obj) => any[]" },
  { label: "Object.entries", type: "function", detail: "(obj) => [string, any][]" },
  { label: "Object.assign", type: "function", detail: "(target, ...sources) => any" },
  { label: "Object.freeze", type: "function", detail: "(obj) => obj" },
  { label: "Array.isArray", type: "function", detail: "(value) => boolean" },
  { label: "Array.from", type: "function", detail: "(iterable) => any[]" },
  // Promise
  { label: "Promise", type: "class" },
  { label: "Promise.resolve", type: "function", detail: "(value) => Promise" },
  { label: "Promise.reject", type: "function", detail: "(reason) => Promise" },
  { label: "Promise.all", type: "function", detail: "(promises) => Promise" },
  { label: "Promise.allSettled", type: "function", detail: "(promises) => Promise" },
  { label: "Promise.race", type: "function", detail: "(promises) => Promise" },
  // DOM query
  {
    label: "document.querySelector",
    type: "function",
    detail: "(selector) => Element|null",
    boost: 3,
  },
  {
    label: "document.querySelectorAll",
    type: "function",
    detail: "(selector) => NodeList",
    boost: 3,
  },
  { label: "document.getElementById", type: "function", detail: "(id) => Element|null" },
  { label: "document.createElement", type: "function", detail: "(tag) => Element" },
  { label: "document.body", type: "property", detail: "HTMLBodyElement" },
  { label: "document.title", type: "property", detail: "string" },
  { label: "document.cookie", type: "property", detail: "string" },
  // Element common methods
  { label: "addEventListener", type: "function", detail: "(type, listener) => void" },
  { label: "removeEventListener", type: "function", detail: "(type, listener) => void" },
  { label: "getAttribute", type: "function", detail: "(name) => string|null" },
  { label: "setAttribute", type: "function", detail: "(name, value) => void" },
  { label: "innerHTML", type: "property", detail: "string" },
  { label: "innerText", type: "property", detail: "string" },
  { label: "textContent", type: "property", detail: "string|null" },
  { label: "classList", type: "property", detail: "DOMTokenList" },
  { label: "style", type: "property", detail: "CSSStyleDeclaration" },
  { label: "parentElement", type: "property", detail: "Element|null" },
  { label: "children", type: "property", detail: "HTMLCollection" },
  { label: "nextElementSibling", type: "property", detail: "Element|null" },
  // Stagehand / page automation APIs
  { label: "page", type: "variable", detail: "Stagehand Page", boost: 5 },
  { label: "page.goto", type: "function", detail: "(url, options?) => Promise", boost: 4 },
  { label: "page.click", type: "function", detail: "(selector) => Promise", boost: 4 },
  { label: "page.type", type: "function", detail: "(selector, text) => Promise" },
  { label: "page.waitForSelector", type: "function", detail: "(selector, options?) => Promise" },
  { label: "page.evaluate", type: "function", detail: "(fn, ...args) => Promise<any>", boost: 4 },
  { label: "page.$$eval", type: "function", detail: "(selector, fn) => Promise<any>" },
  { label: "page.$eval", type: "function", detail: "(selector, fn) => Promise<any>" },
  { label: "page.$$", type: "function", detail: "(selector) => Promise<ElementHandle[]>" },
  { label: "page.$", type: "function", detail: "(selector) => Promise<ElementHandle|null>" },
  { label: "page.url", type: "function", detail: "() => string" },
  { label: "page.title", type: "function", detail: "() => Promise<string>" },
  { label: "page.content", type: "function", detail: "() => Promise<string>" },
  { label: "page.waitForNavigation", type: "function", detail: "(options?) => Promise" },
  { label: "page.waitForTimeout", type: "function", detail: "(ms) => Promise" },
  { label: "page.screenshot", type: "function", detail: "(options?) => Promise<Buffer>" },
  { label: "page.setViewport", type: "function", detail: "(viewport) => Promise" },
  { label: "page.keyboard", type: "property", detail: "Keyboard" },
  { label: "page.mouse", type: "property", detail: "Mouse" },
  // Common keywords / snippets
  { label: "async", type: "keyword" },
  { label: "await", type: "keyword" },
  { label: "export", type: "keyword" },
  { label: "import", type: "keyword" },
  { label: "const", type: "keyword" },
  { label: "let", type: "keyword" },
  { label: "function", type: "keyword" },
  { label: "return", type: "keyword" },
  { label: "throw", type: "keyword" },
  { label: "try", type: "keyword" },
  { label: "catch", type: "keyword" },
  { label: "finally", type: "keyword" },
  { label: "for", type: "keyword" },
  { label: "while", type: "keyword" },
  { label: "if", type: "keyword" },
  { label: "else", type: "keyword" },
  { label: "switch", type: "keyword" },
  { label: "case", type: "keyword" },
  { label: "break", type: "keyword" },
  { label: "continue", type: "keyword" },
  { label: "typeof", type: "keyword" },
  { label: "instanceof", type: "keyword" },
  { label: "new", type: "keyword" },
  { label: "delete", type: "keyword" },
  { label: "void", type: "keyword" },
  { label: "null", type: "keyword" },
  { label: "undefined", type: "keyword" },
  { label: "true", type: "keyword" },
  { label: "false", type: "keyword" },
];

const jsGlobalCompletion = (context: CompletionContext) => {
  const word = context.matchBefore(/[\w.$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: jsGlobals };
};

const initCodeMirror = () => {
  if (!cmEditorRef.value) return;
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      cmSyncFromExternal = true;
      editorContent.value = update.state.doc.toString();
      cmSyncFromExternal = false;
    }
  });
  const state = EditorState.create({
    doc: editorContent.value,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      autocompletion({ override: [jsGlobalCompletion] }),
      updateListener,
    ],
  });
  cmViewRef.value = new EditorView({ state, parent: cmEditorRef.value });
};

watch(editorContent, (newVal) => {
  if (cmSyncFromExternal) return;
  const view = cmViewRef.value;
  if (view && view.state.doc.toString() !== newVal) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newVal },
    });
  }
});

const parseJSDocParams = (code: string): ParamField[] => {
  const fields: ParamField[] = [];
  if (!code) return fields;

  const regex =
    /@param\s+\{(string|number|boolean|select)\}\s+\[(\w+)(?:=(.*?))?\]\s*([^|\n]*)(?:\|\s*(.*))?/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    const [, type, name, rawDefault, label, extra] = match;
    let defaultValue: any = rawDefault ? rawDefault.trim().replace(/^["']|["']$/g, "") : "";

    if (type === "number") {
      defaultValue = rawDefault ? Number(defaultValue) : 0;
      if (isNaN(defaultValue)) defaultValue = 0;
    } else if (type === "boolean") {
      defaultValue = defaultValue === "true";
    }

    let options: Record<string, string> | undefined;
    if (type === "select" && extra && extra.includes("选项:")) {
      try {
        const jsonStr = extra.split("选项:")[1].trim();
        options = JSON.parse(jsonStr);
      } catch (e) {
        console.warn("Failed to parse JSDoc select options:", e);
      }
    }

    fields.push({
      name,
      type: type as any,
      default: defaultValue,
      label: (label || "").trim() || name,
      options,
    });
  }

  return fields;
};

const updateParamsFromCode = () => {
  const parsed = parseJSDocParams(editorContent.value);
  paramFields.value = parsed;

  const newValues: Record<string, any> = {};
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
  nextTick(() => initCodeMirror());
});

onUnmounted(() => {
  cmViewRef.value?.destroy();
});
</script>

<template>
  <div class="scripts-page">
    <!-- Left Sidebar: File Tree & Management -->
    <aside class="file-sidebar">
      <div class="sidebar-header">
        <h3>JS / MJS 脚本列表</h3>
        <div class="sidebar-actions-group">
          <button class="btn-ai-sidebar" @click="openAiGeneratorModal" title="AI 一键生成脚本">
            ✨ AI 生成
          </button>
          <button class="btn-new" @click="createNewScript" title="新建脚本">+ 新建</button>
        </div>
      </div>

      <div v-if="isLoadingScripts" class="sidebar-loading">
        <span>加载脚本列表中...</span>
      </div>

      <div v-else class="file-list">
        <div
          v-for="item in scripts"
          :key="item.filename"
          class="file-item"
          :class="{ active: activeFilename === item.filename }"
          @click="selectScript(item)"
        >
          <div class="file-info">
            <span class="file-icon">📄</span>
            <span class="file-name" :title="item.filename">{{ item.filename }}</span>
          </div>
          <button class="btn-delete" @click.stop="deleteScript(item.filename)" title="删除脚本">
            🗑️
          </button>
        </div>
      </div>
    </aside>

    <!-- Right Workspace Area -->
    <main class="workspace">
      <!-- Toolbar Header -->
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="filename-box">
            <span class="label">文件名:</span>
            <input
              v-model="currentFilenameInput"
              type="text"
              placeholder="script_name.mjs"
              class="filename-input"
            />
          </div>

          <!-- Target Tab Selector Component -->
          <div class="target-tab-container">
            <span class="label">🎯 目标 Tab:</span>

            <div class="tab-trigger-wrapper">
              <button class="tab-trigger-btn" @click="isTabDropdownOpen = !isTabDropdownOpen">
                <div v-if="currentSelectedTab" class="trigger-content">
                  <img
                    v-if="currentSelectedTab.favicon"
                    :src="currentSelectedTab.favicon"
                    class="trigger-icon"
                    @error="
                      ($event.target as HTMLImageElement).src =
                        'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2364748b\' stroke-width=\'2\'><circle cx=\'12\' cy=\'12\' r=\'10\'/></svg>'
                    "
                  />
                  <span v-else class="trigger-icon-fallback">🌐</span>
                  <span class="trigger-badge">#{{ currentSelectedTab.index + 1 }}</span>
                  <span class="trigger-title" :title="currentSelectedTab.title">
                    {{ currentSelectedTab.title || currentSelectedTab.url }}
                  </span>
                </div>
                <span v-else class="trigger-empty">选择目标标签页...</span>
                <svg
                  class="chevron-icon"
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>

              <button
                class="btn-refresh-tabs"
                :class="{ spinning: isRefreshingTabs }"
                @click="fetchTabs"
                title="刷新已打开的 Tab 列表"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M23 4v6h-6"></path>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
              </button>

              <!-- Popover Dropdown Menu -->
              <div v-if="isTabDropdownOpen" class="tab-popover-menu">
                <div class="popover-header">
                  <span>选择脚本执行的 Chrome 标签页</span>
                  <span class="popover-count">共 {{ openTabs.length }} 个</span>
                </div>

                <div class="popover-body">
                  <div
                    v-for="t in openTabs"
                    :key="t.index"
                    class="popover-item"
                    :class="{ selected: t.index === selectedTabIndex }"
                    @click="selectTab(t)"
                  >
                    <div class="item-left">
                      <img
                        v-if="t.favicon"
                        :src="t.favicon"
                        class="item-icon"
                        @error="
                          ($event.target as HTMLImageElement).src =
                            'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2364748b\' stroke-width=\'2\'><circle cx=\'12\' cy=\'12\' r=\'10\'/></svg>'
                        "
                      />
                      <span v-else class="item-icon-fallback">🌐</span>
                      <span class="item-index">#{{ t.index + 1 }}</span>
                    </div>

                    <div class="item-info">
                      <div class="item-title" :title="t.title">{{ t.title || t.url }}</div>
                      <div class="item-url" :title="t.url">{{ t.url }}</div>
                    </div>

                    <div v-if="t.index === selectedTabIndex" class="item-check">✓</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="toolbar-actions">
          <button
            class="btn-db-view"
            @click="openDbViewerModal"
            title="查看 SQLite 爬取存入的数据表"
          >
            🗄️ SQLite 数据 ({{ totalDbRecordsCount }})
          </button>

          <button class="btn-ai-gradient" @click="openAiGeneratorModal">✨ AI 智能生成</button>

          <button
            class="btn-history"
            @click="openDrawer('versions')"
            title="查看代码修改历史与运行 Trace 轨迹"
          >
            📜 历史记录 ({{ totalHistoryCount }})
          </button>

          <button class="btn-secondary" @click="validateSyntax" :disabled="isValidating">
            <span v-if="isValidating">⏳ 校验中...</span>
            <span v-else>🧪 语法测试</span>
          </button>

          <button class="btn-save" @click="saveScript('手动保存')" :disabled="isSaving">
            <span>💾 保存</span>
          </button>

          <button
            class="btn-run"
            :class="{ executing: isExecuting, 'btn-running-cancel': isExecuting }"
            @click="runScript"
            :title="isExecuting ? '点击取消脚本运行' : '在所选页签上一键运行此脚本'"
          >
            <template v-if="isExecuting">
              <span class="btn-text-default">⏳ 运行中</span>
              <span class="btn-text-hover">🛑 取消</span>
            </template>
            <span v-else>▶️ 一键运行</span>
          </button>
        </div>
      </div>

      <!-- AI Toast Success Banner -->
      <div v-if="aiSuccessToast" class="ai-toast-banner">
        <span>{{ aiSuccessToast }}</span>
        <button class="btn-run-now" @click="runScript">▶️ 立即运行测试</button>
        <button class="toast-close" @click="aiSuccessToast = null">✕</button>
      </div>

      <!-- Syntax Validation Banner -->
      <div
        v-if="validationResult"
        class="validation-banner"
        :class="{ valid: validationResult.valid, invalid: !validationResult.valid }"
      >
        <div class="banner-title">
          <span v-if="validationResult.valid">✅ 语法测试通过</span>
          <span v-else>❌ 语法检测到错误</span>
        </div>
        <div v-if="validationResult.message" class="banner-msg">
          {{ validationResult.message }}
        </div>
        <div
          v-if="validationResult.errors && validationResult.errors.length > 0"
          class="banner-errors"
        >
          <div v-for="(err, i) in validationResult.errors" :key="i" class="err-line">
            ⚠️ <strong>Line {{ err.line }}, Col {{ err.character }}:</strong> {{ err.message }}
          </div>
        </div>
      </div>

      <!-- Dynamic JSDoc Parameter Config Section -->
      <div v-if="paramFields.length > 0" class="script-params-bar">
        <div class="params-bar-header">
          <span class="params-bar-title">⚙️ 运行时参数配置</span>
          <span class="params-bar-subtitle">(根据 JSDoc 注释自动解析)</span>
        </div>
        <div class="params-form-grid">
          <div v-for="field in paramFields" :key="field.name" class="param-form-item">
            <label class="param-label">
              <span>{{ field.label }}</span>
              <span class="param-name-badge">{{ field.name }}</span>
            </label>

            <!-- Text Input -->
            <input
              v-if="field.type === 'string'"
              v-model="formValues[field.name]"
              type="text"
              class="param-input"
              :placeholder="`请输入 ${field.label}`"
            />

            <!-- Number Input -->
            <input
              v-if="field.type === 'number'"
              v-model.number="formValues[field.name]"
              type="number"
              class="param-input param-input-number"
            />

            <!-- Boolean Toggle Switch -->
            <label v-if="field.type === 'boolean'" class="param-switch">
              <input v-model="formValues[field.name]" type="checkbox" />
              <span class="switch-slider"></span>
              <span class="switch-text">{{ formValues[field.name] ? "开启" : "关闭" }}</span>
            </label>

            <!-- Select Dropdown -->
            <select
              v-if="field.type === 'select'"
              v-model="formValues[field.name]"
              class="param-select"
            >
              <option v-for="(optLabel, optVal) in field.options" :key="optVal" :value="optVal">
                {{ optLabel }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <!-- Code Editor Section -->
      <div class="editor-container">
        <div ref="cmEditorRef" class="cm-editor-wrap"></div>
      </div>

      <!-- Bottom Output Section: Dual-Tab Logs Console & Visual Replay Player -->
      <div class="terminal-panel">
        <div class="terminal-header">
          <div class="console-tabs">
            <button
              class="console-tab-btn"
              :class="{ active: activeConsoleTab === 'logs' }"
              @click="activeConsoleTab = 'logs'"
            >
              📜 控制台文本日志
            </button>
            <button
              class="console-tab-btn"
              :class="{ active: activeConsoleTab === 'replay' }"
              @click="activeConsoleTab = 'replay'"
            >
              🎬 运行画面视觉回放
              <span v-if="traceFrames && traceFrames.length > 0" class="frame-badge"
                >{{ traceFrames.length }} 帧</span
              >
            </button>
          </div>

          <div v-if="activeConsoleTab === 'logs'" class="terminal-actions">
            <button class="term-btn" @click="copyLogs">复制日志</button>
            <button class="term-btn" @click="clearLogs">清空控制台</button>
          </div>

          <!-- Replay Controls in Header -->
          <div
            v-else-if="activeConsoleTab === 'replay' && traceFrames.length > 0"
            class="replay-controls-header"
          >
            <button class="player-btn" @click="prevFrame" title="上一帧">⏮️</button>
            <button class="player-btn play-main" @click="togglePlayReplay">
              {{ isPlayingReplay ? "⏸️ 暂停" : "▶️ 播放回放" }}
            </button>
            <button class="player-btn" @click="nextFrame" title="下一帧">⏭️</button>

            <div class="speed-selector">
              <button
                v-for="s in [0.5, 1, 2, 4]"
                :key="s"
                class="speed-btn"
                :class="{ active: replaySpeed === s }"
                @click="setSpeed(s)"
              >
                {{ s }}x
              </button>
            </div>
          </div>
        </div>

        <!-- Tab 1: Terminal Log Text View -->
        <div v-if="activeConsoleTab === 'logs'" ref="logsTerminalRef" class="terminal-body">
          <div v-if="logs.length === 0" class="terminal-empty">
            点击顶部 ▶️ "一键运行脚本" 按钮，此处将按行实时流式打字输出日志...
          </div>
          <div v-for="(log, idx) in logs" :key="idx" class="log-line" :class="log.type">
            <span class="log-time">[{{ log.time }}]</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
        </div>

        <!-- Tab 2: Visual Step Replay Player Screen -->
        <div v-else class="replay-player-body">
          <div v-if="traceFrames.length === 0" class="replay-empty">
            <div class="empty-icon-replay">🎬</div>
            <p>暂无捕获的运行画面。运行脚本时将自动高频捕获每一步网页画面快照。</p>
          </div>

          <div v-else class="player-screen-container">
            <div class="screen-frame-box">
              <img
                v-if="currentFrame"
                :src="currentFrame.frameUrl"
                class="screenshot-img"
                alt="Chrome Tab Screenshot"
              />

              <div v-if="currentFrame" class="subtitle-overlay">
                <span class="sub-step"
                  >Step #{{ currentFrame.step }} [{{ currentFrame.time }}]</span
                >
                <span class="sub-text">{{ currentFrame.message }}</span>
              </div>
            </div>

            <div class="player-timeline-bar">
              <input
                v-model.number="currentFrameIndex"
                type="range"
                min="0"
                :max="traceFrames.length - 1"
                class="step-slider"
              />
              <span class="step-indicator">
                步骤 {{ currentFrameIndex + 1 }} / {{ traceFrames.length }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 🗄️ SQLite Database Data Viewer Modal -->
    <div v-if="showDbModal" class="modal-overlay" @click.self="showDbModal = false">
      <div class="db-modal-card">
        <div class="modal-header">
          <div class="modal-title">
            <span class="db-header-icon">🗄️</span>
            <h3>SQLite 爬取数据查看器</h3>
          </div>
          <button class="btn-close-modal" @click="showDbModal = false">✕</button>
        </div>

        <div class="modal-toolbar">
          <div class="table-selector-group">
            <label class="db-label">选择数据表:</label>
            <select v-model="selectedTable" class="table-select" @change="fetchDbRows">
              <option v-for="t in dbTables" :key="t.name" :value="t.name">
                {{ t.name }} ({{ t.count }} 条数据)
              </option>
            </select>
          </div>

          <div class="search-box-group">
            <input
              v-model="dbSearchInput"
              type="text"
              placeholder="按 eid / 名称搜索..."
              class="db-search-input"
              @keyup.enter="fetchDbRows"
            />
            <button class="btn-search-db" @click="fetchDbRows">搜索</button>
          </div>

          <div class="db-action-buttons">
            <button class="btn-export-json" @click="exportDbJson" :disabled="dbRows.length === 0">
              📥 导出 JSON
            </button>
            <button class="btn-clear-db" @click="clearDbTable" :disabled="!selectedTable">
              🗑️ 清空表
            </button>
          </div>
        </div>

        <div class="modal-body db-grid-body">
          <div v-if="isLoadingDb" class="db-loading">
            <span>正在查询 SQLite 数据库...</span>
          </div>

          <div v-else-if="dbRows.length === 0" class="db-empty">
            暂无爬取存入的数据，在脚本中使用 <code>db.insert()</code> 或
            <code>db.upsert()</code> 自动存入。
          </div>

          <div v-else class="db-table-wrapper">
            <table class="data-grid-table">
              <thead>
                <tr>
                  <th v-for="col in dbColumns" :key="col">{{ col }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, idx) in dbRows" :key="idx">
                  <td v-for="col in dbColumns" :key="col" :title="String(row[col])">
                    {{ row[col] }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- ✨ AI Generator Modal -->
    <div v-if="showAiModal" class="modal-overlay" @click.self="showAiModal = false">
      <div class="ai-modal-card">
        <div class="modal-header">
          <div class="modal-title">
            <span class="ai-sparkle-icon">✨</span>
            <h3>AI 智能生成自动化脚本</h3>
          </div>
          <button class="btn-close-modal" @click="showAiModal = false">✕</button>
        </div>

        <div class="modal-body">
          <div class="input-group">
            <label class="input-label"
              >描述你的自动化需求 (支持自动保存数据到 SQLite 数据库与去重)：</label
            >
            <textarea
              v-model="aiPromptInput"
              class="ai-prompt-textarea"
              placeholder="例如：自动提取当前页面上的列表数据，包含标题、价格和链接，并使用 db.upsert() 去重保存到 SQLite 数据库中..."
              rows="4"
            ></textarea>
          </div>

          <div class="preset-section">
            <span class="preset-label">💡 常用需求快捷模板 (自动整合 SQLite 数据库):</span>
            <div class="preset-chips">
              <button
                class="chip-btn"
                @click="
                  applyPresetTag(
                    '自动建表 cbg_items，提取当前页面列表元素的名称、价格与链接，并使用 db.exists() 判断去重后通过 db.upsert() 存入 SQLite 数据库',
                  )
                "
              >
                📊 提取数据并去重存入 SQLite
              </button>

              <button
                class="chip-btn"
                @click="applyPresetTag('分析并观察当前页面上的主要按钮、输入框和可交互链接')"
              >
                🎯 观察交互元素
              </button>

              <button
                class="chip-btn"
                @click="applyPresetTag('在页面的搜索框中输入搜索词并自动点击提交')"
              >
                🔍 搜索并点击
              </button>

              <button
                class="chip-btn"
                @click="applyPresetTag('查询 SQLite 数据库中 cbg_items 表的数据总量并在控制台打印')"
              >
                🗄️ 读取 SQLite 数据库
              </button>
            </div>
          </div>

          <div v-if="editorContent.trim()" class="modify-mode-toggle">
            <label class="checkbox-label">
              <input v-model="aiIncrementalModify" type="checkbox" />
              <span>结合当前编辑器中的代码进行增量修改 (若取消勾选则全新生成)</span>
            </label>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" @click="showAiModal = false">取消</button>
          <button
            class="btn-generate-ai"
            :disabled="isAiGenerating || !aiPromptInput.trim()"
            @click="generateScriptWithAi"
          >
            <span v-if="isAiGenerating">🧠 AI 思考并生成中...</span>
            <span v-else>✨ 一键生成 / 修改代码</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 📜 Version History & Trace Management Drawer -->
    <div v-if="showHistoryDrawer" class="drawer-overlay" @click.self="showHistoryDrawer = false">
      <div class="history-drawer">
        <div class="drawer-header">
          <div class="drawer-tabs">
            <button
              class="drawer-tab-btn"
              :class="{ active: drawerActiveTab === 'versions' }"
              @click="drawerActiveTab = 'versions'"
            >
              📜 代码版本历史 ({{ historyList.length }})
            </button>
            <button
              class="drawer-tab-btn"
              :class="{ active: drawerActiveTab === 'traces' }"
              @click="drawerActiveTab = 'traces'"
            >
              🎬 运行 Trace 轨迹 ({{ allTracesList.length }})
            </button>
          </div>
          <button class="btn-close-modal" @click="showHistoryDrawer = false">✕</button>
        </div>

        <div class="drawer-body">
          <!-- Tab 1: Code Versions -->
          <div v-if="drawerActiveTab === 'versions'" class="drawer-tab-content">
            <div v-if="historyList.length > 0" class="drawer-batch-bar">
              <label class="batch-select-all">
                <input
                  type="checkbox"
                  :checked="isAllHistorySelected"
                  @change="toggleSelectAllHistory"
                />
                <span>全选</span>
              </label>
              <span class="batch-count-info">已选 {{ selectedHistoryIds.length }} 项</span>
              <button
                class="btn-batch-delete"
                :disabled="selectedHistoryIds.length === 0"
                @click="batchDeleteHistory"
              >
                🗑️ 批量删除
              </button>
            </div>

            <div v-if="isLoadingHistory" class="history-loading">
              <span>正在读取历史版本...</span>
            </div>

            <div v-else-if="historyList.length === 0" class="history-empty">
              暂无历史快照，每次保存或 AI 生成修改时会自动记录代码版本。
            </div>

            <div v-else class="history-timeline">
              <div v-for="(item, idx) in historyList" :key="item.id" class="history-card">
                <div class="history-card-header">
                  <input
                    type="checkbox"
                    :value="item.id"
                    v-model="selectedHistoryIds"
                    class="card-checkbox"
                  />
                  <span class="version-badge">v{{ historyList.length - idx }}</span>
                  <span class="history-label">{{ item.label }}</span>
                  <span class="history-time">{{ item.timestamp }}</span>
                </div>

                <div class="history-actions">
                  <button
                    class="hist-btn preview"
                    @click="
                      previewHistoryContent =
                        previewHistoryContent === item.content ? null : item.content
                    "
                  >
                    {{ previewHistoryContent === item.content ? "隐藏" : "👁️ 预览代码" }}
                  </button>
                  <button class="hist-btn restore" @click="restoreHistoryVersion(item.id)">
                    ↺ 恢复此版本
                  </button>
                  <button class="hist-btn delete" @click="deleteHistoryVersion(item.id)">
                    🗑️ 删除快照
                  </button>
                </div>

                <pre v-if="previewHistoryContent === item.content" class="preview-code-block">{{
                  item.content
                }}</pre>
              </div>
            </div>
          </div>

          <!-- Tab 2: Execution Traces -->
          <div v-else class="drawer-tab-content">
            <div v-if="allTracesList.length > 0" class="drawer-batch-bar">
              <label class="batch-select-all">
                <input
                  type="checkbox"
                  :checked="isAllTracesSelected"
                  @change="toggleSelectAllTraces"
                />
                <span>全选</span>
              </label>
              <span class="batch-count-info">已选 {{ selectedTraceRunIds.length }} 项</span>
              <button
                class="btn-batch-delete"
                :disabled="selectedTraceRunIds.length === 0"
                @click="batchDeleteTraces"
              >
                🗑️ 批量删除
              </button>
            </div>

            <div v-if="isLoadingTraces" class="history-loading">
              <span>正在读取 Trace 轨迹...</span>
            </div>

            <div v-else-if="allTracesList.length === 0" class="history-empty">
              暂无运行画面轨迹。点击 ▶️ "一键运行" 时将自动捕获网页画面并展示在这里。
            </div>

            <div v-else class="history-timeline">
              <div v-for="t in allTracesList" :key="t.runId" class="history-card trace-card">
                <div class="history-card-header">
                  <input
                    type="checkbox"
                    :value="t.runId"
                    v-model="selectedTraceRunIds"
                    class="card-checkbox"
                  />
                  <span class="trace-badge">🎬 {{ t.runId.slice(-6) }}</span>
                  <span class="history-label">{{ t.filename }}</span>
                  <span class="history-time">{{ t.timestamp }}</span>
                </div>

                <div class="trace-meta-info">
                  <span
                    >📸 画面: <strong>{{ t.totalFrames }} 帧</strong></span
                  >
                  <span class="meta-divider">|</span>
                  <span
                    >📜 控制台日志:
                    <strong>{{ t.logs ? t.logs.length : t.totalLogs || 0 }} 条</strong></span
                  >
                </div>

                <div class="history-actions">
                  <button class="hist-btn logs-toggle-btn" @click="toggleTraceLog(t.runId)">
                    📜 控制台文本日志 ({{ t.logs ? t.logs.length : t.totalLogs || 0 }})
                    <span class="accordion-arrow">{{
                      expandedLogRunIds.includes(t.runId) ? "▲" : "▼"
                    }}</span>
                  </button>
                  <button class="hist-btn replay-trace-btn" @click="loadTraceReplay(t.runId)">
                    🎬 观看画面回放
                  </button>
                  <button class="hist-btn delete" @click="deleteTraceRun(t.runId)">🗑️ 删除</button>
                </div>

                <!-- Collapsible Console Text Log Accordion -->
                <div v-if="expandedLogRunIds.includes(t.runId)" class="trace-logs-accordion">
                  <div class="accordion-header">
                    <span>📜 控制台实时日志记录</span>
                    <span class="accordion-count">{{ t.logs ? t.logs.length : 0 }} 条记录</span>
                  </div>
                  <div v-if="t.logs && t.logs.length > 0" class="trace-logs-list">
                    <div
                      v-for="(log, idx) in t.logs"
                      :key="idx"
                      class="trace-log-line"
                      :class="log.type || 'log'"
                    >
                      <span class="log-time">[{{ log.time }}]</span>
                      <span class="log-msg">{{ log.message }}</span>
                    </div>
                  </div>
                  <div v-else class="trace-logs-empty">暂无此运行记录的详细控制台日志</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scripts-page {
  display: flex;
  gap: 1.5rem;
  min-height: calc(100vh - 120px);
}

/* File Sidebar */
.file-sidebar {
  width: 260px;
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-sm);
  flex-shrink: 0;
}

.sidebar-header {
  padding: 1rem 1rem;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.sidebar-header h3 {
  font-size: 0.9rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.sidebar-actions-group {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.btn-ai-sidebar {
  background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
  color: white;
  border: none;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(139, 92, 246, 0.3);
  transition: all 0.2s ease;
}

.btn-ai-sidebar:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(139, 92, 246, 0.4);
}

.btn-new {
  background-color: #e0e7ff;
  color: #4f46e5;
  border: none;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-new:hover {
  background-color: #4f46e5;
  color: white;
}

.sidebar-loading {
  padding: 2rem;
  text-align: center;
  color: #94a3b8;
  font-size: 0.85rem;
}

.file-list {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  overflow-y: auto;
}

.file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  color: #475569;
}

.file-item:hover {
  background-color: #f1f5f9;
  color: #0f172a;
}

.file-item.active {
  background-color: #e0e7ff;
  color: #4f46e5;
  font-weight: 600;
}

.file-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.file-name {
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-delete {
  border: none;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease;
  font-size: 0.85rem;
}

.file-item:hover .btn-delete {
  opacity: 0.6;
}

.btn-delete:hover {
  opacity: 1 !important;
}

/* Workspace */
.workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}

/* Toolbar */
.toolbar {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 0.85rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  box-shadow: var(--shadow-sm);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.filename-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #64748b;
  white-space: nowrap;
}

.filename-input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  font-family: var(--font-mono, monospace);
  color: #0f172a;
  outline: none;
  width: 170px;
}

.filename-input:focus {
  border-color: #4f46e5;
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.1);
}

/* Target Tab Component */
.target-tab-container {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.tab-trigger-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.tab-trigger-btn {
  background-color: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.35rem 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 240px;
  max-width: 320px;
  justify-content: space-between;
}

.tab-trigger-btn:hover {
  border-color: #4f46e5;
  background-color: #ffffff;
  box-shadow: 0 2px 6px rgba(79, 70, 229, 0.08);
}

.trigger-content {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  flex: 1;
}

.trigger-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
  flex-shrink: 0;
}

.trigger-icon-fallback {
  font-size: 0.9rem;
  flex-shrink: 0;
}

.trigger-badge {
  font-size: 0.75rem;
  font-weight: 700;
  color: #4f46e5;
  background-color: #e0e7ff;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  flex-shrink: 0;
}

.trigger-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trigger-empty {
  font-size: 0.85rem;
  color: #94a3b8;
}

.chevron-icon {
  color: #64748b;
  flex-shrink: 0;
}

.btn-refresh-tabs {
  background-color: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #475569;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-refresh-tabs:hover {
  background-color: #e2e8f0;
  color: #0f172a;
}

.btn-refresh-tabs.spinning svg {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Popover Dropdown */
.tab-popover-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 340px;
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow:
    0 10px 25px -5px rgba(0, 0, 0, 0.1),
    0 8px 10px -6px rgba(0, 0, 0, 0.05);
  z-index: 50;
  overflow: hidden;
}

.popover-header {
  padding: 0.65rem 0.85rem;
  background-color: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
  color: #64748b;
}

.popover-count {
  color: #4f46e5;
}

.popover-body {
  max-height: 260px;
  overflow-y: auto;
  padding: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.popover-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.popover-item:hover {
  background-color: #f1f5f9;
}

.popover-item.selected {
  background-color: #e0e7ff;
}

.item-left {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.item-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.item-icon-fallback {
  font-size: 0.85rem;
}

.item-index {
  font-size: 0.75rem;
  font-weight: 700;
  color: #4f46e5;
  background-color: #ffffff;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
}

.item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.item-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-url {
  font-size: 0.75rem;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-check {
  font-weight: 700;
  color: #4f46e5;
  font-size: 0.85rem;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-db-view {
  background-color: #0284c7;
  color: white;
  border: none;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 4px rgba(2, 132, 199, 0.25);
}

.btn-db-view:hover {
  background-color: #0369a1;
  transform: translateY(-1px);
}

.btn-ai-gradient {
  background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
  color: white;
  border: none;
  padding: 0.5rem 0.9rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 6px rgba(139, 92, 246, 0.3);
}

.btn-ai-gradient:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(139, 92, 246, 0.4);
}

.btn-history {
  background-color: #f8fafc;
  border: 1px solid #cbd5e1;
  color: #475569;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-history:hover {
  background-color: #f1f5f9;
  color: #0f172a;
}

.btn-trace {
  background-color: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #15803d;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-trace:hover {
  background-color: #dcfce7;
  color: #166534;
}

.btn-secondary {
  background-color: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-secondary:hover:not(:disabled) {
  background-color: #e2e8f0;
}

.btn-save {
  background-color: #e0e7ff;
  color: #4f46e5;
  border: 1px solid #c7d2fe;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-save:hover:not(:disabled) {
  background-color: #4f46e5;
  color: white;
}

.btn-run {
  background-color: #10b981;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 4px rgba(16, 185, 129, 0.25);
}

.btn-run:hover {
  background-color: #059669;
  transform: translateY(-1px);
}

.btn-run.executing {
  background-color: #3b82f6;
  box-shadow: 0 2px 4px rgba(59, 130, 246, 0.25);
}

.btn-running-cancel .btn-text-default {
  display: inline;
}

.btn-running-cancel .btn-text-hover {
  display: none;
}

.btn-running-cancel:hover {
  background-color: #ef4444 !important;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35) !important;
  transform: translateY(-1px);
}

.btn-running-cancel:hover .btn-text-default {
  display: none;
}

.btn-running-cancel:hover .btn-text-hover {
  display: inline;
}

/* AI Toast Banner */
.ai-toast-banner {
  background-color: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #166534;
  padding: 0.75rem 1.25rem;
  border-radius: 10px;
  font-size: 0.875rem;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  box-shadow: var(--shadow-sm);
}

.btn-run-now {
  background-color: #16a34a;
  color: white;
  border: none;
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-run-now:hover {
  background-color: #15803d;
}

.toast-close {
  border: none;
  background: transparent;
  color: #166534;
  cursor: pointer;
}

/* Validation Banner */
.validation-banner {
  padding: 0.85rem 1.25rem;
  border-radius: 10px;
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.validation-banner.valid {
  background-color: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #047857;
}

.validation-banner.invalid {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
}

.banner-title {
  font-weight: 700;
}

.banner-errors {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 0.25rem;
}

.err-line {
  font-family: var(--font-mono, monospace);
  font-size: 0.825rem;
}

/* Dynamic JSDoc Script Parameters Bar */
.script-params-bar {
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 0.85rem 1.15rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.params-bar-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.params-bar-title {
  font-weight: 600;
  font-size: 0.9rem;
  color: #1e293b;
}

.params-bar-subtitle {
  font-size: 0.78rem;
  color: #64748b;
}

.params-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.85rem 1.25rem;
}

.param-form-item {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.param-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: #334155;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.param-name-badge {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  color: #2563eb;
  background-color: #dbeafe;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}

.param-input,
.param-select {
  padding: 0.4rem 0.65rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.85rem;
  background-color: #ffffff;
  color: #0f172a;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.param-input:focus,
.param-select:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.param-switch {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  margin-top: 0.2rem;
  user-select: none;
}

.param-switch input {
  display: none;
}

.switch-slider {
  width: 36px;
  height: 20px;
  background-color: #cbd5e1;
  border-radius: 20px;
  position: relative;
  transition: background-color 0.2s ease;
}

.switch-slider::before {
  content: "";
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background-color: #ffffff;
  border-radius: 50%;
  transition: transform 0.2s ease;
}

.param-switch input:checked + .switch-slider {
  background-color: #3b82f6;
}

.param-switch input:checked + .switch-slider::before {
  transform: translateX(16px);
}

.switch-text {
  font-size: 0.82rem;
  color: #475569;
}

/* Code Editor */
.editor-container {
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.cm-editor-wrap {
  min-height: 260px;
}

.cm-editor-wrap :deep(.cm-editor) {
  min-height: 260px;
  font-size: 0.9rem;
  line-height: 1.5;
}

.cm-editor-wrap :deep(.cm-editor.cm-focused) {
  outline: none;
}

.cm-editor-wrap :deep(.cm-scroller) {
  min-height: 260px;
  resize: vertical;
  overflow: auto;
}

/* Terminal Console & Visual Replay Player */
.terminal-panel {
  background-color: #0f172a;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
}

.terminal-header {
  background-color: #1e293b;
  padding: 0.5rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.console-tabs {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.console-tab-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  transition: all 0.2s ease;
}

.console-tab-btn.active {
  background-color: #334155;
  color: #38bdf8;
}

.frame-badge {
  background-color: #38bdf8;
  color: #0f172a;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
}

.replay-controls-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.player-btn {
  background-color: #334155;
  color: white;
  border: 1px solid #475569;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.player-btn.play-main {
  background-color: #10b981;
  border-color: #059669;
  font-weight: 600;
}

.player-btn:hover {
  background-color: #475569;
}

.speed-selector {
  display: flex;
  gap: 0.25rem;
  background-color: #0f172a;
  padding: 0.2rem;
  border-radius: 6px;
}

.speed-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}

.speed-btn.active {
  background-color: #475569;
  color: white;
}

.terminal-body {
  padding: 1rem;
  height: 200px;
  overflow-y: auto;
  font-family: Consolas, Monaco, monospace;
  font-size: 0.85rem;
  line-height: 1.6;
  color: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.terminal-empty {
  color: #64748b;
  font-style: italic;
  font-size: 0.85rem;
}

.log-line {
  display: flex;
  gap: 0.75rem;
  word-break: break-all;
}

.log-time {
  color: #64748b;
  flex-shrink: 0;
}

.log-line.log .log-msg {
  color: #38bdf8;
}

.log-line.done .log-msg {
  color: #4ade80;
  font-weight: 600;
}

.log-line.error .log-msg {
  color: #f87171;
  font-weight: 600;
}

/* Visual Replay Player Screen */
.replay-player-body {
  padding: 1rem;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.replay-empty {
  text-align: center;
  color: #64748b;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.empty-icon-replay {
  font-size: 2rem;
}

.player-screen-container {
  width: 100%;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.screen-frame-box {
  position: relative;
  width: 100%;
  height: 380px;
  background-color: #020617;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #334155;
  display: flex;
  align-items: center;
  justify-content: center;
}

.screenshot-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.subtitle-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(4px);
  padding: 0.6rem 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: #f8fafc;
}

.sub-step {
  font-size: 0.75rem;
  font-weight: 700;
  color: #38bdf8;
  background-color: rgba(56, 189, 248, 0.15);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  flex-shrink: 0;
}

.sub-text {
  font-size: 0.85rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-timeline-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  background-color: #1e293b;
  padding: 0.5rem 1rem;
  border-radius: 8px;
}

.step-slider {
  flex: 1;
  cursor: pointer;
  accent-color: #38bdf8;
}

.step-indicator {
  font-size: 0.8rem;
  font-weight: 600;
  color: #38bdf8;
  white-space: nowrap;
}

/* Modals & Overlays */
.modal-overlay,
.drawer-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* DB Modal Card */
.db-modal-card {
  width: 90%;
  max-width: 960px;
  background-color: #ffffff;
  border-radius: 16px;
  box-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.1),
    0 8px 10px -6px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 85vh;
}

.db-header-icon {
  font-size: 1.2rem;
}

.modal-toolbar {
  padding: 0.85rem 1.5rem;
  background-color: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.table-selector-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.db-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #475569;
}

.table-select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.35rem 0.75rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: #0f172a;
  background-color: #ffffff;
}

.search-box-group {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.db-search-input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.35rem 0.75rem;
  font-size: 0.85rem;
  outline: none;
  width: 220px;
}

.btn-search-db {
  background-color: #e2e8f0;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.db-action-buttons {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-export-json {
  background-color: #e0e7ff;
  border: 1px solid #c7d2fe;
  color: #4f46e5;
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-clear-db {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.db-grid-body {
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
}

.db-loading,
.db-empty {
  text-align: center;
  color: #94a3b8;
  padding: 3rem 1rem;
  font-size: 0.9rem;
}

.db-table-wrapper {
  overflow-x: auto;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.data-grid-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  text-align: left;
}

.data-grid-table th {
  background-color: #f8fafc;
  color: #475569;
  font-weight: 700;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid #e2e8f0;
  white-space: nowrap;
}

.data-grid-table td {
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid #f1f5f9;
  color: #0f172a;
  max-width: 300px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.data-grid-table tr:hover {
  background-color: #f8fafc;
}

/* AI Modal Card */
.ai-modal-card {
  width: 90%;
  max-width: 600px;
  background-color: #ffffff;
  border-radius: 16px;
  box-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.1),
    0 8px 10px -6px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.modal-title h3 {
  font-size: 1.1rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.ai-sparkle-icon {
  font-size: 1.2rem;
}

.btn-close-modal {
  border: none;
  background: transparent;
  font-size: 1.1rem;
  color: #64748b;
  cursor: pointer;
}

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.input-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: #334155;
}

.ai-prompt-textarea {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 0.85rem;
  font-size: 0.9rem;
  font-family: inherit;
  color: #0f172a;
  outline: none;
  resize: vertical;
}

.ai-prompt-textarea:focus {
  border-color: #8b5cf6;
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
}

.preset-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preset-label {
  font-size: 0.8rem;
  color: #64748b;
  font-weight: 500;
}

.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.chip-btn {
  background-color: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #475569;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.chip-btn:hover {
  background-color: #e0e7ff;
  color: #4f46e5;
  border-color: #c7d2fe;
}

.modify-mode-toggle {
  background-color: #f8fafc;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #475569;
  cursor: pointer;
}

.modal-footer {
  padding: 1rem 1.5rem;
  background-color: #f8fafc;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
}

.btn-cancel {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-generate-ai {
  background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
  color: white;
  border: none;
  padding: 0.55rem 1.25rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 10px rgba(139, 92, 246, 0.3);
  transition: all 0.2s ease;
}

.btn-generate-ai:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(139, 92, 246, 0.4);
}

.btn-generate-ai:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* History Drawer */
.history-drawer {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 440px;
  background-color: #ffffff;
  box-shadow: -10px 0 25px -5px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
}

.drawer-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.drawer-tabs {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.drawer-tab-btn {
  background-color: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #64748b;
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.drawer-tab-btn.active {
  background-color: #4f46e5;
  color: white;
  border-color: #4f46e5;
}

.drawer-body {
  padding: 1.25rem;
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.drawer-batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.85rem;
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}

.batch-select-all {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-weight: 600;
  color: #334155;
  cursor: pointer;
}

.batch-count-info {
  font-size: 0.8rem;
  color: #64748b;
}

.btn-batch-delete {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  padding: 0.3rem 0.65rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-batch-delete:hover:not(:disabled) {
  background-color: #b91c1c;
  color: white;
}

.btn-batch-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.card-checkbox {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: #4f46e5;
}

.history-loading,
.history-empty {
  text-align: center;
  color: #94a3b8;
  padding: 3rem 1rem;
  font-size: 0.9rem;
}

.history-timeline {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.history-card {
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.history-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.version-badge {
  font-size: 0.75rem;
  font-weight: 700;
  color: #8b5cf6;
  background-color: #f3e8ff;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}

.trace-badge {
  font-size: 0.75rem;
  font-weight: 700;
  color: #0284c7;
  background-color: #e0f2fe;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}

.trace-meta-info {
  font-size: 0.8rem;
  color: #64748b;
}

.history-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #0f172a;
  flex: 1;
}

.history-time {
  font-size: 0.75rem;
  color: #94a3b8;
}

.history-actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.hist-btn {
  padding: 0.35rem 0.65rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.replay-trace-btn {
  background-color: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #047857;
}

.replay-trace-btn:hover {
  background-color: #10b981;
  color: white;
}

.hist-btn.preview {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
}

.hist-btn.restore {
  background-color: #e0e7ff;
  border: 1px solid #c7d2fe;
  color: #4f46e5;
}

.hist-btn.restore:hover {
  background-color: #4f46e5;
  color: white;
}

.hist-btn.delete {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
}

.hist-btn.delete:hover {
  background-color: #b91c1c;
  color: white;
}

.logs-toggle-btn {
  background-color: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #1d4ed8;
}

.logs-toggle-btn:hover {
  background-color: #3b82f6;
  color: white;
}

.accordion-arrow {
  font-size: 0.65rem;
  margin-left: 0.2rem;
}

.meta-divider {
  color: #cbd5e1;
  font-size: 0.75rem;
}

.trace-logs-accordion {
  margin-top: 0.65rem;
  background-color: #0f172a;
  border-radius: 8px;
  border: 1px solid #1e293b;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.accordion-header {
  background-color: #1e293b;
  padding: 0.4rem 0.75rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 700;
  color: #94a3b8;
  border-bottom: 1px solid #334155;
}

.accordion-count {
  background-color: #334155;
  color: #cbd5e1;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.7rem;
}

.trace-logs-list {
  padding: 0.6rem 0.75rem;
  max-height: 200px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.trace-log-line {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  word-break: break-all;
  line-height: 1.4;
}

.trace-log-line .log-time {
  color: #64748b;
  font-size: 0.72rem;
  flex-shrink: 0;
}

.trace-log-line .log-msg {
  color: #e2e8f0;
}

.trace-log-line.error .log-msg {
  color: #f87171;
}

.trace-log-line.done .log-msg {
  color: #4ade80;
}

.trace-log-line.cancelled .log-msg {
  color: #fcd34d;
}

.trace-log-time {
  color: #64748b;
  font-size: 0.72rem;
  flex-shrink: 0;
}

.trace-log-msg {
  color: #e2e8f0;
}

.trace-log-line.error .trace-log-msg {
  color: #f87171;
}

.trace-logs-empty {
  padding: 0.75rem;
  color: #64748b;
  font-size: 0.75rem;
  text-align: center;
}

.preview-code-block {
  background-color: #0f172a;
  color: #f8fafc;
  padding: 0.75rem;
  border-radius: 6px;
  font-family: Consolas, Monaco, monospace;
  font-size: 0.8rem;
  max-height: 200px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
}
</style>
