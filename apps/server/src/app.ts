import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import { createGetUserVisiblePages } from "./browser/page-visibility.js";
import { ensureStagehand } from "./browser/stagehand-manager.js";
import { HISTORY_DIR, SCRIPTS_DIR, TRACES_DIR } from "./config/runtime-paths.js";
import { db } from "./db.js";
import { ExecutionCoordinator } from "./execution/execution-coordinator.js";
import { RecordingCoordinator } from "./recording/recording-coordinator.js";
import { registerDatabaseRoutes } from "./routes/database-routes.js";
import { registerExecutionRoutes } from "./routes/execution-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerRecordingRoutes } from "./routes/recording-routes.js";
import { registerScriptManagementRoutes } from "./routes/script-management-routes.js";
import { registerTabRoutes } from "./routes/tab-routes.js";
import { registerTraceRoutes } from "./routes/trace-routes.js";

export async function startApp(): Promise<FastifyInstance> {
  const executionCoordinator = new ExecutionCoordinator();
  const getUserVisiblePages = createGetUserVisiblePages(executionCoordinator);
  const recordingCoordinator = new RecordingCoordinator({
    executionCoordinator,
    getUserVisiblePages,
  });

  // 1. Initialize Stagehand (connect to browser)
  try {
    await ensureStagehand();
  } catch {
    console.warn(
      "[Stagehand] Initial connection failed. Will retry automatically on incoming requests.",
    );
  }

  // 2. Create Fastify instance
  const port = Number(process.env.PORT) || 3001;
  const host = "127.0.0.1";
  const trustedBrowserOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, {
    origin: [trustedBrowserOrigin],
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  // 3. Routes
  registerHealthRoutes({ fastify });
  registerTabRoutes({ fastify, getUserVisiblePages });
  registerDatabaseRoutes({ fastify, db });
  registerTraceRoutes({ fastify, tracesDir: TRACES_DIR });
  registerScriptManagementRoutes({
    fastify,
    scriptsDir: SCRIPTS_DIR,
    historyDir: HISTORY_DIR,
  });
  registerExecutionRoutes({
    fastify,
    trustedBrowserOrigin,
    executionCoordinator,
    getUserVisiblePages,
  });
  registerRecordingRoutes({
    fastify,
    trustedBrowserOrigin,
    recordingCoordinator,
  });
  fastify.addHook("onClose", async () => {
    await recordingCoordinator.shutdown();
  });

  // 4. Start server
  try {
    await fastify.listen({ port, host });
    console.log(`\n🚀 Server is running at http://localhost:${port}`);
    console.log(`   GET /health          — Health check`);
    console.log(`   GET /api/tabs        — List all browser tabs`);
    console.log(`   GET /api/scripts     — Script manager & execution engine`);
    console.log(`   GET /api/db/tables   — SQLite tables list`);
    console.log(`   GET /api/db/data     — SQLite table data viewer\n`);

    void ensureStagehand().catch((error) => {
      console.warn(
        `[Stagehand] Background connection is not ready yet: ${error.message || String(error)}`,
      );
    });
  } catch (error) {
    fastify.log.error(error);
    await fastify.close();
    throw error;
  }

  return fastify;
}
