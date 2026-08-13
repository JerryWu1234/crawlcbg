<script setup lang="ts">
import type { SourceRef } from "../types/flow";

defineProps<{
  sources: SourceRef[];
}>();
</script>

<template>
  <section class="source-index" aria-labelledby="source-index-title">
    <div class="section-heading">
      <div>
        <p class="kicker">PROVENANCE</p>
        <h2 id="source-index-title">Evidence index</h2>
      </div>
      <p class="section-copy">路径和稳定符号是身份；行号没有被用作长期关联键。</p>
    </div>

    <div class="source-index-grid">
      <article v-for="(source, index) in sources" :key="source.id">
        <span>{{ String(index + 1).padStart(2, "0") }}</span>
        <code>{{ source.path }}</code>
        <strong>{{ source.symbol }}</strong>
        <p>{{ source.claim }}</p>
      </article>
    </div>
  </section>
</template>
