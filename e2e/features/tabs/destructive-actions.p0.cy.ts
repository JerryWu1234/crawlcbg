export {};

interface RuntimeState {
  pinnedIds: string[];
}

describe("P0 pinned-tab deletion", () => {
  beforeEach(() => {
    cy.visit("/tabs");
    cy.contains(".pinned-card", "P0 pinned delete target").should("be.visible");
  });

  it("honors cancellation and removes only the confirmed preset from persistent storage", () => {
    cy.window().then((window) => {
      let confirmationCount = 0;
      cy.stub(window, "confirm")
        .callsFake(() => {
          confirmationCount += 1;
          return confirmationCount % 2 === 0;
        })
        .as("confirm");
    });

    cy.contains(".pinned-card", "P0 pinned delete target")
      .find('button[title="移除此常驻预设"]')
      .click();
    cy.task<RuntimeState>("p0:runtimeState").its("pinnedIds").should("include", "p0-pin-delete");

    cy.contains(".pinned-card", "P0 pinned delete target")
      .find('button[title="移除此常驻预设"]')
      .click();
    cy.contains(".pinned-card", "P0 pinned delete target").should("not.exist");
    cy.contains(".pinned-card", "P0 pinned sentinel").should("be.visible");
    cy.task<RuntimeState>("p0:runtimeState").its("pinnedIds").should("deep.equal", ["p0-pin-keep"]);
  });
});
