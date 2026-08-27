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
