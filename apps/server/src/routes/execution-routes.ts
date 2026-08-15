import type { Stagehand } from "@browserbasehq/stagehand";
import type { FastifyInstance } from "fastify";
import { registerScriptExecutionHandler } from "../execution/script-execution-handler.js";
import type { ExecutionCoordinator } from "../execution/execution-coordinator.js";

interface ExecutionRoutesDependencies {
  fastify: FastifyInstance;
  trustedBrowserOrigin: RegExp;
  internalExecutionToken: string;
  executionCoordinator: ExecutionCoordinator;
  getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
}

export function registerExecutionRoutes({
  fastify,
  trustedBrowserOrigin,
  internalExecutionToken,
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
    internalExecutionToken,
    executionCoordinator,
    getUserVisiblePages,
  });
}
