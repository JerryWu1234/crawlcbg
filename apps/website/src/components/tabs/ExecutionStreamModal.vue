<script setup lang="ts">
import type { BrowserTab, ExecutionLogEntry, TraceFrame } from "../../types/automation";

const props = defineProps<{
  tab: BrowserTab;
  scriptName: string;
  isExecuting: boolean;
  logs: readonly ExecutionLogEntry[];
  currentFrame: TraceFrame | null;
}>();

const emit = defineEmits<{
  stop: [];
  close: [];
}>();
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="execution-modal-card">
      <div class="modal-header">
        <div class="modal-title">
          <span class="pulse-status-dot" :class="{ active: props.isExecuting }"></span>
          <h3>Tab #{{ props.tab.index + 1 }} 脚本实时执行</h3>
          <span class="script-tag">📄 {{ props.scriptName }}</span>
        </div>
        <button class="btn-close-modal" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body execution-body">
        <div class="target-tab-info">
          <span class="tab-target-label">目标页签:</span>
          <span class="tab-target-title">{{ props.tab.title || props.tab.url }}</span>
        </div>

        <div v-if="props.currentFrame" class="live-frame-preview">
          <img :src="props.currentFrame.frameUrl" class="live-frame-img" />
          <div class="frame-overlay-badge">
            <span>Step #{{ props.currentFrame.step }} [{{ props.currentFrame.time }}]</span>
            <span>{{ props.currentFrame.message }}</span>
          </div>
        </div>

        <div class="modal-terminal-box">
          <div
            v-for="(log, index) in props.logs"
            :key="index"
            class="modal-log-line"
            :class="log.type"
          >
            <span class="log-time">{{ log.time }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button v-if="props.isExecuting" class="btn-stop-execution" @click="emit('stop')">
          ⏹️ 停止运行
        </button>
        <button class="btn-close-modal-footer" @click="emit('close')">关闭窗口</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.execution-modal-card {
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

.modal-header {
  padding: 1rem 1.25rem;
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
  font-size: 1.05rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.script-tag {
  font-size: 0.75rem;
  font-weight: 600;
  color: #4f46e5;
  background-color: #e0e7ff;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}

.pulse-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.pulse-status-dot.active {
  background-color: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.25);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(0.95);
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(0.95);
  }
}

.btn-close-modal {
  background: none;
  border: none;
  font-size: 1.1rem;
  color: #94a3b8;
  cursor: pointer;
}

.execution-body {
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.target-tab-info {
  font-size: 0.85rem;
  color: #475569;
  background-color: #f8fafc;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
}

.tab-target-label {
  font-weight: 600;
  margin-right: 0.35rem;
}

.live-frame-preview {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #0f172a;
  background-color: #000;
}

.live-frame-img {
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  display: block;
}

.frame-overlay-badge {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(15, 23, 42, 0.85);
  color: #f8fafc;
  padding: 0.4rem 0.75rem;
  font-size: 0.75rem;
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.modal-terminal-box {
  background-color: #0f172a;
  color: #f8fafc;
  padding: 0.85rem;
  border-radius: 8px;
  font-family: monospace;
  font-size: 0.8rem;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.modal-log-line {
  display: flex;
  gap: 0.5rem;
  word-break: break-all;
}

.log-time {
  color: #64748b;
  font-size: 0.75rem;
}

.log-msg {
  color: #e2e8f0;
}

.modal-footer {
  padding: 0.85rem 1.25rem;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.btn-stop-execution {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-close-modal-footer {
  background-color: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
</style>
