export interface CdpPage {
  targetId(): string;
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeoutMs?: number },
  ): Promise<unknown>;
  isClosed?(): boolean;
}

export interface CdpBrowserContext {
  pages(): CdpPage[];
}

interface CreateTargetResponse {
  targetId: string;
}

interface TargetInfoResponse {
  targetInfo: { browserContextId?: string };
}

interface TargetInfo {
  targetId: string;
  type: string;
  openerId?: string;
}

interface GetTargetsResponse {
  targetInfos: TargetInfo[];
}

interface WindowForTargetResponse {
  windowId: number;
  bounds: { windowState?: "normal" | "minimized" | "maximized" | "fullscreen" };
}

interface CloseTargetResponse {
  success: boolean;
}

export interface MinimizedBrowserWindow {
  page: CdpPage;
  targetId: string;
  windowId: number;
  close(): Promise<void>;
}

interface MinimizedBrowserWindowOptions {
  onTargetCreated?: (targetId: string) => void;
  onTargetDiscovered?: (targetId: string) => void;
  onWindowReady?: (windowId: number) => void;
  onWindowDiscovered?: (windowId: number) => void;
  onOwnershipError?: (error: unknown) => void;
}

const TARGET_ATTACH_TIMEOUT_MS = 5_000;
const WINDOW_CLOSE_TIMEOUT_MS = 3_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const OWNERSHIP_REFRESH_INTERVAL_MS = 50;
const OWNERSHIP_EMPTY_PASSES_REQUIRED = 2;
const OWNERSHIP_FAILURE_LIMIT = Math.ceil(TARGET_ATTACH_TIMEOUT_MS / OWNERSHIP_REFRESH_INTERVAL_MS);
const OWNERSHIP_MONITOR_TIMEOUT_MS = TARGET_ATTACH_TIMEOUT_MS;

function abortError(): Error {
  const error = new Error("Background browser window creation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(abortError());
    signal.addEventListener("abort", handleAbort, { once: true });
    operation.then(
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

function raceWithDeadline<T>(operation: Promise<T>, deadline: number, action: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new Error(`${action}已超过允许时限。`));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${action}未在剩余 ${remainingMs}ms 时限内完成。`)),
      remainingMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validateTargetUrl(rawUrl: string): string {
  const targetUrl = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("后台运行需要有效的目标 URL。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("后台运行仅支持 http 或 https 页面。");
  }
  return parsed.toString();
}

function getOpenPages(context: CdpBrowserContext): CdpPage[] {
  return context.pages().filter((page) => !page.isClosed?.());
}

function selectControlPage(
  context: CdpBrowserContext,
  preferredControlPage: CdpPage,
  ownedTargetIds: ReadonlySet<string>,
): CdpPage | null {
  const pages = getOpenPages(context);
  return (
    pages.find((page) => !ownedTargetIds.has(page.targetId())) ||
    pages.find((page) => page === preferredControlPage) ||
    pages[0] ||
    null
  );
}

async function waitForPage(
  context: CdpBrowserContext,
  targetId: string,
  signal: AbortSignal,
): Promise<CdpPage> {
  const deadline = Date.now() + TARGET_ATTACH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const page = getOpenPages(context).find((candidate) => candidate.targetId() === targetId);
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`最小化浏览器窗口未在 ${TARGET_ATTACH_TIMEOUT_MS}ms 内连接。`);
}

async function getWindowInfo(page: CdpPage, targetId: string): Promise<WindowForTargetResponse> {
  return page.sendCDP<WindowForTargetResponse>("Browser.getWindowForTarget", { targetId });
}

async function ensureMinimized(page: CdpPage, targetId: string): Promise<number> {
  let windowInfo = await getWindowInfo(page, targetId);
  if (windowInfo.bounds.windowState !== "minimized") {
    await page.sendCDP("Browser.setWindowBounds", {
      windowId: windowInfo.windowId,
      bounds: { windowState: "minimized" },
    });
    windowInfo = await getWindowInfo(page, targetId);
  }
  if (windowInfo.bounds.windowState !== "minimized") {
    throw new Error("Chrome 未确认独立执行窗口已最小化，已取消后台运行。");
  }
  return windowInfo.windowId;
}

function isPageTarget(targetInfo: TargetInfo): boolean {
  return targetInfo.type === "page" || targetInfo.type === "tab";
}

function addDescendantTargets(
  targetInfos: readonly TargetInfo[],
  ownedTargetIds: Set<string>,
): boolean {
  let changed = false;
  let passChanged = true;
  while (passChanged) {
    passChanged = false;
    for (const targetInfo of targetInfos) {
      if (
        isPageTarget(targetInfo) &&
        targetInfo.openerId &&
        ownedTargetIds.has(targetInfo.openerId) &&
        !ownedTargetIds.has(targetInfo.targetId)
      ) {
        ownedTargetIds.add(targetInfo.targetId);
        changed = true;
        passChanged = true;
      }
    }
  }
  return changed;
}

async function getTargetInfos(controlPage: CdpPage): Promise<TargetInfo[]> {
  const response = await controlPage.sendCDP<GetTargetsResponse>("Target.getTargets");
  return response.targetInfos;
}

export async function discoverOwnedTargetIds(
  context: CdpBrowserContext,
  rootTargetIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const ownedTargetIds = new Set(rootTargetIds);
  if (ownedTargetIds.size === 0) return ownedTargetIds;

  const controlPage = getOpenPages(context)[0];
  if (!controlPage) return ownedTargetIds;
  addDescendantTargets(await getTargetInfos(controlPage), ownedTargetIds);
  return ownedTargetIds;
}

interface OwnershipSnapshot {
  targetIds: Set<string>;
  windowIds: Set<number>;
  targetInfos: TargetInfo[];
  unresolvedWindowTargetIds: string[];
}

async function discoverOwnership(
  controlPage: CdpPage,
  ownedTargetIds: Set<string>,
  ownedWindowIds: Set<number>,
  options: MinimizedBrowserWindowOptions,
): Promise<OwnershipSnapshot> {
  const previousTargetIds = new Set(ownedTargetIds);
  const previousWindowIds = new Set(ownedWindowIds);
  const targetInfos = await getTargetInfos(controlPage);
  addDescendantTargets(targetInfos, ownedTargetIds);

  const targetWindows = await Promise.all(
    targetInfos.filter(isPageTarget).map(async ({ targetId }) => {
      try {
        return { targetId, windowInfo: await getWindowInfo(controlPage, targetId) };
      } catch {
        return { targetId, windowInfo: null };
      }
    }),
  );

  let changed = true;
  while (changed) {
    changed = addDescendantTargets(targetInfos, ownedTargetIds);
    for (const entry of targetWindows) {
      if (!entry.windowInfo) continue;
      if (ownedTargetIds.has(entry.targetId) || ownedWindowIds.has(entry.windowInfo.windowId)) {
        if (!ownedTargetIds.has(entry.targetId)) {
          ownedTargetIds.add(entry.targetId);
          changed = true;
        }
        if (!ownedWindowIds.has(entry.windowInfo.windowId)) {
          ownedWindowIds.add(entry.windowInfo.windowId);
          changed = true;
        }
      }
    }
  }

  for (const targetId of ownedTargetIds) {
    if (!previousTargetIds.has(targetId)) options.onTargetDiscovered?.(targetId);
  }
  for (const windowId of ownedWindowIds) {
    if (!previousWindowIds.has(windowId)) options.onWindowDiscovered?.(windowId);
  }

  return {
    targetIds: ownedTargetIds,
    windowIds: ownedWindowIds,
    targetInfos,
    unresolvedWindowTargetIds: targetWindows
      .filter((entry) => !entry.windowInfo)
      .map((entry) => entry.targetId),
  };
}

async function minimizeOwnedWindows(
  controlPage: CdpPage,
  targetInfos: readonly TargetInfo[],
  ownedTargetIds: ReadonlySet<string>,
  ownedWindowIds: ReadonlySet<number>,
): Promise<string[]> {
  const representativeTargets = new Map<number, string>();
  const unresolvedTargetIds: string[] = [];

  for (const { targetId } of targetInfos.filter(isPageTarget)) {
    if (!ownedTargetIds.has(targetId)) continue;
    try {
      const windowInfo = await getWindowInfo(controlPage, targetId);
      if (
        ownedWindowIds.has(windowInfo.windowId) &&
        !representativeTargets.has(windowInfo.windowId)
      ) {
        representativeTargets.set(windowInfo.windowId, targetId);
      }
    } catch {
      unresolvedTargetIds.push(targetId);
    }
  }

  for (const targetId of representativeTargets.values()) {
    try {
      await ensureMinimized(controlPage, targetId);
    } catch {
      unresolvedTargetIds.push(targetId);
    }
  }

  return unresolvedTargetIds;
}

async function confirmOwnedTargetsMinimized(
  context: CdpBrowserContext,
  preferredControlPage: CdpPage,
  rootTargetId: string,
  ownedTargetIds: Set<string>,
  ownedWindowIds: Set<number>,
  options: MinimizedBrowserWindowOptions,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  let pendingTargetIds: string[] = [rootTargetId];
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const controlPage = selectControlPage(context, preferredControlPage, ownedTargetIds);
    if (!controlPage) {
      throw new Error("无法取得 CDP 控制页面，不能确认所有后台窗口均已最小化。");
    }

    try {
      const ownership = await raceWithDeadline(
        raceWithAbort(
          discoverOwnership(controlPage, ownedTargetIds, ownedWindowIds, options),
          signal,
        ),
        deadline,
        "确认后台 targets 所有权",
      );
      const minimizationFailures = await raceWithDeadline(
        raceWithAbort(
          minimizeOwnedWindows(controlPage, ownership.targetInfos, ownedTargetIds, ownedWindowIds),
          signal,
        ),
        deadline,
        "确认后台窗口最小化状态",
      );
      const currentTargetIds = new Set(
        ownership.targetInfos.filter(isPageTarget).map((targetInfo) => targetInfo.targetId),
      );
      pendingTargetIds = [
        ...(currentTargetIds.has(rootTargetId) ? [] : [rootTargetId]),
        ...ownership.unresolvedWindowTargetIds,
        ...minimizationFailures,
      ];
      pendingTargetIds = [...new Set(pendingTargetIds)];
      if (pendingTargetIds.length === 0) return;
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
    }

    await raceWithAbort(new Promise<void>((resolve) => setTimeout(resolve, 25)), signal);
  }

  const pendingLabel = pendingTargetIds.length > 0 ? pendingTargetIds.join(", ") : "未知";
  const errorLabel = lastError instanceof Error ? `：${lastError.message}` : "";
  throw new Error(`未能确认所有后台 targets 已最小化 (${pendingLabel})${errorLabel}`);
}

async function closeTarget(controlPage: CdpPage, targetId: string): Promise<void> {
  const result = await controlPage.sendCDP<CloseTargetResponse>("Target.closeTarget", { targetId });
  if (!result.success) throw new Error(`Chrome 拒绝关闭后台 target ${targetId}。`);
}

async function closeWindowAndVerify(
  context: CdpBrowserContext,
  preferredControlPage: CdpPage,
  ownedTargetIds: Set<string>,
  ownedWindowIds: Set<number>,
  options: MinimizedBrowserWindowOptions,
  deadline = Date.now() + WINDOW_CLOSE_TIMEOUT_MS,
): Promise<void> {
  let emptyPasses = 0;

  while (Date.now() < deadline) {
    const controlPage = selectControlPage(context, preferredControlPage, ownedTargetIds);
    if (!controlPage) {
      throw new Error("无法取得 CDP 控制页面，后台窗口关闭状态未获确认。");
    }

    const ownership = await raceWithDeadline(
      discoverOwnership(controlPage, ownedTargetIds, ownedWindowIds, options),
      deadline,
      "发现后台窗口 targets",
    );
    const presentTargetIds = new Set(
      ownership.targetInfos.filter(isPageTarget).map((targetInfo) => targetInfo.targetId),
    );
    for (const page of getOpenPages(context)) presentTargetIds.add(page.targetId());

    const closeCandidates = [...ownership.targetIds].filter((targetId) =>
      presentTargetIds.has(targetId),
    );
    if (closeCandidates.length === 0) {
      if (ownership.unresolvedWindowTargetIds.length > 0) {
        emptyPasses = 0;
        await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_REFRESH_INTERVAL_MS));
        continue;
      }
      emptyPasses += 1;
      if (emptyPasses >= OWNERSHIP_EMPTY_PASSES_REQUIRED) return;
      await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_REFRESH_INTERVAL_MS));
      continue;
    }

    emptyPasses = 0;
    closeCandidates.sort(
      (leftTargetId, rightTargetId) =>
        Number(leftTargetId === controlPage.targetId()) -
        Number(rightTargetId === controlPage.targetId()),
    );
    for (const targetId of closeCandidates) {
      try {
        await raceWithDeadline(
          closeTarget(controlPage, targetId),
          deadline,
          `关闭后台 target ${targetId}`,
        );
      } catch (error) {
        const verificationPage = selectControlPage(context, preferredControlPage, ownedTargetIds);
        if (!verificationPage) {
          throw new Error("关闭 target 后失去 CDP 控制页面，无法确认后台窗口已清理。", {
            cause: error,
          });
        }
        const stillPresent = (
          await raceWithDeadline(
            getTargetInfos(verificationPage),
            deadline,
            `确认后台 target ${targetId} 的关闭状态`,
          )
        ).some((targetInfo) => targetInfo.targetId === targetId);
        if (stillPresent) throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("独立后台 Chrome 窗口及其派生窗口未能在限定时间内完整关闭。");
}

export async function createMinimizedBrowserWindow(
  context: CdpBrowserContext,
  rawTargetUrl: string,
  signal: AbortSignal,
  options: MinimizedBrowserWindowOptions = {},
): Promise<MinimizedBrowserWindow> {
  const targetUrl = validateTargetUrl(rawTargetUrl);
  throwIfAborted(signal);

  const controlPage = getOpenPages(context)[0];
  if (!controlPage) {
    throw new Error("当前 Chrome 中没有可用于创建独立后台窗口的页面。");
  }

  let targetId: string | null = null;
  let windowId: number | null = null;
  const ownedTargetIds = new Set<string>();
  const ownedWindowIds = new Set<number>();
  let monitorTimer: ReturnType<typeof setTimeout> | null = null;
  let monitorOperation: Promise<void> | null = null;
  let monitorUnderlyingOperation: Promise<void> | null = null;
  let monitorStopped = true;
  let ownershipErrorReported = false;
  let initializationConfirmed = false;
  const ownershipFailureCounts = new Map<string, number>();

  const refreshOwnership = async (): Promise<void> => {
    const activeControlPage = selectControlPage(context, controlPage, ownedTargetIds);
    if (!activeControlPage) {
      throw new Error("无法取得 CDP 控制页面，不能确认派生后台窗口仍保持最小化。");
    }
    const ownership = await discoverOwnership(
      activeControlPage,
      ownedTargetIds,
      ownedWindowIds,
      options,
    );
    const minimizationFailures = await minimizeOwnedWindows(
      activeControlPage,
      ownership.targetInfos,
      ownedTargetIds,
      ownedWindowIds,
    );
    const failedTargetIds = new Set([
      ...ownership.unresolvedWindowTargetIds,
      ...minimizationFailures,
    ]);
    for (const targetId of ownershipFailureCounts.keys()) {
      if (!failedTargetIds.has(targetId)) ownershipFailureCounts.delete(targetId);
    }
    for (const targetId of failedTargetIds) {
      ownershipFailureCounts.set(targetId, (ownershipFailureCounts.get(targetId) || 0) + 1);
    }
    if (initializationConfirmed) {
      const persistentFailures = [...ownershipFailureCounts]
        .filter(([, failureCount]) => failureCount >= OWNERSHIP_FAILURE_LIMIT)
        .map(([targetId]) => targetId);
      if (persistentFailures.length > 0) {
        throw new Error(
          `连续 ${OWNERSHIP_FAILURE_LIMIT} 次无法确认后台 targets 的最小化状态：${persistentFailures.join(", ")}`,
        );
      }
    }
  };
  const runOwnershipRefresh = (): Promise<void> => {
    if (monitorOperation) return monitorOperation;
    if (monitorUnderlyingOperation) {
      return Promise.reject(
        new Error("上一轮后台窗口所有权扫描已超时且仍未结束，拒绝叠加新的 CDP 请求。"),
      );
    }

    const underlyingOperation = refreshOwnership();
    monitorUnderlyingOperation = underlyingOperation;
    void underlyingOperation
      .finally(() => {
        if (monitorUnderlyingOperation === underlyingOperation) {
          monitorUnderlyingOperation = null;
        }
      })
      .catch(() => undefined);

    const watchdogOperation = raceWithDeadline(
      underlyingOperation,
      Date.now() + OWNERSHIP_MONITOR_TIMEOUT_MS,
      "刷新后台窗口所有权",
    );
    const monitoredOperation = watchdogOperation.finally(() => {
      if (monitorOperation === monitoredOperation) monitorOperation = null;
    });
    monitorOperation = monitoredOperation;
    return monitoredOperation;
  };
  const runFreshOwnershipRefresh = async (
    rootTargetId: string,
    deadline: number,
  ): Promise<void> => {
    const inFlightOperation = monitorUnderlyingOperation || monitorOperation;
    if (inFlightOperation) {
      await raceWithDeadline(
        raceWithAbort(inFlightOperation, signal),
        deadline,
        "等待导航期后台窗口所有权扫描完成",
      );
    }
    await confirmOwnedTargetsMinimized(
      context,
      controlPage,
      rootTargetId,
      ownedTargetIds,
      ownedWindowIds,
      options,
      deadline,
      signal,
    );
  };
  const reportOwnershipError = (error: unknown): void => {
    if (ownershipErrorReported) return;
    ownershipErrorReported = true;
    monitorStopped = true;
    if (monitorTimer) {
      clearTimeout(monitorTimer);
      monitorTimer = null;
    }
    options.onOwnershipError?.(error);
  };
  const scheduleOwnershipRefresh = (): void => {
    if (monitorStopped || monitorTimer) return;
    monitorTimer = setTimeout(() => {
      monitorTimer = null;
      void runOwnershipRefresh().catch(reportOwnershipError).finally(scheduleOwnershipRefresh);
    }, OWNERSHIP_REFRESH_INTERVAL_MS);
    monitorTimer.unref?.();
  };
  const startOwnershipMonitor = (): void => {
    monitorStopped = false;
    scheduleOwnershipRefresh();
  };
  const stopOwnershipMonitor = async (deadline?: number): Promise<void> => {
    monitorStopped = true;
    if (monitorTimer) {
      clearTimeout(monitorTimer);
      monitorTimer = null;
    }
    const inFlightOperation = monitorUnderlyingOperation || monitorOperation;
    if (inFlightOperation) {
      const drainOperation = inFlightOperation.catch(() => undefined);
      if (deadline === undefined) {
        await drainOperation;
      } else {
        await raceWithDeadline(drainOperation, deadline, "等待后台窗口所有权监控停止");
      }
    }
  };

  try {
    const sourceTarget = await controlPage
      .sendCDP<TargetInfoResponse>("Target.getTargetInfo", {
        targetId: controlPage.targetId(),
      })
      .catch(() => null);
    const browserContextId = sourceTarget?.targetInfo.browserContextId;

    // Target.createTarget cannot be cancelled. Always await its result so a late target can be
    // deterministically closed when cancellation arrives during creation.
    const created = await controlPage.sendCDP<CreateTargetResponse>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: true,
      focus: false,
      windowState: "minimized",
      ...(browserContextId ? { browserContextId } : {}),
    });
    targetId = created.targetId;
    ownedTargetIds.add(targetId);
    options.onTargetCreated?.(targetId);
    if (signal.aborted) throw abortError();

    const page = await waitForPage(context, targetId, signal);
    const initialMinimizationDeadline = Date.now() + TARGET_ATTACH_TIMEOUT_MS;
    windowId = await raceWithDeadline(
      raceWithAbort(ensureMinimized(page, targetId), signal),
      initialMinimizationDeadline,
      "确认初始后台窗口最小化状态",
    );
    ownedWindowIds.add(windowId);
    options.onWindowReady?.(windowId);
    startOwnershipMonitor();

    await raceWithAbort(
      page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeoutMs: NAVIGATION_TIMEOUT_MS,
      }),
      signal,
    );
    throwIfAborted(signal);
    const postNavigationDeadline = Date.now() + TARGET_ATTACH_TIMEOUT_MS;
    await runFreshOwnershipRefresh(targetId, postNavigationDeadline);
    initializationConfirmed = true;
    ownershipFailureCounts.clear();

    let closePromise: Promise<void> | null = null;
    return {
      page,
      targetId,
      windowId,
      close() {
        if (!closePromise) {
          closePromise = (async () => {
            const cleanupDeadline = Date.now() + WINDOW_CLOSE_TIMEOUT_MS;
            await stopOwnershipMonitor(cleanupDeadline).catch(() => undefined);
            await closeWindowAndVerify(
              context,
              controlPage,
              ownedTargetIds,
              ownedWindowIds,
              options,
              cleanupDeadline,
            );
          })().catch((error) => {
            closePromise = null;
            throw error;
          });
        }
        return closePromise;
      },
    };
  } catch (error) {
    let cleanupError: unknown = null;
    try {
      const cleanupDeadline = Date.now() + WINDOW_CLOSE_TIMEOUT_MS;
      await stopOwnershipMonitor(cleanupDeadline);
      if (targetId) ownedTargetIds.add(targetId);
      if (windowId !== null) ownedWindowIds.add(windowId);
      if (targetId) {
        await closeWindowAndVerify(
          context,
          controlPage,
          ownedTargetIds,
          ownedWindowIds,
          options,
          cleanupDeadline,
        );
      }
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      const combined = new Error(
        `后台窗口初始化失败，且清理未完成：${
          cleanupError instanceof Error
            ? cleanupError.message
            : typeof cleanupError === "string"
              ? cleanupError
              : "未知清理错误"
        }`,
        { cause: error },
      ) as Error & { cleanupFailed?: boolean };
      combined.cleanupFailed = true;
      throw combined;
    }
    throw error;
  }
}
