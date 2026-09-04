export {};

interface BrowserTabPayload {
  index: number;
  targetId: string;
  title: string;
  url: string;
}

const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");

describe("recording target identity", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
  });

  it("fails closed when the clicked CDP target is replaced by a same-URL page before startup", () => {
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.intercept("POST", `${apiBaseUrl}/api/recordings`).as("startRecording");
      cy.intercept("GET", `${apiBaseUrl}/api/tabs`, (request) => {
        request.continue((response) => {
          const replaceTarget = (tab: BrowserTabPayload): BrowserTabPayload => ({
            ...tab,
            targetId: `${tab.targetId}-replacement`,
          });
          if (Array.isArray(response.body)) {
            response.body = response.body.map(replaceTarget);
          } else if (response.body && Array.isArray(response.body.tabs)) {
            response.body = { ...response.body, tabs: response.body.tabs.map(replaceTarget) };
          }
        });
      }).as("driftedTabs");
    });

    fixtureCard().find('[data-cy="record-tab"]').click();
    cy.wait("@driftedTabs").its("response.statusCode").should("equal", 200);
    cy.get('[data-cy="recording-target-error"]')
      .should("be.visible")
      .and("contain.text", "身份发生变化")
      .and("contain.text", "不会自动录制其他页签");
    cy.get("@startRecording.all").should("have.length", 0);
  });
});
