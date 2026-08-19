import fs from "node:fs";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  abortSession,
  ContextOverflowError,
  createSession,
  deleteSession,
  exportSessionJsonl,
  getSessionInfo,
  getSessionMessages,
  getSessionStats,
  isSessionActive,
  isSessionBusy,
  listSessions,
  ModelValidationError,
  promptSession,
  resolveModelId,
  restoreSession,
  SessionBusyError,
  type AgentStreamEvent,
} from "./agent-manager.js";
import { DatabaseRegistry, TableSelectionError } from "./database-registry.js";
import { parseEvidenceId, readEvidenceRow } from "./evidence.js";
import { getModelCatalog } from "./model-config.js";
import { SandboxUnavailableError } from "./sandbox-tools.js";
import {
  createWorkspace,
  deleteWorkspace,
  ensureWorkspacesRoot,
  getWorkspace,
  writeSnapshotToWorkspace,
} from "./workspace-manager.js";

export interface PiAgentRoutesDependencies {
  fastify: FastifyInstance;
  registry: DatabaseRegistry;
}

function contextOverflowPayload(
  error: ContextOverflowError,
  snapshot?: { totalRows: number; totalBytes: number; tableNames: string[] },
) {
  return {
    success: false,
    error: "context_overflow",
    message: error.message,
    details: {
      phase: error.phase,
      estimatedTokens: error.estimatedTokens,
      contextWindow: error.contextWindow,
      reserveTokens: error.reserveTokens,
      effectiveWindow: error.effectiveWindow,
      ...(snapshot
        ? {
            tableNames: snapshot.tableNames,
            totalRows: snapshot.totalRows,
            totalBytes: snapshot.totalBytes,
          }
        : {}),
    },
  };
}

/**
 * Fastify keeps plugin headers on Reply until it serializes a payload. SSE is
 * hijacked, so copy those headers (including CORS) onto the raw response first.
 */
function beginEventStream(reply: FastifyReply): void {
  const fastifyHeaders = reply.getHeaders();
  reply.hijack();
  for (const [name, value] of Object.entries(fastifyHeaders)) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders();
}

function sendEvent(reply: FastifyReply, event: AgentStreamEvent): void {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerPiAgentRoutes({ fastify, registry }: PiAgentRoutesDependencies): void {
  ensureWorkspacesRoot();

  /**
   * Configured model catalog, so the UI does not hard-code model ids. Pointing
   * the deployment at another gateway is then configuration only.
   */
  fastify.get("/api/pi-agent/models", async () => {
    const { baseUrl, choices } = getModelCatalog();
    return { success: true, baseUrl, models: choices };
  });

  fastify.get("/api/pi-agent/databases", async () => ({
    success: true,
    databases: registry.list(),
  }));

  fastify.post("/api/pi-agent/databases/refresh", async () => {
    registry.refresh();
    return { success: true, databases: registry.list() };
  });

  fastify.get("/api/pi-agent/databases/:id/tables", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tables = registry.listTables(id);
    if (tables === null) {
      return reply.status(404).send({ success: false, error: "Database not found" });
    }
    return { success: true, tables };
  });

  fastify.post("/api/pi-agent/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as {
      databaseId?: unknown;
      tableNames?: unknown;
      prompt?: unknown;
      modelId?: unknown;
    };

    if (typeof body.databaseId !== "string" || !body.databaseId) {
      return reply.status(400).send({ success: false, error: "Missing databaseId" });
    }
    if (!Array.isArray(body.tableNames) || body.tableNames.length === 0) {
      return reply
        .status(400)
        .send({ success: false, error: "At least one table must be selected" });
    }
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      return reply.status(400).send({ success: false, error: "Prompt is required" });
    }
    if (body.modelId !== undefined && typeof body.modelId !== "string") {
      return reply.status(400).send({ success: false, error: "modelId must be a string" });
    }

    let modelId: string;
    try {
      modelId = resolveModelId(body.modelId);
    } catch (error) {
      if (error instanceof ModelValidationError) {
        return reply.status(400).send({
          success: false,
          error: "invalid_model",
          message: error.message,
          details: { modelId: error.modelId, available: error.available },
        });
      }
      throw error;
    }

    const tableNames = body.tableNames as unknown[];
    if (!tableNames.every((name): name is string => typeof name === "string")) {
      return reply.status(400).send({
        success: false,
        error: "invalid_table_selection",
        message: "Every table name must be a string",
      });
    }

    const database = registry.getEntry(body.databaseId);
    if (!database) {
      return reply.status(404).send({ success: false, error: "Database not found" });
    }

    let snapshots;
    try {
      snapshots = registry.snapshotTables(body.databaseId, tableNames);
    } catch (error) {
      if (error instanceof TableSelectionError) {
        return reply.status(400).send({
          success: false,
          error: "invalid_table_selection",
          message: error.message,
          details: { invalidTableNames: error.invalidTableNames },
        });
      }
      throw error;
    }
    if (!snapshots) {
      return reply.status(404).send({ success: false, error: "Database not found" });
    }

    const workspace = createWorkspace();
    try {
      const manifest = writeSnapshotToWorkspace(
        workspace,
        body.databaseId,
        database.name,
        snapshots,
        body.prompt,
      );
      const { sessionId, info } = await createSession({
        databaseId: body.databaseId,
        databaseName: database.name,
        tableNames,
        snapshots,
        prompt: body.prompt,
        modelId,
        workspace,
        manifest,
      });

      return {
        success: true,
        sessionId,
        session: info,
        snapshot: info.snapshot,
      };
    } catch (error) {
      deleteWorkspace(workspace.runId);
      if (error instanceof ContextOverflowError) {
        const estimate = registry.estimateSnapshotSize(snapshots);
        return reply.status(422).send(
          contextOverflowPayload(error, {
            ...estimate,
            tableNames,
          }),
        );
      }
      if (error instanceof ModelValidationError) {
        return reply.status(400).send({
          success: false,
          error: "invalid_model",
          message: error.message,
          details: { modelId: error.modelId, available: error.available },
        });
      }
      if (error instanceof SandboxUnavailableError) {
        return reply.status(503).send({
          success: false,
          error: "sandbox_unavailable",
          message: error.message,
        });
      }
      throw error;
    }
  });

  fastify.get("/api/pi-agent/sessions", async () => ({
    success: true,
    sessions: await listSessions(),
  }));

  fastify.get("/api/pi-agent/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const info = await getSessionInfo(id);
    if (!info) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    return {
      success: true,
      session: info,
      active: isSessionActive(id),
      running: isSessionBusy(id),
    };
  });

  fastify.post("/api/pi-agent/sessions/:id/prompt", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { message?: unknown };
    if (typeof body.message !== "string" || !body.message.trim()) {
      return reply.status(400).send({ success: false, error: "Message is required" });
    }

    const info = await getSessionInfo(id);
    if (!info) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }

    try {
      if (!(await restoreSession(id))) {
        return reply.status(410).send({
          success: false,
          error: "session_workspace_unavailable",
          message: "Session workspace or immutable snapshot is unavailable",
        });
      }
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        return reply.status(503).send({
          success: false,
          error: "sandbox_unavailable",
          message: error.message,
        });
      }
      throw error;
    }

    if (isSessionBusy(id)) {
      return reply.status(409).send({
        success: false,
        error: "session_busy",
        message: `Session ${id} is already running`,
      });
    }

    beginEventStream(reply);
    let streamCompleted = false;
    const handleDisconnect = () => {
      if (!streamCompleted) {
        void abortSession(id).catch((error) => {
          fastify.log.warn({ error, sessionId: id }, "Failed to abort disconnected PI session");
        });
      }
    };
    reply.raw.once("close", handleDisconnect);

    try {
      const result = await promptSession(id, body.message, (event) => sendEvent(reply, event));
      if (result.status === "completed") {
        sendEvent(reply, { type: "done" });
      } else if (result.status === "aborted") {
        sendEvent(reply, { type: "aborted", data: { message: result.message || "Agent aborted" } });
      } else {
        sendEvent(reply, { type: "error", data: { message: result.message || "Agent failed" } });
      }
    } catch (error) {
      if (error instanceof ContextOverflowError) {
        sendEvent(reply, { type: "error", data: contextOverflowPayload(error) });
      } else if (error instanceof SessionBusyError) {
        sendEvent(reply, {
          type: "error",
          data: { error: "session_busy", message: error.message },
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        sendEvent(reply, { type: "error", data: { error: "agent_error", message } });
      }
    } finally {
      streamCompleted = true;
      reply.raw.off("close", handleDisconnect);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  fastify.post("/api/pi-agent/sessions/:id/abort", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await getSessionInfo(id))) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    if (!(await abortSession(id))) {
      return reply.status(409).send({ success: false, error: "Session is not running" });
    }
    return { success: true };
  });

  fastify.delete("/api/pi-agent/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await deleteSession(id))) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    return { success: true };
  });

  fastify.get("/api/pi-agent/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await getSessionInfo(id))) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    try {
      if (!(await restoreSession(id))) {
        return reply.status(410).send({
          success: false,
          error: "session_workspace_unavailable",
          message: "Session workspace or immutable snapshot is unavailable",
        });
      }
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        return reply.status(503).send({
          success: false,
          error: "sandbox_unavailable",
          message: error.message,
        });
      }
      throw error;
    }

    const messages = await getSessionMessages(id);
    return { success: true, messages: messages ?? [] };
  });

  fastify.get("/api/pi-agent/sessions/:id/stats", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stats = await getSessionStats(id);
    if (!stats) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    return { success: true, stats };
  });

  fastify.get("/api/pi-agent/sessions/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await getSessionInfo(id))) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    try {
      const exported = await exportSessionJsonl(id);
      reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${exported.fileName}"`);
      return reply.send(fs.createReadStream(exported.filePath));
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return reply.status(409).send({
          success: false,
          error: "session_busy",
          message: error.message,
        });
      }
      if (error instanceof Error && error.message === "Session workspace not found") {
        return reply.status(410).send({
          success: false,
          error: "session_workspace_unavailable",
          message: error.message,
        });
      }
      throw error;
    }
  });

  fastify.get("/api/pi-agent/sessions/:id/evidence/:evidenceId", async (request, reply) => {
    const { id, evidenceId } = request.params as { id: string; evidenceId: string };
    const info = await getSessionInfo(id);
    if (!info) {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }

    const parsed = parseEvidenceId(evidenceId);
    if (!parsed) {
      return reply.status(400).send({ success: false, error: "Invalid evidence ID format" });
    }
    const workspace = getWorkspace(info.runId);
    if (!workspace) {
      return reply.status(410).send({ success: false, error: "Session workspace not found" });
    }
    const evidence = readEvidenceRow(workspace, parsed.tableName, parsed.rowIndex);
    if (!evidence) {
      return reply.status(404).send({ success: false, error: "Evidence not found" });
    }
    return { success: true, evidence };
  });
}
