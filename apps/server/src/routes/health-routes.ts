import type { FastifyInstance } from "fastify";

interface HealthRoutesDependencies {
  fastify: FastifyInstance;
}

export function registerHealthRoutes({ fastify }: HealthRoutesDependencies): void {
  fastify.get("/health", async () => {
    return { status: "OK", timestamp: new Date().toISOString() };
  });
}
