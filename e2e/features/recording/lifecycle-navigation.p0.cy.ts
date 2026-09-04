export {};

const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

const openWorkspace = (): void => {
  fixtureCard().find('[data-cy="record-tab"]').click();
  cy.location("pathname").should("match", /^\/tabs\/\d+\/recording$/);
};

const confirmNavigation = (): void => {
  cy.on("window:confirm", () => true);
};

describe("recording navigation lifecycle", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
    confirmNavigation();
  });

  it("waits for a committed start response, stops that recording, then leaves", () => {
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.intercept("POST", `${apiBaseUrl}/api/recordings`, (request) => {
        request.continue((response) => {
          response.setDelay(1_500);
        });
      }).as("delayedStartRecording");
      cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/stop`).as("stopForNavigation");
    });

    openWorkspace();
    cy.contains(".recording-panel", "正在连接录制服务").should("be.visible");
    cy.get('.sidebar-nav a[href="/scripts"]').click();
    cy.window().then((win) => {
      expect(win.location.pathname).to.match(/^\/tabs\/\d+\/recording$/);
    });

    cy.wait("@delayedStartRecording").its("response.statusCode").should("equal", 201);
    cy.wait("@stopForNavigation").then(({ request, response }) => {
      expect(response?.statusCode).to.equal(200);
      const startedId = request.url.match(/\/api\/recordings\/([^/]+)\/stop$/)?.[1];
      expect(startedId).to.be.a("string").and.not.equal("");
    });
    cy.location("pathname").should("eq", "/scripts");

    cy.get('.sidebar-nav a[href="/tabs"]').click();
    fixtureCard().should("be.visible");
    fixtureCard().find('[data-cy="record-tab"]').click();
    cy.wait("@delayedStartRecording").its("response.statusCode").should("equal", 201);
    cy.get(".stream-state", { timeout: 15_000 }).should("contain.text", "录制事件流已连接");
    cy.contains(".recording-panel button", "停止录制").click();
    cy.wait("@stopForNavigation").its("response.statusCode").should("equal", 200);
  });

  it("awaits active recording cleanup before completing route navigation", () => {
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/stop`, (request) => {
        request.continue((response) => {
          response.setDelay(750);
        });
      }).as("stopForNavigation");
    });

    openWorkspace();
    cy.get(".stream-state", { timeout: 15_000 }).should("contain.text", "录制事件流已连接");
    cy.get('.sidebar-nav a[href="/database"]').click();
    cy.window().then((win) => {
      expect(win.location.pathname).to.match(/^\/tabs\/\d+\/recording$/);
    });
    cy.wait("@stopForNavigation").its("response.statusCode").should("equal", 200);
    cy.location("pathname").should("eq", "/database");
  });
});
