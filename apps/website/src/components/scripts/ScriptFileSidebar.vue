<script setup lang="ts">
import type { ScriptItem } from "../../types/automation";

defineProps<{
  scripts: readonly ScriptItem[];
  activeFilename: string;
  isLoadingScripts: boolean;
}>();

const emit = defineEmits<{
  "open-ai": [];
  create: [];
  select: [item: ScriptItem];
  delete: [filename: string];
}>();
</script>

<template>
  <aside class="file-sidebar">
    <div class="sidebar-header">
      <h3>JS / MJS 脚本列表</h3>
      <div class="sidebar-actions-group">
        <button class="btn-ai-sidebar" title="AI 一键生成脚本" @click="emit('open-ai')">
          ✨ AI 生成
        </button>
        <button class="btn-new" title="新建脚本" @click="emit('create')">+ 新建</button>
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
        @click="emit('select', item)"
      >
        <div class="file-info">
          <span class="file-icon">📄</span>
          <span class="file-name" :title="item.filename">{{ item.filename }}</span>
        </div>
        <button class="btn-delete" title="删除脚本" @click.stop="emit('delete', item.filename)">
          🗑️
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
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
</style>
