import { type StorageHistoryResponse, type StorageHistorySessionResponse } from "@omni/contracts";
import { blockCounts, diffBlocks, liveMarkdown } from "@omni/docs";
import { docReplayFrom, STORAGE_VERSION_DAYS, type Db, type DocSession } from "@omni/db";
import * as Y from "yjs";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { memberStorage, refused } from "./http.ts";

type Files = ReturnType<typeof memberStorage>;

const kindOf = (by: string) => {
  const kind: "agent" | "member" | "unknown" = by.startsWith("a:")
    ? "agent"
    : by.startsWith("m:")
      ? "member"
      : "unknown";
  return kind;
};

const wireSession = (session: DocSession, held: { versionId: string | null } | null) => ({
  id: session.id,
  startedAt: session.startedAt.toISOString(),
  endedAt: session.endedAt.toISOString(),
  authors: session.authors.map((author) => ({
    kind: kindOf(author.by),
    name: author.name,
    agent: author.agent,
  })),
  contentVersion: session.contentVersion,
  restorable: !!held,
  versionId: held?.versionId ?? null,
});

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pageAt(db: Db, nodeId: string, epoch: number, seq: number) {
  const replay = await docReplayFrom(db, nodeId, epoch, seq);
  if (!replay) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(replay.baseline.state));
  for (const run of replay.runs) if (run.update) Y.applyUpdate(doc, fromBase64(run.update));
  return liveMarkdown(doc);
}

async function heldFor(files: Files, nodeId: string, sessions: DocSession[]) {
  const counts = new Map<number, number>();
  for (const s of sessions) counts.set(s.contentVersion, (counts.get(s.contentVersion) ?? 0) + 1);
  return Promise.all(
    sessions.map((s) =>
      counts.get(s.contentVersion) === 1 ? files.contentAt(nodeId, s.contentVersion) : null,
    ),
  );
}

async function textAt(c: { env: Env }, files: Files, nodeId: string, contentVersion: number) {
  const held = await files.contentAt(nodeId, contentVersion);
  const object = held ? await c.env.STORAGE_BUCKET.get(held.r2Key) : null;
  return object ? await object.text() : null;
}

/** A doc's History: its editing sessions from the journal, and what each one changed. */
export const storageHistory = new Hono<AppEnv>()
  .get("/files/:id/history", async (c) => {
    const files = memberStorage(c);
    const nodeId = c.req.param("id");
    const listed = await files.history(nodeId);
    if (listed.status !== "ok") return refused(c, listed.status);
    const held = await heldFor(files, nodeId, listed.sessions);
    const sessions = listed.sessions.map((session, i) => wireSession(session, held[i] ?? null));
    return c.json({ sessions, keepDays: STORAGE_VERSION_DAYS } satisfies StorageHistoryResponse);
  })

  .get("/files/:id/history/:sessionId", async (c) => {
    const files = memberStorage(c);
    const { id: nodeId, sessionId } = c.req.param();
    const listed = await files.history(nodeId);
    if (listed.status !== "ok") return refused(c, listed.status);
    const at = listed.sessions.findIndex((session) => session.id === sessionId);
    const session = listed.sessions[at];
    if (!session) return refused(c, "not_found");
    const held = (await heldFor(files, nodeId, listed.sessions))[at] ?? null;
    const { span } = session;
    const [before, after] = span
      ? await Promise.all([
          pageAt(c.var.db, nodeId, span.epoch, span.firstSeq - 1),
          pageAt(c.var.db, nodeId, span.epoch, span.lastSeq),
        ])
      : await Promise.all([
          textAt(c, files, nodeId, session.contentVersion - 1),
          textAt(c, files, nodeId, session.contentVersion),
        ]);
    const available = before !== null && after !== null;
    const blocks = available ? diffBlocks(before, after) : [];
    return c.json({
      session: wireSession(session, held),
      available,
      blocks,
      counts: blockCounts(blocks),
    } satisfies StorageHistorySessionResponse);
  });
