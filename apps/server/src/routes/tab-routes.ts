import type { Stagehand } from "@browserbasehq/stagehand";
import type { FastifyInstance } from "fastify";
import { ensureStagehand } from "../browser/stagehand-manager.js";
import { createTabFaviconDataUri } from "../tabs/favicon.js";
import { loadPinnedTabsJSON, savePinnedTabsJSON } from "../tabs/pinned-tabs-store.js";

interface TabRoutesDependencies {
  fastify: FastifyInstance;
  getUserVisiblePages: (stagehand: Stagehand) => Promise<any[]>;
}

export function registerTabRoutes({ fastify, getUserVisiblePages }: TabRoutesDependencies): void {
  // Get all browser tabs
  fastify.get("/api/tabs", async (_request, reply) => {
    let sh: Stagehand;
    try {
      sh = await ensureStagehand();
    } catch {
      return reply.status(503).send({ error: "Stagehand is not connected to a browser." });
    }

    try {
      const pages = await getUserVisiblePages(sh);
      const tabs = await Promise.all(
        pages.map(async (page, index) => {
          const url = page.url();
          const targetId = typeof page.targetId === "function" ? page.targetId() : "";
          if (typeof targetId !== "string" || !targetId) {
            throw new Error(`Browser page at index ${index} has no stable target id.`);
          }
          return {
            index,
            targetId,
            title: await page.title(),
            url,
            favicon: createTabFaviconDataUri(url),
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
      const pages = await getUserVisiblePages(sh);
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
      const pages = await getUserVisiblePages(sh);
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

      const updatedPages = await getUserVisiblePages(sh);
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
}
