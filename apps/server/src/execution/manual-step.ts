import crypto from "node:crypto";
import type { ManualControlKind, ManualStepTarget } from "../recording/recording-types.js";
import {
  ScriptExecutionCancelledError,
  isExecutionCancelledError,
  throwIfExecutionCancelled,
} from "./execution-cancellation.js";
import type { ExecutionCoordinator, ManualExecutionMode } from "./execution-coordinator.js";

const MANUAL_STEP_PAGE_STATE_KEY = "__crawlcbgManualStepV1";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const POLL_INTERVAL_MS = 225;
const MAX_TARGETS = 50;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 120;
const MAX_DISPLAY_NAME_LENGTH = 120;
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

interface ManualStepPage {
  targetId?: () => string;
  url?: () => string;
  isClosed?: () => boolean;
  bringToFront?: () => Promise<unknown> | undefined;
  sendCDP?: <Result = unknown>(method: string, params?: object) => Promise<Result>;
  evaluate: <Result = unknown>(expression: string) => Promise<Result>;
}

export interface ManualStepOptions {
  title: string;
  targets: ManualStepTarget[];
}

export interface ManualStepRequiredEvent {
  stepId: string;
  title: string;
  targetCount: number;
}

export type ManualStepResolution = "completed" | "cancelled" | "failed";

export interface CreateManualStepRuntimeOptions {
  runId: string;
  executionMode: ManualExecutionMode;
  signal: AbortSignal;
  executionCoordinator: ExecutionCoordinator;
  getPages: () => unknown[] | Promise<unknown[]>;
  cancelExecution: () => void;
  disableScreenshots: () => Promise<void>;
  onRequired: (event: ManualStepRequiredEvent) => void | Promise<void>;
  onResolved: (
    event: ManualStepRequiredEvent & { resolution: ManualStepResolution },
  ) => void | Promise<void>;
  timeoutMs?: number;
}

export interface ManualStepRuntime {
  wait: (page: unknown, options: ManualStepOptions) => Promise<void>;
}

export class ManualStepRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ManualStepRuntimeError";
  }
}

interface ManualStepOverlayConfig {
  stateKey: string;
  stepId: string;
  title: string;
  targets: ManualStepTarget[];
}

interface ManualStepOverlayResult {
  ok: boolean;
  code?: string;
  message?: string;
}

interface ManualStepPageStateResult {
  status: "waiting" | "completed" | "cancelled" | "missing";
}

/** Serialized into the target Chrome page. Do not reference server-side closures here. */
function installManualStepOverlay(config: ManualStepOverlayConfig): ManualStepOverlayResult {
  type BrowserElement = Record<string, any>;
  type BrowserGlobal = typeof globalThis &
    Record<string, any> & { document: Record<string, any>; getComputedStyle: (node: any) => any };

  const browserGlobal = globalThis as BrowserGlobal;
  const browserDocument = browserGlobal.document;
  const previous = browserGlobal[config.stateKey];
  if (previous && typeof previous.dispose === "function") previous.dispose();

  const isElement = (value: unknown): value is BrowserElement =>
    Boolean(value && typeof value === "object" && (value as BrowserElement).nodeType === 1);
  const tagName = (element: BrowserElement): string =>
    typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  const inputType = (element: BrowserElement): string => String(element.type || "").toLowerCase();
  const isContentEditable = (element: BrowserElement): boolean =>
    element.isContentEditable === true || element.getAttribute?.("contenteditable") === "true";
  const isVisible = (element: BrowserElement): boolean => {
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = browserGlobal.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const isDisabled = (element: BrowserElement): boolean =>
    element.disabled === true || element.getAttribute?.("aria-disabled") === "true";
  const isReadOnly = (element: BrowserElement): boolean =>
    element.readOnly === true || element.getAttribute?.("aria-readonly") === "true";
  const supportsKind = (element: BrowserElement, kind: ManualControlKind): boolean => {
    if (isDisabled(element)) return false;
    if (kind === "custom") return true;
    if (kind === "select" || kind === "multiSelect") return tagName(element) === "select";
    if (kind === "checkbox") {
      return tagName(element) === "input" && inputType(element) === "checkbox";
    }
    if (kind === "radioGroup") {
      return tagName(element) === "input" && inputType(element) === "radio";
    }
    if (isReadOnly(element)) return false;
    if (kind === "date") {
      return (
        tagName(element) === "input" &&
        ["date", "datetime-local", "month", "time", "week"].includes(inputType(element))
      );
    }
    return (
      tagName(element) === "input" || tagName(element) === "textarea" || isContentEditable(element)
    );
  };

  const resolvedTargets: Array<{ target: ManualStepTarget; element: BrowserElement }> = [];
  for (let index = 0; index < config.targets.length; index += 1) {
    const target = config.targets[index];
    let matches: BrowserElement[];
    try {
      matches = Array.from(browserDocument.querySelectorAll(target.selector)).filter(isElement);
    } catch {
      return {
        ok: false,
        code: "manual_step_invalid_selector",
        message: `目标“${target.displayName}”的定位规则无效。`,
      };
    }
    if (matches.length !== 1) {
      return {
        ok: false,
        code: "manual_step_target_not_unique",
        message: `目标“${target.displayName}”匹配到 ${matches.length} 个元素。`,
      };
    }
    const element = matches[0];
    if (!isVisible(element)) {
      return {
        ok: false,
        code: "manual_step_target_not_visible",
        message: `目标“${target.displayName}”当前不可见。`,
      };
    }
    if (!supportsKind(element, target.controlKind)) {
      return {
        ok: false,
        code: "manual_step_target_not_editable",
        message: `目标“${target.displayName}”不可操作或控件类型已变化。`,
      };
    }
    resolvedTargets.push({ target, element });
  }

  const host = browserDocument.createElement("div");
  host.setAttribute("data-crawlcbg-manual-step", config.stepId);
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    pointerEvents: "none",
  });
  const shadow = host.attachShadow({ mode: "closed" });
  const style = browserDocument.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .highlight { position: fixed; border: 3px solid #f59e0b; border-radius: 8px;
      box-shadow: 0 0 0 4px rgba(245,158,11,.22), 0 0 22px rgba(245,158,11,.65);
      pointer-events: none; transition: top .08s linear, left .08s linear, width .08s linear,
      height .08s linear; animation: crawlcbg-pulse 1.4s ease-in-out infinite; }
    .badge { position: absolute; left: -11px; top: -13px; width: 24px; height: 24px;
      border-radius: 999px; background: #f59e0b; color: #111827; font: 700 13px/24px
      ui-sans-serif, system-ui, sans-serif; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
    .panel { position: fixed; top: 18px; right: 18px; width: min(380px, calc(100vw - 36px));
      max-height: calc(100vh - 36px); overflow: auto; pointer-events: auto; color: #f9fafb;
      background: rgba(17,24,39,.97); border: 1px solid rgba(245,158,11,.7); border-radius: 14px;
      box-shadow: 0 18px 50px rgba(0,0,0,.42); padding: 16px; font: 14px/1.45
      ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .eyebrow { color: #fbbf24; font-size: 12px; font-weight: 800; letter-spacing: .08em;
      text-transform: uppercase; }
    h2 { color: #fff; font-size: 17px; line-height: 1.35; margin: 5px 0 7px; }
    .hint { color: #d1d5db; font-size: 12px; margin: 0 0 12px; }
    ol { list-style: none; padding: 0; margin: 0 0 14px; display: grid; gap: 8px; }
    li { display: flex; gap: 9px; align-items: center; padding: 9px 10px; background: #1f2937;
      border-radius: 9px; }
    .number { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 999px; background: #f59e0b;
      color: #111827; font-weight: 800; line-height: 22px; text-align: center; }
    .name { min-width: 0; flex: 1; color: #f3f4f6; font-weight: 650; overflow-wrap: anywhere; }
    .state { flex: 0 0 auto; color: #9ca3af; font-size: 12px; }
    .state.ready { color: #6ee7b7; }
    .actions { display: flex; gap: 8px; }
    button { appearance: none; border: 0; border-radius: 9px; padding: 10px 13px; cursor: pointer;
      font: 700 13px/1 ui-sans-serif, system-ui, sans-serif; }
    .complete { flex: 1; background: #f59e0b; color: #111827; }
    .cancel { background: #374151; color: #f9fafb; }
    button:hover { filter: brightness(1.07); }
    button:focus-visible { outline: 3px solid #fde68a; outline-offset: 2px; }
    @keyframes crawlcbg-pulse { 0%,100% { opacity: .82; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .highlight { animation: none; transition: none; } }
  `;
  shadow.appendChild(style);

  const highlightElements = resolvedTargets.map(({ element }, index) => {
    const highlight = browserDocument.createElement("div");
    highlight.className = "highlight";
    const badge = browserDocument.createElement("span");
    badge.className = "badge";
    badge.textContent = String(index + 1);
    highlight.appendChild(badge);
    shadow.appendChild(highlight);
    return { element, highlight };
  });

  const panel = browserDocument.createElement("section");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "CrawlCBG 人工操作");
  const eyebrow = browserDocument.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "CrawlCBG · 等待人工操作";
  const heading = browserDocument.createElement("h2");
  heading.textContent = config.title;
  const hint = browserDocument.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "请直接在当前网页完成高亮控件，确认无误后再继续。字段内容不会发送给 CrawlCBG。";
  const list = browserDocument.createElement("ol");

  const readinessElements = resolvedTargets.map(({ target, element }, index) => {
    const item = browserDocument.createElement("li");
    const number = browserDocument.createElement("span");
    number.className = "number";
    number.textContent = String(index + 1);
    const name = browserDocument.createElement("span");
    name.className = "name";
    name.textContent = `${target.displayName}${target.required ? " *" : ""}`;
    const state = browserDocument.createElement("span");
    state.className = "state";
    item.append(number, name, state);
    list.appendChild(item);
    return { target, element, state };
  });

  const actions = browserDocument.createElement("div");
  actions.className = "actions";
  const cancelButton = browserDocument.createElement("button");
  cancelButton.className = "cancel";
  cancelButton.type = "button";
  cancelButton.textContent = "取消执行";
  const completeButton = browserDocument.createElement("button");
  completeButton.className = "complete";
  completeButton.type = "button";
  completeButton.textContent = "完成并继续";
  actions.append(cancelButton, completeButton);
  panel.append(eyebrow, heading, hint, list, actions);
  shadow.appendChild(panel);
  browserDocument.documentElement.appendChild(host);

  let animationFrame = 0;
  let disposed = false;
  const listeners: Array<{ element: BrowserElement; type: string; listener: () => void }> = [];
  const readiness = (element: BrowserElement, kind: ManualControlKind): boolean | null => {
    if (kind === "custom") return null;
    if (kind === "checkbox" || kind === "radioGroup") return element.checked === true;
    if (kind === "multiSelect") return Array.from(element.selectedOptions || []).length > 0;
    if (kind === "select") return element.selectedIndex >= 0 && String(element.value ?? "") !== "";
    if (isContentEditable(element)) return String(element.textContent || "").trim().length > 0;
    return String(element.value ?? "").trim().length > 0;
  };
  const refreshReadiness = (): void => {
    for (const item of readinessElements) {
      const ready = readiness(item.element, item.target.controlKind);
      item.state.classList.toggle("ready", ready === true);
      item.state.textContent = ready === null ? "请操作" : ready ? "已填写" : "待完成";
    }
  };
  const updateHighlights = (): void => {
    if (disposed) return;
    for (const { element, highlight } of highlightElements) {
      const rect = element.getBoundingClientRect();
      Object.assign(highlight.style, {
        top: `${Math.max(0, rect.top - 4)}px`,
        left: `${Math.max(0, rect.left - 4)}px`,
        width: `${Math.max(0, rect.width + 8)}px`,
        height: `${Math.max(0, rect.height + 8)}px`,
        display: isVisible(element) ? "block" : "none",
      });
    }
    animationFrame = browserGlobal.requestAnimationFrame(updateHighlights);
  };

  const state = {
    stepId: config.stepId,
    status: "waiting" as "waiting" | "completed" | "cancelled",
    isActive: () => !disposed && host.isConnected === true,
    focus: () => {
      const first = resolvedTargets[0]?.element;
      first?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
      try {
        first?.focus?.({ preventScroll: true });
      } catch {
        first?.focus?.();
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (animationFrame) browserGlobal.cancelAnimationFrame(animationFrame);
      for (const entry of listeners) {
        entry.element.removeEventListener(entry.type, entry.listener, true);
      }
      host.remove();
      if (browserGlobal[config.stateKey] === state) delete browserGlobal[config.stateKey];
    },
  };
  browserGlobal[config.stateKey] = state;

  const updateListener = () => refreshReadiness();
  for (const { element } of resolvedTargets) {
    for (const type of ["input", "change", "click"]) {
      element.addEventListener(type, updateListener, true);
      listeners.push({ element, type, listener: updateListener });
    }
  }
  completeButton.addEventListener("click", (event: { isTrusted?: boolean }) => {
    if (event.isTrusted !== true) return;
    state.status = "completed";
    completeButton.disabled = true;
    cancelButton.disabled = true;
    completeButton.textContent = "正在继续…";
  });
  cancelButton.addEventListener("click", (event: { isTrusted?: boolean }) => {
    if (event.isTrusted !== true) return;
    state.status = "cancelled";
    completeButton.disabled = true;
    cancelButton.disabled = true;
    cancelButton.textContent = "正在取消…";
  });

  refreshReadiness();
  updateHighlights();
  state.focus();
  return { ok: true };
}

function readManualStepPageState(config: {
  stateKey: string;
  stepId: string;
}): ManualStepPageStateResult {
  const state = (globalThis as Record<string, any>)[config.stateKey];
  if (
    !state ||
    state.stepId !== config.stepId ||
    typeof state.isActive !== "function" ||
    state.isActive() !== true
  ) {
    return { status: "missing" };
  }
  if (state.status === "completed" || state.status === "cancelled") {
    return { status: state.status };
  }
  return { status: "waiting" };
}

function cleanupManualStepOverlay(config: { stateKey: string; stepId: string }): void {
  const browserGlobal = globalThis as Record<string, any>;
  const state = browserGlobal[config.stateKey];
  if (state?.stepId === config.stepId && typeof state.dispose === "function") state.dispose();
}

function focusManualStepOverlay(config: {
  stateKey: string;
  stepId: string;
}): ManualStepPageStateResult {
  const state = (globalThis as Record<string, any>)[config.stateKey];
  if (
    !state ||
    state.stepId !== config.stepId ||
    typeof state.isActive !== "function" ||
    state.isActive() !== true ||
    typeof state.focus !== "function"
  ) {
    return { status: "missing" };
  }
  state.focus();
  if (state.status === "completed" || state.status === "cancelled") {
    return { status: state.status };
  }
  return { status: "waiting" };
}

const expressionFor = (fn: (...args: any[]) => unknown, config: object): string =>
  `(${fn.toString()})(${JSON.stringify(config)})`;

const createManualStepIsolatedWorld = async (
  page: ManualStepPage,
  stepId: string,
): Promise<number> => {
  if (typeof page.sendCDP !== "function") {
    throw new ManualStepRuntimeError(
      "当前 Chrome 页面不支持隔离的人工操作环境。",
      "manual_step_isolated_world_unavailable",
    );
  }
  try {
    const frameTree = await page.sendCDP<{
      frameTree?: { frame?: { id?: string } };
    }>("Page.getFrameTree");
    const frameId = frameTree.frameTree?.frame?.id;
    if (!frameId) throw new Error("Missing main frame id");
    const world = await page.sendCDP<{ executionContextId?: number }>("Page.createIsolatedWorld", {
      frameId,
      worldName: `crawlcbg-manual-${stepId}`,
      grantUniveralAccess: false,
    });
    if (!Number.isInteger(world.executionContextId)) {
      throw new Error("Missing isolated execution context id");
    }
    return world.executionContextId as number;
  } catch (error) {
    if (error instanceof ManualStepRuntimeError) throw error;
    throw new ManualStepRuntimeError(
      "无法为人工操作创建隔离的 Chrome 执行环境。",
      "manual_step_isolated_world_unavailable",
    );
  }
};

const evaluateInManualStepWorld = async <Result>(
  page: ManualStepPage,
  executionContextId: number,
  expression: string,
): Promise<Result> => {
  if (typeof page.sendCDP !== "function") {
    throw new ManualStepRuntimeError(
      "人工操作页面的隔离环境已不可用。",
      "manual_step_page_unavailable",
    );
  }
  const response = await page.sendCDP<{
    result?: { value?: Result };
    exceptionDetails?: object;
  }>("Runtime.evaluate", {
    expression,
    contextId: executionContextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new ManualStepRuntimeError(
      "人工操作页面的隔离环境执行失败。",
      "manual_step_page_unavailable",
    );
  }
  return response.result?.value as Result;
};

const pageTargetId = (page: unknown): string | null => {
  if (
    !page ||
    typeof page !== "object" ||
    typeof (page as ManualStepPage).targetId !== "function"
  ) {
    return null;
  }
  try {
    const targetId = (page as ManualStepPage).targetId?.();
    return typeof targetId === "string" && targetId ? targetId : null;
  } catch {
    return null;
  }
};

const isManualStepPage = (page: unknown): page is ManualStepPage =>
  Boolean(
    page && typeof page === "object" && typeof (page as ManualStepPage).sendCDP === "function",
  );

const normalizeOptions = (value: unknown): ManualStepOptions => {
  if (!value || typeof value !== "object") {
    throw new ManualStepRuntimeError("manual.wait 缺少人工操作配置。", "invalid_manual_step");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.hasOwn(candidate, "value")) {
    throw new ManualStepRuntimeError("人工操作配置不能包含字段值。", "manual_step_value_forbidden");
  }
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new ManualStepRuntimeError(
      `人工操作标题必须为 1-${MAX_TITLE_LENGTH} 个字符。`,
      "invalid_manual_step_title",
    );
  }
  if (
    !Array.isArray(candidate.targets) ||
    candidate.targets.length === 0 ||
    candidate.targets.length > MAX_TARGETS
  ) {
    throw new ManualStepRuntimeError(
      `人工操作目标数量必须为 1-${MAX_TARGETS}。`,
      "invalid_manual_step_targets",
    );
  }

  const targets = candidate.targets.map((value, index): ManualStepTarget => {
    if (!value || typeof value !== "object") {
      throw new ManualStepRuntimeError(
        `第 ${index + 1} 个人工操作目标无效。`,
        "invalid_manual_step_target",
      );
    }
    const target = value as Record<string, unknown>;
    if (Object.hasOwn(target, "value")) {
      throw new ManualStepRuntimeError(
        "人工操作目标不能包含字段值。",
        "manual_step_value_forbidden",
      );
    }
    const selector = typeof target.selector === "string" ? target.selector : "";
    const displayName = typeof target.displayName === "string" ? target.displayName.trim() : "";
    const controlKind = target.controlKind;
    if (!selector || selector.length > MAX_SELECTOR_LENGTH) {
      throw new ManualStepRuntimeError(
        `第 ${index + 1} 个人工操作目标缺少有效 selector。`,
        "invalid_manual_step_selector",
      );
    }
    if (
      typeof controlKind !== "string" ||
      !MANUAL_CONTROL_KINDS.has(controlKind as ManualControlKind)
    ) {
      throw new ManualStepRuntimeError(
        `第 ${index + 1} 个人工操作目标类型无效。`,
        "invalid_manual_step_control_kind",
      );
    }
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new ManualStepRuntimeError(
        `第 ${index + 1} 个人工操作目标显示名称无效。`,
        "invalid_manual_step_display_name",
      );
    }
    if (target.required !== undefined && typeof target.required !== "boolean") {
      throw new ManualStepRuntimeError(
        `第 ${index + 1} 个人工操作目标 required 无效。`,
        "invalid_manual_step_required",
      );
    }
    return {
      selector,
      controlKind: controlKind as ManualControlKind,
      displayName,
      ...(target.required !== undefined ? { required: target.required as boolean } : {}),
    };
  });
  return { title, targets };
};

const bringToFront = async (page: ManualStepPage): Promise<void> => {
  if (typeof page.bringToFront === "function") {
    await page.bringToFront();
    return;
  }
  if (typeof page.sendCDP === "function") {
    await page.sendCDP("Page.bringToFront");
  }
};

const cancellableDelay = (durationMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfExecutionCancelled(signal);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, durationMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(new ScriptExecutionCancelledError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });

export const createManualStepRuntime = ({
  runId,
  executionMode,
  signal,
  executionCoordinator,
  getPages,
  cancelExecution,
  disableScreenshots,
  onRequired,
  onResolved,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CreateManualStepRuntimeOptions): ManualStepRuntime => ({
  async wait(pageValue, rawOptions) {
    if (executionMode !== "visible") {
      throw new ManualStepRuntimeError(
        "人工操作步骤仅支持 visible 模式，请切换到可见窗口后重试。",
        "manual_step_visible_only",
      );
    }
    throwIfExecutionCancelled(signal);
    const options = normalizeOptions(rawOptions);
    const requestedTargetId = pageTargetId(pageValue);
    if (!requestedTargetId) {
      throw new ManualStepRuntimeError(
        "人工操作页面缺少稳定的 Chrome targetId。",
        "manual_step_target_unavailable",
      );
    }

    const waitTimeoutMs = Math.max(1_000, timeoutMs);
    const deadline = Date.now() + waitTimeoutMs;
    const throwIfTimedOut = (): void => {
      if (Date.now() >= deadline) {
        throw new ManualStepRuntimeError(
          `人工操作等待超过 ${Math.round(waitTimeoutMs / 1_000)} 秒，执行已停止。`,
          "manual_step_timeout",
        );
      }
    };

    // This is a one-way privacy boundary for the entire run. It is intentionally never re-enabled.
    await disableScreenshots();
    throwIfExecutionCancelled(signal);
    throwIfTimedOut();

    const pages = await getPages();
    throwIfExecutionCancelled(signal);
    throwIfTimedOut();
    const rawPage = Array.isArray(pages)
      ? pages.find(
          (candidate) =>
            isManualStepPage(candidate) && pageTargetId(candidate) === requestedTargetId,
        )
      : null;
    if (!rawPage || !isManualStepPage(rawPage) || rawPage.isClosed?.()) {
      throw new ManualStepRuntimeError(
        "人工操作目标页面已关闭或不再属于当前 Chrome 会话。",
        "manual_step_page_closed",
      );
    }

    const stepId = `manual_${Date.now()}_${crypto.randomUUID()}`;
    const event: ManualStepRequiredEvent = {
      stepId,
      title: options.title,
      targetCount: options.targets.length,
    };
    const overlayConfig: ManualStepOverlayConfig = {
      stateKey: MANUAL_STEP_PAGE_STATE_KEY,
      stepId,
      title: options.title,
      targets: options.targets,
    };
    const executionContextId = await createManualStepIsolatedWorld(rawPage, stepId);
    throwIfExecutionCancelled(signal);
    throwIfTimedOut();

    let overlayAttempted = false;
    let cleanupPromise: Promise<void> | null = null;
    let registered = false;
    let requiredSent = false;
    let resolution: ManualStepResolution = "failed";
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        if (!overlayAttempted) return;
        try {
          if (!rawPage.isClosed?.()) {
            await evaluateInManualStepWorld<void>(
              rawPage,
              executionContextId,
              expressionFor(cleanupManualStepOverlay, overlayConfig),
            );
          }
        } catch {
          // Navigation and page closure destroy the overlay with the old document.
        }
      })();
      return cleanupPromise;
    };
    const focus = async (): Promise<void> => {
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();
      if (rawPage.isClosed?.()) {
        throw new ManualStepRuntimeError("人工操作目标页面已关闭。", "manual_step_page_closed");
      }
      await bringToFront(rawPage);
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();
      const focusResult = await evaluateInManualStepWorld<ManualStepPageStateResult>(
        rawPage,
        executionContextId,
        expressionFor(focusManualStepOverlay, overlayConfig),
      );
      if (!focusResult || focusResult.status === "missing") {
        throw new ManualStepRuntimeError(
          "人工操作浮层已因页面变化而失效。",
          "manual_step_navigation",
        );
      }
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();
    };

    try {
      overlayAttempted = true;
      const installResult = await evaluateInManualStepWorld<ManualStepOverlayResult>(
        rawPage,
        executionContextId,
        expressionFor(installManualStepOverlay, overlayConfig),
      );
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();
      if (!installResult?.ok) {
        throw new ManualStepRuntimeError(
          installResult?.message || "无法在目标页面展示人工操作区域。",
          installResult?.code || "manual_step_overlay_failed",
        );
      }

      executionCoordinator.registerManualStep(runId, {
        stepId,
        targetId: requestedTargetId,
        title: options.title,
        targetCount: options.targets.length,
        focus,
        dispose: cleanup,
      });
      registered = true;
      throwIfExecutionCancelled(signal);
      await focus();
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();
      const stateBeforeRequired = await evaluateInManualStepWorld<ManualStepPageStateResult>(
        rawPage,
        executionContextId,
        expressionFor(readManualStepPageState, overlayConfig),
      );
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();
      if (stateBeforeRequired?.status === "completed") {
        resolution = "completed";
        return;
      }
      if (stateBeforeRequired?.status === "cancelled") {
        resolution = "cancelled";
        cancelExecution();
        throw new ScriptExecutionCancelledError();
      }
      if (!stateBeforeRequired || stateBeforeRequired.status !== "waiting") {
        throw new ManualStepRuntimeError(
          "等待人工操作前页面发生导航，人工步骤已安全停止。",
          "manual_step_navigation",
        );
      }
      requiredSent = true;
      await onRequired(event);
      throwIfExecutionCancelled(signal);
      throwIfTimedOut();

      while (Date.now() < deadline) {
        throwIfExecutionCancelled(signal);
        if (rawPage.isClosed?.()) {
          throw new ManualStepRuntimeError(
            "等待人工操作时目标页面被关闭。",
            "manual_step_page_closed",
          );
        }

        let state: ManualStepPageStateResult;
        try {
          state = await evaluateInManualStepWorld<ManualStepPageStateResult>(
            rawPage,
            executionContextId,
            expressionFor(readManualStepPageState, overlayConfig),
          );
        } catch {
          if (signal.aborted) throw new ScriptExecutionCancelledError();
          throw new ManualStepRuntimeError(
            "等待人工操作时页面发生导航，人工步骤已安全停止。",
            "manual_step_navigation",
          );
        }
        throwIfExecutionCancelled(signal);
        throwIfTimedOut();
        if (state?.status === "completed") {
          resolution = "completed";
          return;
        }
        if (state?.status === "cancelled") {
          resolution = "cancelled";
          cancelExecution();
          throw new ScriptExecutionCancelledError();
        }
        if (!state || state.status === "missing") {
          throw new ManualStepRuntimeError(
            "等待人工操作时页面发生导航，人工步骤已安全停止。",
            "manual_step_navigation",
          );
        }
        await cancellableDelay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
      }
      throwIfTimedOut();
    } catch (error) {
      if (signal.aborted || isExecutionCancelledError(error)) {
        resolution = "cancelled";
        throw new ScriptExecutionCancelledError();
      }
      throw error;
    } finally {
      if (registered) executionCoordinator.releaseManualStep(runId, stepId);
      await cleanup();
      if (requiredSent) {
        try {
          await onResolved({ ...event, resolution });
        } catch {
          // UI notification failures must not change script control flow.
        }
      }
    }
  },
});
