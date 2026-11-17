import { and, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageLocks, storageNodes } from "../schema/storage.ts";
import type { Door } from "./access.ts";
import { lockJoin, MAX_WALK, nodeColumns, toNode, type Drive, type StorageNode } from "./core.ts";

/** Search shows this many; it does not page. */
export const STORAGE_FIND_LIMIT = 50;

function liveIn(drives: Drive[]) {
  const roots = drives.map(
    (drive) =>
      sql`(r.org_id = ${drive.orgId} and r.space = ${drive.space} and coalesce(r.owner_member_id, '') = ${drive.ownerMemberId ?? ""})`,
  );
  return sql`${storageNodes.id} in (
    with recursive live(id, depth) as (
      select r.id, 0 from ${storageNodes} r
        where r.parent_id is null and r.trashed_at is null and (${sql.join(roots, sql` or `)})
      union all
      select c.id, live.depth + 1 from ${storageNodes} c
        join live on c.parent_id = live.id
        where c.trashed_at is null and live.depth < ${MAX_WALK}
    ) select id from live)` satisfies SQL;
}

const likeEscaped = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export function findOperations(db: Db, door: Door) {
  const drives = async () => {
    const found = await Promise.all([door.root(db, "personal"), door.root(db, "shared")]);
    return found.filter((drive): drive is Drive => drive !== null);
  };
  return {
    async search(query: string) {
      const text = query.trim();
      const reach = await drives();
      if (!text || !reach.length) return [] satisfies StorageNode[];
      const rows = await db
        .select(nodeColumns)
        .from(storageNodes)
        .leftJoin(storageLocks, lockJoin)
        .where(and(sql`${storageNodes.name} ilike ${`%${likeEscaped(text)}%`}`, liveIn(reach)))
        .orderBy(storageNodes.kind, sql`lower(${storageNodes.name})`, storageNodes.id)
        .limit(STORAGE_FIND_LIMIT);
      return rows.map(toNode) satisfies StorageNode[];
    },
  };
}
