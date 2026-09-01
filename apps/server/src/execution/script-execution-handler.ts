import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Stagehand } from "@browserbasehq/stagehand";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { createPace } from "../pace.js";
import {
  createMinimizedBrowserWindow,
  type MinimizedBrowserWindow,
} from "../minimized-browser-window.js";
import { SCRIPTS_DIR, TRACES_DIR } from "../config/runtime-paths.js";
import {
  createBackgroundPageFacade,
  createBackgroundStagehandFacade,
} from "../browser/background-capabilities.js";
import { ensureStagehand } from "../browser/stagehand-manager.js";
import {
  createAbortableAutomationProxy,
  isExecutionCancelledError,
  raceWithExecutionCancellation,
  throwIfExecutionCancelled,
} from "./execution-cancellation.js";
import { createManualStepRuntime, ManualStepRuntimeError } from "./manual-step.js";
import type {
  BackgroundExecutionOwnership,
  ExecutionCoordinator,
  ExecutionEventPayload,
  ManualExecutionMode,
} from "./execution-coordinator.js";
import { safeTranspile } from "../scripts/script-compiler.js";
import { getSanitizedFilename } from "../scripts/script-files.js";
import { loadPinnedTabsJSON } from "../tabs/pinned-tabs-store.js";

interface ScriptExecutionHandlerDependencies {
  fastify: FastifyInstance;
  trustedBrowserOrigin: RegExp;
  executionCoordinator: ExecutionCoordinator;
  getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
}

export function registerScriptExecutionHandler({
  fastify,
  trustedBrowserOrigin,
  executionCoordinator,
  getUserVisiblePages,
}: ScriptExecutionHandlerDependencies): void {
  // 8. Execute .mjs script with Frame Capturing (No duplicate version snapshots generated here!)
  fastify.get("/api/scripts/execute/stream", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    const isTrustedBrowserRequest =
      typeof requestOrigin === "string" && trustedBrowserOrigin.test(requestOrigin);
    if (!isTrustedBrowserRequest) {
      return reply.status(403).send({ error: "脚本执行请求来源不受信任。" });
    }

    const {
      filename,
      tabIndex,
      targetUrl,
      params: rawParams,
      runId: requestedRunId,
      executionMode: requestedExecutionMode,
    } = (request.query as {
      filename?: string;
      tabIndex?: string;
      targetUrl?: string;
      params?: string;
      runId?: string;
      executionMode?: string;
    }) || {};

    if (
      requestedExecutionMode &&
      requestedExecutionMode !== "visible" &&
      requestedExecutionMode !== "background"
    ) {
      return reply.status(400).send({ error: "无效的运行方式。" });
    }
    const executionMode: ManualExecutionMode =
      requestedExecutionMode === "background" ? "background" : "visible";

    let scriptParams: Record<string, any> = {};
    try {
      if (rawParams) {
        scriptParams = JSON.parse(rawParams);
      }
    } catch {
      // Ignore invalid JSON params
    }

    // Set SSE headers. Raw responses bypass Fastify's normal CORS response handling.
    if (isTrustedBrowserRequest && typeof requestOrigin === "string") {
      reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
      reply.raw.setHeader("Vary", "Origin");
    }
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");

    const runId = requestedRunId?.trim() || `run_${Date.now()}_${crypto.randomUUID()}`;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "无效的脚本运行 ID。" })}\n\n`,
      );
      reply.raw.end();
      return;
    }
    if (executionCoordinator.hasScriptExecution(runId)) {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "该脚本运行 ID 已在使用中。" })}\n\n`,
      );
      reply.raw.end();
      return;
    }
    const blockingBackgroundRunId = executionCoordinator.getBlockingBackgroundRunId();
    if (executionMode === "background" && blockingBackgroundRunId) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "error",
          code: "background_busy",
          message: `后台窗口任务 ${blockingBackgroundRunId} 正在运行或仍有窗口待清理，请先等待完成或取消。`,
        })}\n\n`,
      );
      reply.raw.end();
      return;
    }
    const browserActivityResult = executionCoordinator.acquireBrowserActivity("execution", runId);
    if (!browserActivityResult.acquired) {
      const { conflict } = browserActivityResult;
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "error",
          code: conflict.kind === "recording" ? "recording_busy" : "browser_busy",
          message:
            conflict.kind === "recording"
              ? `浏览器操作录制 ${conflict.ownerId} 正在进行，请先停止录制。`
              : `浏览器活动 ${conflict.ownerId} 正在占用执行环境。`,
        })}\n\n`,
      );
      reply.raw.end();
      return;
    }
    const browserActivityLease = browserActivityResult.lease;

    if (executionMode === "background") {
      executionCoordinator.setActiveBackgroundExecutionRunId(runId);
    }

    const executionController = new AbortController();
    const executionSignal = executionController.signal;
    const pendingAutomationOperations = new Set<Promise<unknown>>();
    executionCoordinator.registerScriptExecution(runId, executionController);

    const backgroundRecord =
      executionMode === "background"
        ? executionCoordinator.createBackgroundExecutionRecord(
            runId,
            getSanitizedFilename(filename || "script.mjs"),
            targetUrl?.trim() || "",
          )
        : null;
    const backgroundOwnership: BackgroundExecutionOwnership | null =
      executionMode === "background"
        ? executionCoordinator.createBackgroundExecutionOwnership(runId)
        : null;

    let backgroundWindow: MinimizedBrowserWindow | null = null;
    let backgroundWindowCleanupFailed = false;
    let backgroundWindowOwnershipError: unknown = null;
    let executionFinished = false;
    let activeTargetKey: string | null = null;
    let ownsActiveTargetLock = false;

    let pendingTerminalEvent: ExecutionEventPayload | null = null;
    let finishResponsePromise: Promise<void> | null = null;
    const isTerminalEvent = (data: ExecutionEventPayload) =>
      data.type === "done" || data.type === "error" || data.type === "cancelled";
    const writeEvent = (data: ExecutionEventPayload) => {
      const outgoingEvent = executionCoordinator.appendBackgroundExecutionEvent(
        backgroundRecord,
        data,
      );
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(outgoingEvent)}\n\n`);
      }
    };
    const sendEvent = (data: ExecutionEventPayload) => {
      if (executionMode === "background" && isTerminalEvent(data)) {
        pendingTerminalEvent ??= data;
        return;
      }
      writeEvent(data);
    };
    const handleClientDisconnect = () => {
      if (executionMode === "visible" && !executionFinished && !executionSignal.aborted) {
        executionController.abort();
      }
    };
    const finishResponse = (): Promise<void> => {
      if (finishResponsePromise) return finishResponsePromise;
      finishResponsePromise = (async () => {
        executionFinished = true;
        reply.raw.off("close", handleClientDisconnect);
        await executionCoordinator.disposeManualStep(runId);

        let cleanupError: unknown = null;
        const windowToClose = backgroundWindow;
        backgroundWindow = null;
        if (windowToClose) {
          try {
            await windowToClose.close();
          } catch (error) {
            cleanupError = error;
            fastify.log.error(
              `[Background Window] 关闭运行窗口失败: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (backgroundWindowCleanupFailed && !cleanupError) {
          cleanupError = new Error("后台窗口初始化失败后的清理未完成。");
        }
        if (!cleanupError && backgroundOwnership) {
          executionCoordinator.releaseBackgroundExecutionOwnership(runId);
        }
        if (activeTargetKey && ownsActiveTargetLock) {
          executionCoordinator.releaseTargetExecution(activeTargetKey, runId);
        }
        executionCoordinator.releaseScriptExecution(runId, executionController);
        executionCoordinator.releaseActiveBackgroundExecutionRunId(runId);
        executionCoordinator.releaseBrowserActivity(browserActivityLease);

        if (cleanupError) {
          pendingTerminalEvent = {
            type: "error",
            code: "background_window_cleanup_failed",
            runId,
            time: new Date().toLocaleTimeString(),
            message: `脚本已停止，但独立后台窗口未确认关闭：${
              cleanupError instanceof Error
                ? cleanupError.message
                : typeof cleanupError === "string"
                  ? cleanupError
                  : "未知清理错误"
            }`,
          };
        } else if (backgroundWindowOwnershipError) {
          pendingTerminalEvent = {
            type: "error",
            code: "background_window_ownership_failed",
            runId,
            time: new Date().toLocaleTimeString(),
            message: `无法持续确认派生窗口处于最小化状态，后台运行已停止：${
              backgroundWindowOwnershipError instanceof Error
                ? backgroundWindowOwnershipError.message
                : typeof backgroundWindowOwnershipError === "string"
                  ? backgroundWindowOwnershipError
                  : "未知所有权监控错误"
            }`,
          };
        }
        if (backgroundRecord && !pendingTerminalEvent) {
          pendingTerminalEvent = {
            type: executionSignal.aborted ? "cancelled" : "error",
            runId,
            time: new Date().toLocaleTimeString(),
            message: executionSignal.aborted
              ? "🛑 后台脚本运行已中止。"
              : "❌ 后台脚本运行在返回终态前结束。",
          };
        }
        if (pendingTerminalEvent) writeEvent(pendingTerminalEvent);
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
      })();
      return finishResponsePromise;
    };
    const sendEarlyCancellation = () => {
      sendEvent({
        type: "cancelled",
        runId,
        time: new Date().toLocaleTimeString(),
        message: `🛑 脚本 [${getSanitizedFilename(filename || "script.mjs")}] 已中止。`,
      });
    };
    reply.raw.on("close", handleClientDisconnect);
    sendEvent({
      type: "accepted",
      runId,
      time: new Date().toLocaleTimeString(),
      message:
        executionMode === "background"
          ? "服务端已接受后台运行请求，正在创建独立最小化窗口。"
          : "服务端已接受脚本执行请求。",
    });

    let sh: Stagehand;
    try {
      sh = await ensureStagehand();
    } catch {
      if (executionSignal.aborted) {
        sendEarlyCancellation();
      } else {
        sendEvent({ type: "error", message: "Stagehand 未连接到 Chrome 浏览器。" });
      }
      await finishResponse();
      return;
    }

    if (executionSignal.aborted) {
      sendEarlyCancellation();
      await finishResponse();
      return;
    }

    let index = Number(tabIndex ?? 0);
    let pages = await getUserVisiblePages(sh);
    let targetPage: any;

    if (executionMode === "background") {
      if (!targetUrl?.trim()) {
        sendEvent({
          type: "error",
          code: "background_target_required",
          message: "后台运行需要明确的目标 URL。",
        });
        await finishResponse();
        return;
      }

      activeTargetKey = executionCoordinator.getTargetExecutionKey(targetUrl);
      const activeExecution = executionCoordinator.getTargetExecution(activeTargetKey);
      if (activeExecution) {
        sendEvent({
          type: "error",
          code: "target_busy",
          runId,
          message: `该目标页正在执行任务 ${activeExecution.runId}，不能重复执行。`,
        });
        await finishResponse();
        return;
      }
      executionCoordinator.setTargetExecution(activeTargetKey, runId);
      ownsActiveTargetLock = true;

      try {
        backgroundWindow = await createMinimizedBrowserWindow(
          sh.context,
          targetUrl,
          executionSignal,
          {
            onTargetCreated(targetId) {
              backgroundOwnership?.rootTargetIds.add(targetId);
              backgroundOwnership?.targetIds.add(targetId);
            },
            onTargetDiscovered(targetId) {
              backgroundOwnership?.targetIds.add(targetId);
            },
            onWindowReady(windowId) {
              backgroundOwnership?.windowIds.add(windowId);
            },
            onWindowDiscovered(windowId) {
              backgroundOwnership?.windowIds.add(windowId);
            },
            onOwnershipError(error) {
              if (backgroundWindowOwnershipError) return;
              backgroundWindowOwnershipError = error;
              fastify.log.error(
                `[Background Window] 派生窗口所有权监控失败: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              if (!executionSignal.aborted) executionController.abort();
            },
          },
        );
        targetPage = backgroundWindow.page;
        index = -1;
        sendEvent({
          type: "log",
          runId,
          time: new Date().toLocaleTimeString(),
          message: "🪟 已创建并最小化独立 Chrome 执行窗口。",
        });
      } catch (error) {
        backgroundWindowCleanupFailed = Boolean(
          (error as Error & { cleanupFailed?: boolean }).cleanupFailed,
        );
        if (executionSignal.aborted) {
          sendEarlyCancellation();
        } else {
          sendEvent({
            type: "error",
            code: "background_window_failed",
            message: `无法创建独立最小化 Chrome 窗口：${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        await finishResponse();
        return;
      }
    } else if (targetUrl?.trim()) {
      const expectedUrl = targetUrl.trim();
      const exactMatches = pages.filter(
        (page) => !(page as any).isClosed?.() && page.url() === expectedUrl,
      );
      if (exactMatches.length > 1) {
        sendEvent({
          type: "error",
          code: "target_ambiguous",
          message: "存在多个 URL 完全相同的标签页，无法安全确认目标，请关闭重复页签后重试。",
        });
        await finishResponse();
        return;
      }
      if (
        isNaN(index) ||
        index < 0 ||
        index >= pages.length ||
        (pages[index] as any).isClosed?.() ||
        pages[index].url() !== expectedUrl
      ) {
        sendEvent({
          type: "error",
          code: "target_not_found",
          message: "目标标签页的序号或 URL 已变化，本轮未执行，请刷新后重试。",
        });
        await finishResponse();
        return;
      }
      targetPage = pages[index];
    } else {
      if (isNaN(index) || index < 0 || index >= pages.length) {
        sendEvent({
          type: "error",
          message: `目标 Tab 序号 #${index + 1} 无效或超出了打开的页签数量 (${pages.length})`,
        });
        await finishResponse();
        return;
      }
      targetPage = pages[index];
    }

    if (executionMode === "visible") {
      activeTargetKey = executionCoordinator.getTargetExecutionKey(targetPage.url());
      const activeExecution = executionCoordinator.getTargetExecution(activeTargetKey);
      if (activeExecution) {
        sendEvent({
          type: "error",
          code: "target_busy",
          runId,
          message: `该目标页正在执行任务 ${activeExecution.runId}，不能重复执行。`,
        });
        await finishResponse();
        return;
      }
      if (!activeExecution) {
        executionCoordinator.setTargetExecution(activeTargetKey, runId);
        ownsActiveTargetLock = true;
      }
    }

    const executionTargetPage =
      executionMode === "background" ? createBackgroundPageFacade(targetPage as any) : targetPage;
    const abortableTargetPage = createAbortableAutomationProxy(
      executionTargetPage as any,
      executionSignal,
      pendingAutomationOperations,
    );
    if (executionMode === "visible") {
      try {
        if (typeof (targetPage as any).bringToFront === "function") {
          void (targetPage as any).bringToFront();
        } else if (typeof (targetPage as any).sendCDP === "function") {
          void (targetPage as any).sendCDP("Page.bringToFront");
        }
      } catch {
        // Ignore focus errors in the explicitly visible mode.
      }
    }

    const safeName = getSanitizedFilename(filename || "script.mjs");
    const scriptPath = path.join(SCRIPTS_DIR, safeName);

    if (!fs.existsSync(scriptPath)) {
      sendEvent({ type: "error", message: `脚本文件 ${safeName} 不存在。` });
      await finishResponse();
      return;
    }

    const runDir = path.join(TRACES_DIR, runId);
    try {
      fs.mkdirSync(runDir, { recursive: true });
    } catch (error) {
      sendEvent({
        type: "error",
        message: `无法创建运行记录目录：${error instanceof Error ? error.message : String(error)}`,
      });
      await finishResponse();
      return;
    }
    const traceFrames: Array<{ step: number; time: string; message: string; frameUrl: string }> =
      [];
    const traceLogs: Array<{ time: string; message: string; type: string }> = [];

    let lastScreenshotTime = 0;
    let lastFrameUrl = "";
    let screenshotCounter = 0;
    let screenshotsAllowed = true;
    let screenshotPrivacyLocked = false;
    const pendingScreenshotCaptures = new Set<Promise<void>>();
    let tracePage: any = targetPage;
    const tracePageParents = new WeakMap<object, any>();
    const activateTracePage = (page: any) => {
      tracePage = page;
      lastScreenshotTime = 0;
      lastFrameUrl = "";
    };
    const disableScreenshots = async (): Promise<void> => {
      screenshotsAllowed = false;
      if (pendingScreenshotCaptures.size > 0) {
        await Promise.allSettled(pendingScreenshotCaptures);
      }
      // Never reuse a pre-manual frame after the privacy boundary.
      lastFrameUrl = "";
      lastScreenshotTime = 0;
      if (!screenshotPrivacyLocked) {
        screenshotPrivacyLocked = true;
        sendEvent({
          type: "manual-step-privacy-locked",
          runId,
          time: new Date().toLocaleTimeString(),
        });
      }
    };

    const sendLog = async (message: string, logType: string = "log") => {
      const stepTime = new Date().toLocaleTimeString();
      traceLogs.push({ time: stepTime, message, type: logType });

      // Text logs should never wait for screenshot capture. Push them to the UI immediately.
      sendEvent({
        type: logType,
        time: stepTime,
        message,
        runId,
      });

      try {
        if (screenshotsAllowed && tracePage && !(tracePage as any).isClosed?.()) {
          const screenshotCapture = (async (): Promise<void> => {
            const now = Date.now();
            const isActionMsg = /页面|点击|滚动|导航|打开|提取|保存|加载|下页|底端/.test(message);

            // Capture a new screenshot if > 1.2s elapsed or page action occurred or first frame.
            if (now - lastScreenshotTime > 1200 || isActionMsg || !lastFrameUrl) {
              screenshotCounter++;
              const imageName = `frame_${screenshotCounter}.jpg`;
              const imagePath = path.join(runDir, imageName);

              const imgBuffer = await (tracePage as any).screenshot({
                type: "jpeg",
                quality: 60,
              });

              fs.writeFileSync(imagePath, imgBuffer);
              lastFrameUrl = `http://localhost:3001/api/traces/${runId}/frame/${imageName}`;
              lastScreenshotTime = now;
            }

            if (lastFrameUrl) {
              const frameData = {
                step: traceFrames.length + 1,
                time: stepTime,
                message,
                frameUrl: lastFrameUrl,
              };
              traceFrames.push(frameData);

              sendEvent({
                type: "frame",
                runId,
                ...frameData,
              });
            }
          })();
          pendingScreenshotCaptures.add(screenshotCapture);
          try {
            await screenshotCapture;
          } finally {
            pendingScreenshotCaptures.delete(screenshotCapture);
          }
        }
      } catch {
        // Screenshot capture is optional
      }

      // Always persist updated trace.json metadata including logs
      try {
        fs.writeFileSync(
          path.join(runDir, "trace.json"),
          JSON.stringify(
            {
              runId,
              filename: safeName,
              targetUrl:
                targetUrl ||
                (targetPage && !(targetPage as any).isClosed?.() ? targetPage.url() : ""),
              timestamp: new Date().toLocaleString("zh-CN"),
              totalFrames: traceFrames.length,
              totalLogs: traceLogs.length,
              frames: traceFrames,
              logs: traceLogs,
            },
            null,
            2,
          ),
          "utf-8",
        );
      } catch {
        // Ignore JSON write error
      }
    };

    const executionTargetLabel =
      executionMode === "background" ? "独立最小化 Chrome 窗口" : `Tab #${index + 1}`;
    void sendLog(`🎬 开始在${executionTargetLabel} (${targetPage.url()}) 上运行脚本 [${safeName}]`);

    (async () => {
      try {
        // Pre-run URL Match Verification & Redirect Check
        let expectedUrl = targetUrl;
        if (!expectedUrl) {
          const pinnedTabs = loadPinnedTabsJSON();
          const matchedPinned = pinnedTabs.find((p) => p.scriptFilename === safeName);
          if (matchedPinned) {
            expectedUrl = matchedPinned.url;
          }
        }

        if (expectedUrl && expectedUrl.trim()) {
          const currentUrl = targetPage.url();
          if (currentUrl !== expectedUrl) {
            void sendLog(
              `⚠️ [运行前 URL 校验] 当前页签 URL (${currentUrl}) 与常驻目标 URL (${expectedUrl}) 不一致，正在自动重定向校准...`,
            );
            try {
              await abortableTargetPage.goto(expectedUrl, { waitUntil: "domcontentloaded" });
              void sendLog(`✅ [运行前 URL 校验] 成功纠偏重定向至目标网页: ${targetPage.url()}`);
            } catch (navErr: any) {
              if (isExecutionCancelledError(navErr) || executionSignal.aborted) throw navErr;
              void sendLog(`⚠️ 自动重定向页面警告: ${navErr.message}`);
            }
          } else {
            void sendLog(`✅ [运行前 URL 校验] 页面 URL 校验 100% 吻合: ${currentUrl}`);
          }
        }

        const sourceCode = fs.readFileSync(scriptPath, "utf-8");

        let codeBody = sourceCode
          .replace(/import\s+type\s+[^;]+;/g, "")
          .replace(/import\s+[^;]+;/g, "")
          .replace(/export\s+interface\s+[^}]*}/g, "")
          .replace(/interface\s+[^}]*}/g, "")
          .replace(/type\s+\w+\s*=[^;]+;/g, "");

        if (/export\s+default\s+(async\s+)?function/.test(codeBody)) {
          codeBody = codeBody.replace(
            /export\s+default\s+(async\s+)?function\s*\w*\s*\([^)]*\)\s*\{/,
            "",
          );
          const lastBraceIndex = codeBody.lastIndexOf("}");
          if (lastBraceIndex !== -1) {
            codeBody = codeBody.slice(0, lastBraceIndex) + codeBody.slice(lastBraceIndex + 1);
          }
        }

        const transpiledJS = safeTranspile(codeBody).outputText;

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const runner = new AsyncFunction(
          "page",
          "stagehand",
          "log",
          "console",
          "db",
          "params",
          "signal",
          "pace",
          "fetch",
          "manual",
          transpiledJS,
        );

        const executionLog = async (message: string, logType: string = "log") => {
          throwIfExecutionCancelled(executionSignal);
          await sendLog(message, logType);
          throwIfExecutionCancelled(executionSignal);
        };
        const executionStagehand =
          executionMode === "background"
            ? createBackgroundStagehandFacade(sh, targetPage as any)
            : sh;
        const abortableStagehand = createAbortableAutomationProxy(
          executionStagehand as any,
          executionSignal,
          pendingAutomationOperations,
        );
        const abortableDb = createAbortableAutomationProxy(
          db as any,
          executionSignal,
          pendingAutomationOperations,
        );
        const pace = createPace({
          rootPage: abortableTargetPage,
          getPages: () => {
            if (executionMode === "background") {
              throw new Error(
                "pace.clickAndWaitForNewPage 暂不支持 background 模式，请改用 visible 模式运行。",
              );
            }
            return abortableStagehand.context.pages();
          },
          signal: executionSignal,
          onPageOpened: (openedPage, sourcePage) => {
            tracePageParents.set(openedPage, sourcePage);
            activateTracePage(openedPage);
          },
          onPageClosed: (closedPage) => {
            const parentPage = tracePageParents.get(closedPage);
            tracePageParents.delete(closedPage);
            if (tracePage === closedPage) {
              activateTracePage(parentPage ?? abortableTargetPage);
            }
          },
        });
        const manual = createManualStepRuntime({
          runId,
          executionMode,
          signal: executionSignal,
          executionCoordinator,
          getPages: () => sh.context.pages(),
          cancelExecution: () => {
            if (!executionSignal.aborted) executionController.abort();
          },
          disableScreenshots,
          onRequired: async ({ stepId, title, targetCount }) => {
            sendEvent({
              type: "manual-step-required",
              runId,
              stepId,
              title,
              targetCount,
              time: new Date().toLocaleTimeString(),
            });
            await sendLog(`✋ 等待人工操作：${title}（${targetCount} 项）`);
          },
          onResolved: async ({ stepId, title, targetCount, resolution }) => {
            sendEvent({
              type: "manual-step-resolved",
              runId,
              stepId,
              title,
              targetCount,
              resolution,
              time: new Date().toLocaleTimeString(),
            });
            if (resolution === "completed") {
              await sendLog(`✅ 人工操作已确认：${title}`);
            }
          },
        });
        const abortableFetch: typeof fetch = (input, init) => {
          throwIfExecutionCancelled(executionSignal);
          const requestSignal = init?.signal
            ? AbortSignal.any([executionSignal, init.signal])
            : executionSignal;
          const request = fetch(input, { ...init, signal: requestSignal });
          pendingAutomationOperations.add(request);
          request.then(
            () => pendingAutomationOperations.delete(request),
            () => pendingAutomationOperations.delete(request),
          );
          return raceWithExecutionCancellation(request, executionSignal);
        };

        const customConsole = {
          ...console,
          log: (...args: any[]) => {
            throwIfExecutionCancelled(executionSignal);
            console.log(...args);
            void sendLog(
              args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
            );
          },
          error: (...args: any[]) => {
            throwIfExecutionCancelled(executionSignal);
            console.error(...args);
            void sendLog(
              "❌ " +
                args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
            );
          },
        };

        // Execute script passing db and scriptParams.
        sendEvent({
          type: "started",
          runId,
          time: new Date().toLocaleTimeString(),
          message: `脚本 [${safeName}] 已开始执行。`,
        });
        const runnerPromise = runner(
          abortableTargetPage,
          abortableStagehand,
          executionLog,
          customConsole,
          abortableDb,
          scriptParams,
          executionSignal,
          pace,
          abortableFetch,
          manual,
        );
        // Wait for user code to exit instead of reporting cancellation while it is still running.
        // Wrapped automation, database, log and fetch boundaries reject cooperatively on abort.
        await runnerPromise;
        throwIfExecutionCancelled(executionSignal);

        sendEvent({
          type: "done",
          runId,
          time: new Date().toLocaleTimeString(),
          message: `🎉 脚本 [${safeName}] 在${executionTargetLabel}中全部执行完毕！`,
        });
      } catch (err: any) {
        if (isExecutionCancelledError(err) || executionSignal.aborted) {
          const message = `🛑 脚本 [${safeName}] 在${executionTargetLabel}中已中止。`;
          await sendLog(message, "cancelled");
        } else {
          sendEvent({
            type: "error",
            ...(err instanceof ManualStepRuntimeError ? { code: err.code } : {}),
            runId,
            time: new Date().toLocaleTimeString(),
            message: `❌ 脚本执行异常中断: ${err.message || String(err)}`,
          });
        }
      } finally {
        if (pendingAutomationOperations.size > 0) {
          await Promise.allSettled(pendingAutomationOperations);
        }
        if (pendingScreenshotCaptures.size > 0) {
          await Promise.allSettled(pendingScreenshotCaptures);
        }
        await finishResponse();
      }
    })().catch(async (err) => {
      sendEvent({ type: "error", message: `系统致命错误: ${err.message}` });
      await finishResponse();
    });
  });
}
