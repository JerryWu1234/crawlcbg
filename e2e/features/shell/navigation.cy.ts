import { stubEmptyAppApis } from "../../support/api-stubs";

describe("Application navigation", () => {
  it("redirects to Tabs and lets the user navigate across the main features", () => {
    stubEmptyAppApis();

    cy.visit("/");

    cy.location("pathname").should("eq", "/tabs");
    cy.get("h2.page-header-title").should("have.text", "标签页管理 (Tab Manager)");
    cy.contains(".status-text", "后台服务连线中").should("be.visible");

    cy.get('nav a[href="/scripts"]').should("contain.text", "插件脚本管理").click();
    cy.location("pathname").should("eq", "/scripts");
    cy.get("h2.page-header-title").should("have.text", "插件脚本管理 (Script Manager)");
    cy.contains("JS / MJS 脚本列表").should("be.visible");

    cy.get('nav a[href="/database"]').should("contain.text", "SQLite 数据管理").click();
    cy.location("pathname").should("eq", "/database");
    cy.get("h2.page-header-title").should("have.text", "SQLite 数据管理 (Data Manager)");
    cy.contains("数据表总数 (Tables)").should("be.visible");
  });
});
