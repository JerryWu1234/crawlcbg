import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RecordingCoordinator,
  RecordingCoordinatorError,
} from "../recording/recording-coordinator.js";
import type { RecordingStreamEvent } from "../recording/recording-types.js";
import { getSanitizedFilename } from "../scripts/script-files.js";

interface RecordingRoutesDependencies {
  fastify: FastifyInstance;
  trustedBrowserOrigin: RegExp;
  recordingCoordinator: RecordingCoordinator;
}

const sendRecordingError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof RecordingCoordinatorError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
    });
  }
  return reply.status(500).send({
    error: error instanceof Error ? error.message : "浏览器录制请求失败。",
    code: "recording_request_failed",
  });
};

export function registerRecordingRoutes({
  fastify,
  trustedBrowserOrigin,
  recordingCoordinator,
}: RecordingRoutesDependencies): void {
  fastify.post("/api/recordings", async (request, reply) => {
    const { tabIndex, expectedUrl } =
      (request.body as { tabIndex?: number; expectedUrl?: string }) || {};
    if (!Number.isInteger(tabIndex) || typeof expectedUrl !== "string" || !expectedUrl.trim()) {
      return reply.status(400).send({
        error: "请求体必须包含非负整数 tabIndex 和非空 expectedUrl。",
        code: "invalid_recording_target",
      });
    }

    try {
      const recording = await recordingCoordinator.start(tabIndex as number, expectedUrl);
      return reply.status(201).send({ recording });
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.get("/api/recordings/:id/stream", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (typeof requestOrigin !== "string" || !trustedBrowserOrigin.test(requestOrigin)) {
      return reply.status(403).send({ error: "录制事件流请求来源不受信任。" });
    }

    const { id } = request.params as { id?: string };
    if (!id) return reply.status(400).send({ error: "Missing recording id." });

    let unsubscribe: () => void = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };
    const send = (event: RecordingStreamEvent): void => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const subscription = recordingCoordinator.subscribe(id, (event) => {
        send(event);
      });
      unsubscribe = subscription.unsubscribe;

      reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
      reply.raw.setHeader("Vary", "Origin");
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.hijack();
      reply.raw.on("close", cleanup);
      send({ type: "started", recording: subscription.recording });

      if (subscription.recording.status === "stopped") {
        send({ type: "stopped", recording: subscription.recording });
      }

      heartbeat = setInterval(() => {
        if (!closed && !reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.write(": heartbeat\n\n");
        }
      }, 15_000);
    } catch (error) {
      cleanup();
      if (reply.sent) return;
      return sendRecordingError(reply, error);
    }
  });

  fastify.patch("/api/recordings/:id/actions/:actionId", async (request, reply) => {
    const { id, actionId } = request.params as { id?: string; actionId?: string };
    const { included } = (request.body as { included?: boolean }) || {};
    if (!id || !actionId) {
      return reply.status(400).send({ error: "Missing recording id or action id." });
    }
    if (typeof included !== "boolean") {
      return reply.status(400).send({ error: "请求体必须包含布尔值 included。" });
    }

    try {
      return recordingCoordinator.updateActionIncluded(id, actionId, included);
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.post("/api/recordings/:id/stop", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.status(400).send({ error: "Missing recording id." });

    try {
      const recording = await recordingCoordinator.stop(id);
      return { recording };
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.post("/api/recordings/:id/generate", async (request, reply) => {
    const { id } = request.params as { id?: string };
    const { filename } = (request.body as { filename?: string }) || {};
    if (!id) return reply.status(400).send({ error: "Missing recording id." });
    if (
      typeof filename !== "string" ||
      !filename.trim() ||
      filename.length > 160 ||
      filename === "." ||
      filename === ".." ||
      /[\\/]/.test(filename)
    ) {
      return reply.status(400).send({ error: "请提供不含路径的有效脚本文件名。" });
    }

    try {
      const safeFilename = getSanitizedFilename(filename.trim());
      const code = recordingCoordinator.generate(id);
      return { filename: safeFilename, code };
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });
}
