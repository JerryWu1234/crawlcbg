import type { SourceRef } from "../types/flow";

export const sourceIndex: SourceRef[] = [
  {
    id: "src-workspace",
    path: "pnpm-workspace.yaml",
    symbol: "packages / catalog",
    claim: "apps/* 自动纳入工作区，前端应用共享 Vue、TypeScript 与 Vite+ catalog。",
  },
  {
    id: "src-router",
    path: "apps/website/src/router/index.ts",
    symbol: "routes",
    claim: "现有工作台由 /tabs、/scripts 与 /database 三个主要视图组成。",
  },
  {
    id: "src-scripts-view",
    path: "apps/website/src/views/ScriptsView.vue",
    symbol: "fetchScripts / selectScript / saveScript / runScript / generateScriptWithAi",
    claim: "脚本工作台负责读取、编辑、校验、保存、AI 生成与启动 SSE 执行。",
  },
  {
    id: "src-editor",
    path: "apps/website/src/components/scripts/ScriptCodeEditor.vue",
    symbol: "CodeMirror editor lifecycle",
    claim: "脚本源码在 CodeMirror 中编辑并回传到 ScriptsView。",
  },
  {
    id: "src-params",
    path: "apps/website/src/utils/scriptParams.ts",
    symbol: "parseJSDocParams",
    claim: "JSDoc 注释被解析为 string、number、boolean 或 select 参数字段。",
  },
  {
    id: "src-server-scripts",
    path: "apps/server/src/index.ts",
    symbol: "/api/scripts routes / saveHistorySnapshot / safeTranspile",
    claim: "服务端读取和保存脚本、创建历史快照，并在执行前转译源码。",
  },
  {
    id: "src-ai",
    path: "apps/server/src/index.ts",
    symbol: "getOpenAIClient / POST /api/scripts/generate-ai",
    claim: "AI 生成通过 OpenAI-compatible 客户端产生候选脚本源码。",
  },
  {
    id: "src-tabs-view",
    path: "apps/website/src/views/TabsView.vue",
    symbol: "fetchTabs / launchPinnedTab / executeScriptWithParams",
    claim: "TabsView 获取页面、解析 pinned 状态并按 tabIndex 启动脚本。",
  },
  {
    id: "src-server-tabs",
    path: "apps/server/src/index.ts",
    symbol: "initStagehand / ensureStagehand / /api/tabs routes",
    claim: "服务端通过 Stagehand/CDP 枚举、激活、创建或导航 Chrome 页面。",
  },
  {
    id: "src-pinned",
    path: "apps/server/src/index.ts",
    symbol: "loadPinnedTabsJSON / savePinnedTabsJSON",
    claim: "Pinned Tabs 持久化在 scripts/.local/pinned_tabs.json。",
  },
  {
    id: "src-execution",
    path: "apps/server/src/index.ts",
    symbol: "GET /api/scripts/execute/stream / sendEvent / sendLog",
    claim: "执行路由注册 runId、准备页面和源码、运行 AsyncFunction，并通过 SSE 发出事件。",
  },
  {
    id: "src-cancel",
    path: "apps/server/src/index.ts",
    symbol: "activeScriptExecutions / POST /api/scripts/execute/:runId/cancel",
    claim: "AbortController 以 runId 注册；取消接口存在，但执行只支持协作式中止。",
  },
  {
    id: "src-trace",
    path: "apps/server/src/index.ts",
    symbol: "sendLog / GET /api/traces / GET /api/traces/:runId",
    claim: "sendLog 写入 trace.json 与 frame_N.jpg；Trace API 读取摘要和详情。",
  },
  {
    id: "src-automation-types",
    path: "apps/website/src/types/automation.ts",
    symbol: "ExecutionLogType / TraceRunSummary / TraceRunDetail",
    claim: "前端声明日志与 Trace 结构，但 ExecutionLogType 尚未包含 cancelled。",
  },
  {
    id: "src-db-routes",
    path: "apps/server/src/index.ts",
    symbol: "/api/db/tables / /api/db/data / /api/db/clear / /api/db/delete-row",
    claim: "数据库管理 API 负责表枚举、分页读取、清空与删除行。",
  },
  {
    id: "src-db-helper",
    path: "apps/server/src/db.ts",
    symbol: "db / createTable / query / upsert",
    claim: "注入脚本的 db helper 使用 SQLite，并以 INSERT OR REPLACE 实现 upsert。",
  },
  {
    id: "src-db-view",
    path: "apps/website/src/views/DatabaseView.vue",
    symbol: "fetchTables / fetchTableData / primaryKeyCol / exportData",
    claim: "DatabaseView 选择表、分页展示、推测主键并导出当前已加载数据。",
  },
  {
    id: "src-youtube-script",
    path: "apps/server/scripts/04_youtube_feed.mjs",
    symbol: "run",
    claim: "示例脚本展示参数化采集与 db.upsert 副作用；saveToDb 分支目前未阻止写库。",
  },
];
