<script setup lang="ts">
import { ref, onMounted, computed } from "vue";

interface DbTableInfo {
  name: string;
  count: number;
}

const tables = ref<DbTableInfo[]>([]);
const selectedTable = ref<string>("");
const rows = ref<any[]>([]);
const searchKeyword = ref<string>("");
const isLoadingTables = ref(false);
const isLoadingRows = ref(false);

// Pagination State
const currentPage = ref<number>(1);
const pageSize = ref<number>(20);
const totalRecords = ref<number>(0);
const totalPages = ref<number>(1);

// Multiline & Detail Modal State
const expandedCells = ref<Record<string, boolean>>({});
const selectedDetailRow = ref<any | null>(null);

const isMultiLine = (val: any): boolean => {
  if (val === null || val === undefined) return false;
  const str = String(val);
  return str.includes("\n") || str.length > 50;
};

const isJsonString = (val: any): boolean => {
  if (typeof val !== "string" || (!val.trim().startsWith("{") && !val.trim().startsWith("[")))
    return false;
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
};

const formatJson = (val: string): string => {
  try {
    return JSON.stringify(JSON.parse(val), null, 2);
  } catch {
    return val;
  }
};

const toggleCellExpand = (rowIdx: number, colKey: string) => {
  const key = `${rowIdx}_${colKey}`;
  expandedCells.value[key] = !expandedCells.value[key];
};

const isCellExpanded = (rowIdx: number, colKey: string): boolean => {
  return !!expandedCells.value[`${rowIdx}_${colKey}`];
};

const openRowDetailModal = (row: any) => {
  selectedDetailRow.value = row;
};

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text);
  alert("📋 已成功复制内容到剪贴板！");
};

const columns = computed(() => {
  if (
    !rows.value ||
    rows.value.length === 0 ||
    !rows.value[0] ||
    typeof rows.value[0] !== "object"
  ) {
    return [];
  }
  return Object.keys(rows.value[0]);
});

const totalRecordsCount = computed(() => {
  return tables.value.reduce((sum, t) => sum + (t.count || 0), 0);
});

const primaryKeyCol = computed(() => {
  if (columns.value.includes("eid")) return "eid";
  if (columns.value.includes("id")) return "id";
  if (columns.value.includes("url")) return "url";
  return columns.value[0] || "rowid";
});

const pageNumbers = computed(() => {
  const pages: number[] = [];
  const total = totalPages.value;
  const curr = currentPage.value;

  let start = Math.max(1, curr - 2);
  let end = Math.min(total, curr + 2);

  if (curr <= 3) {
    end = Math.min(total, 5);
  }
  if (curr >= total - 2) {
    start = Math.max(1, total - 4);
  }

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  return pages;
});

const fetchTables = async () => {
  isLoadingTables.value = true;
  try {
    const res = await fetch("http://localhost:3001/api/db/tables");
    if (res.ok) {
      const data = await res.json();
      tables.value = data.tables || [];
      if (tables.value.length > 0 && !selectedTable.value) {
        selectedTable.value = tables.value[0].name;
      }
      if (selectedTable.value) {
        await fetchRows();
      }
    }
  } catch (err) {
    console.error("Fetch tables error:", err);
  } finally {
    isLoadingTables.value = false;
  }
};

const fetchRows = async () => {
  if (!selectedTable.value) return;
  isLoadingRows.value = true;
  try {
    const search = encodeURIComponent(searchKeyword.value.trim());
    const res = await fetch(
      `http://localhost:3001/api/db/data?table=${selectedTable.value}&search=${search}&page=${currentPage.value}&pageSize=${pageSize.value}`,
    );
    if (res.ok) {
      const data = await res.json();
      rows.value = data.rows || [];
      totalRecords.value = data.total || 0;
      totalPages.value = data.totalPages || 1;
      currentPage.value = data.page || 1;
    }
  } catch (err) {
    console.error("Fetch rows error:", err);
  } finally {
    isLoadingRows.value = false;
  }
};

const switchTable = (tableName: string) => {
  selectedTable.value = tableName;
  searchKeyword.value = "";
  currentPage.value = 1;
  fetchRows();
};

const onSearch = () => {
  currentPage.value = 1;
  fetchRows();
};

const changePage = (page: number) => {
  if (page < 1 || page > totalPages.value) return;
  currentPage.value = page;
  fetchRows();
};

const changePageSize = () => {
  currentPage.value = 1;
  fetchRows();
};

const clearCurrentTable = async () => {
  if (!selectedTable.value) return;
  if (!confirm(`确认要清空数据表 '${selectedTable.value}' 中的所有数据吗？`)) return;
  try {
    const res = await fetch("http://localhost:3001/api/db/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: selectedTable.value }),
    });
    if (res.ok) {
      await fetchTables();
      await fetchRows();
    }
  } catch (err: any) {
    alert(`清空表失败: ${err.message}`);
  }
};

const deleteSingleRow = async (row: any) => {
  const pk = primaryKeyCol.value;
  const val = row[pk];
  if (!val) return;
  if (!confirm(`确认要删除此条记录 (${pk} = ${val}) 吗？`)) return;

  try {
    const res = await fetch("http://localhost:3001/api/db/delete-row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: selectedTable.value,
        primaryKey: pk,
        primaryValue: val,
      }),
    });
    if (res.ok) {
      await fetchTables();
      await fetchRows();
    }
  } catch (err: any) {
    alert(`删除记录失败: ${err.message}`);
  }
};

const exportAsJson = () => {
  if (rows.value.length === 0) return;
  const jsonStr = JSON.stringify(rows.value, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${selectedTable.value}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

onMounted(() => {
  fetchTables();
});
</script>

<template>
  <div class="database-page">
    <!-- Top Summary Metrics Cards -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-icon purple">🗄️</div>
        <div class="metric-info">
          <span class="metric-label">数据表总数 (Tables)</span>
          <span class="metric-value">{{ tables.length }} 个</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon blue">📦</div>
        <div class="metric-info">
          <span class="metric-label">已爬取存储记录数 (Total Records)</span>
          <span class="metric-value">{{ totalRecordsCount }} 条</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon green">💾</div>
        <div class="metric-info">
          <span class="metric-label">数据库类型与文件</span>
          <span class="metric-value small">SQLite (cbg_data.db)</span>
        </div>
      </div>
    </div>

    <!-- Main Table Browser & Management Panel -->
    <div class="data-manager-card">
      <div class="card-header-bar">
        <!-- Tables Tab Pills -->
        <div class="table-tabs-list">
          <span class="tabs-label">选择数据表:</span>
          <button
            v-for="t in tables"
            :key="t.name"
            class="table-tab-btn"
            :class="{ active: selectedTable === t.name }"
            @click="switchTable(t.name)"
          >
            <span class="tab-name">{{ t.name }}</span>
            <span class="tab-count">{{ t.count }}</span>
          </button>
        </div>

        <!-- Controls Toolbar -->
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
              v-model="searchKeyword"
              type="text"
              placeholder="按 eid / 名称搜索..."
              class="search-input"
              @keyup.enter="onSearch"
            />
          </div>

          <button class="btn-action-db refresh" @click="fetchRows" title="刷新数据">🔄 刷新</button>

          <button
            class="btn-action-db export"
            @click="exportAsJson"
            :disabled="rows.length === 0"
            title="导出 JSON 文件"
          >
            📥 导出 JSON
          </button>

          <button
            class="btn-action-db clear"
            @click="clearCurrentTable"
            :disabled="!selectedTable"
            title="清空表"
          >
            🗑️ 清空表
          </button>
        </div>
      </div>

      <!-- Data Grid Table Content -->
      <div class="grid-container">
        <div v-if="isLoadingRows" class="grid-loading">
          <span>正在查询 SQLite 数据库...</span>
        </div>

        <div v-else-if="tables.length === 0" class="grid-empty">
          <div class="empty-icon">🗄️</div>
          <p>
            暂无 SQLite 数据表。在脚本中使用 <code>db.exec()</code> 和
            <code>db.upsert()</code> 保存数据后即可在此管理。
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
                <th v-for="col in columns" :key="col" class="col-header">{{ col }}</th>
                <th class="col-action">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in rows" :key="idx" class="data-row">
                <td class="col-index">{{ (currentPage - 1) * pageSize + idx + 1 }}</td>
                <td v-for="col in columns" :key="col" class="cell-content">
                  <!-- 1. URLs & Links -->
                  <a
                    v-if="col === 'href' || col === 'url'"
                    :href="row[col]"
                    target="_blank"
                    class="cell-link"
                    :title="row[col]"
                  >
                    🔗 {{ row[col] }}
                  </a>

                  <!-- 2. Structured JSON Code Block -->
                  <pre v-else-if="isJsonString(row[col])" class="json-code-preview">{{
                    formatJson(row[col])
                  }}</pre>

                  <!-- 3. Direct Full Multi-line Text (100% visible, no truncation) -->
                  <div v-else class="full-multiline-text">{{ row[col] ?? "(null)" }}</div>
                </td>

                <!-- Action Column: Delete Only -->
                <td class="col-action">
                  <button class="btn-row-delete" @click="deleteSingleRow(row)" title="删除此行记录">
                    🗑️ 删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Pagination Footer Bar -->
      <div v-if="totalRecords > 0" class="pagination-footer-bar">
        <div class="pagination-info">
          <span>
            显示第 <strong>{{ (currentPage - 1) * pageSize + 1 }}</strong> -
            <strong>{{ Math.min(currentPage * pageSize, totalRecords) }}</strong> 条，共
            <strong>{{ totalRecords }}</strong> 条记录
          </span>

          <div class="page-size-selector">
            <label class="size-label">每页显示:</label>
            <select v-model="pageSize" class="size-select" @change="changePageSize">
              <option :value="10">10 条</option>
              <option :value="20">20 条</option>
              <option :value="50">50 条</option>
              <option :value="100">100 条</option>
            </select>
          </div>
        </div>

        <div class="pagination-controls">
          <button class="page-btn" :disabled="currentPage <= 1" @click="changePage(1)" title="首页">
            ⏮️
          </button>

          <button
            class="page-btn"
            :disabled="currentPage <= 1"
            @click="changePage(currentPage - 1)"
            title="上一页"
          >
            ◀️
          </button>

          <button
            v-for="p in pageNumbers"
            :key="p"
            class="page-number-btn"
            :class="{ active: p === currentPage }"
            @click="changePage(p)"
          >
            {{ p }}
          </button>

          <button
            class="page-btn"
            :disabled="currentPage >= totalPages"
            @click="changePage(currentPage + 1)"
            title="下一页"
          >
            ▶️
          </button>

          <button
            class="page-btn"
            :disabled="currentPage >= totalPages"
            @click="changePage(totalPages)"
            title="尾页"
          >
            ⏭️
          </button>
        </div>
      </div>
    </div>

    <!-- 📄 Single Record Full Field Details Modal -->
    <div v-if="selectedDetailRow" class="modal-overlay" @click.self="selectedDetailRow = null">
      <div class="record-detail-modal">
        <div class="modal-header">
          <div class="modal-title">
            <span class="detail-icon">📄</span>
            <h3>单条记录完整字段详情</h3>
          </div>
          <button class="btn-close-modal" @click="selectedDetailRow = null">✕</button>
        </div>

        <div class="modal-body detail-modal-body">
          <div v-for="(val, key) in selectedDetailRow" :key="String(key)" class="detail-field-card">
            <div class="field-header">
              <span class="field-name">{{ String(key) }}</span>
              <button
                class="btn-copy-field"
                @click="copyToClipboard(String(val))"
                title="复制该字段"
              >
                📋 复制字段
              </button>
            </div>

            <div class="field-value-box">
              <pre v-if="isJsonString(val)" class="detail-json-pre">{{
                formatJson(String(val))
              }}</pre>
              <a
                v-else-if="String(key) === 'href' || String(key) === 'url'"
                :href="String(val)"
                target="_blank"
                class="detail-url-link"
              >
                🔗 {{ String(val) }}
              </a>
              <div v-else class="detail-text-val">{{ String(val ?? "(null)") }}</div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-primary-close" @click="selectedDetailRow = null">关闭窗口</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.database-page {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

/* Summary Metrics */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
  width: 100%;
  min-width: 0;
}

.metric-card {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.25rem;
  box-shadow: var(--shadow-sm);
  min-width: 0;
}

.metric-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
}

.metric-icon.purple {
  background-color: #f3e8ff;
}

.metric-icon.blue {
  background-color: #e0f2fe;
}

.metric-icon.green {
  background-color: #dcfce7;
}

.metric-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.metric-label {
  font-size: 0.8rem;
  color: #64748b;
  font-weight: 500;
}

.metric-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: #0f172a;
}

.metric-value.small {
  font-size: 1.1rem;
}

/* Data Manager Panel */
.data-manager-card {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

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

/* Grid Container */
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
  font-size: 0.8rem;
  line-height: 1.45;
  background-color: #0f172a;
  color: #38bdf8;
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
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

/* Multiline Cell Box */
.multiline-cell-box {
  position: relative;
  max-height: 72px;
  overflow: hidden;
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.5rem 0.65rem;
  transition: max-height 0.3s ease;
  min-width: 220px;
  max-width: 360px;
}

.multiline-cell-box.expanded {
  max-height: 380px;
  overflow-y: auto;
}

.multiline-text-content {
  font-size: 0.8rem;
  line-height: 1.45;
  color: #334155;
  white-space: pre-wrap;
  word-break: break-word;
}

.json-code-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  background-color: #0f172a;
  color: #38bdf8;
  padding: 0.5rem;
  border-radius: 6px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.multiline-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.35rem;
  justify-content: flex-end;
}

.btn-cell-expand,
.btn-cell-copy {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #4f46e5;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-cell-expand:hover,
.btn-cell-copy:hover {
  background-color: #4f46e5;
  color: white;
  border-color: #4f46e5;
}

/* Single Record Detail Modal */
.record-detail-modal {
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

.detail-icon {
  font-size: 1.25rem;
}

.detail-modal-body {
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.detail-field-card {
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-name {
  font-size: 0.85rem;
  font-weight: 700;
  color: #4f46e5;
  font-family: monospace;
}

.btn-copy-field {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
}

.field-value-box {
  font-size: 0.85rem;
  color: #0f172a;
  word-break: break-word;
}

.detail-text-val {
  white-space: pre-wrap;
  line-height: 1.5;
}

.detail-json-pre {
  background-color: #0f172a;
  color: #38bdf8;
  padding: 0.75rem;
  border-radius: 8px;
  font-family: monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  margin: 0;
}

.detail-url-link {
  color: #2563eb;
  text-decoration: none;
  word-break: break-all;
}

.detail-url-link:hover {
  text-decoration: underline;
}

.btn-primary-close {
  background-color: #4f46e5;
  color: white;
  border: none;
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}

/* Pagination Footer Bar */
.pagination-footer-bar {
  padding: 0.85rem 1.5rem;
  background-color: #f8fafc;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
  color: #64748b;
}

.pagination-info {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.page-size-selector {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.size-select {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.8rem;
  background-color: #ffffff;
  color: #0f172a;
}

.pagination-controls {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.page-btn,
.page-number-btn {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.page-btn:hover:not(:disabled),
.page-number-btn:hover:not(.active) {
  background-color: #f1f5f9;
  color: #0f172a;
  border-color: #94a3b8;
}

.page-number-btn.active {
  background-color: #4f46e5;
  color: white;
  border-color: #4f46e5;
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
