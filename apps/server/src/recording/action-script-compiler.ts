import { PAGINATION_LOOP_ITEM_ORDINAL_TOKEN } from "./pagination-loop.js";
import type {
  RecordedAction,
  RecordedPaginationLoop,
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

const selectorExpression = (
  action: RecordedAction,
  pageId: string,
  selectorCode?: string,
): string => {
  if (selectorCode === undefined && typeof action.selector !== "string") {
    throw new Error(`动作 ${action.id} (${action.type}) 缺少 selector。`);
  }
  return `${pageId}.locator(${selectorCode ?? serialize(action.selector, "selector")}).first()`;
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

const compileAction = (action: RecordedAction, selectorCode?: string): string => {
  const pageId = pageVariable(action.pageId, "pageId");

  switch (action.type) {
    case "click": {
      const locator = selectorExpression(action, pageId, selectorCode);
      if (action.opensPageId) {
        const openedPageId = pageVariable(action.opensPageId, "opensPageId");
        return `const ${openedPageId} = await pace.clickAndWaitForNewPage(${pageId}, ${locator});`;
      }
      return `await pace.click(${locator});`;
    }
    case "fill":
      return `await pace.fill(${selectorExpression(action, pageId, selectorCode)}, ${stringValue(action)});`;
    case "select":
      return `await pace.select(${selectorExpression(action, pageId, selectorCode)}, ${selectValue(action)});`;
    case "setChecked":
      return `await pace.setChecked(${selectorExpression(action, pageId, selectorCode)}, ${checkedValue(action)});`;
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

const orderedIncludedActions = (recording: RecordingSession): RecordedAction[] =>
  recording.actions
    .map((action, inputIndex) => ({ action, inputIndex }))
    .filter(({ action }) => action.included !== false)
    .sort(
      (left, right) => left.action.order - right.action.order || left.inputIndex - right.inputIndex,
    )
    .map(({ action }) => action);

interface ResolvedPaginationLoop {
  loop: RecordedPaginationLoop;
  bodyActions: RecordedAction[];
  nextAction: RecordedAction;
  startIndex: number;
  endIndex: number;
}

const resolvePaginationLoop = (
  actions: RecordedAction[],
  loop: RecordedPaginationLoop,
): ResolvedPaginationLoop => {
  if (loop.actionIds.length < 2 || new Set(loop.actionIds).size !== loop.actionIds.length) {
    throw new Error("分页循环必须包含不重复的循环体步骤和下一页步骤。");
  }
  if (!Number.isInteger(loop.maxPages) || loop.maxPages < 1 || loop.maxPages > 1_000) {
    throw new Error("分页循环 maxPages 必须是 1 到 1000 之间的整数。");
  }
  if (
    !loop.listSelector ||
    !loop.sourceItemSelector ||
    !loop.itemSelectorTemplate ||
    loop.itemSelectorTemplate.split(PAGINATION_LOOP_ITEM_ORDINAL_TOKEN).length !== 2
  ) {
    throw new Error("分页循环的列表选择器配置无效。");
  }

  const actionIds = new Set(loop.actionIds);
  const indexes = loop.actionIds.map((actionId) =>
    actions.findIndex((action) => action.id === actionId),
  );
  if (indexes.some((index) => index < 0)) {
    throw new Error("分页循环包含不存在或已停用的步骤。");
  }
  const startIndex = Math.min(...indexes);
  const endIndex = Math.max(...indexes);
  const loopActions = actions.slice(startIndex, endIndex + 1);
  if (
    loopActions.length !== loop.actionIds.length ||
    loopActions.some((action) => !actionIds.has(action.id))
  ) {
    throw new Error("分页循环步骤必须在录制动作中连续出现。");
  }
  if (new Set(loopActions.map((action) => action.pageId)).size !== 1) {
    throw new Error("分页循环不能包含跨页面步骤。");
  }
  if (loopActions.some((action) => action.type === "closePage" || action.opensPageId)) {
    throw new Error("分页循环不能包含打开或关闭额外页面的步骤。");
  }

  const nextAction = loopActions.at(-1);
  if (
    !nextAction ||
    nextAction.id !== loop.nextActionId ||
    nextAction.type !== "click" ||
    typeof nextAction.selector !== "string"
  ) {
    throw new Error("分页循环的最后一步必须是有选择器的下一页点击。");
  }
  const bodyActions = loopActions.slice(0, -1);
  const listEntryAction = bodyActions.find((action) => action.id === loop.listEntryActionId);
  if (!listEntryAction || listEntryAction.type !== "click") {
    throw new Error("分页循环的列表入口必须是循环体内的点击步骤。");
  }
  if (!listEntryAction.structuralSelector?.startsWith(loop.sourceItemSelector)) {
    throw new Error("分页循环的列表入口与所选结构选择器不匹配。");
  }

  return { loop, bodyActions, nextAction, startIndex, endIndex };
};

const dynamicSelectorCode = (
  action: RecordedAction,
  loop: RecordedPaginationLoop,
): string | undefined => {
  if (!action.structuralSelector?.startsWith(loop.sourceItemSelector)) return undefined;
  const suffix = action.structuralSelector.slice(loop.sourceItemSelector.length);
  return suffix
    ? `paginationLoopItemSelector + ${serialize(suffix, "selector suffix")}`
    : "paginationLoopItemSelector";
};

const appendCompiledAction = (
  lines: string[],
  action: RecordedAction,
  indentation: string,
  selectorCode?: string,
): void => {
  if (!Number.isFinite(action.order)) {
    throw new Error(`动作 ${action.id} 的 order 必须是有限数字。`);
  }
  lines.push(
    "",
    `${indentation}await log(${serialize(`执行步骤 ${action.order}：${ACTION_LABELS[action.type]}`, "日志")});`,
    `${indentation}${compileAction(action, selectorCode)}`,
  );
};

export const compileRecordingToScript = (recording: RecordingSession): string => {
  const actions = orderedIncludedActions(recording);

  const lines = [
    "export default async function run({ page, log, pace }) {",
    "  const page0 = page;",
  ];

  if (!recording.paginationLoop) {
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
  }

  const resolved = resolvePaginationLoop(actions, recording.paginationLoop);
  for (const action of actions.slice(0, resolved.startIndex)) {
    appendCompiledAction(lines, action, "  ");
  }

  const loopPageId = pageVariable(resolved.nextAction.pageId, "pageId");
  lines.push(
    "",
    `  const paginationLoopItemSelectorTemplate = ${serialize(resolved.loop.itemSelectorTemplate, "itemSelectorTemplate")};`,
    `  for (let paginationLoopPageNumber = 1; paginationLoopPageNumber <= ${resolved.loop.maxPages}; paginationLoopPageNumber += 1) {`,
    `    const paginationLoopItemOrdinals = await pace.listItemOrdinals(${loopPageId}, ${serialize(resolved.loop.listSelector, "listSelector")});`,
    "    if (paginationLoopItemOrdinals.length === 0) break;",
    "    for (const paginationLoopItemOrdinal of paginationLoopItemOrdinals) {",
    `      const paginationLoopItemSelector = paginationLoopItemSelectorTemplate.replace(${serialize(PAGINATION_LOOP_ITEM_ORDINAL_TOKEN, "item ordinal token")}, String(paginationLoopItemOrdinal));`,
  );

  for (const action of resolved.bodyActions) {
    appendCompiledAction(lines, action, "      ", dynamicSelectorCode(action, resolved.loop));
  }

  lines.push(
    "    }",
    `    if (paginationLoopPageNumber >= ${resolved.loop.maxPages}) break;`,
    "",
    `    await log(${serialize(`执行步骤 ${resolved.nextAction.order}：${ACTION_LABELS[resolved.nextAction.type]}`, "日志")});`,
    `    const paginationLoopHasNextPage = await pace.clickNextAndWaitForChange(${loopPageId}, ${serialize(resolved.nextAction.selector, "next selector")}, ${serialize(resolved.loop.listSelector, "listSelector")});`,
    "    if (!paginationLoopHasNextPage) break;",
    "  }",
  );

  for (const action of actions.slice(resolved.endIndex + 1)) {
    appendCompiledAction(lines, action, "  ");
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
};

export type {
  PaginationLoopSelectorCandidate,
  RecordedAction,
  RecordedActionType,
  RecordedPage,
  RecordedPaginationLoop,
  RecordingSession,
  RecordingStatus,
} from "./recording-types.js";
