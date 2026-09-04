<script setup lang="ts">
import { computed } from "vue";
import type {
  InsertRecordedActionDraft,
  PaginationLoopSelectorCandidate,
  RecordedAction,
  RecordedPage,
  RecordedPaginationLoop,
} from "../../types/automation";

type InsertRecordedActionType = InsertRecordedActionDraft["type"];

interface RecordingActionEditorViewModel {
  open: boolean;
  canOpen: boolean;
  busy: boolean;
  anchorActionId: string | null;
  pageId: string;
  type: InsertRecordedActionType;
  selector: string;
  value: string;
  checked: boolean;
  canSubmit: boolean;
  hint: string;
}

interface RecordingActionDeleteViewModel {
  confirmingActionId: string | null;
  canDelete: boolean;
  busy: boolean;
  hint: string;
}

interface RecordingManualEditorViewModel {
  visible: boolean;
  title: string;
  selectionHint: string;
  selectedCount: number;
  titleDisabled: boolean;
  canConvertControls: boolean;
  canConvertCustom: boolean;
  clearDisabled: boolean;
}

interface RecordingLoopEditorViewModel {
  visible: boolean;
  canEdit: boolean;
  busy: boolean;
  startActionId: string;
  nextActionId: string;
  entryActionId: string;
  maxPages: number;
  startOptions: readonly RecordedAction[];
  nextOptions: readonly RecordedAction[];
  entryOptions: readonly RecordedAction[];
  selectedActions: readonly RecordedAction[];
  candidates: readonly PaginationLoopSelectorCandidate[];
  selectedCandidateIndex: number | null;
  canPreview: boolean;
  canCreate: boolean;
  configuredActions: readonly RecordedAction[];
  canConfigure: boolean;
}

type ManualStepConversionMode = "controls" | "custom";

const props = defineProps<{
  focusedNodeId: string | null;
  action: RecordedAction | null;
  page: RecordedPage | null;
  paginationLoop?: RecordedPaginationLoop;
  includeDisabled: boolean;
  includePending: boolean;
  manualSelected: boolean;
  manualSelectable: boolean;
  actionEditor: RecordingActionEditorViewModel;
  actionDelete: RecordingActionDeleteViewModel;
  manualEditor: RecordingManualEditorViewModel;
  loopEditor: RecordingLoopEditorViewModel;
}>();

const emit = defineEmits<{
  "open-action-insert": [afterActionId: string | null];
  "update-action-draft-type": [type: InsertRecordedActionType];
  "update-action-draft-selector": [selector: string];
  "update-action-draft-value": [value: string];
  "update-action-draft-checked": [checked: boolean];
  "submit-action-insert": [];
  "cancel-action-insert": [];
  "request-action-delete": [actionId: string];
  "confirm-action-delete": [];
  "cancel-action-delete": [];
  "update-action-included": [actionId: string, included: boolean];
  "update-action-selected": [actionId: string, selected: boolean];
  "update-manual-title": [title: string];
  "create-manual-step": [mode: ManualStepConversionMode];
  "clear-manual-selection": [];
  "update-loop-start-action-id": [actionId: string];
  "update-loop-next-action-id": [actionId: string];
  "update-loop-entry-action-id": [actionId: string];
  "update-loop-max-pages": [maxPages: number];
  "update-loop-candidate-index": [candidateIndex: number];
  "preview-loop": [];
  "create-loop": [];
  "reconfigure-loop": [];
  "dissolve-loop": [];
}>();

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

const INSERT_ACTION_LABELS: Record<InsertRecordedActionType, string> = {
  click: "点击",
  fill: "输入",
  select: "选择",
  setChecked: "勾选",
  press: "按键",
  scroll: "滚动",
};

const actionDraftUsesSelector = computed(() =>
  ["click", "fill", "select", "setChecked"].includes(props.actionEditor.type),
);
const actionDraftUsesTextValue = computed(() =>
  ["fill", "select", "press"].includes(props.actionEditor.type),
);

const formattedValue = computed(() => {
  const value = props.action?.value;
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
});

const actionOptionLabel = (action: RecordedAction): string =>
  `步骤 ${action.order} · ${ACTION_LABELS[action.type]}${action.selector ? ` · ${action.selector}` : ""}`;

const handleIncluded = (event: Event): void => {
  if (!props.action) return;
  emit("update-action-included", props.action.id, (event.target as HTMLInputElement).checked);
};

const handleManualSelected = (event: Event): void => {
  if (!props.action) return;
  emit("update-action-selected", props.action.id, (event.target as HTMLInputElement).checked);
};

const emitSelectValue = (
  event: Event,
  eventName:
    | "update-loop-start-action-id"
    | "update-loop-next-action-id"
    | "update-loop-entry-action-id",
): void => {
  emit(eventName, (event.target as HTMLSelectElement).value);
};

const handleMaxPages = (event: Event): void => {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  emit("update-loop-max-pages", Number.isNaN(value) ? 0 : value);
};

const handleCandidate = (candidateIndex: number): void => {
  emit("update-loop-candidate-index", candidateIndex);
};
</script>

<template>
  <aside
    class="inspector-card"
    aria-labelledby="recording-inspector-title"
    data-cy="recording-inspector"
  >
    <header>
      <span>节点检查器</span>
      <h4 id="recording-inspector-title">流程详情与编排</h4>
    </header>

    <div class="inspector-body">
      <section
        v-if="props.focusedNodeId === 'pagination-loop' && props.paginationLoop"
        class="inspector-section loop-detail"
        data-cy="recording-loop-details"
      >
        <span class="node-type loop">Loop</span>
        <h5>分页列表循环</h5>
        <dl>
          <div>
            <dt>步骤数</dt>
            <dd>{{ props.paginationLoop.actionIds.length }}</dd>
          </div>
          <div>
            <dt>最大页数</dt>
            <dd>{{ props.paginationLoop.maxPages }}</dd>
          </div>
          <div>
            <dt>列表入口</dt>
            <dd>{{ props.paginationLoop.listEntryActionId }}</dd>
          </div>
          <div>
            <dt>下一页</dt>
            <dd>{{ props.paginationLoop.nextActionId }}</dd>
          </div>
        </dl>
        <label class="code-field">
          <span>列表 selector</span>
          <code>{{ props.paginationLoop.listSelector }}</code>
        </label>

        <details class="nested-loop-details" open>
          <summary>父节点内执行步骤</summary>
          <ol>
            <li v-for="member in props.loopEditor.configuredActions" :key="member.id">
              <span>步骤 {{ member.order }}</span>
              <strong>{{ ACTION_LABELS[member.type] }}</strong>
              <small>{{
                member.id === props.paginationLoop.nextActionId ? "Next" : "循环体"
              }}</small>
            </li>
          </ol>
        </details>

        <div class="editor-actions">
          <button
            type="button"
            class="secondary-button"
            :disabled="!props.loopEditor.canConfigure"
            data-cy="recording-loop-reconfigure"
            @click="emit('reconfigure-loop')"
          >
            重新配置
          </button>
          <button
            type="button"
            class="danger-button"
            :disabled="!props.loopEditor.canConfigure"
            data-cy="recording-loop-dissolve"
            @click="emit('dissolve-loop')"
          >
            解散循环
          </button>
        </div>
        <p class="inspector-hint">
          循环成员以原动作 ID 保留在父节点内；循环配置和解散均由当前检查器完成。
        </p>
      </section>

      <section v-else-if="props.action" class="inspector-section">
        <span class="node-type" :class="props.action.type">
          {{ ACTION_LABELS[props.action.type] }}
        </span>
        <h5>步骤 {{ props.action.order }}</h5>
        <dl>
          <div>
            <dt>页面</dt>
            <dd>{{ props.action.pageId }}</dd>
          </div>
          <div v-if="props.action.opensPageId">
            <dt>打开页面</dt>
            <dd>{{ props.action.opensPageId }}</dd>
          </div>
          <div>
            <dt>生成状态</dt>
            <dd>{{ props.action.included ? "包含" : "已排除" }}</dd>
          </div>
          <div v-if="props.page">
            <dt>页面 URL</dt>
            <dd :title="props.page.url">{{ props.page.url }}</dd>
          </div>
        </dl>

        <label v-if="props.action.selector" class="code-field">
          <span>CSS selector</span>
          <code>{{ props.action.selector }}</code>
        </label>
        <label v-if="formattedValue" class="code-field">
          <span>录制值</span>
          <code>{{ formattedValue }}</code>
        </label>

        <div v-if="props.action.type === 'manualStep'" class="manual-targets">
          <strong>{{ props.action.title || "请完成人工操作" }}</strong>
          <span
            v-for="target in props.action.targets || []"
            :key="`${target.selector}:${target.controlKind}`"
          >
            {{ target.displayName }} · {{ target.controlKind }}
          </span>
        </div>

        <label class="toggle-row">
          <input
            type="checkbox"
            :checked="props.action.included"
            :disabled="props.includeDisabled"
            data-cy="recording-include-toggle"
            @change="handleIncluded"
          />
          <span>{{ props.includePending ? "正在同步…" : "生成 JS 时包含此节点" }}</span>
        </label>
        <label class="toggle-row">
          <input
            type="checkbox"
            :checked="props.manualSelected"
            :disabled="!props.manualSelectable"
            data-cy="recording-manual-select"
            @change="handleManualSelected"
          />
          <span>加入人工步骤连续范围</span>
        </label>
      </section>

      <section v-else-if="props.page" class="inspector-section" data-cy="recording-inspector-page">
        <span class="node-type">页面</span>
        <h5>{{ props.page.id }}</h5>
        <dl>
          <div>
            <dt>页面 ID</dt>
            <dd>{{ props.page.id }}</dd>
          </div>
          <div v-if="props.page.openerPageId">
            <dt>来源页面</dt>
            <dd>{{ props.page.openerPageId }}</dd>
          </div>
          <div>
            <dt>页面 URL</dt>
            <dd :title="props.page.url">{{ props.page.url }}</dd>
          </div>
        </dl>
        <p class="inspector-hint">从左侧流程节点选择动作，可继续查看 selector 与生成状态。</p>
      </section>

      <section v-else class="inspector-section inspector-empty">
        <strong>选择一个流程节点</strong>
        <p>点击左侧节点查看 selector、所属页面与生成状态；点击中间页面可切换页面上下文。</p>
      </section>

      <section
        v-if="
          (props.action || props.focusedNodeId === 'recording-start') &&
          !props.actionEditor.open &&
          !props.actionDelete.confirmingActionId
        "
        class="editor-section action-mutation-entry"
        data-cy="recording-action-mutation-entry"
      >
        <div class="editor-heading">
          <div>
            <span>流程编辑</span>
            <h5>新增或删除动作</h5>
          </div>
          <small>停止后编辑</small>
        </div>
        <p>{{ props.actionEditor.hint }}</p>
        <div class="editor-actions">
          <button
            type="button"
            class="primary-button"
            :disabled="!props.actionEditor.canOpen"
            :data-anchor-action-id="props.action?.id ?? 'recording-start'"
            data-cy="recording-inspector-insert-after"
            @click="emit('open-action-insert', props.action?.id ?? null)"
          >
            ＋ 在此节点后新增
          </button>
          <button
            v-if="props.action"
            type="button"
            class="danger-button"
            :disabled="!props.actionDelete.canDelete"
            data-cy="recording-action-delete"
            @click="emit('request-action-delete', props.action.id)"
          >
            删除此节点
          </button>
        </div>
        <p v-if="props.action && !props.actionDelete.canDelete" class="mutation-lock-hint">
          {{ props.actionDelete.hint }}
        </p>
      </section>

      <section
        v-if="props.actionEditor.open"
        class="editor-section action-editor"
        aria-labelledby="recording-action-editor-title"
        data-cy="recording-action-editor"
      >
        <div class="editor-heading">
          <div>
            <span>新增动作</span>
            <h5 id="recording-action-editor-title">在当前节点后插入</h5>
          </div>
          <small>{{ props.actionEditor.pageId }}</small>
        </div>
        <p>
          锚点：{{ props.actionEditor.anchorActionId ?? "Start" }}。新节点由服务端生成 ID
          并重新排列步骤编号。
        </p>
        <div class="action-editor-fields">
          <label>
            <span>动作类型</span>
            <select
              :value="props.actionEditor.type"
              :disabled="props.actionEditor.busy"
              data-cy="recording-action-type"
              @change="
                emit(
                  'update-action-draft-type',
                  ($event.target as HTMLSelectElement).value as InsertRecordedActionType,
                )
              "
            >
              <option v-for="(label, type) in INSERT_ACTION_LABELS" :key="type" :value="type">
                {{ label }}
              </option>
            </select>
          </label>
          <label v-if="actionDraftUsesSelector">
            <span>CSS selector</span>
            <input
              :value="props.actionEditor.selector"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder='例如：[data-testid="submit"]'
              :disabled="props.actionEditor.busy"
              data-cy="recording-action-selector"
              @input="
                emit('update-action-draft-selector', ($event.target as HTMLInputElement).value)
              "
            />
          </label>
          <label v-if="actionDraftUsesTextValue">
            <span>{{ props.actionEditor.type === "press" ? "按键" : "值" }}</span>
            <input
              :value="props.actionEditor.value"
              type="text"
              autocomplete="off"
              :placeholder="props.actionEditor.type === 'press' ? '例如：Enter' : '请输入值'"
              :disabled="props.actionEditor.busy"
              data-cy="recording-action-value"
              @input="emit('update-action-draft-value', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label v-if="props.actionEditor.type === 'scroll'">
            <span>纵向滚动位置</span>
            <input
              :value="props.actionEditor.value"
              type="number"
              step="1"
              :disabled="props.actionEditor.busy"
              data-cy="recording-action-value"
              @input="emit('update-action-draft-value', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label v-if="props.actionEditor.type === 'setChecked'" class="toggle-row">
            <input
              type="checkbox"
              :checked="props.actionEditor.checked"
              :disabled="props.actionEditor.busy"
              data-cy="recording-action-checked"
              @change="
                emit('update-action-draft-checked', ($event.target as HTMLInputElement).checked)
              "
            />
            <span>目标控件应为勾选状态</span>
          </label>
        </div>
        <p v-if="props.actionEditor.type === 'fill'" class="privacy-hint">
          输入值会写入生成代码；密码、验证码等敏感信息请继续使用人工操作步骤。
        </p>
        <div class="editor-actions">
          <button
            type="button"
            class="primary-button"
            :disabled="!props.actionEditor.canSubmit"
            data-cy="recording-action-submit"
            @click="emit('submit-action-insert')"
          >
            {{ props.actionEditor.busy ? "新增中…" : "新增节点" }}
          </button>
          <button
            type="button"
            class="secondary-button"
            :disabled="props.actionEditor.busy"
            data-cy="recording-action-cancel"
            @click="emit('cancel-action-insert')"
          >
            取消
          </button>
        </div>
      </section>

      <section
        v-if="
          props.actionDelete.confirmingActionId &&
          props.action?.id === props.actionDelete.confirmingActionId
        "
        class="editor-section delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="recording-action-delete-title"
        :data-action-id="props.actionDelete.confirmingActionId"
        data-cy="recording-action-delete-dialog"
      >
        <div class="editor-heading">
          <div>
            <span>危险操作</span>
            <h5 id="recording-action-delete-title">确认删除步骤 {{ props.action.order }}？</h5>
          </div>
          <small>{{ ACTION_LABELS[props.action.type] }}</small>
        </div>
        <code>{{ props.action.selector || props.action.id }}</code>
        <p>删除成功后会重新排列步骤编号，并清除当前生成代码。</p>
        <div class="editor-actions">
          <button
            type="button"
            class="danger-button"
            :disabled="props.actionDelete.busy"
            data-cy="recording-action-delete-confirm"
            @click="emit('confirm-action-delete')"
          >
            {{ props.actionDelete.busy ? "删除中…" : "确认删除" }}
          </button>
          <button
            type="button"
            class="secondary-button"
            :disabled="props.actionDelete.busy"
            data-cy="recording-action-delete-cancel"
            @click="emit('cancel-action-delete')"
          >
            取消
          </button>
        </div>
      </section>

      <section
        v-if="props.loopEditor.visible"
        class="editor-section loop-editor"
        aria-labelledby="loop-editor-title"
        data-cy="recording-loop-editor"
      >
        <div class="editor-heading">
          <div>
            <span>循环编排</span>
            <h5 id="loop-editor-title">分页列表循环</h5>
          </div>
          <small>最多 1000 页</small>
        </div>
        <p>选择连续范围；范围最后一步作为 Next，每页列表项数量在运行时重新计算。</p>

        <div class="loop-fields">
          <label>
            <span>循环起点</span>
            <select
              :value="props.loopEditor.startActionId"
              :disabled="!props.loopEditor.canEdit"
              data-cy="recording-loop-start"
              @change="emitSelectValue($event, 'update-loop-start-action-id')"
            >
              <option value="">选择第一步</option>
              <option
                v-for="option in props.loopEditor.startOptions"
                :key="option.id"
                :value="option.id"
              >
                {{ actionOptionLabel(option) }}
              </option>
            </select>
          </label>
          <label>
            <span>Next（范围末步）</span>
            <select
              :value="props.loopEditor.nextActionId"
              :disabled="!props.loopEditor.canEdit || !props.loopEditor.startActionId"
              data-cy="recording-loop-next"
              @change="emitSelectValue($event, 'update-loop-next-action-id')"
            >
              <option value="">选择下一页点击</option>
              <option
                v-for="option in props.loopEditor.nextOptions"
                :key="option.id"
                :value="option.id"
              >
                {{ actionOptionLabel(option) }}
              </option>
            </select>
          </label>
          <label>
            <span>列表入口点击</span>
            <select
              :value="props.loopEditor.entryActionId"
              :disabled="!props.loopEditor.canEdit || props.loopEditor.entryOptions.length === 0"
              data-cy="recording-loop-entry"
              @change="emitSelectValue($event, 'update-loop-entry-action-id')"
            >
              <option value="">选择用于示范第一项的点击</option>
              <option
                v-for="option in props.loopEditor.entryOptions"
                :key="option.id"
                :value="option.id"
              >
                {{ actionOptionLabel(option) }}
              </option>
            </select>
          </label>
          <label>
            <span>最大页数</span>
            <input
              :value="props.loopEditor.maxPages"
              type="number"
              min="1"
              max="1000"
              step="1"
              :disabled="!props.loopEditor.canEdit"
              data-cy="recording-loop-max-pages"
              @input="handleMaxPages"
            />
          </label>
        </div>

        <div class="loop-preview-row">
          <span v-if="props.loopEditor.selectedActions.length">
            已选择 {{ props.loopEditor.selectedActions.length }} 步：步骤
            {{ props.loopEditor.selectedActions[0]?.order }}–{{
              props.loopEditor.selectedActions.at(-1)?.order
            }}
          </span>
          <span v-else>先选择起点、Next 和列表入口。</span>
          <button
            type="button"
            class="secondary-button"
            :disabled="!props.loopEditor.canPreview"
            data-cy="recording-loop-analyze"
            @click="emit('preview-loop')"
          >
            {{ props.loopEditor.busy ? "分析中…" : "分析列表结构" }}
          </button>
        </div>

        <fieldset v-if="props.loopEditor.candidates.length" class="candidate-list">
          <legend>选择要逐项遍历的结构</legend>
          <label
            v-for="candidate in props.loopEditor.candidates"
            :key="candidate.candidateIndex"
            class="candidate-option"
          >
            <input
              type="radio"
              name="recording-loop-candidate"
              :value="candidate.candidateIndex"
              :checked="props.loopEditor.selectedCandidateIndex === candidate.candidateIndex"
              :disabled="!props.loopEditor.canEdit"
              data-cy="recording-loop-candidate"
              @change="handleCandidate(candidate.candidateIndex)"
            />
            <span>
              <strong>录制时第 {{ candidate.sourceOrdinal }} 项</strong>
              <code>{{ candidate.listSelector }}</code>
            </span>
          </label>
          <button
            type="button"
            class="primary-button"
            :disabled="!props.loopEditor.canCreate"
            data-cy="recording-loop-create"
            @click="emit('create-loop')"
          >
            创建分页循环
          </button>
        </fieldset>
      </section>

      <section
        v-if="props.manualEditor.visible"
        class="editor-section manual-editor"
        aria-labelledby="manual-editor-title"
        data-cy="recording-manual-editor"
      >
        <div class="editor-heading">
          <div>
            <span>人工编排</span>
            <h5 id="manual-editor-title">人工操作 checkpoint</h5>
          </div>
          <small>{{ props.manualEditor.selectedCount }} 项</small>
        </div>
        <p>{{ props.manualEditor.selectionHint }}</p>
        <input
          :value="props.manualEditor.title"
          type="text"
          maxlength="120"
          autocomplete="off"
          placeholder="可选标题，例如：请完成登录"
          :disabled="props.manualEditor.titleDisabled"
          data-cy="recording-manual-title"
          @input="emit('update-manual-title', ($event.target as HTMLInputElement).value)"
        />
        <div class="editor-actions manual-actions">
          <button
            type="button"
            class="primary-button amber"
            :disabled="!props.manualEditor.canConvertControls"
            data-cy="recording-manual-controls"
            @click="emit('create-manual-step', 'controls')"
          >
            转为人工控件组
          </button>
          <button
            type="button"
            class="secondary-button amber"
            :disabled="!props.manualEditor.canConvertCustom"
            data-cy="recording-manual-custom"
            @click="emit('create-manual-step', 'custom')"
          >
            合并为自定义下拉
          </button>
          <button
            v-if="props.manualEditor.selectedCount"
            type="button"
            class="secondary-button"
            :disabled="props.manualEditor.clearDisabled"
            data-cy="recording-manual-clear"
            @click="emit('clear-manual-selection')"
          >
            清除选择
          </button>
        </div>
      </section>
    </div>

    <footer>连接顺序由录制动作决定；当前仅支持单层分页循环，不开放任意改线或条件分支。</footer>
  </aside>
</template>

<style scoped>
.inspector-card {
  min-width: 0;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.inspector-card > header {
  min-height: 62px;
  padding: 0.8rem 0.9rem;
  border-bottom: 1px solid #eef2f7;
}

.inspector-card > header span {
  color: #4f46e5;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.inspector-card > header h4 {
  margin: 0.15rem 0 0;
  color: #1e293b;
  font-size: 0.9rem;
}

.inspector-body {
  display: grid;
  align-content: start;
  gap: 0.8rem;
  min-height: 560px;
  max-height: 560px;
  padding: 0.9rem;
  overflow: auto;
}

.inspector-section,
.editor-section {
  display: grid;
  align-content: start;
  gap: 0.75rem;
}

.node-type {
  justify-self: start;
  padding: 0.25rem 0.5rem;
  color: #3730a3;
  background: #eef2ff;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 800;
}

.node-type.loop,
.node-type.manualStep {
  color: #6d28d9;
  background: #f3e8ff;
}

.inspector-section h5,
.editor-section h5 {
  margin: 0;
  color: #0f172a;
  font-size: 0.84rem;
}

.inspector-section dl {
  display: grid;
  gap: 0.1rem;
  margin: 0;
  border: 1px solid #eef2f7;
  border-radius: 8px;
}

.inspector-section dl div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0.55rem 0.65rem;
  border-bottom: 1px solid #eef2f7;
}

.inspector-section dl div:last-child {
  border-bottom: 0;
}

.inspector-section dt {
  color: #64748b;
  font-size: 0.64rem;
}

.inspector-section dd {
  overflow: hidden;
  margin: 0;
  color: #334155;
  font-size: 0.66rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-field {
  display: grid;
  gap: 0.35rem;
}

.code-field > span {
  color: #64748b;
  font-size: 0.62rem;
  font-weight: 700;
}

.code-field code {
  padding: 0.55rem;
  overflow-wrap: anywhere;
  color: #334155;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  font-size: 0.61rem;
  line-height: 1.45;
}

.manual-targets {
  display: grid;
  gap: 0.35rem;
  padding: 0.65rem;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}

.manual-targets strong {
  font-size: 0.7rem;
}

.manual-targets span {
  font-size: 0.62rem;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem;
  color: #334155;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  font-size: 0.66rem;
  font-weight: 650;
}

.toggle-row input {
  accent-color: #4f46e5;
}

.inspector-hint,
.editor-section > p {
  margin: 0;
  color: #64748b;
  font-size: 0.65rem;
  line-height: 1.5;
}

.inspector-empty {
  padding: 0.7rem;
  color: #64748b;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  text-align: center;
}

.inspector-empty strong {
  color: #334155;
  font-size: 0.75rem;
}

.inspector-empty p {
  margin: 0;
  font-size: 0.64rem;
  line-height: 1.5;
}

.editor-section {
  padding: 0.75rem;
  border: 1px solid #c7d2fe;
  border-radius: 9px;
}

.loop-editor {
  background: #f8faff;
}

.action-mutation-entry,
.action-editor {
  background: #f8faff;
}

.delete-dialog {
  color: #991b1b;
  background: #fff7f7;
  border-color: #fecaca;
}

.delete-dialog code {
  padding: 0.55rem;
  overflow-wrap: anywhere;
  color: #991b1b;
  background: #ffffff;
  border: 1px solid #fecaca;
  border-radius: 7px;
  font-size: 0.61rem;
}

.mutation-lock-hint {
  color: #b45309 !important;
}

.privacy-hint {
  padding: 0.5rem;
  color: #92400e !important;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 7px;
}

.manual-editor {
  background: #fffbeb;
  border-color: #fde68a;
}

.editor-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.55rem;
}

.editor-heading > div {
  display: grid;
  gap: 0.12rem;
}

.editor-heading span {
  color: #4f46e5;
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.manual-editor .editor-heading span {
  color: #b45309;
}

.editor-heading small {
  color: #64748b;
  font-size: 0.61rem;
  font-weight: 700;
}

.loop-fields,
.action-editor-fields {
  display: grid;
  gap: 0.55rem;
}

.loop-fields label > span,
.action-editor-fields label > span {
  display: block;
  margin-bottom: 0.25rem;
  color: #475569;
  font-size: 0.62rem;
  font-weight: 700;
}

.loop-fields select,
.loop-fields input,
.action-editor-fields select,
.action-editor-fields input,
.manual-editor > input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 0.55rem;
  color: #334155;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  outline: none;
  font-size: 0.67rem;
}

.manual-editor > input {
  color: #78350f;
  border-color: #fcd34d;
}

.loop-preview-row {
  display: grid;
  gap: 0.5rem;
}

.loop-preview-row > span {
  color: #6366f1;
  font-size: 0.62rem;
  font-weight: 700;
}

.candidate-list {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0.6rem;
  border: 1px solid #e0e7ff;
  border-radius: 8px;
}

.candidate-list legend {
  padding: 0 0.25rem;
  color: #475569;
  font-size: 0.62rem;
  font-weight: 700;
}

.candidate-option {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.42rem;
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
  font-size: 0.65rem;
}

.candidate-option code {
  margin-top: 0.2rem;
  overflow: hidden;
  color: #64748b;
  font-size: 0.6rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.editor-actions button,
.loop-preview-row button,
.candidate-list button {
  min-height: 32px;
  padding: 0.4rem 0.65rem;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.66rem;
  font-weight: 750;
}

.primary-button {
  color: #ffffff;
  background: #4f46e5;
  border: 1px solid #4f46e5;
}

.primary-button.amber {
  background: #d97706;
  border-color: #d97706;
}

.secondary-button {
  color: #4338ca;
  background: #ffffff;
  border: 1px solid #c7d2fe;
}

.secondary-button.amber {
  color: #92400e;
  background: #fef3c7;
  border-color: #f59e0b;
}

.danger-button {
  color: #b91c1c;
  background: #ffffff;
  border: 1px solid #fecaca;
}

.editor-actions button:disabled,
.loop-preview-row button:disabled,
.candidate-list button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.nested-loop-details {
  padding: 0.6rem;
  background: #f5f3ff;
  border: 1px solid #ddd6fe;
  border-radius: 8px;
}

.nested-loop-details summary {
  color: #5b21b6;
  cursor: pointer;
  font-size: 0.67rem;
  font-weight: 800;
}

.nested-loop-details ol {
  display: grid;
  gap: 0.3rem;
  margin: 0.55rem 0 0;
  padding: 0;
  list-style: none;
}

.nested-loop-details li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.4rem;
  padding: 0.36rem 0.42rem;
  color: #475569;
  background: #ffffff;
  border-radius: 6px;
  font-size: 0.61rem;
}

.nested-loop-details li strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nested-loop-details li small {
  color: #6366f1;
}

.inspector-card footer {
  padding: 0.65rem 0.8rem;
  color: #64748b;
  background: #f8fafc;
  border-top: 1px solid #eef2f7;
  font-size: 0.64rem;
  line-height: 1.5;
}
</style>
