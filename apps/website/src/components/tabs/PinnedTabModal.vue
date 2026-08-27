<script setup lang="ts">
import { computed } from "vue";
import type { PinnedTabForm, ScriptItem } from "../../types/automation";

const props = defineProps<{
  form: Readonly<PinnedTabForm>;
  scripts: readonly ScriptItem[];
}>();

const emit = defineEmits<{
  "update:form": [form: PinnedTabForm];
  cancel: [];
  save: [form: PinnedTabForm];
}>();

const updateField = <Key extends keyof PinnedTabForm>(key: Key, value: PinnedTabForm[Key]) => {
  emit("update:form", { ...props.form, [key]: value });
};

const titleModel = computed({
  get: () => props.form.title,
  set: (value: string) => updateField("title", value),
});

const urlModel = computed({
  get: () => props.form.url,
  set: (value: string) => updateField("url", value),
});
</script>

<template>
  <div class="modal-overlay animated-fade-in" @click.self="emit('cancel')">
    <div class="pinned-modal-card animated-slide-up">
      <div class="modal-header-hero">
        <div class="modal-title-wrapper">
          <div class="pin-icon-box">
            <span class="icon">📌</span>
          </div>
          <div class="title-text-group">
            <h3>新增常驻预设配置</h3>
            <p class="subtitle">设定常驻网页，实现一键检测开页与流式执行自动化</p>
          </div>
        </div>
        <button class="btn-close-modal-glass" @click="emit('cancel')">✕</button>
      </div>

      <div class="modal-body-styled">
        <div class="input-field-block">
          <label class="field-label">
            <span class="label-icon">🏷️</span>
            <span>预设名称</span>
            <span class="required-star">*</span>
          </label>
          <input
            v-model="titleModel"
            type="text"
            placeholder="例如：小红书蒲公英 - 商业内容管理"
            class="styled-input"
          />
          <span class="field-hint">给予预设一个易辨识的标识名称</span>
        </div>

        <div class="input-field-block">
          <label class="field-label">
            <span class="label-icon">🔗</span>
            <span>目标网页 URL</span>
            <span class="required-star">*</span>
          </label>
          <input
            v-model="urlModel"
            type="text"
            placeholder="https://pgy.xiaohongshu.com/microapp/creativity/commercial"
            class="styled-input font-mono"
          />
          <span class="field-hint">未打开或 URL 不相符时，系统将自动重定向并加载此目标 URL</span>
        </div>

        <div class="input-field-block">
          <label class="field-label">
            <span class="label-icon">📄</span>
            <span>默认关联执行脚本</span>
          </label>
          <div class="select-wrapper">
            <select
              :value="props.form.scriptFilename"
              class="styled-select"
              @change="updateField('scriptFilename', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">(无 - 运行时默认选择最新脚本)</option>
              <option
                v-for="script in props.scripts"
                :key="script.filename"
                :value="script.filename"
              >
                📄 {{ script.filename }}
              </option>
            </select>
            <span class="select-arrow-icon">▾</span>
          </div>
          <span class="field-hint">选定在极速起航时默认自动运行的自动化脚本</span>
        </div>
      </div>

      <div class="modal-footer-styled">
        <button class="btn-cancel-glass" @click="emit('cancel')">取消</button>
        <button class="btn-save-pinned-hero" @click="emit('save', { ...props.form })">
          <span>💾 保存常驻配置</span>
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

.pinned-modal-card {
  width: 92%;
  max-width: 540px;
  background: #ffffff;
  border-radius: 20px;
  box-shadow:
    0 25px 50px -12px rgba(15, 23, 42, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.8) inset;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e2e8f0;
}

.modal-header-hero {
  background: linear-gradient(135deg, #4f46e5 0%, #6366f1 50%, #7c3aed 100%);
  padding: 1.5rem 1.75rem;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  position: relative;
}

.modal-title-wrapper {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.pin-icon-box {
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.title-text-group h3 {
  font-size: 1.25rem;
  font-weight: 800;
  color: #ffffff;
  margin: 0 0 0.25rem 0;
  letter-spacing: -0.01em;
}

.title-text-group .subtitle {
  font-size: 0.82rem;
  color: rgba(255, 255, 255, 0.85);
  margin: 0;
  font-weight: 400;
}

.btn-close-modal-glass {
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #ffffff;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  font-size: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-close-modal-glass:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: rotate(90deg);
}

.modal-body-styled {
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  background-color: #f8fafc;
}

.input-field-block {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.field-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.88rem;
  font-weight: 700;
  color: #1e293b;
}

.label-icon {
  font-size: 0.95rem;
}

.required-star {
  color: #ef4444;
  font-weight: 800;
}

.styled-input {
  width: 100%;
  padding: 0.7rem 0.9rem;
  border: 1.5px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.9rem;
  color: #0f172a;
  background-color: #ffffff;
  box-sizing: border-box;
  transition: all 0.2s ease;
}

.styled-input.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
}

.styled-input:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
  background-color: #ffffff;
}

.select-wrapper {
  position: relative;
  width: 100%;
}

.styled-select {
  width: 100%;
  padding: 0.7rem 2.2rem 0.7rem 0.9rem;
  border: 1.5px solid #cbd5e1;
  border-radius: 10px;
  font-size: 0.88rem;
  color: #0f172a;
  background-color: #ffffff;
  appearance: none;
  box-sizing: border-box;
  cursor: pointer;
  transition: all 0.2s ease;
}

.styled-select:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
}

.select-arrow-icon {
  position: absolute;
  right: 0.9rem;
  top: 50%;
  transform: translateY(-50%);
  color: #64748b;
  pointer-events: none;
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

/* Keep the dialog shell, form and actions aligned at every viewport size. */
.modal-overlay {
  padding: 1rem;
}

.pinned-modal-card {
  width: min(100%, 640px);
  max-width: 640px;
  max-height: calc(100dvh - 2rem);
}

.modal-header-hero,
.modal-footer-styled {
  flex-shrink: 0;
}

.modal-header-hero {
  gap: 1rem;
}

.modal-title-wrapper,
.title-text-group {
  min-width: 0;
}

.btn-close-modal-glass,
.pin-icon-box {
  flex-shrink: 0;
}

.modal-body-styled {
  min-height: 0;
  overflow-y: auto;
}

.field-hint {
  color: #64748b;
  font-size: 0.76rem;
  line-height: 1.45;
}

.modal-footer-styled {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.75rem;
  border-top: 1px solid #e2e8f0;
  background: #ffffff;
}

.btn-cancel-glass,
.btn-save-pinned-hero {
  min-height: 42px;
  padding: 0.6rem 1.25rem;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.88rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.btn-save-pinned-hero {
  border: 1px solid #4f46e5;
  color: #ffffff;
  background: linear-gradient(135deg, #4f46e5 0%, #6366f1 55%, #7c3aed 100%);
  box-shadow: 0 5px 14px rgba(79, 70, 229, 0.28);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    filter 0.18s ease;
}

.btn-save-pinned-hero:hover {
  transform: translateY(-1px);
  filter: saturate(1.08);
  box-shadow: 0 8px 20px rgba(79, 70, 229, 0.36);
}

.btn-cancel-glass:focus-visible,
.btn-save-pinned-hero:focus-visible,
.btn-close-modal-glass:focus-visible {
  outline: 3px solid rgba(99, 102, 241, 0.3);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .modal-overlay {
    padding: 0.75rem;
  }

  .pinned-modal-card {
    max-height: calc(100dvh - 1.5rem);
    border-radius: 16px;
  }

  .modal-header-hero,
  .modal-body-styled,
  .modal-footer-styled {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .modal-header-hero {
    padding-top: 1.1rem;
    padding-bottom: 1.1rem;
  }

  .modal-title-wrapper {
    align-items: flex-start;
    gap: 0.75rem;
  }

  .pin-icon-box {
    width: 40px;
    height: 40px;
    border-radius: 12px;
  }

  .title-text-group h3 {
    font-size: 1.05rem;
  }

  .title-text-group .subtitle {
    font-size: 0.76rem;
    line-height: 1.4;
  }

  .modal-body-styled {
    padding-top: 1.15rem;
    padding-bottom: 1.15rem;
    gap: 1rem;
  }

  .modal-footer-styled {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
  }

  .btn-cancel-glass,
  .btn-save-pinned-hero {
    width: 100%;
    min-width: 0;
    padding-inline: 0.75rem;
  }
}
</style>
