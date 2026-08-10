export default async function run({ page, stagehand, log, db }) {
  log("🚀 开始执行：小红书蒲公英笔记列表自动化爬取（精确定位下一页与禁用检测）");
  log(`📍 当前页面 URL: ${page.url()}`);

  // 1. 初始化 SQLite 数据表 notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      eid TEXT PRIMARY KEY,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  log("🗄️ SQLite 数据表 'notes' 就绪。");

  let pageNum = 1;

  // 2. 开始多页循环爬取
  while (true) {
    log(`========================================`);
    log(`📄 正在处理第 ${pageNum} 页笔记列表...`);
    log(`========================================`);

    // 尝试等待 #note-list 节点加载完成
    try {
      await page.waitForSelector("#note-list", { timeout: 4000 });
    } catch {
      log("⚠️ 等待 #note-list 节点超时，尝试直接提取内容...");
    }

    // 获取当前页 #note-list 的 innerText 内容
    const content = await page.evaluate(() => {
      const el = document.querySelector("#note-list");
      return el ? el.innerText.trim() : "";
    });

    if (!content) {
      log("⚠️ 当前页 #note-list 内容为空，自动化爬取结束。");
      break;
    }

    // 生成随机 eid 存库
    const eid = `note_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    db.upsert("notes", { eid, content });
    log(`💾 成功保存第 ${pageNum} 页笔记内容到 SQLite 数据库 (notes)！eid: ${eid}`);

    // 3. 寻找真正序数递增的 '下一页' 按钮 (避免点击到最后一页 144)
    log(`🔍 寻找单页顺序递增的 '下一页' 按钮...`);
    const pageState = await page.evaluate(() => {
      const pagination =
        document.querySelector("#note-list div.d-pagination") ||
        document.querySelector(".d-pagination") ||
        document;

      // 策略 A: 精确定位类名 .d-pagination-next 或 [title="下一页"]
      let nextBtn =
        pagination.querySelector(".d-pagination-next") ||
        pagination.querySelector("[title='下一页']") ||
        pagination.querySelector("[aria-label='Next Page']") ||
        pagination.querySelector("[aria-label='下一页']");

      // 策略 B: 查找包含 "下一页" 文本或特有属性的节点
      if (!nextBtn) {
        const candidates = Array.from(pagination.querySelectorAll("div, span, button, li, a"));
        nextBtn =
          candidates.find((el) => {
            const txt = el.innerText ? el.innerText.trim() : "";
            const title = el.getAttribute("title") || "";
            return txt === "下一页" || title === "下一页";
          }) || null;
      }

      // 策略 C: 查找当前高亮激活页码 N，精准查找第 N+1 页按钮 (严格保证 1 -> 2 -> 3 顺序)
      if (!nextBtn) {
        const activeItem = pagination.querySelector(
          ".d-pagination-page-active, .d-pagination-item-active, .active",
        );
        if (activeItem) {
          const currentNum = parseInt(activeItem.innerText.trim(), 10);
          if (!isNaN(currentNum)) {
            const targetNum = currentNum + 1;
            const pageItems = Array.from(
              pagination.querySelectorAll(".d-pagination-page, .d-pagination-item, span, div"),
            );
            nextBtn = pageItems.find((el) => el.innerText.trim() === String(targetNum)) || null;
          }
        }
      }

      // 策略 D: 若以上均未匹配，取分页组件中最后一个元素（通常为右箭头 > 下一页）
      if (!nextBtn) {
        const lastBtn = pagination.querySelector(
          "div:nth-child(2) > div:nth-child(1) > div:last-child",
        );
        if (lastBtn && !lastBtn.innerText.match(/^\d+$/)) {
          // 确保不是页码数字 144
          nextBtn = lastBtn;
        }
      }

      if (!nextBtn) {
        return { isEnd: true, reason: "未在 DOM 中查找到 '下一页' 按钮" };
      }

      // 检查该下一页按钮本身或其父节点是否包含 disabled 禁用状态
      const isNextDisabled =
        nextBtn.classList.contains("disabled") ||
        nextBtn.getAttribute("aria-disabled") === "true" ||
        (nextBtn.parentElement && nextBtn.parentElement.classList.contains("disabled"));

      if (isNextDisabled) {
        return {
          isEnd: true,
          reason: "检测到 '下一页' 按钮本身已处于 disabled 禁用状态（已到达末页）",
        };
      }

      // 执行点击
      nextBtn.click();
      return { isEnd: false, clicked: true };
    });

    if (pageState.isEnd) {
      log(`🏁 ${pageState.reason}，自动化爬取结束。`);
      break;
    }

    if (pageState.clicked) {
      log(`➡️ 已成功点击 '下一页' 按钮，等待第 ${pageNum + 1} 页笔记列表加载...`);
      await page.waitForTimeout(3000); // 留出 3 秒给异步网络请求和 DOM 重新渲染
      pageNum++;
    } else {
      log("⚠️ 无法完成点击操作，自动化爬取结束。");
      break;
    }
  }

  log("🎉 自动化爬取与 SQLite 数据库归档全部完成！");
}
