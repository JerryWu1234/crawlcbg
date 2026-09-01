import type {
  AutomatedRecordedAction,
  ManualControlKind,
  RecordedAction,
  RecordedPage,
} from "./recording-types.js";
import {
  DRAIN_RECORDING_PAGE_EVENTS_EXPRESSION,
  RECORDING_CONSOLE_PREFIX,
  RECORDING_PAGE_EVENT_SCRIPT,
  STOP_RECORDING_PAGE_EVENTS_EXPRESSION,
  type RawRecordedPageEvent,
} from "./page-event-script.js";

const DEFAULT_POLL_INTERVAL_MS = 125;
const DEFAULT_POPUP_ASSOCIATION_WINDOW_MS = 2_000;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_TEXT_VALUE_LENGTH = 100_000;
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

interface RecorderConsoleMessage {
  text: () => string;
}

interface RecorderPage {
  targetId?: () => string;
  url: () => string;
  evaluate: <Result = unknown>(expression: string) => Promise<Result>;
  sendCDP: <Result = unknown>(method: string, params?: object) => Promise<Result>;
  waitForLoadState?: (state: "domcontentloaded", timeoutMs?: number) => Promise<void>;
  on?: (event: "console", listener: (message: RecorderConsoleMessage) => void) => unknown;
  off?: (event: "console", listener: (message: RecorderConsoleMessage) => void) => unknown;
}

export interface BrowserRecorderOptions {
  rootPage: unknown;
  getPages: () => unknown[] | Promise<unknown[]>;
  onAction: (action: RecordedAction) => void | Promise<void>;
  onActionUpdated?: (action: RecordedAction) => void | Promise<void>;
  onPageOpened: (page: RecordedPage) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  pollIntervalMs?: number;
  popupAssociationWindowMs?: number;
}

export interface BrowserRecorderHandle {
  stop: () => Promise<void>;
}

interface TrackedPage {
  key: string;
  id: string;
  page: RecorderPage;
  initScriptIdentifier: string;
  consoleListener: (message: RecorderConsoleMessage) => void;
  consoleEvents: RawRecordedPageEvent[];
  seenEventIds: Set<string>;
  closed: boolean;
}

interface RecentClick {
  action: AutomatedRecordedAction;
  capturedAt: number;
  consumed: boolean;
}

interface PendingPage {
  page: RecorderPage;
  firstSeenAt: number;
}

interface CollectedPageEvent {
  page: TrackedPage;
  event: RawRecordedPageEvent;
}

const sensitiveSelectorPattern =
  /(?:password|passwd|pwd|passcode|one[\s_"'=-]?time|otp|verification|verify[\s_"'=-]?code|captcha|token|secret|api[\s_"'=-]?key|access[\s_"'=-]?key|auth[\s_"'=-]?code|credit[\s_"'=-]?card|card[\s_"'=-]?(?:number|no)|cc[\s_"'=-]?(?:number|num|csc)|cvv|cvc|security[\s_"'=-]?code)/i;

const isRecorderPage = (value: unknown): value is RecorderPage =>
  Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Partial<RecorderPage>).url === "function" &&
    typeof (value as Partial<RecorderPage>).evaluate === "function" &&
    typeof (value as Partial<RecorderPage>).sendCDP === "function",
  );

const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(typeof error === "string" ? error : fallback);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const passesLuhnCheck = (digits: string): boolean => {
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
};

const resemblesSensitiveValue = (value: string): boolean => {
  const compactDigits = value.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(compactDigits) && passesLuhnCheck(compactDigits)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim())) {
    return true;
  }
  return /^(?:sk|rk|api|token|secret|key)[-_][A-Za-z0-9_-]{12,}$/i.test(value.trim());
};

interface NormalizedControlMetadata {
  controlKind?: ManualControlKind;
  displayName?: string;
  required?: boolean;
}

const normalizeControlMetadata = (
  candidate: Partial<RawRecordedPageEvent>,
): NormalizedControlMetadata | null => {
  if (
    candidate.controlKind !== undefined &&
    (typeof candidate.controlKind !== "string" || !MANUAL_CONTROL_KINDS.has(candidate.controlKind))
  ) {
    return null;
  }
  if (
    candidate.displayName !== undefined &&
    (typeof candidate.displayName !== "string" ||
      !candidate.displayName.trim() ||
      candidate.displayName.length > MAX_DISPLAY_NAME_LENGTH)
  ) {
    return null;
  }
  if (candidate.required !== undefined && typeof candidate.required !== "boolean") return null;

  return {
    ...(candidate.controlKind ? { controlKind: candidate.controlKind } : {}),
    ...(candidate.displayName ? { displayName: candidate.displayName.trim() } : {}),
    ...(candidate.required !== undefined ? { required: candidate.required } : {}),
  };
};

const normalizeRawEvent = (value: unknown): RawRecordedPageEvent | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RawRecordedPageEvent>;
  if (
    typeof candidate.eventId !== "string" ||
    candidate.eventId.length > 160 ||
    typeof candidate.timestamp !== "number" ||
    !Number.isFinite(candidate.timestamp) ||
    !["click", "fill", "select", "setChecked", "press", "scroll", "manualStep"].includes(
      String(candidate.type),
    )
  ) {
    return null;
  }

  if (candidate.sensitive === true && candidate.type !== "manualStep") return null;
  if (candidate.selector !== undefined) {
    if (
      typeof candidate.selector !== "string" ||
      !candidate.selector ||
      candidate.selector.length > MAX_SELECTOR_LENGTH
    ) {
      return null;
    }
    if (candidate.type !== "manualStep" && sensitiveSelectorPattern.test(candidate.selector)) {
      return null;
    }
  }
  if (candidate.structuralSelector !== undefined) {
    if (
      typeof candidate.structuralSelector !== "string" ||
      !candidate.structuralSelector ||
      candidate.structuralSelector.length > MAX_SELECTOR_LENGTH
    ) {
      return null;
    }
    if (sensitiveSelectorPattern.test(candidate.structuralSelector)) return null;
  }

  const selectorFields = (selector: string) => ({
    selector,
    ...(typeof candidate.structuralSelector === "string"
      ? { structuralSelector: candidate.structuralSelector }
      : {}),
  });

  const controlMetadata = normalizeControlMetadata(candidate);
  if (!controlMetadata) return null;

  switch (candidate.type) {
    case "manualStep":
      if (
        typeof candidate.selector !== "string" ||
        candidate.value !== undefined ||
        !controlMetadata.controlKind ||
        !controlMetadata.displayName
      ) {
        return null;
      }
      return {
        eventId: candidate.eventId,
        timestamp: candidate.timestamp,
        type: candidate.type,
        selector: candidate.selector,
        sensitive: true,
        controlKind: controlMetadata.controlKind,
        displayName: controlMetadata.displayName,
        ...(controlMetadata.required !== undefined ? { required: controlMetadata.required } : {}),
      };
    case "click":
      return typeof candidate.selector === "string"
        ? {
            eventId: candidate.eventId,
            timestamp: candidate.timestamp,
            type: candidate.type,
            ...selectorFields(candidate.selector),
          }
        : null;
    case "fill":
      if (
        typeof candidate.selector !== "string" ||
        typeof candidate.value !== "string" ||
        candidate.value.length > MAX_TEXT_VALUE_LENGTH ||
        resemblesSensitiveValue(candidate.value)
      ) {
        return null;
      }
      return {
        eventId: candidate.eventId,
        timestamp: candidate.timestamp,
        type: candidate.type,
        ...selectorFields(candidate.selector),
        value: candidate.value,
        ...controlMetadata,
      };
    case "select":
      if (
        typeof candidate.selector !== "string" ||
        (typeof candidate.value !== "string" && !isStringArray(candidate.value))
      ) {
        return null;
      }
      return {
        eventId: candidate.eventId,
        timestamp: candidate.timestamp,
        type: candidate.type,
        ...selectorFields(candidate.selector),
        value: candidate.value,
        ...controlMetadata,
      };
    case "setChecked":
      return typeof candidate.selector === "string" && typeof candidate.value === "boolean"
        ? {
            eventId: candidate.eventId,
            timestamp: candidate.timestamp,
            type: candidate.type,
            ...selectorFields(candidate.selector),
            value: candidate.value,
            ...controlMetadata,
          }
        : null;
    case "press":
      return typeof candidate.value === "string" && candidate.value === "Enter"
        ? {
            eventId: candidate.eventId,
            timestamp: candidate.timestamp,
            type: candidate.type,
            value: candidate.value,
          }
        : null;
    case "scroll":
      return typeof candidate.value === "number" && Number.isFinite(candidate.value)
        ? {
            eventId: candidate.eventId,
            timestamp: candidate.timestamp,
            type: candidate.type,
            value: Math.max(0, Math.round(candidate.value)),
          }
        : null;
    default:
      return null;
  }
};

const parseConsoleEvent = (message: RecorderConsoleMessage): RawRecordedPageEvent | null => {
  try {
    const text = message.text();
    if (!text.startsWith(RECORDING_CONSOLE_PREFIX)) return null;
    return normalizeRawEvent(JSON.parse(text.slice(RECORDING_CONSOLE_PREFIX.length)));
  } catch {
    return null;
  }
};

const safePageUrl = (page: RecorderPage): string => {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
};

export async function startBrowserRecorder(
  options: BrowserRecorderOptions,
): Promise<BrowserRecorderHandle> {
  if (!isRecorderPage(options.rootPage)) {
    throw new Error("录制目标不是有效的 Stagehand Page。");
  }

  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const popupAssociationWindowMs = Math.max(
    500,
    options.popupAssociationWindowMs ?? DEFAULT_POPUP_ASSOCIATION_WINDOW_MS,
  );
  const rootPage = options.rootPage;
  const objectKeys = new WeakMap<object, string>();
  let nextObjectKey = 0;
  let nextPageNumber = 1;
  let nextActionNumber = 0;
  let stopping = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollInFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const trackedPages = new Map<string, TrackedPage>();
  const allTrackedPages: TrackedPage[] = [];
  const knownPageKeys = new Set<string>();
  const pendingPages = new Map<string, PendingPage>();
  const recentClicks: RecentClick[] = [];

  const reportError = async (error: unknown, fallback: string): Promise<void> => {
    if (!options.onError) return;
    try {
      await options.onError(asError(error, fallback));
    } catch {
      // An error observer must not recursively stop recorder cleanup.
    }
  };

  const pageKey = (page: RecorderPage): string => {
    try {
      const targetId = page.targetId?.();
      if (typeof targetId === "string" && targetId) return `target:${targetId}`;
    } catch {
      // Fall back to object identity while Chrome is changing target state.
    }
    const object = page as object;
    const existing = objectKeys.get(object);
    if (existing) return existing;
    const key = `object:${++nextObjectKey}`;
    objectKeys.set(object, key);
    return key;
  };

  const readPages = async (): Promise<RecorderPage[]> => {
    const values = await options.getPages();
    if (!Array.isArray(values)) throw new Error("BrowserRecorder getPages() 必须返回页面数组。");
    return values.filter(isRecorderPage);
  };

  const installOnPage = async (page: RecorderPage, id: string): Promise<TrackedPage> => {
    const key = pageKey(page);
    const consoleEvents: RawRecordedPageEvent[] = [];
    const consoleListener = (message: RecorderConsoleMessage): void => {
      const event = parseConsoleEvent(message);
      if (event) consoleEvents.push(event);
    };
    page.on?.("console", consoleListener);

    let initScriptIdentifier = "";
    try {
      const result = await page.sendCDP<{ identifier?: string }>(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: RECORDING_PAGE_EVENT_SCRIPT },
      );
      if (!result || typeof result.identifier !== "string" || !result.identifier) {
        throw new Error("Chrome 未返回新文档脚本 identifier。");
      }
      initScriptIdentifier = result.identifier;

      try {
        await page.evaluate(RECORDING_PAGE_EVENT_SCRIPT);
      } catch (firstError) {
        if (typeof page.waitForLoadState === "function") {
          await page.waitForLoadState("domcontentloaded", 2_000).catch(() => undefined);
        }
        try {
          await page.evaluate(RECORDING_PAGE_EVENT_SCRIPT);
        } catch {
          throw firstError;
        }
      }
    } catch (error) {
      page.off?.("console", consoleListener);
      if (initScriptIdentifier) {
        await page
          .sendCDP("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: initScriptIdentifier,
          })
          .catch(() => undefined);
      }
      throw asError(error, `无法在 ${id} 安装录制监听器。`);
    }

    const tracked: TrackedPage = {
      key,
      id,
      page,
      initScriptIdentifier,
      consoleListener,
      consoleEvents,
      seenEventIds: new Set(),
      closed: false,
    };
    trackedPages.set(key, tracked);
    allTrackedPages.push(tracked);
    knownPageKeys.add(key);
    return tracked;
  };

  const actionFromEvent = (
    trackedPage: TrackedPage,
    event: RawRecordedPageEvent,
  ): RecordedAction => {
    const id = `action-${++nextActionNumber}`;
    const base = {
      id,
      order: nextActionNumber,
      pageId: trackedPage.id,
      included: true,
    };
    if (event.type === "manualStep") {
      if (
        typeof event.selector !== "string" ||
        !event.controlKind ||
        typeof event.displayName !== "string"
      ) {
        throw new Error(`人工步骤事件 ${event.eventId} 缺少目标元数据。`);
      }
      return {
        ...base,
        type: "manualStep",
        title: "请完成人工输入",
        targets: [
          {
            selector: event.selector,
            controlKind: event.controlKind,
            displayName: event.displayName,
            ...(event.required !== undefined ? { required: event.required } : {}),
          },
        ],
      };
    }

    const action: AutomatedRecordedAction = { ...base, type: event.type };
    if (event.selector !== undefined) action.selector = event.selector;
    if (event.structuralSelector !== undefined) {
      action.structuralSelector = event.structuralSelector;
    }
    if (event.value !== undefined) action.value = event.value;
    if (event.controlKind !== undefined) action.controlKind = event.controlKind;
    if (event.displayName !== undefined) action.displayName = event.displayName;
    if (event.required !== undefined) action.required = event.required;
    return action;
  };

  const processCollectedEvents = async (events: CollectedPageEvent[]): Promise<void> => {
    events.sort(
      (left, right) =>
        left.event.timestamp - right.event.timestamp ||
        left.event.eventId.localeCompare(right.event.eventId),
    );

    for (const collected of events) {
      const event = normalizeRawEvent(collected.event);
      if (!event || collected.page.seenEventIds.has(event.eventId)) continue;
      collected.page.seenEventIds.add(event.eventId);
      if (collected.page.seenEventIds.size > 5_000) {
        const retained = [...collected.page.seenEventIds].slice(-2_500);
        collected.page.seenEventIds = new Set(retained);
      }

      const action = actionFromEvent(collected.page, event);
      await options.onAction(action);
      if (action.type === "click") {
        recentClicks.push({ action, capturedAt: event.timestamp, consumed: false });
        if (recentClicks.length > 50) recentClicks.splice(0, recentClicks.length - 50);
      }
    }
  };

  const collectPageEvents = async (
    pagesToCollect: readonly TrackedPage[],
    stopAndDrain = false,
  ): Promise<CollectedPageEvent[]> => {
    const collected: CollectedPageEvent[] = [];
    for (const tracked of pagesToCollect) {
      const consoleEvents = tracked.consoleEvents.splice(0, tracked.consoleEvents.length);
      for (const event of consoleEvents) collected.push({ page: tracked, event });
      if (tracked.closed) continue;
      try {
        const expression = stopAndDrain
          ? STOP_RECORDING_PAGE_EVENTS_EXPRESSION
          : DRAIN_RECORDING_PAGE_EVENTS_EXPRESSION;
        const queued = await tracked.page.evaluate<unknown>(expression);
        if (Array.isArray(queued)) {
          for (const value of queued) {
            const event = normalizeRawEvent(value);
            if (event) collected.push({ page: tracked, event });
          }
        }
      } catch {
        // A navigation can replace the execution context between two polls. The console channel
        // preserves events emitted before replacement, and the init script installs on the next doc.
      }
      const eventsArrivingDuringDrain = tracked.consoleEvents.splice(
        0,
        tracked.consoleEvents.length,
      );
      for (const event of eventsArrivingDuringDrain) collected.push({ page: tracked, event });
    }
    return collected;
  };

  const newestUnconsumedClick = (at: number): RecentClick | null => {
    for (let index = recentClicks.length - 1; index >= 0; index -= 1) {
      const click = recentClicks[index];
      if (click.consumed) continue;
      if (at - click.capturedAt > popupAssociationWindowMs) break;
      if (click.action.pageId !== "page0") return null;
      return click;
    }
    return null;
  };

  const discoverPages = async (currentPages: RecorderPage[], now: number): Promise<void> => {
    const currentKeys = new Set(currentPages.map(pageKey));

    for (const page of currentPages) {
      const key = pageKey(page);
      if (knownPageKeys.has(key)) continue;
      if (!pendingPages.has(key)) pendingPages.set(key, { page, firstSeenAt: now });
    }

    for (const [key, pending] of pendingPages) {
      if (!currentKeys.has(key)) {
        pendingPages.delete(key);
        continue;
      }
      const sourceClick = newestUnconsumedClick(now);
      if (!sourceClick) {
        if (now - pending.firstSeenAt >= popupAssociationWindowMs) {
          knownPageKeys.add(key);
          pendingPages.delete(key);
          await reportError(
            new Error("检测到没有近期 page0 点击可关联的新页面，已按无关页面忽略。"),
            "无法关联新页面。",
          );
        }
        continue;
      }

      sourceClick.consumed = true;
      const pageId = `page${nextPageNumber++}`;
      const tracked = await installOnPage(pending.page, pageId);
      pendingPages.delete(key);
      const recordedPage: RecordedPage = {
        id: pageId,
        url: safePageUrl(tracked.page),
        openerPageId: sourceClick.action.pageId,
      };
      await options.onPageOpened(recordedPage);

      const updatedClick: RecordedAction = { ...sourceClick.action, opensPageId: pageId };
      sourceClick.action = updatedClick;
      if (options.onActionUpdated) await options.onActionUpdated(updatedClick);
      else await options.onAction(updatedClick);
    }

    for (const [key, tracked] of trackedPages) {
      if (tracked.id === "page0" || tracked.closed || currentKeys.has(key)) continue;
      tracked.closed = true;
      trackedPages.delete(key);
      tracked.page.off?.("console", tracked.consoleListener);
      const closeAction: RecordedAction = {
        id: `action-${++nextActionNumber}`,
        order: nextActionNumber,
        pageId: tracked.id,
        type: "closePage",
        included: true,
      };
      await options.onAction(closeAction);
    }

    const rootKey = pageKey(rootPage);
    if (!currentKeys.has(rootKey) && !stopping) {
      await reportError(new Error("录制的初始页面已关闭。"), "录制初始页面不可用。");
    }
  };

  const pollOnce = async (): Promise<void> => {
    const events = await collectPageEvents([...trackedPages.values()]);
    await processCollectedEvents(events);
    const pages = await readPages();
    await discoverPages(pages, Date.now());
  };

  const schedulePoll = (): void => {
    if (stopping || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (stopping) return;
      const operation = pollOnce()
        .catch((error) => reportError(error, "浏览器录制轮询失败。"))
        .finally(() => {
          if (pollInFlight === operation) pollInFlight = null;
          schedulePoll();
        });
      pollInFlight = operation;
    }, pollIntervalMs);
  };

  const initialPages = await readPages();
  for (const page of initialPages) knownPageKeys.add(pageKey(page));
  const rootKey = pageKey(rootPage);
  knownPageKeys.add(rootKey);
  await installOnPage(rootPage, "page0");
  schedulePoll();

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      await pollInFlight?.catch(() => undefined);
      pollInFlight = null;

      let currentKeys = new Set<string>();
      try {
        currentKeys = new Set((await readPages()).map(pageKey));
      } catch {
        // Cleanup still attempts every tracked page if the context is already disconnecting.
      }

      const cleanupErrors: Error[] = [];
      for (const tracked of allTrackedPages) {
        if (tracked.closed || (currentKeys.size > 0 && !currentKeys.has(tracked.key))) continue;
        try {
          await tracked.page.sendCDP("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: tracked.initScriptIdentifier,
          });
        } catch (error) {
          cleanupErrors.push(
            asError(error, `无法移除 ${tracked.id} 的新文档录制脚本，页面可能已关闭。`),
          );
        }
      }

      const finalEvents = await collectPageEvents(allTrackedPages, true);
      await processCollectedEvents(finalEvents);
      for (const tracked of allTrackedPages) {
        tracked.page.off?.("console", tracked.consoleListener);
        tracked.consoleEvents.length = 0;
      }
      trackedPages.clear();
      pendingPages.clear();

      if (cleanupErrors.length > 0) {
        const error = new AggregateError(cleanupErrors, "未能完整移除页面录制脚本。");
        await reportError(error, error.message);
        throw error;
      }
    })();
    return stopPromise;
  };

  return { stop };
}
