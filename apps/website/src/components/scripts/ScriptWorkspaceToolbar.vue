<script setup lang="ts">
import { computed } from "vue";
import type { BrowserTab } from "../../types/automation";

const props = defineProps<{
  currentFilenameInput: string;
  currentSelectedTab: BrowserTab | null;
  openTabs: readonly BrowserTab[];
  selectedTabIndex: number;
  isTabDropdownOpen: boolean;
  isRefreshingTabs: boolean;
  totalDbRecordsCount: number;
  totalHistoryCount: number;
  isValidating: boolean;
  isSaving: boolean;
  isExecuting: boolean;
}>();

const emit = defineEmits<{
  "update:currentFilenameInput": [value: string];
  "update:isTabDropdownOpen": [value: boolean];
  "refresh-tabs": [];
  "select-tab": [tab: BrowserTab];
  "open-db": [];
  "open-ai": [];
  "open-history": [];
  validate: [];
  save: [];
  run: [];
}>();

const filenameModel = computed({
  get: () => props.currentFilenameInput,
  set: (value: string) => emit("update:currentFilenameInput", value),
});

const fallbackFavicon =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'><circle cx='12' cy='12' r='10'/></svg>";

const handleFaviconError = (event: Event) => {
  (event.target as HTMLImageElement).src = fallbackFavicon;
};
</script>

<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="filename-box">
        <span class="label">文件名:</span>
        <input
          v-model="filenameModel"
          type="text"
          placeholder="script_name.mjs"
          class="filename-input"
        />
      </div>

      <div class="target-tab-container">
        <span class="label">🎯 目标 Tab:</span>

        <div class="tab-trigger-wrapper">
          <button
            class="tab-trigger-btn"
            @click="emit('update:isTabDropdownOpen', !props.isTabDropdownOpen)"
          >
            <div v-if="currentSelectedTab" class="trigger-content">
              <img
                v-if="currentSelectedTab.favicon"
                :src="currentSelectedTab.favicon"
                class="trigger-icon"
                @error="handleFaviconError"
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
            title="刷新已打开的 Tab 列表"
            @click="emit('refresh-tabs')"
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

          <div v-if="isTabDropdownOpen" class="tab-popover-menu">
            <div class="popover-header">
              <span>选择脚本执行的 Chrome 标签页</span>
              <span class="popover-count">共 {{ openTabs.length }} 个</span>
            </div>

            <div class="popover-body">
              <div
                v-for="tab in openTabs"
                :key="tab.index"
                class="popover-item"
                :class="{ selected: tab.index === selectedTabIndex }"
                @click="emit('select-tab', tab)"
              >
                <div class="item-left">
                  <img
                    v-if="tab.favicon"
                    :src="tab.favicon"
                    class="item-icon"
                    @error="handleFaviconError"
                  />
                  <span v-else class="item-icon-fallback">🌐</span>
                  <span class="item-index">#{{ tab.index + 1 }}</span>
                </div>

                <div class="item-info">
                  <div class="item-title" :title="tab.title">{{ tab.title || tab.url }}</div>
                  <div class="item-url" :title="tab.url">{{ tab.url }}</div>
                </div>

                <div v-if="tab.index === selectedTabIndex" class="item-check">✓</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="toolbar-actions">
      <button class="btn-db-view" title="查看 SQLite 爬取存入的数据表" @click="emit('open-db')">
        🗄️ SQLite 数据 ({{ totalDbRecordsCount }})
      </button>

      <button class="btn-ai-gradient" @click="emit('open-ai')">✨ AI 智能生成</button>

      <button
        class="btn-history"
        title="查看代码修改历史与运行 Trace 轨迹"
        @click="emit('open-history')"
      >
        📜 历史记录 ({{ totalHistoryCount }})
      </button>

      <button class="btn-secondary" :disabled="isValidating" @click="emit('validate')">
        <span v-if="isValidating">⏳ 校验中...</span>
        <span v-else>🧪 语法测试</span>
      </button>

      <button class="btn-save" :disabled="isSaving" @click="emit('save')">
        <span>💾 保存</span>
      </button>

      <button
        class="btn-run"
        :class="{ executing: isExecuting, 'btn-running-cancel': isExecuting }"
        :title="isExecuting ? '点击取消脚本运行' : '在所选页签上一键运行此脚本'"
        @click="emit('run')"
      >
        <template v-if="isExecuting">
          <span class="btn-text-default">⏳ 运行中</span>
          <span class="btn-text-hover">🛑 取消</span>
        </template>
        <span v-else>▶️ 一键运行</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
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
</style>
