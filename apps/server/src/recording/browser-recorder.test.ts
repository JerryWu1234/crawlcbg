import { Script } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { startBrowserRecorder } from "./browser-recorder.js";
import {
  DRAIN_RECORDING_PAGE_EVENTS_EXPRESSION,
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

let rawEventTimestamp = Date.now();
const rawEvent = (
  eventId: string,
  type: RawRecordedPageEvent["type"],
  fields: Partial<Omit<RawRecordedPageEvent, "eventId" | "timestamp" | "type">> = {},
): RawRecordedPageEvent => ({
  eventId,
  timestamp: ++rawEventTimestamp,
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

    root.queuedEvents.push(rawEvent("click-1", "click", { selector: "#details" }));
    pages = [root, popup];
    await waitFor(() => openedPages.length === 1 && updatedActions.length === 1);
    expect(openedPages[0]).toMatchObject({ id: "page1", openerPageId: "page0" });
    expect(updatedActions[0]).toMatchObject({ id: "action-1", opensPageId: "page1" });
    expect(popup.installed).toBe(true);

    popup.queuedEvents.push(
      rawEvent("secret-1", "fill", {
        selector: '[name="password"]',
        value: "canary-secret-must-not-escape",
      }),
      rawEvent("manual-secret-1", "manualStep", {
        selector: '[name="password"]',
        sensitive: true,
        controlKind: "secret",
        displayName: "密码",
        required: true,
      }),
      rawEvent("fill-1", "fill", {
        selector: "#quantity",
        value: "2",
        controlKind: "text",
        displayName: "数量",
      }),
    );
    await waitFor(() => actions.some((action) => action.selector === "#quantity"));
    expect(actions.some((action) => action.value === "canary-secret-must-not-escape")).toBe(false);
    expect(actions.find((action) => action.type === "manualStep")).toMatchObject({
      title: "请完成人工输入",
      targets: [
        {
          selector: '[name="password"]',
          controlKind: "secret",
          displayName: "密码",
          required: true,
        },
      ],
    });

    pages = [root];
    await waitFor(() => actions.some((action) => action.type === "closePage"));
    await recorder.stop();

    expect(actions.map((action) => action.type)).toEqual([
      "click",
      "manualStep",
      "fill",
      "closePage",
    ]);
    expect(
      root.cdpCalls.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toBe(true);
    expect(
      popup.cdpCalls.some((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});
