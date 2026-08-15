import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getSanitizedFilename } from "../scripts/script-files.js";

interface TraceRoutesDependencies {
  fastify: FastifyInstance;
  tracesDir: string;
}

export function registerTraceRoutes({
  fastify,
  tracesDir: TRACES_DIR,
}: TraceRoutesDependencies): void {
  // List all execution trace runs (Filtered by optional filename, url, or domain)
  fastify.get("/api/traces", async (request) => {
    const { filename, url, domain } =
      (request.query as { filename?: string; url?: string; domain?: string }) || {};

    if (!fs.existsSync(TRACES_DIR)) {
      return { traces: [], total: 0 };
    }

    const safeName = filename ? getSanitizedFilename(filename) : null;
    let targetDomain = domain || "";
    if (!targetDomain && url) {
      try {
        targetDomain = new URL(url).hostname;
      } catch {
        targetDomain = url;
      }
    }

    const runDirs = fs
      .readdirSync(TRACES_DIR)
      .filter((d) => d.startsWith("run_") && fs.statSync(path.join(TRACES_DIR, d)).isDirectory());

    const traces = runDirs
      .map((runId) => {
        try {
          const traceJsonPath = path.join(TRACES_DIR, runId, "trace.json");
          if (!fs.existsSync(traceJsonPath)) return null;
          const meta = JSON.parse(fs.readFileSync(traceJsonPath, "utf-8"));

          // 1. Filter by filename if provided
          if (safeName) {
            if (!meta.filename || meta.filename !== safeName) {
              return null;
            }
          }

          // 2. Filter by URL or domain if provided (with legacy fallback)
          if (url || targetDomain) {
            let matches = false;
            if (meta.targetUrl) {
              matches =
                meta.targetUrl === url ||
                (targetDomain ? meta.targetUrl.includes(targetDomain) : false);
            } else {
              // Legacy fallback: check if filename matches safeName OR any frame message contains targetDomain
              if (safeName && meta.filename === safeName) {
                matches = true;
              } else if (targetDomain && Array.isArray(meta.frames)) {
                matches = meta.frames.some(
                  (f: any) => f.message && f.message.includes(targetDomain),
                );
              }
            }
            if (!matches) {
              return null;
            }
          }

          // Format logs: fallback to extracting log entries from frames if meta.logs is empty
          let logsList = meta.logs || [];
          if ((!logsList || logsList.length === 0) && Array.isArray(meta.frames)) {
            logsList = meta.frames.map((f: any) => ({
              time: f.time || "00:00:00",
              message: f.message || "",
              type: "log",
            }));
          }

          return {
            runId: meta.runId || runId,
            filename: meta.filename || "unknown",
            targetUrl: meta.targetUrl || "",
            timestamp: meta.timestamp || "未知时间",
            totalFrames: meta.totalFrames || (meta.frames ? meta.frames.length : 0),
            totalLogs: logsList.length,
            logs: logsList,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = Number(a!.runId.replace("run_", "")) || 0;
        const timeB = Number(b!.runId.replace("run_", "")) || 0;
        return timeB - timeA;
      });

    return { traces, total: traces.length };
  });

  // Get trace frames for a specific runId
  fastify.get("/api/traces/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const traceJsonPath = path.join(TRACES_DIR, runId, "trace.json");

    if (!fs.existsSync(traceJsonPath)) {
      return reply.status(404).send({ error: `Trace for runId '${runId}' not found.` });
    }

    try {
      const traceData = JSON.parse(fs.readFileSync(traceJsonPath, "utf-8"));
      return { success: true, ...traceData };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to read trace: ${err.message}` });
    }
  });

  // Delete a specific trace run folder
  fastify.post("/api/traces/delete", async (request, reply) => {
    const { runId } = (request.body as { runId?: string }) || {};
    if (!runId) {
      return reply.status(400).send({ error: "Missing 'runId' parameter." });
    }

    const safeRunId = path.basename(runId);
    const targetDir = path.join(TRACES_DIR, safeRunId);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return { success: true, runId: safeRunId, message: `Trace '${safeRunId}' deleted.` };
    }
    return reply.status(404).send({ error: `Trace '${safeRunId}' not found.` });
  });

  // Batch delete trace run folders
  fastify.post("/api/traces/batch-delete", async (request, reply) => {
    const { runIds } = (request.body as { runIds?: string[] }) || {};
    if (!Array.isArray(runIds) || runIds.length === 0) {
      return reply.status(400).send({ error: "Missing 'runIds' parameter." });
    }

    let count = 0;
    for (const id of runIds) {
      const safeRunId = path.basename(id);
      const targetDir = path.join(TRACES_DIR, safeRunId);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        count++;
      }
    }
    return { success: true, count, message: `成功删除了 ${count} 个 Trace 运行轨迹。` };
  });

  fastify.get("/api/traces/:runId/frame/:imageName", async (request, reply) => {
    const { runId, imageName } = request.params as { runId: string; imageName: string };
    const imagePath = path.join(TRACES_DIR, runId, path.basename(imageName));

    if (!fs.existsSync(imagePath)) {
      return reply.status(404).send({ error: "Image frame not found." });
    }

    const imageStream = fs.createReadStream(imagePath);
    return reply.type("image/jpeg").send(imageStream);
  });
}
