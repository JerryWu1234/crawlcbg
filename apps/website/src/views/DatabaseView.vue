<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import DatabaseDataGrid from "../components/database/DatabaseDataGrid.vue";
import DatabaseManagerHeader from "../components/database/DatabaseManagerHeader.vue";
import DatabaseMetrics from "../components/database/DatabaseMetrics.vue";
import DatabasePagination from "../components/database/DatabasePagination.vue";
import type { DbRow, DbTableInfo } from "../types/automation";

const tables = ref<DbTableInfo[]>([]);
const selectedTable = ref("");
const rows = ref<DbRow[]>([]);
const searchKeyword = ref("");
const isLoadingRows = ref(false);

const currentPage = ref(1);
const pageSize = ref(20);
const totalRecords = ref(0);
const totalPages = ref(1);

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
  return tables.value.reduce((sum, table) => sum + (table.count || 0), 0);
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
  const current = currentPage.value;

  let start = Math.max(1, current - 2);
  let end = Math.min(total, current + 2);

  if (current <= 3) {
    end = Math.min(total, 5);
  }
  if (current >= total - 2) {
    start = Math.max(1, total - 4);
  }

  for (let page = start; page <= end; page++) {
    pages.push(page);
  }
  return pages;
});

const fetchTables = async () => {
  try {
    const response = await fetch("http://localhost:3001/api/db/tables");
    if (response.ok) {
      const data = await response.json();
      tables.value = data.tables || [];
      if (tables.value.length > 0 && !selectedTable.value) {
        selectedTable.value = tables.value[0].name;
      }
      if (selectedTable.value) {
        await fetchRows();
      }
    }
  } catch (error) {
    console.error("Fetch tables error:", error);
  }
};

const fetchRows = async () => {
  if (!selectedTable.value) return;
  isLoadingRows.value = true;
  try {
    const search = encodeURIComponent(searchKeyword.value.trim());
    const response = await fetch(
      `http://localhost:3001/api/db/data?table=${selectedTable.value}&search=${search}&page=${currentPage.value}&pageSize=${pageSize.value}`,
    );
    if (response.ok) {
      const data = await response.json();
      rows.value = data.rows || [];
      totalRecords.value = data.total || 0;
      totalPages.value = data.totalPages || 1;
      currentPage.value = data.page || 1;
    }
  } catch (error) {
    console.error("Fetch rows error:", error);
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

const changePageSize = (nextPageSize: number) => {
  pageSize.value = nextPageSize;
  currentPage.value = 1;
  fetchRows();
};

const clearCurrentTable = async () => {
  if (!selectedTable.value) return;
  if (!confirm(`确认要清空数据表 '${selectedTable.value}' 中的所有数据吗？`)) return;
  try {
    const response = await fetch("http://localhost:3001/api/db/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: selectedTable.value }),
    });
    if (response.ok) {
      await fetchTables();
      await fetchRows();
    }
  } catch (error: any) {
    alert(`清空表失败: ${error.message}`);
  }
};

const deleteSingleRow = async (row: DbRow) => {
  const primaryKey = primaryKeyCol.value;
  const value = row[primaryKey];
  if (!value) return;
  if (!confirm(`确认要删除此条记录 (${primaryKey} = ${value}) 吗？`)) return;

  try {
    const response = await fetch("http://localhost:3001/api/db/delete-row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: selectedTable.value,
        primaryKey,
        primaryValue: value,
      }),
    });
    if (response.ok) {
      await fetchTables();
      await fetchRows();
    }
  } catch (error: any) {
    alert(`删除记录失败: ${error.message}`);
  }
};

const exportAsJson = () => {
  if (rows.value.length === 0) return;
  const json = JSON.stringify(rows.value, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${selectedTable.value}_${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

onMounted(() => {
  fetchTables();
});
</script>

<template>
  <div class="database-page">
    <DatabaseMetrics :table-count="tables.length" :total-records-count="totalRecordsCount" />

    <div class="data-manager-card">
      <DatabaseManagerHeader
        :tables="tables"
        :selected-table="selectedTable"
        :search-keyword="searchKeyword"
        :rows-count="rows.length"
        @switch-table="switchTable"
        @search-keyword-change="searchKeyword = $event"
        @search="onSearch"
        @refresh="fetchRows"
        @export="exportAsJson"
        @clear="clearCurrentTable"
      />

      <DatabaseDataGrid
        :is-loading-rows="isLoadingRows"
        :table-count="tables.length"
        :selected-table="selectedTable"
        :rows="rows"
        :columns="columns"
        :current-page="currentPage"
        :page-size="pageSize"
        @delete-row="deleteSingleRow"
      />

      <DatabasePagination
        :total-records="totalRecords"
        :current-page="currentPage"
        :page-size="pageSize"
        :total-pages="totalPages"
        :page-numbers="pageNumbers"
        @page-change="changePage"
        @page-size-change="changePageSize"
      />
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
</style>
