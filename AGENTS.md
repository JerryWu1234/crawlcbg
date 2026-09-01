<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Cypress E2E Requirements

- Every plan for a new or changed user-facing feature must include an E2E section that identifies the corresponding Cypress user journeys, test files, and highest-risk user-visible failure path.
- Add or update the Cypress tests in the same implementation as the feature. Place each feature's tests under `e2e/features/<feature>/` and name them `*.cy.ts`.
- At minimum, cover the feature's key happy path. Also cover the highest-risk failure or recovery path when the feature handles persisted data, privacy-sensitive input, browser activity, or destructive actions.
- Run the unified `vp run e2e` suite for changes that affect user-visible behavior, in addition to `vp check` and `vp test`. The command builds the server and manages isolated dynamic website/server ports, runtime data, and Chrome profile; do not reuse a developer website or browser.
- If Cypress cannot reasonably cover a feature, document why in the feature plan, provide the alternative automated validation, and create an explicit follow-up task. Do not silently omit E2E coverage.
