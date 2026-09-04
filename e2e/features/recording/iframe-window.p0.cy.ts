export {};

const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

const fixtureUrl = (): Cypress.Chainable<string> =>
  cy.env(["fixtureUrl"]).then(({ fixtureUrl: value }) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("缺少 P0 fixture URL。");
    return value;
  });

const openRecordingWorkspace = (): void => {
  fixtureCard().then(($card) => {
    const tabIndex = $card.attr("data-tab-index");
    expect(tabIndex).to.match(/^\d+$/);
    cy.wrap($card).find('[data-cy="record-tab"]').click();
    cy.location("pathname").should("eq", `/tabs/${tabIndex}/recording`);
  });
  cy.get('[data-cy="recording-page-preview"]').should("be.visible");
  cy.get(".stream-state").should("contain.text", "录制事件流已连接");
};

const stopRecording = (): void => {
  cy.contains(".recording-panel button", "停止录制").click();
  cy.contains(".recording-panel", "录制已停止").should("be.visible");
};

describe("recording iframe page preview", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
  });

  it("previews the selected page and follows a popup page", () => {
    fixtureUrl().then((rootUrl) => {
      const popupUrl = new URL("/popup", rootUrl).href;

      openRecordingWorkspace();
      cy.get('[data-cy="recording-page-chip"][data-page-id="page0"]')
        .should("have.attr", "aria-pressed", "true")
        .and("contain.text", rootUrl);
      cy.get('[data-cy="recording-page-url"]').should("have.text", rootUrl);
      cy.get('[data-cy="recording-page-frame"]').should("have.attr", "src", rootUrl);
      cy.get('[data-cy="recording-page-open-new-tab"]').should("have.attr", "href", rootUrl);

      cy.task<{ popupOpened: boolean }>("p0:recordingOpenPopup")
        .its("popupOpened")
        .should("equal", true);
      cy.contains('[data-cy="recording-page-chip"]', popupUrl)
        .should("be.visible")
        .click()
        .should("have.attr", "aria-pressed", "true");
      cy.get('[data-cy="recording-page-url"]').should("have.text", popupUrl);
      cy.get('[data-cy="recording-page-frame"]').should("have.attr", "src", popupUrl);
      cy.get('[data-cy="recording-page-open-new-tab"]').should("have.attr", "href", popupUrl);
      cy.get('[data-cy="recording-inspector-page"]').should("contain.text", popupUrl);

      stopRecording();
    });
  });

  it("offers an exact new-tab fallback when framing is blocked", () => {
    fixtureUrl().then((rootUrl) => {
      const blockedUrl = new URL("/blocked-frame", rootUrl).href;

      cy.request(blockedUrl).then((response) => {
        expect(response.status).to.equal(200);
        expect(response.headers["x-frame-options"]).to.equal("DENY");
        expect(response.headers["content-security-policy"]).to.contain("frame-ancestors 'none'");
      });

      openRecordingWorkspace();
      cy.task<{ blockedFrameOpened: boolean }>("p0:recordingOpenBlockedFrame")
        .its("blockedFrameOpened")
        .should("equal", true);
      cy.contains('[data-cy="recording-page-chip"]', blockedUrl)
        .should("be.visible")
        .click()
        .should("have.attr", "aria-pressed", "true");
      cy.get('[data-cy="recording-page-url"]').should("have.text", blockedUrl);
      cy.get('[data-cy="recording-page-frame"]').should("have.attr", "src", blockedUrl);
      cy.get('[data-cy="recording-page-warning"]')
        .should("be.visible")
        .and("contain.text", "X-Frame-Options")
        .and("contain.text", "frame-ancestors")
        .and("contain.text", "不是同一会话")
        .and("contain.text", "暂不由当前录制器捕获");
      cy.get('[data-cy="recording-page-open-new-tab"]').should(($link) => {
        expect($link.attr("href")).to.equal(blockedUrl);
        expect($link.attr("target")).to.equal("_blank");
        expect($link.attr("rel")?.split(/\s+/)).to.include.members(["noopener", "noreferrer"]);
      });

      stopRecording();
    });
  });
});
