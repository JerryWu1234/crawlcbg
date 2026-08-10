/**
 * @name YouTube 视频数据自动化爬取脚本
 * @description 自动对 YouTube 视频列表进行下拉刷新抓取并持久化至 SQLite 数据库
 *
 * @param {number} [maxScrolls=5] 最大下拉刷新次数 | 限制在 1-50 次
 * @param {number} [scrollDistance=1500] 每次向下滚动像素距离 | 单位: px
 * @param {select} [waitSpeed="medium"] 页面渲染等待速度 | 选项: {"fast":"快速 (1.5s)", "medium":"适中 (2.5s)", "slow":"深度 (4s)"}
 * @param {boolean} [saveToDb=true] 是否自动存入 SQLite 数据库
 */
export default async function run({ page, log, db, params }) {
  const maxScrolls = params?.maxScrolls || 5;
  const scrollDistance = params?.scrollDistance || 1500;
  const waitSpeedMap = { fast: 1500, medium: 2500, slow: 4000 };
  const waitMs = waitSpeedMap[params?.waitSpeed] || 2500;
  const shouldSaveDb = params?.saveToDb !== false;

  log("🚀 开始执行：YouTube 首页/列表视频数据自动化爬取与下拉刷新");
  log(
    `⚙️ 运行时参数生效: 最大刷新次数=${maxScrolls}, 滚动距离=${scrollDistance}px, 等待延迟=${waitMs}ms, 存入数据库=${shouldSaveDb}`,
  );
  log(`📍 当前页面 URL: ${page.url()}`);

  // 1. 初始化 SQLite 数据表 youtube_videos
  if (shouldSaveDb) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_videos (
        eid TEXT PRIMARY KEY,
        title TEXT,
        href TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    log("🗄️ SQLite 数据表 'youtube_videos' 就绪。");
  }

  let scrollCount = 1;
  const processedHrefs = new Set();
  let totalNewSaved = 0;

  while (scrollCount <= maxScrolls) {
    log(`========================================`);
    log(`📄 正在进行第 ${scrollCount} / ${maxScrolls} 次下拉刷新与页面提取...`);
    log(`========================================`);

    // 2. 提取当前 DOM 中的所有 #contents > ytd-rich-item-renderer 元素
    const videoItems = await page.evaluate(() => {
      // 兼容 #contents > ytd-rich-item-renderer 以及全局 ytd-rich-item-renderer 节点
      const elements = Array.from(
        document.querySelectorAll("#contents > ytd-rich-item-renderer, ytd-rich-item-renderer"),
      );

      return elements
        .map((item) => {
          // 优先使用用户指定的精准 Selector 路径
          // #contents > ytd-rich-item-renderer > yt-lockup-view-model > div > div > yt-lockup-metadata-view-model > div.ytLockupMetadataViewModelTextContainer > h3 > a > span
          const specificTitleSpan = item.querySelector(
            "yt-lockup-view-model > div > div > yt-lockup-metadata-view-model > div.ytLockupMetadataViewModelTextContainer > h3 > a > span",
          );
          const specificLinkAnchor = item.querySelector(
            "yt-lockup-view-model > div > div > yt-lockup-metadata-view-model > div.ytLockupMetadataViewModelTextContainer > h3 > a",
          );

          // 通用 Fallback Selector
          const fallbackTitleAnchor = item.querySelector(
            "a#video-title, h3 a, a.yt-simple-endpoint",
          );

          let title = "";
          if (specificTitleSpan) {
            title = specificTitleSpan.innerText ? specificTitleSpan.innerText.trim() : "";
          }
          if (!title && specificLinkAnchor) {
            title = specificLinkAnchor.innerText ? specificLinkAnchor.innerText.trim() : "";
          }
          if (!title && fallbackTitleAnchor) {
            title = fallbackTitleAnchor.innerText ? fallbackTitleAnchor.innerText.trim() : "";
          }

          let href = "";
          if (specificLinkAnchor) {
            href = specificLinkAnchor.getAttribute("href") || specificLinkAnchor.href || "";
          }
          if (!href && fallbackTitleAnchor) {
            href = fallbackTitleAnchor.getAttribute("href") || fallbackTitleAnchor.href || "";
          }

          return { title, href };
        })
        .filter((v) => v.title || v.href);
    });

    log(`📊 当前页面共找到 ${videoItems.length} 个视频元素节点`);

    let newItemsFoundThisScroll = 0;

    // 3. 遍历提取到的视频信息并存入数据库
    for (const item of videoItems) {
      if (!item.href) continue;

      // 补全相对 URL
      let fullUrl = item.href;
      if (fullUrl.startsWith("/")) {
        fullUrl = `https://www.youtube.com${fullUrl}`;
      }

      // 生成唯一的 eid 标识 (解析 v= 视频 ID，若无则使用 url/hash 拼接)
      let eid = "";
      try {
        const urlObj = new URL(fullUrl);
        eid = urlObj.searchParams.get("v") || "";
      } catch {
        // ignore
      }

      if (!eid) {
        eid = fullUrl.replace(/[^a-zA-Z0-9_-]/g, "_");
      }

      // 跳过本次运行中已处理过的记录
      if (processedHrefs.has(fullUrl)) {
        continue;
      }
      processedHrefs.add(fullUrl);
      newItemsFoundThisScroll++;

      // 存入 SQLite 数据库 (自动去重/替换)
      db.upsert("youtube_videos", {
        eid,
        title: item.title,
        href: fullUrl,
      });

      log(
        `💾 [${newItemsFoundThisScroll}] 成功保存视频: [${item.title || "无标题"}] | URL: ${fullUrl}`,
      );
    }

    totalNewSaved += newItemsFoundThisScroll;
    log(
      `✨ 第 ${scrollCount} 次提取完成，本次新增记录: ${newItemsFoundThisScroll} 条，累计处理记录: ${processedHrefs.size} 条`,
    );

    // 4. 执行下拉刷新 (Scroll down) 触发加载更多内容
    log(`⏬ 正在平滑向下滚动页面，触发加载更多视频内容...`);

    // 获取滚动前页面高度
    const previousHeight = await page.evaluate(() => document.body.scrollHeight);

    // 平滑向下滚动指定像素或到达底部
    await page.evaluate((dist) => {
      window.scrollBy({
        top: dist,
        left: 0,
        behavior: "smooth",
      });
    }, scrollDistance);

    // 留出时间等待网络异步请求与 DOM 节点动态加载
    log(`⏳ 等待新数据渲染 (${waitMs / 1000} 秒)...`);
    await page.waitForTimeout(waitMs);

    // 检查滚动后页面高度
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight && newItemsFoundThisScroll === 0 && scrollCount > 3) {
      log(`🏁 连续下拉后页面高度未增加且无新数据加载，已到达底端，结束爬取。`);
      break;
    }

    scrollCount++;
  }

  log(
    `🎉 自动化爬取与 SQLite 数据库归档完成！共归档 ${totalNewSaved} 条视频数据到 'youtube_videos' 表。`,
  );
}
