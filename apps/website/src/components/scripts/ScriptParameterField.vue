<script setup lang="ts">
import { computed } from "vue";
import type { ScriptParamField, ScriptParamValue } from "../../types/automation";

const props = defineProps<{
  field: ScriptParamField;
  modelValue: ScriptParamValue;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: ScriptParamValue];
}>();

const valueModel = computed({
  get: () => props.modelValue,
  set: (value: ScriptParamValue) => emit("update:modelValue", value),
});
</script>

<template>
  <div class="param-form-item">
    <label class="param-label">
      <span>{{ field.label }}</span>
      <span class="param-name-badge">{{ field.name }}</span>
    </label>

    <input
      v-if="field.type === 'string'"
      v-model="valueModel"
      type="text"
      class="param-input"
      :placeholder="`请输入 ${field.label}`"
    />

    <input
      v-if="field.type === 'number'"
      v-model.number="valueModel"
      type="number"
      class="param-input param-input-number"
    />

    <label v-if="field.type === 'boolean'" class="param-switch">
      <input v-model="valueModel" type="checkbox" />
      <span class="switch-slider"></span>
      <span class="switch-text">{{ valueModel ? "开启" : "关闭" }}</span>
    </label>

    <select v-if="field.type === 'select'" v-model="valueModel" class="param-select">
      <option
        v-for="(optionLabel, optionValue) in field.options"
        :key="optionValue"
        :value="optionValue"
      >
        {{ optionLabel }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.param-form-item {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.param-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: #334155;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.param-name-badge {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  color: #2563eb;
  background-color: #dbeafe;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}

.param-input,
.param-select {
  padding: 0.4rem 0.65rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.85rem;
  background-color: #ffffff;
  color: #0f172a;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.param-input:focus,
.param-select:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.param-switch {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  margin-top: 0.2rem;
  user-select: none;
}

.param-switch input {
  display: none;
}

.switch-slider {
  width: 36px;
  height: 20px;
  background-color: #cbd5e1;
  border-radius: 20px;
  position: relative;
  transition: background-color 0.2s ease;
}

.switch-slider::before {
  content: "";
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background-color: #ffffff;
  border-radius: 50%;
  transition: transform 0.2s ease;
}

.param-switch input:checked + .switch-slider {
  background-color: #3b82f6;
}

.param-switch input:checked + .switch-slider::before {
  transform: translateX(16px);
}

.switch-text {
  font-size: 0.82rem;
  color: #475569;
}
</style>
