import { describe, expect, it } from "vite-plus/test";
import { safeTranspile, ts } from "../scripts/script-compiler.js";
import { compileRecordingToScript } from "./action-script-compiler.js";
import type { RecordingSession } from "./recording-types.js";

const createRecording = (actions: RecordingSession["actions"]): RecordingSession => ({
  id: "recording-1",
  status: "stopped",
  startUrl: "https://example.com",
  pages: [
    { id: "page0", url: "https://example.com" },
    {
      id: "page1",
      url: "https://example.com/detail",
      openerPageId: "page0",
    },
  ],
  actions,
});

describe("compileRecordingToScript", () => {
  it("compiles the documented popup fixture byte-for-byte", () => {
    const recording = createRecording([
      {
        id: "action-1",
        order: 1,
        pageId: "page0",
        type: "click",
        selector: "#detail",
        included: true,
        opensPageId: "page1",
      },
      {
        id: "action-2",
        order: 2,
        pageId: "page1",
        type: "fill",
        selector: "#quantity",
        value: "2",
        included: true,
      },
    ]);

    expect(compileRecordingToScript(recording))
      .toBe(`export default async function run({ page, log, pace, manual }) {
  const page0 = page;

  await log("执行步骤 1：点击");
  const page1 = await pace.clickAndWaitForNewPage(page0, page0.locator("#detail").first());

  await log("执行步骤 2：输入");
  await pace.fill(page1.locator("#quantity").first(), "2");
}
`);
  });

  it("filters excluded actions, sorts stably, serializes values, and supports every action", () => {
    const recording = createRecording([
      {
        id: "excluded",
        order: 0,
        pageId: "page0",
        type: "click",
        selector: "#excluded",
        included: false,
      },
      {
        id: "close",
        order: 7,
        pageId: "page1",
        type: "closePage",
        included: true,
      },
      {
        id: "popup",
        order: 1,
        pageId: "page0",
        type: "click",
        selector: '[data-name="detail"]',
        included: true,
        opensPageId: "page1",
      },
      {
        id: "fill",
        order: 2,
        pageId: "page1",
        type: "fill",
        selector: "#text",
        value: 'line 1\n"line 2"',
        included: true,
      },
      {
        id: "select",
        order: 3,
        pageId: "page1",
        type: "select",
        selector: "#options",
        value: ["one", "two"],
        included: true,
      },
      {
        id: "checked",
        order: 4,
        pageId: "page1",
        type: "setChecked",
        selector: "#enabled",
        value: true,
        included: true,
      },
      {
        id: "press",
        order: 5,
        pageId: "page1",
        type: "press",
        value: "Enter",
        included: true,
      },
      {
        id: "scroll",
        order: 6,
        pageId: "page1",
        type: "scroll",
        value: 480,
        included: true,
      },
      {
        id: "manual-secret",
        order: 8,
        pageId: "page0",
        type: "manualStep",
        title: "请完成登录",
        targets: [
          {
            selector: "#password",
            controlKind: "secret",
            displayName: "密码",
            required: true,
          },
        ],
        included: true,
      },
      {
        id: "manual-select",
        order: 9,
        pageId: "page0",
        type: "manualStep",
        title: "请完成登录",
        targets: [
          {
            selector: "#tenant",
            controlKind: "select",
            displayName: "租户",
          },
        ],
        included: true,
      },
      {
        id: "click",
        order: 10,
        pageId: "page0",
        type: "click",
        selector: "#continue",
        included: true,
      },
    ]);

    const first = compileRecordingToScript(recording);
    const second = compileRecordingToScript(recording);

    expect(second).toBe(first);
    expect(first).not.toContain("#excluded");
    expect(first).not.toMatch(/^import\s/m);
    expect(first).toContain(
      'const page1 = await pace.clickAndWaitForNewPage(page0, page0.locator("[data-name=\\"detail\\"]").first());',
    );
    expect(first).toContain(
      'await pace.fill(page1.locator("#text").first(), "line 1\\n\\"line 2\\"");',
    );
    expect(first).toContain('await pace.select(page1.locator("#options").first(), ["one","two"]);');
    expect(first).toContain('await pace.setChecked(page1.locator("#enabled").first(), true);');
    expect(first).toContain('await pace.press(page1, "Enter");');
    expect(first).toContain("await pace.scrollTo(page1, 480);");
    expect(first).toContain("await pace.closePage(page1);");
    expect(first).toContain(
      'await manual.wait(page0, {"title":"请完成登录","targets":[{"selector":"#password","controlKind":"secret","displayName":"密码","required":true},{"selector":"#tenant","controlKind":"select","displayName":"租户"}]});',
    );
    expect(first.match(/manual\.wait/g)).toHaveLength(1);
    expect(first).toContain('await pace.click(page0.locator("#continue").first());');

    const diagnostics = safeTranspile(first).diagnostics ?? [];
    expect(
      diagnostics.filter(
        (diagnostic: { category: number }) => diagnostic.category === ts.DiagnosticCategory.Error,
      ),
    ).toEqual([]);
  });
});
