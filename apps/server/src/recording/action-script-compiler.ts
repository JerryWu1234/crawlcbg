import type { RecordedAction, RecordingSession } from "./recording-types.js";

const ACTION_LABELS = {
  click: "点击",
  fill: "输入",
  select: "选择",
  setChecked: "设置勾选状态",
  press: "按键",
  scroll: "滚动",
  closePage: "关闭页面",
} as const;

const serialize = (value: unknown, field: string): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`录制动作缺少可序列化的 ${field}。`);
  }
  return serialized;
};

const pageVariable = (pageId: string, field: string): string => {
  if (!/^page\d+$/.test(pageId)) {
    throw new Error(`${field} 必须使用 page0、page1 等页面 ID，收到：${pageId}`);
  }
  return pageId;
};

const selectorExpression = (action: RecordedAction, pageId: string): string => {
  if (typeof action.selector !== "string") {
    throw new Error(`动作 ${action.id} (${action.type}) 缺少 selector。`);
  }
  return `${pageId}.locator(${serialize(action.selector, "selector")}).first()`;
};

const stringValue = (action: RecordedAction): string => {
  if (typeof action.value !== "string") {
    throw new Error(`动作 ${action.id} (${action.type}) 的 value 必须是字符串。`);
  }
  return serialize(action.value, "value");
};

const selectValue = (action: RecordedAction): string => {
  const { value } = action;
  if (
    typeof value !== "string" &&
    !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  ) {
    throw new Error(`动作 ${action.id} (select) 的 value 必须是字符串或字符串数组。`);
  }
  return serialize(value, "value");
};

const checkedValue = (action: RecordedAction): string => {
  if (typeof action.value !== "boolean") {
    throw new Error(`动作 ${action.id} (setChecked) 的 value 必须是布尔值。`);
  }
  return serialize(action.value, "value");
};

const scrollValue = (action: RecordedAction): string => {
  if (typeof action.value !== "number" || !Number.isFinite(action.value)) {
    throw new Error(`动作 ${action.id} (scroll) 的 value 必须是有限数字。`);
  }
  return serialize(action.value, "value");
};

const compileAction = (action: RecordedAction): string => {
  const pageId = pageVariable(action.pageId, "pageId");

  switch (action.type) {
    case "click": {
      const locator = selectorExpression(action, pageId);
      if (action.opensPageId) {
        const openedPageId = pageVariable(action.opensPageId, "opensPageId");
        return `const ${openedPageId} = await pace.clickAndWaitForNewPage(${pageId}, ${locator});`;
      }
      return `await pace.click(${locator});`;
    }
    case "fill":
      return `await pace.fill(${selectorExpression(action, pageId)}, ${stringValue(action)});`;
    case "select":
      return `await pace.select(${selectorExpression(action, pageId)}, ${selectValue(action)});`;
    case "setChecked":
      return `await pace.setChecked(${selectorExpression(action, pageId)}, ${checkedValue(action)});`;
    case "press":
      return `await pace.press(${pageId}, ${stringValue(action)});`;
    case "scroll":
      return `await pace.scrollTo(${pageId}, ${scrollValue(action)});`;
    case "closePage":
      return `await pace.closePage(${pageId});`;
    default: {
      const unsupportedType: never = action.type;
      throw new Error(`不支持的录制动作类型：${String(unsupportedType)}`);
    }
  }
};

export const compileRecordingToScript = (recording: RecordingSession): string => {
  const actions = recording.actions
    .map((action, inputIndex) => ({ action, inputIndex }))
    .filter(({ action }) => action.included !== false)
    .sort(
      (left, right) => left.action.order - right.action.order || left.inputIndex - right.inputIndex,
    )
    .map(({ action }) => action);

  const lines = [
    "export default async function run({ page, log, pace }) {",
    "  const page0 = page;",
  ];

  for (const action of actions) {
    if (!Number.isFinite(action.order)) {
      throw new Error(`动作 ${action.id} 的 order 必须是有限数字。`);
    }
    lines.push(
      "",
      `  await log(${serialize(`执行步骤 ${action.order}：${ACTION_LABELS[action.type]}`, "日志")});`,
      `  ${compileAction(action)}`,
    );
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
};

export type {
  RecordedAction,
  RecordedActionType,
  RecordedPage,
  RecordingSession,
  RecordingStatus,
} from "./recording-types.js";
