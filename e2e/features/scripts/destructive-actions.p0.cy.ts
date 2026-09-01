export {};

interface RuntimeState {
  historyIds: string[];
  scripts: string[];
  traces: string[];
}

const runtimeState = () => cy.task<RuntimeState>("p0:runtimeState");
const targetScriptItem = () => cy.contains(".file-item", "p0-delete-target.mjs");

const installAlternatingConfirmations = () => {
  cy.window().then((window) => {
    let confirmationCount = 0;
    cy.stub(window, "confirm")
      .callsFake(() => {
        confirmationCount += 1;
        return confirmationCount % 2 === 0;
      })
      .as("confirm");
  });
};

describe("P0 script, history, and trace deletion", () => {
  beforeEach(() => {
    cy.visit("/scripts");
    targetScriptItem().should("be.visible");
  });

  it("honors cancellation and deletes only the selected script", () => {
    installAlternatingConfirmations();

    targetScriptItem().find('button[title="删除脚本"]').click({ force: true });
    runtimeState().then((state) => {
      expect(state.scripts).to.include("p0-delete-target.mjs");
    });

    targetScriptItem().find('button[title="删除脚本"]').click({ force: true });
    targetScriptItem().should("not.exist");
    runtimeState().then((state) => {
      expect(state.scripts).not.to.include("p0-delete-target.mjs");
      expect(state.scripts).to.include("p0-keep.mjs");
      expect(state.historyIds).to.have.length(3);
      expect(state.traces).to.have.length(3);
    });
  });

  it("honors cancellation for single and batch history deletion and preserves the sentinel", () => {
    targetScriptItem().click();
    cy.get('button[title="查看代码修改历史与运行 Trace 轨迹"]').click();
    cy.contains(".history-card", "P0 history single target").should("be.visible");
    installAlternatingConfirmations();

    cy.contains(".history-card", "P0 history single target").contains("button", "删除快照").click();
    runtimeState().its("historyIds").should("include", "1700000000001");

    cy.contains(".history-card", "P0 history single target").contains("button", "删除快照").click();
    cy.contains(".history-card", "P0 history single target").should("not.exist");

    cy.contains(".history-card", "P0 history batch target").find(".card-checkbox").check();
    cy.get(".drawer-tab-content .btn-batch-delete").click();
    runtimeState().its("historyIds").should("include", "1700000000002");

    cy.get(".drawer-tab-content .btn-batch-delete").click();
    runtimeState().then((state) => {
      expect(state.historyIds).to.deep.equal(["1700000000003"]);
      expect(state.scripts).to.include("p0-delete-target.mjs");
    });
  });

  it("honors cancellation for single and batch trace deletion and preserves the sentinel", () => {
    targetScriptItem().click();
    cy.get('button[title="查看代码修改历史与运行 Trace 轨迹"]').click();
    cy.contains("button", "运行 Trace 轨迹").click();
    cy.contains(".trace-card", "P0 trace single target").should("be.visible");
    installAlternatingConfirmations();

    cy.contains(".trace-card", "P0 trace single target").contains("button", "删除").click();
    runtimeState().its("traces").should("include", "run_1700000000001");

    cy.contains(".trace-card", "P0 trace single target").contains("button", "删除").click();
    cy.contains(".trace-card", "P0 trace single target").should("not.exist");

    cy.contains(".trace-card", "P0 trace batch target").find(".card-checkbox").check();
    cy.get(".drawer-tab-content .btn-batch-delete").click();
    runtimeState().its("traces").should("include", "run_1700000000002");

    cy.get(".drawer-tab-content .btn-batch-delete").click();
    runtimeState().its("traces").should("deep.equal", ["run_1700000000003"]);
  });

  it("rejects traversal and non-trace identifiers before any destructive filesystem access", () => {
    cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
      if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
      cy.request({
        body: { filename: "p0-delete-target.mjs", historyId: "../../p0-keep" },
        failOnStatusCode: false,
        method: "POST",
        url: `${apiBaseUrl}/api/scripts/history/delete`,
      })
        .its("status")
        .should("equal", 400);
      cy.request({
        body: {
          filename: "p0-delete-target.mjs",
          historyIds: ["1700000000003", "../../p0-keep"],
        },
        failOnStatusCode: false,
        method: "POST",
        url: `${apiBaseUrl}/api/scripts/history/batch-delete`,
      })
        .its("status")
        .should("equal", 400);
      cy.request({
        body: { runId: "not-a-trace" },
        failOnStatusCode: false,
        method: "POST",
        url: `${apiBaseUrl}/api/traces/delete`,
      })
        .its("status")
        .should("equal", 400);
      cy.request({
        body: { runIds: ["run_1700000000003", "not-a-trace"] },
        failOnStatusCode: false,
        method: "POST",
        url: `${apiBaseUrl}/api/traces/batch-delete`,
      })
        .its("status")
        .should("equal", 400);
    });
    runtimeState().then((state) => {
      expect(state.scripts).to.include("p0-delete-target.mjs");
      expect(state.scripts).to.include("p0-keep.mjs");
      expect(state.historyIds).to.deep.equal(["1700000000001", "1700000000002", "1700000000003"]);
      expect(state.traces).to.deep.equal([
        "run_1700000000001",
        "run_1700000000002",
        "run_1700000000003",
      ]);
    });
  });
});
