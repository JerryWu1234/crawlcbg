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

export interface PaceApi {
  wait: () => Promise<void>;
  click: (target: string | object, ...args: unknown[]) => Promise<unknown>;
  type: (target: string | object, text: string) => Promise<void>;
  scroll: () => Promise<number>;
}

const randomInt = (min: number, max: number): number => crypto.randomInt(min, max + 1);

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error("Script execution was cancelled");
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
      reject(new Error("Script execution was cancelled"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });

const runAbortable = async <T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(new Error("Script execution was cancelled"));
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

export const createPace = (page: any, signal: AbortSignal): PaceApi => {
  const wait = () =>
    delay(randomInt(PACE_PROFILE.actionWaitMinMs, PACE_PROFILE.actionWaitMaxMs), signal);

  const resolveTarget = (target: string | object): any =>
    typeof target === "string" ? page.locator(target).first() : target;

  return {
    wait,
    async click(target, ...args) {
      await wait();
      const resolved = resolveTarget(target);
      if (!resolved || typeof resolved.click !== "function") {
        throw new Error("pace.click 需要 CSS 选择器或包含 click() 的定位对象。");
      }
      const result = await runAbortable(resolved.click(...args), signal);
      await wait();
      return result;
    },
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
        } else if (page.keyboard && typeof page.keyboard.type === "function") {
          await runAbortable(page.keyboard.type(character), signal);
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
        page.evaluate((scrollDistance: number) => {
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
  };
};
