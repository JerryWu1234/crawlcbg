<script setup lang="ts">
import type { BrowserTab, ScriptItem, TabSchedule } from "../../types/automation";

const props = defineProps<{
  tabs: readonly BrowserTab[];
  scripts: readonly ScriptItem[];
  selectedScripts: Readonly<Record<number, string>>;
  schedulesByUrl: Readonly<Record<string, TabSchedule>>;
  openScriptPickerTab: number | null;
  switchingIndex: number | null;
  runningTabIndex: number | null;
  hasActiveExecution: boolean;
}>();

const emit = defineEmits<{
  "pin-tab": [tab: BrowserTab];
  "toggle-script-picker": [tabIndex: number];
  "select-script": [tabIndex: number, filename: string];
  "toggle-run": [tab: BrowserTab];
  "open-history": [tab: BrowserTab];
  "open-schedule": [tab: BrowserTab];
  activate: [tabIndex: number];
}>();

const getDomainName = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const handleFaviconError = (event: Event) => {
  const img = event.target as HTMLImageElement;
  img.src =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'><circle cx='12' cy='12' r='10'/></svg>";
};

const getSchedule = (tab: BrowserTab) => props.schedulesByUrl[tab.url] || null;
const isManualRunning = (tabIndex: number) => props.runningTabIndex === tabIndex;
const isScheduledRunning = (tab: BrowserTab) => getSchedule(tab)?.status === "running";

const scheduleSummary = (schedule: TabSchedule | null) => {
  if (!schedule) return "未配置";
  if (!schedule.enabled) return "已暂停";
  if (schedule.recurrenceType === "hourly") return `每 ${schedule.intervalValue} 小时`;
  if (schedule.recurrenceType === "daily") return `每 ${schedule.intervalValue} 天`;
  if (schedule.recurrenceType === "weekly") return `每 ${schedule.intervalValue} 周`;
  if (schedule.recurrenceType === "weekdays") return `工作日 ${schedule.runAt}`;
  return `周末 ${schedule.runAt}`;
};

const formatNextRun = (schedule: TabSchedule | null) => {
  if (!schedule) return "等待配置";
  if (!schedule.enabled) return "自动执行已暂停";
  if (schedule.status === "running") return "本轮正在执行";
  if (!schedule.nextRunAt) return "等待计算下次执行";
  return `下次 ${new Date(schedule.nextRunAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};
</script>

<template>
  <div class="tabs-grid">
    <div
      v-for="tab in props.tabs"
      :key="tab.index"
      class="tab-card"
      :class="{ 'tab-card-running': isScheduledRunning(tab) }"
    >
      <div class="tab-card-header">
        <span class="tab-index-badge">#{{ tab.index + 1 }}</span>
        <span class="tab-domain-tag">{{ getDomainName(tab.url) }}</span>
        <button
          class="btn-pin-shortcut"
          title="将此正在打开的标签页保存为常驻预设"
          @click="emit('pin-tab', tab)"
        >
          📌 设为常驻
        </button>
      </div>

      <div class="tab-card-body">
        <div class="favicon-container">
          <img
            v-if="tab.favicon"
            :src="tab.favicon"
            :alt="tab.title"
            class="favicon-img"
            @error="handleFaviconError"
          />
          <div v-else class="favicon-fallback">🌐</div>
        </div>

        <div class="tab-main-info">
          <h4 class="tab-title" :title="tab.title">{{ tab.title || tab.url }}</h4>
          <a
            :href="tab.url"
            target="_blank"
            rel="noopener noreferrer"
            class="tab-url-link"
            :title="tab.url"
          >
            {{ tab.url }}
          </a>
        </div>
      </div>

      <div
        class="schedule-strip"
        :class="{
          configured: getSchedule(tab),
          running: isScheduledRunning(tab),
          disabled: getSchedule(tab) && !getSchedule(tab)?.enabled,
        }"
      >
        <button
          class="schedule-config-btn"
          :title="getSchedule(tab) ? '查看或编辑此标签页的循环计划' : '设置此标签页的循环计划'"
          @click="emit('open-schedule', tab)"
        >
          🔁 {{ getSchedule(tab) ? "循环计划" : "设置循环" }}
        </button>
        <div v-if="getSchedule(tab)" class="schedule-copy">
          <strong>{{ scheduleSummary(getSchedule(tab)) }}</strong>
          <span :title="getSchedule(tab)?.lastError || ''">{{
            formatNextRun(getSchedule(tab))
          }}</span>
        </div>
        <div v-else class="schedule-copy empty">
          <span>尚未配置自动循环</span>
          <small>Pace 固定启用</small>
        </div>
        <span v-if="isScheduledRunning(tab)" class="running-pill">正在执行</span>
      </div>

      <div class="tab-card-footer">
        <div class="custom-script-picker">
          <button
            class="picker-trigger-btn"
            :class="{ open: props.openScriptPickerTab === tab.index }"
            title="选择要在该标签页运行的脚本"
            @click.stop="emit('toggle-script-picker', tab.index)"
          >
            <span class="picker-file-icon">📄</span>
            <span class="picker-selected-text">{{
              props.selectedScripts[tab.index] || props.scripts[0]?.filename || "选择脚本"
            }}</span>
            <span class="picker-arrow">▾</span>
          </button>

          <div
            v-if="props.openScriptPickerTab === tab.index"
            class="picker-popover-menu"
            @click.stop
          >
            <div class="picker-menu-header">
              <span>选择关联执行的脚本</span>
              <span class="picker-count">{{ props.scripts.length }} 个可用</span>
            </div>

            <div class="picker-menu-list">
              <div
                v-for="script in props.scripts"
                :key="script.filename"
                class="picker-menu-item"
                :class="{
                  active:
                    (props.selectedScripts[tab.index] || props.scripts[0]?.filename) ===
                    script.filename,
                }"
                @click="emit('select-script', tab.index, script.filename)"
              >
                <span class="item-file-icon">📄</span>
                <span class="item-file-name">{{ script.filename }}</span>
                <span
                  v-if="
                    (props.selectedScripts[tab.index] || props.scripts[0]?.filename) ===
                    script.filename
                  "
                  class="item-check"
                  >✓</span
                >
              </div>
            </div>
          </div>

          <button
            class="action-btn run-tab-btn"
            :class="{ 'btn-running-view': isManualRunning(tab.index) }"
            :disabled="
              isScheduledRunning(tab) || (props.hasActiveExecution && !isManualRunning(tab.index))
            "
            :title="
              isScheduledRunning(tab)
                ? '此标签页的循环任务正在执行，不能重复启动'
                : isManualRunning(tab.index)
                  ? '点击重新打开执行日志弹窗'
                  : props.hasActiveExecution
                    ? '已有脚本正在执行，请在运行中的页签查看进度'
                    : '对此页签一键运行选中的脚本'
            "
            @click="emit('toggle-run', tab)"
          >
            <template v-if="isScheduledRunning(tab)"> ⏳ 正在执行 </template>
            <template v-else-if="isManualRunning(tab.index)">
              <span class="btn-text-default">⏳ 运行中</span>
              <span class="btn-text-hover">📊 查看进度</span>
            </template>
            <template v-else> ▶️ 运行 </template>
          </button>
        </div>

        <button
          class="action-btn logs-btn-tab"
          title="查看此标签页的历史执行日志"
          @click="emit('open-history', tab)"
        >
          <span>📜 日志</span>
        </button>

        <button
          class="action-btn open-btn"
          :disabled="props.switchingIndex === tab.index"
          title="在 Chrome 中聚焦此标签页"
          @click="emit('activate', tab.index)"
        >
          <span>{{ props.switchingIndex === tab.index ? "激活中..." : "激活页签" }}</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.25rem;
}

.tab-card {
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 1rem;
  box-shadow: var(--shadow-sm);
  transition: all 0.25s ease;
}

.tab-card:hover {
  transform: translateY(-3px);
  border-color: #c7d2fe;
  box-shadow: var(--shadow-hover);
}

.tab-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tab-index-badge {
  font-size: 0.75rem;
  font-weight: 700;
  color: #4f46e5;
  background-color: #e0e7ff;
  padding: 0.15rem 0.55rem;
  border-radius: 6px;
}

.tab-domain-tag {
  font-size: 0.75rem;
  color: #64748b;
  background-color: #f1f5f9;
  padding: 0.15rem 0.55rem;
  border-radius: 6px;
  font-weight: 500;
}

.btn-pin-shortcut {
  background-color: #fef3c7;
  border: 1px solid #fde68a;
  color: #b45309;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  cursor: pointer;
}

.btn-pin-shortcut:hover {
  background-color: #f59e0b;
  color: white;
}

.tab-card-body {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
}

.favicon-container {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

.favicon-img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.favicon-fallback {
  font-size: 1.2rem;
}

.tab-main-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tab-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.tab-url-link {
  font-size: 0.825rem;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}

.tab-url-link:hover {
  color: #4f46e5;
  text-decoration: underline;
}

.tab-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-top: 0.85rem;
  border-top: 1px solid #f1f5f9;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.4rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid #e2e8f0;
}

.custom-script-picker {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.picker-trigger-btn {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  background-color: #f8fafc;
  border: 1px solid #cbd5e1;
  border-right: none;
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
  color: #0f172a;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  transition: all 0.2s ease;
  height: 34px;
  box-sizing: border-box;
}

.picker-trigger-btn:hover,
.picker-trigger-btn.open {
  background-color: #ffffff;
  border-color: #8b5cf6;
}

.picker-file-icon {
  font-size: 0.85rem;
}

.picker-selected-text {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  text-align: left;
}

.picker-arrow {
  font-size: 0.7rem;
  color: #64748b;
  transition: transform 0.2s ease;
}

.picker-trigger-btn.open .picker-arrow {
  transform: rotate(180deg);
}

.picker-popover-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 250px;
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow:
    0 10px 25px -5px rgba(0, 0, 0, 0.12),
    0 8px 10px -6px rgba(0, 0, 0, 0.04);
  z-index: 60;
  overflow: hidden;
  animation: popoverFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes popoverFadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.picker-menu-header {
  padding: 0.6rem 0.85rem;
  background-color: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
  color: #64748b;
}

.picker-count {
  color: #4f46e5;
}

.picker-menu-list {
  max-height: 200px;
  overflow-y: auto;
  padding: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.picker-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8rem;
  color: #334155;
  transition: all 0.15s ease;
}

.picker-menu-item:hover {
  background-color: #f1f5f9;
  color: #0f172a;
}

.picker-menu-item.active {
  background-color: #f3e8ff;
  color: #7c3aed;
  font-weight: 600;
}

.item-file-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-check {
  font-size: 0.85rem;
  font-weight: 700;
  color: #7c3aed;
}

.run-tab-btn {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  border: 1px solid #059669;
  color: white;
  white-space: nowrap;
  font-weight: 700;
  padding: 0.35rem 0.75rem;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
  height: 34px;
  box-sizing: border-box;
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);
  transition: all 0.2s ease;
}

.run-tab-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(16, 185, 129, 0.35);
}

.logs-btn-tab {
  background-color: #f1f5f9;
  border: 1px solid #cbd5e1;
  color: #334155;
  font-weight: 600;
  border-radius: 8px;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.logs-btn-tab:hover {
  background-color: #e2e8f0;
  color: #0f172a;
  border-color: #94a3b8;
}

.open-btn {
  background-color: #e0e7ff;
  color: #4f46e5;
  border-color: #c7d2fe;
  text-decoration: none;
  white-space: nowrap;
}

.open-btn:hover {
  background-color: #4f46e5;
  color: white;
}

.btn-running-view,
.action-btn.run-tab-btn.btn-running-view {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
  border-color: #2563eb !important;
  color: white !important;
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3) !important;
  position: relative;
  overflow: hidden;
}

.btn-running-view .btn-text-default {
  display: inline !important;
}

.btn-running-view .btn-text-hover {
  display: none !important;
}

.btn-running-view:hover,
.action-btn.run-tab-btn.btn-running-view:hover {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%) !important;
  border-color: #1d4ed8 !important;
  color: white !important;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35) !important;
  transform: translateY(-1px);
}

.btn-running-view:hover .btn-text-default {
  display: none !important;
}

.btn-running-view:hover .btn-text-hover {
  display: inline !important;
}

.tab-card-running {
  border-color: #93c5fd;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}

.schedule-strip {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem 0.7rem;
  border: 1px dashed #cbd5e1;
  border-radius: 9px;
  background: #f8fafc;
}

.schedule-strip.configured {
  border-style: solid;
  border-color: #99f6e4;
  background: #f0fdfa;
}

.schedule-strip.running {
  border-color: #bfdbfe;
  background: #eff6ff;
}

.schedule-strip.disabled {
  border-color: #e2e8f0;
  background: #f8fafc;
}

.schedule-config-btn {
  flex: 0 0 auto;
  padding: 0.38rem 0.58rem;
  border: 1px solid #5eead4;
  border-radius: 7px;
  color: #0f766e;
  background: #ffffff;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  transition: 0.15s ease;
}

.schedule-config-btn:hover {
  color: #ffffff;
  border-color: #0d9488;
  background: #0d9488;
}

.schedule-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.schedule-copy strong {
  color: #115e59;
  font-size: 0.76rem;
}

.schedule-copy span,
.schedule-copy small {
  overflow: hidden;
  color: #64748b;
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-copy.empty {
  color: #64748b;
}

.running-pill {
  flex: 0 0 auto;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  color: #1d4ed8;
  background: #dbeafe;
  font-size: 0.66rem;
  font-weight: 750;
}

.run-tab-btn:disabled {
  cursor: not-allowed;
  opacity: 0.72;
  transform: none;
  background: linear-gradient(135deg, #60a5fa, #3b82f6);
  border-color: #3b82f6;
  box-shadow: none;
}
</style>
