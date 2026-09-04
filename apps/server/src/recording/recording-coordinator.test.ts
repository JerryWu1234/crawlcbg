import type { Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vite-plus/test";
import { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import type { BrowserRecorderHandle, BrowserRecorderOptions } from "./browser-recorder.js";
import { RecordingCoordinator, RecordingCoordinatorError } from "./recording-coordinator.js";
import type { RecordedAction, RecordingStreamEvent } from "./recording-types.js";

const rootPage = {
  targetId: () => "target-test",
  url: () => "https://example.com",
  sendCDP: vi.fn(async () => ({})),
};

interface HarnessOptions {
  recorderFactory?: (options: BrowserRecorderOptions) => Promise<BrowserRecorderHandle>;
  getUserVisiblePages?: () => Promise<any[]>;
  orphanGraceMs?: number;
}

const createHarness = (options: HarnessOptions = {}) => {
  const executionCoordinator = new ExecutionCoordinator();
  const stopRecorder = vi.fn(async () => undefined);
  let recorderOptions: BrowserRecorderOptions | null = null;
  const getStagehand = vi.fn(async () => ({}) as Stagehand);
  const defaultRecorderFactory = async (
    recorderOptionsFromCoordinator: BrowserRecorderOptions,
  ): Promise<BrowserRecorderHandle> => {
    recorderOptions = recorderOptionsFromCoordinator;
    return { stop: stopRecorder };
  };
  const coordinator = new RecordingCoordinator({
    executionCoordinator,
    getStagehand,
    getUserVisiblePages: options.getUserVisiblePages ?? (async () => [rootPage]),
    recorderFactory: options.recorderFactory ?? defaultRecorderFactory,
    ...(options.orphanGraceMs ? { orphanGraceMs: options.orphanGraceMs } : {}),
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
    await harness.coordinator.start(0, "target-test", "https://example.com");

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
    await harness.coordinator.start(0, "target-test", "https://example.com");
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
      controlKind: "text",
      displayName: "搜索词",
      included: true,
    });
    await recorder.onAction({
      id: "action-4",
      order: 4,
      pageId: "page0",
      type: "select",
      selector: "#category",
      value: "books",
      controlKind: "select",
      displayName: "分类",
      included: true,
    });
    await recorder.onAction({
      id: "action-5",
      order: 5,
      pageId: "page0",
      type: "click",
      selector: "#custom-trigger",
      included: true,
    });
    await recorder.onAction({
      id: "action-6",
      order: 6,
      pageId: "page0",
      type: "click",
      selector: "#custom-option-secret",
      included: true,
    });
    await harness.coordinator.stop("recording-test");

    const insertedPopupAction = harness.coordinator.insertAction("recording-test", {
      afterActionId: popupFill.id,
      action: { type: "click", selector: "#inserted-popup-child" },
    });
    expect(insertedPopupAction.action).toMatchObject({
      pageId: "page1",
      included: false,
      type: "click",
      selector: "#inserted-popup-child",
    });
    const popupCode = harness.coordinator.generate("recording-test");
    expect(popupCode).not.toContain("#inserted-popup-child");
    expect(popupCode).not.toContain("page1");

    const controlsConversion = harness.coordinator.createManualStep("recording-test", {
      actionIds: ["action-3", "action-4"],
      title: "请填写搜索条件",
    });
    expect(controlsConversion.action).toMatchObject({
      id: "action-3",
      type: "manualStep",
      targets: [
        { selector: "#search", controlKind: "text", displayName: "搜索词" },
        { selector: "#category", controlKind: "select", displayName: "分类" },
      ],
    });
    expect(controlsConversion.updatedActions.map((action) => action.id)).toEqual(["action-3"]);
    expect(controlsConversion.removedActionIds).toEqual(["action-4"]);
    expect(JSON.stringify(controlsConversion)).not.toContain("public query");
    expect(JSON.stringify(controlsConversion)).not.toContain("books");

    const customConversion = harness.coordinator.createManualStep("recording-test", {
      actionIds: ["action-5", "action-6"],
      mode: "custom",
    });
    expect(customConversion.action).toMatchObject({
      id: "action-5",
      type: "manualStep",
      targets: [{ selector: "#custom-trigger", controlKind: "custom" }],
    });
    expect(customConversion.updatedActions.map((action) => action.id)).toEqual(["action-5"]);
    expect(customConversion.removedActionIds).toEqual(["action-6"]);
    expect(JSON.stringify(customConversion)).not.toContain("#custom-option-secret");

    const code = harness.coordinator.generate("recording-test");
    expect(code).toContain('manual.wait(page0, {"title":"请填写搜索条件"');
    expect(code).toContain('"selector":"#custom-trigger","controlKind":"custom"');
    expect(code).not.toContain("public query");
    expect(code).not.toContain("#custom-option-secret");
    expect(code).not.toContain("page1");

    snapshot = harness.coordinator.get("recording-test");
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.actions.map((action) => action.id)).not.toContain("action-4");
    expect(snapshot.actions.map((action) => action.id)).not.toContain("action-6");
    expect(events.some((event) => event.type === "page-opened")).toBe(true);
    expect(events.filter((event) => event.type === "action-updated").length).toBeGreaterThan(2);
    expect(events.some((event) => event.type === "stopped")).toBe(true);
  });

  it("inserts and deletes stopped actions with stable IDs and contiguous order", async () => {
    const harness = createHarness();
    await harness.coordinator.start(0, "target-test", "https://example.com");
    const recorder = harness.requireRecorderOptions();
    await recorder.onAction({
      id: "action-1",
      order: 1,
      pageId: "page0",
      type: "click",
      selector: "#first",
      included: true,
    });
    await recorder.onAction({
      id: "action-2",
      order: 2,
      pageId: "page0",
      type: "fill",
      selector: "#second",
      value: "public value",
      included: true,
    });

    expect(() =>
      harness.coordinator.insertAction("recording-test", {
        afterActionId: "action-1",
        action: { type: "click", selector: "#inserted" },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RecordingCoordinatorError>>({
        code: "recording_not_stopped",
        statusCode: 409,
      }),
    );
    expect(() => harness.coordinator.deleteAction("recording-test", "action-1")).toThrowError(
      expect.objectContaining<Partial<RecordingCoordinatorError>>({
        code: "recording_not_stopped",
        statusCode: 409,
      }),
    );

    await harness.coordinator.stop("recording-test");
    const inserted = harness.coordinator.insertAction("recording-test", {
      afterActionId: "action-1",
      action: { type: "click", selector: "#inserted" },
    });
    expect(inserted.action).toMatchObject({
      order: 2,
      pageId: "page0",
      type: "click",
      selector: "#inserted",
      included: true,
    });
    expect(inserted.action.id).toMatch(/^action-edit-/);
    expect(inserted.recording.actions.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "action-1", order: 1 },
      { id: inserted.action.id, order: 2 },
      { id: "action-2", order: 3 },
    ]);
    const code = harness.coordinator.generate("recording-test");
    expect(code.indexOf("#first")).toBeLessThan(code.indexOf("#inserted"));
    expect(code.indexOf("#inserted")).toBeLessThan(code.indexOf("#second"));

    const deleted = harness.coordinator.deleteAction("recording-test", inserted.action.id);
    expect(deleted.removedActionIds).toEqual([inserted.action.id]);
    expect(deleted.recording.actions.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "action-1", order: 1 },
      { id: "action-2", order: 2 },
    ]);
    expect(harness.coordinator.generate("recording-test")).not.toContain("#inserted");

    expect(() =>
      harness.coordinator.insertAction("recording-test", {
        afterActionId: null,
        action: {
          type: "click",
          selector: "#unsafe",
          id: "client-id",
        } as never,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RecordingCoordinatorError>>({
        code: "invalid_recording_action",
        statusCode: 400,
      }),
    );
  });

  it("protects pagination loops and popup openers from structural deletion", async () => {
    const harness = createHarness();
    await harness.coordinator.start(0, "target-test", "https://example.com");
    const recorder = harness.requireRecorderOptions();
    await recorder.onAction(popupClick);
    await recorder.onPageOpened({
      id: "page1",
      url: "https://example.com/details",
      openerPageId: "page0",
    });
    await recorder.onActionUpdated?.({ ...popupClick, opensPageId: "page1" });
    await harness.coordinator.stop("recording-test");

    expect(() => harness.coordinator.deleteAction("recording-test", popupClick.id)).toThrowError(
      expect.objectContaining<Partial<RecordingCoordinatorError>>({
        code: "popup_opener_action_locked",
        statusCode: 409,
      }),
    );
  });

  it("rejects execution conflicts and releases its lease after target validation failure", async () => {
    const harness = createHarness();
    const execution = harness.executionCoordinator.acquireBrowserActivity("execution", "run-1");
    expect(execution.acquired).toBe(true);

    await expect(
      harness.coordinator.start(0, "target-test", "https://example.com"),
    ).rejects.toMatchObject({
      code: "execution_busy",
      statusCode: 409,
    });
    expect(harness.getStagehand).not.toHaveBeenCalled();
    if (execution.acquired) harness.executionCoordinator.releaseBrowserActivity(execution.lease);

    await expect(
      harness.coordinator.start(0, "target-test", "https://changed.example.com"),
    ).rejects.toMatchObject({
      code: "target_not_found",
      statusCode: 409,
    });
    const afterFailure = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-after-failure",
    );
    expect(afterFailure.acquired).toBe(true);
  });
});

it("previews, creates, locks, compiles, and dissolves a pagination loop", async () => {
  const harness = createHarness();
  await harness.coordinator.start(0, "target-test", "https://example.com");
  const recorder = harness.requireRecorderOptions();
  const loopActions: RecordedAction[] = [
    {
      id: "entry",
      order: 1,
      pageId: "page0",
      type: "click",
      selector: "#first-result",
      structuralSelector:
        "body > main > ul.results > li.result:nth-of-type(1) > button.result-action",
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
      structuralSelector: "body > nav > a.next",
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
  expect(() =>
    harness.coordinator.insertAction("recording-test", {
      afterActionId: "after",
      action: { type: "click", selector: "#inserted" },
    }),
  ).toThrowError(
    expect.objectContaining<Partial<RecordingCoordinatorError>>({
      code: "pagination_loop_action_locked",
      statusCode: 409,
    }),
  );
  expect(() => harness.coordinator.deleteAction("recording-test", "after")).toThrowError(
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

it("rejects anchor navigation in a pagination loop preview without persisting it", async () => {
  const harness = createHarness();
  await harness.coordinator.start(0, "target-test", "https://example.com");
  const recorder = harness.requireRecorderOptions();
  await recorder.onAction({
    id: "entry",
    order: 1,
    pageId: "page0",
    type: "click",
    selector: "#first-result",
    structuralSelector: "body > ul.results > li.result:nth-of-type(1) > a.result-link",
    included: true,
  });
  await recorder.onAction({
    id: "next",
    order: 2,
    pageId: "page0",
    type: "click",
    selector: "#next",
    structuralSelector: "body > nav > a.next",
    included: true,
  });
  await harness.coordinator.stop("recording-test");

  expect(() =>
    harness.coordinator.previewPaginationLoop("recording-test", {
      actionIds: ["entry", "next"],
      listEntryActionId: "entry",
      nextActionId: "next",
    }),
  ).toThrowError(
    expect.objectContaining<Partial<RecordingCoordinatorError>>({
      code: "pagination_loop_navigation_not_supported",
      statusCode: 422,
    }),
  );
  expect(harness.coordinator.get("recording-test").paginationLoop).toBeUndefined();
});

it("blocks excluding a popup opener whose descendant page contains the loop", async () => {
  const harness = createHarness();
  await harness.coordinator.start(0, "target-test", "https://example.com");
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
    structuralSelector: "body > ul.results > li.result:nth-of-type(1) > button.result-action",
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

describe("RecordingCoordinator resource rollback", () => {
  it("removes a partial record and releases the browser lease when recorder startup fails", async () => {
    const harness = createHarness({
      recorderFactory: async () => {
        throw new Error("recorder failed");
      },
    });

    await expect(
      harness.coordinator.start(0, "target-test", "https://example.com"),
    ).rejects.toMatchObject({
      code: "recording_start_failed",
      statusCode: 500,
    });
    expect(() => harness.coordinator.get("recording-test")).toThrowError(
      expect.objectContaining({ code: "recording_not_found" }),
    );

    const activity = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-after-start-rollback",
    );
    expect(activity.acquired).toBe(true);
    if (activity.acquired) {
      harness.executionCoordinator.releaseBrowserActivity(activity.lease);
    }
  });

  it("stops the recorder and releases its lease even when recorder cleanup fails", async () => {
    const stopRecorder = vi.fn(async () => {
      throw new Error("recorder cleanup failed");
    });
    const harness = createHarness({
      recorderFactory: async () => ({ stop: stopRecorder }),
    });
    await harness.coordinator.start(0, "target-test", "https://example.com");
    const events: RecordingStreamEvent[] = [];
    harness.coordinator.subscribe("recording-test", (event) => events.push(event));

    await expect(harness.coordinator.stop("recording-test")).rejects.toMatchObject({
      code: "recording_cleanup_failed",
      statusCode: 500,
    });
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(harness.coordinator.get("recording-test").status).toBe("stopped");
    expect(events.map((event) => event.type)).toEqual(["error", "stopped"]);
    await expect(harness.coordinator.stop("recording-test")).resolves.toMatchObject({
      status: "stopped",
    });

    const activity = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-after-stop-cleanup",
    );
    expect(activity.acquired).toBe(true);
    if (activity.acquired) {
      harness.executionCoordinator.releaseBrowserActivity(activity.lease);
    }
  });

  it("settles active recorder cleanup during shutdown", async () => {
    const stopRecorder = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const harness = createHarness({
      recorderFactory: async () => ({ stop: stopRecorder }),
    });
    await harness.coordinator.start(0, "target-test", "https://example.com");

    await expect(harness.coordinator.shutdown()).resolves.toBeUndefined();
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(harness.coordinator.get("recording-test").status).toBe("stopped");
  });
});

describe("RecordingCoordinator recording ownership", () => {
  it("expires an unclaimed recording and releases its browser lease", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ orphanGraceMs: 100 });
      await harness.coordinator.start(0, "target-test", "https://example.com");

      await vi.advanceTimersByTimeAsync(99);
      expect(harness.coordinator.get("recording-test").status).toBe("recording");
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();

      expect(harness.stopRecorder).toHaveBeenCalledOnce();
      expect(harness.coordinator.get("recording-test").status).toBe("stopped");
      const activity = harness.executionCoordinator.acquireBrowserActivity(
        "execution",
        "run-after-unclaimed-recording",
      );
      expect(activity.acquired).toBe(true);
      if (activity.acquired) {
        harness.executionCoordinator.releaseBrowserActivity(activity.lease);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a subscribed recording alive and starts the grace period after disconnect", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ orphanGraceMs: 100 });
      await harness.coordinator.start(0, "target-test", "https://example.com");
      const subscription = harness.coordinator.subscribe("recording-test", () => undefined);

      await vi.advanceTimersByTimeAsync(200);
      expect(harness.coordinator.get("recording-test").status).toBe("recording");
      subscription.unsubscribe();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();

      expect(harness.coordinator.get("recording-test").status).toBe("stopped");
      expect(harness.stopRecorder).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a same-URL replacement page whose stable target id changed", async () => {
    const replacementPage = {
      targetId: () => "replacement-target",
      url: () => "https://example.com",
      sendCDP: vi.fn(async () => ({})),
    };
    const harness = createHarness({
      getUserVisiblePages: async () => [replacementPage],
    });

    await expect(
      harness.coordinator.start(0, "target-test", "https://example.com"),
    ).rejects.toMatchObject({ code: "target_not_found", statusCode: 409 });
    expect(harness.stopRecorder).not.toHaveBeenCalled();
    const activity = harness.executionCoordinator.acquireBrowserActivity(
      "execution",
      "run-after-target-replacement",
    );
    expect(activity.acquired).toBe(true);
    if (activity.acquired) {
      harness.executionCoordinator.releaseBrowserActivity(activity.lease);
    }
  });
});
