export {};

interface RecordedActionSnapshot {
  id: string;
  selector?: string;
}

interface RecordingSnapshot {
  actions: RecordedActionSnapshot[];
  paginationLoop?: {
    actionIds: string[];
    listSelector: string;
  };
}

interface PaginationCandidate {
  candidateIndex: number;
  listSelector: string;
}

interface LoopActionIds {
  body?: string;
  entry: string;
  next: string;
}

const ENTRY_SELECTOR = '[data-testid="pagination-entry"]';
const BODY_SELECTOR = '[data-testid="pagination-body"]';
const ANCHOR_SELECTOR = '[data-testid="pagination-anchor"]';
const NEXT_SELECTOR = '[data-testid="pagination-next"]';
const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");
const recordingPanel = () => cy.get(".recording-panel");

const actionIdFor = (recording: RecordingSnapshot, selector: string): string => {
  const action = recording.actions.find((candidate) => candidate.selector === selector);
  if (!action) throw new Error(`停止响应缺少动作：${selector}`);
  return action.id;
};

const selectLoopRange = ({ entry, next }: LoopActionIds): void => {
  cy.get('[data-cy="recording-loop-start"]').select(entry);
  cy.get('[data-cy="recording-loop-next"]').select(next);
  cy.get('[data-cy="recording-loop-entry"]').select(entry);
};

const installRecordingIntercepts = (): void => {
  cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
    if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");
    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/stop`).as("stopRecording");
    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/pagination-loop/preview`).as(
      "previewPaginationLoop",
    );
    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/pagination-loop`).as(
      "createPaginationLoop",
    );
    cy.intercept("DELETE", `${apiBaseUrl}/api/recordings/*/pagination-loop`).as(
      "dissolvePaginationLoop",
    );
    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/generate`).as("generateRecording");
  });
};

describe("pagination loop recording", () => {
  beforeEach(() => {
    installRecordingIntercepts();
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
    fixtureCard().contains("button", "录制").click();
    cy.get(".stream-state").should("contain.text", "录制事件流已连接");
  });

  it("creates and dissolves a loop without including heterogeneous list rows", () => {
    cy.task<{ completed: boolean }>("p0:recordingPaginationActions", "button-loop")
      .its("completed")
      .should("equal", true);

    for (const selector of [ENTRY_SELECTOR, BODY_SELECTOR, NEXT_SELECTOR]) {
      cy.contains('[data-cy="recording-action-node"]', selector).should("exist");
    }
    cy.contains(".recording-panel button", "停止录制").click();

    cy.wait("@stopRecording").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const recording = response?.body.recording as RecordingSnapshot;
      const ids: LoopActionIds = {
        entry: actionIdFor(recording, ENTRY_SELECTOR),
        body: actionIdFor(recording, BODY_SELECTOR),
        next: actionIdFor(recording, NEXT_SELECTOR),
      };
      cy.wrap(ids).as("loopActionIds");
      selectLoopRange(ids);
    });

    cy.get('[data-cy="recording-loop-analyze"]').click();
    cy.wait("@previewPaginationLoop").then(({ request, response }) => {
      expect(response?.statusCode).to.equal(200);
      const candidates = response?.body.preview.candidates as PaginationCandidate[];
      const resultCandidate = candidates.find((candidate) =>
        candidate.listSelector.endsWith("li.result"),
      );
      expect(resultCandidate, "result cohort candidate").to.not.equal(undefined);
      expect(
        candidates.some((candidate) => /(?:^|>)\s*li$/.test(candidate.listSelector)),
        "bare li candidate",
      ).to.equal(false);
      expect(request.body.actionIds).to.have.length(3);
      cy.get(
        `[data-cy="recording-loop-candidate"][value="${resultCandidate?.candidateIndex}"]`,
      ).check();
    });

    cy.get('[data-cy="recording-loop-create"]').click();
    cy.wait("@createPaginationLoop").then(({ response }) => {
      expect(response?.statusCode).to.equal(201);
      const recording = response?.body.recording as RecordingSnapshot;
      expect(recording.paginationLoop?.actionIds).to.have.length(3);
      expect(recording.paginationLoop?.listSelector).to.match(/li\.result$/);
    });
    const parentSelector = '[data-cy="recording-pagination-node"]';
    const childSelector = '[data-cy="recording-action-node"][data-parent-node="pagination-loop"]';
    recordingPanel().find(parentSelector).should("have.length", 1);
    recordingPanel().find(childSelector).should("have.length", 3);

    // Wait for Vue Flow's topology fit animation before measuring real rendered positions.
    cy.wait(250);
    recordingPanel()
      .find(parentSelector)
      .then(($parent) => {
        const parent = $parent[0];
        if (!parent) throw new Error("缺少分页循环父节点。");

        return recordingPanel()
          .find(childSelector)
          .first()
          .then(($child) => {
            const child = $child[0];
            if (!child) throw new Error("缺少分页循环子节点。");

            const bounds = (element: Element) => {
              const rect = element.getBoundingClientRect();
              return {
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                top: rect.top,
              };
            };
            const dragTo = (element: Element, clientX: number, clientY: number) => {
              const rect = element.getBoundingClientRect();
              const startX = rect.left + rect.width / 2;
              const startY = rect.top + rect.height / 2;
              const view = element.ownerDocument.defaultView;
              if (!view) throw new Error("缺少 Vue Flow 浏览器窗口。");

              return cy
                .wrap(element)
                .trigger("mousedown", {
                  bubbles: true,
                  button: 0,
                  buttons: 1,
                  clientX: startX,
                  clientY: startY,
                  force: true,
                  view,
                })
                .then(() =>
                  cy
                    .get("body")
                    .trigger("mousemove", {
                      bubbles: true,
                      buttons: 1,
                      clientX: startX + (clientX - startX) / 2,
                      clientY: startY + (clientY - startY) / 2,
                      force: true,
                      view,
                    })
                    .trigger("mousemove", {
                      bubbles: true,
                      buttons: 1,
                      clientX,
                      clientY,
                      force: true,
                      view,
                    })
                    .trigger("mouseup", {
                      bubbles: true,
                      button: 0,
                      buttons: 0,
                      clientX,
                      clientY,
                      force: true,
                      view,
                    }),
                );
            };

            const parentBefore = bounds(parent);
            const childBefore = bounds(child);
            const parentRect = parent.getBoundingClientRect();

            return dragTo(
              parent,
              parentRect.left + parentRect.width / 2 + 80,
              parentRect.top + parentRect.height / 2 + 50,
            )
              .then(() =>
                cy.wrap(parent).should(() => {
                  const parentAfter = bounds(parent);
                  const childAfter = bounds(child);
                  const parentDeltaX = parentAfter.left - parentBefore.left;
                  const parentDeltaY = parentAfter.top - parentBefore.top;
                  const childDeltaX = childAfter.left - childBefore.left;
                  const childDeltaY = childAfter.top - childBefore.top;

                  expect(
                    Math.hypot(parentDeltaX, parentDeltaY),
                    "父节点确实移动",
                  ).to.be.greaterThan(20);
                  expect(Math.abs(parentDeltaX - childDeltaX), "父子节点横向同步").to.be.lessThan(
                    3,
                  );
                  expect(Math.abs(parentDeltaY - childDeltaY), "父子节点纵向同步").to.be.lessThan(
                    3,
                  );
                }),
              )
              .then(() => {
                const parentAfter = bounds(parent);
                return dragTo(child, parentAfter.left - 120, parentAfter.top - 120);
              })
              .then(() =>
                cy.wrap(child).should(() => {
                  const constrainedChild = bounds(child);
                  const currentParent = bounds(parent);
                  expect(constrainedChild.left, "子节点左边界").to.be.at.least(
                    currentParent.left - 2,
                  );
                  expect(constrainedChild.top, "子节点上边界").to.be.at.least(
                    currentParent.top - 2,
                  );
                  expect(constrainedChild.right, "子节点右边界").to.be.at.most(
                    currentParent.right + 2,
                  );
                  expect(constrainedChild.bottom, "子节点下边界").to.be.at.most(
                    currentParent.bottom + 2,
                  );
                }),
              );
          });
      });

    cy.get('[data-cy="recording-generate"]').click();
    cy.wait("@generateRecording").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const code = response?.body.code as string;
      expect(code).to.contain("paginationLoopItemSelectorTemplate");
      expect(code).to.contain("for (let paginationLoopPageNumber");
      expect(code).to.contain("pace.listItemOrdinals");
      expect(code).to.contain("pace.clickNextAndWaitForChange");
    });
    cy.get('[data-cy="recording-output-drawer"] button[aria-label="关闭代码抽屉"]').click();

    recordingPanel().find('[data-cy="recording-pagination-node"]').click({ force: true });
    cy.get('[data-cy="recording-loop-dissolve"]').click();
    cy.wait("@dissolvePaginationLoop").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const recording = response?.body.recording as RecordingSnapshot | undefined;
      expect(recording?.paginationLoop).to.equal(undefined);
    });
    recordingPanel().find('[data-cy="recording-pagination-node"]').should("not.exist");
    recordingPanel()
      .find('[data-cy="recording-action-node"]')
      .should("have.length", 3)
      .and("not.have.attr", "data-parent-node");
    recordingPanel()
      .find('[data-cy="recording-action-node"]')
      .then(($nodes) => {
        const actionIds = [...$nodes].map((node) => node.getAttribute("data-action-id"));
        expect(new Set(actionIds).size).to.equal(3);
      });
    for (const selector of [ENTRY_SELECTOR, BODY_SELECTOR, NEXT_SELECTOR]) {
      cy.contains('[data-cy="recording-action-node"]', selector).should("exist");
    }

    cy.get('[data-cy="recording-generate"]').click();
    cy.wait("@generateRecording").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const code = response?.body.code as string;
      expect(code).not.to.contain("paginationLoop");
      expect(code).not.to.contain("pace.listItemOrdinals");
      expect(code).not.to.contain("pace.clickNextAndWaitForChange");
      const entryIndex = code.indexOf("pagination-entry");
      const bodyIndex = code.indexOf("pagination-body");
      const nextIndex = code.indexOf("pagination-next");
      expect(entryIndex).to.be.greaterThan(-1);
      expect(bodyIndex).to.be.greaterThan(entryIndex);
      expect(nextIndex).to.be.greaterThan(bodyIndex);
      expect(code).to.contain("P0 pagination body");
    });
  });

  it("rejects same-tab anchor navigation and preserves the stopped recording", () => {
    cy.task<{ completed: boolean }>("p0:recordingPaginationActions", "same-tab-anchor")
      .its("completed")
      .should("equal", true);
    for (const selector of [ANCHOR_SELECTOR, NEXT_SELECTOR]) {
      cy.contains('[data-cy="recording-action-node"]', selector).should("exist");
    }
    cy.contains(".recording-panel button", "停止录制").click();

    cy.wait("@stopRecording").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const recording = response?.body.recording as RecordingSnapshot;
      selectLoopRange({
        entry: actionIdFor(recording, ANCHOR_SELECTOR),
        next: actionIdFor(recording, NEXT_SELECTOR),
      });
    });

    cy.get('[data-cy="recording-loop-analyze"]').click();
    cy.wait("@previewPaginationLoop").then(({ response }) => {
      expect(response?.statusCode).to.equal(422);
      expect(response?.body.code).to.equal("pagination_loop_navigation_not_supported");
    });
    cy.contains(".recording-panel .error-banner", "分页循环体不能包含原生链接导航").should(
      "be.visible",
    );
    recordingPanel().find('[data-cy="recording-pagination-node"]').should("not.exist");
    recordingPanel()
      .find('[data-cy="recording-action-node"]:not([data-parent-node])')
      .should("have.length", 2);
    for (const selector of [ANCHOR_SELECTOR, NEXT_SELECTOR]) {
      cy.contains('[data-cy="recording-action-node"]', selector).should("exist");
    }
    cy.get('[data-cy="recording-loop-create"]').should("not.exist");
  });
});
