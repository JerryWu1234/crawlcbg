export default async function run({ page, log, db }) {
  log("🚀 开始执行：藏宝阁商品列表自动化爬取（自动翻页 + SQLite 去重中断）");
  log(`📍 当前页面 URL: ${page.url()}`);

  // 1. 初始化 SQLite 数据表（如果表不存在则自动建表）
  db.exec(`
    CREATE TABLE IF NOT EXISTS cbg_items (
      eid TEXT PRIMARY KEY,
      name TEXT,
      href TEXT,
      tips TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  log("🗄️ SQLite 数据表 'cbg_items' 就绪。");

  // 第一步：检查是否存在“去登录”元素，若找到则立刻终止
  log("🔍 正在检查页面是否存在 '去登录' 按钮...");
  const isNeedLogin = await page.evaluate(() => {
    const btn = document.querySelector("a.btn1.js_alert_btn_0");
    if (btn) return true;
    const links = Array.from(document.querySelectorAll("a"));
    return links.some((a) => a.innerText && a.innerText.includes("去登录"));
  });

  if (isNeedLogin) {
    log("⚠️ 检测到 '去登录' 按钮（账号未登录），按预设终止脚本执行！");
    return;
  }
  log("✅ 未发现 '去登录' 按钮，开始爬取分析。");

  let pageNum = 1;

  // 开始多页循环爬取
  while (true) {
    log(`========================================`);
    log(`📄 正在处理第 ${pageNum} 页商品列表...`);
    log(`========================================`);

    // 获取当前页 #soldList > tbody > tr 数量（通常为 15 条）
    const rowsCount = await page.evaluate(() => {
      return document.querySelectorAll("#soldList > tbody > tr").length;
    });
    log(`📊 第 ${pageNum} 页共找到 ${rowsCount} 行商品`);

    if (rowsCount === 0) {
      log("⚠️ 当前页商品列表为空，结束自动化爬取。");
      break;
    }

    let isDuplicateEncountered = false;

    // 依次处理当前页的每一行商品
    for (let i = 1; i <= rowsCount; i++) {
      log(`----------------------------------------`);
      log(`📦 [第 ${pageNum} 页] 正在处理第 ${i} / ${rowsCount} 条商品...`);

      const aSoldImgSelector = `#soldList > tbody > tr:nth-child(${i}) a.soldImg`;

      // 提取商品名称与链接
      const rowInfo = await page.evaluate((index) => {
        const a = document.querySelector(`#soldList > tbody > tr:nth-child(${index}) a.soldImg`);
        const img = document.querySelector(`#soldList > tbody > tr:nth-child(${index}) img`);
        const nameTd = document.querySelector(
          `#soldList > tbody > tr:nth-child(${index}) > td:nth-child(2)`,
        );

        return {
          href: a ? a.getAttribute("href") || a.href || "" : "",
          name: nameTd
            ? nameTd.innerText.trim()
            : img
              ? img.getAttribute("data_equip_name") || ""
              : "",
        };
      }, i);

      // 解析 eid 参数
      let eid = "";
      if (rowInfo.href) {
        try {
          const urlObj = new URL(rowInfo.href, page.url());
          eid = urlObj.searchParams.get("eid") || "";
        } catch {
          const match = rowInfo.href.match(/eid=([^&]+)/);
          if (match) eid = match[1];
        }
      }
      log(`🆔 提取到的 eid: ${eid || "未获取到 eid"}`);

      // 核心要求规则：只要遇到任何一条已经在 SQLite 数据库中存在，就立即停止爬取！
      if (eid) {
        const existsInDb = db.exists("cbg_items", { eid });
        if (existsInDb) {
          log(`🛑 检测到商品 [${eid}] 在 SQLite 数据库中已被抓取保存过！`);
          log(`🛑 触发表单去重安全保护规则：此商品已存在于数据库中，自动化脚本已安全停止！`);
          log(
            `💡 提示：若需对此页面强制重新跑，请先在【SQLite 数据管理】页面中清空表或删除历史数据！`,
          );
          isDuplicateEncountered = true;
          break;
        }
      }

      // 平滑滚动到屏幕中央
      await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, aSoldImgSelector);

      await page.waitForTimeout(300);

      // 精准 Hover 悬停图片元素触发 #TipsBox
      log(`🖱️ 正在 Hover 悬停第 ${i} 条商品图片...`);
      try {
        const aElem = page.locator(aSoldImgSelector).first();
        if ((await aElem.count()) > 0) {
          await aElem.hover({ force: true });
        }
      } catch (e) {
        log(`⚠️ Hover 提示: ${e.message}`);
      }

      await page.waitForTimeout(500);

      // 读取 #TipsBox 浮层属性
      const tipsText = await page.evaluate(() => {
        const box = document.querySelector("#TipsBox");
        if (box) {
          return (box.innerText || box.textContent || "").trim();
        }
        return "";
      });

      // 写入新数据到 SQLite 数据库
      if (eid) {
        db.upsert("cbg_items", {
          eid,
          name: rowInfo.name,
          href: rowInfo.href,
          tips: tipsText,
        });
        log(`💾 成功写入新商品 [${eid}] 到 SQLite 数据库 (cbg_items)！`);
      }
    }

    // 如果遇到了重复数据，跳出外层翻页循环并终止
    if (isDuplicateEncountered) {
      log("🎉 遇到已保存的历史商品，按去重规则成功安全终止流程。");
      return;
    }

    // 处理完当前页 15 条且均为全新数据后，尝试寻找并点击“下一页”
    log(`🔍 正在寻找页码指示器 (#pager) 中的 '下一页' 按钮...`);
    const clickedNext = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("#pager div a, #pager a"));
      const nextBtn = links.find((a) => a.innerText && a.innerText.trim().includes("下一页"));

      if (nextBtn && !nextBtn.classList.contains("disabled")) {
        nextBtn.click();
        return true;
      }
      return false;
    });

    if (clickedNext) {
      log(`➡️ 已成功点击 '下一页'，等待新一页商品加载...`);
      await page.waitForTimeout(2500); // 等待异步请求加载下一页商品
      pageNum++;
    } else {
      log("🏁 未找到可点击的 '下一页' 按钮（已到达最后一页），自动化爬取结束。");
      break;
    }
  }

  log("🎉 自动化爬取与数据库存库任务全部完成！");
}
