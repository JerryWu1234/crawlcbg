<script setup lang="ts">
import { computed } from "vue";

import type { FlowDefinition, FlowStage, FlowTransition } from "../types/flow";

const props = defineProps<{
  flow: FlowDefinition;
  progress: number;
  currentStageId: string;
  activeTransitionId: string;
}>();

const emit = defineEmits<{
  selectStage: [stageId: string];
  selectTransition: [transitionId: string];
}>();

const primaryStages = computed(() =>
  props.flow.primaryStageIds
    .map((id) => props.flow.stages.find((stage) => stage.id === id))
    .filter((stage): stage is FlowStage => Boolean(stage)),
);

function connectorAfter(stage: FlowStage): FlowTransition | undefined {
  return props.flow.primaryTransitionIds
    .map((id) => props.flow.transitions.find((transition) => transition.id === id))
    .find((transition) => transition?.from === stage.id && transition.to !== stage.id);
}

function stageStatus(stage: FlowStage): "complete" | "current" | "upcoming" {
  if (stage.id === props.currentStageId) return "current";
  if (stage.progress < props.progress) return "complete";
  return "upcoming";
}

function statusLabel(stage: FlowStage): string {
  const status = stageStatus(stage);
  if (status === "complete") return "已经过";
  if (status === "current") return "当前阶段";
  return "尚未到达";
}

const trackStyle = computed<Record<string, string>>(() => ({
  "--flow-progress": `${props.progress * 100}%`,
  "--active-accent": props.flow.accent,
}));
</script>

<template>
  <section class="flow-canvas" :style="trackStyle" aria-labelledby="flow-canvas-title">
    <div class="canvas-heading">
      <div>
        <p class="kicker">{{ flow.number }} · CORE FLOW</p>
        <h2 id="flow-canvas-title">{{ flow.title }}</h2>
        <p>{{ flow.summary }}</p>
      </div>
      <div class="flow-outcome">
        <span>可验证终点</span>
        <p>{{ flow.outcome }}</p>
      </div>
    </div>

    <div class="flow-track-scroll" tabindex="0" aria-label="流程阶段，可横向滚动">
      <div class="flow-track">
        <div class="track-line" aria-hidden="true">
          <span></span>
          <i></i>
        </div>

        <template v-for="(stage, index) in primaryStages" :key="stage.id">
          <button
            type="button"
            class="stage-card"
            :class="[`stage-${stageStatus(stage)}`]"
            :aria-current="stage.id === currentStageId ? 'step' : undefined"
            @click="emit('selectStage', stage.id)"
          >
            <span class="stage-status-line">
              <span class="stage-index">{{ String(index + 1).padStart(2, "0") }}</span>
              <span class="stage-status">{{ statusLabel(stage) }}</span>
            </span>
            <span class="stage-eyebrow">{{ stage.eyebrow }}</span>
            <strong>{{ stage.title }}</strong>
            <span class="stage-state">{{ stage.state }}</span>
            <span class="stage-participants">{{ stage.participants.join(" · ") }}</span>
          </button>

          <button
            v-if="index < primaryStages.length - 1 && connectorAfter(stage)"
            type="button"
            class="track-transition"
            :class="{
              active: connectorAfter(stage)?.id === activeTransitionId,
              passed: (connectorAfter(stage)?.window[1] ?? 1) < progress,
            }"
            :aria-label="`查看转换：${connectorAfter(stage)?.label}`"
            @click="emit('selectTransition', connectorAfter(stage)!.id)"
          >
            <span aria-hidden="true">→</span>
            <small>{{ connectorAfter(stage)?.label }}</small>
          </button>
        </template>
      </div>
    </div>

    <div class="current-stage-summary" aria-live="polite">
      <span class="pulse-dot" aria-hidden="true"></span>
      <p>
        <strong>{{ flow.stages.find((stage) => stage.id === currentStageId)?.title }}</strong>
        · {{ flow.stages.find((stage) => stage.id === currentStageId)?.explanation }}
      </p>
    </div>
  </section>
</template>
