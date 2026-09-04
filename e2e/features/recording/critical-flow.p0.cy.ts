export {};

interface PrivacySnapshot {
  canaryHits: string[];
  frameCount: number;
}

interface RuntimeState {
  scripts: string[];
}

interface StoppedRecording {
  actions: Array<{
    id: string;
    type: string;
    value?: string;
  }>;
}

const CANARY = "E2E_SECRET_CANARY_RECORDING_7F3A";
const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

describe("P0 browser recording", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
  });

  it("records real Chrome actions, converts controls, saves code, and never persists a secret", () => {
    let savedFilename = "";
    let alphaActionId = "";
    let betaActionId = "";
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/stop`).as("stopRecording");
      cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/manual-steps`).as("createManualStep");
      cy.intercept("POST", `${apiBaseUrl}/api/scripts/save`).as("saveRecording");
    });

    fixtureCard().then(($card) => {
      const tabIndex = $card.attr("data-tab-index");
      expect(tabIndex).to.match(/^\d+$/);
      cy.wrap($card).find('[data-cy="record-tab"]').click();
      cy.location("pathname").should("eq", `/tabs/${tabIndex}/recording`);
    });
    cy.get(".recording-panel").should("be.visible");
    cy.get('[data-cy="recording-flow"]').should("be.visible");
    cy.get('[data-cy="recording-page-preview"]').should("be.visible");
    cy.get(".stream-state").should("contain.text", "录制事件流已连接");
    cy.get('[data-cy="recording-inspector"]').should("be.visible");

    cy.task<{ popupOpened: boolean }>("p0:recordingActions", CANARY)
      .its("popupOpened")
      .should("equal", true);

    cy.get('[data-cy="recording-action-node"]').should("have.length.at.least", 4);
    cy.contains('[data-cy="recording-action-node"]', "人工步骤").should("exist");
    for (const [selector, value] of [
      ['[data-testid="public-alpha"]', "P0_PUBLIC_ALPHA"],
      ['[data-testid="public-beta"]', "P0_PUBLIC_BETA"],
    ] as const) {
      cy.contains('[data-cy="recording-action-node"]', selector)
        .find(".flow-node > strong")
        .click();
      cy.get('[data-cy="recording-inspector"]').contains("code", value).should("be.visible");
    }
    cy.get('[data-cy="recording-page-chip"]').should("have.length", 2);
    cy.get('[data-cy="recording-page-chip"][data-page-id="page1"]').should("be.visible");
    cy.get(".recording-panel").should("not.contain.text", CANARY);

    cy.contains(".recording-panel button", "停止录制").click();
    cy.wait("@stopRecording").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const recording = response?.body.recording as StoppedRecording;
      alphaActionId =
        recording.actions.find((action) => action.value === "P0_PUBLIC_ALPHA")?.id ?? "";
      betaActionId =
        recording.actions.find((action) => action.value === "P0_PUBLIC_BETA")?.id ?? "";
      expect(alphaActionId).not.to.equal("");
      expect(betaActionId).not.to.equal("");
    });
    cy.contains(".recording-panel", "录制已停止").should("be.visible");

    cy.then(() => {
      for (const actionId of [alphaActionId, betaActionId]) {
        cy.get(`[data-cy="recording-action-node"][data-action-id="${actionId}"]`)
          .find('[data-cy="recording-flow-manual-select"]')
          .check({ force: true });
      }
    });
    cy.get('[data-cy="recording-manual-title"]').clear().type("P0 public controls");
    cy.get('[data-cy="recording-manual-controls"]').click();
    cy.wait("@createManualStep").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      expect(response?.body.action).to.include({ type: "manualStep", title: "P0 public controls" });
    });

    cy.get('[data-cy="recording-generate"]').click();
    cy.get('[data-cy="recording-output-drawer"]').should("be.visible");
    cy.get('[data-cy="recording-code-preview"]').should("contain.text", "manual.wait");
    cy.get('[data-cy="recording-output-drawer"]').should("not.contain.text", CANARY);
    cy.get('[data-cy="recording-validate-save"]').click();

    cy.wait("@saveRecording").then((interception) => {
      const body = interception.request.body as { content?: string; filename?: string };
      expect(body.filename).to.match(/^recording-tab-\d+\.mjs$/);
      expect(body.content).to.contain("manual.wait");
      expect(body.content).not.to.contain(CANARY);
      savedFilename = body.filename ?? "";
    });
    cy.get('[data-cy="recording-save-success"]').should("contain.text", "已保存为");

    cy.get('[data-cy="recording-output-drawer"] button[aria-label="关闭代码抽屉"]').click();
    cy.get('[data-cy="recording-return-tabs"]').click();
    cy.location("pathname").should("eq", "/tabs");
    fixtureCard()
      .find('[data-cy="tab-selected-script"]')
      .should(($selected) => expect($selected.text().trim()).to.equal(savedFilename));

    cy.task<PrivacySnapshot>("p0:privacySnapshot", CANARY).then((snapshot) => {
      expect(snapshot.canaryHits).to.deep.equal([]);
    });
    cy.task<RuntimeState>("p0:runtimeState").then((state) => {
      expect(state.scripts.some((name) => /^recording-tab-\d+\.mjs$/.test(name))).to.equal(true);
    });
  });
});
