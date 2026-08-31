export const getApiBaseUrl = (): Cypress.Chainable<string> =>
  cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) {
      throw new Error("缺少 Cypress API base URL。");
    }
    return apiBaseUrl.replace(/\/+$/, "");
  });

export const stubHealth = () =>
  getApiBaseUrl().then((apiBaseUrl) =>
    cy
      .intercept("GET", `${apiBaseUrl}/health`, {
        statusCode: 200,
        body: { status: "OK", timestamp: "2026-01-01T00:00:00.000Z" },
      })
      .as("health"),
  );

export const stubTabs = (delay = 0) =>
  getApiBaseUrl().then((apiBaseUrl) =>
    cy
      .intercept("GET", `${apiBaseUrl}/api/tabs`, {
        statusCode: 200,
        delay,
        body: { tabs: [], total: 0 },
      })
      .as("tabs"),
  );

export const stubPinnedTabs = () =>
  getApiBaseUrl().then((apiBaseUrl) =>
    cy
      .intercept("GET", `${apiBaseUrl}/api/tabs/pinned`, {
        statusCode: 200,
        body: { success: true, pinnedTabs: [] },
      })
      .as("pinnedTabs"),
  );

export const stubScripts = () =>
  getApiBaseUrl().then((apiBaseUrl) =>
    cy
      .intercept("GET", `${apiBaseUrl}/api/scripts`, {
        statusCode: 200,
        body: { scripts: [], total: 0 },
      })
      .as("scripts"),
  );

export const stubDatabaseTables = () =>
  getApiBaseUrl().then((apiBaseUrl) =>
    cy
      .intercept("GET", `${apiBaseUrl}/api/db/tables`, {
        statusCode: 200,
        body: { success: true, tables: [] },
      })
      .as("databaseTables"),
  );

export const stubEmptyAppApis = (options: { tabsDelay?: number } = {}) => {
  stubHealth();
  stubTabs(options.tabsDelay);
  stubPinnedTabs();
  stubScripts();
  stubDatabaseTables();
};
