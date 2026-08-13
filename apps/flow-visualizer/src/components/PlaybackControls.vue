<script setup lang="ts">
const props = defineProps<{
  progress: number;
  isPlaying: boolean;
  reducedMotion: boolean;
}>();

const emit = defineEmits<{
  play: [];
  pause: [];
  replay: [];
  seek: [progress: number];
}>();

function handleScrub(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  emit("seek", Number(input.value) / 100);
}
</script>

<template>
  <div class="playback-panel" aria-label="流程播放控制">
    <div class="playback-buttons">
      <button type="button" class="icon-button" title="回到流程起点" @click="emit('replay')">
        <span aria-hidden="true">↺</span>
        <span>重播</span>
      </button>
      <button v-if="isPlaying" type="button" class="primary-control" @click="emit('pause')">
        <span aria-hidden="true">Ⅱ</span>
        暂停
      </button>
      <button v-else type="button" class="primary-control" @click="emit('play')">
        <span aria-hidden="true">{{ reducedMotion ? "→" : "▶" }}</span>
        {{ reducedMotion ? "下一阶段" : "播放" }}
      </button>
    </div>

    <div class="scrubber-wrap">
      <label for="flow-progress">
        <span>统一进度</span>
        <output for="flow-progress">{{ Math.round(props.progress * 100) }}%</output>
      </label>
      <input
        id="flow-progress"
        type="range"
        min="0"
        max="100"
        step="0.1"
        :value="props.progress * 100"
        :aria-valuetext="`${Math.round(props.progress * 100)}%`"
        aria-describedby="scrubber-help"
        @input="handleScrub"
      />
      <p id="scrubber-help">拖动会暂停播放、清除旧转换选择，并从同一进度更新所有视图。</p>
    </div>

    <span v-if="reducedMotion" class="motion-badge">减少动态：逐阶段模式</span>
  </div>
</template>
