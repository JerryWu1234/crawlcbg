import { startApp } from "./app.js";

async function main(): Promise<void> {
  const fastify = await startApp();
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info({ signal }, "Shutting down server");
    try {
      await fastify.close();
    } catch (error) {
      fastify.log.error(error, "Failed to close server cleanly");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
