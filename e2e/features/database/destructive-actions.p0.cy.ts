export {};

interface RuntimeState {
  dbCounts: Record<string, number>;
}

const runtimeState = () => cy.task<RuntimeState>("p0:runtimeState");

const DELETE_ROW_PROMPT = "确认要删除此条记录 (id = 1) 吗？";
const CLEAR_TABLE_PROMPT = "确认要清空数据表 'e2e_clear' 中的所有数据吗？";

const installConfirmations = () => {
  const responses = new Map<string, boolean[]>([
    [DELETE_ROW_PROMPT, [false, true]],
    [CLEAR_TABLE_PROMPT, [false, true]],
  ]);

  cy.window().then((window) => {
    cy.stub(window, "confirm")
      .callsFake((message?: string) => {
        const response = responses.get(message ?? "")?.shift();
        if (typeof response !== "boolean") {
          throw new Error(`收到非预期确认提示：${message ?? "(missing message)"}`);
        }
        return response;
      })
      .as("confirm");
  });
};

describe("P0 database destructive actions", () => {
  beforeEach(() => {
    cy.visit("/database");
    cy.contains(".table-tab-btn", "e2e_rows").should("be.visible");
  });

  it("honors cancellation, deletes one row, clears one table, and preserves sentinels", () => {
    installConfirmations();
    cy.intercept("POST", "**/api/db/delete-row").as("deleteRow");
    cy.intercept("POST", "**/api/db/clear").as("clearTable");

    runtimeState().its("dbCounts").should("deep.equal", {
      e2e_clear: 2,
      e2e_keep: 1,
      e2e_rows: 2,
    });

    cy.contains(".table-tab-btn", "e2e_rows").click();
    cy.contains(".data-row", "P0 row delete target").find('button[title="删除此行记录"]').click();
    cy.get("@confirm").should("have.been.calledOnceWith", DELETE_ROW_PROMPT);
    cy.get("@deleteRow.all").should("have.length", 0);
    runtimeState().its("dbCounts.e2e_rows").should("equal", 2);

    cy.contains(".data-row", "P0 row delete target").find('button[title="删除此行记录"]').click();
    cy.wait("@deleteRow").then((interception) => {
      expect(interception.request.body).to.deep.equal({
        primaryKey: "id",
        primaryValue: 1,
        table: "e2e_rows",
      });
      expect(interception.response?.statusCode).to.equal(200);
    });
    cy.get("@confirm").its("callCount").should("equal", 2);
    cy.get("@deleteRow.all").should("have.length", 1);
    cy.contains(".data-row", "P0 row delete target").should("not.exist");
    cy.contains(".data-row", "P0 row sentinel").should("be.visible");

    cy.contains(".table-tab-btn", "e2e_clear").click();
    cy.get('button[title="清空表"]').click();
    cy.get("@confirm").its("callCount").should("equal", 3);
    cy.get("@clearTable.all").should("have.length", 0);
    runtimeState().its("dbCounts.e2e_clear").should("equal", 2);

    cy.get('button[title="清空表"]').click();
    cy.wait("@clearTable").then((interception) => {
      expect(interception.request.body).to.deep.equal({ table: "e2e_clear" });
      expect(interception.response?.statusCode).to.equal(200);
    });
    cy.get("@confirm").its("callCount").should("equal", 4);
    cy.get("@clearTable.all").should("have.length", 1);
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
