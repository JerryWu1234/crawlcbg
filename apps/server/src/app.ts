import { HISTORY_DIR, SCRIPTS_DIR, TRACES_DIR } from "./config/runtime-paths.js";
import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { db } from "./db.js";
import { createGetUserVisiblePages } from "./browser/page-visibility.js";
import { ensureStagehand } from "./browser/stagehand-manager.js";
import { ExecutionCoordinator } from "./execution/execution-coordinator.js";
import { createScheduledExecutor } from "./execution/scheduled-executor.js";
import { TabScheduler } from "./scheduler.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerScheduleRoutes } from "./routes/schedule-routes.js";
import { registerTabRoutes } from "./routes/tab-routes.js";
import { registerDatabaseRoutes } from "./routes/database-routes.js";
import { registerTraceRoutes } from "./routes/trace-routes.js";
import { registerScriptManagementRoutes } from "./routes/script-management-routes.js";
import { registerExecutionRoutes } from "./routes/execution-routes.js";

export async function startApp(): Promise<void> {
  const executionCoordinator = new ExecutionCoordinator();
  const getUserVisiblePages = createGetUserVisiblePages(executionCoordinator);

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
  const internalExecutionToken = crypto.randomBytes(32).toString("hex");
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, {
    origin: [trustedBrowserOrigin],
  });

  const executeScheduledRequest = createScheduledExecutor({
    executionCoordinator,
    getUserVisiblePages,
    ensureStagehand,
    port,
    internalExecutionToken,
    fetch,
  });
  const scheduler = new TabScheduler(db, executeScheduledRequest, {
    info: (message) => fastify.log.info(message),
    warn: (message) => fastify.log.warn(message),
    error: (message) => fastify.log.error(message),
  });
  scheduler.initializeSchema();
  fastify.addHook("onClose", async () => scheduler.stop());

  // 2. Routes
  registerHealthRoutes({ fastify });
  registerScheduleRoutes({ fastify, scheduler });
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
    internalExecutionToken,
    executionCoordinator,
    getUserVisiblePages,
  });

  // 4. Start server
  try {
    await fastify.listen({ port, host });
    scheduler.start();
    console.log(`\n🚀 Server is running at http://localhost:${port}`);
    console.log(`   GET /health          — Health check`);
    console.log(`   GET /api/tabs        — List all browser tabs`);
    console.log(`   GET /api/scripts     — Script manager & execution engine`);
    console.log(`   GET /api/db/tables   — SQLite tables list`);
    console.log(`   GET /api/db/data     — SQLite table data viewer\n`);

    void ensureStagehand().catch((err) => {
      console.warn(
        `[Stagehand] Background connection is not ready yet: ${err.message || String(err)}`,
      );
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}
