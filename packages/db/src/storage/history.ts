import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import {
  storageContents,
  storageDocBaselines,
  storageDocChanges,
  storageDocJournals,
  storageNodes,
} from "../schema/storage.ts";

/** One run of a live document's change log, as the journal job writes it. */
export interface DocRun {
  firstSeq: number;
  lastSeq: number;
  by: string;
  authorName: string | null;
  agent: string | null;
  startedAt: Date;
  endedAt: Date;
  update: string;
}

/** Where a doc's journal stands; null when it has none yet. */
export async function docJournalOf(db: Db, nodeId: string) {
  const [row] = await db
    .select()
    .from(storageDocJournals)
    .where(eq(storageDocJournals.nodeId, nodeId));
  return row ?? null;
}

/**
 * Docs (Omni docs and Markdown files) whose content was written in the last day and moved past
 * their journal: the minute job's work list, for saves whose own journal run did not happen.
 */
export async function docsOwedJournal(db: Db, limit = 20) {
  return db
    .select({
      id: storageNodes.id,
      orgId: storageNodes.orgId,
      contentVersion: storageNodes.contentVersion,
    })
    .from(storageNodes)
    .innerJoin(storageContents, eq(storageContents.nodeId, storageNodes.id))
    .leftJoin(storageDocJournals, eq(storageDocJournals.nodeId, storageNodes.id))
    .where(
      and(
        eq(storageNodes.kind, "file"),
        isNull(storageNodes.trashedAt),
        sql`${storageContents.writtenAt} > now() - interval '1 day'`,
        or(
          sql`split_part(lower(${storageNodes.mimeType}), ';', 1) = 'text/vnd.omni.doc'`,
          sql`${storageNodes.name} ~* '\\.(md|markdown)$'`,
        ),
        or(
          isNull(storageDocJournals.nodeId),
          gt(storageNodes.contentVersion, storageDocJournals.contentVersion),
        ),
      ),
    )
    .orderBy(asc(storageContents.writtenAt))
    .limit(limit);
}

/** Names of these members now, by id. */
export async function memberNames(db: Db, memberIds: string[]) {
  if (memberIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: members.id, name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(inArray(members.id, memberIds));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The latest baseline of `epoch` at or before `seq`, and the runs after it through `seq`. */
export async function docReplayFrom(db: Db, nodeId: string, epoch: number, seq: number) {
  const [baseline] = await db
    .select()
    .from(storageDocBaselines)
    .where(
      and(
        eq(storageDocBaselines.nodeId, nodeId),
        eq(storageDocBaselines.epoch, epoch),
        lte(storageDocBaselines.seq, seq),
      ),
    )
    .orderBy(desc(storageDocBaselines.seq))
    .limit(1);
  if (!baseline) return null;
  const runs = await db
    .select()
    .from(storageDocChanges)
    .where(
      and(
        eq(storageDocChanges.nodeId, nodeId),
        eq(storageDocChanges.epoch, epoch),
        gt(storageDocChanges.firstSeq, baseline.seq),
        lte(storageDocChanges.lastSeq, seq),
      ),
    )
    .orderBy(asc(storageDocChanges.firstSeq));
  return { baseline, runs };
}

/**
 * Writes runs of `epoch` (and a baseline, when one is due) and moves the doc's journal to
 * `lastSeq`, if the journal is still where it was read (`expected`, null for none): the doc's
 * journal writes take turns, and one made from a cursor another has since moved writes nothing
 * and answers false, so the caller reads again. Runs and baselines already written are skipped.
 */
export async function writeDocJournal(
  db: Db,
  input: {
    orgId: string;
    nodeId: string;
    epoch: number;
    lastSeq: number;
    contentVersion: number;
    runs: DocRun[];
    baseline: { seq: number; state: string } | null;
    sinceBaseline: number;
    expected: { epoch: number; lastSeq: number } | null;
  },
) {
  const { orgId, nodeId, epoch } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`doc-journal:${nodeId}`}))`);
    const [now] = await tx
      .select({ epoch: storageDocJournals.epoch, lastSeq: storageDocJournals.lastSeq })
      .from(storageDocJournals)
      .where(eq(storageDocJournals.nodeId, nodeId));
    const moved = now
      ? now.epoch !== input.expected?.epoch || now.lastSeq !== input.expected.lastSeq
      : input.expected !== null;
    if (moved) return false;
    if (input.runs.length) {
      await tx
        .insert(storageDocChanges)
        .values(
          input.runs.map((run) => ({
            ...run,
            orgId,
            nodeId,
            epoch,
            contentVersion: input.contentVersion,
          })),
        )
        .onConflictDoNothing();
    }
    if (input.baseline) {
      await tx
        .insert(storageDocBaselines)
        .values({ orgId, nodeId, epoch, ...input.baseline })
        .onConflictDoNothing();
    }
    const at = {
      epoch,
      lastSeq: input.lastSeq,
      contentVersion: input.contentVersion,
      sinceBaseline: input.sinceBaseline,
      updatedAt: new Date(),
    };
    await tx
      .insert(storageDocJournals)
      .values({ nodeId, orgId, ...at })
      .onConflictDoUpdate({ target: storageDocJournals.nodeId, set: at });
    return true;
  });
}

/**
 * Deletes runs that ended before `before` that a kept baseline covers (a replay of what is left
 * never needs them), and the baselines no remaining run needs (every one of an epoch older than
 * its oldest remaining run, but the latest of those). Expired runs a later run still depends on
 * stay until a checkpoint after them lets them go. The daily job's.
 */
export async function purgeDocHistory(db: Db, before: Date) {
  const cutoff = before.toISOString();
  const gone = (await db.execute(sql`
    delete from ${storageDocChanges} c
    where c.ended_at < ${cutoff}::timestamptz
      and (c.update = '' or exists (
        select 1 from ${storageDocBaselines} b
        where b.node_id = c.node_id and b.epoch = c.epoch and b.seq >= c.last_seq
          and b.seq <= coalesce(
            (select min(n.first_seq) from ${storageDocChanges} n
              where n.node_id = c.node_id and n.epoch = c.epoch and n.update <> ''
                and n.ended_at >= ${cutoff}::timestamptz),
            2147483647)
      ))
    returning c.node_id`)) as unknown as unknown[];
  await db.execute(sql`
    delete from ${storageDocBaselines} b
    where b.created_at < ${cutoff}::timestamptz
      and exists (
        select 1 from ${storageDocBaselines} newer
        where newer.node_id = b.node_id and newer.epoch = b.epoch and newer.seq > b.seq
          and newer.seq <= coalesce(
            (select min(c.first_seq) from ${storageDocChanges} c
              where c.node_id = b.node_id and c.epoch = b.epoch),
            2147483647)
      )`);
  return gone.length;
}
