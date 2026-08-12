<script setup lang="ts">
import type { ValidationResult } from "../../types/automation";

defineProps<{
  result: ValidationResult;
}>();
</script>

<template>
  <div class="validation-banner" :class="{ valid: result.valid, invalid: !result.valid }">
    <div class="banner-title">
      <span v-if="result.valid">✅ 语法测试通过</span>
      <span v-else>❌ 语法检测到错误</span>
    </div>
    <div v-if="result.message" class="banner-msg">
      {{ result.message }}
    </div>
    <div v-if="result.errors && result.errors.length > 0" class="banner-errors">
      <div v-for="(error, index) in result.errors" :key="index" class="err-line">
        ⚠️ <strong>Line {{ error.line }}, Col {{ error.character }}:</strong>
        {{ error.message }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.validation-banner {
  padding: 0.85rem 1.25rem;
  border-radius: 10px;
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.validation-banner.valid {
  background-color: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #047857;
}

.validation-banner.invalid {
  background-color: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
}

.banner-title {
  font-weight: 700;
}

.banner-errors {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 0.25rem;
}

.err-line {
  font-family: var(--font-mono, monospace);
  font-size: 0.825rem;
}
</style>
