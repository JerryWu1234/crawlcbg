export {};

interface FixtureState {
  abortedGates: Record<string, number>;
  gateRequests: Record<string, number>;
  marks: Record<string, number>;
  waitingGates: Record<string, number>;
}

interface BrowserSnapshot {
  baselineCount: number;
  extraTargets: Array<{
    targetId: string;
    title: string;
    url: string;
    windowId: number | null;
    windowState: string;
  }>;
}

const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

const selectScript = (filename: string) => {
  fixtureCard().find(".picker-trigger-btn").click();
  fixtureCard().contains(".picker-menu-item", filename).click();
};

const openRun = (mode: "visible" | "background") => {
  fixtureCard().find(".run-tab-btn").click();
  cy.contains(".param-modal-card", "运行配置与确认")
    .find(".param-form-item-fancy")
    .contains("运行方式")
    .parents(".param-form-item-fancy")
    .find("select")
    .select(mode);
  cy.contains(".param-modal-card", "运行配置与确认").find(".btn-glow-confirm").click();
};

const waitForFixtureState = (
  description: string,
  predicate: (state: FixtureState) => boolean,
  attempts = 60,
): Cypress.Chainable<FixtureState> =>
  cy.task<FixtureState>("p0:fixtureState").then((state) => {
    if (predicate(state)) return cy.wrap(state, { log: false });
    if (attempts <= 1) {
      throw new Error(`fixture 未进入 ${description} 状态：${JSON.stringify(state)}`);
    }
    return cy.wait(100).then(() => waitForFixtureState(description, predicate, attempts - 1));
  });

const waitForBrowserState = (
  expected: "active" | "clean",
  attempts = 60,
): Cypress.Chainable<BrowserSnapshot> =>
  cy.task<BrowserSnapshot>("p0:backgroundSnapshot").then((snapshot) => {
    const ready =
      expected === "active"
        ? snapshot.extraTargets.length >= 2 &&
          snapshot.extraTargets.every((target) => target.windowState === "minimized")
        : snapshot.extraTargets.length === 0;
    if (ready) return cy.wrap(snapshot, { log: false });
    if (attempts <= 1) {
      throw new Error(
        `managed Chrome 未进入 ${expected} 状态：${JSON.stringify(snapshot.extraTargets)}`,
      );
    }
    return cy.wait(100).then(() => waitForBrowserState(expected, attempts - 1));
  });

describe("P0 execution safety", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
  });

  it("executes on the exact visible target and exposes the real side effect", () => {
    selectScript("p0-visible.mjs");
    openRun("visible");

    cy.contains(".execution-modal-card", "E2E_VISIBLE_DONE").should("be.visible");
    cy.contains(".execution-modal-card", "全部执行完毕").should("be.visible");
    cy.task<FixtureState>("p0:fixtureState").then((state) => {
      expect(state.marks["visible-button"]).to.equal(1);
      expect(state.marks["visible-script"]).to.equal(1);
    });
  });

  it("refuses a target whose URL changed after the confirmation dialog opened", () => {
    selectScript("p0-visible.mjs");
    fixtureCard().find(".run-tab-btn").click();
    cy.contains(".param-modal-card", "运行配置与确认").should("be.visible");
    cy.task("p0:navigateTargetStale");
    cy.contains(".param-modal-card", "运行配置与确认").find(".btn-glow-confirm").click();

    cy.contains(".execution-modal-card", "目标标签页的序号或 URL 已变化").should("be.visible");
    cy.task<FixtureState>("p0:fixtureState").then((state) => {
      expect(state.marks["visible-button"]).to.equal(undefined);
      expect(state.marks["visible-script"]).to.equal(undefined);
    });
  });

  it("refuses an ambiguous duplicate exact target", () => {
    selectScript("p0-visible.mjs");
    fixtureCard().find(".run-tab-btn").click();
    cy.contains(".param-modal-card", "运行配置与确认").should("be.visible");
    cy.task("p0:createDuplicateTab");
    cy.contains(".param-modal-card", "运行配置与确认").find(".btn-glow-confirm").click();

    cy.contains(".execution-modal-card", "存在多个 URL 完全相同的标签页").should("be.visible");
    cy.task<FixtureState>("p0:fixtureState").then((state) => {
      expect(state.marks["visible-script"]).to.equal(undefined);
    });
  });

  it("waits for a real cancelled terminal event and aborts pending work", () => {
    selectScript("p0-cancel.mjs");
    openRun("visible");

    cy.contains(".execution-modal-card", "E2E_CANCEL_READY").should("be.visible");
    waitForFixtureState("cancel gate waiting", (state) => state.waitingGates.cancel === 1);
    cy.contains(".execution-modal-card .btn-stop-execution", "停止运行").click();
    cy.contains(".execution-modal-card", "已中止").should("be.visible");
    cy.contains(".execution-modal-card", "E2E_CANCEL_AFTER_GATE").should("not.exist");

    waitForFixtureState("cancel gate aborted", (state) => state.abortedGates.cancel === 1).then(
      (state) => {
        expect(state.marks["cancel-after-gate"]).to.equal(undefined);
      },
    );
  });

  it("cancels a background run only after pending work and owned windows are cleaned", () => {
    selectScript("p0-cancel.mjs");
    openRun("background");

    cy.contains(".execution-modal-card", "E2E_CANCEL_READY").should("be.visible");
    waitForFixtureState("cancel gate waiting", (state) => state.waitingGates.cancel === 1);
    cy.window().then((window) => {
      expect(window.localStorage.getItem("crawlcbg.tabs.background-execution")).to.contain("run_");
    });

    cy.contains(".execution-modal-card .btn-stop-execution", "停止运行").click();
    cy.contains(".execution-modal-card", "已中止").should("be.visible");
    cy.contains(".execution-modal-card", "E2E_CANCEL_AFTER_GATE").should("not.exist");

    cy.task<FixtureState>("p0:fixtureState").then((state) => {
      expect(state.abortedGates.cancel).to.equal(1);
      expect(state.waitingGates.cancel ?? 0).to.equal(0);
      expect(state.marks["cancel-after-gate"]).to.equal(undefined);
    });
    cy.task<BrowserSnapshot>("p0:backgroundSnapshot").then((snapshot) => {
      expect(snapshot.baselineCount).to.equal(1);
      expect(snapshot.extraTargets).to.deep.equal([]);
    });
    cy.window().then((window) => {
      expect(window.localStorage.getItem("crawlcbg.tabs.background-execution")).to.equal(null);
    });

    cy.contains(".execution-modal-card button", "关闭窗口").click();
    selectScript("p0-visible.mjs");
    openRun("visible");
    cy.contains(".execution-modal-card", "E2E_VISIBLE_DONE").should("be.visible");
    cy.contains(".execution-modal-card", "全部执行完毕").should("be.visible");
    cy.task<FixtureState>("p0:fixtureState").then((state) => {
      expect(state.marks["visible-button"]).to.equal(1);
      expect(state.marks["visible-script"]).to.equal(1);
    });
  });

  it("recovers a background run after reload and proves owned windows are minimized then removed", () => {
    selectScript("p0-background.mjs");
    openRun("background");

    cy.contains(".execution-modal-card", "E2E_BACKGROUND_READY").should("be.visible");
    waitForBrowserState("active").then((snapshot) => {
      expect(snapshot.baselineCount).to.equal(1);
      expect(snapshot.extraTargets).to.have.length.at.least(2);
      expect(snapshot.extraTargets.every((target) => target.windowState === "minimized")).to.equal(
        true,
      );
    });

    cy.window().then((window) => {
      expect(window.localStorage.getItem("crawlcbg.tabs.background-execution")).to.contain("run_");
    });
    cy.reload();
    cy.contains(".execution-modal-card", "最小化后台窗口脚本实时执行").should("be.visible");
    cy.contains(".execution-modal-card", "E2E_BACKGROUND_READY").should("be.visible");

    cy.task<{ released: number }>("p0:releaseGate", "background").then(({ released }) => {
      expect(released).to.equal(1);
    });
    cy.contains(".execution-modal-card", "E2E_BACKGROUND_DONE").should("be.visible");
    cy.contains(".execution-modal-card", "全部执行完毕").should("be.visible");
    cy.window().then((window) => {
      expect(window.localStorage.getItem("crawlcbg.tabs.background-execution")).to.equal(null);
    });
    waitForBrowserState("clean").its("baselineCount").should("equal", 1);
  });
});
