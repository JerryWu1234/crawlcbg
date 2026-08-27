<script setup lang="ts">
import { ref, watch } from "vue";
import type {
  ManualExecutionMode,
  ScriptParamField,
  ScriptParamValues,
} from "../../types/automation";

const props = defineProps<{
  fields: readonly ScriptParamField[];
  targetTabIndex: number;
  targetLabel: string;
  scriptName: string;
  formValues: Readonly<ScriptParamValues>;
}>();

const emit = defineEmits<{
  "update:form-values": [values: ScriptParamValues];
  cancel: [];
  confirm: [values: ScriptParamValues, executionMode: ManualExecutionMode];
}>();

const localValues = ref<ScriptParamValues>({ ...props.formValues });
const localExecutionMode = ref<ManualExecutionMode>("visible");
let isSyncingFromProps = false;

const hasSameValues = (left: Readonly<ScriptParamValues>, right: Readonly<ScriptParamValues>) => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(left[key], right[key]))
  );
};

watch(
  () => props.formValues,
  (values) => {
    if (hasSameValues(values, localValues.value)) return;
    isSyncingFromProps = true;
    localValues.value = { ...values };
    isSyncingFromProps = false;
  },
  { deep: true, flush: "sync" },
);

watch(
  localValues,
  (values) => {
    if (!isSyncingFromProps) {
      emit("update:form-values", { ...values });
    }
  },
  { deep: true, flush: "sync" },
);

const decrementValue = (name: string) => {
  const currentValue = (localValues.value[name] || 0) as number;
  localValues.value[name] = Math.max(0, currentValue - 1);
};

const incrementValue = (name: string) => {
  const currentValue = (localValues.value[name] || 0) as number;
  localValues.value[name] = currentValue + 1;
};
</script>

<template>
  <div class="modal-overlay modal-backdrop-glass" @click.self="emit('cancel')">
    <div class="param-modal-card fancy-param-modal">
      <div class="modal-accent-line"></div>
      <div class="modal-header fancy-header">
        <div class="modal-title-group">
          <div class="header-icon-wrap">⚙️</div>
          <div>
            <h3 class="modal-main-title">运行配置与确认</h3>
            <p class="modal-sub-title">选择运行方式，并确认脚本参数</p>
          </div>
        </div>
        <button class="btn-close-modal-fancy" @click="emit('cancel')">✕</button>
      </div>

      <div class="modal-body param-modal-body">
        <div class="param-dialog-tip-card">
          <div class="tip-icon">⚡</div>
          <div class="tip-content">
            即将在
            <span class="tab-badge">
              {{
                props.targetTabIndex >= 0 ? `Tab #${props.targetTabIndex + 1}` : props.targetLabel
              }}
            </span>
            运行脚本
            <span class="script-badge-code">📄 {{ props.scriptName }}</span>
          </div>
        </div>

        <div class="params-form-grid modal-params-grid-fancy">
          <div class="param-form-item-fancy">
            <div class="param-label-group">
              <span class="param-title-text">运行方式</span>
              <span class="param-code-tag">默认可视</span>
            </div>
            <div class="custom-select-wrap">
              <select v-model="localExecutionMode" class="fancy-select">
                <option value="visible">可视运行 · 使用当前页签</option>
                <option value="background">后台运行 · 独立普通窗口最小化</option>
              </select>
              <span class="select-chevron">▾</span>
            </div>
            <p class="modal-sub-title">
              后台运行会复用当前 Chrome 登录状态，任务完成或取消后自动关闭独立窗口。
            </p>
          </div>

          <div v-if="props.fields.length === 0" class="param-form-item-fancy">
            <div class="param-label-group">
              <span class="param-title-text">脚本参数</span>
              <span class="param-code-tag">无需配置</span>
            </div>
            <p class="modal-sub-title">这个脚本没有声明运行参数，可直接启动。</p>
          </div>

          <div v-for="field in props.fields" :key="field.name" class="param-form-item-fancy">
            <div class="param-label-group">
              <span class="param-title-text">{{ field.label }}</span>
              <span class="param-code-tag">{{ field.name }}</span>
            </div>

            <div v-if="field.type === 'string'" class="input-field-wrap">
              <input
                v-model="localValues[field.name]"
                type="text"
                class="fancy-input"
                :placeholder="`请输入 ${field.label}`"
              />
            </div>

            <div v-if="field.type === 'number'" class="number-stepper-wrap">
              <button type="button" class="stepper-btn minus" @click="decrementValue(field.name)">
                -
              </button>
              <input v-model.number="localValues[field.name]" type="number" class="stepper-input" />
              <button type="button" class="stepper-btn plus" @click="incrementValue(field.name)">
                +
              </button>
            </div>

            <div v-if="field.type === 'boolean'" class="switch-field-wrap">
              <label class="param-switch-card" :class="{ checked: localValues[field.name] }">
                <span class="switch-state-text">{{
                  localValues[field.name] ? "🟢 已启用" : "⚪ 已停用"
                }}</span>
                <input v-model="localValues[field.name]" type="checkbox" class="real-checkbox" />
                <span class="modern-switch-slider"></span>
              </label>
            </div>

            <div v-if="field.type === 'select'" class="custom-select-wrap">
              <select v-model="localValues[field.name]" class="fancy-select">
                <option
                  v-for="(optionLabel, optionValue) in field.options"
                  :key="optionValue"
                  :value="optionValue"
                >
                  {{ optionLabel }}
                </option>
              </select>
              <span class="select-chevron">▾</span>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer fancy-footer">
        <button class="btn-cancel-glass" @click="emit('cancel')">取消</button>
        <button
          class="btn-glow-confirm"
          @click="emit('confirm', { ...localValues }, localExecutionMode)"
        >
          <span>🚀 确定并启动运行</span>
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

.modal-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-footer {
  padding: 0.85rem 1.25rem;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.modal-backdrop-glass {
  background: rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeInModal 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes fadeInModal {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.fancy-param-modal {
  background: #ffffff;
  border-radius: 20px;
  width: 92%;
  max-width: 580px;
  box-shadow:
    0 25px 50px -12px rgba(15, 23, 42, 0.25),
    0 0 0 1px rgba(226, 232, 240, 0.8);
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

.modal-accent-line {
  height: 4px;
  background: linear-gradient(90deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
  width: 100%;
}

.fancy-header {
  padding: 1.25rem 1.75rem 1rem 1.75rem;
  border-bottom: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title-group {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.header-icon-wrap {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
  border: 1px solid #c7d2fe;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.35rem;
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.15);
}

.modal-main-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.modal-sub-title {
  font-size: 0.78rem;
  color: #64748b;
  margin: 0.15rem 0 0 0;
}

.btn-close-modal-fancy {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #64748b;
  font-size: 0.95rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.btn-close-modal-fancy:hover {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #ef4444;
}

.param-dialog-tip-card {
  background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
  border: 1px solid #bbf7d0;
  border-radius: 12px;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.tip-icon {
  font-size: 1.2rem;
  flex-shrink: 0;
}

.tip-content {
  font-size: 0.85rem;
  color: #15803d;
  line-height: 1.45;
}

.tab-badge {
  font-weight: 700;
  color: #166534;
  background: rgba(255, 255, 255, 0.8);
  padding: 0.15rem 0.45rem;
  border-radius: 6px;
  border: 1px solid #a7f3d0;
}

.script-badge-code {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  color: #047857;
  background: rgba(255, 255, 255, 0.8);
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #a7f3d0;
}

.modal-params-grid-fancy {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
  max-height: 380px;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.param-form-item-fancy {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
}

.param-form-item-fancy:hover {
  border-color: #cbd5e1;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.param-label-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.param-title-text {
  font-size: 0.85rem;
  font-weight: 600;
  color: #1e293b;
}

.param-code-tag {
  font-family: Consolas, Monaco, monospace;
  font-size: 0.72rem;
  color: #6366f1;
  background-color: #e0e7ff;
  padding: 0.12rem 0.4rem;
  border-radius: 5px;
  border: 1px solid #c7d2fe;
}

.fancy-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.88rem;
  color: #0f172a;
  background: #f8fafc;
  outline: none;
  box-sizing: border-box;
  transition: all 0.15s ease;
}

.fancy-input:focus {
  background: #ffffff;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.number-stepper-wrap {
  display: flex;
  align-items: center;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
  transition: all 0.15s ease;
}

.number-stepper-wrap:focus-within {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  background: #ffffff;
}

.stepper-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: #f1f5f9;
  color: #475569;
  font-size: 1.1rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  user-select: none;
}

.stepper-btn:hover {
  background: #e2e8f0;
  color: #0f172a;
}

.stepper-btn.minus {
  border-right: 1px solid #e2e8f0;
}

.stepper-btn.plus {
  border-left: 1px solid #e2e8f0;
}

.stepper-input {
  flex: 1;
  border: none;
  background: transparent;
  text-align: center;
  font-size: 0.9rem;
  font-weight: 600;
  color: #0f172a;
  outline: none;
  -moz-appearance: textfield;
}

.stepper-input::-webkit-outer-spin-button,
.stepper-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.custom-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.fancy-select {
  width: 100%;
  padding: 0.5rem 2rem 0.5rem 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.88rem;
  font-weight: 500;
  color: #0f172a;
  background: #f8fafc;
  outline: none;
  appearance: none;
  cursor: pointer;
  box-sizing: border-box;
  transition: all 0.15s ease;
}

.fancy-select:focus {
  background: #ffffff;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.select-chevron {
  position: absolute;
  right: 0.75rem;
  pointer-events: none;
  font-size: 0.85rem;
  color: #64748b;
}

.param-switch-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.75rem;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease;
}

.param-switch-card.checked {
  background: #f0fdf4;
  border-color: #86efac;
}

.switch-state-text {
  font-size: 0.82rem;
  font-weight: 600;
  color: #475569;
}

.param-switch-card.checked .switch-state-text {
  color: #166534;
}

.real-checkbox {
  display: none;
}

.modern-switch-slider {
  width: 38px;
  height: 22px;
  background-color: #cbd5e1;
  border-radius: 22px;
  position: relative;
  transition: background-color 0.2s ease;
}

.modern-switch-slider::before {
  content: "";
  position: absolute;
  width: 18px;
  height: 18px;
  left: 2px;
  top: 2px;
  background-color: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.real-checkbox:checked + .modern-switch-slider {
  background-color: #10b981;
}

.real-checkbox:checked + .modern-switch-slider::before {
  transform: translateX(16px);
}

.fancy-footer {
  padding: 1.15rem 1.75rem;
  background: #f8fafc;
  border-top: 1px solid #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
}

.btn-cancel-glass {
  background: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
  padding: 0.55rem 1.25rem;
  border-radius: 10px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-cancel-glass:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.btn-glow-confirm {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  border: 1px solid #059669;
  color: #ffffff;
  padding: 0.6rem 1.5rem;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.btn-glow-confirm:hover {
  transform: translateY(-1.5px);
  box-shadow: 0 6px 18px rgba(16, 185, 129, 0.45);
}

/* Let the body own scrolling so the header and actions stay aligned and reachable. */
.modal-backdrop-glass {
  padding: 1rem;
}

.fancy-param-modal {
  width: min(100%, 620px);
  max-width: 620px;
  max-height: calc(100dvh - 2rem);
}

.fancy-header,
.fancy-footer,
.modal-accent-line {
  flex-shrink: 0;
}

.modal-title-group,
.modal-title-group > div:last-child {
  min-width: 0;
}

.header-icon-wrap,
.btn-close-modal-fancy {
  flex-shrink: 0;
}

.param-modal-body {
  min-height: 0;
  padding: 1.25rem 1.75rem;
  overflow-y: auto;
  background: #f8fafc;
}

.modal-params-grid-fancy {
  max-height: none;
  overflow: visible;
  padding-right: 0;
}

.fancy-footer {
  flex-wrap: wrap;
}

.btn-cancel-glass,
.btn-glow-confirm {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

@media (max-width: 640px) {
  .modal-backdrop-glass {
    padding: 0.75rem;
  }

  .fancy-param-modal {
    max-height: calc(100dvh - 1.5rem);
    border-radius: 16px;
  }

  .fancy-header,
  .param-modal-body,
  .fancy-footer {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .fancy-header {
    gap: 0.75rem;
  }

  .header-icon-wrap {
    width: 38px;
    height: 38px;
  }

  .modal-main-title {
    font-size: 1rem;
  }

  .param-dialog-tip-card {
    align-items: flex-start;
  }

  .modal-params-grid-fancy {
    grid-template-columns: minmax(0, 1fr);
  }

  .fancy-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr);
  }

  .btn-cancel-glass,
  .btn-glow-confirm {
    width: 100%;
    min-width: 0;
    padding-inline: 0.75rem;
  }
}
</style>
