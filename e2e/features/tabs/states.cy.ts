import {
  getApiBaseUrl,
  stubEmptyAppApis,
  stubHealth,
  stubPinnedTabs,
  stubScripts,
} from "../../support/api-stubs";

describe("Tabs page states", () => {
  it("shows loading and then the empty state", () => {
    stubEmptyAppApis({ tabsDelay: 300 });

    cy.visit("/tabs");

    cy.contains("正在读取已打开的浏览器标签页...").should("be.visible");
    cy.wait("@tabs").its("response.statusCode").should("eq", 200);
    cy.contains("未找到匹配的标签页").should("be.visible");
    cy.contains("当前 Chrome 窗口中似乎没有打开任何标签页").should("be.visible");
  });

  it("lets the user retry after the Tabs API recovers", () => {
    let requestCount = 0;
    stubHealth();
    stubPinnedTabs();
    stubScripts();
    getApiBaseUrl().then((apiBaseUrl) => {
      cy.intercept("GET", `${apiBaseUrl}/api/tabs`, (request) => {
        requestCount += 1;
        if (requestCount === 1) {
          request.reply({
            statusCode: 503,
            statusMessage: "Service Unavailable",
            body: { error: "temporarily unavailable" },
          });
          return;
        }

        request.reply({ statusCode: 200, body: { tabs: [], total: 0 } });
      }).as("tabs");
    });

    cy.visit("/tabs");

    cy.wait("@tabs").its("response.statusCode").should("eq", 503);
    cy.contains("后台 API 连接错误").should("be.visible");
    cy.contains("button", "重试连接").click();

    cy.wait("@tabs").its("response.statusCode").should("eq", 200);
    cy.contains("后台 API 连接错误").should("not.exist");
    cy.contains("未找到匹配的标签页").should("be.visible");
  });
});
