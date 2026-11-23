import type { FetchMessageObject, ImapFlow, MailboxObject } from "imapflow";
import { type FolderSyncPlan, planFolderSync } from "@omni/mail-core/folder-sync";
import type { Logger } from "./log.ts";
import type { MailboxConfig } from "./mailbox-config.ts";
import type { FetchedMessage, FlagChange, FolderRole, MailStore, SyncPosition } from "./ports.ts";
import { discard, isSpooled, spool } from "./spool.ts";

const MAX_CONSECUTIVE_STORE_FAILURES = 5;
const SIZE_CHUNK = 500;

export interface NewMessageEvent {
  mailboxId: string;
  folder: string;
  role: FolderRole;
  uid: number;
}

export interface FolderSyncResult {
  folder: string;
  added: number;
  /** New messages that could not be stored this time; the next sync retries them. */
  failed: number;
  removed: number;
  flagsChanged: number;
  reset: boolean;
  mode: "condstore" | "uid-diff" | "unchanged";
}

/** How a sync fetches new messages: in batches bounded by count and bytes, big ones streamed. */
export interface FetchLimits {
  /** Messages fetched per round trip during import and catch-up. */
  batchSize: number;
  /** A fetch batch also stops at this many bytes, so big messages come one at a time. */
  batchBytes: number;
  /**
   * A message larger than this is streamed to a temp file and parsed from there, never held in
   * memory: parsing costs several times a message's size, and the VM is small.
   */
  streamAboveBytes: number;
}

/** Everything one folder sync needs from its connection. */
export interface FolderSyncContext {
  client: ImapFlow;
  mailbox: Pick<MailboxConfig, "id" | "syncSince">;
  store: MailStore;
  log: Logger;
  /** The server has CONDSTORE (enabled or advertised). */
  condstore: boolean;
  /** The server is Gmail: fetches carry X-GM-THRID. */
  gmail: boolean;
  /** The role of the folder being synced, for `onMessage`. */
  role: FolderRole;
  limits: FetchLimits;
  isStopped(): boolean;
  onMessage(event: NewMessageEvent): void;
}

/** The connection is stopping: the rest of the sync is abandoned, the next start resumes it. */
export class StoppedError extends Error {
  override name = "StoppedError";
}

type ChangedPlan = Exclude<FolderSyncPlan, { mode: "unchanged" }>;
type StoreMessage = (fetched: FetchedMessage) => Promise<void>;

/**
 * Brings one folder's index in line with the server: a UIDVALIDITY change resets it, then
 * removals and flag changes apply, then new messages import, newest first. The sync position
 * only moves past new messages that all stored, so a failed one is retried next time.
 */
export async function syncFolder(ctx: FolderSyncContext, path: string) {
  const { client } = ctx;
  throwIfStopped(ctx);
  const lock = await client.getMailboxLock(path);
  try {
    if (client.mailbox === false) throw new Error(`could not select ${path}`);
    const box = client.mailbox;
    const result: FolderSyncResult = {
      folder: path,
      added: 0,
      failed: 0,
      removed: 0,
      flagsChanged: 0,
      reset: false,
      mode: "uid-diff",
    };
    const position = await startPosition(ctx, path, box, result);
    const serverModseq = ctx.condstore && !box.noModseq ? (box.highestModseq ?? null) : null;
    const index = await ctx.store.folderIndex(ctx.mailbox.id, path);
    const plan = planFolderSync(
      position,
      { uidNext: box.uidNext, exists: box.exists, highestModseq: serverModseq },
      index.size,
    );
    result.mode = plan.mode;
    if (plan.mode === "unchanged") return result satisfies FolderSyncResult;

    const serverUids = await listServerUids(ctx, box, plan, index);
    const added = await applyServerChanges(ctx, path, box, plan, index, serverUids);
    result.removed = added.removed;
    result.flagsChanged = added.flagsChanged;
    await importMessages(ctx, path, added.uids, result);

    await ctx.store.saveSyncPosition(ctx.mailbox.id, path, {
      uidValidity: box.uidValidity,
      highestModseq: serverModseq,
      uidNext: result.failed > 0 ? position.uidNext : box.uidNext,
    });
    if (result.added || result.removed || result.flagsChanged || result.reset || result.failed) {
      ctx.log.info("sync.folder", { ...result });
    }
    return result satisfies FolderSyncResult;
  } finally {
    lock.release();
  }
}

function throwIfStopped(ctx: FolderSyncContext) {
  if (ctx.isStopped()) throw new StoppedError(`mailbox ${ctx.mailbox.id} is stopping`);
}

async function startPosition(
  ctx: FolderSyncContext,
  path: string,
  box: MailboxObject,
  result: FolderSyncResult,
) {
  const mailboxId = ctx.mailbox.id;
  const stored = await ctx.store.getSyncPosition(mailboxId, path);
  if (stored && stored.uidValidity === box.uidValidity) return stored satisfies SyncPosition;
  if (stored) {
    ctx.log.warn("sync.uidvalidity_changed", {
      folder: path,
      was: stored.uidValidity,
      now: box.uidValidity,
    });
    await ctx.store.resetFolder(mailboxId, path);
    result.reset = true;
  }
  const position = { uidValidity: box.uidValidity, highestModseq: null, uidNext: 0 };
  await ctx.store.saveSyncPosition(mailboxId, path, position);
  return position satisfies SyncPosition;
}

async function listServerUids(
  ctx: FolderSyncContext,
  box: MailboxObject,
  plan: ChangedPlan,
  index: Map<number, string[]>,
) {
  const { client } = ctx;
  if (!plan.listUids) return [...index.keys()] satisfies number[];
  if (box.exists === 0) return [] satisfies number[];
  const since = ctx.mailbox.syncSince;
  if (!since) return ((await client.search({ all: true }, { uid: true })) || []) satisfies number[];
  const recent = (await client.search({ since }, { uid: true })) || [];
  const floor = recent.reduce((low, uid) => Math.min(low, uid), box.uidNext);
  const from = lowestUid(index, floor);
  const listed = (await client.search({ uid: `${from}:*` }, { uid: true })) || [];
  return listed.filter((uid) => uid >= floor || index.has(uid)) satisfies number[];
}

async function applyServerChanges(
  ctx: FolderSyncContext,
  path: string,
  box: MailboxObject,
  plan: ChangedPlan,
  index: Map<number, string[]>,
  serverUids: number[],
) {
  const mailboxId = ctx.mailbox.id;
  const onServer = new Set(serverUids);
  const removed = [...index.keys()].filter((uid) => !onServer.has(uid));
  const flagChanges =
    box.exists > 0 && index.size > 0
      ? await changedFlags(ctx.client, index, plan.changedSince)
      : [];
  if (removed.length > 0) await ctx.store.removeMessages(mailboxId, path, removed);
  if (flagChanges.length > 0) await ctx.store.applyFlags(mailboxId, path, flagChanges);
  return {
    removed: removed.length,
    flagsChanged: flagChanges.length,
    uids: serverUids.filter((uid) => !index.has(uid)).toSorted((a, b) => b - a),
  };
}

async function changedFlags(
  client: ImapFlow,
  index: Map<number, string[]>,
  changedSince: bigint | undefined,
) {
  const changes: FlagChange[] = [];
  for await (const msg of client.fetch(
    `${lowestUid(index, 1)}:*`,
    { uid: true, flags: true },
    { uid: true, changedSince },
  )) {
    const known = index.get(msg.uid);
    const flags = sortedFlags(msg.flags);
    if (known && !sameFlags(known, flags)) {
      changes.push({ uid: msg.uid, flags, modseq: msg.modseq ?? null });
    }
  }
  return changes satisfies FlagChange[];
}

async function importMessages(
  ctx: FolderSyncContext,
  path: string,
  uids: number[],
  result: FolderSyncResult,
) {
  const store = messageStorer(ctx, path, result);
  for await (const { uids: batch, large } of sizedBatches(ctx, uids)) {
    throwIfStopped(ctx);
    if (large) await importLarge(ctx, path, batch[0] ?? 0, store);
    else await importBatch(ctx, path, batch, store);
    throwIfStopped(ctx);
  }
}

function messageStorer(ctx: FolderSyncContext, path: string, result: FolderSyncResult) {
  const mailboxId = ctx.mailbox.id;
  let consecutiveFailures = 0;
  return (async (fetched) => {
    try {
      const { created } = await ctx.store.storeMessage(mailboxId, fetched);
      consecutiveFailures = 0;
      if (!created) return;
      result.added++;
      ctx.onMessage({ mailboxId, folder: path, role: ctx.role, uid: fetched.uid });
    } catch (error) {
      result.failed++;
      consecutiveFailures++;
      ctx.log.warn("sync.message_failed", { folder: path, uid: fetched.uid, error });
      if (consecutiveFailures >= MAX_CONSECUTIVE_STORE_FAILURES) throw error;
    }
  }) satisfies StoreMessage;
}

async function importLarge(ctx: FolderSyncContext, path: string, uid: number, store: StoreMessage) {
  const fetched = await fetchLarge(ctx, path, uid);
  if (!fetched) return;
  try {
    await store(fetched);
  } finally {
    if (isSpooled(fetched.raw)) await discard(fetched.raw.path);
  }
}

async function importBatch(
  ctx: FolderSyncContext,
  path: string,
  batch: number[],
  store: StoreMessage,
) {
  const query = { ...metadataQuery(ctx), source: true };
  for await (const msg of ctx.client.fetch(batch.join(","), query, { uid: true })) {
    if (ctx.isStopped() || !msg.source) continue;
    await store({ ...fetchedFields(path, msg), raw: msg.source });
  }
}

async function* sizedBatches(ctx: FolderSyncContext, uids: number[]) {
  const { batchSize, batchBytes, streamAboveBytes } = ctx.limits;
  let batch: number[] = [];
  let bytes = 0;
  for (let i = 0; i < uids.length; i += SIZE_CHUNK) {
    const chunk = uids.slice(i, i + SIZE_CHUNK);
    const sizes = new Map<number, number>();
    for await (const msg of ctx.client.fetch(
      chunk.join(","),
      { uid: true, size: true },
      { uid: true },
    )) {
      sizes.set(msg.uid, msg.size ?? 0);
    }
    for (const uid of chunk) {
      if (!sizes.has(uid)) continue;
      const size = sizes.get(uid) ?? 0;
      if (size > streamAboveBytes) {
        yield { uids: [uid], large: true };
        continue;
      }
      if (batch.length > 0 && (batch.length >= batchSize || bytes + size > batchBytes)) {
        yield { uids: batch, large: false };
        batch = [];
        bytes = 0;
      }
      batch.push(uid);
      bytes += size;
    }
  }
  if (batch.length > 0) yield { uids: batch, large: false };
}

async function fetchLarge(ctx: FolderSyncContext, path: string, uid: number) {
  const msg = await ctx.client.fetchOne(String(uid), metadataQuery(ctx), { uid: true });
  if (!msg) return null satisfies FetchedMessage | null;
  const download = await ctx.client.download(String(uid), undefined, {
    uid: true,
    chunkSize: 1024 * 1024,
  });
  if (!download.content) return null satisfies FetchedMessage | null;
  return {
    ...fetchedFields(path, msg),
    raw: await spool(download.content),
  } satisfies FetchedMessage | null;
}

function metadataQuery(ctx: FolderSyncContext) {
  return {
    uid: true,
    flags: true,
    internalDate: true,
    ...(ctx.gmail ? { threadId: true } : {}),
  } as const;
}

function fetchedFields(path: string, msg: FetchMessageObject) {
  return {
    folder: path,
    uid: msg.uid,
    flags: sortedFlags(msg.flags),
    modseq: msg.modseq ?? null,
    internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
    ...(msg.threadId ? { providerThreadId: msg.threadId } : {}),
  } satisfies Omit<FetchedMessage, "raw">;
}

function lowestUid(index: Map<number, string[]>, fallback: number) {
  let lowest = fallback;
  for (const uid of index.keys()) lowest = Math.min(lowest, uid);
  return lowest;
}

function sortedFlags(flags: Set<string> | undefined) {
  return (flags ? [...flags].toSorted() : []) satisfies string[];
}

function sameFlags(a: string[], b: string[]) {
  return a.length === b.length && a.every((flag, i) => flag === b[i]);
}
