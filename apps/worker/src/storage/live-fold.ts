import type { StorageDocEvent, StorageLiveEntry } from "@omni/contracts";
import {
  foldContent,
  foldTargetOf,
  granteeActor,
  storageObjectKey,
  type StorageNode,
  type StorageWriter,
} from "@omni/db";
import { openDb } from "../db.ts";
import { loadConfig } from "../env.ts";
import { s2Basin } from "../s2.ts";
import { storageLimit } from "./core.ts";
import { docRecordEvents, LiveFile } from "./doc-live.ts";
import { DOC_MAX_BYTES } from "./docs.ts";
import type { FoldAuthor } from "../realtime-folds.ts";

export type { FoldAuthor };

const SAVE_TRIES = 3;

/** A save Postgres holds whose fold record the stream does not have yet. */
export interface UnrecordedFold {
  cv: number;
  through: number;
}

/**
 * What a fold did: saved the doc (the records to pass on, the file now, and the save to record
 * next time when its fold record failed to append), or nothing to do.
 */
export type FoldOutcome =
  | {
      status: "saved";
      node: StorageNode;
      events: StorageDocEvent[];
      unrecorded?: UnrecordedFold;
    }
  | { status: "nothing" }
  | { status: "refused"; reason: string };

async function writerOf(env: Env, orgId: string, author: FoldAuthor) {
  if (author.kind === "guest") {
    return { memberId: null, guest: { id: author.id, name: author.name } } satisfies StorageWriter;
  }
  const { db, close } = openDb(env, 1);
  try {
    const memberId = await granteeActor(db, author.id, orgId);
    if (!memberId) throw new Error("storage: a grantee's save has no member to record");
    return { memberId } satisfies StorageWriter;
  } finally {
    await close({ timeout: 0 });
  }
}

async function recorded(live: LiveFile, nodeId: string, node: StorageNode, through: number) {
  const cv = node.contentVersion;
  let entry: StorageLiveEntry;
  try {
    entry = await live.folded(cv, through);
  } catch {
    return { status: "saved", node, events: [], unrecorded: { cv, through } } satisfies FoldOutcome;
  }
  const snap = await live.snapIfDue(cv, through);
  const events = docRecordEvents(nodeId, snap ? [entry, snap] : [entry]);
  return { status: "saved", node, events } satisfies FoldOutcome;
}

/**
 * Saves a doc's live document that outsiders typed in and nobody saved yet
 * (`docs/spec/live-sharing.md`): the Worker's own save, as its tabs never write over HTTP. Its
 * writer is whoever typed last (a member too), and every outsider it holds is a coauthor. Idempotent:
 * once a fold holds the records, another run finds nothing unsaved.
 */
export const foldLive: (
  env: Env,
  input: {
    orgId: string;
    nodeId: string;
    authors: FoldAuthor[];
    member: { memberId: string; lastSeq: number } | null;
    unrecorded?: UnrecordedFold | undefined;
  },
) => Promise<FoldOutcome> = async (env, input) => {
  const config = loadConfig(env);
  const basin = s2Basin(config);
  if (!basin || input.authors.length === 0) return { status: "nothing" };
  const { db, close } = openDb(env, 1);
  try {
    const node = await foldTargetOf(db, input.nodeId);
    if (!node || node.orgId !== input.orgId) return { status: "refused", reason: "not_found" };
    const live = await LiveFile.latest(basin, input.nodeId);
    const owed = input.unrecorded;
    if (live && owed && live.savedAs < owed.cv) await live.folded(owed.cv, owed.through);
    if (!live || live.savedAs !== node.contentVersion || !live.unsaved)
      return { status: "nothing" };
    const last = input.authors.reduce((a, b) => (b.lastSeq > a.lastSeq ? b : a));
    const writer =
      input.member && input.member.lastSeq > last.lastSeq
        ? ({ memberId: input.member.memberId } satisfies StorageWriter)
        : await writerOf(env, input.orgId, last);
    const coauthors = input.authors.map(({ kind, id, name }) => ({ kind, id, name }));
    let base = node.contentVersion;
    for (let tries = 0; ; tries++) {
      const markdown = live.markdown;
      const bytes = new TextEncoder().encode(markdown);
      if (bytes.byteLength > DOC_MAX_BYTES) return { status: "refused", reason: "too_large" };
      const through = live.through;
      const r2Key = storageObjectKey(input.orgId, crypto.randomUUID());
      await env.STORAGE_BUCKET.put(r2Key, bytes);
      const { limitBytes } = await storageLimit(db, config, input.orgId);
      const saved = await foldContent(db, {
        orgId: input.orgId,
        nodeId: input.nodeId,
        base,
        size: bytes.byteLength,
        mimeType: node.mimeType,
        r2Key,
        writer,
        coauthors,
        limitBytes,
      });
      if (saved.status === "ok") return recorded(live, input.nodeId, saved.node, through);
      await env.STORAGE_BUCKET.delete(r2Key);
      if (saved.status !== "version_conflict" || tries >= SAVE_TRIES) {
        return { status: "refused", reason: saved.status };
      }
      const fold = await live.lastFold();
      if (fold.cv !== saved.contentVersion) return { status: "refused", reason: "moved_on" };
      if (!live.unsaved) return { status: "nothing" };
      base = saved.contentVersion;
    }
  } finally {
    await close({ timeout: 0 });
  }
};
