<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  searchQuery: string;
  autoRefresh: boolean;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  "update:search-query": [value: string];
  "create-pinned": [];
  "toggle-auto-refresh": [];
  refresh: [];
}>();

const searchQueryModel = computed({
  get: () => props.searchQuery,
  set: (value: string) => emit("update:search-query", value),
});
</script>

<template>
  <div class="controls-card">
    <div class="search-box">
      <svg
        class="search-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input
        v-model="searchQueryModel"
        type="text"
        placeholder="搜索标签页标题或网址 URL..."
        class="search-input"
      />
      <button
        v-if="props.searchQuery"
        class="clear-search"
        @click="emit('update:search-query', '')"
      >
        ✕
      </button>
    </div>

    <div class="action-buttons">
      <button class="btn-add-pinned" title="手动新增常驻预设网页" @click="emit('create-pinned')">
        📌 + 新建常驻预设
      </button>

      <button
        class="auto-refresh-toggle"
        :class="{ active: props.autoRefresh }"
        title="每5秒自动刷新"
        @click="emit('toggle-auto-refresh')"
      >
        <span class="toggle-indicator"></span>
        <span>5s 自动刷新</span>
      </button>

      <button class="btn-primary" :disabled="props.isLoading" @click="emit('refresh')">
        <svg
          :class="{ spin: props.isLoading }"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M23 4v6h-6"></path>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        <span>{{ props.isLoading ? "刷新中..." : "刷新列表" }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.controls-card {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  box-shadow: var(--shadow-sm);
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 0.5rem 0.8rem;
  flex: 1;
  min-width: 280px;
  transition: border-color 0.2s ease;
}

.search-box:focus-within {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.search-icon {
  color: #94a3b8;
}

.search-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 0.9rem;
  color: #0f172a;
  width: 100%;
}

.clear-search {
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  font-size: 0.9rem;
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.auto-refresh-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #475569;
  padding: 0.5rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.auto-refresh-toggle:hover {
  background-color: #e2e8f0;
}

.auto-refresh-toggle.active {
  background-color: #e0e7ff;
  color: #4f46e5;
  border-color: #c7d2fe;
}

.toggle-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.auto-refresh-toggle.active .toggle-indicator {
  background-color: #4f46e5;
  box-shadow: 0 0 6px rgba(79, 70, 229, 0.6);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #4f46e5;
  color: white;
  border: none;
  padding: 0.55rem 1.1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2);
}

.btn-primary:hover:not(:disabled) {
  background-color: #4338ca;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(79, 70, 229, 0.3);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-add-pinned {
  background-color: #fef3c7;
  border: 1px solid #fde68a;
  color: #b45309;
  font-weight: 700;
  padding: 0.4rem 0.85rem;
  border-radius: 8px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-add-pinned:hover {
  background-color: #f59e0b;
  color: white;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
