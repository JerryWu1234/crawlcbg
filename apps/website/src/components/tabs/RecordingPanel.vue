<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { BrowserTab, RecordedAction } from "../../types/automation";
import {
  useRecording,
  type RecordingPhase,
  type SavedRecordingScript,
} from "../../composables/useRecording";

const props = withDefaults(
  defineProps<{
    tab: Readonly<BrowserTab>;
    executionActive?: boolean;
    autoStart?: boolean;
  }>(),
  {
    executionActive: false,
    autoStart: true,
  },
);

const emit = defineEmits<{
  close: [];
  "active-change": [active: boolean, recordingId: string | null];
  saved: [result: SavedRecordingScript];
}>();

const {
  session,
  pages,
  actions,
  phase,
  operation,
  isActive,
  canStart,
  canStop,
  canUpdateActions,
  canCreateManualStep,
  canGenerate,
  canValidateAndSave,
  errorMessage,
  streamConnected,
  streamWarning,
  generatedScript,
  validationResult,
  savedScript,
  hasPendingActionUpdates,
  startRecording,
  setActionIncluded,
  createManualStep,
  stopRecording,
  generateScript,
  validateAndSave,
  isActionPending,
  clearError,
} = useRecording();

const filename = ref(`recording-tab-${props.tab.index + 1}.mjs`);
const selectedActionIds = ref<Set<string>>(new Set());
const manualStepTitle = ref("");

const PHASE_LABELS: Record<RecordingPhase, string> = {
  idle: "等待开始",
  starting: "正在启动",
  recording: "录制中",
  stopping: "正在停止",
  stopped: "已停止",
  generating: "正在生成",
  generated: "代码已生成",
  validating: "正在校验",
  invalid: "校验未通过",
  validated: "校验通过",
  saving: "正在保存",
  saved: "已保存",
};

const ACTION_LABELS: Record<RecordedAction["type"], string> = {
  click: "点击",
  fill: "输入",
  select: "选择",
  setChecked: "勾选",
  press: "按键",
  scroll: "滚动",
  closePage: "关闭页面",
  manualStep: "人工操作",
};

const CONTROL_KIND_LABELS = {
  text: "文本",
  secret: "敏感输入",
  select: "下拉选择",
  multiSelect: "多选",
  checkbox: "复选框",
  radioGroup: "单选项",
  date: "日期",
  custom: "自定义控件",
} as const;

const phaseLabel = computed(() => PHASE_LABELS[phase.value]);
const phaseTone = computed(() => {
  if (phase.value === "recording" || phase.value === "starting") return "live";
  if (phase.value === "invalid") return "danger";
  if (phase.value === "saved" || phase.value === "validated") return "success";
  if (phase.value === "stopped" || phase.value === "generated") return "ready";
  return "neutral";
});
const canClose = computed(() => !isActive.value && operation.value === "idle");
const hasPopupActions = computed(() => actions.value.some((action) => action.opensPageId));
const targetLabel = computed(() => props.tab.title || props.tab.url);
const selectedActions = computed(() =>
  actions.value.filter((action) => selectedActionIds.value.has(action.id)),
);
const selectedRangeIsContiguous = computed(() => {
  if (selectedActions.value.length === 0) return false;
  const positions = selectedActions.value.map((selected) =>
    actions.value.findIndex((action) => action.id === selected.id),
  );
  return positions.every((position, index) => position === positions[0] + index);
});
const selectedRangeIsSafe = computed(
  () =>
    selectedActions.value.length > 0 &&
    selectedRangeIsContiguous.value &&
    selectedActions.value.every(
      (action) =>
        action.included &&
        !action.opensPageId &&
        action.pageId === selectedActions.value[0]?.pageId &&
        !isActionPending(action.id),
    ),
);
const canConvertControls = computed(
  () =>
    canCreateManualStep.value &&
    selectedRangeIsSafe.value &&
    selectedActions.value.every((action) =>
      ["fill", "select", "setChecked", "manualStep"].includes(action.type),
    ),
);
const canConvertCustom = computed(
  () =>
    canCreateManualStep.value &&
    selectedRangeIsSafe.value &&
    selectedActions.value.every(
      (action) => action.type !== "manualStep" && typeof action.selector === "string",
    ),
);
const selectionHint = computed(() => {
  if (selectedActions.value.length === 0) return "勾选连续步骤后，可转换为一个人工 checkpoint。";
  if (!selectedRangeIsContiguous.value) return "所选动作必须在时间线上连续。";
  if (!selectedRangeIsSafe.value) return "所选动作必须启用、位于同一页面且不能打开 popup。";
  if (!canConvertControls.value && !canConvertCustom.value) {
    return "控件组仅支持输入/选择/勾选；自定义范围内每步都需要 selector。";
  }
  return `已选择 ${selectedActions.value.length} 个连续动作。请求只发送动作 ID，不发送 selector 或值。`;
});

const isActionSelectable = (action: RecordedAction) =>
  session.value?.status === "stopped" &&
  canCreateManualStep.value &&
  action.included &&
  !action.opensPageId &&
  (action.type === "manualStep" || typeof action.selector === "string");

const handleActionSelection = (action: RecordedAction, event: Event) => {
  const checked = (event.target as HTMLInputElement).checked;
  const next = new Set(selectedActionIds.value);
  if (checked) next.add(action.id);
  else next.delete(action.id);
  selectedActionIds.value = next;
};

const clearActionSelection = () => {
  selectedActionIds.value = new Set();
};

const handleCreateManualStep = async (mode: "controls" | "custom") => {
  const result = await createManualStep({
    actionIds: selectedActions.value.map((action) => action.id),
    mode,
    ...(manualStepTitle.value.trim() ? { title: manualStepTitle.value.trim() } : {}),
  });
  if (result) {
    clearActionSelection();
    manualStepTitle.value = "";
  }
};

const compactUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
};

const formatValue = (value: RecordedAction["value"]) => {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
};

const handleStart = async () => {
  if (props.executionActive || !canStart.value) return;
  clearError();
  await startRecording({ index: props.tab.index, url: props.tab.url });
};

const handleIncludeChange = async (action: RecordedAction, event: Event) => {
  const checkbox = event.target as HTMLInputElement;
  const requestedValue = checkbox.checked;
  const updated = await setActionIncluded(action.id, requestedValue);
  if (!updated) checkbox.checked = action.included;
};

const handleGenerate = async () => {
  const generated = await generateScript(filename.value);
  if (generated) filename.value = generated.filename;
};

const handleValidateAndSave = async () => {
  const result = await validateAndSave(
    `浏览器录制：${generatedScript.value?.filename ?? filename.value.trim()}`,
  );
  if (result) emit("saved", result);
};

watch(actions, (nextActions) => {
  const existingIds = new Set(nextActions.map((action) => action.id));
  const nextSelection = new Set(
    [...selectedActionIds.value].filter((actionId) => existingIds.has(actionId)),
  );
  if (nextSelection.size !== selectedActionIds.value.size) selectedActionIds.value = nextSelection;
});

watch(
  [isActive, () => session.value?.id ?? null],
  ([active, recordingId]) => emit("active-change", active, recordingId),
  { immediate: true },
);

onMounted(() => {
  if (props.autoStart) void handleStart();
});
</script>

<template>
  <section class="recording-panel" aria-labelledby="recording-panel-title">
    <header class="panel-header">
      <div class="header-copy">
        <div class="eyebrow-row">
          <span class="eyebrow">浏览器录制</span>
          <span class="status-badge" :class="`status-${phaseTone}`">
            <span class="status-dot" aria-hidden="true"></span>
            {{ phaseLabel }}
          </span>
        </div>
        <h3 id="recording-panel-title">{{ targetLabel }}</h3>
        <p :title="props.tab.url">Tab #{{ props.tab.index + 1 }} · {{ props.tab.url }}</p>
      </div>
      <button
        type="button"
        class="close-button"
        :disabled="!canClose"
        :title="
          canClose ? '关闭录制面板' : operation !== 'idle' ? '请等待当前操作完成' : '请先停止录制'
        "
        aria-label="关闭录制面板"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <div v-if="errorMessage" class="message-banner error-banner" role="alert">
      <div>
        <strong>操作未完成</strong>
        <p>{{ errorMessage }}</p>
      </div>
      <button type="button" aria-label="关闭错误提示" @click="clearError">×</button>
    </div>

    <div v-if="!session" class="empty-state">
      <div class="empty-mark" aria-hidden="true"><span></span></div>
      <div class="empty-copy">
        <h4>{{ operation === "starting" ? "正在连接录制服务" : "准备记录页面操作" }}</h4>
        <p v-if="props.executionActive">当前有脚本正在执行。请等待执行结束，再开始录制这个页签。</p>
        <p v-else>
          录制会实时收集点击、输入、选择、按键、滚动和 popup 页面操作；刷新后不会恢复本次会话。
        </p>
      </div>
      <button
        v-if="operation !== 'starting'"
        type="button"
        class="primary-button"
        :disabled="props.executionActive || !canStart"
        @click="handleStart"
      >
        开始录制
      </button>
      <span v-else class="inline-loader" role="status">正在启动…</span>
    </div>

    <template v-else>
      <div class="session-toolbar">
        <div class="session-summary">
          <div class="live-state">
            <span
              class="live-indicator"
              :class="{ pulsing: session.status === 'recording' }"
            ></span>
            <div>
              <strong>{{ session.status === "recording" ? "正在捕获操作" : "录制已停止" }}</strong>
              <span>
                {{ pages.length }} 个页面 · {{ actions.length }} 个动作
                <template v-if="hasPendingActionUpdates"> · 正在同步动作</template>
              </span>
            </div>
          </div>
          <span
            v-if="session.status === 'recording'"
            class="stream-state"
            :class="{ connected: streamConnected, warning: streamWarning }"
          >
            {{ streamConnected ? "实时流已连接" : streamWarning ? "实时流重连中" : "实时流连接中" }}
          </span>
        </div>
        <button type="button" class="stop-button" :disabled="!canStop" @click="stopRecording">
          {{ operation === "stopping" ? "正在停止…" : "停止录制" }}
        </button>
      </div>

      <p v-if="streamWarning" class="stream-warning" role="status">{{ streamWarning }}</p>

      <div class="page-strip" aria-label="已录制页面">
        <span v-if="pages.length === 0" class="page-placeholder">正在识别 page0…</span>
        <span v-for="page in pages" :key="page.id" class="page-chip" :title="page.url">
          <strong>{{ page.id }}</strong>
          <span>{{ compactUrl(page.url) }}</span>
          <small v-if="page.openerPageId">来自 {{ page.openerPageId }}</small>
        </span>
      </div>

      <div class="recording-workspace">
        <section class="workspace-card timeline-card" aria-labelledby="timeline-title">
          <div class="card-heading">
            <div>
              <span class="section-kicker">实时步骤</span>
              <h4 id="timeline-title">动作时间线</h4>
            </div>
            <span class="count-badge">{{ actions.length }}</span>
          </div>

          <div v-if="session.status === 'stopped'" class="manual-builder">
            <div class="manual-builder-copy">
              <strong>人工操作 checkpoint</strong>
              <span>{{ selectionHint }}</span>
            </div>
            <input
              v-model="manualStepTitle"
              type="text"
              maxlength="120"
              autocomplete="off"
              placeholder="可选标题，例如：请完成登录"
              :disabled="!canCreateManualStep"
            />
            <div class="manual-builder-actions">
              <button
                type="button"
                class="manual-control-button"
                :disabled="!canConvertControls"
                @click="handleCreateManualStep('controls')"
              >
                转为人工控件组
              </button>
              <button
                type="button"
                class="manual-custom-button"
                :disabled="!canConvertCustom"
                @click="handleCreateManualStep('custom')"
              >
                合并为自定义下拉
              </button>
              <button
                v-if="selectedActions.length"
                type="button"
                class="manual-clear-button"
                :disabled="hasPendingActionUpdates"
                @click="clearActionSelection"
              >
                清除选择
              </button>
            </div>
          </div>

          <div v-if="actions.length === 0" class="timeline-empty">
            <span class="empty-line"></span>
            <p>在目标页面执行操作后，动作会实时显示在这里。</p>
          </div>

          <ol v-else class="action-list">
            <li
              v-for="action in actions"
              :key="action.id"
              class="action-item"
              :class="{
                excluded: !action.included,
                'manual-action': action.type === 'manualStep',
                selected: selectedActionIds.has(action.id),
              }"
            >
              <div class="action-rail">
                <span class="order-badge">{{ action.order }}</span>
                <span class="rail-line"></span>
              </div>

              <div class="action-content">
                <div class="action-heading">
                  <div class="action-labels">
                    <span class="page-badge">{{ action.pageId }}</span>
                    <strong>{{ ACTION_LABELS[action.type] }}</strong>
                    <span v-if="action.opensPageId" class="popup-badge">
                      打开 {{ action.opensPageId }}
                    </span>
                  </div>
                  <div class="action-controls">
                    <label v-if="session.status === 'stopped'" class="range-control">
                      <input
                        type="checkbox"
                        :checked="selectedActionIds.has(action.id)"
                        :disabled="!isActionSelectable(action)"
                        :aria-label="`选择第 ${action.order} 个动作加入人工步骤`"
                        @change="handleActionSelection(action, $event)"
                      />
                      <span>分组</span>
                    </label>
                    <label class="include-control">
                      <input
                        type="checkbox"
                        :checked="action.included"
                        :disabled="!canUpdateActions || isActionPending(action.id)"
                        :aria-label="`${action.included ? '排除' : '包含'}第 ${action.order} 个动作`"
                        @change="handleIncludeChange(action, $event)"
                      />
                      <span>{{ isActionPending(action.id) ? "同步中" : "包含" }}</span>
                    </label>
                  </div>
                </div>

                <div v-if="action.type === 'manualStep'" class="manual-step-card">
                  <div class="manual-step-title">
                    <span aria-hidden="true">✋</span>
                    <strong>{{ action.title || "请完成人工操作" }}</strong>
                  </div>
                  <ul>
                    <li v-for="(target, targetIndex) in action.targets || []" :key="targetIndex">
                      <span>{{ targetIndex + 1 }}</span>
                      <strong>{{ target.displayName }}</strong>
                      <small>{{ CONTROL_KIND_LABELS[target.controlKind] }}</small>
                      <em v-if="target.required">必填</em>
                    </li>
                  </ul>
                  <p>执行到此处会在真实 Chrome 页面高亮并暂停；字段值不会进入脚本、日志或 API。</p>
                </div>
                <code v-if="action.selector" class="selector-value">{{ action.selector }}</code>
                <div v-if="action.value !== undefined" class="action-value">
                  <span>值</span>
                  <code>{{ formatValue(action.value) }}</code>
                </div>
                <span v-if="!action.included" class="excluded-note">生成脚本时将跳过此动作</span>
              </div>
            </li>
          </ol>

          <p v-if="hasPopupActions" class="cascade-note">
            排除打开 popup
            的点击时只提交一次更新；该页面内的动作由服务端原子级联，并通过实时流同步。
          </p>
        </section>

        <section class="workspace-card output-card" aria-labelledby="output-title">
          <div class="card-heading">
            <div>
              <span class="section-kicker">脚本输出</span>
              <h4 id="output-title">生成与保存</h4>
            </div>
          </div>

          <label class="filename-field">
            <span>文件名</span>
            <div class="filename-row">
              <input
                v-model.trim="filename"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="recorded-flow.mjs"
                :disabled="operation !== 'idle' || generatedScript !== null"
              />
              <button
                type="button"
                class="primary-button generate-button"
                :disabled="!canGenerate || !filename.trim()"
                @click="handleGenerate"
              >
                {{ operation === "generating" ? "生成中…" : "生成 JS" }}
              </button>
            </div>
          </label>
          <p v-if="session.status !== 'stopped'" class="field-help">停止录制后才能生成代码。</p>

          <div class="code-preview">
            <div class="preview-header">
              <span>代码预览</span>
              <code v-if="generatedScript">{{ generatedScript.filename }}</code>
            </div>
            <pre v-if="generatedScript"><code>{{ generatedScript.code }}</code></pre>
            <div v-else class="preview-placeholder">
              <span>&lt;/&gt;</span>
              <p>生成后的 ES Module 代码将在此处显示。</p>
            </div>
          </div>

          <div
            v-if="validationResult"
            class="validation-result"
            :class="validationResult.valid ? 'validation-success' : 'validation-error'"
            role="status"
          >
            <strong>{{ validationResult.valid ? "代码校验通过" : "代码校验未通过" }}</strong>
            <p v-if="validationResult.message">{{ validationResult.message }}</p>
            <ul v-if="validationResult.errors?.length">
              <li
                v-for="item in validationResult.errors"
                :key="`${item.line}:${item.character}:${item.message}`"
              >
                第 {{ item.line }} 行:{{ item.character }} — {{ item.message }}
              </li>
            </ul>
          </div>

          <div v-if="savedScript" class="save-success" role="status">
            已保存为 <code>{{ savedScript.filename }}</code>
          </div>

          <button
            type="button"
            class="save-button"
            :disabled="!canValidateAndSave"
            @click="handleValidateAndSave"
          >
            <template v-if="operation === 'validating'">正在校验…</template>
            <template v-else-if="operation === 'saving'">正在保存…</template>
            <template v-else>校验并保存</template>
          </button>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.recording-panel {
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #dbe3ef;
  border-radius: 16px;
  box-shadow: var(--shadow-sm);
  color: #0f172a;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem 1.5rem;
  background:
    radial-gradient(circle at 88% 10%, rgba(129, 140, 248, 0.18), transparent 30%),
    linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
  border-bottom: 1px solid #dbe3ef;
}

.header-copy {
  min-width: 0;
}

.eyebrow-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin-bottom: 0.45rem;
}

.eyebrow,
.section-kicker {
  color: #4f46e5;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.header-copy h3 {
  margin: 0;
  overflow: hidden;
  color: #0f172a;
  font-size: 1.2rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-copy p {
  max-width: 760px;
  margin: 0.35rem 0 0;
  overflow: hidden;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge,
.stream-state {
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0.22rem 0.58rem;
  font-size: 0.72rem;
  font-weight: 700;
}

.status-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.status-live {
  color: #b91c1c;
  background: #fef2f2;
  border-color: #fecaca;
}

.status-ready {
  color: #4338ca;
  background: #eef2ff;
  border-color: #c7d2fe;
}

.status-success {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.status-danger {
  color: #b91c1c;
  background: #fff1f2;
  border-color: #fecdd3;
}

.status-neutral {
  color: #475569;
  background: #f1f5f9;
  border-color: #e2e8f0;
}

.close-button,
.message-banner button {
  display: grid;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  padding: 0;
  place-items: center;
  color: #64748b;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid #dbe3ef;
  border-radius: 9px;
  font-size: 1.25rem;
  cursor: pointer;
}

.close-button:hover:not(:disabled),
.message-banner button:hover {
  color: #0f172a;
  background: #ffffff;
  border-color: #94a3b8;
}

.close-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.message-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin: 1rem 1.5rem 0;
  padding: 0.85rem 1rem;
  border: 1px solid;
  border-radius: 10px;
}

.message-banner strong,
.message-banner p {
  margin: 0;
}

.message-banner p {
  margin-top: 0.2rem;
  font-size: 0.82rem;
  line-height: 1.45;
}

.error-banner {
  color: #991b1b;
  background: #fff7f7;
  border-color: #fecaca;
}

.error-banner button {
  width: 26px;
  height: 26px;
  color: #991b1b;
  background: transparent;
  border: 0;
}

.empty-state {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.5rem;
}

.empty-mark {
  display: grid;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  place-items: center;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 13px;
}

.empty-mark span {
  width: 17px;
  height: 17px;
  border: 3px solid #4f46e5;
  border-radius: 50%;
  box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.12);
}

.empty-copy {
  flex: 1;
  min-width: 0;
}

.empty-copy h4,
.empty-copy p {
  margin: 0;
}

.empty-copy h4 {
  font-size: 0.95rem;
}

.empty-copy p {
  margin-top: 0.3rem;
  color: #64748b;
  font-size: 0.82rem;
  line-height: 1.5;
}

.primary-button,
.stop-button,
.save-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 38px;
  padding: 0.55rem 0.9rem;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 750;
  cursor: pointer;
  transition: 0.18s ease;
}

.primary-button {
  color: #ffffff;
  background: linear-gradient(135deg, #4f46e5, #6366f1);
  border: 1px solid #4f46e5;
  box-shadow: 0 3px 8px rgba(79, 70, 229, 0.2);
}

.primary-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 5px 12px rgba(79, 70, 229, 0.28);
}

.primary-button:disabled,
.stop-button:disabled,
.save-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  transform: none;
  box-shadow: none;
}

.inline-loader {
  color: #4f46e5;
  font-size: 0.8rem;
  font-weight: 700;
  white-space: nowrap;
}

.session-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #edf1f7;
}

.session-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  min-width: 0;
}

.live-state {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.live-state > div {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
}

.live-state strong {
  font-size: 0.86rem;
}

.live-state span:not(.live-indicator) {
  color: #64748b;
  font-size: 0.74rem;
}

.live-indicator {
  position: relative;
  width: 10px;
  height: 10px;
  background: #94a3b8;
  border-radius: 50%;
}

.live-indicator.pulsing {
  background: #ef4444;
}

.live-indicator.pulsing::after {
  position: absolute;
  inset: -4px;
  border: 1px solid rgba(239, 68, 68, 0.48);
  border-radius: 50%;
  content: "";
  animation: recording-pulse 1.6s ease-out infinite;
}

@keyframes recording-pulse {
  0% {
    opacity: 0.85;
    transform: scale(0.7);
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

.stream-state {
  color: #64748b;
  background: #f8fafc;
  border-color: #e2e8f0;
}

.stream-state.connected {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.stream-state.warning {
  color: #b45309;
  background: #fffbeb;
  border-color: #fde68a;
}

.stop-button {
  flex: 0 0 auto;
  color: #b91c1c;
  background: #fff1f2;
  border: 1px solid #fecdd3;
}

.stop-button:hover:not(:disabled) {
  color: #ffffff;
  background: #dc2626;
  border-color: #dc2626;
}

.stream-warning {
  margin: 0;
  padding: 0.55rem 1.5rem;
  color: #92400e;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
  font-size: 0.76rem;
}

.page-strip {
  display: flex;
  gap: 0.55rem;
  overflow-x: auto;
  padding: 0.8rem 1.5rem;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
}

.page-chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.45rem;
  max-width: 310px;
  padding: 0.38rem 0.62rem;
  color: #475569;
  background: #ffffff;
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  font-size: 0.72rem;
}

.page-chip strong {
  color: #4338ca;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.page-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-chip small {
  flex: 0 0 auto;
  color: #7c3aed;
}

.page-placeholder {
  color: #94a3b8;
  font-size: 0.76rem;
}

.recording-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(360px, 0.88fr);
  gap: 1rem;
  padding: 1rem 1.5rem 1.5rem;
  background: #f8fafc;
}

.workspace-card {
  min-width: 0;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.1rem 0.85rem;
  border-bottom: 1px solid #f1f5f9;
}

.card-heading h4 {
  margin: 0.2rem 0 0;
  color: #1e293b;
  font-size: 0.94rem;
}

.manual-builder {
  display: grid;
  gap: 0.65rem;
  padding: 0.85rem 1rem;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
}

.manual-builder-copy {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

.manual-builder-copy strong {
  color: #92400e;
  font-size: 0.78rem;
}

.manual-builder-copy span {
  color: #a16207;
  font-size: 0.68rem;
  text-align: right;
}

.manual-builder input {
  width: 100%;
  min-width: 0;
  height: 35px;
  padding: 0 0.65rem;
  color: #78350f;
  background: #ffffff;
  border: 1px solid #fcd34d;
  border-radius: 7px;
  outline: none;
  font-size: 0.74rem;
}

.manual-builder input:focus {
  border-color: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
}

.manual-builder-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.manual-builder-actions button {
  min-height: 32px;
  padding: 0.4rem 0.65rem;
  border-radius: 7px;
  font-size: 0.7rem;
  font-weight: 750;
  cursor: pointer;
}

.manual-control-button {
  color: #ffffff;
  background: #d97706;
  border: 1px solid #d97706;
}

.manual-custom-button {
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #f59e0b;
}

.manual-clear-button {
  color: #64748b;
  background: #ffffff;
  border: 1px solid #cbd5e1;
}

.manual-builder-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.count-badge {
  min-width: 28px;
  padding: 0.2rem 0.45rem;
  color: #4f46e5;
  background: #eef2ff;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 800;
  text-align: center;
}

.timeline-empty {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 150px;
  padding: 1.25rem;
  color: #94a3b8;
}

.timeline-empty p {
  margin: 0;
  font-size: 0.8rem;
}

.empty-line {
  width: 3px;
  height: 52px;
  background: linear-gradient(#c7d2fe, transparent);
  border-radius: 99px;
}

.action-list {
  max-height: 520px;
  margin: 0;
  overflow-y: auto;
  padding: 0.75rem 1rem 0.9rem;
  list-style: none;
}

.action-item {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  transition: opacity 0.18s ease;
}

.action-item.excluded {
  opacity: 0.58;
}

.action-item.selected .action-content {
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.1), transparent);
}

.action-item.manual-action .order-badge {
  color: #92400e;
  background: #fef3c7;
  border-color: #fcd34d;
}

.action-rail {
  display: flex;
  align-items: center;
  flex-direction: column;
}

.order-badge {
  display: grid;
  flex: 0 0 auto;
  width: 25px;
  height: 25px;
  place-items: center;
  color: #4338ca;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 50%;
  font-size: 0.68rem;
  font-weight: 800;
}

.rail-line {
  width: 1px;
  min-height: 24px;
  flex: 1;
  background: #e2e8f0;
}

.action-item:last-child .rail-line {
  background: linear-gradient(#e2e8f0, transparent);
}

.action-content {
  min-width: 0;
  margin: 0 0 0.65rem 0.35rem;
  padding: 0 0.1rem 0.75rem 0.55rem;
  border-bottom: 1px solid #f1f5f9;
}

.action-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.action-labels {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  min-width: 0;
}

.action-labels strong {
  font-size: 0.8rem;
}

.page-badge,
.popup-badge {
  padding: 0.14rem 0.38rem;
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.64rem;
  font-weight: 700;
}

.page-badge {
  color: #475569;
  background: #f1f5f9;
}

.popup-badge {
  color: #6d28d9;
  background: #f3e8ff;
}

.action-controls {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.6rem;
}

.range-control,
.include-control {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.35rem;
  color: #64748b;
  font-size: 0.7rem;
  cursor: pointer;
}

.range-control {
  color: #a16207;
}

.range-control input,
.include-control input {
  width: 15px;
  height: 15px;
  margin: 0;
}

.range-control input {
  accent-color: #d97706;
}

.include-control input {
  accent-color: #4f46e5;
}

.range-control:has(input:disabled),
.include-control:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.55;
}

.manual-step-card {
  margin-top: 0.55rem;
  padding: 0.65rem;
  color: #78350f;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}

.manual-step-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.76rem;
}

.manual-step-card ul {
  display: grid;
  gap: 0.35rem;
  margin: 0.55rem 0 0;
  padding: 0;
  list-style: none;
}

.manual-step-card li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  padding: 0.35rem 0.45rem;
  background: rgba(255, 255, 255, 0.76);
  border-radius: 6px;
  font-size: 0.68rem;
}

.manual-step-card li > span {
  display: grid;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  place-items: center;
  color: #ffffff;
  background: #d97706;
  border-radius: 50%;
  font-weight: 800;
}

.manual-step-card li strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manual-step-card li small {
  margin-left: auto;
  color: #a16207;
  white-space: nowrap;
}

.manual-step-card li em {
  color: #b91c1c;
  font-size: 0.62rem;
  font-style: normal;
}

.manual-step-card p {
  margin: 0.55rem 0 0;
  color: #92400e;
  font-size: 0.66rem;
  line-height: 1.45;
}

.selector-value {
  display: block;
  max-width: 100%;
  margin-top: 0.48rem;
  overflow: hidden;
  color: #334155;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-value {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin-top: 0.35rem;
  color: #94a3b8;
  font-size: 0.68rem;
}

.action-value code {
  overflow: hidden;
  color: #475569;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.excluded-note {
  display: block;
  margin-top: 0.4rem;
  color: #b45309;
  font-size: 0.68rem;
}

.cascade-note {
  margin: 0;
  padding: 0.75rem 1rem;
  color: #5b21b6;
  background: #faf5ff;
  border-top: 1px solid #e9d5ff;
  font-size: 0.72rem;
  line-height: 1.5;
}

.output-card {
  padding-bottom: 1rem;
}

.filename-field {
  display: block;
  padding: 1rem 1.1rem 0;
}

.filename-field > span {
  display: block;
  margin-bottom: 0.42rem;
  color: #475569;
  font-size: 0.75rem;
  font-weight: 700;
}

.filename-row {
  display: flex;
  align-items: stretch;
}

.filename-row input {
  min-width: 0;
  flex: 1;
  height: 39px;
  padding: 0 0.7rem;
  color: #1e293b;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-right: 0;
  border-radius: 8px 0 0 8px;
  outline: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.76rem;
}

.filename-row input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.filename-row input:disabled {
  color: #94a3b8;
  background: #f8fafc;
}

.generate-button {
  min-height: 39px;
  border-radius: 0 8px 8px 0;
  white-space: nowrap;
}

.field-help {
  margin: 0.45rem 1.1rem 0;
  color: #94a3b8;
  font-size: 0.7rem;
}

.code-preview {
  margin: 1rem 1.1rem 0;
  overflow: hidden;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 9px;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
  color: #94a3b8;
  background: #172033;
  border-bottom: 1px solid #263248;
  font-size: 0.68rem;
  font-weight: 700;
}

.preview-header code {
  overflow: hidden;
  color: #c7d2fe;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-preview pre {
  min-height: 220px;
  max-height: 420px;
  margin: 0;
  overflow: auto;
  padding: 0.9rem;
  color: #dbeafe;
  font-size: 0.7rem;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
}

.preview-placeholder {
  display: grid;
  min-height: 220px;
  padding: 1rem;
  place-content: center;
  color: #64748b;
  text-align: center;
}

.preview-placeholder span {
  color: #818cf8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 1.1rem;
  font-weight: 800;
}

.preview-placeholder p {
  margin: 0.45rem 0 0;
  font-size: 0.72rem;
}

.validation-result,
.save-success {
  margin: 0.8rem 1.1rem 0;
  padding: 0.72rem 0.8rem;
  border: 1px solid;
  border-radius: 8px;
  font-size: 0.72rem;
  line-height: 1.5;
}

.validation-result p,
.validation-result ul {
  margin: 0.25rem 0 0;
}

.validation-result ul {
  max-height: 120px;
  overflow: auto;
  padding-left: 1.1rem;
}

.validation-success,
.save-success {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.validation-error {
  color: #b91c1c;
  background: #fff1f2;
  border-color: #fecdd3;
}

.save-success code {
  color: inherit;
  font-weight: 800;
}

.save-button {
  width: calc(100% - 2.2rem);
  margin: 0.9rem 1.1rem 0;
  color: #ffffff;
  background: linear-gradient(135deg, #059669, #0d9488);
  border: 1px solid #059669;
  box-shadow: 0 3px 8px rgba(5, 150, 105, 0.18);
}

.save-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 5px 12px rgba(5, 150, 105, 0.26);
}

@media (max-width: 960px) {
  .recording-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .action-list {
    max-height: 430px;
  }
}

@media (max-width: 640px) {
  .panel-header,
  .session-toolbar,
  .empty-state {
    padding-right: 1rem;
    padding-left: 1rem;
  }

  .panel-header {
    align-items: flex-start;
  }

  .message-banner {
    margin-right: 1rem;
    margin-left: 1rem;
  }

  .empty-state {
    align-items: stretch;
    flex-direction: column;
  }

  .empty-mark {
    display: none;
  }

  .session-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .stop-button {
    width: 100%;
  }

  .page-strip,
  .recording-workspace {
    padding-right: 1rem;
    padding-left: 1rem;
  }

  .page-chip {
    max-width: 260px;
  }

  .action-heading {
    align-items: flex-start;
  }

  .filename-row {
    flex-direction: column;
    gap: 0.55rem;
  }

  .filename-row input,
  .generate-button {
    width: 100%;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
  }
}
</style>
