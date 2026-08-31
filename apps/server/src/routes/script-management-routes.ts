import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getOpenAIClient, getUtilityModel } from "../browser/stagehand-manager.js";
import { safeTranspile, ts } from "../scripts/script-compiler.js";
import { getSanitizedFilename, saveHistorySnapshot } from "../scripts/script-files.js";

interface ScriptManagementRoutesDependencies {
  fastify: FastifyInstance;
  scriptsDir: string;
  historyDir: string;
}

const HISTORY_ID_PATTERN = /^\d{1,20}$/;

const isHistoryId = (value: unknown): value is string =>
  typeof value === "string" && HISTORY_ID_PATTERN.test(value);

export function registerScriptManagementRoutes({
  fastify,
  scriptsDir: SCRIPTS_DIR,
  historyDir: HISTORY_DIR,
}: ScriptManagementRoutesDependencies): void {
  fastify.get("/api/scripts", async () => {
    const files = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((f) => (f.endsWith(".mjs") || f.endsWith(".js")) && !f.startsWith("."));
    const scripts = files.map((filename) => {
      const filePath = path.join(SCRIPTS_DIR, filename);
      const content = fs.readFileSync(filePath, "utf-8");
      return { filename, content };
    });
    return { scripts, total: scripts.length };
  });

  fastify.post("/api/scripts/save", async (request, reply) => {
    const { filename, content, label } =
      (request.body as { filename?: string; content?: string; label?: string }) || {};
    if (!filename || typeof content !== "string") {
      return reply.status(400).send({ error: "Missing 'filename' or 'content'." });
    }

    const safeName = getSanitizedFilename(filename);
    const targetPath = path.join(SCRIPTS_DIR, safeName);
    fs.writeFileSync(targetPath, content, "utf-8");

    // Save history snapshot (with MD5 deduplication)
    saveHistorySnapshot(safeName, content, label || "手动保存");

    return { success: true, filename: safeName, message: `Script '${safeName}' saved.` };
  });

  fastify.post("/api/scripts/delete", async (request, reply) => {
    const { filename } = (request.body as { filename?: string }) || {};
    if (!filename) {
      return reply.status(400).send({ error: "Missing 'filename'." });
    }

    const safeName = getSanitizedFilename(filename);
    const targetPath = path.join(SCRIPTS_DIR, safeName);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      return { success: true, filename: safeName, message: `Script '${safeName}' deleted.` };
    }
    return reply.status(404).send({ error: `Script '${safeName}' not found.` });
  });

  fastify.post("/api/scripts/validate", async (request, reply) => {
    const { content } = (request.body as { content?: string }) || {};
    if (typeof content !== "string") {
      return reply.status(400).send({ error: "Missing 'content' field." });
    }

    const result = safeTranspile(content);

    const diagnostics = result.diagnostics || [];
    const syntaxErrors = diagnostics
      .filter((d: any) => d.category === ts.DiagnosticCategory?.Error || d.category === 1)
      .map((d: any) => {
        let line = 1;
        let character = 1;
        if (d.file && d.start !== undefined) {
          const pos = d.file.getLineAndCharacterOfPosition(d.start);
          line = pos.line + 1;
          character = pos.character + 1;
        }
        const message = ts.flattenDiagnosticMessageText
          ? ts.flattenDiagnosticMessageText(d.messageText, "\n")
          : typeof d.messageText === "string"
            ? d.messageText
            : JSON.stringify(d.messageText);
        return { line, character, message };
      });

    if (syntaxErrors.length > 0) {
      return { valid: false, errors: syntaxErrors };
    }

    return { valid: true, message: "✅ JS/MJS 语法测试通过！代码格式与 JavaScript 语法完全正确。" };
  });

  fastify.post("/api/scripts/generate-ai", async (request, reply) => {
    const { prompt, currentCode, tabTitle, tabUrl } =
      (request.body as {
        prompt?: string;
        currentCode?: string;
        tabTitle?: string;
        tabUrl?: string;
      }) || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return reply.status(400).send({ error: "请提供想要 AI 生成或修改的需求描述。" });
    }

    try {
      const openai = getOpenAIClient();

      const systemPrompt = `You are an expert Stagehand & Playwright JavaScript automation script generator.
Your job is to generate or refactor browser automation scripts in pure JavaScript ES Module (.mjs) format.

STRICT JSON OUTPUT REQUIREMENT:
You MUST output ONLY a valid JSON object matching this schema:
{
  "code": "export default async function run({ page, stagehand, log, db, params, pace }) { ... }"
}

CRITICAL ARCHITECTURE RULES FOR THE CODE INSIDE "code":
1. ALWAYS start with: export default async function run({ page, stagehand, log, db, params, pace }) { ... }
2. YOU HAVE NATIVE ACCESS TO THE "db" SQLITE HELPER OBJECT for persistent data storage & automatic deduplication:
   - db.exec(sql): Execute DDL queries (e.g. \`db.exec("CREATE TABLE IF NOT EXISTS items (eid TEXT PRIMARY KEY, name TEXT, price TEXT, url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)")\`). ALWAYS call db.exec() at the start of scripts when storing data!
   - db.exists(tableName, whereObject): Check if a record already exists before saving (e.g. \`if (db.exists("items", { eid })) { log("Skipping existing item..."); }\`).
   - db.upsert(tableName, dataObject): Insert or update a record by primary key, automatically avoiding duplicates! (e.g. \`db.upsert("items", { eid, name, price, url })\`).
   - db.all(sql, params): Fetch array of all matching rows (e.g. \`const list = db.all("SELECT * FROM items")\`).
   - db.get(sql, params): Fetch single row.
   - db.insert(tableName, dataObject): Insert single row.
3. Use PURE JavaScript (ES Module)! NEVER use TypeScript annotations like "catch (e: any)" or "interface". Always use "catch (error)".
4. ALL user-like interactions MUST use the fixed pace helper: await pace.click(selectorOrLocator), await pace.type(selectorOrLocator, text), await pace.scroll(), and await pace.wait(). Use page.evaluate() only for non-interactive DOM reads/extraction; NEVER trigger click, input, typing, or scrolling inside page.evaluate(). The pace timings are system-controlled and MUST NOT be overridden or exposed as script parameters.
5. ALWAYS call log("...") for every major action step so the user receives real-time execution feedback.
6. DO NOT include markdown code fences (like \`\`\`javascript), conversational commentary, or explanation text. Return ONLY the raw JSON object.`;

      const userContextMessage = `USER REQUEST:
"${prompt.trim()}"

TARGET CHROME TAB CONTEXT:
- Title: "${tabTitle || "Unknown Title"}"
- URL: "${tabUrl || "Unknown URL"}"

EXISTING CODE IN EDITOR (IF ANY):
${currentCode && currentCode.trim() ? currentCode.trim() : "(No existing code, generate from scratch)"}`;

      const completion = await openai.chat.completions.create({
        model: getUtilityModel(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContextMessage },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const rawResponse = completion.choices[0]?.message?.content || "";
      let generatedCode = "";

      try {
        const parsedJson = JSON.parse(rawResponse);
        generatedCode = parsedJson.code || parsedJson.script || parsedJson.javascript || "";
      } catch {
        const match = rawResponse.match(/"code"\s*:\s*"([\s\S]*)"/);
        if (match) {
          generatedCode = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
        } else {
          generatedCode = rawResponse
            .replace(/^```(json|javascript|js|mjs)?/i, "")
            .replace(/```$/i, "")
            .trim();
        }
      }

      if (generatedCode.includes("```")) {
        const codeMatch = generatedCode.match(/```(?:javascript|js|mjs)?\s*([\s\S]*?)```/i);
        if (codeMatch) {
          generatedCode = codeMatch[1].trim();
        }
      }

      if (!generatedCode || !generatedCode.includes("export default")) {
        return reply.status(500).send({ error: "AI 未能生成合格的 JS 代码，请重新重试。" });
      }

      return {
        success: true,
        code: generatedCode,
        message: "✨ AI 纯代码生成成功！",
      };
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(500).send({
        error: `AI 生成失败: ${error.message || String(error)}`,
      });
    }
  });

  fastify.get("/api/scripts/history", async (request, reply) => {
    const { filename } = (request.query as { filename?: string }) || {};
    if (!filename) {
      return reply.status(400).send({ error: "Missing 'filename'." });
    }

    const safeName = getSanitizedFilename(filename);
    const fileHistoryDir = path.join(HISTORY_DIR, safeName);

    if (!fs.existsSync(fileHistoryDir)) {
      return { history: [], total: 0 };
    }

    const metaFiles = fs.readdirSync(fileHistoryDir).filter((f) => f.endsWith(".json"));

    const history = metaFiles
      .map((metaFile) => {
        try {
          const metaPath = path.join(fileHistoryDir, metaFile);
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          // Filter out legacy "执行运行" snapshots so Code Version History contains 0% execution run items!
          if (meta.label && meta.label.includes("执行运行")) {
            return null;
          }
          const snapshotPath = path.join(fileHistoryDir, `${meta.id}.mjs`);
          const content = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf-8") : "";
          return {
            id: meta.id,
            timestamp: meta.timestamp,
            label: meta.label || "版本修改",
            runId: meta.runId || null,
            content,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(b!.id) - Number(a!.id));

    return { history, total: history.length };
  });

  fastify.post("/api/scripts/history/restore", async (request, reply) => {
    const { filename, historyId } =
      (request.body as { filename?: string; historyId?: string }) || {};
    if (!filename || !historyId) {
      return reply.status(400).send({ error: "Missing 'filename' or 'historyId'." });
    }
    if (!isHistoryId(historyId)) {
      return reply.status(400).send({ error: "Invalid 'historyId' parameter." });
    }

    const safeName = getSanitizedFilename(filename);
    const snapshotPath = path.join(HISTORY_DIR, safeName, `${historyId}.mjs`);
    const targetPath = path.join(SCRIPTS_DIR, safeName);

    if (!fs.existsSync(snapshotPath)) {
      return reply.status(404).send({ error: "指定的历史版本未找到。" });
    }

    const restoredContent = fs.readFileSync(snapshotPath, "utf-8");
    fs.writeFileSync(targetPath, restoredContent, "utf-8");

    saveHistorySnapshot(safeName, restoredContent, `恢复至版本 #${historyId.slice(-4)}`);

    return {
      success: true,
      content: restoredContent,
      message: `已成功恢复到历史版本 #${historyId.slice(-4)}！`,
    };
  });

  fastify.post("/api/scripts/history/delete", async (request, reply) => {
    const { filename, historyId } =
      (request.body as { filename?: string; historyId?: string }) || {};
    if (!filename || !historyId) {
      return reply.status(400).send({ error: "Missing 'filename' or 'historyId'." });
    }
    if (!isHistoryId(historyId)) {
      return reply.status(400).send({ error: "Invalid 'historyId' parameter." });
    }

    const safeName = getSanitizedFilename(filename);
    const snapshotPath = path.join(HISTORY_DIR, safeName, `${historyId}.mjs`);
    const metaPath = path.join(HISTORY_DIR, safeName, `${historyId}.json`);

    let deleted = false;
    if (fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
      deleted = true;
    }
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
      deleted = true;
    }

    if (deleted) {
      return { success: true, message: `历史版本 #${historyId.slice(-4)} 已彻底删除。` };
    }
    return reply.status(404).send({ error: "未找到该历史版本快照。" });
  });

  fastify.post("/api/scripts/history/batch-delete", async (request, reply) => {
    const { filename, historyIds } =
      (request.body as { filename?: string; historyIds?: string[] }) || {};
    if (!filename || !Array.isArray(historyIds) || historyIds.length === 0) {
      return reply.status(400).send({ error: "Missing 'filename' or 'historyIds'." });
    }
    if (!historyIds.every(isHistoryId)) {
      return reply.status(400).send({ error: "Invalid 'historyIds' parameter." });
    }

    const safeName = getSanitizedFilename(filename);
    let count = 0;
    for (const id of historyIds) {
      const snapshotPath = path.join(HISTORY_DIR, safeName, `${id}.mjs`);
      const metaPath = path.join(HISTORY_DIR, safeName, `${id}.json`);
      if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      count++;
    }
    return { success: true, message: `成功删除了 ${count} 个代码版本快照。` };
  });
}
