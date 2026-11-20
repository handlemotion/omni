import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageNodes } from "../schema/storage.ts";
import type { Door } from "./access.ts";
import { inTrash, MAX_WALK } from "./core.ts";
import { reach } from "./tree.ts";

/** One thing a zip holds: a folder (no bytes) or a file and where its bytes are. */
export interface StorageArchiveEntry {
  /** Relative path inside the zip, `/`-separated, starting at the selected item's own name. */
  path: string;
  kind: "folder" | "file";
  size: number;
  r2Key: string | null;
  updatedAt: Date;
}

export type ArchiveResult =
  | { status: "ok"; entries: StorageArchiveEntry[] }
  | { status: "not_found" }
  | { status: "too_many" };

function freeRoot(name: string, kind: "folder" | "file", taken: Set<string>) {
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let free = name;
  for (let n = 2; taken.has(free.toLowerCase()); n++) free = `${stem} (${n})${ext}`;
  taken.add(free.toLowerCase());
  return free;
}

/**
 * A selection as the entries of one zip: every selected file, and every selected folder with
 * everything live inside it. Something in Trash is left out, as it is from a folder's listing.
 * `max` bounds the entries read; more than that answers `too_many` before anything streams.
 */
export function archiveOperations(db: Db, door: Door) {
  return {
    async archive(nodeIds: string[], max: number) {
      const entries: StorageArchiveEntry[] = [];
      const roots = new Set<string>();
      for (const nodeId of new Set(nodeIds)) {
        const found = await reach(db, door, nodeId);
        if (!found || inTrash(found.chain)) return { status: "not_found" } satisfies ArchiveResult;
        const { name, kind } = found.node;
        const root = freeRoot(name, kind, roots);
        const rows = (await db.execute(sql`
          with recursive down(id, path, depth) as (
            select n.id, n.name::text, 0 from ${storageNodes} n where n.id = ${nodeId}
            union all
            select c.id, down.path || '/' || c.name, down.depth + 1 from ${storageNodes} c
              join down on c.parent_id = down.id
              where c.trashed_at is null and not c.attached and down.depth < ${MAX_WALK}
                ${found.access.role === "member" ? sql`` : sql`and not c.team_only`}
          )
          select n.kind, n.size, n.r2_key, n.updated_at, down.path
          from down join ${storageNodes} n on n.id = down.id
          order by down.path
          limit ${max - entries.length + 1}`)) as unknown as {
          kind: "folder" | "file";
          size: string | number;
          r2_key: string | null;
          updated_at: Date | string;
          path: string;
        }[];
        for (const row of rows) {
          if (row.kind === "file" && !row.r2_key) continue;
          entries.push({
            path: root + row.path.slice(name.length),
            kind: row.kind,
            size: Number(row.size),
            r2Key: row.r2_key,
            updatedAt: new Date(row.updated_at),
          });
        }
        if (entries.length > max) return { status: "too_many" } satisfies ArchiveResult;
      }
      return { status: "ok", entries } satisfies ArchiveResult;
    },
  };
}
