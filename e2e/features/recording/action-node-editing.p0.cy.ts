export {};

interface RecordedActionSnapshot {
  id: string;
  order: number;
  pageId: string;
  type: string;
  selector?: string;
}

interface RecordingSnapshot {
  id: string;
  actions: RecordedActionSnapshot[];
}

interface InsertActionResponse {
  action: RecordedActionSnapshot;
  recording: RecordingSnapshot;
}

interface DeleteInterceptState {
  failNext: boolean;
  requestedActionIds: string[];
}

const ENTRY_SELECTOR = '[data-testid="pagination-entry"]';
const BODY_SELECTOR = '[data-testid="pagination-body"]';
const NEXT_SELECTOR = '[data-testid="pagination-next"]';
const INSERTED_SELECTOR = '[data-testid="visible-action"]';

const fixtureCard = () => cy.contains(".tab-card", "CrawlCBG P0 Fixture");
const recordingPanel = () => cy.get(".recording-panel");
const actionNode = (actionId: string) =>
  cy.get(`[data-cy="recording-action-node"][data-action-id="${actionId}"]`);
const focusActionNode = (actionId: string): void => {
  actionNode(actionId).find(".flow-node > strong").click();
};

const actionIdFor = (recording: RecordingSnapshot, selector: string): string => {
  const action = recording.actions.find((candidate) => candidate.selector === selector);
  if (!action) throw new Error(`停止响应缺少动作：${selector}`);
  return action.id;
};

const installRecordingIntercepts = (deleteState: DeleteInterceptState): void => {
  cy.env(["apiBaseUrl"]).then(({ apiBaseUrl }) => {
    if (typeof apiBaseUrl !== "string") throw new Error("缺少 P0 API base URL。");

    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/stop`).as("stopRecording");
    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/actions`).as("insertRecordingAction");
    cy.intercept("POST", `${apiBaseUrl}/api/recordings/*/generate`).as("generateRecording");
    cy.intercept("DELETE", `${apiBaseUrl}/api/recordings/*/actions/*`, (request) => {
      const encodedActionId = new URL(request.url).pathname.split("/").at(-1) ?? "";
      deleteState.requestedActionIds.push(decodeURIComponent(encodedActionId));
      if (deleteState.failNext) {
        deleteState.failNext = false;
        request.reply({
          statusCode: 503,
          body: { error: "temporary delete failure" },
        });
        return;
      }
      request.continue();
    }).as("deleteRecordingAction");
  });
};

const recordAndStop = (): Cypress.Chainable<RecordingSnapshot> =>
  cy
    .task<{ completed: boolean }>("p0:recordingPaginationActions", "button-loop")
    .then(({ completed }) => {
      expect(completed).to.equal(true);
      for (const selector of [ENTRY_SELECTOR, BODY_SELECTOR, NEXT_SELECTOR]) {
        cy.contains('[data-cy="recording-action-node"]', selector).should("exist");
      }
      cy.contains(".recording-panel button", "停止录制").click();
      return cy.wait("@stopRecording").then(({ response }) => {
        expect(response?.statusCode).to.equal(200);
        const recording = response?.body.recording as RecordingSnapshot | undefined;
        if (!recording) throw new Error("停止接口缺少 recording 快照。");
        expect(recording.id).to.match(/\S/);
        expect(recording.actions.length).to.be.at.least(3);
        return recording;
      });
    });

const insertVisibleClick = (entryActionId: string): Cypress.Chainable<InsertActionResponse> => {
  focusActionNode(entryActionId);
  cy.get('[data-cy="recording-inspector-insert-after"]')
    .should("be.enabled")
    .and("have.attr", "data-anchor-action-id", entryActionId)
    .click();
  cy.get('[data-cy="recording-action-editor"]').should("be.visible");
  cy.get('[data-cy="recording-action-type"]').select("click");
  cy.get('[data-cy="recording-action-selector"]').type(INSERTED_SELECTOR);
  cy.get('[data-cy="recording-action-submit"]').should("be.enabled").click();

  return cy.wait("@insertRecordingAction").then(({ request, response }) => {
    expect(response?.statusCode).to.equal(201);
    expect(request.body).to.deep.equal({
      afterActionId: entryActionId,
      action: { type: "click", selector: INSERTED_SELECTOR },
    });
    const payload = response?.body as InsertActionResponse | undefined;
    if (!payload?.action || !payload.recording) {
      throw new Error("新增动作接口缺少权威 recording/action 快照。");
    }
    expect(payload.action.id).to.match(/\S/);
    expect(payload.action.selector).to.equal(INSERTED_SELECTOR);

    const ordered = [...payload.recording.actions].sort((left, right) => left.order - right.order);
    const entryIndex = ordered.findIndex((action) => action.id === entryActionId);
    const insertedIndex = ordered.findIndex((action) => action.id === payload.action.id);
    const bodyIndex = ordered.findIndex((action) => action.selector === BODY_SELECTOR);
    const nextIndex = ordered.findIndex((action) => action.selector === NEXT_SELECTOR);
    expect(insertedIndex).to.equal(entryIndex + 1);
    expect(bodyIndex).to.be.greaterThan(insertedIndex);
    expect(nextIndex).to.be.greaterThan(bodyIndex);
    return payload;
  });
};

const generateCode = (): Cypress.Chainable<string> => {
  cy.get('[data-cy="recording-generate"]').should("be.enabled").click();
  return cy.wait("@generateRecording").then(({ response }) => {
    expect(response?.statusCode).to.equal(200);
    const code = response?.body.code as string | undefined;
    if (typeof code !== "string") throw new Error("生成接口缺少 code。");
    return code;
  });
};

const closeOutputDrawer = (): void => {
  cy.get('[data-cy="recording-output-drawer"]')
    .should("be.visible")
    .find('button[aria-label="关闭代码抽屉"]')
    .click();
};

const openDeleteDialog = (actionId: string): void => {
  focusActionNode(actionId);
  cy.get('[data-cy="recording-action-delete"]').should("be.enabled").click();
  cy.get('[data-cy="recording-action-delete-dialog"]')
    .should("be.visible")
    .and("have.attr", "data-action-id", actionId);
};

const assertCodeOrder = (code: string): void => {
  const entryIndex = code.indexOf("pagination-entry");
  const insertedIndex = code.indexOf("visible-action");
  const bodyIndex = code.indexOf("pagination-body");
  const nextIndex = code.indexOf("pagination-next");
  expect(entryIndex).to.be.greaterThan(-1);
  expect(insertedIndex).to.be.greaterThan(entryIndex);
  expect(bodyIndex).to.be.greaterThan(insertedIndex);
  expect(nextIndex).to.be.greaterThan(bodyIndex);
};

describe("recording action node editing", () => {
  let deleteState: DeleteInterceptState;

  beforeEach(() => {
    deleteState = { failNext: false, requestedActionIds: [] };
    installRecordingIntercepts(deleteState);
    cy.visit("/tabs");
    fixtureCard().should("be.visible");
    fixtureCard().contains("button", "录制").click();
    cy.get(".stream-state").should("contain.text", "录制事件流已连接");
  });

  it("inserts an action in order and restores the generated code after deletion", () => {
    let stoppedRecording: RecordingSnapshot;
    let entryActionId = "";
    let insertedActionId = "";
    let baselineCode = "";

    recordAndStop().then((recording) => {
      stoppedRecording = recording;
      entryActionId = actionIdFor(recording, ENTRY_SELECTOR);
    });
    generateCode().then((code) => {
      baselineCode = code;
    });
    closeOutputDrawer();

    cy.then(() => insertVisibleClick(entryActionId)).then(({ action, recording }) => {
      insertedActionId = action.id;
      expect(recording.id).to.equal(stoppedRecording.id);
      actionNode(insertedActionId).should("exist");
    });

    generateCode().then((code) => {
      assertCodeOrder(code);
    });
    closeOutputDrawer();

    cy.then(() => openDeleteDialog(insertedActionId));
    cy.get('[data-cy="recording-action-delete-confirm"]').click();
    cy.wait("@deleteRecordingAction").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      expect(response?.body.removedActionIds).to.deep.equal([insertedActionId]);
      const recording = response?.body.recording as RecordingSnapshot;
      expect(recording.actions.some((action) => action.id === insertedActionId)).to.equal(false);
    });

    cy.then(() => {
      expect(deleteState.requestedActionIds).to.deep.equal([insertedActionId]);
      actionNode(insertedActionId).should("not.exist");
      for (const action of stoppedRecording.actions) actionNode(action.id).should("exist");
    });
    generateCode().then((code) => {
      expect(code).to.equal(baselineCode);
      expect(code).not.to.contain("visible-action");
    });
  });

  it("keeps the node and generated code through cancellation and a transient delete failure", () => {
    let stoppedRecording: RecordingSnapshot;
    let entryActionId = "";
    let insertedActionId = "";
    let generatedCode = "";

    recordAndStop().then((recording) => {
      stoppedRecording = recording;
      entryActionId = actionIdFor(recording, ENTRY_SELECTOR);
    });
    cy.then(() => insertVisibleClick(entryActionId)).then(({ action }) => {
      insertedActionId = action.id;
    });
    generateCode().then((code) => {
      generatedCode = code;
      expect(code).to.contain("visible-action");
    });
    closeOutputDrawer();

    cy.then(() => openDeleteDialog(insertedActionId));
    cy.get('[data-cy="recording-action-delete-cancel"]').click();
    cy.get('[data-cy="recording-action-delete-dialog"]').should("not.exist");
    cy.then(() => {
      expect(deleteState.requestedActionIds).to.deep.equal([]);
      actionNode(insertedActionId).should("exist");
    });

    cy.then(() => openDeleteDialog(insertedActionId));
    cy.then(() => {
      deleteState.failNext = true;
    });
    cy.get('[data-cy="recording-action-delete-confirm"]').click();
    cy.wait("@deleteRecordingAction").then(({ response }) => {
      expect(response?.statusCode).to.equal(503);
      expect(response?.body.error).to.equal("temporary delete failure");
    });

    cy.contains(".recording-panel .error-banner", "temporary delete failure").should("be.visible");
    cy.then(() => {
      actionNode(insertedActionId).should("exist");
      for (const action of stoppedRecording.actions) actionNode(action.id).should("exist");
      cy.get('[data-cy="recording-action-delete-dialog"]')
        .should("be.visible")
        .and("have.attr", "data-action-id", insertedActionId);
    });
    cy.get('[data-cy="recording-view-output"]').should("be.enabled").click();
    cy.get('[data-cy="recording-code-preview"] pre code')
      .invoke("text")
      .should((code) => expect(code).to.equal(generatedCode));
    closeOutputDrawer();

    cy.get('[data-cy="recording-action-delete-confirm"]').should("be.enabled").click();
    cy.wait("@deleteRecordingAction").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      expect(response?.body.removedActionIds).to.deep.equal([insertedActionId]);
      const recording = response?.body.recording as RecordingSnapshot;
      expect(recording.actions.some((action) => action.id === insertedActionId)).to.equal(false);
      expect(recording.actions.map((action) => action.id)).to.have.members(
        stoppedRecording.actions.map((action) => action.id),
      );
    });

    cy.then(() => {
      expect(deleteState.requestedActionIds).to.deep.equal([insertedActionId, insertedActionId]);
      actionNode(insertedActionId).should("not.exist");
      for (const action of stoppedRecording.actions) actionNode(action.id).should("exist");
      recordingPanel()
        .find('[data-cy="recording-action-node"]')
        .should("have.length", stoppedRecording.actions.length);
    });
    cy.get('[data-cy="recording-action-delete-dialog"]').should("not.exist");
  });
});
