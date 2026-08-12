<script setup lang="ts">
import type { PinnedTab, PinnedTabStatus } from "../../types/automation";

const props = defineProps<{
  pinnedTabs: readonly PinnedTab[];
  statuses: Readonly<Record<string, PinnedTabStatus>>;
  runningStates: Readonly<Record<string, boolean>>;
}>();

const emit = defineEmits<{
  "create-pinned": [];
  "toggle-run": [pinned: PinnedTab];
  "open-history": [pinned: PinnedTab];
  "delete-pinned": [id: string];
}>();

const fallbackStatus: PinnedTabStatus = {
  type: "closed",
  text: "⚪ 未打开 (点击将自动创建页签并载入)",
  index: -1,
};

const getStatus = (id: string) => props.statuses[id] ?? fallbackStatus;
const isRunning = (id: string) => props.runningStates[id] ?? false;
</script>

<template>
  <div class="pinned-section">
    <div class="section-title-bar">
      <div class="section-title">
        <span class="pin-badge-icon">📌</span>
        <h3>常驻置顶页签</h3>
        <span class="section-subtitle">固定预设网页 · 自动检查开页纠偏重定向一键自动化起航</span>
      </div>
      <div class="title-bar-actions">
        <span class="pinned-count">共 {{ props.pinnedTabs.length }} 个常驻预设</span>
        <button class="btn-add-pinned-small" @click="emit('create-pinned')">+ 新建预设</button>
      </div>
    </div>

    <div class="pinned-grid">
      <div v-for="pinned in props.pinnedTabs" :key="pinned.id" class="pinned-card">
        <div class="pinned-card-header">
          <span class="pinned-tag">📌 常驻预设</span>
          <span class="pinned-status-badge" :class="getStatus(pinned.id).type">
            {{ getStatus(pinned.id).text }}
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
            :class="{ 'btn-running-cancel': isRunning(pinned.id) }"
            :title="
              isRunning(pinned.id)
                ? '点击取消此脚本的运行'
                : '自动查找/新建页签并导航至目标 URL 一键执行脚本'
            "
            @click="emit('toggle-run', pinned)"
          >
            <template v-if="isRunning(pinned.id)">
              <span class="btn-text-default">⏳ 运行中</span>
              <span class="btn-text-hover">🛑 取消</span>
            </template>
            <template v-else> ▶️ 运行 </template>
          </button>
          <button
            class="action-btn logs-btn-tab"
            title="查看此预设网页的历史执行日志"
            @click="emit('open-history', pinned)"
          >
            <span>📜 日志</span>
          </button>
          <button
            class="btn-delete-pinned"
            title="移除此常驻预设"
            @click="emit('delete-pinned', pinned.id)"
          >
            🗑️ 移除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.btn-launch-pinned {
  flex: 1;
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  border: 1px solid #059669;
  color: white;
  white-space: nowrap;
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 700;
  height: 34px;
  box-sizing: border-box;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
}

.btn-launch-pinned:hover {
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

.btn-running-cancel,
.btn-launch-pinned.btn-running-cancel {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
  border-color: #2563eb !important;
  color: white !important;
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3) !important;
  position: relative;
  overflow: hidden;
}

.btn-running-cancel .btn-text-default {
  display: inline !important;
}

.btn-running-cancel .btn-text-hover {
  display: none !important;
}

.btn-running-cancel:hover,
.btn-launch-pinned.btn-running-cancel:hover {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
  border-color: #dc2626 !important;
  color: white !important;
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35) !important;
  transform: translateY(-1px);
}

.btn-running-cancel:hover .btn-text-default {
  display: none !important;
}

.btn-running-cancel:hover .btn-text-hover {
  display: inline !important;
}
</style>
