<script setup lang="ts">
import { computed } from "vue";

import type { FlowDefinition, FlowTransition, TransitionKind } from "../types/flow";

const props = defineProps<{
  flow: FlowDefinition;
  progress: number;
  activeTransitionId: string;
}>();

const emit = defineEmits<{
  select: [transitionId: string];
}>();

const kindLabels: Record<TransitionKind, string> = {
  normal: "主路径",
  alternate: "替代分支",
  failure: "失败",
  recovery: "恢复",
};

const orderedTransitions = computed(() =>
  [...props.flow.transitions].sort(
    (left, right) => left.window[0] - right.window[0] || left.window[1] - right.window[1],
  ),
);

function transitionStatus(transition: FlowTransition): "active" | "passed" | "upcoming" {
  if (transition.id === props.activeTransitionId) return "active";
  if (props.progress > transition.window[1]) return "passed";
  return "upcoming";
}
</script>

<template>
  <section class="timeline-panel" aria-labelledby="timeline-title">
    <div class="section-heading compact-heading">
      <div>
        <p class="kicker">TRANSITIONS</p>
        <h2 id="timeline-title">分支与恢复路径</h2>
      </div>
      <p class="section-copy">选择任意转换会暂停并定位到其代表时间窗。</p>
    </div>

    <ol class="transition-list">
      <li v-for="transition in orderedTransitions" :key="transition.id">
        <button
          type="button"
          class="transition-row"
          :class="[`kind-${transition.kind}`, `transition-${transitionStatus(transition)}`]"
          :aria-pressed="transition.id === activeTransitionId"
          @click="emit('select', transition.id)"
        >
          <span class="transition-rail" aria-hidden="true">
            <i></i>
          </span>
          <span class="transition-body">
            <span class="transition-meta">
              <span class="kind-label">{{ kindLabels[transition.kind] }}</span>
              <code>{{ transition.id }}</code>
              <span>
                {{ Math.round(transition.window[0] * 100) }}–{{
                  Math.round(transition.window[1] * 100)
                }}%
              </span>
            </span>
            <strong>{{ transition.label }}</strong>
            <small>{{ transition.timing }}</small>
          </span>
          <span class="transition-arrow" aria-hidden="true">↗</span>
        </button>
      </li>
    </ol>
  </section>
</template>
