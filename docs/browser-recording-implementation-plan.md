****# 浏览器操作录制与脚本生成实施计划

## 1. 背景与目标

在现有 Tabs 页面中，用户选择一个真实 Chrome 标签页并开始录制。用户随后在 Chrome 中完成一次操作流程，系统记录可回放的业务动作。录制结束后，用户可以取消不需要的步骤，并将保留步骤确定性地生成一个 JavaScript ES Module（`.mjs`）脚本。

生成的脚本继续复用项目现有的脚本校验、保存、版本历史、执行、日志和 trace 能力。

本计划强调：

- 先冻结最小数据契约，再并行开发；
- 各模块通过简单接口协作，尽量避免修改相同文件；
- 先完成 visible 模式下的 MVP；
- 不构建通用浏览器自动化框架；
- 忽略非核心边缘场景。

## 2. MVP 用户流程

1. 用户进入 Tabs 页面。
2. 用户在某个 tab 卡片上点击“开始录制”。
3. 系统激活对应的真实 Chrome 页面。
4. 用户完成输入、选择、勾选、点击、滚动等操作。
5. 如果点击打开新窗口，系统继续录制新窗口中的操作。
6. Tabs 页面实时展示归并后的业务步骤。
7. 用户取消勾选不需要的步骤。
8. 用户停止录制并输入脚本文件名。
9. 系统确定性生成 `.mjs` 代码。
10. 前端调用现有脚本校验和保存接口。
11. 用户通过现有执行入口回放生成的脚本。

## 3. MVP 范围

### 3.1 支持的动作

- 普通点击；
- 文本输入，多个原始 input 事件归并成一次 `fill`；
- 原生 select 选择；
- checkbox/radio 最终状态设置；
- Enter 等必要按键；
- 页面滚动；
- 关闭由流程打开的新页面；
- 点击后打开一个新 tab 或新窗口；
- 关闭新窗口后继续操作原页面；
- 页面内普通 Modal 或弹层。

### 3.2 明确不做

- 每天自动定时触发；
- background 模式下的 popup 回放；
- 录制过程中切换到与流程无关的已有 Chrome tab；
- 一次点击同时打开多个窗口；
- popup 再打开 popup；
- iframe 和 Shadow DOM；
- 浏览器原生 `alert`、`confirm`、`prompt`；
- 文件上传、下载和拖拽；
- 复杂快捷键、输入法组合事件；
- selector 自动修复；
- 录制 session 持久化或页面刷新恢复；
- AI 生成或修改最终脚本；
- 将密码、验证码或 token 写入生成脚本。

## 4. 简化假设

为避免过度设计，MVP 采用以下假设：

1. 同一时间只允许一个录制 session。
2. 录制开始后持有初始 Page 对象，不依赖 tab index 持续定位。
3. 录制过程中用户不会主动打开无关 tab。
4. 新出现的 Page 归属于最近一次打开窗口的 click。
5. 一次 click 最多创建一个新 Page。
6. 初始页面命名为 `page0`，新页面依次命名为 `page1`、`page2`。
7. 每个元素只保存一个 selector，不保存候选 selector 集合。
8. 用户只能启用或禁用步骤，不支持调整步骤顺序。
9. 输入值默认按固定字面量忠实回放，敏感输入不记录。
10. 录制 session 只保存在服务端内存，最终 `.mjs` 文件才持久化。

## 5. 最小公共契约

公共契约必须在并行开发开始前冻结。服务端和前端可以各自声明 TypeScript 类型，但 JSON 字段、动作名称和 Pace 方法名称不得自行修改。

### 5.1 录制数据模型

```ts
type RecordingStatus = "recording" | "stopped";

type RecordedActionType =
  "click" | "fill" | "select" | "setChecked" | "press" | "scroll" | "closePage";

interface RecordedPage {
  id: string;
  url: string;
  openerPageId?: string;
}

interface RecordedAction {
  id: string;
  order: number;
  pageId: string;
  type: RecordedActionType;
  selector?: string;
  value?: string | boolean | string[] | number;
  included: boolean;
  opensPageId?: string;
}

interface RecordingSession {
  id: string;
  status: RecordingStatus;
  startUrl: string;
  pages: RecordedPage[];
  actions: RecordedAction[];
}
```

### 5.2 Popup 表达方式

打开新页面的行为附着在触发 click 上，不额外创建一个无关联的 open-page 动作：

```json
{
  "id": "action-1",
  "order": 1,
  "pageId": "page0",
  "type": "click",
  "selector": "[data-testid=\"detail\"]",
  "included": true,
  "opensPageId": "page1"
}
```

新页面记录为：

```json
{
  "id": "page1",
  "url": "https://example.com/detail",
  "openerPageId": "page0"
}
```

### 5.3 Selector 生成优先级

只生成一个 CSS selector，固定优先级如下：

1. `data-testid`；
2. 稳定的 `id`；
3. `name`；
4. `aria-label`；
5. 简单 CSS 路径。

MVP 不提供 selector 编辑器和自动修复。

### 5.4 Pace 运行时契约

脚本编译器只允许生成以下调用：

```ts
pace.click(locator);
pace.fill(locator, value);
pace.select(locator, value);
pace.setChecked(locator, checked);
pace.press(page, key);
pace.scrollTo(page, y);
pace.clickAndWaitForNewPage(sourcePage, locator);
pace.closePage(page);
```

编译器和 Pace 开发者必须共同遵守这些方法名称和参数顺序。

### 5.5 HTTP API 契约

```http
POST  /api/recordings
GET   /api/recordings/:id/stream
PATCH /api/recordings/:id/actions/:actionId
POST  /api/recordings/:id/stop
POST  /api/recordings/:id/generate
```

开始录制：

```json
{
  "tabIndex": 0,
  "expectedUrl": "https://example.com"
}
```

更新步骤：

```json
{
  "included": false
}
```

生成代码：

```json
{
  "filename": "daily-flow.mjs"
}
```

生成接口只返回代码，不直接写文件：

```json
{
  "filename": "daily-flow.mjs",
  "code": "export default async function run(...) { ... }"
}
```

前端收到代码后继续调用现有：

```http
POST /api/scripts/validate
POST /api/scripts/save
```

### 5.6 SSE 事件契约

```ts
type RecordingStreamEvent =
  | { type: "started"; recording: RecordingSession }
  | { type: "page-opened"; page: RecordedPage }
  | { type: "action"; action: RecordedAction }
  | { type: "action-updated"; action: RecordedAction }
  | { type: "stopped"; recording: RecordingSession }
  | { type: "error"; message: string };
```

## 6. 并行开发工作流

公共契约冻结后，下面五条工作流可以同时开发。

## 6.1 工作流 A：浏览器录制器

### 文件边界

```text
apps/server/src/recording/browser-recorder.ts
apps/server/src/recording/page-event-script.ts
```

该工作流不修改路由、不管理 session、不生成脚本。

### 输入接口

```ts
interface BrowserRecorderOptions {
  rootPage: unknown;
  getPages: () => unknown[] | Promise<unknown[]>;
  onAction: (action: RecordedAction) => void;
  onPageOpened: (page: RecordedPage) => void;
}

interface BrowserRecorderHandle {
  stop: () => Promise<void>;
}

function startBrowserRecorder(options: BrowserRecorderOptions): Promise<BrowserRecorderHandle>;
```

### 实现内容

- 给当前 Page 执行 `addInitScript()`，保证普通页面导航后仍可安装监听器；
- 给已加载文档执行 `evaluate()`，立即安装监听器；
- 页面内维护一个待上报事件队列；
- 服务端定期读取并清空事件队列；
- 捕获 click、input/change、select、checkbox/radio、Enter 和 scroll；
- 页面内完成基础事件归并；
- 定期比较 `getPages()` 前后结果；
- 发现新 Page 时分配 `page1`，并向新 Page 安装同一录制脚本；
- 将新 Page 关联到最近一次 click 的 `opensPageId`。

### 基础归并规则

- 多个 input 事件最终生成一个 `fill`；
- select 的 click/input/change 生成一个 `select`；
- checkbox/radio 的 click/change 生成一个 `setChecked`；
- 连续 scroll 事件合并成一个最终 scroll 位置；
- 普通 Enter 生成一个 `press`；
- mousemove、keyup、focus 和无业务意义的 blur 不生成动作。

### 独立验收

给定真实 Page 和回调函数，不连接 Fastify，也能输出有序的 `RecordedAction[]`。

## 6.2 工作流 B：确定性脚本编译器

### 文件边界

```text
apps/server/src/recording/action-script-compiler.ts
```

该工作流不连接 Chrome、不依赖 Fastify、不读写脚本文件。

### 接口

```ts
function compileRecordingToScript(recording: RecordingSession): string;
```

### 编译规则

- 过滤 `included === false` 的动作；
- 按 `order` 升序生成；
- 初始 Page 变量固定为 `const page0 = page`；
- 普通动作根据 `pageId` 使用对应页面变量；
- 有 `opensPageId` 的 click 生成 `clickAndWaitForNewPage`；
- `value` 使用 `JSON.stringify()` 安全序列化；
- 每个动作前生成一条 `await log(...)`；
- 不生成 import；
- 输出标准 `export default async function run(...)`；
- 相同输入必须产生完全相同的代码。

### 示例输入

```ts
const recording: RecordingSession = {
  id: "recording-1",
  status: "stopped",
  startUrl: "https://example.com",
  pages: [
    { id: "page0", url: "https://example.com" },
    {
      id: "page1",
      url: "https://example.com/detail",
      openerPageId: "page0",
    },
  ],
  actions: [
    {
      id: "action-1",
      order: 1,
      pageId: "page0",
      type: "click",
      selector: "#detail",
      included: true,
      opensPageId: "page1",
    },
    {
      id: "action-2",
      order: 2,
      pageId: "page1",
      type: "fill",
      selector: "#quantity",
      value: "2",
      included: true,
    },
  ],
};
```

### 预期输出结构

```js
export default async function run({ page, log, pace }) {
  const page0 = page;

  await log("执行步骤 1：点击");
  const page1 = await pace.clickAndWaitForNewPage(page0, page0.locator("#detail").first());

  await log("执行步骤 2：输入");
  await pace.fill(page1.locator("#quantity").first(), "2");
}
```

### 独立验收

使用手写 Recording fixture 可以生成合法 `.mjs`，并通过现有 `safeTranspile()` 校验。

## 6.3 工作流 C：Pace 回放能力

### 文件边界

```text
apps/server/src/pace.ts
apps/server/src/execution/script-execution-handler.ts
```

这两个文件只由本工作流开发者修改，避免并行冲突。

### 实现内容

在现有 PaceApi 上增加：

```ts
fill();
select();
setChecked();
press();
scrollTo();
clickAndWaitForNewPage();
closePage();
```

将 Pace 创建方式从：

```ts
createPace(page, signal);
```

扩展为类似：

```ts
createPace({
  rootPage,
  getPages: () => stagehand.context.pages(),
  signal,
});
```

### Popup 回放的最小实现

`clickAndWaitForNewPage()`：

1. 点击前获取一次 `getPages()` 快照；
2. 执行 click；
3. 轮询 `getPages()`；
4. 找到一个快照中不存在的新 Page；
5. 等待新 Page 的 `domcontentloaded`；
6. 返回新 Page。

MVP 不校验 opener，也不处理同时出现多个新 Page。

### 独立验收

手写一个 `.mjs`：

```text
page0 点击 -> page1 打开 -> page1 输入 -> 关闭 page1 -> page0 继续
```

在 visible 模式下能够成功执行。

## 6.4 工作流 D：Session、API 与 SSE

### 文件边界

```text
apps/server/src/recording/recording-coordinator.ts
apps/server/src/routes/recording-routes.ts
```

最后由本工作流开发者在以下文件注册路由：

```text
apps/server/src/app.ts
```

### Session Store

使用简单内存 Map：

```ts
Map<string, RecordingSession>;
```

只允许一个 session 处于 `recording` 状态。

### 实现内容

- 根据 `tabIndex + expectedUrl` 取得并固定初始 Page；
- 创建 recording id 和初始 `page0`；
- 调用 BrowserRecorder；
- 接收 recorder 回调并写入 session；
- 通过 SSE 推送 page 和 action；
- 更新动作的 `included`；
- 停止 recorder；
- 调用脚本编译器并返回 code。

### 并行开发方式

在工作流 A 完成前，可以使用假的 BrowserRecorder：

```ts
onAction({
  id: "mock-action",
  order: 1,
  pageId: "page0",
  type: "click",
  selector: "#submit",
  included: true,
});
```

在工作流 B 完成前，generate 接口可以返回固定代码字符串。

### 独立验收

不连接真实录制器时，使用 mock action 也能完成：

```text
start -> SSE action -> update included -> stop -> generate
```

## 6.5 工作流 E：Tabs 录制 UI

### 文件边界

新增：

```text
apps/website/src/components/tabs/RecordingPanel.vue
apps/website/src/composables/useRecording.ts
```

修改：

```text
apps/website/src/types/automation.ts
apps/website/src/views/TabsView.vue
apps/website/src/components/tabs/TabCardsGrid.vue
```

### UI 内容

- tab 卡片上的“开始录制”；
- 当前录制状态；
- SSE 动作时间线；
- `page0`、`page1` 页面标签；
- 每个动作的 include checkbox；
- 停止录制；
- 脚本文件名输入；
- 生成 JS；
- 生成代码预览；
- 校验并保存。

### 简化行为

- 录制时禁止执行脚本；
- 执行脚本时禁止开始录制；
- 不允许拖动调整步骤顺序；
- 不允许编辑 selector；
- 取消打开 `page1` 的 click 时，前端同时取消所有 `page1` 动作；
- 刷新页面后不恢复录制状态。

### 并行开发方式

使用固定的 mock SSE 事件开发，不等待服务端 API：

```json
{
  "type": "action",
  "action": {
    "id": "action-1",
    "order": 1,
    "pageId": "page0",
    "type": "click",
    "selector": "#submit",
    "included": true
  }
}
```

### 独立验收

使用 mock 数据可以完成开始、展示步骤、取消步骤、停止和代码预览的完整 UI 流程。

## 7. 文件所有权与冲突控制

| 工作流          | 独占文件                                                           | 集成时修改的共享文件                                |
| --------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| A. 浏览器录制器 | `recording/browser-recorder.ts`、`recording/page-event-script.ts`  | 无                                                  |
| B. JS 编译器    | `recording/action-script-compiler.ts`                              | 无                                                  |
| C. Pace 回放    | `pace.ts`、`execution/script-execution-handler.ts`                 | 无                                                  |
| D. Session/API  | `recording/recording-coordinator.ts`、`routes/recording-routes.ts` | `app.ts`                                            |
| E. 前端 UI      | `RecordingPanel.vue`、`useRecording.ts`                            | `TabsView.vue`、`TabCardsGrid.vue`、`automation.ts` |

约束：

- 工作流 A 不直接操作 Coordinator；
- 工作流 B 不直接保存文件；
- 工作流 C 不感知 RecordingSession；
- 工作流 D 只做编排，不实现 DOM 事件解析；
- 工作流 E 不复制脚本编译逻辑。

## 8. 开发与集成顺序

## 8.1 阶段 0：冻结契约

必须先完成：

- RecordingSession JSON；
- RecordedAction JSON；
- Pace 方法名称；
- HTTP API；
- SSE 事件格式；
- 一份所有工作流共用的 fixture。

冻结后，除非所有工作流同步确认，否则不再修改字段名称。

## 8.2 阶段 1：五条工作流并行开发

```text
工作流 A：浏览器录制器
工作流 B：JS 编译器
工作流 C：Pace 回放
工作流 D：Session/API/SSE
工作流 E：前端录制 UI
```

每条工作流使用 mock 或 fixture 独立验收。

## 8.3 阶段 2：Recorder 接入 API

集成工作流 A 和 D：

1. start API 找到目标 Page；
2. Coordinator 启动 BrowserRecorder；
3. Recorder action 写入 session；
4. action 通过 SSE 发给前端；
5. stop API 关闭 Recorder。

验收：真实 Chrome 同页面动作可以在 SSE 中看到。

## 8.4 阶段 3：前端接入 API

集成工作流 D 和 E：

1. tab 卡片启动录制；
2. UI 接收并展示 SSE action；
3. checkbox 更新 included；
4. 停止录制。

验收：无需生成脚本，也能完成真实录制和步骤筛选。

## 8.5 阶段 4：编译器接入 Generate API

集成工作流 B 和 D：

1. generate API 读取 stopped session；
2. 调用 `compileRecordingToScript()`；
3. 返回代码；
4. 前端调用现有 validate；
5. 前端调用现有 save。

验收：生成文件出现在现有脚本列表。

## 8.6 阶段 5：生成脚本接入 Pace

集成工作流 B 和 C：

1. 普通 action 映射到 Pace；
2. popup click 映射到 `clickAndWaitForNewPage()`；
3. page1 后续动作使用返回的新 Page；
4. 脚本通过现有 visible 执行入口运行。

验收：录制产生的真实脚本可以完成回放。

## 9. 验收场景

## 9.1 普通页面流程

录制：

```text
输入文本 -> 选择下拉框 -> 勾选 checkbox -> 点击提交
```

预期：

- 事件列表包含 `fill`、`select`、`setChecked` 和 `click`；
- 没有重复 input/change/click 噪声；
- 生成脚本可以在原页面成功执行。

## 9.2 新窗口流程

录制：

```text
page0 点击详情
-> page1 打开
-> page1 输入并点击
-> 关闭 page1
-> page0 继续点击
```

预期：

- 打开窗口的 click 包含 `opensPageId: "page1"`；
- page1 动作包含 `pageId: "page1"`；
- 生成代码创建 `const page1 = await pace.clickAndWaitForNewPage(...)`；
- 脚本完成 page1 操作后可以继续使用 page0。

## 9.3 步骤过滤

录制 A、B、C，取消 C。

预期：

- session 中 C 的 `included` 为 false；
- 生成代码只包含 A、B；
- 如果 A 打开 page1，取消 A 时同时取消所有 page1 动作。

## 10. 完成标准

功能完成需要同时满足：

- [ ] Tabs 页面可以开始和停止录制；
- [ ] 服务端可以录制常用业务动作；
- [ ] 新窗口可以继续录制；
- [ ] 前端可以启用或禁用步骤；
- [ ] 取消 popup 父动作会取消子页面动作；
- [ ] 相同 RecordingSession 总是生成相同代码；
- [ ] 生成代码通过现有语法校验；
- [ ] 生成代码可以保存到现有脚本目录；
- [ ] 普通页面流程可以回放；
- [ ] visible 模式下的新窗口流程可以回放；
- [ ] 执行日志和 trace 继续使用现有能力；
- [ ] `vp check` 通过；
- [ ] `vp test` 通过。

## 11. 推荐人员分工

### 五人并行

| 开发者 | 工作流              |
| ------ | ------------------- |
| A      | 浏览器录制器        |
| B      | 确定性脚本编译器    |
| C      | Pace 和 popup 回放  |
| D      | Session、API 和 SSE |
| E      | Tabs 录制 UI        |

### 三人并行

| 开发者 | 工作流                |
| ------ | --------------------- |
| A      | 浏览器录制器          |
| B      | 编译器和 Pace         |
| C      | Session/API 和前端 UI |

## 12. 后续阶段候选

以下内容仅在 MVP 跑通后评估：

- background 模式 popup 回放；
- 每日定时任务；
- 录制草稿持久化；
- 动态日期和运行参数；
- iframe、原生 dialog、文件上传和下载；
- selector 候选、运行前检查和自动修复；
- 登录态失效检测；
- 多个并发录制或执行任务。
