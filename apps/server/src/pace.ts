import crypto from "node:crypto";

export const PACE_PROFILE = Object.freeze({
  actionWaitMinMs: 800,
  actionWaitMaxMs: 2_500,
  typingDelayMinMs: 50,
  typingDelayMaxMs: 160,
  scrollDistanceMinPx: 300,
  scrollDistanceMaxPx: 700,
  scrollWaitMinMs: 400,
  scrollWaitMaxMs: 1_200,
});

const POPUP_POLL_INTERVAL_MS = 100;
const POPUP_TIMEOUT_MS = 10_000;

type PaceTarget = string | object;
type PacePage = Record<string, any>;

export interface CreatePaceOptions {
  rootPage: PacePage;
  getPages: () => PacePage[] | Promise<PacePage[]>;
  signal: AbortSignal;
  onPageOpened?: (page: PacePage, sourcePage: PacePage) => void;
  onPageClosed?: (page: PacePage) => void;
}

export interface PaceApi {
  wait: () => Promise<void>;
  click: (target: PaceTarget, ...args: unknown[]) => Promise<unknown>;
  type: (target: PaceTarget, text: string) => Promise<void>;
  scroll: () => Promise<number>;
  fill: (target: PaceTarget, value: string) => Promise<void>;
  select: (target: PaceTarget, value: string | string[]) => Promise<void>;
  setChecked: (target: PaceTarget, checked: boolean) => Promise<void>;
  press: (page: PacePage, key: string) => Promise<void>;
  scrollTo: (page: PacePage, y: number) => Promise<void>;
  clickAndWaitForNewPage: (sourcePage: PacePage, target: PaceTarget) => Promise<PacePage>;
  closePage: (page: PacePage) => Promise<void>;
}

const randomInt = (min: number, max: number): number => crypto.randomInt(min, max + 1);

const cancellationError = (): Error => new Error("Script execution was cancelled");

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw cancellationError();
};

const delay = (durationMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, durationMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(cancellationError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });

const runAbortable = async <T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(cancellationError());
    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
};

const isCreatePaceOptions = (value: unknown): value is CreatePaceOptions =>
  typeof value === "object" &&
  value !== null &&
  "rootPage" in value &&
  "getPages" in value &&
  "signal" in value;

export function createPace(options: CreatePaceOptions): PaceApi;
export function createPace(page: any, signal: AbortSignal): PaceApi;
export function createPace(
  optionsOrPage: CreatePaceOptions | PacePage,
  legacySignal?: AbortSignal,
): PaceApi {
  const usesOptions = isCreatePaceOptions(optionsOrPage);
  const rootPage = usesOptions ? optionsOrPage.rootPage : optionsOrPage;
  const getPages = usesOptions ? optionsOrPage.getPages : undefined;
  const signal = usesOptions ? optionsOrPage.signal : legacySignal;
  const onPageOpened = usesOptions ? optionsOrPage.onPageOpened : undefined;
  const onPageClosed = usesOptions ? optionsOrPage.onPageClosed : undefined;

  if (!signal) {
    throw new Error("createPace 需要 AbortSignal。");
  }

  const pageTargetId = (page: PacePage): string | undefined => {
    if (!page || typeof page.targetId !== "function") return undefined;
    try {
      const targetId = page.targetId();
      return typeof targetId === "string" ? targetId : undefined;
    } catch {
      return undefined;
    }
  };
  const rootTargetId = pageTargetId(rootPage);
  const isRootPage = (page: PacePage): boolean =>
    page === rootPage || (rootTargetId !== undefined && pageTargetId(page) === rootTargetId);

  const wait = () =>
    delay(randomInt(PACE_PROFILE.actionWaitMinMs, PACE_PROFILE.actionWaitMaxMs), signal);

  const resolveTarget = (target: PaceTarget): any =>
    typeof target === "string" ? rootPage.locator(target).first() : target;

  const click = async (target: PaceTarget, ...args: unknown[]): Promise<unknown> => {
    await wait();
    const resolved = resolveTarget(target);
    if (!resolved || typeof resolved.click !== "function") {
      throw new Error("pace.click 需要 CSS 选择器或包含 click() 的定位对象。");
    }
    const result = await runAbortable(resolved.click(...args), signal);
    await wait();
    return result;
  };

  const readPages = async (): Promise<PacePage[]> => {
    if (!getPages) {
      throw new Error(
        "pace.clickAndWaitForNewPage 需要使用 createPace({ rootPage, getPages, signal }) 创建 Pace。",
      );
    }
    const pages = await runAbortable(Promise.resolve().then(getPages), signal);
    if (!Array.isArray(pages)) {
      throw new Error("pace.clickAndWaitForNewPage 的 getPages() 必须返回页面数组。");
    }
    return pages;
  };

  return {
    wait,
    click,
    async type(target, text) {
      await wait();
      const resolved = resolveTarget(target);
      if (!resolved) throw new Error("pace.type 无法定位输入目标。");

      if (typeof resolved.fill === "function") {
        await runAbortable(resolved.fill(""), signal);
      }

      let accumulated = "";
      for (const character of String(text)) {
        throwIfAborted(signal);
        if (typeof resolved.pressSequentially === "function") {
          await runAbortable(resolved.pressSequentially(character), signal);
        } else if (typeof resolved.type === "function") {
          await runAbortable(resolved.type(character), signal);
        } else if (rootPage.keyboard && typeof rootPage.keyboard.type === "function") {
          await runAbortable(rootPage.keyboard.type(character), signal);
        } else if (typeof resolved.fill === "function") {
          accumulated += character;
          await runAbortable(resolved.fill(accumulated), signal);
        } else {
          throw new Error("pace.type 的目标不支持逐字输入。");
        }
        await delay(
          randomInt(PACE_PROFILE.typingDelayMinMs, PACE_PROFILE.typingDelayMaxMs),
          signal,
        );
      }
      await wait();
    },
    async scroll() {
      await wait();
      const distance = randomInt(
        PACE_PROFILE.scrollDistanceMinPx,
        PACE_PROFILE.scrollDistanceMaxPx,
      );
      await runAbortable(
        rootPage.evaluate((scrollDistance: number) => {
          (globalThis as any).scrollBy({
            top: scrollDistance,
            left: 0,
            behavior: "smooth",
          });
        }, distance),
        signal,
      );
      await delay(randomInt(PACE_PROFILE.scrollWaitMinMs, PACE_PROFILE.scrollWaitMaxMs), signal);
      return distance;
    },
    async fill(target, value) {
      await wait();
      const resolved = resolveTarget(target);
      if (!resolved || typeof resolved.fill !== "function") {
        throw new Error("pace.fill 需要 CSS 选择器或包含 fill() 的定位对象。");
      }
      await runAbortable(resolved.fill(value), signal);
      await wait();
    },
    async select(target, value) {
      await wait();
      const resolved = resolveTarget(target);
      if (!resolved || typeof resolved.selectOption !== "function") {
        throw new Error("pace.select 需要 CSS 选择器或包含 selectOption() 的定位对象。");
      }
      await runAbortable(resolved.selectOption(value), signal);
      await wait();
    },
    async setChecked(target, checked) {
      await wait();
      const resolved = resolveTarget(target);
      if (
        !resolved ||
        typeof resolved.isChecked !== "function" ||
        typeof resolved.click !== "function"
      ) {
        throw new Error("pace.setChecked 需要包含 isChecked() 和 click() 的定位对象。");
      }

      const current = await runAbortable(resolved.isChecked(), signal);
      if (current !== checked) {
        await runAbortable(resolved.click(), signal);
        const updated = await runAbortable(resolved.isChecked(), signal);
        if (updated !== checked) {
          throw new Error(`pace.setChecked 无法将目标状态设置为 ${String(checked)}。`);
        }
      }
      await wait();
    },
    async press(targetPage, key) {
      await wait();
      if (!targetPage || typeof targetPage.keyPress !== "function") {
        throw new Error("pace.press 需要包含 keyPress() 的 Stagehand Page。");
      }
      await runAbortable(targetPage.keyPress(key), signal);
      await wait();
    },
    async scrollTo(targetPage, y) {
      if (!Number.isFinite(y)) {
        throw new Error("pace.scrollTo 的 y 必须是有限数字。");
      }
      await wait();
      if (!targetPage || typeof targetPage.evaluate !== "function") {
        throw new Error("pace.scrollTo 需要包含 evaluate() 的 Stagehand Page。");
      }
      await runAbortable(
        targetPage.evaluate((scrollY: number) => {
          (globalThis as any).scrollTo({
            top: scrollY,
            left: 0,
            behavior: "smooth",
          });
        }, y),
        signal,
      );
      await delay(randomInt(PACE_PROFILE.scrollWaitMinMs, PACE_PROFILE.scrollWaitMaxMs), signal);
    },
    async clickAndWaitForNewPage(sourcePage, target) {
      if (!sourcePage || typeof sourcePage !== "object") {
        throw new Error("pace.clickAndWaitForNewPage 需要有效的来源 Page。");
      }

      const existingPages = new Set(await readPages());
      await click(target);
      const deadline = Date.now() + POPUP_TIMEOUT_MS;

      while (Date.now() < deadline) {
        throwIfAborted(signal);
        const pages = await readPages();
        const newPage = pages.find((candidate) => !existingPages.has(candidate));
        if (newPage) {
          if (typeof newPage.waitForLoadState !== "function") {
            throw new Error(
              "pace.clickAndWaitForNewPage 检测到的新页面不支持 waitForLoadState()。",
            );
          }
          const remainingMs = Math.max(1, deadline - Date.now());
          try {
            await runAbortable(newPage.waitForLoadState("domcontentloaded", remainingMs), signal);
          } catch (error) {
            if (signal.aborted) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              `pace.clickAndWaitForNewPage 检测到新页面，但未能在 ${POPUP_TIMEOUT_MS}ms 内等待到 domcontentloaded：${reason}`,
            );
          }
          onPageOpened?.(newPage, sourcePage);
          return newPage;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await delay(Math.min(POPUP_POLL_INTERVAL_MS, remainingMs), signal);
      }

      throw new Error(
        `pace.clickAndWaitForNewPage 在 ${POPUP_TIMEOUT_MS}ms 内未检测到新页面。请确认脚本使用 visible 模式运行且点击确实会打开新页面。`,
      );
    },
    async closePage(targetPage) {
      if (isRootPage(targetPage)) {
        throw new Error("pace.closePage 不允许关闭初始 root page。");
      }
      if (!targetPage || typeof targetPage.close !== "function") {
        throw new Error("pace.closePage 需要包含 close() 的 Stagehand Page。");
      }
      await wait();
      await runAbortable(targetPage.close(), signal);
      onPageClosed?.(targetPage);
      await wait();
    },
  };
}
