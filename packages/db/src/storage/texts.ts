import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageNodes, storageTexts } from "../schema/storage.ts";

/** Failed reads of one content version before the indexer gives up on it. */
export const STORAGE_TEXT_MAX_ATTEMPTS = 3;
const RETRY_AFTER = "10 minutes";

export type StorageTextStatus = (typeof storageTexts.status.enumValues)[number];

/** A file whose text is missing or behind its content, with what the indexer needs to read it. */
export interface StorageFileToRead {
  id: string;
  orgId: string;
  r2Key: string;
  name: string;
  mimeType: string | null;
  size: number;
  contentVersion: number;
}

/**
 * Up to `limit` live files whose text was never read, is from an older content version, or
 * failed and may be tried again: new uploads, replaced files, and every file from before the
 * indexer existed. Newest first, so what people just added is searchable soonest.
 */
export async function storageFilesToRead(db: Db, limit: number) {
  const rows = await db
    .select({
      id: storageNodes.id,
      orgId: storageNodes.orgId,
      r2Key: storageNodes.r2Key,
      name: storageNodes.name,
      mimeType: storageNodes.mimeType,
      size: storageNodes.size,
      contentVersion: storageNodes.contentVersion,
    })
    .from(storageNodes)
    .leftJoin(storageTexts, eq(storageTexts.nodeId, storageNodes.id))
    .where(
      and(
        eq(storageNodes.kind, "file"),
        isNull(storageNodes.trashedAt),
        isNotNull(storageNodes.r2Key),
        or(
          isNull(storageTexts.nodeId),
          lt(storageTexts.contentVersion, storageNodes.contentVersion),
          and(
            eq(storageTexts.status, "failed"),
            lt(storageTexts.attempts, STORAGE_TEXT_MAX_ATTEMPTS),
            sql`${storageTexts.readAt} < now() - interval '${sql.raw(RETRY_AFTER)}'`,
          ),
        ),
      ),
    )
    .orderBy(desc(storageNodes.updatedAt), storageNodes.id)
    .limit(limit);
  return rows.map((row) => ({ ...row, r2Key: row.r2Key! })) satisfies StorageFileToRead[];
}

export interface StorageTextInput {
  nodeId: string;
  orgId: string;
  contentVersion: number;
  status: StorageTextStatus;
  text?: string;
  truncated?: boolean;
}

/**
 * Records what reading a file came to. Safe to run twice and in any order: a read of an older
 * content version never replaces a newer one, and a failure counts toward the attempts of its
 * own version only. A file deleted meanwhile has no row to write to, and nothing is written.
 */
export async function saveStorageText(db: Db, input: StorageTextInput) {
  const failed = input.status === "failed";
  await db.execute(sql`
    insert into ${storageTexts} (node_id, org_id, content_version, status, text, truncated, attempts, read_at)
    select n.id, n.org_id, ${input.contentVersion}, ${input.status}::storage_text_status,
      ${input.text ?? ""}, ${input.truncated ?? false}, ${failed ? 1 : 0}, now()
    from ${storageNodes} n where n.id = ${input.nodeId} and n.org_id = ${input.orgId}
    on conflict (node_id) do update set
      content_version = excluded.content_version,
      status = excluded.status,
      text = excluded.text,
      truncated = excluded.truncated,
      attempts = ${
        failed
          ? sql`case when ${storageTexts}.content_version = excluded.content_version then ${storageTexts}.attempts + 1 else 1 end`
          : sql`0`
      },
      read_at = now()
    where excluded.content_version >= ${storageTexts}.content_version`);
}
