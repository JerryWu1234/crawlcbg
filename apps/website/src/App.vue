<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";

const route = useRoute();
const apiOnline = ref<boolean | null>(null);

const pageTitle = computed(() => {
  if (route.path.startsWith("/database")) return "SQLite 数据管理 (Data Manager)";
  if (route.path.startsWith("/scripts")) return "插件脚本管理 (Script Manager)";
  return "标签页管理 (Tab Manager)";
});

const pageSubtitle = computed(() => {
  if (route.path.startsWith("/database")) return "可视化浏览、精准检索、出与管理 SQLite 爬取数据表";
  if (route.path.startsWith("/scripts"))
    return "AI 智能生成、语法测试、实时运行与 Trace 视觉回原复盘";
  return "管理并接管已打开的 Chrome 标签页";
});

const checkHealth = async () => {
  try {
    const res = await fetch("http://localhost:3001/health");
    apiOnline.value = res.ok;
  } catch {
    apiOnline.value = false;
  }
};

onMounted(() => {
  checkHealth();
  setInterval(checkHealth, 10000);
});
</script>

<template>
  <div class="admin-layout">
    <!-- Left Sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-logo">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
        </div>
        <div class="brand-text">
          <span class="brand-title">CrawlCBG</span>
          <span class="brand-sub">控制台 Platform</span>
        </div>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-section-label">管理菜单</div>
        <RouterLink to="/tabs" class="nav-item" active-class="active">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="3" y1="9" x2="21" y2="9"></line>
            <line x1="9" y1="21" x2="9" y2="9"></line>
          </svg>
          <span>浏览器 Tab 管理</span>
        </RouterLink>

        <RouterLink to="/scripts" class="nav-item" active-class="active">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
          <span>插件脚本管理</span>
        </RouterLink>

        <RouterLink to="/database" class="nav-item" active-class="active">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
          </svg>
          <span>SQLite 数据管理</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="server-status">
          <span
            class="status-dot"
            :class="{ online: apiOnline === true, offline: apiOnline === false }"
          ></span>
          <span class="status-text">
            {{
              apiOnline === true
                ? "后台服务连线中"
                : apiOnline === false
                  ? "后台服务离线"
                  : "检查服务中..."
            }}
          </span>
        </div>
      </div>
    </aside>

    <!-- Main Content Area -->
    <div class="main-wrapper">
      <header class="top-header">
        <div class="header-left">
          <h2 class="page-header-title">{{ pageTitle }}</h2>
          <span class="header-subtitle">{{ pageSubtitle }}</span>
        </div>

        <div class="header-right">
          <div class="status-badge" :class="{ online: apiOnline === true }">
            <span class="dot"></span>
            <span>API: Port 3001</span>
          </div>
        </div>
      </header>

      <main class="content-area">
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  min-height: 100vh;
  background-color: var(--bg-main, #f8fafc);
}

/* Sidebar */
.sidebar {
  width: 260px;
  background-color: var(--bg-sidebar, #ffffff);
  border-right: 1px solid var(--border-color, #e2e8f0);
  display: flex;
  flex-direction: column;
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 20;
}

.brand {
  padding: 1.5rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border-bottom: 1px solid var(--border-color, #e2e8f0);
}

.brand-logo {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 10px rgba(79, 70, 229, 0.25);
}

.brand-text {
  display: flex;
  flex-direction: column;
}

.brand-title {
  font-weight: 700;
  font-size: 1.1rem;
  color: #0f172a;
  letter-spacing: -0.3px;
}

.brand-sub {
  font-size: 0.75rem;
  color: #64748b;
}

.sidebar-nav {
  flex: 1;
  padding: 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.nav-section-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0 0.5rem 0.5rem 0.5rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  color: #475569;
  font-weight: 500;
  font-size: 0.95rem;
  transition: all 0.2s ease;
}

.nav-item:hover {
  background-color: #f1f5f9;
  color: #0f172a;
}

.nav-item.active {
  background-color: #e0e7ff;
  color: #4f46e5;
  font-weight: 600;
}

.sidebar-footer {
  padding: 1rem;
  border-top: 1px solid var(--border-color, #e2e8f0);
}

.server-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #64748b;
  background-color: #f8fafc;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #cbd5e1;
}

.status-dot.online {
  background-color: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
}

.status-dot.offline {
  background-color: #ef4444;
}

/* Main Content Area */
.main-wrapper {
  margin-left: 260px;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-width: 0;
  overflow-x: hidden;
}

.top-header {
  height: 70px;
  background-color: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-color, #e2e8f0);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2rem;
  position: sticky;
  top: 0;
  z-index: 10;
}

.page-header-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.header-subtitle {
  font-size: 0.85rem;
  color: #64748b;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.35rem 0.8rem;
  border-radius: 999px;
  background-color: #f1f5f9;
  color: #64748b;
  border: 1px solid #e2e8f0;
}

.status-badge.online {
  background-color: #ecfdf5;
  color: #047857;
  border-color: #a7f3d0;
}

.status-badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: currentColor;
}

.content-area {
  padding: 2rem;
  flex: 1;
  max-width: 1400px;
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
}
</style>
