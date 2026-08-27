<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  open: boolean;
  aiPromptInput: string;
  isAiGenerating: boolean;
  aiIncrementalModify: boolean;
  hasEditorContent: boolean;
}>();

const emit = defineEmits<{
  "update:aiPromptInput": [value: string];
  "update:aiIncrementalModify": [value: boolean];
  preset: [prompt: string];
  cancel: [];
  generate: [];
}>();

const promptModel = computed({
  get: () => props.aiPromptInput,
  set: (value: string) => emit("update:aiPromptInput", value),
});

const incrementalModifyModel = computed({
  get: () => props.aiIncrementalModify,
  set: (value: boolean) => emit("update:aiIncrementalModify", value),
});
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('cancel')">
    <div class="ai-modal-card">
      <div class="modal-header">
        <div class="modal-title">
          <span class="ai-sparkle-icon">✨</span>
          <h3>AI 智能生成自动化脚本</h3>
        </div>
        <button class="btn-close-modal" @click="emit('cancel')">✕</button>
      </div>

      <div class="modal-body">
        <div class="input-group">
          <label class="input-label">
            描述你的自动化需求 (支持自动保存数据到 SQLite 数据库与去重)：
          </label>
          <textarea
            v-model="promptModel"
            class="ai-prompt-textarea"
            placeholder="例如：自动提取当前页面上的列表数据，包含标题、价格和链接，并使用 db.upsert() 去重保存到 SQLite 数据库中..."
            rows="4"
          ></textarea>
        </div>

        <div class="preset-section">
          <span class="preset-label">💡 常用需求快捷模板 (自动整合 SQLite 数据库):</span>
          <div class="preset-chips">
            <button
              class="chip-btn"
              @click="
                emit(
                  'preset',
                  '自动建表 cbg_items，提取当前页面列表元素的名称、价格与链接，并使用 db.exists() 判断去重后通过 db.upsert() 存入 SQLite 数据库',
                )
              "
            >
              📊 提取数据并去重存入 SQLite
            </button>

            <button
              class="chip-btn"
              @click="emit('preset', '分析并观察当前页面上的主要按钮、输入框和可交互链接')"
            >
              🎯 观察交互元素
            </button>

            <button
              class="chip-btn"
              @click="emit('preset', '在页面的搜索框中输入搜索词并自动点击提交')"
            >
              🔍 搜索并点击
            </button>

            <button
              class="chip-btn"
              @click="emit('preset', '查询 SQLite 数据库中 cbg_items 表的数据总量并在控制台打印')"
            >
              🗄️ 读取 SQLite 数据库
            </button>
          </div>
        </div>

        <div v-if="hasEditorContent" class="modify-mode-toggle">
          <label class="checkbox-label">
            <input v-model="incrementalModifyModel" type="checkbox" />
            <span>结合当前编辑器中的代码进行增量修改 (若取消勾选则全新生成)</span>
          </label>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-cancel" @click="emit('cancel')">取消</button>
        <button
          class="btn-generate-ai"
          :disabled="isAiGenerating || !aiPromptInput.trim()"
          @click="emit('generate')"
        >
          <span v-if="isAiGenerating">🧠 AI 思考并生成中...</span>
          <span v-else>✨ 一键生成 / 修改代码</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ai-modal-card {
  width: 90%;
  max-width: 600px;
  background-color: #ffffff;
  border-radius: 16px;
  box-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.1),
    0 8px 10px -6px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  padding: 1.25rem 1.5rem;
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
  font-size: 1.1rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.ai-sparkle-icon {
  font-size: 1.2rem;
}

.btn-close-modal {
  border: none;
  background: transparent;
  font-size: 1.1rem;
  color: #64748b;
  cursor: pointer;
}

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.input-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: #334155;
}

.ai-prompt-textarea {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 0.85rem;
  font-size: 0.9rem;
  font-family: inherit;
  color: #0f172a;
  outline: none;
  resize: vertical;
}

.ai-prompt-textarea:focus {
  border-color: #8b5cf6;
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
}

.preset-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preset-label {
  font-size: 0.8rem;
  color: #64748b;
  font-weight: 500;
}

.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.chip-btn {
  background-color: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #475569;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.chip-btn:hover {
  background-color: #e0e7ff;
  color: #4f46e5;
  border-color: #c7d2fe;
}

.modify-mode-toggle {
  background-color: #f8fafc;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #475569;
  cursor: pointer;
}

.modal-footer {
  padding: 1rem 1.5rem;
  background-color: #f8fafc;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
}

.btn-cancel {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  color: #475569;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-generate-ai {
  background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
  color: white;
  border: none;
  padding: 0.55rem 1.25rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 10px rgba(139, 92, 246, 0.3);
  transition: all 0.2s ease;
}

.btn-generate-ai:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(139, 92, 246, 0.4);
}

.btn-generate-ai:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Keep long prompts and action labels inside the viewport. */
.modal-overlay {
  padding: 1rem;
}

.ai-modal-card {
  width: min(100%, 640px);
  max-width: 640px;
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
}

.modal-title h3 {
  overflow-wrap: anywhere;
}

.btn-close-modal {
  flex-shrink: 0;
}

.modal-body {
  min-height: 0;
  overflow-y: auto;
}

.ai-prompt-textarea {
  min-height: 108px;
  max-height: 42vh;
}

.modal-footer {
  flex-wrap: wrap;
}

.btn-cancel,
.btn-generate-ai {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1.15;
}

@media (max-width: 560px) {
  .modal-overlay {
    padding: 0.75rem;
  }

  .ai-modal-card {
    max-height: calc(100dvh - 1.5rem);
    border-radius: 14px;
  }

  .modal-header,
  .modal-body,
  .modal-footer {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .modal-title h3 {
    font-size: 1rem;
  }

  .chip-btn {
    max-width: 100%;
    text-align: left;
    line-height: 1.35;
  }

  .modal-footer {
    display: grid;
    grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.5fr);
  }

  .btn-cancel,
  .btn-generate-ai {
    width: 100%;
    min-width: 0;
    padding-inline: 0.65rem;
  }
}
</style>
