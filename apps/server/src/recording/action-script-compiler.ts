import type {
  ManualControlKind,
  ManualStepAction,
  ManualStepTarget,
  RecordedAction,
  RecordingSession,
} from "./recording-types.js";

const ACTION_LABELS = {
  click: "点击",
  fill: "输入",
  select: "选择",
  setChecked: "设置勾选状态",
  press: "按键",
  scroll: "滚动",
  closePage: "关闭页面",
  manualStep: "人工操作",
} as const;

const MAX_MANUAL_STEP_TARGETS = 50;

const MANUAL_CONTROL_KINDS = new Set<ManualControlKind>([
  "text",
  "secret",
  "select",
  "multiSelect",
  "checkbox",
  "radioGroup",
  "date",
  "custom",
]);

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

const safeManualTargets = (action: ManualStepAction): ManualStepTarget[] => {
  if (!Array.isArray(action.targets) || action.targets.length === 0) {
    throw new Error(`动作 ${action.id} (manualStep) 至少需要一个目标控件。`);
  }
  if (action.targets.length > MAX_MANUAL_STEP_TARGETS) {
    throw new Error(
      `动作 ${action.id} (manualStep) 最多支持 ${MAX_MANUAL_STEP_TARGETS} 个目标控件。`,
    );
  }
  return action.targets.map((target, index) => {
    if (!target || typeof target.selector !== "string" || !target.selector) {
      throw new Error(`动作 ${action.id} 的第 ${index + 1} 个人工目标缺少 selector。`);
    }
    if (!MANUAL_CONTROL_KINDS.has(target.controlKind)) {
      throw new Error(`动作 ${action.id} 的第 ${index + 1} 个人工目标类型无效。`);
    }
    if (typeof target.displayName !== "string" || !target.displayName.trim()) {
      throw new Error(`动作 ${action.id} 的第 ${index + 1} 个人工目标缺少显示名称。`);
    }
    if (target.required !== undefined && typeof target.required !== "boolean") {
      throw new Error(`动作 ${action.id} 的第 ${index + 1} 个人工目标 required 无效。`);
    }
    return {
      selector: target.selector,
      controlKind: target.controlKind,
      displayName: target.displayName.trim(),
      ...(target.required !== undefined ? { required: target.required } : {}),
    };
  });
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
    case "manualStep": {
      if (typeof action.title !== "string" || !action.title.trim()) {
        throw new Error(`动作 ${action.id} (manualStep) 缺少标题。`);
      }
      const options = {
        title: action.title.trim(),
        targets: safeManualTargets(action),
      };
      return `await manual.wait(${pageId}, ${serialize(options, "manualStep options")});`;
    }
    default: {
      const unsupportedType: never = action;
      throw new Error(`不支持的录制动作类型：${String(unsupportedType)}`);
    }
  }
};

const includedActionsWithManualGroups = (recording: RecordingSession): RecordedAction[] => {
  for (const action of recording.actions) {
    if (!Number.isFinite(action.order)) {
      throw new Error(`动作 ${action.id} 的 order 必须是有限数字。`);
    }
  }

  const ordered = recording.actions
    .map((action, inputIndex) => ({ action, inputIndex }))
    .sort(
      (left, right) => left.action.order - right.action.order || left.inputIndex - right.inputIndex,
    );
  const result: RecordedAction[] = [];
  let pendingManual: ManualStepAction | null = null;
  const flushManual = (): void => {
    if (!pendingManual) return;
    result.push(pendingManual);
    pendingManual = null;
  };

  for (const { action } of ordered) {
    if (action.included === false) {
      flushManual();
      continue;
    }
    if (action.type !== "manualStep") {
      flushManual();
      result.push(action);
      continue;
    }
    let targets = action.targets
      .filter(
        (target, index, allTargets) =>
          allTargets.findIndex(
            (candidate) =>
              candidate.selector === target.selector &&
              candidate.controlKind === target.controlKind,
          ) === index,
      )
      .map((target) => ({ ...target }));
    if (
      pendingManual &&
      pendingManual.pageId === action.pageId &&
      pendingManual.title === action.title
    ) {
      targets = targets.filter(
        (target) =>
          !pendingManual?.targets.some(
            (candidate) =>
              candidate.selector === target.selector &&
              candidate.controlKind === target.controlKind,
          ),
      );
      if (targets.length === 0) continue;
      if (pendingManual.targets.length + targets.length <= MAX_MANUAL_STEP_TARGETS) {
        pendingManual.targets.push(...targets);
        continue;
      }
    }
    flushManual();
    pendingManual = {
      ...action,
      targets,
    };
  }
  flushManual();
  return result;
};

export const compileRecordingToScript = (recording: RecordingSession): string => {
  const actions = includedActionsWithManualGroups(recording);
  const lines = [
    "export default async function run({ page, log, pace, manual }) {",
    "  const page0 = page;",
  ];

  for (const action of actions) {
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
  ManualControlKind,
  ManualStepTarget,
  RecordedAction,
  RecordedActionType,
  RecordedPage,
  RecordingSession,
  RecordingStatus,
} from "./recording-types.js";
