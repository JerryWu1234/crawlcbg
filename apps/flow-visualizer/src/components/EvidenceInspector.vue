<script setup lang="ts">
import { computed } from "vue";

import type {
  DataDetail,
  FieldRequirement,
  FlowStage,
  FlowTransition,
  SourceRef,
} from "../types/flow";

const props = defineProps<{
  stage: FlowStage;
  transition: FlowTransition;
  dataDetail: DataDetail;
  sources: SourceRef[];
}>();

const requirementLabels: Record<FieldRequirement, string> = {
  required: "必需",
  optional: "可选",
  conditional: "条件必需",
};

const relevantSources = computed(() => {
  const ids = new Set([
    ...props.stage.sourceIds,
    ...props.transition.sourceIds,
    ...props.dataDetail.sourceIds,
  ]);
  return props.sources.filter((source) => ids.has(source.id));
});
</script>

<template>
  <aside class="inspector-panel" role="region" aria-labelledby="inspector-title" tabindex="0">
    <div class="inspector-sticky">
      <div class="section-heading compact-heading">
        <div>
          <p class="kicker">SYNCHRONIZED INSPECTOR</p>
          <h2 id="inspector-title">当前转换</h2>
        </div>
        <span class="kind-pill" :data-kind="transition.kind">{{ transition.kind }}</span>
      </div>

      <section class="inspector-block transition-focus">
        <code>{{ transition.id }}</code>
        <h3>{{ transition.label }}</h3>
        <p>{{ transition.explanation }}</p>
        <dl class="inline-facts">
          <div>
            <dt>FROM</dt>
            <dd>{{ transition.from }}</dd>
          </div>
          <div>
            <dt>TO</dt>
            <dd>{{ transition.to }}</dd>
          </div>
          <div>
            <dt>WHEN</dt>
            <dd>{{ transition.timing }}</dd>
          </div>
        </dl>
      </section>

      <section class="inspector-block">
        <div class="block-title">
          <span>01</span>
          <h3>阶段语义</h3>
        </div>
        <p class="stage-title-inline">{{ stage.eyebrow }} · {{ stage.title }}</p>
        <p>{{ stage.explanation }}</p>
        <div class="before-after">
          <div>
            <span>BEFORE</span>
            <p>{{ stage.before }}</p>
          </div>
          <div>
            <span>AFTER</span>
            <p>{{ stage.after }}</p>
          </div>
        </div>
        <div class="output-list">
          <span v-for="output in stage.outputs" :key="output">{{ output }}</span>
        </div>
      </section>

      <section class="inspector-block">
        <div class="block-title">
          <span>02</span>
          <h3>示例 payload</h3>
        </div>
        <p class="example-warning">说明性示例 · 不是实时或录制数据</p>
        <pre><code>{{ transition.payloadExample }}</code></pre>
      </section>

      <section class="inspector-block data-block">
        <div class="block-title">
          <span>03</span>
          <h3>{{ dataDetail.title }}</h3>
        </div>
        <span class="data-category">{{ dataDetail.category }}</span>
        <p>{{ dataDetail.purpose }}</p>
        <dl class="data-lifecycle">
          <div>
            <dt>生产者</dt>
            <dd>{{ dataDetail.producer }}</dd>
          </div>
          <div>
            <dt>消费者</dt>
            <dd>{{ dataDetail.consumer }}</dd>
          </div>
          <div>
            <dt>转换</dt>
            <dd>{{ dataDetail.transformation }}</dd>
          </div>
          <div>
            <dt>生命周期</dt>
            <dd>{{ dataDetail.lifecycle }}</dd>
          </div>
        </dl>

        <div class="table-scroll" tabindex="0" aria-label="数据字段，可横向滚动">
          <table>
            <thead>
              <tr>
                <th>路径</th>
                <th>类型 / 必需性</th>
                <th>示例值</th>
                <th>用途</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in dataDetail.fields" :key="field.path">
                <td>
                  <code>{{ field.path }}</code>
                </td>
                <td>
                  <code>{{ field.type }}</code>
                  <small>{{ requirementLabels[field.requirement] }}</small>
                </td>
                <td>{{ field.example }}</td>
                <td>{{ field.purpose }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="inspector-block source-block">
        <div class="block-title">
          <span>04</span>
          <h3>源码证据</h3>
        </div>
        <article v-for="source in relevantSources" :key="source.id" class="source-card">
          <code>{{ source.path }}</code>
          <strong>{{ source.symbol }}</strong>
          <p>{{ source.claim }}</p>
        </article>
      </section>
    </div>
  </aside>
</template>
