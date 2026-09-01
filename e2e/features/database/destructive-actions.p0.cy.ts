export {};

interface RuntimeState {
  dbCounts: Record<string, number>;
}

const runtimeState = () => cy.task<RuntimeState>("p0:runtimeState");

const installAlternatingConfirmations = () => {
  let confirmationCount = 0;
  cy.on("window:confirm", () => {
    confirmationCount += 1;
    return confirmationCount % 2 === 0;
  });
};

describe("P0 database destructive actions", () => {
  beforeEach(() => {
    cy.visit("/database");
    cy.contains(".table-tab-btn", "e2e_rows").should("be.visible");
  });

  it("honors cancellation, deletes one row, clears one table, and preserves sentinels", () => {
    installAlternatingConfirmations();

    cy.contains(".table-tab-btn", "e2e_rows").click();
    cy.contains(".data-row", "P0 row delete target").find('button[title="删除此行记录"]').click();
    runtimeState().its("dbCounts.e2e_rows").should("equal", 2);

    cy.contains(".data-row", "P0 row delete target").find('button[title="删除此行记录"]').click();
    cy.contains(".data-row", "P0 row delete target").should("not.exist");
    cy.contains(".data-row", "P0 row sentinel").should("be.visible");

    cy.contains(".table-tab-btn", "e2e_clear").click();
    cy.get('button[title="清空表"]').click();
    runtimeState().its("dbCounts.e2e_clear").should("equal", 2);

    cy.get('button[title="清空表"]').click();
    cy.contains("当前表 e2e_clear 中没有检索到符合条件的数据").should("be.visible");
    runtimeState().then((state) => {
      expect(state.dbCounts.e2e_rows).to.equal(1);
      expect(state.dbCounts.e2e_clear).to.equal(0);
      expect(state.dbCounts.e2e_keep).to.equal(1);
    });
  });

  it("rejects stacked SQL and unknown identifiers without touching the sentinel table", () => {
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.request({
        body: { table: "e2e_clear; DROP TABLE e2e_keep; --" },
        failOnStatusCode: false,
        method: "POST",
        url: `${apiBaseUrl}/api/db/clear`,
      })
        .its("status")
        .should("equal", 400);
      cy.request({
        body: { primaryKey: "id; DROP TABLE e2e_keep; --", primaryValue: 1, table: "e2e_rows" },
        failOnStatusCode: false,
        method: "POST",
        url: `${apiBaseUrl}/api/db/delete-row`,
      })
        .its("status")
        .should("equal", 400);
    });
    runtimeState().then((state) => {
      expect(state.dbCounts.e2e_rows).to.equal(2);
      expect(state.dbCounts.e2e_clear).to.equal(2);
      expect(state.dbCounts.e2e_keep).to.equal(1);
    });
  });
});
