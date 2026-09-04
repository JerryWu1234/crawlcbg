import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RecordingCoordinator } from "../recording/recording-coordinator.js";
import type { RecordedAction, RecordingSession } from "../recording/recording-types.js";
import { registerRecordingRoutes } from "./recording-routes.js";

const recording: RecordingSession = {
  id: "recording-test",
  status: "stopped",
  startUrl: "https://example.com",
  pages: [{ id: "page0", url: "https://example.com" }],
  actions: [],
  paginationLoop: {
    actionIds: ["entry", "next"],
    listEntryActionId: "entry",
    nextActionId: "next",
    listSelector: "ul > li",
    sourceItemSelector: "ul > li:nth-of-type(1)",
    itemSelectorTemplate: "ul > li:nth-of-type({{itemOrdinal}})",
    maxPages: 100,
  },
};

const insertedAction: RecordedAction = {
  id: "action-edit-test",
  order: 1,
  pageId: "page0",
  type: "click",
  selector: "#inserted",
  included: true,
};

const editedRecording: RecordingSession = {
  ...recording,
  actions: [insertedAction],
  paginationLoop: undefined,
};

const apps: ReturnType<typeof Fastify>[] = [];

const createApp = async () => {
  const previewPaginationLoop = vi.fn(() => ({
    actionIds: ["entry", "next"],
    listEntryActionId: "entry",
    nextActionId: "next",
    candidates: [
      {
        candidateIndex: 0,
        sourceOrdinal: 1,
        listSelector: "ul > li",
        sourceItemSelector: "ul > li:nth-of-type(1)",
        itemSelectorTemplate: "ul > li:nth-of-type({{itemOrdinal}})",
      },
    ],
  }));
  const createPaginationLoop = vi.fn(() => recording);
  const dissolvePaginationLoop = vi.fn(() => ({ ...recording, paginationLoop: undefined }));
  const insertAction = vi.fn(() => ({ recording: editedRecording, action: insertedAction }));
  const deleteAction = vi.fn(() => ({
    recording: { ...editedRecording, actions: [] },
    removedActionIds: [insertedAction.id],
  }));
  const activeRecording: RecordingSession = { ...recording, status: "recording" };
  const start = vi.fn(async () => activeRecording);
  const stop = vi.fn(async () => ({ ...activeRecording, status: "stopped" as const }));
  const coordinator = {
    start,
    stop,
    insertAction,
    deleteAction,
    previewPaginationLoop,
    createPaginationLoop,
    dissolvePaginationLoop,
  } as unknown as RecordingCoordinator;
  const app = Fastify();
  apps.push(app);
  registerRecordingRoutes({
    fastify: app,
    trustedBrowserOrigin: /^https?:\/\/localhost(?::\d+)?$/,
    recordingCoordinator: coordinator,
  });
  await app.ready();
  return {
    app,
    start,
    insertAction,
    deleteAction,
    previewPaginationLoop,
    createPaginationLoop,
    dissolvePaginationLoop,
  };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("recording start route", () => {
  it("returns a recording-only envelope for the exact stable target", async () => {
    const harness = await createApp();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/recordings",
      payload: { tabIndex: 0, targetId: "target-test", expectedUrl: "https://example.com" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ recording: { ...recording, status: "recording" } });
    expect(response.json()).not.toHaveProperty("liveView");
    expect(harness.start).toHaveBeenCalledWith(0, "target-test", "https://example.com");
  });

  it("does not expose the removed live-view token or WebSocket routes", async () => {
    const harness = await createApp();
    const tokenResponse = await harness.app.inject({
      method: "POST",
      url: "/api/recordings/recording-test/live-view-token",
      headers: { origin: "http://localhost:5173" },
    });
    const socketResponse = await harness.app.inject({
      method: "GET",
      url: "/api/recordings/recording-test/live",
      headers: { origin: "http://localhost:5173" },
    });

    expect(tokenResponse.statusCode).toBe(404);
    expect(socketResponse.statusCode).toBe(404);
  });
});

describe("recording action mutation routes", () => {
  it("inserts and deletes actions with authoritative recording envelopes", async () => {
    const harness = await createApp();
    const insertResponse = await harness.app.inject({
      method: "POST",
      url: "/api/recordings/recording-test/actions",
      payload: {
        afterActionId: null,
        action: { type: "click", selector: " #inserted " },
      },
    });

    expect(insertResponse.statusCode).toBe(201);
    expect(insertResponse.json()).toEqual({ recording: editedRecording, action: insertedAction });
    expect(harness.insertAction).toHaveBeenCalledWith("recording-test", {
      afterActionId: null,
      action: { type: "click", selector: "#inserted" },
    });

    const deleteResponse = await harness.app.inject({
      method: "DELETE",
      url: `/api/recordings/recording-test/actions/${insertedAction.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({
      recording: { ...editedRecording, actions: [] },
      removedActionIds: [insertedAction.id],
    });
    expect(harness.deleteAction).toHaveBeenCalledWith("recording-test", insertedAction.id);
  });

  it("rejects unsupported or client-owned action fields", async () => {
    const harness = await createApp();
    for (const action of [
      { type: "closePage" },
      { type: "click", selector: "#unsafe", id: "client-id" },
      { type: "scroll", value: Number.POSITIVE_INFINITY },
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/recordings/recording-test/actions",
        payload: { afterActionId: null, action },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("invalid_recording_action");
    }
    expect(harness.insertAction).not.toHaveBeenCalled();
  });
});

describe("recording pagination loop routes", () => {
  it("returns stable preview, create, and dissolve envelopes", async () => {
    const harness = await createApp();
    const selection = {
      actionIds: ["entry", "next"],
      listEntryActionId: "entry",
      nextActionId: "next",
    };

    const previewResponse = await harness.app.inject({
      method: "POST",
      url: "/api/recordings/recording-test/pagination-loop/preview",
      payload: selection,
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json()).toMatchObject({
      preview: { ...selection, candidates: [{ candidateIndex: 0 }] },
    });
    expect(harness.previewPaginationLoop).toHaveBeenCalledWith("recording-test", selection);

    const createResponse = await harness.app.inject({
      method: "POST",
      url: "/api/recordings/recording-test/pagination-loop",
      payload: { ...selection, candidateIndex: 0, maxPages: 100 },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toEqual({ recording });
    expect(harness.createPaginationLoop).toHaveBeenCalledWith("recording-test", {
      ...selection,
      candidateIndex: 0,
      maxPages: 100,
    });

    const dissolveResponse = await harness.app.inject({
      method: "DELETE",
      url: "/api/recordings/recording-test/pagination-loop",
    });
    expect(dissolveResponse.statusCode).toBe(200);
    expect(dissolveResponse.json().recording.paginationLoop).toBeUndefined();
    expect(harness.dissolvePaginationLoop).toHaveBeenCalledWith("recording-test");
  });

  it("rejects malformed selection bodies before calling the coordinator", async () => {
    const harness = await createApp();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/recordings/recording-test/pagination-loop/preview",
      payload: { actionIds: ["entry"] },
    });

    expect(response.statusCode).toBe(400);
    expect(harness.previewPaginationLoop).not.toHaveBeenCalled();
  });
});

describe("removed recording preview routes", () => {
  it("does not expose the removed JPEG page-preview endpoint", async () => {
    const harness = await createApp();
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/recordings/recording-test/pages/page0/preview",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.statusCode).toBe(404);
  });
});
