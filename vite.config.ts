import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    tasks: {
      "e2e:run": {
        command: "vp run --filter ./apps/server build && vp exec cypress run --project e2e",
        cache: false,
      },
      "e2e:open:run": {
        command:
          "vp run --filter ./apps/server build && vp exec cypress open --project e2e --e2e --browser chrome",
        cache: false,
      },
    },
  },
});
