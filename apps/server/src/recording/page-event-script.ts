import type { ManualControlKind } from "./recording-types.js";

export const RECORDING_PAGE_STATE_KEY = "__crawlcbgBrowserRecorderV1";
export const RECORDING_CONSOLE_PREFIX = "__CRAWLCBG_RECORDING_EVENT_V1__";

export interface RawRecordedPageEvent {
  eventId: string;
  timestamp: number;
  type: "click" | "fill" | "select" | "setChecked" | "press" | "scroll" | "manualStep";
  selector?: string;
  structuralSelector?: string;
  value?: string | boolean | string[] | number;
  sensitive?: boolean;
  controlKind?: ManualControlKind;
  displayName?: string;
  required?: boolean;
}

interface RecordingPageScriptConfig {
  stateKey: string;
  consolePrefix: string;
}

/**
 * This function is serialized and executed in Chrome. Keep all browser-side helpers scoped inside
 * it so the generated source has no server-side closure dependencies.
 */
function installRecordingPageEventListeners(config: RecordingPageScriptConfig): void {
  type BrowserElement = Record<string, any>;
  type BrowserEvent = Record<string, any>;
  type BrowserGlobal = typeof globalThis &
    Record<string, any> & {
      document: Record<string, any>;
      CSS?: { escape?: (value: string) => string };
      scrollY?: number;
    };

  const browserGlobal = globalThis as BrowserGlobal;
  const browserDocument = browserGlobal.document;
  if (browserGlobal[config.stateKey]) return;

  const listeners: Array<[Record<string, any>, string, (event: BrowserEvent) => void, boolean]> =
    [];
  const pendingFills = new Map<BrowserElement, ReturnType<typeof setTimeout>>();
  const lastFillValues = new WeakMap<object, string>();
  const activeSensitiveTargets = new WeakSet<object>();
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let sequence = 0;
  let disposed = false;
  const queue: RawRecordedPageEvent[] = [];

  const isElement = (value: unknown): value is BrowserElement =>
    Boolean(value && typeof value === "object" && (value as BrowserElement).nodeType === 1);
  const tagName = (element: BrowserElement): string =>
    typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  const isTag = (element: BrowserElement, expected: string): boolean =>
    tagName(element) === expected;
  const isContentEditable = (element: BrowserElement): boolean =>
    element.isContentEditable === true || element.getAttribute?.("contenteditable") === "true";
  const escapeAttribute = (value: unknown): string =>
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\n\r\f]/g, " ");
  const escapeIdentifier = (value: unknown): string => {
    if (typeof browserGlobal.CSS?.escape === "function") {
      return browserGlobal.CSS.escape(String(value));
    }
    return String(value).replace(
      /[^a-zA-Z0-9_-]/g,
      (character) => `\\${character.codePointAt(0)?.toString(16) ?? "20"} `,
    );
  };
  const isStableToken = (value: unknown): boolean => {
    const text = (typeof value === "string" ? value : "").trim();
    return (
      text.length > 0 &&
      text.length <= 80 &&
      !/(?:^|[-_])\d{6,}(?:$|[-_])/i.test(text) &&
      !/^[a-f\d]{16,}$/i.test(text) &&
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(text)
    );
  };
  const isUniqueSelector = (selector: string): boolean => {
    try {
      return browserDocument.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const attributeSelector = (name: string, value: unknown): string =>
    `[${name}="${escapeAttribute(value)}"]`;

  const structuralSelectorFor = (
    element: BrowserElement,
    stopWhenUnique: boolean,
    sharedRepeatedClassesOnly: boolean,
  ): string | null => {
    if (!isElement(element)) return null;

    const segments: string[] = [];
    let current: BrowserElement | null = element;
    for (let depth = 0; current && depth < 7; depth += 1) {
      const currentTag = tagName(current);
      if (!currentTag) break;
      let segment = currentTag;
      const parent: BrowserElement | null = isElement(current.parentElement)
        ? current.parentElement
        : null;
      const sameTagSiblings = parent
        ? Array.from(parent.children || []).filter(
            (child): child is BrowserElement => isElement(child) && tagName(child) === currentTag,
          )
        : [];
      const stableClasses = Array.from(current.classList || [])
        .map(String)
        .filter(isStableToken)
        .filter((token) => !/(active|focus|hover|selected|open|disabled|ng-|css-)/i.test(token))
        .filter(
          (token) =>
            !sharedRepeatedClassesOnly ||
            sameTagSiblings.length <= 1 ||
            sameTagSiblings.filter((sibling) =>
              Array.from(sibling.classList || [])
                .map(String)
                .includes(token),
            ).length >= 2,
        )
        .slice(0, 2);
      if (stableClasses.length > 0) {
        segment += stableClasses.map((token) => `.${escapeIdentifier(token)}`).join("");
      }

      if (parent && sameTagSiblings.length > 1) {
        segment += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
      segments.unshift(segment);
      const selector = segments.join(" > ");
      if (stopWhenUnique && isUniqueSelector(selector)) return selector;
      current = parent;
    }

    return segments.join(" > ") || null;
  };

  const selectorFor = (element: BrowserElement): string | null => {
    if (!isElement(element)) return null;

    const testId = element.getAttribute?.("data-testid");
    if (testId) return attributeSelector("data-testid", testId);

    if (isStableToken(element.id)) {
      const selector = `#${escapeIdentifier(element.id)}`;
      if (isUniqueSelector(selector)) return selector;
    }

    const name = element.getAttribute?.("name");
    if (name) {
      const selector = attributeSelector("name", name);
      if (isUniqueSelector(selector)) return selector;
    }

    const ariaLabel = element.getAttribute?.("aria-label");
    if (ariaLabel) {
      const selector = attributeSelector("aria-label", ariaLabel);
      if (isUniqueSelector(selector)) return selector;
    }

    return structuralSelectorFor(element, true, false);
  };

  const secretPattern =
    /(?:password|passwd|pwd|passcode|one[\s_-]?time|otp|verification|verify[\s_-]?code|captcha|token|secret|api[\s_-]?key|access[\s_-]?key|auth[\s_-]?code|credit[\s_-]?card|card[\s_-]?(?:number|no)|cc[\s_-]?(?:number|num|csc)|cvv|cvc|security[\s_-]?code)/i;
  const accountPattern = /(?:user[\s_-]?name|login|account|e[\s_-]?mail|member[\s_-]?id)/i;
  const metadataText = (element: BrowserElement): string =>
    [
      element.getAttribute?.("type"),
      element.getAttribute?.("name"),
      element.getAttribute?.("id"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("autocomplete"),
      element.getAttribute?.("data-testid"),
    ]
      .filter(Boolean)
      .join(" ");
  const sensitiveControlKind = (element: BrowserElement): ManualControlKind | null => {
    if (!isElement(element)) return "secret";
    const inputType = String(element.type || "").toLowerCase();
    const autocomplete = String(element.getAttribute?.("autocomplete") || "").toLowerCase();
    const autocompleteTokens = autocomplete.split(/\s+/);
    if (
      (isTag(element, "input") && inputType === "password") ||
      autocompleteTokens.some((token) =>
        ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(
          token,
        ),
      ) ||
      secretPattern.test(metadataText(element))
    ) {
      return "secret";
    }
    if (
      (isTag(element, "input") && inputType === "email") ||
      autocompleteTokens.some((token) => ["username", "email"].includes(token)) ||
      accountPattern.test(metadataText(element))
    ) {
      return "text";
    }
    return null;
  };
  const controlKindFor = (element: BrowserElement): ManualControlKind => {
    const sensitiveKind = sensitiveControlKind(element);
    if (sensitiveKind) return sensitiveKind;
    const inputType = String(element.type || "").toLowerCase();
    if (isTag(element, "select")) return element.multiple === true ? "multiSelect" : "select";
    if (isTag(element, "input") && inputType === "checkbox") return "checkbox";
    if (isTag(element, "input") && inputType === "radio") return "radioGroup";
    if (
      isTag(element, "input") &&
      ["date", "datetime-local", "month", "time", "week"].includes(inputType)
    ) {
      return "date";
    }
    return "text";
  };
  const displayNameFor = (element: BrowserElement, fallback: string): string => {
    const firstLabel = Array.from(element.labels || []).find(isElement);
    const candidates = [
      element.getAttribute?.("aria-label"),
      firstLabel?.innerText,
      firstLabel?.textContent,
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("name"),
      element.getAttribute?.("id"),
    ];
    for (const candidate of candidates) {
      const normalized = typeof candidate === "string" ? candidate.replace(/\s+/g, " ").trim() : "";
      if (normalized) return normalized.slice(0, 120);
    }
    return fallback;
  };
  const controlMetadataFor = (
    element: BrowserElement,
    controlKind = controlKindFor(element),
  ): Pick<RawRecordedPageEvent, "controlKind" | "displayName" | "required"> => ({
    controlKind,
    displayName: displayNameFor(
      element,
      controlKind === "secret" ? "敏感信息" : controlKind === "text" ? "文本输入" : "表单控件",
    ),
    required:
      element.required === true || String(element.getAttribute?.("aria-required") || "") === "true",
  });

  const emit = (event: Omit<RawRecordedPageEvent, "eventId" | "timestamp">): void => {
    if (disposed) return;
    const timestamp = Date.now();
    const payload: RawRecordedPageEvent = {
      ...event,
      eventId: `${timestamp}-${++sequence}`,
      timestamp,
    };
    queue.push(payload);
    if (queue.length > 1000) queue.splice(0, queue.length - 1000);
    try {
      console.debug(`${config.consolePrefix}${JSON.stringify(payload)}`);
    } catch {
      // Polling the in-page queue remains available if console forwarding is blocked.
    }
  };

  const emitSensitiveManualStep = (element: BrowserElement): boolean => {
    const controlKind = sensitiveControlKind(element);
    if (!controlKind) return false;
    if (activeSensitiveTargets.has(element)) return true;
    activeSensitiveTargets.add(element);
    const selector = selectorFor(element);
    if (!selector) return true;
    emit({
      type: "manualStep",
      selector,
      sensitive: true,
      ...controlMetadataFor(element, controlKind),
    });
    return true;
  };

  const valueForFill = (element: BrowserElement): string | null => {
    if (isTag(element, "input") || isTag(element, "textarea")) {
      return typeof element.value === "string" ? element.value : "";
    }
    if (isContentEditable(element))
      return typeof element.textContent === "string" ? element.textContent : "";
    return null;
  };

  const flushFill = (element: BrowserElement): void => {
    const timer = pendingFills.get(element);
    if (timer) clearTimeout(timer);
    pendingFills.delete(element);
    // Sensitive controls emit a metadata-only marker before valueForFill can read their value.
    if (!isElement(element) || emitSensitiveManualStep(element)) return;
    const selector = selectorFor(element);
    if (!selector) return;
    const value = valueForFill(element);
    if (value === null || lastFillValues.get(element) === value) return;
    lastFillValues.set(element, value);
    emit({
      type: "fill",
      selector,
      structuralSelector: structuralSelectorFor(element, false, true) ?? selector,
      value,
      ...controlMetadataFor(element),
    });
  };

  const scheduleFill = (element: BrowserElement): void => {
    if (!isElement(element) || emitSensitiveManualStep(element)) {
      const timer = pendingFills.get(element);
      if (timer) clearTimeout(timer);
      pendingFills.delete(element);
      return;
    }
    const previous = pendingFills.get(element);
    if (previous) clearTimeout(previous);
    pendingFills.set(
      element,
      setTimeout(() => flushFill(element), 350),
    );
  };

  const eventElement = (event: BrowserEvent): BrowserElement | null =>
    isElement(event.target) ? event.target : null;

  const onClick = (event: BrowserEvent): void => {
    const origin = eventElement(event);
    if (!origin || typeof origin.closest !== "function") return;
    const target = origin.closest(
      'button, a, input, textarea, select, summary, [role="button"], [role="link"], [role="combobox"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [aria-haspopup], [contenteditable="true"], [tabindex]',
    );
    if (!isElement(target)) return;
    const inputType = String(target.type || "").toLowerCase();
    const targetRole = String(target.getAttribute?.("role") || "").toLowerCase();
    const isCustomDropdownTrigger =
      targetRole === "combobox" || Boolean(target.getAttribute?.("aria-haspopup"));
    if (
      isTag(target, "select") ||
      isTag(target, "textarea") ||
      (isTag(target, "input") &&
        !["button", "submit", "reset", "image"].includes(inputType) &&
        !isCustomDropdownTrigger) ||
      isContentEditable(target)
    ) {
      return;
    }
    const selector = selectorFor(target);
    if (selector) {
      emit({
        type: "click",
        selector,
        structuralSelector: structuralSelectorFor(target, false, true) ?? selector,
      });
    }
  };

  const onFocusIn = (event: BrowserEvent): void => {
    const target = eventElement(event);
    if (!target) return;
    if (isTag(target, "input") || isTag(target, "textarea") || isContentEditable(target)) {
      emitSensitiveManualStep(target);
    }
  };

  const onFocusOut = (event: BrowserEvent): void => {
    const target = eventElement(event);
    if (target) activeSensitiveTargets.delete(target);
  };

  const onInput = (event: BrowserEvent): void => {
    const target = eventElement(event);
    if (!target) return;
    const inputType = String(target.type || "").toLowerCase();
    if (
      isTag(target, "select") ||
      (isTag(target, "input") && ["checkbox", "radio"].includes(inputType))
    ) {
      return;
    }
    if (isTag(target, "input") || isTag(target, "textarea") || isContentEditable(target)) {
      scheduleFill(target);
    }
  };

  const onChange = (event: BrowserEvent): void => {
    const target = eventElement(event);
    if (!target || emitSensitiveManualStep(target)) return;
    if (isTag(target, "select")) {
      const selector = selectorFor(target);
      if (!selector) return;
      const value = target.multiple
        ? Array.from(target.selectedOptions || []).map((option) =>
            String((option as BrowserElement).value ?? ""),
          )
        : String(target.value ?? "");
      emit({
        type: "select",
        selector,
        structuralSelector: structuralSelectorFor(target, false, true) ?? selector,
        value,
        ...controlMetadataFor(target),
      });
      return;
    }
    const inputType = String(target.type || "").toLowerCase();
    if (isTag(target, "input") && ["checkbox", "radio"].includes(inputType)) {
      const selector = selectorFor(target);
      if (selector) {
        emit({
          type: "setChecked",
          selector,
          structuralSelector: structuralSelectorFor(target, false, true) ?? selector,
          value: target.checked === true,
          ...controlMetadataFor(target),
        });
      }
      return;
    }
    if (isTag(target, "input") || isTag(target, "textarea") || isContentEditable(target)) {
      flushFill(target);
    }
  };

  const onKeyDown = (event: BrowserEvent): void => {
    if (event.key !== "Enter" || event.isComposing === true || event.repeat === true) return;
    const target = eventElement(event);
    if (target && pendingFills.has(target)) flushFill(target);
    emit({ type: "press", value: "Enter" });
  };

  const flushScroll = (): void => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    emit({ type: "scroll", value: Math.max(0, Math.round(browserGlobal.scrollY || 0)) });
  };
  const onScroll = (): void => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(flushScroll, 250);
  };

  const add = (
    target: Record<string, any>,
    type: string,
    listener: (event: BrowserEvent) => void,
  ): void => {
    target.addEventListener(type, listener, true);
    listeners.push([target, type, listener, true]);
  };
  const drain = (): RawRecordedPageEvent[] => queue.splice(0, queue.length);
  const stopAndDrain = (): RawRecordedPageEvent[] => {
    for (const element of Array.from(pendingFills.keys())) flushFill(element);
    if (scrollTimer) flushScroll();
    disposed = true;
    for (const [target, type, listener, capture] of listeners) {
      target.removeEventListener(type, listener, capture);
    }
    listeners.length = 0;
    for (const timer of pendingFills.values()) clearTimeout(timer);
    pendingFills.clear();
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = null;
    const remaining = drain();
    delete browserGlobal[config.stateKey];
    return remaining;
  };

  add(browserDocument, "click", onClick);
  add(browserDocument, "focusin", onFocusIn);
  add(browserDocument, "focusout", onFocusOut);
  add(browserDocument, "input", onInput);
  add(browserDocument, "change", onChange);
  add(browserDocument, "keydown", onKeyDown);
  add(browserGlobal, "scroll", onScroll);
  browserGlobal[config.stateKey] = { drain, stopAndDrain };
}

const pageScriptConfig: RecordingPageScriptConfig = {
  stateKey: RECORDING_PAGE_STATE_KEY,
  consolePrefix: RECORDING_CONSOLE_PREFIX,
};

export const RECORDING_PAGE_EVENT_SCRIPT = `(${installRecordingPageEventListeners.toString()})(${JSON.stringify(pageScriptConfig)});`;

export const DRAIN_RECORDING_PAGE_EVENTS_EXPRESSION = `(() => {
  const state = globalThis[${JSON.stringify(RECORDING_PAGE_STATE_KEY)}];
  return state && typeof state.drain === "function" ? state.drain() : [];
})()`;

export const STOP_RECORDING_PAGE_EVENTS_EXPRESSION = `(() => {
  const state = globalThis[${JSON.stringify(RECORDING_PAGE_STATE_KEY)}];
  return state && typeof state.stopAndDrain === "function" ? state.stopAndDrain() : [];
})()`;
