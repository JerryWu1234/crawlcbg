import type { ArchitectureConnection, ArchitectureParticipant } from "../types/flow";

export const participants: ArchitectureParticipant[] = [
  {
    id: "actor-user",
    label: "用户",
    detail: "选择页面、编辑脚本、启动执行并检查数据。",
    boundary: "browser",
    sourceIds: ["src-router"],
  },
  {
    id: "actor-spa",
    label: "Vue SPA",
    detail: "Tabs、Scripts、Database 三个工作台视图与临时 UI 状态。",
    boundary: "browser",
    sourceIds: ["src-router", "src-scripts-view", "src-tabs-view", "src-db-view"],
  },
  {
    id: "actor-fastify",
    label: "Fastify API",
    detail: "HTTP/SSE 编排、文件 I/O、执行注册表和 Trace API。",
    boundary: "node",
    sourceIds: ["src-server-scripts", "src-execution", "src-db-routes"],
  },
  {
    id: "actor-runner",
    label: "动态 Runner",
    detail: "在 Fastify 进程内转译并调用用户脚本 AsyncFunction。",
    boundary: "node",
    sourceIds: ["src-execution", "src-cancel"],
  },
  {
    id: "actor-chrome",
    label: "Chrome / CDP",
    detail: "外部浏览器 pages 与真实页面副作用。",
    boundary: "external",
    sourceIds: ["src-server-tabs", "src-execution"],
  },
  {
    id: "actor-ai",
    label: "AI Provider",
    detail: "通过 OpenAI-compatible API 返回候选脚本。",
    boundary: "external",
    sourceIds: ["src-ai"],
  },
  {
    id: "actor-fs",
    label: "Local Artifacts",
    detail: "scripts、history、pinned JSON、trace JSON 与 JPEG。",
    boundary: "storage",
    sourceIds: ["src-server-scripts", "src-pinned", "src-trace"],
  },
  {
    id: "actor-sqlite",
    label: "SQLite",
    detail: "cbg_data.db 中由脚本动态创建的表与采集行。",
    boundary: "storage",
    sourceIds: ["src-db-helper", "src-db-routes"],
  },
];

export const connections: ArchitectureConnection[] = [
  {
    id: "connection-user-spa",
    from: "actor-user",
    to: "actor-spa",
    label: "操作工作台",
    protocol: "DOM / Vue events",
  },
  {
    id: "connection-spa-fastify",
    from: "actor-spa",
    to: "actor-fastify",
    label: "命令与流",
    protocol: "HTTP JSON / SSE",
  },
  {
    id: "connection-fastify-runner",
    from: "actor-fastify",
    to: "actor-runner",
    label: "同进程调用",
    protocol: "AsyncFunction",
  },
  {
    id: "connection-runner-chrome",
    from: "actor-runner",
    to: "actor-chrome",
    label: "页面自动化",
    protocol: "Stagehand / CDP",
  },
  {
    id: "connection-fastify-ai",
    from: "actor-fastify",
    to: "actor-ai",
    label: "生成候选源码",
    protocol: "OpenAI-compatible HTTPS",
  },
  {
    id: "connection-fastify-fs",
    from: "actor-fastify",
    to: "actor-fs",
    label: "读写产物",
    protocol: "Node fs / process.cwd()",
  },
  {
    id: "connection-runner-sqlite",
    from: "actor-runner",
    to: "actor-sqlite",
    label: "查询与副作用",
    protocol: "better-sqlite3",
  },
  {
    id: "connection-fastify-sqlite",
    from: "actor-fastify",
    to: "actor-sqlite",
    label: "数据管理 API",
    protocol: "SQL",
  },
];
