<script setup lang="ts">
import { computed } from "vue";
import type { RecordedPage } from "../../types/automation";

const props = defineProps<{
  pages: readonly RecordedPage[];
  activePageId: string | null;
}>();

const emit = defineEmits<{
  "select-page": [pageId: string];
}>();

const activePage = computed(
  () => props.pages.find((page) => page.id === props.activePageId) ?? null,
);

const safePageUrl = computed(() => {
  const value = activePage.value?.url.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
});
</script>

<template>
  <section
    class="page-preview-card"
    aria-labelledby="recording-page-preview-title"
    data-cy="recording-page-preview"
  >
    <header>
      <div>
        <span>iframe 最小模式</span>
        <h4 id="recording-page-preview-title">独立页面预览</h4>
      </div>
      <a
        v-if="safePageUrl"
        :href="safePageUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-cy="recording-page-open-new-tab"
      >
        新标签页打开
      </a>
    </header>

    <div class="page-url-row">
      <strong>{{ activePage?.id ?? "未选择页面" }}</strong>
      <code data-cy="recording-page-url">{{ activePage?.url ?? "等待 page0…" }}</code>
    </div>

    <div class="page-frame-shell">
      <iframe
        v-if="safePageUrl"
        :key="`${activePage?.id}:${safePageUrl}`"
        :src="safePageUrl"
        :title="`${activePage?.id ?? '当前'} 页面独立预览`"
        sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
        referrerpolicy="no-referrer"
        data-cy="recording-page-frame"
      />
      <div v-else class="page-frame-empty" role="status">
        当前页面没有可安全嵌入的 HTTP/HTTPS 地址。
      </div>
    </div>

    <nav class="page-strip" aria-label="录制页面" data-cy="recording-page-pages">
      <button
        v-for="page in props.pages"
        :key="page.id"
        type="button"
        :class="{ active: props.activePageId === page.id }"
        :aria-pressed="props.activePageId === page.id"
        :data-page-id="page.id"
        data-cy="recording-page-chip"
        @click="emit('select-page', page.id)"
      >
        <span>
          <strong>{{ page.id }}</strong>
          <small v-if="page.openerPageId">来自 {{ page.openerPageId }}</small>
        </span>
        <code :title="page.url">{{ page.url }}</code>
      </button>
      <span v-if="props.pages.length === 0" class="pages-empty">正在识别 page0…</span>
    </nav>

    <footer data-cy="recording-page-warning">
      站点可能通过 X-Frame-Options 或 CSP frame-ancestors 拒绝嵌入。此 iframe 与录制 Chromium
      不是同一会话，登录、Cookie 和存储可能不同；在这里或新标签页中的操作暂不由当前录制器捕获。
    </footer>
  </section>
</template>

<style scoped>
.page-preview-card {
  min-width: 0;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.page-preview-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 62px;
  padding: 0.8rem 0.9rem;
  border-bottom: 1px solid #eef2f7;
}

.page-preview-card > header span {
  color: #4f46e5;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-preview-card > header h4 {
  margin: 0.15rem 0 0;
  color: #1e293b;
  font-size: 0.9rem;
}

.page-preview-card > header a {
  padding: 0.38rem 0.62rem;
  color: #3730a3;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 7px;
  font-size: 0.68rem;
  font-weight: 700;
  text-decoration: none;
}

.page-url-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin: 0.75rem 0.85rem 0;
  padding: 0.48rem 0.58rem;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.page-url-row strong {
  flex: 0 0 auto;
  color: #4338ca;
  font-size: 0.67rem;
}

.page-url-row code {
  overflow: hidden;
  font-size: 0.6rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-frame-shell {
  position: relative;
  aspect-ratio: 16 / 10;
  min-height: 300px;
  margin: 0.65rem 0.85rem 0.85rem;
  overflow: hidden;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
}

.page-frame-shell iframe {
  width: 100%;
  height: 100%;
  background: #ffffff;
  border: 0;
}

.page-frame-empty {
  display: grid;
  height: 100%;
  place-items: center;
  padding: 1.5rem;
  color: #64748b;
  text-align: center;
  font-size: 0.72rem;
}

.page-strip {
  display: flex;
  gap: 0.45rem;
  margin: 0 0.85rem 0.85rem;
  overflow-x: auto;
  padding-bottom: 0.1rem;
}

.page-strip button {
  display: grid;
  min-width: 170px;
  max-width: 240px;
  flex: 1 0 170px;
  gap: 0.28rem;
  padding: 0.48rem 0.58rem;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}

.page-strip button.active {
  color: #3730a3;
  background: #eef2ff;
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.12);
}

.page-strip button > span {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.45rem;
}

.page-strip strong {
  font-size: 0.67rem;
}

.page-strip small {
  color: #94a3b8;
  font-size: 0.55rem;
}

.page-strip code {
  overflow: hidden;
  font-size: 0.58rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pages-empty {
  padding: 0.65rem;
  color: #94a3b8;
  font-size: 0.68rem;
}

.page-preview-card > footer {
  padding: 0.7rem 0.9rem;
  color: #92400e;
  background: #fffbeb;
  border-top: 1px solid #fde68a;
  font-size: 0.65rem;
  line-height: 1.55;
}

@media (max-width: 640px) {
  .page-frame-shell {
    min-height: 220px;
  }
}
</style>
