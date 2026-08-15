<script setup lang="ts">
import { computed, ref } from "vue";

type PrototypeState = "ready" | "preparing" | "running" | "success" | "partial" | "error";

type TableOption = {
  name: string;
  count: number;
  size: string;
  selected: boolean;
};

type EvidenceRecord = {
  id: string;
  table: string;
  row: number;
  fields: Record<string, string>;
};

type LeftPanelMode = "config" | "history";

type HistorySession = {
  id: string;
  title: string;
  database: string;
  scope: string;
  updatedAt: string;
  preview: string;
  prompt: string;
  state: "success" | "partial" | "error";
  status: string;
};

const reviewStates: Array<{ id: PrototypeState; label: string }> = [
  { id: "ready", label: "配置中" },
  { id: "preparing", label: "准备快照" },
  { id: "running", label: "运行中" },
  { id: "success", label: "已完成" },
  { id: "partial", label: "部分结果" },
  { id: "error", label: "失败" },
];

const databases = [
  { id: "cbg-main", name: "cbg_data.db", meta: "57 KB · 刚刚更新" },
  { id: "archive", name: "archive.sqlite", meta: "1.2 MB · 2 天前更新" },
];

const tables = ref<TableOption[]>([
  { name: "youtube_videos", count: 32, size: "18.4 KB", selected: true },
  { name: "notes", count: 4, size: "33.4 KB", selected: true },
  { name: "cbg_items", count: 0, size: "0 B", selected: false },
]);

const historySessions: HistorySession[] = [
  {
    id: "session-current",
    title: "内容主题分析",
    database: "cbg_data.db",
    scope: "youtube_videos + notes",
    updatedAt: "刚刚",
    preview: "所选数据主要呈现出两个值得继续关注的方向……",
    prompt: "总结所选数据中的主要主题，并指出值得继续关注的内容。",
    state: "success",
    status: "可继续追问",
  },
  {
    id: "session-youtube-trend",
    title: "YouTube 标题趋势",
    database: "cbg_data.db",
    scope: "youtube_videos · 32 行",
    updatedAt: "昨天 18:42",
    preview: "最近抓取的标题主要集中在自动化、AI 工具和数据整理。",
    prompt: "分析这些视频标题最近出现了哪些主题趋势。",
    state: "success",
    status: "已完成",
  },
  {
    id: "session-notes-summary",
    title: "笔记内容归纳",
    database: "archive.sqlite",
    scope: "notes · 86 行",
    updatedAt: "8 月 13 日",
    preview: "已保留前两部分归纳，外部工具调用在最后阶段超时。",
    prompt: "归纳这些笔记中的核心观点，并按主题分组。",
    state: "partial",
    status: "部分完成",
  },
  {
    id: "session-failed",
    title: "旧数据结构检查",
    database: "archive.sqlite",
    scope: "legacy_items · 1,204 行",
    updatedAt: "8 月 11 日",
    preview: "沙箱启动失败，未生成回答。",
    prompt: "检查这批旧数据的字段结构和异常内容。",
    state: "error",
    status: "失败",
  },
];

const evidenceRecords: Record<string, EvidenceRecord> = {
  "youtube_videos#12": {
    id: "youtube_videos#12",
    table: "youtube_videos",
    row: 12,
    fields: {
      title: "用浏览器自动化整理公开数据的完整工作流",
      href: "https://www.youtube.com/watch?v=example-12",
      created_at: "2026-08-14 10:22:08",
    },
  },
  "notes#3": {
    id: "notes#3",
    table: "notes",
    row: 3,
    fields: {
      title: "数据分析入口讨论",
      content: "选择本地表和 Prompt 后，希望能够围绕同一份数据继续追问。",
      created_at: "2026-08-15 09:42:16",
    },
  },
};

const prototypeState = ref<PrototypeState>("success");
const leftPanelMode = ref<LeftPanelMode>("history");
const selectedHistoryId = ref("session-current");
const historySearch = ref("");
const selectedDatabase = ref("cbg-main");
const tableSearch = ref("");
const prompt = ref("总结所选数据中的主要主题，并指出值得继续关注的内容。");
const followUp = ref("");
const activityExpanded = ref(false);
const activeEvidenceId = ref("youtube_videos#12");
const evidenceVisible = ref(true);

const selectedTables = computed(() => tables.value.filter((table) => table.selected));
const selectedRows = computed(() =>
  selectedTables.value.reduce((total, table) => total + table.count, 0),
);
const filteredTables = computed(() => {
  const keyword = tableSearch.value.trim().toLowerCase();
  if (!keyword) return tables.value;
  return tables.value.filter((table) => table.name.toLowerCase().includes(keyword));
});
const filteredHistorySessions = computed(() => {
  const keyword = historySearch.value.trim().toLowerCase();
  if (!keyword) return historySessions;
  return historySessions.filter((session) =>
    [session.title, session.database, session.scope, session.preview].some((value) =>
      value.toLowerCase().includes(keyword),
    ),
  );
});
const selectedHistorySession = computed(() =>
  historySessions.find((session) => session.id === selectedHistoryId.value),
);
const hasSession = computed(() => prototypeState.value !== "ready");
const controlsLocked = computed(() => hasSession.value);
const canStart = computed(() => selectedTables.value.length > 0 && prompt.value.trim().length > 0);
const activeEvidence = computed(() => evidenceRecords[activeEvidenceId.value]);

const statusMeta = computed(() => {
  const states: Record<PrototypeState, { label: string; tone: string; detail: string }> = {
    ready: {
      label: "等待配置",
      tone: "neutral",
      detail: "选择数据表并输入 Prompt",
    },
    preparing: {
      label: "准备快照",
      tone: "info",
      detail: "正在复制 2 张表的全量内容",
    },
    running: {
      label: "Agent 运行中",
      tone: "info",
      detail: "正在分析数据并生成回答",
    },
    success: {
      label: "可以继续追问",
      tone: "success",
      detail: "本轮已完成 · 复用固定数据快照",
    },
    partial: {
      label: "部分完成",
      tone: "warning",
      detail: "已有结果可用，部分工具执行超时",
    },
    error: {
      label: "运行失败",
      tone: "danger",
      detail: "沙箱启动失败，未产生回答",
    },
  };
  return states[prototypeState.value];
});

const setPrototypeState = (state: PrototypeState) => {
  prototypeState.value = state;
  evidenceVisible.value = state === "success" || state === "partial";
};

const toggleTable = (name: string) => {
  if (controlsLocked.value) return;
  const table = tables.value.find((item) => item.name === name);
  if (table) table.selected = !table.selected;
};

const applyHelloPreset = () => {
  if (!controlsLocked.value) prompt.value = "你好";
};

const startSession = () => {
  if (!canStart.value) return;
  prototypeState.value = "preparing";
  evidenceVisible.value = false;
};

const cancelRun = () => {
  prototypeState.value = "partial";
  evidenceVisible.value = true;
};

const newSession = () => {
  prototypeState.value = "ready";
  leftPanelMode.value = "config";
  selectedHistoryId.value = "";
  followUp.value = "";
  evidenceVisible.value = false;
};

const openHistorySession = (session: HistorySession) => {
  selectedHistoryId.value = session.id;
  prompt.value = session.prompt;
  prototypeState.value = session.state;
  evidenceVisible.value = session.state === "success" || session.state === "partial";
};

const sendFollowUp = () => {
  if (!followUp.value.trim()) return;
  followUp.value = "";
  prototypeState.value = "running";
  evidenceVisible.value = false;
};

const showEvidence = (id: string) => {
  activeEvidenceId.value = id;
  evidenceVisible.value = true;
};
</script>

<template>
  <div class="prototype-page">
    <section class="prototype-toolbar" aria-label="原型状态切换器">
      <div class="prototype-note">
        <span class="prototype-badge">交互原型</span>
        <span>切换状态，查看页面在不同运行阶段的反馈</span>
      </div>
      <div class="state-switcher">
        <button
          v-for="state in reviewStates"
          :key="state.id"
          type="button"
          class="state-button"
          :class="{ active: prototypeState === state.id }"
          @click="setPrototypeState(state.id)"
        >
          {{ state.label }}
        </button>
      </div>
    </section>

    <div class="agent-workbench">
      <aside class="config-panel">
        <nav class="panel-tabs" aria-label="PI Agent 左侧面板">
          <button
            type="button"
            :class="{ active: leftPanelMode === 'config' }"
            @click="leftPanelMode = 'config'"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14"></path>
            </svg>
            新建分析
          </button>
          <button
            type="button"
            :class="{ active: leftPanelMode === 'history' }"
            @click="leftPanelMode = 'history'"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
              <path d="M3 3v5h5M12 7v5l3 2"></path>
            </svg>
            历史会话
            <span>{{ historySessions.length }}</span>
          </button>
        </nav>

        <header v-if="leftPanelMode === 'config'" class="panel-heading">
          <div>
            <span class="eyebrow">分析配置</span>
            <h3>选择本次数据范围</h3>
          </div>
          <span v-if="controlsLocked" class="lock-badge">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="10" width="14" height="10" rx="2"></rect>
              <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
            </svg>
            已锁定
          </span>
        </header>

        <div v-if="leftPanelMode === 'config'" class="config-scroll">
          <section class="field-group">
            <label for="pi-database">数据库</label>
            <div class="select-shell">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <ellipse cx="12" cy="5" rx="8" ry="3"></ellipse>
                <path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5"></path>
                <path d="M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7"></path>
              </svg>
              <select id="pi-database" v-model="selectedDatabase" :disabled="controlsLocked">
                <option v-for="database in databases" :key="database.id" :value="database.id">
                  {{ database.name }}
                </option>
              </select>
            </div>
            <span class="field-hint">
              {{ databases.find((database) => database.id === selectedDatabase)?.meta }}
            </span>
          </section>

          <section class="field-group table-section">
            <div class="field-label-row">
              <label>数据表</label>
              <span>{{ selectedTables.length }} 已选择</span>
            </div>
            <div class="search-shell">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7"></circle>
                <path d="m20 20-4-4"></path>
              </svg>
              <input
                v-model="tableSearch"
                type="search"
                placeholder="搜索数据表"
                :disabled="controlsLocked"
              />
            </div>
            <div class="table-list">
              <button
                v-for="table in filteredTables"
                :key="table.name"
                type="button"
                class="table-option"
                :class="{ selected: table.selected, disabled: controlsLocked }"
                @click="toggleTable(table.name)"
              >
                <span class="checkbox" :class="{ checked: table.selected }">
                  <svg v-if="table.selected" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m5 12 4 4L19 6"></path>
                  </svg>
                </span>
                <span class="table-copy">
                  <strong>{{ table.name }}</strong>
                  <small>{{ table.count }} 行 · {{ table.size }}</small>
                </span>
              </button>
            </div>
            <span class="field-hint">内部调度表已隐藏，不会进入 Agent 快照</span>
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
            ></textarea>
            <span class="field-hint">预设只填充文本，你可以自由修改或完全替换</span>
          </section>

          <section class="snapshot-summary" :class="{ locked: controlsLocked }">
            <div class="summary-title">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 4 7v5c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V7l-8-4Z"></path>
                <path d="m9 12 2 2 4-4"></path>
              </svg>
              <span>{{ controlsLocked ? "会话数据范围已固定" : "即将创建全量快照" }}</span>
            </div>
            <dl>
              <div>
                <dt>数据表</dt>
                <dd>{{ selectedTables.length }} 张</dd>
              </div>
              <div>
                <dt>总行数</dt>
                <dd>{{ selectedRows }} 行</dd>
              </div>
              <div>
                <dt>预计大小</dt>
                <dd>51.8 KB</dd>
              </div>
            </dl>
          </section>
        </div>

        <footer v-if="leftPanelMode === 'config'" class="config-footer">
          <button
            type="button"
            class="primary-button"
            :disabled="!canStart || controlsLocked"
            @click="startSession"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 3 14 9-14 9V3Z"></path>
            </svg>
            开始分析
          </button>
          <span v-if="controlsLocked" class="locked-help">更改数据范围需要新建会话</span>
        </footer>

        <template v-else>
          <header class="history-heading">
            <div>
              <span class="eyebrow">会话历史</span>
              <h3>继续之前的分析</h3>
            </div>
            <span class="history-count">{{ historySessions.length }} 个会话</span>
          </header>

          <div class="history-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7"></circle>
              <path d="m20 20-4-4"></path>
            </svg>
            <input v-model="historySearch" type="search" placeholder="搜索标题、数据库或表" />
          </div>

          <div class="history-list">
            <button
              v-for="session in filteredHistorySessions"
              :key="session.id"
              type="button"
              class="history-item"
              :class="{ active: selectedHistoryId === session.id }"
              @click="openHistorySession(session)"
            >
              <span class="history-item-topline">
                <strong>{{ session.title }}</strong>
                <small>{{ session.updatedAt }}</small>
              </span>
              <span class="history-scope">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <ellipse cx="12" cy="5" rx="8" ry="3"></ellipse>
                  <path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5"></path>
                </svg>
                {{ session.database }} · {{ session.scope }}
              </span>
              <span class="history-preview">{{ session.preview }}</span>
              <span class="history-status" :class="session.state">
                <i></i>
                {{ session.status }}
              </span>
            </button>

            <div v-if="filteredHistorySessions.length === 0" class="history-empty">
              没有找到匹配的历史会话
            </div>
          </div>

          <footer class="history-footer">
            <button type="button" class="primary-button" @click="newSession">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
              新建分析
            </button>
            <span>当前为模拟历史；V1 将通过 PI SQLite 会话库跨刷新恢复</span>
          </footer>
        </template>
      </aside>

      <section class="conversation-panel">
        <header class="conversation-header">
          <div class="session-heading">
            <div class="agent-mark">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3a6 6 0 0 0-6 6c0 2.4 1.3 4.5 3.2 5.5V18h5.6v-3.5A6.48 6.48 0 0 0 18 9a6 6 0 0 0-6-6Z"
                ></path>
                <path d="M9 21h6"></path>
                <path d="M9.2 18h5.6"></path>
              </svg>
            </div>
            <div>
              <span class="eyebrow">PI Agent 会话</span>
              <h3>
                {{ hasSession ? (selectedHistorySession?.title ?? "内容主题分析") : "新分析会话" }}
              </h3>
            </div>
          </div>

          <div class="header-actions">
            <button
              type="button"
              class="secondary-button history-action"
              @click="leftPanelMode = 'history'"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
                <path d="M3 3v5h5M12 7v5l3 2"></path>
              </svg>
              历史
            </button>
            <div class="status-pill" :class="statusMeta.tone">
              <span class="status-indicator"></span>
              {{ statusMeta.label }}
            </div>
            <button
              v-if="prototypeState === 'preparing' || prototypeState === 'running'"
              type="button"
              class="secondary-button danger-action"
              @click="cancelRun"
            >
              取消运行
            </button>
            <button v-else type="button" class="secondary-button" @click="newSession">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
              新建会话
            </button>
          </div>
        </header>

        <div v-if="hasSession" class="scope-strip">
          <span class="scope-label">固定快照</span>
          <span class="scope-item">cbg_data.db</span>
          <span class="scope-separator"></span>
          <span class="scope-item">youtube_videos + notes</span>
          <span class="scope-separator"></span>
          <span class="scope-item">36 行 · 51.8 KB</span>
          <span class="scope-note">数据库后续变化不会进入本会话</span>
        </div>

        <div v-if="prototypeState === 'ready'" class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h7"></path>
              <path d="M18 2v6M15 5h6"></path>
            </svg>
          </div>
          <h3>从左侧配置一次分析</h3>
          <p>选择至少一张表并输入 Prompt。会话开始后，数据快照会固定并支持连续追问。</p>
          <div class="empty-steps">
            <span>1. 选择数据库和表</span>
            <span>2. 输入分析问题</span>
            <span>3. 创建连续会话</span>
          </div>
        </div>

        <template v-else>
          <div v-if="prototypeState === 'preparing'" class="run-banner info-banner" role="status">
            <span class="spinner"></span>
            <div>
              <strong>正在准备全量数据快照</strong>
              <span>已读取 28 / 36 行，完成后将启动 Agent 沙箱。</span>
            </div>
            <span class="progress-value">78%</span>
          </div>

          <div v-if="prototypeState === 'running'" class="run-banner info-banner" role="status">
            <span class="pulse-ring"></span>
            <div>
              <strong>PI Agent 正在分析</strong>
              <span>正在整理第二轮回答，当前会话上下文约 4.2K tokens。</span>
            </div>
          </div>

          <div v-if="prototypeState === 'partial'" class="run-banner warning-banner" role="status">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3 2 21h20L12 3Z"></path>
              <path d="M12 9v5M12 18h.01"></path>
            </svg>
            <div>
              <strong>本轮只返回了部分结果</strong>
              <span>一个外部工具在 30 秒后超时，已有回答和证据仍然保留。</span>
            </div>
            <button type="button" @click="setPrototypeState('running')">重新继续</button>
          </div>

          <div v-if="prototypeState === 'error'" class="error-state">
            <div class="error-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9"></circle>
                <path d="M12 7v6M12 17h.01"></path>
              </svg>
            </div>
            <div>
              <h3>沙箱启动失败</h3>
              <p>没有数据发送给模型，也没有生成会话内容。请检查运行环境后重试。</p>
              <code>PI_WORKSPACE_INIT_FAILED · exit code 1</code>
            </div>
            <button type="button" class="secondary-button" @click="setPrototypeState('preparing')">
              重试
            </button>
          </div>

          <div v-if="prototypeState !== 'error'" class="conversation-content">
            <div class="messages-column">
              <article class="message user-message">
                <div class="message-avatar user-avatar">你</div>
                <div class="message-body">
                  <div class="message-meta">
                    <strong>你</strong>
                    <span>15:18</span>
                  </div>
                  <p>{{ prompt }}</p>
                </div>
              </article>

              <article class="message assistant-message">
                <div class="message-avatar agent-avatar">PI</div>
                <div class="message-body">
                  <div class="message-meta">
                    <strong>PI Agent</strong>
                    <span>15:18 · 8.4 秒</span>
                  </div>
                  <div class="answer-copy">
                    <p>所选数据主要呈现出两个值得继续关注的方向：</p>
                    <ol>
                      <li>
                        <strong>自动化数据采集与整理。</strong>
                        视频标题多次涉及浏览器自动化、抓取与结构化整理，说明这是当前数据中最集中的主题。
                        <button
                          type="button"
                          class="evidence-chip"
                          @click="showEvidence('youtube_videos#12')"
                        >
                          [youtube_videos#12]
                        </button>
                      </li>
                      <li>
                        <strong>围绕固定数据持续分析。</strong>
                        笔记明确提出选择本地表后继续追问，适合在同一份不可变快照上保持连续会话。
                        <button
                          type="button"
                          class="evidence-chip"
                          @click="showEvidence('notes#3')"
                        >
                          [notes#3]
                        </button>
                      </li>
                    </ol>
                    <p>建议下一步对标题进行主题归类，并比较各主题随时间的变化。</p>
                  </div>
                </div>
              </article>

              <article
                v-if="prototypeState === 'running'"
                class="message user-message compact-message"
              >
                <div class="message-avatar user-avatar">你</div>
                <div class="message-body">
                  <div class="message-meta">
                    <strong>你</strong>
                    <span>15:20</span>
                  </div>
                  <p>把与自动化工作流有关的内容单独列出来。</p>
                </div>
              </article>

              <article
                v-if="prototypeState === 'running'"
                class="message assistant-message typing-message"
              >
                <div class="message-avatar agent-avatar">PI</div>
                <div class="message-body">
                  <div class="message-meta">
                    <strong>PI Agent</strong>
                    <span>正在输入</span>
                  </div>
                  <div class="typing-dots" aria-label="Agent 正在输入">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </article>

              <button
                type="button"
                class="activity-toggle"
                @click="activityExpanded = !activityExpanded"
              >
                <span>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 4v16h16"></path>
                    <path d="m7 14 3-3 3 2 5-6"></path>
                  </svg>
                  运行过程 · 4 个事件
                </span>
                <svg class="chevron" :class="{ rotated: activityExpanded }" viewBox="0 0 24 24">
                  <path d="m7 10 5 5 5-5"></path>
                </svg>
              </button>

              <div v-if="activityExpanded" class="activity-list">
                <div>
                  <span class="event-dot complete"></span><strong>数据快照完成</strong
                  ><small>36 行 · 51.8 KB</small>
                </div>
                <div>
                  <span class="event-dot complete"></span><strong>Agent 沙箱已创建</strong
                  ><small>420 ms</small>
                </div>
                <div>
                  <span class="event-dot complete"></span><strong>read input/snapshot.json</strong
                  ><small>完成</small>
                </div>
                <div>
                  <span class="event-dot running"></span><strong>生成自然语言回答</strong
                  ><small>进行中</small>
                </div>
              </div>
            </div>

            <aside v-if="evidenceVisible && activeEvidence" class="evidence-panel">
              <header>
                <div>
                  <span class="eyebrow">证据原始行</span>
                  <h4>{{ activeEvidence.id }}</h4>
                </div>
                <button type="button" aria-label="关闭证据" @click="evidenceVisible = false">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18"></path>
                  </svg>
                </button>
              </header>
              <div class="evidence-meta">
                <span>来源表：{{ activeEvidence.table }}</span>
                <span>快照行：{{ activeEvidence.row }}</span>
              </div>
              <dl class="evidence-fields">
                <div v-for="(value, key) in activeEvidence.fields" :key="key">
                  <dt>{{ key }}</dt>
                  <dd>{{ value }}</dd>
                </div>
              </dl>
              <p class="evidence-note">索引只在当前不可变快照和连续会话中保持稳定。</p>
            </aside>
          </div>

          <footer v-if="prototypeState !== 'error'" class="composer">
            <div class="composer-input">
              <textarea
                v-model="followUp"
                rows="2"
                placeholder="继续追问这份数据……"
                :disabled="prototypeState === 'preparing' || prototypeState === 'running'"
                @keydown.meta.enter.prevent="sendFollowUp"
                @keydown.ctrl.enter.prevent="sendFollowUp"
              ></textarea>
              <button
                type="button"
                class="send-button"
                :disabled="
                  !followUp.trim() || prototypeState === 'preparing' || prototypeState === 'running'
                "
                aria-label="发送追问"
                @click="sendFollowUp"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m22 2-7 20-4-9-9-4 20-7Z"></path>
                  <path d="M22 2 11 13"></path>
                </svg>
              </button>
            </div>
            <div class="composer-meta">
              <span>同一会话 · 复用 36 行固定快照</span>
              <span>⌘ Enter 发送</span>
            </div>
          </footer>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.prototype-page {
  --pi-primary: #4f46e5;
  --pi-primary-soft: #eef2ff;
  --pi-border: #e2e8f0;
  --pi-muted: #64748b;
  --pi-ink: #0f172a;
  display: flex;
  flex-direction: column;
  gap: 1rem;
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
}

.prototype-toolbar {
  min-height: 52px;
  padding: 0.55rem 0.7rem 0.55rem 1rem;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: linear-gradient(90deg, #eef2ff, #ffffff 58%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.prototype-note,
.state-switcher {
  display: flex;
  align-items: center;
}

.prototype-note {
  gap: 0.65rem;
  color: #475569;
  font-size: 0.78rem;
}

.prototype-badge {
  padding: 0.28rem 0.55rem;
  border-radius: 999px;
  color: #4338ca;
  background: #ffffff;
  border: 1px solid #c7d2fe;
  font-weight: 700;
}

.state-switcher {
  gap: 0.25rem;
  padding: 0.2rem;
  background: #ffffff;
  border: 1px solid var(--pi-border);
  border-radius: 9px;
}

.state-button {
  border: 0;
  background: transparent;
  color: #64748b;
  padding: 0.42rem 0.65rem;
  border-radius: 7px;
  font-size: 0.75rem;
  font-weight: 600;
}

.state-button:hover {
  color: #1e293b;
  background: #f8fafc;
}

.state-button.active {
  color: #4338ca;
  background: #eef2ff;
}

.agent-workbench {
  min-height: calc(100vh - 171px);
  display: grid;
  grid-template-columns: 310px minmax(0, 1fr);
  gap: 1rem;
}

.config-panel,
.conversation-panel {
  background: #ffffff;
  border: 1px solid var(--pi-border);
  border-radius: 14px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
  min-width: 0;
  overflow: hidden;
}

.config-panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 171px);
}

.panel-tabs {
  min-height: 46px;
  padding: 0.35rem;
  border-bottom: 1px solid var(--pi-border);
  background: #f8fafc;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.3rem;
}

.panel-tabs button {
  min-width: 0;
  border: 0;
  border-radius: 8px;
  color: #64748b;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  font-weight: 700;
}

.panel-tabs button:hover {
  color: #334155;
  background: #ffffff;
}

.panel-tabs button.active {
  color: #4338ca;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

.panel-tabs button > span {
  min-width: 17px;
  height: 17px;
  padding: 0 0.25rem;
  border-radius: 999px;
  color: #64748b;
  background: #e2e8f0;
  display: grid;
  place-items: center;
  font-size: 0.58rem;
}

.panel-tabs button.active > span {
  color: #4338ca;
  background: #e0e7ff;
}

.panel-tabs svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.panel-heading,
.conversation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--pi-border);
}

.panel-heading {
  min-height: 70px;
  padding: 0 1rem;
}

.panel-heading h3,
.conversation-header h3 {
  margin: 0.15rem 0 0;
  color: var(--pi-ink);
  font-size: 0.95rem;
}

.eyebrow {
  display: block;
  color: #94a3b8;
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.lock-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.5rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 0.68rem;
  font-weight: 700;
}

.lock-badge svg,
.summary-title svg,
.primary-button svg,
.secondary-button svg,
.search-shell svg,
.select-shell svg,
.activity-toggle svg,
.run-banner > svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.config-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.field-group label {
  color: #334155;
  font-size: 0.76rem;
  font-weight: 700;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.field-label-row > span {
  color: #64748b;
  font-size: 0.68rem;
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
  background: #ffffff;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.select-shell select,
.search-shell input {
  height: 40px;
  padding: 0 0.75rem 0 2.25rem;
  font-size: 0.78rem;
}

.field-group textarea {
  min-height: 104px;
  resize: vertical;
  padding: 0.7rem 0.75rem;
  line-height: 1.55;
  font-size: 0.78rem;
}

.select-shell select:focus,
.search-shell input:focus,
.field-group textarea:focus,
.composer textarea:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.select-shell select:disabled,
.search-shell input:disabled,
.field-group textarea:disabled {
  color: #64748b;
  background: #f8fafc;
  opacity: 1;
}

.field-hint {
  color: #94a3b8;
  font-size: 0.66rem;
  line-height: 1.45;
}

.table-list {
  max-height: 154px;
  overflow-y: auto;
  border: 1px solid var(--pi-border);
  border-radius: 9px;
}

.table-option {
  width: 100%;
  border: 0;
  border-bottom: 1px solid #f1f5f9;
  background: #ffffff;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.58rem 0.65rem;
  text-align: left;
}

.table-option:last-child {
  border-bottom: 0;
}

.table-option:hover:not(.disabled),
.table-option.selected {
  background: #f8faff;
}

.table-option.disabled {
  cursor: not-allowed;
}

.checkbox {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  border: 1.5px solid #cbd5e1;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: #ffffff;
}

.checkbox.checked {
  background: var(--pi-primary);
  border-color: var(--pi-primary);
}

.checkbox svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.table-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.table-copy strong {
  color: #334155;
  font-size: 0.74rem;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
}

.table-copy small {
  color: #94a3b8;
  font-size: 0.64rem;
}

.preset-button {
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  color: #4338ca;
  background: #eef2ff;
  padding: 0.26rem 0.55rem;
  font-size: 0.66rem;
  font-weight: 700;
}

.preset-button:disabled {
  color: #94a3b8;
  border-color: #e2e8f0;
  background: #f8fafc;
}

.snapshot-summary {
  padding: 0.75rem;
  border: 1px solid #c7d2fe;
  border-radius: 10px;
  background: #f8faff;
}

.snapshot-summary.locked {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.summary-title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  color: #4338ca;
  font-size: 0.7rem;
  font-weight: 700;
}

.snapshot-summary.locked .summary-title {
  color: #047857;
}

.snapshot-summary dl {
  margin: 0.7rem 0 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}

.snapshot-summary dl div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.snapshot-summary dt {
  color: #94a3b8;
  font-size: 0.6rem;
}

.snapshot-summary dd {
  margin: 0;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 700;
}

.history-heading {
  min-height: 64px;
  padding: 0 1rem;
  border-bottom: 1px solid var(--pi-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.history-heading h3 {
  margin: 0.15rem 0 0;
  color: var(--pi-ink);
  font-size: 0.9rem;
}

.history-count {
  color: #64748b;
  font-size: 0.65rem;
}

.history-search {
  position: relative;
  padding: 0.75rem 0.8rem;
  border-bottom: 1px solid var(--pi-border);
  display: flex;
  align-items: center;
}

.history-search svg {
  position: absolute;
  left: 1.5rem;
  width: 15px;
  height: 15px;
  color: #94a3b8;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  pointer-events: none;
}

.history-search input {
  width: 100%;
  height: 38px;
  box-sizing: border-box;
  padding: 0 0.7rem 0 2.1rem;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  color: #334155;
  background: #ffffff;
  outline: none;
  font-size: 0.72rem;
}

.history-search input:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.history-list {
  flex: 1;
  min-height: 0;
  padding: 0.45rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.history-item {
  width: 100%;
  padding: 0.72rem;
  border: 1px solid transparent;
  border-radius: 10px;
  color: #475569;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 0.38rem;
  text-align: left;
}

.history-item:hover {
  border-color: #e2e8f0;
  background: #f8fafc;
}

.history-item.active {
  border-color: #c7d2fe;
  background: #f5f7ff;
  box-shadow: inset 3px 0 0 #6366f1;
}

.history-item-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.history-item-topline strong {
  min-width: 0;
  color: #1e293b;
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-item-topline small {
  flex: 0 0 auto;
  color: #94a3b8;
  font-size: 0.58rem;
}

.history-scope {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  color: #64748b;
  font-size: 0.61rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-scope svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.history-preview {
  color: #64748b;
  font-size: 0.65rem;
  line-height: 1.45;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.history-status {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  color: #047857;
  font-size: 0.59rem;
  font-weight: 700;
}

.history-status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.history-status.partial {
  color: #a16207;
}

.history-status.error {
  color: #b91c1c;
}

.history-empty {
  padding: 2rem 0.75rem;
  color: #94a3b8;
  font-size: 0.7rem;
  text-align: center;
}

.history-footer {
  padding: 0.75rem 0.8rem;
  border-top: 1px solid var(--pi-border);
  background: #ffffff;
}

.history-footer > span {
  display: block;
  margin-top: 0.45rem;
  color: #94a3b8;
  font-size: 0.59rem;
  line-height: 1.45;
  text-align: center;
}

.config-footer {
  padding: 0.85rem 1rem;
  border-top: 1px solid var(--pi-border);
  background: #ffffff;
}

.primary-button,
.secondary-button {
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  font-weight: 700;
}

.primary-button {
  width: 100%;
  min-height: 41px;
  border: 1px solid var(--pi-primary);
  background: var(--pi-primary);
  color: #ffffff;
  font-size: 0.78rem;
  box-shadow: 0 4px 10px rgba(79, 70, 229, 0.18);
}

.primary-button:disabled {
  border-color: #cbd5e1;
  color: #94a3b8;
  background: #e2e8f0;
  box-shadow: none;
}

.locked-help {
  display: block;
  margin-top: 0.5rem;
  color: #94a3b8;
  font-size: 0.64rem;
  text-align: center;
}

.conversation-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: calc(100vh - 171px);
}

.conversation-header {
  min-height: 70px;
  padding: 0 1rem;
}

.session-heading,
.header-actions {
  display: flex;
  align-items: center;
}

.session-heading {
  gap: 0.7rem;
  min-width: 0;
}

.agent-mark {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border-radius: 10px;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  color: #ffffff;
  display: grid;
  place-items: center;
  box-shadow: 0 4px 9px rgba(79, 70, 229, 0.2);
}

.agent-mark svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.header-actions {
  gap: 0.55rem;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.34rem 0.58rem;
  border-radius: 999px;
  font-size: 0.67rem;
  font-weight: 700;
  border: 1px solid #e2e8f0;
  color: #64748b;
  background: #f8fafc;
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

.status-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill.info .status-indicator {
  animation: pulse 1.4s infinite;
}

.secondary-button {
  min-height: 34px;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #475569;
  padding: 0 0.65rem;
  font-size: 0.7rem;
}

.secondary-button:hover {
  border-color: #a5b4fc;
  color: #4338ca;
}

.danger-action {
  color: #b91c1c;
  border-color: #fecaca;
}

.scope-strip {
  min-height: 40px;
  padding: 0 1rem;
  border-bottom: 1px solid var(--pi-border);
  background: #f8fafc;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: #64748b;
  font-size: 0.66rem;
  white-space: nowrap;
  overflow: hidden;
}

.scope-label {
  color: #047857;
  background: #dcfce7;
  border-radius: 999px;
  padding: 0.22rem 0.46rem;
  font-weight: 700;
}

.scope-item {
  color: #334155;
  font-weight: 650;
}

.scope-separator {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #cbd5e1;
}

.scope-note {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
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

.empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: #eef2ff;
  color: #4f46e5;
  display: grid;
  place-items: center;
}

.empty-icon svg,
.error-icon svg {
  width: 30px;
  height: 30px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.empty-state h3 {
  margin: 1rem 0 0.4rem;
  color: var(--pi-ink);
  font-size: 1rem;
}

.empty-state p {
  max-width: 430px;
  margin: 0;
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.6;
}

.empty-steps {
  margin-top: 1.2rem;
  display: flex;
  gap: 0.5rem;
}

.empty-steps span {
  padding: 0.38rem 0.58rem;
  border: 1px solid var(--pi-border);
  border-radius: 999px;
  color: #64748b;
  background: #ffffff;
  font-size: 0.65rem;
}

.run-banner {
  margin: 0.75rem 0.9rem 0;
  min-height: 50px;
  padding: 0.65rem 0.8rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  font-size: 0.7rem;
}

.run-banner div {
  display: flex;
  flex-direction: column;
  gap: 0.16rem;
}

.run-banner strong {
  color: #1e293b;
}

.run-banner span:not(.spinner, .pulse-ring, .progress-value) {
  color: #64748b;
}

.info-banner {
  border: 1px solid #c7d2fe;
  background: #f5f7ff;
}

.warning-banner {
  border: 1px solid #fde68a;
  background: #fffbeb;
}

.warning-banner > svg {
  color: #ca8a04;
}

.warning-banner button {
  margin-left: auto;
  border: 0;
  color: #92400e;
  background: transparent;
  font-size: 0.68rem;
  font-weight: 700;
}

.spinner,
.pulse-ring {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.spinner {
  border: 2px solid #c7d2fe;
  border-top-color: #4f46e5;
  animation: spin 0.8s linear infinite;
}

.pulse-ring {
  background: #6366f1;
  box-shadow: 0 0 0 5px rgba(99, 102, 241, 0.12);
  animation: pulse 1.4s infinite;
}

.progress-value {
  margin-left: auto;
  color: #4338ca;
  font-weight: 700;
}

.error-state {
  flex: 1;
  margin: 1.25rem;
  padding: 1.1rem;
  border: 1px solid #fecaca;
  border-radius: 12px;
  background: #fffafa;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 0.9rem;
}

.error-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: #dc2626;
  background: #fee2e2;
  display: grid;
  place-items: center;
}

.error-icon svg {
  width: 22px;
  height: 22px;
}

.error-state h3 {
  margin: 0;
  color: #991b1b;
  font-size: 0.9rem;
}

.error-state p {
  margin: 0.35rem 0 0.65rem;
  color: #64748b;
  font-size: 0.72rem;
  line-height: 1.55;
}

.error-state code {
  color: #b91c1c;
  font-size: 0.65rem;
}

.conversation-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 270px;
  align-items: start;
}

.messages-column {
  min-width: 0;
  padding: 0.9rem 1rem 1.25rem;
}

.message {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 0.65rem;
  margin-bottom: 1rem;
}

.message-avatar {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-size: 0.67rem;
  font-weight: 800;
}

.user-avatar {
  color: #334155;
  background: #e2e8f0;
}

.agent-avatar {
  color: #ffffff;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
}

.message-body {
  min-width: 0;
}

.message-meta {
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 0.55rem;
}

.message-meta strong {
  color: #1e293b;
  font-size: 0.73rem;
}

.message-meta span {
  color: #94a3b8;
  font-size: 0.62rem;
}

.message p,
.answer-copy li {
  color: #475569;
  font-size: 0.75rem;
  line-height: 1.7;
}

.message p {
  margin: 0.1rem 0 0;
}

.user-message .message-body {
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--pi-border);
  border-radius: 4px 11px 11px 11px;
  background: #f8fafc;
}

.user-message .message-meta {
  min-height: auto;
  margin-bottom: 0.2rem;
}

.answer-copy p {
  margin: 0.2rem 0 0.6rem;
}

.answer-copy ol {
  margin: 0.2rem 0 0.7rem;
  padding-left: 1.2rem;
}

.answer-copy li + li {
  margin-top: 0.55rem;
}

.answer-copy strong {
  color: #1e293b;
}

.evidence-chip {
  display: inline;
  border: 0;
  border-radius: 5px;
  color: #4338ca;
  background: #eef2ff;
  padding: 0.12rem 0.3rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.65rem;
  font-weight: 700;
  vertical-align: baseline;
}

.evidence-chip:hover {
  background: #e0e7ff;
}

.compact-message {
  margin-top: 1.3rem;
}

.typing-dots {
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #818cf8;
  animation: typing 1.2s infinite;
}

.typing-dots span:nth-child(2) {
  animation-delay: 0.18s;
}

.typing-dots span:nth-child(3) {
  animation-delay: 0.36s;
}

.activity-toggle {
  width: 100%;
  min-height: 36px;
  padding: 0 0.7rem;
  border: 1px solid var(--pi-border);
  border-radius: 9px;
  background: #ffffff;
  color: #64748b;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.68rem;
}

.activity-toggle > span {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.activity-toggle .chevron {
  width: 14px;
  height: 14px;
  transition: transform 0.15s ease;
}

.activity-toggle .chevron.rotated {
  transform: rotate(180deg);
}

.activity-list {
  margin-top: 0.45rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--pi-border);
  border-radius: 9px;
  background: #f8fafc;
}

.activity-list > div {
  min-height: 27px;
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 0.5rem;
  color: #475569;
  font-size: 0.65rem;
}

.activity-list small {
  color: #94a3b8;
}

.event-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.event-dot.complete {
  background: #10b981;
}

.event-dot.running {
  background: #6366f1;
  animation: pulse 1.2s infinite;
}

.evidence-panel {
  align-self: stretch;
  min-height: 100%;
  border-left: 1px solid var(--pi-border);
  background: #f8fafc;
}

.evidence-panel header {
  min-height: 62px;
  padding: 0 0.85rem;
  border-bottom: 1px solid var(--pi-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.evidence-panel h4 {
  margin: 0.18rem 0 0;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
}

.evidence-panel header button {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  color: #64748b;
  background: transparent;
  display: grid;
  place-items: center;
}

.evidence-panel header button:hover {
  background: #e2e8f0;
}

.evidence-panel header button svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}

.evidence-meta {
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--pi-border);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  color: #64748b;
  font-size: 0.64rem;
}

.evidence-fields {
  margin: 0;
  padding: 0.2rem 0.85rem;
}

.evidence-fields > div {
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--pi-border);
}

.evidence-fields dt {
  margin-bottom: 0.25rem;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.6rem;
}

.evidence-fields dd {
  margin: 0;
  color: #334155;
  font-size: 0.68rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.evidence-note {
  margin: 0.7rem 0.85rem;
  color: #94a3b8;
  font-size: 0.61rem;
  line-height: 1.5;
}

.composer {
  padding: 0.75rem 0.9rem 0.6rem;
  border-top: 1px solid var(--pi-border);
  background: #ffffff;
}

.composer-input {
  position: relative;
}

.composer textarea {
  width: 100%;
  min-height: 54px;
  max-height: 120px;
  box-sizing: border-box;
  resize: none;
  padding: 0.65rem 3rem 0.65rem 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  color: #1e293b;
  background: #ffffff;
  outline: none;
  font-size: 0.74rem;
  line-height: 1.5;
}

.composer textarea:disabled {
  background: #f8fafc;
}

.send-button {
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  color: #ffffff;
  background: var(--pi-primary);
  display: grid;
  place-items: center;
}

.send-button:disabled {
  color: #94a3b8;
  background: #e2e8f0;
}

.send-button svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.composer-meta {
  margin-top: 0.35rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #94a3b8;
  font-size: 0.61rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
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

@media (max-width: 1120px) {
  .prototype-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .state-switcher {
    width: 100%;
    overflow-x: auto;
  }

  .agent-workbench {
    grid-template-columns: 280px minmax(0, 1fr);
  }

  .conversation-content {
    grid-template-columns: minmax(0, 1fr);
  }

  .evidence-panel {
    min-height: auto;
    border-top: 1px solid var(--pi-border);
    border-left: 0;
  }
}

@media (max-width: 860px) {
  .agent-workbench {
    display: flex;
    flex-direction: column;
  }

  .config-panel,
  .conversation-panel {
    max-height: none;
  }

  .conversation-panel {
    min-height: 680px;
  }
}
</style>
