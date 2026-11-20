import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageLocks, storageNodes } from "../schema/storage.ts";
import type { Door } from "./access.ts";
import { lockJoin, MAX_WALK, nodeColumns, toNode, type Drive, type StorageNode } from "./core.ts";

/** Search shows this many; it does not page. */
export const STORAGE_FIND_LIMIT = 50;

export function inDrives(drives: Drive[], alias: string) {
  const t = sql.raw(alias);
  return sql.join(
    drives.map(
      (drive) =>
        sql`(${t}.org_id = ${drive.orgId} and ${t}.space = ${drive.space} and coalesce(${t}.owner_member_id, '') = ${drive.ownerMemberId ?? ""})`,
    ),
    sql` or `,
  );
}

function firstLiveMatches(drives: Drive[], pattern: string) {
  return sql`select c.id from (
    select n.id, n.kind, lower(n.name) as sort_name, n.parent_id from ${storageNodes} n
      where (${inDrives(drives, "n")}) and n.trashed_at is null and not n.attached
        and n.name ilike ${pattern}
      order by n.kind, sort_name, n.id offset 0
  ) c
  where not exists (
    with recursive up(parent_id, trashed, depth) as (
      select p.parent_id, p.trashed_at is not null, 1 from ${storageNodes} p where p.id = c.parent_id
      union all
      select p.parent_id, p.trashed_at is not null, up.depth + 1 from ${storageNodes} p
        join up on p.id = up.parent_id
        where not up.trashed and up.depth < ${MAX_WALK}
    ) select 1 from up where trashed
  )
  order by c.kind, c.sort_name, c.id
  limit ${STORAGE_FIND_LIMIT}` satisfies SQL;
}

export const likeEscaped = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

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
        .where(sql`${storageNodes.id} in (${firstLiveMatches(reach, `%${likeEscaped(text)}%`)})`)
        .orderBy(storageNodes.kind, sql`lower(${storageNodes.name})`, storageNodes.id);
      return rows.map(toNode) satisfies StorageNode[];
    },
  };
}
