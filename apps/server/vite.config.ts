import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: "./src/index.ts",
    format: ["esm"],
    clean: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
