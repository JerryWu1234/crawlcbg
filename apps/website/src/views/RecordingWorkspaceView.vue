<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router";
import RecordingPanel from "../components/tabs/RecordingPanel.vue";
import { API_BASE_URL } from "../config/api";
import type { SavedRecordingScript } from "../composables/useRecording";
import type { BrowserTab } from "../types/automation";

interface RecordingPanelHandle {
  stopForNavigation: () => Promise<boolean>;
}

const route = useRoute();
const router = useRouter();
const recordingPanel = ref<RecordingPanelHandle | null>(null);
const target = ref<BrowserTab | null>(null);
const isLoading = ref(true);
const loadError = ref<string | null>(null);
const canLeave = ref(true);
const savedScript = ref<SavedRecordingScript | null>(null);
const autoStart = ref(route.query.start === "1");
const intendedTargetId = ref<string | null>(null);
const intendedTargetUrl = ref<string | null>(null);
let loadGeneration = 0;
let loadController: AbortController | null = null;
let mounted = false;

const tabIndexFromRoute = (): number | null => {
  const value = Array.isArray(route.params.tabIndex)
    ? route.params.tabIndex[0]
    : route.params.tabIndex;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
};

const targetIdentityFromHistory = (): { targetId: string; url: string } | null => {
  const state = window.history.state as {
    recordingTargetId?: unknown;
    recordingTargetUrl?: unknown;
  } | null;
  return typeof state?.recordingTargetId === "string" &&
    state.recordingTargetId.trim() &&
    typeof state.recordingTargetUrl === "string" &&
    state.recordingTargetUrl.trim()
    ? { targetId: state.recordingTargetId, url: state.recordingTargetUrl }
    : null;
};

const loadTarget = async (): Promise<void> => {
  const generation = ++loadGeneration;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  isLoading.value = true;
  loadError.value = null;
  target.value = null;
  savedScript.value = null;

  const tabIndex = tabIndexFromRoute();
  const expectedTargetId = intendedTargetId.value;
  const expectedUrl = intendedTargetUrl.value;
  if (tabIndex === null) {
    loadError.value = "录制目标页签序号无效。";
    isLoading.value = false;
    return;
  }
  if (!expectedTargetId || !expectedUrl) {
    loadError.value = "录制目标信息已失效，请从标签页管理重新选择要录制的页签。";
    isLoading.value = false;
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/tabs`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`服务端返回 ${response.status}`);
    const payload = (await response.json()) as BrowserTab[] | { tabs?: BrowserTab[] };
    if (generation !== loadGeneration || controller.signal.aborted) return;
    const tabs = Array.isArray(payload) ? payload : (payload.tabs ?? []);
    const matched = tabs.find((tab) => tab.targetId === expectedTargetId);
    if (!matched || matched.url !== expectedUrl) {
      loadError.value = "目标 Chrome 页签已关闭或身份发生变化，本轮不会自动录制其他页签。";
      return;
    }
    target.value = matched;
  } catch (error) {
    if (controller.signal.aborted || generation !== loadGeneration) return;
    loadError.value = `无法读取目标页签：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (generation === loadGeneration) {
      if (loadController === controller) loadController = null;
      isLoading.value = false;
    }
  }
};

const clearAutoStartQuery = async (): Promise<void> => {
  if (!autoStart.value || route.query.start !== "1") return;
  const query = { ...route.query };
  delete query.start;
  await router.replace({
    name: "recording-workspace",
    params: route.params,
    query,
    state: {
      recordingTargetId: intendedTargetId.value,
      recordingTargetUrl: intendedTargetUrl.value,
    },
  });
};

const loadRouteTarget = async (): Promise<void> => {
  const intendedTarget = targetIdentityFromHistory();
  intendedTargetId.value = intendedTarget?.targetId ?? null;
  intendedTargetUrl.value = intendedTarget?.url ?? null;
  autoStart.value = route.query.start === "1";
  await loadTarget();
  await clearAutoStartQuery();
};

const returnToTabs = async (): Promise<void> => {
  if (!canLeave.value) return;
  const query =
    target.value && savedScript.value
      ? {
          recordingTab: String(target.value.index),
          selectedScript: savedScript.value.filename,
        }
      : undefined;
  await router.push({
    name: "tabs",
    query,
    state: {
      recordingTargetId: target.value?.targetId,
      recordingTargetUrl: target.value?.url,
    },
  });
};

const handleSaved = (result: SavedRecordingScript): void => {
  savedScript.value = result;
};

const beforeUnload = (event: BeforeUnloadEvent): void => {
  if (canLeave.value) return;
  event.preventDefault();
  event.returnValue = "";
};

const confirmAndStopForNavigation = async (): Promise<boolean> => {
  if (canLeave.value) return true;
  if (!window.confirm("录制或编辑操作仍在进行。离开会停止录制并丢失尚未保存的内容，确定离开吗？")) {
    return false;
  }
  return (await recordingPanel.value?.stopForNavigation()) ?? true;
};

onBeforeRouteLeave(confirmAndStopForNavigation);
onBeforeRouteUpdate(async (to, from) => {
  if (to.params.tabIndex === from.params.tabIndex) return true;
  return confirmAndStopForNavigation();
});

watch(
  () => route.params.tabIndex,
  () => {
    if (mounted) void loadRouteTarget();
  },
);

onMounted(async () => {
  mounted = true;
  window.addEventListener("beforeunload", beforeUnload);
  await loadRouteTarget();
});

onBeforeUnmount(() => {
  mounted = false;
  loadGeneration += 1;
  loadController?.abort();
  loadController = null;
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <div class="recording-workspace-view" data-cy="recording-workspace">
    <div class="workspace-navigation">
      <button
        type="button"
        :disabled="!canLeave"
        data-cy="recording-return-tabs"
        @click="returnToTabs"
      >
        ← 返回标签页管理
      </button>
      <span v-if="savedScript">已保存 {{ savedScript.filename }}</span>
    </div>

    <div v-if="isLoading" class="workspace-state" role="status">
      <strong>正在读取目标 Chrome 页签…</strong>
      <span>工作台会继续使用当前 CrawlCBG 页面结构。</span>
    </div>

    <div
      v-else-if="loadError || !target"
      class="workspace-state error"
      data-cy="recording-target-error"
    >
      <strong>无法打开录制工作台</strong>
      <span>{{ loadError }}</span>
      <button type="button" @click="returnToTabs">返回标签页管理</button>
    </div>

    <RecordingPanel
      v-else
      ref="recordingPanel"
      :key="`${target.index}:${target.url}`"
      :tab="target"
      :auto-start="autoStart"
      @can-close-change="canLeave = $event"
      @saved="handleSaved"
      @close="returnToTabs"
    />
  </div>
</template>

<style scoped>
.recording-workspace-view {
  display: grid;
  gap: 0.8rem;
  min-width: 0;
}

.workspace-navigation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.workspace-navigation button,
.workspace-state button {
  padding: 0.55rem 0.8rem;
  color: #4338ca;
  background: #ffffff;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.72rem;
  font-weight: 750;
}

.workspace-navigation button:disabled {
  color: #94a3b8;
  background: #f8fafc;
  border-color: #e2e8f0;
  cursor: not-allowed;
}

.workspace-navigation span {
  color: #047857;
  font-size: 0.7rem;
  font-weight: 700;
}

.workspace-state {
  display: grid;
  place-items: center;
  gap: 0.5rem;
  min-height: 320px;
  padding: 2rem;
  color: #64748b;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  text-align: center;
}

.workspace-state strong {
  color: #334155;
  font-size: 0.95rem;
}

.workspace-state span {
  font-size: 0.74rem;
}

.workspace-state.error strong {
  color: #b91c1c;
}
</style>
