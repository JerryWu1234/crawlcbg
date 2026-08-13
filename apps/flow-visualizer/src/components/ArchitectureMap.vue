<script setup lang="ts">
import { computed } from "vue";

import type { ArchitectureConnection, ArchitectureParticipant } from "../types/flow";

const props = defineProps<{
  participants: ArchitectureParticipant[];
  connections: ArchitectureConnection[];
}>();

const boundaryOrder: ArchitectureParticipant["boundary"][] = [
  "browser",
  "node",
  "external",
  "storage",
];

const boundaryLabels: Record<ArchitectureParticipant["boundary"], string> = {
  browser: "Browser · 交互边界",
  node: "Node · 编排与执行",
  external: "External · 外部能力",
  storage: "Storage · 持久化",
};

const groups = computed(() =>
  boundaryOrder.map((boundary) => ({
    boundary,
    label: boundaryLabels[boundary],
    participants: props.participants.filter((item) => item.boundary === boundary),
  })),
);

const participantNames = computed(
  () => new Map(props.participants.map((participant) => [participant.id, participant.label])),
);
</script>

<template>
  <section class="architecture-panel" aria-labelledby="architecture-title">
    <div class="section-heading architecture-heading">
      <div>
        <p class="kicker">SYSTEM BOUNDARIES</p>
        <h2 id="architecture-title">谁拥有状态，谁产生副作用</h2>
      </div>
      <p class="section-copy">
        浏览器界面、Node 编排、外部 Chrome 与本地持久化是四个不同的可信边界。
      </p>
    </div>

    <div class="architecture-grid">
      <section
        v-for="group in groups"
        :key="group.boundary"
        class="architecture-lane"
        :data-boundary="group.boundary"
        :aria-labelledby="`boundary-${group.boundary}`"
      >
        <h3 :id="`boundary-${group.boundary}`">{{ group.label }}</h3>
        <article
          v-for="participant in group.participants"
          :key="participant.id"
          class="participant-card"
        >
          <div class="participant-node" aria-hidden="true"></div>
          <div>
            <h4>{{ participant.label }}</h4>
            <p>{{ participant.detail }}</p>
            <span>{{ participant.sourceIds.length }} 个证据锚点</span>
          </div>
        </article>
      </section>
    </div>

    <div class="connection-strip" aria-label="系统连接">
      <article v-for="connection in connections" :key="connection.id" class="connection-card">
        <div class="connection-route">
          <span>{{ participantNames.get(connection.from) }}</span>
          <span aria-hidden="true">→</span>
          <span>{{ participantNames.get(connection.to) }}</span>
        </div>
        <strong>{{ connection.label }}</strong>
        <code>{{ connection.protocol }}</code>
      </article>
    </div>
  </section>
</template>
