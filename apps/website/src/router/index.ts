import { createRouter, createWebHistory } from "vue-router";
import TabsView from "../views/TabsView.vue";
import ScriptsView from "../views/ScriptsView.vue";
import DatabaseView from "../views/DatabaseView.vue";
import PiAgentView from "../views/PiAgentView.vue";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      redirect: "/tabs",
    },
    {
      path: "/tabs",
      name: "tabs",
      component: TabsView,
    },
    {
      path: "/scripts",
      name: "scripts",
      component: ScriptsView,
    },
    {
      path: "/database",
      name: "database",
      component: DatabaseView,
    },
    {
      path: "/pi-agent",
      name: "pi-agent",
      component: PiAgentView,
    },
  ],
});

export default router;
