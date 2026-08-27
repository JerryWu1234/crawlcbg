<script setup lang="ts">
import { computed } from "vue";
import type { DbRow, DbTableInfo } from "../../types/automation";

const props = defineProps<{
  open: boolean;
  dbTables: readonly DbTableInfo[];
  selectedTable: string;
  dbRows: readonly DbRow[];
  dbColumns: readonly string[];
  dbSearchInput: string;
  isLoadingDb: boolean;
}>();

const emit = defineEmits<{
  close: [];
  "update:selectedTable": [table: string];
  "update:dbSearchInput": [value: string];
  refresh: [];
  export: [];
  clear: [];
}>();

const selectedTableModel = computed({
  get: () => props.selectedTable,
  set: (value: string) => emit("update:selectedTable", value),
});

const dbSearchInputModel = computed({
  get: () => props.dbSearchInput,
  set: (value: string) => emit("update:dbSearchInput", value),
});
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div class="db-modal-card">
      <div class="modal-header">
        <div class="modal-title">
          <span class="db-header-icon">🗄️</span>
          <h3>SQLite 爬取数据查看器</h3>
        </div>
        <button class="btn-close-modal" @click="emit('close')">✕</button>
      </div>

      <div class="modal-toolbar">
        <div class="table-selector-group">
          <label class="db-label">选择数据表:</label>
          <select v-model="selectedTableModel" class="table-select" @change="emit('refresh')">
            <option v-for="table in dbTables" :key="table.name" :value="table.name">
              {{ table.name }} ({{ table.count }} 条数据)
            </option>
          </select>
        </div>

        <div class="search-box-group">
          <input
            v-model="dbSearchInputModel"
            type="text"
            placeholder="按 eid / 名称搜索..."
            class="db-search-input"
            @keyup.enter="emit('refresh')"
          />
          <button class="btn-search-db" @click="emit('refresh')">搜索</button>
        </div>

        <div class="db-action-buttons">
          <button class="btn-export-json" :disabled="dbRows.length === 0" @click="emit('export')">
            📥 导出 JSON
          </button>
          <button class="btn-clear-db" :disabled="!selectedTable" @click="emit('clear')">
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
                <th v-for="column in dbColumns" :key="column">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in dbRows" :key="index">
                <td v-for="column in dbColumns" :key="column" :title="String(row[column])">
                  {{ row[column] }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

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

/* Allow toolbar groups to share space cleanly and stack before they overflow. */
.modal-overlay {
  padding: 1rem;
}

.db-modal-card {
  width: min(100%, 1040px);
  max-width: 1040px;
  max-height: calc(100dvh - 2rem);
}

.modal-header {
  flex-shrink: 0;
  gap: 1rem;
}

.modal-title,
.table-selector-group,
.search-box-group,
.db-action-buttons {
  min-width: 0;
}

.modal-title h3 {
  overflow-wrap: anywhere;
}

.btn-close-modal {
  flex-shrink: 0;
}

.table-selector-group {
  flex: 1 1 220px;
}

.table-select {
  min-width: 0;
  max-width: 100%;
  flex: 1;
}

.search-box-group {
  flex: 1 1 260px;
}

.db-search-input {
  width: auto;
  min-width: 0;
  flex: 1;
}

.db-action-buttons {
  flex: 0 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.modal-body.db-grid-body {
  min-height: 0;
  padding: 1rem;
}

@media (max-width: 760px) {
  .modal-overlay {
    padding: 0.75rem;
  }

  .db-modal-card {
    max-height: calc(100dvh - 1.5rem);
    border-radius: 14px;
  }

  .modal-header,
  .modal-toolbar {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .modal-toolbar {
    align-items: stretch;
    gap: 0.75rem;
  }

  .table-selector-group,
  .search-box-group,
  .db-action-buttons {
    width: 100%;
    flex-basis: 100%;
  }

  .db-action-buttons {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .db-action-buttons button {
    min-width: 0;
  }
}

@media (max-width: 460px) {
  .table-selector-group {
    align-items: stretch;
    flex-direction: column;
  }

  .search-box-group {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
}
</style>
