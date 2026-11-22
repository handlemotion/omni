import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  postMailEvents,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

type Frame = Record<string, unknown>;
type Sync = { type: "sync"; epoch: string; seq: number; resumed: boolean };

async function connect(cookie: string, query: Record<string, string> = {}) {
  const url = new URL("/api/realtime", worker.url);
  url.protocol = "ws:";
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    frames.push(JSON.parse(String(e.data)) as Frame);
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  const until = async (match: (frame: Frame) => boolean) => {
    const found = Promise.withResolvers<Frame>();
    const check = () => {
      const hit = frames.find(match);
      if (hit) found.resolve(hit);
    };
    waiters.add(check);
    check();
    return found.promise.finally(() => waiters.delete(check));
  };
  const sync = (await until((frame) => frame.type === "sync")) as Sync;
  return {
    socket,
    frames,
    sync,
    until,
    replayed: () => frames.slice(0, frames.indexOf(sync)),
    async close() {
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
      socket.close();
      await closed;
    },
  };
}

const since = (sync: Sync) => ({ since: `${sync.epoch}.${sync.seq}` });

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function talk(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/talk${path}`, worker.url), {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (await response.json()) as any };
}

async function folder(cookie: string, space: "personal" | "shared", name: string) {
  const response = await fetch(new URL("/api/storage/folders", worker.url), {
    method: "POST",
    headers: { cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name, space }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { node: { id: string } }).node;
}

test("a socket that comes back is sent what its member missed while away, in order, and nobody else's", async () => {
  const { db } = database;
  const org = await createOrg(db, "replay");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@replay.test");
  const bea = await createMember(db, org.id, "bea@replay.test");
  const anaBox = await createMailbox(db, org.id, "ana@replay.test", "personal");
  const beaBox = await createMailbox(db, org.id, "bea@replay.test", "personal");
  await grant(db, org.id, anaBox.id, ana.id);
  await grant(db, org.id, beaBox.id, bea.id);
  const forAna = await seedMessage(db, anaBox, { subject: "A", fromAddress: "x@c.test", uid: 1 });
  const forBea = await seedMessage(db, beaBox, { subject: "B", fromAddress: "y@c.test", uid: 1 });
  const anaCookie = await signIn(worker, db, "ana@replay.test");
  const beaCookie = await signIn(worker, db, "bea@replay.test");
  const created = (mailboxId: string, thread: { threadId: string; messageId: string }) =>
    postMailEvents(worker, {
      events: [
        {
          type: "message.created",
          folderRole: "inbox",
          orgId: org.id,
          mailboxId,
          threadId: thread.threadId,
          messageId: thread.messageId,
        },
      ],
    });

  const first = await connect(anaCookie);
  expect(first.sync).toMatchObject({ type: "sync", resumed: false });
  expect(first.replayed()).toEqual([]);
  await first.close();

  expect((await created(beaBox.id, forBea)).status).toBe(202);
  expect((await created(anaBox.id, forAna)).status).toBe(202);
  const shared = await folder(beaCookie, "shared", "Team");
  await folder(beaCookie, "personal", "Mine");
  await worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: org.id, webSockets: "close" });

  const back = await connect(anaCookie, since(first.sync));
  expect(back.sync).toMatchObject({ epoch: first.sync.epoch, resumed: true });
  const missed = back.replayed();
  expect(missed.map((event) => ({ ...event, seq: undefined }))).toEqual([
    { type: "changed", mailboxId: anaBox.id, threadIds: [forAna.threadId] },
    { type: "thread.changed", mailboxId: anaBox.id, threadIds: [forAna.threadId] },
    { type: "storage.changed", space: "shared", parentIds: [null, shared.id] },
  ]);
  const seqs = missed.map((event) => event.seq as number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(seqs[0]).toBeGreaterThan(first.sync.seq);
  expect(back.sync.seq).toBeGreaterThanOrEqual(seqs.at(-1) ?? 0);

  const again = await connect(anaCookie, since(back.sync));
  expect(again.sync).toMatchObject({ seq: back.sync.seq, resumed: true });
  expect(again.replayed()).toEqual([]);

  expect((await created(anaBox.id, forAna)).status).toBe(202);
  const live = await again.until((frame) => frame.type === "changed");
  expect(live.seq).toBeGreaterThan(back.sync.seq);
  for (const s of [back, again]) await s.close();
});

test("a cursor the log cannot vouch for replays nothing and says the app must refetch", async () => {
  const { db } = database;
  const org = await createOrg(db, "replay-stale");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  await createMember(db, org.id, "ana@replay-stale.test");
  const cookie = await signIn(worker, db, "ana@replay-stale.test");
  const now = (await connect(cookie)).sync;

  for (const cursor of [
    `${crypto.randomUUID()}.${now.seq}`,
    `${now.epoch}.${now.seq + 1000}`,
    "not-a-cursor",
  ]) {
    const socket = await connect(cookie, { since: cursor });
    expect(socket.sync).toEqual({ type: "sync", epoch: now.epoch, seq: now.seq, resumed: false });
    expect(socket.replayed()).toEqual([]);
    await socket.close();
  }
});

test("a Talk note sent while its recipient was away reaches their Talk app when it comes back", async () => {
  const { db } = database;
  const org = await createOrg(db, "replay-talk");
  const ana = await createMember(db, org.id, "ana@replay-talk.test");
  const ben = await createMember(db, org.id, "ben@replay-talk.test");
  const anaCookie = await signIn(worker, db, "ana@replay-talk.test");
  const benCookie = await signIn(worker, db, "ben@replay-talk.test");
  const threadId = (await talk(anaCookie, "POST", "/threads", { memberId: ben.id })).body.thread.id;

  const benTalk = await connect(benCookie, { talk: "1" });
  const benApp = await connect(benCookie);
  for (const s of [benTalk, benApp]) await s.close();

  const sent = await talk(anaCookie, "POST", `/threads/${threadId}/messages`, { body: "Back?" });
  expect(sent.status).toBe(201);
  await settle();

  const talkBack = await connect(benCookie, { talk: "1", ...since(benTalk.sync) });
  expect(talkBack.sync.resumed).toBe(true);
  expect(talkBack.replayed().filter((frame) => frame.type === "talk.message")).toMatchObject([
    { threadId, messageId: sent.body.message.id, fromMemberId: ana.id, preview: "Back?" },
  ]);

  const appBack = await connect(benCookie, since(benApp.sync));
  expect(appBack.sync.resumed).toBe(true);
  expect(appBack.replayed().filter((frame) => String(frame.type).startsWith("talk."))).toEqual([]);
  for (const s of [talkBack, appBack]) await s.close();
});
