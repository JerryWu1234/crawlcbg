# CrawlCBG Cypress E2E 测试体系规划

> 实施状态（2026-08-31）：普通 stub 与真实 P0 场景现已收敛到唯一的 `e2e/cypress.config.ts`、`vp run e2e` 和 `vp run e2e:open`。统一 harness 会构建 server，并管理动态端口、临时 runtime 和独立 Chrome profile；当前操作方式与覆盖清单以 `e2e/README.md` 为准。下文保留首期分阶段设计背景，不再作为运行命令说明。

## 1. 决策摘要

CrawlCBG 的 E2E runner 统一使用 Cypress。测试代码放在仓库根目录独立的 `e2e/` 项目中，并按用户功能组织到 `e2e/features/<feature>/`。

首期采用“Cypress 驱动 website + `cy.intercept` 提供确定性 API 响应”的方式，覆盖真实用户导航、加载、空状态、错误和恢复操作。这一层只需要 website，不连接真实 server、Stagehand、LLM、数据库或开发者 Chrome。

后续真实全栈测试分阶段接入。CrawlCBG 自身会通过 Stagehand/CDP 控制 Chrome，而 Cypress 也运行在浏览器中，因此必须保持两个浏览器角色完全分离：

- Cypress 浏览器：只操作 CrawlCBG website；
- 受管 Chrome：只作为 CrawlCBG 的自动化、执行和录制目标。

不能让 Cypress 页面进入 Stagehand 的 page context，否则会造成 tab index 漂移、测试页面被 activate/导航/关闭以及 teardown 破坏 Stagehand 连接。

## 2. 目标与非目标

### 2.1 目标

- 根 `package.json` 提供一个可重复执行的 `vp run e2e` 命令。
- 在 website 已按固定地址启动时，`vp run e2e` 直接运行 Cypress 并返回其退出码。
- 所有用户功能拥有独立测试目录。
- 新增或修改用户功能时，在同一规划和改动中同步增加或更新 Cypress E2E。
- 首批测试不依赖 server、Stagehand、真实 Chrome、真实 LLM 或开发数据。
- 后续全栈场景使用临时运行目录、独立端口和独立 Chrome profile。

### 2.2 非目标

- 不把所有字段校验、内部状态分支和算法边界都改写为 E2E。
- 不通过固定 sleep、放宽断言或大量 retry 掩盖不稳定。
- 不在 PR 默认测试中访问真实业务网站、真实账号或真实模型。
- 不在首期 Cypress 测试中伪造“已验证录制、manual-step 或后台窗口”；这些需要独立 CDP harness。
- 不为测试顺便重构无关业务代码。

## 3. 当前仓库约束

- website 多处直接请求 `http://localhost:3001`。
- server 启动时会尝试连接 Stagehand，失败时可能等待约 12 秒。
- SQLite、scripts、history、traces 和 pinned tabs 当前依赖 `process.cwd()`。
- Stagehand、execution coordinator、recording coordinator 都有进程级共享状态。
- execution 与 recording 互斥，background execution 还有窗口所有权状态。
- execution/recording SSE 和部分控制接口要求可信 localhost `Origin`。
- manual-step 使用 isolated world、closed shadow root 和 `event.isTrusted`，Cypress 无法直接在另一个 Chrome 进程中用普通 DOM 命令完成。
- background 模式依赖 headed Chrome、CDP target/window API 和操作系统窗口最小化能力。

这些约束决定了测试必须分层，不能一开始就让所有场景连接开发者当前使用的 3001 server 和 9222 Chrome。

## 4. 根目录结构

```text
e2e/
├── README.md
├── cypress.config.ts
├── tsconfig.json
├── support/
│   ├── e2e.ts
│   └── api-stubs.ts
├── features/
│   ├── shell/
│   │   └── navigation.cy.ts
│   ├── tabs/
│   │   └── states.cy.ts
│   ├── scripts/
│   ├── database/
│   ├── traces/
│   ├── execution/
│   ├── recording/
│   └── manual-step/
└── artifacts/                    # screenshots/downloads，Git 忽略
```

目录规则：

- 测试文件只能放在对应 `features/<feature>/` 下。
- 只服务一个功能的 helper 和数据与该功能放在一起；至少两个功能复用后才提升到 `support/`。
- 测试统一命名为 `*.cy.ts`。
- 优先使用原生语义、可见文本、`href`、label 和 button；只有缺乏稳定语义时才增加少量 `data-cy`。
- 不预先建立大型 Page Object 层。重复行为稳定出现后再提取。

## 5. 命令与运行方式

根 `package.json` 提供：

```json
{
  "scripts": {
    "e2e": "vp run e2e:run"
  }
}
```

根 `vite.config.ts` 定义不可缓存的 Cypress 任务：

```ts
run: {
  tasks: {
    "e2e:run": {
      command: "vp exec cypress run --project e2e",
      cache: false,
    },
  },
}
```

这样保留其他 Vite Task 的缓存，同时确保每次 `vp run e2e` 都真实运行 Cypress，而不是回放缓存结果。

先在一个终端固定启动 website：

```bash
vp run --filter ./apps/website dev -- --host 127.0.0.1 --port 5173 --strictPort
```

再在另一个终端运行：

```bash
vp run e2e
```

Cypress 固定连接 `http://127.0.0.1:5173`。E2E 命令本身不再负责启动或关闭 website，也不启动根 `dev`，避免连带启动真实 server、Stagehand 和开发者 Chrome。

## 6. 测试分层

| 层级                | 内容                                                                       | 外部依赖                 | 默认 PR gate   |
| ------------------- | -------------------------------------------------------------------------- | ------------------------ | -------------- |
| UI journey          | website 路由、状态、表单和用户恢复操作；API 由 `cy.intercept` 控制         | 只有 website             | 是             |
| Core full-stack     | website + 真实 server + 临时 scripts/DB/traces；禁用 browser eager connect | 临时 runtime             | Phase 2 后启用 |
| Browser integration | tabs、visible execution、recording；独立受管 Chrome                        | server + 独立 CDP Chrome | 稳定后启用     |
| Platform browser    | manual-step trusted input、background window/minimize/cleanup              | headed Chrome + OS       | nightly/手动   |
| External contract   | 真实 LLM 或真实网站 smoke                                                  | 外部网络/凭据            | 仅显式 opt-in  |

首批 UI journey 属于用户视角的浏览器流程，但因为 API 被 stub，不应把它描述成真实全栈覆盖。真实 server 行为继续由现有 Vitest 和后续 full-stack 层负责。

## 7. 首批实际测试内容

### 7.1 `features/shell/navigation.cy.ts`

用户旅程：

1. 用户访问 `/`；
2. 应用重定向到 `/tabs`；
3. 用户看到 Tab Manager 标题和后台在线状态；
4. 用户点击“插件脚本管理”，看到 Script Manager；
5. 用户点击“SQLite 数据管理”，看到 Data Manager；
6. 各页面挂载请求均收到确定性的空数据响应。

保护的风险：路由失效、导航链接错误、页面标题与 RouterView 不同步、页面首次请求导致崩溃。

### 7.2 `features/tabs/states.cy.ts`

场景一：加载到空状态。

- 延迟 `/api/tabs` 响应以观察 loading；
- 断言“正在读取已打开的浏览器标签页...”可见；
- 返回空 tabs/scripts/pinned；
- 断言“未找到匹配的标签页”和 Chrome 空状态说明。

场景二：错误后重试恢复。

- 第一次 `/api/tabs` 返回 503；
- 断言“后台 API 连接错误”和“重试连接”；
- 用户点击重试；
- 第二次返回空成功响应；
- 断言错误消失并进入空状态。

保护的风险：请求错误被吞掉、重试按钮失效、loading 永不结束、失败恢复后未继续加载 scripts。

## 8. API stub 规则

首批共享 stub 只覆盖页面真实会请求的接口：

```text
GET http://localhost:3001/health
GET http://localhost:3001/api/tabs
GET http://localhost:3001/api/tabs/pinned
GET http://localhost:3001/api/scripts
GET http://localhost:3001/api/db/tables
```

规则：

- 所有 intercept 必须在 `cy.visit()` 前注册。
- 每次 visit 前删除 `crawlcbg.tabs.background-execution`，防止本地残留触发后台轮询。
- stub 响应形状必须与真实 server 契约一致，不能为了测试方便虚构字段。
- health intercept 不能只响应一次，因为 App 每 10 秒轮询。
- 测试只断言用户可见行为，不断言 Vue ref、组件私有状态或 CSS 实现细节。

## 9. Cypress 与 CrawlCBG 双浏览器方案

Cypress 擅长操作自己的 AUT（Application Under Test）浏览器，但 CrawlCBG 的核心能力需要操作另一套 Chrome。后续 browser integration 必须通过 Cypress Node process 中的 `setupNodeEvents`/`cy.task` 或独立 harness 管理第二个 Chrome：

```text
Cypress browser
  └── website --> server --> Stagehand --> managed Chrome --> local fixture site

Cypress Node process
  ├── 创建临时 runtime
  ├── 启动 managed Chrome + 独立 user-data-dir
  ├── 将 CDP_URL 传给 server
  ├── 提供受限的状态查询/真实输入 task
  └── 按顺序关闭 server、Chrome 和临时目录
```

重要限制：

- Cypress 普通 `cy.get/click/type` 只能作用于 AUT，不能直接作用于第二个 Chrome。
- manual-step 的 trusted click 需要 Node/CDP 输入事件或专用浏览器驱动，不能用 `dispatchEvent` 伪造。
- SSE streaming 不应依赖 `cy.intercept` 模拟完整协议；execution/recording 测试应连接真实本地 server。
- 第二个 Chrome 必须使用本地 fixture site，不得默认访问真实业务网站。

## 10. 全栈测试前必须增加的隔离接口

| 配置                           | 用途                                  | 默认行为                     |
| ------------------------------ | ------------------------------------- | ---------------------------- |
| `VITE_API_BASE_URL`            | website 指向测试 server               | 保持 `http://localhost:3001` |
| `PORT`                         | 每次测试独立 server 端口              | `3001`                       |
| `CBG_PUBLIC_API_URL`           | trace frame URL 使用正确端口          | 从 `PORT` 推导               |
| `CBG_RUNTIME_DIR`              | 隔离 scripts/history/traces/DB/pinned | 保持当前 cwd                 |
| `CBG_CONNECT_BROWSER_ON_START` | core 测试跳过 Stagehand 启动等待      | 保持当前行为                 |
| test env 隔离                  | 不读取根 `.env` 和真实 LLM secret     | 非 test 保持当前 dotenv 行为 |
| `CDP_URL`                      | 指向每次测试独立受管 Chrome           | 保持当前默认值               |

测试模式缺少 `CBG_RUNTIME_DIR` 时应直接拒绝启动，不能静默回退到开发目录。

## 11. 风险矩阵

| 优先级 | 风险                              | 后果                                      | 缓解措施                                                              |
| ------ | --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| P0     | Cypress 与 Stagehand 共用 Chrome  | tab index 漂移、AUT 被导航/关闭、连接失效 | 两个浏览器进程和两个 profile                                          |
| P0     | 测试使用当前 cwd                  | 污染或删除开发 DB、scripts、traces        | 临时 runtime、marker、realpath 删除保护                               |
| P0     | 测试继承真实 `.env`/CI secrets    | 调用真实 LLM/外站、费用或泄密             | 最小环境 allowlist、test 模式跳过根 dotenv、阻断外网                  |
| P0     | 用户脚本可执行任意代码            | CI 文件和 secret 暴露                     | 只执行固定 fixture 脚本，E2E job 不提供生产 secret                    |
| P1     | `cy.intercept` 测试被误称全栈     | server 回归未被发现                       | 文档和 CI 明确 UI journey 与 full-stack 层级                          |
| P1     | shared singleton/lease 未释放     | 后续测试持续 busy                         | browser 层单 worker、每测试清理、失败后重启 worker server             |
| P1     | website 未启动或端口漂移          | Cypress 无法访问 baseUrl                  | 使用文档中的固定 5173 + strictPort 启动命令，其他地址显式设置环境变量 |
| P1     | SSE/CDP 时序抖动                  | flaky                                     | 事件驱动等待，不使用固定 sleep，不断言精确帧数/时间                   |
| P1     | manual-step artifact 泄密         | screenshot/trace 暴露输入                 | 合成 canary、privacy-lock 断言、失败 artifact 短期保留                |
| P2     | Cypress 不能直接操作第二个 Chrome | manual/background 难以实现                | Node task/CDP harness，平台测试独立分组                               |
| P2     | background 依赖 headed/OS         | CI 跨平台不稳定                           | 独立 nightly job，目标平台稳定后再考虑 gate                           |
| P2     | Cypress binary 较大               | 安装和 CI 缓存耗时                        | 精确 pin 版本，缓存 Cypress binary，不频繁升级                        |
| P2     | E2E 数量无限增长                  | CI 变慢、维护成本高                       | 每功能只保留关键 happy path 和最高风险用户失败路径                    |

## 12. 分阶段实施

### Phase 1：Cypress 基础与 UI journey

- 精确安装 Cypress；
- 根 `e2e/`、配置、support 和按功能目录；
- 实现 shell navigation 与 tabs states 三条测试；
- 根 `package.json` 增加 `e2e`；
- `AGENTS.md` 写入功能规划必须同步 E2E 的规则；
- 本地或 CI 先启动 website，再通过 `vp run e2e` 运行。

验收：website 在固定地址运行时三条测试通过；不需要 server/Chrome/LLM；Git 工作区除预期源码外无运行产物。

### Phase 2：Core full-stack

- 集中 website API base；
- server 支持临时 runtime、动态 public URL 和禁用 eager Stagehand；
- Cypress Node event 启动隔离 server；
- scripts、database、traces 功能各增加真实 server 用户旅程。

验收：只写临时目录；运行前后开发数据不变；失败后 server 退出。

### Phase 3：Tabs 与 visible execution

- 启动独立受管 Chrome 和本地 fixture site；
- 覆盖 tabs discover/activate/ensure、target stale、visible execution 和 cancel；
- server、Cypress browser、受管 Chrome 生命周期完全分离。

验收：AUT 不出现在 `/api/tabs`；不需要手工启动 9222 Chrome；lease 和进程可回收。

### Phase 4：Recording 与 manual-step

- 覆盖录制、popup、exclude cascade、生成/保存和 manual conversion；
- Node/CDP task 提供第二个 Chrome 中的真实输入；
- 加入敏感 canary 和 privacy-lock 断言。

验收：canary 不进入响应、生成脚本或产品 trace；manual-step 后不再新增 frame。

### Phase 5：Background 与 CI 分层

- 覆盖最小化窗口、断线恢复和 cleanup ownership；
- UI journey 作为 PR gate；browser 稳定后加入 merge gate；platform browser 先 nightly；
- 收集 flaky、耗时和清理失败数据后再决定并行化。

## 13. 新功能 E2E 规则

每次规划或实现用户可见功能时必须：

1. 在功能方案中列出对应 Cypress 用户旅程；
2. 在 `e2e/features/<feature>/` 新增或更新测试；
3. 至少覆盖关键 happy path；涉及数据、权限、隐私、恢复时再覆盖最高风险失败路径；
4. 启动 website 后运行 `vp run e2e`；
5. 若客观上无法使用 Cypress 覆盖，必须在方案中明确原因、替代测试和后续补测任务，不能静默省略。

## 14. 完成定义

- [ ] 根 `e2e/` 是独立 Cypress 项目，测试按功能分目录。
- [ ] 根 `package.json` 提供 `vp run e2e` 对应命令。
- [ ] `vp run e2e` 直接执行不可缓存的 Cypress 任务并返回其退出码。
- [ ] 文档明确 website 的固定启动命令和 Cypress baseUrl。
- [ ] shell 与 tabs 首批三条测试通过。
- [ ] 测试不请求真实 server、Stagehand、LLM 或开发者 Chrome。
- [ ] Cypress artifacts 被 Git 忽略。
- [ ] `AGENTS.md` 要求功能规划和实现同步 E2E。
- [ ] `vp check`、`vp test`、build 和 website 启动后的 `vp run e2e` 全部通过。
