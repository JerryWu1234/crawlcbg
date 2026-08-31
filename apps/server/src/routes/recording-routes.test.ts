import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RecordingCoordinator } from "../recording/recording-coordinator.js";
import type { RecordingSession } from "../recording/recording-types.js";
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
  const coordinator = {
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
    previewPaginationLoop,
    createPaginationLoop,
    dissolvePaginationLoop,
  };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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
