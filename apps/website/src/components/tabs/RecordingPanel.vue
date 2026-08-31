<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { BrowserTab, RecordedAction, RecordedPaginationLoop } from "../../types/automation";
import {
  useRecording,
  type PaginationLoopPreview,
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
  canConfigurePaginationLoop,
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
  previewPaginationLoop,
  createPaginationLoop,
  dissolvePaginationLoop,
  stopRecording,
  generateScript,
  validateAndSave,
  isActionPending,
  clearError,
} = useRecording();

const filename = ref(`recording-tab-${props.tab.index + 1}.mjs`);
const loopStartActionId = ref("");
const loopEntryActionId = ref("");
const loopNextActionId = ref("");
const loopMaxPages = ref(100);
const loopPreview = ref<PaginationLoopPreview | null>(null);
const selectedLoopCandidateIndex = ref<number | null>(null);

type TimelineRow =
  | { kind: "action"; key: string; action: RecordedAction }
  | {
      kind: "pagination-loop";
      key: string;
      loop: RecordedPaginationLoop;
      actions: RecordedAction[];
    };

const PHASE_LABELS: Record<RecordingPhase, string> = {
  idle: "等待开始",
  starting: "正在启动",
  recording: "录制中",
  stopping: "正在停止",
  stopped: "已停止",
  "configuring-loop": "正在配置循环",
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
};

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
const includedActions = computed(() => actions.value.filter((action) => action.included));
const loopNextOptions = computed(() => {
  const startIndex = actions.value.findIndex((action) => action.id === loopStartActionId.value);
  if (startIndex < 0) return [];
  return actions.value
    .slice(startIndex + 1)
    .filter((action) => action.included && action.type === "click" && action.selector);
});
const selectedLoopActions = computed(() => {
  const startIndex = actions.value.findIndex((action) => action.id === loopStartActionId.value);
  const nextIndex = actions.value.findIndex((action) => action.id === loopNextActionId.value);
  if (startIndex < 0 || nextIndex <= startIndex) return [];
  const range = actions.value.slice(startIndex, nextIndex + 1);
  return range.every((action) => action.included) ? range : [];
});
const loopEntryOptions = computed(() =>
  selectedLoopActions.value
    .slice(0, -1)
    .filter((action) => action.type === "click" && action.selector),
);
const canPreviewLoop = computed(
  () =>
    canConfigurePaginationLoop.value &&
    !session.value?.paginationLoop &&
    selectedLoopActions.value.length >= 2 &&
    loopEntryOptions.value.some((action) => action.id === loopEntryActionId.value),
);
const canCreateLoop = computed(
  () =>
    canConfigurePaginationLoop.value &&
    loopPreview.value !== null &&
    selectedLoopCandidateIndex.value !== null &&
    Number.isInteger(loopMaxPages.value) &&
    loopMaxPages.value >= 1 &&
    loopMaxPages.value <= 1000,
);
const timelineRows = computed<TimelineRow[]>(() => {
  const loop = session.value?.paginationLoop;
  if (!loop) {
    return actions.value.map((action) => ({ kind: "action", key: action.id, action }));
  }

  const actionById = new Map(actions.value.map((action) => [action.id, action]));
  const loopActions = loop.actionIds
    .map((actionId) => actionById.get(actionId))
    .filter((action): action is RecordedAction => action !== undefined);
  if (loopActions.length === 0) {
    return actions.value.map((action) => ({ kind: "action", key: action.id, action }));
  }

  const loopActionIds = new Set(loop.actionIds);
  const rows: TimelineRow[] = [];
  let loopInserted = false;
  for (const action of actions.value) {
    if (loopActionIds.has(action.id)) {
      if (!loopInserted) {
        rows.push({
          kind: "pagination-loop",
          key: "pagination-loop",
          loop,
          actions: loopActions,
        });
        loopInserted = true;
      }
      continue;
    }
    rows.push({ kind: "action", key: action.id, action });
  }
  return rows;
});

const actionOptionLabel = (action: RecordedAction) =>
  `步骤 ${action.order} · ${ACTION_LABELS[action.type]}${action.selector ? ` · ${action.selector}` : ""}`;

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

const resetLoopForm = () => {
  loopStartActionId.value = "";
  loopEntryActionId.value = "";
  loopNextActionId.value = "";
  loopMaxPages.value = 100;
  loopPreview.value = null;
  selectedLoopCandidateIndex.value = null;
};

const currentLoopSelection = () => {
  if (!canPreviewLoop.value) return null;
  return {
    actionIds: selectedLoopActions.value.map((action) => action.id),
    listEntryActionId: loopEntryActionId.value,
    nextActionId: loopNextActionId.value,
  };
};

const handlePreviewLoop = async () => {
  const selection = currentLoopSelection();
  if (!selection) return;
  loopPreview.value = null;
  selectedLoopCandidateIndex.value = null;
  const preview = await previewPaginationLoop(selection);
  if (!preview) return;
  loopPreview.value = preview;
  if (preview.candidates.length === 1) {
    selectedLoopCandidateIndex.value = preview.candidates[0]?.candidateIndex ?? null;
  }
};

const handleCreateLoop = async () => {
  const preview = loopPreview.value;
  const candidateIndex = selectedLoopCandidateIndex.value;
  if (!preview || candidateIndex === null || !canCreateLoop.value) return;
  const created = await createPaginationLoop({
    actionIds: [...preview.actionIds],
    listEntryActionId: preview.listEntryActionId,
    nextActionId: preview.nextActionId,
    candidateIndex,
    maxPages: loopMaxPages.value,
  });
  if (created) resetLoopForm();
};

const handleDissolveLoop = async (reconfigure: boolean) => {
  const configuredLoop = session.value?.paginationLoop;
  if (!configuredLoop) return;
  const previous = {
    startActionId: configuredLoop.actionIds[0] ?? "",
    listEntryActionId: configuredLoop.listEntryActionId,
    nextActionId: configuredLoop.nextActionId,
    maxPages: configuredLoop.maxPages,
  };
  const dissolved = await dissolvePaginationLoop();
  if (!dissolved) return;
  resetLoopForm();
  if (reconfigure) {
    loopStartActionId.value = previous.startActionId;
    loopEntryActionId.value = previous.listEntryActionId;
    loopNextActionId.value = previous.nextActionId;
    loopMaxPages.value = previous.maxPages;
  }
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

watch([loopStartActionId, loopNextActionId, loopEntryActionId], () => {
  if (
    loopNextActionId.value &&
    !loopNextOptions.value.some((action) => action.id === loopNextActionId.value)
  ) {
    loopNextActionId.value = "";
  }
  if (
    loopEntryActionId.value &&
    !loopEntryOptions.value.some((action) => action.id === loopEntryActionId.value)
  ) {
    loopEntryActionId.value = "";
  }
  loopPreview.value = null;
  selectedLoopCandidateIndex.value = null;
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

          <section
            v-if="session.status === 'stopped' && !session.paginationLoop"
            class="loop-config"
            aria-labelledby="loop-config-title"
          >
            <div class="loop-config-heading">
              <div>
                <strong id="loop-config-title">分页列表循环</strong>
                <p>选择连续范围；范围最后一步作为 Next，每页列表项数量在运行时重新计算。</p>
              </div>
              <span>最多 1000 页</span>
            </div>

            <div class="loop-fields">
              <label>
                <span>循环起点</span>
                <select v-model="loopStartActionId" :disabled="!canConfigurePaginationLoop">
                  <option value="">选择第一步</option>
                  <option v-for="action in includedActions" :key="action.id" :value="action.id">
                    {{ actionOptionLabel(action) }}
                  </option>
                </select>
              </label>
              <label>
                <span>Next（范围末步）</span>
                <select
                  v-model="loopNextActionId"
                  :disabled="!canConfigurePaginationLoop || !loopStartActionId"
                >
                  <option value="">选择下一页点击</option>
                  <option v-for="action in loopNextOptions" :key="action.id" :value="action.id">
                    {{ actionOptionLabel(action) }}
                  </option>
                </select>
              </label>
              <label>
                <span>列表入口点击</span>
                <select
                  v-model="loopEntryActionId"
                  :disabled="!canConfigurePaginationLoop || loopEntryOptions.length === 0"
                >
                  <option value="">选择用于示范第一项的点击</option>
                  <option v-for="action in loopEntryOptions" :key="action.id" :value="action.id">
                    {{ actionOptionLabel(action) }}
                  </option>
                </select>
              </label>
              <label>
                <span>最大页数</span>
                <input
                  v-model.number="loopMaxPages"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  :disabled="!canConfigurePaginationLoop"
                />
              </label>
            </div>

            <div class="loop-preview-row">
              <span v-if="selectedLoopActions.length">
                已选择 {{ selectedLoopActions.length }} 步：步骤
                {{ selectedLoopActions[0]?.order }}–{{ selectedLoopActions.at(-1)?.order }}
              </span>
              <span v-else>先选择起点、Next 和列表入口。</span>
              <button
                type="button"
                class="secondary-button"
                :disabled="!canPreviewLoop"
                @click="handlePreviewLoop"
              >
                {{ operation === "configuring-loop" ? "分析中…" : "分析列表结构" }}
              </button>
            </div>

            <fieldset v-if="loopPreview" class="candidate-list">
              <legend>选择要逐项遍历的结构</legend>
              <label
                v-for="candidate in loopPreview.candidates"
                :key="candidate.candidateIndex"
                class="candidate-option"
              >
                <input
                  v-model="selectedLoopCandidateIndex"
                  type="radio"
                  :value="candidate.candidateIndex"
                  :disabled="!canConfigurePaginationLoop"
                />
                <span>
                  <strong>录制时第 {{ candidate.sourceOrdinal }} 项</strong>
                  <code>{{ candidate.listSelector }}</code>
                </span>
              </label>
              <button
                type="button"
                class="primary-button loop-create-button"
                :disabled="!canCreateLoop"
                @click="handleCreateLoop"
              >
                创建分页循环
              </button>
            </fieldset>
          </section>

          <div v-if="actions.length === 0" class="timeline-empty">
            <span class="empty-line"></span>
            <p>在目标页面执行操作后，动作会实时显示在这里。</p>
          </div>

          <ol v-else class="action-list">
            <template v-for="row in timelineRows" :key="row.key">
              <li
                v-if="row.kind === 'action'"
                class="action-item"
                :class="{ excluded: !row.action.included }"
              >
                <div class="action-rail">
                  <span class="order-badge">{{ row.action.order }}</span>
                  <span class="rail-line"></span>
                </div>

                <div class="action-content">
                  <div class="action-heading">
                    <div class="action-labels">
                      <span class="page-badge">{{ row.action.pageId }}</span>
                      <strong>{{ ACTION_LABELS[row.action.type] }}</strong>
                      <span v-if="row.action.opensPageId" class="popup-badge">
                        打开 {{ row.action.opensPageId }}
                      </span>
                    </div>
                    <label class="include-control">
                      <input
                        type="checkbox"
                        :checked="row.action.included"
                        :disabled="!canUpdateActions || isActionPending(row.action.id)"
                        :aria-label="`${row.action.included ? '排除' : '包含'}第 ${row.action.order} 个动作`"
                        @change="handleIncludeChange(row.action, $event)"
                      />
                      <span>{{ isActionPending(row.action.id) ? "同步中" : "包含" }}</span>
                    </label>
                  </div>

                  <code v-if="row.action.selector" class="selector-value">
                    {{ row.action.selector }}
                  </code>
                  <div v-if="row.action.value !== undefined" class="action-value">
                    <span>值</span>
                    <code>{{ formatValue(row.action.value) }}</code>
                  </div>
                  <span v-if="!row.action.included" class="excluded-note">
                    生成脚本时将跳过此动作
                  </span>
                </div>
              </li>

              <li v-else class="action-item pagination-loop-item">
                <div class="action-rail">
                  <span class="order-badge loop-order-badge">↻</span>
                  <span class="rail-line"></span>
                </div>
                <div class="action-content loop-action-content">
                  <details class="loop-details">
                    <summary>
                      <span>
                        <strong>分页列表循环</strong>
                        <small>
                          步骤 {{ row.actions[0]?.order }}–{{ row.actions.at(-1)?.order }} · 最多
                          {{ row.loop.maxPages }} 页
                        </small>
                      </span>
                      <span class="loop-summary-badge">每页动态逐项执行</span>
                    </summary>
                    <p>
                      每页先扫描真实列表项，重复执行 {{ Math.max(0, row.actions.length - 1) }}
                      个循环体步骤，再点击一次 Next；Next 不可用或内容未变化时提前结束。
                    </p>
                    <ol class="loop-member-list">
                      <li v-for="action in row.actions" :key="action.id">
                        <span>步骤 {{ action.order }}</span>
                        <strong>{{ ACTION_LABELS[action.type] }}</strong>
                        <small>{{ action.id === row.loop.nextActionId ? "Next" : "循环体" }}</small>
                      </li>
                    </ol>
                    <code class="selector-value" :title="row.loop.listSelector">
                      {{ row.loop.listSelector }}
                    </code>
                    <div class="loop-card-actions">
                      <button
                        type="button"
                        class="secondary-button"
                        :disabled="!canConfigurePaginationLoop"
                        @click="handleDissolveLoop(true)"
                      >
                        重新配置
                      </button>
                      <button
                        type="button"
                        class="danger-text-button"
                        :disabled="!canConfigurePaginationLoop"
                        @click="handleDissolveLoop(false)"
                      >
                        解散循环
                      </button>
                    </div>
                  </details>
                </div>
              </li>
            </template>
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

.include-control {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.35rem;
  color: #64748b;
  font-size: 0.7rem;
  cursor: pointer;
}

.include-control input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: #4f46e5;
}

.include-control:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.55;
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

.loop-config {
  margin: 0.8rem 1rem 0;
  padding: 0.9rem;
  background: #f8faff;
  border: 1px solid #c7d2fe;
  border-radius: 10px;
}

.loop-config-heading,
.loop-preview-row,
.loop-card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.loop-config-heading strong {
  color: #312e81;
  font-size: 0.82rem;
}

.loop-config-heading p {
  margin: 0.2rem 0 0;
  color: #64748b;
  font-size: 0.7rem;
  line-height: 1.45;
}

.loop-config-heading > span,
.loop-preview-row > span {
  flex: 0 0 auto;
  color: #6366f1;
  font-size: 0.68rem;
  font-weight: 700;
}

.loop-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  margin-top: 0.8rem;
}

.loop-fields label > span {
  display: block;
  margin-bottom: 0.3rem;
  color: #475569;
  font-size: 0.68rem;
  font-weight: 700;
}

.loop-fields select,
.loop-fields input {
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 0.55rem;
  color: #334155;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  font-size: 0.7rem;
}

.loop-preview-row {
  margin-top: 0.75rem;
}

.secondary-button,
.danger-text-button {
  min-height: 32px;
  padding: 0.4rem 0.7rem;
  background: #ffffff;
  border: 1px solid #c7d2fe;
  border-radius: 7px;
  font-size: 0.7rem;
  font-weight: 750;
  cursor: pointer;
}

.secondary-button {
  color: #4338ca;
}

.danger-text-button {
  color: #b91c1c;
  border-color: #fecaca;
}

.secondary-button:disabled,
.danger-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.candidate-list {
  display: grid;
  gap: 0.45rem;
  margin: 0.8rem 0 0;
  padding: 0.7rem;
  border: 1px solid #e0e7ff;
  border-radius: 8px;
}

.candidate-list legend {
  padding: 0 0.3rem;
  color: #475569;
  font-size: 0.68rem;
  font-weight: 700;
}

.candidate-option {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.45rem;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  cursor: pointer;
}

.candidate-option span,
.candidate-option code {
  display: block;
  min-width: 0;
}

.candidate-option strong {
  color: #334155;
  font-size: 0.7rem;
}

.candidate-option code {
  margin-top: 0.2rem;
  overflow: hidden;
  color: #64748b;
  font-size: 0.66rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loop-create-button {
  width: 100%;
  margin-top: 0.25rem;
}

.pagination-loop-item .loop-order-badge {
  color: #ffffff;
  background: #4f46e5;
  border-color: #4f46e5;
}

.loop-action-content {
  padding-bottom: 0.65rem;
}

.loop-details {
  padding: 0.7rem;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 9px;
}

.loop-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  cursor: pointer;
  list-style: none;
}

.loop-details summary::-webkit-details-marker {
  display: none;
}

.loop-details summary > span:first-child {
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}

.loop-details summary strong {
  color: #312e81;
  font-size: 0.8rem;
}

.loop-details summary small,
.loop-details > p {
  color: #64748b;
  font-size: 0.67rem;
}

.loop-summary-badge {
  flex: 0 0 auto;
  padding: 0.2rem 0.42rem;
  color: #4338ca;
  background: #ffffff;
  border-radius: 999px;
  font-size: 0.64rem;
  font-weight: 700;
}

.loop-details > p {
  margin: 0.7rem 0 0;
  line-height: 1.5;
}

.loop-member-list {
  display: grid;
  gap: 0.3rem;
  margin: 0.6rem 0 0;
  padding: 0;
  list-style: none;
}

.loop-member-list li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.5rem;
  padding: 0.35rem 0.45rem;
  color: #475569;
  background: rgba(255, 255, 255, 0.75);
  border-radius: 6px;
  font-size: 0.66rem;
}

.loop-member-list small {
  color: #6366f1;
}

.loop-card-actions {
  justify-content: flex-end;
  margin-top: 0.7rem;
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

  .loop-fields {
    grid-template-columns: minmax(0, 1fr);
  }

  .loop-config-heading,
  .loop-preview-row,
  .loop-details summary {
    align-items: flex-start;
    flex-direction: column;
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
