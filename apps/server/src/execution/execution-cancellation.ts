export class ScriptExecutionCancelledError extends Error {
  constructor() {
    super("Script execution was cancelled");
    this.name = "ScriptExecutionCancelledError";
  }
}

export function throwIfExecutionCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ScriptExecutionCancelledError();
  }
}

export function isExecutionCancelledError(error: unknown): boolean {
  return error instanceof ScriptExecutionCancelledError;
}

export function raceWithExecutionCancellation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfExecutionCancelled(signal);

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(new ScriptExecutionCancelledError());
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
}

/**
 * Wrap Playwright/Stagehand objects so cancellation is responsive while the caller can retain
 * target ownership until any underlying browser operation has actually settled.
 */
export function createAbortableAutomationProxy<T extends object>(
  target: T,
  signal: AbortSignal,
  pendingOperations?: Set<Promise<unknown>>,
): T {
  const proxyCache = new WeakMap<object, object>();

  const wrapValue = (value: any): any => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => wrapValue(item));
    }
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      return value;
    }

    const cached = proxyCache.get(value);
    if (cached) return cached;

    const proxy = new Proxy(value, {
      get(currentTarget, property) {
        throwIfExecutionCancelled(signal);
        const member = Reflect.get(currentTarget, property, currentTarget);
        if (typeof member !== "function") return wrapValue(member);

        return (...args: any[]) => {
          throwIfExecutionCancelled(signal);
          const result: any = Reflect.apply(member, currentTarget, args);
          if (result && typeof result.then === "function") {
            const underlyingOperation = Promise.resolve(result) as Promise<unknown>;
            pendingOperations?.add(underlyingOperation);
            underlyingOperation.then(
              () => pendingOperations?.delete(underlyingOperation),
              () => pendingOperations?.delete(underlyingOperation),
            );
            return raceWithExecutionCancellation(underlyingOperation, signal).then((resolved) =>
              wrapValue(resolved),
            );
          }
          return wrapValue(result);
        };
      },
    });

    proxyCache.set(value, proxy);
    return proxy;
  };

  return wrapValue(target) as T;
}
