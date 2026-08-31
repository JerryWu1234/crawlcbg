const BACKGROUND_EXECUTION_STORAGE_KEY = "crawlcbg.tabs.background-execution";

beforeEach(() => {
  cy.task("p0:reset");
});

Cypress.on("window:before:load", (window) => {
  if (!Cypress.spec.name.endsWith(".p0.cy.ts")) {
    window.localStorage.removeItem(BACKGROUND_EXECUTION_STORAGE_KEY);
  }
});
