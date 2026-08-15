import type { Stagehand } from "@browserbasehq/stagehand";

export function createBackgroundPageFacade<T extends object>(page: T): T {
  const pageMethods = [
    "targetId",
    "mainFrameId",
    "mainFrame",
    "frames",
    "goto",
    "reload",
    "goBack",
    "goForward",
    "url",
    "title",
    "screenshot",
    "addInitScript",
    "setExtraHTTPHeaders",
    "locator",
    "deepLocator",
    "frameLocator",
    "waitForLoadState",
    "waitForTimeout",
    "waitForSelector",
    "evaluate",
    "setViewportSize",
    "click",
    "hover",
    "scroll",
    "dragAndDrop",
    "type",
    "keyPress",
    "snapshot",
    "listWebMCPTools",
    "invokeWebMCPTool",
    "isClosed",
  ] as const;
  const frameMethods = [
    "isBrowserRemote",
    "getNodeAtLocation",
    "getLocationForSelector",
    "getAccessibilityTree",
    "evaluate",
    "screenshot",
    "childFrames",
    "waitForLoadState",
    "locator",
  ] as const;
  const locatorMethods = [
    "setInputFiles",
    "backendNodeId",
    "count",
    "centroid",
    "highlight",
    "hover",
    "click",
    "sendClickEvent",
    "scrollTo",
    "fill",
    "type",
    "selectOption",
    "isVisible",
    "isChecked",
    "inputValue",
    "textContent",
    "innerHtml",
    "innerText",
    "first",
    "nth",
  ] as const;
  const frameLocatorMethods = ["frameLocator", "locator"] as const;
  const responseMethods = [
    "url",
    "status",
    "statusText",
    "ok",
    "frame",
    "fromServiceWorker",
    "securityDetails",
    "serverAddr",
    "headers",
    "allHeaders",
    "headerValue",
    "headerValues",
    "headersArray",
    "body",
    "text",
    "json",
    "finished",
  ] as const;

  const rawByFacade = new WeakMap<object, object>();
  const frameFacades = new WeakMap<object, object>();
  const locatorFacades = new WeakMap<object, object>();
  const frameLocatorFacades = new WeakMap<object, object>();
  const responseFacades = new WeakMap<object, object>();

  const unwrapCapabilityArgument = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const rawValue = rawByFacade.get(value);
    if (rawValue) return rawValue;
    if (Array.isArray(value)) return value.map(unwrapCapabilityArgument);
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      return value;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, unwrapCapabilityArgument(entry)]),
      );
    }
    return value;
  };

  const buildCapabilityFacade = (
    target: object,
    methods: readonly string[],
    wrapResult: (methodName: string, value: any) => any,
    label: string,
  ): object => {
    const facade = Object.create(null) as Record<PropertyKey, unknown>;
    for (const methodName of methods) {
      const member = Reflect.get(target, methodName, target);
      if (typeof member !== "function") continue;
      Object.defineProperty(facade, methodName, {
        enumerable: true,
        value: (...args: unknown[]) => {
          const result: any = Reflect.apply(member, target, args.map(unwrapCapabilityArgument));
          if (result && typeof result.then === "function") {
            return Promise.resolve(result).then((resolved) => wrapResult(methodName, resolved));
          }
          return wrapResult(methodName, result);
        },
      });
    }
    Object.defineProperty(facade, Symbol.toStringTag, { value: label });
    rawByFacade.set(facade, target);
    return Object.freeze(facade);
  };

  const wrapLocator = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const cached = locatorFacades.get(value);
    if (cached) return cached;
    const facade = buildCapabilityFacade(
      value,
      locatorMethods,
      (methodName, result) =>
        methodName === "first" || methodName === "nth" ? wrapLocator(result) : result,
      "BackgroundLocator",
    );
    locatorFacades.set(value, facade);
    return facade;
  };

  const wrapFrameLocator = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const cached = frameLocatorFacades.get(value);
    if (cached) return cached;
    const facade = buildCapabilityFacade(
      value,
      frameLocatorMethods,
      (methodName, result) =>
        methodName === "frameLocator" ? wrapFrameLocator(result) : wrapLocator(result),
      "BackgroundFrameLocator",
    );
    frameLocatorFacades.set(value, facade);
    return facade;
  };

  const wrapFrame = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const cached = frameFacades.get(value);
    if (cached) return cached;
    const facade = buildCapabilityFacade(
      value,
      frameMethods,
      (methodName, result) => {
        if (methodName === "locator") return wrapLocator(result);
        if (methodName === "childFrames" && Array.isArray(result)) return result.map(wrapFrame);
        return result;
      },
      "BackgroundFrame",
    );
    frameFacades.set(value, facade);
    return facade;
  };

  const wrapResponse = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const cached = responseFacades.get(value);
    if (cached) return cached;
    const facade = buildCapabilityFacade(
      value,
      responseMethods,
      (methodName, result) => (methodName === "frame" ? wrapFrame(result) : result),
      "BackgroundResponse",
    );
    responseFacades.set(value, facade);
    return facade;
  };

  let restrictedPage: object;
  restrictedPage = buildCapabilityFacade(
    page,
    pageMethods,
    (methodName, result) => {
      if (methodName === "locator" || methodName === "deepLocator") {
        return wrapLocator(result);
      }
      if (methodName === "frameLocator") return wrapFrameLocator(result);
      if (methodName === "mainFrame") return wrapFrame(result);
      if (methodName === "frames" && Array.isArray(result)) return result.map(wrapFrame);
      if (
        methodName === "goto" ||
        methodName === "reload" ||
        methodName === "goBack" ||
        methodName === "goForward"
      ) {
        return wrapResponse(result);
      }
      return result;
    },
    "BackgroundPage",
  );

  return restrictedPage as T;
}

export function createBackgroundStagehandFacade(
  stagehandInstance: Stagehand,
  page: object,
): Stagehand {
  const restrictedPage = createBackgroundPageFacade(page);
  const withOwnedPage = (options: unknown) => ({
    ...(options && typeof options === "object" ? options : {}),
    page,
  });
  const isSchemaLike = (value: unknown): boolean =>
    Boolean(
      value &&
      typeof value === "object" &&
      "parse" in value &&
      typeof (value as { parse?: unknown }).parse === "function" &&
      "safeParse" in value &&
      typeof (value as { safeParse?: unknown }).safeParse === "function",
    );

  const restrictedContext = Object.freeze(
    Object.assign(Object.create(null), {
      pages: () => [restrictedPage],
      activePage: () => restrictedPage,
      awaitActivePage: async () => restrictedPage,
    }),
  );
  const facade = Object.assign(Object.create(null), {
    context: restrictedContext,
    act: (input: unknown, options?: unknown) =>
      (stagehandInstance.act as any)(input, withOwnedPage(options)),
    extract: (first?: unknown, second?: unknown, third?: unknown) => {
      if (typeof first === "string") {
        if (isSchemaLike(second)) {
          return (stagehandInstance.extract as any)(first, second, withOwnedPage(third));
        }
        return (stagehandInstance.extract as any)(first, withOwnedPage(second));
      }
      return (stagehandInstance.extract as any)(withOwnedPage(first));
    },
    observe: (first?: unknown, second?: unknown) =>
      typeof first === "string"
        ? (stagehandInstance.observe as any)(first, withOwnedPage(second))
        : (stagehandInstance.observe as any)(withOwnedPage(first)),
  });

  return Object.freeze(facade) as unknown as Stagehand;
}
