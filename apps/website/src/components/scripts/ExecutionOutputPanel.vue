<script setup lang="ts">
import { ref } from "vue";
import type { ExecutionLogEntry, TraceFrame } from "../../types/automation";

const props = defineProps<{
  activeConsoleTab: "logs" | "replay";
  logs: readonly ExecutionLogEntry[];
  traceFrames: readonly TraceFrame[];
  currentFrame: TraceFrame | null;
  currentFrameIndex: number;
  isPlayingReplay: boolean;
  replaySpeed: number;
}>();

const emit = defineEmits<{
  "update:activeConsoleTab": [tab: "logs" | "replay"];
  "update:currentFrameIndex": [index: number];
  copy: [];
  clear: [];
  previous: [];
  next: [];
  "toggle-play": [];
  "set-speed": [speed: number];
}>();

const terminalElement = ref<HTMLDivElement | null>(null);

const updateFrameIndex = (event: Event) => {
  emit("update:currentFrameIndex", Number((event.target as HTMLInputElement).value));
};

const scrollToBottom = () => {
  if (terminalElement.value) {
    terminalElement.value.scrollTop = terminalElement.value.scrollHeight;
  }
};

defineExpose({ scrollToBottom });
</script>

<template>
  <div class="terminal-panel">
    <div class="terminal-header">
      <div class="console-tabs">
        <button
          class="console-tab-btn"
          :class="{ active: activeConsoleTab === 'logs' }"
          @click="emit('update:activeConsoleTab', 'logs')"
        >
          📜 控制台文本日志
        </button>
        <button
          class="console-tab-btn"
          :class="{ active: activeConsoleTab === 'replay' }"
          @click="emit('update:activeConsoleTab', 'replay')"
        >
          🎬 运行画面视觉回放
          <span v-if="traceFrames && traceFrames.length > 0" class="frame-badge">
            {{ traceFrames.length }} 帧
          </span>
        </button>
      </div>

      <div v-if="activeConsoleTab === 'logs'" class="terminal-actions">
        <button class="term-btn" @click="emit('copy')">复制日志</button>
        <button class="term-btn" @click="emit('clear')">清空控制台</button>
      </div>

      <div
        v-else-if="activeConsoleTab === 'replay' && traceFrames.length > 0"
        class="replay-controls-header"
      >
        <button class="player-btn" title="上一帧" @click="emit('previous')">⏮️</button>
        <button class="player-btn play-main" @click="emit('toggle-play')">
          {{ isPlayingReplay ? "⏸️ 暂停" : "▶️ 播放回放" }}
        </button>
        <button class="player-btn" title="下一帧" @click="emit('next')">⏭️</button>

        <div class="speed-selector">
          <button
            v-for="speed in [0.5, 1, 2, 4]"
            :key="speed"
            class="speed-btn"
            :class="{ active: replaySpeed === speed }"
            @click="emit('set-speed', speed)"
          >
            {{ speed }}x
          </button>
        </div>
      </div>
    </div>

    <div v-if="activeConsoleTab === 'logs'" ref="terminalElement" class="terminal-body">
      <div v-if="logs.length === 0" class="terminal-empty">
        点击顶部 ▶️ "一键运行脚本" 按钮，此处将按行实时流式打字输出日志...
      </div>
      <div v-for="(log, index) in logs" :key="index" class="log-line" :class="log.type">
        <span class="log-time">[{{ log.time }}]</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
    </div>

    <div v-else class="replay-player-body">
      <div v-if="traceFrames.length === 0" class="replay-empty">
        <div class="empty-icon-replay">🎬</div>
        <p>暂无捕获的运行画面。运行脚本时将自动高频捕获每一步网页画面快照。</p>
      </div>

      <div v-else class="player-screen-container">
        <div class="screen-frame-box">
          <img
            v-if="currentFrame"
            :src="currentFrame.frameUrl"
            class="screenshot-img"
            alt="Chrome Tab Screenshot"
          />

          <div v-if="currentFrame" class="subtitle-overlay">
            <span class="sub-step"> Step #{{ currentFrame.step }} [{{ currentFrame.time }}] </span>
            <span class="sub-text">{{ currentFrame.message }}</span>
          </div>
        </div>

        <div class="player-timeline-bar">
          <input
            :value="props.currentFrameIndex"
            type="range"
            min="0"
            :max="traceFrames.length - 1"
            class="step-slider"
            @input="updateFrameIndex"
          />
          <span class="step-indicator">
            步骤 {{ currentFrameIndex + 1 }} / {{ traceFrames.length }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  background-color: #0f172a;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
}

.terminal-header {
  background-color: #1e293b;
  padding: 0.5rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.console-tabs {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.console-tab-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  transition: all 0.2s ease;
}

.console-tab-btn.active {
  background-color: #334155;
  color: #38bdf8;
}

.frame-badge {
  background-color: #38bdf8;
  color: #0f172a;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
}

.replay-controls-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.player-btn {
  background-color: #334155;
  color: white;
  border: 1px solid #475569;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.player-btn.play-main {
  background-color: #10b981;
  border-color: #059669;
  font-weight: 600;
}

.player-btn:hover {
  background-color: #475569;
}

.speed-selector {
  display: flex;
  gap: 0.25rem;
  background-color: #0f172a;
  padding: 0.2rem;
  border-radius: 6px;
}

.speed-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}

.speed-btn.active {
  background-color: #475569;
  color: white;
}

.terminal-body {
  padding: 1rem;
  height: 200px;
  overflow-y: auto;
  font-family: Consolas, Monaco, monospace;
  font-size: 0.85rem;
  line-height: 1.6;
  color: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.terminal-empty {
  color: #64748b;
  font-style: italic;
  font-size: 0.85rem;
}

.log-line {
  display: flex;
  gap: 0.75rem;
  word-break: break-all;
}

.log-time {
  color: #64748b;
  flex-shrink: 0;
}

.log-line.log .log-msg {
  color: #38bdf8;
}

.log-line.done .log-msg {
  color: #4ade80;
  font-weight: 600;
}

.log-line.error .log-msg {
  color: #f87171;
  font-weight: 600;
}

.replay-player-body {
  padding: 1rem;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.replay-empty {
  text-align: center;
  color: #64748b;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.empty-icon-replay {
  font-size: 2rem;
}

.player-screen-container {
  width: 100%;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.screen-frame-box {
  position: relative;
  width: 100%;
  height: 380px;
  background-color: #020617;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #334155;
  display: flex;
  align-items: center;
  justify-content: center;
}

.screenshot-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.subtitle-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(4px);
  padding: 0.6rem 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: #f8fafc;
}

.sub-step {
  font-size: 0.75rem;
  font-weight: 700;
  color: #38bdf8;
  background-color: rgba(56, 189, 248, 0.15);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  flex-shrink: 0;
}

.sub-text {
  font-size: 0.85rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-timeline-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  background-color: #1e293b;
  padding: 0.5rem 1rem;
  border-radius: 8px;
}

.step-slider {
  flex: 1;
  cursor: pointer;
  accent-color: #38bdf8;
}

.step-indicator {
  font-size: 0.8rem;
  font-weight: 600;
  color: #38bdf8;
  white-space: nowrap;
}
</style>
