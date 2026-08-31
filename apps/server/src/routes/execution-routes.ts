import type { Stagehand } from "@browserbasehq/stagehand";
import type { FastifyInstance } from "fastify";
import { registerScriptExecutionHandler } from "../execution/script-execution-handler.js";
import type { ExecutionCoordinator } from "../execution/execution-coordinator.js";

interface ExecutionRoutesDependencies {
  fastify: FastifyInstance;
  trustedBrowserOrigin: RegExp;
  executionCoordinator: ExecutionCoordinator;
  getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
}

export function registerExecutionRoutes({
  fastify,
  trustedBrowserOrigin,
  executionCoordinator,
  getUserVisiblePages,
}: ExecutionRoutesDependencies): void {
  fastify.get("/api/scripts/executions/:runId", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (typeof requestOrigin !== "string" || !trustedBrowserOrigin.test(requestOrigin)) {
      return reply.status(403).send({ error: "后台运行状态请求来源不受信任。" });
    }

    const { runId } = request.params as { runId?: string };
    const { afterSequence: rawAfterSequence } =
      (request.query as {
        afterSequence?: string;
      }) || {};
    if (!runId) {
      return reply.status(400).send({ error: "Missing runId." });
    }

    const afterSequence = Math.max(0, Number.parseInt(rawAfterSequence || "0", 10) || 0);
    const execution = executionCoordinator.getSerializedBackgroundExecution(runId, afterSequence);
    if (!execution) {
      return reply.status(404).send({ error: "后台运行记录不存在或已过期。" });
    }
    reply.header("Cache-Control", "no-store");
    return { execution };
  });

  fastify.post("/api/scripts/execute/:runId/manual-step/:stepId/focus", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (typeof requestOrigin !== "string" || !trustedBrowserOrigin.test(requestOrigin)) {
      return reply.status(403).send({ error: "人工操作聚焦请求来源不受信任。" });
    }

    const { runId, stepId } = request.params as { runId?: string; stepId?: string };
    if (!runId || !stepId) {
      return reply.status(400).send({ error: "Missing runId or stepId." });
    }

    try {
      const step = await executionCoordinator.focusManualStep(runId, stepId);
      if (!step) {
        return reply.status(404).send({ error: "人工操作步骤已完成或不存在。" });
      }
      reply.header("Cache-Control", "no-store");
      return {
        success: true,
        step: {
          stepId: step.stepId,
          title: step.title,
          targetCount: step.targetCount,
        },
      };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : "无法聚焦人工操作页面。",
      });
    }
  });

  fastify.post("/api/scripts/execute/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId?: string };
    if (!runId) {
      return reply.status(400).send({ error: "Missing runId." });
    }

    if (!executionCoordinator.cancelScriptExecution(runId)) {
      return reply.status(404).send({ error: "该爬取任务已结束或不存在。" });
    }
    return { success: true, runId, message: "爬取任务中止信号已发送。" };
  });

  registerScriptExecutionHandler({
    fastify,
    trustedBrowserOrigin,
    executionCoordinator,
    getUserVisiblePages,
  });
}
