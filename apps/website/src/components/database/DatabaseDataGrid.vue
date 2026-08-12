<script setup lang="ts">
import type { DbRow } from "../../types/automation";

defineProps<{
  isLoadingRows: boolean;
  tableCount: number;
  selectedTable: string;
  rows: DbRow[];
  columns: string[];
  currentPage: number;
  pageSize: number;
}>();

const emit = defineEmits<{
  deleteRow: [row: DbRow];
}>();

const isJsonString = (value: any): boolean => {
  if (
    typeof value !== "string" ||
    (!value.trim().startsWith("{") && !value.trim().startsWith("["))
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
};

const formatJson = (value: string): string => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};
</script>

<template>
  <div class="grid-container">
    <div v-if="isLoadingRows" class="grid-loading">
      <span>正在查询 SQLite 数据库...</span>
    </div>

    <div v-else-if="tableCount === 0" class="grid-empty">
      <div class="empty-icon">🗄️</div>
      <p>
        暂无 SQLite 数据表。在脚本中使用 <code>db.exec()</code> 和 <code>db.upsert()</code>
        保存数据后即可在此管理。
      </p>
    </div>

    <div v-else-if="rows.length === 0" class="grid-empty">
      <div class="empty-icon">🔍</div>
      <p>
        当前表 <code>{{ selectedTable }}</code> 中没有检索到符合条件的数据。
      </p>
    </div>

    <div v-else class="table-scroll-wrapper">
      <table class="db-data-table">
        <thead>
          <tr>
            <th class="col-index">#</th>
            <th v-for="column in columns" :key="column" class="col-header">{{ column }}</th>
            <th class="col-action">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="index" class="data-row">
            <td class="col-index">{{ (currentPage - 1) * pageSize + index + 1 }}</td>
            <td v-for="column in columns" :key="column" class="cell-content">
              <a
                v-if="column === 'href' || column === 'url'"
                :href="row[column]"
                target="_blank"
                class="cell-link"
                :title="row[column]"
              >
                🔗 {{ row[column] }}
              </a>

              <pre v-else-if="isJsonString(row[column])" class="json-code-preview">{{
                formatJson(row[column])
              }}</pre>

              <div v-else class="full-multiline-text">{{ row[column] ?? "(null)" }}</div>
            </td>

            <td class="col-action">
              <button class="btn-row-delete" title="删除此行记录" @click="emit('deleteRow', row)">
                🗑️ 删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.grid-container {
  min-height: 400px;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}

.grid-loading,
.grid-empty {
  padding: 4rem 2rem;
  text-align: center;
  color: #94a3b8;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.empty-icon {
  font-size: 2.5rem;
}

.table-scroll-wrapper {
  overflow-x: auto;
  width: 100%;
  max-width: 100%;
}

.db-data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  text-align: left;
}

.db-data-table th {
  background-color: #f8fafc;
  color: #475569;
  font-weight: 700;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #e2e8f0;
  white-space: nowrap;
}

.col-index {
  width: 50px;
  text-align: center;
  color: #94a3b8;
}

.col-action {
  width: 140px;
  text-align: center;
}

.data-row {
  border-bottom: 1px solid #f1f5f9;
  transition: background-color 0.15s ease;
}

.data-row:hover {
  background-color: #f8fafc;
}

.cell-content {
  padding: 0.85rem 1rem;
  color: #0f172a;
  vertical-align: top;
  max-width: 450px;
}

.full-multiline-text {
  font-size: 0.85rem;
  line-height: 1.5;
  color: #334155;
  white-space: pre-wrap;
  word-break: break-word;
  min-width: 150px;
}

.json-code-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.45;
  background-color: #0f172a;
  color: #38bdf8;
  padding: 0.5rem;
  border-radius: 6px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.cell-link {
  color: #4f46e5;
  text-decoration: none;
  font-weight: 500;
  word-break: break-all;
  white-space: pre-wrap;
  display: block;
}

.cell-link:hover {
  text-decoration: underline;
}

.btn-row-delete {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #dc2626;
  padding: 0.25rem 0.55rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-row-delete:hover {
  background-color: #dc2626;
  color: white;
}
</style>
