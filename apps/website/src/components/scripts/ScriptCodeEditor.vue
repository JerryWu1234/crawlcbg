<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  keydown: [event: KeyboardEvent];
}>();

const contentModel = computed({
  get: () => props.modelValue,
  set: (value: string) => emit("update:modelValue", value),
});

const lineCount = computed(() => (props.modelValue.match(/\n/g) || []).length + 1);
</script>

<template>
  <div class="editor-container">
    <div class="line-numbers">
      <span v-for="line in lineCount" :key="line">{{ line }}</span>
    </div>
    <textarea
      v-model="contentModel"
      class="code-textarea"
      placeholder="// 在此处编写你的 JavaScript / MJS 脚本..."
      spellcheck="false"
      @keydown="emit('keydown', $event)"
    ></textarea>
  </div>
</template>

<style scoped>
.editor-container {
  background-color: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  display: flex;
  min-height: 260px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.line-numbers {
  width: 48px;
  background-color: #f8fafc;
  border-right: 1px solid #e2e8f0;
  padding: 0.85rem 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  user-select: none;
  font-family: Consolas, Monaco, monospace;
  font-size: 0.85rem;
  line-height: 1.5;
  color: #94a3b8;
}

.code-textarea {
  flex: 1;
  border: none;
  outline: none;
  padding: 0.85rem;
  font-family: Consolas, Monaco, "Courier New", monospace;
  font-size: 0.9rem;
  line-height: 1.5;
  color: #0f172a;
  background-color: #ffffff;
  resize: vertical;
  min-height: 260px;
  white-space: pre;
  tab-size: 2;
}
</style>
