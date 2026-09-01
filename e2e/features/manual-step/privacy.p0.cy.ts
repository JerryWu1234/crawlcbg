export {};

interface PrivacySnapshot {
  canaryHits: string[];
  frameCount: number;
}

const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

const selectScript = (filename: string) => {
  fixtureCard().find(".picker-trigger-btn").click();
  fixtureCard().contains(".picker-menu-item", filename).click();
};

const runVisible = () => {
  fixtureCard().find(".run-tab-btn").click();
  cy.contains(".param-modal-card", "运行配置与确认").find(".btn-glow-confirm").click();
};

describe("P0 manual-step privacy", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
  });

  it("keeps a manual value out of UI and artifacts and never resumes screenshots", () => {
    const canary = "E2E_SECRET_CANARY_MANUAL_91BC";
    selectScript("p0-manual.mjs");
    runVisible();

    cy.contains(".manual-wait-card", "P0 敏感输入").should("be.visible");
    cy.contains(".manual-wait-card", "CrawlCBG 不接收字段值").should("be.visible");
    cy.contains(".manual-wait-card button", "聚焦目标页面").click();

    let lockedFrameCount = 0;
    cy.task<PrivacySnapshot>("p0:privacySnapshot", canary).then((snapshot) => {
      lockedFrameCount = snapshot.frameCount;
      expect(snapshot.canaryHits).to.deep.equal([]);
    });
    cy.task("p0:manualFill", canary);
    cy.get("body").should("not.contain.text", canary);
    cy.task<PrivacySnapshot>("p0:privacySnapshot", canary).then((snapshot) => {
      expect(snapshot.canaryHits).to.deep.equal([]);
      expect(snapshot.frameCount).to.equal(lockedFrameCount);
    });

    cy.task("p0:manualClick", "完成并继续");
    cy.contains(".execution-modal-card", "E2E_MANUAL_AFTER").should("be.visible");
    cy.contains(".manual-privacy-banner", "后续实时截图已关闭").should("be.visible");
    cy.task<PrivacySnapshot>("p0:privacySnapshot", canary).then((snapshot) => {
      expect(snapshot.canaryHits).to.deep.equal([]);
      expect(snapshot.frameCount).to.equal(lockedFrameCount);
    });
  });

  it("cancels from the trusted Chrome overlay and releases the browser lease", () => {
    selectScript("p0-manual.mjs");
    runVisible();
    cy.contains(".manual-wait-card", "P0 敏感输入").should("be.visible");

    cy.task("p0:manualClick", "取消执行");
    cy.contains(".execution-modal-card", "已中止").should("be.visible");
    cy.task<boolean>("p0:manualOverlayVisible").should("equal", false);

    cy.contains(".execution-modal-card button", "关闭窗口").click();
    selectScript("p0-visible.mjs");
    runVisible();
    cy.contains(".execution-modal-card", "E2E_VISIBLE_DONE").should("be.visible");
  });
});
