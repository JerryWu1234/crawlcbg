import type { Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vite-plus/test";
import { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import type { BrowserRecorderOptions } from "./browser-recorder.js";
import { RecordingCoordinator, RecordingCoordinatorError } from "./recording-coordinator.js";
import type { RecordedAction, RecordingStreamEvent } from "./recording-types.js";

const rootPage = {
  url: () => "https://example.com",
  sendCDP: vi.fn(async () => ({})),
};

const createHarness = () => {
  const executionCoordinator = new ExecutionCoordinator();
  const stopRecorder = vi.fn(async () => undefined);
  let recorderOptions: BrowserRecorderOptions | null = null;
  const getStagehand = vi.fn(async () => ({}) as Stagehand);
  const coordinator = new RecordingCoordinator({
    executionCoordinator,
    getStagehand,
    getUserVisiblePages: async () => [rootPage],
    recorderFactory: async (options) => {
      recorderOptions = options;
      return { stop: stopRecorder };
    },
    createId: () => "recording-test",
  });
  const requireRecorderOptions = (): BrowserRecorderOptions => {
    if (!recorderOptions) throw new Error("Recorder has not started.");
    return recorderOptions;
  };
  return {
    coordinator,
    executionCoordinator,
    getStagehand,
    requireRecorderOptions,
    stopRecorder,
  };
};

const popupClick: RecordedAction = {
  id: "action-1",
  order: 1,
  pageId: "page0",
  type: "click",
  selector: "#details",
  included: true,
};

const popupFill: RecordedAction = {
  id: "action-2",
  order: 2,
  pageId: "page1",
  type: "fill",
  selector: "#quantity",
  value: "2",
  included: true,
};

describe("RecordingCoordinator", () => {
  it("holds an exclusive recording lease and releases it after an idempotent stop", async () => {
    const harness = createHarness();
    await harness.coordinator.start(0, "https://example.com");

    const blockedExecution = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-during-recording",
    );
    expect(blockedExecution).toEqual({
      acquired: false,
      conflict: { kind: "recording", ownerId: "recording-test" },
    });

    const firstStop = await harness.coordinator.stop("recording-test");
    const secondStop = await harness.coordinator.stop("recording-test");
    expect(firstStop.status).toBe("stopped");
    expect(secondStop).toEqual(firstStop);
    expect(harness.stopRecorder).toHaveBeenCalledOnce();

    const execution = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-after-recording",
    );
    expect(execution.acquired).toBe(true);
    if (execution.acquired) harness.executionCoordinator.releaseBrowserActivity(execution.lease);
  });

  it("atomically cascades excluded popup actions, including actions arriving later", async () => {
    const harness = createHarness();
    await harness.coordinator.start(0, "https://example.com");
    const events: RecordingStreamEvent[] = [];
    harness.coordinator.subscribe("recording-test", (event) => events.push(event));
    const recorder = harness.requireRecorderOptions();

    await recorder.onAction(popupClick);
    harness.coordinator.updateActionIncluded("recording-test", popupClick.id, false);
    await recorder.onPageOpened({
      id: "page1",
      url: "https://example.com/details",
      openerPageId: "page0",
    });
    await recorder.onActionUpdated?.({ ...popupClick, opensPageId: "page1" });
    await recorder.onAction(popupFill);

    let snapshot = harness.coordinator.get("recording-test");
    expect(snapshot.actions.find((action) => action.id === popupClick.id)).toMatchObject({
      included: false,
      opensPageId: "page1",
    });
    expect(snapshot.actions.find((action) => action.id === popupFill.id)?.included).toBe(false);
    expect(() =>
      harness.coordinator.updateActionIncluded("recording-test", popupFill.id, true),
    ).toThrowError(
      expect.objectContaining<Partial<RecordingCoordinatorError>>({
        code: "parent_action_excluded",
        statusCode: 409,
      }),
    );

    harness.coordinator.updateActionIncluded("recording-test", popupClick.id, true);
    harness.coordinator.updateActionIncluded("recording-test", popupFill.id, true);
    const cascaded = harness.coordinator.updateActionIncluded(
      "recording-test",
      popupClick.id,
      false,
    );
    expect(cascaded.updatedActions.map((action) => action.id)).toEqual([
      popupClick.id,
      popupFill.id,
    ]);

    await recorder.onAction({
      id: "action-3",
      order: 3,
      pageId: "page0",
      type: "fill",
      selector: "#search",
      value: "public query",
      included: true,
    });
    await harness.coordinator.stop("recording-test");
    const code = harness.coordinator.generate("recording-test");
    expect(code).toContain('pace.fill(page0.locator("#search").first(), "public query")');
    expect(code).not.toContain("page1");

    snapshot = harness.coordinator.get("recording-test");
    expect(snapshot.status).toBe("stopped");
    expect(events.some((event) => event.type === "page-opened")).toBe(true);
    expect(events.filter((event) => event.type === "action-updated").length).toBeGreaterThan(2);
    expect(events.at(-1)?.type).toBe("stopped");
  });

  it("rejects execution conflicts and releases its lease after target validation failure", async () => {
    const harness = createHarness();
    const execution = harness.executionCoordinator.acquireBrowserActivity("execution", "run-1");
    expect(execution.acquired).toBe(true);

    await expect(harness.coordinator.start(0, "https://example.com")).rejects.toMatchObject({
      code: "execution_busy",
      statusCode: 409,
    });
    expect(harness.getStagehand).not.toHaveBeenCalled();
    if (execution.acquired) harness.executionCoordinator.releaseBrowserActivity(execution.lease);

    await expect(harness.coordinator.start(0, "https://changed.example.com")).rejects.toMatchObject(
      {
        code: "target_not_found",
        statusCode: 409,
      },
    );
    const afterFailure = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-after-failure",
    );
    expect(afterFailure.acquired).toBe(true);
  });
});

it("previews, creates, locks, compiles, and dissolves a pagination loop", async () => {
  const harness = createHarness();
  await harness.coordinator.start(0, "https://example.com");
  const recorder = harness.requireRecorderOptions();
  const loopActions: RecordedAction[] = [
    {
      id: "entry",
      order: 1,
      pageId: "page0",
      type: "click",
      selector: "#first-result",
      structuralSelector: "body > main > ul.results > li.result:nth-of-type(1) > a.result-link",
      included: true,
    },
    {
      id: "body",
      order: 2,
      pageId: "page0",
      type: "fill",
      selector: "#note",
      value: "reviewed",
      included: true,
    },
    {
      id: "next",
      order: 3,
      pageId: "page0",
      type: "click",
      selector: "#next",
      included: true,
    },
    {
      id: "after",
      order: 4,
      pageId: "page0",
      type: "click",
      selector: "#done",
      included: true,
    },
  ];
  for (const action of loopActions) await recorder.onAction(action);

  const selection = {
    actionIds: ["entry", "body", "next"],
    listEntryActionId: "entry",
    nextActionId: "next",
  };
  expect(() => harness.coordinator.previewPaginationLoop("recording-test", selection)).toThrowError(
    expect.objectContaining<Partial<RecordingCoordinatorError>>({
      code: "recording_not_stopped",
      statusCode: 409,
    }),
  );

  await harness.coordinator.stop("recording-test");
  expect(() =>
    harness.coordinator.previewPaginationLoop("recording-test", {
      ...selection,
      actionIds: ["entry", "next"],
    }),
  ).toThrowError(
    expect.objectContaining<Partial<RecordingCoordinatorError>>({
      code: "invalid_pagination_loop_range",
      statusCode: 422,
    }),
  );

  const preview = harness.coordinator.previewPaginationLoop("recording-test", selection);
  expect(preview).toEqual({
    ...selection,
    candidates: [
      {
        candidateIndex: 0,
        sourceOrdinal: 1,
        listSelector: "body > main > ul.results > li.result",
        sourceItemSelector: "body > main > ul.results > li.result:nth-of-type(1)",
        itemSelectorTemplate: "body > main > ul.results > li.result:nth-of-type({{itemOrdinal}})",
      },
    ],
  });

  const created = harness.coordinator.createPaginationLoop("recording-test", {
    ...selection,
    candidateIndex: 0,
    maxPages: 100,
  });
  expect(created.paginationLoop).toMatchObject({
    actionIds: selection.actionIds,
    listEntryActionId: "entry",
    nextActionId: "next",
    maxPages: 100,
  });
  expect(() =>
    harness.coordinator.updateActionIncluded("recording-test", "body", false),
  ).toThrowError(
    expect.objectContaining<Partial<RecordingCoordinatorError>>({
      code: "pagination_loop_action_locked",
      statusCode: 409,
    }),
  );
  expect(harness.coordinator.generate("recording-test")).toContain("clickNextAndWaitForChange");

  const dissolved = harness.coordinator.dissolvePaginationLoop("recording-test");
  expect(dissolved.paginationLoop).toBeUndefined();
  expect(dissolved.actions.map((action) => action.id)).toEqual(["entry", "body", "next", "after"]);
  expect(
    harness.coordinator.updateActionIncluded("recording-test", "body", false).action.included,
  ).toBe(false);
});

it("blocks excluding a popup opener whose descendant page contains the loop", async () => {
  const harness = createHarness();
  await harness.coordinator.start(0, "https://example.com");
  const recorder = harness.requireRecorderOptions();
  await recorder.onAction(popupClick);
  await recorder.onPageOpened({
    id: "page1",
    url: "https://example.com/details",
    openerPageId: "page0",
  });
  await recorder.onActionUpdated?.({ ...popupClick, opensPageId: "page1" });
  await recorder.onAction({
    id: "action-2",
    order: 2,
    pageId: "page1",
    type: "click",
    selector: "#first-result",
    structuralSelector: "body > ul.results > li.result:nth-of-type(1) > a",
    included: true,
  });
  await recorder.onAction({
    id: "action-3",
    order: 3,
    pageId: "page1",
    type: "fill",
    selector: "#note",
    value: "reviewed",
    included: true,
  });
  await recorder.onAction({
    id: "action-4",
    order: 4,
    pageId: "page1",
    type: "click",
    selector: "#next",
    included: true,
  });
  await harness.coordinator.stop("recording-test");

  harness.coordinator.createPaginationLoop("recording-test", {
    actionIds: ["action-2", "action-3", "action-4"],
    listEntryActionId: "action-2",
    nextActionId: "action-4",
    candidateIndex: 0,
    maxPages: 100,
  });

  expect(() =>
    harness.coordinator.updateActionIncluded("recording-test", popupClick.id, false),
  ).toThrowError(
    expect.objectContaining<Partial<RecordingCoordinatorError>>({
      code: "pagination_loop_action_locked",
      statusCode: 409,
    }),
  );
  const snapshot = harness.coordinator.get("recording-test");
  expect(snapshot.actions.every((action) => action.included)).toBe(true);
  expect(snapshot.paginationLoop?.actionIds).toEqual(["action-2", "action-3", "action-4"]);
  expect(harness.coordinator.generate("recording-test")).toContain("clickNextAndWaitForChange");
});
