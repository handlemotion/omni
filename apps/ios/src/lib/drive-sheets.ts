import { router } from "expo-router";
import type { DriveNode } from "./drive.ts";
import { keys } from "./query-keys.ts";
import { queryClient } from "./query-client.ts";

/**
 * Opens one of a node's sheets (Share, Move, Versions) over Drive. The node goes into the cache
 * first, so the sheet draws it at once and only asks the Worker when it is stale.
 */
export function openDriveSheet(sheet: "share" | "move" | "versions", node: DriveNode) {
  queryClient.setQueryData(keys.driveNode(node.id), { node });
  router.push({ pathname: `/drive/${sheet}/[id]`, params: { id: node.id } });
}
