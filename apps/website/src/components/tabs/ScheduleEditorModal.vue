<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  BrowserTab,
  ScheduleRecurrenceType,
  ScriptItem,
  ScriptParamValue,
  TabSchedule,
  TabScheduleInput,
} from "../../types/automation";
import { parseJSDocParams } from "../../utils/scriptParams";

const props = defineProps<{
  tab: BrowserTab;
  schedule: TabSchedule | null;
  scripts: readonly ScriptItem[];
  defaultScript: string;
  saving: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  save: [schedule: TabScheduleInput];
  delete: [schedule: TabSchedule];
}>();

const createForm = (schedule: TabSchedule | null): TabScheduleInput => ({
  id: schedule?.id,
  targetUrl: schedule?.targetUrl || props.tab.url,
  targetTitle: schedule?.targetTitle || props.tab.title || props.tab.url,
  scriptFilename:
    schedule?.scriptFilename || props.defaultScript || props.scripts[0]?.filename || "",
  params: { ...schedule?.params },
  recurrenceType: schedule?.recurrenceType || "hourly",
  intervalValue: schedule?.intervalValue || 1,
  runAt: schedule?.runAt || "09:00",
  enabled: schedule?.enabled ?? true,
});

const form = ref<TabScheduleInput>(createForm(props.schedule));

const isRunning = computed(() => props.schedule?.status === "running");
const usesInterval = computed(() =>
  ["hourly", "daily", "weekly"].includes(form.value.recurrenceType),
);
const intervalUnit = computed(() => {
  if (form.value.recurrenceType === "hourly") return "小时";
  if (form.value.recurrenceType === "daily") return "天";
  return "周";
});
const selectedScript = computed(() =>
  props.scripts.find((script) => script.filename === form.value.scriptFilename),
);
const paramFields = computed(() =>
  selectedScript.value?.content ? parseJSDocParams(selectedScript.value.content) : [],
);

const modalBody = ref<HTMLFieldSetElement | null>(null);
const canScrollDown = ref(false);
let bodyResizeObserver: ResizeObserver | undefined;

const updateScrollState = () => {
  const body = modalBody.value;
  if (!body) return;
  const remainingScroll = body.scrollHeight - body.scrollTop - body.clientHeight;
  canScrollDown.value = remainingScroll > 4;
};

const refreshScrollState = () => {
  void nextTick(updateScrollState);
};

const scrollForMore = () => {
  const body = modalBody.value;
  if (!body) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  body.scrollBy({
    top: Math.max(160, Math.floor(body.clientHeight * 0.65)),
    behavior: reduceMotion ? "auto" : "smooth",
  });
};

watch([() => form.value.recurrenceType, paramFields, isRunning], refreshScrollState, {
  flush: "post",
});

onMounted(() => {
  refreshScrollState();
  window.addEventListener("resize", refreshScrollState);
  if (typeof ResizeObserver !== "undefined" && modalBody.value) {
    bodyResizeObserver = new ResizeObserver(refreshScrollState);
    bodyResizeObserver.observe(modalBody.value);
    for (const child of modalBody.value.children) bodyResizeObserver.observe(child);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", refreshScrollState);
  bodyResizeObserver?.disconnect();
});

watch(
  () => props.schedule?.id,
  (scheduleId, previousScheduleId) => {
    if (scheduleId && scheduleId !== previousScheduleId) {
      form.value = createForm(props.schedule);
    }
  },
);

watch(
  () => form.value.scriptFilename,
  () => {
    const nextParams: Record<string, ScriptParamValue> = {};
    for (const field of paramFields.value) {
      nextParams[field.name] = Object.prototype.hasOwnProperty.call(form.value.params, field.name)
        ? form.value.params[field.name]
        : field.default;
    }
    form.value.params = nextParams;
  },
  { immediate: true },
);

const updateParam = (name: string, value: ScriptParamValue) => {
  form.value.params = { ...form.value.params, [name]: value };
};

const updateRecurrence = (event: Event) => {
  form.value.recurrenceType = (event.target as HTMLSelectElement).value as ScheduleRecurrenceType;
};

const submit = () => {
  if (!form.value.scriptFilename || props.saving || isRunning.value) return;
  emit("save", {
    ...form.value,
    intervalValue: Math.max(1, Math.trunc(Number(form.value.intervalValue) || 1)),
    params: { ...form.value.params },
  });
};
</script>

<template>
  <div class="modal-overlay" @click.self="!props.saving && emit('cancel')">
    <div class="schedule-modal">
      <div class="modal-header">
        <div class="header-icon">🔁</div>
        <div class="header-copy">
          <h3>{{ props.schedule ? "编辑循环计划" : "创建循环计划" }}</h3>
          <p>每个目标 URL 只保留一个计划，到期时自动运行最新脚本内容</p>
        </div>
        <button class="close-btn" :disabled="props.saving" @click="emit('cancel')">✕</button>
      </div>

      <div v-if="isRunning" class="running-notice">
        <strong>⏳ 正在执行</strong>
        <span>本轮结束前不能修改或删除这个计划。</span>
      </div>

      <fieldset
        ref="modalBody"
        class="modal-body"
        :disabled="props.saving || isRunning"
        @scroll.passive="updateScrollState"
      >
        <section class="form-section">
          <div class="section-heading">
            <span>目标与脚本</span>
            <small>目标丢失后会按此完整 URL 新开标签页</small>
          </div>

          <label class="field full-width">
            <span class="field-label">目标页面</span>
            <input :value="form.targetTitle" type="text" readonly />
            <code>{{ form.targetUrl }}</code>
          </label>

          <label class="field full-width">
            <span class="field-label">执行脚本 <b>*</b></span>
            <select v-model="form.scriptFilename">
              <option value="" disabled>请选择脚本</option>
              <option
                v-for="script in props.scripts"
                :key="script.filename"
                :value="script.filename"
              >
                {{ script.filename }}
              </option>
            </select>
            <small>每轮执行时重新读取磁盘文件，因此脚本修改会在下一轮生效。</small>
          </label>
        </section>

        <section class="form-section">
          <div class="section-heading">
            <span>循环规则</span>
            <small>服务重启后从重启时刻重新计算，不补跑历史任务</small>
          </div>

          <div class="two-columns">
            <label class="field">
              <span class="field-label">循环类型</span>
              <select :value="form.recurrenceType" @change="updateRecurrence">
                <option value="hourly">小时</option>
                <option value="daily">天</option>
                <option value="weekly">周</option>
                <option value="weekdays">工作日（周一至周五）</option>
                <option value="weekends">周末（周六、周日）</option>
              </select>
            </label>

            <label v-if="usesInterval" class="field">
              <span class="field-label">每隔多久</span>
              <div class="input-with-unit">
                <input v-model.number="form.intervalValue" type="number" min="1" max="999" />
                <span>{{ intervalUnit }}</span>
              </div>
            </label>

            <label v-else class="field">
              <span class="field-label">执行时间（北京时间）</span>
              <input v-model="form.runAt" type="time" max="23:54" required />
              <small>最晚 23:54，避免 1–5 分钟随机启动跨到下一天。</small>
            </label>
          </div>

          <label class="enable-card">
            <div>
              <strong>{{ form.enabled ? "计划已启用" : "计划已暂停" }}</strong>
              <span>{{ form.enabled ? "系统会自动计算下一次执行" : "保存配置但不自动运行" }}</span>
            </div>
            <input v-model="form.enabled" type="checkbox" />
            <span class="switch"></span>
          </label>
        </section>

        <section class="form-section">
          <div class="section-heading">
            <span>脚本参数</span>
            <small>来自脚本 JSDoc 参数声明</small>
          </div>

          <div v-if="paramFields.length" class="params-grid">
            <label v-for="field in paramFields" :key="field.name" class="field param-field">
              <span class="field-label">
                {{ field.label }}
                <code>{{ field.name }}</code>
              </span>

              <input
                v-if="field.type === 'string'"
                :value="String(form.params[field.name] ?? '')"
                type="text"
                @input="updateParam(field.name, ($event.target as HTMLInputElement).value)"
              />
              <input
                v-else-if="field.type === 'number'"
                :value="Number(form.params[field.name] ?? 0)"
                type="number"
                @input="updateParam(field.name, Number(($event.target as HTMLInputElement).value))"
              />
              <label v-else-if="field.type === 'boolean'" class="boolean-param">
                <input
                  type="checkbox"
                  :checked="Boolean(form.params[field.name])"
                  @change="updateParam(field.name, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ form.params[field.name] ? "已启用" : "已停用" }}</span>
              </label>
              <select
                v-else
                :value="String(form.params[field.name] ?? '')"
                @change="updateParam(field.name, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="(label, value) in field.options" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </label>
          </div>
          <div v-else class="empty-params">该脚本没有声明可配置参数。</div>
        </section>

        <section class="pace-card">
          <div class="pace-icon">🧑‍💻</div>
          <div>
            <strong>模仿人工操作：系统固定启用</strong>
            <p>点击前后随机等待 0.8–2.5 秒，输入逐字间隔 50–160 毫秒，滚动距离和停顿随机。</p>
            <small>这些参数由系统统一控制，用户不能调整。</small>
          </div>
        </section>
      </fieldset>

      <div class="modal-footer">
        <button
          v-if="props.schedule"
          class="delete-btn"
          :disabled="props.saving || isRunning"
          @click="emit('delete', props.schedule)"
        >
          删除计划
        </button>
        <button
          v-if="canScrollDown"
          type="button"
          class="scroll-hint-btn"
          aria-label="向下滚动查看更多计划设置"
          @click="scrollForMore"
        >
          <span aria-hidden="true">↓</span>
          向下滚动查看更多
        </button>
        <span class="footer-spacer"></span>
        <button class="cancel-btn" :disabled="props.saving" @click="emit('cancel')">取消</button>
        <button
          class="save-btn"
          :disabled="props.saving || isRunning || !form.scriptFilename"
          @click="submit"
        >
          {{ props.saving ? "保存中..." : props.schedule ? "保存修改" : "创建计划" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(15, 23, 42, 0.68);
  backdrop-filter: blur(10px);
}

.schedule-modal {
  width: min(720px, 100%);
  max-height: calc(100vh - 2rem);
  max-height: calc(100dvh - 2rem);
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  box-shadow: 0 28px 70px rgba(15, 23, 42, 0.35);
}

.modal-header,
.running-notice,
.modal-footer {
  flex: 0 0 auto;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 1.2rem 1.4rem;
  color: #fff;
  background: linear-gradient(135deg, #0f766e, #0d9488 55%, #14b8a6);
}

.header-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.16);
  font-size: 1.25rem;
}

.header-copy {
  flex: 1;
  min-width: 0;
}

.header-copy h3 {
  margin: 0;
  font-size: 1.15rem;
}

.header-copy p {
  margin: 0.2rem 0 0;
  color: rgba(255, 255, 255, 0.82);
  font-size: 0.78rem;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 9px;
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  cursor: pointer;
}

.running-notice {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1.4rem;
  color: #1d4ed8;
  background: #eff6ff;
  border-bottom: 1px solid #bfdbfe;
  font-size: 0.82rem;
}

.modal-body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 1.25rem 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: #94a3b8 #e2e8f0;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  border: 0;
  background: #f8fafc;
}

.modal-body:disabled {
  opacity: 0.72;
}

.modal-body::-webkit-scrollbar {
  width: 10px;
}

.modal-body::-webkit-scrollbar-track {
  margin-block: 0.75rem;
  border-radius: 999px;
  background: #e2e8f0;
}

.modal-body::-webkit-scrollbar-thumb {
  border: 2px solid #e2e8f0;
  border-radius: 999px;
  background: #94a3b8;
}

.modal-body::-webkit-scrollbar-thumb:hover {
  background: #64748b;
}

.form-section {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}

.section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid #f1f5f9;
}

.section-heading > span {
  color: #0f172a;
  font-size: 0.9rem;
  font-weight: 750;
}

.section-heading small,
.field small {
  color: #64748b;
  font-size: 0.72rem;
}

.two-columns,
.params-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.85rem;
}

.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.full-width {
  width: 100%;
}

.field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  color: #334155;
  font-size: 0.8rem;
  font-weight: 650;
}

.field-label b {
  color: #ef4444;
}

.field input,
.field select {
  width: 100%;
  box-sizing: border-box;
  padding: 0.62rem 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  color: #0f172a;
  background: #fff;
  font-size: 0.84rem;
  outline: none;
}

.field input:focus,
.field select:focus {
  border-color: #14b8a6;
  box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.14);
}

.field input[readonly] {
  color: #475569;
  background: #f8fafc;
}

.field > code,
.field-label code {
  overflow: hidden;
  color: #0f766e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.input-with-unit {
  display: flex;
  align-items: stretch;
}

.input-with-unit input {
  border-radius: 8px 0 0 8px;
}

.input-with-unit span {
  min-width: 3rem;
  display: grid;
  place-items: center;
  border: 1px solid #cbd5e1;
  border-left: 0;
  border-radius: 0 8px 8px 0;
  color: #475569;
  background: #f1f5f9;
  font-size: 0.8rem;
}

.enable-card,
.boolean-param {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.enable-card {
  gap: 0.8rem;
  padding: 0.75rem;
  border: 1px solid #ccfbf1;
  border-radius: 10px;
  background: #f0fdfa;
}

.enable-card > div {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.enable-card strong {
  color: #115e59;
  font-size: 0.82rem;
}

.enable-card div span {
  color: #64748b;
  font-size: 0.72rem;
}

.enable-card > input {
  position: absolute;
  opacity: 0;
}

.switch {
  width: 42px;
  height: 24px;
  position: relative;
  border-radius: 999px;
  background: #cbd5e1;
  transition: 0.2s;
}

.switch::after {
  content: "";
  width: 18px;
  height: 18px;
  position: absolute;
  top: 3px;
  left: 3px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
  transition: 0.2s;
}

.enable-card > input:checked + .switch {
  background: #14b8a6;
}

.enable-card > input:checked + .switch::after {
  transform: translateX(18px);
}

.param-field {
  padding: 0.7rem;
  border: 1px solid #e2e8f0;
  border-radius: 9px;
  background: #f8fafc;
}

.boolean-param {
  gap: 0.5rem;
  min-height: 37px;
  color: #475569;
  font-size: 0.82rem;
}

.empty-params {
  padding: 0.85rem;
  border-radius: 9px;
  color: #64748b;
  background: #f8fafc;
  text-align: center;
  font-size: 0.8rem;
}

.pace-card {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.9rem 1rem;
  border: 1px solid #ddd6fe;
  border-radius: 12px;
  background: linear-gradient(135deg, #faf5ff, #eef2ff);
}

.pace-icon {
  font-size: 1.35rem;
}

.pace-card strong {
  color: #5b21b6;
  font-size: 0.84rem;
}

.pace-card p {
  margin: 0.2rem 0;
  color: #475569;
  font-size: 0.76rem;
  line-height: 1.45;
}

.pace-card small {
  color: #7c3aed;
  font-size: 0.7rem;
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 1rem 1.4rem;
  border-top: 1px solid #e2e8f0;
  background: #fff;
}

.footer-spacer {
  flex: 1;
}

.modal-footer button {
  padding: 0.55rem 1rem;
  border-radius: 9px;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}

.scroll-hint-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid #99f6e4;
  color: #0f766e;
  white-space: nowrap;
  background: #f0fdfa;
  box-shadow: 0 2px 8px rgba(13, 148, 136, 0.12);
}

.scroll-hint-btn:hover {
  border-color: #5eead4;
  background: #ccfbf1;
}

.scroll-hint-btn span {
  line-height: 1;
  animation: scroll-hint-bounce 1.4s ease-in-out infinite;
}

@keyframes scroll-hint-bounce {
  0%,
  100% {
    transform: translateY(-1px);
  }
  50% {
    transform: translateY(2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .scroll-hint-btn span {
    animation: none;
  }
}

.modal-footer button:disabled,
.close-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delete-btn {
  border: 1px solid #fecaca;
  color: #dc2626;
  background: #fff;
}

.cancel-btn {
  border: 1px solid #cbd5e1;
  color: #475569;
  background: #fff;
}

.save-btn {
  border: 1px solid #0d9488;
  color: #fff;
  background: linear-gradient(135deg, #14b8a6, #0d9488);
  box-shadow: 0 4px 12px rgba(13, 148, 136, 0.25);
}

@media (max-width: 640px) {
  .two-columns,
  .params-grid {
    grid-template-columns: 1fr;
  }

  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .modal-footer {
    flex-wrap: wrap;
  }
}
</style>
