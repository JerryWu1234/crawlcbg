<script setup lang="ts">
import type { FlowDefinition } from "../types/flow";

defineProps<{
  flows: FlowDefinition[];
  activeFlowId: string;
}>();

const emit = defineEmits<{
  select: [flowId: string];
}>();
</script>

<template>
  <nav class="flow-selector" aria-label="选择核心流程">
    <button
      v-for="flow in flows"
      :key="flow.id"
      type="button"
      class="flow-tab"
      :class="{ active: flow.id === activeFlowId }"
      :style="{ '--flow-accent': flow.accent }"
      :aria-current="flow.id === activeFlowId ? 'page' : undefined"
      @click="emit('select', flow.id)"
    >
      <span class="flow-tab-number">{{ flow.number }}</span>
      <span>
        <strong>{{ flow.title }}</strong>
        <small>{{ flow.stages.length }} stages · {{ flow.transitions.length }} transitions</small>
      </span>
    </button>
  </nav>
</template>
