import { randomUUID } from "node:crypto";
import { untilLockWaiters } from "@omni/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";
import { pushFrame, WEB_ORIGIN, type CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { S2_BASIN_URL: "http://127.0.0.1:54380/v1", S2_BASIN: "omni-docs-dev" },
  });
});
afterAll(() => stack?.stop());

const bytes = (text: string) => new TextEncoder().encode(text);

async function connect(jar: CookieJar) {
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    pushFrame(received, e.data);
    for (const waiter of waiters) waiter();
  });
  const waitFor = <T>(match: () => T | undefined) => {
    const arrived = Promise.withResolvers<T>();
    const check = () => {
      const found = match();
      if (found !== undefined) arrived.resolve(found);
    };
    waiters.add(check);
    check();
    return arrived.promise.finally(() => waiters.delete(check));
  };
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
    editing(nodeId: string, state: "editing" | "left") {
      socket.send(JSON.stringify({ type: "file.presence", nodeId, state }));
    },
    append(nodeId: string, ref: number, record: Record<string, unknown>, matchSeqNum?: number) {
      socket.send(JSON.stringify({ type: "doc.append", nodeId, ref, record, matchSeqNum }));
    },
    next: (count: number) => waitFor(() => (received.length >= count ? received : undefined)),
    answer: (nodeId: string, ref: number) =>
      waitFor(() =>
        received.find(
          (e) =>
            (e.type === "doc.appended" || e.type === "doc.refused") &&
            e.nodeId === nodeId &&
            e.ref === ref,
        ),
      ),
    waitFor: (match: (event: Record<string, unknown>) => boolean) =>
      waitFor(() => received.find(match)),
  };
}

test("editing presence reaches those who see the file, survives hibernation, and clears on close", async () => {
  const org = await stack.company(`presence-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "doc.md", bytes("# Doc"));
  const bos = await stack.upload(bo.jar, { space: "personal" }, "bo.md", bytes("mine"));
  const [anaHears, boHears] = [await connect(ana.jar), await connect(bo.jar)];
  const at = (memberId: string, state: string) => ({
    type: "file.presence",
    nodeId: doc.id,
    memberId,
    state,
  });

  anaHears.editing(doc.id, "editing");
  expect(await boHears.next(1)).toEqual([at(ana.id, "editing")]);
  await stack.worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: org.id, webSockets: "hibernate" });
  boHears.editing(doc.id, "editing");
  expect(await boHears.next(2)).toEqual([at(ana.id, "editing"), at(ana.id, "editing")]);
  expect(await anaHears.next(1)).toEqual([at(bo.id, "editing")]);

  anaHears.editing(bos.id, "editing");

  anaHears.socket.close();
  expect((await boHears.next(3))[2]).toEqual(at(ana.id, "left"));
  expect(boHears.received).toHaveLength(3);
  boHears.socket.close();
});

test("a left sent while the editing check is still running wins", async () => {
  const org = await stack.company(`presence-race-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "doc.md", bytes("# Doc"));
  const [anaHears, boHears] = [await connect(ana.jar), await connect(bo.jar)];
  const at = (state: string) => ({
    type: "file.presence",
    nodeId: doc.id,
    memberId: ana.id,
    state,
  });
  const seed = { t: "seed", cv: 1, u: "AA==" };

  const held = Promise.withResolvers<void>();
  const taken = Promise.withResolvers<void>();
  const locked = stack.db.transaction(async (tx) => {
    await tx.execute(sql`lock table storage_nodes in access exclusive mode`);
    taken.resolve();
    await held.promise;
  });
  locked.catch(taken.reject);
  let check: number;
  try {
    await taken.promise;
    anaHears.editing(doc.id, "editing");
    check = await stuckCheck();
    anaHears.editing(doc.id, "left");
    anaHears.append(doc.id, 1, seed);
    expect(await anaHears.answer(doc.id, 1)).toMatchObject({
      type: "doc.refused",
      reason: "editing",
    });
  } finally {
    held.resolve();
    await locked;
  }
  await expect.poll(() => backendAlive(check)).toBe(false);

  anaHears.append(doc.id, 2, seed);
  expect(await anaHears.answer(doc.id, 2)).toMatchObject({
    type: "doc.refused",
    reason: "editing",
  });

  anaHears.editing(doc.id, "editing");
  expect(await boHears.next(1)).toEqual([at("editing")]);
  anaHears.editing(doc.id, "left");
  expect(await boHears.next(2)).toEqual([at("editing"), at("left")]);
  anaHears.socket.close();
  boHears.socket.close();
});

async function stuckCheck() {
  await untilLockWaiters(stack.db, 1);
  const [row] = (await stack.db.execute(sql`
    select pid from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`)) as unknown as {
    pid: number;
  }[];
  if (!row) throw new Error("the editing check stopped waiting before it was seen");
  return row.pid;
}

async function backendAlive(pid: number) {
  const rows = (await stack.db.execute(
    sql`select 1 from pg_stat_activity where pid = ${pid}`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

test("only a socket editing the file appends to its live document, and the other editors hear it", async () => {
  const org = await stack.company(`live-${randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bo = await stack.member(org.id);
  const cy = await stack.member(org.id);
  const doc = await stack.upload(ana.jar, { space: "shared" }, "doc.md", bytes("# Doc"));
  const bos = await stack.upload(bo.jar, { space: "personal" }, "bo.md", bytes("mine"));
  const [anaSocket, boSocket, cySocket] = await Promise.all([
    connect(ana.jar),
    connect(bo.jar),
    connect(cy.jar),
  ]);
  const seed = { t: "seed", cv: 1, u: "AA==" };
  const ofDoc = (received: Record<string, unknown>[]) =>
    received.filter((event) => String(event.type).startsWith("doc."));

  anaSocket.append(doc.id, 1, seed, 0);
  await anaSocket.answer(doc.id, 1);
  expect(ofDoc(anaSocket.received)).toEqual([
    { type: "doc.refused", nodeId: doc.id, ref: 1, reason: "editing" },
  ]);
  anaSocket.editing(bos.id, "editing");
  anaSocket.append(bos.id, 2, seed, 0);
  expect(await anaSocket.answer(bos.id, 2)).toEqual({
    type: "doc.refused",
    nodeId: bos.id,
    ref: 2,
    reason: "editing",
  });
  expect((await stack.api(bo.jar, "GET", `/files/${bos.id}/live`)).body).toEqual({
    enabled: true,
    entries: [],
    more: false,
  });

  const editingDoc = (memberId: string) => (e: Record<string, unknown>) =>
    e.type === "file.presence" && e.nodeId === doc.id && e.memberId === memberId;
  anaSocket.editing(doc.id, "editing");
  boSocket.editing(doc.id, "editing");
  await Promise.all([anaSocket.waitFor(editingDoc(bo.id)), boSocket.waitFor(editingDoc(ana.id))]);
  anaSocket.append(doc.id, 3, seed, 0);
  expect(await anaSocket.answer(doc.id, 3)).toEqual({
    type: "doc.appended",
    nodeId: doc.id,
    ref: 3,
    seqNum: 0,
  });
  boSocket.append(doc.id, 1, seed, 0);
  await boSocket.answer(doc.id, 1);
  expect(ofDoc(boSocket.received)).toEqual([
    { type: "doc.record", nodeId: doc.id, seqNum: 0, record: seed },
    { type: "doc.refused", nodeId: doc.id, ref: 1, reason: "tail" },
  ]);

  const update = { t: "update", e: 0, u: "AQ==", by: `m:${ana.id}` };
  const stamped = { ...update, by: `m:${bo.id}` };
  boSocket.append(doc.id, 2, update);
  expect(await anaSocket.waitFor((e) => e.type === "doc.record" && e.seqNum === 1)).toEqual({
    type: "doc.record",
    nodeId: doc.id,
    seqNum: 1,
    record: stamped,
  });
  expect((await stack.api(cy.jar, "GET", `/files/${doc.id}/live?from=1`)).body).toEqual({
    enabled: true,
    entries: [{ seqNum: 1, record: stamped }],
    more: false,
  });
  expect(ofDoc(cySocket.received)).toEqual([]);
  expect((await stack.api(ana.jar, "GET", `/files/${bos.id}/live`)).status).toBe(404);

  const moved = await stack.api(ana.jar, "PATCH", `/nodes/${doc.id}`, { space: "personal" });
  expect(moved.status).toBe(200);
  let ref = 3;
  await expect
    .poll(
      async () => {
        const sent = ref++;
        boSocket.append(doc.id, sent, update, 1_000);
        return (await boSocket.answer(doc.id, sent)).reason;
      },
      { timeout: 10_000, interval: 250 },
    )
    .toBe("denied");
  expect((await stack.api(ana.jar, "GET", `/files/${doc.id}/live?from=2`)).body).toEqual({
    enabled: true,
    entries: [],
    more: false,
  });
  for (const hears of [anaSocket, boSocket, cySocket]) hears.socket.close();
});
