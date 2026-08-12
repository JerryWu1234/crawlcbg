<script setup lang="ts">
type TabsState = "loading" | "error" | "empty";

const props = defineProps<{
  state: TabsState;
  error: string | null;
  searchQuery: string;
}>();

const emit = defineEmits<{
  retry: [];
}>();
</script>

<template>
  <div
    class="state-container"
    :class="{ 'error-state': props.state === 'error', 'empty-state': props.state === 'empty' }"
  >
    <template v-if="props.state === 'loading'">
      <div class="spinner"></div>
      <p class="state-text">正在读取已打开的浏览器标签页...</p>
    </template>

    <template v-else-if="props.state === 'error'">
      <div class="state-icon-wrapper error">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </div>
      <h3 class="state-title">后台 API 连接错误</h3>
      <p class="state-desc">{{ props.error }}</p>
      <button class="btn-primary" @click="emit('retry')">重试连接</button>
    </template>

    <template v-else>
      <div class="state-icon-wrapper empty">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
      </div>
      <h3 class="state-title">未找到匹配的标签页</h3>
      <p v-if="props.searchQuery" class="state-desc">
        没有与 "{{ props.searchQuery }}" 匹配的标签页，请检查搜索关键词
      </p>
      <p v-else class="state-desc">当前 Chrome 窗口中似乎没有打开任何标签页</p>
    </template>
  </div>
</template>

<style scoped>
.state-container {
  background-color: #ffffff;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  padding: 4rem 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 1rem;
}

.spinner {
  width: 42px;
  height: 42px;
  border: 3px solid #e2e8f0;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.state-text {
  color: #64748b;
  font-size: 1rem;
}

.state-icon-wrapper {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.state-icon-wrapper.error {
  background-color: #fef2f2;
  color: #ef4444;
}

.state-icon-wrapper.empty {
  background-color: #f8fafc;
  color: #94a3b8;
}

.state-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.state-desc {
  font-size: 0.95rem;
  color: #64748b;
  max-width: 480px;
  margin: 0;
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

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
