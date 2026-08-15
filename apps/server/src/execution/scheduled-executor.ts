import type { Stagehand } from "@browserbasehq/stagehand";
import type { ScheduledExecutionRequest, ScheduledExecutionResult } from "../scheduler.js";
import type { ExecutionCoordinator } from "./execution-coordinator.js";

interface ScheduledExecutorDependencies {
  executionCoordinator: ExecutionCoordinator;
  getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
  ensureStagehand: () => Promise<Stagehand>;
  port: number;
  internalExecutionToken: string;
  fetch: typeof fetch;
}

export function createScheduledExecutor({
  executionCoordinator,
  getUserVisiblePages,
  ensureStagehand,
  port,
  internalExecutionToken,
  fetch,
}: ScheduledExecutorDependencies): (
  request: ScheduledExecutionRequest,
) => Promise<ScheduledExecutionResult> {
  return async function executeScheduledRequest({
    runId,
    schedule,
  }: ScheduledExecutionRequest): Promise<ScheduledExecutionResult> {
    const targetKey = executionCoordinator.getTargetExecutionKey(schedule.targetUrl);
    const activeExecution = executionCoordinator.getTargetExecution(targetKey);
    if (activeExecution) {
      return {
        status: "skipped",
        error: `目标标签页正在执行任务 ${activeExecution.runId}，本轮已跳过。`,
      };
    }

    executionCoordinator.setTargetExecution(targetKey, runId, "scheduler");
    let createdPage: any = null;
    let executionStarted = false;

    try {
      let sh: Stagehand;
      try {
        sh = await ensureStagehand();
      } catch (error) {
        throw new Error(
          `Stagehand 未连接到 Chrome：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let pages = await getUserVisiblePages(sh);
      let targetPage: any = pages.find(
        (page) => !(page as any).isClosed?.() && page.url() === schedule.targetUrl,
      );

      if (!targetPage) {
        createdPage = await sh.context.newPage();
        targetPage = createdPage;
        await targetPage.goto(schedule.targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }

      pages = await getUserVisiblePages(sh);
      const tabIndex = pages.indexOf(targetPage);
      if (tabIndex < 0) {
        throw new Error("重新获取目标标签页后无法确定页签序号。");
      }

      const query = new URLSearchParams({
        filename: schedule.scriptFilename,
        tabIndex: String(tabIndex),
        targetUrl: schedule.targetUrl,
        params: JSON.stringify(schedule.params),
        runId,
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/api/scripts/execute/stream?${query.toString()}`,
        { headers: { "x-crawlcbg-internal-token": internalExecutionToken } },
      );
      if (!response.ok) {
        throw new Error(`后台执行接口返回 HTTP ${response.status}。`);
      }
      if (!response.body) {
        throw new Error("后台执行接口未返回事件流。");
      }

      let terminalResult: ScheduledExecutionResult | null = null;
      const consumeEventLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        try {
          const event = JSON.parse(line.slice(5).trim()) as {
            type?: string;
            code?: string;
            message?: string;
          };
          if (event.type === "started") {
            executionStarted = true;
          } else if (event.type === "done") {
            terminalResult = { status: "completed" };
          } else if (event.type === "cancelled") {
            terminalResult = { status: "failed", error: event.message || "后台任务已中止。" };
          } else if (event.type === "error") {
            terminalResult = {
              status: event.code === "target_busy" ? "skipped" : "failed",
              error: event.message || "后台脚本执行失败。",
            };
          }
        } catch {
          // Ignore malformed non-terminal SSE lines.
        }
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingLine = "";
      const consumeAvailableLines = (flush = false) => {
        let newlineIndex = pendingLine.indexOf("\n");
        while (newlineIndex >= 0) {
          consumeEventLine(pendingLine.slice(0, newlineIndex).replace(/\r$/, ""));
          pendingLine = pendingLine.slice(newlineIndex + 1);
          newlineIndex = pendingLine.indexOf("\n");
        }
        if (flush && pendingLine) {
          consumeEventLine(pendingLine.replace(/\r$/, ""));
          pendingLine = "";
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pendingLine += decoder.decode(value, { stream: true });
          consumeAvailableLines();
        }
        pendingLine += decoder.decode();
        consumeAvailableLines(true);
      } finally {
        reader.releaseLock();
      }

      return (
        terminalResult ?? {
          status: "failed",
          error: "后台脚本执行流在返回完成状态前结束。",
        }
      );
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (createdPage && !executionStarted && !(createdPage as any).isClosed?.()) {
        try {
          await createdPage.close();
        } catch {
          // Best-effort cleanup for pages created by a failed pre-execution attempt.
        }
      }
      executionCoordinator.releaseTargetExecution(targetKey, runId, "scheduler");
    }
  };
}
