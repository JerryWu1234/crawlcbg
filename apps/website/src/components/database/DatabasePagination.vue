<script setup lang="ts">
defineProps<{
  totalRecords: number;
  currentPage: number;
  pageSize: number;
  totalPages: number;
  pageNumbers: number[];
}>();

const emit = defineEmits<{
  pageChange: [page: number];
  pageSizeChange: [pageSize: number];
}>();

const changePageSize = (event: Event) => {
  emit("pageSizeChange", Number((event.target as HTMLSelectElement).value));
};
</script>

<template>
  <div v-if="totalRecords > 0" class="pagination-footer-bar">
    <div class="pagination-info">
      <span>
        显示第 <strong>{{ (currentPage - 1) * pageSize + 1 }}</strong> -
        <strong>{{ Math.min(currentPage * pageSize, totalRecords) }}</strong> 条，共
        <strong>{{ totalRecords }}</strong> 条记录
      </span>

      <div class="page-size-selector">
        <label class="size-label">每页显示:</label>
        <select :value="pageSize" class="size-select" @change="changePageSize">
          <option :value="10">10 条</option>
          <option :value="20">20 条</option>
          <option :value="50">50 条</option>
          <option :value="100">100 条</option>
        </select>
      </div>
    </div>

    <div class="pagination-controls">
      <button
        class="page-btn"
        :disabled="currentPage <= 1"
        title="首页"
        @click="emit('pageChange', 1)"
      >
        ⏮️
      </button>

      <button
        class="page-btn"
        :disabled="currentPage <= 1"
        title="上一页"
        @click="emit('pageChange', currentPage - 1)"
      >
        ◀️
      </button>

      <button
        v-for="page in pageNumbers"
        :key="page"
        class="page-number-btn"
        :class="{ active: page === currentPage }"
        @click="emit('pageChange', page)"
      >
        {{ page }}
      </button>

      <button
        class="page-btn"
        :disabled="currentPage >= totalPages"
        title="下一页"
        @click="emit('pageChange', currentPage + 1)"
      >
        ▶️
      </button>

      <button
        class="page-btn"
        :disabled="currentPage >= totalPages"
        title="尾页"
        @click="emit('pageChange', totalPages)"
      >
        ⏭️
      </button>
    </div>
  </div>
</template>

<style scoped>
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
