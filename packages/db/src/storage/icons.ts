import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageFolderIcons, storageNodes } from "../schema/storage.ts";
import type { Door } from "./access.ts";
import { inTrash, toNode, type StorageNode, type StorageSpace } from "./core.ts";
import { reach } from "./tree.ts";

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

export type IconResult = { status: "ok"; node: StorageNode } | typeof NOT_FOUND | typeof FORBIDDEN;

export function iconOperations(db: Db, door: Door) {
  return {
    async setIcon(nodeId: string, icon: string | null) {
      const found = await reach(db, door, nodeId);
      if (!found || inTrash(found.chain)) return NOT_FOUND satisfies IconResult;
      const { node } = found;
      if (node.kind !== "folder" || node.parentId !== null) return NOT_FOUND satisfies IconResult;
      if (!found.access.change) return FORBIDDEN satisfies IconResult;
      if (icon === null) {
        await db.delete(storageFolderIcons).where(eq(storageFolderIcons.nodeId, nodeId));
      } else {
        await db
          .insert(storageFolderIcons)
          .values({ nodeId, orgId: node.orgId, icon })
          .onConflictDoUpdate({ target: storageFolderIcons.nodeId, set: { icon } });
      }
      return { status: "ok", node: toNode(node) } satisfies IconResult;
    },

    async folderIcons(space: StorageSpace) {
      const drive = await door.root(db, space);
      if (!drive) return {} satisfies Record<string, string>;
      const rows = await db
        .select({ nodeId: storageFolderIcons.nodeId, icon: storageFolderIcons.icon })
        .from(storageFolderIcons)
        .innerJoin(storageNodes, eq(storageNodes.id, storageFolderIcons.nodeId))
        .where(
          and(
            eq(storageNodes.orgId, drive.orgId),
            eq(storageNodes.space, drive.space),
            sql`coalesce(${storageNodes.ownerMemberId}, '') = ${drive.ownerMemberId ?? ""}`,
            isNull(storageNodes.parentId),
            isNull(storageNodes.trashedAt),
          ),
        );
      return Object.fromEntries(rows.map((row) => [row.nodeId, row.icon])) satisfies Record<
        string,
        string
      >;
    },
  };
}
