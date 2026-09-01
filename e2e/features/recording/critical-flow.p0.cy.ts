export {};

interface PrivacySnapshot {
  canaryHits: string[];
  frameCount: number;
}

interface RuntimeState {
  scripts: string[];
}

const CANARY = "E2E_SECRET_CANARY_RECORDING_7F3A";
const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

describe("P0 browser recording", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
  });

  it("records real Chrome actions, converts controls, saves code, and never persists a secret", () => {
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.intercept("POST", `${apiBaseUrl}/api/scripts/save`).as("saveRecording");
    });

    fixtureCard().contains("button", "录制").click();
    cy.contains(".recording-panel", "实时流已连接").should("be.visible");
    cy.task<{ popupOpened: boolean }>("p0:recordingActions", CANARY)
      .its("popupOpened")
      .should("equal", true);

    cy.contains(".recording-panel .action-item", "P0_PUBLIC_ALPHA").should("be.visible");
    cy.contains(".recording-panel .action-item", "P0_PUBLIC_BETA").should("be.visible");
    cy.contains(".recording-panel .manual-step-card", "E2E Password").should("be.visible");
    cy.contains(".recording-panel .popup-badge", "打开 page1").should("be.visible");
    cy.get(".recording-panel").should("not.contain.text", CANARY);

    cy.contains(".recording-panel button", "停止录制").click();
    cy.contains(".recording-panel", "录制已停止").should("be.visible");

    cy.contains(".recording-panel .action-item", "P0_PUBLIC_ALPHA")
      .find('input[aria-label^="选择第"]')
      .check({ force: true });
    cy.contains(".recording-panel .action-item", "P0_PUBLIC_BETA")
      .find('input[aria-label^="选择第"]')
      .check({ force: true });
    cy.get('.recording-panel input[placeholder="可选标题，例如：请完成登录"]')
      .clear()
      .type("P0 public controls");
    cy.contains(".recording-panel button", "转为人工控件组").click();
    cy.contains(".recording-panel .manual-step-card", "P0 public controls").should("be.visible");

    cy.contains(".recording-panel button", "生成 JS").click();
    cy.contains(".recording-panel .code-preview", "manual.wait").should("be.visible");
    cy.get(".recording-panel").should("not.contain.text", CANARY);
    cy.contains(".recording-panel button", "校验并保存").click();

    cy.wait("@saveRecording").then((interception) => {
      const body = interception.request.body as { content?: string; filename?: string };
      expect(body.filename).to.match(/^recording-tab-\d+\.mjs$/);
      expect(body.content).to.contain("manual.wait");
      expect(body.content).not.to.contain(CANARY);
    });
    cy.contains(".recording-panel", "已保存为").should("be.visible");

    cy.task<PrivacySnapshot>("p0:privacySnapshot", CANARY).then((snapshot) => {
      expect(snapshot.canaryHits).to.deep.equal([]);
    });
    cy.task<RuntimeState>("p0:runtimeState").then((state) => {
      expect(state.scripts.some((name) => /^recording-tab-\d+\.mjs$/.test(name))).to.equal(true);
    });
  });
});
