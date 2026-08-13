import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
