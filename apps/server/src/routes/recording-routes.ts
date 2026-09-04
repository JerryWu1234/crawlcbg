import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RecordingCoordinator,
  RecordingCoordinatorError,
  type CreatePaginationLoopInput,
  type InsertRecordingActionInput,
  type ManualStepConversionMode,
  type PaginationLoopSelectionInput,
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

const paginationLoopSelectionFromBody = (body: unknown): PaginationLoopSelectionInput | null => {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Partial<PaginationLoopSelectionInput>;
  if (
    !Array.isArray(candidate.actionIds) ||
    !candidate.actionIds.every((actionId) => typeof actionId === "string" && actionId.length > 0) ||
    typeof candidate.listEntryActionId !== "string" ||
    !candidate.listEntryActionId ||
    typeof candidate.nextActionId !== "string" ||
    !candidate.nextActionId
  ) {
    return null;
  }
  return {
    actionIds: [...candidate.actionIds],
    listEntryActionId: candidate.listEntryActionId,
    nextActionId: candidate.nextActionId,
  };
};

const insertActionInputFromBody = (body: unknown): InsertRecordingActionInput | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (
    !Object.hasOwn(candidate, "afterActionId") ||
    (candidate.afterActionId !== null &&
      (typeof candidate.afterActionId !== "string" || !candidate.afterActionId)) ||
    !candidate.action ||
    typeof candidate.action !== "object" ||
    Array.isArray(candidate.action)
  ) {
    return null;
  }

  const action = candidate.action as Record<string, unknown>;
  const selector = typeof action.selector === "string" ? action.selector.trim() : "";
  const exactKeys = (...expected: string[]): boolean => {
    const keys = Object.keys(action);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
  };
  let normalizedAction: InsertRecordingActionInput["action"];
  switch (action.type) {
    case "click":
      if (!selector || !exactKeys("type", "selector")) return null;
      normalizedAction = { type: "click", selector };
      break;
    case "fill":
      if (
        !selector ||
        typeof action.value !== "string" ||
        !exactKeys("type", "selector", "value")
      ) {
        return null;
      }
      normalizedAction = { type: "fill", selector, value: action.value };
      break;
    case "select":
      if (
        !selector ||
        (typeof action.value !== "string" &&
          !(
            Array.isArray(action.value) && action.value.every((item) => typeof item === "string")
          )) ||
        !exactKeys("type", "selector", "value")
      ) {
        return null;
      }
      normalizedAction = {
        type: "select",
        selector,
        value: Array.isArray(action.value) ? [...action.value] : action.value,
      };
      break;
    case "setChecked":
      if (
        !selector ||
        typeof action.value !== "boolean" ||
        !exactKeys("type", "selector", "value")
      ) {
        return null;
      }
      normalizedAction = { type: "setChecked", selector, value: action.value };
      break;
    case "press":
      if (typeof action.value !== "string" || !action.value.trim() || !exactKeys("type", "value")) {
        return null;
      }
      normalizedAction = { type: "press", value: action.value.trim() };
      break;
    case "scroll":
      if (
        typeof action.value !== "number" ||
        !Number.isFinite(action.value) ||
        !exactKeys("type", "value")
      ) {
        return null;
      }
      normalizedAction = { type: "scroll", value: action.value };
      break;
    default:
      return null;
  }

  return {
    afterActionId: candidate.afterActionId as string | null,
    action: normalizedAction,
  };
};

export function registerRecordingRoutes({
  fastify,
  trustedBrowserOrigin,
  recordingCoordinator,
}: RecordingRoutesDependencies): void {
  fastify.post("/api/recordings", async (request, reply) => {
    const { tabIndex, targetId, expectedUrl } =
      (request.body as { tabIndex?: number; targetId?: string; expectedUrl?: string }) || {};
    if (
      !Number.isInteger(tabIndex) ||
      typeof targetId !== "string" ||
      !targetId.trim() ||
      typeof expectedUrl !== "string" ||
      !expectedUrl.trim()
    ) {
      return reply.status(400).send({
        error: "请求体必须包含非负整数 tabIndex、非空 targetId 和 expectedUrl。",
        code: "invalid_recording_target",
      });
    }

    try {
      const recording = await recordingCoordinator.start(tabIndex as number, targetId, expectedUrl);
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

  fastify.post("/api/recordings/:id/actions", async (request, reply) => {
    const { id } = request.params as { id?: string };
    const input = insertActionInputFromBody(request.body);
    if (!id) return reply.status(400).send({ error: "Missing recording id." });
    if (!input) {
      return reply.status(400).send({
        error: "请求体必须包含 afterActionId 和有效的 action。",
        code: "invalid_recording_action",
      });
    }

    try {
      return reply.status(201).send(recordingCoordinator.insertAction(id, input));
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.delete("/api/recordings/:id/actions/:actionId", async (request, reply) => {
    const { id, actionId } = request.params as { id?: string; actionId?: string };
    if (!id || !actionId) {
      return reply.status(400).send({ error: "Missing recording id or action id." });
    }

    try {
      return recordingCoordinator.deleteAction(id, actionId);
    } catch (error) {
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

  fastify.post("/api/recordings/:id/pagination-loop/preview", async (request, reply) => {
    const { id } = request.params as { id?: string };
    const selection = paginationLoopSelectionFromBody(request.body);
    if (!id) return reply.status(400).send({ error: "Missing recording id." });
    if (!selection) {
      return reply.status(400).send({
        error: "请求体必须包含 actionIds、listEntryActionId 和 nextActionId。",
      });
    }

    try {
      return { preview: recordingCoordinator.previewPaginationLoop(id, selection) };
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.post("/api/recordings/:id/pagination-loop", async (request, reply) => {
    const { id } = request.params as { id?: string };
    const selection = paginationLoopSelectionFromBody(request.body);
    const body = (request.body as Partial<CreatePaginationLoopInput>) || {};
    if (!id) return reply.status(400).send({ error: "Missing recording id." });
    if (!selection || !Number.isInteger(body.candidateIndex) || !Number.isInteger(body.maxPages)) {
      return reply.status(400).send({
        error:
          "请求体必须包含 actionIds、listEntryActionId、nextActionId、candidateIndex 和 maxPages。",
      });
    }

    try {
      const recording = recordingCoordinator.createPaginationLoop(id, {
        ...selection,
        candidateIndex: body.candidateIndex as number,
        maxPages: body.maxPages as number,
      });
      return reply.status(201).send({ recording });
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.delete("/api/recordings/:id/pagination-loop", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.status(400).send({ error: "Missing recording id." });

    try {
      return { recording: recordingCoordinator.dissolvePaginationLoop(id) };
    } catch (error) {
      return sendRecordingError(reply, error);
    }
  });

  fastify.post("/api/recordings/:id/manual-steps", async (request, reply) => {
    const { id } = request.params as { id?: string };
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    if (!id) return reply.status(400).send({ error: "Missing recording id." });
    if (Object.hasOwn(body, "selector") || Object.hasOwn(body, "value")) {
      return reply.status(400).send({
        error: "人工步骤只能引用动作 ID，不能提交 selector 或 value。",
        code: "manual_step_raw_data_rejected",
      });
    }

    const { actionIds, mode, title } = body;
    if (
      !Array.isArray(actionIds) ||
      actionIds.length === 0 ||
      actionIds.some((actionId) => typeof actionId !== "string")
    ) {
      return reply.status(400).send({ error: "请求体必须包含非空字符串数组 actionIds。" });
    }
    if (mode !== undefined && mode !== "controls" && mode !== "custom") {
      return reply.status(400).send({ error: "mode 必须是 controls 或 custom。" });
    }
    if (title !== undefined && typeof title !== "string") {
      return reply.status(400).send({ error: "title 必须是字符串。" });
    }

    try {
      return recordingCoordinator.createManualStep(id, {
        actionIds,
        ...(mode ? { mode: mode as ManualStepConversionMode } : {}),
        ...(typeof title === "string" ? { title } : {}),
      });
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
