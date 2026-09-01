# Cypress E2E

The root `e2e/` directory is one Cypress project. All tests are organized by user-facing feature under `features/<feature>/` and are loaded by the same config, support file, isolated runtime, and Cypress UI.

## Run

Run every spec headlessly:

```bash
vp run e2e
```

Open the same complete suite interactively in Chrome:

```bash
vp run e2e:open
```

The interactive runner lists all ordinary and `*.p0.cy.ts` specs together and enables Cypress's **Run All Specs** action. It shows the command log and DOM snapshots while each step executes.

Both commands build the server and then manage their own dynamic website/server stack, loopback fixture site, temporary runtime, and separate headed Chrome profile. Do not start a website on 5173 first: the unified harness never reuses developer ports 3001/5173, the repository `.env`, developer data, secrets, or the developer Chrome profile.

An installed Chrome is required. Set `E2E_CHROME_PATH` if Chrome is not at the platform default path.

## One project, two coverage styles

The suite remains semantically layered without separate commands or configs:

- Ordinary `*.cy.ts` specs use `cy.intercept` for deterministic UI states.
- `*.p0.cy.ts` specs exercise the real isolated server, Stagehand/CDP Chrome, SQLite, scripts, traces, recording, execution, and window cleanup.

Every test starts from a newly seeded marker-protected runtime. The Cypress Chrome only operates the CrawlCBG website; the separately managed Chrome remains the automation target. This separation prevents Cypress pages from changing Stagehand tab indexes or sharing a developer browser profile.

## Current coverage

The unified runner currently discovers 8 specs with 19 tests:

- `features/shell/navigation.cy.ts`: root redirect and navigation across Tabs, Scripts, and Database.
- `features/tabs/states.cy.ts`: loading, empty state, API failure, and retry recovery.
- `features/tabs/destructive-actions.p0.cy.ts`: pinned-tab deletion cancellation and persistence.
- `features/database/destructive-actions.p0.cy.ts`: destructive database operations and identifier safety.
- `features/execution/critical-flows.p0.cy.ts`: visible/background execution, cancellation, target safety, reload recovery, and window cleanup.
- `features/manual-step/privacy.p0.cy.ts`: trusted manual completion/cancellation and secret privacy.
- `features/recording/critical-flow.p0.cy.ts`: real recording, conversion, save, popup handling, and privacy.
- `features/scripts/destructive-actions.p0.cy.ts`: script/history/trace deletion and atomic malicious-input rejection.

## Adding feature coverage

1. Put the spec in `features/<feature>/` and name it `*.cy.ts`; use `*.p0.cy.ts` when it needs the real isolated stack.
2. Cover the feature's key user journey and highest-risk user-visible failure when applicable.
3. Register UI-only API intercepts before `cy.visit()` and keep their response shape aligned with the server contract.
4. Prefer visible semantics and stable attributes over CSS implementation details.
5. Run `vp run e2e`, `vp check`, and `vp test` before considering the change complete.

Real-stack tests must continue using the harness runtime and managed Chrome. They must never reuse developer data, credentials, ports, or browser profiles.
