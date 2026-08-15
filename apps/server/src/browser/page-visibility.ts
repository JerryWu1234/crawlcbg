import type { Stagehand } from "@browserbasehq/stagehand";
import type { ExecutionCoordinator } from "../execution/execution-coordinator.js";
import { discoverOwnedTargetIds } from "../minimized-browser-window.js";

export function createGetUserVisiblePages(
  executionCoordinator: Pick<ExecutionCoordinator, "getBackgroundExecutionOwnerships">,
): (stagehand: Stagehand) => Promise<any[]> {
  return async function getUserVisiblePages(stagehand: Stagehand): Promise<any[]> {
    const pages = stagehand.context.pages();
    const ownerships = executionCoordinator.getBackgroundExecutionOwnerships();

    await Promise.all(
      ownerships.map(async (ownership) => {
        if (ownership.rootTargetIds.size === 0) return;
        try {
          const discoveredTargetIds = await discoverOwnedTargetIds(
            stagehand.context,
            ownership.rootTargetIds,
          );
          for (const targetId of discoveredTargetIds) ownership.targetIds.add(targetId);
        } catch {
          // Keep filtering already known targets/windows if Chrome is concurrently closing one.
        }
      }),
    );

    const visibility = await Promise.all(
      pages.map(async (page) => {
        const targetId = (page as any).targetId?.();
        const directOwners = targetId
          ? ownerships.filter((ownership) => ownership.targetIds.has(targetId))
          : [];
        try {
          const windowInfo = await (page as any).sendCDP("Browser.getWindowForTarget", {
            targetId,
          });
          for (const ownership of directOwners) ownership.windowIds.add(windowInfo.windowId);
          const windowOwners = ownerships.filter((ownership) =>
            ownership.windowIds.has(windowInfo.windowId),
          );
          for (const ownership of windowOwners) {
            if (targetId) ownership.targetIds.add(targetId);
          }
          return directOwners.length === 0 && windowOwners.length === 0;
        } catch {
          return directOwners.length === 0;
        }
      }),
    );
    return pages.filter((_page, index) => visibility[index]);
  };
}
