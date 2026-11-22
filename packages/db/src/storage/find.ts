import { desc, inArray, sql, type SQL } from "drizzle-orm";
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
        sql`(${t}.org_id = ${drive.orgId} and ${t}.space = ${drive.space} and coalesce(${t}.owner_member_id, '') = ${drive.ownerMemberId ?? ""} and coalesce(${t}.teamspace_id, '') = ${drive.teamspaceId ?? ""})`,
    ),
    sql` or `,
  );
}

/** What a search keeps besides the name, applied before its limit. */
export interface StorageSearchFilter {
  /** Leave out the member's My files. */
  teamOnly?: boolean;
  /** Only files of this type, and folders. */
  type?: string;
}

function firstLiveMatches(drives: Drive[], pattern: string, type: string | undefined) {
  const ofType = type ? sql`and (n.kind = 'folder' or n.mime_type = ${type})` : sql``;
  return sql`select c.id from (
    select n.id, n.kind, lower(n.name) as sort_name, n.parent_id from ${storageNodes} n
      where (${inDrives(drives, "n")}) and n.trashed_at is null and not n.attached
        and n.name ilike ${pattern} ${ofType}
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
  const drives = () => door.drives(db);
  return {
    async search(query: string, filter: StorageSearchFilter = {}) {
      const text = query.trim();
      const reach = (await drives()).filter((d) => !filter.teamOnly || d.space !== "personal");
      if (!text || !reach.length) return [] satisfies StorageNode[];
      const rows = await db
        .select(nodeColumns)
        .from(storageNodes)
        .leftJoin(storageLocks, lockJoin)
        .where(
          sql`${storageNodes.id} in (${firstLiveMatches(reach, `%${likeEscaped(text)}%`, filter.type)})`,
        )
        .orderBy(storageNodes.kind, sql`lower(${storageNodes.name})`, storageNodes.id);
      return rows.map(toNode) satisfies StorageNode[];
    },

    async recent(limit = STORAGE_FIND_LIMIT) {
      const reach = await drives();
      if (!reach.length) return [] satisfies StorageNode[];
      const rows = (await db.execute(sql`
        select n.id from ${storageNodes} n
        where (${inDrives(reach, "n")}) and n.kind = 'file' and n.trashed_at is null
          and not n.attached and ${noTrashAbove(sql`n.parent_id`)}
        order by n.updated_at desc, n.id desc
        limit ${Math.min(Math.max(1, limit), STORAGE_FIND_LIMIT)}`)) as unknown as { id: string }[];
      if (!rows.length) return [] satisfies StorageNode[];
      const nodes = await db
        .select(nodeColumns)
        .from(storageNodes)
        .leftJoin(storageLocks, lockJoin)
        .where(
          inArray(
            storageNodes.id,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(desc(storageNodes.updatedAt), desc(storageNodes.id));
      return nodes.map(toNode) satisfies StorageNode[];
    },
  };
}

const noTrashAbove = (parent: SQL) => sql`not exists (
  with recursive up(parent_id, trashed, depth) as (
    select p.parent_id, p.trashed_at is not null, 1 from ${storageNodes} p where p.id = ${parent}
    union all
    select p.parent_id, p.trashed_at is not null, up.depth + 1 from ${storageNodes} p
      join up on p.id = up.parent_id
      where not up.trashed and up.depth < ${MAX_WALK}
  ) select 1 from up where trashed)`;
