<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import ArchitectureMap from "./components/ArchitectureMap.vue";
import EvidenceInspector from "./components/EvidenceInspector.vue";
import FlowCanvas from "./components/FlowCanvas.vue";
import FlowSelector from "./components/FlowSelector.vue";
import PlaybackControls from "./components/PlaybackControls.vue";
import SourceIndex from "./components/SourceIndex.vue";
import TransitionTimeline from "./components/TransitionTimeline.vue";
import { flowModel } from "./model";
import type { FlowStage, FlowTransition } from "./types/flow";

const activeFlowId = ref(flowModel.flows[0]?.id ?? "");
const progress = ref(0);
const isPlaying = ref(false);
const selectedTransitionId = ref<string | null>(null);
const reducedMotion = ref(false);
const liveMessage = ref("已加载源码推导流程模型。当前位于第一条流程的起点。");

let animationFrame: number | undefined;
let previousTimestamp = 0;
let motionQuery: MediaQueryList | undefined;
const playbackDuration = 18_000;

const activeFlow = computed(
  () => flowModel.flows.find((flow) => flow.id === activeFlowId.value) ?? flowModel.flows[0],
);

const totalStages = computed(() =>
  flowModel.flows.reduce((total, flow) => total + flow.stages.length, 0),
);

const totalTransitions = computed(() =>
  flowModel.flows.reduce((total, flow) => total + flow.transitions.length, 0),
);

function primaryTransitionAtProgress(): FlowTransition | undefined {
  const flow = activeFlow.value;
  if (!flow) return undefined;

  const transitions = flow.primaryTransitionIds
    .map((id) => flow.transitions.find((transition) => transition.id === id))
    .filter((transition): transition is FlowTransition => Boolean(transition));

  return (
    transitions.find(
      (transition) =>
        progress.value >= transition.window[0] && progress.value <= transition.window[1],
    ) ??
    transitions.find((transition) => progress.value < transition.window[0]) ??
    transitions.at(-1)
  );
}

const activeTransition = computed(() => {
  const flow = activeFlow.value;
  if (!flow) return undefined;

  if (selectedTransitionId.value) {
    const selected = flow.transitions.find(
      (transition) => transition.id === selectedTransitionId.value,
    );
    if (selected) return selected;
  }

  return primaryTransitionAtProgress();
});

const currentStage = computed<FlowStage | undefined>(() => {
  const flow = activeFlow.value;
  if (!flow) return undefined;

  if (selectedTransitionId.value && activeTransition.value) {
    const selectedStage = flow.stages.find((stage) => stage.id === activeTransition.value?.to);
    if (selectedStage) return selectedStage;
  }

  const primaryStages = flow.primaryStageIds
    .map((id) => flow.stages.find((stage) => stage.id === id))
    .filter((stage): stage is FlowStage => Boolean(stage));

  return (
    [...primaryStages].reverse().find((stage) => progress.value >= stage.progress) ??
    primaryStages[0]
  );
});

const activeDataDetail = computed(() =>
  flowModel.dataDetails.find((detail) => detail.id === activeTransition.value?.dataDetailId),
);

const pageStyle = computed<Record<string, string>>(() => ({
  "--active-flow-accent": activeFlow.value?.accent ?? "#68c7bd",
}));

function stopAnimation() {
  if (animationFrame !== undefined) {
    cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
  }
  previousTimestamp = 0;
}

function pause(announce = true) {
  isPlaying.value = false;
  stopAnimation();
  if (announce) liveMessage.value = `流程已暂停在 ${Math.round(progress.value * 100)}%。`;
}

function animate(timestamp: number) {
  if (!isPlaying.value) return;
  if (previousTimestamp === 0) previousTimestamp = timestamp;

  const elapsed = timestamp - previousTimestamp;
  previousTimestamp = timestamp;
  progress.value = Math.min(1, progress.value + elapsed / playbackDuration);

  if (progress.value >= 1) {
    isPlaying.value = false;
    stopAnimation();
    liveMessage.value = `${activeFlow.value?.title ?? "流程"} 已到达主路径终点。`;
    return;
  }

  animationFrame = requestAnimationFrame(animate);
}

function stepToNextStage() {
  const flow = activeFlow.value;
  if (!flow) return;

  selectedTransitionId.value = null;
  const nextStage = flow.primaryStageIds
    .map((id) => flow.stages.find((stage) => stage.id === id))
    .filter((stage): stage is FlowStage => Boolean(stage))
    .find((stage) => stage.progress > progress.value + 0.001);

  if (nextStage) {
    progress.value = nextStage.progress;
    liveMessage.value = `已进入阶段：${nextStage.title}。`;
  } else {
    liveMessage.value = `${flow.title} 已位于主路径终点。`;
  }
}

function play() {
  if (reducedMotion.value) {
    stepToNextStage();
    return;
  }

  if (progress.value >= 1) progress.value = 0;
  selectedTransitionId.value = null;
  isPlaying.value = true;
  previousTimestamp = 0;
  liveMessage.value = `正在播放 ${activeFlow.value?.title ?? "流程"}。`;
  stopAnimation();
  isPlaying.value = true;
  animationFrame = requestAnimationFrame(animate);
}

function replay() {
  pause(false);
  selectedTransitionId.value = null;
  progress.value = 0;
  liveMessage.value = `${activeFlow.value?.title ?? "流程"} 已回到起点。`;
}

function seek(nextProgress: number) {
  pause(false);
  selectedTransitionId.value = null;
  progress.value = Math.max(0, Math.min(1, nextProgress));
}

function selectFlow(flowId: string) {
  if (flowId === activeFlowId.value) return;
  pause(false);
  activeFlowId.value = flowId;
  progress.value = 0;
  selectedTransitionId.value = null;
  const flow = flowModel.flows.find((item) => item.id === flowId);
  liveMessage.value = `已切换到 ${flow?.title ?? "新流程"}，并回到起点。`;
}

function selectStage(stageId: string) {
  const stage = activeFlow.value?.stages.find((item) => item.id === stageId);
  if (!stage) return;

  pause(false);
  selectedTransitionId.value = null;
  progress.value = stage.progress;
  liveMessage.value = `已选择阶段：${stage.title}。${stage.explanation}`;
}

function selectTransition(transitionId: string) {
  const transition = activeFlow.value?.transitions.find((item) => item.id === transitionId);
  if (!transition) return;

  pause(false);
  selectedTransitionId.value = transition.id;
  progress.value = (transition.window[0] + transition.window[1]) / 2;
  liveMessage.value = `已选择转换：${transition.label}。详情检查器已同步更新。`;
}

function handleMotionPreference(event: MediaQueryListEvent) {
  reducedMotion.value = event.matches;
  if (event.matches && isPlaying.value) pause(false);
}

onMounted(() => {
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.value = motionQuery.matches;
  motionQuery.addEventListener("change", handleMotionPreference);
});

onBeforeUnmount(() => {
  stopAnimation();
  motionQuery?.removeEventListener("change", handleMotionPreference);
});
</script>

<template>
  <div class="app-shell" :style="pageStyle">
    <a class="skip-link" href="#flow-workspace">跳到流程工作区</a>

    <header class="hero">
      <div class="hero-grid" aria-hidden="true"></div>
      <nav class="topbar" aria-label="页面信息">
        <a class="brand" href="#top" aria-label="crawlcbg Flow Evidence 首页">
          <span class="brand-mark"><i></i><i></i><i></i></span>
          <span>
            <strong>crawlcbg</strong>
            <small>FLOW EVIDENCE</small>
          </span>
        </a>
        <div class="classification-pill">
          <span></span>
          {{ flowModel.classification }}
        </div>
      </nav>

      <div id="top" class="hero-content">
        <div class="hero-copy">
          <p class="hero-kicker">BROWSER AUTOMATION · EXPLAINED FROM SOURCE</p>
          <h1>看清每次自动化，<br /><em>在哪里获得能力。</em></h1>
          <p class="hero-intro">
            从 Vue 操作台到 Fastify Runner、外部 Chrome、SQLite
            与文件产物。每个阶段、转换和字段都能回到当前仓库中的稳定源码符号。
          </p>
        </div>

        <dl class="hero-stats">
          <div>
            <dt>{{ flowModel.flows.length }}</dt>
            <dd>核心流程</dd>
          </div>
          <div>
            <dt>{{ totalStages }}</dt>
            <dd>语义阶段</dd>
          </div>
          <div>
            <dt>{{ totalTransitions }}</dt>
            <dd>转换与分支</dd>
          </div>
          <div>
            <dt>{{ flowModel.sources.length }}</dt>
            <dd>源码锚点</dd>
          </div>
        </dl>
      </div>

      <div class="truth-strip">
        <article>
          <span>01</span>
          <div>
            <strong>模型类型</strong>
            <p>源码推导的说明模型，不是 live telemetry。</p>
          </div>
        </article>
        <article>
          <span>02</span>
          <div>
            <strong>数据声明</strong>
            <p>Payload 均明确标为示例；没有伪装成真实运行。</p>
          </div>
        </article>
        <article>
          <span>03</span>
          <div>
            <strong>验证边界</strong>
            <p>{{ flowModel.generatedFrom }}。</p>
          </div>
        </article>
      </div>
    </header>

    <main>
      <ArchitectureMap
        :participants="flowModel.participants"
        :connections="flowModel.connections"
      />

      <section id="flow-workspace" class="workspace" aria-labelledby="workspace-title">
        <div class="section-heading workspace-heading">
          <div>
            <p class="kicker">INTERACTIVE MODEL</p>
            <h2 id="workspace-title">沿着证据走一遍</h2>
          </div>
          <p class="section-copy">
            主路径用于播放；失败、替代和恢复转换都可单独选择，并同步更新右侧语义、数据与来源。
          </p>
        </div>

        <FlowSelector
          :flows="flowModel.flows"
          :active-flow-id="activeFlowId"
          @select="selectFlow"
        />

        <PlaybackControls
          :progress="progress"
          :is-playing="isPlaying"
          :reduced-motion="reducedMotion"
          @play="play"
          @pause="pause"
          @replay="replay"
          @seek="seek"
        />

        <div
          v-if="activeFlow && currentStage && activeTransition && activeDataDetail"
          class="workspace-grid"
        >
          <div class="workspace-main">
            <FlowCanvas
              :flow="activeFlow"
              :progress="progress"
              :current-stage-id="currentStage.id"
              :active-transition-id="activeTransition.id"
              @select-stage="selectStage"
              @select-transition="selectTransition"
            />
            <TransitionTimeline
              :flow="activeFlow"
              :progress="progress"
              :active-transition-id="activeTransition.id"
              @select="selectTransition"
            />
          </div>

          <EvidenceInspector
            :stage="currentStage"
            :transition="activeTransition"
            :data-detail="activeDataDetail"
            :sources="flowModel.sources"
          />
        </div>
      </section>

      <section class="findings-panel" aria-labelledby="findings-title">
        <div class="section-heading">
          <div>
            <p class="kicker">CONFIRMED GAPS</p>
            <h2 id="findings-title">确定性在这些边界变弱</h2>
          </div>
          <p class="section-copy">
            这些不是模拟故障，而是当前生产者、消费者或持久化协议之间的源码差异。
          </p>
        </div>
        <div class="finding-grid">
          <article>
            <span class="priority priority-critical">P0</span>
            <h3>Runner 与 API 同进程</h3>
            <p>同步死循环无法被 AbortSignal 抢占，并会阻塞 Fastify、SSE 和其他运行。</p>
            <code>src-execution · src-cancel</code>
          </article>
          <article>
            <span class="priority priority-critical">P0</span>
            <h3>SQL identifier 未收口</h3>
            <p>部分表名和列名直接进入 SQL；值参数绑定不能保护 identifier。</p>
            <code>src-db-routes</code>
          </article>
          <article>
            <span class="priority priority-high">P1</span>
            <h3>取消协议没有端到端接线</h3>
            <p>服务端有 cancel endpoint，前端主要依赖关闭 EventSource 触发连接断开。</p>
            <code>src-cancel · src-scripts-view</code>
          </article>
          <article>
            <span class="priority priority-high">P1</span>
            <h3>Trace 不保证终态</h3>
            <p>done/error 走 sendEvent 而不走 sendLog；历史文件通常无法证明最终成功或失败。</p>
            <code>src-execution · src-trace</code>
          </article>
        </div>
      </section>

      <SourceIndex :sources="flowModel.sources" />
    </main>

    <footer>
      <div>
        <strong>{{ flowModel.title }}</strong>
        <span>{{ flowModel.version }}</span>
      </div>
      <p>模型内容与渲染分离。页面未连接运行 API，不会把示例数据描述为实时状态。</p>
    </footer>

    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveMessage }}</p>
  </div>
</template>
