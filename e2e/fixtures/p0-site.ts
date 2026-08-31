export const fixtureRootHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CrawlCBG P0 Fixture</title>
    <style>
      body { font: 16px system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 24px; }
      main { display: grid; gap: 16px; }
      label { display: grid; gap: 6px; }
      input, button { min-height: 40px; padding: 8px 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>CrawlCBG P0 Fixture</h1>
      <label>
        Public alpha
        <input data-testid="public-alpha" name="public-alpha" autocomplete="off" />
      </label>
      <label>
        Public beta
        <input data-testid="public-beta" name="public-beta" autocomplete="off" />
      </label>
      <label>
        E2E Password
        <input
          data-testid="secret-input"
          name="password"
          type="password"
          autocomplete="current-password"
          aria-label="E2E Password"
          required
        />
      </label>
      <button
        data-testid="visible-action"
        type="button"
        onclick="fetch('/mark/visible-button', { method: 'POST' })"
      >
        Mark visible action
      </button>
      <button
        data-testid="open-popup"
        type="button"
        onclick="window.open('/popup', 'crawlcbg-p0-popup-' + Date.now(), 'width=480,height=360')"
      >
        Open deterministic popup
      </button>
    </main>
  </body>
</html>`;

export const fixturePopupHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>CrawlCBG P0 Popup</title>
  </head>
  <body>
    <h1>CrawlCBG P0 Popup</h1>
    <button data-testid="popup-action" type="button">Popup action</button>
  </body>
</html>`;

export const fixtureStaleHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>CrawlCBG Stale Target</title>
  </head>
  <body><h1>The target URL changed after the user opened the run dialog.</h1></body>
</html>`;
