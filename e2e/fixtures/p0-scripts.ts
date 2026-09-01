export const P0_SCRIPT_NAMES = {
  background: "p0-background.mjs",
  cancel: "p0-cancel.mjs",
  deleteTarget: "p0-delete-target.mjs",
  keep: "p0-keep.mjs",
  manual: "p0-manual.mjs",
  visible: "p0-visible.mjs",
} as const;

export function createP0Scripts(fixtureBaseUrl: string): Record<string, string> {
  const baseUrl = JSON.stringify(fixtureBaseUrl.replace(/\/+$/, ""));

  return {
    [P0_SCRIPT_NAMES.visible]: `export default async function run({ page, log, fetch }) {
  await log("E2E_VISIBLE_READY");
  await page.locator('[data-testid="visible-action"]').click();
  await fetch(${baseUrl} + "/mark/visible-script", { method: "POST" });
  await log("E2E_VISIBLE_DONE");
}`,
    [P0_SCRIPT_NAMES.cancel]: `export default async function run({ log, fetch }) {
  await log("E2E_CANCEL_READY");
  await fetch(${baseUrl} + "/gate/cancel");
  await fetch(${baseUrl} + "/mark/cancel-after-gate", { method: "POST" });
  await log("E2E_CANCEL_AFTER_GATE");
}`,
    [P0_SCRIPT_NAMES.background]: `export default async function run({ page, log, fetch }) {
  await log("E2E_BACKGROUND_BEFORE_POPUP");
  await page.evaluate(() => {
    document.querySelector('[data-testid="open-popup"]')?.click();
  });
  await log("E2E_BACKGROUND_AFTER_POPUP");
  await page.waitForTimeout(250);
  await fetch(${baseUrl} + "/mark/background-popup-opened", { method: "POST" });
  await log("E2E_BACKGROUND_READY");
  await fetch(${baseUrl} + "/gate/background");
  await log("E2E_BACKGROUND_DONE");
}`,
    [P0_SCRIPT_NAMES.manual]: `export default async function run({ page, log, manual }) {
  await log("E2E_MANUAL_BEFORE");
  await manual.wait(page, {
    title: "P0 敏感输入",
    targets: [
      {
        selector: '[data-testid="secret-input"]',
        controlKind: "secret",
        displayName: "E2E Password",
        required: true,
      },
    ],
  });
  await log("E2E_MANUAL_AFTER");
}`,
    [P0_SCRIPT_NAMES.deleteTarget]: `export default async function run({ log }) {
  await log("P0 delete target script");
}`,
    [P0_SCRIPT_NAMES.keep]: `export default async function run({ log }) {
  await log("P0 sentinel script");
}`,
  };
}
