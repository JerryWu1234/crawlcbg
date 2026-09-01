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
      .pagination-fixture { display: none; gap: 8px; padding: 12px; border: 1px solid #c7d2fe; }
      .results { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
      .results > li { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; align-items: center; }
      .results > li.ad { display: block; padding: 6px; color: #64748b; background: #f8fafc; }
      .results input, .results button { min-width: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>CrawlCBG P0 Fixture</h1>
      <section class="pagination-fixture" aria-label="Pagination recording fixture">
        <ul class="results" data-testid="pagination-results">
          <li class="result">
            <button class="result-action" data-testid="pagination-entry-first" type="button">
              Review first result
            </button>
          </li>
          <li class="ad">Sponsored result separator</li>
          <li class="result">
            <button class="result-action" data-testid="pagination-entry" type="button">
              Review second result
            </button>
            <input
              class="result-note"
              data-testid="pagination-body"
              name="pagination-body"
              autocomplete="off"
              aria-label="Pagination result note"
            />
            <a class="result-link" data-testid="pagination-anchor" href="#pagination-detail">
              Open second result
            </a>
          </li>
        </ul>
        <button data-testid="pagination-next" type="button">Next results</button>
      </section>
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
