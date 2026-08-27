<script setup lang="ts">
import type { TraceFrame, TraceRunDetail, TraceRunSummary } from "../../types/automation";

type HistoryModalTab = "logs" | "frames";

const props = defineProps<{
  targetTitle: string;
  runs: readonly TraceRunSummary[];
  selectedRunId: string;
  selectedRun: TraceRunDetail | null;
  isLoading: boolean;
  activeTab: HistoryModalTab;
  frames: readonly TraceFrame[];
  activeFrameIndex: number;
  isPlaying: boolean;
  replaySpeed: number;
}>();

const emit = defineEmits<{
  close: [];
  "load-run": [runId: string];
  "toggle-play": [];
  "start-replay": [];
  "update-active-tab": [tab: HistoryModalTab];
  "update-frame-index": [index: number];
  "update-replay-speed": [speed: number];
  "image-error": [event: Event];
}>();

const loadRun = (event: Event) => {
  emit("load-run", (event.target as HTMLSelectElement).value);
};

const updateFrameIndex = (event: Event) => {
  emit("update-frame-index", Number((event.target as HTMLInputElement).value));
};

const updateReplaySpeed = (event: Event) => {
  emit("update-replay-speed", Number((event.target as HTMLSelectElement).value));
  if (props.isPlaying) {
    emit("start-replay");
  }
};
</script>

<template>
  <div class="modal-overlay history-modal-overlay animated-fade-in" @click.self="emit('close')">
    <div class="history-log-modal-card light-mode animated-slide-up">
      <div class="history-modal-header light">
        <div class="modal-title-wrapper">
          <div class="icon-box-purple">
            <span class="icon">📜</span>
          </div>
          <div class="title-text-group">
            <div class="title-row">
              <h3 class="light-title">历史执行日志明细</h3>
              <span v-if="props.runs.length > 0" class="runs-count-badge">
                {{ props.runs.length }} 次运行批次
              </span>
            </div>
            <p class="subtitle-light" :title="props.targetTitle">
              🎯 目标网页: <strong>{{ props.targetTitle }}</strong>
            </p>
          </div>
        </div>
        <button class="btn-close-modal-light" @click="emit('close')">✕</button>
      </div>

      <div class="history-log-modal-body light">
        <div v-if="props.isLoading" class="history-modal-loading light">
          <div class="spinner-purple"></div>
          <span>正在读取历史执行轨迹...</span>
        </div>

        <div v-else-if="props.runs.length === 0" class="history-modal-empty light">
          <div class="empty-icon-light">📭</div>
          <h4>暂无历史执行记录</h4>
          <p>
            该网页或自动化脚本尚未产生过运行轨迹。点击“自动打开并运行”后将自动捕捉此处的终端日志。
          </p>
        </div>

        <div v-else class="history-log-modal-content">
          <div class="run-selector-card light">
            <div class="selector-header light">
              <span class="label">📅 选择历史运行批次:</span>
              <span v-if="props.selectedRun" class="selected-time-badge light">
                ⏱️ {{ props.selectedRun.timestamp }}
              </span>
            </div>
            <div class="styled-select-wrapper light">
              <select
                :value="props.selectedRunId"
                class="custom-run-select light"
                @change="loadRun"
              >
                <option v-for="run in props.runs" :key="run.runId" :value="run.runId">
                  🚀 {{ run.timestamp }} ({{ run.filename }}) — 📜 {{ run.totalLogs || 0 }} 条日志 |
                  🎬 {{ run.totalFrames }} 帧画面
                </option>
              </select>
              <span class="select-chevron light">▾</span>
            </div>
          </div>

          <div class="segmented-control-light">
            <button
              class="segment-btn-light"
              :class="{ active: props.activeTab === 'logs' }"
              @click="emit('update-active-tab', 'logs')"
            >
              <span class="btn-icon">📜</span>
              <span>控制台文本日志</span>
              <span class="badge-count">{{ props.selectedRun?.logs?.length || 0 }}</span>
            </button>
            <button
              class="segment-btn-light"
              :class="{ active: props.activeTab === 'frames' }"
              @click="emit('update-active-tab', 'frames')"
            >
              <span class="btn-icon">🎬</span>
              <span>捕获画面轨迹</span>
              <span class="badge-count">{{ props.frames.length }}</span>
            </button>
          </div>

          <div v-if="props.activeTab === 'logs'" class="history-logs-panel">
            <div
              v-if="props.selectedRun?.logs && props.selectedRun.logs.length > 0"
              class="console-box-light"
            >
              <div class="console-top-bar light">
                <div class="console-dots">
                  <span class="dot red"></span>
                  <span class="dot yellow"></span>
                  <span class="dot green"></span>
                </div>
                <span class="console-title light">CONSOLE LOG OUTPUT</span>
                <span class="console-meta light">
                  {{ props.selectedRun.logs.length }} LOG ENTRIES
                </span>
              </div>
              <div class="console-scroll-light">
                <div
                  v-for="(log, index) in props.selectedRun.logs"
                  :key="index"
                  class="console-row-light"
                  :class="log.type || 'log'"
                >
                  <span class="row-num light">#{{ String(index + 1).padStart(2, "0") }}</span>
                  <span class="row-time light">[{{ log.time }}]</span>
                  <span class="row-text light">{{ log.message }}</span>
                </div>
              </div>
            </div>
            <div v-else class="console-empty-light">
              <span class="icon">💬</span>
              <span>此运行批次暂无文本日志记录</span>
            </div>
          </div>

          <div v-else-if="props.activeTab === 'frames'" class="history-frames-panel">
            <div v-if="props.frames.length > 0" class="cinema-viewer-container light">
              <div class="cinema-screen light">
                <img
                  :src="props.frames[props.activeFrameIndex]?.frameUrl"
                  class="cinema-img"
                  @error="emit('image-error', $event)"
                />
                <div class="cinema-overlay-banner light">
                  <span class="frame-tag light">
                    画面 {{ props.activeFrameIndex + 1 }} / {{ props.frames.length }} (Step #{{
                      props.frames[props.activeFrameIndex]?.step
                    }})
                  </span>
                  <span class="frame-msg light">{{
                    props.frames[props.activeFrameIndex]?.message
                  }}</span>
                  <span class="frame-time light">
                    ⏱️ {{ props.frames[props.activeFrameIndex]?.time }}
                  </span>
                </div>
              </div>

              <div class="replay-control-toolbar light">
                <div class="control-left-group">
                  <button
                    class="btn-player-action play-btn"
                    :class="{ playing: props.isPlaying }"
                    :title="props.isPlaying ? '暂停播放' : '循环播放轨迹'"
                    @click="emit('toggle-play')"
                  >
                    <span v-if="props.isPlaying">⏸️ 暂停</span>
                    <span v-else>▶️ 自动播放</span>
                  </button>

                  <button
                    class="btn-player-action step-btn"
                    :disabled="props.activeFrameIndex === 0"
                    title="上一画面"
                    @click="emit('update-frame-index', Math.max(0, props.activeFrameIndex - 1))"
                  >
                    ⏮️ 上一帧
                  </button>

                  <button
                    class="btn-player-action step-btn"
                    :disabled="props.activeFrameIndex >= props.frames.length - 1"
                    title="下一画面"
                    @click="
                      emit(
                        'update-frame-index',
                        Math.min(props.frames.length - 1, props.activeFrameIndex + 1),
                      )
                    "
                  >
                    下一帧 ⏭️
                  </button>
                </div>

                <div class="scrubber-container">
                  <input
                    type="range"
                    min="0"
                    :max="props.frames.length - 1"
                    :value="props.activeFrameIndex"
                    class="player-scrubber-range"
                    @input="updateFrameIndex"
                  />
                </div>

                <div class="control-right-group">
                  <span class="frames-counter-badge">
                    {{ props.activeFrameIndex + 1 }} / {{ props.frames.length }} 异帧画面
                  </span>

                  <select
                    :value="props.replaySpeed"
                    class="speed-select-light"
                    @change="updateReplaySpeed"
                  >
                    <option :value="1">1x 速度</option>
                    <option :value="2">2x 速度</option>
                    <option :value="5">5x 倍速</option>
                  </select>
                </div>
              </div>
            </div>
            <div v-else class="console-empty-light">
              <span class="icon">📸</span>
              <span>此运行批次暂无捕获的网页画面快照</span>
            </div>
          </div>
        </div>
      </div>

      <div class="history-modal-footer light">
        <button class="btn-close-light" @click="emit('close')">
          <span>✕ 关闭窗口</span>
        </button>
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

@keyframes fadeInOverlay {
  from {
    opacity: 0;
    backdrop-filter: blur(0px);
  }
  to {
    opacity: 1;
    backdrop-filter: blur(12px);
  }
}

@keyframes slideUpModal {
  from {
    opacity: 0;
    transform: translateY(24px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.animated-fade-in {
  animation: fadeInOverlay 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  background: rgba(15, 23, 42, 0.65) !important;
  backdrop-filter: blur(12px) !important;
}

.animated-slide-up {
  animation: slideUpModal 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.modal-title-wrapper {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.title-text-group h3 {
  font-size: 1.25rem;
  font-weight: 800;
  color: #ffffff;
  margin: 0 0 0.25rem 0;
  letter-spacing: -0.01em;
}

.history-modal-overlay {
  background: rgba(15, 23, 42, 0.35);
  backdrop-filter: blur(8px);
}

.history-log-modal-card.light-mode {
  width: 92%;
  max-width: 820px;
  background: #ffffff;
  border-radius: 20px;
  box-shadow:
    0 20px 50px -10px rgba(15, 23, 42, 0.15),
    0 0 1px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  max-height: 88vh;
  color: #0f172a;
}

.history-modal-header.light {
  padding: 1.25rem 1.75rem;
  background: #ffffff;
  border-bottom: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.icon-box-purple {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  color: #ffffff;
  flex-shrink: 0;
}

.light-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.01em;
}

.runs-count-badge {
  background: #e0e7ff;
  border: 1px solid #c7d2fe;
  color: #4338ca;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
}

.subtitle-light {
  margin: 0.25rem 0 0 0;
  font-size: 0.82rem;
  color: #64748b;
  max-width: 520px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-close-modal-light {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #64748b;
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.btn-close-modal-light:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.history-log-modal-body.light {
  padding: 1.5rem;
  background-color: #f8fafc;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.history-modal-loading.light,
.history-modal-empty.light {
  padding: 4rem 1.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  color: #64748b;
  text-align: center;
}

.spinner-purple {
  width: 40px;
  height: 40px;
  border: 3px solid #e0e7ff;
  border-top-color: #4f46e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.empty-icon-light {
  font-size: 3rem;
  opacity: 0.8;
}

.history-modal-empty.light h4 {
  margin: 0;
  font-size: 1.1rem;
  color: #1e293b;
  font-weight: 700;
}

.history-modal-empty.light p {
  margin: 0;
  font-size: 0.85rem;
  color: #64748b;
  max-width: 400px;
  line-height: 1.5;
}

.run-selector-card.light {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.selector-header.light {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.82rem;
  font-weight: 700;
  color: #334155;
}

.selected-time-badge.light {
  background: #f1f5f9;
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  color: #4f46e5;
  font-size: 0.78rem;
  font-weight: 600;
}

.custom-run-select.light {
  width: 100%;
  padding: 0.7rem 2.4rem 0.7rem 0.95rem;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.88rem;
  font-weight: 600;
  color: #0f172a;
  background: #ffffff;
  appearance: none;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
  transition: all 0.2s ease;
}

.custom-run-select.light:hover,
.custom-run-select.light:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.select-chevron.light {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  color: #64748b;
  pointer-events: none;
  font-size: 0.85rem;
}

.segmented-control-light {
  display: flex;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  padding: 4px;
  border-radius: 12px;
  gap: 4px;
}

.segment-btn-light {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 0.85rem;
  font-weight: 700;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.segment-btn-light:hover {
  color: #1e293b;
}

.segment-btn-light.active {
  background: #ffffff;
  color: #4f46e5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.badge-count {
  background: #e2e8f0;
  color: #475569;
  padding: 0.1rem 0.45rem;
  border-radius: 10px;
  font-size: 0.72rem;
}

.segment-btn-light.active .badge-count {
  background: #e0e7ff;
  color: #4338ca;
}

.console-box-light {
  background: #0f172a;
  border-radius: 12px;
  border: 1px solid #1e293b;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
  display: flex;
  flex-direction: column;
}

.console-top-bar.light {
  background: #1e293b;
  padding: 0.5rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #334155;
}

.console-dots .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
}

.console-title.light {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.console-meta.light {
  font-size: 0.7rem;
  color: #818cf8;
  font-weight: 700;
  background: rgba(99, 102, 241, 0.15);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.console-scroll-light {
  padding: 0.85rem 1rem;
  max-height: 360px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.82rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.console-row-light {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  line-height: 1.45;
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
  word-break: break-all;
}

.console-row-light:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.row-num.light {
  color: #475569;
  font-size: 0.75rem;
  flex-shrink: 0;
  user-select: none;
}

.row-time.light {
  color: #64748b;
  font-size: 0.75rem;
  flex-shrink: 0;
}

.row-text.light {
  color: #e2e8f0;
}

.console-row-light.error .row-text.light {
  color: #f87171;
}

.console-row-light.success .row-text.light {
  color: #4ade80;
}

.console-empty-light {
  padding: 3rem 1rem;
  text-align: center;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  color: #64748b;
  font-size: 0.88rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.console-empty-light .icon {
  font-size: 2rem;
}

.cinema-viewer-container.light {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.cinema-screen.light {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #0f172a;
  border: 1px solid #cbd5e1;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.12);
  height: 400px;
  max-height: 52vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  box-sizing: border-box;
}

.cinema-img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  transition: all 0.2s ease;
}

.cinema-overlay-banner.light {
  position: absolute;
  bottom: 0.85rem;
  left: 0.85rem;
  right: 0.85rem;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(10px);
  color: #ffffff;
  padding: 0.65rem 1rem;
  border-radius: 10px;
  font-size: 0.8rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.frame-tag.light {
  background: #4f46e5;
  color: white;
  font-weight: 800;
  font-size: 0.72rem;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  flex-shrink: 0;
}

.frame-msg.light {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #f8fafc;
}

.frame-time.light {
  color: #cbd5e1;
  font-size: 0.75rem;
  flex-shrink: 0;
}

.replay-control-toolbar.light {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.control-left-group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.btn-player-action {
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.btn-player-action:hover:not(:disabled) {
  background: #e2e8f0;
  color: #0f172a;
}

.btn-player-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-player-action.play-btn {
  background: #e0e7ff;
  border-color: #c7d2fe;
  color: #4338ca;
}

.btn-player-action.play-btn.playing {
  background: #fef3c7;
  border-color: #fde68a;
  color: #b45309;
}

.scrubber-container {
  flex: 1;
  display: flex;
  align-items: center;
}

.player-scrubber-range {
  width: 100%;
  accent-color: #4f46e5;
  cursor: pointer;
  height: 6px;
  border-radius: 3px;
}

.control-right-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.frames-counter-badge {
  font-size: 0.78rem;
  font-weight: 700;
  color: #475569;
  background: #f1f5f9;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  white-space: nowrap;
}

.speed-select-light {
  background: #ffffff;
  border: 1px solid #cbd5e1;
  color: #334155;
  padding: 0.35rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.history-modal-footer.light {
  padding: 1.25rem 1.75rem;
  background: #ffffff;
  border-top: 1px solid #f1f5f9;
  display: flex;
  justify-content: flex-end;
}

.btn-close-light {
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  font-weight: 700;
  padding: 0.6rem 1.4rem;
  border-radius: 10px;
  font-size: 0.88rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-close-light:hover {
  background: #e2e8f0;
  color: #0f172a;
}

/* Complete missing layout hooks and keep rich trace controls responsive. */
.modal-overlay {
  padding: 1rem;
}

.history-log-modal-card.light-mode {
  width: min(100%, 880px);
  max-width: 880px;
  max-height: calc(100dvh - 2rem);
}

.history-modal-header.light,
.history-modal-footer.light {
  flex-shrink: 0;
}

.history-modal-header.light {
  gap: 1rem;
}

.modal-title-wrapper,
.title-text-group,
.history-log-modal-content,
.run-selector-card,
.styled-select-wrapper {
  min-width: 0;
}

.history-modal-header .title-text-group .light-title {
  color: #0f172a;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.history-log-modal-body.light {
  min-height: 0;
}

.history-log-modal-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.styled-select-wrapper {
  position: relative;
}

.console-dots .dot.red {
  background: #fb7185;
}

.console-dots .dot.yellow {
  background: #fbbf24;
}

.console-dots .dot.green {
  background: #34d399;
}

.selector-header.light,
.console-top-bar.light,
.replay-control-toolbar.light,
.control-left-group,
.control-right-group,
.cinema-overlay-banner.light {
  flex-wrap: wrap;
}

.scrubber-container {
  min-width: 160px;
}

.history-modal-footer.light {
  gap: 0.75rem;
  flex-wrap: wrap;
}

@media (max-width: 700px) {
  .modal-overlay {
    padding: 0.75rem;
  }

  .history-log-modal-card.light-mode {
    max-height: calc(100dvh - 1.5rem);
    border-radius: 16px;
  }

  .history-modal-header.light,
  .history-log-modal-body.light,
  .history-modal-footer.light {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .history-modal-header.light {
    align-items: flex-start;
  }

  .modal-title-wrapper {
    align-items: flex-start;
    gap: 0.75rem;
  }

  .icon-box-purple {
    width: 40px;
    height: 40px;
  }

  .subtitle-light {
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .selector-header.light {
    align-items: flex-start;
    gap: 0.5rem;
  }

  .segmented-control-light {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .segment-btn-light {
    justify-content: space-between;
    min-width: 0;
  }

  .console-top-bar.light {
    justify-content: flex-start;
    gap: 0.5rem 0.75rem;
  }

  .console-meta.light {
    margin-left: auto;
  }

  .console-scroll-light {
    padding-inline: 0.75rem;
  }

  .console-row-light {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.2rem 0.5rem;
  }

  .row-text.light {
    grid-column: 1 / -1;
  }

  .cinema-screen.light {
    height: clamp(220px, 58vw, 340px);
    max-height: 44vh;
  }

  .cinema-overlay-banner.light {
    align-items: flex-start;
    bottom: 0.5rem;
    left: 0.5rem;
    right: 0.5rem;
  }

  .frame-msg.light {
    order: 3;
    flex-basis: 100%;
    white-space: normal;
  }

  .replay-control-toolbar.light {
    align-items: stretch;
    flex-direction: column;
    gap: 0.75rem;
  }

  .control-left-group,
  .control-right-group,
  .scrubber-container {
    width: 100%;
  }

  .control-left-group .btn-player-action {
    flex: 1;
    min-width: 0;
  }

  .control-right-group {
    justify-content: space-between;
  }

  .history-modal-footer.light .btn-close-light {
    width: 100%;
  }
}
</style>
