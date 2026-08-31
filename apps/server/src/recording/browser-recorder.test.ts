import { Script } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { startBrowserRecorder } from "./browser-recorder.js";
import {
  DRAIN_RECORDING_PAGE_EVENTS_EXPRESSION,
  RECORDING_CONSOLE_PREFIX,
  RECORDING_PAGE_EVENT_SCRIPT,
  STOP_RECORDING_PAGE_EVENTS_EXPRESSION,
  type RawRecordedPageEvent,
} from "./page-event-script.js";
import type { RecordedAction, RecordedPage } from "./recording-types.js";

class FakePage {
  readonly queuedEvents: RawRecordedPageEvent[] = [];
  readonly cdpCalls: Array<{ method: string; params?: object }> = [];
  installed = false;
  private readonly consoleListeners = new Set<(message: { text: () => string }) => void>();

  constructor(
    private readonly id: string,
    private readonly currentUrl: string,
  ) {}

  targetId(): string {
    return this.id;
  }

  url(): string {
    return this.currentUrl;
  }

  async sendCDP<Result = unknown>(method: string, params?: object): Promise<Result> {
    this.cdpCalls.push({ method, params });
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      return { identifier: `init-${this.id}` } as Result;
    }
    return {} as Result;
  }

  async evaluate<Result = unknown>(expression: string): Promise<Result> {
    if (expression === RECORDING_PAGE_EVENT_SCRIPT) {
      this.installed = true;
      return undefined as Result;
    }
    if (
      expression === DRAIN_RECORDING_PAGE_EVENTS_EXPRESSION ||
      expression === STOP_RECORDING_PAGE_EVENTS_EXPRESSION
    ) {
      return this.queuedEvents.splice(0, this.queuedEvents.length) as Result;
    }
    return undefined as Result;
  }

  on(_event: "console", listener: (message: { text: () => string }) => void): void {
    this.consoleListeners.add(listener);
  }

  off(_event: "console", listener: (message: { text: () => string }) => void): void {
    this.consoleListeners.delete(listener);
  }
}

const waitFor = async (condition: () => boolean, timeoutMs = 1_500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for recorder state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const rawEvent = (
  eventId: string,
  type: RawRecordedPageEvent["type"],
  fields: Pick<RawRecordedPageEvent, "selector" | "structuralSelector" | "value"> = {},
): RawRecordedPageEvent => ({
  eventId,
  timestamp: Date.now(),
  type,
  ...fields,
});

describe("BrowserRecorder", () => {
  it("installs valid browser source and records popup actions, close, and sensitive filtering", async () => {
    expect(() => new Script(RECORDING_PAGE_EVENT_SCRIPT)).not.toThrow();

    const root = new FakePage("root", "https://example.com");
    const popup = new FakePage("popup", "https://example.com/details");
    let pages: FakePage[] = [root];
    const actions: RecordedAction[] = [];
    const updatedActions: RecordedAction[] = [];
    const openedPages: RecordedPage[] = [];
    const onError = vi.fn();

    const recorder = await startBrowserRecorder({
      rootPage: root,
      getPages: () => pages,
      pollIntervalMs: 50,
      onAction: (action) => {
        actions.push(action);
      },
      onActionUpdated: (action) => {
        updatedActions.push(action);
      },
      onPageOpened: (page) => {
        openedPages.push(page);
      },
      onError,
    });
    expect(root.installed).toBe(true);

    root.queuedEvents.push(
      rawEvent("click-1", "click", {
        selector: "#details",
        structuralSelector: "body > main > ul > li:nth-of-type(1) > a",
      }),
    );
    pages = [root, popup];
    await waitFor(() => openedPages.length === 1 && updatedActions.length === 1);
    expect(actions[0]).toMatchObject({
      selector: "#details",
      structuralSelector: "body > main > ul > li:nth-of-type(1) > a",
    });
    expect(openedPages[0]).toMatchObject({ id: "page1", openerPageId: "page0" });
    expect(updatedActions[0]).toMatchObject({ id: "action-1", opensPageId: "page1" });
    expect(popup.installed).toBe(true);

    popup.queuedEvents.push(
      rawEvent("secret-1", "fill", {
        selector: '[name="password"]',
        value: "canary-secret-must-not-escape",
      }),
      rawEvent("fill-1", "fill", { selector: "#quantity", value: "2" }),
    );
    await waitFor(() => actions.some((action) => action.selector === "#quantity"));
    expect(actions.some((action) => action.value === "canary-secret-must-not-escape")).toBe(false);

    pages = [root];
    await waitFor(() => actions.some((action) => action.type === "closePage"));
    await recorder.stop();

    expect(actions.map((action) => action.type)).toEqual(["click", "fill", "closePage"]);
    expect(
      root.cdpCalls.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toBe(true);
    expect(
      popup.cdpCalls.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("recording page structural selectors", () => {
  it("keeps only classes shared by repeated same-tag siblings", () => {
    interface BrowserElementFixture {
      nodeType: number;
      tagName: string;
      id: string;
      classList: string[];
      parentElement: BrowserElementFixture | null;
      children: BrowserElementFixture[];
      getAttribute: (name: string) => string | null;
      closest: () => BrowserElementFixture;
    }
    const element = (
      tagName: string,
      classList: string[] = [],
      attributes: Record<string, string> = {},
    ): BrowserElementFixture => {
      const fixture: BrowserElementFixture = {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        id: "",
        classList,
        parentElement: null,
        children: [],
        getAttribute: (name: string) => attributes[name] ?? null,
        closest: () => fixture,
      };
      return fixture;
    };
    const append = (parent: BrowserElementFixture, ...children: BrowserElementFixture[]): void => {
      parent.children.push(...children);
      for (const child of children) child.parentElement = parent;
    };

    const body = element("body");
    const list = element("ul", ["results"]);
    const featuredItem = element("li", ["result", "featured"]);
    const regularItem = element("li", ["result"]);
    const link = element("a", ["result-link"], { "data-testid": "first-link" });
    append(body, list);
    append(list, featuredItem, regularItem);
    append(featuredItem, link);

    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const consoleDebug = vi.fn();
    const documentFixture = {
      querySelectorAll: () => [],
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const context = {
      document: documentFixture,
      console: { debug: consoleDebug },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setTimeout,
      clearTimeout,
      Date,
    };

    new Script(RECORDING_PAGE_EVENT_SCRIPT).runInNewContext(context);
    listeners.get("click")?.({ target: link });

    const message = String(consoleDebug.mock.calls[0]?.[0] ?? "");
    expect(message.startsWith(RECORDING_CONSOLE_PREFIX)).toBe(true);
    const event = JSON.parse(message.slice(RECORDING_CONSOLE_PREFIX.length)) as {
      selector: string;
      structuralSelector: string;
    };
    expect(event.selector).toBe('[data-testid="first-link"]');
    expect(event.structuralSelector).toBe(
      "body > ul.results > li.result:nth-of-type(1) > a.result-link",
    );
    expect(event.structuralSelector).not.toContain("featured");
  });
});
