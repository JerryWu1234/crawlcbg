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
    structuralSelector: "body > ul > li:nth-of-type(1) > a",
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

    await recording.startRecording({ index: 0, url: "https://example.com" });
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
