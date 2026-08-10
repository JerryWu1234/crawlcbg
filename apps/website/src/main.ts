import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "./style.css";

// Prevent double-click zoom gesture on non-editable elements
document.addEventListener(
  "dblclick",
  (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      target.tagName !== "INPUT" &&
      target.tagName !== "TEXTAREA" &&
      !target.isContentEditable
    ) {
      e.preventDefault();
    }
  },
  { passive: false },
);

createApp(App).use(router).mount("#app");
