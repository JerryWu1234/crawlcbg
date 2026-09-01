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
