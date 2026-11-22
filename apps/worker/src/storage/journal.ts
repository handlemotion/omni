import { latestEpochStart, type StorageLiveEntry } from "@omni/contracts";
import { isDocFile } from "@omni/docs";
import {
  contentWriterOf,
  docJournalOf,
  docReplayFrom,
  docsOwedJournal,
  memberNames,
  writeDocJournal,
  type Db,
  type DocRun,
} from "@omni/db";
import { Effect } from "effect";
import type { Context } from "hono";
import * as Y from "yjs";
import type { AppEnv } from "../context.ts";
import { openDb } from "../db.ts";
import { loadConfig, type Config } from "../env.ts";
import { runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";
import { s2Basin, type S2Basin } from "../s2.ts";
import { latestLiveStart, readLiveTimed } from "./live-read.ts";

const RUN_MS = 60_000;
const BASELINE_EVERY = 500;
const FOLD_GRACE_MS = 2 * 60_000;

type Timed = StorageLiveEntry & { at: number };
type Deps = { db: Db; config: Config; log: Logger };
type Doc = { id: string; orgId: string; contentVersion: number };

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const memberOf = (by: string) =>
  by.startsWith("m:") || by.startsWith("a:") ? by.split(":")[1] : null;
const agentOf = (by: string) => (by.startsWith("a:") ? by.split(":").slice(2).join(":") : null);

function runsOf(updates: Timed[]) {
  const runs: (Omit<DocRun, "update" | "authorName" | "agent"> & { updates: Uint8Array[] })[] = [];
  for (const entry of updates) {
    if (entry.record.t !== "update") continue;
    const by = entry.record.by ?? "unknown";
    const run = runs.at(-1);
    const at = new Date(entry.at);
    if (run && run.by === by && entry.at - run.startedAt.getTime() <= RUN_MS) {
      run.lastSeq = entry.seqNum;
      run.endedAt = at;
      run.updates.push(fromBase64(entry.record.u));
      continue;
    }
    runs.push({
      by,
      firstSeq: entry.seqNum,
      lastSeq: entry.seqNum,
      startedAt: at,
      endedAt: at,
      updates: [fromBase64(entry.record.u)],
    });
  }
  return runs;
}

async function namedRuns(db: Db, updates: Timed[]) {
  const grouped = runsOf(updates);
  const names = await memberNames(db, [
    ...new Set(grouped.map((run) => memberOf(run.by)).filter((id): id is string => !!id)),
  ]);
  return grouped.map(({ updates: parts, ...run }) => {
    const memberId = memberOf(run.by);
    const named: DocRun = {
      ...run,
      authorName: memberId ? (names.get(memberId) ?? null) : null,
      agent: agentOf(run.by),
      update: toBase64(Y.mergeUpdates(parts)),
    };
    return named;
  });
}

async function writeRun(db: Db, doc: Doc, journaled: number, folded = new Set<number>()) {
  const runs: DocRun[] = [];
  for (let cv = Math.max(journaled + 1, doc.contentVersion - 50); cv <= doc.contentVersion; cv++) {
    if (folded.has(cv)) continue;
    const writer = await contentWriterOf(db, doc.id, cv);
    if (!writer) continue;
    const names = await memberNames(db, writer.memberId ? [writer.memberId] : []);
    runs.push({
      firstSeq: -cv,
      lastSeq: -cv,
      by: writer.by,
      authorName: writer.memberId ? (names.get(writer.memberId) ?? null) : null,
      agent: writer.agent,
      startedAt: writer.at,
      endedAt: writer.at,
      update: "",
      contentVersion: cv,
    });
  }
  return runs;
}

async function checkpoint(db: Db, doc: Doc, epoch: number, through: number, runs: DocRun[]) {
  const replay = await docReplayFrom(db, doc.id, epoch, through);
  if (!replay) return null;
  const state = new Y.Doc();
  Y.applyUpdate(state, fromBase64(replay.baseline.state));
  for (const run of [...replay.runs, ...runs]) {
    if (run.update) Y.applyUpdate(state, fromBase64(run.update));
  }
  const last = runs.at(-1);
  if (!last) return null;
  const baseline: { seq: number; state: string } = {
    seq: last.lastSeq,
    state: toBase64(Y.encodeStateAsUpdate(state)),
  };
  return baseline;
}

/**
 * Copies what the doc's live document recorded since its journal into `storage_doc_changes`, so
 * its history outlives the stream. Safe to run twice, and from anywhere: every save of a doc
 * runs it, and the minute job runs it for any doc a save's run missed.
 */
export async function journalDoc(deps: Deps, doc: Doc) {
  for (let tries = 0; tries < 8; tries++) {
    if (await journalOnce(deps, doc)) return;
  }
  deps.log.warn("storage.journal_busy", { nodeId: doc.id });
}

async function runsAfter(
  db: Db,
  doc: Doc,
  entries: Timed[],
  at: { epoch: number; after: number; startCv: number },
  cursor: Cursor | null,
) {
  const updates = entries.filter(
    (e) => e.seqNum > at.after && e.record.t === "update" && e.record.e === at.epoch,
  );
  const runs = await namedRuns(db, updates);
  const { writes, held } = await outsideSaves(db, doc, entries, cursor, at.startCv);
  const live = held ? runs.map((run) => ({ ...run, contentVersion: doc.contentVersion })) : runs;
  return { runs: [...writes, ...live], contentVersion: doc.contentVersion - (held ? 1 : 0) };
}

async function outsideSaves(
  db: Db,
  doc: Doc,
  entries: Timed[],
  cursor: Cursor | null,
  startCv: number,
) {
  const folded = new Set(
    entries.flatMap((e) =>
      e.record.t === "fold" || (e.record.t === "snap" && e.record.f > e.record.e)
        ? [e.record.cv]
        : [],
    ),
  );
  const held =
    entries.length > 0 &&
    doc.contentVersion > startCv &&
    !folded.has(doc.contentVersion) &&
    (await recentlyWritten(db, doc));
  if (held) folded.add(doc.contentVersion);
  return { writes: await writeRun(db, doc, cursor?.contentVersion ?? 0, folded), held };
}

async function recentlyWritten(db: Db, doc: Doc) {
  const writer = await contentWriterOf(db, doc.id, doc.contentVersion);
  return !!writer && Date.now() - writer.at.getTime() < FOLD_GRACE_MS;
}

async function nextBaseline(
  db: Db,
  doc: Doc,
  at: { epoch: number; after: number },
  runs: DocRun[],
  since: number,
) {
  const baseline =
    since >= BASELINE_EVERY ? await checkpoint(db, doc, at.epoch, at.after, runs) : null;
  return { baseline, sinceBaseline: baseline ? 0 : since };
}

type Cursor = NonNullable<Awaited<ReturnType<typeof docJournalOf>>>;

async function drain(db: Db, basin: S2Basin, nodeId: string, cursor: Cursor, latest: number) {
  const entries = await readLiveTimed(basin, nodeId, cursor.lastSeq + 1);
  const left = entries.filter((e) => e.record.t === "update" && e.record.e === cursor.epoch);
  if (left.length) {
    const runs = await namedRuns(db, left);
    return {
      lastSeq: Math.max(...left.map((e) => e.seqNum)),
      runs,
      sinceBaseline: cursor.sinceBaseline + runs.length,
    };
  }
  const seed = entries.find(
    (e) => e.record.t === "seed" && e.seqNum > cursor.epoch && e.seqNum < latest,
  );
  if (!seed || seed.record.t !== "seed") return null;
  const epoch = seed.seqNum;
  const own = entries.filter((e) => e.record.t === "update" && e.record.e === epoch);
  const runs = await namedRuns(db, own);
  return {
    epoch,
    lastSeq: Math.max(epoch, ...own.map((e) => e.seqNum)),
    runs,
    baseline: { seq: epoch, state: seed.record.u },
    sinceBaseline: runs.length,
  };
}

const baselineOf = (first: NonNullable<ReturnType<typeof latestEpochStart>>) => ({
  seq: first.record.t === "snap" ? first.record.s : first.seqNum,
  state: first.record.u,
});

async function journalOnce(deps: Deps, doc: Doc) {
  const basin = s2Basin(deps.config);
  if (!basin) return true;
  const cursor = await docJournalOf(deps.db, doc.id);
  const start = await latestLiveStart(basin, doc.id);
  let entries = await readLiveTimed(basin, doc.id, start);
  const first = latestEpochStart(entries);
  const mark = (input: Partial<Parameters<typeof writeDocJournal>[1]>) =>
    writeDocJournal(deps.db, {
      orgId: doc.orgId,
      nodeId: doc.id,
      epoch: cursor?.epoch ?? -1,
      lastSeq: cursor?.lastSeq ?? -1,
      contentVersion: doc.contentVersion,
      runs: [],
      baseline: null,
      sinceBaseline: cursor?.sinceBaseline ?? 0,
      expected: cursor ? { epoch: cursor.epoch, lastSeq: cursor.lastSeq } : null,
      ...input,
    });
  if (!first) {
    const { writes, held } = await outsideSaves(deps.db, doc, entries, cursor, 0);
    return mark({ runs: writes, contentVersion: doc.contentVersion - (held ? 1 : 0) });
  }
  const epoch = first.record.t === "snap" ? first.record.e : first.seqNum;
  if (cursor && cursor.epoch >= 0 && cursor.epoch !== epoch) {
    const drained = await drain(deps.db, basin, doc.id, cursor, epoch);
    if (drained) {
      await mark(drained);
      return false;
    }
  }
  const continuing = cursor?.epoch === epoch;
  if (continuing && cursor.lastSeq + 1 < start) {
    entries = await readLiveTimed(basin, doc.id, cursor.lastSeq + 1);
  }
  const base = continuing ? null : baselineOf(first);
  const after = base ? base.seq : cursor!.lastSeq;
  const startCv = first.record.cv;
  const { runs, contentVersion } = await runsAfter(
    deps.db,
    doc,
    entries,
    { epoch, after, startCv },
    cursor,
  );
  const since = (continuing ? cursor.sinceBaseline : 0) + runs.length;
  const next = base
    ? { baseline: base, sinceBaseline: since }
    : await nextBaseline(deps.db, doc, { epoch, after }, runs, since);
  const lastSeq = Math.max(after, ...entries.map((e) => e.seqNum));
  return mark({ epoch, lastSeq, contentVersion, runs, ...next });
}

/** The minute job's part: journals docs saved since their journal, a few at a time. */
export async function journalOwedDocs(deps: Deps, limit = 20) {
  let journaled = 0;
  for (const doc of await docsOwedJournal(deps.db, limit)) {
    try {
      await journalDoc(deps, doc);
      journaled++;
    } catch (error) {
      deps.log.warn("storage.journal_failed", { error, nodeId: doc.id });
    }
  }
  return journaled;
}

/** The minute job: journals docs a save's own run missed. */
export function journalStorageDocs(env: Env) {
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const config = loadConfig(env);
      const count = yield* Effect.promise(() => journalOwedDocs({ db, config, log }));
      if (count) log.info("storage.docs_journaled", { count });
    }),
  );
}

/**
 * Journals a doc once the response has gone, on a connection of its own (the request's closes
 * with it). A run that fails is left to the minute job.
 */
export function journalLater(
  work: { env: Env; config: Config; log: Logger; waitUntil: (work: Promise<unknown>) => void },
  node: {
    id: string;
    orgId: string;
    name: string;
    mimeType: string | null;
    contentVersion: number;
  },
) {
  if (!isDocFile(node.name, node.mimeType) || !s2Basin(work.config)) return;
  work.waitUntil(
    (async () => {
      const { db, close } = openDb(work.env, 1);
      try {
        await journalDoc({ db, config: work.config, log: work.log }, node);
      } catch (error) {
        work.log.warn("storage.journal_failed", { error, nodeId: node.id });
      } finally {
        await close({ timeout: 0 });
      }
    })(),
  );
}

/** After a save of a doc through the API. */
export function journalSaved(
  c: Context<AppEnv>,
  node: {
    id: string;
    orgId: string;
    name: string;
    mimeType: string | null;
    contentVersion: number;
  },
) {
  journalLater(
    {
      env: c.env,
      config: c.var.config,
      log: c.var.log,
      waitUntil: (work) => c.executionCtx.waitUntil(work),
    },
    node,
  );
}
