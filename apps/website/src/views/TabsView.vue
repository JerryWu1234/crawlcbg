<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";

interface Tab {
  index: number;
  title: string;
  url: string;
  favicon: string;
}

interface ScriptItem {
  filename: string;
  content: string;
}

const tabs = ref<Tab[]>([]);
const scripts = ref<ScriptItem[]>([]);
const selectedScriptPerTab = ref<Record<number, string>>({});
const isLoading = ref(true);
const error = ref<string | null>(null);
const searchQuery = ref("");
const autoRefresh = ref(false);
let refreshInterval: number | null = null;
const switchingIndex = ref<number | null>(null);

// Historical Trace Logs Modal State
interface HistoricalTraceRun {
  runId: string;
  filename: string;
  timestamp: string;
  totalFrames: number;
  totalLogs?: number;
  logs?: Array<{ time: string; message: string; type?: string }>;
  frames?: Array<{ step: number; time: string; message: string; frameUrl: string }>;
}

const showHistoryLogModal = ref(false);
const historyLogTargetTitle = ref<string>("");
const historicalTraces = ref<HistoricalTraceRun[]>([]);
const selectedRunId = ref<string>("");
const selectedRunDetail = ref<HistoricalTraceRun | null>(null);
const isLoadingHistoryLogs = ref(false);
const historyModalActiveTab = ref<"logs" | "frames">("logs");
const activeFrameIdx = ref<number>(0);

// Unique distinct frame snapshots (deduplicate identical consecutive frameUrls)
const uniqueFrames = computed(() => {
  if (!selectedRunDetail.value?.frames || selectedRunDetail.value.frames.length === 0) {
    return [];
  }
  const result: Array<{ step: number; time: string; message: string; frameUrl: string }> = [];
  const seenUrls = new Set<string>();

  for (const f of selectedRunDetail.value.frames) {
    if (f.frameUrl && !seenUrls.has(f.frameUrl)) {
      seenUrls.add(f.frameUrl);
      result.push(f);
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
          (p) => p.url === target.url || (p.url && p.url.includes(targetHost)),
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
const executingTab = ref<Tab | null>(null);
const executingScript = ref<string>("");
const isExecuting = ref(false);
const executionLogs = ref<Array<{ type: string; time?: string; message?: string }>>([]);
const traceFrames = ref<Array<{ step: number; time: string; message: string; frameUrl: string }>>(
  [],
);
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
        tabs.value.forEach((t) => {
          if (!selectedScriptPerTab.value[t.index]) {
            selectedScriptPerTab.value[t.index] = scripts.value[0].filename;
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

const runScriptOnTab = async (tab: Tab) => {
  const scriptName = selectedScriptPerTab.value[tab.index] || scripts.value[0]?.filename;
  if (!scriptName) {
    alert("暂无可用脚本，请先在【脚本管理】页面创建或生成脚本！");
    return;
  }

  await switchToTab(tab.index);

  executingTab.value = tab;
  executingScript.value = scriptName;
  isExecuting.value = true;
  executionLogs.value = [];
  traceFrames.value = [];
  currentFrameIndex.value = 0;

  executionLogs.value.push({
    type: "log",
    time: new Date().toLocaleTimeString(),
    message: `🔌 开始在 Tab #${tab.index + 1} ("${tab.title || tab.url}") 上运行脚本 [${scriptName}]...`,
  });

  const targetUrlParam = tab.url ? `&targetUrl=${encodeURIComponent(tab.url)}` : "";
  const url = `http://localhost:3001/api/scripts/execute/stream?filename=${encodeURIComponent(
    scriptName,
  )}&tabIndex=${tab.index}${targetUrlParam}`;

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
};

const closeExecutionModal = () => {
  stopExecutionModal();
  executingTab.value = null;
};

// Filter tabs by search query
const filteredTabs = computed(() => {
  if (!searchQuery.value.trim()) return tabs.value;
  const q = searchQuery.value.toLowerCase();
  return tabs.value.filter(
    (t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q),
  );
});

// Compute unique domains count
const uniqueDomainsCount = computed(() => {
  const domains = new Set<string>();
  tabs.value.forEach((t) => {
    try {
      if (t.url) {
        domains.add(new URL(t.url).hostname);
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

const copyUrl = (url: string, index: number) => {
  navigator.clipboard.writeText(url);
  copiedIndex.value = index;
  setTimeout(() => {
    copiedIndex.value = null;
  }, 2000);
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
interface PinnedTab {
  id: string;
  title: string;
  url: string;
  scriptFilename?: string;
  created_at?: string;
}

const pinnedTabs = ref<PinnedTab[]>([]);
const isLoadingPinned = ref(false);
const showPinnedModal = ref(false);
const pinnedForm = ref({
  id: "",
  title: "",
  url: "",
  scriptFilename: "",
});

const fetchPinnedTabs = async () => {
  isLoadingPinned.value = true;
  try {
    const res = await fetch("http://localhost:3001/api/tabs/pinned");
    if (res.ok) {
      const data = await res.json();
      pinnedTabs.value = data.pinnedTabs || [];
    }
  } catch (err) {
    console.error("Fetch pinned tabs error:", err);
  } finally {
    isLoadingPinned.value = false;
  }
};

const getPinnedTabStatus = (pinned: PinnedTab) => {
  if (!tabs.value || tabs.value.length === 0)
    return { type: "closed", text: "⚪ 未打开 (点击将自动创建页签并载入)", index: -1 };

  const exactTab = tabs.value.find((t) => t.url === pinned.url);
  if (exactTab) {
    return {
      type: "exact",
      text: `🟢 已在 Chrome 打开 (Tab #${exactTab.index + 1} · URL 完全一致)`,
      index: exactTab.index,
    };
  }

  try {
    const targetDomain = new URL(pinned.url).hostname;
    const domainTab = tabs.value.find((t) => t.url && t.url.includes(targetDomain));
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

const pinLiveTab = (tab: Tab) => {
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

    const targetTab = tabs.value.find((t) => t.index === tabIndex) || {
      index: tabIndex,
      title: pinned.title,
      url: pinned.url,
      favicon: "",
    };

    selectedScriptPerTab.value[tabIndex] = scriptName;
    await runScriptOnTab(targetTab);
  } catch (err: any) {
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

const handleDocumentClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (!target.closest(".custom-script-picker")) {
    openScriptPickerTab.value = null;
  }
};

onMounted(() => {
  fetchTabs();
  fetchPinnedTabs();
  document.addEventListener("click", handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener("click", handleDocumentClick);
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div class="tabs-page">
    <!-- Stat Cards Overview -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon tabs-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="3" y1="9" x2="21" y2="9"></line>
            <line x1="9" y1="21" x2="9" y2="9"></line>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-label">总标签页数量</span>
          <span class="stat-value">{{ tabs.length }}</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon domain-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path
              d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
            ></path>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-label">独立域名种类</span>
          <span class="stat-value">{{ uniqueDomainsCount }}</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon cdp-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-label">Stagehand / CDP 连接</span>
          <span class="stat-value status-badge-online">在线 (Active)</span>
        </div>
      </div>
    </div>

    <!-- 📌 Pinned Resident Tab Presets Grid Section -->
    <div v-if="pinnedTabs.length > 0" class="pinned-section">
      <div class="section-title-bar">
        <div class="section-title">
          <span class="pin-badge-icon">📌</span>
          <h3>常驻置顶页签</h3>
          <span class="section-subtitle">固定预设网页 · 自动检查开页纠偏重定向一键自动化起航</span>
        </div>
        <div class="title-bar-actions">
          <span class="pinned-count">共 {{ pinnedTabs.length }} 个常驻预设</span>
          <button class="btn-add-pinned-small" @click="showPinnedModal = true">+ 新建预设</button>
        </div>
      </div>

      <div class="pinned-grid">
        <div v-for="pinned in pinnedTabs" :key="pinned.id" class="pinned-card">
          <div class="pinned-card-header">
            <span class="pinned-tag">📌 常驻预设</span>
            <span class="pinned-status-badge" :class="getPinnedTabStatus(pinned).type">
              {{ getPinnedTabStatus(pinned).text }}
            </span>
          </div>

          <div class="pinned-card-body">
            <h4 class="pinned-title" :title="pinned.title">{{ pinned.title }}</h4>
            <a :href="pinned.url" target="_blank" class="pinned-url" :title="pinned.url">
              🔗 {{ pinned.url }}
            </a>
            <div class="pinned-script-info">
              <span class="label">默认执行脚本:</span>
              <span class="script-badge">📄 {{ pinned.scriptFilename || "无 (默认最新)" }}</span>
            </div>
          </div>

          <div class="pinned-card-footer">
            <button
              class="btn-launch-pinned"
              @click="launchPinnedTab(pinned)"
              title="自动查找/新建页签并导航至目标 URL 一键执行脚本"
            >
              🚀 自动打开并运行
            </button>
            <button
              class="action-btn logs-btn-tab"
              @click="openHistoryLogModal(pinned)"
              title="查看此预设网页的历史执行日志"
            >
              <span>📜 日志</span>
            </button>
            <button
              class="btn-delete-pinned"
              @click="deletePinnedTab(pinned.id)"
              title="移除此常驻预设"
            >
              🗑️ 移除
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Filter & Controls Bar -->
    <div class="controls-card">
      <div class="search-box">
        <svg
          class="search-icon"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索标签页标题或网址 URL..."
          class="search-input"
        />
        <button v-if="searchQuery" class="clear-search" @click="searchQuery = ''">✕</button>
      </div>

      <div class="action-buttons">
        <button class="btn-add-pinned" @click="showPinnedModal = true" title="手动新增常驻预设网页">
          📌 + 新建常驻预设
        </button>

        <button
          class="auto-refresh-toggle"
          :class="{ active: autoRefresh }"
          @click="toggleAutoRefresh"
          title="每5秒自动刷新"
        >
          <span class="toggle-indicator"></span>
          <span>5s 自动刷新</span>
        </button>

        <button class="btn-primary" @click="fetchTabs" :disabled="isLoading">
          <svg
            :class="{ spin: isLoading }"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M23 4v6h-6"></path>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          <span>{{ isLoading ? "刷新中..." : "刷新列表" }}</span>
        </button>
      </div>
    </div>

    <!-- State Views (Loading / Error / Empty) -->
    <div v-if="isLoading && tabs.length === 0" class="state-container">
      <div class="spinner"></div>
      <p class="state-text">正在读取已打开的浏览器标签页...</p>
    </div>

    <div v-else-if="error" class="state-container error-state">
      <div class="state-icon-wrapper error">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </div>
      <h3 class="state-title">后台 API 连接错误</h3>
      <p class="state-desc">{{ error }}</p>
      <button class="btn-primary" @click="fetchTabs">重试连接</button>
    </div>

    <div v-else-if="filteredTabs.length === 0" class="state-container empty-state">
      <div class="state-icon-wrapper empty">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
      </div>
      <h3 class="state-title">未找到匹配的标签页</h3>
      <p class="state-desc" v-if="searchQuery">
        没有与 "{{ searchQuery }}" 匹配的标签页，请检查搜索关键词
      </p>
      <p class="state-desc" v-else>当前 Chrome 窗口中似乎没有打开任何标签页</p>
    </div>

    <!-- Tab Cards Grid -->
    <div v-else class="tabs-grid">
      <div v-for="tab in filteredTabs" :key="tab.index" class="tab-card">
        <div class="tab-card-header">
          <span class="tab-index-badge">#{{ tab.index + 1 }}</span>
          <span class="tab-domain-tag">{{ getDomainName(tab.url) }}</span>
          <button
            class="btn-pin-shortcut"
            @click="pinLiveTab(tab)"
            title="将此正在打开的标签页保存为常驻预设"
          >
            📌 设为常驻
          </button>
        </div>

        <div class="tab-card-body">
          <div class="favicon-container">
            <img
              v-if="tab.favicon"
              :src="tab.favicon"
              :alt="tab.title"
              class="favicon-img"
              @error="
                ($event.target as HTMLImageElement).src =
                  'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2364748b\' stroke-width=\'2\'><circle cx=\'12\' cy=\'12\' r=\'10\'/></svg>'
              "
            />
            <div v-else class="favicon-fallback">🌐</div>
          </div>

          <div class="tab-main-info">
            <h4 class="tab-title" :title="tab.title">{{ tab.title || tab.url }}</h4>
            <a
              :href="tab.url"
              target="_blank"
              rel="noopener noreferrer"
              class="tab-url-link"
              :title="tab.url"
            >
              {{ tab.url }}
            </a>
          </div>
        </div>

        <div class="tab-card-footer">
          <div class="custom-script-picker">
            <button
              class="picker-trigger-btn"
              :class="{ open: openScriptPickerTab === tab.index }"
              @click.stop="toggleScriptPicker(tab.index)"
              title="选择要在该标签页运行的脚本"
            >
              <span class="picker-file-icon">📄</span>
              <span class="picker-selected-text">{{
                selectedScriptPerTab[tab.index] || scripts[0]?.filename || "选择脚本"
              }}</span>
              <span class="picker-arrow">▾</span>
            </button>

            <!-- Custom Popover Menu Card -->
            <div v-if="openScriptPickerTab === tab.index" class="picker-popover-menu" @click.stop>
              <div class="picker-menu-header">
                <span>选择关联执行的脚本</span>
                <span class="picker-count">{{ scripts.length }} 个可用</span>
              </div>

              <div class="picker-menu-list">
                <div
                  v-for="s in scripts"
                  :key="s.filename"
                  class="picker-menu-item"
                  :class="{
                    active:
                      (selectedScriptPerTab[tab.index] || scripts[0]?.filename) === s.filename,
                  }"
                  @click="selectScriptForTab(tab.index, s.filename)"
                >
                  <span class="item-file-icon">📄</span>
                  <span class="item-file-name">{{ s.filename }}</span>
                  <span
                    v-if="(selectedScriptPerTab[tab.index] || scripts[0]?.filename) === s.filename"
                    class="item-check"
                    >✓</span
                  >
                </div>
              </div>
            </div>

            <button
              class="action-btn run-tab-btn"
              @click="runScriptOnTab(tab)"
              title="对此页签一键运行选中的脚本"
            >
              ▶️ 运行
            </button>
          </div>

          <button
            class="action-btn logs-btn-tab"
            @click="openHistoryLogModal(tab)"
            title="查看此标签页的历史执行日志"
          >
            <span>📜 日志</span>
          </button>

          <button
            class="action-btn open-btn"
            :disabled="switchingIndex === tab.index"
            @click="switchToTab(tab.index)"
            title="在 Chrome 中聚焦此标签页"
          >
            <span>{{ switchingIndex === tab.index ? "激活中..." : "激活页签" }}</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Real-Time SSE Script Execution Modal -->
    <div v-if="executingTab" class="modal-overlay" @click.self="closeExecutionModal">
      <div class="execution-modal-card">
        <div class="modal-header">
          <div class="modal-title">
            <span class="pulse-status-dot" :class="{ active: isExecuting }"></span>
            <h3>Tab #{{ executingTab.index + 1 }} 脚本实时执行</h3>
            <span class="script-tag">📄 {{ executingScript }}</span>
          </div>
          <button class="btn-close-modal" @click="closeExecutionModal">✕</button>
        </div>

        <div class="modal-body execution-body">
          <div class="target-tab-info">
            <span class="tab-target-label">目标页签:</span>
            <span class="tab-target-title">{{ executingTab.title || executingTab.url }}</span>
          </div>

          <!-- Live Frame Preview (if available) -->
          <div v-if="currentFrame" class="live-frame-preview">
            <img :src="currentFrame.frameUrl" class="live-frame-img" />
            <div class="frame-overlay-badge">
              <span>Step #{{ currentFrame.step }} [{{ currentFrame.time }}]</span>
              <span>{{ currentFrame.message }}</span>
            </div>
          </div>

          <!-- Terminal Logs Stream -->
          <div class="modal-terminal-box">
            <div
              v-for="(log, idx) in executionLogs"
              :key="idx"
              class="modal-log-line"
              :class="log.type"
            >
              <span class="log-time">{{ log.time }}</span>
              <span class="log-msg">{{ log.message }}</span>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button v-if="isExecuting" class="btn-stop-execution" @click="stopExecutionModal">
            ⏹️ 停止运行
          </button>
          <button class="btn-close-modal-footer" @click="closeExecutionModal">关闭窗口</button>
        </div>
      </div>
    </div>

    <!-- 📌 Pinned Resident Tab Preset Modal -->
    <div
      v-if="showPinnedModal"
      class="modal-overlay animated-fade-in"
      @click.self="showPinnedModal = false"
    >
      <div class="pinned-modal-card animated-slide-up">
        <div class="modal-header-hero">
          <div class="modal-title-wrapper">
            <div class="pin-icon-box">
              <span class="icon">📌</span>
            </div>
            <div class="title-text-group">
              <h3>新增常驻预设配置</h3>
              <p class="subtitle">设定常驻网页，实现一键检测开页与流式执行自动化</p>
            </div>
          </div>
          <button class="btn-close-modal-glass" @click="showPinnedModal = false">✕</button>
        </div>

        <div class="modal-body-styled">
          <div class="input-field-block">
            <label class="field-label">
              <span class="label-icon">🏷️</span>
              <span>预设名称</span>
              <span class="required-star">*</span>
            </label>
            <input
              v-model="pinnedForm.title"
              type="text"
              placeholder="例如：小红书蒲公英 - 商业内容管理"
              class="styled-input"
            />
            <span class="field-hint">给予预设一个易辨识的标识名称</span>
          </div>

          <div class="input-field-block">
            <label class="field-label">
              <span class="label-icon">🔗</span>
              <span>目标网页 URL</span>
              <span class="required-star">*</span>
            </label>
            <input
              v-model="pinnedForm.url"
              type="text"
              placeholder="https://pgy.xiaohongshu.com/microapp/creativity/commercial"
              class="styled-input font-mono"
            />
            <span class="field-hint">未打开或 URL 不相符时，系统将自动重定向并加载此目标 URL</span>
          </div>

          <div class="input-field-block">
            <label class="field-label">
              <span class="label-icon">📄</span>
              <span>默认关联执行脚本</span>
            </label>
            <div class="select-wrapper">
              <select v-model="pinnedForm.scriptFilename" class="styled-select">
                <option value="">(无 - 运行时默认选择最新脚本)</option>
                <option v-for="s in scripts" :key="s.filename" :value="s.filename">
                  📄 {{ s.filename }}
                </option>
              </select>
              <span class="select-arrow-icon">▾</span>
            </div>
            <span class="field-hint">选定在极速起航时默认自动运行的自动化脚本</span>
          </div>
        </div>

        <div class="modal-footer-styled">
          <button class="btn-cancel-glass" @click="showPinnedModal = false">取消</button>
          <button class="btn-save-pinned-hero" @click="savePinnedTab">
            <span>💾 保存常驻配置</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 📜 Historical Execution Trace Logs Modal (Light Mode 白天主题) -->
    <div
      v-if="showHistoryLogModal"
      class="modal-overlay history-modal-overlay animated-fade-in"
      @click.self="showHistoryLogModal = false"
    >
      <div class="history-log-modal-card light-mode animated-slide-up">
        <!-- Header Bar -->
        <div class="history-modal-header light">
          <div class="modal-title-wrapper">
            <div class="icon-box-purple">
              <span class="icon">📜</span>
            </div>
            <div class="title-text-group">
              <div class="title-row">
                <h3 class="light-title">历史执行日志明细</h3>
                <span v-if="historicalTraces.length > 0" class="runs-count-badge">
                  {{ historicalTraces.length }} 次运行批次
                </span>
              </div>
              <p class="subtitle-light" :title="historyLogTargetTitle">
                🎯 目标网页: <strong>{{ historyLogTargetTitle }}</strong>
              </p>
            </div>
          </div>
          <button class="btn-close-modal-light" @click="showHistoryLogModal = false">✕</button>
        </div>

        <div class="history-log-modal-body light">
          <!-- Loading State -->
          <div v-if="isLoadingHistoryLogs" class="history-modal-loading light">
            <div class="spinner-purple"></div>
            <span>正在读取历史执行轨迹...</span>
          </div>

          <!-- Empty State -->
          <div v-else-if="historicalTraces.length === 0" class="history-modal-empty light">
            <div class="empty-icon-light">📭</div>
            <h4>暂无历史执行记录</h4>
            <p>
              该网页或自动化脚本尚未产生过运行轨迹。点击“自动打开并运行”后将自动捕捉此处的终端日志。
            </p>
          </div>

          <!-- Content View -->
          <div v-else class="history-log-modal-content">
            <!-- Run Selector Dropdown Card -->
            <div class="run-selector-card light">
              <div class="selector-header light">
                <span class="label">📅 选择历史运行批次:</span>
                <span class="selected-time-badge light" v-if="selectedRunDetail">
                  ⏱️ {{ selectedRunDetail.timestamp }}
                </span>
              </div>
              <div class="styled-select-wrapper light">
                <select
                  :value="selectedRunId"
                  @change="loadHistoryRunDetail(($event.target as HTMLSelectElement).value)"
                  class="custom-run-select light"
                >
                  <option v-for="t in historicalTraces" :key="t.runId" :value="t.runId">
                    🚀 {{ t.timestamp }} ({{ t.filename }}) — 📜 {{ t.totalLogs || 0 }} 条日志 | 🎬
                    {{ t.totalFrames }} 帧画面
                  </option>
                </select>
                <span class="select-chevron light">▾</span>
              </div>
            </div>

            <!-- Segmented Control Switcher -->
            <div class="segmented-control-light">
              <button
                class="segment-btn-light"
                :class="{ active: historyModalActiveTab === 'logs' }"
                @click="historyModalActiveTab = 'logs'"
              >
                <span class="btn-icon">📜</span>
                <span>控制台文本日志</span>
                <span class="badge-count">{{ selectedRunDetail?.logs?.length || 0 }}</span>
              </button>
              <button
                class="segment-btn-light"
                :class="{ active: historyModalActiveTab === 'frames' }"
                @click="historyModalActiveTab = 'frames'"
              >
                <span class="btn-icon">🎬</span>
                <span>捕获画面轨迹</span>
                <span class="badge-count">{{ uniqueFrames.length }}</span>
              </button>
            </div>

            <!-- Panel 1: Terminal Log Box -->
            <div v-if="historyModalActiveTab === 'logs'" class="history-logs-panel">
              <div
                v-if="
                  selectedRunDetail && selectedRunDetail.logs && selectedRunDetail.logs.length > 0
                "
                class="console-box-light"
              >
                <div class="console-top-bar light">
                  <div class="console-dots">
                    <span class="dot red"></span>
                    <span class="dot yellow"></span>
                    <span class="dot green"></span>
                  </div>
                  <span class="console-title light">CONSOLE LOG OUTPUT</span>
                  <span class="console-meta light"
                    >{{ selectedRunDetail.logs.length }} LOG ENTRIES</span
                  >
                </div>
                <div class="console-scroll-light">
                  <div
                    v-for="(log, idx) in selectedRunDetail.logs"
                    :key="idx"
                    class="console-row-light"
                    :class="log.type || 'log'"
                  >
                    <span class="row-num light">#{{ String(idx + 1).padStart(2, "0") }}</span>
                    <span class="row-time light">[{{ log.time }}]</span>
                    <span class="row-text light">{{ log.message }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="console-empty-light">
                <span class="icon">💬</span>
                <span>此运行批次暂无文本日志记录</span>
              </div>
            </div>

            <!-- Panel 2: Cinema Screen Replay Player (独家唯一画面播放控制台) -->
            <div v-else-if="historyModalActiveTab === 'frames'" class="history-frames-panel">
              <div v-if="uniqueFrames.length > 0" class="cinema-viewer-container light">
                <!-- Screen Frame Display -->
                <div class="cinema-screen light">
                  <img
                    :src="uniqueFrames[activeFrameIdx]?.frameUrl"
                    class="cinema-img"
                    @error="handleFrameImgError"
                  />
                  <div class="cinema-overlay-banner light">
                    <span class="frame-tag light">
                      画面 {{ activeFrameIdx + 1 }} / {{ uniqueFrames.length }} (Step #{{
                        uniqueFrames[activeFrameIdx]?.step
                      }})
                    </span>
                    <span class="frame-msg light">{{ uniqueFrames[activeFrameIdx]?.message }}</span>
                    <span class="frame-time light"
                      >⏱️ {{ uniqueFrames[activeFrameIdx]?.time }}</span
                    >
                  </div>
                </div>

                <!-- Video Replay Control Toolbar -->
                <div class="replay-control-toolbar light">
                  <div class="control-left-group">
                    <button
                      class="btn-player-action play-btn"
                      :class="{ playing: isPlayingHistoryReplay }"
                      @click="togglePlayHistoryReplay"
                      :title="isPlayingHistoryReplay ? '暂停播放' : '循环播放轨迹'"
                    >
                      <span v-if="isPlayingHistoryReplay">⏸️ 暂停</span>
                      <span v-else>▶️ 自动播放</span>
                    </button>

                    <button
                      class="btn-player-action step-btn"
                      @click="activeFrameIdx = Math.max(0, activeFrameIdx - 1)"
                      :disabled="activeFrameIdx === 0"
                      title="上一画面"
                    >
                      ⏮️ 上一帧
                    </button>

                    <button
                      class="btn-player-action step-btn"
                      @click="
                        activeFrameIdx = Math.min(uniqueFrames.length - 1, activeFrameIdx + 1)
                      "
                      :disabled="activeFrameIdx >= uniqueFrames.length - 1"
                      title="下一画面"
                    >
                      下一帧 ⏭️
                    </button>
                  </div>

                  <!-- Range Slider Scrubber -->
                  <div class="scrubber-container">
                    <input
                      type="range"
                      min="0"
                      :max="uniqueFrames.length - 1"
                      v-model.number="activeFrameIdx"
                      class="player-scrubber-range"
                    />
                  </div>

                  <div class="control-right-group">
                    <span class="frames-counter-badge">
                      {{ activeFrameIdx + 1 }} / {{ uniqueFrames.length }} 异帧画面
                    </span>

                    <select
                      v-model.number="historyReplaySpeed"
                      class="speed-select-light"
                      @change="if (isPlayingHistoryReplay) startHistoryReplay();"
                    >
                      <option :value="1">1x 速度</option>
                      <option :value="2">2x 速度</option>
                      <option :value="5">5x 倍速</option>
                    </select>
                  </div>
                </div>
              </div>
              <div v-else class="console-empty-light">
                <span class="icon">📸</span>
                <span>此运行批次暂无捕获的网页画面快照</span>
              </div>
            </div>
          </div>
        </div>

        <div class="history-modal-footer light">
          <button class="btn-close-light" @click="showHistoryLogModal = false">
            <span>✕ 关闭窗口</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs-page {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* Stats Overview */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1.25rem;
}

.stat-card {
  background-color: var(--bg-card, #ffffff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 12px;
  padding: 1.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  box-shadow: var(--shadow-sm, 0 1px 2px 0 rgba(0, 0, 0, 0.05));
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.05));
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tabs-icon {
  background-color: #e0e7ff;
  color: #4f46e5;
}

.domain-icon {
  background-color: #e0f2fe;
  color: #0284c7;
}

.cdp-icon {
  background-color: #d1fae5;
  color: #059669;
}

.stat-content {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 0.85rem;
  color: #64748b;
  font-weight: 500;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: #0f172a;
  margin-top: 0.1rem;
}

.status-badge-online {
  font-size: 1rem;
  color: #059669;
  font-weight: 600;
}

/* Controls Toolbar */
.controls-card {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  box-shadow: var(--shadow-sm);
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.5rem 0.8rem;
  flex: 1;
  min-width: 280px;
  transition: border-color 0.2s ease;
}

.search-box:focus-within {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.search-icon {
  color: #94a3b8;
}

.search-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 0.9rem;
  color: #0f172a;
  width: 100%;
}

.clear-search {
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  font-size: 0.9rem;
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.auto-refresh-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #475569;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.auto-refresh-toggle:hover {
  background-color: #e2e8f0;
}

.auto-refresh-toggle.active {
  background-color: #e0e7ff;
  color: #4f46e5;
  border-color: #c7d2fe;
}

.toggle-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.auto-refresh-toggle.active .toggle-indicator {
  background-color: #4f46e5;
  box-shadow: 0 0 6px rgba(79, 70, 229, 0.6);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #4f46e5;
  color: white;
  border: none;
  padding: 0.55rem 1.1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2);
}

.btn-primary:hover:not(:disabled) {
  background-color: #4338ca;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(79, 70, 229, 0.3);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* State Views */
.state-container {
  background-color: #ffffff;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  padding: 4rem 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 1rem;
}

.spinner {
  width: 42px;
  height: 42px;
  border: 3px solid #e2e8f0;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.state-text {
  color: #64748b;
  font-size: 1rem;
}

.state-icon-wrapper {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.state-icon-wrapper.error {
  background-color: #fef2f2;
  color: #ef4444;
}

.state-icon-wrapper.empty {
  background-color: #f8fafc;
  color: #94a3b8;
}

.state-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.state-desc {
  font-size: 0.95rem;
  color: #64748b;
  max-width: 480px;
  margin: 0;
}

/* Tabs Grid & Cards */
.tabs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.25rem;
}

.tab-card {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 1rem;
  box-shadow: var(--shadow-sm);
  transition: all 0.25s ease;
}

.tab-card:hover {
  transform: translateY(-3px);
  border-color: #c7d2fe;
  box-shadow: var(--shadow-hover);
}

.tab-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tab-index-badge {
  font-size: 0.75rem;
  font-weight: 700;
  color: #4f46e5;
  background-color: #e0e7ff;
  padding: 0.15rem 0.55rem;
  border-radius: 6px;
}

.tab-domain-tag {
  font-size: 0.75rem;
  color: #64748b;
  background-color: #f1f5f9;
  padding: 0.15rem 0.55rem;
  border-radius: 6px;
  font-weight: 500;
}

.tab-card-body {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
}

.favicon-container {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

.favicon-img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.favicon-fallback {
  font-size: 1.2rem;
}

.tab-main-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tab-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.tab-url-link {
  font-size: 0.825rem;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}

.tab-url-link:hover {
  color: #4f46e5;
  text-decoration: underline;
}

.tab-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-top: 0.85rem;
  border-top: 1px solid #f1f5f9;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.4rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid #e2e8f0;
}

.custom-script-picker {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.picker-trigger-btn {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  background-color: #f8fafc;
  border: 1px solid #cbd5e1;
  border-right: none;
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
  color: #0f172a;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  transition: all 0.2s ease;
  height: 34px;
  box-sizing: border-box;
}

.picker-trigger-btn:hover,
.picker-trigger-btn.open {
  background-color: #ffffff;
  border-color: #8b5cf6;
}

.picker-file-icon {
  font-size: 0.85rem;
}

.picker-selected-text {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  text-align: left;
}

.picker-arrow {
  font-size: 0.7rem;
  color: #64748b;
  transition: transform 0.2s ease;
}

.picker-trigger-btn.open .picker-arrow {
  transform: rotate(180deg);
}

.picker-popover-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 250px;
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow:
    0 10px 25px -5px rgba(0, 0, 0, 0.12),
    0 8px 10px -6px rgba(0, 0, 0, 0.04);
  z-index: 60;
  overflow: hidden;
  animation: popoverFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes popoverFadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.picker-menu-header {
  padding: 0.6rem 0.85rem;
  background-color: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
  color: #64748b;
}

.picker-count {
  color: #4f46e5;
}

.picker-menu-list {
  max-height: 200px;
  overflow-y: auto;
  padding: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.picker-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8rem;
  color: #334155;
  transition: all 0.15s ease;
}

.picker-menu-item:hover {
  background-color: #f1f5f9;
  color: #0f172a;
}

.picker-menu-item.active {
  background-color: #f3e8ff;
  color: #7c3aed;
  font-weight: 600;
}

.item-file-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-check {
  font-size: 0.85rem;
  font-weight: 700;
  color: #7c3aed;
}

.run-tab-btn {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  border: 1px solid #059669;
  color: white;
  white-space: nowrap;
  font-weight: 700;
  padding: 0.35rem 0.75rem;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
  height: 34px;
  box-sizing: border-box;
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);
  transition: all 0.2s ease;
}

.run-tab-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(16, 185, 129, 0.35);
}

.logs-btn-tab {
  background-color: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  font-weight: 600;
  border-radius: 8px;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.logs-btn-tab:hover {
  background-color: #e2e8f0;
  color: #0f172a;
  border-color: #94a3b8;
}

.open-btn {
  background-color: #e0e7ff;
  color: #4f46e5;
  border-color: #c7d2fe;
  text-decoration: none;
  white-space: nowrap;
}

.open-btn:hover {
  background-color: #4f46e5;
  color: white;
}

/* Modal Overlay & Card */
.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.execution-modal-card {
  width: 90%;
  max-width: 720px;
  max-height: 85vh;
  background-color: #ffffff;
  border-radius: 16px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 1rem 1.25rem;
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
  font-size: 1.05rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.script-tag {
  font-size: 0.75rem;
  font-weight: 600;
  color: #4f46e5;
  background-color: #e0e7ff;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}

.pulse-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.pulse-status-dot.active {
  background-color: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.25);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(0.95);
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(0.95);
  }
}

.btn-close-modal {
  background: none;
  border: none;
  font-size: 1.1rem;
  color: #94a3b8;
  cursor: pointer;
}

.execution-body {
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.target-tab-info {
  font-size: 0.85rem;
  color: #475569;
  background-color: #f8fafc;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
}

.tab-target-label {
  font-weight: 600;
  margin-right: 0.35rem;
}

.live-frame-preview {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #0f172a;
  background-color: #000;
}

.live-frame-img {
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  display: block;
}

.frame-overlay-badge {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(15, 23, 42, 0.85);
  color: #f8fafc;
  padding: 0.4rem 0.75rem;
  font-size: 0.75rem;
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.modal-terminal-box {
  background-color: #0f172a;
  color: #f8fafc;
  padding: 0.85rem;
  border-radius: 8px;
  font-family: monospace;
  font-size: 0.8rem;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.modal-log-line {
  display: flex;
  gap: 0.5rem;
  word-break: break-all;
}

.log-time {
  color: #64748b;
  font-size: 0.75rem;
}

.log-msg {
  color: #e2e8f0;
}

.modal-footer {
  padding: 0.85rem 1.25rem;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.btn-stop-execution {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-close-modal-footer {
  background-color: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

/* Pinned Resident Presets Section */
.pinned-section {
  background: linear-gradient(135deg, #fefce8 0%, #fffbebe6 100%);
  border: 1px solid #fde68a;
  border-radius: 14px;
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.08);
}

.section-title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.section-title h3 {
  font-size: 1.1rem;
  font-weight: 800;
  color: #92400e;
  margin: 0;
}

.section-subtitle {
  font-size: 0.8rem;
  color: #b45309;
}

.title-bar-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.pinned-count {
  font-size: 0.8rem;
  color: #b45309;
  font-weight: 600;
}

.btn-add-pinned-small {
  background-color: #fef3c7;
  border: 1px solid #fde68a;
  color: #b45309;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.btn-add-pinned-small:hover {
  background-color: #f59e0b;
  color: white;
}

.pinned-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1rem;
}

.pinned-card {
  background-color: #ffffff;
  border: 1.5px solid #fcd34d;
  border-radius: 12px;
  padding: 1rem 1.15rem;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0.85rem;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.04);
}

.pinned-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.pinned-tag {
  background-color: #fef3c7;
  color: #b45309;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
}

.pinned-status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.15rem 0.55rem;
  border-radius: 6px;
}

.pinned-status-badge.exact {
  background-color: #ecfdf5;
  color: #047857;
  border: 1px solid #a7f3d0;
}

.pinned-status-badge.domain {
  background-color: #fffbeb;
  color: #b45309;
  border: 1px solid #fde68a;
}

.pinned-status-badge.closed {
  background-color: #f8fafc;
  color: #64748b;
  border: 1px solid #e2e8f0;
}

.pinned-card-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.pinned-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.pinned-url {
  font-size: 0.8rem;
  color: #4f46e5;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}

.pinned-script-info {
  font-size: 0.75rem;
  color: #64748b;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.25rem;
}

.script-badge {
  background-color: #e0e7ff;
  color: #4338ca;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.pinned-card-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-top: 0.65rem;
  border-top: 1px dashed #e2e8f0;
}

.btn-launch-pinned {
  flex: 1;
  background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
  color: white;
  border: none;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(79, 70, 229, 0.25);
  transition: all 0.2s ease;
}

.btn-launch-pinned:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35);
}

.btn-delete-pinned {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  padding: 0.4rem 0.65rem;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-add-pinned {
  background-color: #fef3c7;
  border: 1px solid #fde68a;
  color: #b45309;
  font-weight: 700;
  padding: 0.4rem 0.85rem;
  border-radius: 8px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-add-pinned:hover {
  background-color: #f59e0b;
  color: white;
}

.btn-pin-shortcut {
  background-color: #fef3c7;
  border: 1px solid #fde68a;
  color: #b45309;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  cursor: pointer;
}

.btn-pin-shortcut:hover {
  background-color: #f59e0b;
  color: white;
}

/* Animations */
@keyframes fadeInOverlay {
  from {
    opacity: 0;
    backdrop-filter: blur(0px);
  }
  to {
    opacity: 1;
    backdrop-filter: blur(12px);
  }
}

@keyframes slideUpModal {
  from {
    opacity: 0;
    transform: translateY(24px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.animated-fade-in {
  animation: fadeInOverlay 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  background: rgba(15, 23, 42, 0.65) !important;
  backdrop-filter: blur(12px) !important;
}

.animated-slide-up {
  animation: slideUpModal 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

/* Modal for New Pinned Tab */
.pinned-modal-card {
  width: 92%;
  max-width: 540px;
  background: #ffffff;
  border-radius: 20px;
  box-shadow:
    0 25px 50px -12px rgba(15, 23, 42, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.8) inset;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e2e8f0;
}

.modal-header-hero {
  background: linear-gradient(135deg, #4f46e5 0%, #6366f1 50%, #7c3aed 100%);
  padding: 1.5rem 1.75rem;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  position: relative;
}

.modal-title-wrapper {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.pin-icon-box {
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.title-text-group h3 {
  font-size: 1.25rem;
  font-weight: 800;
  color: #ffffff;
  margin: 0 0 0.25rem 0;
  letter-spacing: -0.01em;
}

.title-text-group .subtitle {
  font-size: 0.82rem;
  color: rgba(255, 255, 255, 0.85);
  margin: 0;
  font-weight: 400;
}

.btn-close-modal-glass {
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #ffffff;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  font-size: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-close-modal-glass:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: rotate(90deg);
}

.modal-body-styled {
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  background-color: #f8fafc;
}

.input-field-block {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.field-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.88rem;
  font-weight: 700;
  color: #1e293b;
}

.label-icon {
  font-size: 0.95rem;
}

.required-star {
  color: #ef4444;
  font-weight: 800;
}

.styled-input {
  width: 100%;
  padding: 0.7rem 0.9rem;
  border: 1.5px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.9rem;
  color: #0f172a;
  background-color: #ffffff;
  box-sizing: border-box;
  transition: all 0.2s ease;
}

.styled-input.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
}

.styled-input:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
  background-color: #ffffff;
}

.select-wrapper {
  position: relative;
  width: 100%;
}

.styled-select {
  width: 100%;
  padding: 0.7rem 2.2rem 0.7rem 0.9rem;
  border: 1.5px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.88rem;
  color: #0f172a;
  background-color: #ffffff;
  appearance: none;
  box-sizing: border-box;
  cursor: pointer;
  transition: all 0.2s ease;
}

.styled-select:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
}

.select-arrow-icon {
  position: absolute;
  right: 0.9rem;
  top: 50%;
  transform: translateY(-50%);
  color: #64748b;
  pointer-events: none;
}

/* Historical Execution Trace Logs Modal - Light Mode (白天模式) */
.history-modal-overlay {
  background: rgba(15, 23, 42, 0.35);
  backdrop-filter: blur(8px);
}

.history-log-modal-card.light-mode {
  width: 92%;
  max-width: 820px;
  background: #ffffff;
  border-radius: 20px;
  box-shadow:
    0 20px 50px -10px rgba(15, 23, 42, 0.15),
    0 0 1px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  max-height: 88vh;
  color: #0f172a;
}

.history-modal-header.light {
  padding: 1.25rem 1.75rem;
  background: #ffffff;
  border-bottom: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.icon-box-purple {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  color: #ffffff;
  flex-shrink: 0;
}

.light-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.01em;
}

.runs-count-badge {
  background: #e0e7ff;
  border: 1px solid #c7d2fe;
  color: #4338ca;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
}

.subtitle-light {
  margin: 0.25rem 0 0 0;
  font-size: 0.82rem;
  color: #64748b;
  max-width: 520px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-close-modal-light {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #64748b;
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.btn-close-modal-light:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.history-log-modal-body.light {
  padding: 1.5rem;
  background-color: #f8fafc;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Loading & Empty States - Light Mode */
.history-modal-loading.light,
.history-modal-empty.light {
  padding: 4rem 1.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: #64748b;
  text-align: center;
}

.spinner-purple {
  width: 40px;
  height: 40px;
  border: 3px solid #e0e7ff;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.empty-icon-light {
  font-size: 3rem;
  opacity: 0.8;
}

.history-modal-empty.light h4 {
  margin: 0;
  font-size: 1.1rem;
  color: #1e293b;
  font-weight: 700;
}

.history-modal-empty.light p {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
  max-width: 400px;
  line-height: 1.5;
}

/* Run Selector Card - Light Mode */
.run-selector-card.light {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.selector-header.light {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.82rem;
  font-weight: 700;
  color: #334155;
}

.selected-time-badge.light {
  background: #f1f5f9;
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  color: #4f46e5;
  font-size: 0.78rem;
  font-weight: 600;
}

.custom-run-select.light {
  width: 100%;
  padding: 0.7rem 2.4rem 0.7rem 0.95rem;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.88rem;
  font-weight: 600;
  color: #0f172a;
  background: #ffffff;
  appearance: none;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
  transition: all 0.2s ease;
}

.custom-run-select.light:hover,
.custom-run-select.light:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.select-chevron.light {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  color: #64748b;
  pointer-events: none;
  font-size: 0.85rem;
}

/* Segmented Control - Light Mode */
.segmented-control-light {
  display: flex;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  padding: 4px;
  border-radius: 12px;
  gap: 4px;
}

.segment-btn-light {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 0.85rem;
  font-weight: 700;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.segment-btn-light:hover {
  color: #1e293b;
}

.segment-btn-light.active {
  background: #ffffff;
  color: #4f46e5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.badge-count {
  background: #e2e8f0;
  color: #475569;
  padding: 0.1rem 0.45rem;
  border-radius: 10px;
  font-size: 0.72rem;
}

.segment-btn-light.active .badge-count {
  background: #e0e7ff;
  color: #4338ca;
}

/* Console Log Output - Light Mode Developer Terminal Box */
.console-box-light {
  background: #0f172a;
  border-radius: 12px;
  border: 1px solid #1e293b;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
  display: flex;
  flex-direction: column;
}

.console-top-bar.light {
  background: #1e293b;
  padding: 0.5rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #334155;
}

.console-dots .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
}

.console-title.light {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.console-meta.light {
  font-size: 0.7rem;
  color: #818cf8;
  font-weight: 700;
  background: rgba(99, 102, 241, 0.15);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.console-scroll-light {
  padding: 0.85rem 1rem;
  max-height: 360px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.82rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.console-row-light {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  line-height: 1.45;
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
  word-break: break-all;
}

.console-row-light:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.row-num.light {
  color: #475569;
  font-size: 0.75rem;
  flex-shrink: 0;
  user-select: none;
}

.row-time.light {
  color: #64748b;
  font-size: 0.75rem;
  flex-shrink: 0;
}

.row-text.light {
  color: #e2e8f0;
}

.console-row-light.error .row-text.light {
  color: #f87171;
}

.console-row-light.success .row-text.light {
  color: #4ade80;
}

.console-empty-light {
  padding: 3rem 1rem;
  text-align: center;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  color: #64748b;
  font-size: 0.88rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.console-empty-light .icon {
  font-size: 2rem;
}

/* Cinema Viewer Container - Light Mode */
.cinema-viewer-container.light {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.cinema-screen.light {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #0f172a;
  border: 1px solid #cbd5e1;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.12);
  height: 400px;
  max-height: 52vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  box-sizing: border-box;
}

.cinema-img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  transition: all 0.2s ease;
}

.cinema-overlay-banner.light {
  position: absolute;
  bottom: 0.85rem;
  left: 0.85rem;
  right: 0.85rem;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(10px);
  color: #ffffff;
  padding: 0.65rem 1rem;
  border-radius: 10px;
  font-size: 0.8rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.frame-tag.light {
  background: #4f46e5;
  color: white;
  font-weight: 800;
  font-size: 0.72rem;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  flex-shrink: 0;
}

.frame-msg.light {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #f8fafc;
}

.frame-time.light {
  color: #cbd5e1;
  font-size: 0.75rem;
  flex-shrink: 0;
}

/* Replay Control Toolbar - Video Player Style */
.replay-control-toolbar.light {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.control-left-group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.btn-player-action {
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.btn-player-action:hover:not(:disabled) {
  background: #e2e8f0;
  color: #0f172a;
}

.btn-player-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-player-action.play-btn {
  background: #e0e7ff;
  border-color: #c7d2fe;
  color: #4338ca;
}

.btn-player-action.play-btn.playing {
  background: #fef3c7;
  border-color: #fde68a;
  color: #b45309;
}

.scrubber-container {
  flex: 1;
  display: flex;
  align-items: center;
}

.player-scrubber-range {
  width: 100%;
  accent-color: #4f46e5;
  cursor: pointer;
  height: 6px;
  border-radius: 3px;
}

.control-right-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.frames-counter-badge {
  font-size: 0.78rem;
  font-weight: 700;
  color: #475569;
  background: #f1f5f9;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  white-space: nowrap;
}

.speed-select-light {
  background: #ffffff;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.35rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.history-modal-footer.light {
  padding: 1.25rem 1.75rem;
  background: #ffffff;
  border-top: 1px solid #f1f5f9;
  display: flex;
  justify-content: flex-end;
}

.btn-close-light {
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  font-weight: 700;
  padding: 0.6rem 1.4rem;
  border-radius: 10px;
  font-size: 0.88rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-close-light:hover {
  background: #e2e8f0;
  color: #0f172a;
}
</style>
