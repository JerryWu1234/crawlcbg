import { createRouter, createWebHistory } from "vue-router";
import TabsView from "../views/TabsView.vue";
import ScriptsView from "../views/ScriptsView.vue";
import DatabaseView from "../views/DatabaseView.vue";
import RecordingWorkspaceView from "../views/RecordingWorkspaceView.vue";

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
      path: "/tabs/:tabIndex/recording",
      name: "recording-workspace",
      component: RecordingWorkspaceView,
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
      path: "/:pathMatch(.*)*",
      redirect: "/tabs",
    },
  ],
});

export default router;
