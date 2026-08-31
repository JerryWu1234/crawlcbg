import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPace } from "./pace.js";

const finishTimers = async <T>(operation: Promise<T>): Promise<T> => {
  await vi.runAllTimersAsync();
  return await operation;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createPace", () => {
  it("keeps the legacy (page, signal) signature working", async () => {
    vi.useFakeTimers();
    const locator = { click: vi.fn(async () => "clicked") };
    const page = {
      locator: vi.fn(() => ({ first: () => locator })),
    };
    const pace = createPace(page, new AbortController().signal);

    await expect(finishTimers(pace.click("#save"))).resolves.toBe("clicked");
    expect(page.locator).toHaveBeenCalledWith("#save");
    expect(locator.click).toHaveBeenCalledOnce();
  });

  it("uses the Stagehand locator and page APIs for recorded actions", async () => {
    vi.useFakeTimers();
    let checked = false;
    const locator = {
      fill: vi.fn(async () => undefined),
      selectOption: vi.fn(async () => ["two"]),
      isChecked: vi.fn(async () => checked),
      click: vi.fn(async () => {
        checked = true;
      }),
    };
    const rootPage = {
      locator: vi.fn(() => ({ first: () => locator })),
      evaluate: vi.fn(async () => undefined),
      keyPress: vi.fn(async () => undefined),
    };
    const pace = createPace({
      rootPage,
      getPages: () => [rootPage],
      signal: new AbortController().signal,
    });

    await finishTimers(pace.fill(locator, "hello"));
    await finishTimers(pace.select(locator, ["one", "two"]));
    await finishTimers(pace.setChecked(locator, true));
    await finishTimers(pace.press(rootPage, "Enter"));
    await finishTimers(pace.scrollTo(rootPage, 640));

    expect(locator.fill).toHaveBeenCalledWith("hello");
    expect(locator.selectOption).toHaveBeenCalledWith(["one", "two"]);
    expect(locator.isChecked).toHaveBeenCalledTimes(2);
    expect(locator.click).toHaveBeenCalledOnce();
    expect(rootPage.keyPress).toHaveBeenCalledWith("Enter");
    expect(rootPage.evaluate).toHaveBeenCalledWith(expect.any(Function), 640);
  });

  it("discovers a popup by polling context pages and waits for domcontentloaded", async () => {
    vi.useFakeTimers();
    const rootPage = {};
    const popupPage = {
      waitForLoadState: vi.fn(async () => undefined),
    };
    let popupOpened = false;
    const locator = {
      click: vi.fn(async () => {
        popupOpened = true;
      }),
    };
    const getPages = vi.fn(() => (popupOpened ? [rootPage, popupPage] : [rootPage]));
    const onPageOpened = vi.fn();
    const pace = createPace({
      rootPage,
      getPages,
      signal: new AbortController().signal,
      onPageOpened,
    });

    const popup = await finishTimers(pace.clickAndWaitForNewPage(rootPage, locator));

    expect(popup).toBe(popupPage);
    expect(getPages).toHaveBeenCalledTimes(2);
    expect(popupPage.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", expect.any(Number));
    expect(onPageOpened).toHaveBeenCalledWith(popupPage, rootPage);
  });

  it("supports cancellation while polling for a popup", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const rootPage = {};
    const pace = createPace({
      rootPage,
      getPages: () => [rootPage],
      signal: controller.signal,
    });
    const operation = pace.clickAndWaitForNewPage(rootPage, {
      click: async () => undefined,
    });
    const rejection = expect(operation).rejects.toThrow("Script execution was cancelled");

    setTimeout(() => controller.abort(), 6_000);
    await vi.runAllTimersAsync();
    await rejection;
  });

  it("reports popup timeout clearly and refuses root page aliases", async () => {
    vi.useFakeTimers();
    const rootPage = { targetId: () => "root-target" };
    const rootPageAlias = {
      targetId: () => "root-target",
      close: vi.fn(async () => undefined),
    };
    const pace = createPace({
      rootPage,
      getPages: () => [rootPage],
      signal: new AbortController().signal,
    });
    const popupOperation = pace.clickAndWaitForNewPage(rootPage, {
      click: async () => undefined,
    });
    const timeoutRejection = expect(popupOperation).rejects.toThrow("在 10000ms 内未检测到新页面");

    await vi.runAllTimersAsync();
    await timeoutRejection;
    await expect(pace.closePage(rootPage)).rejects.toThrow("不允许关闭初始 root page");
    await expect(pace.closePage(rootPageAlias)).rejects.toThrow("不允许关闭初始 root page");
    expect(rootPageAlias.close).not.toHaveBeenCalled();
  });

  it("closes a non-root popup page", async () => {
    vi.useFakeTimers();
    const rootPage = {};
    const popupPage = { close: vi.fn(async () => undefined) };
    const onPageClosed = vi.fn();
    const pace = createPace({
      rootPage,
      getPages: () => [rootPage, popupPage],
      signal: new AbortController().signal,
      onPageClosed,
    });

    await finishTimers(pace.closePage(popupPage));
    expect(popupPage.close).toHaveBeenCalledOnce();
    expect(onPageClosed).toHaveBeenCalledWith(popupPage);
  });
});

describe("createPace pagination primitives", () => {
  it("returns real nth-of-type ordinals for the matching list items", async () => {
    const parent = { children: [] as Array<Record<string, unknown>> };
    const first = { tagName: "LI", parentElement: parent };
    const divider = { tagName: "DIV", parentElement: parent };
    const second = { tagName: "LI", parentElement: parent };
    const third = { tagName: "LI", parentElement: parent };
    parent.children = [first, divider, second, third];
    const querySelectorAll = vi.fn(() => [first, third]);
    const page = {
      evaluate: vi.fn(async (callback: (selector: string) => number[], selector: string) => {
        const previousDocument = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = { querySelectorAll };
        try {
          return callback(selector);
        } finally {
          if (previousDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
          } else {
            (globalThis as { document?: unknown }).document = previousDocument;
          }
        }
      }),
    };
    const pace = createPace({
      rootPage: page,
      getPages: () => [page],
      signal: new AbortController().signal,
    });

    await expect(pace.listItemOrdinals(page, "ul.results > li.result")).resolves.toEqual([1, 3]);
    expect(querySelectorAll).toHaveBeenCalledWith("ul.results > li.result");
  });

  it("clicks an available Next once and reports changed list content", async () => {
    vi.useFakeTimers();
    const locator = { click: vi.fn(async () => undefined) };
    const states = [
      { fingerprint: "2:before", itemCount: 2, nextAvailable: true },
      { fingerprint: "3:after", itemCount: 3, nextAvailable: true },
    ];
    const page = {
      evaluate: vi.fn(async () => states.shift() ?? states.at(-1)),
      locator: vi.fn(() => ({ first: () => locator })),
    };
    const pace = createPace({
      rootPage: page,
      getPages: () => [page],
      signal: new AbortController().signal,
    });

    await expect(
      finishTimers(pace.clickNextAndWaitForChange(page, "#next", "ul > li")),
    ).resolves.toBe(true);
    expect(page.locator).toHaveBeenCalledWith("#next");
    expect(locator.click).toHaveBeenCalledOnce();
  });

  it("does not click a hidden or disabled Next and stops when content never changes", async () => {
    const disabledWrapper = { className: "page-item disabled", parentElement: null };
    const nextLink = {
      className: "page-link",
      parentElement: disabledWrapper,
      hidden: false,
      disabled: false,
      getAttribute: () => null,
      hasAttribute: () => false,
      closest: () => null,
      getClientRects: () => [{}],
    };
    const browserDocument = {
      querySelectorAll: vi.fn(() => [{ outerHTML: "<li>first</li>" }]),
      querySelector: vi.fn(() => nextLink),
    };
    const unavailablePage = {
      evaluate: vi.fn(
        async (
          callback: (input: { nextSelector: string; listSelector: string }) => unknown,
          input: { nextSelector: string; listSelector: string },
        ) => {
          const browserGlobal = globalThis as {
            document?: unknown;
            getComputedStyle?: unknown;
          };
          const previousDocument = browserGlobal.document;
          const previousGetComputedStyle = browserGlobal.getComputedStyle;
          browserGlobal.document = browserDocument;
          browserGlobal.getComputedStyle = () => ({
            display: "block",
            visibility: "visible",
            opacity: "1",
          });
          try {
            return callback(input);
          } finally {
            if (previousDocument === undefined) delete browserGlobal.document;
            else browserGlobal.document = previousDocument;
            if (previousGetComputedStyle === undefined) delete browserGlobal.getComputedStyle;
            else browserGlobal.getComputedStyle = previousGetComputedStyle;
          }
        },
      ),
      locator: vi.fn(),
    };
    const unavailablePace = createPace({
      rootPage: unavailablePage,
      getPages: () => [unavailablePage],
      signal: new AbortController().signal,
    });
    await expect(
      unavailablePace.clickNextAndWaitForChange(unavailablePage, "#next", "ul > li"),
    ).resolves.toBe(false);
    expect(browserDocument.querySelector).toHaveBeenCalledWith("#next");
    expect(unavailablePage.locator).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const locator = { click: vi.fn(async () => undefined) };
    const unchangedPage = {
      evaluate: vi.fn(async () => ({
        fingerprint: "2:same",
        itemCount: 2,
        nextAvailable: true,
      })),
      locator: vi.fn(() => ({ first: () => locator })),
    };
    const unchangedPace = createPace({
      rootPage: unchangedPage,
      getPages: () => [unchangedPage],
      signal: new AbortController().signal,
    });
    await expect(
      finishTimers(unchangedPace.clickNextAndWaitForChange(unchangedPage, "#next", "ul > li")),
    ).resolves.toBe(false);
    expect(locator.click).toHaveBeenCalledOnce();
    expect(unchangedPage.evaluate.mock.calls.length).toBeGreaterThan(2);
  });
});
