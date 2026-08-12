<script setup lang="ts">
import ScriptParameterField from "./ScriptParameterField.vue";
import type { ScriptParamField, ScriptParamValue, ScriptParamValues } from "../../types/automation";

const props = defineProps<{
  fields: readonly ScriptParamField[];
  values: Readonly<ScriptParamValues>;
}>();

const emit = defineEmits<{
  "update:values": [values: ScriptParamValues];
}>();

const updateField = (name: string, value: ScriptParamValue) => {
  emit("update:values", { ...props.values, [name]: value });
};
</script>

<template>
  <div class="script-params-bar">
    <div class="params-bar-header">
      <span class="params-bar-title">⚙️ 运行时参数配置</span>
      <span class="params-bar-subtitle">(根据 JSDoc 注释自动解析)</span>
    </div>
    <div class="params-form-grid">
      <ScriptParameterField
        v-for="field in fields"
        :key="field.name"
        :field="field"
        :model-value="values[field.name]"
        @update:model-value="updateField(field.name, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.script-params-bar {
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 0.85rem 1.15rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.params-bar-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.params-bar-title {
  font-weight: 600;
  font-size: 0.9rem;
  color: #1e293b;
}

.params-bar-subtitle {
  font-size: 0.78rem;
  color: #64748b;
}

.params-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.85rem 1.25rem;
}
</style>
