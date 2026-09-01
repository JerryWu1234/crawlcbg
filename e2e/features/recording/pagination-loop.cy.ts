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
  cy.contains(".recording-panel .loop-fields label", "循环起点").find("select").select(entry);
  cy.contains(".recording-panel .loop-fields label", "Next（范围末步）")
    .find("select")
    .select(next);
  cy.contains(".recording-panel .loop-fields label", "列表入口点击").find("select").select(entry);
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
  });
};

describe("pagination loop recording", () => {
  beforeEach(() => {
    installRecordingIntercepts();
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
    fixtureCard().contains("button", "录制").click();
    cy.contains(".recording-panel", "实时流已连接").should("be.visible");
  });

  it("creates and dissolves a loop without including heterogeneous list rows", () => {
    cy.task<{ completed: boolean }>("p0:recordingPaginationActions", "button-loop")
      .its("completed")
      .should("equal", true);

    for (const selector of [ENTRY_SELECTOR, BODY_SELECTOR, NEXT_SELECTOR]) {
      cy.contains(".recording-panel .action-item", selector).should("be.visible");
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

    cy.contains(".recording-panel button", "分析列表结构").click();
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
      cy.get(`.candidate-option input[value="${resultCandidate?.candidateIndex}"]`).check();
    });

    cy.contains(".recording-panel button", "创建分页循环").click();
    cy.wait("@createPaginationLoop").then(({ response }) => {
      expect(response?.statusCode).to.equal(201);
      const recording = response?.body.recording as RecordingSnapshot;
      expect(recording.paginationLoop?.actionIds).to.have.length(3);
      expect(recording.paginationLoop?.listSelector).to.match(/li\.result$/);
    });
    recordingPanel().find(".pagination-loop-item").should("have.length", 1);
    recordingPanel().find(".action-list > .action-item").should("have.length", 1);

    recordingPanel().find(".pagination-loop-item summary").click();
    cy.contains(".recording-panel button", "解散循环").click();
    cy.wait("@dissolvePaginationLoop").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      const recording = response?.body.recording as RecordingSnapshot | undefined;
      expect(recording?.paginationLoop).to.equal(undefined);
    });
    recordingPanel().find(".pagination-loop-item").should("not.exist");
    recordingPanel().find(".action-list > .action-item").should("have.length", 3);
    for (const selector of [ENTRY_SELECTOR, BODY_SELECTOR, NEXT_SELECTOR]) {
      cy.contains(".recording-panel .action-item", selector).should("be.visible");
    }
  });

  it("rejects same-tab anchor navigation and preserves the stopped recording", () => {
    cy.task<{ completed: boolean }>("p0:recordingPaginationActions", "same-tab-anchor")
      .its("completed")
      .should("equal", true);
    for (const selector of [ANCHOR_SELECTOR, NEXT_SELECTOR]) {
      cy.contains(".recording-panel .action-item", selector).should("be.visible");
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

    cy.contains(".recording-panel button", "分析列表结构").click();
    cy.wait("@previewPaginationLoop").then(({ response }) => {
      expect(response?.statusCode).to.equal(422);
      expect(response?.body.code).to.equal("pagination_loop_navigation_not_supported");
    });
    cy.contains(".recording-panel .error-banner", "分页循环体不能包含原生链接导航").should(
      "be.visible",
    );
    recordingPanel().find(".pagination-loop-item").should("not.exist");
    recordingPanel().find(".action-list > .action-item").should("have.length", 2);
    for (const selector of [ANCHOR_SELECTOR, NEXT_SELECTOR]) {
      cy.contains(".recording-panel .action-item", selector).should("be.visible");
    }
    cy.contains(".recording-panel button", "创建分页循环").should("not.exist");
  });
});
