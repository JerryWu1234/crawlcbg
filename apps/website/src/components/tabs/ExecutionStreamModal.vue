<script setup lang="ts">
import type {
  ActiveManualStep,
  BrowserTab,
  ExecutionLogEntry,
  ManualExecutionMode,
  TraceFrame,
} from "../../types/automation";

const props = defineProps<{
  tab: BrowserTab;
  scriptName: string;
  executionMode: ManualExecutionMode;
  isExecuting: boolean;
  canCancel: boolean;
  isCancelling: boolean;
  logs: readonly ExecutionLogEntry[];
  currentFrame: TraceFrame | null;
  activeManualStep: ActiveManualStep | null;
  tracePrivacyLocked: boolean;
  isFocusingManualStep: boolean;
}>();

const emit = defineEmits<{
  stop: [];
  close: [];
  focusManualStep: [];
}>();
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="execution-modal-card">
      <div class="modal-header">
        <div class="modal-title">
          <span class="pulse-status-dot" :class="{ active: props.isExecuting }"></span>
          <h3>
            {{
              props.executionMode === "background"
                ? "最小化后台窗口脚本实时执行"
                : `Tab #${props.tab.index + 1} 脚本实时执行`
            }}
          </h3>
          <span class="script-tag">📄 {{ props.scriptName }}</span>
        </div>
        <button class="btn-close-modal" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body execution-body">
        <div class="target-tab-info">
          <span class="tab-target-label">目标页签:</span>
          <span class="tab-target-title">{{ props.tab.title || props.tab.url }}</span>
        </div>

        <section v-if="props.activeManualStep" class="manual-wait-card" role="status">
          <div class="manual-wait-heading">
            <span class="manual-icon" aria-hidden="true">✋</span>
            <div>
              <span>执行已安全暂停</span>
              <h4>{{ props.activeManualStep.title }}</h4>
            </div>
          </div>
          <p>
            请在真实 Chrome 目标页面完成 {{ props.activeManualStep.targetCount }}
            项高亮操作，然后点击页面浮层中的“完成并继续”。
          </p>
          <div class="manual-privacy-note">
            CrawlCBG 不接收字段值；从此步骤起，本次运行不再截图或复用旧画面。
          </div>
          <button
            type="button"
            class="btn-focus-manual"
            :disabled="props.isFocusingManualStep"
            @click="emit('focusManualStep')"
          >
            {{ props.isFocusingManualStep ? "正在聚焦…" : "聚焦目标页面" }}
          </button>
        </section>

        <div v-else-if="props.tracePrivacyLocked" class="manual-privacy-banner" role="status">
          🔒 本次运行经过人工操作步骤，后续实时截图已关闭；文字日志会继续更新。
        </div>

        <div
          v-if="
            props.currentFrame && props.executionMode === 'visible' && !props.tracePrivacyLocked
          "
          class="live-frame-preview"
        >
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
        <button
          v-if="props.isExecuting"
          class="btn-stop-execution"
          :disabled="!props.canCancel || props.isCancelling"
          @click="emit('stop')"
        >
          {{
            !props.canCancel
              ? "⏳ 正在连接..."
              : props.isCancelling
                ? "🛑 中止中..."
                : "⏹️ 停止运行"
          }}
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

.manual-wait-card {
  padding: 1rem;
  color: #78350f;
  background: linear-gradient(135deg, #fffbeb, #fef3c7);
  border: 1px solid #f59e0b;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(245, 158, 11, 0.12);
}

.manual-wait-heading {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.manual-icon {
  display: grid;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  place-items: center;
  background: #ffffff;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  font-size: 1.15rem;
}

.manual-wait-heading span:not(.manual-icon) {
  color: #b45309;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.manual-wait-heading h4 {
  margin: 0.15rem 0 0;
  color: #78350f;
  font-size: 1rem;
}

.manual-wait-card > p {
  margin: 0.75rem 0 0;
  font-size: 0.8rem;
  line-height: 1.55;
}

.manual-privacy-note,
.manual-privacy-banner {
  margin-top: 0.7rem;
  padding: 0.55rem 0.65rem;
  color: #92400e;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 7px;
  font-size: 0.72rem;
  line-height: 1.5;
}

.manual-privacy-banner {
  margin-top: 0;
  background: #fffbeb;
  border: 1px solid #fde68a;
}

.btn-focus-manual {
  width: 100%;
  min-height: 38px;
  margin-top: 0.75rem;
  color: #ffffff;
  background: #d97706;
  border: 1px solid #b45309;
  border-radius: 8px;
  font-size: 0.78rem;
  font-weight: 750;
  cursor: pointer;
}

.btn-focus-manual:disabled {
  cursor: wait;
  opacity: 0.6;
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

/* Keep live status, logs and controls aligned without clipping on narrow windows. */
.modal-overlay {
  padding: 1rem;
}

.execution-modal-card {
  width: min(100%, 760px);
  max-width: 760px;
  max-height: calc(100dvh - 2rem);
}

.modal-header,
.modal-footer {
  flex-shrink: 0;
}

.modal-header {
  gap: 1rem;
}

.modal-title {
  min-width: 0;
  flex-wrap: wrap;
}

.modal-title h3 {
  min-width: 0;
}

.script-tag {
  max-width: min(100%, 320px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-close-modal,
.pulse-status-dot {
  flex-shrink: 0;
}

.execution-body {
  min-height: 0;
}

.target-tab-info {
  overflow-wrap: anywhere;
}

.frame-overlay-badge,
.modal-footer {
  flex-wrap: wrap;
}

.log-time {
  flex-shrink: 0;
}

.btn-stop-execution,
.btn-close-modal-footer {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 560px) {
  .modal-overlay {
    padding: 0.75rem;
  }

  .execution-modal-card {
    max-height: calc(100dvh - 1.5rem);
    border-radius: 14px;
  }

  .modal-header,
  .execution-body,
  .modal-footer {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .modal-title {
    align-items: flex-start;
  }

  .modal-title h3 {
    flex-basis: calc(100% - 24px);
    font-size: 0.95rem;
  }

  .script-tag {
    order: 3;
    flex-basis: 100%;
    max-width: 100%;
  }

  .frame-overlay-badge {
    position: static;
    justify-content: flex-start;
  }

  .modal-log-line {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .modal-footer {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .btn-stop-execution,
  .btn-close-modal-footer {
    width: 100%;
    min-width: 0;
  }

  .modal-footer > :only-child {
    grid-column: 1 / -1;
  }
}
</style>
