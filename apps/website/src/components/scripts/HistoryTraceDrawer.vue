<script setup lang="ts">
import type { HistoryItem, TraceRunSummary } from "../../types/automation";

const props = defineProps<{
  open: boolean;
  drawerActiveTab: "versions" | "traces";
  historyList: readonly HistoryItem[];
  allTracesList: readonly TraceRunSummary[];
  expandedLogRunIds: readonly string[];
  isLoadingHistory: boolean;
  isLoadingTraces: boolean;
  previewHistoryContent: string | null;
  selectedHistoryIds: readonly string[];
  selectedTraceRunIds: readonly string[];
  isAllHistorySelected: boolean;
  isAllTracesSelected: boolean;
}>();

const emit = defineEmits<{
  close: [];
  "update:drawerActiveTab": [tab: "versions" | "traces"];
  "update:selectedHistoryIds": [ids: string[]];
  "update:selectedTraceRunIds": [ids: string[]];
  "toggle-select-all-history": [];
  "toggle-select-all-traces": [];
  "batch-delete-history": [];
  "batch-delete-traces": [];
  "preview-history": [content: string];
  "restore-history": [historyId: string];
  "delete-history": [historyId: string];
  "toggle-trace-log": [runId: string];
  "load-trace": [runId: string];
  "delete-trace": [runId: string];
}>();

const updateHistorySelection = (historyId: string, event: Event) => {
  const isSelected = (event.target as HTMLInputElement).checked;
  const nextIds = isSelected
    ? props.selectedHistoryIds.includes(historyId)
      ? [...props.selectedHistoryIds]
      : [...props.selectedHistoryIds, historyId]
    : props.selectedHistoryIds.filter((id) => id !== historyId);
  emit("update:selectedHistoryIds", nextIds);
};

const updateTraceSelection = (runId: string, event: Event) => {
  const isSelected = (event.target as HTMLInputElement).checked;
  const nextIds = isSelected
    ? props.selectedTraceRunIds.includes(runId)
      ? [...props.selectedTraceRunIds]
      : [...props.selectedTraceRunIds, runId]
    : props.selectedTraceRunIds.filter((id) => id !== runId);
  emit("update:selectedTraceRunIds", nextIds);
};
</script>

<template>
  <div v-if="open" class="drawer-overlay" @click.self="emit('close')">
    <div class="history-drawer">
      <div class="drawer-header">
        <div class="drawer-tabs">
          <button
            class="drawer-tab-btn"
            :class="{ active: drawerActiveTab === 'versions' }"
            @click="emit('update:drawerActiveTab', 'versions')"
          >
            📜 代码版本历史 ({{ historyList.length }})
          </button>
          <button
            class="drawer-tab-btn"
            :class="{ active: drawerActiveTab === 'traces' }"
            @click="emit('update:drawerActiveTab', 'traces')"
          >
            🎬 运行 Trace 轨迹 ({{ allTracesList.length }})
          </button>
        </div>
        <button class="btn-close-modal" @click="emit('close')">✕</button>
      </div>

      <div class="drawer-body">
        <div v-if="drawerActiveTab === 'versions'" class="drawer-tab-content">
          <div v-if="historyList.length > 0" class="drawer-batch-bar">
            <label class="batch-select-all">
              <input
                type="checkbox"
                :checked="isAllHistorySelected"
                @change="emit('toggle-select-all-history')"
              />
              <span>全选</span>
            </label>
            <span class="batch-count-info">已选 {{ selectedHistoryIds.length }} 项</span>
            <button
              class="btn-batch-delete"
              :disabled="selectedHistoryIds.length === 0"
              @click="emit('batch-delete-history')"
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
            <div v-for="(item, index) in historyList" :key="item.id" class="history-card">
              <div class="history-card-header">
                <input
                  type="checkbox"
                  :value="item.id"
                  :checked="selectedHistoryIds.includes(item.id)"
                  class="card-checkbox"
                  @change="updateHistorySelection(item.id, $event)"
                />
                <span class="version-badge">v{{ historyList.length - index }}</span>
                <span class="history-label">{{ item.label }}</span>
                <span class="history-time">{{ item.timestamp }}</span>
              </div>

              <div class="history-actions">
                <button class="hist-btn preview" @click="emit('preview-history', item.content)">
                  {{ previewHistoryContent === item.content ? "隐藏" : "👁️ 预览代码" }}
                </button>
                <button class="hist-btn restore" @click="emit('restore-history', item.id)">
                  ↺ 恢复此版本
                </button>
                <button class="hist-btn delete" @click="emit('delete-history', item.id)">
                  🗑️ 删除快照
                </button>
              </div>

              <pre v-if="previewHistoryContent === item.content" class="preview-code-block">{{
                item.content
              }}</pre>
            </div>
          </div>
        </div>

        <div v-else class="drawer-tab-content">
          <div v-if="allTracesList.length > 0" class="drawer-batch-bar">
            <label class="batch-select-all">
              <input
                type="checkbox"
                :checked="isAllTracesSelected"
                @change="emit('toggle-select-all-traces')"
              />
              <span>全选</span>
            </label>
            <span class="batch-count-info">已选 {{ selectedTraceRunIds.length }} 项</span>
            <button
              class="btn-batch-delete"
              :disabled="selectedTraceRunIds.length === 0"
              @click="emit('batch-delete-traces')"
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
            <div v-for="trace in allTracesList" :key="trace.runId" class="history-card trace-card">
              <div class="history-card-header">
                <input
                  type="checkbox"
                  :value="trace.runId"
                  :checked="selectedTraceRunIds.includes(trace.runId)"
                  class="card-checkbox"
                  @change="updateTraceSelection(trace.runId, $event)"
                />
                <span class="trace-badge">🎬 {{ trace.runId.slice(-6) }}</span>
                <span class="history-label">{{ trace.filename }}</span>
                <span class="history-time">{{ trace.timestamp }}</span>
              </div>

              <div class="trace-meta-info">
                <span
                  >📸 画面: <strong>{{ trace.totalFrames }} 帧</strong></span
                >
                <span class="meta-divider">|</span>
                <span>
                  📜 控制台日志:
                  <strong>{{ trace.logs ? trace.logs.length : trace.totalLogs || 0 }} 条</strong>
                </span>
              </div>

              <div class="history-actions">
                <button
                  class="hist-btn logs-toggle-btn"
                  @click="emit('toggle-trace-log', trace.runId)"
                >
                  📜 控制台文本日志 ({{ trace.logs ? trace.logs.length : trace.totalLogs || 0 }})
                  <span class="accordion-arrow">
                    {{ expandedLogRunIds.includes(trace.runId) ? "▲" : "▼" }}
                  </span>
                </button>
                <button class="hist-btn replay-trace-btn" @click="emit('load-trace', trace.runId)">
                  🎬 观看画面回放
                </button>
                <button class="hist-btn delete" @click="emit('delete-trace', trace.runId)">
                  🗑️ 删除
                </button>
              </div>

              <div v-if="expandedLogRunIds.includes(trace.runId)" class="trace-logs-accordion">
                <div class="accordion-header">
                  <span>📜 控制台实时日志记录</span>
                  <span class="accordion-count"
                    >{{ trace.logs ? trace.logs.length : 0 }} 条记录</span
                  >
                </div>
                <div v-if="trace.logs && trace.logs.length > 0" class="trace-logs-list">
                  <div
                    v-for="(log, index) in trace.logs"
                    :key="index"
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
</template>

<style scoped>
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

.btn-close-modal {
  border: none;
  background: transparent;
  font-size: 1.1rem;
  color: #64748b;
  cursor: pointer;
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

.log-time {
  color: #64748b;
  flex-shrink: 0;
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

/* Keep the side drawer usable on viewports narrower than its desktop width. */
.history-drawer {
  width: min(440px, 100vw);
  max-width: 100%;
}

.drawer-header,
.drawer-batch-bar,
.history-card-header {
  gap: 0.75rem;
}

.drawer-tabs,
.drawer-batch-bar,
.history-card-header {
  min-width: 0;
  flex-wrap: wrap;
}

@media (max-width: 480px) {
  .drawer-header,
  .drawer-body {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .drawer-header {
    align-items: flex-start;
  }

  .drawer-tabs {
    flex: 1;
  }

  .drawer-tab-btn {
    flex: 1;
    min-width: 0;
  }

  .drawer-batch-bar {
    align-items: flex-start;
  }

  .btn-batch-delete {
    width: 100%;
  }
}
</style>
