import { defineConfig } from "cypress";
import { createP0Harness } from "./support/p0-harness";

export default defineConfig({
  projectId: "fwu7xv",
  allowCypressEnv: false,
  defaultCommandTimeout: 15_000,
  taskTimeout: 90_000,
  experimentalRunAllSpecs: true,
  e2e: {
    specPattern: "features/**/*.cy.ts",
    supportFile: "support/e2e.ts",
    async setupNodeEvents(on, config) {
      const harness = createP0Harness();
      if (!config.isInteractive) {
        on("after:run", async () => {
          await harness.stop();
        });
      }

      const endpoints = await harness.start();
      on("task", harness.tasks());

      config.baseUrl = endpoints.websiteUrl;
      config.env.apiBaseUrl = endpoints.apiBaseUrl;
      config.env.fixtureUrl = endpoints.fixtureUrl;
      return config;
    },
  },
  downloadsFolder: "artifacts/downloads",
  screenshotsFolder: "artifacts/screenshots",
  videosFolder: "artifacts/videos",
  video: false,
  screenshotOnRunFailure: true,
  retries: {
    openMode: 0,
    runMode: 0,
  },
  viewportHeight: 900,
  viewportWidth: 1440,
});
