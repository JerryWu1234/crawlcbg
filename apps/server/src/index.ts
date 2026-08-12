import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Stagehand, CustomOpenAIClient } from "@browserbasehq/stagehand";
import OpenAI from "openai";
import * as tsModule from "typescript";
import { db } from "./db.js";

const ts: any = (tsModule as any).default || tsModule;

// Load .env from root directory or current directory
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

// ── Scripts, History & Traces Directory Paths ──────────────────────────────
const SCRIPTS_DIR = path.resolve(process.cwd(), "scripts");
const HISTORY_DIR = path.resolve(SCRIPTS_DIR, ".history");
const TRACES_DIR = path.resolve(process.cwd(), "traces");

if (!fs.existsSync(SCRIPTS_DIR)) {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}
if (!fs.existsSync(TRACES_DIR)) {
  fs.mkdirSync(TRACES_DIR, { recursive: true });
}

const LOCAL_DIR = path.resolve(SCRIPTS_DIR, ".local");
if (!fs.existsSync(LOCAL_DIR)) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

class ScriptExecutionCancelledError extends Error {
  constructor() {
    super("Script execution was cancelled");
    this.name = "ScriptExecutionCancelledError";
  }
}

const activeScriptExecutions = new Map<string, AbortController>();

function throwIfExecutionCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new ScriptExecutionCancelledError();
  }
}

function isExecutionCancelledError(error: unknown): boolean {
  return error instanceof ScriptExecutionCancelledError;
}

function raceWithExecutionCancellation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfExecutionCancelled(signal);

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(new ScriptExecutionCancelledError());
    signal.addEventListener("abort", handleAbort, { once: true });

    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wrap Playwright/Stagehand objects so in-flight waits reject as soon as a run is cancelled.
 * Nested locators and element handles are wrapped as well.
 */
function createAbortableAutomationProxy<T extends object>(target: T, signal: AbortSignal): T {
  const proxyCache = new WeakMap<object, object>();

  const wrapValue = (value: any): any => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => wrapValue(item));
    }
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      return value;
    }

    const cached = proxyCache.get(value);
    if (cached) return cached;

    const proxy = new Proxy(value, {
      get(currentTarget, property) {
        throwIfExecutionCancelled(signal);
        const member = Reflect.get(currentTarget, property, currentTarget);
        if (typeof member !== "function") return wrapValue(member);

        return (...args: any[]) => {
          throwIfExecutionCancelled(signal);
          const result: any = Reflect.apply(member, currentTarget, args);
          if (result && typeof result.then === "function") {
            return raceWithExecutionCancellation(result, signal).then((resolved) =>
              wrapValue(resolved),
            );
          }
          return wrapValue(result);
        };
      },
    });

    proxyCache.set(value, proxy);
    return proxy;
  };

  return wrapValue(target) as T;
}

// JSON file path for pinned resident tabs (gitignored local storage inside scripts/.local/)
const PINNED_TABS_FILE = path.resolve(LOCAL_DIR, "pinned_tabs.json");

function loadPinnedTabsJSON(): Array<{
  id: string;
  title: string;
  url: string;
  scriptFilename?: string;
  created_at?: string;
}> {
  try {
    if (fs.existsSync(PINNED_TABS_FILE)) {
      const data = fs.readFileSync(PINNED_TABS_FILE, "utf-8");
      return JSON.parse(data) || [];
    }
  } catch (err) {
    console.error("Read pinned_tabs.json error:", err);
  }
  return [];
}

function savePinnedTabsJSON(tabs: any[]) {
  try {
    fs.writeFileSync(PINNED_TABS_FILE, JSON.stringify(tabs, null, 2), "utf-8");
  } catch (err) {
    console.error("Save pinned_tabs.json error:", err);
  }
}

// Helper to sanitize filename to .mjs
function getSanitizedFilename(name: string): string {
  const baseName = path.basename(name);
  if (!baseName.endsWith(".mjs") && !baseName.endsWith(".js")) {
    return `${baseName}.mjs`;
  }
  return baseName;
}

// Helper to save version history snapshot with MD5 content hash deduplication
function saveHistorySnapshot(filename: string, content: string, label: string, runId?: string) {
  try {
    const safeName = getSanitizedFilename(filename);
    const fileHistoryDir = path.join(HISTORY_DIR, safeName);
    if (!fs.existsSync(fileHistoryDir)) {
      fs.mkdirSync(fileHistoryDir, { recursive: true });
    }

    // 1. Content MD5 Hash Deduplication Check
    const newHash = crypto.createHash("md5").update(content).digest("hex");
    const existingMetaFiles = fs
      .readdirSync(fileHistoryDir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => Number(b.replace(".json", "")) - Number(a.replace(".json", "")));

    if (existingMetaFiles.length > 0) {
      const latestMetaFile = existingMetaFiles[0];
      const latestSnapshotFile = path.join(fileHistoryDir, latestMetaFile.replace(".json", ".mjs"));
      if (fs.existsSync(latestSnapshotFile)) {
        const latestContent = fs.readFileSync(latestSnapshotFile, "utf-8");
        const latestHash = crypto.createHash("md5").update(latestContent).digest("hex");
        if (newHash === latestHash) {
          // Content is 100% identical to the latest snapshot, skip creating duplicate snapshot!
          return;
        }
      }
    }

    // 2. Save new version snapshot
    const timestamp = Date.now();
    const formattedTime = new Date().toLocaleString("zh-CN");
    const snapshotFile = path.join(fileHistoryDir, `${timestamp}.mjs`);
    const metaFile = path.join(fileHistoryDir, `${timestamp}.json`);

    fs.writeFileSync(snapshotFile, content, "utf-8");
    fs.writeFileSync(
      metaFile,
      JSON.stringify(
        {
          id: String(timestamp),
          filename: safeName,
          label,
          timestamp: formattedTime,
          runId: runId || null,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    console.error("Save history snapshot error:", err);
  }
}

// ── Stagehand singleton ──────────────────────────────────────────────
const DEFAULT_CDP_URL = "ws://127.0.0.1:9222/devtools/browser/";

let stagehand: Stagehand | null = null;
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1";

  if (!apiKey || apiKey === "YOUR_DEEPSEEK_API_KEY_HERE") {
    throw new Error(
      "Please configure your DEEPSEEK_API_KEY in the `.env` file at the root of the project.",
    );
  }
  openaiClient = new OpenAI({ apiKey, baseURL });
  return openaiClient;
}

async function initStagehand(): Promise<Stagehand> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const configuredCdpUrl = process.env.CDP_URL?.trim();
  const cdpUrl = configuredCdpUrl || DEFAULT_CDP_URL;

  if (!apiKey || apiKey === "YOUR_DEEPSEEK_API_KEY_HERE") {
    throw new Error(
      "Please configure your DEEPSEEK_API_KEY in the `.env` file at the root of the project.",
    );
  }

  const customLlmClient = new CustomOpenAIClient({
    modelName: "deepseek-chat",
    client: getOpenAIClient(),
  });

  const sh = new Stagehand({
    env: "LOCAL",
    llmClient: customLlmClient,
    verbose: 1,
    localBrowserLaunchOptions: {
      headless: false,
      cdpUrl,
    },
  });

  console.log(
    configuredCdpUrl
      ? `Connecting Stagehand to browser at ${cdpUrl}...`
      : `CDP_URL is not configured; connecting Stagehand to default browser at ${cdpUrl}...`,
  );

  await sh.init();
  console.log("Stagehand connected to browser successfully.");
  return sh;
}

let stagehandConnectionPromise: Promise<Stagehand> | null = null;

function waitForStagehandConnection(
  connectionPromise: Promise<Stagehand>,
  timeoutMs = 12_000,
): Promise<Stagehand> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Stagehand connection timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    connectionPromise.then(
      (connectedStagehand) => {
        clearTimeout(timeout);
        resolve(connectedStagehand);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function ensureStagehand(): Promise<Stagehand> {
  if (stagehand) {
    try {
      if (stagehand.context && typeof stagehand.context.pages === "function") {
        stagehand.context.pages();
        return stagehand;
      }
    } catch (e) {
      console.warn(
        "[Stagehand] Connection lost or context invalidated, attempting reconnect...",
        e,
      );
      stagehand = null;
    }
  }

  if (!stagehandConnectionPromise) {
    console.log("[Stagehand] Connecting/reconnecting to Chrome browser...");
    stagehandConnectionPromise = initStagehand()
      .then((connectedStagehand) => {
        stagehand = connectedStagehand;
        return connectedStagehand;
      })
      .catch((err) => {
        console.error("[Stagehand] Connection failed:", err);
        throw err;
      })
      .finally(() => {
        stagehandConnectionPromise = null;
      });
  }

  return waitForStagehandConnection(stagehandConnectionPromise);
}

// Safe helper for JavaScript / MJS syntax validation
function safeTranspile(sourceCode: string) {
  const tsAny: any = tsModule;
  const ModuleKind_ESNext = ts.ModuleKind?.ESNext ?? tsAny.ModuleKind?.ESNext ?? 99;
  const ScriptTarget_ES2022 = ts.ScriptTarget?.ES2022 ?? tsAny.ScriptTarget?.ES2022 ?? 9;
  const JsxEmit_None = ts.JsxEmit?.None ?? tsAny.JsxEmit?.None ?? 0;

  const transpileFn = ts.transpileModule || tsAny.transpileModule || tsAny.default?.transpileModule;

  if (typeof transpileFn === "function") {
    return transpileFn(sourceCode, {
      compilerOptions: {
        module: ModuleKind_ESNext,
        target: ScriptTarget_ES2022,
        jsx: JsxEmit_None,
        noEmitOnError: false,
      },
      reportDiagnostics: true,
    });
  }

  return { outputText: sourceCode, diagnostics: [] };
}

// ── Fastify server ───────────────────────────────────────────────────
async function main() {
  // 1. Initialize Stagehand (connect to browser)
  try {
    stagehand = await ensureStagehand();
  } catch {
    console.warn(
      "[Stagehand] Initial connection failed. Will retry automatically on incoming requests.",
    );
  }

  // 2. Create Fastify instance
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, { origin: true });

  // 2. Routes

  // Health check
  fastify.get("/health", async () => {
    return { status: "OK", timestamp: new Date().toISOString() };
  });

  // Get all browser tabs
  fastify.get("/api/tabs", async (_request, reply) => {
    let sh: Stagehand;
    try {
      sh = await ensureStagehand();
    } catch {
      return reply.status(503).send({ error: "Stagehand is not connected to a browser." });
    }

    try {
      const pages = sh.context.pages();
      const tabs = await Promise.all(
        pages.map(async (page, index) => {
          const url = page.url();
          let domain = "";
          try {
            domain = new URL(url).hostname;
          } catch {
            // URL may be invalid
          }

          return {
            index,
            title: await page.title(),
            url,
            favicon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : "",
          };
        }),
      );

      return { tabs, total: tabs.length };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to retrieve browser tabs." });
    }
  });

  // Activate (switch focus to) a specific browser tab
  fastify.post("/api/tabs/activate", async (request, reply) => {
    let sh: Stagehand;
    try {
      sh = await ensureStagehand();
    } catch {
      return reply.status(503).send({ error: "Stagehand is not connected to a browser." });
    }

    const { index } = (request.body as { index?: number }) || {};
    if (typeof index !== "number") {
      return reply.status(400).send({ error: "Missing required numeric 'index' parameter." });
    }

    try {
      const pages = sh.context.pages();
      if (index < 0 || index >= pages.length) {
        return reply.status(404).send({ error: `Tab index ${index} is out of bounds.` });
      }

      const targetPage = pages[index];
      if (typeof (targetPage as any).bringToFront === "function") {
        await (targetPage as any).bringToFront();
      } else if (typeof (targetPage as any).sendCDP === "function") {
        await (targetPage as any).sendCDP("Page.bringToFront");
      }
      return { success: true, message: `Switched focus to tab #${index + 1}` };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to activate tab." });
    }
  });

  // ── PINNED RESIDENT TAB PRESETS ENDPOINTS (JSON FILE STORED) ───────────────
  fastify.get("/api/tabs/pinned", async (_request, reply) => {
    try {
      const pinnedTabs = loadPinnedTabsJSON();
      return { success: true, pinnedTabs };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post("/api/tabs/pinned", async (request, reply) => {
    const { title, url, scriptFilename } = (request.body as any) || {};
    if (!title || !url) {
      return reply.status(400).send({ error: "请提供预设标题与目标 URL" });
    }
    try {
      const pinnedTabs = loadPinnedTabsJSON();
      const existingIdx = pinnedTabs.findIndex((p) => p.url === url);
      const newEntry = {
        id:
          existingIdx !== -1
            ? pinnedTabs[existingIdx].id
            : `pin_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        title,
        url,
        scriptFilename: scriptFilename || "",
        created_at: new Date().toISOString(),
      };

      if (existingIdx !== -1) {
        pinnedTabs[existingIdx] = newEntry;
      } else {
        pinnedTabs.unshift(newEntry);
      }

      savePinnedTabsJSON(pinnedTabs);
      return { success: true, id: newEntry.id, message: "常驻页签预设已成功保存至 JSON 文件" };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post("/api/tabs/pinned/delete", async (request, reply) => {
    const { id } = (request.body as any) || {};
    if (!id) {
      return reply.status(400).send({ error: "Missing required 'id' parameter." });
    }
    try {
      let pinnedTabs = loadPinnedTabsJSON();
      pinnedTabs = pinnedTabs.filter((p) => p.id !== id);
      savePinnedTabsJSON(pinnedTabs);
      return { success: true, message: "常驻预设已删除" };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Ensure target URL is open in Chrome (Reuse existing or open new tab, with strict URL equality check)
  fastify.post("/api/tabs/ensure", async (request, reply) => {
    let sh: Stagehand;
    try {
      sh = await ensureStagehand();
    } catch {
      return reply.status(503).send({ error: "Stagehand 尚未连接到 Chrome 浏览器。" });
    }

    const { url } = (request.body as any) || {};
    if (!url) {
      return reply.status(400).send({ error: "请提供目标网页 URL" });
    }

    try {
      const pages = sh.context.pages();
      let foundIndex = -1;
      let targetDomain = "";
      try {
        targetDomain = new URL(url).hostname;
      } catch {
        targetDomain = url;
      }

      for (let i = 0; i < pages.length; i++) {
        const pageUrl = pages[i].url();
        if (pageUrl === url) {
          foundIndex = i;
          break;
        }
        if (targetDomain && pageUrl.includes(targetDomain)) {
          foundIndex = i;
          break;
        }
      }

      if (foundIndex !== -1) {
        const targetPage = pages[foundIndex];
        const currentTabUrl = targetPage.url();

        // 强校验：检查当前 Tab 的 URL 是否与保存的预设目标 URL 100% 完全一致
        if (currentTabUrl !== url) {
          fastify.log.info(
            `[Tabs Ensure] 当前页签 URL (${currentTabUrl}) 与预设 URL (${url}) 不一致，重新重定向导航...`,
          );
          await targetPage.goto(url, { waitUntil: "domcontentloaded" });
        }

        if (typeof (targetPage as any).bringToFront === "function") {
          await (targetPage as any).bringToFront();
        }
        return {
          success: true,
          tabIndex: foundIndex,
          createdNew: false,
          navigated: currentTabUrl !== url,
          message:
            currentTabUrl === url
              ? `已匹配已有标签页 #${foundIndex + 1} (URL 校验完全一致)`
              : `已匹配已有标签页 #${foundIndex + 1} 并自动重定向至预设目标 URL`,
        };
      }

      // Tab not found -> Open new tab & navigate
      const newPage = await sh.context.newPage();
      await newPage.goto(url, { waitUntil: "domcontentloaded" });
      if (typeof (newPage as any).bringToFront === "function") {
        await (newPage as any).bringToFront();
      }

      const updatedPages = sh.context.pages();
      const newIndex =
        updatedPages.indexOf(newPage) !== -1
          ? updatedPages.indexOf(newPage)
          : updatedPages.length - 1;

      return {
        success: true,
        tabIndex: newIndex,
        createdNew: true,
        navigated: true,
        message: `已自动为目标网页创建新标签页并载入预设目标 URL (#${newIndex + 1})`,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: `自动匹配/创建页签失败: ${err.message}` });
    }
  });

  // ── SQLITE DATABASE VIEWER ENDPOINTS ──────────────────────────────────

  // 1. List all SQLite tables and row counts
  fastify.get("/api/db/tables", async () => {
    try {
      const tablesRaw = db.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      const tables = tablesRaw.map((t: any) => {
        const countRes = db.get(`SELECT COUNT(*) as count FROM ${t.name}`);
        return {
          name: t.name,
          count: countRes ? countRes.count : 0,
        };
      });
      return { success: true, tables };
    } catch (err: any) {
      return { success: false, error: err.message, tables: [] };
    }
  });

  // 2. Query table data with pagination and optional search filter
  fastify.get("/api/db/data", async (request, reply) => {
    const {
      table,
      search,
      page = "1",
      pageSize = "20",
    } = (request.query as {
      table?: string;
      search?: string;
      page?: string;
      pageSize?: string;
    }) || {};

    if (!table) {
      return reply.status(400).send({ error: "Missing 'table' parameter." });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(500, parseInt(pageSize, 10) || 20));
    const offsetNum = (pageNum - 1) * limitNum;

    try {
      let rows: any[] = [];
      let totalCount = 0;

      // Safely check if rowid is supported by the table
      let orderClause = "";
      try {
        db.get(`SELECT rowid FROM ${table} LIMIT 1`);
        orderClause = "ORDER BY rowid DESC";
      } catch {
        orderClause = "";
      }

      if (search && search.trim()) {
        const keyword = `%${search.trim()}%`;
        const sample = db.get(`SELECT * FROM ${table} LIMIT 1`);
        if (sample) {
          const keys = Object.keys(sample);
          const whereClause = keys.map((k) => `${k} LIKE ?`).join(" OR ");
          const params = keys.map(() => keyword);

          const countRes = db.get(
            `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClause}`,
            params,
          );
          totalCount = countRes ? countRes.count : 0;

          const sql = `SELECT * FROM ${table} WHERE ${whereClause} ${orderClause} LIMIT ${limitNum} OFFSET ${offsetNum}`;
          rows = db.all(sql, params);
        }
      } else {
        const countRes = db.get(`SELECT COUNT(*) as count FROM ${table}`);
        totalCount = countRes ? countRes.count : 0;

        const sql = `SELECT * FROM ${table} ${orderClause} LIMIT ${limitNum} OFFSET ${offsetNum}`;
        rows = db.all(sql);
      }

      const totalPages = Math.max(1, Math.ceil(totalCount / limitNum));

      return {
        success: true,
        table,
        total: totalCount,
        page: pageNum,
        pageSize: limitNum,
        totalPages,
        rows,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: `Query failed: ${err.message}` });
    }
  });

  // 3. Clear table data
  fastify.post("/api/db/clear", async (request, reply) => {
    const { table } = (request.body as { table?: string }) || {};
    if (!table) {
      return reply.status(400).send({ error: "Missing 'table' parameter." });
    }

    try {
      db.exec(`DELETE FROM ${table}`);
      return { success: true, message: `Table '${table}' cleared.` };
    } catch (err: any) {
      return reply.status(500).send({ error: `Clear failed: ${err.message}` });
    }
  });

  // 4. Delete single row from table
  fastify.post("/api/db/delete-row", async (request, reply) => {
    const { table, primaryKey, primaryValue } =
      (request.body as { table?: string; primaryKey?: string; primaryValue?: any }) || {};
    if (!table || !primaryKey || primaryValue === undefined) {
      return reply.status(400).send({ error: "Missing 'table', 'primaryKey', or 'primaryValue'." });
    }

    try {
      db.run(`DELETE FROM ${table} WHERE ${primaryKey} = ?`, [primaryValue]);
      return { success: true, message: `Row where ${primaryKey}='${primaryValue}' deleted.` };
    } catch (err: any) {
      return reply.status(500).send({ error: `Delete row failed: ${err.message}` });
    }
  });

  // ── TRACE VISUAL REPLAY ENDPOINTS ──────────────────────────────────────

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

  // ── SCRIPT MANAGEMENT ENDPOINTS ──────────────────────────────────────

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
  "code": "export default async function run({ page, stagehand, log, db }) { ... }"
}

CRITICAL ARCHITECTURE RULES FOR THE CODE INSIDE "code":
1. ALWAYS start with: export default async function run({ page, stagehand, log, db }) { ... }
2. YOU HAVE NATIVE ACCESS TO THE "db" SQLITE HELPER OBJECT for persistent data storage & automatic deduplication:
   - db.exec(sql): Execute DDL queries (e.g. \`db.exec("CREATE TABLE IF NOT EXISTS items (eid TEXT PRIMARY KEY, name TEXT, price TEXT, url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)")\`). ALWAYS call db.exec() at the start of scripts when storing data!
   - db.exists(tableName, whereObject): Check if a record already exists before saving (e.g. \`if (db.exists("items", { eid })) { log("Skipping existing item..."); }\`).
   - db.upsert(tableName, dataObject): Insert or update a record by primary key, automatically avoiding duplicates! (e.g. \`db.upsert("items", { eid, name, price, url })\`).
   - db.all(sql, params): Fetch array of all matching rows (e.g. \`const list = db.all("SELECT * FROM items")\`).
   - db.get(sql, params): Fetch single row.
   - db.insert(tableName, dataObject): Insert single row.
3. Use PURE JavaScript (ES Module)! NEVER use TypeScript annotations like "catch (e: any)" or "interface". Always use "catch (error)".
4. For DOM querying, extraction, or clicking elements, use page.evaluate() for maximum speed and cross-browser reliability.
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
        model: "deepseek-chat",
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

  fastify.post("/api/scripts/execute/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId?: string };
    if (!runId) {
      return reply.status(400).send({ error: "Missing runId." });
    }

    const controller = activeScriptExecutions.get(runId);
    if (!controller) {
      return reply.status(404).send({ error: "该爬取任务已结束或不存在。" });
    }

    if (!controller.signal.aborted) {
      controller.abort();
    }
    return { success: true, runId, message: "爬取任务中止信号已发送。" };
  });

  // 8. Execute .mjs script with Frame Capturing (No duplicate version snapshots generated here!)
  fastify.get("/api/scripts/execute/stream", async (request, reply) => {
    const {
      filename,
      tabIndex,
      targetUrl,
      params: rawParams,
      runId: requestedRunId,
    } = (request.query as {
      filename?: string;
      tabIndex?: string;
      targetUrl?: string;
      params?: string;
      runId?: string;
    }) || {};

    let scriptParams: Record<string, any> = {};
    try {
      if (rawParams) {
        scriptParams = JSON.parse(rawParams);
      }
    } catch {
      // Ignore invalid JSON params
    }

    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");

    const runId = requestedRunId?.trim() || `run_${Date.now()}_${crypto.randomUUID()}`;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "无效的脚本运行 ID。" })}\n\n`,
      );
      reply.raw.end();
      return;
    }
    if (activeScriptExecutions.has(runId)) {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "该脚本运行 ID 已在使用中。" })}\n\n`,
      );
      reply.raw.end();
      return;
    }

    const executionController = new AbortController();
    const executionSignal = executionController.signal;
    activeScriptExecutions.set(runId, executionController);

    let executionFinished = false;
    const handleClientDisconnect = () => {
      if (!executionFinished && !executionSignal.aborted) {
        executionController.abort();
      }
    };
    const finishResponse = () => {
      executionFinished = true;
      reply.raw.off("close", handleClientDisconnect);
      if (activeScriptExecutions.get(runId) === executionController) {
        activeScriptExecutions.delete(runId);
      }
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    };
    reply.raw.on("close", handleClientDisconnect);

    let sh: Stagehand;
    try {
      sh = await ensureStagehand();
    } catch {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "Stagehand 未连接到 Chrome 浏览器。" })}\n\n`,
      );
      finishResponse();
      return;
    }

    if (executionSignal.aborted) {
      finishResponse();
      return;
    }

    const index = Number(tabIndex ?? 0);
    const pages = sh.context.pages();
    if (isNaN(index) || index < 0 || index >= pages.length) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "error",
          message: `目标 Tab 序号 #${index + 1} 无效或超出了打开的页签数量 (${pages.length})`,
        })}\n\n`,
      );
      finishResponse();
      return;
    }

    const targetPage = pages[index];
    const abortableTargetPage = createAbortableAutomationProxy(targetPage as any, executionSignal);
    try {
      if (typeof (targetPage as any).bringToFront === "function") {
        void (targetPage as any).bringToFront();
      } else if (typeof (targetPage as any).sendCDP === "function") {
        void (targetPage as any).sendCDP("Page.bringToFront");
      }
    } catch {
      // Ignore focus errors
    }

    const safeName = getSanitizedFilename(filename || "script.mjs");
    const scriptPath = path.join(SCRIPTS_DIR, safeName);

    if (!fs.existsSync(scriptPath)) {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: `脚本文件 ${safeName} 不存在。` })}\n\n`,
      );
      finishResponse();
      return;
    }

    const runDir = path.join(TRACES_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const traceFrames: Array<{ step: number; time: string; message: string; frameUrl: string }> =
      [];
    const traceLogs: Array<{ time: string; message: string; type: string }> = [];

    const sendEvent = (data: object) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    let lastScreenshotTime = 0;
    let lastFrameUrl = "";
    let screenshotCounter = 0;

    const sendLog = async (message: string, logType: string = "log") => {
      const stepTime = new Date().toLocaleTimeString();
      traceLogs.push({ time: stepTime, message, type: logType });

      // Text logs should never wait for screenshot capture. Push them to the UI immediately.
      sendEvent({
        type: logType,
        time: stepTime,
        message,
        runId,
      });

      try {
        if (targetPage && !(targetPage as any).isClosed?.()) {
          const now = Date.now();
          const isActionMsg = /页面|点击|滚动|导航|打开|提取|保存|加载|下页|底端/.test(message);

          // Capture a new screenshot if > 1.2s elapsed or page action occurred or first frame
          if (now - lastScreenshotTime > 1200 || isActionMsg || !lastFrameUrl) {
            screenshotCounter++;
            const imageName = `frame_${screenshotCounter}.jpg`;
            const imagePath = path.join(runDir, imageName);

            const imgBuffer = await (targetPage as any).screenshot({
              type: "jpeg",
              quality: 60,
            });

            fs.writeFileSync(imagePath, imgBuffer);
            lastFrameUrl = `http://localhost:3001/api/traces/${runId}/frame/${imageName}`;
            lastScreenshotTime = now;
          }

          if (lastFrameUrl) {
            const frameData = {
              step: traceFrames.length + 1,
              time: stepTime,
              message,
              frameUrl: lastFrameUrl,
            };
            traceFrames.push(frameData);

            sendEvent({
              type: "frame",
              runId,
              ...frameData,
            });
          }
        }
      } catch {
        // Screenshot capture is optional
      }

      // Always persist updated trace.json metadata including logs
      try {
        fs.writeFileSync(
          path.join(runDir, "trace.json"),
          JSON.stringify(
            {
              runId,
              filename: safeName,
              targetUrl:
                targetUrl ||
                (targetPage && !(targetPage as any).isClosed?.() ? targetPage.url() : ""),
              timestamp: new Date().toLocaleString("zh-CN"),
              totalFrames: traceFrames.length,
              totalLogs: traceLogs.length,
              frames: traceFrames,
              logs: traceLogs,
            },
            null,
            2,
          ),
          "utf-8",
        );
      } catch {
        // Ignore JSON write error
      }
    };

    void sendLog(`🎬 开始在 Tab #${index + 1} (${targetPage.url()}) 上运行脚本 [${safeName}]`);

    (async () => {
      try {
        // Pre-run URL Match Verification & Redirect Check
        let expectedUrl = targetUrl;
        if (!expectedUrl) {
          const pinnedTabs = loadPinnedTabsJSON();
          const matchedPinned = pinnedTabs.find((p) => p.scriptFilename === safeName);
          if (matchedPinned) {
            expectedUrl = matchedPinned.url;
          }
        }

        if (expectedUrl && expectedUrl.trim()) {
          const currentUrl = targetPage.url();
          if (currentUrl !== expectedUrl) {
            void sendLog(
              `⚠️ [运行前 URL 校验] 当前页签 URL (${currentUrl}) 与常驻目标 URL (${expectedUrl}) 不一致，正在自动重定向校准...`,
            );
            try {
              await abortableTargetPage.goto(expectedUrl, { waitUntil: "domcontentloaded" });
              void sendLog(`✅ [运行前 URL 校验] 成功纠偏重定向至目标网页: ${targetPage.url()}`);
            } catch (navErr: any) {
              if (isExecutionCancelledError(navErr) || executionSignal.aborted) throw navErr;
              void sendLog(`⚠️ 自动重定向页面警告: ${navErr.message}`);
            }
          } else {
            void sendLog(`✅ [运行前 URL 校验] 页面 URL 校验 100% 吻合: ${currentUrl}`);
          }
        }

        const sourceCode = fs.readFileSync(scriptPath, "utf-8");

        let codeBody = sourceCode
          .replace(/import\s+type\s+[^;]+;/g, "")
          .replace(/import\s+[^;]+;/g, "")
          .replace(/export\s+interface\s+[^}]*}/g, "")
          .replace(/interface\s+[^}]*}/g, "")
          .replace(/type\s+\w+\s*=[^;]+;/g, "");

        if (/export\s+default\s+(async\s+)?function/.test(codeBody)) {
          codeBody = codeBody.replace(
            /export\s+default\s+(async\s+)?function\s*\w*\s*\([^)]*\)\s*\{/,
            "",
          );
          const lastBraceIndex = codeBody.lastIndexOf("}");
          if (lastBraceIndex !== -1) {
            codeBody = codeBody.slice(0, lastBraceIndex) + codeBody.slice(lastBraceIndex + 1);
          }
        }

        const transpiledJS = safeTranspile(codeBody).outputText;

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const runner = new AsyncFunction(
          "page",
          "stagehand",
          "log",
          "console",
          "db",
          "params",
          "signal",
          "fetch",
          transpiledJS,
        );

        const executionLog = async (message: string, logType: string = "log") => {
          throwIfExecutionCancelled(executionSignal);
          await sendLog(message, logType);
          throwIfExecutionCancelled(executionSignal);
        };
        const abortableStagehand = createAbortableAutomationProxy(sh as any, executionSignal);
        const abortableDb = createAbortableAutomationProxy(db as any, executionSignal);
        const abortableFetch: typeof fetch = (input, init) => {
          throwIfExecutionCancelled(executionSignal);
          const requestSignal = init?.signal
            ? AbortSignal.any([executionSignal, init.signal])
            : executionSignal;
          return raceWithExecutionCancellation(
            fetch(input, { ...init, signal: requestSignal }),
            executionSignal,
          );
        };

        const customConsole = {
          ...console,
          log: (...args: any[]) => {
            throwIfExecutionCancelled(executionSignal);
            console.log(...args);
            void sendLog(
              args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
            );
          },
          error: (...args: any[]) => {
            throwIfExecutionCancelled(executionSignal);
            console.error(...args);
            void sendLog(
              "❌ " +
                args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
            );
          },
        };

        // Execute script passing db and scriptParams
        const runnerPromise = runner(
          abortableTargetPage,
          abortableStagehand,
          executionLog,
          customConsole,
          abortableDb,
          scriptParams,
          executionSignal,
          abortableFetch,
        );
        // Wait for user code to exit instead of reporting cancellation while it is still running.
        // Wrapped automation, database, log and fetch boundaries reject cooperatively on abort.
        await runnerPromise;
        throwIfExecutionCancelled(executionSignal);

        sendEvent({
          type: "done",
          runId,
          time: new Date().toLocaleTimeString(),
          message: `🎉 脚本 [${safeName}] 在 Tab #${index + 1} 上全部执行完毕！`,
        });
      } catch (err: any) {
        if (isExecutionCancelledError(err) || executionSignal.aborted) {
          const message = `🛑 脚本 [${safeName}] 在 Tab #${index + 1} 上已中止。`;
          await sendLog(message, "cancelled");
        } else {
          sendEvent({
            type: "error",
            runId,
            time: new Date().toLocaleTimeString(),
            message: `❌ 脚本执行异常中断: ${err.message || String(err)}`,
          });
        }
      } finally {
        finishResponse();
      }
    })().catch((err) => {
      sendEvent({ type: "error", message: `系统致命错误: ${err.message}` });
      finishResponse();
    });
  });

  // 4. Start server
  const port = Number(process.env.PORT) || 3001;
  try {
    await fastify.listen({ port, host: "0.0.0.0" });
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

void main();
