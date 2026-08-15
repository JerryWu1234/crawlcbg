import type { FastifyInstance } from "fastify";
import type { TabScheduleInput, TabScheduler } from "../scheduler.js";

interface ScheduleRoutesDependencies {
  fastify: FastifyInstance;
  scheduler: TabScheduler;
}

export function registerScheduleRoutes({ fastify, scheduler }: ScheduleRoutesDependencies): void {
  fastify.get("/api/schedules", async () => ({ schedules: scheduler.list() }));

  fastify.post("/api/schedules", async (request, reply) => {
    try {
      const schedule = scheduler.save((request.body || {}) as TabScheduleInput);
      return reply.status(201).send({ schedule });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message.includes("正在执行") ||
        message.includes("已有循环任务") ||
        message.includes("UNIQUE")
          ? 409
          : 400;
      return reply.status(status).send({ error: message });
    }
  });

  fastify.patch("/api/schedules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = scheduler.getById(id);
    if (!current) return reply.status(404).send({ error: "循环任务不存在。" });

    const patch = (request.body || {}) as Partial<TabScheduleInput>;
    try {
      const schedule = scheduler.save({
        id,
        targetUrl: patch.targetUrl ?? current.targetUrl,
        targetTitle: patch.targetTitle ?? current.targetTitle,
        scriptFilename: patch.scriptFilename ?? current.scriptFilename,
        params: patch.params ?? current.params,
        recurrenceType: patch.recurrenceType ?? current.recurrenceType,
        intervalValue: patch.intervalValue ?? current.intervalValue,
        runAt: patch.runAt ?? current.runAt,
        enabled: patch.enabled ?? current.enabled,
      });
      return { schedule };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message.includes("正在执行") ||
        message.includes("已有循环任务") ||
        message.includes("UNIQUE")
          ? 409
          : 400;
      return reply.status(status).send({ error: message });
    }
  });

  fastify.delete("/api/schedules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      if (!scheduler.delete(id)) {
        return reply.status(404).send({ error: "循环任务不存在。" });
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(409).send({ error: message });
    }
  });
}
