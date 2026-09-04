import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RecordingSession } from "../types/automation";
import { useRecording } from "./useRecording";

class FakeEventSource {
  static readonly OPEN = 1;
  readonly readyState = FakeEventSource.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const baseActions: RecordingSession["actions"] = [
  {
    id: "entry",
    order: 1,
    pageId: "page0",
    type: "click",
    selector: "#first-result",
    structuralSelector: "body > ul > li:nth-of-type(1) > button.result-action",
    included: true,
  },
  {
    id: "next",
    order: 2,
    pageId: "page0",
    type: "click",
    selector: "#next",
    included: true,
  },
];

const sessionPayload = (status: RecordingSession["status"]): RecordingSession => ({
  id: "recording-test",
  status,
  startUrl: "https://example.com",
  pages: [{ id: "page0", url: "https://example.com" }],
  actions: baseActions,
});

const loop = {
  actionIds: ["entry", "next"],
  listEntryActionId: "entry",
  nextActionId: "next",
  listSelector: "body > ul > li",
  sourceItemSelector: "body > ul > li:nth-of-type(1)",
  itemSelectorTemplate: "body > ul > li:nth-of-type({{itemOrdinal}})",
  maxPages: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRecording pagination loop workflow", () => {
  it("normalizes preview/create responses, locks members, and restores actions on dissolve", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      if (url.endsWith("/api/recordings") && init?.method === "POST") {
        return jsonResponse({ recording: sessionPayload("recording") }, 201);
      }
      if (url.endsWith("/stop") && init?.method === "POST") {
        return jsonResponse({ recording: sessionPayload("stopped") });
      }
      if (url.endsWith("/pagination-loop/preview")) {
        return jsonResponse({
          preview: {
            actionIds: loop.actionIds,
            listEntryActionId: loop.listEntryActionId,
            nextActionId: loop.nextActionId,
            candidates: [
              {
                candidateIndex: 0,
                sourceOrdinal: 1,
                listSelector: loop.listSelector,
                sourceItemSelector: loop.sourceItemSelector,
                itemSelectorTemplate: loop.itemSelectorTemplate,
              },
            ],
          },
        });
      }
      if (url.endsWith("/pagination-loop") && init?.method === "POST") {
        return jsonResponse(
          {
            recording: { ...sessionPayload("stopped"), paginationLoop: loop },
          },
          201,
        );
      }
      if (url.endsWith("/pagination-loop") && init?.method === "DELETE") {
        return jsonResponse({ recording: sessionPayload("stopped") });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const scope = effectScope();
    const recording = scope.run(() =>
      useRecording({
        fetcher,
        eventSourceFactory: () => new FakeEventSource() as unknown as EventSource,
      }),
    );
    if (!recording) throw new Error("Failed to create recording composable.");

    await recording.startRecording({
      index: 0,
      targetId: "target-test",
      url: "https://example.com",
    });
    expect(recording.session.value?.id).toBe("recording-test");
    await recording.stopRecording();
    expect(recording.session.value?.status).toBe("stopped");

    const selection = {
      actionIds: ["entry", "next"],
      listEntryActionId: "entry",
      nextActionId: "next",
    };
    const preview = await recording.previewPaginationLoop(selection);
    expect(preview?.candidates).toEqual([
      expect.objectContaining({ candidateIndex: 0, sourceOrdinal: 1 }),
    ]);

    await recording.createPaginationLoop({
      ...selection,
      candidateIndex: 0,
      maxPages: 100,
    });
    expect(recording.session.value?.paginationLoop).toEqual(loop);
    const requestCountBeforeLockedUpdate = requests.length;
    await expect(recording.setActionIncluded("entry", false)).resolves.toBe(false);
    expect(requests).toHaveLength(requestCountBeforeLockedUpdate);

    await recording.dissolvePaginationLoop();
    expect(recording.session.value?.paginationLoop).toBeUndefined();
    expect(recording.session.value?.actions).toEqual(baseActions);

    const createRequest = requests.find(
      ({ url, init }) => url.endsWith("/pagination-loop") && init?.method === "POST",
    );
    const createBody = createRequest?.init?.body;
    expect(typeof createBody).toBe("string");
    if (typeof createBody !== "string") throw new Error("Missing create request body.");
    expect(JSON.parse(createBody)).toMatchObject({ maxPages: 100 });
    scope.stop();
  });
});

describe("useRecording action structure mutations", () => {
  it("replaces the stopped snapshot atomically and preserves it when deletion fails", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const insertedAction: RecordingSession["actions"][number] = {
      id: "action-edit-test",
      order: 2,
      pageId: "page0",
      type: "click",
      selector: "#inserted",
      included: true,
    };
    const insertedSession: RecordingSession = {
      ...sessionPayload("stopped"),
      actions: [{ ...baseActions[0], order: 1 }, insertedAction, { ...baseActions[1], order: 3 }],
    };
    let deleteAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      if (url.endsWith("/api/recordings") && init?.method === "POST") {
        return jsonResponse({ recording: sessionPayload("recording") }, 201);
      }
      if (url.endsWith("/stop") && init?.method === "POST") {
        return jsonResponse({ recording: sessionPayload("stopped") });
      }
      if (url.endsWith("/generate") && init?.method === "POST") {
        return jsonResponse({ filename: "recording.mjs", code: "generated code" });
      }
      if (url.endsWith("/actions") && init?.method === "POST") {
        return jsonResponse({ recording: insertedSession, action: insertedAction }, 201);
      }
      if (url.endsWith(`/actions/${insertedAction.id}`) && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) return jsonResponse({ error: "temporary delete failure" }, 503);
        return jsonResponse({
          recording: sessionPayload("stopped"),
          removedActionIds: [insertedAction.id],
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const scope = effectScope();
    const recording = scope.run(() =>
      useRecording({
        fetcher,
        eventSourceFactory: () => new FakeEventSource() as unknown as EventSource,
      }),
    );
    if (!recording) throw new Error("Failed to create recording composable.");

    await recording.startRecording({
      index: 0,
      targetId: "target-test",
      url: "https://example.com",
    });
    await recording.stopRecording();
    expect(recording.canMutateActions.value).toBe(true);
    await recording.generateScript("recording.mjs");
    expect(recording.generatedScript.value).not.toBeNull();

    const inserted = await recording.insertAction("entry", {
      type: "click",
      selector: "#inserted",
    });
    expect(inserted).toEqual(insertedAction);
    expect(recording.actions.value.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "entry", order: 1 },
      { id: insertedAction.id, order: 2 },
      { id: "next", order: 3 },
    ]);
    expect(recording.generatedScript.value).toBeNull();
    const insertRequest = requests.find(
      ({ url, init }) => url.endsWith("/actions") && init?.method === "POST",
    );
    const insertBody = insertRequest?.init?.body;
    expect(typeof insertBody).toBe("string");
    if (typeof insertBody !== "string") throw new Error("Missing insert request body.");
    expect(JSON.parse(insertBody)).toEqual({
      afterActionId: "entry",
      action: { type: "click", selector: "#inserted" },
    });

    await recording.generateScript("recording.mjs");
    const failedDelete = await recording.deleteAction(insertedAction.id);
    expect(failedDelete).toBeNull();
    expect(recording.actions.value.some((action) => action.id === insertedAction.id)).toBe(true);
    expect(recording.generatedScript.value).not.toBeNull();
    expect(recording.errorMessage.value).toContain("temporary delete failure");
    expect(recording.operation.value).toBe("idle");

    const deleted = await recording.deleteAction(insertedAction.id);
    expect(deleted?.actions.map((action) => action.id)).toEqual(["entry", "next"]);
    expect(recording.actions.value.map((action) => action.id)).toEqual(["entry", "next"]);
    expect(recording.generatedScript.value).toBeNull();
    expect(recording.errorMessage.value).toBeNull();
    scope.stop();
  });
});

describe("useRecording lifecycle cleanup", () => {
  it("does not abort a committed start and stops the late recording after scope disposal", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveStart!: (response: Response) => void;
    const startResponse = new Promise<Response>((resolve) => {
      resolveStart = resolve;
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      if (url.endsWith("/api/recordings")) return startResponse;
      if (url.endsWith("/api/recordings/recording-test/stop")) {
        return jsonResponse({ recording: sessionPayload("stopped") });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const scope = effectScope();
    const recording = scope.run(() =>
      useRecording({
        fetcher,
        eventSourceFactory: () => new FakeEventSource() as unknown as EventSource,
      }),
    );
    if (!recording) throw new Error("Failed to create recording composable.");

    const pendingStart = recording.startRecording({
      index: 0,
      targetId: "target-test",
      url: "https://example.com",
    });
    await Promise.resolve();
    const startRequest = requests[0];
    expect(startRequest?.init?.signal).toBeInstanceOf(AbortSignal);
    scope.stop();
    expect((startRequest?.init?.signal as AbortSignal | undefined)?.aborted).toBe(false);

    resolveStart(jsonResponse({ recording: sessionPayload("recording") }, 201));
    await expect(pendingStart).resolves.toBeNull();
    expect(
      requests.filter(({ url, init }) => url.endsWith("/recording-test/stop") && init?.keepalive),
    ).toHaveLength(1);
    expect(recording.session.value).toBeNull();
  });

  it("starts from a recording-only envelope without compensating stop", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      if (url.endsWith("/api/recordings")) {
        return jsonResponse({ recording: sessionPayload("recording") }, 201);
      }
      if (url.endsWith("/api/recordings/recording-test/stop")) {
        return jsonResponse({ recording: sessionPayload("stopped") });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const scope = effectScope();
    const recording = scope.run(() =>
      useRecording({
        fetcher,
        eventSourceFactory: () => new FakeEventSource() as unknown as EventSource,
      }),
    );
    if (!recording) throw new Error("Failed to create recording composable.");

    await expect(
      recording.startRecording({ index: 0, targetId: "target-test", url: "https://example.com" }),
    ).resolves.toMatchObject({ id: "recording-test", status: "recording" });
    expect(recording.session.value?.id).toBe("recording-test");
    expect(recording.errorMessage.value).toBeNull();
    expect(requests.some(({ url }) => url.endsWith("/recording-test/stop"))).toBe(false);
    scope.stop();
  });
});
