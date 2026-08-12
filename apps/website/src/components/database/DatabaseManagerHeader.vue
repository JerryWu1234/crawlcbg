<script setup lang="ts">
import { computed } from "vue";
import type { DbTableInfo } from "../../types/automation";

const props = defineProps<{
  tables: DbTableInfo[];
  selectedTable: string;
  searchKeyword: string;
  rowsCount: number;
}>();

const emit = defineEmits<{
  switchTable: [tableName: string];
  searchKeywordChange: [value: string];
  search: [];
  refresh: [];
  export: [];
  clear: [];
}>();

const searchKeywordModel = computed({
  get: () => props.searchKeyword,
  set: (value: string) => emit("searchKeywordChange", value),
});
</script>

<template>
  <div class="card-header-bar">
    <div class="table-tabs-list">
      <span class="tabs-label">选择数据表:</span>
      <button
        v-for="table in tables"
        :key="table.name"
        class="table-tab-btn"
        :class="{ active: selectedTable === table.name }"
        @click="emit('switchTable', table.name)"
      >
        <span class="tab-name">{{ table.name }}</span>
        <span class="tab-count">{{ table.count }}</span>
      </button>
    </div>

    <div class="table-actions-toolbar">
      <div class="search-input-box">
        <svg
          class="search-icon"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          v-model="searchKeywordModel"
          type="text"
          placeholder="按 eid / 名称搜索..."
          class="search-input"
          @keyup.enter="emit('search')"
        />
      </div>

      <button class="btn-action-db refresh" title="刷新数据" @click="emit('refresh')">
        🔄 刷新
      </button>

      <button
        class="btn-action-db export"
        :disabled="rowsCount === 0"
        title="导出 JSON 文件"
        @click="emit('export')"
      >
        📥 导出 JSON
      </button>

      <button
        class="btn-action-db clear"
        :disabled="!selectedTable"
        title="清空表"
        @click="emit('clear')"
      >
        🗑️ 清空表
      </button>
    </div>
  </div>
</template>

<style scoped>
.card-header-bar {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #e2e8f0;
  background-color: #f8fafc;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.table-tabs-list {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.tabs-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #64748b;
}

.table-tab-btn {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
  padding: 0.35rem 0.85rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: all 0.2s ease;
}

.table-tab-btn:hover {
  border-color: #4f46e5;
  color: #4f46e5;
}

.table-tab-btn.active {
  background-color: #4f46e5;
  border-color: #4f46e5;
  color: white;
}

.tab-count {
  font-size: 0.75rem;
  background-color: rgba(0, 0, 0, 0.1);
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
}

.table-tab-btn.active .tab-count {
  background-color: rgba(255, 255, 255, 0.25);
}

.table-actions-toolbar {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.search-input-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 0.75rem;
  color: #94a3b8;
}

.search-input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.4rem 0.75rem 0.4rem 2.2rem;
  font-size: 0.85rem;
  color: #0f172a;
  outline: none;
  width: 220px;
}

.search-input:focus {
  border-color: #4f46e5;
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.1);
}

.btn-action-db {
  border: 1px solid #cbd5e1;
  padding: 0.4rem 0.85rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-action-db.refresh {
  background-color: #ffffff;
  color: #334155;
}

.btn-action-db.export {
  background-color: #e0e7ff;
  border-color: #c7d2fe;
  color: #4f46e5;
}

.btn-action-db.clear {
  background-color: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}

.btn-action-db:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
