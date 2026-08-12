<script setup lang="ts">
defineProps<{
  tableCount: number;
  totalRecordsCount: number;
}>();
</script>

<template>
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-icon purple">🗄️</div>
      <div class="metric-info">
        <span class="metric-label">数据表总数 (Tables)</span>
        <span class="metric-value">{{ tableCount }} 个</span>
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
</template>

<style scoped>
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
</style>
